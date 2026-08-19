use crate::config::{
    Config, AUTOMATION_BROKEN_INTEGRATION_ERROR,
    ECHO_SWAPP_ADVISORY_LOCK_RETRY_MILLIS,
    MESSENGER_INTEGRATION_CLIENT_DATA_BACKUP_SUFFIX,
    MESSENGER_INTEGRATION_OPERATION_LOCK_NAMESPACE,
    MESSENGER_INTEGRATION_RELINK_STATE_PREFIX,
    MESSENGER_INTEGRATION_UNIQUENESS_LOCK_ID,
};
use crate::error::{
    bad_request, conflict, not_found, service_unavailable,
    service_unavailable_with_source, ShortContext,
};
use crate::h;
use anyhow::{Context, Result};
use base64::{engine::general_purpose, Engine};
use echo_im::entities::sea_orm_active_enums::{
    EchoMessageSource, SignalCliMode,
};
use echo_im::entities::{
    echo_account, echo_client, echo_client_config, echo_client_lock,
    echo_group, echo_qr_code, echo_sender,
};
use echo_im::types::{MessageSource, OutboxAttachmentInput, SendMessageReq};
use regex::Regex;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseBackend,
    DatabaseConnection, DatabaseTransaction, EntityTrait, IntoActiveModel,
    JoinType, QueryFilter, QuerySelect, RelationTrait, Set, Statement,
    TransactionTrait,
};
use serde::{Deserialize, Serialize};

