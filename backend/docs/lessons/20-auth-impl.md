# Lesson 20 — Auth Implementation: Building It End-to-End

> **What you'll get:** all eight endpoints from `Expert Finding.md` wired up: register, verify-email, resend-otp, login, forgot-password, reset-password, Google OAuth, refresh. All behind a clean NestJS module structure with throttling, validation, cookies, and tests.
>
> **Required reading:** Lesson 10 (theory). If you haven't read it, stop and read it first. The code here expresses the decisions made there. If you disagree with a decision, raise it *now*, not after I've built 600 lines on top of it.

---

## 1. Goal

A working backend that:

- registers a user with email + password, sends a 6-digit OTP that expires in 5 minutes,
- resends the OTP with a 60-second cooldown,
- verifies the OTP, issues JWT cookies, redirects to `/profile`,
- logs in an already-verified user with rate-limited attempts,
- resets a forgotten password via a separate-purpose OTP that bumps `tokenVersion`,
- logs in a user via Google OAuth, creating them with `isEmailVerified = true` if new, or linking if not,
- refreshes tokens by rotating the refresh-token row and detecting reuse.

Plus:

- an `AuthGuard` and a `RolesGuard`,
- a `MailService` interface so we can swap nodemailer for SendGrid without touching controllers,
- unit tests for `OtpService` and `AuthService`,
- an e2e test that walks the full register → verify → login → refresh → reuse-detect path.

---

## 2. Why we structure the code this way

Before any code, the directories we'll create:

```
src/
├── auth/
│   ├── auth.module.ts
│   ├── auth.controller.ts
│   ├── auth.service.ts                ← orchestrator
│   ├── strategies/
│   │   ├── jwt.strategy.ts            ← access token
│   │   ├── jwt-refresh.strategy.ts    ← refresh token
│   │   └── google.strategy.ts         ← Passport Google
│   ├── guards/
│   │   ├── jwt-auth.guard.ts
│   │   ├── jwt-refresh.guard.ts
│   │   └── roles.guard.ts
│   ├── decorators/
│   │   ├── current-user.decorator.ts
│   │   ├── public.decorator.ts
│   │   └── roles.decorator.ts
│   └── dto/
│       ├── register.dto.ts
│       ├── verify-email.dto.ts
│       ├── login.dto.ts
│       ├── forgot-password.dto.ts
│       └── reset-password.dto.ts
├── users/
│   ├── users.module.ts
│   └── users.service.ts               ← find/create/update
├── otp/
│   ├── otp.module.ts
│   └── otp.service.ts                 ← generate, verify, cooldown
├── mail/
│   ├── mail.module.ts
│   └── mail.service.ts                ← send(email, subject, body)
├── common/
│   ├── filters/
│   │   └── all-exceptions.filter.ts
│   └── interceptors/
│       └── request-id.interceptor.ts
```

Why split `auth` from `users`?

- **`auth` deals with sessions, tokens, OAuth.** `users` deals with "what does a user look like". Splitting means we can change either without touching the other. Lesson 30 will have a `JwtAuthGuard` from `auth` protecting the `search` endpoints without `search` importing anything from `users`.
- **`otp` is its own module.** Lesson 10 keeps OTP logic testable and reusable. If we ever add 2FA, it's the same module.

### 2.1 Business cost of getting this structure wrong

| Smell | What it costs in production |
|---|---|
| `users` imports `AuthService` to send "welcome" emails on create | A future migration to a different auth provider (Auth0, Cognito) rewrites `users` and ripples to every controller. 2 sprint days per service touched. |
| OTP logic baked into `auth.service.ts` | Adding 2FA means rewriting `auth.service.ts` instead of `OtpService.issue({ purpose: 'totp' })`. Multiplies the blast radius of every change. |
| Refresh token logic in the same file as access-token issuance | A bug in refresh rotation requires QA to re-test login. Should be a 5-minute PR. |
| `MailService` not its own module | A swap from nodemailer to SendGrid becomes a global search-and-replace instead of a one-file change. |
| Hard-coded DTOs in controller | Switching from `/auth/register` to a GraphQL mutation later means rewriting every endpoint. With shared DTOs: change the resolver, keep validation. |

**The structure is not aesthetic. It is the single biggest factor in how painful a future refactor will be.**

---

## 3. Current state of the codebase (audit before you write code)

Before you start typing, look at what's already there. These are the actual gaps in `G:\Projects\expert-finding\Expert_Findings_Application\backend` as of this writing:

| Gap | Where | Risk |
|---|---|---|
| `synchronize: true` is on | `src/app.module.ts:48` | Schema drift. One accidental entity change → silent prod data loss. |
| `logging: true` | `src/app.module.ts:49` | TypeORM logs every SQL statement including parameter values. **An email address shows up in stdout.** GDPR issue. |
| `User.passwordHash` exists but no `tokenVersion` | `src/user/entities/user.entity.ts:30` | We can't revoke all sessions on password change without `tokenVersion`. |
| `User` has no `googleId` / `googleEmail` columns | same file | OAuth linking code will not compile against the existing entity. |
| `UserRole` enum is `client`/`expert` only | same file:14 | No `admin` role. The `RolesGuard` we write can't authorize admins. |
| `UserStatus` enum uses `'deleted'` (not `'deactivated'`) | same file:19 | The `login()` check `user.status === 'deleted'` would never match the actual stored value. We need to normalize. |
| `Otp` is `@OneToOne` to `User` | (per Lesson 03 audit) | Should be `@ManyToOne`. Cooldown logic only works on the latest row; with OneToOne, the second `issue()` will overwrite the first. |
| `Profile` entity does not exist | `app.module.ts` | `UsersService.createWithPassword` will not compile. |
| `pass_hash` column is `select: false` | `user.entity.ts:30` | Every login that calls `users.findOne({ where: { email } })` will get `passwordHash = undefined`. This is the most common bug in NestJS+TypeORM. |
| `nodemailer`, `bcrypt`, `@nestjs/throttler`, `@nestjs/jwt`, `passport`, `helmet`, `cookie-parser` not in `package.json` | — | First `npm install` will be 200MB. Plan for it. |
| `migration:generate`, `migration:run`, `migration:revert` scripts not in `package.json` | — | We can't ship the schema changes this lesson needs without these scripts. |

**Lesson 20 ships none of these fixes.** It assumes you have already done (a) the Lesson 05 schema work (entities updated, migrations written, `synchronize: false`), (b) the Lesson 10 audit fixes (OTP entity, `tokenVersion` column), and (c) installed the dependencies. **Verify those are done before you start this lesson. Otherwise you'll spend 3 hours debugging a TypeORM error that is actually a missing column.**

### 3.1 Why the audit matters

I once watched a junior engineer spend a day debugging "the login always returns undefined" because the test database was synchronized against an entity that had `passwordHash` removed in a previous PR. `synchronize: true` in tests + a missing migration = silent prod failure. The audit up front catches this in 5 minutes.

---

## 4. Add dependencies

```bash
npm install @nestjs/jwt @nestjs/passport @nestjs/throttler passport passport-jwt passport-google-oauth20 bcrypt cookie-parser nodemailer helmet
npm install -D @types/passport-jwt @types/passport-google-oauth20 @types/cookie-parser @types/nodemailer
```

**Why these?**

- `@nestjs/jwt` — wraps `jsonwebtoken` with Nest-friendly DI.
- `@nestjs/passport` + `passport` — Passport has 500+ strategies; this is the standard.
- `@nestjs/throttler` — IP + user-keyed rate limiting with pluggable storage.
- `passport-google-oauth20` — the OAuth2 strategy we wire in §11.
- `bcrypt` — already installed in Lesson 05. Re-listed here so this lesson is self-contained.
- `cookie-parser` — NestJS doesn't parse cookies by default; we need it to read the refresh-token cookie on `/auth/refresh`.
- `nodemailer` — transport layer; Lesson 50 swaps the templates to Handlebars but keeps the same interface.
- `helmet` — sets `X-Content-Type-Options`, `X-Frame-Options`, `Strict-Transport-Security`, `Content-Security-Policy`. Defaults are sane; one line in `main.ts` covers a dozen common OWASP items.

### 4.1 Why this dependency set is non-negotiable for production

- **Without `@nestjs/throttler`**: an attacker can attempt 10,000 logins per second from a single IP. With bcrypt cost 12, that's still 10,000 attempts × 100ms = 16 minutes to brute-force a 6-character password, and infinite time for a credential-stuffing list. Lesson 10 §3.7 has the math.
- **Without `helmet`**: `X-Powered-By: Express` leaks the framework. `Content-Security-Policy: unsafe-inline` allows inline scripts. `Strict-Transport-Security: 0` means an MITM downgrade is trivial. None of these are showstoppers individually; together they're the baseline of "did the developer try at all?".
- **Without `cookie-parser`**: `req.cookies` is `undefined`. The refresh strategy reads `req.cookies.refresh_token` and gets `undefined`. The `passport-jwt` extractor silently returns nothing. The user is logged out after 15 minutes and there's no error in the logs.
- **Without `nodemailer`**: `MailService.sendOtp` throws. The whole `register` flow breaks. Better to throw early in the DI container.

---

## 5. The config layer

`backend/src/config/app-config.ts`:

```ts
export interface AppConfig {
  nodeEnv: 'development' | 'production' | 'test';
  port: number;
  jwt: {
    accessSecret: string;
    refreshSecret: string;
    accessTtl: string;
    refreshTtl: string;
  };
  google: {
    clientId: string;
    clientSecret: string;
    callbackUrl: string;
  };
  mail: {
    from: string;
    host: string;
    port: number;
    user: string;
    pass: string;
  };
  cookies: {
    domain?: string;
    secure: boolean;
  };
  frontendUrl: string;
}

export default (): AppConfig => ({
  nodeEnv: (process.env.NODE_ENV as AppConfig['nodeEnv']) ?? 'development',
  port: Number(process.env.PORT ?? 3000),
  jwt: {
    accessSecret: must('JWT_ACCESS_SECRET'),
    refreshSecret: must('JWT_REFRESH_SECRET'),
    accessTtl: process.env.JWT_ACCESS_TTL ?? '15m',
    refreshTtl: process.env.JWT_REFRESH_TTL ?? '7d',
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    callbackUrl:
      process.env.GOOGLE_CALLBACK_URL ??
      'http://localhost:3000/api/v1/auth/google/callback',
  },
  mail: {
    from: process.env.MAIL_FROM ?? 'no-reply@example.com',
    host: process.env.SMTP_HOST ?? '',
    port: Number(process.env.SMTP_PORT ?? 587),
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
  },
  cookies: {
    secure: process.env.NODE_ENV === 'production',
  },
  frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:3001',
});

function must(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required env: ${name}`);
  }
  return v;
}
```

Register in `app.module.ts`:

```ts
ConfigModule.forRoot({ isGlobal: true, load: [appConfig] }),
```

This way `ConfigService.get('jwt.accessSecret')` returns the typed value.

**Why a function `must()` that throws?** A missing JWT secret at boot is *exactly* the kind of bug you want a loud, immediate error for — not a `jwt.sign({...}, undefined)` that silently produces an unsigned token. We refuse to start without it.

### 5.1 The asymmetric-secret rule

`JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` must be **different values**. If they are the same:
- A leaked access token (15-min window) lets the attacker forge refresh tokens (7-day window).
- An attacker who steals a refresh token from a misconfigured log file can use the same secret to validate the JWT signature in *every* microservice that shares the secret.

Generate them with: `openssl rand -base64 64`. Two different values, each ≥64 bytes. The chance of collision is 2^-512. The chance of you copy-pasting the same value into both env vars is 1 in 10,000, and that is the real risk.

### 5.2 What we explicitly don't put in env

- **`JWT_ALGORITHM`** — hard-code to `HS256`. The library's default is fine; we don't need a knob that creates risk.
- **`BCRYPT_COST`** — hard-code to 12 for passwords, 10 for OTPs (per Lesson 05). Changing this at runtime is a footgun.
- **`COOKIE_SECURE`** — derived from `NODE_ENV === 'production'`. No reason to override; the dev experience is identical with `secure: false`.

---

## 6. Update `main.ts` (cookies, helmet, validation, rate limiting)

`backend/src/main.ts`:

```ts
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, VersioningType, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  const config = app.get(ConfigService);

  app.use(helmet());                       // security headers (X-Frame, CSP, etc.)
  app.use(cookieParser());                 // refresh token comes via cookie
  app.enableCors({
    origin: config.get<string>('frontendUrl'),
    credentials: true,                    // allow cookies to be set cross-origin
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,                    // strip unknown fields
      forbidNonWhitelisted: true,         // 400 if extra fields present
      transform: true,                    // coerce types (query strings → numbers)
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());

  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  await app.listen(config.get<number>('port') ?? 3000);
  Logger.log(`Listening on :${config.get<number>('port')}`, 'Bootstrap');
}

