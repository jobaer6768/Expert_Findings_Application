# Lesson 30 — Search Theory: From "Dr. Luna" to a Ranked Result

> **What you'll get:** the mental model for every line of Lesson 40. Search is where most backends either sink or swim — easy to write a query that returns the right rows, hard to write one that does it at p99 < 200ms for 100k experts.
>
> **No code in this lesson.** Just diagrams, decision points, and the Postgres features we'll lean on.

---

## 1. Goal

After this lesson you can:

1. Decompose any search request into *intent → filters → ranking* and explain each stage.
2. Decide whether `ILIKE`, `pg_trgm`, `tsvector`, or a separate search engine is the right tool for the job.
3. Read an `EXPLAIN ANALYZE` plan and identify a sequential scan that should be an index scan.
4. Justify our scoring function (text match → category → verification → Bayesian-adjusted rating → review count) instead of "sort by rating".
5. Compute facets correctly so the UI can show "BSc (18)" without firing a second query.
6. Generate empty-result suggestions server-side by selectively relaxing filters.

---

## 2. Why this matters — the trap

The naïve search:

```ts
const experts = await this.repo.find({
  where: { /* every filter */ },
  order: { avg_rating: 'DESC' },
});
```

Returns correct rows. Fails at scale for three reasons:

1. **N+1 by default.** Each `expert.category`, `expert.organization`, etc., triggers a lazy query.
2. **No full-text ranking.** `name LIKE '%Luna%'` matches; but `name = 'Luna'` ranked above `name = 'Luna Hospital'` is luck.
3. **Filters in `where: {}` force Postgres to compose them all *before* sorting.** On 100k rows that's a sort over the whole filtered set. Wrong index → seconds.

The fix isn't exotic. It's the *sequence*: build one query, hand it to Postgres with the right index, and rank in a single SQL statement.

### 2.1 The business cost of a slow search

Search is the **only page users care about**. Profile pages, settings, dashboards — all secondary. The search page is where buyers come to find an expert. If it's slow, your marketplace is slow, and "marketplace is slow" is the #1 reason B2B marketplaces fail.

| Symptom | What it costs |
|---|---|
| p95 latency > 1 second | 32% of users abandon the page (Akamai, 2017). For 10K daily searches, 3,200 abandoned sessions/day. At 5% conversion, 160 lost leads/day. |
| Returning wrong results (no ranking) | Users complain "search is broken" even when results exist. Support tickets. Churn. |
| No facets | Users can't narrow results. They leave. The "filter" UI is a feature parity requirement with competitors. |
| Returning 0 results without explanation | Users conclude "no experts in this category exist". They don't try other categories. They go to a competitor. |
| Returning unverified experts in the default sort | Users book unverified experts → bad experience → refund requests → platform trust erodes. |

A "correct" search that returns the right rows but slowly is **a worse business outcome than a search that returns the wrong rows quickly**, because at least the latter is a bug that gets fixed. The former is invisible until churn analysis catches it 6 months later.

---

## 3. Current state of the codebase (audit before you write code)

Search has not been built. The audit is what's missing in the foundation lessons that search will need.

| Gap | Where | Risk for search |
|---|---|---|
| `experts.service.ts` is empty | `src/experts/experts.service.ts:1` | No `findAll`, no `findByCategory`, no search at all. The 100k-row problem is theoretical until you write the first query. |
| `experts.controller.ts` doesn't exist | `src/experts/` | No search endpoint. The frontend cannot hit it. |
| No `tsvector` column on `experts` | (none) | Lesson 40 will need a migration to add `search_tsv` and a GIN index. |
| No `bayesian_rating` generated column | (none) | Lesson 40 will need the column added. |
| `experts.category_id` has no index | (per Lesson 02/03 audit) | A `WHERE category_id = ?` query does a sequential scan. At 100k experts, that's 100k row reads per query. |
| `experts.verification_status` has no index | (per Lesson 02/03 audit) | A "verified only" filter does a sequential scan. |
| `expert_qualifications(qualification_id, expert_id)` doesn't exist | (Lesson 03 audit) | Facet counts for qualifications are N+1. |
| `expert_languages`, `expert_organizations`, `expert_prices` same | (Lesson 03 audit) | Same. |
| `Profile` entity doesn't exist | (Lesson 05 audit) | `JOIN profiles p ON p.user_id = u.id` will fail. |
| `Category` has no `parent_id` index | (Lesson 02/03 audit) | Recursive CTE is `O(depth × N)` without the index. |
| No Redis in the stack | (Lesson 05 audit) | The "cache search results for 60s" plan needs Redis. |

**Lesson 30 ships none of these fixes.** It assumes Lessons 02/03/05/20 are all in. The lesson's job is to design the query, not to build the indexes. But the pre-ship checklist in §22 calls out which of these must be done before Lesson 40 can ship.

### 3.1 Why the "empty service" state is the right starting point

A junior engineer might "fill in" the empty `experts.service.ts` with placeholder methods. **Don't.** The empty service is a signal that the design is not yet decided. Writing `findAll()` before deciding on pagination, filtering, ranking, and faceting produces a method that has to be rewritten when those decisions are made.

Lesson 30 is the design lesson. Lesson 40 is the implementation. The gap between them is *intentional* — you should not write the implementation until you can answer every question in §23 (the self-check).

---

## 4. Concepts

### 4.1 The three-stage pipeline

```
                 ┌──────────────┐
   User input ──►│   Intent    │  (q, category, location, ...)
                 └──────┬───────┘
                        ▼
                 ┌──────────────┐
                 │   Filters    │  (WHERE category_id = … AND …)
                 └──────┬───────┘
                        ▼
                 ┌──────────────┐
                 │   Ranking    │  (ORDER BY score DESC, …)
                 └──────┬───────┘
                        ▼
                  Experts + facets + suggestions
```

- **Intent:** what does the user want? For our MVP, the *intent* is implicit in the params (`q` → text search; `category_id` → filter; both → both).
- **Filters:** the `WHERE` clause. AND across filters, OR within multi-selects.
- **Ranking:** the `ORDER BY` clause, which uses a computed score expression.

**Why three stages, not one?** Because filtering and ranking have different jobs. Filtering says "who qualifies"; ranking says "in what order". If you conflate them — e.g. by hardcoding `WHERE avg_rating >= 4.5` for "best experts" — you've removed the user's ability to opt out.

