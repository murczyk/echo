use crate::entities::{api_integration, sigint_callsign, sigint_unit};
use crate::error::AppError;
use crate::rer_importer::types::{InboxMessage, InboxMessagesReq};
use crate::sigint::etalonka::query::{
    build_network_freq_join_condition, SigintInboxItem, SigintInboxItemNetwork,
    SigintNetwork, SigintNetworkFreq, SignalMessage,
};
use crate::types::*;
use bytes::Bytes;
use chrono::{NaiveDateTime, Utc};
use futures_util::StreamExt;
use iggy::prelude::{IggyMessage, IggyProducer};
use sea_orm::sea_query::{
    Alias, Expr, ExprTrait, Func, PostgresQueryBuilder, Query, SelectStatement,
};
use sea_orm::*;
use serde::Serialize;
use std::collections::{BTreeSet, HashMap};
use std::time::Duration;
use tokio::time::{sleep, timeout, Instant};

#[derive(Debug, Serialize)]
struct IggyInboxMessage {
    #[serde(flatten)]
    inbox_message: InboxMessage,
    sigint_callsign_ids: Vec<i64>,
    sigint_unit_ids: Vec<i64>,
    sigint_signal_ids: Vec<i64>,
    sigint_network_freq_ids: Vec<i64>,
}

pub async fn run_nofail(env: Arc<Env>) {
    loop {
        let has_active_integrations =
            sync_active_integrations(&env).await.unwrap_or_else(|err| {
                error!("Iggy integration worker cycle failed: {err:#?}");
                false
            });
        let sleep_duration = if has_active_integrations {
            Duration::from_millis(
                crate::config::API_INTEGRATION_IGGY_WORKER_ACTIVE_SLEEP_MS,
            )
        } else {
            Duration::from_secs(
                crate::config::API_INTEGRATION_IGGY_WORKER_IDLE_SLEEP_SEC,
            )
        };
        sleep(sleep_duration).await;
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
    for api_integration in integrations {
        let id = api_integration.id;
        if let Err(err) = sync_integration(env, api_integration).await {
            error!("Iggy integration {id} sync failed: {err:#?}");
            if let Err(status_err) = set_is_working(&env.dbx, id, false).await {
                error!(
                    "Iggy integration {id} status update failed: {status_err:#?}"
                );
            }
        } else {
            info!("Iggy integration {id} sync succeeded");
        }
    }
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
    } else {
        info!(
            "Iggy integration {} did not publish any messages",
            api_integration.id,
        );
        return Ok(());
    }
    let inbox_messages =
        enrich_inbox_messages(env, inbox_messages).await.c(h!())?;
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
    inbox_messages: Vec<(i64, IggyInboxMessage)>,
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
    let logins = crate::users::get_organism_login_ids_by_id(
        &env.dbx,
        &api_integration.api_user_login_id,
    )
    .await
    .c(h!())?;
    crate::rer_importer::inbox::get_inbox_messages_created_between(
        &api_integration.api_user_login_id,
        &logins,
        env,
        &req,
        last_sync_at,
        started_at,
    )
    .await
}

async fn enrich_inbox_messages(
    env: &Env,
    inbox_messages: Vec<(i64, InboxMessage)>,
) -> Result<Vec<(i64, IggyInboxMessage)>, AppError> {
    let callsign_ids = load_callsign_ids(env, &inbox_messages).await.c(h!())?;
    let inbox_item_ids =
        inbox_messages.iter().map(|(id, _)| *id).collect::<Vec<_>>();
    let mut network_freq_ids = load_network_freq_ids(&env.dbx, &inbox_item_ids)
        .await
        .c(h!())?;

    Ok(inbox_messages
        .into_iter()
        .map(|(id, inbox_message)| {
            let network_freq_ids =
                network_freq_ids.remove(&id).unwrap_or_default();
            (
                id,
                enrich_inbox_message(
                    inbox_message,
                    &callsign_ids,
                    network_freq_ids,
                ),
            )
        })
        .collect())
}