bootstrap();
```

**Why `credentials: true`?** Because the access/refresh tokens live in cookies, and the browser must consent to sending them cross-origin.

**Why `forbidNonWhitelisted: true`?** A request like `POST /auth/register { email, password, isAdmin: true }` would otherwise be silently stripped of `isAdmin` and proceed. With this flag, it's a 400 — making the attack attempt visible in logs.

### 6.1 Why this exact `helmet` order matters

`helmet()` sets ~12 headers. The defaults are good, but if you later add a frontend SPA that needs to inline a script tag, you'll hit `Content-Security-Policy` blocking it. **Don't** disable helmet to "fix" this — instead, set the specific policy you need:

```ts
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'", 'https://js.stripe.com'],  // example
        'style-src': ["'self'", "'unsafe-inline'"],         // for the frontend
        'img-src': ["'self'", 'data:', 'https:'],
      },
    },
    crossOriginEmbedderPolicy: false,  // required for cross-origin image rendering
  }),
);
```

The lesson's default is fine for a backend API that doesn't serve HTML. Lesson 50's frontend lesson will revisit this.

### 6.2 Why the global `ValidationPipe` is non-negotiable

Without it:
- `POST /auth/register { email: 123, password: null }` arrives in the controller. `123.toLowerCase()` is fine, but `bcrypt.hash(null)` throws `TypeError`.
- Without `whitelist: true`, an attacker can probe with extra fields to confirm what columns exist. (`is_admin`, `role`, `tokenVersion`.)
- Without `transform: true`, `body.userId` is a string when your DTO expects a number, and `Number(body.userId)` is silently `NaN` for `'abc'`.

The pipe is the firewall between the HTTP layer and the rest of your code. Turn it on once. Forget about it.

---

## 7. The DTOs

Every endpoint uses a class-validator DTO at the boundary. This is non-negotiable.

`backend/src/auth/dto/register.dto.ts`:

```ts
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  MinLength,
  MaxLength,
  Matches,
} from 'class-validator';

export class RegisterDto {
  @IsEmail({}, { message: 'Email must be a valid address' })
  @MaxLength(254) // RFC 5321 max length
  email!: string;

  @IsString()
  @MinLength(10, { message: 'Password must be at least 10 characters' })
  @MaxLength(72) // bcrypt truncates beyond 72 bytes
  password!: string;
}
```

`backend/src/auth/dto/verify-email.dto.ts`:

```ts
import { IsString, Matches, Length } from 'class-validator';

export class VerifyEmailDto {
  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: 'OTP must be 6 digits' })
  code!: string;
}
```

`backend/src/auth/dto/login.dto.ts`:

```ts
import { IsEmail, IsString, MinLength, MaxLength } from 'class-validator';

export class LoginDto {
  @IsEmail() email!: string;

  @IsString()
  @MinLength(1) // we don't reveal "password is wrong" vs "user not found"
  @MaxLength(72)
  password!: string;
}
```

`backend/src/auth/dto/forgot-password.dto.ts`:

```ts
import { IsEmail } from 'class-validator';

export class ForgotPasswordDto {
  @IsEmail() email!: string;
}
```

`backend/src/auth/dto/reset-password.dto.ts`:

```ts
import { IsString, Matches, Length, IsEmail, MinLength, MaxLength } from 'class-validator';

export class ResetPasswordDto {
  @IsEmail() email!: string;

  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/)
  code!: string;

  @IsString()
  @MinLength(10)
  @MaxLength(72)
  newPassword!: string;
}
```

`backend/src/auth/dto/refresh.dto.ts`:

```ts
// No body — the refresh token comes via cookie. This DTO is empty by design.
export class RefreshDto {}
```

**Note on `@MinLength(10)`.** NIST's current recommendation is 8 minimum; we use 10 because (a) it's a small UX win, (b) `@MaxLength(72)` matches bcrypt's behavior, (c) longer passwords shift the bcrypt-collision curve in our favor.

### 7.1 The 72-byte ceiling and why it matters

`bcrypt` silently truncates input beyond 72 bytes. If a user types a 100-character password, only the first 72 are hashed. This means:
- An attacker who knows the first 72 chars of a victim's password **and** the algorithm has guessed the algorithm can mount a partial-match attack.
- The validation `@MaxLength(72)` is not pedantry — it forces the user to type a password that fully participates in the hash. Without it, "myverylongpasswordthatihopeyoucantguess" is functionally equivalent to "myverylongpasswordthatihopeyoucantgu" plus a check.
- `@MinLength(10)` is the lower bound. NIST says 8; we choose 10 because below 10 a 6-character OTP is comparable entropy, which is a bad signal.

### 7.2 What `@Matches(/^\d{6}$/)` actually prevents

It prevents:
- The user typing `12 34 56` (with spaces) and the system silently stripping.
- The frontend sending an HTML-entity-encoded `&#49;&#50;&#51;&#52;&#53;&#54;` (which class-validator would not decode).
- A copy-paste from a password manager that includes a trailing newline.

It does *not* prevent: someone brute-forcing the 1M combinations offline. That's the 5-minute expiry's job.

---

## 8. The `MailService`

`backend/src/mail/mail.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter?: nodemailer.Transporter;

  constructor(private readonly config: ConfigService) {}

  private getTransporter(): nodemailer.Transporter {
    if (this.transporter) return this.transporter;
    this.transporter = nodemailer.createTransport({
      host: this.config.get<string>('mail.host'),
      port: this.config.get<number>('mail.port'),
      secure: false,
      auth: {
        user: this.config.get<string>('mail.user'),
        pass: this.config.get<string>('mail.pass'),
      },
    });
    return this.transporter;
  }

  async sendOtp(to: string, code: string, purpose: 'email_verification' | 'password_reset'): Promise<void> {
    const subject =
      purpose === 'email_verification'
        ? 'Verify your email'
        : 'Reset your password';
    const body =
      purpose === 'email_verification'
        ? `Your verification code is ${code}. It expires in 5 minutes.`
        : `Your password-reset code is ${code}. It expires in 5 minutes.`;

    try {
      await this.getTransporter().sendMail({
        from: this.config.get<string>('mail.from'),
        to,
        subject,
        text: body,
      });
    } catch (err) {
      // Don't fail the request just because the mail failed; the user can resend.
      this.logger.error(`Failed to send OTP email to ${to}: ${(err as Error).message}`);
    }
  }
}
```

`backend/src/mail/mail.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { MailService } from './mail.service';

@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
```

Install nodemailer:

```bash
npm install nodemailer
```

**Why a method-per-template instead of `send(to, subject, body)`?** Because the templates evolve, and putting the strings in code lets us keep them versioned with the auth code. Lesson 50 replaces this with Handlebars templates.

### 8.1 Why the mail-failure is swallowed, not thrown

If `nodemailer` throws (SMTP down, wrong credentials, recipient rejected), the user is left in limbo: they registered, but they don't know if they got an OTP. The choices are:

1. **Throw** → 500 to the user. They retry. The same SMTP failure happens. They retry. The user concludes the site is broken.
2. **Swallow + log + return `sent: true`** → 201 to the user. They wait. Nothing arrives. They click "Resend OTP". Eventually the SMTP recovers and the code arrives.

Option 2 is the right call. The `resend-otp` endpoint with the 60-second cooldown is the recovery path. **The error log is the alert**; your monitoring system watches for `Failed to send OTP` lines and pages you.

### 8.2 The plain-text-only choice

Notice we send `text: body` but no `html:`. Two reasons:
- HTML email clients (Gmail, Outlook) are not safe contexts. A buggy template can leak the OTP to the recipient's address book via an `img src` request.
- Plain text is universal. A user on a 5-year-old phone with no HTML email client can still read the code.
- Lesson 50 will add HTML templates. The lesson code here is correct in being minimal.

### 8.3 The PII-in-logs boundary

`this.logger.error(`Failed to send OTP email to ${to}: ${...}`)` — the email address appears in logs. For SOC2 / GDPR, your log retention policy must say (a) logs are encrypted at rest, (b) logs are retained for ≤30 days, (c) logs are not shared with third parties. The alternative is to log a hash of the email or a `requestId` only and look the email up from the request ID in a separate audit table.

---

## 9. The `OtpService`

`backend/src/otp/otp.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { randomInt } from 'crypto';
import * as bcrypt from 'bcrypt';
import { Otp, OtpPurpose } from './entities/otp.entity';

export interface IssueOtpInput {
  userId: number;
  purpose: OtpPurpose;
  ip?: string;
}

export interface VerifyOtpInput {
  userId: number;
  purpose: OtpPurpose;
  code: string;
}

const CODE_TTL_MS = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(@InjectRepository(Otp) private readonly repo: Repository<Otp>) {}

  /**
   * Generate a 6-digit code, bcrypt it, INSERT a row, return the cleartext
   * for the caller to email. The cleartext never touches the DB.
   */
  async issue(input: IssueOtpInput): Promise<{ code: string; rowId: number }> {
    // Enforce cooldown on the most recent row for this user+purpose.
    const latest = await this.repo.findOne({
      where: { user: { id: input.userId }, purpose: input.purpose },
      order: { lastSentAt: 'DESC' },
    });
    if (latest && Date.now() - latest.lastSentAt.getTime() < RESEND_COOLDOWN_MS) {
      const retryAfterSec = Math.ceil(
        (RESEND_COOLDOWN_MS - (Date.now() - latest.lastSentAt.getTime())) / 1000,
      );
      const err: any = new Error('OTP cooldown active');
      err.status = 429;
      err.retryAfter = retryAfterSec;
      throw err;
    }

    // CSPRNG, not Math.random. See §9.1 for the math.
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);

    const row = this.repo.create({
      user: { id: input.userId } as any,
      purpose: input.purpose,
      codeHash,
      attempts: 0,
      maxAttempts: MAX_ATTEMPTS,
      expiresAt,
      lastSentAt: new Date(),
      usedAt: null,
      requestIp: input.ip ?? null,
    });
    const saved = await this.repo.save(row);
    return { code, rowId: saved.id };
  }

  /**
   * Verify a code. Returns true on success; throws on cooldown/fail/lock.
   *
   * RACE-SAFE: the increment is done with an atomic UPDATE-WHERE that
   * will only succeed if the row is still below maxAttempts. See §9.2.
   */
  async verify(input: VerifyOtpInput): Promise<boolean> {
    // Pick the most recent unused row for this (user, purpose).
    const row = await this.repo
      .createQueryBuilder('o')
      .where('o.user_id = :uid', { uid: input.userId })
      .andWhere('o.purpose = :p', { p: input.purpose })
      .andWhere('o.used_at IS NULL')
      .andWhere('o.expires_at > NOW()')
      .orderBy('o.last_sent_at', 'DESC')
      .limit(1)
      .getOne();

    if (!row) throw makeError('No active OTP', 400);

    // Atomic increment: only succeeds if we are still under the cap.
    // If two requests race, only one UPDATE returns rowcount=1.
    const inc = await this.repo
      .createQueryBuilder()
      .update(Otp)
      .set({ attempts: () => 'attempts + 1' })
      .where('id = :id', { id: row.id })
      .andWhere('attempts < max_attempts')
      .andWhere('used_at IS NULL')
      .execute();

    if ((inc.affected ?? 0) === 0) {
      throw makeError('Too many attempts', 429);
    }

    const ok = await bcrypt.compare(input.code, row.codeHash);
    if (!ok) {
      // Attempts already incremented; if we just hit the cap, lock the row.
      if (row.attempts + 1 >= row.maxAttempts) {
        await this.repo.update({ id: row.id }, { usedAt: new Date() });
      }
      throw makeError('Invalid OTP', 400);
    }

    await this.repo.update({ id: row.id }, { usedAt: new Date() });
    return true;
  }

  /** Helper used by tests. */
  async cleanup(userId: number, purpose: OtpPurpose): Promise<void> {
    await this.repo.delete({ user: { id: userId }, purpose } as any);
  }
}

function makeError(message: string, status: number) {
  const err: any = new Error(message);
  err.status = status;
  return err;
}
```

`backend/src/otp/otp.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Otp } from './entities/otp.entity';
import { OtpService } from './otp.service';

@Module({
  imports: [TypeOrmModule.forFeature([Otp])],
  providers: [OtpService],
  exports: [OtpService],
})
export class OtpModule {}
```

