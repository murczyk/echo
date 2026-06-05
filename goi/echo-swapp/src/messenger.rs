use crate::config::Config;
use anyhow::{bail, Context, Result};
use echo_im::entities::sea_orm_active_enums::{
    EchoMessageSource, SignalCliMode,
};
use echo_im::entities::{
    echo_account, echo_client, echo_client_config, echo_client_lock,
    echo_sender,
};
use echo_im::types::{MessageSource, OutboxAttachmentInput, SendMessageReq};
use regex::Regex;
use std::time::Duration;

use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseBackend,
    DatabaseConnection, EntityTrait, JoinType, QueryFilter, QuerySelect,
    RelationTrait, Set, Statement, TransactionTrait,
};
use serde::{Deserialize, Serialize};

const OWNED_CLIENT_PREFIX: &str = "echo-swapp-";
const GLOBAL_SYNC_STATE_KEY: &str = "global";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MessengerKind {
    Signal,
    Whatsapp,
}

impl MessengerKind {
    pub fn as_str(self) -> &'static str {
        match self {
            MessengerKind::Signal => "signal",
            MessengerKind::Whatsapp => "whatsapp",
        }
    }

    fn message_source(self) -> MessageSource {
        match self {
            MessengerKind::Signal => MessageSource::Signal,
            MessengerKind::Whatsapp => MessageSource::Whatsapp,
        }
    }

    fn echo_source(self) -> EchoMessageSource {
        match self {
            MessengerKind::Signal => EchoMessageSource::Signal,
            MessengerKind::Whatsapp => EchoMessageSource::Whatsapp,
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct CreateMessengerReq {
    pub name: String,
    pub kind: MessengerKind,
    pub phone: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessengerView {
    pub name: String,
    pub kind: MessengerKind,
    pub phone: Option<String>,
    pub is_linked: bool,
    pub is_paused: bool,
    pub process_name: String,
    pub signal_port: i32,
    pub created_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QrRsp {
    pub qr_code_base64: String,
}

#[derive(Debug, Serialize)]
pub struct ChatView {
    pub id: String,
    pub name: String,
}

pub async fn ensure_pause_state_storage(db: &DatabaseConnection) -> Result<()> {
    db.execute_unprepared(
        "
        create table if not exists echo_swapp_sync_state (
            key text primary key,
            paused boolean not null default false,
            updated_at timestamp without time zone default (now() at time zone 'utc') not null
        );
        ",
    )
    .await?;
    Ok(())
}

pub async fn create(
    db: &DatabaseConnection,
    config: &Config,
    req: CreateMessengerReq,
) -> Result<MessengerView> {
    validate_name(&req.name)?;
    validate_phone(&req.phone)?;
    let client_name = owned_client_name(&req.name);
    ensure_client_available(db, &client_name).await?;

    let txn = db.begin().await?;
    let port = echo_im::find_port_available(8010, 9000, &txn).await?;
    let process_name =
        format!("{}@{}", unit_name(config, req.kind), client_name);
    let attachment_path = format!(
        "{}/{}/{}/attachments/",
        client_dir(config, req.kind),
        client_name,
        cli_dir_name(req.kind),
    );

    echo_im::attach_new_client(
        &client_name,
        &attachment_path,
        process_name,
        port,
        &txn,
        SignalCliMode::Native,
    )
    .await
    .map_err(|err| anyhow::anyhow!("{err}"))?;
    echo_im::set_account_phone(
        req.phone,
        &client_name,
        req.kind.message_source(),
        true,
        &txn,
    )
    .await
    .map_err(|err| anyhow::anyhow!("{err}"))?;

    start_client(config, req.kind, &client_name, port).await?;
    wait_for_signal_client(req.kind, port).await?;
    txn.commit().await?;
    load(db, &req.name).await
}

pub async fn delete(
    db: &DatabaseConnection,
    config: &Config,
    name: &str,
) -> Result<()> {
    let client_name = owned_client_name(name);
    let messenger = load(db, name).await?;
    stop_client(config, messenger.kind, &client_name).await?;
    let txn = db.begin().await?;
    echo_im::detach_client(&client_name, &txn)
        .await
        .map_err(|err| anyhow::anyhow!("{err}"))?;
    txn.commit().await?;
    Ok(())
}

pub async fn list(db: &DatabaseConnection) -> Result<Vec<MessengerView>> {
    let clients = echo_client::Entity::find()
        .filter(echo_client::Column::Deleted.eq(false))
        .filter(echo_client::Column::Name.starts_with(OWNED_CLIENT_PREFIX))
        .all(db)
        .await?;
    let mut result = Vec::new();
    for client in clients {
        if let Some(messenger) = load_optional_owned(db, &client.name).await? {
            result.push(messenger);
        }
    }
    result.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(result)
}

pub async fn load(
    db: &DatabaseConnection,
    name: &str,
) -> Result<MessengerView> {
    load_optional_owned(db, &owned_client_name(name))
        .await?
        .with_context(|| format!("messenger not found: {name}"))
}

pub async fn link(
    db: &DatabaseConnection,
    config: &Config,
    name: &str,
) -> Result<QrRsp> {
    let client_name = owned_client_name(name);
    let messenger = load(db, name).await?;
    start_client(config, messenger.kind, &client_name, messenger.signal_port)
        .await?;
    wait_for_signal_client(messenger.kind, messenger.signal_port).await?;
    let txn = db.begin().await?;
    let qr_code_base64 = echo_im::link_account(
        &client_name,
        messenger.kind.message_source(),
        &txn,
    )
    .await?;
    txn.commit().await?;
    Ok(QrRsp { qr_code_base64 })
}

pub async fn unlink(db: &DatabaseConnection, name: &str) -> Result<()> {
    let client_name = owned_client_name(name);
    let messenger = load(db, name).await?;
    let phone = messenger
        .phone
        .clone()
        .with_context(|| format!("phone not found for messenger: {name}"))?;
    let txn = db.begin().await?;
    echo_im::unlink_account(
        &client_name,
        messenger.kind.message_source(),
        &txn,
    )
    .await
    .map_err(|err| anyhow::anyhow!("{err}"))?;
    echo_im::set_account_phone(
        phone,
        &client_name,
        messenger.kind.message_source(),
        true,
        &txn,
    )
    .await
    .map_err(|err| anyhow::anyhow!("{err}"))?;
    txn.commit().await?;
    persist_is_linked(db, &client_name, messenger.kind, false).await?;
    Ok(())
}

pub async fn is_linked(
    db: &DatabaseConnection,
    name: &str,
    kind: MessengerKind,
) -> Result<bool> {
    let client_name = owned_client_name(name);
    let txn = db.begin().await?;
    let is_linked =
        echo_im::is_client_logged_in(&client_name, kind.message_source(), &txn)
            .await?;
    txn.commit().await?;
    persist_is_linked(db, &client_name, kind, is_linked).await?;
    Ok(is_linked)
}

pub async fn refresh_groups(
    db: &DatabaseConnection,
    name: &str,
    kind: MessengerKind,
) -> Result<()> {
    let client_name = owned_client_name(name);
    if sync_is_paused(db, &client_name).await? {
        return Ok(());
    }
    match kind {
        MessengerKind::Signal => {
            echo_im::worker::signal_worker_tick_once(&client_name, db).await?
        }
        MessengerKind::Whatsapp => {
            echo_im::worker::whatsapp_worker_tick_once(&client_name, db).await?
        }
    };
    Ok(())
}

pub async fn groups(
    db: &DatabaseConnection,
    name: &str,
    kind: MessengerKind,
) -> Result<Vec<echo_im::types::GroupF1>> {
    let client_name = owned_client_name(name);
    let txn = db.begin().await?;
    let groups = echo_im::list_groups(&client_name, &txn)
        .await?
        .into_iter()
        .filter(|group| group.message_source == kind.message_source())
        .filter(|group| !group.deleted_by_messenger)
        .collect();
    txn.commit().await?;
    Ok(groups)
}

pub async fn chats(
    db: &DatabaseConnection,
    name: &str,
    kind: MessengerKind,
) -> Result<Vec<ChatView>> {
    let client_name = owned_client_name(name);
    let Some(account) = load_account(db, &client_name, kind).await? else {
        return Ok(vec![]);
    };
    let chats = echo_sender::Entity::find()
        .filter(echo_sender::Column::AccountId.eq(account.id))
        .all(db)
        .await?
        .into_iter()
        .map(|sender| {
            let id = sender
                .phone_number
                .clone()
                .filter(|phone| !phone.trim().is_empty())
                .unwrap_or_else(|| sender.uuid.clone());
            ChatView {
                id,
                name: sender.name.unwrap_or(sender.uuid),
            }
        })
        .collect();
    Ok(chats)
}

pub async fn send(
    db: &DatabaseConnection,
    name: &str,
    kind: MessengerKind,
    group_ids: Vec<String>,
    recipient_phone_numbers: Vec<String>,
    text: String,
    attachments: Vec<String>,
) -> Result<()> {
    if text.trim().is_empty() && attachments.is_empty() {
        bail!("message or attachment is required");
    }
    let client_name = owned_client_name(name);
    let txn = db.begin().await?;
    let should_tick_after_send = kind == MessengerKind::Signal;
    echo_im::send_message(
        SendMessageReq {
            text,
            source: kind.message_source(),
            group_ids,
            recipient_phone_numbers,
            attachments: attachments
                .into_iter()
                .map(OutboxAttachmentInput::from)
                .collect(),
        },
        &client_name,
        &txn,
        None,
    )
    .await?;
    txn.commit().await?;
    if should_tick_after_send && !sync_is_paused(db, &client_name).await? {
        echo_im::worker::signal_worker_tick_once(&client_name, db).await?;
    }
    Ok(())
}

async fn load_optional_owned(
    db: &DatabaseConnection,
    client_name: &str,
) -> Result<Option<MessengerView>> {
    let Some(name) = public_client_name(client_name) else {
        return Ok(None);
    };
    let Some((client, config)) = echo_client::Entity::find()
        .filter(echo_client::Column::Name.eq(client_name))
        .filter(echo_client::Column::Deleted.eq(false))
        .join(
            JoinType::InnerJoin,
            echo_client::Relation::EchoClientConfig.def(),
        )
        .select_also(echo_client_config::Entity)
        .one(db)
        .await?
    else {
        return Ok(None);
    };
    let Some(config) = config else {
        return Ok(None);
    };
    let account = echo_account::Entity::find()
        .join(
            JoinType::InnerJoin,
            echo_account::Relation::EchoClientLock.def(),
        )
        .filter(echo_client_lock::Column::ClientId.eq(client.id))
        .one(db)
        .await?;
    let kind = account
        .as_ref()
        .map(|account| match account.source {
            echo_im::entities::sea_orm_active_enums::EchoMessageSource::Signal => {
                MessengerKind::Signal
            }
            echo_im::entities::sea_orm_active_enums::EchoMessageSource::Whatsapp => {
                MessengerKind::Whatsapp
            }
        })
        .unwrap_or_else(|| kind_from_process_name(&config.process_name));

    let is_paused = is_client_paused(db, client_name).await?;

    Ok(Some(MessengerView {
        name,
        kind,
        phone: account.as_ref().map(|account| account.phone_number.clone()),
        is_paused,
        is_linked: account
            .as_ref()
            .map(|account| account.is_linked)
            .unwrap_or(false),
        process_name: config.process_name,
        signal_port: config.signal_port,
        created_at: client.created_at.and_utc().timestamp_millis(),
    }))
}

pub async fn global_is_paused(db: &DatabaseConnection) -> Result<bool> {
    sync_state_is_paused(db, GLOBAL_SYNC_STATE_KEY).await
}

pub async fn set_global_paused(
    db: &DatabaseConnection,
    is_paused: bool,
) -> Result<bool> {
    set_sync_state_paused(db, GLOBAL_SYNC_STATE_KEY, is_paused).await?;
    Ok(is_paused)
}

pub async fn set_paused(
    db: &DatabaseConnection,
    name: &str,
    is_paused: bool,
) -> Result<bool> {
    let client_name = owned_client_name(name);
    load(db, name).await?;
    set_sync_state_paused(db, &client_sync_state_key(&client_name), is_paused)
        .await?;
    Ok(is_paused)
}

async fn ensure_client_available(
    db: &DatabaseConnection,
    name: &str,
) -> Result<()> {
    let existing = echo_client::Entity::find()
        .filter(echo_client::Column::Name.eq(name))
        .filter(echo_client::Column::Deleted.eq(false))
        .one(db)
        .await?;
    if existing.is_some() {
        bail!("messenger already exists: {name}");
    }
    Ok(())
}

async fn load_account(
    db: &DatabaseConnection,
    name: &str,
    kind: MessengerKind,
) -> Result<Option<echo_account::Model>> {
    let Some(client) = echo_client::Entity::find()
        .filter(echo_client::Column::Name.eq(name))
        .filter(echo_client::Column::Deleted.eq(false))
        .one(db)
        .await?
    else {
        return Ok(None);
    };
    let account = echo_account::Entity::find()
        .join(
            JoinType::InnerJoin,
            echo_account::Relation::EchoClientLock.def(),
        )
        .filter(echo_client_lock::Column::ClientId.eq(client.id))
        .filter(echo_account::Column::Source.eq(kind.echo_source()))
        .one(db)
        .await?;
    Ok(account)
}

async fn persist_is_linked(
    db: &DatabaseConnection,
    name: &str,
    kind: MessengerKind,
    is_linked: bool,
) -> Result<()> {
    let Some(account) = load_account(db, name, kind).await? else {
        return Ok(());
    };
    if account.is_linked == is_linked {
        return Ok(());
    }
    let mut account: echo_account::ActiveModel = account.into();
    account.is_linked = Set(is_linked);
    account.update(db).await?;
    Ok(())
}

async fn wait_for_signal_client(kind: MessengerKind, port: i32) -> Result<()> {
    if kind != MessengerKind::Signal {
        return Ok(());
    }
    let addr = format!("127.0.0.1:{port}");
    let mut last_err = None;
    for _ in 0..40 {
        match tokio::net::TcpStream::connect(&addr).await {
            Ok(_) => return Ok(()),
            Err(err) => {
                last_err = Some(err);
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        }
    }
    let err = last_err
        .map(|err| err.to_string())
        .unwrap_or_else(|| "unknown error".to_string());
    bail!("signal service did not become ready on {addr}: {err}");
}

async fn start_client(
    config: &Config,
    kind: MessengerKind,
    name: &str,
    port: i32,
) -> Result<()> {
    match kind {
        MessengerKind::Signal => {
            echo_im::os_specific::start_new_signal_client(
                name,
                port,
                config.signal_client_dir(),
                config.signal_unit_name(),
                config.client_data_dir_name(),
                &SignalCliMode::Native,
            )
            .await?;
        }
        MessengerKind::Whatsapp => {
            echo_im::os_specific::start_new_whatsapp_client(
                name,
                config.whatsapp_client_config(),
                config.whatsapp_client_dir(),
                config.whatsapp_unit_name(),
                config.client_data_dir_name(),
            )
            .await?;
        }
    }
    Ok(())
}

async fn stop_client(
    config: &Config,
    kind: MessengerKind,
    name: &str,
) -> Result<()> {
    match kind {
        MessengerKind::Signal => {
            echo_im::os_specific::stop_signal_client(
                name,
                config.signal_client_dir(),
                config.signal_unit_name(),
            )
            .await?;
        }
        MessengerKind::Whatsapp => {
            echo_im::os_specific::stop_whatsapp_client(
                name,
                config.whatsapp_client_dir(),
                config.whatsapp_unit_name(),
            )
            .await?;
        }
    }
    Ok(())
}

fn validate_name(name: &str) -> Result<()> {
    let re = Regex::new(r"^[a-z0-9][a-z0-9_-]{2,49}$")?;
    if !re.is_match(name) {
        bail!("name must be 3-50 lowercase latin letters, digits, hyphens, or underscores");
    }
    if name.starts_with(OWNED_CLIENT_PREFIX) {
        bail!(
            "name must not start with reserved prefix: {OWNED_CLIENT_PREFIX}"
        );
    }
    Ok(())
}

fn validate_phone(phone: &str) -> Result<()> {
    let re = Regex::new(r"^\+38\d{10}$")?;
    if !re.is_match(phone) {
        bail!("phone must start with +38 and contain 12 digits");
    }
    Ok(())
}

fn unit_name(config: &Config, kind: MessengerKind) -> &str {
    match kind {
        MessengerKind::Signal => config.signal_unit_name(),
        MessengerKind::Whatsapp => config.whatsapp_unit_name(),
    }
}

fn client_dir(config: &Config, kind: MessengerKind) -> &str {
    match kind {
        MessengerKind::Signal => config.signal_client_dir(),
        MessengerKind::Whatsapp => config.whatsapp_client_dir(),
    }
}

fn cli_dir_name(kind: MessengerKind) -> &'static str {
    match kind {
        MessengerKind::Signal => "signal-cli",
        MessengerKind::Whatsapp => "whatsapp-cli",
    }
}

fn kind_from_process_name(process_name: &str) -> MessengerKind {
    if process_name.contains("whatsapp") {
        MessengerKind::Whatsapp
    } else {
        MessengerKind::Signal
    }
}

async fn sync_is_paused(
    db: &DatabaseConnection,
    client_name: &str,
) -> Result<bool> {
    Ok(
        global_is_paused(db).await?
            || is_client_paused(db, client_name).await?,
    )
}

async fn is_client_paused(
    db: &DatabaseConnection,
    client_name: &str,
) -> Result<bool> {
    sync_state_is_paused(db, &client_sync_state_key(client_name)).await
}

async fn sync_state_is_paused(
    db: &DatabaseConnection,
    key: &str,
) -> Result<bool> {
    let row = db
        .query_one(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "select paused from echo_swapp_sync_state where key = $1",
            [key.into()],
        ))
        .await?;
    let Some(row) = row else {
        return Ok(false);
    };
    row.try_get("", "paused").map_err(Into::into)
}

async fn set_sync_state_paused(
    db: &DatabaseConnection,
    key: &str,
    is_paused: bool,
) -> Result<()> {
    db.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "
        insert into echo_swapp_sync_state (key, paused, updated_at)
        values ($1, $2, now() at time zone 'utc')
        on conflict (key) do update set
            paused = excluded.paused,
            updated_at = excluded.updated_at
        ",
        [key.into(), is_paused.into()],
    ))
    .await?;
    Ok(())
}

fn client_sync_state_key(client_name: &str) -> String {
    format!("client:{client_name}")
}

fn owned_client_name(name: &str) -> String {
    format!("{OWNED_CLIENT_PREFIX}{name}")
}

fn public_client_name(client_name: &str) -> Option<String> {
    client_name
        .strip_prefix(OWNED_CLIENT_PREFIX)
        .map(ToOwned::to_owned)
}
