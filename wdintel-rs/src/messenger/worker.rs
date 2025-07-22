use crate::bot::bl::*;
use crate::entities::sea_orm_active_enums::{
    BotMessageType, EchoMessageSource, FlightInboxStatus, MessageSource,
};
use crate::entities::*;
use crate::error_utils::ContextAndError;
use crate::flight_journal::bl;
use crate::flight_journal::types::FlightInsert;
use crate::types::*;
use chrono::{DateTime, TimeDelta, Utc};
use echo_im::types::MessageSource::*;
use echo_im::types::{MessageF1, OutboxMessageStatusRequest, SendMessageReq, SendReplyReq};
use log::*;
use sea_orm::prelude::Expr;
use sea_orm::DatabaseConnection;
use sea_orm::*;
use sea_orm::{NotSet, Set};
use std::collections::HashMap;
use tokio::time::{timeout, Duration};

pub async fn echo_iam_bot_worker_nofail(env: Arc<Env>) {
    loop {
        if let Err(e) = echo_iam_bot_worker_inner(env.clone(), "echo_iam_bot_worker_nofail").await {
            error!("failed to run echo_iam_bot_worker: {:?}", e);
        }
        tokio::time::sleep(core::time::Duration::from_secs(10)).await;
    }
}

pub async fn echo_iam_bot_worker_inner(env: Arc<Env>, flush_key: &str) -> Result<(), AppError> {
    let clients = load_bots_map(&env.db).await.context(h!())?;
    for (id, client) in clients {
        let txn = (&env.db).begin().await.context(h!())?;
        sync_groups(&txn, &client.name, id).await.context(h!())?;
        txn.commit().await.context(h!())?;
    }

    let mut last_sync_at = Utc::now();
    let mut inbox_sync_at = Utc::now() - TimeDelta::seconds(10);
    let mut sync_at = BTreeMap::new();
    loop {
        let now = Utc::now();
        let clients = load_bots_map(&env.db).await.context(h!())?;
        let mut new_sync_at = (last_sync_at, inbox_sync_at);
        for (bot_id, client) in clients {
            let client_name = client.name.clone();
            let (old_last_sync_at, old_inbox_sync_at) = sync_at
                .get(&client_name)
                .cloned()
                .unwrap_or((last_sync_at.clone(), inbox_sync_at.clone()));
            new_sync_at = sync_client_nofail(
                &client_name,
                &env.db,
                old_last_sync_at,
                old_inbox_sync_at,
                env.clone(),
                flush_key,
                bot_id,
            )
            .await;
            sync_at.insert(client_name.clone(), new_sync_at);
        }
        (last_sync_at, inbox_sync_at) = new_sync_at;
        let time_elapsed = Utc::now() - now;
        let delta = TimeDelta::seconds(3);
        if time_elapsed < delta {
            // sleep if update took less than 3 seconds
            let duration = (delta - time_elapsed).num_milliseconds() as u64;
            tokio::time::sleep(core::time::Duration::from_millis(duration)).await;
        }
    }
}

async fn sync_client_nofail(
    client_name: &str,
    db: &DatabaseConnection,
    last_sync_at: DateTime<Utc>,
    inbox_sync_at: DateTime<Utc>,
    env: Arc<Env>,
    flush_key: &str,
    bot_id: Uuid,
) -> (DateTime<Utc>, DateTime<Utc>) {
    let timeout_duration = Duration::from_secs(60);
    match timeout(
        timeout_duration,
        sync_client(
            client_name,
            db,
            last_sync_at,
            inbox_sync_at,
            env.clone(),
            flush_key,
            bot_id,
        ),
    )
    .await
    {
        Ok(result) => match result {
            Ok((new_last, new_inbox)) => {
                debug!("sync_client completed for client {}:", client_name);
                (new_last, new_inbox)
            }
            Err(e) => {
                error!("sync_client failed for client {}: {:?}", client_name, e);
                (last_sync_at, inbox_sync_at)
            }
        },
        Err(e) => {
            error!("sync_client timed out for client {}", client_name);
            debug!("{} timeout: {:?}", client_name, e);
            (last_sync_at, inbox_sync_at)
        }
    }
}