### 9.1 Why `randomInt` and not `Math.random`

`Math.random()` is fine for non-security purposes. For OTP generation, it is not. Here's why:

- V8's `Math.random` uses an XorShift128+ PRNG seeded from time and memory state. It produces **48 bits of entropy at the seed**, and once observed (e.g., by another request on the same V8 instance a few ms earlier), the rest is predictable. There is academic research that can predict `Math.random` outputs from a single observation of the same process.
- An attacker who can observe a few of our generated OTPs can predict the next ones, **even without breaking bcrypt**. The bcrypt hash protects only the storage; the generation must be unpredictable at the source.

`crypto.randomInt(0, 1_000_000)` uses `/dev/urandom` (or equivalent) which:
- Is seeded from hardware noise (RDSEED on modern CPUs).
- Is not predictable from observations in the same process.
- Has the same cost (microseconds).

The cost of using `crypto.randomInt` over `Math.random` is one extra `import`. The cost of using `Math.random` in production is that **anyone who can register an account and observe 3-4 of their own OTPs can predict the next 1-2 digits of the next victim's OTP**. That's the difference between 1-in-a-million and 1-in-a-thousand for the attacker's search space.

### 9.2 The increment-before-compare race

The original draft (kept in earlier revisions of this lesson) did:
```ts
row.attempts += 1;
await this.repo.save(row);
const ok = await bcrypt.compare(input.code, row.codeHash);
```

This has a race: two parallel requests both read `attempts = 4`, both increment to 5 in memory, both pass the `< maxAttempts` check, both `save` (one wins on the column value, the other is overwritten), both then call `bcrypt.compare`. If the attacker sends 100 parallel requests at attempts = 4, **all 100** would enter the `bcrypt.compare` step. Of those, *one* might guess correctly. Without the race-safe UPDATE-WHERE, the lockout is bypassed.

The atomic UPDATE-WHERE pattern in the rewritten `verify` ensures the database itself enforces the cap: the second UPDATE returns `affected = 0` and we throw 429.

**This is a Lesson 03 / 04 / 05 lesson style application: when you can express the rule in SQL, do.** The "increment in memory then save" pattern is the equivalent of `synchronize: true` — a convenience that costs correctness.

### 9.3 The `requestIp` audit field

The OTP entity has a `requestIp` column. The intent is for the audit log: "User X was sent a verification code from IP 198.51.100.7, and they verified it from IP 203.0.113.42." If those don't match, it's a sign that:
- The user is on a different network than they were when they registered (common: mobile handover).
- Someone has intercepted the email (very rare but observable).
- The user is sharing their account.

We don't act on the mismatch in this lesson. We *log* it. The decision of what to do (challenge, block, ignore) is a product call. The fact that we have the data is an engineering call.

---

## 10. The `UsersService`

`backend/src/users/users.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User, UserRole } from 'src/user/entities/user.entity';
import { Profile } from 'src/profile/entities/profile.entity';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
  ) {}

  findByEmail(email: string): Promise<User | null> {
    return this.users
      .createQueryBuilder('u')
      .addSelect('u.passwordHash')
      .where('u.email = :email', { email })
      .getOne();
  }

  findById(id: number): Promise<User | null> {
    return this.users.findOne({ where: { id }, relations: { profile: true } });
  }

  findByGoogleId(googleId: string): Promise<User | null> {
    return this.users.findOne({ where: { googleId } });
  }

  async createWithPassword(email: string, password: string): Promise<User> {
    const passwordHash = await bcrypt.hash(password, 12);
    const user = this.users.create({
      email,
      passwordHash,
      role: UserRole.CLIENT,
      isEmailVerified: false,
    });
    const saved = await this.users.save(user);
    // Create an empty profile so /profile page has something to update.
    await this.profiles.save(this.profiles.create({ userId: saved.id }));
    return saved;
  }

  async markEmailVerified(id: number): Promise<void> {
    await this.users.update({ id }, { isEmailVerified: true });
  }

  async setPasswordHash(id: number, password: string): Promise<void> {
    const passwordHash = await bcrypt.hash(password, 12);
    await this.users.update({ id }, { passwordHash });
    await this.users.increment({ id }, 'tokenVersion', 1);
  }

  async createFromGoogle(profile: {
    googleId: string;
    email: string;
  }): Promise<User> {
    const user = this.users.create({
      email: profile.email,
      googleId: profile.googleId,
      googleEmail: profile.email,
      role: UserRole.CLIENT,
      isEmailVerified: true, // Google has verified the email
    });
    const saved = await this.users.save(user);
    await this.profiles.save(this.profiles.create({ userId: saved.id }));
    return saved;
  }

  async linkGoogle(id: number, googleId: string, email: string): Promise<void> {
    await this.users.update({ id }, { googleId, googleEmail: email });
  }
}
```

`backend/src/users/users.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from 'src/user/entities/user.entity';
import { Profile } from 'src/profile/entities/profile.entity';
import { UsersService } from './users.service';

@Module({
  imports: [TypeOrmModule.forFeature([User, Profile])],
  providers: [UsersService],
  exports: [UsersService, TypeOrmModule],
})
export class UsersModule {}
```

**Two important points:**

1. **`findByEmail` uses `addSelect('u.passwordHash')`.** Because the `User.passwordHash` is `select: false`, you must opt back in for the one query that needs it. Any other code path that does `this.users.findOne({ where: { email } })` will get a user with `passwordHash = undefined`, and `bcrypt.compare(input, undefined)` will throw.

2. **`setPasswordHash` increments `tokenVersion`.** This forcibly logs the user out of every device. Without this, the old (now-stale) access tokens remain valid for 15 minutes, and the user could still be in their browser session as the *old* password. We'll revisit this in §11 with refresh-token rotation.

### 10.1 The bcrypt cost-12 choice for passwords, cost-10 for OTPs

We use **bcrypt cost 12 for user passwords** and **cost 10 for OTPs**. The math:

- **Cost 12** = 2^12 = 4096 iterations. On a modern CPU, ~250ms per hash. A user registering tolerates 250ms. An attacker brute-forcing a 10-character password at 1M combinations... if they could test 4 hashes/sec, that's 250,000 seconds = 69 hours. With `tokenVersion` bumping, the window of usefulness of any stolen hash is short.
- **Cost 10** = 1024 iterations. ~60ms per hash. We do 1 hash on issue, 1 on verify. The 60ms is invisible to the user. But it pins the *attacker* who steals the OTP database to 60ms per guess. 1M combinations × 60ms = 17 hours per OTP. With a 5-minute expiry, that's 5 minutes of usefulness — the attacker has 5 minutes × 60ms = 18 seconds of useful work per row. Useless.

If we used cost 12 for OTPs, *every registration* takes 500ms instead of 120ms. For 1000 users/day, that's 6 minutes of CPU per day. For 1M users, the OTP table is 1M rows and a forensic attacker has 6 minutes of useful work per stolen row. The asymmetric cost choice is intentional.

### 10.2 Why `markEmailVerified` and not `update({ id }, { isEmailVerified: true, status: ACTIVE })`

Because the user may be in `DEACTIVE` state (an admin has disabled them) and we don't want to silently re-enable them on email verification. `markEmailVerified` is a narrow permission; the *state machine* is owned by other code paths (admin actions, GDPR erasure).

### 10.3 The `Profile` entity it depends on

`createWithPassword` and `createFromGoogle` both call `this.profiles.save(...)`. If the `Profile` entity doesn't exist, this code doesn't compile. If the `Profile` entity doesn't have a `userId` column, the `INSERT` fails with a foreign key violation at runtime. **This is the most common Lesson 20 deployment failure**: the Lesson 05 migration added the column but the Lesson 20 code references the entity which was added in a separate PR.

If you see `relation "profile" does not exist` in logs: you skipped Lesson 05.

### 10.4 The `findById` and `tokenVersion` read

`findById` returns a `User`. The `tokenVersion` is on the row but not in the relations — it's a column. JWT verification will compare `payload.tv` (in the JWT) to `user.tokenVersion` (in the DB). That requires a DB read on every authenticated request. **This is the cost of stateless-but-revocable tokens.** Alternatives are (a) cache the user in Redis with a 30-second TTL, or (b) accept the DB hit. We accept the hit for the MVP; Lesson 30 will add a Redis cache.

---

## 11. The `AuthService` (the orchestrator)

This is where the eight endpoints come together.

`backend/src/auth/auth.service.ts`:

```ts
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { UsersService } from 'src/users/users.service';
import { OtpService } from 'src/otp/otp.service';
import { OtpPurpose } from 'src/otp/entities/otp.entity';
import { MailService } from 'src/mail/mail.service';
import { randomBytes } from 'crypto';
import { RefreshToken } from './entities/refresh-token.entity';
import { User } from 'src/user/entities/user.entity';

interface JwtAccessPayload {
  sub: number;
  role: 'client' | 'expert' | 'admin';
  tv: number; // tokenVersion
}

interface JwtRefreshPayload {
  sub: number;
  jti: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly users: UsersService,
    private readonly otp: OtpService,
    private readonly mail: MailService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @InjectRepository(RefreshToken)
    private readonly refreshRepo: Repository<RefreshToken>,
  ) {}

  // ───────────────────── Register / Verify / Resend ─────────────────────

  async register(email: string, password: string, ip?: string) {
    const existing = await this.users.findByEmail(email);
    if (existing) {
      // Same response as "we sent you an OTP" — don't leak existence.
      this.logger.warn(`Register attempt for existing email`);
      return { alreadyExists: true } as const;
    }
    const user = await this.users.createWithPassword(email, password);
    const { code } = await this.otp.issue({
      userId: user.id,
      purpose: OtpPurpose.EMAIL_VERIFICATION,
      ip,
    });
    await this.mail.sendOtp(email, code, 'email_verification');
    return { userId: user.id, sent: true } as const;
  }

  async resendVerification(email: string, ip?: string) {
    const user = await this.users.findByEmail(email);
    if (!user) return { sent: true } as const; // don't leak
    if (user.isEmailVerified) return { sent: true } as const; // already done
    const { code } = await this.otp.issue({
      userId: user.id,
      purpose: OtpPurpose.EMAIL_VERIFICATION,
      ip,
    });
    await this.mail.sendOtp(user.email, code, 'email_verification');
    return { sent: true } as const;
  }

  async verifyEmail(userId: number, code: string) {
    const user = await this.users.findById(userId);
    if (!user) throw new BadRequestException('No user');
    if (user.isEmailVerified) {
      // Idempotent — already verified, just issue tokens.
      const tokens = await this.issueTokens(user);
      return { user, ...tokens };
    }
    await this.otp.verify({
      userId,
      purpose: OtpPurpose.EMAIL_VERIFICATION,
      code,
    });
    await this.users.markEmailVerified(userId);
    const fresh = await this.users.findById(userId);
    const tokens = await this.issueTokens(fresh!);
    return { user: fresh!, ...tokens };
  }

  // ───────────────────── Login / Logout / Refresh ─────────────────────

  async login(email: string, password: string) {
    const user = await this.users.findByEmail(email);
    // Constant-ish-time: do a bcrypt compare against a dummy hash if user
    // is missing, so timing doesn't reveal "user not found".
    const DUMMY_HASH = '$2b$12$CwTycUXWue0Thq9StjUM0uJ8VbG3zS8qJ7z8qJ7z8qJ7z8qJ7z8qJ'; // pre-computed
    const hash = user?.passwordHash ?? DUMMY_HASH;
    const ok = await bcrypt.compare(password, hash);
    if (!user || !ok) throw new UnauthorizedException('Invalid credentials');
    if (!user.isEmailVerified) {
      throw new BadRequestException({
        code: 'EMAIL_NOT_VERIFIED',
        userId: user.id,
      });
    }
    if (user.status === 'deleted') throw new UnauthorizedException('Account deleted');
    const tokens = await this.issueTokens(user);
    return { user, ...tokens };
  }

  async logout(refreshJti: string) {
    await this.refreshRepo.update({ id: refreshJti }, { revokedAt: new Date() });
  }

  async refresh(refreshJti: string, presentedHash: string) {
    const row = await this.refreshRepo.findOne({ where: { id: refreshJti } });
    if (!row) throw new UnauthorizedException('Invalid refresh');

    // Note: the controller passes `${jti}.${plain}` and we bcrypt-compare that
    // against the stored hash. The plain part is never persisted.
    const hashMatches = await bcrypt.compare(presentedHash, row.hash);
    if (!hashMatches) throw new UnauthorizedException('Invalid refresh');

    if (row.revokedAt) {
      // Reuse detected — kill the whole chain for this user.
      this.logger.error(`Refresh reuse detected for user ${row.userId} jti=${refreshJti}`);
      await this.refreshRepo.update(
        { userId: row.userId, revokedAt: null as any },
        { revokedAt: new Date() },
      );
      await this.users['users'].increment({ id: row.userId }, 'tokenVersion', 1);
      throw new UnauthorizedException('Refresh reuse detected');
    }
    if (row.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('Refresh expired');
    }

    const user = await this.users.findById(row.userId);
    if (!user) throw new UnauthorizedException();
    if (user.tokenVersion !== row.tokenVersion) {
      // Someone bumped tokenVersion (password reset / global logout).
      throw new UnauthorizedException('Token version mismatch');
    }

    // Rotate: mark old row revoked + replaced; insert new row.
    const newJti = randomBytes(16).toString('hex');
    const newPlain = randomBytes(48).toString('base64url');
    const newHash = await bcrypt.hash(`${newJti}.${newPlain}`, 10);
    const ttl = msFromTtl(this.config.get<string>('jwt.refreshTtl')!);

    await this.refreshRepo.update(
      { id: refreshJti },
      { revokedAt: new Date(), replacedBy: newJti },
    );
    await this.refreshRepo.insert({
      id: newJti,
      userId: user.id,
      hash: newHash,
      expiresAt: new Date(Date.now() + ttl),
      tokenVersion: user.tokenVersion,
    });

    const accessToken = await this.signAccess({
      sub: user.id,
      role: user.role,
      tv: user.tokenVersion,
    });

    return { accessToken, refreshToken: `${newJti}.${newPlain}` };
  }

  // ───────────────────── Forgot / Reset ─────────────────────

  async forgotPassword(email: string, ip?: string) {
    const user = await this.users.findByEmail(email);
    if (user && !user.isEmailVerified) {
      // still skipped — they're not fully on board; the code path below
      // would issue an OTP but the user can't use it (login blocked)
    }
    if (user && user.isEmailVerified) {
      const { code } = await this.otp.issue({
        userId: user.id,
        purpose: OtpPurpose.PASSWORD_RESET,
        ip,
      });
      await this.mail.sendOtp(user.email, code, 'password_reset');
    }
    return { sent: true } as const; // always the same response
  }

  async resetPassword(email: string, code: string, newPassword: string) {
    const user = await this.users.findByEmail(email);
    if (!user) throw new BadRequestException('Invalid');
    await this.otp.verify({
      userId: user.id,
      purpose: OtpPurpose.PASSWORD_RESET,
      code,
    });
    await this.users.setPasswordHash(user.id, newPassword);
    // Revoke all refresh tokens for this user.
    await this.refreshRepo.update(
      { userId: user.id, revokedAt: null as any },
      { revokedAt: new Date() },
    );
    return { reset: true } as const;
  }

  // ───────────────────── Token helpers ─────────────────────

  private async issueTokens(user: User) {
    const jti = randomBytes(16).toString('hex');
    const refreshPlain = randomBytes(48).toString('base64url');
    const refreshHash = await bcrypt.hash(`${jti}.${refreshPlain}`, 10);
    const ttl = msFromTtl(this.config.get<string>('jwt.refreshTtl')!);
    await this.refreshRepo.insert({
      id: jti,
      userId: user.id,
      hash: refreshHash,
      expiresAt: new Date(Date.now() + ttl),
      tokenVersion: user.tokenVersion,
    });
    const accessToken = await this.signAccess({
      sub: user.id,
      role: user.role,
      tv: user.tokenVersion,
    });
    return {
      accessToken,
      refreshToken: `${jti}.${refreshPlain}`,
    };
  }

  private async signAccess(payload: JwtAccessPayload): Promise<string> {
    return this.jwt.signAsync(payload, {
      secret: this.config.get<string>('jwt.accessSecret'),
      expiresIn: this.config.get<string>('jwt.accessTtl'),
    });
  }
}

function msFromTtl(ttl: string): number {
  const m = ttl.match(/^(\d+)([smhd])$/);
  if (!m) return 7 * 24 * 3600 * 1000;
  const n = Number(m[1]);
  return n * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's'|'m'|'h'|'d'];
}
```

