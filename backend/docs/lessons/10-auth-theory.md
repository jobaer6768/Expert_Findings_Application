# Lesson 10 — Auth Theory: The Threats, The Tokens, The Trade-offs

> **What you'll get:** the vocabulary, the threats, the threat-modeling discipline, the design decisions behind every line of code we'll write in Lesson 20, and — critically — the *production* consequences of each choice. By the end, you should be able to explain *why* the auth flow looks the way it does, predict three problems before they happen, defend the choices to a security auditor, and translate the trade-offs to a non-technical stakeholder.
>
> **This lesson has no code.** That's deliberate. Jumping into code without this lesson is how you build a login page that's correct by accident. Read it twice.
>
> **Prerequisites:** Lessons 02, 03, 04, and 05. The schema decisions in Lesson 05 are the foundation this lesson builds on. `User` has `tokenVersion` and `citext`; `Otp` is `ManyToOne`; `Profile` is the PII boundary.

---

## 1. Goal

After this lesson you can:

1. State the difference between **authentication** (who is this) and **authorization** (what may they do), and know which guard handles which.
2. List the top five threats to your auth flow and the defense for each, with the production cost of getting it wrong.
3. Justify the JWT-in-`httpOnly`-cookie choice over localStorage, sessions, and other variants, and predict the failure mode of each alternative.
4. Explain why we rotate refresh tokens and how reuse-detection works, including the multi-device trade-off.
5. Explain the entire OTP lifecycle: generation, hashing, cooldown, brute-force, expiration, single-use, and the GDPR angle.
6. Sketch the Google OAuth flow as a sequence diagram, including the account-takeover vector and how to defend it.
7. Say "I would put this in env, not in code" without being prompted.
8. Read a threat model and identify the missing controls.
9. Explain the rate-limit math: why 5/15min is right for login, why 3/hour is right for forgot-password.
10. Translate the auth design to a non-technical stakeholder without losing the security substance.

---

## 2. Why this matters — the business cost of getting auth wrong

Authentication is the most-attacked surface in your app. It is also the part of the codebase where being 90% right means 100% compromised. A junior developer who builds a working login page has shipped a vulnerability. A senior developer who builds a working login page has shipped a vulnerability *and* documented how it could happen.

The reason this lesson has no code is that the cost of misunderstanding the theory is invisible until production. You will not see the bug in dev. You will not see it in QA. You will see it when an attacker has already drained a few accounts.

### 2.1 The cost of each auth failure mode

| Failure mode | What happens | Business cost |
|--------------|--------------|---------------|
| **Credential stuffing succeeds** | 10% of your users' passwords match a different site's breach | Account takeovers; customer churn; brand damage; possible class-action |
| **Brute force succeeds** | Attacker finds one weak password | Single account drained; if admin, full system compromise |
| **JWT stolen via XSS** | Attacker has 15 minutes of full account access | PII exfiltration; fraudulent listings; reputation damage |
| **Refresh token replayed** | Attacker has 7 days of access, undetected | Same as above, with longer window; harder to detect |
| **OTP intercepted** | Attacker verifies the victim's email | Account takeover; chain to other services if user reuses passwords |
| **OAuth account takeover** | Victim logs in with Google, gets attacker's profile | Trust destroyed; users stop signing up with Google |
| **Forgot-password enumeration** | Attacker learns which emails are registered | Targeted phishing; credential stuffing with confirmed emails |
| **Session fixation** | Attacker pre-sets a session ID; victim authenticates into it | Account takeover; rare but devastating when it works |
| **CSRF on state-changing endpoints** | Attacker submits a form; victim's cookie authenticates | Unauthorized actions in the victim's name |
| **Refresh-token DB leak** | Attacker has hashes of all refresh tokens | Reuse-detection kicks in; users re-authenticate; incident response |

**The compounding cost:** One auth bug rarely stays one bug. A credential-stuffing success leads to a data-exfiltration attempt, which leads to a GDPR review, which leads to a security audit, which leads to a re-architecture. The total cost of a single weak password policy is often 10x the original bug.

**The compounding benefit:** A well-designed auth flow doesn't just prevent attacks; it makes the rest of the system easier to build. With `tokenVersion` for global logout, "log out all devices" is one UPDATE. Without it, you iterate every refresh token. With `select: false` on `passwordHash`, you never have to remember to strip it. Without it, every endpoint is a potential leak. The auth foundation is leveraged.

### 2.2 The current state of your codebase — what's already there

Looking at your `app.module.ts` and `package.json`:

- **`bcrypt` is not installed.** You can't hash passwords or OTPs. Lesson 20 needs this; install in Lesson 05 §5.1.
- **No `@nestjs/throttler` in dependencies.** You have no rate limiting. Every auth endpoint is brute-forceable.
- **No `@nestjs/jwt` in dependencies.** You can't sign or verify JWTs.
- **No `@nestjs/passport` in dependencies.** The Google OAuth strategy needs this.
- **No `helmet`, no `cookie-parser`.** The cookie + helmet + CORS setup from Lesson 50 isn't there yet.
- **No `pino` or structured logger.** Logs are `console.log` or absent.
- **No DTOs, no `class-validator` validation pipe.** Inputs are unvalidated.

These are the gaps. Lesson 20 fills them; this lesson explains the theory so you know why each piece is needed.

---

## 3. Concepts

### 3.1 Authentication vs. authorization

These two words are not synonyms. Conflating them is a senior-engineer interview red flag.

- **Authentication ("AuthN"):** *Who is this person?* Login. Register. Verify email. Reset password.
- **Authorization ("AuthZ"):** *What may they do?* "Is this user an admin?" "Can this client see this draft expert profile?"

In NestJS we express these as two separate concerns:

| Concern            | Mechanism                             | Example                                |
|--------------------|---------------------------------------|----------------------------------------|
| Authentication     | `JwtAuthGuard` (or `LocalAuthGuard`)  | Validates a JWT and sets `req.user`    |
| Authorization      | `RolesGuard` + `@Roles(UserRole.EXPERT)` | Checks `req.user.role === 'expert'` |

A common bug: putting role checks in the JWT strategy ("only admins can have a token"). That conflates AuthN with AuthZ. Fix it by making every authenticated request carry only the user's identity in the JWT, and checking roles per-endpoint via a guard.

**The clean separation rule:** The JWT contains *identity* (`sub`, `role`, `tv`). It does not contain *permission* (which endpoints this token can call). The `RolesGuard` reads `req.user.role` and decides. This means changing a user's role doesn't require re-issuing tokens; the next request reads the new role from the DB.

**The caching trap:** Some teams put roles in the JWT and never check the DB. The token is valid for 7 days; the user was demoted from admin to client on day 2; they still have admin access until day 7. The fix: either (a) check the role on every request (DB lookup, but you have the user row anyway for `tokenVersion`), or (b) use short access tokens (15 min) so the window is bounded. We do both.