async fn sync_client(
    client_name: &str,
    db: &DatabaseConnection,
    last_sync_at: DateTime<Utc>,
    inbox_sync_at: DateTime<Utc>,
    env: Arc<Env>,
    flush_key: &str,
    bot_id: Uuid,
) -> anyhow::Result<(DateTime<Utc>, DateTime<Utc>)> {
    debug!("[{}] syncing client start", client_name);

    report_error(tick_signal(client_name, db).await, h!());
    trace!("[{}] syncing client signal account completed", client_name);
    report_error(tick_whatsapp(client_name, db).await, h!());
    trace!(
        "[{}] syncing client whatsapp account completed",
        client_name
    );
    let mut last_sync_at = last_sync_at;

    let now = Utc::now();
    if now - TimeDelta::seconds(60) > last_sync_at {
        trace!("[{}] syncing client outbox", client_name);
        let txn = db.begin().await.context(h!())?;
        if let Ok(_) = report_error_in(
            sync_out(last_sync_at, &txn, client_name, bot_id).await,
            h!(),
        ) {
            last_sync_at = now;
        }
        txn.commit().await.context(h!())?;
        trace!("[{}] syncing client outbox completed", client_name);
    }
    let mut inbox_sync_at = inbox_sync_at;
    if now - TimeDelta::seconds(8) > inbox_sync_at {
        trace!("[{}] syncing client inbox", client_name);
        if let Ok(_) = report_error_in(
            sync_in(inbox_sync_at, db, client_name, env.clone(), flush_key).await,
            h!(),
        ) {
            inbox_sync_at = now;
        }
        trace!("[{}] syncing client inbox completed", client_name);
    }
    trace!("[{}] syncing client stale messages", client_name);
    let txn = db.begin().await.context(h!())?;
    report_error(sync_stale(client_name, &txn, env, flush_key).await, h!());
    txn.commit().await.context(h!())?;
    debug!("[{}] syncing client stale messages completed", client_name);

    Ok((last_sync_at, inbox_sync_at))
}

// Add new functions for ticking signal and whatsapp workers
async fn tick_signal(client_name: &str, db: &DatabaseConnection) -> anyhow::Result<()> {
    trace!(
        "started signal::receive_thread for client_name={}",
        client_name
    );
    echo_im::worker::signal_worker_tick_once(client_name, db)
        .await
        .context(h!())?;
    Ok(())
}

async fn tick_whatsapp(client_name: &str, db: &DatabaseConnection) -> anyhow::Result<()> {
    trace!("started whatsapp::receive_thread");
    echo_im::worker::whatsapp_worker_tick_once(client_name, db)
        .await
        .context(h!())?;
    Ok(())
}

/// Sync groups and outbox
async fn sync_out(
    last_sync_at: DateTime<Utc>,
    txn: &DatabaseTransaction,
    client_name: &str,
    bot_id: Uuid,
) -> anyhow::Result<()> {
    sync_groups(txn, client_name, bot_id).await.context(h!())?;
    sync_outbox(last_sync_at.clone(), txn, client_name)
        .await
        .context(h!())?;
    Ok(())
}

async fn sync_in(
    inbox_sync_at: DateTime<Utc>,
    db: &DatabaseConnection,
    client_name: &str,
    env: Arc<Env>,
    flush_key: &str,
) -> anyhow::Result<()> {
    sync_inbox(inbox_sync_at, db, client_name, env.clone(), flush_key)
        .await
        .context(h!())?;
    Ok(())
}