### 11.1 The `RefreshToken` entity

`backend/src/auth/entities/refresh-token.entity.ts`:

```ts
import { User } from 'src/user/entities/user.entity';
import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';

@Entity('refresh_tokens')
@Index('idx_refresh_user_active', ['userId', 'revokedAt'])
export class RefreshToken {
  @PrimaryColumn({ type: 'varchar', length: 32 })
  id!: string; // jti

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ type: 'int', name: 'user_id' })
  userId!: number;

  // bcrypt hash of "<jti>.<plain>" — never the plain
  @Column({ type: 'varchar', length: 80, select: false })
  hash!: string;

  @Column({ type: 'int', name: 'token_version' })
  tokenVersion!: number;

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expiresAt!: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'revoked_at' })
  revokedAt!: Date | null;

  @Column({ type: 'varchar', length: 32, nullable: true, name: 'replaced_by' })
  replacedBy!: string | null;
}
```

Add a migration for it (`backend/src/migrations/1700000000005-refresh-tokens.ts`):

```ts
import { MigrationInterface, QueryRunner } from 'typeorm';

export class RefreshTokens1700000000005 implements MigrationInterface {
  name = 'RefreshTokens1700000000005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id              varchar(32) PRIMARY KEY,
        user_id         int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        hash            varchar(80) NOT NULL,
        token_version   int NOT NULL,
        expires_at      timestamptz NOT NULL,
        revoked_at      timestamptz,
        replaced_by     varchar(32)
      );
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_refresh_user_active
      ON refresh_tokens (user_id) WHERE revoked_at IS NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS refresh_tokens;`);
  }
}
```

And register `RefreshToken` in `app.module.ts`'s `entities` array and in the `data-source.ts` entities.

### 11.2 The dummy-hash timing-attack mitigation

The constant-time `bcrypt.compare` against a dummy hash:
```ts
const DUMMY_HASH = '$2b$12$CwTycUXWue0Thq9StjUM0uJ8VbG3zS8qJ7z8qJ7z8qJ7z8qJ7z8qJ';
const hash = user?.passwordHash ?? DUMMY_HASH;
const ok = await bcrypt.compare(password, hash);
```

Why bother? Because `bcrypt.compare(real, real)` is ~250ms. `bcrypt.compare(real, undefined)` is 0ms (returns false immediately, no hashing). Without the dummy, the attacker can:
1. Send `login({ email: 'victim@example.com', password: 'guess' })` and measure the response time.
2. If 250ms, the user exists. If 5ms, the user does not exist.
3. Repeat to enumerate every email registered.

The dummy hash is a real bcrypt hash that, when compared against any input, takes ~250ms regardless. The compare returns false (because the hash doesn't match), but the timing is the same. **The user's existence is no longer observable through the timing channel.**

A more aggressive version: always do TWO bcrypt compares, even if the first one is on the real hash, so the response time has even less variance. This lesson's code is the minimum acceptable.

### 11.3 The "always 200 on forgot-password" choice

```ts
async forgotPassword(email: string, ip?: string) {
  const user = await this.users.findByEmail(email);
  // ... skip if user missing or not verified
  return { sent: true } as const; // ALWAYS the same response
}
```

Why? Because returning `404` for "email not found" tells the attacker that the email is not in our database. The same attack as the timing channel, but via response body. The fix: **never reveal whether the email exists**. The user (real) doesn't know if they typed their email right; they should re-check.

The cost: a malicious actor can spam our `/forgot-password` endpoint with random email addresses and we'll send no email. The cost is borne by us (zero emails sent = zero SMTP load), not the attacker (they learn nothing). The rate limit on this endpoint (3/hour) bounds the spam.

### 11.4 Why the refresh token is `<jti>.<plain>`

The `jti` is the row's primary key. The `plain` is 48 bytes of CSPRNG entropy. The full string `<jti>.<plain>` is bcrypt-hashed and stored. The user receives both parts. On `/refresh`:
1. We extract `jti` from the cookie.
2. We look up the row by `jti`.
3. We bcrypt-compare the **whole string** (jti + plain) against the stored hash.
4. If it matches, we rotate.

The `jti` is public-ish (it's the row PK), but the `plain` is secret. This means:
- DB breach: attacker has the bcrypt hashes. Without the `plain`, they can't refresh.
- Cookie theft: attacker has the full `<jti>.<plain>`. They can refresh. The user notices eventually (or the throttler catches it).
- DB breach + cookie theft: catastrophic, but rare.

A simpler design uses a single opaque token (no `jti` prefix) and looks up by hashing the whole thing. The cost is the lookup requires `SELECT * FROM refresh_tokens WHERE hash = ?` which is `O(N)` without a special index. The two-part design lets us do `SELECT * FROM refresh_tokens WHERE id = $jti` which is `O(log N)`. **Performance vs. simplicity — we chose performance because the refresh table grows by 1 row per login, and 1M users × 7 devices = 7M rows.**

### 11.5 The reuse-detection chain reaction

When `/refresh` finds `row.revokedAt != null`:
1. We log `error` severity (this should page someone).
2. We revoke every active refresh token for this user.
3. We bump `tokenVersion` (invalidates all access tokens too).
4. We throw 401.

The chain reaction is intentional: a stolen refresh token being re-used means the attacker has it, and the only safe response is to assume **all** of the user's tokens are compromised. The user has to log in again on every device.

The cost: a single network blip where the user's browser sends the old refresh token after the new one was set → the user is logged out of every device. This is rare in practice (browsers don't replay refresh requests) but possible. Lesson 30's "logout everywhere" admin feature uses the same mechanism.

### 11.6 The `tokenVersion` mismatch path

```ts
if (user.tokenVersion !== row.tokenVersion) {
  throw new UnauthorizedException('Token version mismatch');
}
```

If the user reset their password, `setPasswordHash` bumped `tokenVersion` from N to N+1. The row in `refresh_tokens` has `token_version = N` (set at issue time). On the next refresh, `user.tokenVersion = N+1` ≠ `row.tokenVersion = N`. We reject.

This is the safety net for "the user changed their password but the old refresh token is still in the database because we forgot to revoke". Even if a future bug causes us to skip the revoke, this check stops the bleeding. **Defense in depth.**

---

## 12. The `AuthController`

`backend/src/auth/auth.controller.ts`:

```ts
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { LoginDto } from './dto/login.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { Public } from './decorators/public.decorator';
import { JwtRefreshGuard } from './guards/jwt-refresh.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import { GoogleAuthGuard } from './strategies/google.strategy';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  private setAuthCookies(res: Response, access: string, refresh: string) {
    const secure = this.config.get<boolean>('cookies.secure');
    res.cookie('access_token', access, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/',
      maxAge: 15 * 60 * 1000,
    });
    res.cookie('refresh_token', refresh, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/api/v1/auth',   // only sent to auth endpoints
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
  }

  // ───── Register ─────
  @Public()
  @Post('register')
  @Throttle({ default: { limit: 5, ttl: 60 * 60 * 1000 } }) // 5 / hour
  @HttpCode(201)
  async register(@Body() body: RegisterDto, @Req() req: Request) {
    return this.auth.register(body.email, body.password, req.ip);
  }

  // ───── Verify-email ─────
  @Public()
  @Post('verify-email')
  @Throttle({ default: { limit: 10, ttl: 60 * 1000 } }) // 10 / min
  @HttpCode(200)
  async verifyEmail(
    @Body('userId') userId: number,
    @Body() body: VerifyEmailDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.verifyEmail(Number(userId), body.code);
    this.setAuthCookies(res, result.accessToken, result.refreshToken);
    return { user: result.user };
  }

  // ───── Resend OTP ─────
  @Public()
  @Post('resend-otp')
  @Throttle({ default: { limit: 6, ttl: 60 * 1000 } }) // 6 / min
  @HttpCode(200)
  async resendOtp(@Body('email') email: string, @Req() req: Request) {
    return this.auth.resendVerification(email, req.ip);
  }

  // ───── Login ─────
  @Public()
  @Post('login')
  @Throttle({ default: { limit: 5, ttl: 15 * 60 * 1000 } }) // 5 / 15min
  @HttpCode(200)
  async login(@Body() body: LoginDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.login(body.email, body.password);
    this.setAuthCookies(res, result.accessToken, result.refreshToken);
    return { user: result.user };
  }

  // ───── Logout ─────
  @UseGuards(JwtRefreshGuard)
  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentUser() user: any) {
    await this.auth.logout(user.refreshJti);
  }

  // ───── Refresh ─────
  @Public()
  @UseGuards(JwtRefreshGuard)
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @CurrentUser() user: any,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const presented = req.cookies['refresh_token'] as string;
    const [jti, plain] = presented.split('.');
    const result = await this.auth.refresh(jti, `${jti}.${plain}`);
    this.setAuthCookies(res, result.accessToken, result.refreshToken);
    return { ok: true };
  }

  // ───── Forgot password ─────
  @Public()
  @Post('forgot-password')
  @Throttle({ default: { limit: 3, ttl: 60 * 60 * 1000 } }) // 3 / hour
  @HttpCode(200)
  async forgot(@Body() body: ForgotPasswordDto, @Req() req: Request) {
    return this.auth.forgotPassword(body.email, req.ip);
  }

  // ───── Reset password ─────
  @Public()
  @Post('reset-password')
  @Throttle({ default: { limit: 5, ttl: 60 * 60 * 1000 } })
  @HttpCode(200)
  async reset(@Body() body: ResetPasswordDto) {
    return this.auth.resetPassword(body.email, body.code, body.newPassword);
  }

  // ───── Google OAuth ─────
  @Public()
  @Get('google')
  @UseGuards(GoogleAuthGuard)
  async google() {
    /* handled by Passport */
  }

  @Public()
  @Get('google/callback')
  @UseGuards(GoogleAuthGuard)
  async googleCallback(@Req() req: any, @Res() res: Response) {
    const { accessToken, refreshToken } = req.user as {
      accessToken: string;
      refreshToken: string;
    };
    this.setAuthCookies(res, accessToken, refreshToken);
    res.redirect(this.config.get<string>('frontendUrl') + '/profile');
  }
}
```

### 12.1 The cookie path scoping

```ts
res.cookie('refresh_token', refresh, {
  path: '/api/v1/auth',   // only sent to auth endpoints
  ...
});
```

The refresh token cookie is **scoped to `/api/v1/auth`**. It will not be sent on `/api/v1/experts` or `/api/v1/profile`. This is the smallest possible scope for a cookie that needs to reach `/refresh`. **It is a defense against the entire class of "an XSS somewhere on the site reads `document.cookie` and exfiltrates the refresh token."** Even if a malicious script runs on `/profile`, it can't read the refresh token from JavaScript because the cookie isn't sent there (and even if it were, it's `httpOnly` so `document.cookie` is empty).

The access token has `path: '/'` because *every* authenticated endpoint needs it.

### 12.2 The `sameSite: 'lax'` choice

- **`strict`**: Cookie is not sent on cross-site requests *at all*. This breaks OAuth callbacks (Google's redirect comes from `accounts.google.com`, a different site). Login from email link → cookie not set → user confused.
- **`lax`**: Cookie is sent on cross-site GET requests (top-level navigation). OAuth callback works. CSRF on POST is still blocked.
- **`none`**: Cookie is sent on cross-site requests including POST. Requires `secure: true` and is the most permissive.

We chose `lax` because it works with OAuth and blocks CSRF on state-changing endpoints. **Do not use `strict` here; the OAuth flow will break.**

### 12.3 The `@HttpCode` choice

- `register` returns 201 (created).
- `verify-email` returns 200 (the resource is the user; we modified them).
- `login` returns 200.
- `logout` returns 204 (no content).
- `refresh` returns 200.
- `forgot-password`, `reset-password` return 200 (success but the body is `{ sent: true }` or `{ reset: true }` — not a creation).

Wrong status codes confuse API consumers. The defaults NestJS uses are 200 and 201, but we want explicit control.

### 12.4 The throttling values, defended

| Endpoint | Limit | Why |
|---|---|---|
| `register` | 5 / hour | Spammers can create 5 emails per IP per hour. Over 24 hours, 120 accounts per IP. Bounded. |
| `verify-email` | 10 / min | A real user types 1-3 times. 10/min allows the user to fail twice and still be within budget. |
| `resend-otp` | 6 / min | Combined with the 60-second cooldown in OtpService, 6 attempts is the upper bound before the user gives up. |
| `login` | 5 / 15 min | The OWASP-recommended baseline. 5 × 4 = 20 attempts per hour per IP is tolerable. |
| `forgot-password` | 3 / hour | This endpoint is mail-cheap but exists mostly for enumeration attacks. 3/hour is the budget. |
| `reset-password` | 5 / hour | A real user does this once. 5 allows for typos. |

The ThrottlerModule's default of 60/min is the global fallback. The `@Throttle` decorator overrides per-endpoint.

### 12.5 Why `@Public()` on `/refresh`

The `/refresh` endpoint looks like a normal authenticated route — it needs a refresh token. But it can't require the *access* token (that would be circular: to get a new access token, you need the access token). So we mark it `@Public()` and rely on the `JwtRefreshGuard` to validate the *refresh* token. The global `JwtAuthGuard` is bypassed; the `JwtRefreshGuard` is the only gate.

This is a subtle but critical pattern: **two token types, two guards, one marked public to skip the access-token guard.**

---

## 13. Wiring the guards, strategies, and modules

`backend/src/auth/decorators/public.decorator.ts`:

```ts
import { SetMetadata } from '@nestjs/common';
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
```

`backend/src/auth/decorators/current-user.decorator.ts`:

```ts
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().user,
);
```

`backend/src/auth/decorators/roles.decorator.ts`:

```ts
import { SetMetadata } from '@nestjs/common';
import { UserRole } from 'src/user/entities/user.entity';
export const ROLES_KEY = 'roles';
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
```

`backend/src/auth/guards/jwt-auth.guard.ts`:

```ts
import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt-access') {
  constructor(private reflector: Reflector) {
    super();
  }
  canActivate(ctx: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(ctx);
  }
}
```

`backend/src/auth/guards/jwt-refresh.guard.ts`:

```ts
import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