const OWNED_CLIENT_PREFIX: &str = "echo-swapp-";
const GLOBAL_SYNC_STATE_KEY: &str = "global";
static CLIENT_DATA_BACKUP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMessengerReq {
    pub name: String,
    pub kind: MessengerKind,
    pub phone: String,
    #[serde(default)]
    pub stop_dependent_automations: bool,
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
pub struct MessengerAutomationImpact {
    pub automation_count: usize,
    pub automation_names: Vec<String>,
}

struct DependentAutomation {
    id: i64,
    name: String,
}

struct ClientDataBackup {
    original_path: PathBuf,
    backup_path: PathBuf,
}

struct ClientDataBackups {
    paths: Vec<ClientDataBackup>,
}

#[derive(Debug, Deserialize, Eq, PartialEq, Serialize)]
struct RelinkRecoveryState {
    client_name: String,
    previous_kind: MessengerKind,
    previous_phone: Option<String>,
    replacement_kind: MessengerKind,
    replacement_phone: String,
    signal_port: i32,
    backup_token: String,
}

enum CommitRecovery {
    Replacement(MessengerView),
    Previous,
    Superseded,
    Deleted,
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
    let display_name = normalize_display_name(&req.name).c(h!())?;
    let phone = normalize_phone(&req.phone).c(h!())?;
    let txn = db.begin().await.c(h!())?;
    lock_integration_identity(&txn).await.c(h!())?;
    ensure_display_name_available(&txn, &display_name, "")
        .await
        .c(h!())?;
    let name = available_public_name(&txn, &display_name).await.c(h!())?;
    validate_name(&name).c(h!())?;
    let client_name = owned_client_name(&name);
    ensure_client_available(&txn, &client_name).await.c(h!())?;

    let port = echo_im::find_port_available(8010, 9000, &txn)
        .await
        .c(h!())?;
    let process_name = client_process_name(config, req.kind, &client_name);
    let attachment_path =
        client_attachment_path(config, req.kind, &client_name);

    echo_im::attach_new_client(
        &client_name,
        &attachment_path,
        process_name,
        port,
        &txn,
        SignalCliMode::Normal,
    )
    .await
    .map_err(|err| anyhow::anyhow!("{err}"))
    .c(h!())?;
    persist_display_name(&txn, &client_name, &display_name)
        .await
        .c(h!())?;
    echo_im::set_account_phone(
        phone,
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

pub async fn update(
    db: &DatabaseConnection,
    config: &Config,
    name: &str,
    req: UpdateMessengerReq,
) -> Result<MessengerView> {
    let display_name = normalize_display_name(&req.name).c(h!())?;
    let phone = normalize_phone(&req.phone).c(h!())?;
    let client_name = owned_client_name(name);
    let txn = begin_locked_integration_update_transaction(db, &client_name)
        .await
        .c(h!())?;
    let current = load(&txn, name).await.c(h!())?;
    let account_changed =
        current.kind != req.kind || current.phone.as_deref() != Some(&phone);
    ensure_url_unique(&txn, &client_name).await.c(h!())?;
    ensure_display_name_available(&txn, &display_name, &client_name)
        .await
        .c(h!())?;
    if account_changed {
        let automations =
            dependent_automations(&txn, &client_name).await.c(h!())?;
        if !automations.is_empty() && !req.stop_dependent_automations {
            return Err(conflict(
                "Зміна зупинить залежні автоматизації. Підтвердьте дію після перегляду попередження.",
            ));
        }
        if !automations.is_empty() {
            stop_dependent_automations(&txn, &automations)
                .await
                .c(h!())?;
        }
    }
    persist_display_name(&txn, &client_name, &display_name)
        .await
        .c(h!())?;
    let relink_recovery = if account_changed {
        let relink_recovery = RelinkRecoveryState {
            client_name: client_name.clone(),
            previous_kind: current.kind,
            previous_phone: current.phone.clone(),
            replacement_kind: req.kind,
            replacement_phone: phone.clone(),
            signal_port: current.signal_port,
            backup_token: client_data_backup_token().c(h!())?,
        };
        persist_relink_recovery_state(db, &relink_recovery)
            .await
            .c(h!())?;
        Some(relink_recovery)
    } else {
        None
    };
    let client_data_backups = if let Some(relink_recovery) = &relink_recovery {
        let stop_result = stop_clients_for_replacement(
            config,
            &client_name,
            current.kind,
            req.kind,
            current.signal_port,
        )
        .await
        .c(h!());
        if let Err(err) = stop_result {
            rollback_and_recover_relink(txn, db, config, relink_recovery).await;
            return Err(err);
        }
        match backup_replacement_client_data(
            config,
            current.kind,
            req.kind,
            &client_name,
            &relink_recovery.backup_token,
        )
        .await
        .c(h!())
        {
            Ok(client_data_backups) => Some(client_data_backups),
            Err(err) => {
                rollback_and_recover_relink(txn, db, config, relink_recovery)
                    .await;
                return Err(err);
            }
        }
    } else {
        None
    };
    if account_changed {
        let replace_result = replace_account_lock(
            &txn,
            config,
            &client_name,
            current.kind,
            req.kind,
            phone,
        )
        .await
        .c(h!());
        if let Err(err) = replace_result {
            rollback_and_recover_relink(
                txn,
                db,
                config,
                relink_recovery.as_ref().c(h!())?,
            )
            .await;
            return Err(err);
        }
    }
    let commit_result = txn.commit().await.c(h!());
    if let Err(err) = commit_result {
        if let Some(relink_recovery) = &relink_recovery {
            let recovery = recover_interrupted_relink(
                db,
                config,
                relink_recovery,
            )
            .await
            .with_context(|| {
                format!(
                    "failed to reconcile integration {name} after commit failure: {err:#}"
                )
            })
            .c(h!())?;
            if let CommitRecovery::Replacement(messenger) = recovery {
                return Ok(messenger);
            }
        }
        return Err(err);
    }
    if let (Some(client_data_backups), Some(relink_recovery)) =
        (client_data_backups, relink_recovery)
    {
        if let Err(err) = discard_client_data_backups(&client_data_backups)
            .await
            .c(h!())
        {
            log::error!(
                "failed to delete old client data backup for {client_name}: {err:#}"
            );
        } else if let Err(err) =
            remove_relink_recovery_state(db, &relink_recovery)
                .await
                .c(h!())
        {
            log::error!(
                "failed to delete relink recovery state for {client_name}: {err:#}"
            );
        }
    }

    load(db, name).await.c(h!())
}

pub async fn automation_impact(
    db: &DatabaseConnection,
    name: &str,
) -> Result<MessengerAutomationImpact> {
    load(db, name).await.c(h!())?;
    let automations = dependent_automations(db, &owned_client_name(name))
        .await
        .c(h!())?;
    Ok(MessengerAutomationImpact {
        automation_count: automations.len(),
        automation_names: automations
            .into_iter()
            .map(|automation| automation.name)
            .collect(),
    })
}

async fn stop_clients_for_replacement(
    config: &Config,
    client_name: &str,
    current_kind: MessengerKind,
    replacement_kind: MessengerKind,
    port: i32,
) -> Result<()> {
    if let Err(err) = stop_client_process(config, current_kind, client_name)
        .await
        .c(h!())
    {
        restart_previous_client(config, client_name, current_kind, port).await;
        return Err(err);
    }
    if current_kind == replacement_kind {
        return Ok(());
    }
    if let Err(err) = stop_client_process(config, replacement_kind, client_name)
        .await
        .c(h!())
    {
        restart_previous_client(config, client_name, current_kind, port).await;
        return Err(err);
    }
    Ok(())
}

async fn restart_previous_client(
    config: &Config,
    client_name: &str,
    kind: MessengerKind,
    port: i32,
) {
    let restart_result = async {
        start_client(config, kind, client_name, port)
            .await
            .c(h!())?;
        wait_for_signal_client(kind, port).await.c(h!())
    }
    .await;
    if let Err(err) = restart_result {
        log::error!(
            "failed to restart previous client {client_name} after replacement preparation failure: {err:#}"
        );
    }
}

async fn restore_interrupted_old_client(
    config: &Config,
    client_name: &str,
    old_kind: MessengerKind,
    new_kind: MessengerKind,
    port: i32,
    client_data_backups: &ClientDataBackups,
) -> Result<()> {
    if let Err(err) = stop_client_process(config, new_kind, client_name)
        .await
        .c(h!())
    {
        log::warn!(
            "failed to stop replacement client {client_name} during recovery: {err:#}"
        );
    }
    if old_kind != new_kind {
        if let Err(err) = stop_client_process(config, old_kind, client_name)
            .await
            .c(h!())
        {
            log::warn!(
                "failed to stop previous client {client_name} during recovery: {err:#}"
            );
        }
    }
    let restore_result =
        restore_client_data_backups_if_present(client_data_backups)
            .await
            .c(h!());
    let restart_result = async {
        start_client(config, old_kind, client_name, port)
            .await
            .c(h!())?;
        wait_for_signal_client(old_kind, port).await.c(h!())
    }
    .await;
    match (restore_result, restart_result) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(err), Ok(())) | (Ok(()), Err(err)) => Err(err),
        (Err(restore_err), Err(restart_err)) => {
            log::error!(
                "failed to restart previous client {client_name} after credential restoration failure: {restart_err:#}"
            );
            Err(restore_err)
        }
    }
}

async fn rollback_and_recover_relink(
    txn: DatabaseTransaction,
    db: &DatabaseConnection,
    config: &Config,
    relink_recovery: &RelinkRecoveryState,
) {
    if let Err(err) = txn.rollback().await.c(h!()) {
        log::error!(
            "failed to roll back integration update for {}: {err:#}",
            relink_recovery.client_name
        );
    }
    if let Err(err) =
        recover_interrupted_relink(db, config, relink_recovery).await
    {
        log::error!(
            "failed to recover integration update for {}: {err:#}",
            relink_recovery.client_name
        );
    }
}

pub async fn recover_interrupted_relinks(
    db: &DatabaseConnection,
    config: &Config,
) -> Result<()> {
    for relink_recovery in relink_recovery_states(db).await.c(h!())? {
        log::warn!(
            "recovering interrupted relink for {}",
            relink_recovery.client_name
        );
        recover_interrupted_relink(db, config, &relink_recovery)
            .await
            .c(h!())?;
    }
    Ok(())
}

async fn recover_interrupted_relink(
    db: &DatabaseConnection,
    config: &Config,
    relink_recovery: &RelinkRecoveryState,
) -> Result<CommitRecovery> {
    validate_relink_recovery_state(relink_recovery).c(h!())?;
    let txn = db.begin().await.c(h!())?;
    lock_integration_identity(&txn).await.c(h!())?;
    lock_integration_client_records(&txn, &relink_recovery.client_name)
        .await
        .c(h!())?;
    let durable = load_optional_owned(&txn, &relink_recovery.client_name)
        .await
        .c(h!())?;
    let client_data_backups =
        relink_client_data_backups(config, relink_recovery);
    let recovery = match durable {
        Some(messenger)
            if account_matches(
                &messenger,
                relink_recovery.replacement_kind,
                Some(relink_recovery.replacement_phone.as_str()),
            ) =>
        {
            discard_client_data_backups(&client_data_backups)
                .await
                .c(h!())?;
            start_recovered_client(config, &messenger).await.c(h!())?;
            CommitRecovery::Replacement(messenger)
        }
        Some(messenger)
            if account_matches(
                &messenger,
                relink_recovery.previous_kind,
                relink_recovery.previous_phone.as_deref(),
            ) =>
        {
            restore_interrupted_old_client(
                config,
                &relink_recovery.client_name,
                relink_recovery.previous_kind,
                relink_recovery.replacement_kind,
                relink_recovery.signal_port,
                &client_data_backups,
            )
            .await
            .c(h!())?;
            CommitRecovery::Previous
        }
        Some(messenger) => {
            discard_client_data_backups(&client_data_backups)
                .await
                .c(h!())?;
            start_recovered_client(config, &messenger).await.c(h!())?;
            CommitRecovery::Superseded
        }
        None => {
            if let Err(err) = discard_client_data_backups(&client_data_backups)
                .await
                .c(h!())
            {
                log::warn!(
                    "failed to discard stale client data for deleted integration {}: {err:#}",
                    relink_recovery.client_name
                );
            }
            CommitRecovery::Deleted
        }
    };
    txn.commit().await.c(h!())?;
    remove_relink_recovery_state(db, relink_recovery)
        .await
        .c(h!())?;
    if matches!(&recovery, CommitRecovery::Superseded) {
        log::warn!(
            "integration {} changed again before relink recovery completed",
            relink_recovery.client_name
        );
    }
    Ok(recovery)
}

async fn start_recovered_client(
    config: &Config,
    messenger: &MessengerView,
) -> Result<()> {
    let client_name = owned_client_name(&messenger.name);
    start_client(config, messenger.kind, &client_name, messenger.signal_port)
        .await
        .c(h!())?;
    wait_for_signal_client(messenger.kind, messenger.signal_port)
        .await
        .c(h!())
}

fn account_matches(
    messenger: &MessengerView,
    kind: MessengerKind,
    phone: Option<&str>,
) -> bool {
    messenger.kind == kind && messenger.phone.as_deref() == phone
}

fn ensure_messenger_kind(
    actual: MessengerKind,
    expected: MessengerKind,
) -> Result<()> {
    if actual != expected {
        return Err(conflict(
            "Тип інтеграції змінився. Оновіть дані та повторіть спробу.",
        ));
    }
    Ok(())
}

async fn replace_account_lock(
    txn: &DatabaseTransaction,
    config: &Config,
    client_name: &str,
    old_kind: MessengerKind,
    new_kind: MessengerKind,
    phone: String,
) -> Result<()> {
    delete_client_locks(txn, client_name).await.c(h!())?;
    update_client_config(txn, config, client_name, new_kind)
        .await
        .c(h!())?;
    echo_im::set_account_phone(
        phone,
        client_name,
        new_kind.message_source(),
        true,
        txn,
    )
    .await
    .map_err(|err| anyhow::anyhow!("{err}"))
    .c(h!())?;
    persist_is_linked(txn, client_name, new_kind, false)
        .await
        .c(h!())?;
    let port = load_client_port(txn, client_name).await.c(h!())?;
    start_client(config, new_kind, client_name, port)
        .await
        .c(h!())?;
    wait_for_signal_client(new_kind, port).await.c(h!())?;
    if old_kind != new_kind {
        let old_path = client_data_path(config, old_kind, client_name);
        if old_path.exists() {
            tokio::fs::remove_dir_all(old_path).await.c(h!())?;
        }
    }
    Ok(())
}

pub async fn delete(
    db: &DatabaseConnection,
    config: &Config,
    name: &str,
) -> Result<()> {
    let client_name = owned_client_name(name);
    let txn = begin_locked_integration_client_transaction(db, &client_name)
        .await
        .c(h!())?;
    let messenger = load(&txn, name).await.c(h!())?;
    stop_client(config, messenger.kind, &client_name)
        .await
        .c(h!())?;
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

pub async fn load<C>(db: &C, name: &str) -> Result<MessengerView>
where
    C: ConnectionTrait,
{
    load_optional_owned(db, &owned_client_name(name))
        .await
        .c(h!())?
        .ok_or_else(|| {
            not_found(format!(
                "Месенджер «{name}» не знайдено. Оновіть сторінку та повторіть спробу."
            ))
        })
        .c(h!())
}

pub async fn link(
    db: &DatabaseConnection,
    config: &Config,
    name: &str,
) -> Result<QrRsp> {
    let client_name = owned_client_name(name);
    let txn = begin_locked_integration_client_transaction(db, &client_name)
        .await
        .c(h!())?;
    let messenger = load(&txn, name).await.c(h!())?;
    erase_stale_qr_codes(&txn, &client_name, messenger.kind)
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
    persist_is_linked(&txn, &client_name, messenger.kind, false)
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;
    let qr_code_base64 = echo_im::link_account(
        &client_name,
        messenger.kind.message_source(),
        db,
    )
    .await
    .c(h!())?;
    Ok(QrRsp { qr_code_base64 })
}

pub async fn unlink(db: &DatabaseConnection, name: &str) -> Result<()> {
    let client_name = owned_client_name(name);
    let txn = begin_locked_integration_client_transaction(db, &client_name)
        .await
        .c(h!())?;
    let messenger = load(&txn, name).await.c(h!())?;
    let phone = messenger
        .phone
        .clone()
        .with_context(|| format!("phone not found for messenger: {name}"))
        .c(h!())?;
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
    persist_is_linked(&txn, &client_name, messenger.kind, false)
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(())
}

pub async fn is_linked(
    db: &DatabaseConnection,
    name: &str,
    kind: MessengerKind,
) -> Result<bool> {
    let client_name = owned_client_name(name);
    let txn = begin_locked_integration_client_transaction(db, &client_name)
        .await
        .c(h!())?;
    let messenger = load(&txn, name).await.c(h!())?;
    ensure_messenger_kind(messenger.kind, kind).c(h!())?;
    let is_linked =
        echo_im::is_client_logged_in(&client_name, kind.message_source(), &txn)
            .await
            .c(h!())?;
    persist_is_linked(&txn, &client_name, kind, is_linked)
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(is_linked)
}

pub async fn refresh_groups(
    db: &DatabaseConnection,
    name: &str,
    kind: MessengerKind,
) -> Result<()> {
    let client_name = owned_client_name(name);
    let txn = begin_locked_integration_client_transaction(db, &client_name)
        .await
        .c(h!())?;
    let messenger = load(&txn, name).await.c(h!())?;
    ensure_messenger_kind(messenger.kind, kind).c(h!())?;
    if sync_is_paused(&txn, &client_name).await.c(h!())? {
        txn.commit().await.c(h!())?;
        return Ok(());
    }
    tick_messenger_worker(db, &client_name, kind)
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(())
}

pub async fn sync(db: &DatabaseConnection, name: &str) -> Result<()> {
    let client_name = owned_client_name(name);
    let txn = begin_locked_integration_client_transaction(db, &client_name)
        .await
        .c(h!())?;
    let messenger = load(&txn, name).await.c(h!())?;
    if sync_is_paused(&txn, &client_name).await.c(h!())? {
        txn.commit().await.c(h!())?;
        return Ok(());
    }
    let is_linked = echo_im::is_client_logged_in(
        &client_name,
        messenger.kind.message_source(),
        &txn,
    )
    .await
    .c(h!())?;
    if is_linked {
        tick_messenger_worker(db, &client_name, messenger.kind)
            .await
            .c(h!())?;
    }
    persist_is_linked(&txn, &client_name, messenger.kind, is_linked)
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(())
}

pub(crate) async fn send_next_scheduled_signal_message(
    db: &DatabaseConnection,
    name: &str,
) -> Result<()> {
    let client_name = owned_client_name(name);
    let txn = begin_locked_integration_client_transaction(db, &client_name)
        .await
        .c(h!())?;
    let messenger = load(&txn, name).await.c(h!())?;
    ensure_messenger_kind(messenger.kind, MessengerKind::Signal).c(h!())?;
    if sync_is_paused(&txn, &client_name).await.c(h!())?
        || !has_scheduled_signal_message(&txn, &client_name)
            .await
            .c(h!())?
    {
        txn.commit().await.c(h!())?;
        return Ok(());
    }
    echo_im::worker::signal_worker_tick_once(&client_name, db)
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(())
}

pub(crate) async fn signal_messengers_with_scheduled_messages(
    db: &DatabaseConnection,
) -> Result<Vec<String>> {
    let rows = db
        .query_all_raw(Statement::from_string(
            DatabaseBackend::Postgres,
            r#"
            select distinct client.name
            from echo_client client
            join echo_outbox_message message
                on message.client_id = client.id
            join echo_outbox_message_instance instance
                on instance.message_id = message.id
            join echo_account account
                on account.id = instance.account_id
            where client.deleted = false
                and client.name like 'echo-swapp-%'
                and account.source = 'signal'
                and instance.status = 'scheduled'
            order by client.name
            "#,
        ))
        .await
        .c(h!())?;
    rows.into_iter()
        .map(|row| {
            let client_name: String = row.try_get("", "name").c(h!())?;
            public_client_name(&client_name).context(h!())
        })
        .collect()
}

async fn has_scheduled_signal_message<C>(
    db: &C,
    client_name: &str,
) -> Result<bool>
where
    C: ConnectionTrait,
{
    let row = db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
            select exists (
                select 1
                from echo_client client
                join echo_outbox_message message
                    on message.client_id = client.id
                join echo_outbox_message_instance instance
                    on instance.message_id = message.id
                join echo_account account
                    on account.id = instance.account_id
                where client.name = $1
                    and account.source = 'signal'
                    and instance.status = 'scheduled'
            ) as exists
            "#,
            [client_name.into()],
        ))
        .await
        .c(h!())?
        .context(h!())?;
    row.try_get("", "exists").c(h!())
}

