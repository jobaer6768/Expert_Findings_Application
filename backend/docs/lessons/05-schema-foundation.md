# Lesson 05 — Schema Foundation: Fix the Bones Before Building on Them

> **What you'll get:** a refactored `User` entity, a brand-new `Profile` entity, a redesigned `Otp` entity that supports resend and brute-force protection, Google OAuth fields, and migrations that replace `synchronize: true`. After this lesson, the foundation can carry Lessons 10 and 30 without surprises, and you can defend the schema choices to a security auditor, a DBA, and a non-technical stakeholder.
>
> **Why this lesson exists:** the current schema has three latent bugs — the `Otp` relation is `OneToOne` (a user can never resend), there is no `Profile` entity yet (where will the user's name and phone live?), and `synchronize: true` will silently drop columns when we rename them. We fix all three before we build auth on top. But the bigger reason this lesson matters: the choices here propagate to every later lesson. A `User` table without `tokenVersion` means your refresh-token story needs a workaround. A `User` table with `email` as `varchar` instead of `citext` means duplicate accounts and a support nightmare. An `Otp` table without `code_hash` means a DB leak hands out active tokens. This lesson is the foundation everything else builds on.
>
> **Prerequisites:** Lessons 02, 03, and 04. You must be fluent with 1:1, 1:N, M:N, the `onDelete` matrix, FK indexing, the `*AndSelect` vs `relations` choice, and the `EXPLAIN` reading habit.

---

## 1. Goal

By the end of this lesson:

- `User` is correct: roles, status, verified flag, Google linking, refresh-token version counter, `citext` email.
- `Profile` is a 1:1 extension of `User` for non-auth PII (name, phone, photo, bio, address).
- `Otp` is a 1:N history of codes per user, with `purpose`, `expiresAt`, `attempts`, `lastSentAt`, and a hashed code column.
- All changes are in a **migration**, not auto-applied by TypeORM.
- `synchronize: false`. The dev DB is brought up by `migration:run`.
- `EXPLAIN` shows we have an index on `users(email)`, `otp(user_id, purpose, expires_at)`, `profiles(user_id)`.
- You can defend each choice to a security auditor (citext + select:false + bcrypt OTP + GDPR), a DBA (indexes + FK constraints + migration safety), and a stakeholder (cost, time, business risk).

---

## 2. Why this matters — the three latent bugs and the business cost

The current state of `backend/src/` is not production-ready. The bugs are silent, and they will bite you at the worst possible time.

### 2.1 The current state — what your code looks like today

Looking at the actual files:

**`backend/src/otp/entities/otp.entity.ts`** has `@OneToOne(() => User)` with no inverse side. The "resend OTP" feature cannot work.

**`backend/src/app.module.ts`** has `synchronize: true` (line 48) and `logging: true` (line 49). The first one is a data-loss bug; the second is a PII leak vector (full query logs to console, including password hashes and OTPs in dev).

**There is no `Profile` entity.** Where does the user's name live? On `User` (mixing PII with auth)? Not yet decided.

**`backend/src/data-source.ts`** has `synchronize: false` — good — but uses a glob `'src/**/*.entity.ts'` which means new entities are picked up automatically. That works, but explicit listing is safer (Lesson 50 covers why).

**`backend/package.json`** has `migration:run` but no `migration:revert`, `migration:generate`, or `migration:create`. You can't undo a bad migration in dev. We'll add these.

**`bcrypt` is not in dependencies.** You can't hash passwords or OTPs. Lesson 10 will need this; we install it now so the schema is ready.

### 2.2 Bug 1 — `Otp` is `OneToOne` to `User`

**Current code** (`backend/src/otp/entities/otp.entity.ts`):

```ts
@OneToOne(() => User)
@JoinColumn({ name: 'user_id' })
user: User;
```

This means **one user can have at most one OTP row, ever**. Your spec says:

> "If he didn't received the OTP he can request for `resend OTP` but he will have to wait for 1 minute."

The resend flow needs to either (a) update the existing row's `expiresAt` and `oneTimeCode`, or (b) insert a new row and look at the most recent one. Option (b) is what every production system does, because it keeps an audit trail of how many OTPs were issued, when, and how many were tried. With `OneToOne`, you either lose history or you have to fake it with timestamps. We're picking the right model.

**The business cost of the bug:** A user requests an OTP, doesn't receive it (email delay), requests a resend. With the current `OneToOne`, the resend updates the same row. The user enters the first code; the verification fails because the row now has the second code. The user is locked out. They contact support. You refund their frustration by hand. The fix is `ManyToOne` with a history.

**The security cost of the bug:** Without `attempts` and `maxAttempts` on the OTP, an attacker can brute-force the 6-digit code. There are only 10⁶ possibilities; at 100 attempts/second, the code is found in 3 hours. With `attempts` capped at 5 and a 15-minute lockout, the same attack takes 3 years. Lesson 10 will use these columns.

**The compliance cost of the bug:** Without `code_hash`, a DB leak hands out active OTPs. With bcrypt cost 10, a leaked DB doesn't give an attacker usable codes (they'd need to brute-force bcrypt on each guess, which is the same 3-hour → 3-year improvement).

### 2.3 Bug 2 — No `Profile` entity

Your `Expert Finding.md` says:

> "After successful login or registration the user will be redirected to `profile page`. where he will fill up or input his personal information."

We need somewhere to store name, phone, photo, address. Two options:

- **Put it all on `User`.** Fast to start, slow forever. Every PII column mixes with auth columns; password resets accidentally email the phone number; you can't `select: false` name without breaking the JWT.
- **1:1 extension.** `Users` = auth identity. `Profiles` = public PII. They can be `select`-ed, `delete`-d, and audited independently. This is what `er-2.drawio` says; we honor the diagram.

