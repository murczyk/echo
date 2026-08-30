use crate::config::{
    TOTP_2FA_CHALLENGE_REDIS_PREFIX, TOTP_2FA_CHALLENGE_TTL_SEC,
    TOTP_2FA_MAX_ATTEMPTS,
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
        pending_secret: String,
        #[serde(default)]
        attempts: u32,
    },
    Verify {
        login_id: Uuid,
        #[serde(default)]
        attempts: u32,
    },
}

impl TotpChallenge {
    pub fn login_id(&self) -> Uuid {
        match self {
            TotpChallenge::Enroll { login_id, .. }
            | TotpChallenge::Verify { login_id, .. } => *login_id,
        }
    }
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

fn attempts_key(challenge_id: Uuid) -> String {
    format!("{TOTP_2FA_CHALLENGE_REDIS_PREFIX}{challenge_id}:attempts")
}

pub async fn create_enroll_challenge(
    redis: &mut ConnectionManager,
    login_id: Uuid,
    pending_secret: &str,
) -> anyhow::Result<Uuid> {
    let challenge = TotpChallenge::Enroll {
        login_id,
        pending_secret: pending_secret.to_string(),
        attempts: 0,
    };
    store_challenge(redis, challenge).await
}

pub async fn create_verify_challenge(
    redis: &mut ConnectionManager,
    login_id: Uuid,
) -> anyhow::Result<Uuid> {
    let challenge = TotpChallenge::Verify {
        login_id,
        attempts: 0,
    };
    store_challenge(redis, challenge).await
}

async fn store_challenge(
    redis: &mut ConnectionManager,
    challenge: TotpChallenge,
) -> anyhow::Result<Uuid> {
    let challenge_id = Uuid::new_v4();
    let key = challenge_key(challenge_id);
    let payload = serde_json::to_string(&challenge).c(h!())?;
    let _: () = redis
        .set_ex(key, payload, TOTP_2FA_CHALLENGE_TTL_SEC)
        .await
        .c(h!())?;
    Ok(challenge_id)
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
    challenge_id: Uuid,
) -> anyhow::Result<()> {
    let keys = [challenge_key(challenge_id), attempts_key(challenge_id)];
    let _: () = redis.del(&keys).await.c(h!())?;
    Ok(())
}

/// Atomically increments the failed-attempt counter for a challenge.
/// On lockout, deletes the challenge and counter in the same Redis script.
pub async fn record_failed_attempt(
    redis: &mut ConnectionManager,
    challenge_id: Uuid,
) -> anyhow::Result<FailedAttemptResult> {
    // 0 = missing, 1 = still open, 2 = locked out
    let result: i64 = redis::Script::new(
        r#"
local challenge_key = KEYS[1]
local attempts_key = KEYS[2]
local max_attempts = tonumber(ARGV[1])
local default_ttl = tonumber(ARGV[2])
if redis.call('EXISTS', challenge_key) == 0 then
  redis.call('DEL', attempts_key)
  return 0
end
local attempts = redis.call('INCR', attempts_key)
if attempts == 1 then
  local ttl = redis.call('TTL', challenge_key)
  if ttl > 0 then
    redis.call('EXPIRE', attempts_key, ttl)
  else
    redis.call('EXPIRE', attempts_key, default_ttl)
  end
end
if attempts >= max_attempts then
  redis.call('DEL', challenge_key, attempts_key)
  return 2
end
return 1
        "#,
    )
    .key(challenge_key(challenge_id))
    .key(attempts_key(challenge_id))
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
