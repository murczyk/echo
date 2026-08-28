use crate::config::{
    TOTP_2FA_CHALLENGE_REDIS_PREFIX, TOTP_2FA_CHALLENGE_TTL_SEC,
    TOTP_2FA_MAX_ATTEMPTS,
};
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

    pub fn attempts(&self) -> u32 {
        match self {
            TotpChallenge::Enroll { attempts, .. }
            | TotpChallenge::Verify { attempts, .. } => *attempts,
        }
    }

    fn with_attempts(self, attempts: u32) -> Self {
        match self {
            TotpChallenge::Enroll {
                login_id,
                pending_secret,
                ..
            } => TotpChallenge::Enroll {
                login_id,
                pending_secret,
                attempts,
            },
            TotpChallenge::Verify { login_id, .. } => TotpChallenge::Verify {
                login_id,
                attempts,
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FailedAttemptResult {
    StillOpen(TotpChallenge),
    LockedOut,
    Missing,
}

fn challenge_key(challenge_id: Uuid) -> String {
    format!("{TOTP_2FA_CHALLENGE_REDIS_PREFIX}{challenge_id}")
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
    let payload = serde_json::to_string(&challenge)?;
    let _: () = redis
        .set_ex(key, payload, TOTP_2FA_CHALLENGE_TTL_SEC)
        .await?;
    Ok(challenge_id)
}

pub async fn get_challenge(
    redis: &mut ConnectionManager,
    challenge_id: Uuid,
) -> anyhow::Result<Option<TotpChallenge>> {
    let key = challenge_key(challenge_id);
    let raw: Option<String> = redis.get(key).await?;
    match raw {
        None => Ok(None),
        Some(raw) => Ok(Some(serde_json::from_str(&raw)?)),
    }
}

pub async fn delete_challenge(
    redis: &mut ConnectionManager,
    challenge_id: Uuid,
) -> anyhow::Result<()> {
    let key = challenge_key(challenge_id);
    let _: () = redis.del(key).await?;
    Ok(())
}

pub async fn record_failed_attempt(
    redis: &mut ConnectionManager,
    challenge_id: Uuid,
) -> anyhow::Result<FailedAttemptResult> {
    let key = challenge_key(challenge_id);
    let ttl: i64 = redis.ttl(&key).await?;
    let Some(raw): Option<String> = redis.get(&key).await? else {
        return Ok(FailedAttemptResult::Missing);
    };
    let challenge: TotpChallenge = serde_json::from_str(&raw)?;
    let attempts = challenge.attempts().saturating_add(1);
    if attempts >= TOTP_2FA_MAX_ATTEMPTS {
        let _: () = redis.del(&key).await?;
        return Ok(FailedAttemptResult::LockedOut);
    }
    let challenge = challenge.with_attempts(attempts);
    let payload = serde_json::to_string(&challenge)?;
    if ttl > 0 {
        let _: () = redis.set_ex(&key, payload, ttl as u64).await?;
    } else {
        let _: () = redis
            .set_ex(&key, payload, TOTP_2FA_CHALLENGE_TTL_SEC)
            .await?;
    }
    Ok(FailedAttemptResult::StillOpen(challenge))
}