async fn tick_messenger_worker(
    db: &DatabaseConnection,
    client_name: &str,
    kind: MessengerKind,
) -> Result<()> {
    match kind {
        MessengerKind::Signal => {
            echo_im::worker::signal_worker_tick_once(client_name, db)
                .await
                .c(h!())?
        }
        MessengerKind::Whatsapp => {
            echo_im::worker::whatsapp_worker_tick_once(client_name, db)
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

pub(crate) async fn repair_blank_whatsapp_group_names(
    db: &DatabaseConnection,
) -> Result<()> {
    let groups = echo_group::Entity::find()
        .join(JoinType::InnerJoin, echo_group::Relation::EchoAccount.def())
        .join(
            JoinType::InnerJoin,
            echo_account::Relation::EchoClientLock.def(),
        )
        .join(
            JoinType::InnerJoin,
            echo_client_lock::Relation::EchoClient.def(),
        )
        .filter(echo_account::Column::Source.eq(EchoMessageSource::Whatsapp))
        .filter(echo_client::Column::Deleted.eq(false))
        .filter(echo_client::Column::Name.starts_with(OWNED_CLIENT_PREFIX))
        .distinct()
        .all(db)
        .await
        .c(h!())?;
    let resolved_names = groups
        .iter()
        .filter_map(|group| {
            group
                .name
                .as_ref()
                .filter(|name| !name.is_empty())
                .map(|name| (group.group_id.clone(), name.clone()))
        })
        .collect::<BTreeMap<_, _>>();
    for group in groups
        .into_iter()
        .filter(|group| group.name.as_deref() == Some(""))
    {
        let Some(name) = resolved_names.get(&group.group_id) else {
            continue;
        };
        let mut group = group.into_active_model();
        group.name = Set(Some(name.clone()));
        group.update(db).await.c(h!())?;
    }
    Ok(())
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
    let txn = begin_locked_integration_client_transaction(
        db,
        &owned_client_name(name),
    )
    .await
    .c(h!())?;
    let messenger = load(&txn, name).await.c(h!())?;
    ensure_messenger_kind(messenger.kind, kind).c(h!())?;
    if !messenger.is_linked {
        return Err(conflict(
            "Обліковий запис месенджера не підключено. Підключіть його та повторіть спробу.",
        ));
    }
    enqueue(
        &txn,
        name,
        kind,
        group_ids,
        recipient_phone_numbers,
        text,
        attachments,
    )
    .await
    .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(())
}

pub(crate) async fn enqueue(
    txn: &DatabaseTransaction,
    name: &str,
    kind: MessengerKind,
    group_ids: Vec<String>,
    recipient_phone_numbers: Vec<String>,
    text: String,
    attachments: Vec<String>,
) -> Result<()> {
    if text.trim().is_empty() && attachments.is_empty() {
        return Err(bad_request(
            "Вкажіть текст повідомлення або додайте вкладення.",
        ));
    }
    let client_name = owned_client_name(name);
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
        txn,
        None,
    )
    .await
    .c(h!())?
    .ok_or_else(|| {
        conflict(
            "Обліковий запис месенджера не підключено. Підключіть його та повторіть спробу.",
        )
    })
    .c(h!())?;
    Ok(())
}

async fn load_optional_owned<C>(
    db: &C,
    client_name: &str,
) -> Result<Option<MessengerView>>
where
    C: ConnectionTrait,
{
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

pub(crate) async fn lock_integration_identity<C>(db: &C) -> Result<()>
where
    C: ConnectionTrait,
{
    db.query_one_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "select pg_advisory_xact_lock($1)",
        [MESSENGER_INTEGRATION_UNIQUENESS_LOCK_ID.into()],
    ))
    .await
    .c(h!())?;
    Ok(())
}

async fn begin_locked_integration_update_transaction(
    db: &DatabaseConnection,
    client_name: &str,
) -> Result<DatabaseTransaction> {
    loop {
        let client_id = load_client_id(db, client_name).await.c(h!())?;
        let txn = db.begin().await.c(h!())?;
        let identity_locked =
            try_lock_integration_identity(&txn).await.c(h!())?;
        let client_locked = identity_locked
            && try_lock_integration_clients(&txn, &[client_id])
                .await
                .c(h!())?;
        if client_locked
            && load_client_id(&txn, client_name).await.c(h!())? == client_id
        {
            return Ok(txn);
        }
        rollback_before_lock_retry(txn).await.c(h!())?;
    }
}

pub(crate) async fn begin_locked_integration_client_transaction(
    db: &DatabaseConnection,
    client_name: &str,
) -> Result<DatabaseTransaction> {
    loop {
        let client_id = load_client_id(db, client_name).await.c(h!())?;
        let txn = db.begin().await.c(h!())?;
        if try_lock_integration_clients(&txn, &[client_id])
            .await
            .c(h!())?
            && load_client_id(&txn, client_name).await.c(h!())? == client_id
        {
            return Ok(txn);
        }
        rollback_before_lock_retry(txn).await.c(h!())?;
    }
}

pub(crate) async fn begin_locked_integration_accounts_transaction(
    db: &DatabaseConnection,
    account_ids: &[i32],
) -> Result<DatabaseTransaction> {
    loop {
        let txn = db.begin().await.c(h!())?;
        if try_lock_integration_accounts(&txn, account_ids)
            .await
            .c(h!())?
        {
            return Ok(txn);
        }
        rollback_before_lock_retry(txn).await.c(h!())?;
    }
}

async fn rollback_before_lock_retry(txn: DatabaseTransaction) -> Result<()> {
    txn.rollback().await.c(h!())?;
    tokio::time::sleep(Duration::from_millis(
        ECHO_SWAPP_ADVISORY_LOCK_RETRY_MILLIS,
    ))
    .await;
    Ok(())
}

async fn try_lock_integration_identity<C>(db: &C) -> Result<bool>
where
    C: ConnectionTrait,
{
    let row = db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "select pg_try_advisory_xact_lock($1) as locked",
            [MESSENGER_INTEGRATION_UNIQUENESS_LOCK_ID.into()],
        ))
        .await
        .c(h!())?
        .context("integration identity lock query returned no row")
        .c(h!())?;
    row.try_get("", "locked").c(h!())
}

