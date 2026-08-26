use crate::entities::datasource;
use crate::error::AppError;
use crate::rer_importer::types::*;
use crate::types::*;
use crate::users::{has_any_role, login_id_from_identity};
use actix_identity::Identity;
use actix_web::web::Data;
use sea_orm::*;

#[derive(Debug)]
pub(crate) struct SubmittedInboxItem {
    pub(crate) signal_message_id: i64,
    pub(crate) signal_message_uuid: Option<uuid::Uuid>,
    pub(crate) inbox_id: i64,
    pub(crate) warnings: Vec<InboxSubmitWarning>,
}

pub(crate) async fn submit_generic_inbox(
    user: Identity,
    env: &Data<Env>,
    item: InboxSubmitItem,
) -> Result<GenericInboxSubmitRsp, AppError> {
    has_any_role(
        &env.dbx,
        &login_id_from_identity(&user)?,
        vec!["Rer", "Api", "ApiAgent"],
    )
    .await
    .c(h!())?;
    let login = login_id_from_identity(&user)?;
    let logins = crate::users::get_organism_login_ids(&env.dbx, user)
        .await
        .context(h!())?;
    let submitted =
        submit_generic_inbox_message(env, &login, &logins, item).await?;
    Ok(GenericInboxSubmitRsp {
        warnings: submitted.warnings,
    })
}

pub(crate) async fn submit_generic_inbox_message(
    env: &Data<Env>,
    login: &uuid::Uuid,
    logins: &Vec<uuid::Uuid>,
    item: InboxSubmitItem,
) -> Result<SubmittedInboxItem, AppError> {
    let txn = env.dbx.begin().await.c(h!())?;
    let datasource = datasource::Entity::find()
        .filter(datasource::Column::ApiLoginId.eq(*login))
        .filter(datasource::Column::Enabled.eq(true))
        .filter(datasource::Column::Deleted.eq(false))
        .one(&txn)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    let submitted =
        submit_generic_inbox_item(env, &txn, &datasource, login, logins, item)
            .await
            .c(h!())?;
    let inbox_id = submitted.inbox_id;

    txn.commit().await.c(h!())?;
    super::fanout_inbox_changed(env, vec![inbox_id]).await;
    Ok(submitted)
}

pub(crate) async fn submit_generic_inbox_item(
    env: &Data<Env>,
    txn: &DatabaseTransaction,
    datasource: &datasource::Model,
    login: &uuid::Uuid,
    logins: &Vec<uuid::Uuid>,
    item: InboxSubmitItem,
) -> Result<SubmittedInboxItem, AppError> {
    super::validate_generic_submit_item(&item)?;
    let groups = super::ensure_submit_groups(
        txn,
        datasource,
        login,
        item.group_names.as_deref().unwrap_or(&[]),
    )
    .await
    .c(h!())?;
    submit_inbox_item_with_groups(
        env.as_ref(),
        txn,
        Some(datasource.id),
        &groups,
        login,
        logins,
        item,
        false,
    )
    .await
}

pub(crate) async fn submit_inbox_item_with_groups(
    env: &Env,
    txn: &DatabaseTransaction,
    datasource_id: Option<i64>,
    groups: &[(String, i64)],
    login: &uuid::Uuid,
    logins: &Vec<uuid::Uuid>,
    item: InboxSubmitItem,
    allow_empty_content: bool,
) -> Result<SubmittedInboxItem, AppError> {
    submit_inbox_item_with_groups_location_mode(
        env,
        txn,
        datasource_id,
        groups,
        login,
        logins,
        item,
        allow_empty_content,
        false,
        super::InboxLocationSubmitMode::Parse,
    )
    .await
}

pub(crate) async fn submit_inbox_item_with_groups_location_mode(
    env: &Env,
    txn: &DatabaseTransaction,
    datasource_id: Option<i64>,
    groups: &[(String, i64)],
    login: &uuid::Uuid,
    logins: &Vec<uuid::Uuid>,
    item: InboxSubmitItem,
    allow_empty_content: bool,
    keep_timestamp_missing: bool,
    location_mode: super::InboxLocationSubmitMode,
) -> Result<SubmittedInboxItem, AppError> {
    submit_inbox_item_with_groups_inner(
        &env.config,
        env.settlements.clone(),
        txn,
        datasource_id,
        groups,
        login,
        logins,
        item,
        None,
        allow_empty_content,
        keep_timestamp_missing,
        location_mode,
    )
    .await
}

pub(crate) async fn submit_inbox_item_with_groups_location_mode_context(
    config: &crate::config::Config,
    settlements: Arc<RwLock<crate::location::SettlementsDataConfig>>,
    txn: &DatabaseTransaction,
    datasource_id: Option<i64>,
    groups: &[(String, i64)],
    login: &uuid::Uuid,
    logins: &Vec<uuid::Uuid>,
    item: InboxSubmitItem,
    allow_empty_content: bool,
    keep_timestamp_missing: bool,
    location_mode: super::InboxLocationSubmitMode,
) -> Result<SubmittedInboxItem, AppError> {
    submit_inbox_item_with_groups_inner(
        config,
        settlements,
        txn,
        datasource_id,
        groups,
        login,
        logins,
        item,
        None,
        allow_empty_content,
        keep_timestamp_missing,
        location_mode,
    )
    .await
}

