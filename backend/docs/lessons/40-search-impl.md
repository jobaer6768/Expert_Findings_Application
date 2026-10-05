# Lesson 40 — Search Implementation: The Endpoints, The Query, The Indexes

> **What you'll get:** the working `/search/experts` endpoint, the suggest endpoint, the supporting lookup endpoints, the migrations that add full-text + trigram + covering indexes, and the test plan that proves ranking works.
>
> **Required reading:** Lesson 30 (theory), `search-feature-planning.md`, `search-api-design.md`. If you haven't read all three, stop.

---

## 1. Goal

A search module that:

- accepts every filter from `search-api-design.md` §3,
- ranks results by text → verification → category → Bayesian rating → reviews,
- returns facets (qualification counts, observed price range),
- returns up to 3 server-side suggestions when the result set is empty,
- exposes a `/search/suggest` typeahead endpoint that's safe to call on every keystroke,
- protects itself with throttling and a hard per-page cap,
- is test-covered for: ranking, filtering, faceting, empty-state suggestions, suggest endpoint, sort variants.

---

## 2. Why the code looks the way it does

The shape of the implementation:

```
search/
├── search.module.ts
├── search.controller.ts            ← thin: validates, calls service
├── search.service.ts               ← the heavy query
├── suggest.service.ts              ← typeahead (separate file because it's hot path)
├── rank.util.ts                    ← SQL snippets reused across queries
└── dto/
    └── search-experts.dto.ts       ← class-validator at the boundary
```

**Why a separate `suggest.service.ts`?** The typeahead endpoint is called on every keystroke. It has different latency budget (50ms) and different SQL shape (no facet count, no ranking, smaller LIMIT). Sharing code with the main search would either bloat the main query or constrain the suggest path. Splitting them is honest about the difference.

**Why `rank.util.ts`?** Three places in the service need the same SQL expressions: scoring, ordering, and ranking for suggestions. Putting them in one place means a Bayesian-weight change happens in one file.

### 2.1 Business cost of getting this structure wrong

| Smell | What it costs in production |
|---|---|
| `SearchService` calls `ExpertsService` for relations | 5 round-trips for 20 results. p95 = 250ms. Lesson 50 will tell you this is "the obvious failure" — every senior engineer has seen it. |
| `SuggestService` and `SearchService` share a base class | One change to ranking affects both. Suggest latency budget is 50ms; main is 200ms. Different budgets, different code. |
| DTO inline in the controller | Reusing `q` validation in another endpoint requires a refactor. The DTO is the contract; share it. |
| SQL strings in the controller | The controller should be 10 lines. SQL is 200 lines. They don't belong together. |
| Migration logic in the service | A migration runs once. A service runs per request. Mixing them is a deployment nightmare. |

**The structure is the design. Don't move fast by skipping it.**

---

## 3. Current state of the codebase (audit before you write code)

| Gap | Where | Risk |
|---|---|---|
| `experts.service.ts` is empty | `src/experts/experts.service.ts` | Search has nothing to compose with. |
| `experts` entity has no `search_tsv` column | `src/experts/entities/expert.entity.ts` | The migration's `ADD COLUMN` works, but the entity should also declare the column for typing. |
| `experts` entity has no `bayesian_rating` column | same | Same. |
| `experts` entity has no `fee_min`/`fee_max` | same | The search query references them; the column doesn't exist. Migration failure. |
| `experts` entity has no `fee_currency`, `fee_unit`, `is_remote`, `availability_status`, `office_address` | same | Same — these are referenced in the search response shape. |
| `experts` entity has no `is_email_verified` on `User` | `user.entity.ts` | The search query joins `users`; we don't filter on it but the seed data sets it. |
| `verification_status` enum is `PENDING`/`VERIFIED`/`REJECTED`, not `verified`/`pending`/`unverified` | `expert.entity.ts:19` | The migration uses string literals; the entity uses an enum. The mapping has to match exactly. |
| `Profile` entity doesn't exist | (Lesson 05 audit) | The search joins `profiles`; the entity is required for TypeScript to compile. |
| `Category` `parent_id` has no `ON DELETE` cycle check | (Lesson 02/03 audit) | The recursive CTE on `categories` will infinite-loop on a cycle. |
| `experts.category_id` has no index | (Lesson 02/03 audit) | The `WHERE category_id IN (...)` does a sequential scan. |
| `expert_qualifications(qualification_id, expert_id)` doesn't exist | (Lesson 03 audit) | Facet count query does a hash join. Slow. |
| `pg_trgm` extension not enabled | (none) | The `similarity()` function in the suggest query errors at runtime. |
| `pg_trgm_ops` operator class not used in any index | (none) | The `trgm` index in the migration needs this opclass. |
| `synchronize: true` still on | `app.module.ts:48` | The new columns will be added automatically — but the *trigger* and *index* won't. Migrations only. |
| `app.module.ts` does not import `SearchModule` | `app.module.ts` | The new endpoints won't be registered. |
| No Redis in the stack | (Lesson 05 audit) | The "cache results" plan needs Redis. We can ship without it (TTL=0); Lesson 50 adds it. |
| `SearchService.search` has no transaction | (none) | The three parallel queries (`main`, `count`, `facets`) read from a snapshot. A new expert created between the three queries could be in `count` but not `data` (or vice versa). Acceptable for search, but worth knowing. |

**Lesson 40 ships all the schema and code changes.** The audit above is what you must verify is fixed (or that the migration handles it) before the lesson will work. The lesson does not fix `synchronize: true` — that's a Lesson 05 problem. The lesson does not fix the empty `experts.service.ts` — the search bypasses it.

### 3.1 The migration must come first

The order is:
1. Stop the app.
2. Run the migration (creates columns, indexes, triggers).
3. Backfill the existing rows (the trigger does this for new rows; for existing rows, run a one-time `UPDATE`).
4. Start the app.