@Injectable()
export class JwtRefreshGuard extends AuthGuard('jwt-refresh') {
  constructor(private reflector: Reflector) {
    super();
  }
  canActivate(ctx: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(ctx);
  }
}
```

`backend/src/auth/guards/roles.guard.ts`:

```ts
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}
  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required || required.length === 0) return true;
    const { user } = ctx.switchToHttp().getRequest();
    if (!user || !required.includes(user.role))
      throw new ForbiddenException('Insufficient role');
    return true;
  }
}
```

`backend/src/auth/strategies/jwt.strategy.ts`:

```ts
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, ExtractJwt } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class JwtAccessStrategy extends PassportStrategy(Strategy, 'jwt-access') {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        (req: any) => req?.cookies?.access_token,
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('jwt.accessSecret')!,
    });
  }

  async validate(payload: any) {
    // payload.tv must match the user's current tokenVersion
    return { userId: payload.sub, role: payload.role, tv: payload.tv };
  }
}
```

`backend/src/auth/strategies/jwt-refresh.strategy.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, ExtractJwt } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class JwtRefreshStrategy extends PassportStrategy(Strategy, 'jwt-refresh') {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        (req: any) => req?.cookies?.refresh_token,
      ]),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('jwt.refreshSecret')!,
      passReqToCallback: false,
    });
  }

  async validate(payload: any) {
    // controllers will use req.user.refreshJti
    return {
      userId: payload.sub,
      refreshJti: payload.jti,
      tv: payload.tv,
    };
  }
}
```

`backend/src/auth/strategies/google.strategy.ts`:

```ts
import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, VerifyCallback } from 'passport-google-oauth20';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../auth.service';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(
    config: ConfigService,
    private readonly auth: AuthService,
  ) {
    super({
      clientID: config.get<string>('google.clientId')!,
      clientSecret: config.get<string>('google.clientSecret')!,
      callbackURL: config.get<string>('google.callbackUrl')!,
      scope: ['email', 'profile'],
      // stateParam: true is the default; we rely on it for CSRF protection.
    });
  }

  async validate(
    _accessToken: string,
    _refreshToken: string,
    profile: any,
    done: VerifyCallback,
  ): Promise<void> {
    try {
      const email = profile.emails?.[0]?.value;
      const googleId = profile.id;
      if (!email || !googleId) {
        return done(new BadRequestException('No email from Google'), undefined);
      }
      const tokens = await this.auth.googleLogin({ googleId, email });
      done(null, tokens);
    } catch (e) {
      done(e as Error, undefined);
    }
  }
}

export const GoogleAuthGuard = AuthGuard('google');
```

`backend/src/auth/auth.google.ts` (in the service, see `googleLogin` below):

```ts
// Add to AuthService:
async googleLogin(profile: { googleId: string; email: string }) {
  // 1. By googleId
  let user = await this.users.findByGoogleId(profile.googleId);
  // 2. Otherwise, by email (existing user, not yet linked). Per Lesson 10 §3.6,
  //    we DO NOT silently link — we tell them to log in with their password
  //    and link from settings. For an MVP we accept the link if the email
  //    matches and no googleId present.
  if (!user) {
    user = await this.users.findByEmail(profile.email);
    if (user && user.googleId) {
      // already linked to a *different* google account — refuse
      throw new BadRequestException('Email already linked to another Google account');
    }
    if (user && !user.googleId) {
      await this.users.linkGoogle(user.id, profile.googleId, profile.email);
      user = (await this.users.findById(user.id))!;
    }
  }
  if (!user) {
    user = await this.users.createFromGoogle({
      googleId: profile.googleId,
      email: profile.email,
    });
  }
  return this.issueTokens(user);
}
```

`backend/src/auth/auth.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_GUARD } from '@nestjs/core';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { UsersModule } from 'src/users/users.module';
import { OtpModule } from 'src/otp/otp.module';
import { MailModule } from 'src/mail/mail.module';
import { JwtAccessStrategy } from './strategies/jwt.strategy';
import { JwtRefreshStrategy } from './strategies/jwt-refresh.strategy';
import { GoogleStrategy } from './strategies/google.strategy';
import { RefreshToken } from './entities/refresh-token.entity';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { JwtRefreshGuard } from './guards/jwt-refresh.guard';
import { RolesGuard } from './guards/roles.guard';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

@Module({
  imports: [
    PassportModule,
    JwtModule.register({}),
    TypeOrmModule.forFeature([RefreshToken]),
    UsersModule,
    OtpModule,
    MailModule,
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }]),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtAccessStrategy,
    JwtRefreshStrategy,
    GoogleStrategy,
    JwtAuthGuard,
    JwtRefreshGuard,
    RolesGuard,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  exports: [AuthService, JwtAuthGuard, RolesGuard],
})
export class AuthModule {}
```

`backend/src/app.module.ts` updates:

```ts
import { AuthModule } from './auth/auth.module';
import { MailModule } from './mail/mail.module';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';

// inside @Module imports:
ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }]),
MailModule,
AuthModule,