pub(crate) async fn edit_inbox_item_with_groups_location_mode(
    env: &Env,
    txn: &DatabaseTransaction,
    signal_message_id: i64,
    datasource_id: Option<i64>,
    groups: &[(String, i64)],
    login: &uuid::Uuid,
    logins: &Vec<uuid::Uuid>,
    item: InboxSubmitItem,
    allow_empty_content: bool,
    keep_timestamp_missing: bool,
    location_mode: super::InboxLocationSubmitMode,
) -> Result<SubmittedInboxItem, AppError> {
    submit_inbox_item_with_groups_inner(
        &env.config,
        env.settlements.clone(),
        txn,
        datasource_id,
        groups,
        login,
        logins,
        item,
        Some(signal_message_id),
        allow_empty_content,
        keep_timestamp_missing,
        location_mode,
    )
    .await
}

async fn submit_inbox_item_with_groups_inner(
    config: &crate::config::Config,
    settlements: Arc<RwLock<crate::location::SettlementsDataConfig>>,
    txn: &DatabaseTransaction,
    datasource_id: Option<i64>,
    groups: &[(String, i64)],
    login: &uuid::Uuid,
    logins: &Vec<uuid::Uuid>,
    item: InboxSubmitItem,
    signal_message_id: Option<i64>,
    allow_empty_content: bool,
    keep_timestamp_missing: bool,
    location_mode: super::InboxLocationSubmitMode,
) -> Result<SubmittedInboxItem, AppError> {
    let mut prepared = prepare_inbox_submit_item(
        txn,
        groups,
        &item,
        allow_empty_content,
        keep_timestamp_missing,
    )
    .await?;

    if let Some(signal_message_id) = signal_message_id {
        delete_cleared_edit_comment(
            txn,
            signal_message_id,
            login,
            logins,
            &mut prepared.message,
        )
        .await?;
    }

    let signal_message = match signal_message_id {
        Some(signal_message_id) => super::update_submit_signal_message(
            txn,
            config,
            signal_message_id,
            login,
            &prepared.message,
            prepared.timestamp,
            prepared.operator_tags,
            groups,
        )
        .await
        .c(h!())?,
        None => super::upsert_submit_signal_message(
            txn,
            config,
            datasource_id,
            login,
            None,
            &prepared.message,
            prepared.timestamp,
            prepared.operator_tags,
            groups,
        )
        .await
        .c(h!())?,
    };
    let inbox_id = super::submit_upsert_inbox_item(
        settlements,
        txn,
        signal_message.id,
        &prepared.message,
        login,
        logins,
        location_mode,
        item.parse_body_coordinates,
        signal_message_id.is_some(),
    )
    .await
    .c(h!())?;
    match signal_message_id {
        Some(_) => {
            super::replace_submit_tags(
                txn,
                inbox_id,
                signal_message.id_uuid,
                login,
                prepared.tag_ids,
            )
            .await
            .c(h!())?;
        }
        None => {
            super::add_submit_tags(
                txn,
                inbox_id,
                signal_message.id_uuid,
                login,
                prepared.tag_ids,
            )
            .await
            .c(h!())?;
        }
    }
    let InboxSubmitItem { network, dmr, .. } = item;
    let warnings = super::save_submit_dmr_metadata(
        inbox_id,
        signal_message.id_uuid,
        network.as_ref(),
        dmr,
        txn,
    )
    .await
    .c(h!())?;
    crate::stats::enqueue_group_stats_recalculation_for_message(
        txn,
        signal_message.id,
        format!("submitted inbox message {}", signal_message.id),
    )
    .await
    .c(h!())?;

    Ok(SubmittedInboxItem {
        signal_message_id: signal_message.id,
        signal_message_uuid: signal_message.id_uuid,
        inbox_id,
        warnings,
    })
}

async fn delete_cleared_edit_comment(
    txn: &DatabaseTransaction,
    signal_message_id: i64,
    login: &uuid::Uuid,
    logins: &[uuid::Uuid],
    message: &mut InboxMessage,
) -> Result<(), AppError> {
    if message
        .extended_form
        .as_deref()
        .is_some_and(|comment| !comment.trim().is_empty())
    {
        return Ok(());
    }
    super::delete_editable_linked_message_comments(
        txn,
        signal_message_id,
        login,
        logins,
    )
    .await
    .c(h!())?;
    super::delete_editable_sigint_comments(
        txn,
        signal_message_id,
        login,
        logins,
    )
    .await
    .c(h!())?;
    message.extended_form = None;
    Ok(())
}

struct PreparedInboxSubmitItem {
    message: InboxMessage,
    timestamp: Option<chrono::NaiveDateTime>,
    tag_ids: Option<Vec<i64>>,
    operator_tags: Option<serde_json::Value>,
}

async fn prepare_inbox_submit_item(
    txn: &DatabaseTransaction,
    groups: &[(String, i64)],
    item: &InboxSubmitItem,
    allow_empty_content: bool,
    keep_timestamp_missing: bool,
) -> Result<PreparedInboxSubmitItem, AppError> {
    super::validate_submit_item_content(item)?;
    let tag_ids =
        super::resolve_submit_tag_ids(txn, item.tags.as_deref()).await?;
    let operator_tags = super::submit_operator_tags(item.tags.as_deref())?;
    let (mut message, timestamp) =
        super::generic_submit_item_to_inbox_message(item, allow_empty_content)?;
    let timestamp = if keep_timestamp_missing {
        message.date = None;
        message.time = None;
        message.timestamp = None;
        None
    } else {
        Some(timestamp)
    };
    let post = super::normalized_optional_string(message.post.as_deref());
    message.post_id = match message.post_id {
        Some(post_id) => Some(post_id),
        None => crate::sigint::post::get_or_create_post_id(txn, &post)
            .await
            .c(h!())?,
    };
    message.group_master_key = groups.first().map(|(key, _)| key.clone());
    message.post = post;
    super::prepare_submit_body_for_coordinate_extraction(&mut message)?;
    Ok(PreparedInboxSubmitItem {
        message,
        timestamp,
        tag_ids,
        operator_tags,
    })
}
