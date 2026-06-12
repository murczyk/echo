use crate::entities::api_integration;
use crate::error::AppError;
use crate::rer_importer::types::InboxMessagesReq;
use crate::types::*;
use bytes::Bytes;
use chrono::{NaiveDateTime, Utc};
use futures_util::{future::join_all, StreamExt};
use iggy::prelude::{IggyMessage, IggyProducer};
use sea_orm::*;
use std::time::Duration;
use tokio::time::{sleep, timeout, Instant};
use tokio_util::sync::CancellationToken;

pub async fn run_nofail(env: Arc<Env>, cancel_token: CancellationToken) {
    loop {
        let has_active_integrations = match sync_active_integrations(&env).await
        {
            Ok(has_active_integrations) => has_active_integrations,
            Err(err) => {
                error!("Iggy integration worker cycle failed: {err:#?}");
                false
            }
        };
        let sleep_duration = if has_active_integrations {
            Duration::from_millis(
                crate::config::API_INTEGRATION_IGGY_WORKER_ACTIVE_SLEEP_MS,
            )
        } else {
            Duration::from_secs(
                crate::config::API_INTEGRATION_IGGY_WORKER_IDLE_SLEEP_SEC,
            )
        };
        tokio::select! {
            _ = cancel_token.cancelled() => return,
            _ = sleep(sleep_duration) => {}
        }
    }
}

async fn sync_active_integrations(env: &Env) -> Result<bool, AppError> {
    let integrations = api_integration::Entity::find()
        .filter(api_integration::Column::SyncEnabled.eq(true))
        .filter(api_integration::Column::HasIggyConnection.eq(true))
        .order_by_asc(api_integration::Column::Id)
        .all(&env.dbx)
        .await
        .c(h!())?;
    let has_active_integrations = !integrations.is_empty();
    let syncs = integrations.into_iter().map(|api_integration| async move {
        let id = api_integration.id;
        if let Err(err) = sync_integration(env, api_integration).await {
            error!("Iggy integration {id} sync failed: {err:#?}");
            if let Err(status_err) = set_is_working(&env.dbx, id, false).await {
                error!(
                    "Iggy integration {id} status update failed: {status_err:#?}"
                );
            }
        }
    });
    join_all(syncs).await;
    Ok(has_active_integrations)
}

async fn sync_integration(
    env: &Env,
    api_integration: api_integration::Model,
) -> Result<(), AppError> {
    let url = api_integration.iggy_url.as_deref().c(h!())?;
    let iggy_login = api_integration.iggy_login.as_deref().c(h!())?;
    let password = api_integration.iggy_password.as_deref().c(h!())?;
    if !api_integration.is_working {
        if let Err(err) =
            crate::iggy::test_connection(url, iggy_login, password).await
        {
            warn!(
                "Iggy integration {} connection test failed: {err:#?}",
                api_integration.id
            );
            set_is_working(&env.dbx, api_integration.id, false)
                .await
                .c(h!())?;
            return Ok(());
        }
        set_is_working(&env.dbx, api_integration.id, true)
            .await
            .c(h!())?;
    }

    let started_at = Utc::now().naive_utc();
    let inbox_messages = load_inbox_messages(env, &api_integration, started_at)
        .await
        .c(h!())?;
    if !inbox_messages.is_empty() {
        info!(
            "Iggy integration {} publishing {} inbox messages",
            api_integration.id,
            inbox_messages.len()
        );
    }
    let client = crate::iggy::connect(url, iggy_login, password).await?;
    let sync_result = sync_connected_integration(
        env,
        &api_integration,
        started_at,
        inbox_messages,
        &client,
    )
    .await;
    let shutdown_result = crate::iggy::shutdown(&client).await;
    sync_result?;
    shutdown_result
}

async fn sync_connected_integration(
    env: &Env,
    api_integration: &api_integration::Model,
    started_at: NaiveDateTime,
    inbox_messages: Vec<(i64, crate::rer_importer::types::InboxMessage)>,
    client: &iggy::prelude::IggyClient,
) -> Result<(), AppError> {
    let inbox_topic = api_integration.iggy_inbox_topic.as_deref().c(h!())?;
    let (stream, topic) = crate::iggy::stream_and_topic(inbox_topic);
    let producer = client
        .producer(stream, topic)
        .c(h!())?
        .send_retries(Some(0), None)
        .build();
    producer.init().await.c(h!())?;

    for inbox_message in inbox_messages {
        let payload = serde_json::to_vec(&inbox_message).c(h!())?;
        if let Err(err) = publish_with_retry(&producer, &payload).await {
            error!(
                "Iggy integration {} failed to publish inbox message {}: {err:#?}",
                api_integration.id, inbox_message.0
            );
            set_is_working(&env.dbx, api_integration.id, false)
                .await
                .c(h!())?;
            return Ok(());
        }
    }

    set_sync_completed(&env.dbx, api_integration.id, started_at)
        .await
        .c(h!())?;
    log_analytics_entries(client, api_integration).await
}