async fn sync_groups(
    txn: &DatabaseTransaction,
    client_name: &str,
    bot_id: Uuid,
) -> anyhow::Result<()> {
    let unsorted_groups = echo_im::list_groups(client_name, txn).await.context(h!())?;
    let mut groups = vec![];
    let mut deleted_groups = vec![];
    for g in unsorted_groups {
        if g.deleted_by_messenger {
            deleted_groups.push(g);
        } else {
            groups.push(g);
        }
    }
    let group_external_ids = groups.iter().map(|x| x.id.clone()).collect::<Vec<_>>();
    let mut existing_groups = BTreeMap::new();
    let groups_raw = messenger_group::Entity::find()
        .filter(messenger_group::Column::ExternalId.is_in(group_external_ids))
        .all(txn)
        .await
        .cae(h!())?;
    for g in groups_raw {
        if let Some(external_id) = &g.external_id {
            let key = external_id.clone();
            match existing_groups.get(external_id) {
                None => {
                    existing_groups.insert(key, g);
                }
                Some(g2) => {
                    if g.created_at > g2.created_at {
                        existing_groups.insert(key, g);
                    } else {
                        existing_groups.insert(key, g2.clone());
                    }
                }
            }
        }
    }

    for g in groups {
        let source = match &g.message_source {
            Signal => EchoMessageSource::Signal,
            _ => EchoMessageSource::Whatsapp,
        };
        match existing_groups.remove(&g.id.clone()) {
            None => {
                messenger_group::ActiveModel {
                    id: NotSet,
                    name: Set(g.name),
                    created_at: NotSet,
                    external_id: Set(Some(g.id.clone())),
                    messenger: Set(source),
                    deleted: NotSet,
                    bot_id: Set(bot_id),
                }
                .insert(txn)
                .await
                .context(h!())?;
            }
            Some(group_model) => {
                if group_model.name != g.name {
                    let mut model = group_model.into_active_model();
                    model.name = Set(g.name.clone());
                    model.update(txn).await.context(h!())?;
                }
            }
        }
    }

    let mut signal_ids_to_delete = vec![];
    let mut whatsapp_ids_to_delete = vec![];
    for g in deleted_groups {
        if !g.id.is_empty() {
            if g.message_source == Signal {
                signal_ids_to_delete.push(g.id);
            } else {
                whatsapp_ids_to_delete.push(g.id);
            }
        }
    }
    if !signal_ids_to_delete.is_empty() {
        messenger_group::Entity::update_many()
            .filter(messenger_group::Column::ExternalId.is_in(signal_ids_to_delete))
            .filter(messenger_group::Column::Messenger.eq(EchoMessageSource::Signal))
            .col_expr(messenger_group::Column::Deleted, Expr::value(true))
            .exec(txn)
            .await
            .context(h!())?;
    }
    if !whatsapp_ids_to_delete.is_empty() {
        messenger_group::Entity::update_many()
            .filter(messenger_group::Column::ExternalId.is_in(whatsapp_ids_to_delete))
            .filter(messenger_group::Column::Messenger.eq(EchoMessageSource::Whatsapp))
            .col_expr(messenger_group::Column::Deleted, Expr::value(true))
            .exec(txn)
            .await
            .context(h!())?;
    }
    Ok(())
}