If you start the app before the migration, the entity is out of sync with the schema. The next `synchronize: true` (if it's on) will see "entity says no `search_tsv` column" and try to drop it. The migration runs after; the column is back. State confusion. **Disable `synchronize` before running migrations.**

### 3.2 The backfill story

The trigger on `experts` updates `search_tsv` on `INSERT` and on `UPDATE OF bio, category_id, user_id`. It does **not** fire on `INSERT` of the migration's `ADD COLUMN` (the column is added empty). For existing rows, you must populate `search_tsv` once:

```sql
UPDATE experts SET bio = bio;  -- force the trigger to fire for every row
```

Or, more explicitly:

```sql
UPDATE experts e
SET search_tsv :=
     setweight(to_tsvector('simple', coalesce(p.full_name, '')), 'A')
  || setweight(to_tsvector('simple', coalesce(e.bio, '')), 'B')
  || setweight(to_tsvector('simple', coalesce(c.name, '')), 'C')
FROM profiles p, categories c
WHERE p.user_id = e.user_id AND c.id = e.category_id;
```

This is in a separate migration. **Lesson 40's migration is just the schema; backfill is its own migration so it can be re-run.**

---

## 4. Schema changes (migration)

First, we add what Lesson 30's indexes need. Migration `1700000000010-search-indexes.ts`:

`backend/src/migrations/1700000000010-search-indexes.ts`:

```ts
import { MigrationInterface, QueryRunner } from 'typeorm';

export class SearchIndexes1700000000010 implements MigrationInterface {
  name = 'SearchIndexes1700000000010';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. trigram extension for fuzzy matching
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);

    // 2. Generated column for the search vector. We update it on profile/name/bio change.
    await queryRunner.query(`
      ALTER TABLE experts
      ADD COLUMN IF NOT EXISTS search_tsv tsvector
      GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', coalesce(bio, '')), 'B')
      ) STORED;
    `);

    // We can't reference profile.full_name and category.name from inside an
    // experts generated column (cross-table refs are not allowed in generated
    // columns in Postgres). So we maintain search_tsv via a trigger instead.
    await queryRunner.query(`ALTER TABLE experts DROP COLUMN search_tsv;`);

    await queryRunner.query(`
      ALTER TABLE experts
      ADD COLUMN search_tsv tsvector;
    `);

    // 3. The trigger function: keep search_tsv in sync with profile + category + organizations.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION experts_search_tsv_update() RETURNS trigger AS $$
      DECLARE
        nm      text;
        bio_t   text;
        cat_nm  text;
        orgs    text;
      BEGIN
        SELECT full_name INTO nm FROM profiles WHERE user_id = NEW.user_id;
        SELECT bio INTO bio_t FROM experts WHERE user_id = NEW.user_id;
        SELECT name  INTO cat_nm FROM categories WHERE id = NEW.category_id;
        SELECT string_agg(o.name, ' ')
          INTO orgs
          FROM expert_organizations eo
          JOIN organizations o ON o.id = eo.organization_id
          WHERE eo.expert_id = NEW.id;
        NEW.search_tsv :=
             setweight(to_tsvector('simple', coalesce(nm, '')), 'A')
          || setweight(to_tsvector('simple', coalesce(bio_t, '')), 'B')
          || setweight(to_tsvector('simple', coalesce(cat_nm, '')), 'C')
          || setweight(to_tsvector('simple', coalesce(orgs, '')), 'C');
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await queryRunner.query(`
      CREATE TRIGGER trg_experts_search_tsv_update
      BEFORE INSERT OR UPDATE OF bio, category_id, user_id ON experts
      FOR EACH ROW EXECUTE FUNCTION experts_search_tsv_update();
    `);

    // 4. Profiles trigger — when full_name changes, re-fire the expert's trigger.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION profiles_search_tsv_propagate() RETURNS trigger AS $$
      BEGIN
        UPDATE experts SET bio = bio WHERE user_id = NEW.user_id;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_profiles_search_tsv_propagate
      AFTER UPDATE OF full_name ON profiles
      FOR EACH ROW EXECUTE FUNCTION profiles_search_tsv_propagate();
    `);

    // 5. Bayesian-adjusted rating column.
    await queryRunner.query(`
      ALTER TABLE experts
      ADD COLUMN IF NOT EXISTS bayesian_rating numeric(3, 2)
      GENERATED ALWAYS AS (
        CASE WHEN review_count IS NULL OR review_count = 0 THEN 3.5
             ELSE (review_count::numeric / (review_count + 10)) * coalesce(avg_rating, 3.5)
                + (10::numeric / (review_count + 10)) * 3.5
        END
      ) STORED;
    `);

    // 6. Indexes
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_experts_search_tsv
      ON experts USING GIN (search_tsv);
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_experts_category_status_rating
      ON experts (category_id, status, bayesian_rating DESC, review_count DESC);
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_experts_verified_active
      ON experts (verification_status)
      WHERE status = 'active' AND verification_status = 'verified';
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_experts_status_bayesian
      ON experts (status, bayesian_rating DESC);
    `);

    // Trigram on profiles.full_name for typo-tolerant name search
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_profiles_fullname_trgm
      ON profiles USING GIN (full_name gin_trgm_ops);
    `);

    // Reverse-direction indexes for facets
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_eq_qualification
      ON expert_qualifications (qualification_id, expert_id);
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_el_language
      ON expert_languages (language_id, expert_id);
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_eo_organization
      ON expert_organizations (organization_id, expert_id);
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_ep_price
      ON expert_prices (price_id, expert_id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_profiles_search_tsv_propagate ON profiles;`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_experts_search_tsv_update ON experts;`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS profiles_search_tsv_propagate();`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS experts_search_tsv_update();`);
    await queryRunner.query(`ALTER TABLE experts DROP COLUMN IF EXISTS search_tsv;`);
    await queryRunner.query(`ALTER TABLE experts DROP COLUMN IF EXISTS bayesian_rating;`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_experts_search_tsv;`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_experts_category_status_rating;`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_experts_verified_active;`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_experts_status_bayesian;`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_profiles_fullname_trgm;`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_eq_qualification;`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_el_language;`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_eo_organization;`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_ep_price;`);
  }
}
```

**Note on the typo'd trigger above.** Earlier lesson versions had an obvious syntax error in the first `CREATE OR REPLACE FUNCTION` (`$$ ... $$` closed too early, semicolon mid-block). The current version is correct. I keep this note to teach you to *read the migration diff before running it*. Always.

Register `SearchIndexes1700000000010` is auto-picked up because we glob `src/migrations/*.ts`.

### 4.1 Add `bayesianRating` and `searchTsv` to the `Expert` entity

`backend/src/experts/entities/expert.entity.ts` — append:

```ts
@Column({ type: 'tsvector', nullable: true, name: 'search_tsv', select: false })
searchTsv?: string;

@Column({ type: 'numeric', precision: 3, scale: 2, name: 'bayesian_rating', nullable: true })
bayesianRating?: number;
```

(Read-only — they are managed by the DB, not by your code.)

### 4.2 Why two migrations (schema + backfill) is cleaner than one

If you backfill in the up-migration, the down-migration must also un-backfill. There's no SQL "un-backfill". You can `DROP COLUMN` to reverse, but then the column is gone — the data is lost. The two-migration pattern:

- **Migration A**: schema (columns, indexes, triggers).
- **Migration B**: data (backfill existing rows).

Down for A drops columns (data lost, expected). Down for B is a no-op (backfill is idempotent; re-running it on a fresh DB does the same thing). **The two-migration pattern is the rule for "schema + data" changes.**

### 4.3 The `IF NOT EXISTS` defensive pattern

`ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `CREATE TRIGGER IF NOT EXISTS` — these make migrations idempotent. If the migration was partially applied (e.g., the trigger was created but the index wasn't, due to a crash), re-running it picks up where it left off.

**Always use `IF NOT EXISTS` on schema migrations.** The cost is a tiny perf hit (Postgres does an existence check). The benefit is recoverability from partial state.

### 4.4 The "generated column with cross-table refs" trap

Postgres does not allow `GENERATED ALWAYS AS (...)` to reference other tables. The `search_tsv` could not be a generated column referencing `profiles.full_name` and `categories.name`. **We had to fall back to a trigger.** This is a real limitation, not a bug. Lesson 50 covers denormalization as the alternative (store `full_name` and `category_name` on `experts` directly, then the generated column works).

### 4.5 The trigger ordering

`trg_experts_search_tsv_update` runs `BEFORE INSERT OR UPDATE OF bio, category_id, user_id`. The `OF` clause means the trigger only fires when one of those columns is in the SET clause of an UPDATE. An `UPDATE experts SET is_remote = true` does not fire the trigger. **This is intentional** — the `search_tsv` doesn't depend on `is_remote`.

The `profiles_search_tsv_propagate` trigger does `UPDATE experts SET bio = bio WHERE user_id = NEW.user_id`. The `bio = bio` is a no-op assignment, but it makes Postgres see `bio` in the SET clause, which fires the expert's trigger. **This is the "trigger chain" pattern** — a change in `profiles` propagates to `experts` via a no-op update.

### 4.6 The `status` column assumption

The migration uses `status = 'active'` in the partial index. The entity has `availability_status` (`availibility_status` — note the typo in the current code, line 144) but no `status` column. **The migration will fail** if the `status` column doesn't exist. Add a migration first:

```sql
ALTER TABLE experts
ADD COLUMN IF NOT EXISTS status varchar(20) NOT NULL DEFAULT 'active';
```

Or, rename the entity's `availability_status` to `status` and have the migration reference the right column. This is the kind of cross-lesson dependency that breaks deployment. **Verify the column name with `psql -c "\d experts"` before running the migration.**

### 4.7 The `fee_min`/`fee_max`/`fee_currency`/`fee_unit` assumption

Same as above. The search query references these; the entity doesn't have them. **The migration must add them** before the search query can run. Or, the search service must select from columns that exist. A pre-flight check: `SELECT column_name FROM information_schema.columns WHERE table_name = 'experts';` should include all the columns the search query references.

---

## 5. DTOs

`backend/src/search/dto/search-experts.dto.ts`:

```ts
import { Type, Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { toInt, toFloat, splitCsv } from '../util/coerce';

export enum Verified {
  ALL = 'all',
  VERIFIED = 'verified',
  UNVERIFIED = 'unverified',
}

export enum Status {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
}

export enum Sort {
  RELEVANCE = 'relevance',
  RATING = 'rating',
  REVIEWS = 'reviews',
  NEWEST = 'newest',
  PRICE_LOW = 'price_low',
  PRICE_HIGH = 'price_high',
}

export class SearchExpertsDto {
  @IsOptional() @IsString() @MaxLength(120)
  q?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  category_id?: number;

  @IsOptional() @IsString() @MaxLength(80)
  location?: string;

  @IsOptional() @Type(() => Number) @IsNumber() @Min(0)
  price_min?: number;

  @IsOptional() @Type(() => Number) @IsNumber() @Min(0)
  price_max?: number;

  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(5)
  min_rating?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  min_reviews?: number;

  @IsOptional() @IsEnum(Verified)
  verified?: Verified = Verified.ALL;

  @IsOptional() @Type(() => Number) @IsInt()
  organization_id?: number;

  @IsOptional()
  @Transform(({ value }) => splitCsv(value))
  @IsArray() @ArrayMaxSize(20) @IsInt({ each: true })
  qualifications?: number[];

  @IsOptional()
  @Transform(({ value }) => splitCsv(value))
  @IsArray() @ArrayMaxSize(20) @IsInt({ each: true })
  languages?: number[];

  @IsOptional() @IsEnum(Status)
  status?: Status = Status.ACTIVE;

  @IsOptional() @IsEnum(Sort)
  sort?: Sort = Sort.RELEVANCE;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number = 1;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50)
  per_page?: number = 20;
}
```

A small util:

`backend/src/search/util/coerce.ts`:

```ts
export const toInt = (v: any) => (v == null ? undefined : parseInt(String(v), 10));
export const toFloat = (v: any) => (v == null ? undefined : parseFloat(String(v)));

export function splitCsv(v: unknown): number[] | undefined {
  if (v == null) return undefined;
  if (Array.isArray(v)) return v.map(Number);
  return String(v)
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => !Number.isNaN(n));
}
```

**Two important behaviors:**

1. **CSV-style multi-select.** `?languages[]=1&languages[]=2` works in Express; we also accept `?languages=1,2` for clients that don't build arrays (Lesson 50 might add a stricter parser).
2. **Hard cap `per_page=50`.** Prevents a client from asking for 100k rows in one request.

### 5.1 Why `@Transform` for CSV

Express by default parses `?languages[]=1&languages[]=2` as an array. But `?languages=1,2` is a string. The `@Transform` decorator runs before validation and converts the string to an array. The DTO is the contract; the client can send either shape, and the service sees a `number[]`.

### 5.2 The `per_page=50` cap is not arbitrary

50 is chosen because:
- 50 fits in a single screen on most laptops (scrolling not required).
- 50 is small enough that the response is < 100KB even with full profile data.
- 50 is large enough to give the user a "first page" with enough choices to filter down from.
- 1000+ row responses (which some clients request) saturate the network. The 50 cap forces pagination.

A user wanting page 2 calls `?page=2`. We don't allow `?per_page=1000`.

### 5.3 The `min_rating`/`min_reviews` floor

`@Min(0)` for `min_rating` is a floor. `@Max(5)` is the rating scale ceiling. A user typing `?min_rating=10` gets 400. **This is the boundary that turns "absurd input" into "loud error"** instead of "silent return of all experts" (because no expert has rating ≥ 10).

### 5.4 The `verified` enum's middle value

`Verified.ALL` (the default) means "no filter on verification". `Verified.VERIFIED` means "only verified". `Verified.UNVERIFIED` means "only unverified". The middle option is the "we have no preference" default; the other two are explicit filters. **The default matters**: a UI that always shows verified experts first is one thing; a UI that returns verified AND unverified experts (and lets the user filter) is another. The lesson supports both.

---

## 6. The query (the heart of the lesson)

`backend/src/search/search.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SearchExpertsDto, Sort } from './dto/search-experts.dto';

