# Lesson 04 — Joins in TypeORM: From Decorators to SQL

> **What you'll get:** three ways to fetch related data (`relations`, `leftJoinAndSelect`, raw `QueryBuilder`), the trade-offs of each, the SQL they actually emit, the patterns for the queries in `er-2.drawio` and the search feature, and the *production* consequences of each choice. By the end, you should be able to read any service method, predict the SQL it sends, count the queries, identify the N+1, and explain to a non-technical stakeholder why a 2-second response time is a schema or query problem, not a "TypeORM is slow" problem.
>
> **Why this lesson exists:** TypeORM lets you write "find by id with relations" four ways, and only one of them is the right default. The wrong choice is invisible on a 10-row dev DB and catastrophic on a 100k-row prod DB. Worse, the wrong choice can be a *security* issue (cartesian explosion in a list endpoint enables a DoS), a *data correctness* issue (duplicate rows from missing DISTINCT), and a *GDPR* issue (loading PII you didn't intend to load). This lesson makes the choice explicit, ties it to the SQL you'll see in `EXPLAIN ANALYZE`, and gives you the patterns to ship a 50ms search endpoint instead of a 5-second one.
>
> **Prerequisites:** Lessons 02 and 03. You must be fluent with the three cardinalities, the `onDelete` matrix, FK indexing, and pivot promotion.

---

## 1. Goal

By the end of this lesson you can:

1. Pick `relations` vs `leftJoinAndSelect` vs raw `QueryBuilder` for any read pattern, and justify the choice in one sentence.
2. Read a service method and predict the SQL it emits (number of queries, JOINs, indexes used).
3. Detect the N+1 pattern in a loop and replace it with a single `*AndSelect` or `IN()` batch.
4. Write the four "headline" queries of the search feature: profile + category tree, qualified-and-rated experts, expert + their full submission, category with full subtree.
5. Promote a pivot to an entity when business data arrives, and rewrite the affected joins.
6. Recognize and fix the ten most common runtime bugs that come from relationship loading.
7. Read an `EXPLAIN ANALYZE` plan and identify whether a query is using indexes, doing a sequential scan, or hitting a cartesian blowup.
8. Decide when to use keyset pagination vs offset pagination.
9. Audit an existing service for query count, N+1, and PII leak risks.
10. Explain to a stakeholder why "the page is slow" is almost always a query problem, not a framework problem.

---

## 2. Why this matters — the three failure modes (and the business cost)

Failure mode 1: **the N+1**. You load 50 categories and then loop `category.qualifications.length`. Each iteration fires a query. Total: 51 queries. At 5ms per query, that's 255ms. At 1000 categories, 5 seconds. The fix is one `leftJoinAndSelect`. The business cost: customers abandon slow pages. Amazon measured that every 100ms of latency costs 1% of revenue. Your search page is your storefront.

Failure mode 2: **the silent `undefined`**. You load an expert and access `expert.category.name`. It works in dev (you loaded the category). It crashes in prod (a different code path doesn't, or a refactor removed the `relations`). The fix is to make the relationship either eager, explicitly loaded in the service, or marked optional in the DTO. The business cost: production errors, customer support tickets, lost trust.

Failure mode 3: **the wrong join type**. You write `innerJoinAndSelect` instead of `leftJoinAndSelect`. Your "show me experts with their optional languages" query drops experts who don't speak any tracked language. The fix is to know what each join type means in SQL. The business cost: your search shows 30% of the experts it should — directly reducing marketplace supply.

But there are three more failure modes that production engineers hit:

Failure mode 4: **the cartesian blowup**. You `leftJoinAndSelect` 4 collections in a list endpoint. Each expert has 3 qualifications, 2 languages, 1 organization, 2 prices. SQL returns 3×2×1×2 = 12 rows per expert. 50 experts → 600 SQL rows. Network serialization is huge, p99 spikes. The fix is to paginate the list and load relations per row. The business cost: p99 latency spikes, customer complaints, scaling crisis when you grow 10x.

Failure mode 5: **the missing DISTINCT**. You `innerJoin` the same relation twice with different aliases (e.g. `l1` for Bangla, `l2` for English) and the response has duplicates because the SQL JOIN multiplies rows. The fix is `DISTINCT` or selecting only the FK. The business cost: your UI shows the same expert twice in search results. Customers think your platform is broken.

Failure mode 6: **the PII leak**. You `leftJoinAndSelect` a relation that includes PII (e.g. `User.email`) in a public endpoint. The response includes every user's email. The fix is to select only the columns you need, or to use a DTO that strips the field. The business cost: GDPR violation, €20M fine or 4% of annual global turnover (whichever is higher), customer trust destroyed.

This lesson is the rubric for all six.

### 2.1 The current state of your codebase — patterns already in use

Looking at `categories.service.ts`:

```ts
async findAllCategories() {
  return await this.categoryRepository.find({
    relations: {
      // parent: true,
      children: true,
    },
    order: { id: 'DESC' },
  });
}
```

This is `relations: { children: true }`. For a category tree:

**SQL emitted (approximately):**

```sql
SELECT * FROM categories ORDER BY id DESC;
SELECT * FROM categories WHERE parent_id IN (...all category ids from the first query...);
```

**Two queries.** The `IN` clause pulls all children in one go. This is fine for 50 categories. At 5,000 categories, the `IN` clause is still fine (Postgres handles large IN lists well). At 50,000 categories, the `IN` clause starts to slow down and the response is huge.

**The bug:** The order is `id DESC`. For a tree view, you almost always want `parent_id, name` (breadth-first) or `name ASC` (alphabetical). The current order is meaningless for users. Also, `children` is loaded but `parent` is not — so the tree is half-built. A user clicking a child sees no way to navigate back up.

**The improvement:** For a tree view, use a recursive CTE (§5.5) and return the result as a structured DTO. For a flat list, use `leftJoinAndSelect` to get the children in one query.

We'll audit this more in §13.

---

## 3. The three loading styles

### 3.1 `relations` — the simple option

```ts
const category = await this.repo.findOne({
  where: { id: 1 },
  relations: { qualifications: true, experts: true },
});
```

**SQL emitted** (approximately):

```sql
SELECT * FROM categories WHERE id = $1;
SELECT * FROM qualifications WHERE category_id = $1;
SELECT * FROM experts WHERE category_id = $1;
```

**Three queries.** Always. Even when one would do.

**How it works internally:** TypeORM runs the parent query, collects the IDs, then runs one query per relation with `WHERE parent_id IN (...)`. This is `1 + N` queries where `N` is the number of relations, not the number of rows. For one parent with 2 relations, it's 3 queries total. For 50 parents with 2 relations, it's 3 queries total (the IN clause handles the batching). So `relations` is actually quite efficient for batched loads.

**When to use:**

- Quick admin pages.
- One-shot scripts.
- Code where the depth is small and the count is small.
- Detail pages with known relations.

**When NOT to use:**

- Lists with N>20 parents and N>1 children per parent *if you need to filter on the joined rows*.
- Deep graphs (parent → child → grandchild) — `relations` doesn't support nested loads in the way you expect.
- Anywhere you might forget a relation and ship `undefined`.

**The `relations` gotcha:** TypeORM does NOT support filtering on the joined relation. You can load `category.qualifications`, but you can't say "load qualifications where `verified = true`". For that, you need `QueryBuilder`. This is the single biggest reason to graduate from `relations` to `QueryBuilder`.

### 3.2 `leftJoinAndSelect` / `innerJoinAndSelect` — the workhorse

```ts
const category = await this.repo
  .createQueryBuilder('c')
  .leftJoinAndSelect('c.qualifications', 'q')
  .leftJoinAndSelect('c.experts', 'e')
  .leftJoinAndSelect('e.user', 'u')
  .where('c.id = :id', { id: 1 })
  .getOne();
```

**SQL emitted** (approximately):

```sql
SELECT c.*, q.*, e.*, u.*
FROM categories c
LEFT JOIN qualifications q ON q.category_id = c.id
LEFT JOIN experts e        ON e.category_id = c.id
LEFT JOIN users u          ON u.id = e.user_id
WHERE c.id = $1;
```

**One query**. Real SQL `JOIN`. Indexable, plan-able, predictable.

**`LEFT JOIN` vs `INNER JOIN`:**

- `LEFT JOIN` keeps parents without children (a category with no qualifications). Use this by default for collections you want to render even when empty.
- `INNER JOIN` drops parents without matching children. Use this only when you specifically want to filter ("categories that have at least one qualification").

**The alias matters:** The first argument is the relation path (`c.qualifications`). The second is the alias (`q`). The alias is what you'll use in `where`, `select`, and subsequent joins. Pick short aliases; you'll type them a lot.

**The path matters:** `'c.qualifications'` is the relation on the entity aliased as `c`. If you aliased it as `category`, you'd write `'category.qualifications'`. The relation must be a valid `@OneToMany`, `@ManyToOne`, `@OneToOne`, or `@ManyToMany` on the entity. TypeScript will not catch typos here; runtime will fail with "relation not found".

**When to use:** anything you ship to production. This is the default for services.

### 3.3 `QueryBuilder` join without selecting — the filter-only option

```ts
const expertIds = await this.expertRepo
  .createQueryBuilder('e')
  .innerJoin('e.qualifications', 'q', 'q.id IN (:...ids)', { ids: [1, 2, 3] })
  .select('e.id')
  .getMany();
```

**SQL emitted** (approximately):

```sql
SELECT e.id
FROM experts e
INNER JOIN expert_qualifications eq ON eq.expert_id = e.id
INNER JOIN qualifications q        ON q.id = eq.qualification_id
WHERE q.id IN ($1, $2, $3);
```

**No `SELECT *` on the joined tables.** You only get the columns you explicitly `.select()`. Cheaper than `*AndSelect` when you don't need the joined data.

**When to use:** the search feature's "filter by joined rows" cases (filter by language, filter by qualification, filter by price tier). You want the FK lookup but not the joined rows in the response.

**The selectivity win:** For "find experts who speak Bangla" — you don't need the language row in the response. You just need the expert IDs. A `SELECT e.id` is 8 bytes per row. A `SELECT e.*, l.*` is hundreds of bytes per row. At 10,000 matching experts, that's 800KB vs 100MB. The smaller query is faster, uses less memory, and serializes in microseconds.

### 3.4 Raw `QueryBuilder` with explicit columns — the projection option

```ts
const rows = await this.expertRepo
  .createQueryBuilder('e')
  .leftJoin('e.reviews', 'r')
  .select('e.id', 'expert_id')
  .addSelect('e.avg_rating', 'rating')
  .addSelect('COUNT(r.id)', 'review_count')
  .groupBy('e.id')
  .getRawMany();
```

**SQL emitted:**

```sql
SELECT e.id AS expert_id, e.avg_rating AS rating, COUNT(r.id) AS review_count
FROM experts e
LEFT JOIN reviews r ON r.expert_id = e.id
GROUP BY e.id;
```

**When to use:** aggregations, projections, computed columns, search ranking. Anything where you want SQL expressions in the response, not full entity hydration.

**The raw-vs-entity tradeoff:** `getRawMany()` returns plain objects (`{ expert_id: 5, rating: 4.5, review_count: 12 }`). `getMany()` returns full `Expert` entities. Use raw for projections; use entity for full hydration. Don't mix them; the response shape will surprise you.

### 3.5 The decision matrix

| Loading style        | SQL queries | Use case                                            |
|----------------------|-------------|-----------------------------------------------------|
| `relations`          | 1 + N relations | Admin pages, one-shots, dev scripts, detail views  |
| `*AndSelect`         | 1 (with JOINs) | Default for services — list views, detail views     |
| `QueryBuilder` filter | 1 (no join columns) | "Filter by related" without including the related   |
| `QueryBuilder` with explicit columns | 1 (only selected columns) | Aggregations, projections, computed scores |
| Raw SQL (`manager.query`) | 1 (exactly what you wrote) | Recursive CTEs, Postgres-specific features, complex ranking |

**Default rule:** Use `*AndSelect` for everything unless you have a specific reason not to. The "specific reasons" are: filtering on joined rows, projecting specific columns, recursive queries, or Postgres-specific features (CTEs, window functions, full-text search).

---

## 4. The N+1 pattern

### 4.1 What it looks like

```ts
const categories = await this.repo.find();
for (const c of categories) {
  console.log(c.qualifications.length);   // ← fires SELECT on every iteration
}
```

If you have 50 categories, that's 51 queries. With 1000 categories, the loop runs for seconds.

**The runtime cost is multiplicative:** 1 query for `find()` + N queries for `.qualifications` = N+1. At 5ms per query and N=1000, that's 5 seconds. At N=10,000, 50 seconds. The endpoint times out.

### 4.2 The hidden N+1 — lazy properties

Inverse-side properties (`category.experts`, `post.comments`) are lazy by default. Accessing them fires a query — even if you didn't write a loop.

```ts
const category = await this.repo.findOne({ where: { id: 1 } });
console.log(category.experts);          // ← SELECT * FROM experts WHERE category_id = 1
```

**The trap:** This works in dev (you have 5 categories, the query is fast). In prod, an admin tool loads 1000 categories and renders the count of experts per category. The page hangs.

**The fix is the same as above:** load it explicitly. Don't let lazy access creep into production code without an `EXPLAIN` showing you the query cost.

**The `eager: true` trap:** Setting `eager: true` "fixes" the lazy N+1 by always loading the relation. This is wrong for the reasons in §6. The right fix is to load explicitly in the service method that needs the relation.

### 4.3 How to detect N+1 in dev

**Method 1: TypeORM logging.** Set `logging: 'all'` in your TypeORM config. Every query is logged to the console. If you see the same SELECT repeating with different `WHERE` values, you have an N+1.

**Method 2: A query counter.** Use a TypeORM subscriber to count queries per request. In tests, assert "this endpoint should fire ≤ 5 queries". The test fails if you accidentally introduce an N+1.

```ts
// typeorm.subscriber.ts
@EventSubscriber()
export class QueryCounterSubscriber implements EntitySubscriberInterface {
  static queryCount = 0;

  beforeQuery(event: QueryEvent) {
    QueryCounterSubscriber.queryCount++;
  }
}

// in a test
beforeEach(() => { QueryCounterSubscriber.queryCount = 0; });
afterEach(() => {
  if (QueryCounterSubscriber.queryCount > 5) {
    throw new Error(`Too many queries: ${QueryCounterSubscriber.queryCount}`);
  }
});
```

**Method 3: Production observability.** Postgres `log_min_duration_statement = 500` logs queries slower than 500ms. N+1 patterns show up as bursts of identical queries. `pg_stat_statements` aggregates them and shows you the top-N slow queries. If "SELECT * FROM qualifications WHERE category_id = $1" is at the top of the list with 10,000 calls/min, you have an N+1.

### 4.4 How to fix it

**Option A: `relations` (easy but limited).**

```ts
const categories = await this.repo.find({ relations: { qualifications: true } });
for (const c of categories) {
  console.log(c.qualifications.length);   // ← already loaded
}
```

Two queries (one for categories, one for qualifications). Fine for 50 parents.

**Option B: `leftJoinAndSelect` (one query, the right default).**

```ts
const categories = await this.repo
  .createQueryBuilder('c')
  .leftJoinAndSelect('c.qualifications', 'q')
  .getMany();
for (const c of categories) {
  console.log(c.qualifications.length);
}
```

One query. Scales to 10k categories.

**Option C: select what you need (aggregations).**

```ts
const rows = await this.repo
  .createQueryBuilder('c')
  .leftJoin('c.qualifications', 'q')
  .select('c.id', 'category_id')
  .addSelect('COUNT(q.id)', 'qual_count')
  .groupBy('c.id')
  .getRawMany();
```

One query, aggregates returned directly. Cheaper if you only need the count.

**The decision:** Use `relations` for small N (< 100). Use `*AndSelect` for medium N (100-10k) with filtering needed. Use aggregations for "I just need the count" cases. Use keyset pagination for very large N.

### 4.5 The `In()` batch pattern — for inverse-side loads

When you can't `*AndSelect` (e.g., the relation is loaded in a loop after the parent query), batch the loads with `In()`:

```ts
// BAD — N+1
const experts = await this.expertRepo.find();
for (const expert of experts) {
  expert.category = await this.categoryRepo.findOne({ where: { id: expert.category_id } });
}

// GOOD — 2 queries total
const experts = await this.expertRepo.find();
const categoryIds = [...new Set(experts.map(e => e.category_id))];
const categories = await this.categoryRepo.find({ where: { id: In(categoryIds) } });
const categoryMap = new Map(categories.map(c => [c.id, c]));
for (const expert of experts) {
  expert.category = categoryMap.get(expert.category_id);
}
```

This is what TypeORM's `relations` does internally. When you can't use `relations` (because the relation isn't on the entity, or you need filtering), do it manually.

---

## 5. Worked examples — the queries you will actually write

### 5.1 "Show me an expert's profile + their primary category + the category's parent"

The "expert profile detail" page. Loads `Expert → User (profile) → Category → Category.parent`.

```ts
const expert = await this.expertRepo
  .createQueryBuilder('e')
  .leftJoinAndSelect('e.user', 'u')
  .leftJoinAndSelect('e.category', 'c')
  .leftJoinAndSelect('c.parent', 'cp')               // ← the tree
  .leftJoinAndSelect('e.qualifications', 'q')
  .leftJoinAndSelect('e.organizations', 'o')
  .leftJoinAndSelect('e.languages', 'l')
  .where('e.id = :id', { id: 42 })
  .getOne();
```

**SQL (approximately):**

```sql
SELECT e.*, u.*, c.*, cp.*, q.*, o.*, l.*
FROM experts e
LEFT JOIN users u          ON u.id = e.user_id
LEFT JOIN categories c     ON c.id = e.category_id
LEFT JOIN categories cp    ON cp.id = c.parent_id
LEFT JOIN expert_qualifications eq ON eq.expert_id = e.id
LEFT JOIN qualifications q         ON q.id = eq.qualification_id
LEFT JOIN expert_organizations eo  ON eo.expert_id = e.id
LEFT JOIN organizations o          ON o.id = eo.organization_id
LEFT JOIN expert_languages el      ON el.expert_id = e.id
LEFT JOIN languages l              ON l.id = el.language_id
WHERE e.id = 42;
```

**Indexes used:** `experts(id)` (PK), `users(id)`, `categories(id)`, `expert_qualifications(expert_id)` (composite PK prefix), `qualifications(id)`, etc. If you see a sequential scan on any of these, add the index from Lesson 03 §6.2.

**Gotcha:** this query can return a row per (expert × qualification × organization × language). That's *expected* — TypeORM de-duplicates back into nested arrays. The duplication is in the SQL, not the response. To reduce duplication, see §5.6.

**PII risk:** This query loads `users.*` which includes `pass_hash` (or it would if not for `select: false` on the column). With `select: false` on `User.passwordHash`, this query is safe. Without it, every expert detail page leaks the user's password hash. **The `select: false` is doing real security work here; don't remove it.**

### 5.2 "All verified experts who speak Bangla AND English, ordered by rating"

The headline query from the search feature.

```ts
const experts = await this.expertRepo
  .createQueryBuilder('e')
  .innerJoin('e.languages', 'l1', 'l1.name = :l1', { l1: 'Bangla' })
  .innerJoin('e.languages', 'l2', 'l2.name = :l2', { l2: 'English' })
  .leftJoinAndSelect('e.user', 'u')
  .leftJoinAndSelect('e.category', 'c')
  .where('e.verification_status = :s', { s: 'verified' })
  .orderBy('e.avg_rating', 'DESC')
  .addOrderBy('e.review_count', 'DESC')
  .limit(50)
  .getMany();
```

**SQL (approximately):**

```sql
SELECT DISTINCT e.*, u.*, c.*
FROM experts e
INNER JOIN expert_languages el1 ON el1.expert_id = e.id
INNER JOIN languages l1         ON l1.id = el1.language_id AND l1.name = 'Bangla'
INNER JOIN expert_languages el2 ON el2.expert_id = e.id
INNER JOIN languages l2         ON l2.id = el2.language_id AND l2.name = 'English'
LEFT JOIN users u          ON u.id = e.user_id
LEFT JOIN categories c     ON c.id = e.category_id
WHERE e.verification_status = 'verified'
ORDER BY e.avg_rating DESC, e.review_count DESC
LIMIT 50;
```

**Two joins on the same pivot** is the M:N pattern for "AND across a multi-select". Each `innerJoin` adds a row to the WHERE clause. The `DISTINCT` is implicit because TypeORM deduplicates the join rows into the response.

**The `DISTINCT` trap:** Without `DISTINCT`, an expert who speaks both Bangla and English will appear twice in the result. With 5 languages, the cartesian is 5x. With 10 selected languages, 10x. `DISTINCT` fixes this but adds CPU cost on large result sets.

**Better:** Use `innerJoin` (filter only, no `*AndSelect`) and a separate `leftJoinAndSelect` for the response data:

```ts
const experts = await this.expertRepo
  .createQueryBuilder('e')
  .innerJoin('e.languages', 'l1', 'l1.name = :l1', { l1: 'Bangla' })
  .innerJoin('e.languages', 'l2', 'l2.name = :l2', { l2: 'English' })
  .leftJoinAndSelect('e.user', 'u')
  .leftJoinAndSelect('e.category', 'c')
  .leftJoinAndSelect('e.languages', 'l')  // load languages for the response
  .where('e.verification_status = :s', { s: 'verified' })
  .groupBy('e.id, u.id, c.id, l.id')      // dedupe at the group level
  .orderBy('e.avg_rating', 'DESC')
  .addOrderBy('e.review_count', 'DESC')
  .limit(50)
  .getMany();
```

`groupBy` is more efficient than `DISTINCT` on Postgres because it can use a hash aggregate instead of a sort.

### 5.3 "Promote `expert_qualifications` to a real entity (because we now need `obtained_year`)"

The pivot promotion from Lesson 03 §7. After promotion, the relationship is two 1:Ns instead of one M:N. The query changes shape:

**Before:**

```ts
const expert = await this.expertRepo
  .createQueryBuilder('e')
  .leftJoinAndSelect('e.qualifications', 'q')   // @ManyToMany via @JoinTable
  .where('e.id = :id', { id: 42 })
  .getOne();
```

**After:**

```ts
const expert = await this.expertRepo
  .createQueryBuilder('e')
  .leftJoinAndSelect('e.qualifications', 'eq')              // @OneToMany → ExpertQualification
  .leftJoinAndSelect('eq.qualification', 'q')                // @ManyToOne → Qualification
  .where('e.id = :id', { id: 42 })
  .getOne();

// And now you can filter on obtainedYear:
const expertWithRecentDegrees = await this.expertRepo
  .createQueryBuilder('e')
  .leftJoinAndSelect('e.qualifications', 'eq')
  .leftJoinAndSelect('eq.qualification', 'q')
  .where('eq.obtainedYear >= :y', { y: 2010 })
  .getMany();
```

The second query was *impossible* on the implicit pivot. That's the entire argument for promoting early.

### 5.4 "An expert's full submission, including documents and verifications"

The verification admin queue. Deep join.

```ts
const submission = await this.submissionRepo
  .createQueryBuilder('s')
  .leftJoinAndSelect('s.expert', 'e')
  .leftJoinAndSelect('e.user', 'u')
  .leftJoinAndSelect('s.documents', 'd')
  .leftJoinAndSelect('s.verifications', 'v')
  .leftJoinAndSelect('e.qualifications', 'q')
  .where('s.id = :id', { id: 42 })
  .getOne();
```

**Watch the cartesian explosion.** Every `documents` row and every `verifications` row multiplies the result set. For one submission with 5 documents and 3 verifications, you get 15 rows in SQL that TypeORM de-duplicates back into nested arrays. For a list endpoint, see §5.6.

**The mitigation:** For a list endpoint, paginate the submissions (LIMIT 20), then load documents and verifications in a second query with `IN()` on the submission IDs. This caps the result set size.

### 5.5 "Category with full subtree"

Use a recursive CTE. Postgres handles it natively:

```ts
async findSubtree(rootId: number): Promise<Category[]> {
  const rows = await this.repo.manager.query(
    `
    WITH RECURSIVE category_tree AS (
      SELECT id, parent_id, name, 0 AS depth
      FROM categories
      WHERE id = $1

      UNION ALL

      SELECT c.id, c.parent_id, c.name, ct.depth + 1
      FROM categories c
      JOIN category_tree ct ON c.parent_id = ct.id
    )
    SELECT * FROM category_tree ORDER BY depth, name;
    `,
    [rootId],
  );

  // Map raw rows back to entities if needed; or return as DTOs.
  return rows;
}
```

The CTE walks the tree in one query. With an index on `categories.parent_id`, it's fast on trees with thousands of nodes.

**The cycle hazard:** Without the cycle-prevention trigger from Lesson 03 §3.4, a cycle in the tree makes this query infinite-loop. The trigger is the only defense; raw SQL bypasses your service layer.

**Performance:** For a tree of 500 categories, the recursive CTE is sub-millisecond. For 50k categories, still fast. The recursion is bounded by the tree depth and total node count; Postgres handles it well. The key index: `categories(parent_id)` so the `JOIN` is an index scan, not a sequential scan.

### 5.6 Avoiding cartesian blowup in lists

The `findOne` queries above are fine because the row count is small. For *list* endpoints, joining 5 collections explodes the result set.

```ts
// DON'T: list endpoint with full graph
const experts = await this.expertRepo
  .createQueryBuilder('e')
  .leftJoinAndSelect('e.qualifications', 'q')
  .leftJoinAndSelect('e.languages', 'l')
  .leftJoinAndSelect('e.organizations', 'o')
  .leftJoinAndSelect('e.prices', 'p')
  .getMany();
```

If each expert has 3 qualifications, 2 languages, 1 organization, 2 prices, the SQL returns 3×2×1×2 = 12 rows per expert. 50 experts → 600 SQL rows that TypeORM de-duplicates. It works, but it's wasteful and the network serialization is large.

**The cost breakdown:**
- 50 experts × 12 rows = 600 SQL rows
- Each row ~500 bytes → 300KB of data over the wire
- TypeORM de-duplication: O(n) memory, ~50ms for 600 rows
- Network serialization: ~5ms
- Total: ~60ms for 50 experts

For 200 experts: 2400 rows, 1.2MB, 200ms. The latency grows linearly with page size. At 1000 experts per page, you're at 1 second. That's the cartesian blowup.

**Better: paginate the list, then load relations per row.**

```ts
// Step 1: paginated list with minimal data
const page = await this.expertRepo
  .createQueryBuilder('e')
  .leftJoinAndSelect('e.user', 'u')            // user is small (1:1)
  .leftJoinAndSelect('e.category', 'c')        // category is small (N:1)
  .orderBy('e.avg_rating', 'DESC')
  .limit(20)
  .offset(0)
  .getMany();

// Step 2: load the related collections in batched queries
const expertIds = page.map(e => e.id);
const [quals, langs, orgs, prices] = await Promise.all([
  this.qualRepo
    .createQueryBuilder('q')
    .innerJoin('expert_qualifications', 'eq', 'eq.qualification_id = q.id')
    .where('eq.expert_id IN (:...ids)', { ids: expertIds })
    .getMany(),
  this.langRepo
    .createQueryBuilder('l')
    .innerJoin('expert_languages', 'el', 'el.language_id = l.id')
    .where('el.expert_id IN (:...ids)', { ids: expertIds })
    .getMany(),
  // ... etc
]);
```

This is what every well-built listing API does. The list endpoint is cheap (no cartesian); the detail endpoint is rich (full graph). The Promise.all is important — it parallelizes the four queries instead of serializing them.

**The two-query pattern in production:**
- Page query: 1 query, ~5ms, returns 20 rows with 1:1 relations
- Relations query (4 in parallel): 4 queries, ~10ms total (parallel), returns 20 × ~5 = 100 rows
- Server-side merge: ~2ms
- Total: ~15ms for 20 experts with full relations

Compare to the cartesian: ~60ms for 50 experts. The two-query pattern is 4x faster AND scales linearly with page size.

### 5.7 The "facet count" pattern — for search filters

The search UI shows "BSc (18)" next to a qualification filter. The number in parentheses is the count of experts with that qualification, *within the current search results*. This is a facet count, and it's a different query from the search itself.

```ts
// Given the current search (e.g. "verified experts in Medical who speak English"),
// compute the count per qualification for the filter UI.

const facets = await this.expertRepo
  .createQueryBuilder('e')
  .innerJoin('e.qualifications', 'q')
  .select('q.id', 'qualification_id')
  .addSelect('q.name', 'qualification_name')
  .addSelect('COUNT(DISTINCT e.id)', 'expert_count')
  .where('e.verification_status = :s', { s: 'verified' })
  .andWhere('e.category_id = :c', { c: categoryId })
  .groupBy('q.id, q.name')
  .orderBy('expert_count', 'DESC')
  .getRawMany();
```

This is a separate query from the search itself. The search returns the expert list; the facet query returns the counts. Both queries are fast because they're aggregations on indexed columns.

**The trap:** Computing facets inside the search query (as a subquery or window function) is tempting but slow. The Postgres planner has to recompute the facet for every expert in the result. Separate queries let the planner optimize each independently.

---

## 6. Eager loading — and why to avoid it

You can mark a relation `eager: true` and TypeORM will always load it. This is convenient for prototyping and terrible for production:

- You can't opt out at the call site. Every `find()` loads the relation, even when you don't need it.
- A "small" eager relation on a list endpoint becomes an N+1 or a cartesian.
- Refactoring away from `eager` requires touching every call site.
- Eager loading cascades: if `User.profile` is eager and `Profile.address` is eager, every `find(User)` loads the entire address tree.

The rule: **never use `eager: true` in production code**. Load explicitly per service method. The one legitimate use is for truly always-needed relations on a single entity (e.g. `User.profile` if every request needs the profile). Even then, prefer explicit loading in the service.

**The migration story:** If your code has `eager: true` on a relation, removing it is a refactor. Every call site that relied on the eager load now has `undefined` for the relation. You need to either:
1. Add the relation to every `find()` call site (mechanical, error-prone).
2. Add a custom repository method that always loads the relation (clean, but requires a custom repo).

The custom repo pattern is what your codebase should converge on: a `findOneWithRelations` method per entity, with the relations the service layer needs.

---

## 7. Transactions and locking

When you write to related entities, the relationship matters:

```ts
// BAD: two writes, two queries, no transaction
const expert = await this.expertRepo.findOne({ where: { id } });
expert.bio = newBio;
await this.expertRepo.save(expert);

// GOOD: one transaction, both writes atomic
await this.dataSource.transaction(async (manager) => {
  const expert = await manager.findOne(Expert, { where: { id } });
  expert.bio = newBio;
  await manager.save(expert);
  // If you also touch related entities here, they go in the same TX.
});
```

**The atomicity rule:** A transaction boundary should encompass all writes that must succeed or fail together. If you create an `Expert` and add `Qualifications` in an M:N, both writes must be in the same transaction. If the expert write succeeds and the qualification write fails, you have an expert with no qualifications (and a dangling expert if the failure was a constraint violation).

For pessimistic locking (e.g. "two admins can't both verify the same submission"):

```ts
await this.repo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
```

Don't reach for locks unless you have a measured race condition. Default to transactions + optimistic locking via a `version` column.

**The optimistic-locking pattern:**

```ts
@Entity()
export class Expert {
  // ...
  @VersionColumn()
  version!: number;
}

// On save, TypeORM auto-increments version.
// If another transaction updated the row, the save throws OptimisticLockVersionMismatchError.
```

This is the right default for most "two users editing the same row" scenarios. Pessimistic locks (`SELECT ... FOR UPDATE`) are heavier and should be reserved for the cases where optimistic doesn't work (e.g., you need to read-then-write a counter atomically).

---

## 8. Querying through a promoted pivot

After promoting `expert_qualifications` to an entity (Lesson 03 §7), the joins change. The pattern:

```ts
// "All experts with a qualification obtained after 2010, ordered by rating"
const experts = await this.expertRepo
  .createQueryBuilder('e')
  .innerJoin('e.qualifications', 'eq')                   // e.qualifications is now @OneToMany(ExpertQualification)
  .innerJoin('eq.qualification', 'q')                    // eq.qualification is @ManyToOne(Qualification)
  .leftJoinAndSelect('e.user', 'u')
  .where('eq.obtainedYear >= :y', { y: 2010 })
  .andWhere('e.verification_status = :s', { s: 'verified' })
  .orderBy('e.avg_rating', 'DESC')
  .getMany();
```

The two-step join (`eq.qualification`) is the entire reason for promotion. On the implicit pivot, you couldn't filter on `obtainedYear` at all.

**The path syntax:** `'e.qualifications'` navigates from `Expert` to its `OneToMany` of `ExpertQualification`. `'eq.qualification'` navigates from `ExpertQualification` to its `ManyToOne` of `Qualification`. The dot path is the relation graph. TypeORM resolves it via the entity metadata; if the path is wrong, you get a runtime "relation not found" error.

**The index dependency:** This query benefits from two indexes:
1. `expert_qualifications(expert_id)` — for the join from `e` to `eq`
2. `expert_qualifications(obtained_year)` — for the WHERE clause

Without #2, the `WHERE eq.obtainedYear >= 2010` is a filter on the joined result, which means Postgres has to scan all `expert_qualifications` rows and filter. At 1M pivot rows, that's slow. With the index, it's a range scan: fast.

---

## 9. Pagination

For list endpoints, always paginate. The default in your codebase:

```ts
const [rows, total] = await this.expertRepo.findAndCount({
  where: { verification_status: 'verified' },
  relations: { user: true, category: true },
  order: { avg_rating: 'DESC', id: 'ASC' },          // tie-breaker for stable pagination
  take: 20,
  skip: 0,
});
```

Rules:

- Always include a tie-breaker in `ORDER BY` (`id ASC` is the cheapest) for stable pagination. Without it, rows can shift between pages.
- Always return `total` (or a `hasMore` boolean) so the UI can render pagination correctly.
- For deep pagination, switch to keyset pagination (`WHERE id > $lastSeenId`) — `OFFSET` gets slow at high page numbers.

### 9.1 Offset pagination — the simple but slow option

```ts
const page = await this.expertRepo.find({
  order: { avg_rating: 'DESC', id: 'ASC' },
  take: 20,
  skip: 1000,   // page 50
});
```

**The cost:** Postgres still scans the first 1000 rows to skip them. At page 1, the cost is 20 rows. At page 100, the cost is 2000 rows. At page 1000, the cost is 20,000 rows. The latency grows linearly with page number.

**The use case:** Offset is fine for small result sets and "go to page N" UIs (e.g., a search results page where users might click "page 50"). The first 10 pages are fast; the deep pages are slow but rare.

### 9.2 Keyset pagination — the scalable option

```ts
// First page
const page1 = await this.expertRepo.find({
  where: { verification_status: 'verified' },
  order: { avg_rating: 'DESC', id: 'ASC' },
  take: 20,
});

// Next page: WHERE (avg_rating, id) < (last.avg_rating, last.id) ORDER BY avg_rating DESC, id ASC LIMIT 20
const lastRow = page1[page1.length - 1];
const page2 = await this.expertRepo
  .createQueryBuilder('e')
  .where('e.verification_status = :s', { s: 'verified' })
  .andWhere('(e.avg_rating < :lastRating OR (e.avg_rating = :lastRating AND e.id > :lastId))', {
    lastRating: lastRow.avg_rating,
    lastId: lastRow.id,
  })
  .orderBy('e.avg_rating', 'DESC')
  .addOrderBy('e.id', 'ASC')
  .take(20)
  .getMany();
```

**The cost:** Postgres uses the index on `(avg_rating, id)` to seek directly to the first row of the next page. The cost is constant regardless of page depth. Page 1000 is as fast as page 1.

**The tradeoff:** Keyset doesn't support "go to page N" — only "next page" / "previous page". The UI must be a "load more" or infinite scroll, not numbered pages.

**The index requirement:** Keyset requires a composite index on the sort columns. For `(avg_rating DESC, id ASC)`, you need:

```sql
CREATE INDEX idx_experts_rating_id ON experts (avg_rating DESC, id ASC);
```

Note the `DESC` in the index — Postgres can use a descending index for an `ORDER BY ... DESC` more efficiently than sorting.

### 9.3 The cursor pattern — for clients that don't speak keyset

If your frontend can't do "WHERE (a, b) < (x, y)" easily, encode the cursor as a base64 string:

```ts
// Server: encode the last row's sort keys
function encodeCursor(row: Expert): string {
  return Buffer.from(`${row.avg_rating}:${row.id}`).toString('base64');
}

// Server: decode and use
function decodeCursor(cursor: string): { rating: number; id: number } {
  const [rating, id] = Buffer.from(cursor, 'base64').toString().split(':');
  return { rating: parseFloat(rating), id: parseInt(id, 10) };
}

// API
@Get()
async list(@Query('cursor') cursor?: string) {
  const last = cursor ? decodeCursor(cursor) : null;
  const rows = await this.expertRepo
    .createQueryBuilder('e')
    .where(/* ... */)
    .andWhere(last ? '(e.avg_rating < :r OR (e.avg_rating = :r AND e.id > :i))' : '1=1',
      last ? { r: last.rating, i: last.id } : {})
    .orderBy('e.avg_rating', 'DESC')
    .addOrderBy('e.id', 'ASC')
    .take(20)
    .getMany();

  const nextCursor = rows.length === 20 ? encodeCursor(rows[rows.length - 1]) : null;
  return { rows, nextCursor };
}
```

The client just passes back the `nextCursor` it got. The server decodes it and uses it as the keyset WHERE clause. This is the standard pattern for cursor-based pagination in REST APIs.

---

## 10. Common runtime bugs and how to spot them

| Symptom                                                       | Likely cause                                                            | Fix                                                  |
|---------------------------------------------------------------|-------------------------------------------------------------------------|------------------------------------------------------|
| `expert.category` is `undefined` after `findOne`              | Lazy; you didn't `relations: ['category']` or `leftJoinAndSelect`       | Add the relation, or load it explicitly              |
| `category.qualifications` is `[]` for a real parent           | Inverse-side callback has the wrong property name                       | Match the property name in both decorator callbacks  |
| `QueryFailedError: duplicate key value violates unique constraint` | Missing `unique: true` on a 1:1 FK                                  | Add `unique: true` to `@JoinColumn`                  |
| Slow list page with 100 rows                                  | N+1 — loop loads related entity                                         | Replace loop with `*AndSelect` or `relations`        |
| Deleting a category deletes experts                            | `onDelete: 'CASCADE'` on `experts.category_id`                          | Switch to `RESTRICT`; add explicit move-then-delete  |
| Pivot has duplicate `(a, b)` rows                             | Missing composite PK on `@JoinTable`                                    | Add composite PK in a migration                      |
| `Cannot read property 'experts' of undefined` after service call | DTO didn't include the relation                                      | Move the relation to the response DTO                |
| List endpoint times out at 1000 rows                          | Cartesian blowup from `*AndSelect` on multiple collections              | Paginate + load relations per row                    |
| Two `findOne` calls in a row return different shapes           | One had `relations`, the other didn't                                   | Standardize the service method to always load X      |
| `eager: true` explosion                                       | Marked something eager that's expensive                                 | Remove `eager`, load explicitly                      |
| Search for "experts with no language" returns all experts     | Used `leftJoin` with no `WHERE l.id IS NULL` filter                     | Add `andWhere('l.id IS NULL')`                       |
| `getMany()` returns duplicates                                | Joining the same relation twice via different aliases (e.g. `l1`, `l2`) | Use `DISTINCT` or `select` only the FK               |
| Slow query with `LEFT JOIN`                                   | Missing index on the joined FK                                          | Add the index from Lesson 03 §6.2                     |
| Response includes `passwordHash`                              | Forgot `select: false` on `User.passwordHash`                           | Add `select: false` and a DTO that strips it         |
| Search returns 50 results but DB has 1000 matching rows      | Missing `take` / `limit`; query has no upper bound                       | Always add a `take` / `limit` on list queries        |
| Pagination shows same row on consecutive pages               | Missing tie-breaker in `ORDER BY`                                       | Add `id ASC` (or another unique column)              |
| Slow first page of search, fast on refresh                    | No index on the `WHERE` column                                          | Add the index                                        |
| P99 latency spikes at peak hours                              | Connection pool exhausted                                               | Increase pool size; check for slow queries           |
| `error: relation "x" does not exist` after a migration         | Migration didn't run; or ran in wrong order                              | Verify migration history; re-run if needed           |

---

## 11. The full TypeORM → SQL translation table

For the patterns you'll use most:

| TypeORM code                                                  | SQL it emits                                                          | Queries |
|--------------------------------------------------------------|-----------------------------------------------------------------------|---------|
| `findOne({ where: { id } })`                                 | `SELECT * FROM x WHERE id = $1`                                       | 1       |
| `find({ relations: ['a'] })`                                 | `SELECT * FROM x; SELECT * FROM a WHERE x_id IN (...)`                | 2       |
| `qb.leftJoinAndSelect('x.a', 'a')`                           | `SELECT x.*, a.* FROM x LEFT JOIN a ON a.x_id = x.id`                 | 1       |
| `qb.innerJoin('x.a', 'a').select('x.id')`                    | `SELECT x.id FROM x INNER JOIN a ON a.x_id = x.id`                    | 1       |
| `qb.leftJoinAndSelect(...).leftJoinAndSelect(...)`           | Single SQL with chained LEFT JOINs                                    | 1       |
| `qb.innerJoin('x.a', 'a1', 'cond').innerJoin('x.a', 'a2', ...)` | Single SQL with two aliases on the same join                       | 1       |
| Recursive CTE via `manager.query(...)`                       | The raw SQL you wrote                                                  | 1       |
| `qb.leftJoinAndSelect('x.a1', 'a1').leftJoinAndSelect('x.a2', 'a2')` | Cartesian: N rows per parent (deduped in JS)                    | 1       |
| `qb.innerJoin(...).addSelect('COUNT(x.a.id)', 'count')`      | Single SQL with GROUP BY and aggregate                                | 1       |
| `dataSource.transaction(async (m) => { ... })`                | All queries in the transaction wrapped in BEGIN/COMMIT                 | N       |
| `findOne({ where: { id }, lock: { mode: 'pessimistic_write' } })` | `SELECT * FROM x WHERE id = $1 FOR UPDATE`                        | 1       |
| `find({ order: { a: 'DESC' }, take: 20, skip: 1000 })`       | `SELECT * FROM x ORDER BY a DESC LIMIT 20 OFFSET 1000`                | 1       |
| Keyset: `WHERE (a, b) < ($x, $y) ORDER BY a DESC, b ASC LIMIT 20` | Index range scan                                                  | 1       |

If you can read this table cold, you can predict the cost of any service method before you run it.

---

## 12. The EXPLAIN ANALYZE reading guide

When a query is slow, `EXPLAIN ANALYZE` is the first place to look. Here's how to read the output.

### 12.1 The output format

```sql
EXPLAIN ANALYZE
SELECT e.*, u.*, c.*
FROM experts e
LEFT JOIN users u ON u.id = e.user_id
LEFT JOIN categories c ON c.id = e.category_id
WHERE e.verification_status = 'verified'
ORDER BY e.avg_rating DESC
LIMIT 20;
```

Returns a tree of operations:

```
Limit  (cost=... rows=20 time=0.5ms)
  ->  Sort  (cost=... rows=1000 time=0.3ms)
        Sort Key: e.avg_rating DESC
        ->  Hash Left Join  (cost=... rows=1000 time=0.2ms)
              Hash Cond: (c.id = e.category_id)
              ->  Hash Left Join  (cost=... rows=1000 time=0.1ms)
                    Hash Cond: (u.id = e.user_id)
                    ->  Seq Scan on experts e  (cost=... rows=1000 time=0.05ms)  ← BAD
                          Filter: (verification_status = 'verified')
              ->  Hash
                    ->  Seq Scan on categories c  (cost=... rows=500 time=0.02ms)
```

The right side is deeper; the left side is the root. `time` is the actual runtime in milliseconds.

### 12.2 What to look for

**1. `Seq Scan` on a table with > 10,000 rows.** This is a missing index. Add the index on the `WHERE` or `JOIN` column.

**2. `Nested Loop` with a large outer table.** This is an N+1 in disguise. The outer table is being scanned, and for each row, the inner is being scanned. Fix with a Hash Join or Merge Join (which require indexes on the join columns).

**3. `Sort` with a large in-memory sort.** If you see `Sort Method: external merge` or `Sort Method: quicksort` with a large memory number, the sort is spilling to disk. Fix with an index that matches the `ORDER BY`.

**4. `Hash Join` vs. `Merge Join`.** Merge Join is usually faster for large sorted inputs. If you see Hash Join on a large query, consider whether an index would let Postgres use Merge Join instead.

**5. `actual time=... rows=...` mismatches with the planner's estimate.** If the planner estimated 100 rows but actually got 1,000,000, the planner is making bad decisions. Often this is because of stale statistics. Run `ANALYZE experts;` to refresh.

### 12.3 The four indexes that fix 90% of slow queries

1. **Index on every FK column.** (`experts.category_id`, `experts.user_id`, etc.) This is the Lesson 03 lesson.
2. **Composite index for `WHERE` + `ORDER BY` together.** For `WHERE status = 'X' ORDER BY created_at DESC`, the index `(status, created_at DESC)` lets Postgres skip the sort entirely.
3. **Partial index for the common `WHERE` predicate.** For `WHERE status = 'active' AND ...`, the partial index `WHERE status = 'active'` is much smaller and faster.
4. **Expression index for function calls in `WHERE`.** For `WHERE lower(email) = $1`, the expression index on `lower(email)` lets Postgres use the index instead of calling `lower()` on every row.

---

## 13. The audit checklist for your current codebase

Run this checklist against every service method in `backend/src/`:

| Service method | Loads | N+1 risk | Cartesian risk | PII risk | Pagination | Status |
|----------------|-------|----------|----------------|----------|------------|--------|
| `CategoriesService.findAllCategories` | `relations: { children: true }` | Low (1 extra query) | Low | None | No `take`/`skip` | **Fix: add pagination; consider recursive CTE for tree view** |
| `ExpertsService` (empty) | N/A | N/A | N/A | N/A | N/A | **Implement search query here** |
| `LanguagesService` (exists?) | Unknown | Unknown | Unknown | None | Unknown | **Audit when implemented** |
| `OrganizationsService` (exists?) | Unknown | Unknown | Unknown | None | Unknown | **Audit when implemented** |
| `UserService` (auth) | Likely `findOne({ where: { email } })` | None | None | **Likely loads `passwordHash`** | N/A | **Verify `select: false` on password hash** |

**Specific fixes for the current code:**

1. **`CategoriesService.findAllCategories` should paginate.** Add `take: 50, skip: 0` and return `total`. For 5,000 categories, loading all in one query is 5,000 rows; paginating to 50 per page is 50 rows.

2. **`CategoriesService.findAllCategories` should use a tree view for the admin UI.** The current code returns a flat list with `children` loaded. For a tree UI, use the recursive CTE from §5.5 and return a hierarchical DTO. For a flat admin list, return the flat list with pagination.

3. **`ExpertsService` doesn't exist yet.** When you implement it (Lesson 30/40), use the search query from §5.2 as the template. Add pagination, add `EXPLAIN ANALYZE` to the test suite, add an N+1 regression test.

4. **Audit all `findOne` calls for PII leak risk.** Every `findOne(User)` should explicitly use `select: ['id', 'email', 'role', 'status']` (not `select: true`) to prevent accidental password-hash leakage. Or use `select: false` on the password column (you already do this) AND a DTO that strips the field.

### 13.1 The PII leak test

For every endpoint that returns user data, write a test:

```ts
it('does not leak passwordHash in the response', async () => {
  const user = await userService.create({ email: 'x@y.com', password: 'secret' });
  const response = await request(app).get(`/users/${user.id}`).expect(200);

  expect(response.body).not.toHaveProperty('passwordHash');
  expect(response.body).not.toHaveProperty('pass_hash');
  expect(response.body.email).toBe('x@y.com');
});
```

This test catches the "I forgot `select: false`" bug. The bug ships to prod; the test catches it before merge.

---

## 14. The migration recipe — when you change a relationship

When you change a relationship (add a relation, change `onDelete`, promote a pivot), your migration must:

1. `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY (...) REFERENCES ...(...)` (or `DROP CONSTRAINT`).
2. Set `ON DELETE ...` explicitly — never rely on default.
3. Add the index (`CREATE INDEX ... ON ... (fk_column)`) or drop it.
4. For pivots: add composite PK (or drop and recreate when promoting).
5. Write a `down` migration that reverses every step in opposite order. **Always.**
6. Run the migration against a seeded dev DB. Hand-fire the cascade to confirm it does what you expect.
7. `EXPLAIN ANALYZE` every query that touches the changed column. Compare to before.

### 14.1 The recipe for adding a new relation

```ts
export class AddExpertCategoryIndex1700000000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Add the FK constraint
    await queryRunner.query(`
      ALTER TABLE experts
      ADD CONSTRAINT fk_experts_category
      FOREIGN KEY (category_id) REFERENCES categories(id)
      ON DELETE RESTRICT
    `);

    // 2. Add the index
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY idx_experts_category ON experts (category_id)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS idx_experts_category`);
    await queryRunner.query(`ALTER TABLE experts DROP CONSTRAINT fk_experts_category`);
  }
}
```

### 14.2 The recipe for promoting a pivot

Already covered in Lesson 03 §7.4. The order matters: drop the old PK, add the new `id` column, add the new PK, add the business column, add the unique constraint, then add the index.

### 14.3 The recipe for changing `onDelete`

```ts
export class ChangeExpertCategoryOnDelete1700000000001 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE experts DROP CONSTRAINT fk_experts_category
    `);
    await queryRunner.query(`
      ALTER TABLE experts
      ADD CONSTRAINT fk_experts_category
      FOREIGN KEY (category_id) REFERENCES categories(id)
      ON DELETE RESTRICT
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Revert to the previous behavior; you need to know what it was
  }
}
```

**The down migration trap:** If you don't know what the previous `onDelete` was, the down migration is guesswork. Always document the current state in the migration comment before changing it.

### 14.4 The order of operations for adding a cardinality

When you add a new relationship:

1. **Create the parent table** (if it doesn't exist).
2. **Create the child table** with the FK column (initially nullable, no constraint).
3. **Backfill the FK** for existing rows.
4. **Add the FK constraint as `NOT VALID`** (so the add is fast).
5. **`VALIDATE CONSTRAINT`** (so the constraint is enforced for new rows).
6. **Add the index `CONCURRENTLY`** (so the index doesn't lock writes).
7. **Set `NOT NULL`** (if applicable, after backfill).

Doing it in the wrong order either fails (FK constraint on a column with NULLs) or locks the table (adding NOT NULL on a large table rewrites the whole table).

---

## 15. The observability hooks

### 15.1 Enable TypeORM query logging in dev

```ts
// typeorm.config.ts (dev)
{
  type: 'postgres',
  // ...
  logging: ['query', 'error', 'warn'],
  logger: 'advanced-console',
}
```

In production, set `logging: ['error', 'warn']` only. Full query logging in prod is too noisy and can leak PII to logs.

### 15.2 Postgres `log_min_duration_statement`

```sql
-- postgresql.conf
log_min_duration_statement = 500;  -- log queries slower than 500ms
```

This catches the N+1 patterns and the missing-index patterns. Combined with `pg_stat_statements`, you get a full picture of what's slow.

### 15.3 The application-level query counter

A TypeORM subscriber that counts queries per request:

```ts
@EventSubscriber()
export class QueryCounterSubscriber implements EntitySubscriberInterface {
  static queryCount = 0;

