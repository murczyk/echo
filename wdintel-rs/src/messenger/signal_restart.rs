use crate::config::{
    SIGNAL_RESTART_COOLDOWN_REDIS_PREFIX, SIGNAL_RESTART_COOLDOWN_TTL_SEC,
    SIGNAL_RESTART_MAINTENANCE_REDIS_PREFIX,
    SIGNAL_RESTART_MAINTENANCE_TTL_SEC,
};
use crate::h;
use anyhow::{bail, Context};
use async_trait::async_trait;
use echo_im::worker::{
    SignalRestartAcquireOutcome, SignalRestartCoordinator, SignalRestartState,
    SignalWorkerOptions,
};
use redis::aio::ConnectionManager;
use std::fmt::{Debug, Formatter};
use std::sync::Arc;
use uuid::Uuid;

const ACQUIRE_SCRIPT: &str = r#"
if redis.call('EXISTS', KEYS[2]) == 1 then
    return 3
end
if redis.call('EXISTS', KEYS[1]) == 1 then
    return 2
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return 1
"#;

const COMPLETE_SCRIPT: &str = r#"
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
    return 0
end
redis.call('SET', KEYS[2], '1', 'EX', ARGV[2])
redis.call('DEL', KEYS[1])
return 1
"#;

const ABORT_SCRIPT: &str = r#"
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
end
return 0
"#;

#[derive(Clone)]
pub struct RedisSignalRestartCoordinator {
    redis: Option<ConnectionManager>,
    unavailable_reason: Option<String>,
    maintenance_ttl_sec: u64,
    cooldown_ttl_sec: u64,
}

impl RedisSignalRestartCoordinator {
    pub fn new(redis: ConnectionManager) -> Self {
        Self {
            redis: Some(redis),
            unavailable_reason: None,
            maintenance_ttl_sec: SIGNAL_RESTART_MAINTENANCE_TTL_SEC,
            cooldown_ttl_sec: SIGNAL_RESTART_COOLDOWN_TTL_SEC,
        }
    }

    pub fn unavailable(reason: String) -> Self {
        Self {
            redis: None,
            unavailable_reason: Some(reason),
            maintenance_ttl_sec: SIGNAL_RESTART_MAINTENANCE_TTL_SEC,
            cooldown_ttl_sec: SIGNAL_RESTART_COOLDOWN_TTL_SEC,
        }
    }

    fn connection(&self) -> anyhow::Result<ConnectionManager> {
        let Some(redis) = self.redis.clone() else {
            bail!(
                "Signal restart coordination is unavailable: {}",
                self.unavailable_reason
                    .as_deref()
                    .unwrap_or("Redis unavailable")
            );
        };
        Ok(redis)
    }

    fn keys(client_name: &str) -> (String, String) {
        (
            format!("{SIGNAL_RESTART_MAINTENANCE_REDIS_PREFIX}:{client_name}"),
            format!("{SIGNAL_RESTART_COOLDOWN_REDIS_PREFIX}:{client_name}"),
        )
    }

    #[cfg(test)]
    fn with_ttls(
        redis: ConnectionManager,
        maintenance_ttl_sec: u64,
        cooldown_ttl_sec: u64,
    ) -> Self {
        Self {
            redis: Some(redis),
            unavailable_reason: None,
            maintenance_ttl_sec,
            cooldown_ttl_sec,
        }
    }
}

impl Debug for RedisSignalRestartCoordinator {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RedisSignalRestartCoordinator")
            .field("available", &self.redis.is_some())
            .field("maintenance_ttl_sec", &self.maintenance_ttl_sec)
            .field("cooldown_ttl_sec", &self.cooldown_ttl_sec)
            .finish()
    }
}

#[async_trait]
impl SignalRestartCoordinator for RedisSignalRestartCoordinator {
    async fn acquire(
        &self,
        client_name: &str,
    ) -> anyhow::Result<SignalRestartAcquireOutcome> {
        let (maintenance_key, cooldown_key) = Self::keys(client_name);
        let token = Uuid::new_v4().to_string();
        let mut redis = self.connection().context(h!())?;
        let outcome = redis::cmd("EVAL")
            .arg(ACQUIRE_SCRIPT)
            .arg(2)
            .arg(maintenance_key)
            .arg(cooldown_key)
            .arg(&token)
            .arg(self.maintenance_ttl_sec)
            .query_async::<i64>(&mut redis)
            .await
            .context(h!())?;
        match outcome {
            1 => Ok(SignalRestartAcquireOutcome::Acquired { token }),
            2 => Ok(SignalRestartAcquireOutcome::MaintenanceActive),
            3 => Ok(SignalRestartAcquireOutcome::CooldownActive),
            value => bail!("unexpected Signal restart acquire outcome {value}"),
        }
    }

    async fn complete(
        &self,
        client_name: &str,
        token: &str,
    ) -> anyhow::Result<bool> {
        let (maintenance_key, cooldown_key) = Self::keys(client_name);
        let mut redis = self.connection().context(h!())?;
        Ok(redis::cmd("EVAL")
            .arg(COMPLETE_SCRIPT)
            .arg(2)
            .arg(maintenance_key)
            .arg(cooldown_key)
            .arg(token)
            .arg(self.cooldown_ttl_sec)
            .query_async::<i64>(&mut redis)
            .await
            .context(h!())?
            == 1)
    }

