# Lesson 03 — Special Cases, `onDelete`, and Indexes

> **What you'll get:** the two "weird" relationships in your schema (self-referencing trees, 0..1 extensions), the entire `onDelete` decision matrix, the FK-indexing rules, the recipe for promoting a pivot to a real entity when business data creeps in, and — critically — the *production* consequences of each choice. By the end you should be able to audit every FK in your schema, justify the `onDelete` choice in one sentence, predict the failure mode of the wrong choice, and explain to a non-technical stakeholder why each decision protects the business.
>
> **Why this lesson exists:** Lesson 02 covered the three base relationships. Lesson 03 covers the five decisions that turn "it works" into "it works in production": how do children behave when their parent dies (`CASCADE` vs `RESTRICT`), how do you index a FK for fast lookups, how do you model the recursive tree in `Categories` and the nullable expert extension in `Users`, and when do you promote an implicit M:N pivot to a real entity. Get any of these wrong and you have a customer-facing outage, a slow query, a GDPR violation, or a feature that can't ship. This lesson is the rubric for not making those mistakes.
>
> **Prerequisites:** Lesson 02 (you must be fluent with 1:1, 1:N, M:N, owning side, `@JoinColumn`, `@JoinTable`).

---

## 1. Goal

By the end of this lesson you can:

1. Model a self-referencing tree (`Categories.parent_id`) with `nullable: true` + `ON DELETE RESTRICT` for protected roots.
2. Model a 0..1 extension (`Users ↔ Experts`) with `unique: true` and the right `onDelete` for GDPR.
3. Pick the right `onDelete` for any FK in your schema, justify the choice in one sentence, and predict the failure mode of the wrong choice.
4. Explain why `experts.category_id` with `CASCADE` is a customer-facing outage waiting to happen, and how to prevent it.
5. Identify which FK columns in your schema need an index, and write the migration.
6. Decide when to promote an implicit `@JoinTable` pivot to a real `@Entity()`, and execute the migration safely.
7. Recognize the cycle hazard in self-referencing trees and write a defense (app code, check constraint, or Postgres trigger).
8. Read `EXPLAIN ANALYZE` output and identify which missing index is causing a sequential scan.
9. Audit an existing schema and produce a list of cardinality decisions to revisit.
10. Explain the soft-delete interaction with `CASCADE` and when each is appropriate.

---

## 2. Why this matters — the production incidents that come from these decisions

The decisions in this lesson are the ones that, when wrong, take down production systems quietly. Three real-world scenarios (composite from real codebases, paraphrased to protect the guilty):

- **The category wipe.** A junior engineer chose `ON DELETE CASCADE` for `experts.category_id` because the diagram looked clean. A product manager renamed a category, the cascade deleted 1,200 experts, and the team spent a Saturday restoring from backups. The fix is `RESTRICT`, plus an explicit "move children then delete" admin tool.

- **The recursive runaway.** A status update script tried to "delete the inactive categories" with a plain `DELETE`. The CASCADE on `parent_id` deleted every descendant in every branch, then the CASCADE on `experts.category_id` deleted the experts, then the CASCADE on `submissions.expert_id` deleted the submissions, then the CASCADE on `documents.submission_id` deleted the documents. One query, three hours of incident. The lesson: `CASCADE` is a multiplier. A small mistake becomes a large incident.

- **The pivot that wouldn't scale.** `expert_qualifications` started as a `@JoinTable` pivot. Six months later, product wanted `obtained_year` and `verified_at`. The team hacked JSON columns onto the pivot instead of promoting it. Six months after that, they couldn't query "experts who got their degree after 2010". The team had to migrate the entire pivot to an entity anyway — but now the data was in JSON, the migration took a week, and the search feature slipped a quarter.

- **The missing index.** A search endpoint `WHERE category_id = X` did a sequential scan because the FK had no index. At 50k experts, the endpoint took 3 seconds. Users complained. The team added the index in 30 seconds; the endpoint dropped to 15ms. The lesson: missing FK indexes are the most common "why is the API slow?" bug, and they're trivial to prevent.

- **The cycle that broke the tree.** An admin UI let a user set `category.parent_id` to any category, including the category's own descendant. The result: a cycle in the tree. Every "walk the subtree" query entered an infinite loop. The site was down for 45 minutes. The fix: a Postgres trigger that refuses the update.

None of these were bugs in the *code*. They were bugs in the *schema decisions*. This lesson is the rubric for not making them.

### 2.1 The current state of your codebase — bugs to fix

Before we proceed, audit your current code. These are the issues Lesson 03 will teach you to fix:

1. **`categories.entity.ts` line 47: `onDelete: 'CASCADE'` on `parent_id`.** This is the recursive-runaway bug. Deleting a category wipes its entire subtree, which then cascades into qualifications, prices, and (if you ever change it) experts. **Should be `RESTRICT`.**

2. **`otp.entity.ts` line 19: `@OneToOne(() => User)` with no inverse side.** The current entity allows only one OTP per user, ever. The "resend OTP after 60 seconds" feature requires multiple OTPs per user (with a `purpose` field, a `created_at` for cooldown, and an `expires_at`). **Should be `@ManyToOne` with a composite index on `(user_id, purpose, status)`.**

3. **`experts.category_id` has no index decorator.** The `@ManyToOne` is there, but there's no `@Index()`. The search endpoint `WHERE category_id = X` will sequential scan. **Should add `@Index()` above the `@ManyToOne`.**

4. **`expert_qualifications`, `expert_languages`, `expert_organizations`, `expert_prices` have no composite PK on `(expert_id, other_id)`.** TypeORM's `@JoinTable` does not create the composite PK. Duplicate rows are possible. **Should add the composite PK in a migration.**

5. **`qualifications.category_id` has `onDelete: 'CASCADE'`.** This is correct (qualifications die with their category), but worth confirming in the decision matrix below.

We'll revisit these in §11.

---

## 3. Special case 1 — the self-referencing tree

### 3.1 What it is

A table that points at itself. In your schema: `Categories.parent_id` references `Categories.id`. This is how you model "categories have sub-categories have sub-categories".

```text
Medical
├── Cardiology
│   ├── Interventional
│   └── Pediatric
├── Neurology
└── Dermatology
```

This pattern is everywhere: category trees, organizational charts, comment threads (`comments.parent_id` references `comments.id`), file systems, knowledge bases. Once you see it, you can't unsee it.

### 3.2 The pattern (1:N from a table to itself)

```ts
// categories.entity.ts
@ManyToOne(() => Category, (category) => category.children, {
  onDelete: 'RESTRICT',     // ← root categories are protected
  nullable: true,             // ← top-level categories have no parent
})
@JoinColumn({ name: 'parent_id' })
parent!: Category | null;

@OneToMany(() => Category, (category) => category.parent)
children!: Category[];
```

Two decorators, same entity, same relationship, both directions. The `@ManyToOne` is the owning side (holds the FK column); `@OneToMany` is the inverse (declaration only, no column).

**The current bug:** Your `category.entity.ts` has `onDelete: 'CASCADE'` on `parent_id`. This is wrong for the reasons in §3.4. We'll fix it in §3.6.

### 3.3 The nullable parent

`Categories.parent_id` must be nullable — a top-level category has no parent. `nullable: true` lets the column be `NULL`. There's no top-level-marker row; absence is the marker.

If you set `nullable: false`, every category must have a parent. The first category you try to insert will fail with `NOT NULL violation`. You can't seed the tree. The fix: `nullable: true` is mandatory for any self-referencing tree where roots exist.

### 3.4 The cycle hazard

Nothing in SQL prevents `A.parent = B` and `B.parent = A`. You must enforce "no cycles" in app code, or with a check constraint, or — the bulletproof option — a Postgres trigger:

```sql
CREATE OR REPLACE FUNCTION prevent_category_cycle()
RETURNS trigger AS $$
DECLARE
  pid INT;
BEGIN
  pid := NEW.parent_id;
  WHILE pid IS NOT NULL LOOP
    IF pid = NEW.id THEN
      RAISE EXCEPTION 'Category cycle detected: % -> %', NEW.id, pid;
    END IF;
    SELECT parent_id INTO pid FROM categories WHERE id = pid;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_prevent_category_cycle
BEFORE INSERT OR UPDATE OF parent_id ON categories
FOR EACH ROW EXECUTE FUNCTION prevent_category_cycle();
```

This walks up the chain on every update. On your data sizes (categories in the hundreds) the cost is negligible. The protection is total.

**Why app-level validation isn't enough:** Your service layer can validate "no cycles" before saving. But raw SQL access (admin tools, psql, future microservices, ETL jobs) bypasses your service layer. The DB-level trigger is the only defense that catches all paths.

