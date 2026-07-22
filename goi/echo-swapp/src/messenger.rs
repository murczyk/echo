use crate::config::Config;
use crate::error::ShortContext;
use crate::h;
use anyhow::{bail, Context, Result};
use echo_im::entities::sea_orm_active_enums::{
    EchoMessageSource, SignalCliMode,
};
use echo_im::entities::{
    echo_account, echo_client, echo_client_config, echo_client_lock,
    echo_qr_code, echo_sender,
};
use echo_im::types::{MessageSource, OutboxAttachmentInput, SendMessageReq};
use regex::Regex;
use std::process::Command;
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
    pub display_name: String,
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

pub async fn ensure_schema(db: &DatabaseConnection) -> Result<()> {
    db.execute_unprepared(
        "
        alter table echo_client
            add column if not exists display_name text;

        update echo_client
        set display_name = regexp_replace(name, '^echo-swapp-', '')
        where name like 'echo-swapp-%'
            and display_name is null;

        create table if not exists echo_swapp_sync_state (
            key text primary key,
            paused boolean not null default false,
            updated_at timestamp without time zone default (now() at time zone 'utc') not null
        );
        ",
    )
    .await
    .c(h!())?;
    Ok(())
}

pub async fn create(
    db: &DatabaseConnection,
    config: &Config,
    req: CreateMessengerReq,
) -> Result<MessengerView> {
    let display_name = req.name.clone();
    let name = available_public_name(db, &display_name).await.c(h!())?;
    validate_name(&name).c(h!())?;
    validate_phone(&req.phone).c(h!())?;
    let client_name = owned_client_name(&name);
    ensure_client_available(db, &client_name).await.c(h!())?;

    let txn = db.begin().await.c(h!())?;
    let port = echo_im::find_port_available(8010, 9000, &txn)
        .await
        .c(h!())?;
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
    .map_err(|err| anyhow::anyhow!("{err}"))
    .c(h!())?;
    persist_display_name(&txn, &client_name, &display_name)
        .await
        .c(h!())?;
    echo_im::set_account_phone(
        req.phone,
        &client_name,
        req.kind.message_source(),
        true,
        &txn,
    )
    .await
    .map_err(|err| anyhow::anyhow!("{err}"))
    .c(h!())?;
    persist_is_linked(&txn, &client_name, req.kind, false)
        .await
        .c(h!())?;

    start_client(config, req.kind, &client_name, port)
        .await
        .c(h!())?;
    wait_for_signal_client(req.kind, port).await.c(h!())?;
    txn.commit().await.c(h!())?;
    load(db, &name).await.c(h!())
}

pub async fn delete(
    db: &DatabaseConnection,
    config: &Config,
    name: &str,
) -> Result<()> {
    let client_name = owned_client_name(name);
    let messenger = load(db, name).await.c(h!())?;
    stop_client(config, messenger.kind, &client_name)
        .await
        .c(h!())?;
    let txn = db.begin().await.c(h!())?;
    echo_im::detach_client(&client_name, &txn)
        .await
        .map_err(|err| anyhow::anyhow!("{err}"))
        .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(())
}