**The business cost:** If PII is on `User`, every `SELECT *` returns name, phone, address, and (if you're not careful) password hash. The fix for each leak is a refactor of the API. With the 1:1 split, the leak is contained: `User` queries return auth data only; `Profile` queries return PII only.

**The GDPR cost:** Article 17 (right to be forgotten) requires you to delete PII on request. If PII is on `User`, deleting a user deletes their auth too — they can't log in. With the split, you delete `Profile` and the user is still authenticatable. The GDPR workflow in Lesson 03 §5.4 depends on this.

**The performance cost:** A login query is `SELECT * FROM users WHERE email = $1`. With 10 PII columns, that's a 1KB row. With 2 auth columns, that's a 200B row. At 10k logins/minute, the difference is 80MB/min of unnecessary I/O.

### 2.4 Bug 3 — `synchronize: true`

Read the TypeORM docs in one paragraph: when `synchronize: true`, every time the app starts, TypeORM looks at your entities, compares to the DB schema, and runs `ALTER TABLE` to "fix" the differences. It sounds helpful. It is a **production incident waiting to happen**.

Real failure: you rename `Otp.oneTimeCode` to `Otp.codeHash`. On the next deploy, TypeORM drops the column with the data, then adds the new one. Every existing OTP is lost. Every user in mid-verification is locked out. You didn't even run a query.

**The business cost:** A bad deploy corrupts the schema. Recovery requires restoring from backup, which is downtime. The fix is `synchronize: false` plus migrations. Lesson 50 covers the deploy pipeline that catches missing migrations in CI.

**The `logging: true` cost:** Your `app.module.ts` has `logging: true`, which logs every query to the console. In dev, this includes `SELECT * FROM users WHERE email = $1` with the parameters bound — including the email. In prod, full query logging is too noisy and can leak PII to log aggregators. Set `logging: ['error', 'warn']` in prod.

Migrations are explicit, reviewable, replayable, and reversible. There is no world in which `synchronize: true` is acceptable on a long-lived DB. We turn it off today.

---

## 3. Concepts

### 3.1 The OTP model: history vs. single-row

A typical OTP table stores rows like:

```text
id | user_id | purpose      | code_hash           | expires_at         | attempts | last_sent_at
1  | 42      | VERIFICATION | $2a$10$abc...       | 2026-01-01 12:05   | 0        | 2026-01-01 12:00
2  | 42      | VERIFICATION | $2a$10$def...       | 2026-01-01 12:06   | 1        | 2026-01-01 12:01   ← resend
3  | 42      | PASS_RESET   | $2a$10$ghi...       | 2026-01-03 09:00   | 0        | 2026-01-03 08:55   ← different purpose
```

To find the "current OTP" for a user, you query:

```sql
SELECT * FROM otp
WHERE user_id = $1
  AND purpose = $2
  AND expires_at > now()
  AND used_at IS NULL
ORDER BY last_sent_at DESC
LIMIT 1;
```

The `code_hash` is `bcrypt(code, cost 10)`. **Do not store OTPs in cleartext.** If your DB leaks, attackers shouldn't get free tokens for active sessions.

**The bcrypt cost decision:** Cost 10 takes ~100ms per verify on modern hardware. Cost 12 takes ~400ms. For an OTP that the user has 5 minutes to enter, 100ms is fine. For a password that the user types once per session, 400ms is also fine. We use cost 10 for OTPs to keep the resend flow snappy; cost 12 for passwords (defense in depth).

### 3.2 The `Profile` model: 1:1 extension

The cardinal rule: `User` = "who can log in", `Profile` = "what they look like to other users". This separation lets you:

- `select: false` the password hash and never accidentally leak it in a `SELECT *`.
- Soft-delete a profile without deleting auth.
- Have multiple profiles later (personal + business) if your product evolves — without redesigning `User`.

The `User.profile` field is the inverse side; `Profile.user` is the owning side with `unique: true`. If you ever see "duplicate key value violates unique constraint" on `profiles_user_id_key`, a bug already let two profiles in. Add a unique index in the migration defensively.

### 3.3 Migration anatomy

A TypeORM migration is a class with `up` and `down`:

```ts
export class AddProfile1700000000002 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(/* ... */);
  }
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable(/* ... */);
  }
}
```

The `down` method **must** undo `up`. If you can't write `down`, you have a non-reversible change — and you should think twice about doing it.

A migration is run with:

```bash
npm run migration:run
```

Reversed with:

```bash
npm run typeorm -- migration:revert -d src/data-source.ts
```

In CI we run `migration:run` before tests start, against an ephemeral Postgres. The `down` is only used in dev when you broke something.

**The migration is a deployable artifact.** It goes through code review. It runs in the same transaction as the deploy (or in a controlled multi-step migration for non-transactional changes like `CREATE INDEX CONCURRENTLY`). It can be rolled back if the deploy fails.

### 3.4 Refresh tokens — quick aside (full details in Lesson 20)

To support refresh-token rotation, we need a place to store *hashed* refresh tokens. A common pattern: a `refresh_tokens` table with `(id, user_id, hash, expires_at, revoked_at, replaced_by)`. On every refresh we mint a new row, mark the old one `revoked_at`, set `replaced_by = new_id`. If a `revoked_at` token is ever presented again, we **revoke the entire chain** — this is reuse-detection, and it's how you respond to a stolen refresh token.

We don't need to build it yet, but we *do* need a slot in `User` for a refresh-token version counter (`tokenVersion`) so we can mass-logout a user without iterating their tokens.

---

## 4. Decision points

### 4.1 OTP code hashing: bcrypt or SHA-256?

- **bcrypt cost 10.** ~100ms per verify on modern hardware. Pros: you already use bcrypt for passwords; reuse expertise. Cons: 6-digit OTP has only 10⁶ possibilities; bcrypt's slow hash limits brute force even if DB is leaked.
- **HMAC-SHA256 with a server-side pepper.** Faster, but you lose bcrypt's natural slow-down.
- **Plain SHA-256.** Catastrophic. 6-digit codes can be brute-forced offline in seconds.

**We use bcrypt cost 10 for OTPs.** Consistent with passwords, brute-force-bounded.

**The attack math:** Without hashing, an attacker who steals the DB tries all 10⁶ codes against the verification endpoint. At 100 attempts/second, the code is found in 3 hours. With bcrypt cost 10, each verify takes 100ms. At 100 attempts/second... wait, the attacker is hitting the endpoint, not the DB. The endpoint takes 100ms per verify (because bcrypt is slow). At 10 attempts/second, the attacker covers all 10⁶ codes in 100,000 seconds = 28 hours. The 5-attempt cap on `attempts` makes this moot: after 5 wrong attempts, the OTP is locked. The attacker would need 200,000 different users' OTPs to brute-force one in a reasonable time.

**With `select: false` on `codeHash`:** Even an attacker with read access to the DB can't see the hashes without explicitly selecting them. Defense in depth.

### 4.2 `Otp.user` relation: `OneToMany` with a `latestOtp` getter, or a separate query?

- **`OneToMany` + explicit `findOne` in service.** What every production system does. Easy to reason about; service owns the "current OTP" rule.
- **A computed `latestOtp` column on `User`.** Faster, but a denormalization you have to keep in sync. We don't.

**Why the explicit query:** The "current OTP" depends on the purpose (`email_verification` vs `password_reset`), the expiration, and the attempt count. Encoding all of this in a column on `User` is a denormalization that will drift. The service-layer query is the source of truth.

### 4.3 Where does the JWT secret live?

- **In env.** Standard. Must be 32+ random bytes; never re-used across environments.
- **In a secret manager.** (AWS Secrets Manager, Vault.) Better. Out of scope for this codebase, but Lesson 50 shows you the hook point.

**The .env.example must say "replace_me", not "secret".** A committed `JWT_SECRET=secret` is a CVE waiting to happen. The example file should make it impossible to ship without generating a real secret.

### 4.4 `tokenVersion` vs deleting refresh tokens on logout

- **`tokenVersion` integer.** On logout, increment. All existing refresh tokens become invalid in O(1). Simple, fast.
- **Mark every refresh token revoked.** Slower; useful when you want a per-device logout.

We use **both**. `tokenVersion` for global logout; per-token revocation for "log out this device only".

**The tokenVersion semantics:** Each JWT includes the user's current `tokenVersion`. On every request, the JWT's `tokenVersion` is compared to the DB's. If they don't match, the token is rejected. To log out all devices, increment `tokenVersion` — all existing JWTs are now stale. To log out one device, mark that specific refresh token as `revoked_at`.

### 4.5 The `citext` decision — case-insensitive email

`varchar` with `lower(email) = $1` works but requires an expression index. `citext` is a Postgres extension that does case-insensitive equality natively, with a regular B-tree index. The choice is:

- **`citext` (recommended).** The DB enforces case-insensitive uniqueness. You don't have to remember to call `lower()` in every query. The index is a normal B-tree on `email`.
- **`varchar` + `lower()` everywhere.** More portable (works on MySQL, SQLite). Slower (every query has a function call). Error-prone (forget `lower()` once, get duplicate accounts).

We use `citext`. The cost is a Postgres extension (one line in the migration). The benefit is correctness by default.

---

## 5. Code (drop-in, in order)

### 5.1 New package dependencies

```bash
npm install bcrypt
npm install -D @types/bcrypt
```

We're using `bcrypt` (not `bcryptjs`) — the native build is faster, and you already have a Node environment that can compile it.

**Why not `bcryptjs`:** It's a pure-JS implementation, slower, and uses more memory. The native `bcrypt` is the production choice.

**Why not `argon2`:** Argon2id is the OWASP recommendation and is more memory-hard. If you want to use it, the change is `import * as argon2 from 'argon2'` and `argon2.hash(code)` / `argon2.verify(hash, code)`. The schema doesn't change. We use bcrypt for consistency with the existing codebase expectation; Lesson 50 can swap it out.

### 5.2 Update `tsconfig.json` (paths + strict)

Open `backend/tsconfig.json`. Confirm `strictNullChecks`, `noImplicitAny`, and `strict` are all on. Add:

```json
{
  "compilerOptions": {
    "baseUrl": "./",
    "paths": {
      "src/*": ["src/*"]
    }
  }
}
```

We'll use `src/...` imports everywhere for readability.

### 5.3 Replace `User` entity

`backend/src/user/entities/user.entity.ts`:

```ts
import { Expert } from 'src/experts/entities/expert.entity';
import { Otp } from 'src/otp/entities/otp.entity';
import { Profile } from 'src/profile/entities/profile.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum UserRole {
  CLIENT = 'client',
  EXPERT = 'expert',
  ADMIN = 'admin',
}

export enum UserStatus {
  ACTIVE = 'active',
  DEACTIVE = 'deactive',
  DELETED = 'deleted',
}

@Entity('users')
@Index('uq_users_email_lower', { synchronize: false }) // added in migration for case-insensitive unique
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  // We use citext on the column (added in migration) so equality is case-insensitive.
  @Column({ type: 'citext', unique: true })
  email: string;

  @Column({ type: 'varchar', name: 'pass_hash', select: false, nullable: true })
  passwordHash: string | null;

  // OAuth linking — null until the user goes through Google at least once.
  @Column({ type: 'varchar', name: 'google_id', nullable: true, unique: true })
  googleId: string | null;

  @Column({ type: 'citext', name: 'google_email', nullable: true })
  googleEmail: string | null;

  @Column({ type: 'enum', enum: UserRole, default: UserRole.CLIENT })
  role: UserRole;

  @Column({ type: 'enum', enum: UserStatus, default: UserStatus.ACTIVE })
  status: UserStatus;

  @Column({ type: 'boolean', name: 'is_email_verified', default: false })
  isEmailVerified: boolean;

  // Incremented on global logout (e.g. password reset, "log out all devices").
  @Column({ type: 'int', name: 'token_version', default: 1 })
  tokenVersion: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  // ---------- relations ----------

  @OneToOne(() => Profile, (p) => p.user)
  profile?: Profile;

  @OneToOne(() => Expert, (e) => e.user)
  expert?: Expert;

  @OneToMany(() => Otp, (o) => o.user)
  otps?: Otp[];
}
```

**Decision notes for the entity above:**

- `email` is `citext`, not `varchar`. We'll enable the extension in the migration. Why? `"Foo@x.com"` and `"foo@x.com"` are the same address; case-insensitive uniqueness should live in the DB, not in the app.
- `passwordHash` is `nullable: true` because OAuth-only users have no password.
- `googleId` is `unique: true`. This enforces the invariant: "each Google account maps to at most one user". Without it, two users could share a Google login.
- `tokenVersion` is your global logout switch. Lesson 20 explains why.
- `isEmailVerified` is `boolean` not `tinyint`. Postgres booleans are fine.
- We don't put `name` or `phone` here — that's the `Profile`.

**The `UserRole.ADMIN` addition:** Your current entity has `CLIENT` and `EXPERT`. We add `ADMIN` because Lesson 20 (admin endpoints) needs it. If you skip it now, you'll add it later as a migration — which is fine, but doing it now is one line.

### 5.4 Create `Profile` entity

`backend/src/profile/entities/profile.entity.ts`:

```ts
import { User } from 'src/user/entities/user.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('profiles')
export class Profile {
  @PrimaryGeneratedColumn()
  id: number;

  @Index('uq_profiles_user_id', { unique: true })
  @Column({ type: 'int', name: 'user_id', unique: true })
  userId: number;

  @OneToOne(() => User, (u) => u.profile, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ type: 'varchar', length: 80, nullable: true })
  fullName: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  phone: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'photo_url' })
  photoUrl: string | null;

  @Column({ type: 'text', nullable: true })
  address: string | null;

  @Column({ type: 'date', nullable: true, name: 'date_of_birth' })
  dateOfBirth: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
```

**Why two declarations of `user_id`?**

I used both `@Index('uq_profiles_user_id', { unique: true })` on the column decorator *and* `@Column({ ..., unique: true })`. This is belt-and-braces. The `@Index` decorator adds an explicit named index (which we can also write in the migration), and the `unique: true` on the column tells TypeORM's metadata. In a perfect world you'd pick one — but in the world of TypeORM migrations, the redundancy survives renames better.

**The `dateOfBirth` type:** `date` (not `timestamptz`). A date of birth has no time component. Storing it as `timestamptz` wastes 8 bytes per row and confuses the API (does the user mean midnight UTC? their local midnight?). Use `date`.

### 5.5 Rewrite `Otp` entity

`backend/src/otp/entities/otp.entity.ts`:

```ts
import { User } from 'src/user/entities/user.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum OtpPurpose {
  EMAIL_VERIFICATION = 'email_verification',
  PASSWORD_RESET = 'password_reset',
}

@Entity('otp')
@Index('idx_otp_user_purpose_expires', ['user', 'purpose', 'expiresAt'])
export class Otp {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => User, (u) => u.otps, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ type: 'enum', enum: OtpPurpose })
  purpose!: OtpPurpose;

  // bcrypt hash, never the cleartext code.
  @Column({ type: 'varchar', length: 80, name: 'code_hash', select: false })
  codeHash!: string;

  @Column({ type: 'timestamp', name: 'expires_at' })
  expiresAt!: Date;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'int', default: 5, name: 'max_attempts' })
  maxAttempts!: number;

  @Column({ type: 'timestamp', nullable: true, name: 'used_at' })
  usedAt!: Date | null;

  @Column({ type: 'timestamp', name: 'last_sent_at' })
  lastSentAt!: Date;

  // IP that requested the OTP — useful for abuse signals. NOT for auth.
  @Column({ type: 'inet', nullable: true, name: 'request_ip' })
  requestIp!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
```

**Why these columns?**

- `codeHash` is `select: false`. If you ever `SELECT *` for debugging, you won't accidentally read or log the hash.
- `purpose` lets the same user have a verification OTP *and* a password-reset OTP in flight at once. We will *never* check one against the other.
- `attempts` and `maxAttempts` enforce the brute-force lockout. Increment before comparing; on `>= maxAttempts` mark `usedAt` and refuse.
- `lastSentAt` powers the 60-second resend cooldown.
- `requestIp` is informational. If the same IP requests 100 OTPs for 100 different emails, your mail service is being abused; you'll see it here.

**The `inet` type for IP:** Postgres has a native `inet` type that validates IP addresses and supports CIDR queries (`WHERE request_ip << '192.168.1.0/24'`). Use it instead of `varchar`. If you ever need to do "find all OTPs from this /24", the `inet` type makes it a single index lookup.

**The `usedAt` semantics:** `NULL` means unused. A non-null `usedAt` means consumed. The query for "the current OTP" is `WHERE used_at IS NULL AND expires_at > now()`. When the user verifies, set `usedAt = now()`. This is a soft-delete pattern for the OTP itself; it preserves the audit trail.

### 5.6 Create the `Profile` module skeleton

We don't have controllers for `Profile` in this lesson (Lesson 10 adds them when auth needs them). For now, just a module that registers the entity:

`backend/src/profile/profile.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Profile } from './entities/profile.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Profile])],
  exports: [TypeOrmModule],
})
export class ProfileModule {}
```

### 5.7 Update `app.module.ts` to register the new entity, disable `synchronize`, register the new module

`backend/src/app.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CategoriesModule } from './categories/categories.module';
import { Category } from './categories/entities/category.entity';
import { Language } from './languages/entities/language.entity';
import { LanguagesModule } from './languages/languages.module';
import { Organization } from './organizations/entities/organization.entity';
import { OrganizationsModule } from './organizations/organizations.module';
import { Otp } from './otp/entities/otp.entity';
import { OtpModule } from './otp/otp.module';
import { Price } from './prices/entities/price.entity';
import { PricesModule } from './prices/prices.module';
import { Qualification } from './qualifications/entities/qualification.entity';
import { QualificationsModule } from './qualifications/qualifications.module';
import { User } from './user/entities/user.entity';
import { UserModule } from './user/user.module';
import { ExpertsModule } from './experts/experts.module';
import { Expert } from './experts/entities/expert.entity';
import { Profile } from './profile/entities/profile.entity';
import { ProfileModule } from './profile/profile.module';
import { DataSource } from 'typeorm';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      imports: [],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get<string>('DB_HOST', 'localhost'),
        port: configService.get<number>('DB_PORT') || 5432,
        password: configService.get<string>('DB_PASS', ''),
        username: configService.get<string>('DB_USER', 'postgres'),
        entities: [
          Organization,
          Category,
          Qualification,
          Price,
          User,
          Otp,
          Language,
          Expert,
          Profile,
        ],
        database: configService.get<string>('DB_NAME', 'expert-finder'),
        synchronize: false,                        // ← was true
        logging: configService.get<string>('NODE_ENV') !== 'production',
      }),
      dataSourceFactory: async (options) => {
        const ds = new DataSource(options);
        return ds.initialize();
      },
    }),
    OrganizationsModule,
    CategoriesModule,
    QualificationsModule,
    PricesModule,
    LanguagesModule,
    UserModule,
    OtpModule,
    ExpertsModule,
    ProfileModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
```

**The `logging` change:** `logging: configService.get<string>('NODE_ENV') !== 'production'` means dev logs queries, prod doesn't. If you want error-only logging in prod, use `logging: ['error', 'warn']` instead. The boolean form logs everything including parameters; the array form is selective.

### 5.8 Wire up a `data-source.ts` so migrations can be run from the CLI

`backend/src/data-source.ts`:

```ts
import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { DataSource } from 'typeorm';
import { Category } from './categories/entities/category.entity';
import { Expert } from './experts/entities/expert.entity';
import { Language } from './languages/entities/language.entity';
import { Organization } from './organizations/entities/organization.entity';
import { Otp } from './otp/entities/otp.entity';
import { Price } from './prices/entities/price.entity';
import { Profile } from './profile/entities/profile.entity';
import { Qualification } from './qualifications/entities/qualification.entity';
import { User } from './user/entities/user.entity';

loadEnv();

export default new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USER ?? 'postgres',
  password: process.env.DB_PASS ?? '',
  database: process.env.DB_NAME ?? 'expert-finder',
  entities: [
    User,
    Profile,
    Otp,
    Category,
    Expert,
    Language,
    Organization,
    Price,
    Qualification,
  ],
  migrations: ['src/migrations/*.ts'],
  migrationsTableName: 'migrations',
  synchronize: false,
  logging: false,
});
```

**Why explicit entity listing vs glob:** Your current `data-source.ts` uses `entities: ['src/**/*.entity.ts']`. This works but has a subtle bug: if a new entity file is added but not in the glob path, it's silently skipped. Explicit listing catches this at TypeScript compile time. Use explicit listing for production.

### 5.9 The initial migration

This is where the schema actually changes. We're going to do this as one large migration so you can see the whole picture at once. In Lesson 50 you'll learn to split per change; for now, one migration that fixes the existing entities is the right granularity.

`backend/src/migrations/1700000000000-initial.ts`:

```ts
import { MigrationInterface, QueryRunner } from 'typeorm';

export class Initial1700000000000 implements MigrationInterface {
  name = 'Initial1700000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Required extensions
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS citext;`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`); // for gen_random_uuid()

    // 2. Fix the users table — add columns if they don't exist
    await queryRunner.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS google_id varchar(255),
        ADD COLUMN IF NOT EXISTS google_email citext,
        ADD COLUMN IF NOT EXISTS token_version int NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS is_email_verified boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
        ALTER COLUMN email TYPE citext USING email::citext,
        ALTER COLUMN pass_hash DROP NOT NULL;
    `);

    // 3. Case-insensitive uniqueness on email
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email_lower ON users (lower(email));
    `);

    // 4. Google ID uniqueness (NULL allowed multiple times via COALESCE)
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_users_google_id ON users (google_id)
      WHERE google_id IS NOT NULL;
    `);

    // 5. Create profiles table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS profiles (
        id              bigserial PRIMARY KEY,
        user_id         int NOT NULL UNIQUE,
        full_name       varchar(80),
        phone           varchar(32),
        photo_url       varchar(255),
        address         text,
        date_of_birth   date,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT fk_profiles_user FOREIGN KEY (user_id)
          REFERENCES users(id) ON DELETE CASCADE
      );
    `);

    // 6. Rebuild otp table — the old OneToOne was a dead end.
    // Drop old FK if it exists; old shape was (id, user_id [unique], otp_type, one_time_code, expires_at).
    await queryRunner.query(`ALTER TABLE IF EXISTS otp DROP CONSTRAINT IF EXISTS fk_otp_user;`);
    await queryRunner.query(`DROP INDEX IF EXISTS uq_otp_user_id;`);

    // Add new columns, keeping the data we can.
    await queryRunner.query(`
      ALTER TABLE otp
        ADD COLUMN IF NOT EXISTS purpose otp_purpose_enum,
        ADD COLUMN IF NOT EXISTS code_hash varchar(80),
        ADD COLUMN IF NOT EXISTS attempts int NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS max_attempts int NOT NULL DEFAULT 5,
        ADD COLUMN IF NOT EXISTS used_at timestamptz,
        ADD COLUMN IF NOT EXISTS last_sent_at timestamptz NOT NULL DEFAULT now(),
        ADD COLUMN IF NOT EXISTS request_ip inet,
        ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_otp_user_purpose_expires
      ON otp (user_id, purpose, expires_at DESC);
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_otp_active
      ON otp (user_id, purpose)
      WHERE used_at IS NULL;
    `);

    // 7. Make sure the otp_purpose_enum exists
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'otp_purpose_enum') THEN
          CREATE TYPE otp_purpose_enum AS ENUM ('email_verification', 'password_reset');
        END IF;
      END$$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // We accept that dropping the schema is fine in dev. In production you'd
    // write a more careful down that preserves data.
    await queryRunner.query(`DROP TABLE IF EXISTS otp;`);
    await queryRunner.query(`DROP TABLE IF EXISTS profiles;`);
    await queryRunner.query(`DROP INDEX IF EXISTS uq_users_google_id;`);
    await queryRunner.query(`DROP INDEX IF EXISTS uq_users_email_lower;`);
    await queryRunner.query(`
      ALTER TABLE users
        DROP COLUMN IF EXISTS google_id,
        DROP COLUMN IF EXISTS google_email,
        DROP COLUMN IF EXISTS token_version,
        DROP COLUMN IF EXISTS updated_at;
    `);
    await queryRunner.query(`DROP TYPE IF EXISTS otp_purpose_enum;`);
  }
}
```

