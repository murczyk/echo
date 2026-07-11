use super::query;
use super::types::{DirectSubmitPayload, DirectSubmitRsp};
use crate::config::FEATURE_DELETE_UPLOADED_ATTACHMENT_DEFAULT;
use crate::error::AppError;
use crate::rer_importer::types::InboxSubmitItem;
use crate::types::*;
use chrono::{SecondsFormat, Utc};
use sea_orm::TransactionTrait;

pub async fn submit_signal_message(
    login: &str,
    env: &Env,
    payload: DirectSubmitPayload,
) -> Result<DirectSubmitRsp, AppError> {
    if payload
        .full_body
        .as_deref()
        .is_none_or(|body| body.trim().is_empty())
        && payload
            .text
            .as_deref()
            .is_none_or(|body| body.trim().is_empty())
    {
        return Err(AppError::BL {
            msg: "full_body or text cannot be empty".to_string(),
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
    .await?;
    let sender_uuid = query::ensure_current_user_sender(&txn, login)
        .await
        .c(h!())?;
    if let Some(device_name_id) = payload.device_name_id {
        query::validate_device_name_id(&txn, device_name_id).await?;
    }
    let logins = crate::users::get_organism_logins_by_login(&txn, login)
        .await
        .c(h!())?;

    let tus_handler = crate::sigint::file_upload::tus::TusHandler::new(
        env.config.storage_dir.clone(),
        crate::sigint::file_upload::TUS_PATH_BASE,
    );
    let uploads = tus_handler
        .resolve_completed_uploads(login, &upload_urls)
        .await
        .c(h!())?;
    let delete_uploaded_attachments = env
        .config
        .feature_delete_uploaded_attachment
        .unwrap_or(FEATURE_DELETE_UPLOADED_ATTACHMENT_DEFAULT);

    let datasource_id = signal_group.datasource_id.unwrap_or(
        query::resolve_datasource_id_for_group(&txn, &signal_group.master_key)
            .await
            .c(h!())?,
    );
    let datasource_group_id =
        crate::messenger::group::ensure_datasource_group_id(
            &txn,
            signal_group.master_key.clone(),
            datasource_id,
        )
        .await
        .c(h!())?;
    let submit_item =
        direct_submit_payload_to_item(&payload, sender_uuid).c(h!())?;
    let submitted =
        crate::rer_importer::inbox::submit_bl::submit_inbox_item_with_groups(
            env,
            &txn,
            datasource_id,
            &[(signal_group.master_key.clone(), datasource_group_id)],
            login,
            &logins,
            submit_item,
        )
        .await
        .c(h!())?;
    let signal_message_id = submitted.signal_message_id;
    let inbox_item_id = submitted.inbox_id;

    if let Some(device_name_id) = payload.device_name_id {
        query::set_inbox_items_device_name(
            &txn,
            vec![inbox_item_id],
            device_name_id,
        )
        .await
        .c(h!())?;
    }

    crate::messenger::media::store_media_attachments(
        &uploads,
        signal_message_id,
        &env.config,
        &env.s3,
        &txn,
        false,
    )
    .await
    .c(h!())?;

    crate::sigint::worker::incoming_message_after_insert(
        &txn,
        signal_message_id,
    )
    .await
    .c(h!())?;

    txn.commit().await.c(h!())?;

    if delete_uploaded_attachments {
        crate::messenger::media::delete_uploaded_attachment_files(&uploads)
            .await;
    }
    let mut redis = env.redis.clone();
    crate::inbox::fanout_inbox_changes(&mut redis, vec![inbox_item_id])
        .await
        .c(h!())?;

    Ok(DirectSubmitRsp { signal_message_id })
}

fn direct_submit_payload_to_item(
    payload: &DirectSubmitPayload,
    sender: String,
) -> Result<InboxSubmitItem, AppError> {
    Ok(InboxSubmitItem {
        full_body: payload.full_body.clone(),
        text: payload.text.clone(),
        comment: payload.comment.clone(),
        freq: payload.freq.clone(),
        coords: payload.coords.clone(),
        from_callsign: payload.from_callsign.clone(),
        to: payload.to.clone(),
        tags: payload.tags.clone(),
        timestamp: payload.timestamp.clone().unwrap_or_else(|| {
            Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
        }),
        sender: Some(sender),
        post: payload.post.clone(),
        unit: payload.unit.clone(),
        locations: payload.locations.clone(),
        group_names: None,
        network: payload.network.clone(),
        dmr: payload.dmr.clone(),
        parse_body_coordinates: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_submit_maps_explicit_fields_without_parsing() {
        let payload: DirectSubmitPayload =
            serde_json::from_value(serde_json::json!({
                "full_body": "full source",
                "text": "body only",
                "comment": "operator comment",
                "from": "ALPHA",
                "to": ["BRAVO"],
                "timestamp": "2026-07-11T12:34:56Z",
                "signal_group_master_key": "group"
            }))
            .unwrap();

        let item =
            direct_submit_payload_to_item(&payload, "sender".to_string())
                .unwrap();

        assert_eq!(item.full_body.as_deref(), Some("full source"));
        assert_eq!(item.text.as_deref(), Some("body only"));
        assert_eq!(item.comment.as_deref(), Some("operator comment"));
        assert_eq!(item.from_callsign.as_deref(), Some("ALPHA"));
        assert_eq!(item.to, vec!["BRAVO"]);
        assert!(!item.parse_body_coordinates);
    }
}