async fn lock_integration_client_records<C>(
    db: &C,
    client_name: &str,
) -> Result<()>
where
    C: ConnectionTrait,
{
    let client_ids = echo_client::Entity::find()
        .filter(echo_client::Column::Name.eq(client_name))
        .select_only()
        .column(echo_client::Column::Id)
        .into_tuple::<i32>()
        .all(db)
        .await
        .c(h!())?;
    lock_integration_clients(db, &client_ids).await.c(h!())
}

#[cfg(test)]
pub(crate) async fn lock_integration_accounts<C>(
    db: &C,
    account_ids: &[i32],
) -> Result<()>
where
    C: ConnectionTrait,
{
    if account_ids.is_empty() {
        return Ok(());
    }
    let client_ids = echo_client_lock::Entity::find()
        .filter(
            echo_client_lock::Column::AccountId
                .is_in(account_ids.iter().copied()),
        )
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .map(|client_lock| client_lock.client_id)
        .collect::<Vec<_>>();
    lock_integration_clients(db, &client_ids).await.c(h!())
}

pub(crate) async fn try_lock_integration_accounts<C>(
    db: &C,
    account_ids: &[i32],
) -> Result<bool>
where
    C: ConnectionTrait,
{
    if account_ids.is_empty() {
        return Ok(true);
    }
    let client_ids = echo_client_lock::Entity::find()
        .filter(
            echo_client_lock::Column::AccountId
                .is_in(account_ids.iter().copied()),
        )
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .map(|client_lock| client_lock.client_id)
        .collect::<Vec<_>>();
    try_lock_integration_clients(db, &client_ids).await.c(h!())
}

