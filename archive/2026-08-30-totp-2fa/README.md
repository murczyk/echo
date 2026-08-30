# TOTP 2FA for credentials login

Status: **implemented** (password login enroll/verify + admin clear). Manual smoke / PR hygiene may still be open on the branch.

Issue: [#2701](https://github.com/echoua/echo/issues/2701).  
Branch context: `feat/echo-2701-2fa-auth`.

Scope: password login only (`POST /api/user/login` + `POST /api/user/confirm-2fa`).  
Out of scope: Delta login, `/api/user/test-api-login`, user self-reset, backup codes, at-rest encryption of the secret.

Primary code:

- [`wdintel-rs/src/users/totp.rs`](../../wdintel-rs/src/users/totp.rs) — generate enrollment (base32 + QR + manual key), verify
- [`wdintel-rs/src/users/totp_challenge.rs`](../../wdintel-rs/src/users/totp_challenge.rs) — Redis challenge store
- [`wdintel-rs/src/users/mod.rs`](../../wdintel-rs/src/users/mod.rs) — `user_login`, `user_confirm_2fa`, admin clear
- [`wdintel-rs/src/config.rs`](../../wdintel-rs/src/config.rs) — `TOTP_2FA_*` constants
- [`wdintel-web/src/Pages/Login.elm`](../../wdintel-web/src/Pages/Login.elm) — OTP / QR UI
- Admin clear UI: `admin-users-neo` + login DTOs (`totp_enabled`, `clear_totp`)

---

## Outcome

Credentials login no longer starts a session after password alone. After a valid password:

| `login.totp_secret` | Flow | Login response |
| --- | --- | --- |
| `NULL` / empty | Generate pending secret; Redis **Enroll**; QR (otpauth) | `Needs2faSetup { challenge_id, qr_base64, manual_key }` |
| set | Redis **Verify** only (no secret/QR) | `Needs2fa { challenge_id }` |

`POST /api/user/confirm-2fa` with `{ challenge_id, token }` verifies TOTP, persists the secret on enroll, then calls `start_user_session` and deletes the Redis key. Cookie is issued only after confirm.

Delta and `test-api-login` are unchanged (no 2FA).

---

## Schema

**Table:** `login`  
**Column:** `totp_secret TEXT NULL`

- `NULL` = not enrolled → force enroll after password
- non-`NULL` = enrolled → verify after password
- Admin clear sets it back to `NULL`

Migration: `echo-migration/src/m20260827_180023_add_login_totp_secret.rs` (pure SQL, `IF NOT EXISTS`, PeerDB-friendly nullable / no default).  
ClickHouse impact: `deploy/clickhouse/migration-impact.json` → `public.login` replicated snapshot + targeted resnapshot.

Raw `totp_secret` is never returned in list/update login payloads. Admin sees `totp_enabled: bool` only (`secret` present and non-empty).

---

## Challenge store (Redis)

Key: `2fa:challenge:{challenge_id}` (`TOTP_2FA_CHALLENGE_REDIS_PREFIX`).

```text
Enroll { login_id, pending_secret, attempts }
Verify { login_id, attempts }
```

| Rule | Value |
| --- | --- |
| `challenge_id` | UUID v4 |
| TTL | 300s (`TOTP_2FA_CHALLENGE_TTL_SEC`) |
| Lockout | after 5 failed OTP attempts (`TOTP_2FA_MAX_ATTEMPTS`), via atomic Redis `INCR` script |
| Stale enroll | confirm persists secret only if still unset; later enroll challenges are rejected |
| Delete | on successful confirm, lockout, or TTL expiry |
| Multi-instance | Redis only (same service as sessions; stats use another DB) |

---

## Confirm (`POST /api/user/confirm-2fa`)

1. Load Redis challenge; missing/expired/locked → form error, no session
2. Secret:
   - **Enroll** → pending secret from Redis
   - **Verify** → `login.totp_secret` from DB
3. Verify TOTP (6 digits, 30s step, ±1 skew)
4. Success:
   - **Enroll** → persist `totp_secret`
   - both → `start_user_session`, delete Redis key
5. Failure → bump attempts; no cookie

Enrollment is only via login → `Needs2faSetup` → confirm. No public `/setup_2fa`.

---

## Admin clear

`POST /api/login/update` with `clear_totp: true` (`ensure_admin`):

- Sets `totp_secret = NULL`
- Logs the admin action
- Next password login forces enroll again
- FE: “Скинути 2FA” when `totp_enabled`

No user self-reset in v1.

---

## Frontend

**Login**

1. Creds → `LoginRsp` enum
2. `Needs2faSetup` → QR + manual key + OTP
3. `Needs2fa` → OTP only
4. Confirm success → same post-login `Navigation.load` as before (keep OTP panel until redirect; do not clear `pending2fa` first)
5. Errors via existing toast / form handling

**Admin**

- 2FA status + clear action

Types only via `elm.rs` → `just gen-front`.

---

## Config constants

| Constant | Default |
| --- | --- |
| `TOTP_2FA_CHALLENGE_REDIS_PREFIX` | `2fa:challenge:` |
| `TOTP_2FA_CHALLENGE_TTL_SEC` | `300` |
| `TOTP_2FA_MAX_ATTEMPTS` | `5` |
| `TOTP_2FA_ISSUER` | `Echo` |
| `TOTP_2FA_DIGITS` | `6` |
| `TOTP_2FA_SKEW` | `1` |
| `TOTP_2FA_STEP_SEC` | `30` |

---

## Explicit non-goals

| Item | Decision |
| --- | --- |
| `/api/user/test-api-login` | unchanged; no 2FA |
| Delta login | unchanged |
| Logged-in self-setup / disable | not in v1 |
| Encrypt secret at rest | optional later |
| Backup codes | optional later |

Note: `echo-agent` password `/api/user/login` no longer gets a session cookie until it implements confirm-2fa.

---

## Acceptance checks

- Wrong password → no challenge, no session
- First login (null secret) → QR → correct OTP → secret saved + session
- Later login → verify only → OTP → session
- Bad/expired `challenge_id` or bad OTP → no session
- Admin clear → next login is enroll again
- `test-api-login` and Delta unchanged
- Secret never returned after enrollment; not in admin list payloads
