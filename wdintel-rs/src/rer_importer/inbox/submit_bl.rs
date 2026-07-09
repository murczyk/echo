use crate::entities::datasource;
use crate::error::AppError;
use crate::rer_importer::types::*;
use crate::types::*;
use actix_identity::Identity;
use actix_web::web::Data;
use sea_orm::*;

#[derive(Debug)]
pub(crate) struct SubmittedInboxItem {
    pub(crate) message_uid: String,
    pub(crate) inbox_id: i64,
    pub(crate) warnings: Vec<InboxSubmitWarning>,
}

pub(crate) async fn submit_generic_inbox(
    user: Identity,
    env: &Data<Env>,
    item: InboxSubmitItem,
) -> Result<GenericInboxSubmitRsp, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_any_role(
        &env.dbx,
        &login,
        vec!["Rer", "Api", "ApiAgent"],
    )
    .await
    .c(h!())?;
    let logins = crate::users::get_organism_logins(&env.dbx, user)
        .await
        .context(h!())?;
    let submitted =
        submit_generic_inbox_message(env, &login, &logins, item).await?;
    Ok(GenericInboxSubmitRsp {
        message_uid: submitted.message_uid,
        warnings: submitted.warnings,
    })
}

pub(crate) async fn submit_generic_inbox_message(
    env: &Data<Env>,
    login: &str,
    logins: &Vec<String>,
    item: InboxSubmitItem,
) -> Result<SubmittedInboxItem, AppError> {
    let txn = env.dbx.begin().await.c(h!())?;
    let datasource = datasource::Entity::find()
        .filter(datasource::Column::ApiLogin.eq(login))
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
    login: &str,
    logins: &Vec<String>,
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
    let tag_ids =
        super::resolve_submit_tag_ids(txn, item.tags.as_deref()).await?;
    let operator_tags = super::submit_operator_tags(item.tags.as_deref())?;
    let (mut message, timestamp) =
        super::generic_submit_item_to_inbox_message(&item)?;
    let post = super::normalized_optional_string(message.post.as_deref());
    let post_id = match message.post_id {
        Some(post_id) => Some(post_id),
        None => crate::sigint::post::get_or_create_post_id(txn, &post)
            .await
            .c(h!())?,
    };
    message.group_master_key = groups.first().map(|(key, _)| key.clone());
    message.post = post;
    message.post_id = post_id;
    super::prepare_submit_body_for_coordinate_extraction(&mut message)?;

    let signal_message = super::upsert_submit_signal_message(
        txn,
        &env.config,
        datasource.id,
        item.message_uid.as_deref(),
        &message,
        Some(timestamp),
        operator_tags,
        &groups,
    )
    .await
    .c(h!())?;
    let message_uid = signal_message.message_uid.clone().c(h!())?;
    let inbox_id = super::submit_upsert_inbox_item(
        env.settlements.clone(),
        txn,
        signal_message.id,
        &message,
        login,
        logins,
        super::InboxLocationSubmitMode::Parse,
    )
    .await
    .c(h!())?;
    super::add_submit_tags(txn, inbox_id, login, tag_ids)
        .await
        .c(h!())?;
    let InboxSubmitItem { network, dmr, .. } = item;
    let warnings =
        super::save_submit_dmr_metadata(inbox_id, network.as_ref(), dmr, txn)
            .await
            .c(h!())?;

    Ok(SubmittedInboxItem {
        message_uid,
        inbox_id,
        warnings,
    })
}