async fn lock_integration_clients<C>(db: &C, client_ids: &[i32]) -> Result<()>
where
    C: ConnectionTrait,
{
    let mut client_ids = client_ids.to_vec();
    client_ids.sort_unstable();
    client_ids.dedup();
    for client_id in client_ids {
        db.query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "select pg_advisory_xact_lock($1, $2)",
            [
                MESSENGER_INTEGRATION_OPERATION_LOCK_NAMESPACE.into(),
                client_id.into(),
            ],
        ))
        .await
        .c(h!())?;
    }
    Ok(())
}

async fn try_lock_integration_clients<C>(
    db: &C,
    client_ids: &[i32],
) -> Result<bool>
where
    C: ConnectionTrait,
{
    let mut client_ids = client_ids.to_vec();
    client_ids.sort_unstable();
    client_ids.dedup();
    for client_id in client_ids {
        let row = db
            .query_one_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "select pg_try_advisory_xact_lock($1, $2) as locked",
                [
                    MESSENGER_INTEGRATION_OPERATION_LOCK_NAMESPACE.into(),
                    client_id.into(),
                ],
            ))
            .await
            .c(h!())?
            .context("integration operation lock query returned no row")
            .c(h!())?;
        if !row.try_get("", "locked").c(h!())? {
            return Ok(false);
        }
    }
    Ok(true)
}

async fn ensure_display_name_available<C>(
    db: &C,
    display_name: &str,
    current_client_name: &str,
) -> Result<()>
where
    C: ConnectionTrait,
{
    let row = db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
            select exists (
                select 1
                from echo_client
                where deleted = false
                    and name like 'echo-swapp-%'
                    and name <> $2
                    and lower(btrim(coalesce(
                        nullif(btrim(display_name), ''),
                        regexp_replace(name, '^echo-swapp-', '')
                    ))) = lower($1)
            ) as exists
            "#,
            vec![
                display_name.to_string().into(),
                current_client_name.to_string().into(),
            ],
        ))
        .await
        .c(h!())?
        .context("integration display name uniqueness query returned no row")
        .c(h!())?;
    let exists: bool = row.try_get("", "exists").c(h!())?;
    if exists {
        return Err(conflict(format!(
            "Інтеграція з назвою «{display_name}» уже існує. Виберіть іншу назву."
        )));
    }
    Ok(())
}

async fn ensure_url_unique<C>(db: &C, client_name: &str) -> Result<()>
where
    C: ConnectionTrait,
{
    let row = db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "select count(*)::bigint as count from echo_client where deleted = false and name = $1",
            [client_name.into()],
        ))
        .await
        .c(h!())?
        .context("integration URL uniqueness query returned no row")
        .c(h!())?;
    let count: i64 = row.try_get("", "count").c(h!())?;
    if count != 1 {
        return Err(conflict(
            "URL інтеграції вже використовується. Оновіть сторінку та повторіть спробу.",
        ));
    }
    Ok(())
}

async fn dependent_automations<C>(
    db: &C,
    client_name: &str,
) -> Result<Vec<DependentAutomation>>
where
    C: ConnectionTrait,
{
    let rows = db
        .query_all_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
            select distinct
                automation.id,
                case
                    when btrim(automation.name) = '' then 'Автоматизація #' || automation.id
                    else automation.name
                end as name
            from echo_automation automation
            join echo_client_lock client_lock
                on client_lock.account_id = automation.source_account_id
                or client_lock.account_id = automation.target_account_id
            join echo_client client
                on client.id = client_lock.client_id
            where client.deleted = false
                and client.name = $1
            order by name, automation.id
            "#,
            [client_name.into()],
        ))
        .await
        .c(h!())?;
    let mut automations = Vec::with_capacity(rows.len());
    for row in rows {
        automations.push(DependentAutomation {
            id: row.try_get("", "id").c(h!())?,
            name: row.try_get("", "name").c(h!())?,
        });
    }
    Ok(automations)
}

async fn stop_dependent_automations<C>(
    db: &C,
    automations: &[DependentAutomation],
) -> Result<()>
where
    C: ConnectionTrait,
{
    for automation in automations {
        db.execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
            update echo_automation
            set
                is_paused = true,
                status = 'error',
                last_error = $2,
                updated_at = now() at time zone 'utc'
            where id = $1
            "#,
            [
                automation.id.into(),
                AUTOMATION_BROKEN_INTEGRATION_ERROR.into(),
            ],
        ))
        .await
        .c(h!())?;
    }
    Ok(())
}