pub async fn list(db: &DatabaseConnection) -> Result<Vec<MessengerView>> {
    let clients = echo_client::Entity::find()
        .filter(echo_client::Column::Deleted.eq(false))
        .filter(echo_client::Column::Name.starts_with(OWNED_CLIENT_PREFIX))
        .all(db)
        .await
        .c(h!())?;
    let mut result = Vec::new();
    for client in clients {
        if let Some(messenger) =
            load_optional_owned(db, &client.name).await.c(h!())?
        {
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
        .await
        .c(h!())?
        .with_context(|| format!("messenger not found: {name}"))
        .c(h!())
}

pub async fn link(
    db: &DatabaseConnection,
    config: &Config,
    name: &str,
) -> Result<QrRsp> {
    let client_name = owned_client_name(name);
    let messenger = load(db, name).await.c(h!())?;
    erase_stale_qr_codes(db, &client_name, messenger.kind)
        .await
        .c(h!())?;
    start_client(config, messenger.kind, &client_name, messenger.signal_port)
        .await
        .c(h!())?;
    restart_client_process(config, messenger.kind, &client_name)
        .await
        .c(h!())?;
    wait_for_signal_client(messenger.kind, messenger.signal_port)
        .await
        .c(h!())?;
    let txn = db.begin().await.c(h!())?;
    persist_is_linked(&txn, &client_name, messenger.kind, false)
        .await
        .c(h!())?;
    let qr_code_base64 = echo_im::link_account(
        &client_name,
        messenger.kind.message_source(),
        &txn,
    )
    .await
    .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(QrRsp { qr_code_base64 })
}

pub async fn unlink(db: &DatabaseConnection, name: &str) -> Result<()> {
    let client_name = owned_client_name(name);
    let messenger = load(db, name).await.c(h!())?;
    let phone = messenger
        .phone
        .clone()
        .with_context(|| format!("phone not found for messenger: {name}"))
        .c(h!())?;
    let txn = db.begin().await.c(h!())?;
    echo_im::unlink_account(
        &client_name,
        messenger.kind.message_source(),
        &txn,
    )
    .await
    .map_err(|err| anyhow::anyhow!("{err}"))
    .c(h!())?;
    echo_im::set_account_phone(
        phone,
        &client_name,
        messenger.kind.message_source(),
        true,
        &txn,
    )
    .await
    .map_err(|err| anyhow::anyhow!("{err}"))
    .c(h!())?;
    txn.commit().await.c(h!())?;
    persist_is_linked(db, &client_name, messenger.kind, false)
        .await
        .c(h!())?;
    Ok(())
}

pub async fn is_linked(
    db: &DatabaseConnection,
    name: &str,
    kind: MessengerKind,
) -> Result<bool> {
    let client_name = owned_client_name(name);
    let txn = db.begin().await.c(h!())?;
    let is_linked =
        echo_im::is_client_logged_in(&client_name, kind.message_source(), &txn)
            .await
            .c(h!())?;
    txn.commit().await.c(h!())?;
    persist_is_linked(db, &client_name, kind, is_linked)
        .await
        .c(h!())?;
    Ok(is_linked)
}

pub async fn refresh_groups(
    db: &DatabaseConnection,
    name: &str,
    kind: MessengerKind,
) -> Result<()> {
    let client_name = owned_client_name(name);
    if sync_is_paused(db, &client_name).await.c(h!())? {
        return Ok(());
    }
    match kind {
        MessengerKind::Signal => {
            echo_im::worker::signal_worker_tick_once(&client_name, db)
                .await
                .c(h!())?
        }
        MessengerKind::Whatsapp => {
            echo_im::worker::whatsapp_worker_tick_once(&client_name, db)
                .await
                .c(h!())?
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
    let txn = db.begin().await.c(h!())?;
    let groups = echo_im::list_groups(&client_name, &txn)
        .await
        .c(h!())?
        .into_iter()
        .filter(|group| group.message_source == kind.message_source())
        .filter(|group| !group.deleted_by_messenger)
        .collect();
    txn.commit().await.c(h!())?;
    Ok(groups)
}

pub async fn chats(
    db: &DatabaseConnection,
    name: &str,
    kind: MessengerKind,
) -> Result<Vec<ChatView>> {
    let client_name = owned_client_name(name);
    let Some(account) = load_account(db, &client_name, kind).await.c(h!())?
    else {
        return Ok(vec![]);
    };
    let chats = echo_sender::Entity::find()
        .filter(echo_sender::Column::AccountId.eq(account.id))
        .all(db)
        .await
        .c(h!())?
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
    let txn = db.begin().await.c(h!())?;
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
    .await
    .c(h!())?;
    txn.commit().await.c(h!())?;
    if should_tick_after_send
        && !sync_is_paused(db, &client_name).await.c(h!())?
    {
        echo_im::worker::signal_worker_tick_once(&client_name, db)
            .await
            .c(h!())?;
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
        .await
        .c(h!())?
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
        .await
        .c(h!())?;
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

    let is_paused = is_client_paused(db, client_name).await.c(h!())?;
    let display_name = load_display_name(db, client.id, &name).await.c(h!())?;

    Ok(Some(MessengerView {
        name,
        display_name,
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
    set_sync_state_paused(db, GLOBAL_SYNC_STATE_KEY, is_paused)
        .await
        .c(h!())?;
    Ok(is_paused)
}

pub async fn set_paused(
    db: &DatabaseConnection,
    name: &str,
    is_paused: bool,
) -> Result<bool> {
    let client_name = owned_client_name(name);
    load(db, name).await.c(h!())?;
    set_sync_state_paused(db, &client_sync_state_key(&client_name), is_paused)
        .await
        .c(h!())?;
    Ok(is_paused)
}

async fn available_public_name(
    db: &DatabaseConnection,
    display_name: &str,
) -> Result<String> {
    let name = normalize_public_name(display_name);
    for suffix in 0..1000 {
        let name = public_name_with_suffix(&name, suffix);
        let client_name = owned_client_name(&name);
        if !client_exists(db, &client_name).await.c(h!())? {
            return Ok(name);
        }
    }
    bail!("unable to find available messenger name");
}

fn public_name_with_suffix(name: &str, suffix: usize) -> String {
    if suffix == 0 {
        return name.to_string();
    }
    let suffix = format!("-{}", suffix + 1);
    let base_limit = 50usize.saturating_sub(suffix.len());
    let mut name = trim_engine_name(&name[..name.len().min(base_limit)]);
    if name.is_empty() {
        name = "integration".to_string();
    }
    format!("{name}{suffix}")
}

async fn client_exists<C>(db: &C, name: &str) -> Result<bool>
where
    C: ConnectionTrait,
{
    let existing = echo_client::Entity::find()
        .filter(echo_client::Column::Name.eq(name))
        .filter(echo_client::Column::Deleted.eq(false))
        .one(db)
        .await
        .c(h!())?;
    Ok(existing.is_some())
}

async fn persist_display_name<C>(
    db: &C,
    client_name: &str,
    display_name: &str,
) -> Result<()>
where
    C: ConnectionTrait,
{
    db.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "update echo_client set display_name = $1 where name = $2",
        vec![
            display_name.to_string().into(),
            client_name.to_string().into(),
        ],
    ))
    .await
    .c(h!())?;
    Ok(())
}

async fn load_display_name<C>(
    db: &C,
    client_id: i32,
    fallback: &str,
) -> Result<String>
where
    C: ConnectionTrait,
{
    let row = db
        .query_one(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "
            select coalesce(nullif(display_name, ''), $2) as display_name
            from echo_client
            where id = $1
            ",
            vec![client_id.into(), fallback.to_string().into()],
        ))
        .await
        .c(h!())?
        .context("echo client display name query did not return a row")
        .c(h!())?;
    row.try_get("", "display_name").c(h!())
}

async fn ensure_client_available(
    db: &DatabaseConnection,
    name: &str,
) -> Result<()> {
    let existing = echo_client::Entity::find()
        .filter(echo_client::Column::Name.eq(name))
        .filter(echo_client::Column::Deleted.eq(false))
        .one(db)
        .await
        .c(h!())?;
    if existing.is_some() {
        bail!("messenger already exists: {name}");
    }
    Ok(())
}

async fn load_account<C>(
    db: &C,
    name: &str,
    kind: MessengerKind,
) -> Result<Option<echo_account::Model>>
where
    C: ConnectionTrait,
{
    let Some(client) = echo_client::Entity::find()
        .filter(echo_client::Column::Name.eq(name))
        .filter(echo_client::Column::Deleted.eq(false))
        .one(db)
        .await
        .c(h!())?
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
        .await
        .c(h!())?;
    Ok(account)
}

async fn erase_stale_qr_codes<C>(
    db: &C,
    name: &str,
    kind: MessengerKind,
) -> Result<()>
where
    C: ConnectionTrait,
{
    let Some(account) = load_account(db, name, kind).await.c(h!())? else {
        return Ok(());
    };
    echo_qr_code::Entity::delete_many()
        .filter(echo_qr_code::Column::AccountId.eq(account.id))
        .filter(echo_qr_code::Column::Source.eq(kind.echo_source()))
        .exec(db)
        .await
        .c(h!())?;
    Ok(())
}

async fn persist_is_linked<C>(
    db: &C,
    name: &str,
    kind: MessengerKind,
    is_linked: bool,
) -> Result<()>
where
    C: ConnectionTrait,
{
    let Some(account) = load_account(db, name, kind).await.c(h!())? else {
        return Ok(());
    };
    if account.is_linked == is_linked {
        return Ok(());
    }
    let mut account: echo_account::ActiveModel = account.into();
    account.is_linked = Set(is_linked);
    account.update(db).await.c(h!())?;
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
            .await
            .c(h!())?;
        }
        MessengerKind::Whatsapp => {
            echo_im::os_specific::start_new_whatsapp_client(
                name,
                config.whatsapp_client_config(),
                config.whatsapp_client_dir(),
                config.whatsapp_unit_name(),
                config.client_data_dir_name(),
            )
            .await
            .c(h!())?;
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
            .await
            .c(h!())?;
        }
        MessengerKind::Whatsapp => {
            echo_im::os_specific::stop_whatsapp_client(
                name,
                config.whatsapp_client_dir(),
                config.whatsapp_unit_name(),
            )
            .await
            .c(h!())?;
        }
    }
    Ok(())
}

async fn restart_client_process(
    config: &Config,
    kind: MessengerKind,
    name: &str,
) -> Result<()> {
    if kind != MessengerKind::Whatsapp {
        return Ok(());
    }

    let unit_name = format!("{}@{}", config.whatsapp_unit_name(), name);
    log::info!("restarting WhatsApp process {unit_name}");

    let sudo_status = Command::new("sudo")
        .args(["-S", "-n", "true"])
        .status()
        .c(h!())?;
    if !sudo_status.success() {
        log::warn!(
            "cannot restart WhatsApp process {unit_name}: sudo is unavailable"
        );
        return Ok(());
    }

    let restart_status = Command::new("sudo")
        .args(["-S", "systemctl", "restart", &unit_name])
        .status()
        .c(h!())?;
    if !restart_status.success() {
        log::warn!(
            "failed to restart WhatsApp process {unit_name}: {restart_status}"
        );
    }

    Ok(())
}

fn validate_name(name: &str) -> Result<()> {
    let re = Regex::new(r"^[a-z0-9][a-z0-9_-]{2,49}$").c(h!())?;
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

fn normalize_public_name(display_name: &str) -> String {
    let mut name = String::new();
    let mut last_was_separator = false;
    for ch in display_name.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            name.push(ch.to_ascii_lowercase());
            last_was_separator = false;
        } else if ch.is_whitespace() || ch == '-' || ch == '_' {
            if !name.is_empty() && !last_was_separator {
                name.push(if ch == '_' { '_' } else { '-' });
                last_was_separator = true;
            }
        } else if let Some(token) = transliterate_cyrillic(ch) {
            if !token.is_empty() {
                name.push_str(token);
                last_was_separator = false;
            }
        }
    }
    name = trim_engine_name(&name);
    while name.starts_with(OWNED_CLIENT_PREFIX) {
        name = trim_engine_name(&name[OWNED_CLIENT_PREFIX.len()..]);
    }
    if name.is_empty() {
        name = "integration".to_string();
    }
    if name.len() > 50 {
        name = trim_engine_name(&name[..50]);
    }
    if name.len() < 3 {
        name = format!("{name}-im");
    }
    trim_engine_name(&name)
}

fn trim_engine_name(name: &str) -> String {
    name.trim_matches(|ch| ch == '-' || ch == '_').to_string()
}

fn transliterate_cyrillic(ch: char) -> Option<&'static str> {
    match ch {
        'а' | 'А' => Some("a"),
        'б' | 'Б' => Some("b"),
        'в' | 'В' => Some("v"),
        'г' | 'Г' => Some("h"),
        'ґ' | 'Ґ' => Some("g"),
        'д' | 'Д' => Some("d"),
        'е' | 'Е' => Some("e"),
        'є' | 'Є' => Some("ye"),
        'ж' | 'Ж' => Some("zh"),
        'з' | 'З' => Some("z"),
        'и' | 'И' => Some("y"),
        'і' | 'І' => Some("i"),
        'ї' | 'Ї' => Some("yi"),
        'й' | 'Й' => Some("y"),
        'к' | 'К' => Some("k"),
        'л' | 'Л' => Some("l"),
        'м' | 'М' => Some("m"),
        'н' | 'Н' => Some("n"),
        'о' | 'О' => Some("o"),
        'п' | 'П' => Some("p"),
        'р' | 'Р' => Some("r"),
        'с' | 'С' => Some("s"),
        'т' | 'Т' => Some("t"),
        'у' | 'У' => Some("u"),
        'ф' | 'Ф' => Some("f"),
        'х' | 'Х' => Some("kh"),
        'ц' | 'Ц' => Some("ts"),
        'ч' | 'Ч' => Some("ch"),
        'ш' | 'Ш' => Some("sh"),
        'щ' | 'Щ' => Some("shch"),
        'ь' | 'Ь' | 'ъ' | 'Ъ' => Some(""),
        'ю' | 'Ю' => Some("yu"),
        'я' | 'Я' => Some("ya"),
        'ё' | 'Ё' => Some("yo"),
        'э' | 'Э' => Some("e"),
        'ы' | 'Ы' => Some("y"),
        _ => None,
    }
}

fn validate_phone(phone: &str) -> Result<()> {
    let re = Regex::new(r"^\+38\d{10}$").c(h!())?;
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
    Ok(global_is_paused(db).await.c(h!())?
        || is_client_paused(db, client_name).await.c(h!())?)
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
        .await
        .c(h!())?;
    let Some(row) = row else {
        return Ok(false);
    };
    row.try_get("", "paused").c(h!())
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
    .await
    .c(h!())?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_display_name_to_engine_name() {
        assert_eq!(
            normalize_public_name(" Гої Signal 333 омбр! "),
            "hoyi-signal-333-ombr"
        );
        assert_eq!(normalize_public_name("echo-swapp-Тест"), "test");
        assert_eq!(normalize_public_name("!!!"), "integration");
        assert_eq!(normalize_public_name("Я"), "ya-im");
    }
}
