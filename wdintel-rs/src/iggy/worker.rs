use crate::entities::{
    api_integration, api_integration_iggy_destination,
    api_integration_iggy_event, sigint_callsign, sigint_inbox_item_network,
    sigint_unit,
};
use crate::error::AppError;
use crate::rer_importer::callsigns::{
    callsign_match_key, callsign_match_key_expr,
};
use crate::rer_importer::types::{InboxMessage, InboxMessagesReq};
use crate::sigint::etalonka::query::{
    build_open_ended_network_freq_join_condition, SigintInboxItem,
    SigintInboxItemNetwork, SigintNetwork, SigintNetworkFreq, SignalMessage,
};
use crate::types::*;
use bytes::Bytes;
use chrono::{NaiveDateTime, Utc};
use futures_util::StreamExt;
use iggy::prelude::{IggyMessage, IggyProducer};
use sea_orm::sea_query::{
    Alias, Expr, ExprTrait, PostgresQueryBuilder, Query, SelectStatement,
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
    activity_at_ms: i64,
    aor_ids: Vec<i64>,
    sigint_callsign_ids: Vec<i64>,
    sigint_unit_ids: Vec<i64>,
    sigint_signal_ids: Vec<i64>,
    sigint_network_freq_ids: Vec<i64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PendingEventAction {
    Skip,
    Publish,
    Revoke,
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
    let Some(transaction) = try_lock_integration(&env.dbx, api_integration.id)
        .await
        .c(h!())?
    else {
        return Ok(());
    };
    let Some(api_integration) =
        api_integration::Entity::find_by_id(api_integration.id)
            .one(&transaction)
            .await
            .c(h!())?
            .filter(|integration| {
                integration.sync_enabled && integration.has_iggy_connection
            })
    else {
        transaction.commit().await.c(h!())?;
        return Ok(());
    };
    let destinations = load_destinations(&env.dbx, api_integration.id)
        .await
        .c(h!())?;
    let first_destination = destinations.first().c(h!())?;
    let destination = destinations.last().c(h!())?;
    let started_at = Utc::now().naive_utc();
    let pending_events = load_pending_events(&env.dbx, api_integration.id)
        .await
        .c(h!())?;
    let pending_events = pending_events
        .into_iter()
        .filter(|event| event.created_at <= started_at)
        .collect::<Vec<_>>();
    let (historical_events, pending_events): (Vec<_>, Vec<_>) = pending_events
        .into_iter()
        .partition(|event| event.destination_id != destination.id);
    let last_sync_at = sync_historical_destinations(
        env,
        api_integration.id,
        api_integration
            .last_sync_at
            .unwrap_or(first_destination.active_from),
        started_at,
        &destinations,
        &historical_events,
    )
    .await
    .c(h!())?;

    let url = destination.iggy_url.as_deref().c(h!())?;
    let iggy_login = destination.iggy_login.as_deref().c(h!())?;
    let password = destination.iggy_password.as_deref().c(h!())?;
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
            transaction.commit().await.c(h!())?;
            return Ok(());
        }
        set_is_working(&env.dbx, api_integration.id, true)
            .await
            .c(h!())?;
    }

    let inbox_messages = load_inbox_messages(
        env,
        &destination.api_user_login_id,
        std::cmp::max(last_sync_at, destination.active_from),
        started_at,
    )
    .await
    .c(h!())?;
    if !inbox_messages.is_empty() {
        info!(
            "Iggy integration {} publishing {} inbox messages",
            api_integration.id,
            inbox_messages.len()
        );
    } else if pending_events.is_empty() {
        info!(
            "Iggy integration {} did not publish any messages",
            api_integration.id,
        );
        set_sync_completed(&env.dbx, api_integration.id, started_at)
            .await
            .c(h!())?;
        scrub_old_destination_credentials(&env.dbx, api_integration.id)
            .await
            .c(h!())?;
        transaction.commit().await.c(h!())?;
        return Ok(());
    }
    let inbox_messages =
        enrich_inbox_messages(env, inbox_messages).await.c(h!())?;
    let pending_messages = load_pending_event_messages(
        env,
        &destination.api_user_login_id,
        &pending_events,
    )
    .await
    .c(h!())?;
    let client = crate::iggy::connect(url, iggy_login, password)
        .await
        .context(h!())?;
    let sync_result = sync_connected_integration(
        env,
        api_integration.id,
        destination,
        Some(started_at),
        inbox_messages,
        &pending_events,
        &pending_messages,
        &client,
    )
    .await;
    let scrub_result = if sync_result.is_ok() {
        scrub_old_destination_credentials(&env.dbx, api_integration.id).await
    } else {
        Ok(())
    };
    let release_result = transaction.commit().await.c(h!());
    let analytics_result = if sync_result.is_ok()
        && scrub_result.is_ok()
        && release_result.is_ok()
    {
        maybe_log_analytics_entries(&env.dbx, &client, &api_integration).await
    } else {
        Ok(())
    };
    let shutdown_result = crate::iggy::shutdown(&client).await;
    sync_result.context(h!())?;
    scrub_result.context(h!())?;
    release_result.context(h!())?;
    analytics_result.context(h!())?;
    shutdown_result.context(h!())?;
    Ok(())
}

async fn load_destinations(
    dbx: &DatabaseConnection,
    api_integration_id: i64,
) -> Result<Vec<api_integration_iggy_destination::Model>, AppError> {
    api_integration_iggy_destination::Entity::find()
        .filter(
            api_integration_iggy_destination::Column::ApiIntegrationId
                .eq(api_integration_id),
        )
        .order_by_asc(api_integration_iggy_destination::Column::Id)
        .all(dbx)
        .await
        .c(h!())
        .map_err(AppError::from)
}

async fn scrub_old_destination_credentials(
    dbx: &DatabaseConnection,
    api_integration_id: i64,
) -> Result<(), AppError> {
    dbx.query_one_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "select scrub_api_integration_iggy_destination_credentials($1)",
        [api_integration_id.into()],
    ))
    .await
    .c(h!())?;
    Ok(())
}

async fn try_lock_integration(
    dbx: &DatabaseConnection,
    id: i64,
) -> Result<Option<DatabaseTransaction>, AppError> {
    let transaction = dbx.begin().await.c(h!())?;
    let acquired: bool = transaction
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "select pg_try_advisory_xact_lock(hashtextextended($1 || $2::text, 0)) as acquired",
            [
                crate::config::API_INTEGRATION_IGGY_LOCK_NAMESPACE.into(),
                id.into(),
            ],
        ))
        .await
        .c(h!())?
        .c(h!())?
        .try_get("", "acquired")
        .c(h!())?;
    if acquired {
        Ok(Some(transaction))
    } else {
        transaction.rollback().await.c(h!())?;
        Ok(None)
    }
}

pub(crate) async fn lock_integration_for_update(
    transaction: &DatabaseTransaction,
    id: i64,
) -> Result<(), AppError> {
    transaction
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "select pg_advisory_xact_lock(hashtextextended($1 || $2::text, 0))",
            [
                crate::config::API_INTEGRATION_IGGY_LOCK_NAMESPACE.into(),
                id.into(),
            ],
        ))
        .await
        .c(h!())?;
    Ok(())
}

async fn sync_connected_integration(
    env: &Env,
    api_integration_id: i64,
    destination: &api_integration_iggy_destination::Model,
    completed_at: Option<NaiveDateTime>,
    inbox_messages: Vec<(i64, IggyInboxMessage)>,
    pending_events: &[api_integration_iggy_event::Model],
    pending_messages: &HashMap<i64, IggyInboxMessage>,
    client: &iggy::prelude::IggyClient,
) -> Result<(), AppError> {
    let inbox_topic = destination.iggy_inbox_topic.as_deref().c(h!())?;
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
                api_integration_id, inbox_message.0
            );
            return Err(err);
        }
    }

    if let Some(completed_at) = completed_at {
        set_sync_completed(&env.dbx, api_integration_id, completed_at)
            .await
            .c(h!())?;
    }
    publish_pending_events(
        env,
        &destination.api_user_login_id,
        pending_events,
        pending_messages,
        &producer,
    )
    .await
    .c(h!())?;
    Ok(())
}

async fn sync_historical_destinations(
    env: &Env,
    api_integration_id: i64,
    mut last_sync_at: NaiveDateTime,
    started_at: NaiveDateTime,
    destinations: &[api_integration_iggy_destination::Model],
    events: &[api_integration_iggy_event::Model],
) -> Result<NaiveDateTime, AppError> {
    for pair in destinations.windows(2) {
        let destination = &pair[0];
        let completed_at = std::cmp::min(pair[1].active_from, started_at);
        let created_after =
            std::cmp::max(last_sync_at, destination.active_from);
        let inbox_messages = if created_after < completed_at {
            load_inbox_messages(
                env,
                &destination.api_user_login_id,
                created_after,
                completed_at,
            )
            .await
            .c(h!())?
        } else {
            Vec::new()
        };
        let events = events
            .iter()
            .filter(|event| event.destination_id == destination.id)
            .cloned()
            .collect::<Vec<_>>();
        if inbox_messages.is_empty() && events.is_empty() {
            if created_after < completed_at {
                last_sync_at = completed_at;
            }
            continue;
        }
        let inbox_messages =
            enrich_inbox_messages(env, inbox_messages).await.c(h!())?;
        let pending_messages = load_pending_event_messages(
            env,
            &destination.api_user_login_id,
            &events,
        )
        .await
        .c(h!())?;
        let client = crate::iggy::connect(
            destination.iggy_url.as_deref().c(h!())?,
            destination.iggy_login.as_deref().c(h!())?,
            destination.iggy_password.as_deref().c(h!())?,
        )
        .await
        .context(h!())?;
        let sync_result = sync_connected_integration(
            env,
            api_integration_id,
            destination,
            (created_after < completed_at).then_some(completed_at),
            inbox_messages,
            &events,
            &pending_messages,
            &client,
        )
        .await;
        let shutdown_result = crate::iggy::shutdown(&client).await;
        sync_result.context(h!())?;
        shutdown_result.context(h!())?;
        if created_after < completed_at {
            last_sync_at = completed_at;
        }
    }
    Ok(last_sync_at)
}

async fn publish_pending_events(
    env: &Env,
    api_user_login_id: &uuid::Uuid,
    events: &[api_integration_iggy_event::Model],
    pending_messages: &HashMap<i64, IggyInboxMessage>,
    producer: &IggyProducer,
) -> Result<(), AppError> {
    let mut visible_networks = HashMap::new();
    let mut visible_groups = None;
    for event in events {
        let message = event
            .sigint_inbox_item_id
            .and_then(|id| pending_messages.get(&id));
        let action = pending_event_action(
            env,
            api_user_login_id,
            event,
            message,
            &mut visible_networks,
            &mut visible_groups,
        )
        .await
        .c(h!())?;
        if action != PendingEventAction::Skip {
            let payload =
                render_pending_event(event, message, action).c(h!())?;
            if let Err(err) = publish_with_retry(producer, &payload).await {
                error!(
                    "Iggy integration {} failed to publish event {}: {err:#?}",
                    event.api_integration_id, event.id
                );
                return Err(err);
            }
        }
        api_integration_iggy_event::Entity::delete_by_id(event.id)
            .exec(&env.dbx)
            .await
            .c(h!())?;
    }
    Ok(())
}

async fn pending_event_action(
    env: &Env,
    api_user_login_id: &uuid::Uuid,
    event: &api_integration_iggy_event::Model,
    message: Option<&IggyInboxMessage>,
    visible_networks: &mut HashMap<i64, bool>,
    visible_groups: &mut Option<BTreeSet<String>>,
) -> Result<PendingEventAction, AppError> {
    if event.sigint_inbox_item_id.is_some() {
        if event.payload["event_type"] == "sigint_inbox_item_visibility_changed"
        {
            return Ok(if message.is_some() {
                PendingEventAction::Publish
            } else {
                PendingEventAction::Revoke
            });
        }
        if message.is_some()
            || event.payload["event_type"] == "sigint_inbox_item_deleted"
        {
            return Ok(PendingEventAction::Publish);
        }
        if event.payload["event_type"] == "sigint_inbox_item_updated" {
            if let Some(previous_group) =
                event.payload["previous_group_master_key"].as_str()
            {
                if visible_groups.is_none() {
                    *visible_groups = Some(
                        crate::messenger::group::get_identity_sigint_groups(
                            &env.dbx,
                            api_user_login_id,
                        )
                        .await
                        .c(h!())?
                        .into_iter()
                        .collect(),
                    );
                }
                if visible_groups
                    .as_ref()
                    .is_some_and(|groups| groups.contains(previous_group))
                {
                    return Ok(PendingEventAction::Revoke);
                }
            }
        }
        return Ok(PendingEventAction::Skip);
    }
    let network_id = event.payload["sigint_network_id"].as_i64().c(h!())?;
    if let Some(visible) = visible_networks.get(&network_id) {
        return Ok(if *visible {
            PendingEventAction::Publish
        } else {
            PendingEventAction::Skip
        });
    }
    let visible =
        has_visible_linked_inbox_item(env, api_user_login_id, network_id)
            .await
            .c(h!())?;
    visible_networks.insert(network_id, visible);
    Ok(if visible {
        PendingEventAction::Publish
    } else {
        PendingEventAction::Skip
    })
}