**Notice five things:**

1. **Idempotency.** `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`. Running the migration twice doesn't break.
2. **Partial unique index.** `WHERE google_id IS NOT NULL` lets many rows have `NULL` google_id (the default), but the moment one is set, it must be unique. Postgres partial indexes are how you do nullable-uniqueness.
3. **`citext` extension.** Case-insensitive text type. We didn't want `"Bob@x.com"` and `"bob@x.com"` to be two accounts.
4. **`ON DELETE CASCADE`** on `profiles.user_id`. Deleting a user nukes their profile. Lesson 10 will set up the same for `otp.user_id` and `experts.user_id`.
5. **Enum type created with `DO $$ ... $$;`.** Postgres doesn't have `CREATE TYPE IF NOT EXISTS` directly; this is the standard guard pattern.

**The `ALTER COLUMN email TYPE citext` order:** This runs in the same `ALTER TABLE` statement as the `ADD COLUMN`s, but Postgres applies them in order. The `TYPE` change happens after the `ADD COLUMN`s. If you do `ADD COLUMN ... email citext` (a new column) and `ALTER COLUMN email` (the existing column), the order matters because Postgres validates FKs and indexes at the end of each statement.

**The `bigserial` choice for `id`:** `bigserial` is `bigint` with auto-increment. At 1 billion users, `serial` (int) overflows. `bigserial` doesn't. The cost is 8 bytes per row instead of 4. For 1M users, that's 4MB of extra storage — trivial. Use `bigserial` for all primary keys unless you have a measured reason not to.