async fn load_callsign_ids(
    env: &Env,
    inbox_messages: &[(i64, InboxMessage)],
) -> Result<HashMap<String, BTreeSet<i64>>, AppError> {
    let callsigns = inbox_messages
        .iter()
        .flat_map(|(_, inbox_message)| {
            inbox_message
                .callsigns
                .iter()
                .chain(&inbox_message.callsigns_alg2)
        })
        .map(|callsign| callsign.to_lowercase())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let mut callsign_ids = HashMap::<String, BTreeSet<i64>>::new();
    for callsigns in callsigns
        .chunks(crate::config::API_INTEGRATION_IGGY_ENRICHMENT_ID_BATCH_SIZE)
    {
        let callsigns = sigint_callsign::Entity::find()
            .join(
                JoinType::InnerJoin,
                sigint_callsign::Relation::SigintUnit.def(),
            )
            .filter(
                Func::lower(Expr::col((
                    sigint_callsign::Entity,
                    sigint_callsign::Column::Callsign,
                )))
                .is_in(callsigns.iter().cloned()),
            )
            .filter(sigint_callsign::Column::Deleted.eq(false))
            .filter(sigint_unit::Column::Deleted.eq(false))
            .filter(sigint_unit::Column::Active.eq(true))
            .all(&env.dbx)
            .await
            .c(h!())?;
        for callsign in callsigns {
            callsign_ids
                .entry(callsign.callsign.to_lowercase())
                .or_default()
                .insert(callsign.id);
        }
    }
    Ok(callsign_ids)
}

fn enrich_inbox_message(
    inbox_message: InboxMessage,
    callsign_ids: &HashMap<String, BTreeSet<i64>>,
    sigint_network_freq_ids: Vec<i64>,
) -> IggyInboxMessage {
    let sigint_callsign_ids = inbox_message
        .callsigns
        .iter()
        .chain(&inbox_message.callsigns_alg2)
        .filter_map(|callsign| callsign_ids.get(&callsign.to_lowercase()))
        .flatten()
        .copied()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let sigint_unit_ids = inbox_message
        .unit_ids
        .iter()
        .copied()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let sigint_signal_ids = inbox_message
        .signal_tokens
        .iter()
        .flatten()
        .map(|signal| signal.id)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    IggyInboxMessage {
        inbox_message,
        sigint_callsign_ids,
        sigint_unit_ids,
        sigint_signal_ids,
        sigint_network_freq_ids,
    }
}

async fn load_network_freq_ids(
    dbx: &DatabaseConnection,
    inbox_item_ids: &[i64],
) -> Result<HashMap<i64, Vec<i64>>, AppError> {
    let mut ids_by_inbox_item = HashMap::<i64, BTreeSet<i64>>::new();
    for inbox_item_ids in inbox_item_ids
        .chunks(crate::config::API_INTEGRATION_IGGY_ENRICHMENT_ID_BATCH_SIZE)
    {
        let query = build_network_freq_ids_query(inbox_item_ids).c(h!())?;
        let rows = dbx
            .query_all_raw(Statement::from_string(
                DatabaseBackend::Postgres,
                query.to_string(PostgresQueryBuilder),
            ))
            .await
            .c(h!())?;
        for row in rows {
            let inbox_item_id = row.try_get("", "inbox_item_id").c(h!())?;
            let network_freq_id = row.try_get("", "network_freq_id").c(h!())?;
            ids_by_inbox_item
                .entry(inbox_item_id)
                .or_default()
                .insert(network_freq_id);
        }
    }
    Ok(ids_by_inbox_item
        .into_iter()
        .map(|(id, network_freq_ids)| {
            (id, network_freq_ids.into_iter().collect())
        })
        .collect())
}