    async fn abort(
        &self,
        client_name: &str,
        token: &str,
    ) -> anyhow::Result<bool> {
        let (maintenance_key, _) = Self::keys(client_name);
        let mut redis = self.connection().context(h!())?;
        Ok(redis::cmd("EVAL")
            .arg(ABORT_SCRIPT)
            .arg(1)
            .arg(maintenance_key)
            .arg(token)
            .query_async::<i64>(&mut redis)
            .await
            .context(h!())?
            == 1)
    }

    async fn state(
        &self,
        client_name: &str,
    ) -> anyhow::Result<SignalRestartState> {
        let (maintenance_key, cooldown_key) = Self::keys(client_name);
        let mut redis = self.connection().context(h!())?;
        let (maintenance_active, cooldown_active) = redis::pipe()
            .exists(maintenance_key)
            .exists(cooldown_key)
            .query_async::<(bool, bool)>(&mut redis)
            .await
            .context(h!())?;
        if maintenance_active {
            Ok(SignalRestartState::MaintenanceActive)
        } else if cooldown_active {
            Ok(SignalRestartState::CooldownActive)
        } else {
            Ok(SignalRestartState::Idle)
        }
    }
}

pub fn signal_worker_options(
    coordinator: RedisSignalRestartCoordinator,
    restapi_error_discord_webhook_url: Option<String>,
) -> SignalWorkerOptions {
    SignalWorkerOptions {
        restapi_error_discord_webhook_url,
        restart_coordinator: Some(Arc::new(coordinator)),
    }
}

pub fn normalized_failure(failure: &impl Debug) -> String {
    format!("{failure:?}")
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(": ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::time::{sleep, Duration};

    async fn test_coordinator(
        maintenance_ttl_sec: u64,
        cooldown_ttl_sec: u64,
    ) -> RedisSignalRestartCoordinator {
        let client = redis::Client::open("redis://127.0.0.1/15").unwrap();
        let redis = client.get_connection_manager().await.unwrap();
        RedisSignalRestartCoordinator::with_ttls(
            redis,
            maintenance_ttl_sec,
            cooldown_ttl_sec,
        )
    }

    async fn clear(
        coordinator: &RedisSignalRestartCoordinator,
        client_name: &str,
    ) {
        let (maintenance_key, cooldown_key) =
            RedisSignalRestartCoordinator::keys(client_name);
        let mut redis = coordinator.connection().unwrap();
        redis::cmd("DEL")
            .arg(maintenance_key)
            .arg(cooldown_key)
            .query_async::<i64>(&mut redis)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn coordinates_restart_lease_release_and_cooldown() {
        let coordinator = test_coordinator(10, 10).await;
        let client_name = format!("test-signal-restart-{}", Uuid::new_v4());
        clear(&coordinator, &client_name).await;

        let SignalRestartAcquireOutcome::Acquired { token } =
            coordinator.acquire(&client_name).await.unwrap()
        else {
            panic!("expected acquired lease");
        };
        assert_eq!(
            coordinator.acquire(&client_name).await.unwrap(),
            SignalRestartAcquireOutcome::MaintenanceActive
        );
        assert!(!coordinator
            .abort(&client_name, "wrong-token")
            .await
            .unwrap());
        assert_eq!(
            coordinator.state(&client_name).await.unwrap(),
            SignalRestartState::MaintenanceActive
        );
        assert!(coordinator.complete(&client_name, &token).await.unwrap());
        assert_eq!(
            coordinator.state(&client_name).await.unwrap(),
            SignalRestartState::CooldownActive
        );
        assert_eq!(
            coordinator.acquire(&client_name).await.unwrap(),
            SignalRestartAcquireOutcome::CooldownActive
        );

        clear(&coordinator, &client_name).await;
    }

    #[tokio::test]
    async fn only_one_concurrent_restart_acquires_the_lease() {
        let coordinator = test_coordinator(10, 10).await;
        let client_name = format!("test-signal-restart-{}", Uuid::new_v4());
        clear(&coordinator, &client_name).await;

        let (first, second) = tokio::join!(
            coordinator.acquire(&client_name),
            coordinator.acquire(&client_name)
        );
        let outcomes = [first.unwrap(), second.unwrap()];
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| matches!(
                    outcome,
                    SignalRestartAcquireOutcome::Acquired { .. }
                ))
                .count(),
            1
        );
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| **outcome
                    == SignalRestartAcquireOutcome::MaintenanceActive)
                .count(),
            1
        );

        clear(&coordinator, &client_name).await;
    }

    #[tokio::test]
    async fn expired_lease_allows_recovery() {
        let coordinator = test_coordinator(1, 1).await;
        let client_name = format!("test-signal-restart-{}", Uuid::new_v4());
        clear(&coordinator, &client_name).await;

        assert!(matches!(
            coordinator.acquire(&client_name).await.unwrap(),
            SignalRestartAcquireOutcome::Acquired { .. }
        ));
        sleep(Duration::from_millis(1_100)).await;
        assert!(matches!(
            coordinator.acquire(&client_name).await.unwrap(),
            SignalRestartAcquireOutcome::Acquired { .. }
        ));

        clear(&coordinator, &client_name).await;
    }
}