### 5.10 Add a `.env.example` (never commit `.env`)

`backend/.env.example`:

```env
NODE_ENV=development
PORT=3000

# Postgres
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASS=postgres
DB_NAME=expert-finder

# Auth secrets — replace with 32+ random bytes in production:
#   node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
JWT_ACCESS_SECRET=replace_me_access
JWT_REFRESH_SECRET=replace_me_refresh
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=7d

# Google OAuth
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=http://localhost:3000/api/v1/auth/google/callback

# Mail (Lesson 20) — SMTP
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
MAIL_FROM="Expert Finder <no-reply@example.com>"

# Frontend redirect after OAuth (Lesson 20)
FRONTEND_URL=http://localhost:3001
```

**The `.env` rule:** Never commit `.env`. Add `.env` to `.gitignore`. Commit only `.env.example`. The example file should have placeholder values that *obviously* need to be replaced (`replace_me_access`), not values that look real (`my-secret-123`).

### 5.11 Add a script to package.json for running migrations

You already have:

```json
"typeorm": "typeorm-ts-node-commonjs",
"migration:run": "npm run typeorm -- migration:run -d src/data-source.ts"
```

Add:

```json
"migration:revert": "npm run typeorm -- migration:revert -d src/data-source.ts",
"migration:generate": "npm run typeorm -- migration:generate -d src/data-source.ts",
"migration:create": "npm run typeorm -- migration:create"
```