export interface SearchHit {
  expert_id: number;
  name: string | null;
  photo_url: string | null;
  category_id: number;
  category_name: string;
  subcategory_name: string | null;
  organization_name: string | null;
  location: string | null;
  is_remote: boolean | null;
  availability_status: string | null;
  avg_rating: number | null;
  review_count: number;
  verification_status: string;
  fee_min: number | null;
  fee_max: number | null;
  fee_currency: string | null;
  fee_unit: string | null;
}

export interface SearchResponse {
  meta: {
    total_results: number;
    page: number;
    per_page: number;
    applied_filters: Record<string, unknown>;
  };
  facets: {
    available_qualifications: { id: number; name: string; count: number }[];
    price_range_in_results: { min: number | null; max: number | null };
  };
  data: SearchHit[];
  suggestions: null | { action: string; filter: string; label: string }[];
}

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  async search(dto: SearchExpertsDto): Promise<SearchResponse> {
    const params: any[] = [];
    const where: string[] = [];

    // status defaults to active
    where.push(`e.status = $${++params.length}`);
    params.push(dto.status ?? 'active');

    if (dto.verified === 'verified') {
      where.push(`e.verification_status = 'verified'`);
    } else if (dto.verified === 'unverified') {
      where.push(`e.verification_status <> 'verified'`);
    }

    if (dto.category_id != null) {
      // include all descendants of the selected node (recursive CTE)
      where.push(`e.category_id IN (
        WITH RECURSIVE cat AS (
          SELECT id FROM categories WHERE id = $${++params.length}
          UNION
          SELECT c.id FROM categories c JOIN cat ON c.parent_id = cat.id
        )
        SELECT id FROM cat
      )`);
      params.push(dto.category_id);
    }

    if (dto.min_rating != null) {
      where.push(`e.avg_rating >= $${++params.length}`);
      params.push(dto.min_rating);
    }
    if (dto.min_reviews != null) {
      where.push(`e.review_count >= $${++params.length}`);
      params.push(dto.min_reviews);
    }

    // Location: until Locations table exists, LIKE on office_address.
    if (dto.location) {
      where.push(`e.office_address ILIKE $${++params.length} ESCAPE '\\'`);
      params.push(`%${escapeLike(dto.location)}%`);
    }

    if (dto.price_min != null) {
      where.push(`(e.fee_max IS NULL OR e.fee_max >= $${++params.length})`);
      params.push(dto.price_min);
    }
    if (dto.price_max != null) {
      where.push(`(e.fee_min IS NULL OR e.fee_min <= $${++params.length})`);
      params.push(dto.price_max);
    }

    if (dto.organization_id != null) {
      where.push(`EXISTS (
        SELECT 1 FROM expert_organizations eo
        WHERE eo.expert_id = e.id AND eo.organization_id = $${++params.length}
      )`);
      params.push(dto.organization_id);
    }

    if (dto.qualifications?.length) {
      where.push(`EXISTS (
        SELECT 1 FROM expert_qualifications eq
        WHERE eq.expert_id = e.id AND eq.qualification_id = ANY($${++params.length}::int[])
      )`);
      params.push(dto.qualifications);
    }
    if (dto.languages?.length) {
      where.push(`EXISTS (
        SELECT 1 FROM expert_languages el
        WHERE el.expert_id = e.id AND el.language_id = ANY($${++params.length}::int[])
      )`);
      params.push(dto.languages);
    }

    let textExpr = '1'; // constant; replaced if q is present
    if (dto.q && dto.q.trim().length > 0) {
      where.push(`(e.search_tsv @@ plainto_tsquery('simple', $${++params.length})
                   OR p.full_name % $${++params.length})`);
      params.push(dto.q);
      params.push(dto.q);
      textExpr = `ts_rank(e.search_tsv, plainto_tsquery('simple', $${params.length}))`;
    }

    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const orderBy = (() => {
      switch (dto.sort) {
        case Sort.RATING:
          return `ORDER BY e.bayesian_rating DESC NULLS LAST, e.review_count DESC`;
        case Sort.REVIEWS:
          return `ORDER BY e.review_count DESC, e.bayesian_rating DESC`;
        case Sort.NEWEST:
          return `ORDER BY e.created_at DESC NULLS LAST, e.id DESC`;
        case Sort.PRICE_LOW:
          return `ORDER BY e.fee_min ASC NULLS LAST, e.id ASC`;
        case Sort.PRICE_HIGH:
          return `ORDER BY e.fee_max DESC NULLS LAST, e.id ASC`;
        case Sort.RELEVANCE:
        default:
          if (dto.q) {
            return `ORDER BY (${textExpr}
                     + CASE WHEN e.verification_status = 'verified' THEN 0.5 ELSE 0 END
                     + COALESCE(e.bayesian_rating, 0) / 10.0) DESC,
                     e.review_count DESC`;
          }
          return `ORDER BY COALESCE(e.bayesian_rating, 0) DESC,
                          e.verification_status = 'verified' DESC,
                          e.review_count DESC`;
      }
    })();

    const offset = ((dto.page ?? 1) - 1) * (dto.per_page ?? 20);
    const limit = dto.per_page ?? 20;

    const sql = `
      SELECT
        e.id              AS expert_id,
        p.full_name       AS name,
        p.photo_url       AS photo_url,
        c.id              AS category_id,
        c.name            AS category_name,
        cp.name           AS subcategory_name,
        e.office_address  AS location,
        e.is_remote       AS is_remote,
        e.availability_status,
        e.avg_rating,
        e.review_count,
        e.verification_status,
        e.fee_min,
        e.fee_max,
        e.fee_currency,
        e.fee_unit,
        (SELECT o.name FROM expert_organizations eo
           JOIN organizations o ON o.id = eo.organization_id
           WHERE eo.expert_id = e.id LIMIT 1) AS organization_name
      FROM experts e
      JOIN users u    ON u.id = e.user_id
      LEFT JOIN profiles p ON p.user_id = u.id
      JOIN categories c   ON c.id = e.category_id
      LEFT JOIN categories cp ON cp.id = c.parent_id
      ${whereSql}
      ${orderBy}
      LIMIT ${limit} OFFSET ${offset}
    `;

    const countSql = `SELECT COUNT(*) AS n FROM experts e
                      LEFT JOIN profiles p ON p.user_id = e.user_id
                      ${whereSql}`;

    const [rows, countRows, facetRows] = await Promise.all([
      this.ds.query(sql, params),
      this.ds.query(countSql, params),
      this.computeFacets(dto, params),
    ]);
    const total = Number(countRows[0]?.n ?? 0);

    const response: SearchResponse = {
      meta: {
        total_results: total,
        page: dto.page ?? 1,
        per_page: limit,
        applied_filters: Object.fromEntries(
          Object.entries(dto).filter(([_, v]) => v !== undefined && v !== null && v !== ''),
        ),
      },
      facets: facetRows,
      data: rows,
      suggestions: total === 0 ? await this.computeSuggestions(dto) : null,
    };
    return response;
  }

  private async computeFacets(dto: SearchExpertsDto, baseParams: any[]) {
    // Re-run the same WHERE without the qualifications filter; count qualifications observed.
    const params: any[] = [];
    const where: string[] = [];
    where.push(`e.status = $${++params.length}`);
    params.push(dto.status ?? 'active');
    if (dto.verified === 'verified') where.push(`e.verification_status = 'verified'`);
    if (dto.verified === 'unverified') where.push(`e.verification_status <> 'verified'`);
    if (dto.category_id != null) {
      where.push(`e.category_id IN (
        WITH RECURSIVE cat AS (
          SELECT id FROM categories WHERE id = $${++params.length}
          UNION SELECT c.id FROM categories c JOIN cat ON c.parent_id = cat.id
        )
        SELECT id FROM cat
      )`);
      params.push(dto.category_id);
    }
    if (dto.min_rating != null) {
      where.push(`e.avg_rating >= $${++params.length}`);
      params.push(dto.min_rating);
    }
    if (dto.min_reviews != null) {
      where.push(`e.review_count >= $${++params.length}`);
      params.push(dto.min_reviews);
    }
    if (dto.location) {
      where.push(`e.office_address ILIKE $${++params.length} ESCAPE '\\'`);
      params.push(`%${escapeLike(dto.location)}%`);
    }
    if (dto.price_min != null) {
      where.push(`(e.fee_max IS NULL OR e.fee_max >= $${++params.length})`);
      params.push(dto.price_min);
    }
    if (dto.price_max != null) {
      where.push(`(e.fee_min IS NULL OR e.fee_min <= $${++params.length})`);
      params.push(dto.price_max);
    }
    if (dto.organization_id != null) {
      where.push(`EXISTS (SELECT 1 FROM expert_organizations eo
        WHERE eo.expert_id = e.id AND eo.organization_id = $${++params.length})`);
      params.push(dto.organization_id);
    }
    if (dto.languages?.length) {
      where.push(`EXISTS (SELECT 1 FROM expert_languages el
        WHERE el.expert_id = e.id AND el.language_id = ANY($${++params.length}::int[]))`);
      params.push(dto.languages);
    }
    // Deliberately: NO qualifications filter here, so we can offer them as facets.
    const whereSql = 'WHERE ' + where.join(' AND ');

    const facetSql = `
      WITH q AS (
        SELECT e.id FROM experts e ${whereSql}
      )
      SELECT qual.id, qual.name, COUNT(*) AS count
      FROM q
      JOIN expert_qualifications eq ON eq.expert_id = q.id
      JOIN qualifications qual ON qual.id = eq.qualification_id
      GROUP BY qual.id, qual.name
      ORDER BY count DESC LIMIT 20;
    `;
    const priceSql = `
      WITH q AS (
        SELECT e.id FROM experts e ${whereSql}
      )
      SELECT MIN(e.fee_min) AS min, MAX(e.fee_max) AS max
      FROM experts e WHERE e.id IN (SELECT id FROM q);
    `;

    const [qualRows, priceRows] = await Promise.all([
      this.ds.query(facetSql, params),
      this.ds.query(priceSql, params),
    ]);

    return {
      available_qualifications: qualRows.map((r: any) => ({
        id: Number(r.id),
        name: r.name,
        count: Number(r.count),
      })),
      price_range_in_results: {
        min: priceRows[0]?.min != null ? Number(priceRows[0].min) : null,
        max: priceRows[0]?.max != null ? Number(priceRows[0].max) : null,
      },
    };
  }

  private async computeSuggestions(dto: SearchExpertsDto) {
    const candidates: { filter: string; relaxed: Record<string, unknown>; label: string }[] = [];
    const labels: Record<string, string> = {
      verified: 'Try removing "Verified"',
      min_rating: 'Try lowering the rating',
      min_reviews: 'Try lowering the review minimum',
      price_min: 'Try lowering the price floor',
      price_max: 'Try raising the price ceiling',
      location: 'Try widening the location',
      category_id: 'Try a broader category',
      languages: 'Try fewer languages',
      qualifications: 'Try fewer qualifications',
    };

    const relaxations: { key: string; drop: Partial<SearchExpertsDto> }[] = [];
    if (dto.verified && dto.verified !== 'all') {
      relaxations.push({ key: 'verified', drop: { verified: undefined } });
    }
    if (dto.min_rating != null) {
      relaxations.push({
        key: 'min_rating',
        drop: { min_rating: Math.max(0, dto.min_rating - 0.5) },
      });
    }
    if (dto.min_reviews != null) {
      relaxations.push({
        key: 'min_reviews',
        drop: { min_reviews: Math.max(0, dto.min_reviews - 5) },
      });
    }
    if (dto.price_min != null) {
      relaxations.push({ key: 'price_min', drop: { price_min: Math.max(0, dto.price_min - 100) } });
    }
    if (dto.price_max != null) {
      relaxations.push({
        key: 'price_max',
        drop: { price_max: (dto.price_max ?? 0) + 1000 },
      });
    }
    if (dto.category_id != null) {
      relaxations.push({ key: 'category_id', drop: { category_id: undefined } });
    }
    if (dto.location) {
      relaxations.push({ key: 'location', drop: { location: undefined } });
    }
    if (dto.languages?.length) {
      relaxations.push({ key: 'languages', drop: { languages: [] } });
    }
    if (dto.qualifications?.length) {
      relaxations.push({ key: 'qualifications', drop: { qualifications: [] } });
    }

    for (const r of relaxations) {
      const relaxed = { ...dto, ...r.drop };
      const result = await this.search(relaxed);
      if (result.meta.total_results > 0) {
        candidates.push({
          filter: r.key,
          relaxed: r.drop as Record<string, unknown>,
          label: labels[r.key] ?? `Try removing "${r.key}"`,
        });
      }
    }

    return candidates.slice(0, 3).map((c) => ({
      action: 'relax_filter',
      filter: c.filter,
      label: c.label,
    }));
  }
}

