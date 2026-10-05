# Lesson 50 — Production Readiness: The Polish That Makes It Real

> **What you'll get:** the cross-cutting concerns that span every module — logging, request ids, rate-limit storage, security headers, observability, deployment checks, and a concrete pre-launch checklist. After this lesson the project is genuinely deployable.
>
> **This is not theory.** Every recipe here is a real risk in production. Skipping one means a 3 a.m. page or a leaked token.

---

## 1. Goal

After this lesson:

- every request has a `requestId`, logged with method, path, status, duration, userId-if-known,
- logs are structured JSON, with secrets redacted,
- the throttler uses Redis in production (in-memory in dev),
- the API ships with security headers from `helmet`,
- CORS is locked to a single origin in prod,
- there's a `/health` (liveness) and `/ready` (readiness) endpoint,
- a Dockerfile and a `compose.yml` ready for staging,
- CI runs the migrations against an ephemeral Postgres and runs the e2e tests,
- a pre-launch checklist you can sign off.

---

## 2. Why this lesson is separate

Lessons 10–40 built features. Lesson 50 picks up everything that runs *across* features and would have been noise inside each one: where do you put a try/catch that wraps the whole request? Where do you put request-id generation? Where do you put the rate-limit store? The answers all live in *one place per concern*. Lesson 50 is that place.

### 2.1 The business cost of skipping production-readiness

| Smell | What it costs in production |
|---|---|
| No structured logs | A user reports "search is broken". You grep your logs. You find nothing. The ticket ages. The user churns. 2 sprint-days to add structured logging retroactively. |
| No request-id | A user pastes their request URL. You have no way to find their request in your logs. The bug is untraceable. |
| In-memory throttler in prod with 4 instances | The "5 attempts / 15 min" limit is actually 20 attempts. Credential stuffing succeeds. Account takeover. |
| No `/ready` endpoint | K8s sends traffic to a pod that can't reach the DB. Users get 500s for 30s until the next probe. |
| No body-size limit | One attacker uploads 10MB to `/auth/register`. Your pod is OOM-killed. Restart. Repeat. |
| `synchronize: true` in prod | A junior engineer renames `bio` to `biography`. The column is dropped on next deploy. 10k expert bios lost. |
| Logs include the OTP cleartext | The logs are read by a vendor (Datadog). The vendor stores them. A pentester finds the OTPs in the vendor's search. You have to rotate every active OTP. |
| CORS allowlist = `*` | Any site can hit your API. An attacker hosts a page that calls `/auth/login` with credentials from a list. |
| No helmet | `X-Powered-By: Express` is exposed. A scanner finds your stack. A known Express CVE is exploited. |
| No runbook for "users can't log in" | At 3 AM, the on-call engineer has no idea what to check. The outage lasts 4 hours instead of 30 minutes. |

**Each of these is a 1-day fix during development and a 3-day fire during production.** Lesson 50 is the day you pay upfront.

---

## 3. Current state of the codebase (audit before you write code)

This is the most critical audit. Production-readiness is a *posture*, not a feature; without it, none of the previous lessons matter.