**Performance consideration:** The trigger walks the chain on every UPDATE of `parent_id`. For a tree of depth 10, that's 10 SELECTs per update. For your data (categories in the hundreds, depth < 5), this is fine. If your tree ever grows to depth 100+, consider a `ltree` extension instead, which has native cycle detection and recursive query support.

### 3.5 Recursive queries — "all descendants of Cardiology"

A plain `find` only gets direct children. To get the full subtree, use a recursive CTE:

```sql
WITH RECURSIVE category_tree AS (
  SELECT id, parent_id, name, 0 AS depth
  FROM categories
  WHERE id = $1                    -- start: Cardiology

  UNION ALL

  SELECT c.id, c.parent_id, c.name, ct.depth + 1
  FROM categories c
  JOIN category_tree ct ON c.parent_id = ct.id
)
SELECT * FROM category_tree
ORDER BY depth, name;
```

Postgres handles this natively; no extensions. Wire it into TypeORM with `createQueryBuilder().from(...).select(...)` and a raw SQL fragment, or define it as a view.

**Performance:** For a tree of 500 categories, the recursive CTE is sub-millisecond. For 50k categories, still fast. The recursion is bounded by the tree depth and total node count; Postgres handles it well. The key index: `categories(parent_id)` so the `JOIN` is an index scan, not a sequential scan.

**TypeORM pattern:**