function escapeLike(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}
```

**Why this is *the* query and not a chain of `.where()` calls:**

- TypeORM's `find` cannot express `WITH RECURSIVE` cleanly.
- The single SQL is what Postgres plans and optimizes as one unit. Splitting into TypeORM chunks would generate N round-trips.
- We use raw parameterized SQL. Every user input goes through `$N` parameters. SQL injection is impossible by construction.

### 6.1 Why `Promise.all` for facets + main + count?

Three independent reads against the same WHERE clause. They can run in parallel on the same connection pool. The DB does the work in parallel; we save ~2 round-trips of wall time.

If you want to be conservative, run them sequentially. If you want them *really* fast, run them in a single query with `UNION ALL` and `json_agg`. Lesson 50 picks the conservative path and lists the aggressive one as a future optimization.

### 6.2 The N+1 risk in the SELECT subquery

`(SELECT o.name FROM expert_organizations eo JOIN organizations o ON o.id = eo.organization_id WHERE eo.expert_id = e.id LIMIT 1)` is a correlated subquery. It runs once per row in the result set. For 20 rows, it's 20 subqueries. For 1000 rows, 1000 subqueries.

This is acceptable because:
- The outer query is already limited to `LIMIT 20` (or 50).
- The subquery has its own `LIMIT 1`.
- The `expert_organizations(organization_id, expert_id)` index makes the subquery fast.

**If we changed `LIMIT 20` to `LIMIT 1000`, this subquery would dominate.** The lesson's design is correct for the cap; if you raise the cap, switch to a `LEFT JOIN LATERAL` or a window function.

### 6.3 The `(%  $N)` trigram fallback

`(e.search_tsv @@ plainto_tsquery('simple', $1) OR p.full_name % $1)` — the `%` operator is `pg_trgm`'s "similar to". For a query like "Lna", `plainto_tsquery` returns `'lna'`; the `@@` check fails (no match in the `tsvector`). The `%` check uses trigram similarity; "Lna" is similar to "Luna" enough to match. **This is the typo-tolerance fallback.**

The `OR` means: return rows that match either the exact-word search OR the fuzzy search. The query is then ranked by `ts_rank` (which is 0 for trigram-only matches) plus the verification/category boosts. The result: exact matches score high, typo matches score lower but still appear. The user sees "Dr. Luna" at the top, "Lna Hossain" 5 rows down. **Both are returned. Both are useful.**

### 6.4 Why `simple` and not `english` for the tsvector config

`'simple'` does no stemming. `'english'` stems "running" to "run", "children" to "child". For names, stemming is wrong: "Luna" should not match "Lunar". For bios, "running" should match "run". The lesson uses `'simple'` everywhere for consistency. **Lesson 50 can revisit: use `'simple'` for the name field, `'english'` for the bio field.**

### 6.5 The `COALESCE(e.bayesian_rating, 0) / 10.0` normalization

The Bayesian rating is 0..5. The text rank is 0..1. The verification bonus is 0.5. If we summed them as-is, the rating would dominate. We divide by 10 to bring it into the 0..0.5 range, comparable to the other signals. **This is a tuning knob.** A product team can adjust `/ 10.0` to `/ 5.0` (rating matters more) or `/ 20.0` (rating matters less). The lesson's choice is "rating is one signal among many, not the dominant one."

### 6.6 The `NULLS LAST` discipline

`ORDER BY e.bayesian_rating DESC NULLS LAST` — experts with no reviews (NULL rating) sort to the bottom. Without `NULLS LAST`, Postgres's default is platform-dependent (some versions sort NULLs first for DESC, some last). **Always specify `NULLS LAST` (or `NULLS FIRST`) explicitly.** The lesson's choice: missing data is less useful than low data; sort it last.

### 6.7 Why the recursive CTE for `category_id` and not for qualifications

- Categories form a tree (parent-child). A user searching "Healthcare" should see Cardiologists, Neurologists, etc. The recursive CTE expands the tree.
- Qualifications are a flat list. "BSc" doesn't have sub-qualifications. No recursion needed.
- Languages are flat. No recursion.
- Organizations are flat (no parent_id in the current schema). No recursion.

**The CTE is justified by the data shape, not by default.**

### 6.8 The suggestions loop is N+1 by design

```ts
for (const r of relaxations) {
  const result = await this.search(relaxed);  // <-- this calls the DB
  ...
}
```

This fires up to 9 queries (one per filter that was set). For an empty result path, this is OK — empty results are rare. For a busy search, this would be a catastrophe. **The lesson's design is correct because the loop is gated by `total === 0`.**

A smarter implementation: cache the count of each "relaxed" query in a single trip. For now, the loop is fine.

### 6.9 Why `escapeLike` is in the service file

```ts
function escapeLike(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}
```

The function escapes the three characters that have special meaning in `LIKE` patterns: `\`, `%`, `_`. The user's `?location=100%_main` becomes `100\%\_main` after escaping, which `LIKE '%100\%\_main%'` matches as the literal string "100%_main".

**The order matters**: escape `\` first (so we don't double-escape), then `%` and `_`. A user typing `\` gets `\\` (the literal backslash is preserved). A user typing `\\` gets `\\\\` (two backslashes are preserved).

---

## 7. The controller

`backend/src/search/search.controller.ts`:

```ts
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { SearchExpertsDto } from './dto/search-experts.dto';
import { SearchService } from './search.service';
import { SuggestService } from './suggest.service';
import { Public } from 'src/auth/decorators/public.decorator';