async fn has_visible_linked_inbox_item(
    env: &Env,
    login: &uuid::Uuid,
    network_id: i64,
) -> Result<bool, AppError> {
    let mut last_item_id = 0;
    loop {
        let item_ids = sigint_inbox_item_network::Entity::find()
            .select_only()
            .column(sigint_inbox_item_network::Column::SigintInboxItemId)
            .filter(
                sigint_inbox_item_network::Column::SigintNetworkId
                    .eq(network_id),
            )
            .filter(
                sigint_inbox_item_network::Column::SigintInboxItemId
                    .gt(last_item_id),
            )
            .order_by_asc(sigint_inbox_item_network::Column::SigintInboxItemId)
            .limit(crate::config::API_INTEGRATION_IGGY_VISIBILITY_ID_BATCH_SIZE)
            .into_tuple::<i64>()
            .all(&env.dbx)
            .await
            .c(h!())?;
        let Some(last) = item_ids.last() else {
            return Ok(false);
        };
        last_item_id = *last;
        if crate::rer_importer::inbox::query::any_accessible_inbox_candidate_id(
            env, login, &item_ids,
        )
        .await
        .c(h!())?
        {
            return Ok(true);
        }
    }
}

async fn load_pending_events(
    dbx: &DatabaseConnection,
    api_integration_id: i64,
) -> Result<Vec<api_integration_iggy_event::Model>, AppError> {
    api_integration_iggy_event::Entity::find()
        .filter(
            api_integration_iggy_event::Column::ApiIntegrationId
                .eq(api_integration_id),
        )
        .order_by_asc(api_integration_iggy_event::Column::Id)
        .limit(crate::config::API_INTEGRATION_IGGY_EVENT_BATCH_SIZE)
        .all(dbx)
        .await
        .c(h!())
        .map_err(AppError::from)
}

async fn maybe_log_analytics_entries(
    dbx: &DatabaseConnection,
    client: &iggy::prelude::IggyClient,
    api_integration: &api_integration::Model,
) -> Result<(), AppError> {
    let has_pending_events = api_integration_iggy_event::Entity::find()
        .filter(
            api_integration_iggy_event::Column::ApiIntegrationId
                .eq(api_integration.id),
        )
        .one(dbx)
        .await
        .c(h!())?
        .is_some();
    if has_pending_events {
        return Ok(());
    }
    log_analytics_entries(client, api_integration)
        .await
        .context(h!())?;
    Ok(())
}

async fn load_pending_event_messages(
    env: &Env,
    api_user_login_id: &uuid::Uuid,
    events: &[api_integration_iggy_event::Model],
) -> Result<HashMap<i64, IggyInboxMessage>, AppError> {
    let ids = events
        .iter()
        .filter_map(|event| event.sigint_inbox_item_id)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let logins =
        crate::users::get_organism_login_ids_by_id(&env.dbx, api_user_login_id)
            .await
            .c(h!())?;
    let messages = crate::rer_importer::inbox::get_inbox_messages_by_ids(
        api_user_login_id,
        &logins,
        env,
        &ids,
    )
    .await
    .c(h!())?;
    Ok(enrich_inbox_messages(env, messages)
        .await
        .c(h!())?
        .into_iter()
        .collect())
}

fn render_pending_event(
    event: &api_integration_iggy_event::Model,
    message: Option<&IggyInboxMessage>,
    action: PendingEventAction,
) -> Result<Vec<u8>, AppError> {
    if event.payload["event_type"] == "sigint_inbox_item_created"
        || (event.payload["event_type"]
            == "sigint_inbox_item_visibility_changed"
            && action == PendingEventAction::Publish)
    {
        return serde_json::to_vec(&(
            event.sigint_inbox_item_id.c(h!())?,
            message.c(h!())?,
        ))
        .c(h!())
        .map_err(AppError::from);
    }
    let mut payload = event.payload.clone();
    let fields = payload.as_object_mut().c(h!())?;
    fields.remove("previous_group_master_key");
    fields.insert("event_id".into(), serde_json::json!(event.id));
    if let Some(id) = event.sigint_inbox_item_id {
        fields.insert("sigint_inbox_item_id".into(), serde_json::json!(id));
    }
    if action == PendingEventAction::Revoke {
        fields.insert(
            "event_type".into(),
            serde_json::json!("sigint_inbox_item_deleted"),
        );
    } else if fields.get("event_type").and_then(|value| value.as_str())
        == Some("sigint_inbox_item_updated")
    {
        fields.insert(
            "message".into(),
            serde_json::to_value(message.c(h!())?).c(h!())?,
        );
    } else if fields.get("event_type").and_then(|value| value.as_str())
        == Some("sigint_inbox_item_aors_changed")
    {
        fields.insert(
            "aor_ids".into(),
            serde_json::to_value(&message.c(h!())?.aor_ids).c(h!())?,
        );
    }
    serde_json::to_vec(&payload).c(h!()).map_err(AppError::from)
}

async fn load_inbox_messages(
    env: &Env,
    api_user_login_id: &uuid::Uuid,
    created_after: NaiveDateTime,
    created_till: NaiveDateTime,
) -> Result<Vec<(i64, crate::rer_importer::types::InboxMessage)>, AppError> {
    let req = InboxMessagesReq {
        nolimit: Some(true),
        newest_first: Some(false),
        ..Default::default()
    };
    let logins =
        crate::users::get_organism_login_ids_by_id(&env.dbx, api_user_login_id)
            .await
            .c(h!())?;
    Ok(
        crate::rer_importer::inbox::get_inbox_messages_created_between(
            api_user_login_id,
            &logins,
            env,
            &req,
            created_after,
            created_till,
        )
        .await
        .context(h!())?,
    )
}

async fn enrich_inbox_messages(
    env: &Env,
    inbox_messages: Vec<(i64, InboxMessage)>,
) -> Result<Vec<(i64, IggyInboxMessage)>, AppError> {
    let callsign_ids = load_callsign_ids(env, &inbox_messages).await.c(h!())?;
    let inbox_item_ids =
        inbox_messages.iter().map(|(id, _)| *id).collect::<Vec<_>>();
    let mut aor_ids = load_effective_aor_ids(&env.dbx, &inbox_item_ids)
        .await
        .c(h!())?;
    let mut network_freq_ids = load_network_freq_ids(&env.dbx, &inbox_item_ids)
        .await
        .c(h!())?;
    let activity_datetimes = load_activity_datetimes(&env.dbx, &inbox_item_ids)
        .await
        .c(h!())?;

    inbox_messages
        .into_iter()
        .map(|(id, inbox_message)| -> Result<_, AppError> {
            let network_freq_ids =
                network_freq_ids.remove(&id).unwrap_or_default();
            let aor_ids = aor_ids.remove(&id).unwrap_or_default();
            Ok((
                id,
                enrich_inbox_message(
                    inbox_message,
                    &callsign_ids,
                    aor_ids,
                    network_freq_ids,
                    *activity_datetimes.get(&id).c(h!())?,
                ),
            ))
        })
        .collect()
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
        .cloned()
        .collect::<Vec<_>>();
    Ok(load_callsign_ids_for_texts(env, callsigns)
        .await
        .context(h!())?)
}

async fn load_callsign_ids_for_texts(
    env: &Env,
    callsigns: Vec<String>,
) -> Result<HashMap<String, BTreeSet<i64>>, AppError> {
    let callsigns = callsigns
        .into_iter()
        .map(|callsign| callsign_match_key(&callsign))
        .filter(|callsign| !callsign.is_empty())
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
                callsign_match_key_expr((
                    sigint_callsign::Entity,
                    sigint_callsign::Column::Callsign,
                ))
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
                .entry(callsign_match_key(&callsign.callsign))
                .or_default()
                .insert(callsign.id);
        }
    }
    Ok(callsign_ids)
}

fn enrich_inbox_message(
    inbox_message: InboxMessage,
    callsign_ids: &HashMap<String, BTreeSet<i64>>,
    aor_ids: Vec<i64>,
    sigint_network_freq_ids: Vec<i64>,
    activity_at_ms: i64,
) -> IggyInboxMessage {
    let sigint_callsign_ids = inbox_message
        .callsigns
        .iter()
        .chain(&inbox_message.callsigns_alg2)
        .filter_map(|callsign| callsign_ids.get(&callsign_match_key(callsign)))
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
        activity_at_ms,
        aor_ids,
        sigint_callsign_ids,
        sigint_unit_ids,
        sigint_signal_ids,
        sigint_network_freq_ids,
    }
}

async fn load_activity_datetimes(
    dbx: &DatabaseConnection,
    inbox_item_ids: &[i64],
) -> Result<HashMap<i64, i64>, AppError> {
    let mut activity_datetimes = HashMap::new();
    for inbox_item_ids in inbox_item_ids
        .chunks(crate::config::API_INTEGRATION_IGGY_ENRICHMENT_ID_BATCH_SIZE)
    {
        let query = Query::select()
            .column((SigintInboxItem::Table, SigintInboxItem::Id))
            .expr_as(
                Expr::cust("COALESCE(sigint_inbox_item.datetime, signal_message.timestamp, signal_message.created_at)"),
                Alias::new("activity_at"),
            )
            .from(SigintInboxItem::Table)
            .join(
                JoinType::InnerJoin,
                SignalMessage::Table,
                Expr::col((SigintInboxItem::Table, SigintInboxItem::Id))
                    .equals((SignalMessage::Table, SignalMessage::Id)),
            )
            .and_where(
                Expr::col((SigintInboxItem::Table, SigintInboxItem::Id))
                    .is_in(inbox_item_ids.iter().copied()),
            )
            .to_string(PostgresQueryBuilder);
        let rows = dbx
            .query_all_raw(Statement::from_string(
                DatabaseBackend::Postgres,
                query,
            ))
            .await
            .c(h!())?;
        for row in rows {
            let id = row.try_get("", "id").c(h!())?;
            let activity_at: NaiveDateTime =
                row.try_get("", "activity_at").c(h!())?;
            activity_datetimes
                .insert(id, activity_at.and_utc().timestamp_millis());
        }
    }
    Ok(activity_datetimes)
}

async fn load_effective_aor_ids(
    dbx: &DatabaseConnection,
    inbox_item_ids: &[i64],
) -> Result<HashMap<i64, Vec<i64>>, AppError> {
    let mut aor_ids_by_inbox_item = HashMap::<i64, BTreeSet<i64>>::new();
    for inbox_item_ids in inbox_item_ids
        .chunks(crate::config::API_INTEGRATION_IGGY_ENRICHMENT_ID_BATCH_SIZE)
    {
        let rows = dbx
            .query_all_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                r#"
select inbox_network.sigint_inbox_item_id, network_aor.aor_id
from sigint_inbox_item_network inbox_network
left join sigint_network_aor network_aor
    on network_aor.network_id = inbox_network.sigint_network_id
where inbox_network.sigint_inbox_item_id = any($1)
order by inbox_network.sigint_inbox_item_id, network_aor.aor_id
                "#,
                [inbox_item_ids.to_vec().into()],
            ))
            .await
            .c(h!())?;
        let mut network_linked_item_ids = BTreeSet::new();
        for row in rows {
            let inbox_item_id =
                row.try_get("", "sigint_inbox_item_id").c(h!())?;
            let aor_id: Option<i64> = row.try_get("", "aor_id").c(h!())?;
            network_linked_item_ids.insert(inbox_item_id);
            if let Some(aor_id) = aor_id {
                aor_ids_by_inbox_item
                    .entry(inbox_item_id)
                    .or_default()
                    .insert(aor_id);
            }
        }

        let group_scoped_item_ids = inbox_item_ids
            .iter()
            .filter(|id| !network_linked_item_ids.contains(id))
            .copied()
            .collect::<Vec<_>>();
        if group_scoped_item_ids.is_empty() {
            continue;
        }
        let rows = dbx
            .query_all_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                r#"
select message_groups.item_id, group_aor.aor_id
from (
    select message_group.signal_message_id as item_id,
        coalesce(message_group.group_master_key, datasource_group.group_master_key)
            as group_master_key
    from signal_message_group message_group
    left join datasource_group
        on datasource_group.id = message_group.datasource_group_id
    where message_group.signal_message_id = any($1)

    union

    select message.id as item_id, datasource_group.group_master_key
    from signal_message message
    join datasource_group on datasource_group.id = message.datasource_group_id
    where message.id = any($1)
        and not exists (
            select 1 from signal_message_group message_group
            where message_group.signal_message_id = message.id
        )
) message_groups
join signal_group_aor group_aor
    on group_aor.master_key = message_groups.group_master_key
order by message_groups.item_id, group_aor.aor_id
                "#,
                [group_scoped_item_ids.into()],
            ))
            .await
            .c(h!())?;
        for row in rows {
            let inbox_item_id = row.try_get("", "item_id").c(h!())?;
            let aor_id = row.try_get("", "aor_id").c(h!())?;
            aor_ids_by_inbox_item
                .entry(inbox_item_id)
                .or_default()
                .insert(aor_id);
        }
    }
    Ok(aor_ids_by_inbox_item
        .into_iter()
        .map(|(id, aor_ids)| (id, aor_ids.into_iter().collect()))
        .collect())
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
        build_open_ended_network_freq_join_condition(None, true).c(h!())?;
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
) -> Result<(), AppError> {
    api_integration::ActiveModel {
        id: Set(id),
        is_working: Set(is_working),
        ..Default::default()
    }
    .update(dbx)
    .await
    .c(h!())?;
    Ok(())
}