```ts
async findSubtree(rootId: number): Promise<Category[]> {
  return this.dataSource.query(
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
    SELECT * FROM category_tree ORDER BY depth, name
    `,
    [rootId],
  );
}
```

**Common mistake:** Using `parent.parent.parent...` in app code instead of a recursive CTE. This is O(depth) queries per subtree. For a tree of depth 5 with 100 descendants, that's 100 × 5 = 500 queries. The recursive CTE is 1 query.

### 3.6 The cascade decision for `parent_id`

| Choose                    | When                                                                       |
|---------------------------|----------------------------------------------------------------------------|
| `CASCADE`                 | Deleting a category should wipe its entire subtree (e.g. "remove this deprecated branch" as a deliberate admin action) |
| `RESTRICT`                | Root categories are protected; deletion must be explicit (the right default for you) |
| `SET NULL`                | Orphaned categories become roots (rarely what you want; creates phantom trees) |
| `NO ACTION`               | Like `RESTRICT` at commit time; almost never what you want                  |

For your app: **`RESTRICT` is the safe default**. Add an admin-only "delete subtree" operation that explicitly deletes children first. This makes accidental `DELETE FROM categories WHERE id = X` a no-op instead of a customer-facing outage.

**The current bug in your code:** `categories.entity.ts` line 47 has `onDelete: 'CASCADE'`. This is the recursive-runaway bug. One `DELETE FROM categories WHERE id = 5` wipes the entire subtree under category 5, which cascades to qualifications, prices, and (if you ever change `experts.category_id`) experts. **Change to `RESTRICT` in your code, then add a migration to alter the existing FK constraint.**

### 3.7 The admin-tool pattern for subtree deletion

When you RESTRICT a delete, your admin code has to:

1. Detect that the entity has children.
2. Decide what to do with the children (move to a new parent? soft-delete them? reassign?).
3. Move/reassign/delete the children explicitly.
4. Then delete the parent.

This is a service-layer concern. The DB does the right thing automatically (refuses to delete). The admin tool does the right UX thing (explicit "this will affect 47 experts — proceed?").

**Pattern:**

```ts
async deleteCategoryWithReassignment(
  categoryId: number,
  newParentId: number,
): Promise<void> {
  await this.dataSource.transaction(async (manager) => {
    // 1. Detect children
    const childCount = await manager.count(Category, { where: { parent_id: categoryId } });
    if (childCount > 0) {
      // 2. Reassign children to the new parent
      await manager.update(
        Category,
        { parent_id: categoryId },
        { parent_id: newParentId },
      );
    }

    // 3. Now safe to delete (RESTRICT is satisfied because no children remain)
    await manager.delete(Category, categoryId);
  });
}
```

**Never** catch the `ForeignKeyConstraintViolationError` and "fix" it by deleting children automatically. That's how production data disappears silently. The error is the system telling you "stop, you have children". Listen to it.

### 3.8 Common self-ref tree bugs

| Symptom                                                       | Cause                                                          | Fix                                                  |
|---------------------------------------------------------------|----------------------------------------------------------------|------------------------------------------------------|
| `NOT NULL violation` on first category insert                  | `parent_id` is `nullable: false`                                | Set `nullable: true`                                  |
| `RecursiveError: stack overflow` on a category query           | Cycle in the tree (`A.parent = B`, `B.parent = A`)              | Add the Postgres trigger; run a script to find and break existing cycles |
| `DELETE FROM categories WHERE id = 5` wipes 1,200 rows         | `onDelete: 'CASCADE'` on `parent_id`                           | Change to `RESTRICT`; add explicit "reassign children" admin tool |
| Loading the subtree takes 100ms for 50 nodes                   | You're walking the tree in app code, one query per level       | Use a recursive CTE                                  |
| `category.children` is `undefined` after `findOne`            | Inverse side is lazy; you didn't `relations: ['children']`     | Load explicitly (Lesson 04)                          |

---

## 4. Special case 2 — the 0..1 extension

### 4.1 What it is

A row in A has *zero or one* matching row in B. In SQL terms: the FK is nullable *and* unique. In your schema: `Experts.user_id` — most users are not experts, but every expert must be a user.

### 4.2 The pattern

```ts
// user.entity.ts (the inverse side — no @JoinColumn)
@OneToOne(() => Expert, (expert) => expert.user)
expert?: Expert;
```

```ts
// expert.entity.ts (the owning side)
@OneToOne(() => User, (user) => user.expert, { onDelete: 'CASCADE' })
@JoinColumn({ name: 'user_id', unique: true })     // ← unique: true enforces "at most one"
user!: User;
```

Two things make this "0..1" instead of "1":

1. **`unique: true`** — DB refuses a second expert row pointing at the same user.
2. **`nullable: true` is implicit on a 1:1 if you want 0..1** — but since `Experts.user_id` is required (every expert is a user), keep it `nullable: false`. The "0" is on the *other* side: most users have no `expert` row.

### 4.3 Why `unique: true` is doing the heavy lifting

The "0..1" semantics live in two places: the `unique` constraint on `experts.user_id`, and the absence of an `experts` row for non-expert users. The query "is this user an expert?" is:

```sql
SELECT * FROM experts WHERE user_id = $1;   -- returns 0 or 1 row
```

If you forget `unique: true`, the query can return two rows. Your UI shows "this user is two different experts". Your `findOne` returns the first row. Your users see ghost data. The unique constraint is a one-line constraint that prevents an entire class of silent data corruption.

### 4.4 The cascade decision for `user_id`

`ON DELETE CASCADE`. When a user is deleted, the expert row goes with them. This is the GDPR "right to be forgotten" path. If you choose `RESTRICT`, you can't delete a user who is an expert without first deleting the expert — usually not what you want.

**But soft-delete first.** Hard-delete should only happen after the GDPR cooling-off period (30 days). Until then, soft-delete the user. The CASCADE only fires on hard delete. This is the right pattern: soft-delete for normal user flows, hard-delete for GDPR requests after the cooling-off period.

### 4.5 The "is this user an expert?" query pattern

The common query is "does user X have an expert profile?". With the 0..1 model:

```ts
async isExpert(userId: number): Promise<boolean> {
  const count = await this.expertRepo.count({ where: { user: { id: userId } } });
  return count > 0;
}
```

With the unique constraint, this is guaranteed to return 0 or 1. The `count` is cheap (unique index lookup). Don't use `findOne` here — `count` is faster and signals intent.

### 4.6 Common 0..1 bugs

| Symptom                                                       | Cause                                                          | Fix                                                  |
|---------------------------------------------------------------|----------------------------------------------------------------|------------------------------------------------------|
| Two expert rows for one user                                   | Missing `unique: true`                                         | Add unique constraint; deduplicate rows               |
| `user.expert` is `undefined` after `findOne`                  | Inverse side is lazy; you didn't `relations: ['expert']`     | Load explicitly                                      |
| Deleting a user does not delete the expert                    | Missing `onDelete: 'CASCADE'`                                  | Add it on `Expert.user`                              |
| `findOne` returns wrong row when duplicates exist             | Missing `unique: true`; `findOne` returns first by PK          | Add unique constraint; clean up duplicates           |

---

## 5. `onDelete` — the decision matrix

This is the single most leveraged decision in the schema. Pick deliberately for every FK. The four options:

| Option       | What Postgres does if parent is deleted                                       | When to use                                                                                  |
|--------------|--------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------|
| `CASCADE`    | Silently deletes all child rows                                                | Child is meaningless without parent (Profiles of a deleted User, OTP of a deleted User)    |
| `RESTRICT`   | Refuses to delete the parent until children are removed (raises an error)     | Parent has business meaning that must survive children (don't delete Category while Experts exist) |
| `SET NULL`   | Child's FK becomes `NULL` (column must be nullable)                            | Child can exist orphaned (Comments when the User is gone, if you keep the comment for moderation) |
| `NO ACTION`  | Like `RESTRICT` but checked at commit time, not row time                       | Default; rarely what you want                                                                 |

### 5.1 The rule of thumb

> **Be liberal with CASCADE downward (child → grandchild) and conservative with CASCADE upward (parent → child). When in doubt, use RESTRICT and add an explicit "move children then delete" admin operation.**

"Downward" means: the FK is on the child side and the relationship is "child belongs to parent". If parent dies, child has no meaning → CASCADE.

"Upward" means: deleting the parent would wipe grandchildren as well. That's the danger zone. CASCADE upward is almost always wrong for top-of-tree parents.

**The `experts.category_id` case in detail:** The relationship is "expert belongs to category" (downward). But the *consequence* of `CASCADE` is "deleting a category wipes all experts in it" (upward in the cascade chain). The "downward" rule says CASCADE is fine. The "consequence" rule says RESTRICT. The right answer is RESTRICT, because the *blast radius* of the decision is what matters, not the *direction of the FK*.

### 5.2 The decisions for your schema

Every FK in `er-2.drawio`, with my recommendation and the reason:

| FK column                                  | Recommended `onDelete` | Why                                                                                  |
|--------------------------------------------|------------------------|--------------------------------------------------------------------------------------|
| `profiles.user_id`                         | `CASCADE`              | Profile is meaningless without user (GDPR)                                            |
| `experts.user_id`                          | `CASCADE`              | Expert extension dies with the user                                                   |
| `posts.user_id`                            | `CASCADE`              | Posts are owned by the user; user deletion scrubs them                                |
| `comments.user_id`                         | `CASCADE`              | Same as posts                                                                        |
| `reacts.user_id`                           | `CASCADE`              | Reactions die with the user                                                          |
| `channels.user_id`                         | `CASCADE`              | Channels are owned by the user                                                       |
| `reviews.user_id`                          | `CASCADE`              | Reviewer's review dies with them (NOT the expert's review history — see below)        |
| `reviews.expert_id`                        | `RESTRICT`             | Don't lose review history if an expert is deleted (soft-delete instead)              |
| `otp.user_id`                              | `CASCADE`              | OTPs are useless after user is gone                                                  |
| `posts.id` ← `reacts.post_id`              | `CASCADE`              | Reactions die with the post                                                           |
| `posts.id` ← `comments.post_id`            | `CASCADE`              | Comments die with the post                                                           |
| `categories.id` ← `categories.parent_id`   | `RESTRICT`             | Protect root categories from accidental cascade-wipe                                 |
| `categories.id` ← `experts.category_id`    | `RESTRICT`             | Don't wipe experts by renaming/merging categories                                    |
| `categories.id` ← `qualifications.category_id` | `CASCADE`          | Qualifications belong to their category; drop them if category drops                  |
| `categories.id` ← `prices.category_id`     | `CASCADE`              | Prices belong to their category; drop them if category drops                         |
| `experts.id` ← `submissions.expert_id`     | `CASCADE`              | Submissions are part of an expert's lifecycle                                        |
| `experts.id` ← `reviews.expert_id`         | `RESTRICT`             | Preserve review history                                                              |
| `submissions.id` ← `documents.submission_id` | `CASCADE`            | Documents belong to a submission                                                      |
| `submissions.id` ← `verifications.submission_id` | `CASCADE`        | Verifications belong to a submission                                                 |
| `experts.id` ← `expert_qualifications.expert_id` | `CASCADE`        | Pivot row is meaningless without expert                                              |
| `qualifications.id` ← `expert_qualifications.qualification_id` | `CASCADE` | Pivot row is meaningless without qualification                                  |
| `experts.id` ← `expert_languages.expert_id` | `CASCADE`            | Same                                                                                 |
| `languages.id` ← `expert_languages.language_id` | `CASCADE`         | Same                                                                                 |
| `experts.id` ← `expert_organizations.expert_id` | `CASCADE`        | Same                                                                                 |
| `organizations.id` ← `expert_organizations.organization_id` | `CASCADE` | Same                                                                                |
| `experts.id` ← `expert_prices.expert_id`   | `CASCADE`              | Same                                                                                 |
| `prices.id` ← `expert_prices.price_id`     | `CASCADE`              | Same                                                                                 |

### 5.3 The "danger zone" pairs

Three FKs where CASCADE is *catastrophic* if you get it wrong. Re-read this list before you let `synchronize: true` anywhere near your DB:

1. **`experts.category_id` with `CASCADE`** — deleting one category wipes every expert under it, plus their submissions, reviews, pivot rows. A single SQL statement away from a customer-facing outage. **Use RESTRICT.** Your code already does this correctly (`expert.entity.ts` line 46); keep it.

2. **`categories.parent_id` with `CASCADE`** — deleting one node deletes its entire subtree, which then cascades into `Qualifications`, `Prices`, and (if you mis-configured) `Experts`. **Use RESTRICT.** Your code currently has `CASCADE` here (`category.entity.ts` line 47) — **this is a bug, fix it in a migration**.

3. **`reviews.expert_id` with `CASCADE`** — destroys review history. **Use RESTRICT.** Soft-delete the expert instead.

### 5.4 How to enforce RESTRICT in practice

When you RESTRICT a delete, your admin code has to:

1. Detect that the entity has children.
2. Decide what to do with the children (move to a new parent? soft-delete them? reassign?).
3. Move/reassign/delete the children explicitly.
4. Then delete the parent.

This is a service-layer concern. The DB does the right thing automatically (refuses to delete). The admin tool does the right UX thing (explicit "this will affect 47 experts — proceed?").

**Pattern:**

```ts
async deleteExpertSafely(expertId: number): Promise<void> {
  await this.dataSource.transaction(async (manager) => {
    // 1. Check for blocking references
    const reviewCount = await manager.count(Review, { where: { expert: { id: expertId } } });
    if (reviewCount > 0) {
      throw new ConflictException(
        `Cannot delete expert: ${reviewCount} reviews reference this expert. Soft-delete instead.`,
      );
    }

    // 2. Soft-delete instead of hard-delete
    await manager.softDelete(Expert, expertId);
  });
}
```

The DB's RESTRICT is the last line of defense. The service layer is the first line of UX. Both are needed.

### 5.5 The "CASCADE is multiplicative" warning

Every CASCADE you add is a multiplier on the blast radius of any `DELETE`. One CASCADE is fine. Five CASCADEs in a chain is a time bomb.

**Concrete example:** Suppose you have:
- `experts.user_id` → CASCADE on user delete
- `submissions.expert_id` → CASCADE on expert delete
- `documents.submission_id` → CASCADE on submission delete

Now `DELETE FROM users WHERE id = 5` cascades:
- 1 user deletion
- 1 expert deletion (CASCADE)
- 3 submissions deletion (CASCADE)
- 12 documents deletion (CASCADE)

One `DELETE` wipes 17 rows across 4 tables. If any of those has its own CASCADE children (pivots, audit logs, etc.), the multiplier grows.

**Defense:**
- Audit every CASCADE in your schema. List them. Ask: "if this fires, what's the blast radius?"
- For top-of-tree parents (`users`, `categories`), use RESTRICT or soft-delete.
- For mid-tree parents (`submissions`), CASCADE is usually fine because the blast radius is bounded.
- For leaf parents (`documents`), CASCADE is almost always safe.

### 5.6 The CASCADE and soft-delete interaction

Soft-delete does NOT fire CASCADE. The row stays in the DB; only the `deleted_at` column is set. This is the *point* of soft-delete: you can "delete" a user without wiping their expert, reviews, etc., because the DB-level DELETE doesn't happen.

If you need "soft-delete cascade" (soft-delete the user → soft-delete the expert → soft-delete the reviews), that's application logic, not DB logic. Use a service-layer method:

```ts
async softDeleteUser(userId: number): Promise<void> {
  await this.dataSource.transaction(async (manager) => {
    await manager.softDelete(User, userId);
    await manager.softDelete(Expert, { user: { id: userId } });
    // ... etc
  });
}
```

**Why this matters for the CASCADE choice:** If you soft-delete users (the right default), the CASCADE on `experts.user_id` rarely fires. It's a safety net for the GDPR hard-delete path, not the normal user flow. So the CASCADE choice is "what happens if we actually hard-delete this row", which is a rare event. Pick accordingly.

---

## 6. Indexes on FKs

### 6.1 Why you need them

A foreign-key column is **not automatically indexed** by Postgres. If you `SELECT * FROM posts WHERE user_id = 5`, Postgres does a sequential scan unless there's an index on `posts.user_id`. At 100k posts, that's seconds. With the index, milliseconds.

This is the most common performance bug in early Postgres schemas. The fix is one line per FK.

**Why doesn't Postgres auto-index FKs?** Historical design decision. The rationale was that not every FK is queried in isolation, and indexes have a write cost. Modern advice: index every FK unless you have a measured reason not to. The write cost of an index on a FK is small (1-5% slower inserts) compared to the read cost of a sequential scan (100-1000x slower queries).

### 6.2 The minimum index set for your schema

A FK is "must index" if any of:

- You query "all rows for parent X" (`WHERE user_id = X`, `WHERE category_id = X`).
- You join on it (`LEFT JOIN experts e ON e.category_id = c.id`).
- You sort by it (`ORDER BY category_id`).

The minimum index set:

| Column                                  | Why                                                                  |
|-----------------------------------------|----------------------------------------------------------------------|
| `users.email`                           | Login lookup (already `unique`, which creates an index)               |
| `posts.user_id`                         | "Feed for this user"                                                 |
| `posts.created_at`                      | Reverse-chrono feed                                                  |
| `comments.post_id`                      | "All comments of a post"                                             |
| `reacts(post_id, user_id)`              | Composite UNIQUE prevents double-reacting; doubles as an index       |
| `reviews.expert_id`                     | "All reviews of an expert"                                           |
| `experts.category_id`                   | "All experts in a category" — used by search                         |
| `expert_qualifications(expert_id, qualification_id)` | Composite PK + doubles as an index                       |
| `expert_languages(expert_id)` + `(language_id)`   | Both directions for search                            |
| `expert_organizations(expert_id)` + `(organization_id)` | Both directions                                |
| `expert_prices(expert_id, price_id)`    | Composite PK                                                         |
| `categories.parent_id`                  | Walk the tree                                                        |
| `submissions.expert_id`                 | Admin queue lookups                                                  |

**The current bug in your code:** `experts.category_id` has no `@Index()` decorator. The search endpoint `WHERE category_id = X` will sequential scan. **Add `@Index()` above the `@ManyToOne` in `expert.entity.ts`.**

### 6.3 TypeORM decorator pattern

```ts
@Index()                          // single-column index
@Column({ ... })
user_id!: number;