@Controller('search')
export class SearchController {
  constructor(
    private readonly search: SearchService,
    private readonly suggest: SuggestService,
  ) {}

  @Public()
  @Get('experts')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async searchExperts(@Query() dto: SearchExpertsDto) {
    return this.search.search(dto);
  }

  @Public()
  @Get('suggest')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async suggest(@Query('q') q: string) {
    return this.suggest.suggest(q);
  }
}
```

The `@Public()` decorator (from Lesson 20) opts out of the global `JwtAuthGuard`. Search is open.

### 7.1 Why the throttle limits are 60/min and 120/min

- **`/experts`**: 60/min. A human can do 60 searches in a minute only by script. Real usage is <10/min. The 60 cap is generous for humans, hostile to bots.
- **`/suggest`**: 120/min. Typeahead fires on every keystroke. A user typing "Python developer in Dhaka" triggers 28 keystrokes × maybe 2 wrong characters (backspace) = 30 calls. If they search 4 times, that's 120 calls. Right at the limit. **Bump to 200/min if you see legitimate users hitting 429.**

Per-IP throttle is the right level here because search is anonymous. Per-user throttle is for auth'd users. Lesson 50 adds per-user throttle on auth'd search.

### 7.2 Why `@Query()` and not `@Req()` for the DTO

`@Query() dto: SearchExpertsDto` — NestJS auto-binds the query string to the DTO. The `ValidationPipe` (registered globally in main.ts) validates each field. The controller body is 1 line.

`@Req() req: Request` would give raw access; you'd manually extract query params. **Use the DTO; let the framework do the work.**

---

## 8. The suggest service

`backend/src/search/suggest.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export interface Suggestion {
  type: 'expert' | 'category' | 'organization';
  id: number;
  label: string;
  subtitle?: string;
}

@Injectable()
export class SuggestService {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  async suggest(q: string, limit = 8): Promise<{ suggestions: Suggestion[] }> {
    if (!q || q.length < 2) return { suggestions: [] };

    const like = `%${q.replace(/[%_\\]/g, (c) => '\\' + c)}%`;

    const sql = `
      (SELECT 'expert' AS type, e.id::int AS id, p.full_name AS label,
              c.name AS subtitle
       FROM experts e
       JOIN users u ON u.id = e.user_id
       LEFT JOIN profiles p ON p.user_id = u.id
       JOIN categories c ON c.id = e.category_id
       WHERE p.full_name ILIKE $1 ESCAPE '\\'
          OR e.search_tsv @@ plainto_tsquery('simple', $2)
       ORDER BY similarity(p.full_name, $2) DESC NULLS LAST
       LIMIT $3)
      UNION ALL
      (SELECT 'category' AS type, c.id::int AS id, c.name AS label, NULL::text AS subtitle
       FROM categories c
       WHERE c.name ILIKE $1 ESCAPE '\\'
       ORDER BY length(c.name) ASC
       LIMIT $3)
      UNION ALL
      (SELECT 'organization' AS type, o.id::int AS id, o.name AS label, NULL::text AS subtitle
       FROM organizations o
       WHERE o.name ILIKE $1 ESCAPE '\\'
       ORDER BY length(o.name) ASC
       LIMIT $3)
      LIMIT $3;
    `;
    const rows: any[] = await this.ds.query(sql, [like, q, limit]);
    return {
      suggestions: rows.map((r) => ({
        type: r.type,
        id: Number(r.id),
        label: r.label,
        subtitle: r.subtitle ?? undefined,
      })),
    };
  }
}
```

**Two design notes:**

1. **`similarity()`** is provided by `pg_trgm`. We installed the extension in the migration; the function exists. It returns 0..1 — closer to 1 = closer match. Ordering by it gives best typo-tolerance ranking.
2. **`LIMIT $3` at the end** caps the union to the desired total. Each subquery's `LIMIT $3` is a defensive over-fetch; Postgres trims them in the final result.

### 8.1 Why `< 2` chars returns empty

Typeahead is useless for 1 character. The user typed "L"; showing 50 experts whose name contains "L" is noise. The `< 2` check makes the endpoint respond with `[]` for "L" and start returning suggestions at "Lu" / "Luna".

Some marketplaces allow 1-char typeahead for category-only ("D" → "Design, Development, ..."). For the MVP, 2+ is correct.

### 8.2 Why the `similarity()` ordering

`similarity(a, b)` returns the trigram overlap. "Luna" and "Lna" have 2 of 3 trigrams in common (Lun, una vs Lna); similarity is high. "Luna" and "Python" have 0 trigrams in common; similarity is 0. **Ordering by similarity DESC puts "Lna Hossain" right after "Dr. Luna Ahmed"** — typo-tolerance without making "Luna Karim" and "Lna Hossain" indistinguishable.

The cost: `similarity()` is O(n) where n is the length of the strings. For 10k profiles, each `similarity()` call is fast. For 1M profiles, this becomes the bottleneck. **Lesson 50 adds a trigram index on `profiles.full_name` if the suggest latency exceeds 50ms.**

### 8.3 The `UNION ALL` vs `UNION` choice

`UNION ALL` keeps duplicates. `UNION` removes them. For typeahead, duplicates are rare (an expert can't be both a category and an organization). The cost difference: `UNION` sorts the result to dedupe; `UNION ALL` doesn't. For 24 rows (8 per subquery), this is negligible. **The lesson uses `UNION ALL` for clarity** — if a real duplicate appeared, it's the same entity, harmless.

---

## 9. Supporting lookups

`backend/src/search/lookup.controller.ts`:

```ts
import { Controller, Get, Query } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Public } from 'src/auth/decorators/public.decorator';

@Controller()
export class LookupController {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  @Public()
  @Get('categories/tree')
  async categoriesTree() {
    const rows = await this.ds.query(`
      WITH RECURSIVE t AS (
        SELECT id, name, parent_id, 0 AS depth
        FROM categories WHERE parent_id IS NULL
        UNION ALL
        SELECT c.id, c.name, c.parent_id, t.depth + 1
        FROM categories c JOIN t ON c.parent_id = t.id
      )
      SELECT id, name, parent_id, depth FROM t ORDER BY depth, name;
    `);
    // build nested tree
    const map = new Map<number, any>();
    const roots: any[] = [];
    for (const r of rows) {
      const node = { id: Number(r.id), name: r.name, parent_id: r.parent_id == null ? null : Number(r.parent_id), children: [] as any[] };
      map.set(node.id, node);
    }
    for (const r of rows) {
      const id = Number(r.id);
      const node = map.get(id)!;
      if (node.parent_id == null) roots.push(node);
      else map.get(node.parent_id)?.children.push(node);
    }
    return roots;
  }

  @Public()
  @Get('qualifications')
  async qualifications(@Query('category_id') categoryId?: string) {
    if (!categoryId) {
      return this.ds.query(`SELECT id, name FROM qualifications ORDER BY name LIMIT 200;`);
    }
    return this.ds.query(
      `SELECT id, name FROM qualifications
       WHERE category_id = $1 ORDER BY name LIMIT 200;`,
      [Number(categoryId)],
    );
  }

  @Public()
  @Get('languages')
  async languages() {
    return this.ds.query(`SELECT id, name FROM languages ORDER BY name;`);
  }

  @Public()
  @Get('organizations/search')
  async organizationSearch(@Query('q') q: string) {
    if (!q) return [];
    return this.ds.query(
      `SELECT id, name, type FROM organizations
       WHERE name ILIKE $1 ESCAPE '\\'
       ORDER BY length(name) ASC LIMIT 20;`,
      [`%${q.replace(/[%_\\]/g, (c) => '\\' + c)}%`],
    );
  }
}
```

### 9.1 Why the categories endpoint returns a tree, not a flat list

The UI wants a `<CategoryTree>` component that renders "IT > Backend Developer > Python" as nested `<ul>`. Returning a flat list forces the UI to build the tree. The endpoint builds it once, on the DB, and returns nested JSON.

The cost: the tree-building loop in app code is O(n). For 100 categories, this is fine. For 10,000, you'd want the DB to return nested JSON directly (`json_agg` with `WITH RECURSIVE`). For the MVP, the in-app loop is correct.

### 9.2 Why `length(name) ASC` for category/ordering

Shorter category names rank higher. "Python" beats "Python Programming Fundamentals" for typeahead. This is a UX heuristic, not a relevance signal. **A user typing "P" sees the most specific categories first.**

### 9.3 The `qualifications?category_id=...` filter

The UI's "Add filter" dropdown shows qualifications. If the user has already filtered to "Healthcare", the dropdown should only show medical qualifications (MBBS, MD, PhD). The `?category_id=` query param scopes the list. **Without this, the user sees 200 qualifications including BSc/MSc which are irrelevant to a healthcare search.**

### 9.4 The `organizations/search` endpoint is for *typeahead*, not main search

The main search includes organization as a filter (via `expert_organizations` join). The typeahead searches organizations directly so the user can find "Brainstation" and then filter experts to that organization. **The endpoint is not redundant with `/search/experts`.**

---

## 10. The `SearchModule`

`backend/src/search/search.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { SearchService } from './search.service';
import { SuggestService } from './suggest.service';
import { SearchController } from './search.controller';
import { LookupController } from './lookup.controller';

@Module({
  controllers: [SearchController, LookupController],
  providers: [SearchService, SuggestService],
})
export class SearchModule {}
```

Register in `app.module.ts`:

```ts
import { SearchModule } from './search/search.module';
// inside imports:
SearchModule,
```

---

## 11. Tests

### 11.1 Seed data

`backend/seeds/experts.seed.ts`:

```ts
import { DataSource } from 'typeorm';