  beforeQuery(event: QueryEvent) {
    QueryCounterSubscriber.queryCount++;
  }
}

// In NestJS: use a request-scoped counter
@Injectable()
export class RequestQueryCounter {
  private count = 0;
  increment() { this.count++; }
  get() { return this.count; }
}
```

In tests, assert "this endpoint should fire ≤ 5 queries". The test fails if you accidentally introduce an N+1.

### 15.4 The pg_stat_statements extension

`pg_stat_statements` is a Postgres extension that aggregates query statistics:

```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
```

Then:

```sql
SELECT calls, mean_exec_time, total_exec_time, query
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 20;
```

This shows you the top 20 queries by total time. If "SELECT * FROM qualifications WHERE category_id = $1" is at the top with 10,000 calls and 50 seconds of total time, you have an N+1.

### 15.5 The pg_stat_user_tables view

For missing-index detection:

```sql
SELECT relname, seq_scan, idx_scan, n_live_tup
FROM pg_stat_user_tables
WHERE schemaname = 'public'
ORDER BY seq_scan DESC;
```

Tables where `seq_scan >> idx_scan` are missing indexes.

---

## 16. The security implications

### 16.1 The PII leak via `*AndSelect`

`leftJoinAndSelect` on a relation that includes PII is a security control. If you `leftJoinAndSelect('e.user', 'u')` and `User` has `passwordHash` (even with `select: false`), TypeORM will NOT include it (the `select: false` is respected). But if you use `addSelect('u.*')` or `leftJoinAndSelect('u')` without the `select: false`, the password hash is in the response.

**The defense:** Always use `select: false` on PII columns, AND use DTOs that explicitly list fields. Belt and suspenders.

```ts
@Column({ type: 'varchar', name: 'pass_hash', select: false })
passwordHash: string;
```

```ts
// user-response.dto.ts
export class UserResponseDto {
  @Expose() id: number;
  @Expose() email: string;
  @Expose() role: UserRole;
  // NO passwordHash
}
```

The DTO is the last line of defense. Even if a refactor removes `select: false`, the DTO strips the field.

### 16.2 The IDOR trap via JOIN

If your endpoint is `GET /experts/:id/reviews`, the cardinality is `Experts 1—N Reviews`. The naive implementation:

```ts
@Get(':id/reviews')
async getReviews(@Param('id') id: number) {
  return this.reviewRepo.find({ where: { expert_id: id } });
}
```

If the expert is soft-deleted or banned, this still returns their reviews. The fix: join on the expert and check status:

```ts
@Get(':id/reviews')
async getReviews(@Param('id') id: number) {
  return this.reviewRepo
    .createQueryBuilder('review')
    .innerJoinAndSelect('review.expert', 'expert')
    .where('expert.id = :id', { id })
    .andWhere('expert.status = :status', { status: 'active' })
    .getMany();
}
```

The lesson: every endpoint that traverses a relationship should check the *intermediate* entity's status, not just the target.

### 16.3 The DoS via cartesian blowup

A list endpoint that does `leftJoinAndSelect` on 4 collections with 100 parents, each having 5 children per collection, returns 100 × 5^4 = 62,500 rows. The response is ~30MB. The attacker sends 10 such requests; your server is busy serializing 300MB of JSON for 10 minutes.

**The defense:** Always paginate (`take: 20`). Always use the two-query pattern (load relations per row, not via cartesian). Always have a max page size (`take: Math.min(requestedTake, 100)`).

### 16.4 The query injection trap

TypeORM parameterizes queries by default. `where: { id: userInput }` becomes `WHERE id = $1` with the value bound, not interpolated. You can't inject SQL through this.

But raw SQL via `manager.query(...)` is NOT parameterized by default. Always use the parameter array:

```ts
// BAD
await manager.query(`SELECT * FROM experts WHERE id = ${id}`);