### 4.2 Why the order matters

Filters before ranking: if a user filters to "verified experts in Cairo with rating ≥ 4", they don't care about a 4.9 expert in Alexandria. **Filter first; rank what's left.**

Ranking before pagination: `LIMIT 20 OFFSET 0` after a `ORDER BY score DESC` gives the top 20. The pagination is on the *ranked* set. If you paginate first and rank second, the top of page 2 is unranked.

Facets after filters: facets reflect "how many in *this filter context*". If a user filters to Cairo, the qualification facet is "how many Cairo experts have BSc". The count is 47, not 240. **Facets are conditional counts, not global counts.**

### 4.3 The Postgres text-search toolkit

Postgres gives us four tools. Pick the cheapest that meets the requirement.

| Tool          | What it does                                                  | Cost            | Use when                                              |
|---------------|---------------------------------------------------------------|-----------------|-------------------------------------------------------|
| `ILIKE`       | Case-insensitive substring match                              | Full table scan unless prefix-anchored | Simple "starts with" autocompletes (`name LIKE 'Lun%'`) |
| `pg_trgm`     | Trigram index → fuzzy substring matching                      | Index lookup    | Typo tolerance ("Luna" vs "Lna")                      |
| `tsvector`    | Tokenized, stemmed, weighted full-text                        | GIN index lookup| Real word-level search across multiple fields         |
| External (Meilisearch, Elasticsearch) | Pre-built search engine with faceting, fuzzy, ML | Infrastructure cost | Scale, multi-lingual, ML ranking              |

**Our choice:** `tsvector` for the main search (multi-field, multi-word, weighted), `pg_trgm` as a fallback for short queries / typos, `ILIKE` for autocomplete on category/organization names.

**Why not Elasticsearch yet?** It would let us skip ranking tuning, faceting, and partial indexes. But it adds an entire service to operate, and our schema doesn't justify it at MVP scale. Lesson 50 lists the migration path: when `EXPLAIN ANALYZE` shows > 200ms p95, *then* evaluate.

### 4.4 When to graduate from `tsvector` to Elasticsearch

A rough decision tree:

- **< 100k experts, single language**: `tsvector` is enough. p95 < 50ms.
- **100k–1M experts, single language**: `tsvector` is enough but you need careful indexing. p95 < 200ms with proper indexes.
- **1M+ experts, single language**: consider Elasticsearch. `tsvector` indexes become huge; ranking becomes a bottleneck.
- **Any size, multi-language**: Elasticsearch, because multi-language tokenization and stemming is what it does best.
- **Any size, ML ranking (click-through rate, embeddings)**: Elasticsearch with a learning-to-rank plugin, or a vector DB (Pinecone, Weaviate) for semantic search.

Our MVP is 10k experts in English. **`tsvector` is correct. Do not over-engineer.**

### 4.5 `tsvector` in one paragraph

A `tsvector` is a sorted list of lexemes (normalized tokens) with position info. Postgres provides `to_tsvector('english', 'Dr. Luna Ahmed')` → `'luna':2 'dr.':1 'ahmed':3`. You index this column with GIN, then query with `@@ to_tsquery('english', 'luna')`.

The `ts_rank` function returns a relevance score (0..1-ish, not normalized across queries). You can weight fields: `setweight(to_tsvector(name), 'A') || setweight(to_tsvector(bio), 'B')` puts matches in `name` higher than in `bio`.

For your schema, the searchable fields are:

```ts
setweight(to_tsvector(coalesce(profile.full_name, '')), 'A')
|| setweight(to_tsvector(coalesce(expert.bio, '')), 'B')
|| setweight(to_tsvector(coalesce(category.name, '')), 'C')
|| setweight(to_tsvector(coalesce(organization.name, '')), 'C')
```

(A/B/C/D weights rank as 1.0/0.4/0.2/0.1 by default.)

### 4.6 The position info in `tsvector` is what enables phrase queries

`'luna':2 'ahmed':3` — the numbers are positions. `to_tsquery('luna <2> ahmed')` matches documents where 'luna' is within 2 positions of 'ahmed'. **This is what makes "Luna Ahmed" rank higher than "Ahmed who knows someone called Luna's mother."**

For the MVP, we don't use position queries. We use `plainto_tsquery` which ignores position. The position info is there for free; we just don't query on it. Lesson 50 adds phrase queries for power users.

### 4.7 The scoring function

A score expression like this:

```sql
ts_rank(expert_search_tsv, plainto_tsquery('english', :q))   -- text match
+ CASE WHEN expert.verification_status = 'verified' THEN 0.5 ELSE 0 END
+ CASE WHEN category.id IN (
    WITH RECURSIVE cat AS (
      SELECT id FROM categories WHERE id = :categoryId
      UNION
      SELECT c.id FROM categories c JOIN cat ON c.parent_id = cat.id
    )
    SELECT id FROM cat
  ) THEN 0.3 ELSE 0 END
+ bayesian_rating(expert.avg_rating, expert.review_count, 3.5, 10)
```

**Why Bayesian-adjusted rating?**

A 5.0 from 1 review shouldn't outrank a 4.7 from 200 reviews. The Bayesian average solves this:

```
adjusted = (v / (v + m)) * R + (m / (v + m)) * C

where:
  R = expert's avg_rating
  v = expert.review_count
  m = minimum reviews to trust (we use 10)
  C = global mean rating (we use 3.5)
```

The intuition: until an expert has `m` reviews, lean toward `C`. As reviews grow, lean toward `R`. This shrinks the variance of "lucky one-review wonders".

Lesson 40 implements this as a generated column on `experts` so it's computed once and indexed, not on every query.

### 4.8 The score weights, defended

The expression above adds:
- `ts_rank(...)` — typically 0.0 to 1.0. For a strong match across multiple fields, ~0.5.
- `+ 0.5` if verified.
- `+ 0.3` if in the searched category (recursively).
- `+ bayesian_rating` — typically 0.0 to 1.0 (since ratings are 0-5 and we divide by 5, and Bayesian shrinks toward 3.5/5 = 0.7).