async fn sync_inbox(
    inbox_sync_at: DateTime<Utc>,
    db: &DatabaseConnection,
    client_name: &str,
    env: Arc<Env>,
    flush_key: &str,
) -> anyhow::Result<()> {
    debug!("syncing inbox for client_name={}", client_name);
    // let time = inbox_sync_at;
    let time = inbox_sync_at - TimeDelta::seconds(100); // double-check maybe we missed messages not labeled as seen
    let txn = db.begin().await.context(h!())?;
    let inbox_messages = echo_im::list_inbox_since(client_name, time.naive_utc(), &txn)
        .await
        .context(h!())?;
    txn.commit().await.context(h!())?;

    for (i, m) in inbox_messages.iter().enumerate() {
        {
            debug!(
                "processing inbox message {} of {}; m.id={}",
                i + 1,
                inbox_messages.len(),
                m.id.clone().unwrap_or("".to_string())
            );
            let txn = db.begin().await.context(h!())?;
            process_inbox_message_nofail(&txn, client_name, env.clone(), flush_key, m.clone())
                .await;
            echo_im::mark_inbox_as_seen(client_name, vec![m.internal_id], &txn)
                .await
                .context(h!())?;
            txn.commit().await.context(h!())?;
        }
    }
    {
        let latest_updates = {
            let txn = db.begin().await.context(h!())?;
            let latest_updates =
                echo_im::list_updates_since(client_name, Utc::now().naive_utc(), &txn)
                    .await
                    .context(h!())?;
            txn.commit().await.context(h!())?;
            latest_updates
        };
        for m in latest_updates {
            {
                let txn = db.begin().await.context(h!())?;
                process_inbox_message_updates_nofail(&txn, client_name, env.clone(), flush_key, m)
                    .await;
                txn.commit().await.context(h!())?;
            }
        }
    }
    Ok(())
}

async fn process_inbox_message_nofail(
    txn: &DatabaseTransaction,
    client_name: &str,
    env: Arc<Env>,
    flush_key: &str,
    m: MessageF1,
) {
    debug!(
        "process_inbox_message_nofail client_name={}; message_id={}",
        client_name,
        m.id.clone().unwrap_or("".to_string())
    );
    let current_time = Utc::now().naive_utc();
    if m.timestamp < current_time - TimeDelta::minutes(15) {
        warn!(
            "[{}] message is too old: created at {}, current time: {}; skipping: [{}] {}",
            client_name, m.timestamp, current_time, m.internal_id, m.text
        );
        return;
    }
    let process_result =
        try_process_message(&m, client_name, txn, env.clone(), flush_key, env.clone()).await;
    match process_result {
        Err(e) => {
            warn!("bot failed to process a message: {:?}", e)
        }
        Ok(result) => {
            if result {
                return;
            } else {
                if let Some(phone_number) = &m.sender_phone_number {
                    if let Err(e) = maybe_respond_plusplus(txn, phone_number, &m, client_name)
                        .await
                        .context(h!())
                    {
                        error!("failed to exchange ++: {:?}", e);
                    }
                }
            }
        }
    }
}

async fn sync_outbox(
    till_ts: DateTime<Utc>,
    txn: &DatabaseTransaction,
    client_name: &str,
) -> anyhow::Result<()> {
    let since_ts = till_ts - TimeDelta::hours(6);
    let msgs_to_sync = collect_unsynced_oblik_messages(since_ts, till_ts, client_name, txn)
        .await
        .context(h!())?;
    trace!(
        "{}: syncing {} outbox items",
        client_name,
        msgs_to_sync.len()
    );
    let sync_request = msgs_to_sync.iter().map(|(r, _)| r.clone()).collect();
    let result = echo_im::check_outbox_status(client_name, sync_request, txn)
        .await
        .context(h!())?;
    trace!(
        "{}: {} outbox items to update on outbox sync",
        client_name,
        result.len()
    );
    update_unsynced_oblik_messages(msgs_to_sync, result, txn)
        .await
        .context(h!())?;
    trace!("{}: outbox sync ok", client_name);
    Ok(())
}

async fn process_inbox_message_updates_nofail(
    txn: &DatabaseTransaction,
    client_name: &str,
    env: Arc<Env>,
    flush_key: &str,
    m: MessageF1,
) {
    debug!(
        "process_inbox_message_updates_nofail client_name={}; message_id={}",
        client_name,
        m.id.clone().unwrap_or("".to_string())
    );
    let process_result =
        try_process_message_update(&m, client_name, txn, env.clone(), flush_key).await;
    match process_result {
        Err(e) => {
            warn!("bot failed to process a message: {:?}", e)
        }
        Ok(result) => {
            if result {
                return;
            } else {
                if let Some(phone_number) = &m.sender_phone_number {
                    if let Err(e) = maybe_respond_plusplus(txn, phone_number, &m, client_name)
                        .await
                        .context(h!())
                    {
                        error!("failed to exchange ++: {:?}", e);
                    }
                }
            }
        }
    }
}

