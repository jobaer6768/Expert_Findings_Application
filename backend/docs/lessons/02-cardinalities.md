# Lesson 02 — Cardinalities: The Three Relationships in Your Schema

> **What you'll get:** a working vocabulary for the *only three relationships that exist* in your schema (one-to-one, one-to-many, many-to-many), the TypeORM decorator pair that implements each, the rule for deciding which side "owns" the foreign key, and — critically — the *production* consequences of each choice. By the end you should be able to look at any line in `er-2.drawio` and write its entity code without checking the docs, predict the failure modes, and explain to a non-technical stakeholder why each decision protects the business.
>
> **Why this lesson exists:** every Lesson 05+ assumes you know what an "owning side" is, why `@JoinColumn` only goes on one side, and what `@ManyToMany` actually does behind the scenes. If you skip it, you'll write code that "looks right" and returns `undefined` for related rows at runtime — the most common silent breakage in TypeORM. But more importantly: the wrong cardinality choice *is* a business decision. Getting `onDelete` wrong costs you data. Getting the wrong side of a 1:1 wrong leaks PII. Getting the implicit M:N wrong locks you out of features. This lesson is the foundation of every schema decision you'll make.
>
> **Prerequisites:** Lesson 00. You should have `er-2.drawio` open in another tab.

---

## 1. Goal

By the end of this lesson you can:

1. Look at any edge in `er-2.drawio` and state its cardinality in one word: `1:1`, `1:N`, or `M:N`.
2. Identify the **owning side** of any relationship from the diagram (the table whose row contains the FK column).
3. Write the `@OneToOne`, `@OneToMany` / `@ManyToOne`, and `@ManyToMany` decorator pair without consulting this file.
4. Explain why `@JoinColumn` is only ever declared on one side.
5. State, from memory, the three rules that prevent `@ManyToMany` silent breakage: composite PK on the pivot, `@JoinTable` on exactly one side, no business columns on the implicit pivot.
6. Predict the production failure mode of any cardinality mistake before you ship it.
7. Decide *when* to use an explicit pivot entity vs. an implicit `@JoinTable` pivot based on business requirements.
8. Read a Postgres `EXPLAIN ANALYZE` plan and identify which cardinality choice is causing a sequential scan.

---

## 2. Why this matters — the silent `undefined` and the louder customer-facing outage

Three quarters of the bugs in this codebase will be relationship bugs. They look like:

```ts
const category = await this.categoriesService.findOne(5);
console.log(category.qualifications); // ← what do you expect?
```

If you answered `[]` (because the category has qualifications), you're going to spend a confused hour learning that the inverse side of a relationship is **lazy by default** — it's `undefined` until you either declare it `eager: true`, pass `relations` in the find options, or use `leftJoinAndSelect`. The TypeORM compiler will not warn you. The runtime will not throw. Your code will silently fail.

This lesson is the antidote. Once you understand *what a relationship is in TypeORM* — a pair of decorators that **describe** a relationship, plus an opt-in mechanism that **loads** it — you'll never write that bug again.

But the bigger reason this lesson matters is **business risk**. Cardinality decisions are not reversible without a migration. Each wrong choice is a future incident:

| Cardinality mistake | Production consequence | Time to fix |
|---------------------|------------------------|-------------|
| `@OneToOne` without `unique: true` | Duplicate PII rows; user has two profiles; security audit fails | Hours (data cleanup + constraint add) |
| `@ManyToMany` on both sides | Migration creates duplicate pivot metadata; deploy blocked | Hours (debug + fix) |
| Implicit pivot + business column (`obtained_year` on `@JoinTable`) | Schema can't be queried; product feature shipped broken | Days (migrate pivot → entity) |
| `eager: true` on a hot relationship | N+1 query on every `find`; p99 latency spikes | Hours (refactor queries) |
| 1:1 declared as M:N (or vice versa) | Data model doesn't match product; refactor required | Weeks |
| FK without index | `WHERE user_id = X` does seq scan; DB CPU pegs at 100% | Minutes (add index) |
| `onDelete: CASCADE` on `experts.category_id` | One `DELETE` wipes 1,200 experts; data loss | Days (restore from backup + RCA) |

The cardinality decision is the cheapest decision in software engineering, and the most expensive to reverse. Get it right the first time.

---

## 3. The three relationships

There are exactly three. Every edge in `er-2.drawio` is one of them, plus two special-case variants we'll cover in Lesson 03.

| Type       | Also called            | Has FK column on   | Cardinality in your schema                                                  |
|------------|------------------------|---------------------|------------------------------------------------------------------------------|
| `1:1`      | One-to-One             | "Child" side        | `Users ↔ Profiles`, `Users ↔ Experts`                                         |
| `1:N`      | One-to-Many / Many-to-One | "Many" side       | `Users → Posts`, `Categories → Experts`, `Posts → Comments`, etc. (most of your schema) |
| `M:N`      | Many-to-Many           | A separate pivot table | `Experts ↔ Qualifications`, `Experts ↔ Languages`, `Experts ↔ Organizations`, `Experts ↔ Prices` |

That's it. Anything more complicated is a combination of these three.

The pattern that makes everything click: **the table that holds the FK column is the owning side of the relationship**. The other side is the *inverse* side, declared only so you can traverse from parent to child without writing a separate query.

This one rule disambiguates every relationship in the codebase. When you're staring at the diagram and don't know which decorator goes where, look at the FK column. The arrow head in drawio is decoration; the FK column is the source of truth.

---

## 4. One-to-One (1:1)

### 4.1 What it means

Each row in table A has **at most one** matching row in table B, and vice versa. In your schema:

- `Users ↔ Profiles`: each user has zero-or-one profile (you may add a profile later, after registration).
- `Users ↔ Experts`: each user has zero-or-one expert extension (most users are clients, not experts).

Both are **0..1 to 1** — they look like 1:1 in the diagram but allow the "0" on one side. The way to express "at most one" in SQL is `UNIQUE` on the FK column.

### 4.2 The rule

- Pick the side that **holds the FK** — it gets `@JoinColumn`.
- The other side is the **inverse** — it does *not* get `@JoinColumn`.
- The FK column **must** be `unique: true` (this is what enforces "at most one" at the DB level).
- The FK column can be `nullable: true` (for `0..1:1`) or `nullable: false` (for `1:1` — every user *must* have a profile).

### 4.3 The TypeORM pattern, applied to your code

For `Users ↔ Profiles`, where `profiles.user_id` is the FK:

```ts
// user.entity.ts
@OneToOne(() => Profile, (profile) => profile.user)
profile?: Profile;
```

```ts
// profile.entity.ts
@OneToOne(() => User, (user) => user.profile, { onDelete: 'CASCADE' })
@JoinColumn({ name: 'user_id', unique: true }) // ← unique: true is non-negotiable
user!: User;
```