Why these specific values?
- A verified expert with no text match and no category match has score = 0.5 + 0.7 = 1.2.
- An unverified expert with a strong text match and category match has score = 0.5 + 0.3 + 0.7 = 1.5.
- A verified expert with a text match and category match has score = 0.5 + 0.5 + 0.3 + 0.7 = 2.0.

The relative magnitudes matter more than the absolute values. The rule: **text match ≅ category match ≅ verification**. The product team can tune these later; the engineering lesson is the *structure* (additive, bounded, not multipled) not the numbers.

If we multiplied instead of added: `ts_rank × 0.5_verified × 0.3_in_category × bayesian` — a single missing signal would zero out the whole score. A verified expert in the wrong category would rank below an unverified expert. That's wrong UX. **Additive scoring is the right default.**

### 4.9 Facets — and why they're free if you're careful

Faceted search answers "how many of the current results would match *if* I also filtered by X?". The naïve way:

```sql
SELECT qualification_id, COUNT(*) FROM expert_qualifications
WHERE expert_id IN (...current result ids...)
GROUP BY qualification_id;
```

This requires you to *have* the current result ids, which means you have to *finish* the search first. The smarter way:

```sql
SELECT q.id, q.name, COUNT(*) FROM qualifications q
JOIN expert_qualifications eq ON eq.qualification_id = q.id
WHERE eq.expert_id IN (
  -- the same WHERE clause from the main search, *without* the qualifications filter
)
GROUP BY q.id
ORDER BY 2 DESC;
```

This re-uses the same filter machinery; it's almost free.

### 4.10 The "facet without the active filter" rule

The facet query *removes* the filter on the faceted field. The qualification facet says "if I were to also filter by BSc, how many of the current results would still match?". This is the **decision-support** question. If we included the qualification filter in the facet query, the count would always be 1 (the user just selected it) or 0 (an empty result).

**The facet is "given my OTHER filters, what would each option of THIS filter give me?"**

Implementation: the search service builds the same `WHERE` clause as the main query, then *strips* the filter on the field being faceted, then groups by that field. The cost is one query per facet, all in parallel.

### 4.11 Pagination: offset vs. keyset

| Approach  | How                                                                 | When to use                              |
|-----------|---------------------------------------------------------------------|------------------------------------------|
| Offset    | `LIMIT 20 OFFSET 4000`                                              | Admin tools; depth-of-result UI         |
| Keyset    | `WHERE (created_at, id) < (:lastCreatedAt, :lastId) ORDER BY ...`   | Infinite scroll, large result sets      |

For our search we use offset (small page numbers, predictable URLs). Lesson 50 lists the migration to keyset if/when result sets grow.

### 4.12 The cost of deep offset

`OFFSET 10000` makes Postgres *read* 10,020 rows and *return* 20. The read is the cost, not the return. At p99 with 100ms per 1000 rows, page 500 is 5 seconds. This is unacceptable for a UI.

Two options:
- **Cap offset**: `OFFSET 1000` is the maximum. Page 50 is the last page. UI shows "Refine your search" if you hit the cap.
- **Keyset pagination**: `WHERE (score, id) < (:lastScore, :lastId)` reads exactly 20 rows. p99 is constant.

For 10k experts and `LIMIT 20`, offset works up to ~50 pages. Beyond that, keyset. **We use offset for the MVP; the migration to keyset is a Lesson 50 concern.**

### 4.13 Empty-result suggestions — server-side relaxation

The UI's "No results" message is better when the server says *which* filter to relax. Algorithm:

```
empty = run query → 0 rows
for each filter f:
    relaxed = run query with f removed
    if relaxed > 0:
        suggest(f)
sort suggestions by impact (more matches first)
return top 3
```

This costs N+1 queries for N filters. Acceptable for empty results (rare path); for non-empty results, you don't compute suggestions.

### 4.14 Why we relax filters, not loosen them

"Relaxing a filter" means removing it entirely (drop `min_rating`, drop `verified`). "Loosening" would mean changing `min_rating = 4.5` to `min_rating = 4.0`. Loosening requires understanding each filter's semantics (what's a "looser" language filter? a "looser" location filter?). Removing is uniform: drop the predicate, see what comes back.

The trade-off: removing a category filter may return 10,000 results, suggesting the user "broaden the category" even though they really wanted "broaden the location". A smarter system would rank suggestions by user intent. **For the MVP, drop-and-count is the right level of effort.**

### 4.15 Caching strategy

Two cache layers:

1. **Per-request result cache (Redis):** key = `sha256(sorted query params)`. TTL 60s. Works because search queries are mostly repeated.
2. **HTTP cache (CDN/Cloudflare):** for *anonymous* search results, `Cache-Control: public, max-age=30`. Stale-while-revalidate for snappy UX.

Authenticated searches don't get cached by CDN (response includes user-specific fields).

### 4.16 The cache-stampede failure mode

If 1000 requests for the same search arrive within 100ms (e.g., a popular tweet linking to your search), and the cache expires, all 1000 hit Postgres simultaneously. Postgres handles ~1000 concurrent queries slowly. The 1001st user waits 30 seconds.

The fix: **request coalescing** in the cache layer. The first request to find an expired key sets a "lock" in Redis (`SET key:lock 1 NX EX 5`). Other requests see the lock, wait 100ms, re-check. Only one request hits Postgres per expiration.

Lesson 50 implements this with a Redis lock. Lesson 30 just notes it.

### 4.17 The authenticated-cache decision

Auth'd searches are typically personalized (e.g., "experts in your city", "experts you've contacted before"). Caching them by query string alone is wrong — the same query returns different results for different users.

