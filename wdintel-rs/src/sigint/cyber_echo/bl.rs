use super::query;
use super::tus::TusHandler;
use super::types::{
    CreateCyberEchoSignalMessagePayload, CreateCyberEchoSignalMessageRsp,
};
use crate::config::FEATURE_DELETE_UPLOADED_ATTACHMENT_DEFAULT;
use crate::error::AppError;
use crate::types::*;
use chrono::Utc;
use sea_orm::TransactionTrait;

pub async fn create_signal_message(
    login: &str,
    env: &Env,
    payload: CreateCyberEchoSignalMessagePayload,
) -> Result<CreateCyberEchoSignalMessageRsp, AppError> {
    crate::system_settings::ensure_cyber_echo_enabled(&env.dbx)
        .await
        .c(h!())?;

    let body = payload.body.trim().replace("\r\n", "\n");
    if body.is_empty() {
        return Err(AppError::BL {
            msg: "message body cannot be empty".to_string(),
        });
    }

    let upload_urls = payload.upload_urls.clone().unwrap_or_default();
    if !upload_urls.is_empty()
        && (env.config.s3_config.is_none() || env.s3.is_none())
    {
        return Err(AppError::BL {
            msg: "s3 config is required for attachment upload".to_string(),
        });
    }

    let txn = env.dbx.begin().await.c(h!())?;
    let signal_group = query::find_available_signal_group(
        &txn,
        login,
        &payload.signal_group_master_key,
    )
    .await
    .c(h!())?;
    let sender_uuid = query::ensure_current_user_sender(&txn, login)
        .await
        .c(h!())?;
    query::validate_computer_name_id(&txn, payload.computer_name_id)
        .await
        .c(h!())?;

    let tus_handler = TusHandler::new(
        env.config.storage_dir.clone(),
        super::CYBER_ECHO_TUS_PATH_BASE,
    );
    let uploads = tus_handler
        .resolve_completed_uploads(login, &upload_urls)
        .await
        .c(h!())?;

    let datasource_group_id =
        query::ensure_datasource_group_id(&txn, &signal_group.master_key)
            .await
            .c(h!())?;
    let signal_message = query::insert_signal_message(
        &txn,
        body,
        Utc::now().naive_utc(),
        Some(sender_uuid),
        datasource_group_id,
    )
    .await
    .c(h!())?;
    query::insert_signal_message_group(
        &txn,
        &signal_group.master_key,
        &signal_message,
    )
    .await
    .c(h!())?;
    let signal_message = crate::messenger::id::update_message_with_uid(
        &txn,
        &env.config,
        signal_message,
    )
    .await
    .c(h!())?;

    let media = crate::messenger::media::store_media_attachments(
        &uploads,
        signal_message.id,
        &env.config,
        &env.s3,
        &txn,
        env.config
            .feature_delete_uploaded_attachment
            .unwrap_or(FEATURE_DELETE_UPLOADED_ATTACHMENT_DEFAULT),
    )
    .await
    .c(h!())?;

    let changed_inbox_item_ids =
        crate::rer_importer::bgworker::process_message_to_inbox(
            env.settlements.clone(),
            &txn,
            &env.rq,
            &env.config,
            signal_message.id,
            None,
        )
        .await
        .c(h!())?;
    let inbox_item_id =
        changed_inbox_item_ids.first().copied().ok_or_else(|| {
            AppError::BL {
                msg: "message was not converted to inbox item".to_string(),
            }
        })?;
    query::set_inbox_items_computer_name(
        &txn,
        changed_inbox_item_ids.clone(),
        payload.computer_name_id,
    )
    .await
    .c(h!())?;

    crate::sigint::worker::incoming_message_after_insert(
        &txn,
        signal_message.id,
    )
    .await
    .c(h!())?;

    txn.commit().await.c(h!())?;

    let mut redis = env.redis.clone();
    crate::inbox::fanout_inbox_changes(&mut redis, changed_inbox_item_ids)
        .await
        .c(h!())?;

    Ok(CreateCyberEchoSignalMessageRsp {
        signal_message_id: signal_message.id,
        message_uid: signal_message.message_uid,
        inbox_item_id,
        media_ids: media.into_iter().map(|media| media.id).collect(),
    })
}