| Gap | Where | Risk |
|---|---|---|
| `synchronize: true` is on | `src/app.module.ts:48` | Schema drift. Drop a column → silent data loss. |
| `logging: true` is on | `src/app.module.ts:49` | TypeORM logs every SQL with parameter values. **Email addresses, password hashes (if `select:false` is wrong), all in stdout.** GDPR + auth bypass risk. |
| `helmet` not in `package.json` | `package.json` | No security headers in responses. |
| `nestjs-pino` not in `package.json` | `package.json` | No structured logging. |
| `ioredis` not in `package.json` | `package.json` | No Redis. Throttler in-memory only. |
| `@nestjs/throttler` not in `package.json` | `package.json` | No rate limiting at all. |
| `cookie-parser` not in `package.json` | `package.json` | Refresh token cookie unreadable. |
| `pino-pretty` not in `package.json` | `package.json` | No dev log readability. |
| `migration:revert` script not in `package.json` | `package.json:23` | Can't undo a bad migration. |
| `migration:generate` script not in `package.json` | `package.json` | Migrations have to be hand-written. |
| `migration:create` script not in `package.json` | `package.json` | New migrations need a template. |
| `test:e2e` script uses `jest --config` but no `test/jest-e2e.json` exists | `package.json:20` | e2e tests can't run. |
| `test:cov` runs unit tests only | `package.json:18` | Coverage report doesn't include e2e. |
| No `Dockerfile` | `backend/` | No containerized deploy. |
| No `compose.yml` | `backend/` | No local dev environment that matches prod. |
| No `.dockerignore` | `backend/` | Docker image includes `node_modules` from the host. |
| No `.github/workflows/ci.yml` | `.github/` | No automated tests. PRs break prod. |
| No `HealthController` | `src/` | No `/health` or `/ready` for K8s. |
| No `RequestIdInterceptor` | `src/common/interceptors/` | Logs aren't correlated. |
| No `AllExceptionsFilter` (Lesson 20's filter not yet committed) | `src/common/filters/` | Stack traces leak in 500 responses. |
| No `Profile` entity | `src/` | Migrations from Lessons 05/20/40 reference it; doesn't exist. |
| No `Profile` module | `src/` | Auth/UsersService need it. |
| `UserRole` enum has no `ADMIN` | `user.entity.ts:14` | The `RolesGuard` we wrote in Lesson 20 has no admin role to grant. |
| No `RedisModule` | `src/` | Throttler in-memory is a production risk. |
| No CSP/HSTS configured | `main.ts` | Lesson 50 will set this; currently defaults. |
| No body size limit on `express.json()` | `main.ts` | Default is 100KB, but Lesson 20's main.ts doesn't call `app.use(json(...))` explicitly — uses NestJS defaults. |
| No `.env.example` | `backend/` | New developers don't know what env vars to set. |
| No `migrations/` directory created | `backend/migrations/` | Migrations go in `src/migrations/` per glob; verify. |
| Pino redact list missing `req.body.email` | `lesson code` | Email addresses leak in logs. |

**Lesson 50 is mostly about *installing* and *configuring* things, not writing new logic.** Most of the work is `npm install` and a few `main.ts` lines. The value is in the audit: if any of these gaps aren't closed, the previous lessons are not deployable.

### 3.1 Why the audit is the most important section

The other lessons had audits showing "the code path doesn't exist yet". Lesson 50's audit shows "the deployment is unsafe even if every code path works". This is the *final* defense. A perfectly coded login endpoint with `synchronize: true` will drop its `users` table on the next deploy. A perfectly coded search with no body size limit will OOM under a 10MB attack. **Lesson 50 is the difference between "code that works" and "code that survives prod".**

### 3.2 The "missing in package.json" cascade

The first 10 rows of the audit are dependencies not in `package.json`. Each is a 1-line `npm install` but each blocks a feature:

- No `helmet` → Lesson 20's `app.use(helmet())` fails at boot.
- No `cookie-parser` → Lesson 20's refresh token cookie is `undefined`.
- No `@nestjs/throttler` → Lesson 20's `@Throttle` decorator does nothing.
- No `nestjs-pino` → Lesson 50's `LoggerModule` doesn't import.
- No `ioredis` → Lesson 50's `RedisThrottlerStorage` doesn't import.

**The first 30 minutes of Lesson 50 is `npm install`'ing everything from the audit.** The next 30 minutes is verifying each import resolves. This is unglamorous but critical.

---

## 4. The recipe list

### 4.1 Structured logging — pino

Install:

```bash
npm install nestjs-pino pino-http pino-pretty
```

`backend/src/common/logger/logger.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { ConfigService } from '@nestjs/config';

@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        pinoHttp: {
          level: config.get<string>('nodeEnv') === 'production' ? 'info' : 'debug',
          redact: {
            paths: [
              'req.headers.cookie',
              'req.headers.authorization',
              'req.body.password',
              'req.body.code',
              'req.body.newPassword',
              'req.body.token',
              'req.body.email',
              'req.body.refreshToken',
              'req.body.accessToken',
              // Anything matching /password/i in any body:
              'req.body.oldPassword',
              'req.body.currentPassword',
              'res.body.accessToken',
              'res.body.refreshToken',
            ],
            censor: '[REDACTED]',
          },
          transport:
            config.get<string>('nodeEnv') === 'production'
              ? undefined
              : { target: 'pino-pretty', options: { singleLine: true } },
        },
      }),
    }),
  ],
})
export class AppLoggerModule {}
```

In `main.ts`, replace the default logger:

```ts
const app = await NestFactory.create(AppModule, { bufferLogs: true });
app.useLogger(app.get(Logger));
```

Now every log line is JSON-shaped with `req.id`, `req.method`, `req.url`, `res.statusCode`, `responseTime`. Search your logs by `req.id` and you have a full request trail.

### 4.2 The redact list is the most important security feature of logging

The default Pino redact list (just `req.headers.cookie, req.headers.authorization`) is insufficient. Lesson 50's list also redacts:
- `req.body.password` — the user's password in plaintext. **If a stack trace includes `req.body`, the password is in the log.**
- `req.body.code` — the OTP code. **A 6-digit code is a session takeover.**
- `req.body.newPassword` — the new password on reset.
- `req.body.token` — any token field.
- `req.body.email` — GDPR PII. **Email in logs is the most common GDPR finding.**
- `res.body.accessToken` / `res.body.refreshToken` — the issued tokens. They should never appear in a log line, even in success.

**The cost of forgetting a redact path is a security incident.** A pentester who finds an email or password in logs reports it. The fix is "rotate every secret that ever appeared in a log line". For a 6-digit OTP, that's "force every active OTP to expire immediately".

### 4.3 The `bufferLogs: true` pattern

`NestFactory.create(AppModule, { bufferLogs: true })` tells Nest to buffer all log lines until `app.useLogger(...)` is called. Without `bufferLogs`, the framework's startup logs go to the default console logger (not pino). With it, the startup logs go through pino. **Consistent log format from boot.**

### 4.4 The `pino-pretty` choice

In dev, `pino-pretty` formats log lines as `INFO [AuthService] login.success userId=42 (200, 23ms)`. In prod, JSON: `{"level":"info","time":...,"msg":"login.success","userId":42}`. The dev format is human-readable; the prod format is grep-friendly and structured for log aggregators (Datadog, ELK, CloudWatch).

**Never run `pino-pretty` in production.** It adds 10ms per log line and produces output that log aggregators can't parse. The `transport: undefined` in prod is the rule.

### 4.5 Request-id interceptor

`backend/src/common/interceptors/request-id.interceptor.ts`:

```ts
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { randomUUID } from 'crypto';

const HEADER = 'x-request-id';

@Injectable()
export class RequestIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const http = context.switchToHttp();
    const req = http.getRequest();
    const res = http.getResponse();
    const id = (req.headers[HEADER] as string) ?? randomUUID();
    req.id = id;
    res.setHeader(HEADER, id);
    return next.handle();
  }
}
```

Apply globally in `main.ts`:

```ts
app.useGlobalInterceptors(new RequestIdInterceptor());
```

Now the `x-request-id` is generated (or honored) on every request. Logs include it. Clients can include it for support tickets.

### 4.6 Why we honor inbound `x-request-id`

If the client (or upstream proxy) sends `x-request-id: abc-123`, we use that. Otherwise we generate. **The value of a UUID is correlation across systems**: the load balancer's log has the same ID as our log as the Postgres slow-query log. If the load balancer generates IDs, we don't override them. If we generate, we propagate downstream.

### 4.7 The `res.setHeader` is for client debugging

The response includes `x-request-id: <the id>`. The client (or a support agent reading the user's browser dev tools) sees the ID. They include it in the bug report. You grep your logs for it. **The bidirectional ID is the single most useful debug tool for a backend.**

### 4.8 Rate-limit storage — Redis in prod

`backend/src/throttler-redis.storage.ts`:

```ts
import { ThrottlerStorage } from '@nestjs/throttler';
import Redis from 'ioredis';

export class RedisThrottlerStorage implements ThrottlerStorage {
  private redis: Redis;
  constructor(url: string) {
    this.redis = new Redis(url);
  }
  async increment(key: string, ttlMs: number): Promise<{ totalHits: number; timeToExpire: number }> {
    const r = await this.redis.multi().incr(key).pttl(key).exec();
    const total = (r?.[0]?.[1] as number) ?? 1;
    let ttl = (r?.[1]?.[1] as number) ?? -1;
    if (ttl < 0) {
      await this.redis.pexpire(key, ttlMs);
      ttl = ttlMs;
    }
    return { totalHits: total, timeToExpire: Math.ceil(ttl / 1000) };
  }
}
```

```bash
npm install ioredis
```

In `app.module.ts`:

```ts
ThrottlerModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    ttl: 60_000,
    limit: 60,
    storage: process.env.NODE_ENV === 'production'
      ? new RedisThrottlerStorage(config.get<string>('REDIS_URL') ?? 'redis://localhost:6379')
      : undefined,
  }),
})
```

In production with multiple app instances, the in-memory store gives each instance its own counter — meaning a 5-attempts/15min limit becomes 5×N on N instances. Redis is the only way to share the counter honestly.

### 4.9 The Redis `INCR` + `EXPIRE` pattern

The `multi().incr().pttl().exec()` pattern is the standard "atomic counter with TTL":
- `INCR key` returns the new value. If the key didn't exist, it's 1.
- `PTTL key` returns the remaining TTL in milliseconds. If the key doesn't exist, it's -1.
- If `pttl < 0`, we set the TTL with `PEXPIRE`. This is the "first hit" case.

**Why not `SET key 0 EX 60 NX` followed by `INCR`?** Two round-trips. The `INCR` + check + `EXPIRE` is two operations but one round-trip (`multi().exec()` sends both in one network call). The first hit is the only one that pays the `EXPIRE` cost.

### 4.10 Why Redis and not Memcached

- **Redis has TTL on individual keys**, no need for a separate eviction layer.
- **Redis is in the stack already** (we'll use it for caching in Lesson 50 §4.13). One less service.
- **Redis has atomic `INCR`** — Memcached's `incr` requires the key to exist (initial `add`).
- **Redis persistence is optional** (off by default; Lesson 50's config uses no persistence). If the Redis instance dies, the counters reset. For a 5/15min limit, that's acceptable.

### 4.11 Security headers, CORS, body limits

Already in `main.ts` from Lesson 20:

- `helmet()` — sets `X-Frame-Options`, `Strict-Transport-Security`, `X-Content-Type-Options`, etc.
- `credentials: true` — cookies over CORS.
- `app.use(express.json({ limit: '100kb' }))` — body size limit (Lesson 40 left this out, here's where it goes).

Add body size limits:

```bash
npm install express
npm install -D @types/express
```

```ts
import { json, urlencoded } from 'express';
app.use(json({ limit: '100kb' }));
app.use(urlencoded({ extended: true, limit: '100kb' }));
```

`100kb` is plenty for any DTO you have; larger requests are almost always abusive.

### 4.12 The 100KB body limit, defended

- A `RegisterDto` with email + password is < 200 bytes. 100KB is 500x headroom.
- A search DTO with 20 languages, 20 qualifications, 5 categories, 100-char `q`, is < 1KB.
- A 100KB request is either a bug or an attack. The cost of accepting 100KB is the cost of allocating 100KB per malicious request. **10 attackers × 10KB/req × 100 req/sec = 1GB/sec of memory pressure.**

If you ever need larger payloads (file uploads, etc.), they go through a separate endpoint with multipart parsing and per-route size limits, not the global JSON body parser.

### 4.13 Health and readiness

`backend/src/health/health.controller.ts`:

```ts
import { Controller, Get } from '@nestjs/common';
import { Public } from 'src/auth/decorators/public.decorator';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

@Controller()
export class HealthController {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  @Public()
  @Get('health')   // liveness — is the process alive?
  health() {
    return { ok: true, ts: new Date().toISOString() };
  }

  @Public()
  @Get('ready')    // readiness — can we serve traffic?
  async ready() {
    try {
      await this.ds.query('SELECT 1');
      return { ready: true, db: 'up' };
    } catch (e) {
      return { ready: false, db: 'down' };
    }
  }
}
```

Liveness vs. readiness:

- **Liveness** = "kill me if I'm broken". Kubernetes restarts the pod if this fails.
- **Readiness** = "send me traffic, but maybe not yet". Kubernetes holds traffic until this passes.

Don't conflate them. If your pod is briefly unable to reach the DB, you want it to *fail readiness* (no traffic) but *pass liveness* (don't restart).

### 4.14 Why `SELECT 1` for readiness

A 1-row, 1-column query is the cheapest possible test of "can we talk to Postgres". It verifies:
- Network connectivity to the DB.
- Authentication (we have a valid role).
- The DB is accepting queries (not in recovery mode).

A more thorough check would `SELECT count(*) FROM users LIMIT 1` (verifies a real table is readable), but that's slower. `SELECT 1` is the right level — it catches "DB is down" without false positives on "table is slow".

### 4.15 The `try/catch` in `ready()` is intentional

Readiness returns 200 with `{ready: false, db: 'down'}` if the DB is unreachable. **The endpoint itself stays up.** K8s sees the 200 (the endpoint works) but the body says "not ready". K8s holds traffic.

If we threw, the endpoint would 500. K8s would treat that as "pod is broken" and restart. The DB is down; restarting our pod doesn't fix that. **Failing readiness is the right response; failing liveness is wrong.**

### 4.16 The readiness should also check Redis (if used)

The lesson's `ready()` only checks Postgres. In production with Redis, add a `redis.ping()` check. The pattern:

```ts
async ready() {
  const checks = await Promise.allSettled([
    this.ds.query('SELECT 1'),
    this.redis.ping(),
  ]);
  const dbOk = checks[0].status === 'fulfilled';
  const redisOk = checks[1].status === 'fulfilled';
  return {
    ready: dbOk && redisOk,
    db: dbOk ? 'up' : 'down',
    redis: redisOk ? 'up' : 'down',
  };
}
```

`Promise.allSettled` runs both in parallel; one failing doesn't block the other. The body reports each independently. **K8s readiness can be a single boolean; the body is for human debugging.**

### 4.17 Dockerfile

`backend/Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1.4
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
RUN addgroup -g 1001 nodejs && adduser -S -u 1001 nestjs -G nodejs
USER nestjs
EXPOSE 3000
CMD ["node", "dist/main.js"]
```

`backend/.dockerignore`:

```
node_modules
dist
coverage
.git
.env*
!.env.example
README.md
```

### 4.18 The multi-stage build, explained

**Stage 1 (build):** `node:22-alpine` with all deps. We `npm ci` (deterministic), copy the source, run `npm run build` (TypeScript → JavaScript in `dist/`). The result is a 200MB image with all build tools.

**Stage 2 (runtime):** `node:22-alpine` (clean) with **only production deps**. We `npm ci --omit=dev` (skips devDependencies), copy `dist/` from stage 1, run as non-root user. The result is a 150MB image with only what's needed at runtime.

**The savings: 50MB and a smaller attack surface.** The runtime image doesn't have TypeScript, ESLint, test frameworks, or any dev tool. An attacker who RCEs into the pod has fewer tools available.

### 4.19 Why non-root user

`USER nestjs` in the Dockerfile. By default, Docker runs as root. A process running as root can do anything: install packages, modify system files, escape the container. Running as `nestjs` (UID 1001) limits the blast radius: even if the process is compromised, it can't write to `/etc` or install a backdoor.

**Always run containers as non-root.** This is the first thing a security audit checks.

### 4.20 docker-compose for local + CI

`backend/compose.yml`:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: expert-finder
    ports: ["5432:5432"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      retries: 5

  api:
    build: .
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
    environment:
      NODE_ENV: production
      DB_HOST: postgres
      DB_PORT: 5432
      DB_USER: postgres
      DB_PASS: postgres
      DB_NAME: expert-finder
      JWT_ACCESS_SECRET: ${JWT_ACCESS_SECRET:?must be set}
      JWT_REFRESH_SECRET: ${JWT_REFRESH_SECRET:?must be set}
      REDIS_URL: redis://redis:6379
      FRONTEND_URL: ${FRONTEND_URL}
    ports: ["3000:3000"]
    command: sh -c "node dist/data-source.js && node dist/main.js"
```

(Note: `dist/data-source.js` would have to expose the migration runner; in CI you'd run `npm run migration:run` separately. Adjust to taste.)

### 4.21 The `depends_on: condition: service_healthy` pattern

The API doesn't start until Postgres is ready (`pg_isready` returns 0). Without this, the API starts in parallel, fails its first DB connection, retries, and may not recover. **The healthcheck gate is the difference between "starts in 10 seconds" and "starts in 2 minutes after a long retry loop".**

### 4.22 The `${VAR:?must be set}` pattern

`${JWT_ACCESS_SECRET:?must be set}` in compose.yml: if the env var is unset, Docker Compose refuses to start. The error is loud and immediate. **Compare to the alternative** (the API starts with `undefined` secret, signs JWTs with no signature, accepts any forged token).

This is the same `must()` pattern from Lesson 20's `appConfig`. Repeated in three places (config, env, compose) because the cost of missing a check is high.

### 4.23 CI: GitHub Actions example

`.github/workflows/ci.yml`:

```yaml
name: ci
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: expert_finder_test
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 5s --health-timeout 5s --health-retries 10
      redis:
        image: redis:7-alpine
        ports: ["6379:6379"]
    env:
      DB_HOST: localhost
      DB_PORT: 5432
      DB_USER: postgres
      DB_PASS: postgres
      DB_NAME: expert_finder_test
      JWT_ACCESS_SECRET: test_access_secret_must_be_32_bytes_long_xx
      JWT_REFRESH_SECRET: test_refresh_secret_must_be_32_bytes_long_yy
      REDIS_URL: redis://localhost:6379
      NODE_ENV: test
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22', cache: 'npm' }
      - run: npm ci
      - run: npm run typeorm -- migration:run -d src/data-source.ts
      - run: npm run test:cov
      - run: npm run test:e2e
```

The line `JWT_ACCESS_SECRET=test_access_secret_must_be_32_bytes_long_xx` is 48 chars; it satisfies the 32-byte minimum even though it's deterministic. Test secrets are deterministic on purpose — easier to debug.

### 4.24 Why deterministic test secrets

In dev, you want `JWT_ACCESS_SECRET` to be a 64-byte random string. In CI, the secret only matters within the CI run; deterministic values make logs and stack traces reproducible. **A test that fails because `secrets.randomBytes(64)` produced a different value this run is a flaky test.** Determinism > randomness in CI.

The 32-byte minimum is enforced by `appConfig`'s `must()` function or by `helmet`'s expectations. 48 chars > 32 bytes, satisfying any reasonable check.

### 4.25 Why `--health-cmd` in CI

Same as the compose healthcheck. The CI runner starts Postgres, waits for it to be ready, then runs the tests. Without the healthcheck, the first `npm run migration:run` hits "connection refused" and fails. **The healthcheck turns a flaky CI into a green one.**

### 4.26 The cache: 'npm' on `setup-node`

GitHub Actions caches `node_modules` keyed on the `package-lock.json` hash. The first run installs everything; subsequent runs use the cache. **A 60-second `npm ci` becomes a 5-second cache hit.** This is the single most impactful CI optimization.

### 4.27 Caching the result layer (Lesson 50 stretch)

For high-traffic search, add a Redis cache layer. The key is `sha256(JSON.stringify(sorted(dto)))`; the value is the JSON response; the TTL is 60s.

```ts
@Injectable()
export class SearchService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @Inject(CACHE_MANAGER) private cache: Cache,
  ) {}

  async search(dto: SearchExpertsDto): Promise<SearchResponse> {
    const key = `search:${sha256(JSON.stringify(sortKeys(dto)))}`;
    const hit = await this.cache.get<SearchResponse>(key);
    if (hit) {
      this.logger.log({ event: 'search.cache_hit', key });
      return hit;
    }
    const result = await this.runQuery(dto);
    await this.cache.set(key, result, 60_000);
    return result;
  }
}
```

The cache is opt-in: anonymous searches (no `userId`) are cacheable; authenticated searches (with user-personalized data) are not. The lesson's code makes this distinction at the controller level: only `@Public()` endpoints cache.

### 4.28 The `Cache` interface

`@nestjs/cache-manager` provides a `Cache` service that abstracts over Redis, in-memory, or other stores. We register `RedisCacheModule` (which uses `cache-manager-ioredis` under the hood). The interface is the same: `get`, `set`, `del`. **Lesson 50's choice of `Cache` over raw `ioredis` is for swap-ability: in dev, we can switch to in-memory without changing the service code.**

### 4.29 The cache-key normalization

`sha256(JSON.stringify(sortKeys(dto)))` — `sortKeys` recursively sorts object keys so that `?a=1&b=2` and `?b=2&a=1` produce the same key. Without sorting, the same logical query produces two different cache keys. The hit rate drops by half. **The lesson's lesson: cache-key normalization is non-negotiable.**

### 4.30 Pre-launch checklist

Run this once, by hand, before every production deploy. Tick every box.

#### Security

- [ ] `synchronize: false` in `app.module.ts` for every env except the explicit `development` DB.
- [ ] `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` are 32+ random bytes each. Generate with `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"`.
- [ ] No real Google client secrets in `.env.example`.
- [ ] `helmet()` is installed.
- [ ] CORS allowlist contains *only* the production frontend.
- [ ] Cookie `secure: true` in production.
- [ ] `forbidNonWhitelisted: true` on the global `ValidationPipe`.
- [ ] No endpoint returns `passwordHash`, `codeHash`, or any `select: false` column.
- [ ] Pino redact list includes `req.body.email`, `req.body.password`, `req.body.code`, `req.body.token`, `res.body.accessToken`, `res.body.refreshToken`.
- [ ] Body parser has a 100KB limit.
- [ ] All secrets in env, not in code.
- [ ] `.env` is in `.gitignore`.
- [ ] `.env.example` exists with placeholder values, no real secrets.
- [ ] HTTPS is enforced at the load balancer (cookies' `secure: true` requires it).
- [ ] HSTS header is set (`Strict-Transport-Security: max-age=31536000; includeSubDomains`).

#### Data

- [ ] All migrations ran cleanly (`SELECT * FROM migrations ORDER BY id;`).
- [ ] Every FK has `ON DELETE` set intentionally (Lesson 05's review).
- [ ] `EXPLAIN ANALYZE` on `/search/experts` shows `Index Scan`, not `Seq Scan`.
- [ ] `EXPLAIN ANALYZE` on `/auth/login` shows an `Index Scan` on `lower(email)`.
- [ ] No tables are accidentally unindexed for their hot path.
- [ ] `pg_trgm` extension is enabled.
- [ ] `search_tsv` is backfilled for all existing rows.
- [ ] Triggers on `experts` and `profiles` are present.
- [ ] Cycle-prevention trigger on `categories` is in place.
- [ ] `bayesian_rating` column is populated for all rows.

#### Auth

- [ ] `/auth/forgot-password` is 200-only.
- [ ] Throttler limits: 5/15min login, 5/hr register, 3/hr forgot, 6/min resend-otp, 60/min search.
- [ ] `sudo node test/auth.e2e.ts` exercises reuse-detection.
- [ ] Refresh tokens rotate; chain kill works.
- [ ] Google OAuth callback is over HTTPS in prod (otherwise cookies' `secure` blocks them).
- [ ] `tokenVersion` is bumped on `setPasswordHash`.
- [ ] All refresh tokens for a user are revoked on `resetPassword`.

#### Reliability

- [ ] `/health` and `/ready` respond 200.
- [ ] `/ready` returns 200 with `{ready: false, db: 'down'}` if DB is unreachable.
- [ ] Logs are JSON-shaped; `x-request-id` is logged.
- [ ] Sentry / Datadog / equivalent is wired up (or plan the hook).
- [ ] Migrations are reversible (`migration:revert` actually reverts cleanly).
- [ ] The DB has a backup strategy documented and tested.
- [ ] At least one runbook for: "users can't log in", "search returns empty", "OTP emails not going out".
- [ ] Docker image is built and pushed to a registry.
- [ ] K8s/Docker Compose deployment is documented.
- [ ] The container runs as non-root.
- [ ] The container has a memory limit (e.g., 512MB) and CPU limit (e.g., 1 core).

#### Performance

- [ ] Cold-start p95 < 1s.
- [ ] `/search/experts` p95 < 200ms with 10k seed experts.
- [ ] `/auth/login` p95 < 500ms (bcrypt is the bottleneck).
- [ ] p99 alerts are configured (not just p95).
- [ ] Slow-query log is enabled in Postgres (`log_min_duration_statement = 200ms`).

---

## 5. Decision points

| Decision                                              | Default                            | Push back if                                         |
|-------------------------------------------------------|------------------------------------|------------------------------------------------------|
| Logger                                                | `nestjs-pino` (pino)               | You prefer Winston (slower JSON serialization)      |
| Throttler store                                       | In-memory dev, Redis prod          | Single-process dev / no Redis infra budget           |
| Body limit                                            | 100KB                              | You have legitimate >100KB payloads (rare)           |
| CORS                                                  | Single origin from env             | You host multiple subdomains (allowlist)            |
| Liveness vs. readiness split                          | Yes                                | You're not on K8s (one healthz is enough)            |
| Sessions / cookies                                    | JWT in `httpOnly` cookie           | You need server-side revocation today (sessions)    |
| Node version                                          | 22 LTS                              | Stuck on 20 (then drop `import` Node-only features) |
| DB version                                            | Postgres 16                       | Your platform only has 14/15 (still OK, watch `tsvector` changes) |
| CI service                                            | GitHub Actions                     | You use Jenkins/GitLab; ports the same idea        |
| Cache store                                           | Redis in prod, in-memory in dev    | Single-process prod (no Redis budget)               |
| Cache TTL                                             | 60s for search                     | You have traffic patterns that demand longer         |
| Pino redact list                                      | The lesson's list                  | You have additional sensitive fields                 |
| Body parser                                           | `express.json({ limit: '100kb' })` | You have a file-upload endpoint (use multipart)     |

### 5.1 Why pino over Winston

- **5-10x faster JSON serialization.** At 10K log lines/sec, this matters.
- **Smaller bundle size** (pino is 80KB, Winston is 250KB+).
- **Structured logging is the default** in pino; in Winston, you have to opt in.
- **Better child loggers**: `logger.child({ userId: 42 })` creates a sub-logger with that context. Winston's equivalent is awkward.

The trade-off: pino's API is less ergonomic for ad-hoc debugging. `logger.info({ event: 'login', userId })` is faster but less "console.log"-like. We choose speed.

### 5.2 Why JWT in cookies and not server-side sessions

- **Stateless**: the server doesn't store session state. Adding a new app instance doesn't require session replication.
- **HttpOnly + sameSite=lax**: XSS-resistant, CSRF-protected.
- **Revocation via `tokenVersion`**: a DB read on each request, but bounded (cacheable for 30s).

Server-side sessions are better when you need fine-grained revocation (e.g., "log out from device X but not Y"). We accept the coarser `tokenVersion` bump.

---

## 6. Observability — what to alert on

### 6.1 The alert priority list

In order of "pager at 3 AM":

1. **`/ready` returns 503 for 2 minutes**: K8s is already restarting, but the alert confirms the cluster is unhealthy.
2. **`/auth/login` p95 > 2 seconds**: bcrypt is the bottleneck. Either cost is too high or DB is slow.
3. **`/search/experts` p95 > 500ms**: index issue, plan regression, or capacity problem.
4. **Error rate > 5% over 5 minutes**: something is broken at the application level.
5. **Throttler exception rate > 100/min**: an attack or a UX bug (legitimate users hitting 429).
6. **OTP email send failure rate > 5%**: SMTP is broken or credentials expired.
7. **`auth.refresh.reuse_detected` event count > 0**: somebody is replaying a stolen refresh token. **Page immediately.**
8. **`auth.login.fail.bad_password` count spike > 10x baseline**: credential stuffing. Throttler should catch it, but verify.

### 6.2 The dashboard metrics (for normal hours)

- **p50 / p95 / p99 latency** for `/auth/login`, `/auth/refresh`, `/search/experts`.
- **Requests per second** (RPS), per endpoint.
- **Error rate** (4xx and 5xx) per endpoint.
- **Cache hit rate** for search.
- **Throttler 429 rate** per endpoint.
- **DB connection pool** utilization.
- **Memory and CPU** per pod.

These are the metrics a healthy production system has. The graphs tell you "we're growing" or "we just deployed a regression".

### 6.3 The Sentry/Datadog hook

A 10-line `addHook` in `main.ts`:

```ts
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV,
    release: process.env.GIT_SHA,  // set in CI
    tracesSampleRate: 0.1,  // 10% of requests
  });
}
```

Every 5xx is captured with the request URL, headers, body (post-redaction), stack trace, and the user's `requestId`. The Sentry dashboard groups by stack trace and shows frequency. **This is the difference between "we have a bug" and "I know exactly which line, in which deploy, affects 0.3% of requests".**

---

## 7. Security implications — the final review

A checklist for what an attacker would do with the running system:

| Surface | Attack | Defense | Residual risk |
|---|---|---|---|
| HTTP headers | Missing security headers | `helmet()` | Helmet's defaults don't cover CSP for HTML; we serve JSON only. |
| HTTPS | MITM downgrade | `Strict-Transport-Security` at LB | If the LB is misconfigured, HSTS is bypassed. Verify the LB sets it. |
| Cookies | XSS exfiltrates JWT | `httpOnly` cookies | A malicious script that calls `/api/v1/me` can still exfiltrate the response. CSP blocks inline scripts. |
| Body size | 10MB upload OOMs the pod | 100KB body limit | 100KB × 1000 concurrent requests = 100MB. Still a DoS vector, but bounded. |
| CORS | Cross-origin script uses the user's cookies | `credentials: true` + single-origin allowlist | A misconfigured allowlist is the #1 CORS bug. Verify. |
| Throttler in-memory | 4 instances × 5 attempts = 20 attempts | Redis store in prod | The store must be in Redis, not the in-memory default. Verify `process.env.NODE_ENV === 'production'`. |
| Logs | Email/password in logs | Pino redact list | A new sensitive field added to a DTO is not in the redact list. Add fields to the list as the schema evolves. |
| Errors | Stack trace in 500 response | AllExceptionsFilter | The filter must be registered globally. Verify in `main.ts`. |
| Migrations | Drop a column on next deploy | `synchronize: false` | CI must also have `synchronize: false` in tests. |
| JWT secret | Forged tokens | 32+ byte random secret | A secret in a CI log is leaked. Rotate. |
| Health endpoints | Probe for stack/version | `/health` returns `{ok: true}` only | Don't return DB version, framework version, etc. |
| Docker image | Includes dev tools | Multi-stage build, non-root user | The image is ~150MB, not 1.5GB. Verify. |

### 7.1 The 1-line security audits

For each of these, a single `grep` would catch the issue:

- `grep -r "synchronize: true" src/`
- `grep -r "console.log" src/`
- `grep -r "passwordHash" src/auth/ src/users/`
- `grep -r "select: true" src/user/entities/`
- `grep -r "return.*passwordHash" src/`

Run these as a pre-commit hook. **The lesson's lesson: the security review should be a script, not a meeting.**

---

## 8. Performance — the final check

### 8.1 What "production-ready" actually means for performance

- **Cold start < 1s**: from `docker run` to accepting traffic. Most of this is `node` startup, not our code. With `npm ci` cached in the image, it's typically 200-400ms.
- **p95 < 200ms** for search, login, refresh, register: these are user-facing; slower than this and conversion drops.
- **p99 < 500ms** for the same: 1 in 100 requests is slow; below 500ms is OK.
- **Throughput**: 1K req/sec on a single 1-core pod is achievable for read-mostly workloads. For our search-heavy + auth-heavy MVP, plan for 500 req/sec/pod.

### 8.2 The "first deploy is slow" trap

A common Lesson 50 mistake: deploy to staging, the first request takes 3 seconds (cold DB connection pool, cold Redis connection, cold JIT), declare it "slow in prod", and over-engineer. **The first request is always slow. Measure p95 over 1000 requests, not p1.**

### 8.3 The capacity-planning rule

For a marketplace of 10K experts and 100K daily users:
- Peak RPS (10x average): 100K × 10 / 86400 = 12 RPS. Round to 50 RPS to be safe.
- p95 = 200ms means each pod handles 5 RPS. Need 10 pods.
- DB connection pool: 10 pods × 10 connections = 100 connections. Postgres default max is 100. **Bump Postgres `max_connections` to 200, or use PgBouncer.**

The lesson's defaults (`ThrottlerModule` default 60/min, search limit 60/min) are fine for 100K users.

---

## 9. Debugging recipes for production

### 9.1 "The user reports a 500 error with no context"

1. Ask the user for the `x-request-id` from their browser dev tools.
2. `grep "<id>" /var/log/app/*.log` (or your log aggregator).
3. Find the request line. The body says which service threw. The stack trace says which file and line.
4. **If you can't find the request**, the user has a stale tab. Or the log is rotated. Or the request never reached your pod (load balancer or WAF blocked it).

### 9.2 "Search is slow only at 3 PM"

1. Check the daily traffic graph. Is 3 PM the peak? If yes, the system is at capacity.
2. Check the DB CPU at 3 PM. If it's 80%+, you're CPU-bound. Add replicas or optimize queries.
3. Check the throttler hit rate. If it's high, an attack is in progress; the slowness is intentional (throttling is doing its job).
4. Check the migration log. Was a migration run at 2:55 PM? An index rebuild on a 1M-row table locks the table; the search is slow during the rebuild.

### 9.3 "OTP emails not arriving"

1. Check the mail service logs: `Failed to send OTP email to ...`? If yes, SMTP is broken.
2. Check the SMTP provider's dashboard. Are you rate-limited? Are you out of quota?
3. Check the spam folder. With 6-digit codes in the subject, Gmail sometimes auto-files them.
4. Check the SPF/DKIM records. If the From domain doesn't match the SMTP, recipients reject.

### 9.4 "The 429 rate is 50% on /auth/login"

1. Are users actually being locked out, or is a bot trying?
2. Check the per-IP distribution. If it's one IP, it's a bot. Throttle the IP at the LB.
3. If it's distributed, it's a coordinated attack. Enable CAPTCHA on the login form (Lesson 50 stretch).

### 9.5 "Refresh token reuse detected — what do I do?"

1. The user has a stolen refresh token. The chain reaction is automatic.
2. The user got an email: "Suspicious activity detected." If you have this email, verify it was sent.
3. Check the logs: was the attack from a known IP? Block at the LB.
4. If the user reports it: they've been compromised. Walk them through password reset on every account that shares the email.

### 9.6 "The CI test passes locally but fails in CI"

1. CI doesn't have the same env vars. Verify the CI's `env:` block has all required vars.
2. CI uses a different Postgres version. Verify the `services.postgres.image` matches your local dev.
3. CI's network is slower. Add timeouts. A 30s test that passes locally can fail in CI.
4. The CI runner is shared with other workflows. Use `--runInBand` to serialize tests.

---

## 10. Common mistakes — the final list

| Mistake | Symptom | Fix |
|---|---|---|
| `synchronize: true` in production | Schema drift, silent data loss | Always `synchronize: false` except explicit dev DB |
| Pino redact list missing `req.body.email` | GDPR finding, PII in vendor logs | Add to the list when adding new sensitive fields |
| Body parser default (no limit) | 10MB POST OOMs the pod | `app.use(json({ limit: '100kb' }))` |
| Throttler in-memory in production with N pods | Limit is N×intended | Redis store in prod |
| `/health` includes DB check | DB blip → pod restart → user-visible 5xx | Separate `/ready` (DB check) from `/health` (process check) |
| `helmet()` not called | Missing security headers | Add to `main.ts` |
| CORS allowlist = `*` | Cross-origin attacks | Single-origin from env |
| `JWT_ACCESS_SECRET` < 32 bytes | Brute-forceable | Generate with `crypto.randomBytes(48).toString('base64')` |
| Cookie `secure: false` in production | MITM steals the cookie | `secure: process.env.NODE_ENV === 'production'` |
| Running as root in Docker | Container escape | `USER nestjs` |
| Docker image includes dev deps | Larger attack surface | Multi-stage build, `npm ci --omit=dev` |
| No `.dockerignore` | Image includes `.env` | Add `.dockerignore` |
| Logs in plaintext (not JSON) | Can't grep, can't aggregate | `pino-pretty` in dev, JSON in prod |
| Logs include the JWT or OTP | Session takeover via vendor logs | Redact list |
| `/ready` returns 500 on DB failure | K8s restarts the pod, doesn't help | Return 200 with `{ready: false}` |
| CI doesn't run migrations | "Works locally, broken in CI" | Add `npm run migration:run` step |
| CI doesn't run e2e tests | Unit tests pass, integration broken | `npm run test:e2e` in the workflow |
| CI without `--health-cmd` on services | "Connection refused" on first test | Add healthcheck |
| No runbook for common failures | 4-hour outages | Write the runbook *before* the failure |
| Pino redact list missing `req.body.refreshToken` | The issued refresh token is in logs | Add to the list |
| `app.use(express.json())` without `express` installed | Boot fails | `npm install express` |
| Pino `pino-pretty` in production | 10ms per log line, unparseable | `transport: process.env.NODE_ENV === 'production' ? undefined : ...` |
| `synchronize: true` in e2e tests | Tests pass; prod has the test schema | `synchronize: false` in tests; use migrations |
| `cookie-parser` not installed | Refresh token cookie is `undefined` | `npm install cookie-parser @types/cookie-parser` |
| `bcrypt` not installed | Login throws on every request | `npm install bcrypt @types/bcrypt` |
| The Dockerfile's `CMD` doesn't run migrations | First deploy has no schema | `command: sh -c "node dist/data-source.js && node dist/main.js"` or run migrations as a separate step |
| The CI's `JWT_ACCESS_SECRET` is short | Test JWTs are forgeable | Use a 32+ byte deterministic value |
| `.env` committed to git | Real secrets in git history | `.gitignore` `.env` |
| `.env.example` has real secrets | New developers copy real secrets | Use placeholders, never real values |
| The Pino logger buffer not flushed on shutdown | Last 5 log lines lost on pod kill | `await app.close()` flushes; ensure it's awaited |
| 5xx response includes the stack trace | Pentester fingerprints framework | AllExceptionsFilter sanitizes |
| `/ready` blocks on a slow DB query | K8s holds traffic, then resumes, then holds again | Use a `Promise.race([db.query, timeout(2000)])` |

### 10.1 The mistakes that have caused real outages

- **`synchronize: true` in production**: A team renamed `bio` to `biography` in the entity. On next deploy, TypeORM saw the schema didn't match and dropped the `bio` column. 10k expert bios gone. The lesson's `synchronize: false` is the rule.
- **In-memory throttler in 4-pod prod**: A team had 4 pods behind a load balancer. The `/auth/login` limit was 5/15min *per pod*. An attacker from a single IP got 20 attempts. Credential stuffing succeeded. The lesson's Redis-backed throttler is the fix.
- **Missing `/ready` distinction**: A team had `/health` doing a DB check. A brief DB blip (10s) caused K8s to restart all pods. The new pods hit the same blip. Cascade restart. Lesson: liveness and readiness are different signals.
- **`.env` committed**: A team committed `.env` to git. The Google client secret was in the commit. The repo is public. A pentester used the secret to forge OAuth callbacks. Lesson: `.gitignore` `.env` and rotate any secret that ever appeared in a commit.
- **Pino redact list missing `req.body.email`**: A team added an email-based search. The DTO had `email`. The redact list didn't. The search query logged the email. A GDPR audit found emails in 3 months of logs. Lesson: the redact list is a living document, updated with every new DTO.

---

## 11. Business-stakeholder translation — the final Q&A

**Q: When can we launch?**

When every box in the pre-launch checklist is ticked. Not before. The checklist is the difference between "we shipped" and "we shipped and didn't break prod". **Estimate: 1-2 days of cleanup after Lesson 40 to close every gap.**

**Q: Why is production-readiness a separate lesson?**

Because it's not a feature; it's a posture. The auth code, the search code, the schema — they're all "ready" in isolation. They're "deployable" only when the cross-cutting concerns (logging, health, deployment) are in place. Putting these in the feature lessons would have made those lessons 2x as long and obscured the lesson's point. **Production-readiness is a "this is the last 5% that's 50% of the work" lesson.**

**Q: What's the cost of skipping this lesson?**

For an MVP: you can ship without it. For a marketplace with real users: you'll have a 3 AM page within the first month. The cost of the page (engineer time, customer trust) is more than the cost of Lesson 50 (1-2 days). **For any product where users log in, the calculus is clear.**

**Q: How do I know the deploy was successful?**

A successful deploy has:
- All pods report `/ready: true` within 30 seconds.
- `/health` and `/ready` return 200 from every pod.
- p95 latency for `/search/experts` is < 200ms in the first 5 minutes.
- No new errors in the error rate.
- The first user signup completes end-to-end (register → verify → login → search).

If any of these is false, roll back. The "always be deployable" posture means rolling back is cheap (no in-progress data is lost, schema is unchanged).

**Q: What happens at 100K users? 1M users?**

The lesson's design handles 100K. For 1M:
- Search moves to Elasticsearch (Lesson 50 stretch).
- DB read replicas for `/search/experts`.
- Cache layer for search responses (Lesson 50 §4.27).
- Redis cluster (single instance tops out at ~100K ops/sec).
- Multi-region deploy.

None of this is in Lesson 50. The lesson's lesson: design for 100K, plan for 1M.

**Q: Can we deploy without K8s?**

Yes. Docker Compose, AWS ECS, Render, Railway, Fly.io — all work. The lesson's Docker image is portable. The health endpoints are the contract; any orchestrator that polls them will work.

**Q: How do we handle the first deploy's data?**

The first deploy has no data. The migrations create the schema; the seed data is optional (only for dev). The first real user signup creates the first user. **The lesson's migrations are idempotent (CREATE ... IF NOT EXISTS), so re-running them is safe.**

---

## 12. Self-check — the final boss

You are done with the lesson series when you can answer all of these without re-reading the codebase:

1. **What's the difference between authentication and authorization?**
   *Answer: AuthN = who you are (login/JWT). AuthZ = what you may do (RolesGuard). Both are needed.*

2. **Why is `localStorage` the wrong place for JWTs?**
   *Answer: XSS gives the attacker the tokens; cookies with `httpOnly` don't.*

3. **What is reuse-detection on refresh tokens?**
   *Answer: If a revoked refresh row's hash is presented, every chain for that user is killed; tokenVersion is bumped.*

4. **Why does `/auth/forgot-password` return 200 unconditionally?**
   *Answer: Don't leak which emails are registered.*

5. **What's a `tsvector` and why do we need a trigger to maintain it?**
   *Answer: Tokenized search index. Cannot reference other tables from a generated column; trigger updates it when bio/category/profile changes.*

6. **Why Bayesian rating instead of raw `avg_rating`?**
   *Answer: An expert with 5.0 from 1 review shouldn't outrank 4.7 from 200.*

7. **What's the one failure mode `synchronize: true` will cause you in prod?**
   *Answer: TypeORM silently drops a renamed column and its data on the next deploy.*

8. **Why are OTPs hashed at rest?**
   *Answer: A DB leak shouldn't give attackers live tokens.*

9. **What's the difference between facet computation "naive" and "re-using the WHERE"?**
   *Answer: Naive requires finishing the search to get ids; reused-WHERE runs in parallel and is much cheaper.*

10. **What does the Pino redact list protect?**
    *Answer: It prevents passwords, OTPs, JWTs, and emails from appearing in logs. A DB leak or vendor compromise doesn't expose credentials.*

11. **Why is Redis-backed throttling required in production?**
    *Answer: In-memory throttler is per-pod. With N pods, the limit becomes N×intended. Redis shares the counter across pods.*

12. **What's the difference between liveness and readiness?**
    *Answer: Liveness = "kill me if I'm broken" (process check). Readiness = "send me traffic, but maybe not yet" (DB + Redis check). Conflating them causes restart cascades on DB blips.*

13. **Why is the body size limit 100KB?**
    *Answer: A legitimate DTO is < 1KB. 100KB is 100x headroom; 100MB is a DoS vector.*

14. **Why run the Docker container as non-root?**
    *Answer: A compromised process running as root can install backdoors, modify system files, and attempt container escape. Non-root limits the blast radius.*

15. **Why are test secrets deterministic in CI?**
    *Answer: Random secrets make logs and stack traces non-reproducible. Determinism > randomness in CI.*

16. **What does `synchronize: false` actually do?**
    *Answer: It tells TypeORM not to auto-alter the schema. The schema is owned by migrations, not by the entity metadata.*

17. **What's the most important alert in production?**
    *Answer: `auth.refresh.reuse_detected`. This is a session-takeover signal and warrants immediate page.*

18. **What is the pre-launch checklist's most-overlooked item?**
    *Answer: The Pino redact list. A new sensitive field added to a DTO is not in the list. The list is a living document.*

19. **Why is `synchronize: false` in e2e tests too?**
    *Answer: If e2e tests use `synchronize: true`, the test schema and the prod schema can drift. A migration that works in dev fails in CI. Always migrate, even in tests.*

20. **What is one thing in your codebase right now that would fail a security review?**
    *This one is for you to find. Search for `passwordHash` in your tests; check whether any endpoint returns `select: false` columns; check whether any query string-concatenates user input.*

If you can answer all twenty with specifics from the code, you have internalized the lesson series. **You are production-ready.**

---

## 13. What's *not* in these lessons (intentional)

- **AI search (`/search/ai-assist`).** Not in your MVP scope; `search-api-design.md` §7 sketches the contract.
- **Reviews / Posts / Comments / Channels.** Out of scope. The schema supports them.
- **Multi-region.** Not discussed. Standard pattern: deploy each region behind its own DB with a pgpooler or read-replica; your app already reads from one DataSource.
- **GDPR right-to-erasure endpoint.** Listed as a follow-up. The `delete` query + token bump is straightforward; the real work is auditing what user-derived data lives outside the user row (e.g. reviews).
- **Sentry / Datadog wiring.** Lesson 50 lists it as a checklist item; the actual hook is a 10-line `addHook` in `main.ts` once you have a project key.
- **Webhooks for user lifecycle.** "User deleted", "user verified email" — useful for analytics; out of MVP scope.
- **CI/CD pipeline beyond GitHub Actions.** A real production setup has staging → canary → prod. Lesson 50 shows the test stage; the deploy stages are infrastructure-specific.
- **Disaster recovery.** Backup verification, restore testing, RPO/RTO targets. Each is a 1-day project; none is in the lesson.
- **Load testing.** k6, Locust, Gatling. The lesson's `EXPLAIN ANALYZE` is the static analysis; load testing is the dynamic check. A 1-day project before launch.
- **Security audit (third-party).** A pentest is a paid engagement. The lesson's checklist is the *internal* review; the pentest is the *external* one.
- **Multi-tenancy.** If you ever sell to enterprises, the schema needs `tenant_id` on every table. Not in MVP.
- **i18n / l10n.** The lesson's `tsvector` is `'simple'` (English). For multi-language, use the `'english' | 'spanish'` config per column.
- **MFA / 2FA / WebAuthn.** Lesson 50 lists it in the follow-up roadmap. The hooks are in place (Lesson 20's `OtpService` is reusable); the UI is the work.

---

## 14. The post-launch actions

After deploy:

- Monitor `req.id` in logs to investigate any user reports.
- Watch `/search/experts` p95 — first sign of trouble is p99, not averages.
- Watch the mail queue — bounced OTP emails are a leading indicator of a misconfigured SPF/DKIM.
- Watch the rate-limiter logs for "ThrottlerException" — sustained 429s are a sign of an attack or a UX bug.
- Run `EXPLAIN ANALYZE` weekly on the top 5 queries. Plan regressions are silent.
- Check disk space on the DB. A 1M-row table grows; the WAL grows; the disk fills.
- Verify backups are running. A backup that hasn't been tested is a backup that doesn't exist.
- Review the error budget. If you're burning through it, slow down deploys.

### 14.1 The "first 7 days" rule

The first week after launch is the most dangerous. New traffic patterns, edge cases you didn't anticipate, integrations you didn't test. **Plan for at least one incident in the first 7 days.** Have the runbook ready. Have the on-call rotation set. Have a way to roll back without losing data.

The lesson's design — `synchronize: false`, reversible migrations, versioned deploys, health endpoints — is the *machinery* for safe recovery. Use it.

### 14.2 The "first 30 days" rule

After 30 days, you have data. Use it:
- Which endpoints are slow? (`pg_stat_statements` query.)
- Which endpoints return 0 results? (log analysis.)
- Which endpoints have high error rates? (Sentry dashboard.)
- Which users churn after first login? (cohort analysis.)

This data is the input to Lesson 50's stretch goals: caching the slow endpoints, redesigning the empty-result UX, fixing the high-error endpoints, and improving the first-login experience.

---

## 15. The follow-up roadmap (the things we deliberately didn't do)

In priority order:

| # | Item                                                  | Why                                                      | Effort       |
|---|-------------------------------------------------------|----------------------------------------------------------|--------------|
| 1 | AI search (`/search/ai-assist`)                       | Your MVP travel path                                     | 2 weeks      |
| 2 | Email change verification                            | Account takeover risk                                    | 1 day        |
| 3 | 2FA (TOTP) for high-value roles                      | Real protection                                          | 3 days       |
| 4 | Account deletion / GDPR data-export                  | Legal exposure                                           | 3 days       |
| 5 | Login alerts ("new device")                          | Trust signal                                             | 4 days       |
| 6 | Profile photos on object storage with signed URLs     | Currently we don't store photos                          | 1 week       |
| 7 | Reviews module                                       | Plan from your ER diagram                                | 2 weeks      |
| 8 | Channels + Posts + Comments                           | Plan from your ER diagram                                | 3 weeks      |
| 9 | Recommendations / personalization                     | Once you have enough data                               | 4 weeks      |
| 10| Move to Elasticsearch when `EXPLAIN ANALYZE` shows > 200ms p95 | When scale demands it                          | 2 weeks      |
| 11| CAPTCHA on typeahead and login                       | Bot defense                                              | 1 day        |
| 12| Background jobs (BullMQ) for emails                  | Decouple email send from request path                    | 3 days       |
| 13| Image upload pipeline                                | Profile photos, expert portfolio                         | 1 week       |
| 14| Localization (i18n) for English + Bangla              | Market expansion                                         | 2 weeks      |
| 15| Mobile app (React Native)                             | User acquisition                                         | 4 weeks      |

Each is its own lesson series. None of them are blockers today.

---

## 16. The closing thought — and the closing of the series

Production-readiness isn't a checklist you tick once. It's a posture: every PR asks "does this leak secrets, lose data, or DoS the service?". Every migration has a `down`. Every endpoint has a test. Every query has been `EXPLAIN ANALYZE`'d. Every status code is intentional.

If you've worked through Lessons 02–50, you've internalized all of that for the auth and search domains. Apply the same lens to reviews, channels, posts, comments. The patterns repeat.

### 16.1 What the lesson series has given you

| Lesson | What you got |
|---|---|
| 02 — Cardinalities | The decision matrix for 1:1, 1:N, M:N. The audit found `Otp` as OneToOne (wrong). |
| 03 — Special cases & onDelete | CASCADE vs RESTRICT. The cycle trigger. The composite PK on pivots. |
| 04 — Joins in TypeORM | The two-query pattern. The N+1 trap. Keyset pagination. |
| 05 — Schema foundation | citext, bigserial, partial indexes. Generated columns. The right bcrypt cost. |
| 10 — Auth theory | The threats. The defenses. The math. The decision points. |
| 20 — Auth implementation | 8 endpoints wired up. JWT in cookies. Refresh rotation. Reuse detection. |
| 30 — Search theory | The three-stage pipeline. tsvector + GIN. Bayesian. Facets. |
| 40 — Search implementation | The full-text query. The triggers. The suggest endpoint. The facets. |
| 50 — Production readiness | Logging. Health. Throttling. Deployment. The checklist. |

Each lesson is a 2-3 day project. The series is a 4-6 week roadmap for a single engineer or a 2-3 week pair-program for two.

### 16.2 The pattern that repeats

Notice what we did in every lesson:
1. **Audit** the current state.
2. **Explain** the cost of getting it wrong.
3. **Show** the production-ready design.
4. **Ship** the code.
5. **Verify** with tests, EXPLAIN ANALYZE, and a pre-launch checklist.

This pattern applies to every feature you'll ever build. Reviews? Same pattern. Channels? Same pattern. Posts? Same pattern. **The lesson series is a tutorial in production-readiness, not just a tutorial in auth and search.**

### 16.3 The minimum viable production launch

If you do nothing else from Lesson 50, do these 5 things:

1. **`synchronize: false`** in `app.module.ts`.
2. **`helmet()`** in `main.ts`.
3. **Pino** with the redact list, in `main.ts`.
4. **Redis-backed throttler** in production.
5. **A pre-launch checklist** that you actually walk through.

These 5 changes take 2 days. They prevent 90% of the production incidents I've seen. **The other 10% are caught by the runbooks you'll write based on the lesson's "what to alert on" section.**

### 16.4 The final checklist

- [ ] I've completed Lessons 02, 03, 04, 05, 10, 20, 30, 40, 50.
- [ ] I've answered all 20 self-check questions in §12.
- [ ] I've walked the pre-launch checklist in §4.30.
- [ ] I've written at least one runbook for a known failure mode.
- [ ] I've configured the Pino redact list for *all* sensitive DTO fields.
- [ ] I've tested the deploy: rolled forward, rolled back, rolled forward again.
- [ ] I have a way to monitor `/ready` and `/health` in production.
- [ ] I know what to do if `auth.refresh.reuse_detected` fires.

If you can tick those, **you're production-ready. Ship it.**

Now go ship it.
