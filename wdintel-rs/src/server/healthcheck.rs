use crate::config::Config;
use crate::entities::signal_restapi_error;
use crate::h;
use crate::types::*;
use anyhow::Context;
use chrono::*;
use sea_orm::*;

const RESTART_TIME: u64 = 15 * 60;

pub async fn healthcheck_worker(dbx: &DatabaseConnection, config: Config) {
    let mut last_notified_at = None;
    loop {
        debug!("starting healthcheck_worker");
        match run_healthcheck_worker(&dbx, last_notified_at, &config).await {
            Ok(Some(new_last_notified_at)) => {
                last_notified_at = Some(new_last_notified_at)
            }
            Ok(None) => {}
            Err(e) => error!("healthcheck_worker error: {}", e),
        };
        debug!("[healthcheck_worker] nothing to do, sleeping...");
        tokio::time::sleep(tokio::time::Duration::from_secs(RESTART_TIME))
            .await;
    }
}
pub async fn run_healthcheck_worker(
    dbx: &DatabaseConnection,
    last_notified_at: Option<NaiveDateTime>,
    config: &Config,
) -> anyhow::Result<Option<NaiveDateTime>> {
    if let Some(last_notified_at) = last_notified_at {
        let hour_ago = Utc::now() - TimeDelta::minutes(60);
        if last_notified_at.gt(&hour_ago.naive_utc()) {
            return Ok(None);
        }
    }
    let since_last_restart =
        Utc::now() - TimeDelta::seconds(RESTART_TIME as i64);
    let timeouts = signal_restapi_error::Entity::find()
        .filter(
            signal_restapi_error::Column::CreatedAt
                .gt(since_last_restart.naive_utc()),
        )
        .filter(
            signal_restapi_error::Column::ResTxt
                .contains("process killed as timeout reached"),
        )
        .count(dbx)
        .await
        .context(h!())?;
    if timeouts > 4 {
        let content = format!("Почалися таймаути на спробах отримати повідомлення, переприв'яжіть Signal на сервері {}", &config.public_host);
        crate::server::discord::discord_notify(&*content)
            .await
            .context(h!())?;
        Ok(Some(Utc::now().naive_utc()))
    } else {
        Ok(None)
    }
}