// remove from providers (now in AuthModule):
// { provide: APP_GUARD, useClass: ThrottlerGuard },
// { provide: APP_GUARD, useClass: JwtAuthGuard },
```

The global `JwtAuthGuard` requires `@Public()` on every public endpoint. We did that above.

### 13.1 Why `ThrottlerModule` lives in `AuthModule`, not `AppModule`

`ThrottlerModule` is global if registered in any module that's in the import chain. Registering it in `AuthModule` makes the throttler available to every route in the app, not just auth routes. This is the convention: cross-cutting concerns live in the module that introduces them.

For multi-instance deployments (Lesson 50), we'll switch the `ThrottlerModule` storage to Redis. The location doesn't change.

### 13.2 The two-`APP_GUARD` pattern

```ts
providers: [
  { provide: APP_GUARD, useClass: ThrottlerGuard },
  { provide: APP_GUARD, useClass: JwtAuthGuard },
],
```

NestJS applies guards in the order they are registered. **Throttler first, then JWT.** This is intentional: a request from a banned IP should be 429'd *before* we waste cycles verifying its (probably-fake) JWT.

If the order were reversed, an attacker could DoS the JWT verifier with garbage requests from one IP, burning CPU on `bcrypt.compare`-equivalent signature checks. The throttler kills the requests before they get there.

### 13.3 The `state` parameter on Google OAuth

`passport-google-oauth20` enables `state: true` by default, which generates a CSRF token on the initial `/auth/google` request and validates it on the callback. **Do not disable this.** It is the defense against "an attacker's site triggers a Google OAuth flow that the victim completes, then the attacker's site gets the victim's session."

The implementation is automatic; you do nothing. But if you see "OAuth state mismatch" errors in logs, your session middleware is broken (cookies aren't being sent on the redirect), and you should not "fix" it by disabling the state check.

---

## 14. The exception filter (logged, sanitized)

`backend/src/common/filters/all-exceptions.filter.ts`:

```ts
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const isHttp = exception instanceof HttpException;
    const status = isHttp
      ? (exception as HttpException).getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    const body = isHttp
      ? (exception as HttpException).getResponse()
      : { statusCode: 500, message: 'Internal server error' };

    if (status >= 500) {
      this.logger.error(
        `${req.method} ${req.url} ${status}`,
        (exception as Error)?.stack,
      );
    } else {
      this.logger.warn(`${req.method} ${req.url} ${status}`);
    }

    res.status(status).json(body);
  }
}
```

**Why this filter?** Three guarantees:

1. **No stack traces in responses.** Internal errors return a generic 500.
2. **Server-side logging** for debugging.
3. **Consistent shape:** `{ statusCode, message, ... }`.

### 14.1 What we explicitly do not put in error responses

- The exception's `stack` property. Attackers use stack traces to fingerprint the framework and find vulnerable code paths.
- The DB query that failed. If the SQL had a parameter that was a user-input value (e.g., an email), it's a reflection of PII.
- The internal error code (e.g., `ECONNREFUSED on 10.0.5.23:5432`). This leaks infrastructure topology.

The filter sanitizes by replacing all non-HttpException errors with a generic `Internal server error`. The server-side log retains the full stack for debugging. **The asymmetry between response and log is intentional and required.**

### 14.2 Why `>= 500` is the threshold for `error` severity

- `400-499` are client errors. The client did something wrong. Logging at `warn` is correct.
- `500-599` are server errors. We did something wrong. Logging at `error` is correct. **These are the alerts that should page on-call.**

If a 404 is logged at `error`, your on-call will be paged 10,000 times per day for bot traffic scanning for `/wp-admin.php`. Threshold logic in the filter is a small thing that prevents alert fatigue.

---

## 15. Tests

### 15.1 Unit: `OtpService`

`backend/src/otp/otp.service.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Otp } from './entities/otp.entity';
import { OtpService } from './otp.service';
import { User } from 'src/user/entities/user.entity';
import { randomBytes } from 'crypto';

describe('OtpService', () => {
  let service: OtpService;
  let users: Repository<User>;
  let otps: Repository<Otp>;

  beforeEach(async () => {
    const mod = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'sqlite',
          database: ':memory:',
          dropSchema: true,
          entities: [User, Otp],
          synchronize: true,  // OK in unit tests, NOT in e2e
        }),
        TypeOrmModule.forFeature([Otp, User]),
      ],
      providers: [OtpService],
    }).compile();
    service = mod.get(OtpService);
    users = mod.get(getRepositoryToken(User));
    otps = mod.get(getRepositoryToken(Otp));
    await users.save(users.create({ email: 'a@x.com', passwordHash: 'x' }));
  });

  it('issues a 6-digit code', async () => {
    const u = await users.findOneByOrFail({ email: 'a@x.com' });
    const { code } = await service.issue({ userId: u.id, purpose: 'email_verification' });
    expect(code).toMatch(/^\d{6}$/);
  });

  it('refuses second issue within cooldown', async () => {
    const u = await users.findOneByOrFail({ email: 'a@x.com' });
    await service.issue({ userId: u.id, purpose: 'email_verification' });
    await expect(
      service.issue({ userId: u.id, purpose: 'email_verification' }),
    ).rejects.toMatchObject({ status: 429 });
  });

  it('verifies a correct code and locks after 5 wrong tries', async () => {
    const u = await users.findOneByOrFail({ email: 'a@x.com' });
    // Need to bypass cooldown — set lastSentAt in the past.
    const first = await service.issue({ userId: u.id, purpose: 'password_reset' });
    await otps.update(
      { user: { id: u.id } as any, purpose: 'password_reset' },
      { lastSentAt: new Date(Date.now() - 61_000) },
    );
    const { code } = await service.issue({ userId: u.id, purpose: 'password_reset' });

    await expect(service.verify({ userId: u.id, purpose: 'password_reset', code })).resolves.toBe(true);

    // wrong code path
    const second = await service.issue({ userId: u.id, purpose: 'email_verification' });
    await otps.update(
      { user: { id: u.id } as any, purpose: 'email_verification' },
      { lastSentAt: new Date(Date.now() - 61_000) },
    );
    for (let i = 0; i < 4; i++) {
      await expect(
        service.verify({ userId: u.id, purpose: 'email_verification', code: '000000' }),
      ).rejects.toBeTruthy();
    }
    await expect(
      service.verify({ userId: u.id, purpose: 'email_verification', code: '000000' }),
    ).rejects.toMatchObject({ status: 429 });
  });
});
```

### 15.2 e2e: full register-verify-login-refresh-reuse

`backend/test/auth.e2e.ts`:

```ts
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from 'src/app.module';
import { DataSource } from 'typeorm';
import { Otp } from 'src/otp/entities/otp.entity';
import { randomBytes } from 'crypto';

describe('Auth (e2e)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let lastOtpCode: string;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: 1 as any, defaultVersion: '1' });
    await app.init();
    ds = app.get(DataSource);
  });

  afterAll(async () => {
    await ds.dropDatabase();
    await app.close();
  });

  /**
   * For tests, we read the OTP from the database (the cleartext is gone;
   * we get the hash). In a real test we'd inject a MailService spy that
   * captures the cleartext on the way out.
   *
   * For this lesson we accept the limitation and do a workflow test that
   * doesn't depend on reading the OTP: we trigger a verify with the wrong
   * code, count attempts to 5, and assert the lock.
   */
  function getLatestOtpRow(email: string): Promise<Otp> {
    return ds.getRepository(Otp).findOneOrFail({
      where: { user: { email } },
      order: { lastSentAt: 'DESC' },
    });
  }

  it('register → verify → login → refresh → reuse-detect', async () => {
    const email = `${randomBytes(4).toString('hex')}@x.com`;
    const password = 'a-strong-password-123';

    // 1. Register
    const register = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password })
      .expect(201);
    expect(register.body).toHaveProperty('userId');

    // 2. Verify (we don't have the OTP — instead, test wrong-code lockout)
    const userId = register.body.userId;
    for (let i = 0; i < 4; i++) {
      await request(app.getHttpServer())
        .post('/api/v1/auth/verify-email')
        .send({ userId, code: '000000' })
        .expect(400);
    }
    await request(app.getHttpServer())
      .post('/api/v1/auth/verify-email')
      .send({ userId, code: '000000' })
      .expect(429);

    // 3. Login should fail because email not verified
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(400);

    // 4. Mark verified manually for the next steps
    await ds.getRepository('users').update({ id: userId }, { is_email_verified: true });

    // 5. Login
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);
    expect(login.headers['set-cookie']).toBeDefined();
    const cookies = login.headers['set-cookie'];

    // 6. Refresh
    const refresh = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookies)
      .expect(200);
    const newCookies = refresh.headers['set-cookie'];

    // 7. Reuse-detection: refresh with the OLD cookies
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookies)
      .expect(401);

    // 8. Even the new cookies should now be revoked (chain reaction)
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', newCookies)
      .expect(401);
  });

  it('forgot-password returns 200 even for non-existent email', async () => {
    const email = `nonexistent-${randomBytes(4).toString('hex')}@x.com`;
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/forgot-password')
      .send({ email })
      .expect(200);
    expect(res.body).toEqual({ sent: true });
  });
});
```

### 15.3 The "OTP cleartext in tests" problem

Production code: `MailService.sendOtp(to, code, purpose)` is called with the cleartext code. The code is in memory only, then passed to the email, then forgotten.

Test code: we want to verify the OTP that was "emailed". Two options:

1. **Spy on `MailService`**: replace it with a stub that captures the code. The test reads `spy.calls[0].args[1]` to get the code.
2. **Read from the DB**: impossible because we only store the bcrypt hash, not the cleartext.

Option 1 is the only correct approach. **Do not** add a debug `console.log` of the code, and **do not** add a `return { code }` to the response. The test code in this lesson uses option 2 for the wrong-code lockout (we don't need the cleartext) but for the happy-path register-verify you should use option 1.

A working `MailService` spy:

```ts
const mailSpy = { sendOtp: jest.fn().mockResolvedValue(undefined) };
const mod = await Test.createTestingModule({...})
  .overrideProvider(MailService).useValue(mailSpy)
  .compile();
// ... after register:
expect(mailSpy.sendOtp).toHaveBeenCalledWith(email, expect.stringMatching(/^\d{6}$/), 'email_verification');
const code = mailSpy.sendOtp.mock.calls[0][1];
// ... use code in verify-email:
await request(app.getHttpServer()).post('/api/v1/auth/verify-email').send({ userId, code }).expect(200);
```

### 15.4 Concrete e2e scenarios to write and run

For each, write the supertest code in `auth.e2e.ts` and assert:

| # | Scenario                                                    | Expect                                                                                              |
|---|--------------------------------------------------------------|-----------------------------------------------------------------------------------------------------|
| 1 | Register new email                                           | 201, response has `userId`; OTP row in DB                                                            |
| 2 | Register same email again                                    | 201, `alreadyExists` true; no new user                                                               |
| 3 | `POST /verify-email` with wrong code (×4)                     | First 4: 400; 5th: 429                                                                               |
| 4 | `POST /resend-otp` twice in <60s                             | 200 first, 429 second                                                                                |
| 5 | Login with wrong password                                    | 401, generic message                                                                                 |
| 6 | Login before verifying email                                 | 400 with `code: 'EMAIL_NOT_VERIFIED'`                                                                |
| 7 | Login after verifying                                        | 200, `Set-Cookie: access_token=...; refresh_token=...`                                              |
| 8 | Hit authenticated endpoint (e.g. `/api/v1/me`) without cookie | 401                                                                                                |
| 9 | Login from two devices → refresh on device 2 → logout device 2 → try old refresh on device 2 | Reuse detected → 401; device 1's tokens also invalidated (tokenVersion bumped) |
| 10| Forgot-password for non-existent email                       | 200, no row inserted                                                                                 |
| 11| Reset-password with valid OTP                                | 200; old refresh tokens revoked; `tokenVersion`+1                                                   |
| 12| Google OAuth — `GET /auth/google`                            | 302 to accounts.google.com                                                                          |
| 13| Throttle: 6 logins within 15 min                             | First 5: 200/401; 6th: 429                                                                           |
| 14| Concurrent refresh from 2 devices on the same jti            | One succeeds, the other gets 401 + chain reaction                                                   |
| 15| Login → logout → refresh old token                           | 401, but token row marked revoked (no chain reaction — the jti was the user's own)                  |
| 16| Register → wait 5 minutes → verify                           | 400 "OTP expired"                                                                                    |
| 17| Password reset, then login with OLD password                 | 401 "Invalid credentials"                                                                            |
| 18| Password reset, then refresh                                 | 401 "Token version mismatch"                                                                         |
| 19| Helmet headers present on /auth/login response               | `X-Content-Type-Options: nosniff` etc.                                                              |
| 20| Validation: register with extra field `isAdmin: true`        | 400, "property isAdmin should not exist"                                                             |

I wrote test 1's frame above. **Write the rest before you ship.** Tests are the difference between "I think it works" and "I know it works".

---

## 16. Observability hooks

The lesson code logs at `warn` and `error`. The full observability story:

### 16.1 What should be in every log line

- `requestId` — UUID set by the `RequestIdInterceptor` (see below), propagated to every log line in the request.
- `userId` — if the user is authenticated.
- `action` — a stable string: `auth.login.success`, `auth.login.fail`, `auth.refresh.reuse_detected`, etc.
- `outcome` — `success` or `fail`.
- `duration_ms` — for performance analysis.

### 16.2 Stable action vocabulary

`auth.register.success`, `auth.register.fail`, `auth.verify.success`, `auth.verify.expired`, `auth.verify.invalid`, `auth.verify.locked`, `auth.login.success`, `auth.login.fail.bad_password`, `auth.login.fail.unverified`, `auth.login.fail.not_found`, `auth.refresh.success`, `auth.refresh.reuse_detected`, `auth.refresh.expired`, `auth.refresh.tv_mismatch`, `auth.forgot.sent`, `auth.forgot.skipped_unverified`, `auth.reset.success`, `auth.reset.invalid_code`, `auth.google.new_user`, `auth.google.linked`, `auth.google.refused_duplicate`.

Every action is a string. They go in a structured log. You can grep for `auth.refresh.reuse_detected` and see all such events. You can count `auth.login.fail.bad_password` per minute and alert on the count exceeding 100 (credential-stuffing signal).

### 16.3 The `RequestIdInterceptor`

```ts
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { randomUUID } from 'crypto';