pub async fn maybe_respond_plusplus(
    txn: &DatabaseTransaction,
    phone: &String,
    message: &MessageF1,
    client_name: &str,
) -> Result<(), AppError> {
    if message.text.trim() == "+" && message.group_id.is_none() {
        let recipient_phone_numbers = vec![phone.to_string()];
        let req = SendMessageReq {
            source: message.message_source.clone(),
            text: String::from("+"),
            recipient_phone_numbers,
            group_ids: vec![],
            attachments: vec![],
        };
        echo_im::send_message(req, client_name, txn)
            .await
            .map_err(Into::<AppError>::into)
            .context(h!())?;
    }
    Ok(())
}

async fn load_bots_map(
    db: &DatabaseConnection,
) -> anyhow::Result<BTreeMap<Uuid, messenger_bot::Model>> {
    let result = messenger_bot::Entity::find()
        .filter(
            messenger_bot::Column::Status
                .eq(sea_orm_active_enums::BotStatus::Paused)
                .not(),
        )
        .filter(messenger_bot::Column::Deleted.eq(false))
        .all(db)
        .await
        .context(h!())?
        .into_iter()
        .map(|x| (x.id, x))
        .collect::<BTreeMap<_, _>>();
    Ok(result)
}

/// Report error and return nothing
pub fn report_error<T, E: std::fmt::Debug>(result: Result<T, E>, context: &str) {
    if let Err(e) = result {
        error!("{:?}: {}", e, context);
    }
}

/// Report error and return the original result for further matching
pub fn report_error_in<T, E: std::fmt::Debug>(result: Result<T, E>, context: &str) -> Result<T, E> {
    if let Err(ref e) = result {
        error!("{:?}: {}", e, context);
    }
    result
}

pub async fn try_process_message(
    message: &MessageF1,
    client_name: &str,
    txn: &DatabaseTransaction,
    _env: Arc<Env>,
    _flush_key: &str,
    env: Arc<Env>,
) -> Result<bool, AppError> {
    let Ok(Some(bot)) = messenger_bot::Entity::find()
        .filter(messenger_bot::Column::Name.eq(client_name.to_string()))
        .filter(messenger_bot::Column::Deleted.eq(false))
        .one(txn)
        .await
    else {
        debug!(
            "unexpected inbox message, bot for client {} is not set up. skipping message '{}'",
            client_name, message.text
        );
        return Ok(false);
    };

    let Some(restapi_group_id) = message.clone().group_id else {
        info!("[{}] no group_id in message. skip", client_name);
        return Ok(false);
    };
    let Some(link) = get_bot_link(&restapi_group_id, client_name, txn).await? else {
        info!(
            "[{}] no link for bot to group {}. skip",
            client_name, &restapi_group_id
        );
        return Ok(false);
    };

    let time_now = Utc::now();
    info!(
        "[{}] message received at {}: {}",
        client_name, time_now, &message.text
    );
    let (m_flight_insert, warnings) =
        bl::flight_parse_message(link.organism_id, message.text.clone(), txn, &env.mil_geo)
            .await
            .context(h!())?;
    debug!("Parsed flight message: {:?}", m_flight_insert);
    debug!("Warnings: {:?}", warnings);
    let m_flight_insert = m_flight_insert.filter(|fi| {
        fi.task_coords_mgrs.is_some()
            && (fi.crew_id.is_some() || fi.crew_name.is_some())
            && fi.flight_start_or_event_ts.is_some()
    });
    debug!("Filtered flight message: {:?}", m_flight_insert);
    let (m_flight_message_id, msg_type) = if let Some(flight_insert) = m_flight_insert {
        let (m_flight, flight_message_id) = save_new_flight(
            message,
            txn,
            &bot,
            link,
            warnings.clone(),
            flight_insert,
            client_name,
        )
        .await
        .context(h!())?;
        let m_flight_id = m_flight.as_ref().map(|x| x.id);
        debug!("m_flight_id: {:?}", m_flight_id);
        if !warnings.is_empty() {
            echo_im::reply_to_inbox_message(
                mk_warning_message(
                    warnings.clone(),
                    env.config.public_url.clone(),
                    m_flight.clone(),
                    message,
                ),
                client_name,
                txn,
            )
            .await
            .context(h!())?;
        }
        (Some(flight_message_id), BotMessageType::CreateFlight)
    } else {
        (None, BotMessageType::Context)
    };

    debug!("About to save bot inbox message");
    save_bot_inbox_message(txn, message, bot.id, m_flight_message_id, msg_type)
        .await
        .context(h!())?;

    Ok(true)
}