`migration:revert` undoes the last migration. `migration:generate` reads your entities and generates a migration for the diff. `migration:create` makes an empty migration file for you to fill in.

### 5.12 Run the migration against your local Postgres

```bash
# Make sure DB exists
psql -U postgres -c "CREATE DATABASE \"expert-finder\";"

# Run
npm run migration:run
```

You should see a log like:

```
query: SELECT * FROM "migrations" ...
query: CREATE EXTENSION IF NOT EXISTS citext;
...
Migration Initial1700000000000 has been executed successfully.
```

**The migration table:** TypeORM creates a `migrations` table to track what's been run. Never delete rows from this table manually; that's how you get "migration out of sync" errors.

### 5.13 Verify the schema

```bash
psql -U postgres -d expert-finder -c "\d users"
psql -U postgres -d expert-finder -c "\d profiles"
psql -U postgres -d expert-finder -c "\d otp"
```

You should see the new columns, the unique indexes, and the citext type on `email`.

**The `EXPLAIN` verification:** Run `EXPLAIN SELECT * FROM users WHERE email = 'X@Y.com';`. You should see `Index Scan using uq_users_email_lower`. If you see `Seq Scan`, the index wasn't created. Re-run the migration.

---

## 6. Tests

### 6.1 Unit test: ensure `User` entity loads