Walk through what each decorator does:

- `@OneToOne(() => Profile, (profile) => profile.user)` on `User` declares that there's a relationship, names the *other* entity, and gives TypeORM the inverse-side property name. It does **not** create a column.
- `@OneToOne(() => User, (user) => user.profile, { onDelete: 'CASCADE' })` on `Profile` declares the same relationship from the other side.
- `@JoinColumn({ name: 'user_id', unique: true })` on `Profile` tells TypeORM "this side owns the FK; create a column called `user_id` and make it unique". This is the **only** place a column is created. The inverse side gets no `@JoinColumn`.

### 4.4 The production security angle — why `Users ↔ Profiles` is not a luxury

Splitting `Users` (auth identity) from `Profiles` (PII) is one of the most leveraged design decisions in the codebase. It looks like over-engineering the first day and pays for itself every day after.

**The concrete problems with putting all PII on `User`:**

1. **Password hashes leak in every API response.** Every `SELECT *` on `User` returns `passwordHash`, even in JSON responses that go to the frontend. `select: false` saves you on the password hash column, but it's a column-by-column escape hatch, not a structural defense. The day someone forgets `select: false` on a new column (or removes it by accident), your password hashes are in a JSON payload going to a browser. TypeORM's default is to select all columns. The default is your enemy.

2. **You can't soft-delete a profile without deleting auth.** If a user wants to "hide my profile" (a common product request), you can't. The user is the auth identity; if you delete the user, they can't log in. The 1:1 split lets you soft-delete the profile independently.

3. **You can't have "two profiles per user" later.** If you ever support "personal + business" profiles (common in B2B2C), you're stuck. You'd have to split the table anyway. Doing it now is one migration; doing it later is a production data migration with downtime.

4. **GDPR "right to be forgotten" is awkward.** GDPR Article 17 requires you to delete PII on request. If PII is on `User`, you have to either delete the user (and lose auth) or anonymize columns one by one. With the split, you `DELETE FROM profiles WHERE user_id = $1` and the user is still authenticatable (you can keep a tombstone row or soft-delete).

5. **Audit logs become ambiguous.** When you log `user.updated`, did the auth change or did the profile change? Separating them gives you clean audit trails: `user.updated` is auth-relevant, `profile.updated` is not.

6. **Performance — large PII rows (bio, avatar, preferences) slow down auth queries.** Every `SELECT * FROM users WHERE email = $1` on login pulls the PII. With the split, the login query is fast and small; the profile query is separate and only happens when you need it.

The 1:1 split is not "clean architecture theater". It's a security control, a performance control, and a compliance control. It belongs in your schema on day one.

### 4.5 The `Users ↔ Experts` case — the 0..1 extension

This is the special case where the "1" is on the Expert side and the "0" is on the User side. Most users are not experts. The experts that exist are a strict subset of users.

The pattern:

```ts
// user.entity.ts (the inverse side)
@OneToOne(() => Expert, (expert) => expert.user)
expert?: Expert;
```

```ts
// expert.entity.ts (the owning side)
@OneToOne(() => User, (user) => user.expert, { onDelete: 'CASCADE' })
@JoinColumn({ name: 'user_id', unique: true })
user!: User;
```

**Why `unique: true` is the entire defense.** The "0..1" semantics live in two places: the `unique` constraint on `experts.user_id`, and the absence of an `experts` row for non-expert users. The query "is this user an expert?" is:

```sql
SELECT * FROM experts WHERE user_id = $1;   -- returns 0 or 1 row
```

If you forget `unique: true`, the query can return two rows. Your UI shows "this user is two different experts". Your `findOne` returns the first row. Your users see ghost data. The unique constraint is a one-line constraint that prevents an entire class of silent data corruption.

### 4.6 Common 1:1 bugs

| Symptom                                                          | Cause                                                          | Fix                                                  |
|------------------------------------------------------------------|----------------------------------------------------------------|------------------------------------------------------|
| `duplicate key value violates unique constraint` on insert       | Two profiles for one user — `unique: true` missing             | Add `unique: true` to `@JoinColumn`                  |
| `user.profile` is `undefined` after `findOne`                    | Inverse side is lazy; you didn't `relations: ['profile']`     | Load explicitly (Lesson 04)                          |
| Deleting a user does **not** delete their profile                | Missing `onDelete: 'CASCADE'` on the owning side              | Add it on `Profile.user`                             |
| `user.profile` returns the same object even after mutation       | Inverse-side cache                                              | Use `relations` per call, not a cached property      |
| Password hash appears in API response                            | PII on `User` table; forgot `select: false` on a new column   | Split PII into `Profile`; use `select: false` as belt-and-suspenders |
| Can't soft-delete a profile without locking the user out         | PII on `User` table                                             | Split PII into `Profile`                             |
| `findOne` returns wrong row when duplicates exist                | Missing `unique: true`                                          | Add `unique: true`; clean up duplicates in migration  |

### 4.7 1:1 — the decision checklist

Before you declare a 1:1, answer these in a comment above the decorator:

```ts
@OneToOne(() => User, (user) => user.profile, {
  // 1. Owning side: Profile (holds user_id FK)
  // 2. Inverse side: User (no @JoinColumn)
  // 3. Nullable: false on profile.user_id (every profile belongs to a user)
  // 4. onDelete: CASCADE (GDPR; profile is meaningless without user)
  // 5. unique: true on user_id (enforces "at most one profile per user")
  // 6. Index: implicit via unique constraint (no separate @Index needed)
  onDelete: 'CASCADE',
})
@JoinColumn({ name: 'user_id', unique: true })
user!: User;
```

If you can't answer one, you don't understand the relationship well enough to ship it.

---

## 5. One-to-Many / Many-to-One (1:N)

### 5.1 What it means

One row in the "parent" table has many rows in the "child" table; each child belongs to exactly one parent. This is the **workhorse** of your schema — most edges in `er-2.drawio` are 1:N.

Examples in your schema:

- `Users 1—N Posts` (a user has many posts)
- `Users 1—N Channels`
- `Posts 1—N Comments` (a post has many comments)
- `Posts 1—N Reacts`
- `Experts 1—N Submissions`
- `Submissions 1—N Documents`
- `Categories 1—N Experts`
- `Categories 1—N Qualifications`
- `Categories 1—N Prices`

### 5.2 The rule

- The "many" side has the FK column. It declares `@ManyToOne` and `@JoinColumn`.
- The "one" side declares `@OneToMany`. **It does not get `@JoinColumn`.**
- Both decorators must reference each other by property name (`(parent) => parent.children`, `(child) => child.parent`). If you miss the property-name callback, you'll get `undefined` at runtime.
- The FK column should be **indexed** (Lesson 03 covers the rules in detail).