// GOOD
await manager.query(`SELECT * FROM experts WHERE id = $1`, [id]);
```

The `$1` is a placeholder; the value is bound. SQL injection is impossible.

---

## 17. The testing strategy

### 17.1 The query count test

For every endpoint, assert the query count:

```ts
it('loads the expert detail page in ≤ 3 queries', async () => {
  QueryCounterSubscriber.reset();

  const response = await request(app).get('/experts/42');

  expect(QueryCounterSubscriber.count).toBeLessThanOrEqual(3);
  expect(response.status).toBe(200);
});
```

This catches N+1 regressions. If someone adds a loop that accesses a lazy relation, the query count jumps, the test fails.

### 17.2 The PII leak test

```ts
it('does not leak passwordHash in the response', async () => {
  const user = await userService.create({ email: 'x@y.com', password: 'secret' });
  const response = await request(app).get(`/users/${user.id}`).expect(200);

  expect(response.body).not.toHaveProperty('passwordHash');
  expect(response.body).not.toHaveProperty('pass_hash');
});
```

### 17.3 The cartesian test

```ts
it('list endpoint does not return cartesian-exploded rows', async () => {
  // Seed 20 experts, each with 3 qualifications, 2 languages, 1 organization, 2 prices
  await seedComplexExpertData(20);

  const response = await request(app).get('/experts?limit=20').expect(200);

  // The response should have 20 experts, not 240 (20 × 12 cartesian)
  expect(response.body.data).toHaveLength(20);

  // Each expert should have all their relations, not 12 copies
  for (const expert of response.body.data) {
    expect(expert.qualifications.length).toBe(3);
    expect(expert.languages.length).toBe(2);
  }
});
```

### 17.4 The pagination stability test

```ts
it('pagination is stable across page boundaries', async () => {
  // Seed 100 experts with the same avg_rating
  await seedExpertsWithSameRating(100);

  const page1 = await request(app).get('/experts?page=1&limit=20').expect(200);
  const page2 = await request(app).get('/experts?page=2&limit=20').expect(200);

  const page1Ids = page1.body.data.map(e => e.id);
  const page2Ids = page2.body.data.map(e => e.id);

  // No overlap
  expect(page1Ids.filter(id => page2Ids.includes(id))).toHaveLength(0);
});
```

### 17.5 The cycle test

```ts
it('refuses to create a category cycle', async () => {
  const medical = await categoryRepo.save({ name: 'Medical' });
  const cardiology = await categoryRepo.save({ name: 'Cardiology', parent_id: medical.id });

  await expect(
    categoryRepo.update(medical.id, { parent_id: cardiology.id }),
  ).rejects.toThrow(/cycle/i);
});
```

---

## 18. The "before you ship" checklist

For every read-heavy service method, before you commit:

- [ ] Did I `leftJoinAndSelect` (or `innerJoin`) for every relation the response DTO needs?
- [ ] Did I avoid `relations` for lists with N>20?
- [ ] Did I avoid `*AndSelect` with 3+ collections on lists? (If yes, use the two-query pattern.)
- [ ] Did I add `take`/`skip` (or keyset pagination)?
- [ ] Did I add a tie-breaker to `ORDER BY`?
- [ ] Did I `EXPLAIN ANALYZE` the emitted SQL?
- [ ] Are there any missing FK indexes from Lesson 03 §6.2?
- [ ] Did I write a query count test that asserts ≤ N queries?
- [ ] Did I write a PII leak test that asserts no `passwordHash` in the response?
- [ ] Did I write a pagination stability test?
- [ ] Is the response shaped by a DTO (not the raw entity)?
- [ ] Does the endpoint check the *intermediate* entity's status (IDOR defense)?

If you can't tick all twelve, the method isn't ready.

---

## 19. The business-stakeholder translation

When a non-technical stakeholder asks "why does this take so long?" or "why is the API slow?", you need a translation.

**Q: "Why does the search take 2 seconds?"**
A: Three likely causes: (1) missing index on a column we're filtering by (one-line fix); (2) the query is loading too much data and serializing it (refactor to paginate and load relations per row); (3) the database connection pool is exhausted (increase pool size or reduce query duration). We diagnose with `EXPLAIN ANALYZE` and a query counter. One-day fix.

**Q: "Why do we have separate `User` and `Profile` tables?"**
A: Three reasons: (1) security — password hashes never leak in API responses; (2) GDPR — we can delete PII without deleting auth; (3) performance — login queries don't pull PII. The split is one of the most leveraged design decisions in the codebase.

**Q: "Why can't we just return all the data in one query?"**
A: Returning all related data in one query causes a "cartesian blowup" — the response grows multiplicatively with the number of relations. For 20 experts with 4 relations each, the response is 60MB instead of 200KB. The page takes 5 seconds to load. The fix is to load the list and the relations in two queries, then merge server-side. The page loads in 200ms.

**Q: "Why does the page sometimes show the same expert twice?"**
A: When we filter on multiple joined conditions (e.g. "speaks Bangla AND English"), the database can return the same expert multiple times. The fix is to use `DISTINCT` or `GROUP BY` to dedupe. Five-minute change.

**Q: "Why is the password hash in the response?"**
A: It shouldn't be. There's a configuration that hides it (`select: false`), and a DTO that strips it. Either the configuration was removed, or a new endpoint was added without the DTO. We add a test that catches this and merge the fix. Ten-minute change.

**Q: "Why are some pages slow at peak hours but fast off-peak?"**
A: Likely a connection pool exhaustion issue. At peak, all connections are busy and queries queue up. The fix is to increase the pool size or reduce the per-query duration. We measure with `pg_stat_activity` and `pg_stat_statements`. Half-day change.

---

## 20. Self-check

Answer these in writing before moving to Lesson 05.

1. What's the difference between `relations: ['a']` and `leftJoinAndSelect('x.a', 'a')`? How many SQL queries does each emit?
2. Write the query for "all verified experts in the Cardiology category, ordered by review count DESC, with their user loaded".
3. Write the query for "all experts who speak both Bangla and English, with their user loaded, but do not include the language rows in the response".
4. Why is `innerJoin` wrong for fetching "experts + their (possibly empty) languages"?
5. Why is `eager: true` a bad default in production code?
6. What's the N+1 pattern? Write a fix using `leftJoinAndSelect`.
7. You have `findOne({ where: { id }, relations: ['category'] })` and then `category.experts` is `undefined`. Why? Fix it.
8. You want to filter experts by `qualification.obtainedYear >= 2010`, but you used `@JoinTable`. What do you have to do first?
9. Why does `findAndCount({ order: { avg_rating: 'DESC' } })` produce unstable pagination? What's the fix?
10. Your list endpoint joins `experts → qualifications → languages → organizations` and the response is huge. Two strategies to fix it.
11. What is the cartesian blowup and how do you detect it? What's the fix?
12. What is keyset pagination and when do you use it instead of offset pagination?
13. Read the following `EXPLAIN ANALYZE` output. What's the likely problem? `Seq Scan on experts e (cost=... rows=1000 time=50ms) Filter: (verification_status = 'verified')`
14. Why is `select: false` on `User.passwordHash` not enough by itself? What else do you need?
15. What is the two-query pattern for list endpoints, and why is it faster than `*AndSelect` on 4 collections?
16. Why should you add a tie-breaker to `ORDER BY` for pagination?
17. What is the IDOR trap via JOIN, and how do you defend against it?
18. Why is a query count test a regression test for N+1?
19. What is `pg_stat_statements` and how do you use it to find slow queries?
20. A stakeholder asks "why is the search slow?". List four query-level causes and how you'd diagnose each.

When you can answer all twenty without re-opening this file, go to **Lesson 05**.