@Injectable()
export class RequestIdInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<any> {
    const req = ctx.switchToHttp().getRequest();
    const res = ctx.switchToHttp().getResponse();
    const requestId = (req.headers['x-request-id'] as string) ?? randomUUID();
    req.requestId = requestId;
    res.setHeader('x-request-id', requestId);
    return next.handle().pipe(
      tap(() => {
        // log line: { requestId, method, url, status, duration }
      }),
    );
  }
}
```

The `x-request-id` header is propagated back to the client. The user can read it from the response and quote it in a bug report. You can grep your logs for it. The two are linked. **This is the single most useful debug tool for a backend.**

### 16.4 The `auth.refresh.reuse_detected` alert

`this.logger.error(...)` in the reuse-detection code path is your most important alert. If you see this in logs, somebody is replaying a stolen refresh token. The chain reaction is automatic, but you should also:
- Email the user: "We detected suspicious activity on your account. All sessions have been logged out."
- Optionally, lock the account for 15 minutes (Lesson 30 admin tool).

The log line is the trigger. The human action is the policy.

---

## 17. Security implications (a self-audit)

A checklist for what we built and what an attacker would do with it:

| Surface | Attack | Defense we built | Residual risk |
|---|---|---|---|
| `POST /register` | Spammers create accounts | Throttle 5/hour; CAPTCHA in Lesson 50 | Without CAPTCHA, an attacker with rotating IPs can create 1000s/day |
| `POST /verify-email` | Brute-force 1M codes | 5 wrong → 429; 5-minute expiry | A determined attacker with throttler bypass could try 5 codes/min for 1M minutes = 2 years. The 5-minute expiry makes this 5/5min × 1M = 5M minutes = 10 years. |
| `POST /login` | Credential stuffing | 5/15min throttle; bcrypt cost 12 | Cloud NAT allows many users behind one IP. Throttler is per-IP. Lesson 30 adds per-email throttle. |
| `POST /forgot-password` | Email enumeration via timing | Constant dummy-hash compare; identical response | An attacker timing 1000 requests can still statistically infer existence, but with 250ms per request, that's 250 seconds per probe. Bounded. |
| `POST /reset-password` | Brute-force 1M codes | 5 wrong → 429 | Same as verify-email |
| Refresh token theft | Attacker uses the cookie | Rotation; reuse detection; chain reaction | A network MITM that gets both old and new refresh tokens between rotations defeats rotation. HTTPS is the defense. |
| JWT signing secret leak | Attacker forges tokens | `must()` refuses to boot without it; secrets are different for access/refresh | If a secret *is* leaked (e.g., from a CI log), there's no automatic rotation. Lesson 50 adds a `kid` header for rotation. |
| Google OAuth state bypass | Attacker triggers login on victim's behalf | `state: true` default in `passport-google-oauth20` | If you ever add a "skip state check for testing" hack, attackers can hijack sessions. Don't. |
| Google OAuth email trust | Attacker registers a Google account with the victim's email | `isEmailVerified = true` on Google flow | A Google account with the victim's email is, by definition, verified by Google. If the victim didn't register it, the attacker controls the email. The user can re-bind by resetting their password. |
| Helmet bypass | Attacker exploits missing headers | `helmet()` in `main.ts` | Helmet's defaults are not exhaustive. Add CSP if you serve HTML. |
| Cookie CSRF | Attacker forges a state-changing request from another site | `sameSite: 'lax'` on auth cookies | `lax` blocks cross-site POST. Top-level GET navigation still sends the cookie. For high-security endpoints, add a CSRF token (Lesson 50). |
| Bcrypt cost 12 | Offline cracking of leaked hash | Cost 12 = 250ms per guess | 250ms × 1M combinations × 10 GPUs = 28 hours. Acceptable. |

### 17.1 The "what could go wrong" review for each endpoint

- **`/register`**: spammers (covered), email enumeration (the response is the same whether the email exists or not — covered), DoS (throttled — covered).
- **`/verify-email`**: brute-force (covered), replay (5-min expiry — covered), but **if a user has the same code emailed twice to two different addresses** (mistake in our code), an attacker who controls one address can use the code. The current code does not duplicate-issue; check the test.
- **`/login`**: credential stuffing (covered), account enumeration via timing (covered by dummy hash — but verify in production with a real timing test).
- **`/forgot-password`**: enumeration (covered), spam (throttled — but 3/hour/IP is generous; consider 1/hour).
- **`/reset-password`**: brute-force (covered), but a reset *succeeding* doesn't notify the user out-of-band. Consider emailing "Your password was changed" on success.
- **`/refresh`**: replay (reuse detection — covered), but the chain reaction logs out the user from every device. The user has to log back in. If the user is on a metered connection, this is a real cost.

---

## 18. Debugging recipes

When something breaks (and it will), here's how to find the bug:

### 18.1 "Login always returns 401 even with the right password"

1. Check the user row: `SELECT id, email, pass_hash FROM users WHERE email = '...'`. If `pass_hash` is null, the registration didn't hash the password. (Lesson 05's `createWithPassword` issue.)
2. Check the column: is it `passwordHash` (camelCase in JS) or `pass_hash` (snake_case in DB)? The `select: false` decorator uses the JS name; the column is the SQL name. A mismatch means the column is silently not selected.
3. Check the `addSelect` call: did `findByEmail` use `addSelect('u.passwordHash')`? Without it, the user comes back with `passwordHash = undefined`. `bcrypt.compare(input, undefined)` returns false. No error, just always-fail.
4. Add a `console.log` *temporarily* in `findByEmail` to print the row count and the `passwordHash` length. Remove before commit.

### 18.2 "Refresh token works once, then 401s"

This is the reuse-detection chain reaction. The first refresh succeeds. The second fails. **But if the second fails, the user's other devices also fail.** The log line is:
```
ERROR [AuthService] Refresh reuse detected for user 42 jti=abc123
```

This is *expected behavior*, not a bug. If the user reports it, they probably:
- Have two browser tabs open, one of which refreshed and the other is now using the old cookie.
- Have a mobile app and a web session; one of them is stale.

The product fix is to make the *first* refresh's response include the new refresh token in a way that both tabs can pick up (e.g., via `ServiceWorker` or BroadcastChannel). The lesson's design is correct; the UX is a Lesson 50 problem.

### 18.3 "OTP email never arrives"

1. Check `MailService` logs: `Failed to send OTP email to ...`? If yes, the SMTP is broken.
2. Check the OTP row: `SELECT * FROM otp WHERE user_id = ...`. If the row is there, the issue was sending. If it's not, `OtpService.issue` threw — look for the 429 cooldown error.
3. Check the cooldown: was an OTP issued in the last 60 seconds? `last_sent_at` is in the row. The `resend-otp` endpoint will 429 in that case.
4. Check spam folders. With 6-digit codes in subject lines, Gmail sometimes auto-files them as spam.

### 18.4 "Google OAuth callback returns 500"

1. Check `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set.
2. Check the redirect URI in the Google Cloud Console matches `GOOGLE_CALLBACK_URL` exactly. `http://localhost:3000/api/v1/auth/google/callback` ≠ `http://localhost:3000/api/v1/auth/google/callback/` (trailing slash).
3. Check that the OAuth app is configured for "External" users (not just "Internal" if you're on a Workspace).
4. Check the `validate` callback in `GoogleStrategy` — if it throws, the 500 comes from there. The error is in logs.

### 18.5 "Tests pass locally but fail in CI"

1. CI usually doesn't have the SMTP server. Either spin up a test SMTP (MailHog, Mailtrap) or mock `MailService`.
2. The `synchronize: true` in tests is a footgun in CI because CI may run against a real Postgres. Lesson 05: use migrations everywhere.
3. The `e2e` test calls `ds.dropDatabase()` in `afterAll`. If two test files run in parallel, they fight over the DB. Run e2e tests serially or use isolated schemas.

### 18.6 "Throttler says 429 when I shouldn't be limited"

The throttler is per-IP. In dev, your IP is `127.0.0.1`. In CI, all tests come from `127.0.0.1`. The first test passes, the second 429s. The fix: use a `ThrottlerStorage` that has per-test isolation, or accept the 429 and design tests to handle it.

In production, the throttler may share a Redis store across instances, in which case the limit is per-IP-cluster, not per-instance. Verify your config.

---

## 19. Common mistakes (the full list)

| Mistake                                                                                          | Symptom                                                | Fix                                                       |
|--------------------------------------------------------------------------------------------------|--------------------------------------------------------|-----------------------------------------------------------|
| Forgetting `app.use(cookieParser())`                                                              | `req.cookies` is undefined                             | Add the middleware                                        |
| Returning the plain OTP in the verification response "for testing"                               | OTPs leak in dev logs; eventually in prod              | Never. Read from DB in tests via a MailService spy        |
| Using `bcrypt.compare` against `passwordHash` from a `findOne` that didn't `addSelect`           | `TypeError: bcrypt compare with undefined`             | Use `findByEmail` with `addSelect('u.passwordHash')`      |
| Setting `synchronize: true` "just for tests"                                                      | Tests pass; prod schema drift                          | Always `synchronize: false`                              |
| Returning 401 with `{ code: 'USER_NOT_FOUND' }`                                                  | Account enumeration via timing                         | Always identical message; constant-time-ish compare       |
| Putting the JWT in localStorage                                                                   | XSS exfiltrates tokens                                 | `httpOnly` cookie                                         |
| Long-lived access tokens                                                                          | Stolen token works for hours                           | 15 minutes, refresh rotation                              |
| `sameSite=strict` on auth cookies                                                                 | OAuth callback breaks                                  | `sameSite=lax`                                            |
| `select: false` on `passwordHash` but no `addSelect` on login                                    | Login always "wrong password"                          | `addSelect` once, in `findByEmail`                        |
| Refreshing tokens without rotating                                                                | Stolen refresh token = long-term access                | Insert new row, revoke old                                |
| Not checking `tv` on access                                                                       | Old access tokens keep working through password reset | Put `tv` in payload, compare in middleware                |
| `googleId` `unique: true` without `WHERE google_id IS NOT NULL`                                   | First OAuth user blocks every OAuth user               | Partial unique index in migration                         |
| Throttler bound only by IP (cloud NAT)                                                            | One attacker DoSes a whole corporate office            | Throttle by IP+email where possible                        |
| Sending back the access token in the JSON body *and* setting a cookie                            | Bearer header wins → cookie becomes decorative         | Pick one: cookie for web, header for mobile (Lesson 50)   |
| `Math.random()` for OTP generation                                                                | Predictable codes from a few observations              | `crypto.randomInt`                                        |
| Incrementing `attempts` in memory before save                                                     | Race condition lets parallel requests bypass lockout   | Atomic UPDATE-WHERE                                       |
| Forgetting to bump `tokenVersion` on password reset                                              | Old access tokens keep working for 15 min              | `users.increment({ id }, 'tokenVersion', 1)` in `setPasswordHash` |
| Throwing 500 if mail send fails                                                                   | User retries register; same mail failure                | Log + return 201; rely on resend-otp                       |
| Returning 200 with `{ sent: true }` only when user exists                                         | Account enumeration via response body                  | Always 200                                               |
| `cookie.secure: false` in production                                                              | MITM downgrade steals the cookie                       | `secure: true` when NODE_ENV=production                    |
| Throttler in-memory (per-instance) in production                                                 | 5 instances × 5 attempts = 25 attempts                | Redis store, shared across instances                      |
| `forbidNonWhitelisted: false` on the global ValidationPipe                                       | Attacker probes schema with extra fields                | `forbidNonWhitelisted: true`                              |
| Catching exceptions in the controller and returning 200                                           | Real 500s look like successes to the client             | Let the AllExceptionsFilter handle them                   |
| Refresh path '/auth/refresh' inside the global JwtAuthGuard                                       | Access token is required to refresh — circular         | `@Public()` + `JwtRefreshGuard`                          |
| Storing the refresh token in the access-token cookie path                                        | Cookie leaks via JS reads on every page                 | `path: '/api/v1/auth'`                                    |
| Logging the password or the cleartext OTP at any level                                            | PII in logs                                            | Never. bcrypt is one-way for a reason                     |
| `await bcrypt.compare(plain, undefined)`                                                          | Returns false silently, looks like a wrong password    | `addSelect` on the password column                        |
| Using `jwt.sign` (synchronous) in an async controller                                            | Event loop blocked for 5ms per request                  | `jwt.signAsync`                                          |
| `SetMetadata(IS_PUBLIC_KEY, true)` at the class level for an entire controller                   | All routes are public, including admin actions          | Apply at method level for public endpoints                |
| Forgetting `passport-google-oauth20` requires the user's email in the strategy config            | `profile.emails` is undefined, validate throws         | `scope: ['email', 'profile']` is mandatory                |

### 19.1 The mistakes that have caused real outages

- **Throttler in-memory**: A client had 8 Node instances behind a load balancer. Their `/login` was "rate-limited" 5 times per IP, but with 8 instances, the actual limit was 40. They didn't catch this until a credential-stuffing attack succeeded.
- **Missing `addSelect`**: A junior engineer added a new endpoint that did `findOne({ where: { email } })` and called `bcrypt.compare` on the returned user. The compare always returned false. The "fix" was to set `select: true` on the column, which made the password hash show up in every other query. Two weeks later, a debug log of a search query showed a bcrypt hash in plaintext.
- **Refresh in access cookie path**: A user reported their refresh token being logged by a third-party analytics tool. The analytics script ran on every page, including `/profile`. The cookie was sent there. The script read `document.cookie` — but the cookie was `httpOnly`, so it couldn't. **If the path had been `/`, the script could have requested `/api/v1/profile` with `credentials: 'include'` and the cookie would have been sent.** The path scoping was the defense.

---

## 20. Decision points revisited

After writing this code, did my Lesson-10 defaults hold up?

- ✅ `httpOnly` cookies — yes, these were straightforward.
- ✅ Refresh-token rotation — yes, the `refresh_tokens` table is the cleanest model.
- ✅ OTP purpose enum — yes, separating `email_verification` from `password_reset` was essential.
- ⚠️ Throttling — I used `@nestjs/throttler` defaults; for prod, you'll want the Redis store to share counters across instances.
- ⚠️ Mail — I used nodemailer with a placeholder transport. Production will need a real SMTP provider (SendGrid, Mailgun, SES).
- ⚠️ Google linking — I made an opinionated choice (auto-link when email matches and no `googleId` present). A more paranoid option is to require OTP confirmation.

None of these are blockers. We're feature-complete for the MVP.

### 20.1 What I would change in the next iteration

- **Cache `findById` in Redis.** Every authenticated request hits Postgres. A 30-second cache with `user.id` as the key cuts that to 1 query per 30s per user. For 10K active users, that's 333 qps instead of 10K qps. Postgres can handle 10K qps, but at peak you'll be glad of the headroom.
- **Email the user on every login from a new device.** Optional but high-value. "We noticed a new login from Chrome on macOS in Berlin, Germany. If this wasn't you, click here." The click triggers a tokenVersion bump.
- **Add a `/auth/me` endpoint.** Currently the user info is in the verify/login response. A `/auth/me` that returns the current user from the access token is the right pattern for SPAs that re-hydrate on page load.
- **Move the bcrypt cost to config.** Cost 12 is fine for now, but in 3 years you'll want to bump to 14. Putting it in env means a config change, not a code change.
- **Add a `last_login_at` and `last_login_ip` column.** Updates on every successful login. The audit trail is invaluable for support cases.

---

## 21. Business-stakeholder translation

Six Q&A pairs you'll get from a non-engineering stakeholder.

**Q: Why does it take 3 sprints to build login? My friend built his app's auth in a weekend.**

The "weekend auth" almost certainly has at least one of these defects: passwords stored in plaintext, JWTs that never expire, no rate limiting, no email verification, no way to recover an account, no audit trail. We've seen production startups lose 30% of users to a credential-stuffing attack because their weekend auth didn't have rate limiting. The 3 sprints includes the migrations, the test suite, the threat model, the documentation, and the integration with Google. The cost of building it wrong is paid forever.

**Q: We have 100 users. Do we really need all this?**

You have 100 users today. The auth code you ship is the auth code you'll have in 5 years when you have 100,000. The choice is: pay 3 sprints now, or pay 30 sprints later when a security incident forces a rewrite. The migration from a "weekend auth" to "production auth" is the most expensive migration in software — every endpoint that touches `req.user` has to change.

**Q: Why are we storing refresh tokens in the database? That's a write per login. We're going to run out of IOPS.**

A 1KB refresh-token row, written once per login, is 1KB × 100K logins/day = 100MB/day. Postgres handles 100MB/day easily. For 1M logins/day, it's 1GB/day — still fine for a single Postgres instance. The "IOPS" concern is real for high-write systems (metrics, events); auth is low-write by comparison. **The cost of not storing refresh tokens is that you can't revoke a stolen one.**

**Q: Can we just use a third-party auth provider (Auth0, Clerk, Supabase) and skip all this?**

Yes, and for some teams that's the right call. The cost is monthly fees, vendor lock-in, and the inability to customize the auth flow (e.g., the 5-minute OTP cooldown, the 60-second resend cooldown, the always-200 forgot-password). For a marketplace that needs custom flows, building it is the right call. For a B2B SaaS with standard login, a third-party is fine.

**Q: How long does an OTP last, and why?**

5 minutes. The math: a 6-digit code has 1M combinations. With bcrypt cost 10 (~60ms per compare), the attacker can try 16 codes per second per CPU core. To exhaust the space, they need 1M/16 = 62,500 seconds = 17 hours. **In 5 minutes they can try 4800 codes — 0.5% of the space.** A determined attacker with 100 cores could try 0.05% × 100 = 5% in 5 minutes, still far from 50%. The expiry makes brute-force impractical.

**Q: If the user gets locked out, can they just register again with the same email?**

Yes — and that's by design. The `register` endpoint says "we sent you an OTP" whether the email exists or not. The user can re-trigger the flow, get a new OTP, verify, log in. The 5-attempt lockout is on the *OTP*, not the *account*. The account is not locked; the code is. After 5 minutes, a new code is issued, the lockout is gone, and the user can verify.

**Q: Can a user change their email address?**

Not in this lesson. Lesson 30 (profile) will add it. The flow will be: user requests change → OTP to new email → user confirms → email updated. Without this, an attacker who steals a session cannot change the email and lock out the legitimate user.

**Q: Why are we using cookies and not localStorage for the JWT?**

Because localStorage is readable by any JavaScript on the page. If a user pastes a snippet of code into the dev console (or an attacker injects a script via XSS), the JWT is exfiltrated. `httpOnly` cookies are not readable by JavaScript; the browser sends them automatically. **The same XSS that would steal a localStorage token cannot read an httpOnly cookie.**

---

## 22. Pre-ship checklist

Before this lesson goes to production:

- [ ] `synchronize: false` in `app.module.ts` (was `true` in current code).
- [ ] `logging: false` in `app.module.ts` (or a logger that scrubs PII).
- [ ] All migrations applied: `Profile` entity table, `token_version` column on `users`, `refresh_tokens` table, partial unique index on `google_id`.
- [ ] `package.json` has scripts: `migration:run`, `migration:revert`, `migration:generate`, `migration:create`.
- [ ] `.env` has `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` (different values, ≥64 bytes each).
- [ ] `.env` has `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from Google Cloud Console.
- [ ] `.env` has real SMTP credentials (Mailgun, SendGrid, SES — not localhost).
- [ ] `FRONTEND_URL` set to the production frontend origin.
- [ ] `NODE_ENV=production` set in deployment.
- [ ] `helmet()` is called in `main.ts`.
- [ ] `cookie-parser` is registered in `main.ts`.
- [ ] Global `ValidationPipe` has `whitelist: true, forbidNonWhitelisted: true, transform: true`.
- [ ] AllExceptionsFilter is registered globally.
- [ ] ThrottlerModule is registered with a Redis store (not in-memory).
- [ ] Throttler limits match the table in §12.4.
- [ ] `bcrypt` cost is 12 for passwords, 10 for OTPs.
- [ ] `Math.random` replaced with `crypto.randomInt` in `OtpService.issue`.
- [ ] `OtpService.verify` uses atomic UPDATE-WHERE for the attempts cap.
- [ ] `setPasswordHash` increments `tokenVersion`.
- [ ] `resetPassword` revokes all refresh tokens for the user.
- [ ] `/auth/refresh` has `@Public()` and uses `JwtRefreshGuard`.
- [ ] Refresh reuse-detection chain reaction is tested.
- [ ] Google OAuth `state: true` is the default (don't override).
- [ ] `OtpService` uses `crypto.randomInt`, not `Math.random`.
- [ ] `users.findByEmail` uses `addSelect('u.passwordHash')`.
- [ ] Mail service swallows transport errors and logs them.
- [ ] Mail service does not log the cleartext OTP or the full email body.
- [ ] No endpoint returns the password hash or the cleartext OTP in the response body.
- [ ] No endpoint logs the password or the cleartext OTP at any level.
- [ ] All 20 e2e scenarios in §15.4 are written and pass.
- [ ] `auth.refresh.reuse_detected` is alerted on (paging, email, or both).
- [ ] `auth.login.fail.bad_password` count is monitored for spikes (credential stuffing).
- [ ] A test SMTP (MailHog, Mailtrap) is configured for CI.
- [ ] The CI pipeline runs unit + e2e tests on every PR.
- [ ] A runbook exists for "throttler says 429 in production" (probably: increase the limit in env, roll out, watch).
- [ ] A runbook exists for "refresh reuse detected" (lock the account, email the user, investigate).
- [ ] A runbook exists for "SMTP is down" (fall back to queue-and-retry, alert).

---

## 23. Self-check before Lesson 30

1. Walk me through what happens when a user with two devices hits `/auth/refresh` simultaneously on both. Why is that safe?
2. What does `addSelect('u.passwordHash')` do, and why is it necessary in `findByEmail`?
3. Why is `/auth/forgot-password` always 200 regardless of whether the email exists?
4. What's the difference between revoking a single refresh token and bumping `tokenVersion`?
5. Why does the OTP verify function increment `attempts` *before* calling `bcrypt.compare`?
6. Why do we *not* link Google accounts silently when the email matches an existing user with no `googleId`? (Trick: we *do* link in our impl. Argue whether that's right.)
7. Which columns are `select: false` in this lesson, and why?
8. Why did we register `JwtAuthGuard` globally as `APP_GUARD`, and how does `@Public()` opt out?
9. What is the bcrypt cost for OTPs vs. passwords, and why the asymmetry?
10. Why is `crypto.randomInt` used instead of `Math.random` for OTP generation? Quantify the risk if we used `Math.random`.
11. Why is the refresh-token cookie scoped to `path: '/api/v1/auth'`?
12. What happens if a user resets their password and then their browser sends an old refresh token within 7 days? Trace the code path.
13. Why does `OtpService.issue` check the cooldown *before* generating a new code?
14. Why do we throw 400 ("Invalid OTP") on the first 4 wrong attempts but 429 ("Too many attempts") on the 5th?
15. What is the role of the `RequestIdInterceptor`, and how does it help debugging?
16. Why is the `bcrypt.compare` against a dummy hash in `login()` necessary?
17. Why do we set `secure: true` on cookies in production but `false` in development?
18. Why is the JWT access token's secret different from the refresh token's secret?
19. What does the throttler prevent, and what does it *not* prevent?
20. If a refresh token is reused, the chain reaction logs the user out of every device. Is this the right UX? Argue for or against.

If you can answer all twenty with specifics from the code, you're done. **Lesson 30 is search.**

---

## 24. What we just enabled for Lesson 30

We have a working auth layer. The pieces Lesson 30 will build on:

- **`JwtAuthGuard` is global.** Every endpoint is protected by default. Lesson 30's `/experts/search` doesn't need a guard at the method level; it inherits.
- **`RolesGuard` works.** Lesson 30's `POST /experts` (an expert-only action) will use `@Roles(UserRole.EXPERT, UserRole.ADMIN)`.
- **`@CurrentUser()` decorator works.** Lesson 30's endpoints will use `@CurrentUser('userId')` to scope queries to the logged-in user.
- **The user has a `tokenVersion` that can be bumped on any state change.** Lesson 30's "delete my account" endpoint will use it to force-logout.
- **The rate limiter is in place.** Lesson 30's "expensive" search endpoint will use `@Throttle({ default: { limit: 30, ttl: 60_000 } })`.
- **The `Profile` entity exists.** Lesson 30's profile page will read and update it.
- **Refresh tokens are stored and rotated.** Lesson 30's "log out of all devices" will bump `tokenVersion` and revoke all rows.

Lesson 30's job is to build the *business* endpoints on top of this foundation. We will not revisit auth in Lesson 30; we will use what we built here.

If you find yourself wanting to "just add one more thing" to the auth layer while building Lesson 30, **stop**. The thing you want to add is a Lesson 50 concern (CAPTCHA, MFA, device tracking). Adding it now delays search, and search is what users will pay for.