@Index(['post_id', 'user_id'], { unique: true })   // composite unique index
@ManyToOne(...)
post!: Post;
```

TypeORM will emit `CREATE INDEX` for non-unique `@Index()` decorators and a unique constraint (which creates a backing index) for `@Index({ unique: true })`. The composite PK on pivots goes in a migration; TypeORM does not emit it automatically.

### 6.4 The pivot index requirement — both directions

For an M:N pivot like `expert_qualifications(expert_id, qualification_id)`:

- The **composite PK** `(expert_id, qualification_id)` creates an index on `(expert_id, qualification_id)`. This serves queries like "what qualifications does expert 5 have?" (`WHERE expert_id = 5`).
- You also need an index on `(qualification_id)` alone for queries like "what experts have qualification 42?" (`WHERE qualification_id = 42`). The composite PK is *not* used for this query (the leading column is `expert_id`, not `qualification_id`).

**Rule:** For every M:N pivot, you need:
1. The composite PK on `(a_id, b_id)` — for "a's b's" lookups.
2. A secondary index on `(b_id)` — for "b's a's" lookups.

The secondary index is the one TypeORM does NOT create. You must add it in a migration.

### 6.5 Partial indexes — the cheap superpower

For the search feature (Lesson 30/40), queries like "active experts in category X with rating ≥ 4.5" benefit from a *partial* index:

```sql
CREATE INDEX ON experts (category_id, avg_rating) WHERE status = 'active';
```

Partial indexes are tiny (they only index the rows matching the `WHERE`), and Postgres can use them when your query's `WHERE` matches the partial predicate. They are almost always faster than a full index when you only ever query a subset.

**Rule:** any time you write `WHERE status = 'active'` in a hot query, add a partial index on the other columns of the same query.

**Concrete example for your schema:** The search endpoint will filter on `experts.status = 'active' AND category_id = X AND avg_rating >= 4.5`. A partial index:

```sql
CREATE INDEX idx_experts_active_category_rating
ON experts (category_id, avg_rating)
WHERE status = 'active';
```

This index is 10-100x smaller than a full index, and Postgres can use it for the search query. At 100k experts with 80% active, the partial index is 20% the size.

### 6.6 Expression indexes — for case-insensitive lookups

For columns where you do case-insensitive search (like `organizations.name`), a functional index:

```sql
CREATE INDEX idx_organizations_lower_name ON organizations (lower(name));
```

Your existing migration already does this. Good. Without it, `WHERE lower(name) = 'acme corp'` does a sequential scan because the default index is on `name`, not `lower(name)`.

**Rule:** any time you do `WHERE lower(col) = X` or `WHERE col ILIKE X` in a hot query, add an expression index.

### 6.7 Don't over-index

Indexes speed up reads but slow down writes (every INSERT/UPDATE/DELETE has to maintain the index). The "every FK gets an index" rule has a ceiling — for a write-heavy column you may skip it.

**Concrete example:** If you have a `user_last_seen_at` column that updates on every request, indexing it costs you a write on every request. The read benefit ("find users seen in the last hour") may not be worth it. Measure first; skip the index if the write cost dominates.

For your schema, with the read-heavy workloads in mind, default to indexing everything and revisit when you measure write contention.

### 6.8 Composite indexes — column order matters

For a composite index `(a, b, c)`, Postgres can use it for queries on:
- `(a, b, c)` — full match
- `(a, b)` — prefix
- `(a)` — leading column only

But NOT for:
- `(b, c)` — missing leading column
- `(b)` — missing leading column
- `(c)` — missing leading column

**Rule:** Put the most-selective column first (the one with the most distinct values). For `(user_id, created_at)`, `user_id` is more selective than `created_at` (assuming many users), so `user_id` goes first.

For your search query `WHERE user_id = X ORDER BY created_at DESC`, the composite index `(user_id, created_at)` is perfect: the `WHERE` uses the leading column, and the `ORDER BY` uses the trailing column, avoiding a separate sort.

---

## 7. Promoting a pivot to an entity

### 7.1 When to do it

The day product asks for *any* column on the pivot:

- `expert_qualifications.obtained_year`
- `expert_languages.level` ('native' | 'conversational')
- `expert_organizations.started_at`, `ended_at`
- `expert_prices.currency` (when you go multi-currency)

If you ignore the request and add a JSON column on the pivot, you've made the schema un-queryable. If you promote to an entity, you've added an indexable column.

### 7.2 The five concrete triggers for promotion

1. Product asks for *any* column on the pivot (`obtained_year`, `verified_at`, `score`, `level`).
2. Product asks for "the order" of the relationships (a real entity has an `id` you can `ORDER BY`).
3. Product asks for "soft-delete" on the relationship itself (a real entity has its own `deleted_at`).
4. You need to query "experts who got qualification X *after* 2010" (requires a queryable column).
5. You need to enforce "each expert has at most one row per qualification with a non-null `obtained_year`" (requires a partial unique index, which is hard on an implicit pivot).

If any of these are on the roadmap, promote early. The migration is cheap now; it's expensive after you have 100k rows.

### 7.3 The pattern

**Before** — implicit pivot via `@JoinTable`:

```ts
// expert.entity.ts
@ManyToMany(() => Qualification, (q) => q.experts)
@JoinTable({
  name: 'expert_qualifications',
  joinColumn: { name: 'expert_id', referencedColumnName: 'id' },
  inverseJoinColumn: { name: 'qualification_id', referencedColumnName: 'id' },
})
qualifications!: Qualification[];
```

**After** — explicit entity, two 1:Ns:

```ts
// expert-qualification.entity.ts (NEW)
@Entity('expert_qualifications')
@Index(['expert', 'qualification'], { unique: true })
export class ExpertQualification {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Expert, (e) => e.qualifications, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'expert_id' })
  expert!: Expert;

  @ManyToOne(() => Qualification, (q) => q.experts, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'qualification_id' })
  qualification!: Qualification;

  @Column({ type: 'int', nullable: true })
  obtainedYear!: number | null;
}
```

```ts
// expert.entity.ts (REPLACE @ManyToMany with @OneToMany)
@OneToMany(() => ExpertQualification, (eq) => eq.expert)
qualifications!: ExpertQualification[];
```

```ts
// qualification.entity.ts (REPLACE @ManyToMany with @OneToMany)
@OneToMany(() => ExpertQualification, (eq) => eq.qualification)
experts!: ExpertQualification[];
```

### 7.4 The migration recipe

You need a *forward* migration that:

1. Drops the old composite PK constraint (if any).
2. Adds the new `id` column as `bigserial PRIMARY KEY` (or `serial`).
3. Adds the new business column (`obtained_year`).
4. Drops the foreign keys on the old composite PK columns (or recreates them as plain FKs to the new entity).
5. Backfills the new column from any existing JSON (if you've been cheating).
6. Adds a unique constraint on `(expert_id, qualification_id)` to replace the old PK.

And a `down` migration that:

1. Drops the `id` column.
2. Drops the business column.
3. Drops the unique constraint.
4. Recreates the composite PK.

**This is a *non-trivial* migration.** Test it on a copy of prod data before running it. The order of operations matters; the wrong order loses data.

**Recipe for a non-trivial migration:**

```ts
import { MigrationInterface, QueryRunner } from 'typeorm';