async fn available_public_name<C>(db: &C, display_name: &str) -> Result<String>
where
    C: ConnectionTrait,
{
    let name = normalize_public_name(display_name);
    for suffix in 0..1000 {
        let name = public_name_with_suffix(&name, suffix);
        let client_name = owned_client_name(&name);
        if !client_exists(db, &client_name).await.c(h!())? {
            return Ok(name);
        }
    }
    Err(conflict(
        "Не вдалося підібрати унікальне ім’я месенджера. Змініть назву та повторіть спробу.",
    ))
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
    db.execute_raw(Statement::from_sql_and_values(
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
        .query_one_raw(Statement::from_sql_and_values(
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

async fn ensure_client_available<C>(db: &C, name: &str) -> Result<()>
where
    C: ConnectionTrait,
{
    let existing = echo_client::Entity::find()
        .filter(echo_client::Column::Name.eq(name))
        .filter(echo_client::Column::Deleted.eq(false))
        .one(db)
        .await
        .c(h!())?;
    if existing.is_some() {
        return Err(conflict(format!(
            "Месенджер «{name}» уже існує. Виберіть іншу назву."
        )));
    }
    Ok(())
}

async fn delete_client_locks<C>(db: &C, client_name: &str) -> Result<()>
where
    C: ConnectionTrait,
{
    let client_id = load_client_id(db, client_name).await.c(h!())?;
    echo_client_lock::Entity::delete_many()
        .filter(echo_client_lock::Column::ClientId.eq(client_id))
        .exec(db)
        .await
        .c(h!())?;
    Ok(())
}

async fn persist_relink_recovery_state(
    db: &DatabaseConnection,
    relink_recovery: &RelinkRecoveryState,
) -> Result<()> {
    validate_relink_recovery_state(relink_recovery).c(h!())?;
    let key_prefix = relink_recovery_client_key_prefix(relink_recovery);
    let existing = db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "
            select 1
            from echo_swapp_sync_state
            where left(key, char_length($1)) = $1
            limit 1
            ",
            [key_prefix.into()],
        ))
        .await
        .c(h!())?;
    if existing.is_some() {
        anyhow::bail!(
            "unfinished relink recovery already exists for {}",
            relink_recovery.client_name
        );
    }
    let key = relink_recovery_state_key(relink_recovery).c(h!())?;
    db.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "
        insert into echo_swapp_sync_state (key, paused, updated_at)
        values ($1, false, now() at time zone 'utc')
        ",
        [key.into()],
    ))
    .await
    .c(h!())?;
    Ok(())
}

async fn remove_relink_recovery_state(
    db: &DatabaseConnection,
    relink_recovery: &RelinkRecoveryState,
) -> Result<()> {
    validate_relink_recovery_state(relink_recovery).c(h!())?;
    let key_prefix = relink_recovery_client_key_prefix(relink_recovery);
    db.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "
        delete from echo_swapp_sync_state
        where left(key, char_length($1)) = $1
        ",
        [key_prefix.into()],
    ))
    .await
    .c(h!())?;
    Ok(())
}

async fn relink_recovery_states(
    db: &DatabaseConnection,
) -> Result<Vec<RelinkRecoveryState>> {
    let rows = db
        .query_all_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "
            select key
            from echo_swapp_sync_state
            where left(key, char_length($1)) = $1
            order by updated_at, key
            ",
            [MESSENGER_INTEGRATION_RELINK_STATE_PREFIX.into()],
        ))
        .await
        .c(h!())?;
    let mut recovery_states = Vec::with_capacity(rows.len());
    for row in rows {
        let key: String = row.try_get("", "key").c(h!())?;
        recovery_states.push(relink_recovery_state_from_key(&key).c(h!())?);
    }
    Ok(recovery_states)
}

fn relink_recovery_state_key(
    relink_recovery: &RelinkRecoveryState,
) -> Result<String> {
    validate_relink_recovery_state(relink_recovery).c(h!())?;
    let state = serde_json::to_vec(relink_recovery).c(h!())?;
    Ok(format!(
        "{}{}",
        relink_recovery_client_key_prefix(relink_recovery),
        general_purpose::URL_SAFE_NO_PAD.encode(state)
    ))
}

fn relink_recovery_state_from_key(key: &str) -> Result<RelinkRecoveryState> {
    let state = key
        .strip_prefix(MESSENGER_INTEGRATION_RELINK_STATE_PREFIX)
        .context("invalid relink recovery state key")
        .c(h!())?;
    let (client_name, state) = state
        .split_once(':')
        .context("invalid relink recovery state key")
        .c(h!())?;
    let state = general_purpose::URL_SAFE_NO_PAD.decode(state).c(h!())?;
    let relink_recovery: RelinkRecoveryState =
        serde_json::from_slice(&state).c(h!())?;
    validate_relink_recovery_state(&relink_recovery).c(h!())?;
    if relink_recovery.client_name != client_name {
        anyhow::bail!("relink recovery client name does not match its key");
    }
    Ok(relink_recovery)
}

fn relink_recovery_client_key_prefix(
    relink_recovery: &RelinkRecoveryState,
) -> String {
    format!(
        "{MESSENGER_INTEGRATION_RELINK_STATE_PREFIX}{}:",
        relink_recovery.client_name
    )
}

fn validate_relink_recovery_state(
    relink_recovery: &RelinkRecoveryState,
) -> Result<()> {
    let public_name = public_client_name(&relink_recovery.client_name)
        .context("invalid relink recovery client name")
        .c(h!())?;
    validate_name(&public_name).c(h!())?;
    validate_client_data_backup_token(&relink_recovery.backup_token).c(h!())?;
    Ok(())
}

fn validate_client_data_backup_token(backup_token: &str) -> Result<()> {
    let mut parts = backup_token.split('.');
    for _ in 0..3 {
        let part = parts
            .next()
            .context("invalid client data backup token")
            .c(h!())?;
        if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
            anyhow::bail!("invalid client data backup token");
        }
    }
    if parts.next().is_some() {
        anyhow::bail!("invalid client data backup token");
    }
    Ok(())
}

async fn backup_client_data(
    config: &Config,
    kind: MessengerKind,
    client_name: &str,
    backup_token: &str,
) -> Result<ClientDataBackup> {
    let original_path = client_data_path(config, kind, client_name);
    let backup_path = client_data_backup_path(&original_path, backup_token);
    if original_path.exists() {
        tokio::fs::rename(&original_path, &backup_path)
            .await
            .c(h!())?;
    } else {
        tokio::fs::create_dir_all(&backup_path).await.c(h!())?;
    }
    let create_result = tokio::fs::create_dir_all(&original_path).await.c(h!());
    if let Err(err) = create_result {
        if original_path.exists() {
            if let Err(remove_err) =
                tokio::fs::remove_dir_all(&original_path).await.c(h!())
            {
                log::error!(
                    "failed to remove partial client data directory: {remove_err:#}"
                );
            }
        }
        if let Err(restore_err) =
            tokio::fs::rename(&backup_path, &original_path)
                .await
                .c(h!())
        {
            log::error!(
                "failed to restore client data after backup preparation failure: {restore_err:#}"
            );
        }
        return Err(err);
    }
    Ok(ClientDataBackup {
        original_path,
        backup_path,
    })
}

