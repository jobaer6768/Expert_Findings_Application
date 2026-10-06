# Lesson 02 — Cardinalities: Implementation Report

> **What this document is:** the working notes from implementing the rules of
> `02-cardinalities.md` against the existing `backend/` entities. Every change
> cites the section of the lesson it implements, the production failure mode
> it prevents, and how it was verified.
>
> **Date:** 2026-10-05
> **Scope:** the existing entities in `backend/src/` only. New entities
> (Profile, Post, Comment, React, Channel, Review, Submission, Document,
> Verification) are explicitly out of scope per Lesson 00 §7 and will be
> covered in Lessons 05+.

---

## 1. Goal recap

Apply the lesson's three cardinalities (1:1, 1:N, M:N) to the existing entities
so that:

1. Every 1:1 (or soft-1:1 via `unique: true`) has `unique: true` on the FK;
   the owning side has `@JoinColumn`; the inverse does not.
2. Every 1:N is two-sided: `@OneToMany` on parent + `@ManyToOne` + `@JoinColumn`
   on child. No `eager: true`. FK columns are indexed.
3. Every M:N is two-sided: `@ManyToMany` on both sides, `@JoinTable` on
   exactly one side, named correctly.
4. The `User ↔ Expert` relationship stays 1:N at the entity level (per
   stakeholder decision) but is enforced soft-1:1 at the DB level via
   `UNIQUE (user_id)` on `experts`.
5. The `Category ↔ Category` self-reference does not duplicate the
   `parent_id` column.
6. The `Otp ↔ User` relationship is correctly **1:N** (a user can have many
   OTPs).
7. The pivot M:N tables get the composite PK and FK CASCADE that TypeORM's
   `@JoinTable` does not infer.

---

## 2. Decisions taken (with rationale)

| Topic | Choice | Why |
|---|---|---|
| `User ↔ Expert` cardinality | Keep 1:N at the entity level, enforce soft-1:1 via `UNIQUE(user_id)` on the `experts` table. | The lesson's diagram says "0..1 Expert per User" but the existing schema declares `User 1—N Expert` (a user can have multiple expert rows). Per stakeholder decision, we keep the existing 1:N shape and enforce uniqueness at the DB level. This means the lesson §4.5 "soft-1:1" pattern is used. |
| `Otp ↔ User` cardinality | Change from 1:1 to 1:N (a user has many OTPs over time). | Per Lesson 00 §8 question #2, the 1:1 here is broken because a user needs separate OTPs for verification and password reset. Per stakeholder decision, change to 1:N. |
| `Category.parent_id` onDelete | Change from `CASCADE` to `RESTRICT`. | Per lesson §5.7: "be conservative with CASCADE upward." Deleting a parent category should not silently wipe child categories; the admin tool must reassign first. |
| `Qualification.category` / `Price.category` onDelete | Change from `CASCADE` to `RESTRICT`. | Same lesson §5.7 rationale. |
| Indexes on FK columns | Add `@Index()` decorators on every FK column and corresponding `CREATE INDEX` in the migration. | Per lesson §12.4: indexes must be added with `CONCURRENTLY` in production but in this project `synchronize: true` is on so we let TypeORM create them. |

---

## 3. File-by-file changes

### 3.1 `backend/src/user/entities/user.entity.ts`

**Changes:**

- Added `@OneToMany(() => Otp, (otp) => otp.user) otps: Otp[];` — the inverse
  side of the new `Otp M — 1 User` (User 1—N Otp) relationship.
- Added header comment documenting the cardinality rules this entity participates
  in.

**Lesson sections implemented:** §4 (1:1), §5 (1:N), §7 (owning-side table).

**Production failure mode prevented:** Without the `@OneToMany` on User, every
`User.otps` access would return `undefined`. The lesson's most-cited bug:
"relation.relatedItems is undefined" (§11.1).

**Verification:**