`backend/src/user/user.entity.spec.ts`:

```ts
import { DataSource } from 'typeorm';
import { User } from './entities/user.entity';

describe('User entity', () => {
  let ds: DataSource;
  beforeAll(async () => {
    ds = new DataSource({
      type: 'sqlite',                       // any in-memory DB
      database: ':memory:',
      dropSchema: true,
      entities: [User],
      synchronize: true,
    });
    await ds.initialize();
  });
  afterAll(() => ds.destroy());

  it('creates a user with default role=client', async () => {
    const repo = ds.getRepository(User);
    const u = repo.create({ email: 'A@x.com' }); // mixed case
    await repo.save(u);
    const found = await repo.findOneByOrFail({ email: 'a@x.com' }); // lower-case
    expect(found.role).toBe('client');
    expect(found.tokenVersion).toBe(1);
    expect(found.isEmailVerified).toBe(false);
  });
});
```

(I'd skip sqlite-vs-postgres testing here in favor of a real testcontainer; Lesson 50 sets this up.)

**The sqlite caveat:** SQLite doesn't support `citext` or `inet`. The test above uses `synchronize: true` to bypass the migration. In production tests (Lesson 50), use a real Postgres testcontainer.

### 6.2 Migration test: verify the up/down round-trip

Lesson 50 will add a CI job that runs the migration against an ephemeral Postgres, asserts the expected schema, then runs `down` and asserts the original. For now, manually:

```bash
npm run migration:revert
psql -U postgres -d expert-finder -c "\d users"
npm run migration:run
```

The schema should be back.

**The CI migration test pattern:**

```ts
// test/migrations.e2e.ts
import { DataSource } from 'typeorm';
import { Test } from '@nestjs/testing';

describe('Migration round-trip', () => {
  it('up then down leaves the schema in the same state', async () => {
    const ds = new DataSource({ /* test config */ });
    await ds.initialize();

    // Capture schema before
    const before = await captureSchema(ds);

    // Run up then down
    await ds.runMigrations();
    await ds.undoLastMigration();

    // Capture schema after
    const after = await captureSchema(ds);

    // Compare (ignore the migrations table itself)
    expect(after).toEqual(before);
  });
});
```

This test catches the "the down migration doesn't reverse the up" bug.

---

## 7. The migration safety patterns

### 7.1 Why you can't trust `synchronize: true`

Already covered in §2.4. The summary: `synchronize: true` drops columns you removed from entities, drops indexes you removed from decorators, doesn't preserve data, runs at startup (corrupts before health check), and often picks the wrong `onDelete` default.

**The Postgres-specific gotcha:** `synchronize: true` doesn't know about Postgres-specific features like `citext`, `inet`, partial indexes, or extensions. It will try to create them and fail. The migration approach lets you write Postgres-specific SQL.

### 7.2 The migration file anatomy

Already covered in §3.3. The summary: every migration has `up` and `down`. The `down` reverses the `up`. If you can't write `down`, the change is non-reversible and needs extra review.

### 7.3 The `CONCURRENTLY` pattern for indexes

Adding an index on a large table locks the table for writes. Use `CONCURRENTLY`:

```sql
CREATE INDEX CONCURRENTLY idx_users_email ON users (lower(email));
```

This takes longer (minutes vs. seconds) but doesn't lock writes. In a migration:

```ts
await queryRunner.query(`CREATE INDEX CONCURRENTLY idx_users_email ON users (lower(email))`);
```

**Important:** `CONCURRENTLY` can't run inside a transaction. TypeORM's `queryRunner.transaction` wraps every query in a transaction. You need to use `queryRunner.query` directly (no transaction wrapper) for `CONCURRENTLY`.

### 7.4 The order of operations for adding a cardinality

When you add a new relationship, the migration order matters:

1. **Create the parent table** (if it doesn't exist).
2. **Create the child table** with the FK column (initially nullable, no constraint).
3. **Backfill the FK** for existing rows.
4. **Add the FK constraint as `NOT VALID`** (so the add is fast).
5. **`VALIDATE CONSTRAINT`** (so the constraint is enforced for new rows).
6. **Add the index `CONCURRENTLY`** (so the index doesn't lock writes).
7. **Set `NOT NULL`** (if applicable, after backfill).

Doing it in the wrong order either fails (FK constraint on a column with NULLs) or locks the table (adding NOT NULL on a large table rewrites the whole table).

### 7.5 The migration is a deployable artifact

A migration goes through code review. It runs in the same deploy as the code that uses it. If the migration fails, the deploy fails and the old code stays. This is the safe order.

**The wrong order:** Deploy the code first (which references a column that doesn't exist), then run the migration. The code crashes on startup, the migration never runs, the deploy is broken. Always run migrations *before* the new code.

**The deploy pipeline pattern (Lesson 50):**

```bash
# 1. Run migrations
npm run migration:run

# 2. Deploy the new code
kubectl apply -f deployment.yaml
```

If step 1 fails, step 2 doesn't run. If step 2 fails, you can revert by running `migration:revert` and redeploying the old code.

---

## 8. The security implications

### 8.1 The PII boundary

Every entity that crosses the PII boundary (auth identity ↔ PII) is a security control. In your schema:

- `Users` = auth identity. Holds `email`, `passwordHash`, `googleId`, `tokenVersion`.
- `Profiles` = PII. Holds `fullName`, `phone`, `address`, `dateOfBirth`, `photoUrl`.

Rules:
- The PII side (`Profile`) is loaded only when needed. Don't `relations: ['profile']` on the `User` query in your auth middleware.
- The PII side uses `select: false` on sensitive columns (phone, address, photo) as belt-and-suspenders.
- The PII side's API responses are DTOs that explicitly list fields, not `classToPlain(entity)`.

### 8.2 The `select: false` defense in depth

`select: false` on `passwordHash` and `codeHash` is one defense. The other is the DTO:

```ts
// user-response.dto.ts
export class UserResponseDto {
  @Expose() id: number;
  @Expose() email: string;
  @Expose() role: UserRole;
  @Expose() isEmailVerified: boolean;
  // NO passwordHash
}
```

Even if `select: false` is removed (refactor, new endpoint), the DTO strips the field. Belt and suspenders.

**The test that catches the leak:**

```ts
it('does not leak passwordHash in the response', async () => {
  const user = await userService.create({ email: 'x@y.com', password: 'secret' });
  const response = await request(app).get(`/users/${user.id}`).expect(200);

  expect(response.body).not.toHaveProperty('passwordHash');
  expect(response.body).not.toHaveProperty('pass_hash');
});
```

### 8.3 The `citext` security angle

Without `citext`, `Bob@x.com` and `bob@x.com` are two accounts. An attacker registers `bob@x.com` first, then sends a password-reset to `Bob@x.com`. The reset link goes to the attacker's email (if the system is buggy) or to the legitimate user's email (if it's not). Either way, the user is confused.

With `citext`, `Bob@x.com` and `bob@x.com` are the same account. No duplicate, no confusion.

**The `citext` gotcha:** The index on `citext` uses the default collation, which is `CASE_INSENSITIVE` for `citext`. The index lookup is fast. But the `lower(email)` index in the migration is for backward compatibility (in case some query forgets the case-insensitive collation).

### 8.4 The bcrypt cost decision

Bcrypt cost 10 takes ~100ms per verify. Cost 12 takes ~400ms. For an OTP, 100ms is fine. For a password, 400ms is also fine (the user types it once per session).

**The attack math:** An attacker who steals the bcrypt hashes tries to crack them offline. At cost 10, they can test ~10 hashes/second on a single core. At 10⁶ possible 6-digit OTP codes, finding the right one takes 100,000 seconds = 28 hours. The 5-attempt cap on the endpoint makes this moot, but the cost is the defense in depth.

**The cost scaling:** As hardware gets faster, increase the cost. The rule of thumb: bcrypt cost should be tuned so a single hash takes ~250ms on the target CPU. This auto-balances as hardware changes.

### 8.5 The `tokenVersion` and JWT invalidation

JWTs are stateless; you can't revoke them. The `tokenVersion` field gives you O(1) invalidation: increment the field, and all existing JWTs are now stale (their embedded `tokenVersion` no longer matches).

**The flow:**

```ts
// On login
const payload = { sub: user.id, tv: user.tokenVersion, role: user.role };
const accessToken = jwt.sign(payload, secret, { expiresIn: '15m' });

// On every request
const decoded = jwt.verify(token, secret);
const user = await userRepo.findOneByOrFail({ id: decoded.sub });
if (user.tokenVersion !== decoded.tv) {
  throw new UnauthorizedException('Token revoked');
}

// On logout-all-devices
await userRepo.increment({ id: userId }, 'tokenVersion', 1);
```

This is the standard pattern. It's O(1) on the server, requires no per-token storage, and handles "log out all devices" in one query.

### 8.6 The GDPR angle

The `Profile` ↔ `User` split is a GDPR control. Article 17 requires you to delete PII on request. With the split:

```ts
async rightToBe Forgotten(userId: number): Promise<void> {
  await this.dataSource.transaction(async (manager) => {
    // 1. Delete PII
    await manager.delete(Profile, { userId });
    // 2. Anonymize auth (keep the user, but remove identifying fields)
    await manager.update(User, { id: userId }, {
      email: `deleted-${userId}@example.com`,
      googleId: null,
      googleEmail: null,
      passwordHash: null,
      isEmailVerified: false,
    });
    // 3. Soft-delete the user
    await manager.softDelete(User, userId);
  });
}
```

The user can no longer log in (email is anonymized, password is null). The PII is gone. The audit log can still reference the user ID without leaking PII. This is the GDPR-compliant path.

---

## 9. Self-check (answer in writing)

1. Why is `OneToOne` from `User` to `Otp` wrong? What does the right model look like?
2. What's the difference between `citext` and `varchar` for the `email` column? Why does it matter for login?
3. Why are we storing `code_hash` instead of the OTP code itself? What does it cost us at verify time?
4. Explain in one sentence why `synchronize: true` is removed in this lesson.
5. What is `tokenVersion` for? When does it increment?
6. Why a **partial unique index** on `google_id` and not a plain `unique`?
7. Why does the migration use `DO $$ BEGIN IF NOT EXISTS ... $$;` for the enum type?
8. If a teammate runs the migration twice by mistake, what happens? (Look at the SQL.) What changes would you make so even an accidental double-run is safe?
9. What is `logging: true` doing in your current `app.module.ts`? Why is it a PII leak risk?
10. Why is `bcryptjs` not the right choice for production? What about `argon2`?
11. What does `select: false` protect against, and what does it NOT protect against?
12. Why is `bigserial` preferred over `serial` for primary keys?
13. What is the GDPR "right to be forgotten" workflow in your schema? Which columns do you delete vs anonymize?
14. Why is `CREATE INDEX CONCURRENTLY` important for large tables? Why can't it run in a transaction?
15. What is the order of operations for adding a new 1:N relationship in a migration? Why does the order matter?
16. Your current `data-source.ts` uses `entities: ['src/**/*.entity.ts']`. What's the risk vs explicit listing?
17. What is `tokenVersion` and how does it give you O(1) JWT invalidation?
18. Why is `inet` preferred over `varchar` for IP addresses?
19. What is the `usedAt` semantic on `Otp`? Why is it better than a hard delete?
20. A security auditor asks "how do you prevent a DB leak from giving attackers active OTPs?". Answer in three sentences.

When you can answer all twenty in two sentences each, go to **Lesson 10**.

---

## 10. Common mistakes I expect you to make

| Mistake                                                                       | What goes wrong                                                | Fix                                                                       |
|-------------------------------------------------------------------------------|----------------------------------------------------------------|---------------------------------------------------------------------------|
| Forgetting `select: false` on `passwordHash` and `codeHash`                   | Hashes get logged, sent to the client, end up in analytics     | Always `select: false` on anything secret                                |
| Using `varchar` for `email`                                                   | `"Bob@x.com"` and `"bob@x.com"` create two accounts           | Use `citext` or store normalized lowercase                                |
| `unique: true` on `googleId` without `WHERE google_id IS NOT NULL`            | First user without Google blocks every subsequent user         | Partial unique index in the migration                                     |
| Renaming a column in the entity without a migration                           | TypeORM silently drops the column on next boot — data lost    | Every schema change goes through a migration                              |
| Skipping the `down` migration                                                 | Can't roll back, dev gets stuck                                | Write `down` even if it's destructive; document it                        |
| Hardcoding `JWT_SECRET=secret` in `.env`                                       | Token forgery if `.env` leaks                                  | 32+ random bytes; never reused across envs                                |
| Adding a column with `default: null` and forgetting `nullable: true`           | Postgres rejects inserts                                       | Match `nullable` to default semantics                                    |
| Leaving `logging: true` in production                                          | Every query (with parameters) goes to the log aggregator       | `logging: ['error', 'warn']` in production                                |
| Running `synchronize: true` "just for the dev DB"                            | The dev DB silently diverges from production; migration fails | `synchronize: false` everywhere                                           |
| Using `bcryptjs` "because it's easier to install"                             | 10x slower; production performance suffers                     | Use native `bcrypt` or `argon2`                                           |
| Setting `cost: 4` on bcrypt "for faster tests"                                | Tests pass; production is crackable in seconds                  | Use `cost: 10` for OTP, `cost: 12` for passwords; never below 10          |
| Putting `name` and `phone` on `User` "to save time"                           | PII leaks; GDPR workflow is impossible                         | Use `Profile`; this is the lesson's entire point                          |
| Storing the OTP in cleartext "we'll hash it later"                            | Later never comes; DB leak hands out active tokens             | Hash from day one                                                         |
| Skipping `select: false` because "the DTO strips it anyway"                    | DTO refactor removes the strip; hash leaks                     | `select: false` AND DTO; belt and suspenders                              |
| `migrations: ['migrations/*.ts']` in `data-source.ts` when migrations are in `src/migrations/` | Migrations not found; `migration:run` does nothing            | Match the path to the actual location                                    |
| `npm run migration:run` without checking the SQL it will run                   | Surprise column drop; data loss                                 | Always read the generated migration before running it                    |
| Using `DROP TABLE` in `down` migration for a prod table                       | `down` works, but you can't roll back without losing data      | `down` for prod should be a no-op or a careful reverse; `DROP` only in dev |

---

## 11. The business-stakeholder translation

**Q: "Why are we changing the OTP table?"**
A: The current model allows only one OTP per user, ever. The "resend OTP" feature requires multiple OTPs with a history. Without this change, a user who doesn't receive the first OTP can't get a second one without manual intervention. The change takes 2 hours and unblocks the resend feature.

**Q: "Why a separate Profile table?"**
A: Three reasons: (1) security — password hashes never leak in API responses because they're on a different table; (2) GDPR — we can delete PII without deleting auth; (3) performance — login queries don't pull PII. The split is one of the most leveraged design decisions in the codebase.

**Q: "Why are we turning off `synchronize: true`?"**
A: It auto-syncs the schema from the code, but it doesn't preserve data. A deploy that removes a column from an entity will drop that column and all its data from production. The 30 minutes we save by not writing migrations is not worth the data loss risk.

**Q: "Why are we hashing the OTP?"**
A: Without hashing, a DB leak hands out active OTPs. With bcrypt cost 10, the same leak doesn't give an attacker usable codes. The cost is 100ms per verify, which is invisible to the user.

**Q: "Why is `tokenVersion` needed?"**
A: JWTs are stateless; you can't revoke them. `tokenVersion` gives us O(1) global logout. Without it, "log out all devices" requires iterating every refresh token in the DB. With it, it's a single `UPDATE`.

**Q: "Why `.env.example` instead of `.env`?"**
A: Real secrets in `.env` get committed by accident. The example file is committed; the actual file is gitignored. CI fails if the example has placeholder values like `replace_me_access`; production fails if `.env` has the placeholders. The two-file pattern is the only safe way to ship secrets.

**Q: "Why `citext` for email?"**
A: Without it, `Bob@x.com` and `bob@x.com` are two accounts. An attacker exploits this confusion for account takeover. With `citext`, they're the same account. One-line fix in the migration.

---

## 12. The "before you ship" checklist

For the schema foundation, before you merge the PR:

- [ ] `synchronize: false` in `app.module.ts` and `data-source.ts`?
- [ ] `Profile` entity created and registered in `app.module.ts`?
- [ ] `Otp` is `ManyToOne` to `User`, not `OneToOne`?
- [ ] `Otp.codeHash` is `select: false`?
- [ ] `User.passwordHash` is `select: false`?
- [ ] `User.email` is `citext` (not `varchar`)?
- [ ] `User.googleId` is `unique: true`?
- [ ] `User.tokenVersion` exists with default 1?
- [ ] `Profile.user_id` is `unique: true` (the 1:1 enforcement)?
- [ ] `Profile.user` has `onDelete: 'CASCADE'`?
- [ ] `Otp.user` has `onDelete: 'CASCADE'`?
- [ ] Migration has `up` AND `down`?
- [ ] Migration is idempotent (`IF NOT EXISTS`)?
- [ ] Indexes created in the migration: `users(lower(email))`, `users(google_id) WHERE google_id IS NOT NULL`, `otp(user_id, purpose, expires_at DESC)`, `otp(user_id, purpose) WHERE used_at IS NULL`?
- [ ] `bigint` (or `bigserial`) used for all primary keys?
- [ ] `timestamptz` used for all timestamp columns (not `timestamp`)?
- [ ] `.env.example` committed; `.env` in `.gitignore`?
- [ ] `bcrypt` installed (`npm install bcrypt`)?
- [ ] `package.json` has `migration:revert`, `migration:generate`, `migration:create`?
- [ ] Test that asserts the migration round-trips (up then down leaves schema unchanged)?
- [ ] Test that asserts `passwordHash` is not in the response body?
- [ ] `EXPLAIN SELECT * FROM users WHERE email = 'X@Y.com'` shows index scan?

If you can't tick all twenty-three, the foundation isn't ready.

---

## 13. What we just enabled for Lesson 10

- A user can have many OTPs across time, each with a purpose and a cooldown — exactly what `/auth/resend-otp` needs.
- A user can register with email+password *or* Google, with no schema change to switch between them.
- A user can be soft-deleted and have all their refresh tokens invalidated in O(1) via `tokenVersion`.
- The DB will not silently drift because `synchronize: false` and migrations own the schema.
- PII is segregated from auth; GDPR right-to-be-forgotten is implementable.
- OTP brute-force is bounded by `attempts` and `maxAttempts`; DB leaks don't give usable codes.

Lesson 10 (theory) and Lesson 20 (auth endpoints) build on this. Don't move on until the migration runs cleanly and your tests pass.
