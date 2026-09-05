use crate::config::{
    TOTP_2FA_CHALLENGE_REDIS_PREFIX, TOTP_2FA_CHALLENGE_TTL_SEC,
    TOTP_2FA_LOGIN_REDIS_PREFIX, TOTP_2FA_MAX_ATTEMPTS,
    TOTP_2FA_USED_STEP_TTL_SEC,
};
use crate::types::*;
use redis::aio::ConnectionManager;
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TotpChallenge {
    Enroll {
        login_id: Uuid,
        /// StrongBox ciphertext (base64), never plaintext base32.
        pending_secret: String,
        #[serde(default)]
        epoch: i64,
    },
    Verify {
        login_id: Uuid,
        #[serde(default)]
        epoch: i64,
    },
}

impl TotpChallenge {
    pub fn login_id(&self) -> Uuid {
        match self {
            TotpChallenge::Enroll { login_id, .. }
            | TotpChallenge::Verify { login_id, .. } => *login_id,
        }
    }

    pub fn epoch(&self) -> i64 {
        match self {
            TotpChallenge::Enroll { epoch, .. }
            | TotpChallenge::Verify { epoch, .. } => *epoch,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CreateChallengeOutcome {
    Created(Uuid),
    LockedOut,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FailedAttemptResult {
    StillOpen,
    LockedOut,
    Missing,
}

fn challenge_key(challenge_id: Uuid) -> String {
    format!("{TOTP_2FA_CHALLENGE_REDIS_PREFIX}{challenge_id}")
}

fn login_active_key(login_id: Uuid) -> String {
    format!("{TOTP_2FA_LOGIN_REDIS_PREFIX}{login_id}:active")
}

fn login_fails_key(login_id: Uuid) -> String {
    format!("{TOTP_2FA_LOGIN_REDIS_PREFIX}{login_id}:fails")
}

fn login_used_step_key(login_id: Uuid) -> String {
    format!("{TOTP_2FA_LOGIN_REDIS_PREFIX}{login_id}:used_step")
}

pub async fn create_enroll_challenge(
    redis: &mut ConnectionManager,
    login_id: Uuid,
    pending_secret: &str,
    epoch: i64,
) -> anyhow::Result<CreateChallengeOutcome> {
    let challenge = TotpChallenge::Enroll {
        login_id,
        pending_secret: pending_secret.to_string(),
        epoch,
    };
    store_challenge(redis, challenge).await
}

pub async fn create_verify_challenge(
    redis: &mut ConnectionManager,
    login_id: Uuid,
    epoch: i64,
) -> anyhow::Result<CreateChallengeOutcome> {
    let challenge = TotpChallenge::Verify { login_id, epoch };
    store_challenge(redis, challenge).await
}

/// Replaces any prior active challenge for this login. Failure counts are
/// per-login and are intentionally not reset here.
async fn store_challenge(
    redis: &mut ConnectionManager,
    challenge: TotpChallenge,
) -> anyhow::Result<CreateChallengeOutcome> {
    let login_id = challenge.login_id();
    let challenge_id = Uuid::new_v4();
    let payload = serde_json::to_string(&challenge).c(h!())?;
    // 0 = locked out, 1 = created (and prior challenge deleted)
    let result: i64 = redis::Script::new(
        r#"
local active_key = KEYS[1]
local fails_key = KEYS[2]
local challenge_key = KEYS[3]
local challenge_id = ARGV[1]
local payload = ARGV[2]
local ttl = tonumber(ARGV[3])
local max_attempts = tonumber(ARGV[4])
local challenge_prefix = ARGV[5]
local fails = tonumber(redis.call('GET', fails_key) or '0')
if fails >= max_attempts then
  return 0
end
local old = redis.call('GET', active_key)
if old then
  redis.call('DEL', challenge_prefix .. old)
end
redis.call('SET', challenge_key, payload, 'EX', ttl)
redis.call('SET', active_key, challenge_id, 'EX', ttl)
return 1
        "#,
    )
    .key(login_active_key(login_id))
    .key(login_fails_key(login_id))
    .key(challenge_key(challenge_id))
    .arg(challenge_id.to_string())
    .arg(payload)
    .arg(TOTP_2FA_CHALLENGE_TTL_SEC)
    .arg(TOTP_2FA_MAX_ATTEMPTS)
    .arg(TOTP_2FA_CHALLENGE_REDIS_PREFIX)
    .invoke_async(redis)
    .await
    .c(h!())?;

    Ok(match result {
        0 => CreateChallengeOutcome::LockedOut,
        _ => CreateChallengeOutcome::Created(challenge_id),
    })
}

pub async fn get_challenge(
    redis: &mut ConnectionManager,
    challenge_id: Uuid,
) -> anyhow::Result<Option<TotpChallenge>> {
    let key = challenge_key(challenge_id);
    let raw: Option<String> = redis.get(key).await.c(h!())?;
    match raw {
        None => Ok(None),
        Some(raw) => Ok(Some(serde_json::from_str(&raw).c(h!())?)),
    }
}

pub async fn delete_challenge(
    redis: &mut ConnectionManager,
    login_id: Uuid,
    challenge_id: Uuid,
) -> anyhow::Result<()> {
    let _: () = redis::Script::new(
        r#"
local active_key = KEYS[1]
local challenge_key = KEYS[2]
local challenge_id = ARGV[1]
local active = redis.call('GET', active_key)
redis.call('DEL', challenge_key)
if active == challenge_id then
  redis.call('DEL', active_key)
end
return 1
        "#,
    )
    .key(login_active_key(login_id))
    .key(challenge_key(challenge_id))
    .arg(challenge_id.to_string())
    .invoke_async(redis)
    .await
    .c(h!())?;
    Ok(())
}

/// Drop active challenge, failure counter, and used-step marker (admin clear /
/// recovery). Clearing the used step lets a fresh enroll succeed in the same
/// TOTP window after the secret is rotated.
pub async fn invalidate_login_challenges(
    redis: &mut ConnectionManager,
    login_id: Uuid,
) -> anyhow::Result<()> {
    let _: () = redis::Script::new(
        r#"
local active_key = KEYS[1]
local fails_key = KEYS[2]
local used_step_key = KEYS[3]
local challenge_prefix = ARGV[1]
local active = redis.call('GET', active_key)
if active then
  redis.call('DEL', challenge_prefix .. active)
end
redis.call('DEL', active_key, fails_key, used_step_key)
return 1
        "#,
    )
    .key(login_active_key(login_id))
    .key(login_fails_key(login_id))
    .key(login_used_step_key(login_id))
    .arg(TOTP_2FA_CHALLENGE_REDIS_PREFIX)
    .invoke_async(redis)
    .await
    .c(h!())?;
    Ok(())
}

/// Atomically increments the per-login failed-attempt counter.
/// On lockout, deletes the active challenge but keeps the fail counter (TTL)
/// so newly issued challenges stay blocked until the window expires.
pub async fn record_failed_attempt(
    redis: &mut ConnectionManager,
    login_id: Uuid,
    challenge_id: Uuid,
) -> anyhow::Result<FailedAttemptResult> {
    // 0 = missing/stale, 1 = still open, 2 = locked out
    let result: i64 = redis::Script::new(
        r#"
local challenge_key = KEYS[1]
local active_key = KEYS[2]
local fails_key = KEYS[3]
local challenge_id = ARGV[1]
local max_attempts = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local active = redis.call('GET', active_key)
if (not active) or active ~= challenge_id then
  return 0
end
if redis.call('EXISTS', challenge_key) == 0 then
  redis.call('DEL', active_key)
  return 0
end
local fails = redis.call('INCR', fails_key)
redis.call('EXPIRE', fails_key, ttl)
if fails >= max_attempts then
  redis.call('DEL', challenge_key, active_key)
  return 2
end
return 1
        "#,
    )
    .key(challenge_key(challenge_id))
    .key(login_active_key(login_id))
    .key(login_fails_key(login_id))
    .arg(challenge_id.to_string())
    .arg(TOTP_2FA_MAX_ATTEMPTS)
    .arg(TOTP_2FA_CHALLENGE_TTL_SEC)
    .invoke_async(redis)
    .await
    .c(h!())?;

    Ok(match result {
        0 => FailedAttemptResult::Missing,
        2 => FailedAttemptResult::LockedOut,
        _ => FailedAttemptResult::StillOpen,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClaimChallengeOutcome {
    Claimed(TotpChallenge),
    /// Challenge was replaced, expired, or locked out — step was not consumed.
    Missing,
    /// Step was already accepted; challenge is left intact for the next code.
    StepReplayed,
}

const CLAIM_STEP_REPLAY_MARKER: &str = "__totp_step_replay__";

/// Atomically claim the active challenge and record the accepted TOTP step.
/// Failed claims do not burn the step; step replays do not delete the challenge.
pub async fn claim_challenge_with_step(
    redis: &mut ConnectionManager,
    login_id: Uuid,
    challenge_id: Uuid,
    step: u64,
) -> anyhow::Result<ClaimChallengeOutcome> {
    let raw: Option<String> = redis::Script::new(
        r#"
local challenge_key = KEYS[1]
local active_key = KEYS[2]
local fails_key = KEYS[3]
local used_step_key = KEYS[4]
local challenge_id = ARGV[1]
local step = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local replay_marker = ARGV[4]
local active = redis.call('GET', active_key)
if (not active) or active ~= challenge_id then
  return false
end
local raw = redis.call('GET', challenge_key)
if not raw then
  redis.call('DEL', active_key)
  return false
end
local prev = redis.call('GET', used_step_key)
if prev and tonumber(prev) >= step then
  return replay_marker
end
redis.call('SET', used_step_key, step, 'EX', ttl)
redis.call('DEL', challenge_key, active_key, fails_key)
return raw
        "#,
    )
    .key(challenge_key(challenge_id))
    .key(login_active_key(login_id))
    .key(login_fails_key(login_id))
    .key(login_used_step_key(login_id))
    .arg(challenge_id.to_string())
    .arg(step)
    .arg(TOTP_2FA_USED_STEP_TTL_SEC)
    .arg(CLAIM_STEP_REPLAY_MARKER)
    .invoke_async(redis)
    .await
    .c(h!())?;

    match raw {
        None => Ok(ClaimChallengeOutcome::Missing),
        Some(marker) if marker == CLAIM_STEP_REPLAY_MARKER => {
            Ok(ClaimChallengeOutcome::StepReplayed)
        }
        Some(raw) => Ok(ClaimChallengeOutcome::Claimed(
            serde_json::from_str(&raw).c(h!())?,
        )),
    }
}