async fn load_inbox_messages(
    env: &Env,
    api_integration: &api_integration::Model,
    started_at: NaiveDateTime,
) -> Result<Vec<(i64, crate::rer_importer::types::InboxMessage)>, AppError> {
    let last_sync_at = api_integration.last_sync_at.unwrap_or(started_at);
    let req = InboxMessagesReq {
        nolimit: Some(true),
        newest_first: Some(false),
        ..Default::default()
    };
    let logins = crate::users::get_organism_logins_by_login(
        &env.dbx,
        &api_integration.api_user,
    )
    .await
    .c(h!())?;
    crate::rer_importer::inbox::get_inbox_messages_created_between(
        &api_integration.api_user,
        &logins,
        env,
        &req,
        last_sync_at,
        started_at,
    )
    .await
}

async fn publish_with_retry(
    producer: &IggyProducer,
    payload: &[u8],
) -> Result<(), AppError> {
    for attempt in 0..3 {
        if let Some(delay) = publish_retry_delay(attempt) {
            sleep(delay).await;
        }
        let message = IggyMessage::builder()
            .payload(Bytes::copy_from_slice(payload))
            .build()
            .c(h!())?;
        match producer.send_one(message).await {
            Ok(()) => return Ok(()),
            Err(err) if attempt < 2 => {
                warn!("Iggy publish attempt {} failed: {err:#?}", attempt + 1);
            }
            Err(err) => return Err(err).c(h!())?,
        }
    }
    unreachable!()
}

fn publish_retry_delay(attempt: usize) -> Option<Duration> {
    match attempt {
        1 => Some(Duration::from_millis(
            crate::config::API_INTEGRATION_IGGY_PUBLISH_RETRY_2_MS,
        )),
        2 => Some(Duration::from_millis(
            crate::config::API_INTEGRATION_IGGY_PUBLISH_RETRY_3_MS,
        )),
        _ => None,
    }
}

async fn log_analytics_entries(
    client: &iggy::prelude::IggyClient,
    api_integration: &api_integration::Model,
) -> Result<(), AppError> {
    let analytics_topic =
        api_integration.iggy_analytics_topic.as_deref().c(h!())?;
    let (stream, topic) = crate::iggy::stream_and_topic(analytics_topic);
    let consumer_name = format!("echo-api-integration-{}", api_integration.id);
    let mut consumer = client
        .consumer(&consumer_name, stream, topic, 0)
        .c(h!())?
        .build();
    consumer.init().await.c(h!())?;
    let deadline = Instant::now()
        + Duration::from_secs(
            crate::config::API_INTEGRATION_IGGY_ANALYTICS_WINDOW_SEC,
        );
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        let next = timeout(remaining, consumer.next()).await;
        let Ok(Some(entry)) = next else {
            break;
        };
        let entry = entry.c(h!())?;
        info!(
            "Iggy integration {} analytics entry: {}",
            api_integration.id,
            String::from_utf8_lossy(&entry.message.payload)
        );
    }
    Ok(())
}

async fn set_is_working(
    dbx: &DatabaseConnection,
    id: i64,
    is_working: bool,
) -> Result<(), DbErr> {
    api_integration::ActiveModel {
        id: Set(id),
        is_working: Set(is_working),
        ..Default::default()
    }
    .update(dbx)
    .await?;
    Ok(())
}

async fn set_sync_completed(
    dbx: &DatabaseConnection,
    id: i64,
    started_at: NaiveDateTime,
) -> Result<(), DbErr> {
    api_integration::ActiveModel {
        id: Set(id),
        last_sync_at: Set(Some(started_at)),
        is_working: Set(true),
        ..Default::default()
    }
    .update(dbx)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publish_retry_delays_match_required_attempts() {
        assert_eq!(publish_retry_delay(0), None);
        assert_eq!(publish_retry_delay(1), Some(Duration::from_millis(100)));
        assert_eq!(publish_retry_delay(2), Some(Duration::from_secs(1)));
    }
}