async fn backup_replacement_client_data(
    config: &Config,
    current_kind: MessengerKind,
    replacement_kind: MessengerKind,
    client_name: &str,
    backup_token: &str,
) -> Result<ClientDataBackups> {
    let current =
        backup_client_data(config, current_kind, client_name, backup_token)
            .await
            .c(h!())?;
    let replacement_path =
        client_data_path(config, replacement_kind, client_name);
    let replacement = if replacement_path != current.original_path {
        match backup_client_data(
            config,
            replacement_kind,
            client_name,
            backup_token,
        )
        .await
        .c(h!())
        {
            Ok(replacement) => Some(replacement),
            Err(err) => {
                if let Err(restore_err) =
                    restore_client_data(&current).await.c(h!())
                {
                    log::error!(
                        "failed to restore current client data after destination backup failure: {restore_err:#}"
                    );
                }
                return Err(err);
            }
        }
    } else {
        None
    };
    Ok(ClientDataBackups {
        paths: std::iter::once(current).chain(replacement).collect(),
    })
}

fn client_data_backup_token() -> Result<String> {
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .c(h!())?
        .as_nanos();
    let sequence = CLIENT_DATA_BACKUP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    Ok(format!("{}.{}.{sequence}", std::process::id(), created_at))
}

fn client_data_backup_path(
    original_path: &Path,
    backup_token: &str,
) -> PathBuf {
    let mut backup_path = original_path.as_os_str().to_owned();
    backup_path.push(format!(
        "{MESSENGER_INTEGRATION_CLIENT_DATA_BACKUP_SUFFIX}.{backup_token}"
    ));
    PathBuf::from(backup_path)
}

fn relink_client_data_backups(
    config: &Config,
    relink_recovery: &RelinkRecoveryState,
) -> ClientDataBackups {
    let current = client_data_backup(
        config,
        relink_recovery.previous_kind,
        &relink_recovery.client_name,
        &relink_recovery.backup_token,
    );
    let replacement = client_data_backup(
        config,
        relink_recovery.replacement_kind,
        &relink_recovery.client_name,
        &relink_recovery.backup_token,
    );
    let replacement = (replacement.original_path != current.original_path)
        .then_some(replacement);
    ClientDataBackups {
        paths: std::iter::once(current).chain(replacement).collect(),
    }
}

fn client_data_backup(
    config: &Config,
    kind: MessengerKind,
    client_name: &str,
    backup_token: &str,
) -> ClientDataBackup {
    let original_path = client_data_path(config, kind, client_name);
    let backup_path = client_data_backup_path(&original_path, backup_token);
    ClientDataBackup {
        original_path,
        backup_path,
    }
}

async fn restore_client_data(backup: &ClientDataBackup) -> Result<()> {
    if backup.original_path.exists() {
        tokio::fs::remove_dir_all(&backup.original_path)
            .await
            .c(h!())?;
    }
    tokio::fs::rename(&backup.backup_path, &backup.original_path)
        .await
        .c(h!())?;
    Ok(())
}

async fn restore_client_data_backups_if_present(
    backups: &ClientDataBackups,
) -> Result<()> {
    let mut result = Ok(());
    for backup in &backups.paths {
        let restore_result = if backup.backup_path.exists() {
            restore_client_data(backup).await.c(h!())
        } else {
            Ok(())
        };
        if result.is_ok() {
            result = restore_result;
        } else if let Err(err) = restore_result {
            log::error!("failed to restore additional client data: {err:#}");
        }
    }
    result
}

async fn discard_client_data_backup(backup: &ClientDataBackup) -> Result<()> {
    tokio::fs::remove_dir_all(&backup.backup_path)
        .await
        .c(h!())?;
    Ok(())
}

async fn discard_client_data_backups(
    backups: &ClientDataBackups,
) -> Result<()> {
    let mut result = Ok(());
    for backup in &backups.paths {
        let discard_result = if backup.backup_path.exists() {
            discard_client_data_backup(backup).await.c(h!())
        } else {
            Ok(())
        };
        if result.is_ok() {
            result = discard_result;
        } else if let Err(err) = discard_result {
            log::error!("failed to discard additional client data: {err:#}");
        }
    }
    result
}

async fn update_client_config<C>(
    db: &C,
    config: &Config,
    client_name: &str,
    kind: MessengerKind,
) -> Result<()>
where
    C: ConnectionTrait,
{
    let client_id = load_client_id(db, client_name).await.c(h!())?;
    let client_config = echo_client_config::Entity::find()
        .filter(echo_client_config::Column::ClientId.eq(client_id))
        .one(db)
        .await
        .c(h!())?
        .context("integration echo client config not found")
        .c(h!())?;
    let mut client_config = client_config.into_active_model();
    client_config.process_name =
        Set(client_process_name(config, kind, client_name));
    client_config.signal_api_attachment_path =
        Set(client_attachment_path(config, kind, client_name));
    client_config.whatsapp_app_name = Set(client_name.to_string());
    client_config.is_configured = Set(false);
    client_config.update(db).await.c(h!())?;
    Ok(())
}

async fn load_client_id<C>(db: &C, client_name: &str) -> Result<i32>
where
    C: ConnectionTrait,
{
    let client = echo_client::Entity::find()
        .filter(echo_client::Column::Name.eq(client_name))
        .filter(echo_client::Column::Deleted.eq(false))
        .one(db)
        .await
        .c(h!())?
        .context("integration echo client not found")
        .c(h!())?;
    Ok(client.id)
}