Two approaches:
- **Don't cache auth'd searches at all.** Simplest. Each request hits Postgres. For 1K auth'd users, that's 1K qps.
- **Cache by (user_id, query_params).** Per-user cache. Cache hit rate is low (each user's queries differ), so this is mostly a wasted layer.

For the MVP, we don't cache auth'd searches. We cache anonymous. Auth'd users are power users; their p99 can be 200ms instead of 50ms.

### 4.18 Indexes — what to add before launching

For search, the minimum index set:

| Index                                              | Why                                                                    |
|----------------------------------------------------|------------------------------------------------------------------------|
| `experts(category_id, status, avg_rating DESC)`    | Category browse + default sort                                          |
| `experts(verification_status) WHERE status='active'` | Verified-only filter, partial                                          |
| `experts USING GIN (search_tsv)`                   | Full-text search                                                       |
| `experts USING GIN (name gin_trgm_ops)`             | Trigram name search (Lesson 40)                                        |
| `expert_qualifications(qualification_id, expert_id)` | Reverse direction for facet counts                                    |
| `expert_languages(language_id, expert_id)`         | Same                                                                   |
| `expert_organizations(organization_id, expert_id)` | Same                                                                   |
| `expert_prices(price_id, expert_id)`               | Same                                                                   |

Each is justified by either a query path or a facet computation.

### 4.19 The partial index on `verification_status` is non-obvious

`experts(verification_status) WHERE status='active'` — the index is only built for active experts. Why?

- 95% of experts are `active` and `verified`. 5% are inactive. Indexing all rows: 5% are never queried (inactive). Wasted space.
- More importantly: a query like `SELECT * FROM experts WHERE verification_status = 'verified' AND status = 'active'` will use the partial index efficiently because both predicates are satisfied.
- A query like `SELECT * FROM experts WHERE verification_status = 'pending'` will *not* use the partial index. That's correct — admin tools that look at pending experts are rare; we don't optimize for them.

**The partial index is a signal of "this is the hot path" baked into the schema.** Maintenance: when an expert changes status from `active` to `inactive`, the index entry is removed. The cost of that removal is a one-row index delete, which is fast.

### 4.20 The GIN index size cost

A GIN index on a `tsvector` column is **3-5x the size of the indexed data**. For 100k experts with a 500-byte `search_tsv` each, the index is 50MB × 4 = 200MB. This is fine for one column, but if you have 5 GIN indexes, your database is now 5x the size of the raw data. Lesson 50 covers column-pruning and partial GIN indexes for the cases where this becomes a problem.

### 4.21 The "no SQL injection here, but…" rule

Our DTO uses `class-validator` and TypeORM's `QueryBuilder`. We **never** concatenate user input into SQL. `where('name = :name', { name })` is parameterized. `where('name ILIKE :q', { q: `%${q}%` })` is parameterized **but** the wildcard `%` is added in code, not in user input. If a user types `%`, it's escaped because `LIKE` treats it as a literal only if `ESCAPE` is set; Lesson 40 sets `ESCAPE` defensively.

### 4.22 The `LIKE` escape rule

`LIKE 'foo%bar'` matches "fooANYTHINGbar". If a user types `100%` in the search box, the query becomes `LIKE '%100%%'` which matches everything. The fix:

```sql
WHERE name ILIKE :q ESCAPE '\'
-- :q is '%100\%%' (the user's % is now escaped)
```

The `ESCAPE '\'` tells `LIKE` that `\%` is a literal percent. **Always set ESCAPE in production code.** The default is no escape, which is a footgun.

---

## 5. Decision points

| Decision                                                | My choice                                                  | Push back if…                                              |
|---------------------------------------------------------|------------------------------------------------------------|------------------------------------------------------------|
| Full-text engine                                        | `tsvector` + GIN                                           | You have > 500k experts and need typo tolerance + facets    |
| Typo tolerance                                          | `pg_trgm` fallback when `tsvector` returns 0 rows          | Your users don't make typos (unlikely)                      |
| Score weights                                           | A=name, B=bio, C=category, C=org                           | You want orgs to rank higher than category (unusual)        |
| Bayesian prior (m, C)                                   | m=10, C=3.5                                                | Your domain has different review norms                       |
| Default sort                                            | `score DESC, review_count DESC`                            | UI explicitly requests sort=rating/reviews/newest/price      |
| Pagination                                              | Offset, `per_page=20`                                      | You'll have > 100k experts and infinite scroll              |
| Facet count thresholds                                  | Hide facets with < 1 result                                | You want to show all (UI choice)                            |
| Empty-result suggestions                                | Up to 3, server-computed                                   | You want client-side suggestions                            |
| Anonymous caching                                       | 30s CDN cache                                              | All results are user-personalized (then no caching)         |
| Free-text multi-word `q`                                | `plainto_tsquery`                                          | You want phrase support (`phraseto_tsquery`)                |
| Search across sub-categories                            | Recursive CTE on `categories` to expand                    | Sub-categories are flat                                    |

### 5.1 Why `plainto_tsquery` and not `to_tsquery`

`to_tsquery('luna & ahmed')` is strict — the user must write valid query syntax. `plainto_tsquery('luna ahmed')` is forgiving — it treats input as words to AND together. For a marketplace search box, the user types "Luna Ahmed" expecting both words. `plainto_tsquery` is correct.

The trade-off: `to_tsquery` allows advanced syntax (`luna | ahmed` for OR, `luna & !ahmed` for NOT). We don't expose this because the UI is a single text box. Power users can use the advanced filter UI instead.

### 5.2 Why `m=10, C=3.5` for Bayesian

`m=10` is the "minimum reviews to trust" threshold. Below 10, we lean toward `C`. The choice of 10 is empirical: marketplaces show that 10 reviews is roughly where the average stabilizes.

`C=3.5` is the global mean. We choose 3.5 (not 5) because:
- A 5-star average is a sign of rating inflation, not quality. Real quality has 4.0-4.5.
- 3.5 is the average of typical review distributions.
- If your domain has different norms (e.g., medical experts, where 4.8 is normal), use a different `C`.

**Tune these values with A/B testing once you have traffic.** The lesson's defaults are placeholders.

---

## 6. Worked example — the SQL we will write in Lesson 40

Given this query:

```
GET /api/v1/search/experts?q=python&category_id=12&min_rating=4.5&languages[]=1&languages[]=2&verified=verified
```

The SQL we build (roughly):

```sql
WITH RECURSIVE cat_tree AS (
  SELECT id FROM categories WHERE id = $1
  UNION
  SELECT c.id FROM categories c JOIN cat_tree t ON c.parent_id = t.id
),
qualifying_experts AS (
  SELECT e.*
  FROM experts e
  WHERE e.status = 'active'
    AND ($1::int IS NULL OR e.category_id IN (SELECT id FROM cat_tree))
    AND ($2::int IS NULL OR e.avg_rating >= $2)
    AND e.verification_status = 'verified' -- $3 verified filter
    AND (
      $4::text IS NULL OR e.search_tsv @@ plainto_tsquery('english', $4)
    )
  ORDER BY (
        ts_rank(e.search_tsv, plainto_tsquery('english', $4))
        + CASE WHEN e.verification_status = 'verified' THEN 0.5 ELSE 0 END
        + e.bayesian_rating
      ) DESC,
      e.review_count DESC
  OFFSET $5 LIMIT $6
)
SELECT
  e.*, u.email, p.full_name, c.name AS category_name
FROM qualifying_experts e
JOIN users u ON u.id = e.user_id
JOIN profiles p ON p.user_id = u.id
JOIN categories c ON c.id = e.category_id;
```

**Plus parallel queries for facets and suggestions.** Three queries total per search; the heavy work is in the CTE + indexed scan.

### 6.1 Walking through the SQL

The CTE `cat_tree` materializes the category subtree rooted at `$1`. The query `category_id IN (SELECT id FROM cat_tree)` then uses that materialized set. This is **O(1) per expert** instead of **O(depth) per expert** (without the CTE).

The `qualifying_experts` CTE is the "filtered and ranked" set. Note:
- `($1::int IS NULL OR ...)` — the SQL idiom for "if the parameter is null, don't filter". This is the single most common search-query pattern.
- The `ORDER BY` uses an expression, not a column. The expression combines `ts_rank`, verification status, and Bayesian rating. Postgres can't use a simple index for this; it must compute the expression for every row. **At 100k rows, this is the bottleneck.** Lesson 40 mitigates by pre-computing `bayesian_rating` as a generated column and indexing it.

The final `SELECT` joins `users`, `profiles`, `categories`. Three joins on indexed FKs are fast. The result is the API response shape.

### 6.2 Why we join in the final SELECT, not in the CTE

If we joined in the CTE, the `LIMIT 20` would be applied *after* the joins, meaning we'd scan all 100k experts and join all their profiles before limiting. By selecting only `e.*` in the CTE and joining after the limit, we join only 20 rows. **The join order matters for performance.**

The cost: the CTE doesn't have access to the joined columns for ranking. We can't rank by `category.name` unless we join categories in the CTE. The Lesson 40 implementation makes this trade-off explicitly: rank in the CTE, join after.

### 6.3 The `LIMIT 20 OFFSET 0` gotcha

`OFFSET 0` is a no-op in modern Postgres. `OFFSET 1` skips 1 row. **Always set `OFFSET` to an integer, never null.** If `OFFSET NULL`, the query errors. If the user passes `?page=0`, translate to `OFFSET 0` explicitly.

`LIMIT 0` is also a footgun. It returns 0 rows but still scans. Use `LIMIT NULL` (or omit) to mean "no limit".

---

## 7. Performance math — what to expect at MVP scale

- **10k experts, all verified, 5 categories, no text query**: 30ms p95. Postgres uses the `(category_id, status, avg_rating DESC)` index, does 1 index range scan + 1 sort + LIMIT 20. No text matching.
- **10k experts, 30% match `q='python'`**: 50ms p95. GIN index on `search_tsv` returns 3000 candidate rows. We rank them. The sort is on 3000 rows, not 10k. The Bayesian+ts_rank expression is fast.
- **100k experts, 30% match `q='python'`**: 200ms p95. GIN returns 30k rows. The sort is on 30k. The expression evaluation per row is the bottleneck.
- **1M experts**: 1.5s p95. Now you need Elasticsearch.

The threshold is "if p95 > 200ms, look harder". For 10k-100k experts, the lesson's design is within budget. Beyond 100k, you'll revisit.

### 7.1 What `EXPLAIN ANALYZE` should look like for a healthy search

```sql
EXPLAIN (ANALYZE, BUFFERS, TIMING) 
SELECT e.* FROM experts e
WHERE e.status = 'active' AND e.category_id = 12
ORDER BY (
  ts_rank(e.search_tsv, plainto_tsquery('english', 'python'))
  + CASE WHEN e.verification_status = 'verified' THEN 0.5 ELSE 0 END
  + e.bayesian_rating
) DESC
LIMIT 20;
```

Expected:
- `Bitmap Index Scan on idx_experts_category_status` (or similar).
- `Sort  (cost=... rows=... width=...)` then `LIMIT`.
- Total time: < 50ms for 10k experts.

**What you don't want to see:**
- `Seq Scan on experts` — full table scan. Means an index is missing or unused.
- `Sort  (cost=... rows=1000000 ...)` — sorting all 1M rows. The index isn't being used for ordering.
- `Bitmap Heap Scan with Recheck Cond` — fine, but the `Recheck` is happening because the index is lossy. Consider if it's worth a different index type.

### 7.2 The "rows estimated vs actual" check

`EXPLAIN ANALYZE` shows two numbers per node: `rows=NNN` (estimated) and `actual rows=NNN` (real). If estimated ≠ actual by 10x or more, your statistics are out of date. Run `ANALYZE experts;` to refresh.

Postgres uses these estimates to choose the plan. Wrong estimates → wrong plan → slow query. **Run `ANALYZE` after any bulk insert or delete.**

---

## 8. Security implications

Search has two security boundaries: SQL injection and PII leakage. Both are addressed by design.

### 8.1 SQL injection

- **All user input goes through `class-validator`** at the controller. Email is an email, integer is an integer, enum is an enum. A user typing `' OR 1=1 --` is rejected at the controller; the service never sees it.
- **All SQL parameters are bound** via TypeORM's `QueryBuilder`. `where('name = :name', { name: userInput })` is `WHERE name = $1` with the value bound. No string concatenation.
- **`LIKE` wildcards are added in code**, not in user input. The user types `100%`; we escape it to `100\%` before passing to `LIKE`. The `\` is the escape character (set via `ESCAPE '\'`).
- **Numeric parameters are cast in SQL**: `$1::int`. A user typing `'abc'` for a numeric filter is rejected by the cast.

### 8.2 PII leakage in search results

The naïve search returns the full `User` row, including `passwordHash` (if `select: false` is forgotten) and `email`. The search response should include only what the UI needs.

**The rule: search results are public-facing**. An unauthenticated user hitting `GET /api/v1/search/experts` should see `name`, `bio`, `category`, `rating`, `review_count`, and a subset of public profile fields. They should *not* see `email`, `phone`, `passwordHash`, `internal_notes`, `tokenVersion`, or any admin-only field.

A DTO is the right boundary:

```ts
export class ExpertSearchResultDto {
  id: number;
  fullName: string;
  bio: string;
  categoryName: string;
  avgRating: number;
  reviewCount: number;
  verificationStatus: 'verified' | 'pending' | 'unverified';
  // explicitly NOT: email, phone, passwordHash, tokenVersion
}
```

The service maps the entity to the DTO. The DTO is the API contract. **A field that isn't in the DTO cannot leak.**

### 8.3 The "rank by verification" leakage

A subtle leak: ranking unverified experts lower than verified means a user can deduce "the 21st result is unverified" by paging past the verified ones. If your policy is to *hide* unverified experts (not just deprioritize), the search response should not include them at all — `WHERE verification_status = 'verified'` is the filter, and there's no ranked position 21.

The lesson's design uses ranking, not filtering, for verification. **This is a product call.** If "unverified" means "we don't trust them", rank them down. If "unverified" means "we haven't checked yet", include them with a badge.

### 8.4 The empty-result enumeration

If a user searches `q='admin@company.com'` and gets 0 results, they learn that no expert's email contains that string. If they search `q='admin'` and get 50 results, they learn that some expert's name contains "admin".

This isn't a real leak (the user could enumerate experts by category, by location, etc.) but it's worth noting: **search results are themselves an information disclosure**. Rate-limiting search is the right defense.

### 8.5 Rate limit math for search

- Anonymous user: 30 searches/minute. After that, 429. The 30/min is enough for human use; bots get blocked.
- Authenticated user: 120 searches/minute. The auth gives us a per-user key, so a single user can't DoS by exhausting the anonymous bucket.
- Search per-IP: 300/minute. Across all users on a corporate NAT.

The combination: 30/min for anonymous (defense against bots), 120/min per user (defense against compromised accounts), 300/min per IP (defense against botnets).

---

## 9. Observability hooks

Search has the highest query volume of any endpoint. The observability story is critical.

### 9.1 Stable action vocabulary for search

- `search.experts.success` — successful search, with `result_count`, `latency_ms`, `cache_hit`.
- `search.experts.empty` — successful search returning 0 results, with `filters_relaxed` (which suggestions were computed).
- `search.experts.error` — search failed, with `error_code`.
- `search.experts.slow` — search returned but latency > 200ms, with `latency_ms`, `query_plan_summary`.
- `search.suggest.relax_filter` — empty-result suggestion was computed, with `filter_name`, `relaxed_count`.

### 9.2 What to log on every search

- `requestId` — from `RequestIdInterceptor`.
- `userId` if authenticated.
- `query_params` — the full query (NOT the user's IP; the IP is logged at the request level).
- `result_count` — number of experts returned.
- `latency_ms` — server-side time, not network round-trip.
- `cache_hit` — true/false. Hit rate over time is a key metric.
- `slow_query_plan` — only if `latency_ms > 200`. Log the `EXPLAIN ANALYZE` output.

### 9.3 What to alert on

- `search.experts.slow` rate > 5% over 5 minutes — index is missing or degraded. Page.
- `cache_hit_rate < 30%` over 1 hour — cache is not working. Investigate.
- `search.experts.empty` rate > 50% over 1 hour — users can't find anything. Product issue or index issue.
- `search.experts.error` rate > 1% over 5 minutes — Postgres is sick. Page.
- p99 latency > 500ms over 5 minutes — capacity issue or query plan regression.

### 9.4 The `pg_stat_statements` view

Postgres's `pg_stat_statements` extension records every query, its `total_exec_time`, `mean_exec_time`, and call count. For search:

```sql
SELECT query, calls, mean_exec_time, total_exec_time
FROM pg_stat_statements
WHERE query LIKE '%experts%search%'
ORDER BY mean_exec_time DESC
LIMIT 20;
```

This is the **source of truth for "what is slow"**. Slow query logs are noisy; `pg_stat_statements` aggregates. **Always install `pg_stat_statements` in production.**

---

## 10. Debugging recipes

### 10.1 "Search returns 0 results for a query that should match"

1. Check the `search_tsv` column for a known matching expert: `SELECT id, search_tsv FROM experts WHERE id = 42`. If it's empty, the `tsvector` was never populated. The migration's `UPDATE ... SET search_tsv = ...` was skipped.
2. Run the `to_tsquery` directly: `SELECT plainto_tsquery('english', 'luna')`. If it returns empty, the input is all stopwords ("the", "a", "of"). The user typed a stopword-only query.
3. Run the `@@` directly: `SELECT id FROM experts WHERE search_tsv @@ plainto_tsquery('english', 'luna') LIMIT 5`. If this returns 5 rows, the issue is in the higher-level query, not the text matching.
4. Check the filters: comment them out one by one. "Verified only" might be excluding the expert. "Category filter" might be excluding the expert. Walk the filter stack.
5. Check the `EXPLAIN ANALYZE`. The query might be doing a sequential scan and timing out before returning 0 rows.

### 10.2 "Search is slow (> 1s) on the first call but fast after"

The first call is the cold cache. Postgres loads the index into shared buffers. Subsequent calls are fast. This is **expected** and not a bug. The fix is to pre-warm the cache (run the most common 100 queries on deploy).

### 10.3 "Search returns the same expert 3 times"

The expert has 3 rows in `experts` (e.g., a soft-delete didn't actually delete). Or, the join is duplicating. `SELECT COUNT(*) FROM experts` should match the user-visible expert count. If it doesn't, there's data corruption.

Another cause: a category filter via the recursive CTE that includes the expert's category 3 times. The CTE is buggy. Add `DISTINCT` to the CTE result.

### 10.4 "Search returns 0 verified experts when 90% are verified"

The `WHERE verification_status = 'verified'` filter combined with the `WHERE status = 'active'` filter is using a partial index. Check that the partial index is built: `\d experts` in psql shows the indexes. The partial index `experts(verification_status) WHERE status='active'` must exist.

If the index exists but isn't used, the query is not what you think it is. Run `EXPLAIN` to see.

### 10.5 "Facets return 0 for all options but the search returns results"

The facet query has the same `WHERE` clause as the main query, *minus* the filter on the faceted field. If the facet for "BSc" returns 0 but the main search has 50 results, the join `JOIN expert_qualifications eq ON eq.qualification_id = q.id` is excluding the experts. **The main query's filters must be applied to the facet query too, except the faceted field's filter.**

### 10.6 "The Bayesian score is all the same"

`bayesian_rating` is computed as a generated column. If it's the same for every expert, the column is using a constant (e.g., `m` and `C` are hardcoded, not parameterized). Or, every expert has `review_count = 0` (the function returns `C` in that case).

Check: `SELECT id, avg_rating, review_count, bayesian_rating FROM experts ORDER BY id LIMIT 10`. If `bayesian_rating = 0.7` for all of them, either the column wasn't recomputed or `review_count` is always 0.

### 10.7 "The `ts_rank` is always 0 even for matching queries"

The `ts_rank` function returns 0 if the `tsvector` doesn't have position info that overlaps with the `tsquery`. Check:
1. The `tsvector` has the lexeme: `SELECT id, search_tsv FROM experts WHERE id = 42`. Look for the word in the output.
2. The `tsquery` is built correctly: `SELECT plainto_tsquery('english', 'luna')` returns `'luna'`. If the user typed "Luna!" the `plainto_tsquery` strips punctuation and lowercases. Result is `'luna'`.
3. The `@@` operator matches: `WHERE search_tsv @@ plainto_tsquery('english', 'luna')`. If this returns 1 row but `ts_rank` is 0, the rank function is being called wrong (missing argument, wrong argument order).

### 10.8 "Recursive CTE returns infinite loop"

A category tree shouldn't have cycles, but if you have bad data (`A.parent_id = B`, `B.parent_id = A`), the CTE loops. Postgres has a `CYCLE` clause to detect this:

```sql
WITH RECURSIVE cat_tree AS (
  SELECT id, parent_id, false AS is_cycle FROM categories WHERE id = $1
  UNION ALL
  SELECT c.id, c.parent_id, c.parent_id = ANY(...) FROM categories c JOIN cat_tree t ON c.parent_id = t.id WHERE NOT t.is_cycle
) ...
```

Or, **enforce a CHECK constraint or trigger at the DB level** that prevents cycles. Lesson 03 covered the trigger.

---

## 11. Testing strategy

Search has three test layers: unit, integration, performance.

### 11.1 Unit tests for the search service

- Filter parsing: given a query DTO, the service builds the right `WHERE` clause.
- Score weights: given two experts (one verified, one not), the verified one scores higher.
- Bayesian prior: an expert with 1 review at 5.0 ranks below an expert with 100 reviews at 4.5.
- Empty result suggestions: when 0 results, the top 3 filters to relax are returned.
- Facet computation: given a filter set, the facet counts are correct.

### 11.2 Integration tests against a real Postgres

- 10k fake experts seeded.
- Search "Luna" with category=12 → expected experts in expected order.
- Search with all filters → 0 results → suggestions returned.
- Search with `min_rating=4.5` → only experts with rating ≥ 4.5.
- Search with multiple languages → experts speaking *any* of the languages.

### 11.3 Performance tests

- 100k fake experts.
- Run the 20 most common queries; assert p95 < 200ms.
- Run with cache cold; assert p99 < 500ms.
- Run a sequential scan-causing query (e.g., `WHERE bio LIKE '%python%'`); assert it's caught by a regression test.

The performance test is the most valuable. A query that returns the right rows in 5 seconds is a regression that won't be caught by a unit test.

### 11.4 The seed-data realism

Unit tests with 5 experts don't catch N+1. Integration tests with 10 experts don't catch missing index. Performance tests with 100k are the only way to catch "this is fine on my laptop, broken in prod". **Seed with realistic distributions**: most experts have 1-10 reviews, a few have 1000+, ratings cluster around 4.0-4.5.

A simple seed:

```ts
// In a test fixture
for (let i = 0; i < 100_000; i++) {
  await expertRepo.save({
    fullName: `Expert ${i}`,
    bio: faker.lorem.paragraph(),
    categoryId: faker.helpers.arrayElement([1, 2, 3, 4, 5]),
    avgRating: faker.number.float({ min: 1, max: 5, fractionDigits: 2 }),
    reviewCount: faker.helpers.weightedArrayElement([
      { weight: 50, value: faker.number.int({ min: 0, max: 10 }) },
      { weight: 30, value: faker.number.int({ min: 10, max: 50 }) },
      { weight: 15, value: faker.number.int({ min: 50, max: 200 }) },
      { weight: 5, value: faker.number.int({ min: 200, max: 1000 }) },
    ]),
    verificationStatus: faker.helpers.weightedArrayElement([
      { weight: 80, value: 'verified' },
      { weight: 15, value: 'pending' },
      { weight: 5, value: 'unverified' },
    ]),
  });
}
```

This produces a realistic distribution: 80% verified, most have few reviews.

---

## 12. Common mistakes

| Mistake | Symptom | Fix |
|---|---|---|
| `SELECT * FROM experts ORDER BY avg_rating DESC LIMIT 20` | Slow at 100k rows, no ranking by relevance | Use the lesson's score expression |
| Forgetting `LIMIT 20` in the search | Returns 100k rows, kills the network | Always paginate |
| Using `to_tsquery` with user input | Crashes on stopwords, special chars | Use `plainto_tsquery` |
| `WHERE name ILIKE '%luna%'` | Sequential scan, no index can speed it up | Use GIN on `tsvector` or GIN on `name gin_trgm_ops` |
| Putting `ORDER BY` in the controller, sorting in app code | App receives 10k rows, sorts in memory | Sort in SQL |
| Joining all relations in the main query | N+1 by accident | Use a SELECT-with-joins in the final step, not in the WHERE |
| Faceting the same field being filtered | Returns 0 or 1, not useful | Strip that field's filter from the facet query |
| Offset pagination at 10k+ pages | p99 = 5s | Cap offset, migrate to keyset |
| `SELECT * FROM experts` including `passwordHash` | PII leak | DTO is the contract; entity is not |
| Building `search_tsv` in the application | Stale data, race conditions | Generated column on the DB |
| `ts_rank` without position info | Always returns 0 | Use the `tsvector` from the column, with positions |
| No `ANALYZE` after bulk insert | Bad query plans | `ANALYZE experts;` after seed/import |
| Sorting by `review_count` for "best" experts | One-review wonder at top | Use Bayesian rating |
| Facet query includes the filter being faceted | Always 0 or 1 | Strip that filter from the facet query |
| Cache key without user/role | Auth'd user gets anon results | Hash user_id + query params |
| Cache key without sorting params | `?sort=rating` and `?sort=reviews` hit same cache | Include all sort/filter params in the key |
| "Search by partial word" using `LIKE '%lun%'` | Seq scan | Use `pg_trgm` GIN index for trigram matches |
| "Search by exact phrase" using `LIKE '%luna ahmed%'` | Misses "Luna-Marie Ahmed" | Use `to_tsquery` with `<N>` operator |
| Returning 0 results without explanation | User concludes "site is broken" | Return suggestions, log the event |
| Not throttling search | One bot scrapes the entire catalog | Throttle 30/min anon, 120/min auth |
| The `ILIKE` pattern is built from user input | SQL injection or wildcard abuse | Build pattern in code, escape user input |
| Trusting `ts_rank` as a percentage | It's not normalized | Use it as a relative score, not a UI percentage |
| `WHERE category_id = $1` and `$1` is null | Crashes or returns 0 | Use `($1::int IS NULL OR category_id = $1)` |

### 12.1 The mistakes that have caused real outages

- **The 10k-row "small enough" assumption**: A team at a YC company wrote `SELECT * FROM experts` with no LIMIT for their admin search. At 5k experts it was fine. At 50k, the connection pool was exhausted. At 200k, the database fell over. **Always paginate, even if "we'll never have that many".**
- **Bayesian with `m=0`**: A team set `m=0` for the Bayesian prior. The formula becomes `R * 1 + C * 0 = R`, which is just the raw rating. The "Bayesian" label was a lie. The one-review wonder was at the top. The team got complaints from new users who'd booked the 1-review wonder and had a bad experience. **`m=10` is not arbitrary; it's the threshold below which the data is unreliable.**
- **The `tsvector` populated only on insert**: A team created the `search_tsv` column with a default expression but only ran it on insert. When an expert updated their bio, the `tsvector` was stale. Searches for new keywords returned nothing. The fix: a trigger on `UPDATE` that refreshes `search_tsv`. Lesson 40 covers the trigger.
- **Recursive CTE with no cycle detection**: A user-created category had `parent_id` pointing to itself. The recursive CTE looped. The query never returned. The connection pool filled. **Cycle detection is not optional.**

---

## 13. Decision points revisited

After writing this design, did the Lesson 10/20 defaults hold up?

- ✅ JWT-based auth — yes, search is read-only for anonymous users, write-only for authenticated. No new auth surface.
- ✅ Postgres as the only database — yes, the lesson's design uses only Postgres features. No new infra.
- ✅ Module structure — yes, the `SearchModule` will follow the same `module/service/controller/dto` pattern.
- ⚠️ Caching — the in-memory cache from Lesson 50 is now extended to Redis. The pattern is the same.
- ⚠️ Logging — the action vocabulary is broader (`search.experts.*`).

None are blockers. We're feature-complete for the search MVP.

---

## 14. Self-check before Lesson 40

1. Why is "highest rating first" the wrong default sort? What does Bayesian adjustment fix?
2. `ILIKE '%Luna%'` vs `tsvector @@ to_tsquery('luna')` — which is faster at 100k rows? Why?
3. Why do we use `setweight` in the `tsvector`? What goes wrong if you don't?
4. When is offset pagination bad? When is it fine?
5. What is a partial index, and why does `WHERE status='active'` matter for it?
6. How would you implement empty-result suggestions? (Write the algorithm in 5 lines.)
7. What's the difference between filtering and ranking? Give an example where conflating them produces a bad UX.
8. Why is `pg_trgm` not the primary search index?
9. Why does the `setweight(to_tsvector(profile.full_name), 'A')` come before `setweight(to_tsvector(expert.bio), 'B')`? What if you swapped them?
10. What two things make facets expensive if you do them naively, and how does the Lesson 30 approach avoid them?
11. What's the difference between `to_tsquery` and `plainto_tsquery`? When do you use which?
12. Why is the Bayesian prior `m=10`? What changes if `m=0`?
13. Why does the score use addition, not multiplication?
14. What does `ESCAPE '\'` do in a `LIKE` clause, and why is it important?
15. Why is the facet query's `WHERE` clause the same as the main query *minus* the faceted field's filter?
16. What's the cache-stampede failure mode, and how do you prevent it?
17. Why are authenticated searches not CDN-cached?
18. When should you graduate from `tsvector` to Elasticsearch?
19. What's the security risk of returning the full `User` row in search results?
20. Why does the recursive CTE on categories need cycle detection?

If you can answer all twenty, you're ready to build the endpoints in **Lesson 40**.

---

## 15. What we just enabled for Lesson 40

We have a design. The pieces Lesson 40 will build:

- **The schema additions**: `experts.search_tsv` (generated column), `experts.bayesian_rating` (generated column), `experts USING GIN (search_tsv)`, the partial index on `verification_status`, the reverse-direction indexes on the M:N pivot tables.
- **The `SearchService`**: receives a DTO, returns `{ results, facets, suggestions }`. The orchestrator.
- **The `SearchController`**: parses query params, applies the throttle, calls the service, serializes the response.
- **The DTOs**: `ExpertSearchQueryDto`, `ExpertSearchResultDto`, `FacetDto`, `SuggestionDto`. The contract.
- **The cache layer**: Redis-backed, 60s TTL, request coalescing.
- **The observability**: stable action vocabulary, slow-query detection, `pg_stat_statements` integration.

Lesson 40 is implementation. The schema work must come first (a migration). Then the service, controller, DTOs. Then tests. Then the cache. Then observability.

If you find yourself wanting to "tune the algorithm" while implementing the endpoints, **stop**. The lesson's design is correct. Tuning comes after you have traffic data. A perfectly tuned search on 100 experts is over-engineering. A correctly-designed search on 100k experts is the right level of effort.