### 5.3 The TypeORM pattern, applied to your code

For `Categories 1—N Experts`, where `experts.category_id` is the FK:

```ts
// categories.entity.ts (the "one" side — already in your code)
@OneToMany(() => Expert, (expert) => expert.category)
experts!: Expert[];
```

```ts
// expert.entity.ts (the "many" side — owns the FK)
@ManyToOne(() => Category, (category) => category.experts, {
  onDelete: 'RESTRICT',  // see Lesson 03 for the full decision matrix
  nullable: false,        // every expert must have a category
})
@JoinColumn({ name: 'category_id' })
category!: Category;
```

### 5.4 The two-decorator rule — the most-violated rule in beginner TypeORM

This is the single most common silent bug in TypeORM code. **A 1:N relationship requires two decorators in two different files, and both must reference each other by property name.** If you declare only one, you get a silent runtime `undefined`.

```ts
// category.entity.ts
@OneToMany(() => Expert, (expert) => expert.category) // ← 'category' must match the property on Expert
experts!: Expert[];
```

```ts
// expert.entity.ts
@ManyToOne(() => Category, (category) => category.experts) // ← 'experts' must match the property on Category
@JoinColumn({ name: 'category_id' })
category!: Category;
```

If the property names drift (`category` vs `cat`, `experts` vs `expertList`), TypeORM will not warn you. The relationship will simply not load. Add a smoke test: load a category with `relations: ['experts']`, assert the array has the rows you expect. We'll wire that test in Lesson 04.

**Concrete failure scenario:** You write `@OneToMany(() => Expert, (expert) => expert.cat)` on `Category` (typo) and `@ManyToOne(() => Category, (category) => category.experts)` on `Expert` (correct). The query `findOne({ where: { id: 5 }, relations: ['experts'] })` returns a category with `experts: []`. You spend 30 minutes checking the DB. The DB is fine. The bug is the property name mismatch. TypeORM did not warn you.

### 5.5 What `@OneToMany` actually does

Almost nothing. `@OneToMany(() => Expert)` on `Category` does not create a column on `categories`. It does not enforce anything. It is a **declaration** that "if you ask, here is where the related rows are". The mechanism that *loads* those rows is in Lesson 04.

This is why the inverse side of a 1:N is optional in your DTOs. Mark it with `?`:

```ts
export class CategoryResponseDto {
  id!: number;
  name!: string;
  experts?: Expert[];   // ← undefined until you load it
}
```

The `!` vs `?` distinction is not a style choice. It's a type-system signal to every reader: "this field may be undefined, and that's normal". If you mark it `!`, you're lying to the type system, and the first NPE in production is on you.

### 5.6 The performance trap — N+1 queries

The most common performance bug in 1:N relationships is the N+1 query:

```ts
// BAD — N+1
const experts = await this.expertRepo.find();
for (const expert of experts) {
  console.log(expert.category.name); // ← triggers a separate SELECT for each expert
}
```

If you have 100 experts, this runs 101 queries (1 for the experts, 100 for the categories). At 5ms per query, that's 500ms. At 1000 experts, 5 seconds. The fix is `leftJoinAndSelect` (Lesson 04):

```ts
// GOOD — single query
const experts = await this.expertRepo
  .createQueryBuilder('expert')
  .leftJoinAndSelect('expert.category', 'category')
  .getMany();
```

This is one query with a JOIN. 5ms total. The lesson: **never access an inverse-side relationship in a loop without `leftJoinAndSelect`**. The runtime will not warn you. The p99 latency will tell you.

### 5.7 The onDelete decision — the most leveraged choice in the schema

For a 1:N, the `onDelete` on the `@ManyToOne` side is the most consequential decision in the schema. The four options:

| Option       | What Postgres does if parent is deleted                                       | When to use                                                                                  |
|--------------|--------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------|
| `CASCADE`    | Silently deletes all child rows                                                | Child is meaningless without parent (Posts of a deleted User, OTP of a deleted User)    |
| `RESTRICT`   | Refuses to delete the parent until children are removed (raises an error)     | Parent has business meaning that must survive children (don't delete Category while Experts exist) |
| `SET NULL`   | Child's FK becomes `NULL` (column must be nullable)                            | Child can exist orphaned (Comments when the User is gone, if you keep the comment for moderation) |
| `NO ACTION`  | Like `RESTRICT` but checked at commit time, not row time                       | Default; rarely what you want                                                                 |

**The rule of thumb:** Be liberal with CASCADE downward (child → grandchild) and conservative with CASCADE upward (parent → child). When in doubt, use RESTRICT and add an explicit "move children then delete" admin operation.

The full decision matrix for your schema is in Lesson 03. For 1:N in general:

- **`Users 1—N Posts`**: `CASCADE` (posts die with the user; GDPR).
- **`Categories 1—N Experts`**: `RESTRICT` (don't wipe experts by renaming/merging categories).
- **`Posts 1—N Comments`**: `CASCADE` (comments die with the post).
- **`Experts 1—N Submissions`**: `CASCADE` (submissions are part of the expert's lifecycle).

The wrong choice is catastrophic. The `experts.category_id` case in Lesson 03 is the canonical example: `CASCADE` here means one `DELETE FROM categories WHERE id = X` wipes 1,200 experts. That's a customer-facing outage. `RESTRICT` forces the admin tool to reassign first, which is the right UX.

### 5.8 Common 1:N bugs

| Symptom                                                       | Cause                                                          | Fix                                                  |
|---------------------------------------------------------------|----------------------------------------------------------------|------------------------------------------------------|
| `category.experts` is `undefined`                             | Inverse side is lazy by default                               | `relations: ['experts']` in find options              |
| `category.experts` is `[]` for a real parent                  | Property name in the callback mismatches                       | Make both decorators reference the same field name   |
| Loading 100 experts takes 100ms per expert for the category   | N+1 — you did `expert.category` in a loop                     | Use `leftJoinAndSelect` (Lesson 04)                  |
| `experts: undefined` in JSON response                         | DTO stripped it                                                | Keep inverse-side fields in the response DTO         |
| Deleting a parent wipes children unexpectedly                  | `onDelete: CASCADE` on a parent you didn't intend to cascade  | Change to `RESTRICT`; add explicit "move children" admin tool |
| Sequential scan on `WHERE user_id = X`                        | Missing index on FK                                            | Add `@Index()` or migration `CREATE INDEX`           |
| `ForeignKeyConstraintViolationError` on parent delete         | `onDelete: RESTRICT` and children exist                        | Expected behavior; handle in service layer (move/reassign children) |

---

## 6. Many-to-Many (M:N)

### 6.1 What it means

Each row in A can relate to many rows in B, and each row in B can relate to many rows in A. In SQL, there is no direct M:N — you introduce a **pivot table** with two FK columns.

In your schema:

- `Experts ↔ Qualifications` (an expert has many qualifications; a qualification belongs to many experts)
- `Experts ↔ Organizations`
- `Experts ↔ Languages`
- `Experts ↔ Prices`

These four pivots (`expert_qualifications`, `expert_organizations`, `expert_languages`, `expert_prices`) are how `er-2.drawio` encodes "an expert speaks Bangla *and* English *and* Hindi".

### 6.2 Why a pivot table, not a JSON column?

A reasonable question: why not store `expert.languages = ['en', 'bn']` as a `text[]` column?

Two reasons:

1. **You can't index inside a JSON/array column cheaply.** "Find all experts who speak Bangla and English" becomes a sequential scan with `WHERE 'bn' = ANY(languages) AND 'en' = ANY(languages)`. On 100k experts, that's seconds. With a pivot table and two indexed FK columns, it's a few milliseconds. At 1M experts, the difference is minutes vs. milliseconds.

2. **You can't add columns to a JSON/array.** The day you want `expert_languages(level: 'native' | 'conversational')` or `obtained_year` on qualifications, you're migrating again. The pivot is already shaped right.

3. **You can't query "experts who have qualification X but not Y" cleanly.** With a pivot, it's a `JOIN` with a `NOT EXISTS`. With a JSON array, it's `WHERE NOT ('y' = ANY(qualifications))` — which works but is harder to read and slower to plan.

4. **You can't enforce referential integrity.** With a `text[]`, you can store `'ban'` (typo) and Postgres doesn't know it's wrong. With a pivot, the FK constraint refuses invalid language IDs at the DB level.

There is one tradeoff: more joins in read queries. We pay that with the index design in Lesson 03 and the `leftJoinAndSelect` pattern in Lesson 04.

### 6.3 The rule

- Declare `@ManyToMany` on **both** entities (the inverse side is *not* optional for M:N — TypeORM needs it to resolve the pivot).
- Declare `@JoinTable` on **exactly one** side — the side whose FK is named first in the pivot (`joinColumn`). The other side is silent.
- The pivot table needs a **composite primary key** `(a_id, b_id)` — add it in a migration; TypeORM's `@JoinTable` does not add it.
- The pivot table needs **`ON DELETE CASCADE`** on both FK columns — TypeORM cannot infer this; you must write it.
- **Never put business columns on the implicit pivot** (timestamps, `is_verified`, etc.). The moment you need a column, **promote the pivot to a real entity** (two 1:Ns instead of one M:N). Lesson 03 has the recipe.

### 6.4 The TypeORM pattern, applied to your code

For `Experts ↔ Qualifications`, where the pivot is `expert_qualifications`:

```ts
// expert.entity.ts
@ManyToMany(() => Qualification, (q) => q.experts, { cascade: true })
@JoinTable({
  name: 'expert_qualifications',                  // match the table name in er-2.drawio exactly
  joinColumn: { name: 'expert_id', referencedColumnName: 'id' },
  inverseJoinColumn: { name: 'qualification_id', referencedColumnName: 'id' },
})
qualifications!: Qualification[];
```

```ts
// qualification.entity.ts
@ManyToMany(() => Expert, (e) => e.qualifications)   // ← no @JoinTable here!
experts!: Expert[];
```

And in a migration (TypeORM will not do this for you):

```sql
ALTER TABLE expert_qualifications
  ADD CONSTRAINT pk_expert_qualifications
  PRIMARY KEY (expert_id, qualification_id);

ALTER TABLE expert_qualifications
  ADD CONSTRAINT fk_eq_expert
  FOREIGN KEY (expert_id) REFERENCES experts(id)
  ON DELETE CASCADE;

ALTER TABLE expert_qualifications
  ADD CONSTRAINT fk_eq_qualification
  FOREIGN KEY (qualification_id) REFERENCES qualifications(id)
  ON DELETE CASCADE;

CREATE INDEX idx_eq_qualification ON expert_qualifications (qualification_id);
```

### 6.5 Why `@JoinTable` goes on exactly one side

If you put `@JoinTable` on both `Expert.qualifications` and `Qualification.experts`, TypeORM will silently create duplicate pivot metadata, and you'll see either an extra migration with strange column names or a runtime error so confusing you'll think your connection string is broken. Pick one side (the natural "first" entity — usually the one whose FK appears first in the pivot name) and never decorate the other.

**Concrete failure scenario:** You put `@JoinTable` on both sides. TypeORM generates two migrations — one creates `expert_qualifications(expert_id, qualification_id)`, the other tries to create `expert_qualifications(expert_id, qualification_id)` again with a different name. The second migration fails at runtime with a "relation already exists" error. You spend an hour debugging. The fix is one decorator removed.

### 6.6 Why the composite PK matters

Without `(expert_id, qualification_id)` as the primary key, you can insert duplicate `(1, 42)` rows. The DB will store them; nothing complains. Now your "is this expert qualified?" query returns two rows for the same answer; your count is wrong; your UI shows a duplicate. The composite PK is a one-line constraint that prevents an entire class of silent data corruption.

**Concrete failure scenario:** Without the composite PK, a buggy script inserts `(expert_id=1, qualification_id=42)` twice. Your search query for "experts with qualification 42" returns expert 1 twice. Your UI shows the same expert in the results grid. Your user reports a bug. You spend two hours finding the duplicate. The composite PK would have refused the second insert at the DB level.

### 6.7 The promotion path — when the implicit pivot isn't enough

When business data creeps in — "we need `obtained_year` on `expert_qualifications`" — stop using `@JoinTable`. Promote the pivot to a real entity:

```ts
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

Now `Expert.qualifications` becomes `@OneToMany(() => ExpertQualification, eq => eq.expert)` and you do the same on `Qualification`. Two 1:Ns replace one M:N. Yes, more code. Yes, you'll need it.

**The concrete trigger conditions for promotion:**

1. Product asks for *any* column on the pivot (`obtained_year`, `verified_at`, `score`, `level`).
2. Product asks for "the order" of the relationships (a real entity has an `id` you can `ORDER BY`).
3. Product asks for "soft-delete" on the relationship itself (a real entity has its own `deleted_at`).
4. You need to query "experts who got qualification X *after* 2010" (requires a queryable column).
5. You need to enforce "each expert has at most one row per qualification with a non-null `obtained_year`" (requires a partial unique index, which is hard on an implicit pivot).

If any of these are on the roadmap, promote early. The migration is cheap now; it's expensive after you have 100k rows.

### 6.8 The cascade decision — why both sides CASCADE

For an M:N pivot, both FK columns should have `ON DELETE CASCADE`. The pivot row is meaningless without either parent:

- Delete an expert → the `(expert_id, qualification_id)` row is meaningless.
- Delete a qualification → the `(expert_id, qualification_id)` row is meaningless.

If you use `RESTRICT` on either side, you can't delete a parent without first manually cleaning the pivot. That's a footgun. CASCADE is the right default for pivot rows.

### 6.9 Common M:N bugs

| Symptom                                                          | Cause                                                          | Fix                                                  |
|------------------------------------------------------------------|----------------------------------------------------------------|------------------------------------------------------|
| Pivot table has duplicate `(expert, qualification)` rows         | Missing composite PK                                           | Add `(expert_id, qualification_id)` PK in migration   |
| `expert.qualifications` is `undefined`                           | Inverse side not declared on the other entity                  | Add `@ManyToMany(() => Expert, ...)` on Qualification |
| Migration creates pivot with wrong column names                  | `@JoinTable` declared on both sides                            | Strip from one side                                  |
| Can't add `obtained_year` later                                  | Implicit pivot doesn't allow columns                          | Promote to entity (recipe above)                     |
| Deleting an expert leaves dangling pivot rows                    | Missing `ON DELETE CASCADE` on the FK                          | Add it in a migration                                |
| Query for "experts with qualification X" does seq scan           | Missing index on `qualification_id` side of pivot              | Add `CREATE INDEX idx_eq_qualification ON expert_qualifications(qualification_id)` |
| `expert.qualifications.length` is wrong (off by one)             | Stale relation cache; you mutated the array directly           | Use `repository.save()` with the relation; let TypeORM manage the pivot |
| `findOne` returns expert with `qualifications: undefined`        | Inverse side is lazy; you didn't pass `relations`              | `relations: ['qualifications']` or `leftJoinAndSelect` |

---

## 7. The owning-side table

This is the one mental shortcut that disambiguates every relationship. For every edge in the diagram, ask: **which table has the FK column?** That table is the owning side. The other table is the inverse.

| Edge                              | FK column lives on | Owning side | Inverse side |
|-----------------------------------|--------------------|-------------|--------------|
| `Users 1—1 Profiles`              | `profiles`         | `Profile`   | `User`       |
| `Users 1—1 Experts`               | `experts`          | `Expert`    | `User`       |
| `Users 1—N Posts`                 | `posts`            | `Post`      | `User`       |
| `Categories 1—N Experts`          | `experts`          | `Expert`    | `Category`   |
| `Experts M—N Qualifications`      | `expert_qualifications` (pivot) | `Expert` (declares `@JoinTable`) | `Qualification` |

Memorize this rule. When you're staring at the diagram and don't know which decorator goes where, look at the FK column. The arrow head in drawio is decoration; the FK column is the source of truth.

**The inverse-side tradeoff:** Declaring the inverse side is not free. It adds a property to the entity that you must remember to load explicitly. Some teams skip the inverse side entirely (no `@OneToMany` on `User` for `experts`) and only ever query from the owning side. That's a valid choice for a small project. For a production project, the inverse side is worth the cost: it makes your service code read naturally (`user.experts` instead of `expertRepo.find({ where: { user: { id: userId } } })`).

---

## 8. Decision points

### 8.1 When to make a FK `nullable`

- **`nullable: false`** — every child MUST have a parent. `Experts.category_id`, `Posts.user_id`. If you try to insert an expert without a category, the DB refuses.
- **`nullable: true`** — the child can exist without a parent. `Categories.parent_id` (top-level categories have no parent), `Experts.user_id` (a future admin-created expert might not be a user yet).

Decide **upfront** for every FK. The default (`nullable: true`) is rarely what you want.

**The migration cost of getting this wrong:** If you ship `nullable: true` and later realize it should be `nullable: false`, you have to:
1. Backfill all NULL values (decide what parent to assign).
2. Add a `CHECK (fk IS NOT NULL)` constraint (Postgres doesn't have a direct `SET NOT NULL` if NULLs exist).
3. Drop the check constraint and add `NOT NULL` after backfill.

This is a 30-minute migration on a small table; a 4-hour migration on a 10M-row table. Get it right the first time.

### 8.2 When to put `@JoinColumn` on a 1:N

**Always on the `@ManyToOne` side. Never on the `@OneToMany` side.** This is not a choice; it's how TypeORM works. The "many" side owns the FK column; the FK column is declared by `@JoinColumn` on the side that owns it.

### 8.3 When to put `@JoinTable` on M:N

**Exactly one side.** Pick the entity whose FK is the first column in the pivot table. For `expert_qualifications(expert_id, qualification_id)`, that is `Expert`. For a pivot named `user_channels(user_id, channel_id)`, that is `User`. Document the choice in a one-line comment above the decorator — six months from now you'll forget.

### 8.4 When to promote a pivot to an entity

The moment you want to store anything other than `(a_id, b_id)` on the row. The candidates:

- `obtained_year`, `verified_at`, `score` on qualifications
- `level` ('native' | 'conversational') on languages
- `started_at`, `ended_at` on organizations
- `currency` on prices (multi-currency support)

Don't wait. Promote early; the migration is cheap.

### 8.5 When to use `eager: true`

**Almost never.** `eager: true` loads the relation on every `find()` of the entity. This sounds convenient. In practice:

- It hides the N+1 query from you. The query is there; you just don't see it.
- It makes every query slower, even queries that don't need the relation.
- It makes the query plan unpredictable (depends on how deep the eager chain goes).

Use `relations: ['name']` in the find options or `leftJoinAndSelect` in the query builder. The explicitness is worth the typing.

The one exception: audit logs or audit tables where you genuinely always need the related entity. For your schema, there is no such case.

### 8.6 When to use `cascade: true` (TypeORM) vs `onDelete: 'CASCADE'` (Postgres)

They serve different purposes and are often confused:

- **`cascade: true` (TypeORM)**: When you `save()` a parent, automatically `save()` the children too. This is for *write-side convenience*. Example: `expertRepo.save(expert)` with `cascade: true` on `qualifications` will also save new qualifications.
- **`onDelete: 'CASCADE'` (Postgres)**: When the parent row is deleted at the DB level, automatically delete the children. This is for *referential integrity*. Example: `DELETE FROM experts WHERE id = 5` will also delete the child's rows in the pivot.

You often want exactly one; rarely both. The common mistake is using `cascade: true` and assuming it covers deletion. It doesn't. The DB-level `onDelete` is the only thing that protects you from `DELETE FROM` statements that bypass TypeORM (raw SQL, admin tools, cascading deletes from other tables).

**Rule:** Always set `onDelete` explicitly. Use `cascade: true` only when you genuinely want the write-side convenience and you've thought about the delete-side implication.

---

## 9. The cardinality cheat-sheet

Print this. Tape it to your monitor. Every time you add an entity, you walk through this:

| drawio edge                                  | TypeORM pair                                  | FK column                  |
|----------------------------------------------|-----------------------------------------------|----------------------------|
| `A 1—1 B` (A holds FK)                       | `@OneToOne` + `@OneToOne` + `@JoinColumn`     | on `B`                     |
| `A 1—N B`                                    | `@OneToMany` on `A` + `@ManyToOne`+`@JoinColumn` on `B` | on `B`             |
| `A M—N B`                                    | `@ManyToMany` + `@JoinTable` on **one** side, `@ManyToMany` on the other | new pivot table    |

That's the entire vocabulary. Three rows. Everything else is a variant or an exception.

---

## 10. Worked example — trace one edge end-to-end

Take `Experts ↔ Qualifications` from `er-2.drawio`.

**Step 1.** Look at the diagram. The edge label says "M—N". The pivot table is named `expert_qualifications`.

**Step 2.** Look at the pivot's columns: `expert_id`, `qualification_id`. Two FKs.

**Step 3.** Decide the owning side. The first column is `expert_id`, so `Expert` declares `@JoinTable`. `Qualification` declares only `@ManyToMany`.

**Step 4.** Write the code:

```ts
// expert.entity.ts
@ManyToMany(() => Qualification, (q) => q.experts, { cascade: true })
@JoinTable({
  name: 'expert_qualifications',
  joinColumn: { name: 'expert_id', referencedColumnName: 'id' },
  inverseJoinColumn: { name: 'qualification_id', referencedColumnName: 'id' },
})
qualifications!: Qualification[];
```

```ts
// qualification.entity.ts
@ManyToMany(() => Expert, (e) => e.qualifications)
experts!: Expert[];
```

**Step 5.** Write the migration: composite PK, FKs with `ON DELETE CASCADE`, the secondary index.

**Step 6.** Test: create a category, a qualification, an expert. Call `expert.qualifications` after `findOne({ where: { id }, relations: ['qualifications'] })`. Verify the array has the qualification.

**Step 7.** `EXPLAIN ANALYZE` the equivalent raw query. Confirm an index scan, not a sequential scan.

That's the entire workflow for any edge in the diagram.

---

## 11. The debugging recipes — when cardinality bites you at runtime

### 11.1 Symptom: `relation.relatedItems` is `undefined`

**Cause:** Inverse side is lazy by default. You didn't `relations: ['relatedItems']`.

**Fix:** Add `relations: ['relatedItems']` to the find options, or use `leftJoinAndSelect` in a query builder.

**Prevention:** In your service layer, never return an entity from a repository call without explicitly loading the relations the caller needs. A common pattern:

```ts
async findOneWithRelations(id: number): Promise<Category> {
  return this.categoryRepo.findOne({
    where: { id },
    relations: ['experts', 'qualifications', 'prices'],
  });
}
```

If you have multiple "shapes" of a category (one for the list view, one for the detail view, one for the admin view), make them explicit methods. Don't rely on `eager: true`.

### 11.2 Symptom: N+1 queries in production logs

**Cause:** You accessed an inverse-side relation inside a loop.

**Fix:** Replace the loop with a single `leftJoinAndSelect` query, or use `In()` to batch the parent IDs.

**Detection:** Postgres `log_min_duration_statement = 500` in your config will show you the slow queries. The N+1 pattern shows up as 100 identical queries with different `WHERE` values. TypeORM's `logging: true` in dev shows the queries inline.

### 11.3 Symptom: `ForeignKeyConstraintViolationError` on parent delete

**Cause:** `onDelete: 'RESTRICT'` and children exist. This is correct behavior.

**Fix:** In your service layer, before deleting the parent:
1. Check for children (`count` query).
2. If children exist, either:
   a. Move them to a new parent (`UPDATE children SET parent_id = $newParent WHERE parent_id = $oldParent`).
   b. Soft-delete them (set a `deleted_at` column).
   c. Hard-delete them (only if product confirms).
3. Then delete the parent.

Never catch the `ForeignKeyConstraintViolationError` and "fix it" by deleting the children automatically. That's how production data disappears.

### 11.4 Symptom: Duplicate rows in a 1:1 (two profiles per user)

**Cause:** Missing `unique: true` on the FK column.

**Fix:** Add the unique constraint in a migration. But first, deduplicate the data:

```sql
-- 1. Find duplicates
SELECT user_id, COUNT(*)
FROM profiles
GROUP BY user_id
HAVING COUNT(*) > 1;

-- 2. Decide which row to keep (usually the most recent)
DELETE FROM profiles p1
USING profiles p2
WHERE p1.user_id = p2.user_id
  AND p1.id < p2.id;  -- keep the highest id

-- 3. Add the unique constraint
ALTER TABLE profiles
  ADD CONSTRAINT uq_profiles_user_id UNIQUE (user_id);
```

**Prevention:** Always set `unique: true` on 1:1 FKs. Always.

### 11.5 Symptom: Pivot has duplicate `(a_id, b_id)` rows

**Cause:** Missing composite PK on the pivot.

**Fix:** Same as 11.4 — deduplicate, then add the PK.

**Prevention:** Always add the composite PK in a migration when you create a pivot. TypeORM's `@JoinTable` does not do this for you.

### 11.6 Symptom: Slow query, `EXPLAIN ANALYZE` shows `Seq Scan` on a FK

**Cause:** Missing index on the FK column.

**Fix:** Add the index in a migration:

```sql
CREATE INDEX CONCURRENTLY idx_experts_user_id ON experts (user_id);
```

Use `CONCURRENTLY` to avoid locking the table. Note: `CONCURRENTLY` can't run inside a transaction; your migration tool must support this.

**Prevention:** Every FK gets an index. Add it when you create the column, not when the query is slow in production.

---

## 12. The migration safety patterns

### 12.1 Why you can't trust `synchronize: true`

`synchronize: true` is a TypeORM feature that auto-syncs your entities to the DB schema. It sounds convenient. In production, it's a data loss vector:

- It drops columns you removed from entities.
- It drops indexes you removed from decorators.
- It does not preserve data; it preserves *shape*.
- It runs at startup, so a bad deploy corrupts the schema before your health check fires.
- It does not generate migrations; it just applies changes silently.

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

### 12.3 The order of operations for adding a cardinality

When you add a new relationship, the migration order matters:

1. **Create the parent table** (if it doesn't exist).
2. **Create the child table** with the FK column (initially nullable, no constraint).
3. **Backfill the FK** for existing rows (if applicable).
4. **Add the FK constraint** (now that all rows have valid values).
5. **Add the index** (after the constraint, so the index is valid).
6. **Set `NOT NULL`** (if applicable, after backfill).

Doing it in the wrong order either fails (FK constraint on a column with NULLs) or locks the table (adding NOT NULL on a large table rewrites the whole table).

### 12.4 The `CONCURRENTLY` pattern for indexes

Adding an index on a large table locks the table for writes. Use `CONCURRENTLY`:

```sql
CREATE INDEX CONCURRENTLY idx_experts_category ON experts (category_id);
```

This takes longer (minutes vs. seconds) but doesn't lock writes. In a migration:

```ts
await queryRunner.query(`CREATE INDEX CONCURRENTLY idx_experts_category ON experts (category_id)`);
```

Note: `CONCURRENTLY` can't run inside a transaction. TypeORM's `queryRunner.transaction` wraps every query in a transaction. You need to use `queryRunner.query` directly (no transaction wrapper) for `CONCURRENTLY`.

---

## 13. The observability hooks

Cardinality decisions affect query performance. You need to see the queries.

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

This catches the N+1 patterns and the missing-index patterns. Combined with `pg_stat_statements`, you get a full picture of what's slow.

### 13.3 The `EXPLAIN ANALYZE` habit

Before you ship any query, run `EXPLAIN ANALYZE` on it. Look for:

- `Seq Scan` on a table with > 10k rows (missing index).
- `Nested Loop` with a large outer table (N+1 pattern).
- `Sort` with a large in-memory sort (missing index for `ORDER BY`).
- `Hash Join` vs. `Merge Join` (Merge is usually faster for large sorted inputs).

If you see `Seq Scan` on a FK, add the index. If you see `Nested Loop` with a large outer, you're doing an N+1; rewrite with a JOIN.

### 13.4 The application-level metrics

Track in your application:

- Query count per request (should be < 10 for most endpoints; > 50 means N+1).
- Query duration p50, p95, p99 per endpoint.
- Cache hit rate (if you add caching).

These metrics catch cardinality bugs that don't show up in unit tests. A test that loads one expert won't catch an N+1 that loads 1,000 experts.

---

## 14. The testing strategy

### 14.1 Unit tests for entities

Entities are classes; you can test their decorators and metadata. But this is mostly testing TypeORM. Skip it unless you have a custom decorator.

### 14.2 Integration tests for relationships

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

### 14.3 The smoke test for every entity

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

### 14.4 The migration test

For every migration, test:
1. **Up runs successfully** on a fresh DB.
2. **Down runs successfully** after up.
3. **Up is idempotent** (running twice doesn't fail).
4. **Data is preserved** (up doesn't drop columns you want to keep).

The last one is the most commonly missed. A migration that accidentally drops a column because it wasn't in the entity anymore is a data loss incident.

---

## 15. The security implications

### 15.1 The PII boundary

Every relationship that crosses the PII boundary (auth identity ↔ PII) is a security control. In your schema:

- `Users ↔ Profiles`: the boundary. `Profile` holds PII; `User` holds auth.
- `Users ↔ Experts`: the boundary. `Expert` holds professional info; `User` holds auth.

Rules:
- The PII side (`Profile`, `Expert`) is loaded only when needed. Don't `relations: ['profile', 'expert']` on the `User` query in your auth middleware.
- The PII side uses `select: false` on sensitive columns (SSN, phone, address) as belt-and-suspenders.
- The PII side's API responses are DTOs that explicitly list fields, not `classToPlain(entity)`.

### 15.2 The IDOR (Insecure Direct Object Reference) trap

Cardinality decisions affect IDOR. If your endpoint is `GET /experts/:id/reviews`, the cardinality is `Experts 1—N Reviews`. The `:id` is the expert ID. The naive implementation:

```ts
// BAD — IDOR vulnerable
@Get(':id/reviews')
async getReviews(@Param('id') id: number) {
  return this.reviewRepo.find({ where: { expert_id: id } });
}
```

If the expert is soft-deleted or banned, this still returns their reviews. The fix: join on the expert and check status:

```ts
// GOOD — status-aware
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

### 15.3 The cascade-and-leak trap

`onDelete: CASCADE` on `experts.user_id` means deleting a user deletes the expert. But what about the expert's reviews? If `reviews.expert_id` is `RESTRICT`, you can't delete the user (because the reviews block it). If it's `CASCADE`, you delete the review history. Neither is right.

The right pattern: **soft-delete the user, don't hard-delete.** Add a `deleted_at` column to `User`. The cascade only fires on hard delete (which is now rare — GDPR requests, account closure after a waiting period).

### 15.4 The GDPR "right to be forgotten" workflow

GDPR Article 17 requires you to delete PII on request. With your schema:

1. User requests deletion.
2. You mark the user as `deleted` (soft-delete) and start a 30-day cooling-off period (in case they change their mind).
3. After 30 days, you hard-delete the user.
4. The cascade fires: `Profile` is deleted, `Expert` is deleted, all 1:N children are deleted.
5. The M:N pivots are deleted (because both FKs have `CASCADE`).
6. Reviews *written by* the user are deleted (CASCADE on `reviews.user_id`).
7. Reviews *about* the user's expert are preserved (`RESTRICT` on `reviews.expert_id`) but anonymized — the `reviewer_name` is set to "Deleted User".

This is a multi-step process. The cardinality decisions (CASCADE on user-owned, RESTRICT on expert-received) make it possible. The opposite decisions make it impossible or catastrophic.

---

## 16. The soft-delete pattern

### 16.1 Why soft-delete is often the right choice

Hard delete is destructive. Soft delete (`deleted_at` column) preserves data for audit, recovery, and compliance. For your schema:

- `Users`: soft-delete. Hard delete only after GDPR cooling-off period.
- `Experts`: soft-delete. Preserve review history.
- `Categories`: hard delete is OK (no children to lose, with `RESTRICT`).
- `Reviews`: soft-delete. Preserve aggregate ratings on `Expert.avg_rating`.

### 16.2 The TypeORM pattern

```ts
@Entity()
export class Expert {
  // ...
  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamp with time zone', nullable: true })
  deletedAt!: Date | null;
}
```

With `@DeleteDateColumn`, TypeORM's `softDelete()` and `restore()` methods work automatically, and `find()` excludes soft-deleted rows by default. Use `withDeleted: true` to include them.

### 16.3 The interaction with CASCADE

Soft-delete does not fire CASCADE. The row is still there. The CASCADE only fires on hard delete. This is the *point* of soft-delete: you can delete a user without wiping their expert, reviews, etc., because the DB-level delete doesn't happen.

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

---

## 17. The transaction boundary

Cardinality decisions interact with transactions. The rule:

> **A transaction boundary should encompass all writes that must succeed or fail together.**

If you're creating an `Expert` and adding `Qualifications` in an M:N, both writes must be in the same transaction. If the expert write succeeds and the qualification write fails, you have an expert with no qualifications (and a dangling expert if the failure was a constraint violation).

```ts
// GOOD — atomic
await this.dataSource.transaction(async (manager) => {
  const expert = await manager.save(Expert, expertData);
  await manager.save(ExpertQualification, qualifications.map(q => ({ expert, qualification: q })));
});
```

```ts
// BAD — not atomic
const expert = await this.expertRepo.save(expertData);
await this.expertQualificationRepo.save(/* ... */);  // if this fails, expert exists alone
```

The N+1 query pattern also has a transaction implication: if you're updating 1,000 children in a loop, do it in a single transaction. Otherwise, a failure at child 500 leaves the first 499 updated and the rest not.

---

## 18. Common mistakes (read this before you start coding)

1. **Decorating only one side of a relationship.** `@OneToMany` without `@ManyToOne`, or vice versa. Always both.
2. **Putting `@JoinColumn` on the inverse side.** The inverse side never gets `@JoinColumn`. Period.
3. **Putting `@JoinTable` on both sides of an M:N.** Pick one. Document the choice.
4. **Forgetting `unique: true` on a 1:1 FK.** Allows duplicates; corrupts the model.
5. **Forgetting the composite PK on a pivot.** Allows duplicate rows; corrupts counts.
6. **Using `cascade: true` (TypeORM) when you mean `onDelete: 'CASCADE'` (Postgres).** They serve different purposes. `cascade: true` is for "save children when I save parent". `onDelete` is for "wipe children when parent dies". Often you want exactly one; rarely both.
7. **Storing business data on the implicit pivot.** Promote to entity.
8. **Trusting the diagram's arrow head.** The arrow is decoration. The FK column is the truth.
9. **Marking inverse sides as `!` instead of `?`.** Inverse sides are `undefined` until you load them. Mark them optional.
10. **Skipping the smoke test.** After writing the relationship, do `findOne({ relations: [...] })` and assert the array is correct. If you skip this, the bug will ship.
11. **Using `eager: true` to "fix" the lazy loading.** It hides the N+1 query from you. Don't do it.
12. **Forgetting the index on a FK.** Postgres doesn't do it for you. The query is slow in production; you spend a day adding the index; the incident postmortem is embarrassing.
13. **Trusting `synchronize: true` in any non-dev environment.** It drops columns. It drops indexes. It doesn't preserve data. Use migrations.
14. **Marking a FK `nullable: true` "to be safe".** The default is rarely what you want. Be deliberate.
15. **Catching `ForeignKeyConstraintViolationError` and "fixing" it by deleting children.** That's how production data disappears.
16. **Forgetting to add the inverse side on a 1:N.** The service layer code becomes awkward (`expertRepo.find({ where: { user: { id } } })` instead of `user.experts`), but the data model still works. Decide explicitly.
17. **Putting `eager: true` on a `@ManyToMany`.** Every `find()` loads the entire pivot. At 1,000 experts × 5 qualifications each, that's 5,000 rows on every query. Don't.
18. **Not documenting the `@JoinTable` side choice.** Six months from now, you add a `@JoinTable` to the other side "for symmetry" and everything breaks.

---

## 19. The business-stakeholder translation

When a non-technical stakeholder asks "why does this take so long?" or "why can't we just add a column?", you need a translation. Here are the common questions and the answers:

**Q: "Why can't we just add `obtained_year` to the qualifications list?"**
A: The qualifications are stored in a many-to-many relationship, which is a link table with no room for extra columns. Adding the column requires migrating the link table to a real entity — a 2-hour change today, a 2-day change after we have 100k experts. We're doing it now.

**Q: "Why does deleting a category take so long?"**
A: We deliberately configured the database to refuse category deletion if experts are attached. This prevents a single click from wiping 1,200 expert profiles. The admin tool walks you through reassigning the experts first. The extra minute is a feature.

**Q: "Why does the search endpoint return `undefined` for some fields?"**
A: TypeORM loads related data only when you ask for it. This is a performance feature — we don't load 10MB of related data on every search result. The fix is to add the field to the `relations` array in the search query. Five-minute change.

**Q: "Why did the migration fail?"**
A: The migration tried to add a foreign key constraint, but 47 existing rows have invalid values. The migration is protecting us from corrupting the database. The fix is to backfill the 47 rows first, then re-run the migration. One-hour change.

**Q: "Why do we have separate `User` and `Profile` tables?"**
A: Three reasons: (1) security — password hashes never leak in API responses; (2) GDPR — we can delete PII without deleting auth; (3) performance — login queries don't pull PII. The split is one of the most leveraged design decisions in the codebase.

**Q: "Why can't we just use `synchronize: true` in production?"**
A: It auto-syncs the schema from the code, but it doesn't preserve data. A deploy that removes a column from an entity will drop that column and all its data from production. The 30 minutes we save by not writing migrations is not worth the data loss risk.

---

## 20. Self-check

Answer these in writing before moving to Lesson 03.

1. What does it mean for a side to "own" a relationship? How do you identify it from the diagram?
2. Why does `@JoinColumn` appear on exactly one side, and how do you decide which?
3. For `Users 1—N Posts`, write the two entity stubs (just the relationship decorators and the relevant columns).
4. For `Experts M—N Languages` with a pivot `expert_languages`, write the two entity stubs and the SQL for the composite PK + both FKs.
5. Why is the implicit `@JoinTable` pivot a bad place to store `obtained_year`? What do you do instead?
6. State the composite-PK rule for any pivot, and explain what goes wrong if you skip it.
7. Look at `er-2.drawio`. List every 1:1, every 1:N, and every M:N edge.
8. Why is `cascade: true` not a substitute for `onDelete: 'CASCADE'`?
9. If you see `duplicate key value violates unique constraint` on `profiles_user_id_key`, what is the missing decorator option?
10. If you see `expert.qualifications` return `undefined` in production but the row exists in the DB, list the two most likely causes.
11. Why is the `Users ↔ Profiles` split a security control, not just a design preference?
12. What is the N+1 query pattern, and how do you detect it in production?
13. Why should you never catch `ForeignKeyConstraintViolationError` and "fix" it by deleting children?
14. Explain the GDPR "right to be forgotten" workflow in your schema. Which cardinality decisions make it possible?
15. What is the difference between `cascade: true` and `onDelete: 'CASCADE'`? Give an example where you want one but not the other.
16. Why is `eager: true` almost always the wrong choice?
17. What is the migration order for adding a new 1:N relationship? Why does the order matter?
18. What does `EXPLAIN ANALYZE` tell you? What's the first thing you look for?
19. Why is soft-delete often better than hard-delete for `User` and `Expert`? How does it interact with `CASCADE`?
20. A stakeholder asks "why does the search take 2 seconds?". List three cardinality-related causes and how you'd diagnose each.

When you can answer all twenty without re-opening this file, go to **Lesson 03**.