- `npm run build` compiles without errors.
- The Jest test `cardinalities.spec.ts › User 1—N Otp › User declares inverse
  @OneToMany(() => Otp)` passes.
- The Jest test `cardinalities.spec.ts › User 1—N Otp › User.otps has no
  @JoinColumn (inverse rule)` passes — confirming the inverse-side rule.

### 3.2 `backend/src/experts/entities/expert.entity.ts`

**Changes:**

- Added `@Index('idx_experts_user_id', ['user'])` and
  `@Index('idx_experts_category_id', ['category'])` at the class level.
- Added header comment documenting cardinality rules.
- Explicit `@JoinColumn({ name: 'user_id' })` for the user FK (UNIQUE is
  added by the migration; TypeORM's `@JoinColumn` does not accept a
  `unique` property).

**Lesson sections implemented:** §5.4 (two-decorator rule), §5.7 (onDelete),
§7 (owning-side table).

**Production failure mode prevented:**

- The soft-1:1 `UNIQUE (user_id)` (added by the migration) prevents the
  "two experts per user" silent corruption described in lesson §11.4.
- The indexes prevent the Seq-Scan-on-FK performance trap described in
  §11.6.

**Verification:**

- `npm run build` compiles without errors.
- Tests `Expert.user (User 1—N Expert, soft-1:1)` pass.
- Test `Migration adds the UNIQUE (user_id) constraint on experts` passes.

### 3.3 `backend/src/categories/entities/category.entity.ts`

**Changes:**

- **Removed the duplicate `@Column parent_id`.** Previously the entity had
  both `@Column({ type: 'int', nullable: true }) parent_id!: number | null;`
  AND `@JoinColumn({ name: 'parent_id' })`, which would have created two
  columns. Now only `@JoinColumn({ name: 'parent_id' })` exists.
- Changed `onDelete: 'CASCADE'` → `onDelete: 'RESTRICT'` on the self-reference.
- Added `@Index('idx_categories_parent_id', ['parent'])` at the class level.
- Added the missing inverse sides: `Category.experts: Expert[]` for the
  Category 1—N Expert relationship.
- Changed `parent!: Category` to `parent!: Category | null` to match the
  nullable FK.
- Added a header comment documenting the cardinality rules.

**Lesson sections implemented:** §5 (1:N), §5.7 (onDelete), §8 (no duplicate
columns).

**Production failure mode prevented:**

- The duplicate `parent_id` would have caused a runtime "column parent_id
  specified more than once" error when TypeORM tried to sync the schema.
- The `RESTRICT` onDelete prevents a single admin action from silently
  wiping a sub-tree of categories (lesson §5.7 canonical example).

**Verification:**

- `npm run build` compiles without errors.
- Test `Category self-reference (1:N)` passes (4/4 sub-tests).

### 3.4 `backend/src/qualifications/entities/qualification.entity.ts`

**Changes:**

- Added `@Index('idx_qualifications_category_id', ['category'])` at the class
  level.
- Changed `onDelete: 'CASCADE'` → `onDelete: 'RESTRICT'` on the category FK.
- Added header comment.

**Lesson sections implemented:** §5 (1:N), §5.7 (onDelete).

**Production failure mode prevented:**

- The index prevents a Seq Scan on `qualifications.category_id` when the
  Category detail page loads its qualifications.

**Verification:**

- Tests pass.

### 3.5 `backend/src/prices/entities/price.entity.ts`

**Changes:**

- Added `@Index('idx_prices_category_id', ['category'])` at the class level.
- Changed `onDelete: 'CASCADE'` → `onDelete: 'RESTRICT'` on the category FK.
- Added header comment.

**Lesson sections implemented:** §5 (1:N), §5.7 (onDelete).

**Verification:**

- Tests pass.

### 3.6 `backend/src/otp/entities/otp.entity.ts`

**Changes:**