### 3.2 The five threats

Every auth flow has these threats. Memorize them; defend them in order.

#### Threat 1: Credential stuffing

**The attack:** an attacker has 10M email-password pairs from a different site's breach. They automate your login endpoint and try them all.

**The defenses:**

- **Rate-limit by IP and by email.** A real user types 1 password per 5 seconds; an attacker fires 1000/second. The difference is obvious in traffic patterns. The "per IP + per email" pair is critical: a single-IP rate limit doesn't stop a botnet; a per-email limit doesn't stop an attacker rotating emails. Both are needed.
- **Strong passwords.** NIST 800-63B dropped the old "must contain 3 of 4 character classes" rule; now they want a **minimum length of 8 (we use 10) and a check against known breach lists** like HaveIBeenPwned. We implement this in Lesson 20.
- **MFA / email verification gating.** Even if the password is correct, you can require an OTP step before issuing a session.
- **Constant-time password comparison.** `bcrypt.compare` does this; `===` does not. A timing-attack-aware attacker can leak password length by measuring response times.

**The attack math:** Without rate limiting, an attacker can fire 1000 login attempts per second per IP. With a botnet of 1000 IPs, that's 1M attempts/second. A 10M-password breach is exhausted in 10 seconds. With rate limiting at 5 attempts per 15 minutes per IP+email, the same attacker is capped at 5 attempts per 15 minutes per email. To exhaust 10M passwords against 1M users, the attacker needs 2 million years.

#### Threat 2: Brute force

**The attack:** the attacker knows an email address and tries every password.

**Defense:** the same as credential stuffing, plus:

- **Hashing cost.** `bcrypt` cost 12 means ~250ms per attempt on a 2026 CPU. 1000 attempts = 4 minutes; 1M attempts = 70 hours. The attacker gives up.
- **Account lockout.** After N failed attempts, lock for K minutes. We don't lock by email alone (causes DoS), we lock by IP+email pair.

**The DoS-by-lockout attack:** If lockout is per-email, an attacker can lock any user by sending 5 wrong passwords. The user can't log in until the lockout expires. The user contacts support. The attacker has denied service to one user per 5 attempts. The fix: lockout is per IP+email pair, not per email alone. The attacker can lock their own IP+email combinations but not arbitrary users.

#### Threat 3: Token theft (JWT leakage)

**The attack:** the attacker steals a JWT and replays it.

**Where tokens leak:**

- **localStorage / sessionStorage.** XSS gives the attacker everything.
- **Cookies without `httpOnly`.** JS can read them, so XSS gives the attacker everything.
- **Cookies without `secure`.** Plain HTTP on a coffee-shop Wi-Fi gives them everything.
- **Cookies without `sameSite`.** A CSRF on your bank site submits a form to *your* server with your cookie attached.
- **Server logs.** The access token in a request log line; an attacker with log access (insider, breach) has every active session.
- **Browser extensions.** A malicious extension reads `document.cookie`. `httpOnly` blocks JS but extensions have lower-level access.

**The defenses (combined):**

- **`httpOnly`** — JS cannot read the cookie.
- **`secure`** — only sent over HTTPS.
- **`sameSite=lax`** — sent on top-level navigation but not on cross-site sub-requests.
- **Short access-token lifetime** (15 min) — even if stolen, the window is small.
- **Refresh-token rotation + reuse detection** — see §3.4.
- **Bind tokens to a fingerprint.** Optional. Optional because it's a tradeoff: tighter security vs. a hostile UX when users switch networks.
- **Token storage audit.** Search the codebase for `console.log(req)` or logger calls that include the request. The token should never be in a log line.

**The decision:** Lesson 20 puts the access token in `httpOnly`, `secure`, `sameSite=lax` cookies. We *also* support `Authorization: Bearer` for mobile clients that can't share a cookie store. The `Authorization: Bearer` path is for mobile only; web clients use cookies. The mobile path requires explicit `secure` transport (TLS); the cookie path is `secure` by default in prod.