fn mk_warning_message(
    warnings: Vec<String>,
    public_url: Option<String>,
    m_flight: Option<flight::Model>,
    src_inbox_message: &MessageF1,
) -> SendReplyReq {
    let resolution = if let Some(flight) = m_flight {
        let flight_link = if let Some(public_url) = public_url {
            format!(
                "\nhttps://{}/battle-unit/{}/flight-journal?flightType={}",
                public_url,
                flight.battle_unit_id,
                flight.flight_type.to_value()
            )
        } else {
            "".to_string()
        };
        format!("✅ Запис в журналі польотів створено!{}", flight_link)
    } else {
        "⛔ Запис в журналі польотів не створено!".to_string()
    };
    let warnings = warnings
        .into_iter()
        .map(|w| format!("⚠️ {}\n", split_and_clean_warning(&w)))
        .collect::<Vec<_>>()
        .join("");
    let text = format!("{}\n{}", resolution, warnings);
    SendReplyReq {
        echo_inbox_message_id: src_inbox_message.internal_id,
        attachments: vec![],
        text,
    }
}

async fn save_new_flight(
    message: &MessageF1,
    txn: &DatabaseTransaction,
    bot: &messenger_bot::Model,
    link: bot_organism_link::Model,
    mut warnings: Vec<String>,
    flight_insert: FlightInsert,
    client: &str,
) -> Result<(Option<flight::Model>, Uuid), AppError> {
    debug!("Saving new flight");
    let group = messenger_group::Entity::find_by_id(link.group_id)
        .one(txn)
        .await
        .context(h!())?
        .context(h!())?;
    let flight_message = flight_message::ActiveModel {
        id: NotSet,
        stale: NotSet,
        created_at: NotSet,
        updated_at: NotSet,
        sent_at_at: NotSet,
        deleted: NotSet,
        request_received_at: NotSet,
        group_id: Set(link.group_id),
        bot_id: Set(bot.id),
        message: Set(message.text.clone()),
        outbox_message_receipt: NotSet,
    }
    .insert(txn)
    .await
    .context(h!())?;
    let m_flight = match bl::insert_flight(
        flight_insert.clone(),
        txn,
        &mut warnings,
        message.timestamp.clone(),
    )
    .await
    .context(h!())
    {
        Ok(flight) => Some(flight),
        Err(e) => {
            error!(
                "[{}] failed to insert parsed flight: {:?}. flight details: {:?}",
                client, e, flight_insert
            );
            None
        }
    };
    let m_flight_id = m_flight.as_ref().map(|x| x.id);
    let parsing_ok = m_flight_id.is_some();
    debug!(
        "Flight saved, parsing_ok: {}, flight_id: {:?}",
        parsing_ok, m_flight_id
    );
    let source = match group.messenger {
        EchoMessageSource::Whatsapp => MessageSource::Whatsapp,
        EchoMessageSource::Signal => MessageSource::Signal,
    };
    let status = match parsing_ok {
        true => FlightInboxStatus::Seen,
        false => FlightInboxStatus::New,
    };
    flight_inbox::ActiveModel {
        id: NotSet,
        flight_message_id: Set(Some(flight_message.id)),
        flight_id: Set(m_flight_id),
        warnings: Set(Some(warnings.clone().into())),
        deleted: NotSet,
        created_at: NotSet,
        source: Set(source),
        status: Set(status),
        battle_unit_id: Set(link.organism_id),
        user_input: NotSet,
        is_draft: NotSet,
    }
    .insert(txn)
    .await
    .context(h!())?;
    debug!("Flight inbox saved, reacting now");
    react_to_message(message, client, parsing_ok, !warnings.is_empty(), txn)
        .await
        .context(h!())?;
    Ok((m_flight, flight_message.id))
}