export class PromoteExpertQualificationsToEntity1700000000001 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Add the new id column (nullable initially)
    await queryRunner.query(`
      ALTER TABLE expert_qualifications
      ADD COLUMN id BIGSERIAL
    `);

    // 2. Drop the old composite PK
    await queryRunner.query(`
      ALTER TABLE expert_qualifications
      DROP CONSTRAINT pk_expert_qualifications
    `);

    // 3. Add the new PK on id
    await queryRunner.query(`
      ALTER TABLE expert_qualifications
      ADD CONSTRAINT pk_expert_qualifications PRIMARY KEY (id)
    `);

    // 4. Add the unique constraint on (expert_id, qualification_id)
    await queryRunner.query(`
      ALTER TABLE expert_qualifications
      ADD CONSTRAINT uq_expert_qualifications UNIQUE (expert_id, qualification_id)
    `);

    // 5. Add the business column
    await queryRunner.query(`
      ALTER TABLE expert_qualifications
      ADD COLUMN obtained_year INT
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE expert_qualifications DROP COLUMN obtained_year`);
    await queryRunner.query(`ALTER TABLE expert_qualifications DROP CONSTRAINT uq_expert_qualifications`);
    await queryRunner.query(`ALTER TABLE expert_qualifications DROP CONSTRAINT pk_expert_qualifications`);
    await queryRunner.query(`ALTER TABLE expert_qualifications DROP COLUMN id`);
    await queryRunner.query(`
      ALTER TABLE expert_qualifications
      ADD CONSTRAINT pk_expert_qualifications PRIMARY KEY (expert_id, qualification_id)
    `);
  }
}
```

### 7.5 When *not* to promote

If the only thing on the pivot is `(a_id, b_id)` and that's all it will ever be, stay on `@JoinTable`. The cost of the implicit pivot is zero; the cost of an explicit entity is a join on every read. If you don't need the columns, don't pay for them.

**Decision rule:** Promote when you need *indexable, queryable* business data on the pivot. Don't promote for "we might need it someday". Premature promotion is its own cost (more code, more joins, more migrations).

---

## 8. Worked example — auditing one FK end-to-end

Take `experts.category_id`. Walk through the rubric:

**1. What is the cardinality?** Many-to-one (many experts per category). FK lives on `experts`.

**2. What is the nullable policy?** `nullable: false` — every expert must have a category.

**3. What is the `onDelete`?** **`RESTRICT`**. Deleting a category should never wipe experts. The admin tool should explicitly reassign first.

**4. Does it need an index?** Yes — search by category is a core query (`/search/experts?category_id=X`).

**5. Is there a unique constraint?** No — many experts per category, so a unique constraint would be wrong.

**6. The code:**

```ts
// expert.entity.ts
@Index()                                          // for fast "all experts in category" lookups
@ManyToOne(() => Category, (category) => category.experts, {
  onDelete: 'RESTRICT',
  nullable: false,
})
@JoinColumn({ name: 'category_id' })
category!: Category;
```

**7. The migration:**

```sql
-- Forward
ALTER TABLE experts
  ADD CONSTRAINT fk_experts_category
  FOREIGN KEY (category_id) REFERENCES categories(id)
  ON DELETE RESTRICT;                            -- explicit; never trust default

CREATE INDEX idx_experts_category ON experts (category_id);

-- Down
DROP INDEX IF EXISTS idx_experts_category;
ALTER TABLE experts DROP CONSTRAINT fk_experts_category;
```

**8. The smoke test:**

```ts
// in a test
const cat = await categoryRepo.findOne({ where: { id: catId } });
await expect(categoryRepo.delete(catId)).rejects.toThrow();  // RESTRICT refuses
```

That's the entire workflow. Apply it to every FK.

---

## 9. Decision summary

Before you commit any new FK, answer these five questions in a comment above the decorator:

```ts
@ManyToOne(() => Category, (c) => c.experts, {
  // 1. Cardinality: Many-to-One (each expert has one category; each category has many experts)
  // 2. Nullable: false (every expert must have a category)
  // 3. onDelete: RESTRICT (don't wipe experts by renaming categories)
  // 4. Index: yes (used by /search/experts?category_id=X)
  // 5. Unique: no (many experts per category)
  onDelete: 'RESTRICT',
  nullable: false,
})
@Index()  // for the search query
@JoinColumn({ name: 'category_id' })
category!: Category;
```

If you can't answer one, you don't understand the FK well enough to ship it.

---

## 10. The debugging recipes — when these decisions bite you at runtime

### 10.1 Symptom: `ForeignKeyConstraintViolationError` on parent delete

**Cause:** `onDelete: 'RESTRICT'` and children exist. This is correct behavior.

**Fix:** In your service layer, before deleting the parent:
1. Check for children (`count` query).
2. If children exist, either:
   a. Move them to a new parent.
   b. Soft-delete them.
   c. Hard-delete them (only if product confirms).
3. Then delete the parent.

**Never** catch the `ForeignKeyConstraintViolationError` and "fix" it by deleting children automatically. That's how production data disappears.

### 10.2 Symptom: Slow query, `EXPLAIN ANALYZE` shows `Seq Scan` on a FK

**Cause:** Missing index on the FK column.

**Fix:** Add the index in a migration:

```sql
CREATE INDEX CONCURRENTLY idx_experts_category ON experts (category_id);
```

Use `CONCURRENTLY` to avoid locking the table. Note: `CONCURRENTLY` can't run inside a transaction; your migration tool must support this.

**Detection:** Enable Postgres `log_min_duration_statement = 500` in your config. Queries slower than 500ms will be logged. Look for `Seq Scan` on a table with > 10k rows.

### 10.3 Symptom: Recursive query returns wrong results

**Cause:** Cycle in the tree. `A.parent = B`, `B.parent = A`. The recursive CTE enters an infinite loop or returns wrong rows.

**Fix:** Add the cycle-prevention trigger (§3.4). Run a script to find and break existing cycles:

```sql
WITH RECURSIVE category_tree AS (
  SELECT id, parent_id, ARRAY[id] AS path
  FROM categories
  WHERE parent_id IS NULL

  UNION ALL

  SELECT c.id, c.parent_id, ct.path || c.id
  FROM categories c
  JOIN category_tree ct ON c.parent_id = ct.id
  WHERE NOT (c.id = ANY(ct.path))  -- cycle detection
)
SELECT * FROM category_tree WHERE id = ANY(  -- find cycles
  SELECT unnest(path) FROM category_tree WHERE array_length(path, 1) > 100  -- heuristic
);
```

Or simpler: just add the trigger and let the next cycle attempt fail loudly.

### 10.4 Symptom: Duplicate rows in a pivot (e.g., expert has qualification 42 twice)

**Cause:** Missing composite PK on the pivot.

**Fix:** Deduplicate, then add the PK.

```sql
-- 1. Find duplicates
SELECT expert_id, qualification_id, COUNT(*)
FROM expert_qualifications
GROUP BY expert_id, qualification_id
HAVING COUNT(*) > 1;

-- 2. Keep the lowest id, delete the rest
DELETE FROM expert_qualifications eq1
USING expert_qualifications eq2
WHERE eq1.expert_id = eq2.expert_id
  AND eq1.qualification_id = eq2.qualification_id
  AND eq1.id > eq2.id;  -- assumes id column exists; if not, add one first

-- 3. Add the composite PK
ALTER TABLE expert_qualifications
  ADD CONSTRAINT pk_expert_qualifications
  PRIMARY KEY (expert_id, qualification_id);