**The `sameSite=lax` trade-off:** `strict` is more secure (cookies never sent cross-site) but breaks the OAuth callback (Google redirects to your site; the cookie isn't attached on the redirect). `lax` allows the cookie on top-level navigation, which is enough for OAuth. `none` allows everything; only use with `secure`.

#### Threat 4: Replay of OTPs

**The attack:** the attacker intercepts an OTP email (DNS hijack, mail-server breach, shoulder-surfing).

**Defenses:**

- **OTP TTL.** 5 minutes, per your spec.
- **Single-use.** Mark `usedAt` after a successful verification.
- **Hashed at rest.** See §3.5.
- **Max attempts.** Lock after 5 wrong tries.
- **Don't send the OTP over the same channel as the auth.** Email is fine for this MVP; SMS is famously vulnerable to SIM swap. SMS-based OTP is out of scope for you.
- **Audit trail.** Every OTP request and verify is logged with the IP, user agent, and timestamp. A pattern of "request from IP A, verify from IP B" is a hijack signal.

**The `Math.random()` trap:** If you generate OTPs with `Math.random()`, the codes are predictable. An attacker who knows the algorithm can guess the next code. Use `crypto.randomInt(0, 1_000_000)`. The `crypto` module is cryptographically secure; `Math.random()` is not.

**The `padStart(6, '0')` rule:** A code from `randomInt(0, 1_000_000)` could be 6 digits (e.g. `423789`) or fewer (e.g. `4237`). The user types what they see. If you don't zero-pad, the user types `4237` and you compare against the hash of `004237` — mismatch, verification fails. Pad to 6 digits before sending AND before hashing.

#### Threat 5: OAuth account takeover

**The attack:** the attacker goes through your Google OAuth flow with their Google account, then changes their email in your app to point at the victim's. Now the victim logs in with Google and gets the attacker's profile.

**The defense:** when a Google login lands, if the email already exists with a Google account, **link**, do not create. If the email exists with a password account but no Google link, **link** only after the user proves they own the original (re-verify by sending an OTP to the existing email). Never trust an OAuth provider's email as the primary identifier without checking.

Lesson 20 implements this carefully.

**The linking-strategy decision:**

- **Strict linking:** require the user to log in with their password *first*, then click "Link Google" in their settings. (Lesson 20 implements this for simplicity.)
- **Verified linking:** when an OAuth login lands on an existing email, send a one-time OTP to that email and require the user to enter it before linking. (More secure, more friction.)
- **Auto-linking:** trust the OAuth provider's email; if it matches, merge. (Convenient; account-takeover vector.)

For your MVP: strict linking via Settings endpoint, **not** automatic linking on first Google login. This is a deliberate product choice; explain it in your README.

**The `isEmailVerified` rule:** Google has already verified the email. So when a Google login creates a new user, `isEmailVerified = true` from the start. The user doesn't need to verify-by-OTP. This is the whole point of "Sign in with Google" — you trust the provider's verification.

### 3.3 JWT vs. server sessions vs. encrypted tokens

Three ways to carry "I am authenticated".

| Approach               | State lives in       | Revoke by                          | Pros                                                | Cons                                                              |
|------------------------|----------------------|------------------------------------|-----------------------------------------------------|-------------------------------------------------------------------|
| Server session (cookie = session ID) | DB / Redis          | Delete the session row             | Easy to revoke; small cookie                        | DB lookup per request; scaling requires sticky sessions or shared store |
| JWT (signed)           | Client cookie        | Wait for expiry, or check `tokenVersion` | Stateless; scales without a shared store           | Can't revoke instantly; leaked token works until expiry            |
| JWT (encrypted, JWE)   | Client cookie        | Same as above                      | Payload not readable by client                      | Rarely needed; adds complexity                                     |
| **JWT + refresh-token rotation** | DB (refresh only) | Mark refresh revoked, bump `tokenVersion` | Stateless access; revocable refresh                 | More moving parts; reuse-detection needed                          |

**We use the last one.** The access token is a short-lived JWT in a cookie; the refresh token is a long-lived JWT *also* in a cookie, but its hash is in the DB so we can revoke it.

**The scaling story:** Server sessions require a shared store (Redis) for multi-instance deployments. JWTs don't, because the access token is self-contained. The cost of JWTs is the refresh-token DB lookup. At 1M users with 10% active, that's 100k refresh-token lookups per session-refresh. Redis handles this trivially; Postgres handles it fine if indexed.

**The revocation story:** Sessions are easy to revoke (delete the row). JWTs are hard (stateless). The `tokenVersion` field gives O(1) global revocation; per-token revocation is the refresh-token row. Together, you have the best of both: stateless access, revocable refresh.

### 3.4 Refresh-token rotation and reuse detection

This is the part junior engineers skip. Don't.

**The flow:**

1. User logs in. Server creates:
   - Access token (15 min, signed, contains `sub`, `role`, `tv`).
   - Refresh token (7 days, signed, contains `sub`, `jti`).
   - Refresh-token row: `{ id: <jti>, user_id, hash, expires_at, revoked_at: null, replaced_by: null }`.

2. User comes back 16 minutes later. Access token is expired. Client calls `/auth/refresh` with the refresh token.

3. Server checks:
   - Refresh row exists?
   - `revoked_at` is null?
   - Token's `jti` matches row's id?
   - Hash matches?

4. If yes:
   - **Mark the old refresh row revoked, set `replaced_by = <new jti>`.**
   - Issue a new access token + new refresh token.

5. If no:
   - **Reject.** If the *token* itself is valid but the *row* is already revoked, this is **reuse** — someone stole the refresh token. Revoke every refresh token for that user; require re-login.

**The reuse-detection rule:** *if you ever see a refresh-token hash that was already used, treat the entire token chain as compromised.* This is because either (a) someone stole the token and is using it before the legitimate client, or (b) someone stole it from the legitimate client and is replaying it. Either way, the legit client should re-authenticate.

**Why hash refresh tokens at rest:** If our DB leaks, the attacker gets hashes they can't use (because we revoked them) — not bearer tokens. The hash is `sha256(token + SERVER_PEPPER)`; the attacker can't reverse it without the pepper. They also can't use it because the row is revoked.

**The multi-device trade-off:** "Revoke the entire chain" is heavy-handed. A user with three devices (phone, laptop, tablet) might have three active refresh tokens. If one is stolen, the user is logged out of all three. The alternative is "revoke just the stolen one", but you can't tell which one is stolen. The chain revocation is the conservative choice. If your product is multi-device-heavy, add a "this was me" re-auth flow that doesn't require full re-login.

**The "I just got a new phone" scenario:** The user's old phone has a refresh token. They get a new phone, log in again. The old phone's refresh token is still valid until 7 days. If they don't log out of the old phone, the token is "live" but unused. The chain-revocation doesn't fire (no reuse). The user is fine. The old token expires on its own.

### 3.5 The OTP lifecycle

A complete picture of an OTP's life:

```
Generate          Issue             Verify            Expire / Lock
────────────      ─────────────     ─────────────     ──────────────
6 random digits   Hash (bcrypt 10)  Lookup row        expires_at < now → refuse
                  Save to DB        Hash submitted    attempts >= max → mark used
                  Send email        bcrypt.compare    used_at != null → refuse
                  Set lastSentAt    If match: mark used
                  Return 201        Increment attempts
```

**The generate step:** use `crypto.randomInt(0, 1_000_000)` then `padStart(6, '0')`. Don't use `Math.random()` — it's not cryptographically secure. (Lesson 20 wires this in.)

**The cooldown step:** on resend, check `now - last_sent_at`. If `< 60s`, return 429.

**The verify step:** *before* comparing, increment `attempts`. This prevents a race condition where two parallel requests both see `attempts = 4` and both succeed at `5`. The increment-and-check is one transaction.

**The lockout step:** if `attempts >= maxAttempts`, mark `usedAt` and refuse further attempts for this row. The user has to request a new OTP (which resets the counter via a new row, subject to the cooldown).

**The GDPR angle:** OTPs are PII. They contain the user's intent ("verified email at this time"). The audit trail is needed for security (reuse-detection) but is also personal data. The retention rule: delete OTP rows after 30 days. The audit value drops to zero after that. The `requestIp` field is also PII (it's the user's IP); same retention rule.

**The race condition in detail:** Without the increment-before-compare:

```
T1: Read OTP. attempts = 4.
T2: Read OTP. attempts = 4.
T1: bcrypt.compare(submitted, hash) → match!
T1: UPDATE OTP SET usedAt = now() WHERE id = X.
T2: bcrypt.compare(submitted, hash) → match!
T2: UPDATE OTP SET usedAt = now() WHERE id = X.   ← no-op; already used
```

T1 succeeded; T2 also "succeeded" but the OTP is already used. The user thinks they verified; the system thinks the OTP is consumed. Confusing.

With the increment-before-compare:

```
T1: UPDATE OTP SET attempts = attempts + 1 WHERE id = X AND attempts < max.  ← succeeds
T2: UPDATE OTP SET attempts = attempts + 1 WHERE id = X AND attempts < max.  ← fails (attempts is now 5)
T1: bcrypt.compare(submitted, hash) → match! Mark used.
T2: query returns the OTP; attempts is now 5; refuse.
```

The `WHERE attempts < max` clause in the UPDATE is the race-condition fix. It uses an atomic UPDATE-with-WHERE; Postgres serializes the increments.

### 3.6 Google OAuth, end-to-end

```
   Browser           Our API              Google
     │                  │                    │
     │ GET /auth/google │                    │
     │ ───────────────► │                    │
     │                  │ 302 → accounts.google.com/o/oauth2/...
     │ ◄─────────────── │                    │
     │                                           (user logs in / grants)
     │ ◄─────────── 302 /auth/google/callback?code=xyz
     │ ───────────────► │                    │
     │                  │ POST /token (code → id_token) ──►
     │                  │ ◄──── id_token, access_token ─────
     │                  │ 1. verify id_token signature
     │                  │ 2. extract sub (google_id), email, email_verified
     │                  │ 3. find user by google_id or email
     │                  │    - by google_id: log in
     │                  │    - by email + no google_id: link & log in (mark verified)
     │                  │    - new: create user (role=client, isEmailVerified=true)
     │                  │ 4. issue access + refresh cookies
     │ ◄─────────── 302 /profile  Set-Cookie: access=...
```

The key insight: **`isEmailVerified` is set to `true` automatically** for Google-linked users because Google has already verified the email. This is the whole point of "Sign in with Google".

The key risk: **linking**. If someone has an account with `email = bob@x.com` (password-only) and Google later tells us "someone with email `bob@x.com` is logging in", we should not silently merge those accounts. Two safer strategies:

- **Strict linking:** require the user to log in with their password *first*, then click "Link Google" in their settings. (Lesson 20 implements this for simplicity.)
- **Verified linking:** when an OAuth login lands on an existing email, send a one-time OTP to that email and require the user to enter it before linking. (More secure, more friction.)

For your MVP: strict linking via Settings endpoint, **not** automatic linking on first Google login. This is a deliberate product choice; explain it in your README.

**The `state` parameter:** OAuth has a CSRF vulnerability if the `state` parameter is missing. The flow:

1. Server generates a random `state` value, stores it in the session (or a short-lived cookie).
2. Redirects to Google with `state=...`.
3. Google redirects back with `state=...`.
4. Server checks the returned `state` matches the one it stored.

Without this check, an attacker initiates their own OAuth flow, gets the redirect URL, and tricks the victim into clicking it. The victim's browser authenticates against your server with the attacker's `code`. The attacker now has a session in the victim's browser, but on the attacker's account. The victim is logged in as the attacker.

Lesson 20 implements `state` correctly. The pattern is in the official `passport-google-oauth20` strategy.

**The `id_token` verification:** Don't trust the `id_token` payload without verifying the signature. The signature check requires Google's public keys (fetched from their JWKS endpoint). The `@nestjs/jwt` + `passport-google-oauth20` libraries do this for you. Don't roll your own.

### 3.7 Rate limiting — the forgotten control

You already have it in your spec ("1-minute resend cooldown"). But rate limiting is also for:

- `/auth/login` — 5 attempts per 15 min per IP+email.
- `/auth/register` — 5 attempts per hour per IP (prevents spam signups).
- `/auth/forgot-password` — 3 per hour per email (prevents OTP email flooding).
- `/search/experts` — 60 per minute per IP (cheap DoS protection).
- `/search/suggest` — 120 per minute per IP (typeahead is hot).

Lesson 20 implements these with `@nestjs/throttler`. Lesson 50 makes the store pluggable (Redis in prod).

**The rate-limit math:**

- **Login: 5/15min per IP+email.** A real user types 1 password per 5 seconds; in 15 minutes, that's 180 attempts. 5 is well below that. An attacker at 1000 attempts/second hits the limit in 5 attempts = 5ms. The limit is invisible to real users; devastating to attackers.
- **Register: 5/hour per IP.** Real users register once. Spammers register thousands per hour per IP. 5/hour is invisible to real users; stops most spam.
- **Forgot-password: 3/hour per email.** Real users forget passwords 1-2 times per year. 3/hour is invisible. An attacker trying to flood a victim's email with OTPs hits the limit fast.
- **Search: 60/min per IP.** Real users search 5-10 times per minute. 60 is generous. An attacker scraping your search results hits the limit in 1 second.
- **Suggest (typeahead): 120/min per IP.** Typeahead fires on every keystroke. 120/min = 2/sec. A user typing "cardiology" types 10 characters; 10 requests. 120/min leaves headroom for fast typers.

**The store decision:** In dev, an in-memory store works. In prod, a single-instance in-memory store doesn't work (each instance has its own counter; an attacker hits different instances to multiply the limit). Use Redis. The `@nestjs/throttler` library supports a Redis store via `@nest-lab/throttler-storage-redis`.

### 3.8 Logging and observability

Every auth event should be logged, **but never with the secret**.

| Event                       | Log                                           |
|-----------------------------|-----------------------------------------------|
| Register succeeded          | `{ userId, email_hash, ip }`                  |
| Register failed             | `{ reason: 'duplicate_email', ip }`           |
| Login succeeded             | `{ userId, ip, userAgent }`                   |
| Login failed (wrong pass)   | `{ email_hash, ip, attempt: 3 }`              |
| OTP issued                  | `{ userId, purpose, ip }` — no code           |
| OTP verified                | `{ userId, purpose, attempts: 1 }`            |
| OTP failed                  | `{ userId, purpose, attempts: 4, remaining: 1 }` |
| Refresh succeeded           | `{ userId, jti_old, jti_new }`                |
| Refresh reuse detected      | `{ userId, jti, severity: 'critical' }`       |
| Google login succeeded      | `{ userId, googleId_hash, isNew: true }`      |

`email_hash` = `sha256(email + SERVER_PEPPER)`. This lets you correlate "did this email try to log in?" without putting the email in logs (which may be subject to GDPR right-to-erasure in plaintext logs).

**The `severity: 'critical'` for refresh reuse:** This is a signal that something is very wrong. The log entry should trigger an alert (PagerDuty, OpsGenie) and possibly an email to the user ("we detected suspicious activity on your account"). The user can then re-authenticate and review their active sessions.

**The "no PII in logs" rule:** Logs are subject to GDPR right-to-erasure. If you log `email` in plaintext and the user requests erasure, you have to scrub your logs too. With `email_hash`, the email is already not recoverable. Logs are safe to keep.

**The structured-logging requirement:** Every log line is a JSON object, not a string. `pino` is the standard. `console.log('user logged in')` is not searchable, not filterable, not aggregatable. `pino.info({ userId, event: 'login_succeeded' })` is.

Lesson 50 sets up the pino logger and the request-id interceptor. Lesson 20 just calls the logger with these shapes.

### 3.9 The "defense in depth" checklist

Every auth flow has layers. A single defense is bypassable. Multiple layers raise the cost to the attacker until they give up.

| Layer | Defense | Bypass cost |
|-------|---------|-------------|
| **Network** | TLS, HSTS, rate limiting at the edge | Steal cert, use botnet |
| **Application** | Input validation, rate limiting, bcrypt | Find a bug, brute force |
| **Authentication** | JWT + refresh rotation + reuse detection | Steal cookie, replay |
| **Authorization** | Roles, IDOR checks, resource ownership | Find IDOR, escalate |
| **Data** | `select: false`, DTOs, encryption at rest | DB breach, exfiltration |
| **Audit** | Structured logs, anomaly detection, alerting | Cover tracks (harder) |

A skilled attacker will try each layer. The goal isn't to make any single layer impenetrable; it's to make the *combination* expensive enough that the attacker moves to an easier target.

---

## 4. Decision points (commit or push back)

| Decision                                               | My choice                                                    | The alternative                          | Why I picked this |
|--------------------------------------------------------|--------------------------------------------------------------|------------------------------------------|-------------------|
| Access token storage                                   | `httpOnly` cookie (primary) + `Authorization: Bearer` (fallback) | localStorage (XSS-risky), URL param (logged everywhere) | Cookie blocks XSS; Bearer covers mobile |
| Refresh token storage                                  | `httpOnly` cookie                                            | localStorage (worse; same risks)        | Same as access; refresh is even more sensitive |
| Access token lifetime                                  | 15 min                                                       | 5 min (more refresh traffic), 1 hour (larger hijack window) | Balance UX and risk |
| Refresh token lifetime                                 | 7 days, rotated                                              | 30 days (longer hijack window)            | Industry standard |
| Password hashing                                       | `bcrypt` cost 12                                             | argon2id (better, but extra dep)         | `bcrypt` is well-known, audited, available everywhere |
| OTP hashing                                            | `bcrypt` cost 10                                             | HMAC-SHA256 (faster, less brute-force bounded) | OTP has 6 digits; bcrypt's slow hash is the defense |
| OTP length                                             | 6 digits, zero-padded                                        | 8 digits (more typing, fewer collisions) | Matches your spec; UX tradeoff |
| OTP TTL                                                | 5 minutes                                                    | 10 minutes (worse window, more support tickets) | Matches your spec |
| OTP resend cooldown                                    | 60 seconds                                                   | 30s / 120s                              | Matches your spec |
| OTP max attempts                                       | 5, then row is marked `usedAt` (next resend required)        | 3 / 10 (more paranoid / friendlier)      | 5 is the OWASP recommendation |
| Login rate limit                                       | 5 / 15min / IP+email                                         | 3 / 30min (more paranoid)               | Balances UX and brute-force protection |
| Register rate limit                                    | 5 / hour / IP                                                | 1 / hour / IP (most paranoid)           | Stops spam signups without annoying real users |
| Forgot-password rate limit                             | 3 / hour / email                                             | 1 / hour / email                        | Stops OTP flooding |
| OAuth linking strategy                                 | Strict (link from settings, not on first login)              | Verified (OTP gate on first link)       | Less friction; documented in README |
| Cookie `sameSite`                                      | `lax`                                                        | `strict` (breaks OAuth callback)         | OAuth callback needs `lax` |
| JWT signing                                            | HS256 with 32-byte random secret                             | RS256 with JWKS (heavier; needed for many services) | Single-service; HS256 is simpler |
| Token claims                                           | `{ sub, role, tv, iat, exp }`                                | Custom claims like `email` (only if needed; small token = good) | Keep tokens small; DB has the rest |
| `User.passwordHash` select strategy                    | `select: false` always                                       | Two repo methods (findOne vs findOneWithSecret) | `select: false` is foolproof; explicit is fragile |
| Refresh reuse detection                                | Revoke entire chain                                          | Soft warn + log (insufficient)           | Conservative; the alternative is silent compromise |
| Token fingerprinting                                   | None (rely on cookie attributes)                            | Bind token to IP/UA (hostile UX on network change) | UX > marginal security gain |
| Log level for auth events                              | `info` for normal, `warn` for failures, `error` for critical | `debug` (too quiet) or `info` for everything | Filterable, alertable |
| PII in logs                                            | `email_hash`, never `email`                                  | `email` (subject to GDPR right-to-erasure) | Hash is safe; email in logs is not |
| Cookie path                                            | `/`                                                          | `/api` (only sent on API calls)          | `/` is simpler; the security is in the flags, not the path |
| Cookie domain                                          | unset (host-only)                                            | `.example.com` (sent to all subdomains)  | Host-only is more secure |

These are all defensible. None are sacred. If you have a different opinion, write it down *before* Lesson 20 — we'll build on top of whichever you pick.

---

## 5. The sequence diagrams, end-to-end

### 5.1 Register → verify email → access

```
User           Frontend       /auth/register    /auth/verify-email
 │                 │                │                    │
 │ Submit form     │                │                    │
 │ ───────────────►│ POST /register │                    │
 │                 │ ──────────────►│                    │
 │                 │                │ 1. Validate input  │
 │                 │                │ 2. Check email not used
 │                 │                │ 3. Hash password (bcrypt 12)
 │                 │                │ 4. INSERT user (isEmailVerified=false)
 │                 │                │ 5. Issue OTP, hash, INSERT otp row
 │                 │                │ 6. Send email (async)
 │                 │ 201 { userId } │                    │
 │                 │ ◄──────────────│                    │
 │                 │ (redirect to /verify-email)         │
 │                 │                │                    │
 │ Enters OTP      │                │                    │
 │ ───────────────►│ POST /verify-email { code }         │
 │                 │ ────────────────────────────────────►
 │                 │                │                    │ 1. Lookup latest active OTP
 │                 │                │                    │ 2. Increment attempts (atomic)
 │                 │                │                    │ 3. bcrypt.compare(code, hash)
 │                 │                │                    │ 4. If match: UPDATE user
 │                 │                │                    │    SET isEmailVerified=true
 │                 │                │                    │    UPDATE otp SET usedAt=now()
 │                 │                │                    │ 5. Issue access+refresh, set cookies
 │                 │ 200 { role: 'client' }              │
 │                 │ ◄────────────────────────────────────│
 │ Redirect to /profile       │                    │
```

**The async email send:** Step 6 in `/auth/register` is async. The user gets a 201 response before the email is sent. The email send is queued (BullMQ, Lesson 50) or fire-and-forget. The trade-off: if the email service is down, the user doesn't get a 500; they just don't get the email. They can request a resend after 60 seconds.

**The `isEmailVerified=true` step:** This is the moment the user becomes "real". Until this point, they can log in but can't access most endpoints (the `RoleGuard` requires verified email for expert features). After this, they're a full user.

### 5.2 Login with refresh rotation

```
Client            /auth/login         /auth/refresh
 │                    │                    │
 │ POST { email, pass }                  │
 │ ──────────────────► │                  │
 │                    │ 1. Find user by email
 │                    │ 2. Verify password (bcrypt.compare)
 │                    │ 3. Check isEmailVerified
 │                    │ 4. Generate access+refresh JWTs
 │                    │ 5. INSERT refresh row (hash, expires_at)
 │                    │ 6. Set-Cookie: access=...
 │                    │    Set-Cookie: refresh=...
 │ 200                │                  │
 │ ◄──────────────────│                  │
 │                    │                  │
 │ (16 min later)     │                  │
 │ POST /refresh (cookie: refresh=...)   │
 │ ─────────────────────────────────────►
 │                    │                  │ 1. Verify JWT signature
 │                    │                  │ 2. Lookup refresh row by jti
 │                    │                  │ 3. Compare hash
 │                    │                  │ 4. If revoked → REUSE → revoke all
 │                    │                  │ 5. Else: mark old revoked,
 │                    │                  │    INSERT new row,
 │                    │                  │    issue new access+refresh
 │ 200 (rotated cookies)
 │ ◄────────────────────────────────────│
```

**The "always check isEmailVerified" step:** A user with an unverified email can register and try to log in before verifying. The login should succeed (they have a valid password) but the response is a special "please verify your email" with a `resendOtp` link. The user can use the access token to call `/auth/resend-otp` and `/auth/verify-email` but no other endpoints. This is a UX choice: do you block login until verified, or allow login but block other actions? We allow login but block other actions.

**The `Set-Cookie` flags:** The cookie set has `httpOnly`, `secure` (in prod), `sameSite=lax`, `path=/`, `maxAge=15m` (access) or `7d` (refresh). The `secure` flag means the cookie is only sent over HTTPS; in dev (http://localhost), you'd set `secure: false` to allow testing.

### 5.3 Forgot/reset password

```
User             /auth/forgot-password         /auth/reset-password
 │                    │                              │
 │ POST { email }     │                              │
 │ ──────────────────►│                              │
 │                    │ 1. Lookup user                │
 │                    │ 2. Always 200 (don't leak)    │
 │                    │ 3. If user: issue PASS_RESET OTP
 │                    │ 4. Send email                 │
 │ 200 (always)       │                              │
 │ ◄──────────────────│                              │
 │                    │                              │
 │ Enters OTP+new pass│                              │
 │ ───────────────────┼─────────────────────────────►│
 │                    │                              │ 1. Find active OTP
 │                    │                              │ 2. Verify code
 │                    │                              │ 3. Hash new password
 │                    │                              │ 4. UPDATE user
 │                    │                              │ 5. Mark OTP usedAt
 │                    │                              │ 6. Bump tokenVersion
 │                    │                              │    (invalidates all sessions)
 │ 200                │                              │
 │ ◄──────────────────┼──────────────────────────────│
 │ Re-login required  │                              │
```

**Why always 200 on forgot-password?** If the endpoint returns 200 only for existing emails, an attacker can enumerate which addresses are registered. By returning 200 with the same body regardless of whether the email exists, we close that side-channel. The attacker sees an identical response time and body either way. The attacker who *controls* the email still doesn't get a token.

**The "no email enumeration" pattern in detail:**

- The response body is always `{ ok: true }` (or 200 with no body).
- The response time is the same: if user exists, send email; if not, sleep 100ms then return. Without the sleep, the timing difference reveals the email's existence.
- The 100ms is small enough to not be a DoS vector; large enough to mask the DB lookup.

**The `tokenVersion` bump:** Step 6 in the reset flow is critical. The new password is set, but all existing sessions are still valid (the JWT's `sub` matches, the `tv` still matches the DB). The bump makes every existing JWT invalid. The user has to log in again with the new password. This is the right behavior: if an attacker triggered the reset, they shouldn't inherit the legitimate user's sessions.

---

## 6. The threat model — what could go wrong, and how we defend

A threat model is a structured way to think about attacks. For each asset, list the threats, the defenses, and the residual risk.

### 6.1 Assets

- **User credentials** (email, password hash) — DB breach, brute force
- **Session tokens** (access, refresh) — theft via XSS, CSRF, log leak
- **OTP codes** — interception, replay, brute force
- **User PII** (name, phone, address) — DB breach, IDOR
- **OAuth tokens** (Google id_token) — forgery, replay

### 6.2 Threats and defenses

| Asset | Threat | Defense | Residual risk |
|-------|--------|---------|---------------|
| Credentials | DB breach | `select: false` on hash, bcrypt cost 12, encryption at rest | Attacker has hashes; bcrypt cost makes offline attack slow |
| Credentials | Brute force | Rate limit, account lockout, breach list check | Determined attacker with botnet; mitigated by 5/15min cap |
| Access token | XSS | `httpOnly` cookie | XSS that reads via DOM (e.g. fetch with credentials) |
| Access token | CSRF | `sameSite=lax` | Top-level navigation GET (e.g. `<img src="/api/delete-account?x=y">`) |
| Refresh token | Theft | Hash at rest, rotation, reuse detection | Attacker who beats reuse detection (e.g. timing) |
| OTP | Interception | 5-min TTL, single-use, hashed, attempts cap | Email account breach; user shoulder-surfing |
| PII | IDOR | Resource ownership checks, `select: false`, DTOs | New endpoint forgets the check; tested in CI |
| OAuth | Forgery | Signature verification, `state` parameter | Compromise of Google's signing keys (extremely rare) |
| All | DoS | Rate limiting, CDN, connection pool | Coordinated DDoS at the edge (CDN's job) |

### 6.3 The residual risk acceptance

Every defense has a residual risk. The question is: is the residual risk acceptable for the business?

- **XSS that bypasses `httpOnly`:** Yes, we accept this. The `Content-Security-Policy` header (Lesson 50) mitigates XSS; `httpOnly` is the second layer.
- **CSRF on top-level navigation:** Yes, we accept this for GET endpoints. POST/PUT/DELETE are not top-level navigable. Idempotent actions (like `/auth/logout`) need CSRF tokens; non-idempotent ones are protected by the action itself.
- **Compromise of Google's signing keys:** Yes, we accept this. Google rotates keys; if a key is compromised, Google revokes it within hours. We cache keys for 1 hour; the worst case is 1 hour of forged tokens.
- **Coordinated DDoS:** Yes, we accept this. The CDN handles it; we focus on the application layer.

---

## 7. Things we explicitly are *not* doing in this MVP

- **2FA / TOTP.** Your spec doesn't include it; out of scope for Lessons 10–20. Easy to add later (one column on `User` for the TOTP secret).
- **Email change verification.** Re-verify on email change. *Not* in your spec.
- **Login alerts.** "We noticed a login from a new device." Nice to have; out of scope.
- **Anomaly detection.** Beyond what the throttler does.
- **GDPR data-export endpoint.** Out of scope here; Lesson 50 lists it as a follow-up.
- **Account recovery codes.** Out of scope.
- **WebAuthn / passkeys.** The future; not in MVP.
- **SMS-based OTP.** Email is enough; SMS is a SIM-swap vector.
- **CAPTCHA on register/login.** Add when traffic warrants; out of scope now.
- **Password rotation policies.** NIST 800-63B explicitly recommends *against* forced rotation; we don't do it.

---

## 8. The compliance angle

If your product is in the EU, or serves EU users, GDPR applies. The auth flow has specific GDPR implications.

### 8.1 Right to erasure (Article 17)

A user can request their data be deleted. The auth-relevant data is on `User`, `Profile`, and `Otp` (which contains the `requestIp` — also PII). The flow:

1. User requests erasure.
2. You start a 30-day cooling-off period.
3. After 30 days, you delete `Profile`, anonymize `User` (set email to `deleted-{id}@example.com`, null `passwordHash`, null `googleId`), and delete `Otp` rows older than 30 days.
4. You keep the `User` row with the anonymized email so the user ID can still be referenced (e.g. in `Expert` rows where they were a reviewer). The PII is gone; the audit trail is preserved.

**The auth-active session problem:** What if the user is currently logged in when they request erasure? You have two options:

- **Soft-delete immediately, hard-delete after 30 days.** The user's active session continues; after 30 days, the row is anonymized and the session is invalid.
- **Force logout on erasure request.** The user is logged out; their request is processed; they can re-authenticate to check status.

The first is friendlier; the second is more secure. We do the first.

### 8.2 Right to access (Article 15)

A user can request all data you have on them. The auth-relevant data is `User`, `Profile`, `Otp`, `RefreshToken` (if you store it). The export should include:

- User fields (id, email, role, status, created_at)
- Profile fields (full_name, phone, etc.)
- Active refresh tokens (count, last_used_at — never the hash)
- OTP history (count, last request IP — never the code)
- Login history (last 100 logins: timestamp, IP, user agent)

The user is allowed to know what you have. The export is a JSON file, downloadable, deleted after 7 days.

### 8.3 Data minimization (Article 5)

Collect only what you need. For auth, that's:

- email (required for login)
- password hash (required for password auth)
- googleId (required for Google auth)
- tokenVersion (required for global logout)
- requestIp on OTP (informational, with 30-day retention)

You do NOT need:

- The user's real name (that's `Profile`)
- The user's phone (that's `Profile`)
- The user's address (that's `Profile`)
- Browser fingerprinting (track `User-Agent` only, for fraud detection)
- Device IDs (track session ID via refresh token, that's enough)

The auth flow stays minimal. PII lives in `Profile`.

---

## 9. Self-check (answer in writing)

1. What's the difference between authentication and authorization? Which guard handles each in our setup?
2. List the five threats and one defense for each.
3. Why is `localStorage` a poor choice for JWT storage, even though it's the easiest to implement?
4. What is reuse-detection on a refresh token? Why do we hash refresh tokens at rest?
5. Why does the OTP verify step *increment attempts before* the comparison, not after?
6. Why does `/auth/forgot-password` return 200 even when the email doesn't exist?
7. Why must Google OAuth users have `isEmailVerified = true` automatically, while password-register users do not?
8. What's the difference between "rate limit per IP" and "rate limit per IP+email"? Why is the second better for login?
9. When the refresh token rotation detects reuse, why do we revoke the *whole chain* and not just the offending token?
10. Why is `sameSite=strict` wrong for our OAuth callback?
11. What's the `state` parameter in OAuth, and what happens if you omit it?
12. Why is `Math.random()` wrong for OTP generation? What should you use?
13. What's the `email_hash` pattern in logs, and why does it matter for GDPR?
14. Why do we bump `tokenVersion` on password reset, and what does it accomplish?
15. A user logs in from a coffee shop. The refresh token is stolen via Wi-Fi sniffing. Walk through what happens when the attacker tries to use it.
16. Your product team wants to add "login with Facebook" in addition to Google. What changes to the threat model? What new linking strategy do you need?
17. The CTO asks "why can't we just put the JWT in localStorage?". Write a 2-sentence answer a non-technical executive would understand.
18. A security audit flags "your OTP TTL is 5 minutes; OWASP recommends 2-5 minutes for high-value transactions". Do you change it? Justify.
19. Why is `bcrypt` cost 12 for passwords but cost 10 for OTPs? When would you use a different cost?
20. A user reports they didn't request a password reset but got an email. Walk through the investigation: what logs do you check, what data do you need, what is the user-facing response?

If you can answer all twenty in two sentences each, you are ready for Lesson 20.

---

## 10. Common mistakes I expect you to make

| Mistake                                                                       | What goes wrong                                                | Fix                                                                       |
|-------------------------------------------------------------------------------|----------------------------------------------------------------|---------------------------------------------------------------------------|
| Putting role in the JWT and never re-checking the DB                          | Demoted user still has admin access for the access-token lifetime | Re-check role on every request; or use 5-min access tokens                 |
| Storing JWT in localStorage "because cookies are hard"                        | XSS gives the attacker every active session                     | `httpOnly` cookie, always                                                 |
| Setting `sameSite=strict` on the auth cookie                                  | OAuth callback fails; users can't log in with Google           | `sameSite=lax` (or `none` with `secure` for cross-site)                   |
| Skipping `state` parameter in OAuth                                           | CSRF on the OAuth flow; attacker logs victim into attacker's account | Use `passport-google-oauth20`; it handles `state` correctly                |
| `bcrypt.compare(plain, hash)` then `if (match) allow`                         | Race condition; two parallel requests both pass at attempt 4/5 | `UPDATE WHERE attempts < max`; only the first wins                        |
| Returning 200 for forgot-password only when the email exists                  | Email enumeration; attacker learns which emails are registered | Always 200; same body; same timing                                        |
| Auto-linking OAuth accounts on first login                                    | Account takeover via "log in with Google"                      | Strict linking from settings; or OTP-gated linking                        |
| `console.log('login', user)` with the user object                              | Password hash in logs; PII leak                                | Log `userId`, `email_hash`, never the user object                         |
| `Math.random()` for OTP                                                       | Codes are predictable; offline brute force                     | `crypto.randomInt(0, 1_000_000)`                                          |
| Forgetting `padStart(6, '0')` on the OTP                                      | `4237` vs `004237` mismatch; user types 4 digits, you compare 6 | Pad to 6 digits before sending AND before hashing                          |
| Logging the access token "for debugging"                                      | Token in logs; if logs leak, every active session is compromised | Never log tokens; if you must, log the `jti` only                          |
| Rate-limiting only by IP                                                      | Botnet bypasses the limit                                      | Rate-limit by IP+email for login; by IP for search; by email for forgot   |
| Not rotating the JWT secret on a suspected breach                             | Same secret signs new tokens; attacker has a permanent key    | Rotate with overlap; old tokens are valid until expiry                     |
| `JWT_SECRET=secret` in `.env`                                                 | Token forgery if `.env` leaks                                  | 32+ random bytes; never reused                                            |
| Storing refresh tokens in cleartext in the DB                                 | DB leak = every active session compromised                     | `sha256(token + pepper)`                                                  |
| Bypassing `select: false` with `passwordHash: true` in a query                | Password hash in the response                                 | Never use `select: true` on `passwordHash`; trust the default             |
| In-memory rate-limit store in production                                      | Multi-instance deployments each have their own counter; attacker rotates instances | Redis-backed store                                                          |
| Skipping the `tokenVersion` check on protected endpoints                      | Revoked token still works until expiry                          | Always `if (user.tokenVersion !== jwt.tv) throw Unauthorized`              |
| Trusting the JWT signature without checking `exp`                             | Expired token works                                            | `jwt.verify` checks `exp` by default; never disable it                    |

---

## 11. The business-stakeholder translation

When a non-technical stakeholder asks "why does this take so long?" or "why is auth so complicated?", you need a translation.

**Q: "Why can't users just stay logged in forever?"**
A: A token that never expires is a token that, once stolen, works forever. A stolen token is a 7-day window; an unexpiring token is permanent. We rotate every 15 minutes; the user re-authenticates silently. Same UX, much safer.

**Q: "Why do we hash the OTP?"**
A: Without hashing, a database breach hands out active codes. With hashing, the same breach gives the attacker hashes they can't reverse (bcrypt is slow to attack). It's defense in depth.

**Q: "Why rate-limit login?"**
A: Without rate limiting, an attacker can try thousands of passwords per second. With rate limiting (5 attempts per 15 minutes), the same attacker is capped at 5 per 15 minutes. The cost to attack goes from "minutes" to "years".

**Q: "Why does forgot-password always return 200?"**
A: If we returned 200 only for real emails, an attacker could enumerate which addresses are registered and target them for phishing. By always returning 200, we close that side-channel. The user who actually forgot their password still gets an email; the attacker learns nothing.

**Q: "Why is `sameSite=strict` wrong?"**
A: It blocks our Google OAuth callback (Google redirects to our site; the cookie isn't attached). We'd break "Sign in with Google". `lax` is the right balance: secure for most cases, allows the OAuth flow.

**Q: "Why is the access token only 15 minutes?"**
A: The shorter the window, the less damage a stolen token can do. 15 minutes is short enough that a stolen token is mostly useless, long enough that users don't see constant re-auth prompts. The refresh token (7 days) keeps the user logged in; only the access token is short.

**Q: "Why do we need a `Profile` table for PII?"**
A: Three reasons: (1) security — password hashes never leak in API responses; (2) GDPR — we can delete PII without deleting auth; (3) performance — login queries don't pull PII. The split is leveraged.

**Q: "Why bump `tokenVersion` on password reset?"**
A: The user changed their password; if an attacker had the old session, they should not inherit it. The bump invalidates every existing JWT in one query. The legitimate user re-authenticates with the new password; the attacker's sessions are dead.

**Q: "Why is the rate limit per IP+email for login?"**
A: Per-IP alone: a botnet has many IPs, so the limit is bypassed. Per-email alone: an attacker can lock any user by sending 5 wrong passwords. The pair means the attacker is capped at 5 attempts per 15 minutes per (their IP, the email). Real users don't hit this; attackers can't escalate.

---

## 12. The "before you ship" checklist

For the auth foundation, before you merge the PR (Lesson 20):

- [ ] `bcrypt` installed (`npm install bcrypt`)?
- [ ] `@nestjs/jwt` and `@nestjs/passport` installed?
- [ ] `passport-google-oauth20` installed?
- [ ] `@nestjs/throttler` installed?
- [ ] `helmet`, `cookie-parser` installed?
- [ ] `pino` and `nestjs-pino` installed?
- [ ] `class-validator` and `class-transformer` installed (for DTOs)?
- [ ] `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` are 32+ random bytes in env (not `secret`)?
- [ ] `SERVER_PEPPER` is set (used for `email_hash` in logs)?
- [ ] Access token cookie has `httpOnly`, `secure` (prod), `sameSite=lax`?
- [ ] Refresh token cookie has same flags?
- [ ] `bcrypt` cost is 12 for passwords, 10 for OTPs?
- [ ] OTP generation uses `crypto.randomInt`, not `Math.random`?
- [ ] OTP is zero-padded to 6 digits before sending AND hashing?
- [ ] `tokenVersion` is in the JWT and checked on every protected request?
- [ ] Refresh-token rotation marks old `revoked_at` and creates new row?
- [ ] Refresh-token reuse revokes the entire chain?
- [ ] Rate limits configured: login 5/15min, register 5/hour, forgot 3/hour, search 60/min, suggest 120/min?
- [ ] Rate-limit store is Redis in production (not in-memory)?
- [ ] Forgot-password returns 200 regardless of email existence?
- [ ] OAuth flow includes `state` parameter (handled by `passport-google-oauth20`)?
- [ ] `id_token` signature is verified (handled by `passport-google-oauth20`)?
- [ ] Google-linked users get `isEmailVerified = true` automatically?
- [ ] OAuth linking is strict (from settings), not auto on first login?
- [ ] Logs use `email_hash`, not `email`?
- [ ] Logs are structured (pino), not `console.log`?
- [ ] Refresh tokens are hashed (`sha256(token + pepper)`) at rest, not stored cleartext?
- [ ] DTOs strip `passwordHash` from all responses?
- [ ] Tests assert: rate limit fires, OTP brute force locked, refresh reuse revokes, forgot-password always 200, OAuth state verified, password hash not in response?

If you can't tick all twenty-eight, the auth foundation isn't ready.

---

## 13. What we just enabled for Lesson 20

- The vocabulary to read Lesson 20 without confusion: AuthN vs AuthZ, the five threats, the JWT + refresh rotation story.
- The design decisions locked in: cookie + Bearer, 15min/7day, bcrypt 12/10, OTP 5min/5attempts, strict OAuth linking.
- The threat model: every control has a defense; the residual risk is documented.
- The compliance story: GDPR right-to-erasure is implementable; right-to-access has a clear shape.
- The business translation: you can explain the choices to a stakeholder without losing the security substance.

Lesson 20 implements all of this. Don't move on until you can answer the self-check from memory.