//////////TODO

async fn sync_stale(
    client_name: &str,
    _txn: &DatabaseTransaction,
    _env: Arc<Env>,
    _flush_key: &str,
) -> anyhow::Result<()> {
    trace!("[{}] sync_stale not implemented, skipping...", client_name);
    Ok(())
}

pub async fn collect_unsynced_oblik_messages<C>(
    _since_ts: DateTime<Utc>,
    _till_ts: DateTime<Utc>,
    client_name: &str,
    _db: &C,
) -> anyhow::Result<Vec<(OutboxMessageStatusRequest, String)>>
where
    C: ConnectionTrait + TransactionTrait,
{
    trace!(
        "[{}] collect_unsynced_oblik_messages not implemented, skipping...",
        client_name
    );
    Ok(vec![])
}

pub async fn update_unsynced_oblik_messages<C>(
    _messages: Vec<(OutboxMessageStatusRequest, String)>,
    _response: HashMap<Uuid, NaiveDateTime>,
    _db: &C,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + TransactionTrait,
{
    trace!("update_unsynced_oblik_messages not implemented, skipping...");
    Ok(())
}

pub async fn try_process_message_update(
    message: &MessageF1,
    client_name: &str,
    txn: &DatabaseTransaction,
    _env: Arc<Env>,
    _flush_key: &str,
) -> Result<bool, AppError> {
    let Some(restapi_group_id) = message.clone().group_id else {
        info!("[{}] no group_id in message. skip", client_name);
        return Ok(false);
    };

    let Ok(Some(_bot)) = messenger_bot::Entity::find()
        .filter(messenger_bot::Column::Name.eq(client_name.to_string()))
        .filter(messenger_bot::Column::Deleted.eq(false))
        .one(txn)
        .await
    else {
        error!("bot {} not found", client_name);
        return Ok(false);
    };
    let Some(link) = get_bot_link(&restapi_group_id, client_name, txn).await? else {
        info!("[{}] no link for bot. skip", client_name);
        return Ok(false);
    };

    let _organism_id = link.organism_id;

    let time_now = Utc::now();
    info!(
        "[{}] message update received at {}: {}",
        client_name, time_now, &message.text
    );
    Ok(true)
}

fn split_and_clean_warning(s: &str) -> String {
    if let Some(last_dash_index) = s.rfind('-') {
        let (potential_prefix, potential_suffix) = s.split_at(last_dash_index);

        // Check if the part after the last dash looks like " - number"
        // We'll trim to remove leading spaces before checking for a number
        let trimmed_suffix = potential_suffix[1..].trim_start(); // Skip the dash itself

        if trimmed_suffix.chars().all(|c| c.is_ascii_digit()) && !trimmed_suffix.is_empty() {
            // It looks like a number, so we take the prefix
            return potential_prefix.trim_end().to_string();
        }
    }
    // If no dash found, or the part after the dash isn't a number, return the original string trimmed
    s.trim_end().to_string()
}