export async function seedExperts(ds: DataSource) {
  await ds.transaction(async (tx) => {
    await tx.query(`TRUNCATE experts, profiles, expert_qualifications,
                          expert_languages, expert_organizations,
                          expert_prices, reviews, organizations,
                          qualifications, languages, categories
                          RESTART IDENTITY CASCADE;`);

    // IT → Backend Developer → Python
    await tx.query(`
      INSERT INTO categories (name, parent_id) VALUES
        ('IT', NULL),
        ('Backend Developer', 1),
        ('Python', 2),
        ('Frontend Developer', 1),
        ('Healthcare', NULL);
    `);
    await tx.query(`
      INSERT INTO qualifications (name, category_id) VALUES
        ('BSc', 1), ('MSc', 1), ('PhD', 1), ('MBBS', 5), ('MD', 5);
    `);
    await tx.query(`
      INSERT INTO languages (name) VALUES ('English'), ('Bangla'), ('Arabic');
    `);
    await tx.query(`
      INSERT INTO organizations (name) VALUES ('Brainstation'), ('Google'), ('Hospital ABC');
    `);
    // Create experts
    const ex = [
      { name: 'Dr. Luna Ahmed',     bio: 'Cardiologist at Hospital ABC',         cat: 5, status: 'verified', rating: 4.9, reviews: 210, fee: [500, 1500] },
      { name: 'Luna Karim',         bio: 'Python backend developer',             cat: 3, status: 'verified', rating: 4.7, reviews: 60,  fee: [800, 2000] },
      { name: 'Lna Hossain',        bio: 'Node.js developer at Brainstation',    cat: 2, status: 'unverified', rating: 4.2, reviews: 4,   fee: [300, 800] },
      { name: 'Dr. Luna Rashid',    bio: 'Neurologist',                          cat: 5, status: 'verified', rating: 4.6, reviews: 88,  fee: [1000, 3000] },
      { name: 'Rakib Hasan',        bio: 'Frontend developer, Brainstation',     cat: 4, status: 'verified', rating: 4.5, reviews: 23,  fee: [400, 1200] },
    ];
    let uid = 100;
    for (const x of ex) {
      await tx.query(
        `INSERT INTO users (id, email, pass_hash, role, is_email_verified)
         VALUES ($1, $2, 'x', 'expert', true)`,
        [uid, `${x.name.replace(/\s+/g, '').toLowerCase()}@x.com`],
      );
      await tx.query(
        `INSERT INTO profiles (user_id, full_name) VALUES ($1, $2)`,
        [uid, x.name],
      );
      await tx.query(
        `INSERT INTO experts
           (user_id, category_id, bio, avg_rating, review_count,
            verification_status, availability_status,
            fee_min, fee_max, fee_currency, fee_unit,
            office_address, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'active',
                 $7, $8, 'BDT', 'consultation',
                 'Dhaka', 'active')`,
        [uid, x.cat, x.bio, x.rating, x.reviews, x.status, x.fee[0], x.fee[1]],
      );
      uid++;
    }
    await tx.query(`
      INSERT INTO expert_organizations (expert_id, organization_id) VALUES
        (101, 1), (102, 1), (103, 2), (104, 3);
    `);
    await tx.query(`
      INSERT INTO expert_languages (expert_id, language_id) VALUES
        (101, 1), (102, 2), (103, 1), (104, 1), (104, 2);
    `);
    await tx.query(`
      INSERT INTO expert_qualifications (expert_id, qualification_id) VALUES
        (101, 4), (104, 5), (102, 2);
    `);
  });
}
```

Run it once for dev:

```bash
node -e "require('ts-node/register'); const ds = require('./src/data-source').default; (async () => { await ds.initialize(); await require('./seeds/experts.seed').seedExperts(ds); await ds.destroy(); })();"
```

### 11.2 e2e tests

`backend/test/search.e2e.ts`:

```ts
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from 'src/app.module';
import { DataSource } from 'typeorm';
import { seedExperts } from 'seeds/experts.seed';

describe('Search (e2e)', () => {
  let app: INestApplication;
  let ds: DataSource;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: 1 as any, defaultVersion: '1' });
    await app.init();
    ds = app.get(DataSource);
    await seedExperts(ds);
  });

  afterAll(async () => {
    await ds.dropDatabase();
    await app.close();
  });

  it('returns all experts by category=IT (includes descendants)', async () => {
    const r = await request(app.getHttpServer())
      .get('/api/v1/search/experts?category_id=1')
      .expect(200);
    expect(r.body.meta.total_results).toBeGreaterThanOrEqual(3);
    const names = r.body.data.map((d: any) => d.name);
    expect(names).toEqual(expect.arrayContaining(['Luna Karim', 'Lna Hossain', 'Rakib Hasan']));
  });

  it('ranks verified above unverified on equal relevance', async () => {
    const r = await request(app.getHttpServer())
      .get('/api/v1/search/experts?q=luna')
      .expect(200);
    const firstThree = r.body.data.slice(0, 3).map((d: any) => d.verification_status);
    expect(firstThree[0]).toBe('verified');
  });

  it('Bayesian: 4.9/210 vs 4.7/60 — both should be high; the 4.9 wins', async () => {
    const r = await request(app.getHttpServer())
      .get('/api/v1/search/experts?sort=rating')
      .expect(200);
    expect(r.body.data[0].name).toBe('Dr. Luna Ahmed');
  });

  it('verified-only filter', async () => {
    const r = await request(app.getHttpServer())
      .get('/api/v1/search/experts?verified=verified')
      .expect(200);
    expect(r.body.data.every((d: any) => d.verification_status === 'verified')).toBe(true);
  });

  it('languages filter is OR (Bangla OR English)', async () => {
    const r = await request(app.getHttpServer())
      .get('/api/v1/search/experts?languages=1,2')
      .expect(200);
    expect(r.body.meta.total_results).toBeGreaterThan(0);
  });

  it('facets include qualification counts', async () => {
    const r = await request(app.getHttpServer())
      .get('/api/v1/search/experts?category_id=5')
      .expect(200);
    expect(r.body.facets.available_qualifications.length).toBeGreaterThan(0);
  });

  it('returns suggestions when empty', async () => {
    const r = await request(app.getHttpServer())
      .get('/api/v1/search/experts?category_id=5&min_rating=4.99&verified=verified')
      .expect(200);
    expect(r.body.meta.total_results).toBe(0);
    expect(Array.isArray(r.body.suggestions)).toBe(true);
    expect(r.body.suggestions.length).toBeGreaterThan(0);
  });

  it('typeahead returns mixed types', async () => {
    const r = await request(app.getHttpServer())
      .get('/api/v1/search/suggest?q=luna')
      .expect(200);
    expect(r.body.suggestions.length).toBeGreaterThan(0);
  });

  it('rejects per_page over 50', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/search/experts?per_page=1000')
      .expect(400);
  });
});
```

### 11.3 Performance: `EXPLAIN ANALYZE`

After loading 10k seed experts, run this:

```sql
EXPLAIN ANALYZE
SELECT e.id, p.full_name
FROM experts e
LEFT JOIN profiles p ON p.user_id = e.user_id
JOIN categories c ON c.id = e.category_id
WHERE e.status = 'active'
  AND e.category_id IN (
    WITH RECURSIVE cat AS (
      SELECT id FROM categories WHERE id = 1
      UNION
      SELECT c.id FROM categories c JOIN cat ON c.parent_id = cat.id
    )
    SELECT id FROM cat
  )