```

**Prevention:** Always add the composite PK in a migration when you create a pivot. TypeORM's `@JoinTable` does not do this for you.

### 10.5 Symptom: `expert.qualifications` is `undefined` but the pivot has rows

**Cause:** Inverse side not declared on the other entity. For M:N, TypeORM needs `@ManyToMany` on **both** sides. The inverse side is not optional.

**Fix:** Add `@ManyToMany(() => Expert, (e) => e.qualifications)` on `Qualification`. No `@JoinTable` on the inverse side — just the `@ManyToMany` declaration.

### 10.6 Symptom: `ON DELETE CASCADE` fired and wiped 1,000 rows

**Cause:** The wrong `onDelete` choice. The CASCADE chain multiplied.

**Fix:**
1. Restore from backup (if you have one).
2. Investigate: why did this fire? Was it a bug in the admin tool? A raw SQL DELETE?
3. Change the `onDelete` to `RESTRICT` (if appropriate) in a migration.
4. Add the service-layer guard (count children before delete).
5. Add a test that simulates the scenario.

**Prevention:** Audit every CASCADE. List them. Ask: "if this fires, what's the blast radius?"

---

## 11. The audit checklist for your current schema

Run this checklist against every FK in your schema. The "current state" column reflects your code as of this writing.

| FK column                                  | Current `onDelete` | Recommended | Index? | Status |
|--------------------------------------------|--------------------|-------------|--------|--------|
| `experts.user_id`                          | `CASCADE`          | `CASCADE`   | No     | Add `@Index()` |
| `experts.category_id`                      | `RESTRICT`         | `RESTRICT`  | **No** | **Add `@Index()`** |
| `expert_qualifications.expert_id`          | (implicit)         | `CASCADE`   | Yes (composite PK) | Add composite PK in migration |
| `expert_qualifications.qualification_id`   | (implicit)         | `CASCADE`   | **No** | **Add secondary index** |
| `expert_languages.expert_id`               | (implicit)         | `CASCADE`   | Yes (composite PK) | Add composite PK |
| `expert_languages.language_id`             | (implicit)         | `CASCADE`   | **No** | **Add secondary index** |
| `expert_organizations.expert_id`           | (implicit)         | `CASCADE`   | Yes (composite PK) | Add composite PK |
| `expert_organizations.organization_id`     | (implicit)         | `CASCADE`   | **No** | **Add secondary index** |
| `expert_prices.expert_id`                  | (implicit)         | `CASCADE`   | Yes (composite PK) | Add composite PK |
| `expert_prices.price_id`                   | (implicit)         | `CASCADE`   | **No** | **Add secondary index** |
| `qualifications.category_id`               | `CASCADE`          | `CASCADE`   | No     | Add `@Index()` |
| `prices.category_id`                       | `CASCADE`          | `CASCADE`   | No     | Add `@Index()` |
| `categories.parent_id`                     | **`CASCADE`**      | `RESTRICT`  | No     | **BUG: change to RESTRICT, add cycle trigger** |
| `otp.user_id`                              | (implicit)         | `CASCADE`   | No     | **Refactor: change 1:1 to ManyToOne, add `(user_id, purpose)` index** |

**Bugs to fix in priority order:**

1. **`categories.parent_id` is `CASCADE` — change to `RESTRICT`.** Add the cycle-prevention trigger. This is the highest-priority bug; one DELETE wipes the entire subtree.
2. **Composite PKs missing on all four pivots.** Add them in a migration. Without them, duplicate rows are possible.
3. **Secondary indexes missing on the inverse-FK side of all four pivots.** Add them in a migration. Without them, "experts with qualification X" does a sequential scan.
4. **FK indexes missing on `experts.category_id`, `qualifications.category_id`, `prices.category_id`.** Add `@Index()` decorators and migrations.
5. **`otp` is 1:1 — broken for resend flow.** Refactor to ManyToOne with `(user_id, purpose, status)` index.

---

## 12. The migration safety patterns

### 12.1 Why you can't trust `synchronize: true`

`synchronize: true` is a TypeORM feature that auto-syncs your entities to the DB schema. It sounds convenient. In production, it's a data loss vector:

- It drops columns you removed from entities.
- It drops indexes you removed from decorators.
- It does not preserve data; it preserves *shape*.
- It runs at startup, so a bad deploy corrupts the schema before your health check fires.
- It does not generate migrations; it just applies changes silently.
- It often picks the default `NO ACTION` for FKs, which is rarely what you want.

**Rule:** `synchronize: false` in every environment except a throwaway dev DB. Always. Migrations are the only way to evolve a production schema safely.

### 12.2 The migration file anatomy

Every migration has `up` and `down`:

```ts
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddExpertCategoryIndex1700000000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    // Forward: add the index and the FK constraint
    await queryRunner.createIndex(
      'experts',
      new TableIndex({ name: 'idx_experts_category', columnNames: ['category_id'] }),
    );
    await queryRunner.query(`
      ALTER TABLE experts
      ADD CONSTRAINT fk_experts_category
      FOREIGN KEY (category_id) REFERENCES categories(id)
      ON DELETE RESTRICT
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse: drop the FK and the index
    await queryRunner.query(`ALTER TABLE experts DROP CONSTRAINT fk_experts_category`);
    await queryRunner.dropIndex('experts', 'idx_experts_category');
  }
}
```

**The down migration is not optional.** If you can't reverse the change, you have a non-reversible change, and you should think twice about doing it. Non-reversible changes (data deletion, type changes that lose precision) need extra review.

### 12.3 The `CONCURRENTLY` pattern for indexes

Adding an index on a large table locks the table for writes. Use `CONCURRENTLY`:

```sql
CREATE INDEX CONCURRENTLY idx_experts_category ON experts (category_id);
```

This takes longer (minutes vs. seconds) but doesn't lock writes. In a migration:

```ts
await queryRunner.query(`CREATE INDEX CONCURRENTLY idx_experts_category ON experts (category_id)`);
```

**Important:** `CONCURRENTLY` can't run inside a transaction. TypeORM's `queryRunner.transaction` wraps every query in a transaction. You need to use `queryRunner.query` directly (no transaction wrapper) for `CONCURRENTLY`.

### 12.4 The "add constraint NOT VALID" pattern

When you add a FK constraint to an existing table with rows, Postgres validates every existing row. On a 10M-row table, this takes minutes and locks writes. The fix: add the constraint as `NOT VALID`, then `VALIDATE CONSTRAINT` separately.

```sql
-- 1. Add the constraint without validating existing rows
ALTER TABLE experts
  ADD CONSTRAINT fk_experts_category
  FOREIGN KEY (category_id) REFERENCES categories(id)
  ON DELETE RESTRICT
  NOT VALID;  -- skip the full-table validation

-- 2. Validate in the background (takes a lock but only for the validation pass)
ALTER TABLE experts VALIDATE CONSTRAINT fk_experts_category;
```

The `NOT VALID` add takes a brief lock. The `VALIDATE CONSTRAINT` takes a weaker lock that allows concurrent writes. This is the production-safe way to add a FK to a large table.

### 12.5 The order of operations for adding a cardinality

When you add a new relationship, the migration order matters:

1. **Create the parent table** (if it doesn't exist).
2. **Create the child table** with the FK column (initially nullable, no constraint).
3. **Backfill the FK** for existing rows (if applicable).
4. **Add the FK constraint as `NOT VALID`** (so the add is fast).
5. **`VALIDATE CONSTRAINT`** (so the constraint is enforced for new rows).
6. **Add the index `CONCURRENTLY`** (so the index doesn't lock writes).
7. **Set `NOT NULL`** (if applicable, after backfill).

Doing it in the wrong order either fails (FK constraint on a column with NULLs) or locks the table (adding NOT NULL on a large table rewrites the whole table).

---

## 13. The observability hooks

### 13.1 Enable TypeORM query logging in dev

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

### 13.2 Postgres `log_min_duration_statement`

```sql
-- postgresql.conf
log_min_duration_statement = 500;  -- log queries slower than 500ms
```

This catches the missing-index patterns. Combined with `pg_stat_statements`, you get a full picture of what's slow.

### 13.3 The `EXPLAIN ANALYZE` habit

Before you ship any query, run `EXPLAIN ANALYZE` on it. Look for:

- `Seq Scan` on a table with > 10k rows (missing index).
- `Nested Loop` with a large outer table (N+1 pattern).
- `Sort` with a large in-memory sort (missing index for `ORDER BY`).
- `Hash Join` vs. `Merge Join` (Merge is usually faster for large sorted inputs).

If you see `Seq Scan` on a FK, add the index. If you see `Nested Loop` with a large outer, you're doing an N+1; rewrite with a JOIN.

### 13.4 The `pg_stat_user_tables` view

Postgres tracks table-level statistics:

```sql
SELECT relname, seq_scan, idx_scan, n_live_tup
FROM pg_stat_user_tables
WHERE schemaname = 'public'
ORDER BY seq_scan DESC;
```

Tables where `seq_scan >> idx_scan` are missing indexes. This is the production way to find the "why is this slow?" tables.

### 13.5 The `pg_stat_user_indexes` view

For indexes that exist but aren't used:

```sql
SELECT relname, indexrelname, idx_scan
FROM pg_stat_user_indexes
WHERE schemaname = 'public'
ORDER BY idx_scan ASC;
```

Indexes with `idx_scan = 0` are unused. Drop them; they're write overhead with no read benefit.

---

## 14. The testing strategy

### 14.1 Integration tests for relationships

The valuable tests are integration tests against a real (or test-container) Postgres. For each relationship:

1. **Create the parent and child.**
2. **Verify the FK is set correctly** (`child.parent_id === parent.id`).
3. **Verify the inverse side loads** (`parent.children.length === 1`).
4. **Verify the constraint enforces the cardinality:**
   - 1:1: Try to create a second child with the same parent → expect unique violation.
   - 1:N: Try to create a child without a parent (if `nullable: false`) → expect NOT NULL violation.
   - M:N: Try to create a duplicate pivot row → expect PK violation.
5. **Verify `onDelete` behavior:**
   - `CASCADE`: Delete parent → child is gone.
   - `RESTRICT`: Delete parent with children → expect FK violation.
6. **Verify the index exists** (query `pg_indexes`).

### 14.2 The smoke test for every entity

After you write an entity, before you merge the PR:

```ts
// in a test file
it('loads the inverse side correctly', async () => {
  const category = await categoryRepo.save({ name: 'Medical' });
  await expertRepo.save({ user, category, /* ... */ });

  const loaded = await categoryRepo.findOne({
    where: { id: category.id },
    relations: ['experts'],
  });

  expect(loaded.experts).toHaveLength(1);
});
```

If you skip this, the bug will ship. The bug is silent. The bug will be found by a customer.

### 14.3 The `onDelete` test

For every FK, test the cascade behavior:

```ts
describe('experts.category_id onDelete', () => {
  it('RESTRICT refuses to delete a category with experts', async () => {
    const cat = await categoryRepo.save({ name: 'Medical' });
    await expertRepo.save({ user, category: cat, /* ... */ });

    await expect(categoryRepo.delete(cat.id)).rejects.toThrow(  // QueryFailedError: violates foreign key constraint
      /foreign key constraint/,
    );
  });

  it('allows deletion after experts are moved', async () => {
    const cat1 = await categoryRepo.save({ name: 'Medical' });
    const cat2 = await categoryRepo.save({ name: 'Surgery' });
    const expert = await expertRepo.save({ user, category: cat1, /* ... */ });

    // Move the expert
    expert.category = cat2;
    await expertRepo.save(expert);

    // Now safe to delete
    await categoryRepo.delete(cat1.id);
  });
});
```

This test catches the "I changed `onDelete` to CASCADE by accident" bug.

### 14.4 The cycle test

For self-referencing trees, test the cycle prevention:

```ts
describe('categories parent cycle prevention', () => {
  it('refuses to create a cycle', async () => {
    const medical = await categoryRepo.save({ name: 'Medical' });
    const cardiology = await categoryRepo.save({ name: 'Cardiology', parent_id: medical.id });

    // Try to make Medical a child of Cardiology (creates a cycle)
    await expect(
      categoryRepo.update(medical.id, { parent_id: cardiology.id }),
    ).rejects.toThrow(/cycle/i);
  });
});
```

### 14.5 The migration test

For every migration, test:
1. **Up runs successfully** on a fresh DB.
2. **Down runs successfully** after up.
3. **Up is idempotent** (running twice doesn't fail).
4. **Data is preserved** (up doesn't drop columns you want to keep).

The last one is the most commonly missed. A migration that accidentally drops a column because it wasn't in the entity anymore is a data loss incident.

---

## 15. The security implications

### 15.1 The cascade-and-leak trap

`onDelete: CASCADE` on `experts.user_id` means deleting a user deletes the expert. But what about the expert's reviews? If `reviews.expert_id` is `RESTRICT`, you can't delete the user (because the reviews block it). If it's `CASCADE`, you delete the review history. Neither is right.

The right pattern: **soft-delete the user, don't hard-delete.** Add a `deleted_at` column to `User`. The cascade only fires on hard delete (which is now rare — GDPR requests, account closure after a waiting period).

### 15.2 The GDPR "right to be forgotten" workflow

GDPR Article 17 requires you to delete PII on request. With your schema:

1. User requests deletion.
2. You mark the user as `deleted` (soft-delete) and start a 30-day cooling-off period.
3. After 30 days, you hard-delete the user.
4. The cascade fires: `Profile` is deleted, `Expert` is deleted, all 1:N children are deleted.
5. The M:N pivots are deleted (because both FKs have `CASCADE`).
6. Reviews *written by* the user are deleted (CASCADE on `reviews.user_id`).
7. Reviews *about* the user's expert are preserved (`RESTRICT` on `reviews.expert_id`) but anonymized — the `reviewer_name` is set to "Deleted User".

This is a multi-step process. The cardinality decisions (CASCADE on user-owned, RESTRICT on expert-received) make it possible. The opposite decisions make it impossible or catastrophic.

### 15.3 The IDOR trap via RESTRICT

`onDelete: 'RESTRICT'` is a security control, not just a data integrity control. If your API endpoint `DELETE /experts/:id` doesn't check for blocking references, the user gets a confusing FK violation. The fix: check in the service layer first, return a clear 409 Conflict.

**The pattern:**

```ts
@Delete(':id')
async delete(@Param('id') id: number): Promise<void> {
  try {
    await this.expertService.delete(id);
  } catch (err) {
    if (err instanceof ForeignKeyConstraintViolationError) {
      throw new ConflictException(
        'Cannot delete expert: there are reviews referencing this expert. Soft-delete instead.',
      );
    }
    throw err;
  }
}
```

The RESTRICT is the safety net; the service layer is the UX. Both are needed.

---

## 16. Common mistakes (read this before you start coding)

1. **Picking `CASCADE` for everything "because it's simpler".** It is simpler for one day. It is catastrophic on the day someone runs a `DELETE` they didn't mean to.
2. **Skipping the index on a FK.** Postgres doesn't do it for you. Sequential scans on FK columns are the most common "why is the API slow?" bug.
3. **Picking `NO ACTION` because it's the default.** It's not what you want. Be deliberate.
4. **Forgetting `nullable: true` on a self-ref FK.** Top-level rows must be able to have no parent.
5. **Forgetting `unique: true` on a 0..1 FK.** Allows duplicate extensions; corrupts the model.
6. **Adding business columns to the implicit `@JoinTable` pivot.** Promote to entity.
7. **No cycle protection on the recursive tree.** Cycle rows break every "walk the tree" query.
8. **Forgetting the secondary index on the inverse-FK side of a pivot.** `expert_qualifications(expert_id)` is your "qualifications of an expert" lookup. The PK gives you `expert_id` for free. The other side (`qualification_id`) needs its own index for "experts with this qualification".
9. **Trusting TypeORM's `synchronize: true` to set up FKs the way you expect.** It often picks the default `NO ACTION`. Always write the migration explicitly.
10. **No migration `down`.** If you can't reverse the change, you have a non-reversible change, and you should think twice about doing it.
11. **Trusting the diagram's arrow head.** The arrow is decoration. The FK column is the truth.
12. **Catching `ForeignKeyConstraintViolationError` and "fixing" it by deleting children.** That's how production data disappears.
13. **Using `onDelete: 'CASCADE'` on a parent that has business meaning.** The blast radius is larger than you think.
14. **Forgetting the composite PK on a pivot.** Allows duplicate rows; corrupts counts.
15. **Forgetting the index on `experts.category_id`** (the current bug in your code).
16. **Using 1:1 for OTP (the current bug in your code).** Breaks the resend flow.
17. **Trusting `synchronize: true` in any non-dev environment.** It drops columns. It drops indexes. It doesn't preserve data. Use migrations.
18. **Not testing the `onDelete` behavior.** If you don't have a test that asserts the cascade, you don't know it works.
19. **Picking `CASCADE` on a parent because "the child is meaningless without it".** The question is not "is the child meaningless?" but "is the blast radius acceptable?". A category wipe of 1,200 experts is meaningless-to-meaningful in a single SQL statement.
20. **Not documenting the `onDelete` choice.** Six months from now, you change it and don't realize the consequences.

---

## 17. The business-stakeholder translation

When a non-technical stakeholder asks "why does this take so long?" or "why can't we just delete a category?", you need a translation.

**Q: "Why can't we just delete a category?"**
A: We deliberately configured the database to refuse category deletion if experts are attached. This prevents a single click from wiping 1,200 expert profiles. The admin tool walks you through reassigning the experts first. The extra minute is a feature.

**Q: "Why does the search endpoint return `undefined` for some fields?"**
A: TypeORM loads related data only when you ask for it. This is a performance feature — we don't load 10MB of related data on every search result. The fix is to add the field to the `relations` array in the search query. Five-minute change.

**Q: "Why did the migration fail?"**
A: The migration tried to add a foreign key constraint, but 47 existing rows have invalid values. The migration is protecting us from corrupting the database. The fix is to backfill the 47 rows first, then re-run the migration. One-hour change.

**Q: "Why do we need a separate `Profile` table?"**
A: Three reasons: (1) security — password hashes never leak in API responses; (2) GDPR — we can delete PII without deleting auth; (3) performance — login queries don't pull PII. The split is one of the most leveraged design decisions in the codebase.

**Q: "Why can't we just use `synchronize: true` in production?"**
A: It auto-syncs the schema from the code, but it doesn't preserve data. A deploy that removes a column from an entity will drop that column and all its data from production. The 30 minutes we save by not writing migrations is not worth the data loss risk.

**Q: "Why do we need to add an index on every FK?"**
A: Without the index, the database does a sequential scan (reads every row) for `WHERE category_id = X`. At 100k experts, that's seconds. With the index, it's milliseconds. The 30 seconds we spend adding the index saves us a customer-facing performance incident.

**Q: "Why do we need to add a composite primary key to the pivot tables?"**
A: Without it, the database allows duplicate `(expert, qualification)` rows. Your "experts with qualification X" query returns the same expert twice. Your counts are wrong. Your UI shows duplicates. The composite PK is a one-line constraint that prevents the entire class of bug.

**Q: "Why does the OTP resend not work?"**
A: The current `Otp` entity allows only one OTP per user. The resend flow requires multiple OTPs (with a purpose field, a cooldown, and an expiration). We're refactoring the entity to `ManyToOne` with a composite index on `(user_id, purpose)`. This is a one-day change but it's required for the resend feature.

---

## 18. The migration roadmap for your current schema

In priority order, here are the migrations you need to write to fix the bugs called out in §11:

**Migration 1: Fix `categories.parent_id` cascade and add cycle trigger**

```ts
export class FixCategoryParentCascade1700000000001 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Drop the old FK constraint
    await queryRunner.query(`
      ALTER TABLE categories DROP CONSTRAINT IF EXISTS fk_categories_parent
    `);

    // 2. Re-add with RESTRICT
    await queryRunner.query(`
      ALTER TABLE categories
      ADD CONSTRAINT fk_categories_parent
      FOREIGN KEY (parent_id) REFERENCES categories(id)
      ON DELETE RESTRICT
    `);

    // 3. Add the cycle prevention function
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION prevent_category_cycle()
      RETURNS trigger AS $$
      DECLARE
        pid INT;
      BEGIN
        pid := NEW.parent_id;
        WHILE pid IS NOT NULL LOOP
          IF pid = NEW.id THEN
            RAISE EXCEPTION 'Category cycle detected: % -> %', NEW.id, pid;
          END IF;
          SELECT parent_id INTO pid FROM categories WHERE id = pid;
        END LOOP;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

    // 4. Add the trigger
    await queryRunner.query(`
      CREATE TRIGGER trg_prevent_category_cycle
      BEFORE INSERT OR UPDATE OF parent_id ON categories
      FOR EACH ROW EXECUTE FUNCTION prevent_category_cycle()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_prevent_category_cycle ON categories`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS prevent_category_cycle()`);
    await queryRunner.query(`ALTER TABLE categories DROP CONSTRAINT fk_categories_parent`);
    await queryRunner.query(`
      ALTER TABLE categories
      ADD CONSTRAINT fk_categories_parent
      FOREIGN KEY (parent_id) REFERENCES categories(id)
      ON DELETE CASCADE
    `);
  }
}
```

**Migration 2: Add composite PKs and secondary indexes to all four pivots**

```ts
export class AddPivotPksAndIndexes1700000000002 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Composite PKs
    for (const pivot of ['expert_qualifications', 'expert_languages', 'expert_organizations', 'expert_prices']) {
      await queryRunner.query(`
        ALTER TABLE ${pivot}
        ADD CONSTRAINT pk_${pivot} PRIMARY KEY (expert_id, ${pivot.replace('expert_', '')}_id)
      `);
    }

    // Secondary indexes on the inverse-FK side
    await queryRunner.query(`CREATE INDEX idx_eq_qualification ON expert_qualifications (qualification_id)`);
    await queryRunner.query(`CREATE INDEX idx_el_language ON expert_languages (language_id)`);
    await queryRunner.query(`CREATE INDEX idx_eo_organization ON expert_organizations (organization_id)`);
    await queryRunner.query(`CREATE INDEX idx_ep_price ON expert_prices (price_id)`);

    // FK constraints (explicit CASCADE on both sides)
    // ... (add all 8 FKs)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // ... reverse
  }
}
```

**Migration 3: Add FK indexes on `experts.category_id`, `qualifications.category_id`, `prices.category_id`**

```ts
export class AddCategoryFkIndexes1700000000003 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE INDEX CONCURRENTLY idx_experts_category ON experts (category_id)`);
    await queryRunner.query(`CREATE INDEX CONCURRENTLY idx_qualifications_category ON qualifications (category_id)`);
    await queryRunner.query(`CREATE INDEX CONCURRENTLY idx_prices_category ON prices (category_id)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS idx_experts_category`);
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS idx_qualifications_category`);
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS idx_prices_category`);
  }
}
```