async fn load_client_port<C>(db: &C, client_name: &str) -> Result<i32>
where
    C: ConnectionTrait,
{
    let client_id = load_client_id(db, client_name).await.c(h!())?;
    let client_config = echo_client_config::Entity::find()
        .filter(echo_client_config::Column::ClientId.eq(client_id))
        .one(db)
        .await
        .c(h!())?
        .context("integration echo client config not found")
        .c(h!())?;
    Ok(client_config.signal_port)
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
    let message = "Сервіс Signal тимчасово недоступний. Зачекайте кілька секунд і повторіть спробу. Якщо помилка не зникне, зверніться до адміністратора.";
    match last_err {
        Some(err) => Err(service_unavailable_with_source(message, err)),
        None => Err(service_unavailable(message)),
    }
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
                &SignalCliMode::Normal,
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

async fn stop_client_process(
    config: &Config,
    kind: MessengerKind,
    name: &str,
) -> Result<()> {
    let unit_name = client_process_name(config, kind, name);
    for action in ["stop", "disable"] {
        let status = Command::new("sudo")
            .args(["-S", "-n", "systemctl", action, &unit_name])
            .status()
            .c(h!())?;
        if !status.success() {
            anyhow::bail!(
                "failed to {action} messenger process {unit_name}: {status}"
            );
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
        return Err(bad_request(
            "Ім’я має містити 3–50 малих латинських літер, цифр, дефісів або підкреслень.",
        ));
    }
    if name.starts_with(OWNED_CLIENT_PREFIX) {
        return Err(bad_request(format!(
            "Ім’я не може починатися із зарезервованого префікса {OWNED_CLIENT_PREFIX}."
        )));
    }
    Ok(())
}

fn normalize_display_name(name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(bad_request("Вкажіть назву інтеграції."));
    }
    Ok(name.to_string())
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

fn normalize_phone(phone: &str) -> Result<String> {
    let phone = phone
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .collect::<String>();
    let phone = if Regex::new(r"^0\d{9}$").c(h!())?.is_match(&phone) {
        format!("+38{phone}")
    } else {
        phone
    };
    let re = Regex::new(r"^\+380\d{9}$").c(h!())?;
    if !re.is_match(&phone) {
        return Err(bad_request(
            "Введіть номер телефону у форматі +380XXXXXXXXX або 0XXXXXXXXX.",
        ));
    }
    Ok(phone)
}

fn unit_name(config: &Config, kind: MessengerKind) -> &str {
    match kind {
        MessengerKind::Signal => config.signal_unit_name(),
        MessengerKind::Whatsapp => config.whatsapp_unit_name(),
    }
}

fn client_process_name(
    config: &Config,
    kind: MessengerKind,
    client_name: &str,
) -> String {
    format!("{}@{client_name}", unit_name(config, kind))
}

fn client_attachment_path(
    config: &Config,
    kind: MessengerKind,
    client_name: &str,
) -> String {
    format!(
        "{}/{}/{}/attachments/",
        client_dir(config, kind),
        client_name,
        cli_dir_name(kind),
    )
}

fn client_data_path(
    config: &Config,
    kind: MessengerKind,
    client_name: &str,
) -> PathBuf {
    PathBuf::from(client_dir(config, kind)).join(client_name)
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

async fn sync_is_paused<C>(db: &C, client_name: &str) -> Result<bool>
where
    C: ConnectionTrait,
{
    Ok(sync_state_is_paused(db, GLOBAL_SYNC_STATE_KEY)
        .await
        .c(h!())?
        || is_client_paused(db, client_name).await.c(h!())?)
}

async fn is_client_paused<C>(db: &C, client_name: &str) -> Result<bool>
where
    C: ConnectionTrait,
{
    sync_state_is_paused(db, &client_sync_state_key(client_name)).await
}

async fn sync_state_is_paused<C>(db: &C, key: &str) -> Result<bool>
where
    C: ConnectionTrait,
{
    let row = db
        .query_one_raw(Statement::from_sql_and_values(
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
    db.execute_raw(Statement::from_sql_and_values(
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

    #[test]
    fn normalizes_ukrainian_phone_numbers() {
        assert_eq!(
            normalize_phone(" +380 50 123 45 67 ").unwrap(),
            "+380501234567"
        );
        assert_eq!(normalize_phone("050 123 45 67").unwrap(), "+380501234567");
    }

    #[test]
    fn rejects_invalid_phone_numbers() {
        for phone in [
            "380501234567",
            "+381501234567",
            "050123456",
            "050-123-45-67",
        ] {
            assert!(normalize_phone(phone).is_err(), "{phone}");
        }
    }

    #[test]
    fn update_confirmation_defaults_to_false() {
        let req: UpdateMessengerReq =
            serde_json::from_value(serde_json::json!({
                "name": "Signal",
                "kind": "signal",
                "phone": "+380501234567"
            }))
            .unwrap();
        assert!(!req.stop_dependent_automations);
    }

    #[test]
    fn creates_unique_client_data_backup_paths() {
        let original_path = std::path::Path::new("/tmp/echo-swapp-client");
        let first_token = client_data_backup_token().unwrap();
        let second_token = client_data_backup_token().unwrap();
        let first = client_data_backup_path(original_path, &first_token);
        let second = client_data_backup_path(original_path, &second_token);
        assert_ne!(first, second);
        assert!(first
            .to_string_lossy()
            .contains(MESSENGER_INTEGRATION_CLIENT_DATA_BACKUP_SUFFIX));
    }

    #[test]
    fn relink_recovery_state_round_trips_database_key() {
        let relink_recovery = RelinkRecoveryState {
            client_name: "echo-swapp-test".to_string(),
            previous_kind: MessengerKind::Signal,
            previous_phone: Some("+380501234567".to_string()),
            replacement_kind: MessengerKind::Whatsapp,
            replacement_phone: "+380671234567".to_string(),
            signal_port: 8010,
            backup_token: "1.2.3".to_string(),
        };

        let key = relink_recovery_state_key(&relink_recovery).unwrap();

        assert_eq!(
            relink_recovery_state_from_key(&key).unwrap(),
            relink_recovery
        );
    }

    #[tokio::test]
    async fn interrupted_restore_preserves_data_before_backup() {
        let root = std::env::temp_dir().join(format!(
            "echo-swapp-relink-test-{}",
            client_data_backup_token().unwrap()
        ));
        let original_path = root.join("client");
        let backup_path = root.join("client.relink-backup");
        tokio::fs::create_dir_all(&original_path).await.unwrap();
        tokio::fs::write(original_path.join("credentials"), b"old")
            .await
            .unwrap();
        let backups = ClientDataBackups {
            paths: vec![ClientDataBackup {
                original_path: original_path.clone(),
                backup_path,
            }],
        };

        restore_client_data_backups_if_present(&backups)
            .await
            .unwrap();

        assert_eq!(
            tokio::fs::read(original_path.join("credentials"))
                .await
                .unwrap(),
            b"old"
        );
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn interrupted_restore_replaces_partial_data_with_backup() {
        let root = std::env::temp_dir().join(format!(
            "echo-swapp-relink-test-{}",
            client_data_backup_token().unwrap()
        ));
        let original_path = root.join("client");
        let backup_path = root.join("client.relink-backup");
        tokio::fs::create_dir_all(&backup_path).await.unwrap();
        tokio::fs::write(backup_path.join("credentials"), b"old")
            .await
            .unwrap();
        tokio::fs::create_dir_all(&original_path).await.unwrap();
        tokio::fs::write(original_path.join("credentials"), b"partial")
            .await
            .unwrap();
        let backups = ClientDataBackups {
            paths: vec![ClientDataBackup {
                original_path: original_path.clone(),
                backup_path,
            }],
        };

        restore_client_data_backups_if_present(&backups)
            .await
            .unwrap();

        assert_eq!(
            tokio::fs::read(original_path.join("credentials"))
                .await
                .unwrap(),
            b"old"
        );
        tokio::fs::remove_dir_all(root).await.unwrap();
    }
}