async fn set_sync_completed(
    dbx: &DatabaseConnection,
    id: i64,
    started_at: NaiveDateTime,
) -> Result<(), AppError> {
    api_integration::ActiveModel {
        id: Set(id),
        last_sync_at: Set(Some(started_at)),
        is_working: Set(true),
        ..Default::default()
    }
    .update(dbx)
    .await
    .c(h!())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::{
        area_of_responsibility, datasource, datasource_group, device_name,
        echo_gpu_transcription_queue, intel_product, login, media_summary,
        ocr_job, organism, organism_aor, organism_group,
        sea_orm_active_enums::{
            SigintInboxItemCallsignSource, SigintInboxItemUnitKind,
        },
        secret_group_user, settlement, sigint_bookmark, sigint_callsign,
        sigint_comment, sigint_important, sigint_inbox_item,
        sigint_inbox_item_callsign, sigint_inbox_item_network,
        sigint_inbox_item_settlement, sigint_inbox_item_unit, sigint_network,
        sigint_network_aor, sigint_network_callsign, sigint_network_freq,
        sigint_signal, sigint_zone_datasource, signal_group, signal_group_aor,
        signal_message, signal_message_group, signal_message_media,
        signal_message_media_conversion_job, system_settings,
    };
    use crate::functest::tests::*;
    use crate::rer_importer::signals::CNSignal;
    use crate::rer_importer::types::InboxInsertPayload;
    use chrono::Duration as ChronoDuration;
    use serial_test::serial;

    async fn insert_integration(
        env: &Env,
        login_id: uuid::Uuid,
    ) -> api_integration::Model {
        api_integration::ActiveModel {
            api_user_login_id: Set(login_id),
            has_iggy_connection: Set(true),
            iggy_url: Set(Some("tcp://localhost:8090".to_string())),
            iggy_login: Set(Some("test".to_string())),
            iggy_password: Set(Some("test".to_string())),
            iggy_inbox_topic: Set(Some("test-inbox".to_string())),
            iggy_analytics_topic: Set(Some("test-analytics".to_string())),
            sync_enabled: Set(true),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap()
    }

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
            callsign: Set("Iggy\u{2011}Test Callsign".to_string()),
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
                ..Default::default()
            },
        )
        .await
        .unwrap();
        signal_message.id
    }

    async fn insert_grouped_inbox_item(
        env: &Env,
        group: &datasource_group::Model,
    ) -> (i64, signal_message_group::Model) {
        let message = mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                datasource_group_id: Set(Some(group.id)),
                created_at: Set(Utc::now().naive_utc()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_inbox_item(
            &env.dbx,
            sigint_inbox_item::ActiveModel {
                id: Set(message.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let message_group = mk_signal_message_group(
            &env.dbx,
            signal_message_group::ActiveModel {
                signal_message_id: Set(message.id),
                group_master_key: Set(Some(group.group_master_key.clone())),
                datasource_group_id: Set(Some(group.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        (message.id, message_group)
    }

    async fn assert_group_loss_action(
        env: &Env,
        integration: &api_integration::Model,
        item_id: i64,
        group_master_key: &str,
        expected: PendingEventAction,
    ) {
        let events =
            load_pending_events(&env.dbx, integration.id).await.unwrap();
        let event = events
            .iter()
            .rev()
            .find(|event| {
                event.sigint_inbox_item_id == Some(item_id)
                    && event.payload["previous_group_master_key"]
                        == group_master_key
            })
            .unwrap();
        let messages = load_pending_event_messages(
            env,
            &integration.api_user_login_id,
            &events,
        )
        .await
        .unwrap();
        assert!(!messages.contains_key(&item_id));
        let action = pending_event_action(
            env,
            &integration.api_user_login_id,
            event,
            None,
            &mut HashMap::new(),
            &mut None,
        )
        .await
        .unwrap();
        assert_eq!(action, expected);
        if action == PendingEventAction::Revoke {
            let payload: serde_json::Value = serde_json::from_slice(
                &render_pending_event(event, None, action).unwrap(),
            )
            .unwrap();
            assert_eq!(payload["event_type"], "sigint_inbox_item_deleted");
            assert_eq!(payload["sigint_inbox_item_id"], item_id);
            assert_eq!(payload["event_id"], event.id);
            assert!(payload.get("message").is_none());
            assert!(payload.get("previous_group_master_key").is_none());
        }
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

    async fn insert_open_ended_network_frequency(
        env: &Env,
        network_id: i64,
        intercepted_at: NaiveDateTime,
    ) -> i64 {
        mk_sigint_network_freq(
            &env.dbx,
            sigint_network_freq::ActiveModel {
                network_id: Set(network_id),
                freq: Set("123.45".to_string()),
                active_from: Set(intercepted_at - ChronoDuration::hours(1)),
                active_to: Set(None),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .id
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

    struct InboxAorFixture {
        item_id: i64,
        group_master_keys: [String; 2],
        group_aor_ids: [i64; 3],
        second_datasource_group: datasource_group::Model,
        second_message_group: signal_message_group::Model,
    }

    async fn insert_inbox_aor_fixture(env: &Env) -> InboxAorFixture {
        let first_group =
            mk_signal_group(&env.dbx, Default::default()).await.unwrap();
        let second_group =
            mk_signal_group(&env.dbx, Default::default()).await.unwrap();
        let first_aor = mk_aor(&env.dbx, Default::default()).await.unwrap();
        let second_aor = mk_aor(&env.dbx, Default::default()).await.unwrap();
        let third_aor = mk_aor(&env.dbx, Default::default()).await.unwrap();
        for (group_master_key, aor_id) in [
            (first_group.master_key.clone(), first_aor.id),
            (first_group.master_key.clone(), second_aor.id),
            (second_group.master_key.clone(), second_aor.id),
            (second_group.master_key.clone(), third_aor.id),
        ] {
            mk_signal_group_aor(
                &env.dbx,
                signal_group_aor::ActiveModel {
                    master_key: Set(group_master_key),
                    aor_id: Set(aor_id),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        }
        let item_id = insert_inbox_item(env, Utc::now().naive_utc()).await;
        mk_signal_message_group(
            &env.dbx,
            signal_message_group::ActiveModel {
                signal_message_id: Set(item_id),
                group_master_key: Set(Some(first_group.master_key.clone())),
                datasource_group_id: Set(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let second_datasource_group = mk_datasource_group(
            &env.dbx,
            datasource_group::ActiveModel {
                group_master_key: Set(second_group.master_key.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let second_message_group = mk_signal_message_group(
            &env.dbx,
            signal_message_group::ActiveModel {
                signal_message_id: Set(item_id),
                group_master_key: Set(None),
                datasource_group_id: Set(Some(second_datasource_group.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        InboxAorFixture {
            item_id,
            group_master_keys: [
                first_group.master_key,
                second_group.master_key,
            ],
            group_aor_ids: [first_aor.id, second_aor.id, third_aor.id],
            second_datasource_group,
            second_message_group,
        }
    }

    async fn enriched_aor_ids(env: &Env, item_id: i64) -> Vec<i64> {
        let inbox_message: InboxMessage = InboxInsertPayload {
            text: "AOR test".to_string(),
            ..Default::default()
        }
        .into();
        enrich_inbox_messages(env, vec![(item_id, inbox_message)])
            .await
            .unwrap()
            .remove(0)
            .1
            .aor_ids
    }

    async fn assert_queued_aor_event(
        env: &Env,
        integration: &api_integration::Model,
        item_id: i64,
        expected_aor_ids: &[i64],
    ) {
        let events =
            load_pending_events(&env.dbx, integration.id).await.unwrap();
        let event = events
            .iter()
            .rev()
            .find(|event| {
                event.sigint_inbox_item_id == Some(item_id)
                    && event.payload["event_type"]
                        == "sigint_inbox_item_aors_changed"
            })
            .unwrap();
        let inbox_message: InboxMessage = InboxInsertPayload {
            text: "AOR event test".to_string(),
            ..Default::default()
        }
        .into();
        let message =
            enrich_inbox_messages(env, vec![(item_id, inbox_message)])
                .await
                .unwrap()
                .remove(0)
                .1;
        let payload: serde_json::Value = serde_json::from_slice(
            &render_pending_event(
                event,
                Some(&message),
                PendingEventAction::Publish,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(payload["event_type"], "sigint_inbox_item_aors_changed");
        assert_eq!(payload["sigint_inbox_item_id"], item_id);
        assert_eq!(payload["aor_ids"], serde_json::json!(expected_aor_ids));
    }

    async fn queued_event_types(
        env: &Env,
        integration: &api_integration::Model,
        item_id: i64,
    ) -> Vec<String> {
        load_pending_events(&env.dbx, integration.id)
            .await
            .unwrap()
            .into_iter()
            .filter(|event| event.sigint_inbox_item_id == Some(item_id))
            .map(|event| {
                event.payload["event_type"].as_str().unwrap().to_string()
            })
            .collect()
    }

    #[actix_web::test]
    #[serial]
    async fn inbox_event_contains_dictionary_ids_and_stays_compatible() {
        let env = cleanup().await.unwrap();
        let intercepted_at = Utc::now().naive_utc() + ChronoDuration::hours(1);
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
        let open_ended_network_freq_id = insert_open_ended_network_frequency(
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
            event[1]["activity_at_ms"],
            serde_json::json!(intercepted_at.and_utc().timestamp_millis())
        );
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
            serde_json::json!([
                network.network_freq_id,
                open_ended_network_freq_id
            ])
        );
        assert_eq!(event[1]["aor_ids"], serde_json::json!([]));
        let old_message: InboxMessage =
            serde_json::from_value(event[1].clone()).unwrap();
        assert_eq!(old_message.text, "interception");
    }

    #[actix_web::test]
    #[serial]
    async fn inbox_aor_enrichment_prefers_all_networks_over_all_groups() {
        let env = cleanup().await.unwrap();
        let fixture = insert_inbox_aor_fixture(&env).await;
        assert_eq!(
            enriched_aor_ids(&env, fixture.item_id).await,
            fixture.group_aor_ids
        );

        let first_network = mk_sigint_network(&env.dbx, Default::default())
            .await
            .unwrap();
        mk_sigint_inbox_item_network(
            &env.dbx,
            sigint_inbox_item_network::ActiveModel {
                sigint_inbox_item_id: Set(fixture.item_id),
                sigint_network_id: Set(first_network.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert!(enriched_aor_ids(&env, fixture.item_id).await.is_empty());

        mk_sigint_network_aor(
            &env.dbx,
            sigint_network_aor::ActiveModel {
                network_id: Set(first_network.id),
                aor_id: Set(fixture.group_aor_ids[2]),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let second_network = mk_sigint_network(&env.dbx, Default::default())
            .await
            .unwrap();
        mk_sigint_inbox_item_network(
            &env.dbx,
            sigint_inbox_item_network::ActiveModel {
                sigint_inbox_item_id: Set(fixture.item_id),
                sigint_network_id: Set(second_network.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_network_aor(
            &env.dbx,
            sigint_network_aor::ActiveModel {
                network_id: Set(second_network.id),
                aor_id: Set(fixture.group_aor_ids[0]),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(
            enriched_aor_ids(&env, fixture.item_id).await,
            vec![fixture.group_aor_ids[0], fixture.group_aor_ids[2]]
        );
    }

    #[actix_web::test]
    #[serial]
    async fn effective_aor_change_sources_queue_snapshot_events() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let integration = insert_integration(&env, login.id).await;
        let fixture = insert_inbox_aor_fixture(&env).await;
        clear_iggy_events(&env, integration.id).await;

        let mut second_datasource_group =
            fixture.second_datasource_group.clone().into_active_model();
        second_datasource_group.group_master_key =
            Set(fixture.group_master_keys[0].clone());
        let second_datasource_group =
            second_datasource_group.update(&env.dbx).await.unwrap();
        assert_queued_aor_event(
            &env,
            &integration,
            fixture.item_id,
            &fixture.group_aor_ids[..2],
        )
        .await;
        clear_iggy_events(&env, integration.id).await;

        let mut second_datasource_group =
            second_datasource_group.into_active_model();
        second_datasource_group.group_master_key =
            Set(fixture.group_master_keys[1].clone());
        second_datasource_group.update(&env.dbx).await.unwrap();
        clear_iggy_events(&env, integration.id).await;

        signal_message_group::Entity::delete_by_id(
            fixture.second_message_group.id,
        )
        .exec(&env.dbx)
        .await
        .unwrap();
        assert_eq!(
            queued_event_types(&env, &integration, fixture.item_id).await,
            [
                "sigint_inbox_item_updated",
                "sigint_inbox_item_aors_changed"
            ]
        );
        assert_queued_aor_event(
            &env,
            &integration,
            fixture.item_id,
            &fixture.group_aor_ids[..2],
        )
        .await;
        clear_iggy_events(&env, integration.id).await;

        let fourth_aor = mk_aor(&env.dbx, Default::default()).await.unwrap();
        mk_signal_group_aor(
            &env.dbx,
            signal_group_aor::ActiveModel {
                master_key: Set(fixture.group_master_keys[0].clone()),
                aor_id: Set(fourth_aor.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(
            queued_event_types(&env, &integration, fixture.item_id).await,
            [
                "sigint_inbox_item_visibility_changed",
                "sigint_inbox_item_aors_changed"
            ]
        );
        let mut expected_group_aor_ids = fixture.group_aor_ids[..2].to_vec();
        expected_group_aor_ids.push(fourth_aor.id);
        expected_group_aor_ids.sort_unstable();
        assert_queued_aor_event(
            &env,
            &integration,
            fixture.item_id,
            &expected_group_aor_ids,
        )
        .await;
        clear_iggy_events(&env, integration.id).await;

        let network = mk_sigint_network(&env.dbx, Default::default())
            .await
            .unwrap();
        let network_link = mk_sigint_inbox_item_network(
            &env.dbx,
            sigint_inbox_item_network::ActiveModel {
                sigint_inbox_item_id: Set(fixture.item_id),
                sigint_network_id: Set(network.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(
            queued_event_types(&env, &integration, fixture.item_id).await,
            [
                "sigint_inbox_item_network_linked",
                "sigint_inbox_item_aors_changed"
            ]
        );
        assert_queued_aor_event(&env, &integration, fixture.item_id, &[]).await;
        clear_iggy_events(&env, integration.id).await;

        mk_sigint_network_aor(
            &env.dbx,
            sigint_network_aor::ActiveModel {
                network_id: Set(network.id),
                aor_id: Set(fixture.group_aor_ids[2]),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_queued_aor_event(
            &env,
            &integration,
            fixture.item_id,
            &[fixture.group_aor_ids[2]],
        )
        .await;
        clear_iggy_events(&env, integration.id).await;

        sigint_inbox_item_network::Entity::delete_by_id(network_link.id)
            .exec(&env.dbx)
            .await
            .unwrap();
        assert_eq!(
            queued_event_types(&env, &integration, fixture.item_id).await,
            [
                "sigint_inbox_item_network_unlinked",
                "sigint_inbox_item_aors_changed"
            ]
        );
        assert_queued_aor_event(
            &env,
            &integration,
            fixture.item_id,
            &expected_group_aor_ids,
        )
        .await;
    }

    #[actix_web::test]
    #[serial]
    async fn api_user_change_requires_a_new_destination() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let integration = insert_integration(&env, login.id).await;
        let new_login = mk_login(&env.dbx, Default::default()).await.unwrap();

        let result = api_integration::ActiveModel {
            id: Set(integration.id),
            api_user_login_id: Set(new_login.id),
            ..Default::default()
        }
        .update(&env.dbx)
        .await;

        assert!(result.is_err());
        let integration = api_integration::Entity::find_by_id(integration.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(integration.api_user_login_id, login.id);
    }

    #[actix_web::test]
    #[serial]
    async fn creation_waits_for_concurrent_enablement() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let integration = insert_integration(&env, login.id).await;
        api_integration::ActiveModel {
            id: Set(integration.id),
            sync_enabled: Set(false),
            ..Default::default()
        }
        .update(&env.dbx)
        .await
        .unwrap();
        let message = mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                created_at: Set(Utc::now().naive_utc()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let message_id = message.id;
        let transaction = env.dbx.begin().await.unwrap();
        api_integration::ActiveModel {
            id: Set(integration.id),
            sync_enabled: Set(true),
            ..Default::default()
        }
        .update(&transaction)
        .await
        .unwrap();
        let dbx = env.dbx.clone();
        let mut insert = tokio::spawn(async move {
            mk_sigint_inbox_item(
                &dbx,
                sigint_inbox_item::ActiveModel {
                    id: Set(message_id),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        });
        assert!(timeout(Duration::from_millis(100), &mut insert)
            .await
            .is_err());
        transaction.commit().await.unwrap();
        timeout(Duration::from_secs(5), insert)
            .await
            .unwrap()
            .unwrap();

        let events =
            load_pending_events(&env.dbx, integration.id).await.unwrap();
        assert!(events.iter().any(|event| {
            event.sigint_inbox_item_id == Some(message_id)
                && event.payload["event_type"] == "sigint_inbox_item_created"
        }));
    }

    #[actix_web::test]
    #[serial]
    async fn destination_change_keeps_queued_events_on_original_route() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let integration = insert_integration(&env, login.id).await;
        let other = insert_integration(&env, login.id).await;
        let item_id = insert_inbox_item(&env, Utc::now().naive_utc()).await;
        clear_iggy_events(&env, integration.id).await;
        clear_iggy_events(&env, other.id).await;
        sigint_inbox_item::ActiveModel {
            id: Set(item_id),
            location: Set(Some("first edit".to_string())),
            ..Default::default()
        }
        .update(&env.dbx)
        .await
        .unwrap();
        let old_event = load_pending_events(&env.dbx, integration.id)
            .await
            .unwrap()
            .remove(0);
        let old_destination =
            api_integration_iggy_destination::Entity::find_by_id(
                old_event.destination_id,
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(old_destination.iggy_url, integration.iggy_url);
        assert_eq!(
            old_destination.iggy_inbox_topic,
            integration.iggy_inbox_topic
        );

        let new_login = mk_login(&env.dbx, Default::default()).await.unwrap();
        api_integration::ActiveModel {
            id: Set(integration.id),
            api_user_login_id: Set(new_login.id),
            iggy_url: Set(Some("tcp://localhost:8091".to_string())),
            iggy_login: Set(Some("new login".to_string())),
            iggy_password: Set(Some("new password".to_string())),
            iggy_inbox_topic: Set(Some("new-inbox".to_string())),
            ..Default::default()
        }
        .update(&env.dbx)
        .await
        .unwrap();
        assert_eq!(
            load_pending_events(&env.dbx, integration.id).await.unwrap()[0]
                .destination_id,
            old_destination.id
        );

        sigint_inbox_item::ActiveModel {
            id: Set(item_id),
            location: Set(Some("second edit".to_string())),
            ..Default::default()
        }
        .update(&env.dbx)
        .await
        .unwrap();
        let events =
            load_pending_events(&env.dbx, integration.id).await.unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].destination_id, old_destination.id);
        assert_ne!(events[1].destination_id, old_destination.id);
        let new_destination =
            api_integration_iggy_destination::Entity::find_by_id(
                events[1].destination_id,
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            new_destination.iggy_url.as_deref(),
            Some("tcp://localhost:8091")
        );
        assert_eq!(new_destination.iggy_login.as_deref(), Some("new login"));
        assert_eq!(
            new_destination.iggy_password.as_deref(),
            Some("new password")
        );
        assert_eq!(
            new_destination.iggy_inbox_topic.as_deref(),
            Some("new-inbox")
        );
        assert_eq!(new_destination.api_user_login_id, new_login.id);
        assert_eq!(old_destination.iggy_password, integration.iggy_password);
        assert_eq!(old_destination.api_user_login_id, login.id);
        assert_eq!(
            load_pending_events(&env.dbx, other.id).await.unwrap().len(),
            2
        );

        api_integration_iggy_event::Entity::delete_by_id(old_event.id)
            .exec(&env.dbx)
            .await
            .unwrap();
        api_integration::ActiveModel {
            id: Set(integration.id),
            last_sync_at: Set(Some(new_destination.active_from)),
            ..Default::default()
        }
        .update(&env.dbx)
        .await
        .unwrap();
        scrub_old_destination_credentials(&env.dbx, integration.id)
            .await
            .unwrap();
        let old_destination =
            api_integration_iggy_destination::Entity::find_by_id(
                old_destination.id,
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(old_destination.iggy_login, None);
        assert_eq!(old_destination.iggy_password, None);

        let less_privileged_login =
            mk_login(&env.dbx, Default::default()).await.unwrap();
        let route_reuse = api_integration::ActiveModel {
            id: Set(integration.id),
            api_user_login_id: Set(less_privileged_login.id),
            iggy_url: Set(old_destination.iggy_url),
            iggy_inbox_topic: Set(old_destination.iggy_inbox_topic),
            ..Default::default()
        }
        .update(&env.dbx)
        .await;
        assert!(route_reuse.is_err());
    }

    #[actix_web::test]
    #[serial]
    async fn destination_change_keeps_unsent_creations_on_original_route() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let group = find_test_datasource_group(&env.dbx).await.unwrap();
        let integration = insert_integration(&env, login.id).await;
        let last_sync_at = Utc::now().naive_utc() - ChronoDuration::seconds(1);
        api_integration::ActiveModel {
            id: Set(integration.id),
            last_sync_at: Set(Some(last_sync_at)),
            ..Default::default()
        }
        .update(&env.dbx)
        .await
        .unwrap();
        let (old_item_id, _) = insert_grouped_inbox_item(&env, &group).await;
        api_integration::ActiveModel {
            id: Set(integration.id),
            iggy_url: Set(Some("tcp://localhost:8091".to_string())),
            ..Default::default()
        }
        .update(&env.dbx)
        .await
        .unwrap();
        let (new_item_id, _) = insert_grouped_inbox_item(&env, &group).await;
        let destinations =
            load_destinations(&env.dbx, integration.id).await.unwrap();
        assert_eq!(destinations.len(), 2);
        let old_messages = load_inbox_messages(
            &env,
            &login.id,
            std::cmp::max(last_sync_at, destinations[0].active_from),
            destinations[1].active_from,
        )
        .await
        .unwrap();
        let new_messages = load_inbox_messages(
            &env,
            &login.id,
            destinations[1].active_from,
            Utc::now().naive_utc() + ChronoDuration::seconds(1),
        )
        .await
        .unwrap();
        assert!(old_messages.iter().any(|(id, _)| *id == old_item_id));
        assert!(!old_messages.iter().any(|(id, _)| *id == new_item_id));
        assert!(new_messages.iter().any(|(id, _)| *id == new_item_id));
        assert!(!new_messages.iter().any(|(id, _)| *id == old_item_id));

        let creation_events =
            load_pending_events(&env.dbx, integration.id).await.unwrap();
        let old_creation = creation_events
            .iter()
            .find(|event| {
                event.sigint_inbox_item_id == Some(old_item_id)
                    && event.payload["event_type"]
                        == "sigint_inbox_item_created"
            })
            .unwrap();
        let new_creation = creation_events
            .iter()
            .find(|event| {
                event.sigint_inbox_item_id == Some(new_item_id)
                    && event.payload["event_type"]
                        == "sigint_inbox_item_created"
            })
            .unwrap();
        assert_eq!(old_creation.destination_id, destinations[0].id);
        assert_eq!(new_creation.destination_id, destinations[1].id);

        api_integration_iggy_event::Entity::delete_many()
            .filter(
                api_integration_iggy_event::Column::ApiIntegrationId
                    .eq(integration.id),
            )
            .exec(&env.dbx)
            .await
            .unwrap();
        scrub_old_destination_credentials(&env.dbx, integration.id)
            .await
            .unwrap();
        let old_destination =
            api_integration_iggy_destination::Entity::find_by_id(
                destinations[0].id,
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert!(old_destination.iggy_password.is_some());
        api_integration::ActiveModel {
            id: Set(integration.id),
            last_sync_at: Set(Some(destinations[1].active_from)),
            ..Default::default()
        }
        .update(&env.dbx)
        .await
        .unwrap();
        scrub_old_destination_credentials(&env.dbx, integration.id)
            .await
            .unwrap();
        let old_destination =
            api_integration_iggy_destination::Entity::find_by_id(
                destinations[0].id,
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(old_destination.iggy_login, None);
        assert_eq!(old_destination.iggy_password, None);
    }

    #[actix_web::test]
    #[serial]
    async fn unit_visibility_refreshes_linked_units_and_matching_callsigns() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let group = find_test_datasource_group(&env.dbx).await.unwrap();
        let integration = insert_integration(&env, login.id).await;
        let (item_id, _) = insert_grouped_inbox_item(&env, &group).await;
        let unit = mk_sigint_unit(&env.dbx, Default::default()).await.unwrap();
        let callsign_id =
            insert_callsign(&env, unit.id, Utc::now().naive_utc()).await;
        sigint_inbox_item_unit::ActiveModel {
            item_id: Set(item_id),
            unit_id: Set(unit.id),
            kind: Set(SigintInboxItemUnitKind::Parsed),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let (callsign_item_id, _) =
            insert_grouped_inbox_item(&env, &group).await;
        sigint_inbox_item_callsign::ActiveModel {
            sigint_inbox_item_id: Set(callsign_item_id),
            callsign: Set("iggy-test callsign".to_string()),
            source: Set(SigintInboxItemCallsignSource::Primary),
            ordering: Set(0.0),
            deleted: Set(false),
            created_by_id: Set(login.id),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        clear_iggy_events(&env, integration.id).await;

        sigint_unit::ActiveModel {
            id: Set(unit.id),
            deleted: Set(true),
            ..Default::default()
        }
        .update(&env.dbx)
        .await
        .unwrap();
        let events =
            load_pending_events(&env.dbx, integration.id).await.unwrap();
        assert_eq!(events.len(), 2);
        assert!(events
            .iter()
            .all(|event| event.payload["event_type"]
                == "sigint_inbox_item_updated"));
        let messages = load_pending_event_messages(
            &env,
            &integration.api_user_login_id,
            &events,
        )
        .await
        .unwrap();
        assert!(messages[&item_id].sigint_unit_ids.is_empty());
        assert!(messages[&callsign_item_id].sigint_callsign_ids.is_empty());
        clear_iggy_events(&env, integration.id).await;

        sigint_unit::ActiveModel {
            id: Set(unit.id),
            deleted: Set(false),
            ..Default::default()
        }
        .update(&env.dbx)
        .await
        .unwrap();
        let events =
            load_pending_events(&env.dbx, integration.id).await.unwrap();
        assert_eq!(events.len(), 2);
        let messages = load_pending_event_messages(
            &env,
            &integration.api_user_login_id,
            &events,
        )
        .await
        .unwrap();
        assert_eq!(messages[&item_id].sigint_unit_ids, vec![unit.id]);
        assert_eq!(
            messages[&callsign_item_id].sigint_callsign_ids,
            vec![callsign_id]
        );
        clear_iggy_events(&env, integration.id).await;

        sigint_unit::ActiveModel {
            id: Set(unit.id),
            active: Set(false),
            ..Default::default()
        }
        .update(&env.dbx)
        .await
        .unwrap();
        let events =
            load_pending_events(&env.dbx, integration.id).await.unwrap();
        assert_eq!(events.len(), 2);
        let messages = load_pending_event_messages(
            &env,
            &integration.api_user_login_id,
            &events,
        )
        .await
        .unwrap();
        assert!(messages[&callsign_item_id].sigint_callsign_ids.is_empty());
    }

    struct AssociationFixture {
        login: login::Model,
        integration: api_integration::Model,
        item_id: i64,
        unit: sigint_unit::Model,
        callsign_id: i64,
        network: sigint_network::Model,
        first_frequency: sigint_network_freq::Model,
        second_frequency: sigint_network_freq::Model,
        network_callsign: sigint_network_callsign::Model,
        link: sigint_inbox_item_network::Model,
        intercepted_at: NaiveDateTime,
    }

    async fn create_association_fixture(env: &Env) -> AssociationFixture {
        let login = find_test_login(&env.dbx).await.unwrap();
        let integration = insert_integration(env, login.id).await;
        let lock = try_lock_integration(&env.dbx, integration.id)
            .await
            .unwrap()
            .unwrap();
        assert!(try_lock_integration(&env.dbx, integration.id)
            .await
            .unwrap()
            .is_none());
        lock.commit().await.unwrap();
        let intercepted_at = Utc::now().naive_utc();
        let item_id = insert_inbox_item(env, intercepted_at).await;
        let group = find_test_datasource_group(&env.dbx).await.unwrap();
        mk_signal_message_group(
            &env.dbx,
            signal_message_group::ActiveModel {
                signal_message_id: Set(item_id),
                group_master_key: Set(Some(group.group_master_key)),
                datasource_group_id: Set(Some(group.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let unit = mk_sigint_unit(&env.dbx, Default::default()).await.unwrap();
        let callsign_id = insert_callsign(env, unit.id, intercepted_at).await;
        let network = mk_sigint_network(&env.dbx, Default::default())
            .await
            .unwrap();
        let first_frequency = mk_sigint_network_freq(
            &env.dbx,
            sigint_network_freq::ActiveModel {
                network_id: Set(network.id),
                freq: Set("123.45".to_string()),
                active_from: Set(intercepted_at - ChronoDuration::hours(2)),
                active_to: Set(Some(intercepted_at + ChronoDuration::hours(1))),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let second_frequency = mk_sigint_network_freq(
            &env.dbx,
            sigint_network_freq::ActiveModel {
                network_id: Set(network.id),
                freq: Set("123.45".to_string()),
                active_from: Set(intercepted_at - ChronoDuration::hours(1)),
                active_to: Set(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let unrelated_network = mk_sigint_network(&env.dbx, Default::default())
            .await
            .unwrap();
        mk_sigint_network_freq(
            &env.dbx,
            sigint_network_freq::ActiveModel {
                network_id: Set(unrelated_network.id),
                freq: Set("123.45".to_string()),
                active_from: Set(intercepted_at - ChronoDuration::hours(1)),
                active_to: Set(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let network_callsign = sigint_network_callsign::ActiveModel {
            sigint_network_id: Set(network.id),
            sigint_callsign: Set("Iggy-Test Callsign".to_string()),
            sigint_callsign_id: Set(Some(callsign_id)),
            deleted: Set(false),
            created_at: Set(intercepted_at),
            developing: Set(false),
            unit_developing: Set(false),
            main_radio_station: Set(false),
            command_control: Set(false),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let link = mk_sigint_inbox_item_network(
            &env.dbx,
            sigint_inbox_item_network::ActiveModel {
                sigint_inbox_item_id: Set(item_id),
                sigint_network_id: Set(network.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let events =
            load_pending_events(&env.dbx, integration.id).await.unwrap();
        let linked = events
            .iter()
            .find(|event| {
                event.payload["event_type"]
                    == "sigint_inbox_item_network_linked"
            })
            .unwrap();
        assert_eq!(linked.sigint_inbox_item_id, Some(item_id));
        assert_eq!(linked.payload["sigint_network_id"], network.id);
        assert_eq!(
            linked.payload["sigint_network_freq_ids"],
            serde_json::json!([first_frequency.id, second_frequency.id])
        );
        assert_eq!(
            linked.payload["sigint_network_callsign_ids"],
            serde_json::json!([network_callsign.id])
        );
        assert_eq!(
            linked.payload["sigint_callsign_ids"],
            serde_json::json!([callsign_id])
        );
        AssociationFixture {
            login,
            integration,
            item_id,
            unit,
            callsign_id,
            network,
            first_frequency,
            second_frequency,
            network_callsign,
            link,
            intercepted_at,
        }
    }

    async fn assert_frequency_transitions(
        env: &Env,
        fixture: &AssociationFixture,
    ) {
        let integration = &fixture.integration;
        let item_id = fixture.item_id;
        let network = &fixture.network;
        let first_frequency = &fixture.first_frequency;
        let second_frequency = &fixture.second_frequency;
        let intercepted_at = fixture.intercepted_at;
        signal_message::ActiveModel {
            id: Set(item_id),
            timestamp: Set(Some(intercepted_at - ChronoDuration::hours(3))),
            ..Default::default()
        }
        .update(&env.dbx)
        .await
        .unwrap();
        let events =
            load_pending_events(&env.dbx, integration.id).await.unwrap();
        let timestamp_change = events
            .iter()
            .rev()
            .find(|event| {
                event.payload["event_type"]
                    == "sigint_inbox_item_network_frequencies_changed"
            })
            .unwrap();
        assert_eq!(
            timestamp_change.payload["unlinked_sigint_network_freq_ids"],
            serde_json::json!([first_frequency.id, second_frequency.id])
        );
        assert_eq!(
            timestamp_change.payload["linked_sigint_network_freq_ids"],
            serde_json::json!([])
        );
        signal_message::ActiveModel {
            id: Set(item_id),
            timestamp: Set(Some(intercepted_at)),
            ..Default::default()
        }
        .update(&env.dbx)
        .await
        .unwrap();
        let next_frequency = mk_sigint_network_freq(
            &env.dbx,
            sigint_network_freq::ActiveModel {
                network_id: Set(network.id),
                freq: Set("678.90".to_string()),
                active_from: Set(intercepted_at - ChronoDuration::hours(1)),
                active_to: Set(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        sigint_inbox_item::ActiveModel {
            id: Set(item_id),
            freq: Set(Some("678.90".to_string())),
            ..Default::default()
        }
        .update(&env.dbx)
        .await
        .unwrap();
        let events =
            load_pending_events(&env.dbx, integration.id).await.unwrap();
        let frequency_change = events
            .iter()
            .rev()
            .find(|event| {
                event.payload["event_type"]
                    == "sigint_inbox_item_network_frequencies_changed"
            })
            .unwrap();
        assert_eq!(
            frequency_change.payload["unlinked_sigint_network_freq_ids"],
            serde_json::json!([first_frequency.id, second_frequency.id])
        );
        assert_eq!(
            frequency_change.payload["linked_sigint_network_freq_ids"],
            serde_json::json!([next_frequency.id])
        );
        sigint_inbox_item::ActiveModel {
            id: Set(item_id),
            freq: Set(Some("123.45".to_string())),
            ..Default::default()
        }
        .update(&env.dbx)
        .await
        .unwrap();
        let extra_frequency = mk_sigint_network_freq(
            &env.dbx,
            sigint_network_freq::ActiveModel {
                network_id: Set(network.id),
                freq: Set("123.45".to_string()),
                active_from: Set(intercepted_at - ChronoDuration::hours(1)),
                active_to: Set(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        sigint_network_freq::ActiveModel {
            id: Set(extra_frequency.id),
            deleted: Set(true),
            ..Default::default()
        }
        .update(&env.dbx)
        .await
        .unwrap();
    }

    async fn link_inbox_callsign(
        env: &Env,
        fixture: &AssociationFixture,
    ) -> sigint_inbox_item_callsign::Model {
        let login = &fixture.login;
        let integration = &fixture.integration;
        let item_id = fixture.item_id;
        let unit = &fixture.unit;
        let network = &fixture.network;
        let first_frequency = &fixture.first_frequency;
        let second_frequency = &fixture.second_frequency;
        let callsign_id = fixture.callsign_id;
        let intercepted_at = fixture.intercepted_at;
        let item_callsign = sigint_inbox_item_callsign::ActiveModel {
            sigint_inbox_item_id: Set(item_id),
            callsign: Set("Iggy-Test Callsign".to_string()),
            source: Set(SigintInboxItemCallsignSource::Primary),
            ordering: Set(0.0),
            deleted: Set(false),
            created_by_id: Set(login.id),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let events =
            load_pending_events(&env.dbx, integration.id).await.unwrap();
        let callsign_linked = events
            .iter()
            .find(|event| {
                event.payload["event_type"]
                    == "sigint_inbox_item_callsign_linked"
            })
            .unwrap();
        let callsign_ids = load_callsign_ids_for_texts(
            env,
            vec!["Iggy-Test Callsign".to_string()],
        )
        .await
        .unwrap();
        let message = enrich_inbox_message(
            build_inbox_message(unit.id, 0, network.id),
            &callsign_ids,
            vec![],
            vec![first_frequency.id, second_frequency.id],
            intercepted_at.and_utc().timestamp_millis(),
        );
        let payload: serde_json::Value = serde_json::from_slice(
            &render_pending_event(
                callsign_linked,
                Some(&message),
                PendingEventAction::Publish,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            payload["sigint_callsign_ids"],
            serde_json::json!([callsign_id])
        );
        assert_eq!(payload["event_id"], callsign_linked.id);

        item_callsign
    }

    async fn assert_settlement_and_unlinks(
        env: &Env,
        fixture: &AssociationFixture,
        item_callsign: &sigint_inbox_item_callsign::Model,
    ) {
        let integration = &fixture.integration;
        let item_id = fixture.item_id;
        let network_callsign = &fixture.network_callsign;
        let link = &fixture.link;
        let first_frequency = &fixture.first_frequency;
        let second_frequency = &fixture.second_frequency;
        let callsign_id = fixture.callsign_id;
        let settlement_id = settlement::Entity::find()
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap()
            .id;
        sigint_inbox_item_settlement::ActiveModel {
            item_id: Set(item_id),
            settlement_text: Set("test settlement".to_string()),
            settlement_id: Set(Some(settlement_id)),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        crate::battle_line::settlement_queue::requeue_item_settlements(
            &env.dbx, item_id,
        )
        .await
        .unwrap();
        sigint_inbox_item_callsign::ActiveModel {
            id: Set(item_callsign.id),
            deleted: Set(true),
            ..Default::default()
        }
        .update(&env.dbx)
        .await
        .unwrap();
        sigint_network_callsign::ActiveModel {
            id: Set(network_callsign.id),
            sigint_callsign: Set("replacement".to_string()),
            sigint_callsign_id: Set(None),
            ..Default::default()
        }
        .update(&env.dbx)
        .await
        .unwrap();
        sigint_inbox_item_network::Entity::delete_by_id(link.id)
            .exec(&env.dbx)
            .await
            .unwrap();

        let events =
            load_pending_events(&env.dbx, integration.id).await.unwrap();
        for event_type in [
            "sigint_inbox_item_callsign_unlinked",
            "sigint_inbox_item_settlement_linked",
            "sigint_inbox_item_settlement_unlinked",
            "sigint_network_callsign_unlinked",
            "sigint_network_callsign_linked",
            "sigint_network_frequency_linked",
            "sigint_network_frequency_unlinked",
            "sigint_inbox_item_network_unlinked",
        ] {
            assert!(
                events
                    .iter()
                    .any(|event| event.payload["event_type"] == event_type),
                "missing {event_type}"
            );
        }
        let unlinked = events
            .iter()
            .find(|event| {
                event.payload["event_type"]
                    == "sigint_inbox_item_network_unlinked"
            })
            .unwrap();
        assert_eq!(
            unlinked.payload["sigint_network_freq_ids"],
            serde_json::json!([first_frequency.id, second_frequency.id])
        );
        let catalog_event = events
            .iter()
            .find(|event| {
                event.payload["event_type"]
                    == "sigint_network_callsign_unlinked"
            })
            .unwrap();
        assert_eq!(catalog_event.sigint_inbox_item_id, None);
        assert_eq!(catalog_event.payload["sigint_callsign_id"], callsign_id);
    }

    #[actix_web::test]
    #[serial]
    async fn association_edits_queue_link_and_unlink_events() {
        let env = cleanup().await.unwrap();
        let fixture = create_association_fixture(&env).await;
        assert_frequency_transitions(&env, &fixture).await;
        let item_callsign = link_inbox_callsign(&env, &fixture).await;
        assert_settlement_and_unlinks(&env, &fixture, &item_callsign).await;
    }

    async fn relink_network_callsign_ids(
        env: &Env,
        fixture: &AssociationFixture,
    ) -> serde_json::Value {
        sigint_inbox_item_network::Entity::delete_many()
            .filter(
                sigint_inbox_item_network::Column::SigintInboxItemId
                    .eq(fixture.item_id),
            )
            .filter(
                sigint_inbox_item_network::Column::SigintNetworkId
                    .eq(fixture.network.id),
            )
            .exec(&env.dbx)
            .await
            .unwrap();
        clear_iggy_events(env, fixture.integration.id).await;
        mk_sigint_inbox_item_network(
            &env.dbx,
            sigint_inbox_item_network::ActiveModel {
                sigint_inbox_item_id: Set(fixture.item_id),
                sigint_network_id: Set(fixture.network.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        load_pending_events(&env.dbx, fixture.integration.id)
            .await
            .unwrap()
            .into_iter()
            .find(|event| {
                event.payload["event_type"]
                    == "sigint_inbox_item_network_linked"
            })
            .unwrap()
            .payload["sigint_callsign_ids"]
            .clone()
    }

    #[actix_web::test]
    #[serial]
    async fn network_links_use_current_catalog_callsigns() {
        let env = cleanup().await.unwrap();
        let fixture = create_association_fixture(&env).await;

        sigint_network_callsign::ActiveModel {
            id: Set(fixture.network_callsign.id),
            sigint_callsign_id: Set(None),
            ..Default::default()
        }
        .update(&env.dbx)
        .await
        .unwrap();
        assert_eq!(
            relink_network_callsign_ids(&env, &fixture).await,
            serde_json::json!([fixture.callsign_id])
        );

        sigint_unit::ActiveModel {
            id: Set(fixture.unit.id),
            active: Set(false),
            ..Default::default()
        }
        .update(&env.dbx)
        .await
        .unwrap();
        assert_eq!(
            relink_network_callsign_ids(&env, &fixture).await,
            serde_json::json!([])
        );
    }

    #[actix_web::test]
    #[serial]
    async fn network_visibility_queues_frequency_catalog_events() {
        let env = cleanup().await.unwrap();
        let fixture = create_association_fixture(&env).await;
        clear_iggy_events(&env, fixture.integration.id).await;

        sigint_network::ActiveModel {
            id: Set(fixture.network.id),
            deleted: Set(true),
            ..Default::default()
        }
        .update(&env.dbx)
        .await
        .unwrap();
        let events = load_pending_events(&env.dbx, fixture.integration.id)
            .await
            .unwrap();
        assert_eq!(events.len(), 2);
        assert!(events.iter().all(|event| event.payload["event_type"]
            == "sigint_network_frequency_unlinked"));
        let frequency_ids = events
            .iter()
            .map(|event| {
                event.payload["sigint_network_freq_id"].as_i64().unwrap()
            })
            .collect::<BTreeSet<_>>();
        assert_eq!(
            frequency_ids,
            BTreeSet::from([
                fixture.first_frequency.id,
                fixture.second_frequency.id
            ])
        );
        let logins = crate::users::get_organism_login_ids_by_id(
            &env.dbx,
            &fixture.integration.api_user_login_id,
        )
        .await
        .unwrap();
        let messages = crate::rer_importer::inbox::get_inbox_messages_by_ids(
            &fixture.integration.api_user_login_id,
            &logins,
            &env,
            &[fixture.item_id],
        )
        .await
        .unwrap();
        let messages = enrich_inbox_messages(&env, messages)
            .await
            .unwrap()
            .into_iter()
            .collect::<HashMap<_, _>>();
        assert!(messages[&fixture.item_id]
            .sigint_network_freq_ids
            .is_empty());
        clear_iggy_events(&env, fixture.integration.id).await;

        sigint_inbox_item::ActiveModel {
            id: Set(fixture.item_id),
            freq: Set(Some("678.90".to_string())),
            ..Default::default()
        }
        .update(&env.dbx)
        .await
        .unwrap();
        let events = load_pending_events(&env.dbx, fixture.integration.id)
            .await
            .unwrap();
        assert!(events.iter().all(|event| event.payload["event_type"]
            != "sigint_inbox_item_network_frequencies_changed"));
        clear_iggy_events(&env, fixture.integration.id).await;

        sigint_network::ActiveModel {
            id: Set(fixture.network.id),
            deleted: Set(false),
            ..Default::default()
        }
        .update(&env.dbx)
        .await
        .unwrap();
        let events = load_pending_events(&env.dbx, fixture.integration.id)
            .await
            .unwrap();
        assert_eq!(events.len(), 2);
        assert!(events.iter().all(|event| event.payload["event_type"]
            == "sigint_network_frequency_linked"));
    }

    async fn clear_iggy_events(env: &Env, integration_id: i64) {
        api_integration_iggy_event::Entity::delete_many()
            .filter(
                api_integration_iggy_event::Column::ApiIntegrationId
                    .eq(integration_id),
            )
            .exec(&env.dbx)
            .await
            .unwrap();
    }

    async fn assert_single_updated_event(
        env: &Env,
        integration_id: i64,
        item_id: i64,
    ) {
        let events =
            load_pending_events(&env.dbx, integration_id).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].sigint_inbox_item_id, Some(item_id));
        assert_eq!(
            events[0].payload["event_type"],
            "sigint_inbox_item_updated"
        );
    }

    async fn assert_visibility_reconciliation(
        env: &Env,
        integration: &api_integration::Model,
        item_id: i64,
        expected_visible: bool,
    ) {
        let events =
            load_pending_events(&env.dbx, integration.id).await.unwrap();
        let matching_events = events
            .iter()
            .filter(|event| {
                event.sigint_inbox_item_id == Some(item_id)
                    && event.payload["event_type"]
                        == "sigint_inbox_item_visibility_changed"
            })
            .collect::<Vec<_>>();
        assert_eq!(matching_events.len(), 1);
        let event = matching_events[0];
        let messages = load_pending_event_messages(
            env,
            &integration.api_user_login_id,
            &events,
        )
        .await
        .unwrap();
        let message = messages.get(&item_id);
        assert_eq!(message.is_some(), expected_visible);
        let action = pending_event_action(
            env,
            &integration.api_user_login_id,
            event,
            message,
            &mut HashMap::new(),
            &mut None,
        )
        .await
        .unwrap();
        let expected_action = if expected_visible {
            PendingEventAction::Publish
        } else {
            PendingEventAction::Revoke
        };
        assert_eq!(action, expected_action);

        let payload: serde_json::Value = serde_json::from_slice(
            &render_pending_event(event, message, action).unwrap(),
        )
        .unwrap();
        if expected_visible {
            assert_eq!(payload[0], item_id);
            assert!(payload[1].is_object());
        } else {
            assert_eq!(payload["event_type"], "sigint_inbox_item_deleted");
            assert_eq!(payload["sigint_inbox_item_id"], item_id);
        }
    }

    #[actix_web::test]
    #[serial]
    async fn importance_changes_queue_updated_snapshots() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let group = find_test_datasource_group(&env.dbx).await.unwrap();
        let integration = insert_integration(&env, login.id).await;
        let (item_id, _) = insert_grouped_inbox_item(&env, &group).await;
        clear_iggy_events(&env, integration.id).await;

        let important = mk_sigint_important(
            &env.dbx,
            sigint_important::ActiveModel {
                login_id: Set(Some(login.id)),
                signal_message_id: Set(item_id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_single_updated_event(&env, integration.id, item_id).await;
        let events =
            load_pending_events(&env.dbx, integration.id).await.unwrap();
        let messages = load_pending_event_messages(
            &env,
            &integration.api_user_login_id,
            &events,
        )
        .await
        .unwrap();
        assert!(messages[&item_id].inbox_message.important);
        clear_iggy_events(&env, integration.id).await;

        sigint_important::ActiveModel {
            id: Set(important.id),
            deleted: Set(true),
            ..Default::default()
        }
        .update(&env.dbx)
        .await
        .unwrap();
        assert_single_updated_event(&env, integration.id, item_id).await;
        let events =
            load_pending_events(&env.dbx, integration.id).await.unwrap();
        let messages = load_pending_event_messages(
            &env,
            &integration.api_user_login_id,
            &events,
        )
        .await
        .unwrap();
        assert!(!messages[&item_id].inbox_message.important);
    }

    #[actix_web::test]
    #[serial]
    async fn bookmark_changes_queue_api_user_snapshots() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let group = find_test_datasource_group(&env.dbx).await.unwrap();
        let integration = insert_integration(&env, login.id).await;
        let (item_id, _) = insert_grouped_inbox_item(&env, &group).await;
        clear_iggy_events(&env, integration.id).await;

        let bookmark = mk_sigint_bookmark(
            &env.dbx,
            sigint_bookmark::ActiveModel {
                login_id: Set(login.id),
                signal_message_id: Set(item_id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_single_updated_event(&env, integration.id, item_id).await;
        let events =
            load_pending_events(&env.dbx, integration.id).await.unwrap();
        let messages = load_pending_event_messages(
            &env,
            &integration.api_user_login_id,
            &events,
        )
        .await
        .unwrap();
        assert!(messages[&item_id].inbox_message.bookmarked);
        clear_iggy_events(&env, integration.id).await;

        sigint_bookmark::ActiveModel {
            id: Set(bookmark.id),
            deleted: Set(true),
            ..Default::default()
        }
        .update(&env.dbx)
        .await
        .unwrap();
        assert_single_updated_event(&env, integration.id, item_id).await;
        let events =
            load_pending_events(&env.dbx, integration.id).await.unwrap();
        let messages = load_pending_event_messages(
            &env,
            &integration.api_user_login_id,
            &events,
        )
        .await
        .unwrap();
        assert!(!messages[&item_id].inbox_message.bookmarked);
    }

    #[actix_web::test]
    #[serial]
    async fn device_access_role_changes_refresh_snapshots() {
        let env = cleanup().await.unwrap();
        system_settings::ActiveModel {
            devices_section_enabled: Set(true),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let existing_login = find_test_login(&env.dbx).await.unwrap();
        let login = mk_login(
            &env.dbx,
            login::ActiveModel {
                roles: Set(serde_json::json!(["Api", "Cyber"])),
                sigint_zone_id: Set(existing_login.sigint_zone_id),
                organism_id: Set(existing_login.organism_id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let group = find_test_datasource_group(&env.dbx).await.unwrap();
        let integration = insert_integration(&env, login.id).await;
        let (item_id, _) = insert_grouped_inbox_item(&env, &group).await;
        let device_name = device_name::ActiveModel {
            name: Set(Some("Iggy test device".to_string())),
            login_id: Set(login.id),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        sigint_inbox_item::ActiveModel {
            id: Set(item_id),
            device_name_id: Set(Some(device_name.id)),
            ..Default::default()
        }
        .update(&env.dbx)
        .await
        .unwrap();
        let events =
            load_pending_events(&env.dbx, integration.id).await.unwrap();
        let messages = load_pending_event_messages(
            &env,
            &integration.api_user_login_id,
            &events,
        )
        .await
        .unwrap();
        assert_eq!(
            messages[&item_id].inbox_message.device_name.as_deref(),
            Some("Iggy test device")
        );
        clear_iggy_events(&env, integration.id).await;

        login::ActiveModel {
            id: Set(login.id),
            roles: Set(serde_json::json!(["Api"])),
            ..Default::default()
        }
        .update(&env.dbx)
        .await
        .unwrap();
        let events =
            load_pending_events(&env.dbx, integration.id).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].payload["event_type"],
            "sigint_inbox_item_visibility_changed"
        );
        let messages = load_pending_event_messages(
            &env,
            &integration.api_user_login_id,
            &events,
        )
        .await
        .unwrap();
        assert_eq!(messages[&item_id].inbox_message.device_name, None);
    }

    #[actix_web::test]
    #[serial]
    async fn comment_changes_queue_parent_snapshots() {
        let fixture = group_visibility_fixture().await;
        let comment = mk_signal_message(
            &fixture.env.dbx,
            signal_message::ActiveModel {
                body: Set(Some("comment".to_string())),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        intel_product::ActiveModel {
            intel_message_id: Set(comment.id),
            source_message_id: Set(fixture.item_id),
            relation_kind: Set(intel_product::RELATION_KIND_COMMENT),
            ..Default::default()
        }
        .insert(&fixture.env.dbx)
        .await
        .unwrap();
        assert_single_updated_event(
            &fixture.env,
            fixture.integration.id,
            fixture.item_id,
        )
        .await;
        clear_iggy_events(&fixture.env, fixture.integration.id).await;

        signal_message::ActiveModel {
            id: Set(comment.id),
            body: Set(Some("edited comment".to_string())),
            ..Default::default()
        }
        .update(&fixture.env.dbx)
        .await
        .unwrap();
        assert_single_updated_event(
            &fixture.env,
            fixture.integration.id,
            fixture.item_id,
        )
        .await;
        clear_iggy_events(&fixture.env, fixture.integration.id).await;

        signal_message::ActiveModel {
            id: Set(comment.id),
            deleted: Set(true),
            ..Default::default()
        }
        .update(&fixture.env.dbx)
        .await
        .unwrap();
        assert_single_updated_event(
            &fixture.env,
            fixture.integration.id,
            fixture.item_id,
        )
        .await;
        clear_iggy_events(&fixture.env, fixture.integration.id).await;

        let legacy_comment = mk_sigint_comment(
            &fixture.env.dbx,
            sigint_comment::ActiveModel {
                login_id: Set(fixture.login.id),
                signal_message_id: Set(fixture.item_id),
                comment: Set("legacy comment".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_single_updated_event(
            &fixture.env,
            fixture.integration.id,
            fixture.item_id,
        )
        .await;
        clear_iggy_events(&fixture.env, fixture.integration.id).await;

        sigint_comment::ActiveModel {
            id: Set(legacy_comment.id),
            comment: Set("edited legacy comment".to_string()),
            ..Default::default()
        }
        .update(&fixture.env.dbx)
        .await
        .unwrap();
        assert_single_updated_event(
            &fixture.env,
            fixture.integration.id,
            fixture.item_id,
        )
        .await;
        clear_iggy_events(&fixture.env, fixture.integration.id).await;

        sigint_comment::Entity::delete_by_id(legacy_comment.id)
            .exec(&fixture.env.dbx)
            .await
            .unwrap();
        assert_single_updated_event(
            &fixture.env,
            fixture.integration.id,
            fixture.item_id,
        )
        .await;
    }

    struct GroupVisibilityFixture {
        env: Arc<Env>,
        login: login::Model,
        group: datasource_group::Model,
        integration: api_integration::Model,
        item_id: i64,
    }

    async fn group_visibility_fixture() -> GroupVisibilityFixture {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let group = find_test_datasource_group(&env.dbx).await.unwrap();
        let integration = insert_integration(&env, login.id).await;
        let (item_id, _) = insert_grouped_inbox_item(&env, &group).await;
        clear_iggy_events(&env, integration.id).await;
        GroupVisibilityFixture {
            env,
            login,
            group,
            integration,
            item_id,
        }
    }

    #[actix_web::test]
    #[serial]
    async fn group_state_changes_reconcile_snapshots() {
        let fixture = group_visibility_fixture().await;

        signal_group::ActiveModel {
            master_key: Set(fixture.group.group_master_key.clone()),
            is_archived: Set(true),
            ..Default::default()
        }
        .update(&fixture.env.dbx)
        .await
        .unwrap();
        assert_visibility_reconciliation(
            &fixture.env,
            &fixture.integration,
            fixture.item_id,
            false,
        )
        .await;
        clear_iggy_events(&fixture.env, fixture.integration.id).await;

        signal_group::ActiveModel {
            master_key: Set(fixture.group.group_master_key),
            is_archived: Set(false),
            ..Default::default()
        }
        .update(&fixture.env.dbx)
        .await
        .unwrap();
        assert_visibility_reconciliation(
            &fixture.env,
            &fixture.integration,
            fixture.item_id,
            true,
        )
        .await;
    }

    #[actix_web::test]
    #[serial]
    async fn secret_group_membership_reconciles_snapshots() {
        let fixture = group_visibility_fixture().await;

        signal_group::ActiveModel {
            master_key: Set(fixture.group.group_master_key.clone()),
            is_secret: Set(true),
            ..Default::default()
        }
        .update(&fixture.env.dbx)
        .await
        .unwrap();
        assert_visibility_reconciliation(
            &fixture.env,
            &fixture.integration,
            fixture.item_id,
            false,
        )
        .await;
        clear_iggy_events(&fixture.env, fixture.integration.id).await;

        let secret_group_user = mk_secret_group_user(
            &fixture.env.dbx,
            secret_group_user::ActiveModel {
                master_key: Set(fixture.group.group_master_key),
                login_id: Set(fixture.login.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_visibility_reconciliation(
            &fixture.env,
            &fixture.integration,
            fixture.item_id,
            true,
        )
        .await;
        clear_iggy_events(&fixture.env, fixture.integration.id).await;

        secret_group_user::Entity::delete_by_id(secret_group_user.id)
            .exec(&fixture.env.dbx)
            .await
            .unwrap();
        assert_visibility_reconciliation(
            &fixture.env,
            &fixture.integration,
            fixture.item_id,
            false,
        )
        .await;
    }

    #[actix_web::test]
    #[serial]
    async fn zone_group_membership_reconciles_snapshots() {
        let fixture = group_visibility_fixture().await;

        let zone_link = sigint_zone_datasource::Entity::find()
            .filter(
                sigint_zone_datasource::Column::GroupMasterKey
                    .eq(fixture.group.group_master_key),
            )
            .filter(
                sigint_zone_datasource::Column::SigintZoneId
                    .eq(fixture.login.sigint_zone_id.unwrap()),
            )
            .one(&fixture.env.dbx)
            .await
            .unwrap()
            .unwrap();
        sigint_zone_datasource::Entity::delete_by_id(zone_link.id)
            .exec(&fixture.env.dbx)
            .await
            .unwrap();
        assert_visibility_reconciliation(
            &fixture.env,
            &fixture.integration,
            fixture.item_id,
            false,
        )
        .await;
        clear_iggy_events(&fixture.env, fixture.integration.id).await;

        sigint_zone_datasource::ActiveModel {
            sigint_zone_id: Set(zone_link.sigint_zone_id),
            datasource_id: Set(zone_link.datasource_id),
            group_master_key: Set(zone_link.group_master_key),
            created_at: Set(zone_link.created_at),
            ..Default::default()
        }
        .insert(&fixture.env.dbx)
        .await
        .unwrap();
        assert_visibility_reconciliation(
            &fixture.env,
            &fixture.integration,
            fixture.item_id,
            true,
        )
        .await;
    }

    #[actix_web::test]
    #[serial]
    async fn datasource_deletion_reconciles_snapshots() {
        let fixture = group_visibility_fixture().await;
        let datasource_ids = sigint_zone_datasource::Entity::find()
            .filter(
                sigint_zone_datasource::Column::GroupMasterKey
                    .eq(fixture.group.group_master_key.clone()),
            )
            .all(&fixture.env.dbx)
            .await
            .unwrap()
            .into_iter()
            .map(|link| link.datasource_id)
            .collect::<BTreeSet<_>>();
        let live_datasource_ids = datasource::Entity::find()
            .filter(datasource::Column::Id.is_in(datasource_ids))
            .filter(datasource::Column::Deleted.eq(false))
            .all(&fixture.env.dbx)
            .await
            .unwrap()
            .into_iter()
            .map(|datasource| datasource.id)
            .collect::<Vec<_>>();
        let target_datasource_id = live_datasource_ids[0];
        for datasource_id in &live_datasource_ids[1..] {
            datasource::ActiveModel {
                id: Set(*datasource_id),
                deleted: Set(true),
                ..Default::default()
            }
            .update(&fixture.env.dbx)
            .await
            .unwrap();
        }
        clear_iggy_events(&fixture.env, fixture.integration.id).await;

        datasource::ActiveModel {
            id: Set(target_datasource_id),
            deleted: Set(true),
            ..Default::default()
        }
        .update(&fixture.env.dbx)
        .await
        .unwrap();
        assert_visibility_reconciliation(
            &fixture.env,
            &fixture.integration,
            fixture.item_id,
            false,
        )
        .await;
        clear_iggy_events(&fixture.env, fixture.integration.id).await;

        datasource::ActiveModel {
            id: Set(target_datasource_id),
            deleted: Set(false),
            ..Default::default()
        }
        .update(&fixture.env.dbx)
        .await
        .unwrap();
        assert_visibility_reconciliation(
            &fixture.env,
            &fixture.integration,
            fixture.item_id,
            true,
        )
        .await;
    }

    #[actix_web::test]
    #[serial]
    async fn ancestor_moves_reconcile_descendant_snapshots() {
        let fixture = group_visibility_fixture().await;
        let moved_ancestor = mk_organism(&fixture.env.dbx, Default::default())
            .await
            .unwrap();
        organism::ActiveModel {
            id: Set(fixture.login.organism_id.unwrap()),
            parent_id: Set(Some(moved_ancestor.id)),
            ..Default::default()
        }
        .update(&fixture.env.dbx)
        .await
        .unwrap();
        let restrictive_parent =
            mk_organism(&fixture.env.dbx, Default::default())
                .await
                .unwrap();
        let restricted_group =
            mk_signal_group(&fixture.env.dbx, Default::default())
                .await
                .unwrap();
        organism_group::ActiveModel {
            organism_id: Set(restrictive_parent.id),
            signal_group_master_key: Set(restricted_group.master_key),
        }
        .insert(&fixture.env.dbx)
        .await
        .unwrap();
        clear_iggy_events(&fixture.env, fixture.integration.id).await;

        organism::ActiveModel {
            id: Set(moved_ancestor.id),
            parent_id: Set(Some(restrictive_parent.id)),
            ..Default::default()
        }
        .update(&fixture.env.dbx)
        .await
        .unwrap();
        assert_visibility_reconciliation(
            &fixture.env,
            &fixture.integration,
            fixture.item_id,
            false,
        )
        .await;
        clear_iggy_events(&fixture.env, fixture.integration.id).await;

        organism::ActiveModel {
            id: Set(moved_ancestor.id),
            parent_id: Set(None),
            ..Default::default()
        }
        .update(&fixture.env.dbx)
        .await
        .unwrap();
        assert_visibility_reconciliation(
            &fixture.env,
            &fixture.integration,
            fixture.item_id,
            true,
        )
        .await;
    }

    #[actix_web::test]
    #[serial]
    async fn aor_assignment_removals_reconcile_snapshots() {
        let env = cleanup().await.unwrap();
        let existing_login = find_test_login(&env.dbx).await.unwrap();
        let group = find_test_datasource_group(&env.dbx).await.unwrap();
        let aor = mk_aor(
            &env.dbx,
            area_of_responsibility::ActiveModel {
                left_bound: Set(1_000_000_000.0),
                right_bound: Set(1_000_001_000.0),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let group_aor_link = mk_signal_group_aor(
            &env.dbx,
            signal_group_aor::ActiveModel {
                master_key: Set(group.group_master_key.clone()),
                aor_id: Set(aor.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let organism = mk_organism(
            &env.dbx,
            <organism::ActiveModel as Default>::default(),
        )
        .await
        .unwrap();
        let organism_aor_link = mk_organism_aor(
            &env.dbx,
            organism_aor::ActiveModel {
                organism_id: Set(organism.id),
                aor_id: Set(aor.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let login = mk_login(
            &env.dbx,
            login::ActiveModel {
                sigint_zone_id: Set(existing_login.sigint_zone_id),
                organism_id: Set(Some(organism.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let integration = insert_integration(&env, login.id).await;
        let (item_id, _) = insert_grouped_inbox_item(&env, &group).await;
        clear_iggy_events(&env, integration.id).await;

        organism_aor::Entity::delete_by_id(organism_aor_link.id)
            .exec(&env.dbx)
            .await
            .unwrap();
        assert_visibility_reconciliation(&env, &integration, item_id, false)
            .await;
        clear_iggy_events(&env, integration.id).await;

        mk_organism_aor(
            &env.dbx,
            organism_aor::ActiveModel {
                organism_id: Set(organism.id),
                aor_id: Set(aor.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_visibility_reconciliation(&env, &integration, item_id, true)
            .await;
        clear_iggy_events(&env, integration.id).await;

        signal_group_aor::Entity::delete_by_id(group_aor_link.id)
            .exec(&env.dbx)
            .await
            .unwrap();
        assert_visibility_reconciliation(&env, &integration, item_id, false)
            .await;
    }

    #[actix_web::test]
    #[serial]
    async fn aor_boundary_changes_reconcile_snapshots() {
        let env = cleanup().await.unwrap();
        let existing_login = find_test_login(&env.dbx).await.unwrap();
        let group = find_test_datasource_group(&env.dbx).await.unwrap();
        let organism_aor = mk_aor(
            &env.dbx,
            area_of_responsibility::ActiveModel {
                left_bound: Set(1_000_000_000.0),
                right_bound: Set(1_000_001_000.0),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let group_aor = mk_aor(
            &env.dbx,
            area_of_responsibility::ActiveModel {
                left_bound: Set(2_000_000_000.0),
                right_bound: Set(2_000_001_000.0),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_signal_group_aor(
            &env.dbx,
            signal_group_aor::ActiveModel {
                master_key: Set(group.group_master_key.clone()),
                aor_id: Set(group_aor.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let organism = mk_organism(&env.dbx, Default::default()).await.unwrap();
        mk_organism_aor(
            &env.dbx,
            organism_aor::ActiveModel {
                organism_id: Set(organism.id),
                aor_id: Set(organism_aor.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let login = mk_login(
            &env.dbx,
            login::ActiveModel {
                sigint_zone_id: Set(existing_login.sigint_zone_id),
                organism_id: Set(Some(organism.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let integration = insert_integration(&env, login.id).await;
        let (item_id, _) = insert_grouped_inbox_item(&env, &group).await;
        clear_iggy_events(&env, integration.id).await;

        area_of_responsibility::ActiveModel {
            id: Set(group_aor.id),
            left_bound: Set(1_000_000_500.0),
            right_bound: Set(1_000_001_500.0),
            ..Default::default()
        }
        .update(&env.dbx)
        .await
        .unwrap();
        assert_visibility_reconciliation(&env, &integration, item_id, true)
            .await;
        clear_iggy_events(&env, integration.id).await;

        area_of_responsibility::ActiveModel {
            id: Set(group_aor.id),
            left_bound: Set(2_000_000_000.0),
            right_bound: Set(2_000_001_000.0),
            ..Default::default()
        }
        .update(&env.dbx)
        .await
        .unwrap();
        assert_visibility_reconciliation(&env, &integration, item_id, false)
            .await;
    }

    #[actix_web::test]
    #[serial]
    async fn active_integration_prevents_organism_deletion() {
        let fixture = group_visibility_fixture().await;
        let organism_id = fixture.login.organism_id.unwrap();

        let result = organism::ActiveModel {
            id: Set(organism_id),
            deleted_permanently: Set(true),
            ..Default::default()
        }
        .update(&fixture.env.dbx)
        .await;

        assert!(result.is_err());
        let organism = organism::Entity::find_by_id(organism_id)
            .one(&fixture.env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert!(!organism.deleted_permanently);
    }

    #[actix_web::test]
    #[serial]
    async fn derived_media_results_queue_updated_snapshots() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let group = find_test_datasource_group(&env.dbx).await.unwrap();
        let integration = insert_integration(&env, login.id).await;
        let (item_id, _) = insert_grouped_inbox_item(&env, &group).await;
        let media = signal_message_media::ActiveModel {
            id: Set(uuid::Uuid::new_v4()),
            signal_message_id: Set(item_id),
            content_type: Set("audio/ogg".to_string()),
            file_ext: Set(Some("ogg".to_string())),
            file_name: Set(Some("recording.ogg".to_string())),
            size_bytes: Set(1),
            created_at: Set(Utc::now().naive_utc()),
            is_encrypted: Set(false),
            storage_key: Set(None),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        clear_iggy_events(&env, integration.id).await;

        echo_gpu_transcription_queue::ActiveModel {
            source_id: Set(media.id),
            state: Set("completed".to_string()),
            transcribed_value: Set(Some("transcribed".to_string())),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        assert_single_updated_event(&env, integration.id, item_id).await;
        clear_iggy_events(&env, integration.id).await;

        ocr_job::ActiveModel {
            media_id: Set(media.id),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        assert_single_updated_event(&env, integration.id, item_id).await;
        clear_iggy_events(&env, integration.id).await;

        media_summary::ActiveModel {
            media_id: Set(media.id),
            source_kind: Set("transcription".to_string()),
            source_digest: Set("0".repeat(64)),
            source_text: Set(None),
            source_char_count: Set(1),
            state: Set("failed".to_string()),
            ai_engine_id: Set(None),
            ai_engine_name: Set("test".to_string()),
            model_name: Set("test".to_string()),
            last_error: Set(Some("test".to_string())),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        assert_single_updated_event(&env, integration.id, item_id).await;
        clear_iggy_events(&env, integration.id).await;

        signal_message_media_conversion_job::ActiveModel {
            signal_message_id: Set(item_id),
            source_media_id: Set(media.id),
            source_file_md5: Set("0".repeat(32)),
            source_file_name: Set("recording.ogg".to_string()),
            status: Set("pending".to_string()),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        assert_single_updated_event(&env, integration.id, item_id).await;
    }

    async fn assert_updated_callsign_ids(
        env: &Env,
        fixture: &AssociationFixture,
        expected: Vec<i64>,
    ) {
        let events = load_pending_events(&env.dbx, fixture.integration.id)
            .await
            .unwrap();
        let event = events
            .iter()
            .find(|event| {
                event.sigint_inbox_item_id == Some(fixture.item_id)
                    && event.payload["event_type"]
                        == "sigint_inbox_item_updated"
            })
            .unwrap();
        let messages = load_pending_event_messages(
            env,
            &fixture.integration.api_user_login_id,
            std::slice::from_ref(event),
        )
        .await
        .unwrap();
        assert_eq!(messages[&fixture.item_id].sigint_callsign_ids, expected);
        let network_unlinked = events.iter().find(|event| {
            event.payload["event_type"] == "sigint_network_callsign_unlinked"
                && event.payload["sigint_network_callsign_id"]
                    == fixture.network_callsign.id
        });
        assert!(network_unlinked.is_some());
        let network_linked = events
            .iter()
            .find(|event| {
                event.payload["event_type"] == "sigint_network_callsign_linked"
                    && event.payload["sigint_network_callsign_id"]
                        == fixture.network_callsign.id
            })
            .unwrap();
        assert_eq!(
            network_linked.payload["sigint_callsign_ids"],
            serde_json::json!(expected)
        );
    }

    #[actix_web::test]
    #[serial]
    async fn catalog_callsign_edits_queue_updated_snapshots() {
        let env = cleanup().await.unwrap();
        let fixture = create_association_fixture(&env).await;
        link_inbox_callsign(&env, &fixture).await;
        clear_iggy_events(&env, fixture.integration.id).await;

        let second_callsign_id =
            insert_callsign(&env, fixture.unit.id, fixture.intercepted_at)
                .await;
        assert_updated_callsign_ids(
            &env,
            &fixture,
            vec![fixture.callsign_id, second_callsign_id],
        )
        .await;
        clear_iggy_events(&env, fixture.integration.id).await;

        sigint_callsign::ActiveModel {
            id: Set(second_callsign_id),
            callsign: Set("renamed".to_string()),
            ..Default::default()
        }
        .update(&env.dbx)
        .await
        .unwrap();
        assert_updated_callsign_ids(&env, &fixture, vec![fixture.callsign_id])
            .await;
        clear_iggy_events(&env, fixture.integration.id).await;

        sigint_callsign::ActiveModel {
            id: Set(fixture.callsign_id),
            deleted: Set(true),
            ..Default::default()
        }
        .update(&env.dbx)
        .await
        .unwrap();
        assert_updated_callsign_ids(&env, &fixture, Vec::new()).await;
        clear_iggy_events(&env, fixture.integration.id).await;

        sigint_callsign::ActiveModel {
            id: Set(fixture.callsign_id),
            deleted: Set(false),
            ..Default::default()
        }
        .update(&env.dbx)
        .await
        .unwrap();
        clear_iggy_events(&env, fixture.integration.id).await;
        sigint_unit::ActiveModel {
            id: Set(fixture.unit.id),
            active: Set(false),
            ..Default::default()
        }
        .update(&env.dbx)
        .await
        .unwrap();
        assert_updated_callsign_ids(&env, &fixture, Vec::new()).await;
    }

    #[actix_web::test]
    #[serial]
    async fn inbox_edits_hydrate_visible_messages() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let group = find_test_datasource_group(&env.dbx).await.unwrap();
        let integration = insert_integration(&env, login.id).await;
        let intercepted_at = Utc::now().naive_utc();
        let message = mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                body: Set(Some("edited message".to_string())),
                datasource_group_id: Set(Some(group.id)),
                created_at: Set(intercepted_at),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_inbox_item(
            &env.dbx,
            sigint_inbox_item::ActiveModel {
                id: Set(message.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_signal_message_group(
            &env.dbx,
            signal_message_group::ActiveModel {
                signal_message_id: Set(message.id),
                group_master_key: Set(Some(group.group_master_key)),
                datasource_group_id: Set(Some(group.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        sigint_inbox_item::ActiveModel {
            id: Set(message.id),
            location: Set(Some("changed location".to_string())),
            ..Default::default()
        }
        .update(&env.dbx)
        .await
        .unwrap();
        let unit = mk_sigint_unit(&env.dbx, Default::default()).await.unwrap();
        sigint_inbox_item_unit::ActiveModel {
            item_id: Set(message.id),
            unit_id: Set(unit.id),
            kind: Set(SigintInboxItemUnitKind::Parsed),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let network = mk_sigint_network(&env.dbx, Default::default())
            .await
            .unwrap();
        mk_sigint_inbox_item_network(
            &env.dbx,
            sigint_inbox_item_network::ActiveModel {
                sigint_inbox_item_id: Set(message.id),
                sigint_network_id: Set(network.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert!(has_visible_linked_inbox_item(&env, &login.id, network.id)
            .await
            .unwrap());
        let unrelated_zone =
            mk_sigint_zone(&env.dbx, Default::default()).await.unwrap();
        let unrelated_login = mk_login(
            &env.dbx,
            login::ActiveModel {
                sigint_zone_id: Set(Some(unrelated_zone.id)),
                organism_id: Set(login.organism_id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert!(!has_visible_linked_inbox_item(
            &env,
            &unrelated_login.id,
            network.id,
        )
        .await
        .unwrap());

        let events =
            load_pending_events(&env.dbx, integration.id).await.unwrap();
        let messages = load_pending_event_messages(
            &env,
            &integration.api_user_login_id,
            &events,
        )
        .await
        .unwrap();
        let creation_event = events
            .iter()
            .find(|event| {
                event.payload["event_type"] == "sigint_inbox_item_created"
            })
            .unwrap();
        let creation: serde_json::Value = serde_json::from_slice(
            &render_pending_event(
                creation_event,
                Some(&messages[&message.id]),
                PendingEventAction::Publish,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(creation[0], message.id);
        assert_eq!(creation[1]["text"], "edited message");
        let updated_event = events
            .iter()
            .find(|event| {
                event.payload["event_type"] == "sigint_inbox_item_updated"
            })
            .unwrap();
        let rendered: serde_json::Value = serde_json::from_slice(
            &render_pending_event(
                updated_event,
                Some(&messages[&message.id]),
                PendingEventAction::Publish,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(rendered["event_type"], "sigint_inbox_item_updated");
        assert_eq!(rendered["message"]["text"], "edited message");
        assert_eq!(
            rendered["message"]["sigint_unit_ids"],
            serde_json::json!([unit.id])
        );
        signal_message::ActiveModel {
            id: Set(message.id),
            deleted: Set(true),
            ..Default::default()
        }
        .update(&env.dbx)
        .await
        .unwrap();
        let events =
            load_pending_events(&env.dbx, integration.id).await.unwrap();
        let deleted: serde_json::Value = serde_json::from_slice(
            &render_pending_event(
                events.last().unwrap(),
                None,
                PendingEventAction::Publish,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(deleted["event_type"], "sigint_inbox_item_deleted");
    }

    #[actix_web::test]
    #[serial]
    async fn losing_last_visible_group_revokes_only_prior_recipients() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let group = find_test_datasource_group(&env.dbx).await.unwrap();
        let integration = insert_integration(&env, login.id).await;
        let unrelated_zone =
            mk_sigint_zone(&env.dbx, Default::default()).await.unwrap();
        let unrelated_login = mk_login(
            &env.dbx,
            login::ActiveModel {
                sigint_zone_id: Set(Some(unrelated_zone.id)),
                organism_id: Set(login.organism_id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let unrelated_integration =
            insert_integration(&env, unrelated_login.id).await;

        let (deleted_item_id, deleted_group) =
            insert_grouped_inbox_item(&env, &group).await;
        let events =
            load_pending_events(&env.dbx, integration.id).await.unwrap();
        let messages = load_pending_event_messages(
            &env,
            &integration.api_user_login_id,
            &events,
        )
        .await
        .unwrap();
        assert!(messages.contains_key(&deleted_item_id));

        signal_message_group::Entity::delete_by_id(deleted_group.id)
            .exec(&env.dbx)
            .await
            .unwrap();
        assert_group_loss_action(
            &env,
            &integration,
            deleted_item_id,
            &group.group_master_key,
            PendingEventAction::Revoke,
        )
        .await;
        assert_group_loss_action(
            &env,
            &unrelated_integration,
            deleted_item_id,
            &group.group_master_key,
            PendingEventAction::Skip,
        )
        .await;

        let (moved_item_id, moved_group) =
            insert_grouped_inbox_item(&env, &group).await;
        let target_item_id =
            insert_inbox_item(&env, Utc::now().naive_utc()).await;
        signal_message_group::ActiveModel {
            id: Set(moved_group.id),
            signal_message_id: Set(target_item_id),
            ..Default::default()
        }
        .update(&env.dbx)
        .await
        .unwrap();
        let events =
            load_pending_events(&env.dbx, integration.id).await.unwrap();
        let messages = load_pending_event_messages(
            &env,
            &integration.api_user_login_id,
            &events,
        )
        .await
        .unwrap();
        assert!(messages.contains_key(&target_item_id));
        assert_group_loss_action(
            &env,
            &integration,
            moved_item_id,
            &group.group_master_key,
            PendingEventAction::Revoke,
        )
        .await;

        signal_message_group::ActiveModel {
            id: Set(moved_group.id),
            group_master_key: Set(None),
            ..Default::default()
        }
        .update(&env.dbx)
        .await
        .unwrap();
        assert_group_loss_action(
            &env,
            &integration,
            target_item_id,
            &group.group_master_key,
            PendingEventAction::Revoke,
        )
        .await;
    }
}