fn build_network_freq_ids_query(
    inbox_item_ids: &[i64],
) -> Result<SelectStatement, AppError> {
    let network_freqs = Alias::new("network_freqs");
    let join_condition =
        build_network_freq_join_condition(None, true).c(h!())?;
    Ok(Query::select()
        .distinct()
        .expr_as(
            Expr::col((SigintInboxItem::Table, SigintInboxItem::Id)),
            Alias::new("inbox_item_id"),
        )
        .expr_as(
            Expr::col((network_freqs.clone(), SigintNetworkFreq::Id)),
            Alias::new("network_freq_id"),
        )
        .from(SignalMessage::Table)
        .join(
            JoinType::InnerJoin,
            SigintInboxItem::Table,
            Expr::col((SignalMessage::Table, SignalMessage::Id))
                .equals((SigintInboxItem::Table, SigintInboxItem::Id)),
        )
        .join(
            JoinType::InnerJoin,
            SigintInboxItemNetwork::Table,
            Expr::col((SigintInboxItem::Table, SigintInboxItem::Id)).equals((
                SigintInboxItemNetwork::Table,
                SigintInboxItemNetwork::SigintInboxItemId,
            )),
        )
        .join_as(
            JoinType::InnerJoin,
            SigintNetworkFreq::Table,
            network_freqs.clone(),
            join_condition,
        )
        .join(
            JoinType::InnerJoin,
            SigintNetwork::Table,
            Expr::col((SigintNetwork::Table, SigintNetwork::Id))
                .equals((network_freqs.clone(), SigintNetworkFreq::NetworkId)),
        )
        .and_where(
            Expr::col((SigintInboxItem::Table, SigintInboxItem::Id))
                .is_in(inbox_item_ids.iter().copied()),
        )
        .and_where(
            Expr::col((network_freqs.clone(), SigintNetworkFreq::Deleted))
                .eq(false),
        )
        .and_where(
            Expr::col((SigintNetwork::Table, SigintNetwork::Deleted)).eq(false),
        )
        .order_by_expr(
            Expr::col((SigintInboxItem::Table, SigintInboxItem::Id)),
            Order::Asc,
        )
        .order_by_expr(
            Expr::col((network_freqs, SigintNetworkFreq::Id)),
            Order::Asc,
        )
        .to_owned())
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
    use crate::entities::{
        sigint_callsign, sigint_inbox_item, sigint_inbox_item_network,
        sigint_network, sigint_network_freq, sigint_signal, signal_message,
    };
    use crate::functest::tests::*;
    use crate::rer_importer::signals::CNSignal;
    use crate::rer_importer::types::InboxInsertPayload;
    use chrono::Duration as ChronoDuration;
    use serial_test::serial;

    #[test]
    fn publish_retry_delays_match_required_attempts() {
        assert_eq!(publish_retry_delay(0), None);
        assert_eq!(publish_retry_delay(1), Some(Duration::from_millis(100)));
        assert_eq!(publish_retry_delay(2), Some(Duration::from_secs(1)));
    }

    async fn insert_callsign(
        env: &Env,
        unit_id: i64,
        intercepted_at: NaiveDateTime,
    ) -> i64 {
        sigint_callsign::ActiveModel {
            callsign: Set("Iggy-Test-Callsign".to_string()),
            position: Set(String::new()),
            comment: Set(String::new()),
            unit_id: Set(unit_id),
            deleted: Set(false),
            created_at: Set(intercepted_at),
            source_id: Set(None),
            developing: Set(false),
            radio_freq: Set(String::new()),
            sigint_origin_id: Set(None),
            original_id: Set(None),
            full_name: Set(String::new()),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap()
        .id
    }

    async fn insert_signal(
        env: &Env,
        unit_id: i64,
        intercepted_at: NaiveDateTime,
    ) -> i64 {
        sigint_signal::ActiveModel {
            text: Set("iggy-test-signal".to_string()),
            meaning: Set(None),
            unit: Set(Some(unit_id)),
            coordinates: Set(None),
            deleted: Set(false),
            created_at: Set(intercepted_at),
            sigint_origin_id: Set(None),
            original_id: Set(None),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap()
        .id
    }

    async fn insert_inbox_item(
        env: &Env,
        intercepted_at: NaiveDateTime,
    ) -> i64 {
        let signal_message = mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                created_at: Set(intercepted_at),
                timestamp: Set(Some(intercepted_at)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_inbox_item(
            &env.dbx,
            sigint_inbox_item::ActiveModel {
                id: Set(signal_message.id),
                freq: Set(Some("123.45".to_string())),
                datetime: Set(Some(intercepted_at)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        signal_message.id
    }

    struct NetworkFixture {
        network_id: i64,
        network_freq_id: i64,
    }

    async fn insert_network_frequency(
        env: &Env,
        inbox_item_id: i64,
        intercepted_at: NaiveDateTime,
        deleted: bool,
    ) -> NetworkFixture {
        let network = mk_sigint_network(
            &env.dbx,
            sigint_network::ActiveModel {
                deleted: Set(deleted),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let network_freq = mk_sigint_network_freq(
            &env.dbx,
            sigint_network_freq::ActiveModel {
                network_id: Set(network.id),
                freq: Set("123.45".to_string()),
                active_from: Set(intercepted_at - ChronoDuration::hours(1)),
                active_to: Set(Some(intercepted_at)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_inbox_item_network(
            &env.dbx,
            sigint_inbox_item_network::ActiveModel {
                sigint_inbox_item_id: Set(inbox_item_id),
                sigint_network_id: Set(network.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        NetworkFixture {
            network_id: network.id,
            network_freq_id: network_freq.id,
        }
    }

    async fn insert_future_network_frequency(
        env: &Env,
        network_id: i64,
        intercepted_at: NaiveDateTime,
    ) {
        mk_sigint_network_freq(
            &env.dbx,
            sigint_network_freq::ActiveModel {
                network_id: Set(network_id),
                freq: Set("123.45".to_string()),
                active_from: Set(intercepted_at + ChronoDuration::hours(1)),
                active_to: Set(Some(intercepted_at + ChronoDuration::hours(2))),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    }

    fn build_inbox_message(
        unit_id: i64,
        signal_id: i64,
        network_id: i64,
    ) -> InboxMessage {
        let mut inbox_message: InboxMessage = InboxInsertPayload {
            text: "interception".to_string(),
            freq: Some("123.45".to_string()),
            callsigns: vec!["IGGY-TEST-CALLSIGN".to_string()],
            network_ids: Some(vec![network_id]),
            ..Default::default()
        }
        .into();
        inbox_message.unit_ids = vec![unit_id];
        inbox_message.signal_tokens = Some(vec![CNSignal {
            begin: 0,
            end: 1,
            etalon: "iggy-test-signal".to_string(),
            text: "s".to_string(),
            id: signal_id,
        }]);
        inbox_message
    }

    #[actix_web::test]
    #[serial]
    async fn inbox_event_contains_dictionary_ids_and_stays_compatible() {
        let env = cleanup().await.unwrap();
        let intercepted_at = Utc::now().naive_utc();
        let unit = mk_sigint_unit(&env.dbx, Default::default()).await.unwrap();
        let callsign_id = insert_callsign(&env, unit.id, intercepted_at).await;
        let signal_id = insert_signal(&env, unit.id, intercepted_at).await;
        let inbox_item_id = insert_inbox_item(&env, intercepted_at).await;
        let network = insert_network_frequency(
            &env,
            inbox_item_id,
            intercepted_at,
            false,
        )
        .await;
        insert_future_network_frequency(
            &env,
            network.network_id,
            intercepted_at,
        )
        .await;
        insert_network_frequency(&env, inbox_item_id, intercepted_at, true)
            .await;
        let inbox_message =
            build_inbox_message(unit.id, signal_id, network.network_id);
        let enriched =
            enrich_inbox_messages(&env, vec![(inbox_item_id, inbox_message)])
                .await
                .unwrap();
        let event = serde_json::to_value(&enriched[0]).unwrap();
        assert_eq!(event[0], serde_json::json!(inbox_item_id));
        assert_eq!(
            event[1]["sigint_callsign_ids"],
            serde_json::json!([callsign_id])
        );
        assert_eq!(event[1]["sigint_unit_ids"], serde_json::json!([unit.id]));
        assert_eq!(
            event[1]["sigint_signal_ids"],
            serde_json::json!([signal_id])
        );
        assert_eq!(
            event[1]["sigint_network_freq_ids"],
            serde_json::json!([network.network_freq_id])
        );
        let old_message: InboxMessage =
            serde_json::from_value(event[1].clone()).unwrap();
        assert_eq!(old_message.text, "interception");
    }
}
