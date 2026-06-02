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
use sea_orm::{
    ColumnTrait, DatabaseConnection, EntityTrait, JoinType, QueryFilter,
    QuerySelect, RelationTrait, TransactionTrait,
};
use serde::{Deserialize, Serialize};

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

pub async fn create(
    db: &DatabaseConnection,
    config: &Config,
    req: CreateMessengerReq,
) -> Result<MessengerView> {
    validate_name(&req.name)?;
    validate_phone(&req.phone)?;
    ensure_client_available(db, &req.name).await?;

    let txn = db.begin().await?;
    let port = echo_im::find_port_available(8010, 9000, &txn).await?;
    let process_name = format!("{}@{}", unit_name(config, req.kind), req.name);
    let attachment_path = format!(
        "{}/{}/{}/attachments/",
        client_dir(config, req.kind),
        req.name,
        cli_dir_name(req.kind),
    );

    echo_im::attach_new_client(
        &req.name,
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
        &req.name,
        req.kind.message_source(),
        true,
        &txn,
    )
    .await
    .map_err(|err| anyhow::anyhow!("{err}"))?;

    start_client(config, req.kind, &req.name, port).await?;
    txn.commit().await?;
    load(db, &req.name).await
}

pub async fn list(db: &DatabaseConnection) -> Result<Vec<MessengerView>> {
    let clients = echo_client::Entity::find()
        .filter(echo_client::Column::Deleted.eq(false))
        .all(db)
        .await?;
    let mut result = Vec::new();
    for client in clients {
        if let Some(messenger) = load_optional(db, &client.name).await? {
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
    load_optional(db, name)
        .await?
        .with_context(|| format!("messenger not found: {name}"))
}

pub async fn link(db: &DatabaseConnection, name: &str) -> Result<QrRsp> {
    let messenger = load(db, name).await?;
    let txn = db.begin().await?;
    let qr_code_base64 =
        echo_im::link_account(name, messenger.kind.message_source(), &txn)
            .await?;
    txn.commit().await?;
    Ok(QrRsp { qr_code_base64 })
}

pub async fn is_linked(
    db: &DatabaseConnection,
    name: &str,
    kind: MessengerKind,
) -> Result<bool> {
    let txn = db.begin().await?;
    let is_linked =
        echo_im::is_client_logged_in(name, kind.message_source(), &txn).await?;
    txn.commit().await?;
    Ok(is_linked)
}

pub async fn refresh_groups(
    db: &DatabaseConnection,
    name: &str,
    kind: MessengerKind,
) -> Result<()> {
    match kind {
        MessengerKind::Signal => {
            echo_im::worker::signal_worker_tick_once(name, db).await?
        }
        MessengerKind::Whatsapp => {
            echo_im::worker::whatsapp_worker_tick_once(name, db).await?
        }
    };
    Ok(())
}

pub async fn groups(
    db: &DatabaseConnection,
    name: &str,
    kind: MessengerKind,
) -> Result<Vec<echo_im::types::GroupF1>> {
    let txn = db.begin().await?;
    let groups = echo_im::list_groups(name, &txn)
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
    let Some(account) = load_account(db, name, kind).await? else {
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
    let txn = db.begin().await?;
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
        name,
        &txn,
        None,
    )
    .await?;
    txn.commit().await?;
    Ok(())
}

async fn load_optional(
    db: &DatabaseConnection,
    name: &str,
) -> Result<Option<MessengerView>> {
    let Some((client, config)) = echo_client::Entity::find()
        .filter(echo_client::Column::Name.eq(name))
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

    Ok(Some(MessengerView {
        name: client.name,
        kind,
        phone: account.as_ref().map(|account| account.phone_number.clone()),
        is_linked: account
            .as_ref()
            .map(|account| account.is_linked)
            .unwrap_or(false),
        process_name: config.process_name,
        signal_port: config.signal_port,
        created_at: client.created_at.and_utc().timestamp_millis(),
    }))
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

fn validate_name(name: &str) -> Result<()> {
    let re = Regex::new(r"^[a-z0-9][a-z0-9_-]{2,49}$")?;
    if !re.is_match(name) {
        bail!("name must be 3-50 lowercase latin letters, digits, hyphens, or underscores");
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