ORDER BY e.bayesian_rating DESC
LIMIT 20;
```

You should see:

- `Index Scan using idx_experts_category_status_rating`
- `Sort node: (bayesian_rating DESC)` not a sort over the whole table
- Total time: < 50ms on 10k rows, < 200ms on 100k rows

If you see `Seq Scan` on `experts`, your indexes aren't being used. Check:

- `WHERE status = 'active'` — `idx_experts_status_bayesian` covers this.
- `category_id IN (...)` — `idx_experts_category_status_rating` covers this.

If `status = 'active'` is in the WHERE but the index is on `(status, bayesian_rating)`, the planner may prefer a different index. Verify by `SET enable_seqscan = off;` and re-running.

---

## 12. Observability hooks

Search is the highest-volume endpoint. The observability story is non-negotiable.

### 12.1 Stable action vocabulary

- `search.experts.success` — with `result_count`, `latency_ms`, `cache_hit`, `query_hash`.
- `search.experts.empty` — with `result_count: 0`, `suggestions_count`, `relaxed_filters`.
- `search.experts.slow` — `latency_ms > 200`, with `query_plan_summary`.
- `search.experts.error` — with `error_code`, `error_message`.
- `search.suggest.success` — with `result_count`, `latency_ms`.
- `search.suggest.empty` — `q.length < 2`.
- `search.lookups.tree.success` — with `category_count`, `latency_ms`.

### 12.2 What to log on every search

- `requestId` — from `RequestIdInterceptor`.
- `query_hash` — `sha256(JSON.stringify(sorted(dto)))`. Lets you count cache hits by query pattern without storing the params.
- `latency_ms` — `Date.now()` before/after the service call.
- `result_count` — `data.length`.
- `total_results` — from `countSql`.
- `cache_hit` — true/false (Lesson 50 adds caching).
- `query_plan_summary` — only on `search.experts.slow` events. Log the `EXPLAIN ANALYZE` first 5 lines.

### 12.3 What to alert on

- `p95 latency_ms > 300` over 5 min — page.
- `search.experts.slow` rate > 5% — investigate indexes.
- `search.experts.empty` rate > 50% — product issue.
- `search.experts.error` rate > 1% — Postgres sick.
- `cache_hit_rate < 30%` — cache is not effective.

### 12.4 The `pg_stat_statements` view

```sql
SELECT query, calls, mean_exec_time, total_exec_time
FROM pg_stat_statements
WHERE query LIKE '%experts%'
ORDER BY mean_exec_time DESC
LIMIT 20;
```

This is the **source of truth for "what is slow"**. Install the extension in production.

---

## 13. Security implications

### 13.1 SQL injection

All user input is parameterized via `$N`. The only string-concatenated value is `${limit}` and `${offset}` in the SQL — these are integers already validated by class-validator (`@IsInt @Min(1) @Max(50)`). **No user input ever reaches the SQL string.**

### 13.2 PII in search results

The `SearchHit` interface explicitly enumerates the fields. There's no `email`, no `phone`, no `passwordHash`, no `tokenVersion`. The `SELECT` is an explicit column list, not `SELECT *`. **The response shape is the security boundary.**

### 13.3 Rate limit math

- Anonymous: 60 searches/min, 120 suggests/min.
- Auth'd: 120 searches/min (Lesson 50).
- Per-IP: 300 searches/min.

### 13.4 The empty-result enumeration

A user can search for arbitrary strings and learn "this term matches 0 experts". The throttler bounds this. A more aggressive defense: rate-limit by query hash (so a bot can't rotate IPs to enumerate). **For the MVP, the IP throttle is sufficient.**

### 13.5 The ranking-by-verification leakage

An attacker can paginate to position 21 and conclude "the 21st expert is unverified" (because verified ranked higher). For 20 per page, this requires paginating. The throttler bounds enumeration. **Lesson 50 adds "if the user paginates past 50 pages, deny" as a defense.**

### 13.6 The recursive CTE cycle attack

A malicious user (with admin access to categories) could create `A.parent_id = B; B.parent_id = A`. The recursive CTE loops. The `users.experts` connection pool is exhausted.

Defense: a CHECK constraint or trigger that prevents cycles. **Lesson 03 covered the trigger; the migration should include it.** If you don't have it, the lesson's CTE is at risk.

---

## 14. Debugging recipes

### 14.1 "Search returns 0 results for a query that should match"

1. `SELECT id, search_tsv FROM experts WHERE id = 42;` — is the `tsvector` populated?
2. `SELECT plainto_tsquery('simple', 'luna');` — does it return `'luna'`?
3. `SELECT id FROM experts WHERE search_tsv @@ plainto_tsquery('simple', 'luna') LIMIT 5;` — does this return?
4. `SELECT id FROM experts WHERE status = 'active' AND category_id IN (...) LIMIT 5;` — does the filter alone return?
5. If all the above work, the issue is the combination. Comment out filters one by one in the service.

### 14.2 "Search is slow (> 1s)"

1. `EXPLAIN ANALYZE` the query. Look for `Seq Scan` on `experts`.
2. If `Seq Scan`, check `WHERE status = 'active'` is using the partial index.
3. If the plan is `Bitmap Heap Scan with Recheck`, the GIN index is lossy. Consider a covering index.
4. If the sort is over 10k rows, the `bayesian_rating` column isn't being used. Verify the column exists and is populated.

### 14.3 "Facets return wrong counts"

1. The facet query must have the *same* `WHERE` clause as the main query, *minus* the faceted field's filter.
2. Walk the query: does the facet SQL include the `category_id` filter? Yes. The `verified` filter? Yes. The `qualifications` filter? **No.** If yes, the facet is wrong.

### 14.4 "Suggestions loop is slow"

1. Each relaxation is a full search. With 9 filters set, that's 9 searches.
2. The total time is 9 × 200ms = 1.8s. That's user-visible.
3. Mitigation: cache the relaxed searches. Lesson 50 adds caching.

### 14.5 "Bayesian rating is always 3.5"

1. The `bayesian_rating` column is a generated column. Check it exists: `\d experts`.
2. Check `review_count` is populated. If always 0, the formula returns 3.5.
3. Trigger a recompute: `UPDATE experts SET avg_rating = avg_rating;` (the trigger fires).

### 14.6 "Trigram match returns nothing"

1. The `pg_trgm` extension is not enabled: `CREATE EXTENSION pg_trgm;`.
2. The GIN index is not on the column: `\d profiles`.
3. The `similarity()` function is on the wrong schema.

### 14.7 "Recursive CTE returns infinite loop"

1. Add cycle detection: `WITH RECURSIVE cat AS ( ... ) CYCLE id SET is_cycle USING path`.
2. Or, the data has a cycle: `SELECT id, parent_id FROM categories WHERE parent_id IS NOT NULL AND parent_id = id;` — this catches `A → A`. For `A → B → A`, you need a recursive check.

### 14.8 "The /suggest endpoint is slow on every keystroke"

1. The endpoint fires on every key. With 28 keystrokes for a query, that's 28 calls.
2. Each call is 30-50ms (one trigram + one tsvector + one ILIKE).
3. Total: 28 × 40ms = 1.1s of network time. The UI feels laggy.
4. Mitigation: **debounce** the typeahead in the frontend. Wait 200ms after the last keystroke before firing.

---

## 15. Common mistakes (the full list)

| Mistake                                                                       | What goes wrong                                                | Fix                                                                                  |
|-------------------------------------------------------------------------------|----------------------------------------------------------------|--------------------------------------------------------------------------------------|
| Forgetting `ESCAPE '\\'` in `ILIKE`                                           | A user with `_` in their name causes weird matches            | Always escape `%`, `_`, `\` before string interpolation                              |
| `SELECT *` on the search query                                                | Returns `passwordHash` to the wire if you forget `select:false` | Explicit column list                                                               |
| Trusting user input for `LIMIT` / `OFFSET`                                     | SQL injection (no — but DoS by `LIMIT 999999999`)            | Hard cap, validate                                                                   |
| Recursive CTE for `category_id` without cycle protection                      | Infinite recursion if data has a cycle                        | Migration adds a CHECK or trigger to prevent cycles                                   |
| Facets computed without `LIMIT`                                               | Memory blowup on huge result sets                              | `LIMIT 20` per facet                                                                 |
| Suggest endpoint hits the same heavy query as main                             | p99 latency on the hot keystroke path                        | Separate `SuggestService`                                                            |
| No `trgm` index on `profiles.full_name`                                       | Suggest is slow for typo queries                              | Migration adds GIN trgm index                                                        |
| Returning `passwordHash` in the search response                               | Account compromise                                            | Explicit `SELECT` columns; never `SELECT *`                                          |
| Computing `bayesianRating` in SQL `ORDER BY` instead of using the generated column | Sort is slow                                                | Use the generated `bayesian_rating` column                                           |
| Letting unauthenticated users hit `/search/experts` 1000×/min                  | DoS                                                            | Throttler + Cloudflare                                                              |
| Caching results keyed by full URL including random param                       | Cache hit rate near zero                                      | Sort params, normalize booleans, hash for cache key                                  |
| Using `'english'` config for `tsvector` on names                              | "Luna" matches "Lunar" — wrong                                | Use `'simple'` for names, `'english'` for bios                                       |
| Putting `search_tsv` population in a generated column referencing other tables | Migration fails                                               | Use a trigger instead                                                                |
| Forgetting to backfill `search_tsv` on existing rows                           | New experts are searchable; old ones are not                  | Run `UPDATE experts SET bio = bio;` after migration                                  |
| Empty `else` branch in `verified` filter                                      | `verified=unverified` is silently ignored                     | `WHERE verification_status <> 'verified'`                                            |
| Facet query includes the filter being faceted                                 | Returns 1 or 0 — useless                                      | Strip that filter from the facet query                                              |
| `Promise.all` for 3 queries with no timeout                                   | One slow query hangs the request                              | `Promise.race([..., timeout(2000)])` with a fallback                                  |
| Forgetting `LEFT JOIN profiles` (instead of `JOIN`)                           | Experts without profiles don't appear                         | `LEFT JOIN` (profile is optional)                                                    |
| The `OFFSET 10000` deep page                                                  | p99 = 5s                                                      | Cap offset, migrate to keyset in Lesson 50                                          |
| Search returns `applied_filters` with empty string params                    | UI shows "filter: " with no label                             | Filter out empty strings                                                            |
| `category_id IN (CTE)` on a non-existent category                             | Returns 0 — but the user gets no error                        | Validate the category exists; return 404 for missing IDs                              |
| `?q=` is empty string                                                         | Treated as no text filter, but parameter is passed             | `if (dto.q && dto.q.trim().length > 0)` — already in the lesson                       |
| Suggest endpoint doesn't check `q.length < 2`                                 | "L" returns 50 suggestions                                    | Early return for short queries                                                       |
| Migrations run in CI but not in dev                                           | "Works on my machine"                                         | Single `migration:run` script invoked everywhere                                     |
| Indexes created without `CONCURRENTLY` on a populated table                   | Locks the table for the duration of index build               | For large tables, use `CREATE INDEX CONCURRENTLY` (not in a transaction)             |
| `search_tsv` not populated when `profile.full_name` updates                    | User changes name, search for new name returns 0              | The `profiles_search_tsv_propagate` trigger handles this                            |
| Pagination at the offset 0 issue                                              | `OFFSET NULL` crashes                                         | Default to 1, translate to `OFFSET 0`                                                |
| Search returns data but `total_results` is 0                                  | UI shows "0 results" but renders 20                           | The count query and main query use different params                                  |
| Suggestions call search recursively without depth limit                       | 9 filters × N each = 100ms × 9 = 900ms                        | Cap at 3 suggestions; skip if not set                                                |

### 15.1 The mistakes that have caused real outages

- **The `SELECT *` leak**: A team wrote a search endpoint that did `SELECT * FROM experts`. The `passwordHash` was supposed to be `select: false`, but a junior engineer added `@Column({ select: true })` to debug something. The search response included password hashes. **Always explicit `SELECT`.**
- **The missing trigger**: A team created the `search_tsv` column with a default expression. New rows worked. Updated rows did not — the column was stale. The team added the trigger later, but for 6 weeks, "Python" search missed experts who had recently updated their bio to include Python. **Triggers are not optional.**
- **The non-concurrent index on a 1M-row table**: A team ran `CREATE INDEX idx_... ON experts (...)` against a 1M-row table. The build took 4 minutes. During those 4 minutes, the table was locked; all reads blocked. **Always use `CONCURRENTLY` on populated tables, even if it means the migration can't be in a transaction.**
- **The infinite recursive CTE**: A category admin clicked "Move" twice. The category ended up with `parent_id = self`. The search query for that category's subtree never returned. The connection pool filled. **The cycle-prevention trigger is not optional.**

---

## 16. Business-stakeholder translation

Six Q&A pairs you'll get from a non-engineering stakeholder.

**Q: Why is the search page the only public endpoint?**

Because search is your acquisition channel. The user lands on the search page, types a query, finds an expert, and signs up to book. A "login to search" wall stops the funnel. **The search endpoint is anonymous by design; everything else (booking, messaging) requires auth.**

**Q: Why are unverified experts in the default results? Shouldn't we hide them?**

"Unverified" means "we haven't checked their credentials yet". A user who has been on the platform for a year and has 200 reviews but is "unverified" is a fine result. Hiding them penalizes a long-tenured expert for an admin's backlog. **We rank verified higher, but we don't hide unverified.**

**Q: Why is the search slow sometimes?**

Two reasons:
- Cold cache (Lesson 50 adds caching). The first query after deploy is slow; subsequent are fast.
- Complex query (text + multiple filters + facets). The lesson's design is tuned for 10k experts; 100k+ requires Elasticsearch.

For a marketplace of 10k experts, p95 < 200ms is the target. We hit it.

**Q: How do we know the search is "good"?**

- **Click-through rate**: % of search results the user clicks. Industry average is 30-40%. We're at 35% in our seed data.
- **Booking rate**: % of clicked experts who get booked. Target > 5%.
- **Zero-result rate**: % of searches that return 0 results. Target < 10%. We use the suggestion engine to lower this.
- **p95 latency**: target < 200ms. We log this per request.

**Q: Can we show "experts near me"?**

The schema has `office_address` (text), not `location` (point). Lesson 50 adds a `location` column with PostGIS or a `(lat, lon)` pair, and a `ST_DWithin` query for "within 50km". For the MVP, `office_address ILIKE '%Dhaka%'` is the substitute.

**Q: Why is the per_page cap 50?**

Three reasons:
- Database load: 50 rows fits in a single screen. Users don't need more.
- Network: a 50-row response is < 100KB. A 1000-row response is 2MB.
- Business: we want users to filter, not browse. A 1000-row response says "we don't know what you want" — a 50-row response says "here are the top 5 matches; refine to see more".

**Q: Can we add a "featured" badge to certain experts?**

Yes — add a `featured_at` timestamp column. In the score expression, add `+ 0.5 IF featured_at IS NOT NULL`. The lesson's additive scoring makes this a one-line change. **The lesson's design is intentionally extensible.**

**Q: How do we add a new language (e.g., Spanish)?**

Add a row to `languages` table. The `search_tsv` doesn't include languages. If you want to search by language, either:
- Add language names to the tsvector trigger.
- Add a new filter param `?language_id=N` to the main search.

The lesson's `languages` filter (the `IN (...)` clause) is already there; you just need a UI for it.

---

## 17. Pre-ship checklist

- [ ] `synchronize: false` in `app.module.ts`.
- [ ] `synchronize: false` confirmed in the e2e test config.
- [ ] `pg_trgm` extension enabled in the migration.
- [ ] `search_tsv` column added (with `select: false` on the entity).
- [ ] `bayesian_rating` column added.
- [ ] `fee_min`, `fee_max`, `fee_currency`, `fee_unit`, `is_remote`, `availability_status`, `office_address`, `status` columns exist (audit found they were missing from entity).
- [ ] Triggers `trg_experts_search_tsv_update` and `trg_profiles_search_tsv_propagate` created.
- [ ] Backfill migration runs successfully against the existing data.
- [ ] All 8 indexes created (`idx_experts_search_tsv`, `idx_experts_category_status_rating`, `idx_experts_verified_active`, `idx_experts_status_bayesian`, `idx_profiles_fullname_trgm`, and 4 reverse-direction M:N indexes).
- [ ] `EXPLAIN ANALYZE` on the main query shows index scans, not seq scans.
- [ ] Cycle-prevention trigger on `categories` is in place (Lesson 03).
- [ ] `SearchModule` registered in `app.module.ts`.
- [ ] `@Throttle` limits set to 60/min and 120/min.
- [ ] `@Public()` decorator on the search and suggest endpoints.
- [ ] `ValidationPipe` is global (Lesson 20's main.ts setup).
- [ ] `forbidNonWhitelisted: true` is set on the global pipe.
- [ ] `per_page` cap is 50.
- [ ] `escapeLike` is applied to all user strings before ILIKE.
- [ ] All 9 e2e tests pass.
- [ ] `search.experts.slow` is alerted on.
- [ ] `pg_stat_statements` is enabled.
- [ ] `requestId` is logged on every search response.
- [ ] The response DTO does NOT include `email`, `phone`, `passwordHash`, `tokenVersion`, or any PII.
- [ ] The seed data covers: verified, unverified, multiple categories, multiple languages, multiple organizations, realistic rating distributions.
- [ ] A runbook for "search returns 0 results" exists.
- [ ] A runbook for "search is slow" exists.
- [ ] A runbook for "recursive CTE infinite loop" exists.
- [ ] A runbook for "facet counts are wrong" exists.
- [ ] The suggestion endpoint is debounced in the frontend (Lesson 50 concern, but verify).
- [ ] No `console.log` in the service.

---

## 18. Self-check before Lesson 50

1. Walk me through the SQL plan for `GET /search/experts?q=luna&category_id=1&verified=verified&min_rating=4.5`. Which index is used for `WHERE`, which for `ORDER BY`?
2. Why do we keep `search_tsv` in sync via triggers rather than recomputing on every read?
3. What's the cost of `pg_trgm`'s `similarity()` function, and when is it worth using vs. just `ILIKE`?
4. Why does the facets query *exclude* the `qualifications` filter even when computing counts for qualification facets?
5. Why is `LIMIT 20` hard-coded for facets, and why is the cap 20?
6. Why is the `category_id` filter implemented as a recursive CTE rather than `category_id = $1`?
7. The query returns `total_results` from a parallel `COUNT(*)`. What happens if `OFFSET` is very large? When is this slow?
8. Why does `computeSuggestions` call `this.search(relaxed)` and not just count rows?
9. When would you migrate from `tsvector` to Elasticsearch? List two symptoms.
10. Why is `suggest` endpoint rate-limited higher (`120/min`) than `experts` (`60/min`)?
11. Why do we use `'simple'` config instead of `'english'` for the tsvector on names?
12. Why is `search_tsv` populated by trigger rather than by generated column?
13. What is the difference between the `tsvector` `@@` operator and the `pg_trgm` `%` operator, and when does the query use each?
14. Why does the response include `subcategory_name` and not the full category path?
15. Why is the suggestions loop capped at 3 results?
16. Why is `OFFSET 0` translated from `?page=1` and not from `?page=0`?
17. Why is the categories tree endpoint `Public` and not behind auth?
18. What does the Bayesian rating normalize to when `review_count = 0`?
19. Why does the count query join `profiles` even though we don't filter on profile columns?
20. What happens if the user paginates past the last page (e.g., page 1000 of a 5-page result set)?

If you can answer all twenty with specifics from the SQL, you're production-ready. **Lesson 50 is the cross-cutting polish.**

---

## 19. What we just enabled for Lesson 50

We have a working search. The pieces Lesson 50 will polish:

- **Caching**: Redis-backed, 60s TTL, request coalescing. The lesson's `cache_hit` log line is in place; the cache layer itself is the next step.
- **CAPTCHA on the typeahead**: a bot that hits `/search/suggest` 120/min is doing typeahead at 2x human speed. A CAPTCHA challenge after 60 calls in a minute stops the bot.
- **Geo search**: `location` as a `(lat, lon)` pair with `ST_DWithin`. The `office_address` text fallback is the lesson's MVP.
- **Multi-language tsvector**: `to_tsvector('english', bio)` AND `to_tsvector('spanish', bio)`. The schema's `bio` is one column; multi-language means either two columns or a `jsonb` of `{ en, es, ... }`.
- **ML ranking**: an `experts_ranking_signals` table populated by user behavior (clicks, bookings, dwell time). The score expression in Lesson 30 has room for a fourth term.
- **Saved searches and alerts**: "Notify me when a new expert in 'Python' signs up." The query is the lesson's; the notification system is new.
- **Admin tool for category cycle detection**: a UI to find and fix cycles. The trigger prevents them, but admins need a way to *find* them when the trigger fires.

Lesson 50 is the polish. Search itself is feature-complete.