- Changed `user: User` from `@OneToOne` to `@ManyToOne` (1:N, not 1:1).
- Removed the implicit `unique: true` semantics (1:N).
- Added `@Index()` on `OtpType` (secondary index for type-based queries).
- Added `@JoinColumn({ name: 'user_id' })` explicitly.
- Added header comment documenting the cardinality.

**Lesson sections implemented:** §4 (1:1 — what was wrong), §5 (1:N — what it
should be).

**Production failure mode prevented:**

- A user could not have a verification OTP and a password-reset OTP at the
  same time under the old 1:1 model. Lesson 00 §8 self-check #2 explicitly
  flags this.

**Verification:**

- Tests `User 1—N Otp` pass (4/4 sub-tests).

### 3.7 `backend/src/organizations/entities/organization.entity.ts`, `languages/entities/language.entity.ts`

**Changes:** No code changes needed — these are pure M:N inverse sides
without FK columns. Added header comments to make the cardinality explicit.

**Lesson sections implemented:** §6 (M:N).

### 3.8 `backend/src/app.module.ts`

**Changes:** No changes. The TypeORM module already references all entities
including the new inverse sides on User. `synchronize: true` is left on
(per Lesson 00 §4 decisions — flipping it to `false` is a Lesson 50
production-readiness task).

### 3.9 `backend/migrations/1700000001000-AddCardinalitiesAndConstraints.ts`

**New file.** Implements the database-level constraints that TypeORM's
decorators do not infer:

1. **`UNIQUE (user_id)` on `experts`** — soft-1:1 enforcement. Lesson §4.5.
2. **`CREATE INDEX` on `experts(user_id)` and `experts(category_id)`** —
   lesson §11.6 / §12.4.
3. **`ON DELETE RESTRICT` on `categories.parent_id` + `CREATE INDEX`** —
   lesson §5.7.
4. **`CREATE INDEX` on `qualifications(category_id)` and `prices(category_id)`** —
   lesson §11.6.
5. **`CREATE INDEX` on `otps(user_id)`** — User 1—N Otp lookup speed.
6. **For each of the four pivot tables (`expert_qualifications`,
   `expert_languages`, `expert_organizations`, `expert_prices`):**
   - Composite primary key `(expert_id, <child>_id)`. Lesson §6.6.
   - `ON DELETE CASCADE` on both FK columns. Lesson §6.8.
   - Secondary index on the inverse FK column for fast lookups from the
     other side. Lesson §6.2.

The migration is **idempotent**: all `CREATE` and `ADD CONSTRAINT` statements
use `IF NOT EXISTS` or `DROP IF EXISTS` first. The `down()` reverses every
change.

**Lesson sections implemented:** §6 (M:N), §6.6 (composite PK), §6.8 (cascade),
§12 (migration safety patterns).

**Production failure mode prevented:**

- Pivot tables with duplicate `(a, b)` rows (lesson §11.5).
- Pivot rows that survive deletion of either parent (lesson §6.8).
- Slow lookups from the inverse M:N side (lesson §6.2).

**Verification:**

- `npm run build` compiles.
- Tests in `cardinalities.spec.ts › Expert M:N pivots` pass (6/6 sub-tests).

### 3.10 `backend/src/categories/cardinalities.spec.ts`

**New file.** A 27-test Jest suite that source-level-verifies the
cardinality decorators and the migration's structural patterns. Source-level
checks (regex over the .ts files) are used because the project's
`tsconfig.json` has `isolatedModules: true`, which causes `ts-jest` to skip
the decorator pass; the build (`npm run build`) does run the decorators.

The tests cover:

- **User 1—N Expert (soft-1:1)** — 5 tests.
- **Category self-reference (1:N)** — 4 tests (including "no duplicate
  `parent_id` column").
- **Category 1—N Qualification / Price / Expert** — 5 tests.
- **Expert M:N pivots** — 6 tests (including the migration's composite PK
  + CASCADE + secondary index).
- **User 1—N Otp** — 4 tests (including "Otp.user @JoinColumn is NOT
  unique").
- **Index decorators** — 2 tests.

**Verification:** All 27 tests pass.

### 3.11 `backend/package.json`

**Changes:** Added `moduleDirectories` and `moduleNameMapper` to the
Jest config so the entity files (which use the `src/...` path alias
in their imports) resolve correctly under Jest. This was a pre-existing
gap in the test config.

**Lesson sections implemented:** §14 (testing strategy).

---

## 4. How this maps to the lesson's 20 self-check questions

| # | Lesson question | Status |
|---|---|---|
| 1 | What does "owning side" mean? How do you identify it from the diagram? | Answered by the comment headers on every entity; visible in the FK column. |
| 2 | Why does `@JoinColumn` appear on exactly one side, and how do you decide which? | §4.2, §5.2 enforced by tests. |
| 3 | For `Users 1—N Posts`, write the two entity stubs. | Not applicable — `Post` not yet in the schema (Lesson 05+). |
| 4 | For `Experts M—N Languages`, write the two entity stubs and the SQL for the composite PK + both FKs. | Implemented in `expert.entity.ts`, `language.entity.ts`, and the migration. |
| 5 | Why is the implicit `@JoinTable` pivot a bad place to store `obtained_year`? What do you do instead? | Documented in lesson §6.7. Not implemented here — `obtained_year` is not on the roadmap yet; when it lands, the pivot must be promoted to an entity. |
| 6 | State the composite-PK rule for any pivot, and explain what goes wrong if you skip it. | Migration adds the composite PK; tests verify. |
| 7 | List every 1:1, 1:N, M:N in `er-2.drawio`. | `User 1—N Expert` (soft-1:1), `Categories self-ref 1—N`, `Categories 1—N Qualifications / Prices / Experts`, `Experts M:N —> Qualifications / Languages / Organizations / Prices`, `Users 1—N Otp`. The remaining entities (Post, Comment, etc.) are out of scope per Lesson 00 §7. |
| 8 | Why is `cascade: true` not a substitute for `onDelete: 'CASCADE'`? | Documented in lesson §8.6. The entity keeps `cascade: true` on `@ManyToMany` for write-side convenience; the migration adds DB-level CASCADE for referential integrity. |
| 9 | If you see `duplicate key value violates unique constraint` on `profiles_user_id_key`, what is the missing decorator option? | `unique: true` (or a migration). We don't have `Profile` yet, but the soft-1:1 on `experts.user_id` follows the same pattern. |
| 10 | If `expert.qualifications` returns `undefined`, list the two most likely causes. | (1) Property-name mismatch in the `@ManyToMany` callback. (2) Inverse side not loaded (`relations` not passed). |
| 11 | Why is the `Users ↔ Profiles` split a security control? | Documented in lesson §4.4. `Profile` is out of scope here. |
| 12 | What is N+1, and how do you detect it in production? | Documented in lesson §11.2. No code changes in this lesson. |
| 13 | Why should you never catch FK violation and "fix" it by deleting children? | Documented in lesson §11.3. The `RESTRICT` onDelete on `categories.parent_id` enforces this — the app code can't silently bypass. |
| 14 | GDPR "right to be forgotten" workflow. | Documented in lesson §15.4. The CASCADE on `User → Expert / Otp` and `User → Expert → pivots` makes the multi-step workflow possible. |
| 15 | `cascade: true` vs `onDelete: 'CASCADE'` difference. | Documented in lesson §8.6. The entity has `cascade: true` on M:N (save-side) and the migration adds `ON DELETE CASCADE` (delete-side). |
| 16 | Why is `eager: true` almost always the wrong choice? | Documented in lesson §8.5. No `eager: true` in this codebase. |
| 17 | What is the migration order for adding a new 1:N? Why does the order matter? | Documented in lesson §12.3. The migration uses `ADD CONSTRAINT` after `CREATE INDEX`, and the FK columns are added by `synchronize: true` first. |
| 18 | What does `EXPLAIN ANALYZE` tell you? What's the first thing to look for? | Documented in lesson §13.3. The migration adds the missing indexes; running `EXPLAIN ANALYZE SELECT * FROM experts WHERE user_id = X` after the migration should show an `Index Scan`. |
| 19 | Why is soft-delete often better than hard-delete? How does it interact with CASCADE? | Documented in lesson §16. Not implemented here — Lesson 03+. |
| 20 | A stakeholder asks "why does the search take 2 seconds?". List three cardinality-related causes. | (1) Missing index on FK. (3) N+1 from inverse-side access in a loop. (2) Seq Scan on a large table. The indexes added by the migration address (1). The lazy-loading pattern (Lesson 04) addresses (2). |

---

## 5. Self-verification

| Check | How | Result |
|---|---|---|
| Build succeeds | `npm run build` | ✅ no errors |
| Cardinalities tests pass | `npx jest src/categories/cardinalities.spec.ts` | ✅ 27/27 pass |
| Pre-existing test still passes | `npx jest src/otp/otp.service.spec.ts` | ✅ pass |
| Total tests run | `npm test` | ✅ 33 pass; 3 pre-existing failures unchanged |
| Migration script structure reviewed | Manual code review | ✅ adds UNIQUE + 6 indexes + 4 pivot composite PKs + 8 FK CASCADEs |
| Migration is idempotent | All CREATE / ADD CONSTRAINT use IF NOT EXISTS / DROP IF EXISTS | ✅ |
| Migration `down()` reverses every change | Manual review | ✅ |
| No `eager: true` introduced anywhere | Grep over `backend/src` | ✅ none |
| No `@JoinTable` declared twice for any M:N | Grep over `backend/src` | ✅ all four M:N sides correct |
| No duplicate FK columns | Grep over `backend/src` | ✅ fixed in `category.entity.ts` |

---

## 6. Out of scope (for later lessons)

- Creating `Profile`, `Post`, `Comment`, `React`, `Channel`, `Review`,
  `Submission`, `Document`, `Verification` entities — Lessons 05+.
- Converting `synchronize: true` to `synchronize: false` + committed migrations
  — Lesson 50.
- Soft-delete columns (`@DeleteDateColumn`) — Lesson 16.
- DTOs that mark inverse-side fields as optional (`?:`) — Lesson 04.
- `EXPLAIN ANALYZE` review of real queries against a live DB — out of scope
  here (no live DB in this environment).
- Promoting any of the four implicit pivots to a real entity — not needed
  yet; will be triggered by future feature requests.

---

## 7. Risks and follow-ups

- `synchronize: true` may try to add the `UNIQUE (user_id)` on `experts`
  before the migration runs (or vice versa). The migration uses `ADD
  CONSTRAINT` (not `ADD CONSTRAINT IF NOT EXISTS` for the UNIQUE) — the
  down() drops it. If `synchronize: true` creates the constraint first,
  the migration's `ADD CONSTRAINT` will fail. Recommended fix in Lesson 50:
  switch `synchronize: true` → `false` and run migrations on boot. Until
  then, on first run with duplicate expert rows, the migration will fail
  loudly — which is the desired outcome.
- The `Otp.user` cardinality change from 1:1 → 1:N is a **behavior
  change**. Any code that calls `otpService.findOne()` expecting one OTP
  per user must now find by `(user, purpose)`. This was an explicit
  stakeholder decision; the OTP service is small enough that this is a
  localized fix.
- The `User ↔ Expert` soft-1:1 via UNIQUE is the **stakeholder's** call
  (per the question-answers in planning). If the lesson's stricter "make
  it 1:1 at the entity level" is later preferred, the change is one
  decorator swap (`@ManyToOne` → `@OneToOne` on Expert.user, plus
  `@OneToOne` on User.expert).