**Migration 4: Refactor `otp` to ManyToOne**

```ts
export class RefactorOtpToManyToOne1700000000004 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Drop the unique constraint on user_id (if it exists)
    await queryRunner.query(`ALTER TABLE otp DROP CONSTRAINT IF EXISTS uq_otp_user_id`);

    // 2. Add the new columns
    await queryRunner.query(`ALTER TABLE otp ADD COLUMN purpose TEXT NOT NULL DEFAULT 'verification'`);
    await queryRunner.query(`ALTER TABLE otp ADD COLUMN created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()`);
    await queryRunner.query(`ALTER TABLE otp ADD COLUMN consumed_at TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`ALTER TABLE otp ADD COLUMN attempts INT NOT NULL DEFAULT 0`);

    // 3. Drop the old FK (if it was 1:1)
    await queryRunner.query(`ALTER TABLE otp DROP CONSTRAINT IF EXISTS fk_otp_user`);

    // 4. Re-add as ManyToOne with CASCADE
    await queryRunner.query(`
      ALTER TABLE otp
      ADD CONSTRAINT fk_otp_user
      FOREIGN KEY (user_id) REFERENCES users(id)
      ON DELETE CASCADE
    `);

    // 5. Add the composite index
    await queryRunner.query(`
      CREATE INDEX idx_otp_user_purpose ON otp (user_id, purpose, consumed_at)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // ... reverse
  }
}
```

---

## 19. Self-check

Answer these in writing before moving to Lesson 04.

1. Why is `nullable: true` necessary on `categories.parent_id`? What goes wrong if you set it to `false`?
2. Why does `experts.user_id` need `unique: true` even though every expert *should* have a user?
3. For each of `experts.category_id`, `posts.user_id`, `reviews.expert_id`, state the correct `onDelete` and a one-sentence reason.
4. Why does Postgres *not* automatically index foreign-key columns? What is the most common symptom?
5. Write the migration for adding `idx_experts_category` on `experts(category_id)` including the FK with `ON DELETE RESTRICT`. Include the down.
6. When should you promote `@JoinTable` to an entity? Give three concrete examples from your schema.
7. Why is `ON DELETE CASCADE` on `categories.parent_id` dangerous? What should you use instead?
8. What is the cycle hazard in self-referencing trees, and what are two defenses?
9. For `expert_languages`, list the indexes you need. Why does each direction need its own index?
10. Why is `NO ACTION` rarely what you want, even though it's the Postgres default?
11. What is the current bug in your `categories.entity.ts` and why is it a customer-facing risk?
12. Why is the `Otp` entity broken for the resend flow? What is the refactor?
13. What is the "CASCADE is multiplicative" rule? Give a concrete example from your schema.
14. Why should you never catch `ForeignKeyConstraintViolationError` and delete the children?
15. What is `CREATE INDEX CONCURRENTLY` and why does it matter for large tables?
16. What is the `NOT VALID` + `VALIDATE CONSTRAINT` pattern and when do you use it?
17. Why do you need a secondary index on the inverse-FK side of a pivot?
18. What is the difference between soft-delete and hard-delete in terms of CASCADE?
19. Walk through the GDPR "right to be forgotten" workflow for your schema. Which cardinality decisions make it possible?
20. A stakeholder asks "why does the search take 2 seconds?". List three cardinality-related causes and how you'd diagnose each.

When you can answer all twenty in two sentences each, go to **Lesson 04**.
