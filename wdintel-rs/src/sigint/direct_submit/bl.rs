use super::query;
use super::types::{
    DirectSubmitParsePayload, DirectSubmitParseRsp, DirectSubmitPayload,
    DirectSubmitRsp,
};
use crate::config::FEATURE_DELETE_UPLOADED_ATTACHMENT_DEFAULT;
use crate::error::AppError;
use crate::rer_importer::types::InboxSubmitItem;
use crate::types::*;
use chrono::TimeZone;
use chrono::{SecondsFormat, Utc};
use sea_orm::{ConnectionTrait, TransactionTrait};

pub async fn parse_signal_message(
    login: &str,
    env: &Env,
    payload: DirectSubmitParsePayload,
) -> Result<DirectSubmitParseRsp, AppError> {
    let body = payload.full_body.trim().replace("\r\n", "\n");
    if body.is_empty() {
        return Err(AppError::BL {
            msg: "full_body cannot be empty".to_string(),
        });
    }
    query::find_available_signal_group(
        &env.dbx,
        login,
        &payload.signal_group_master_key,
    )
    .await?;
    let aor_id =
        query::resolve_group_aor_id(&env.dbx, &payload.signal_group_master_key)
            .await
            .c(h!())?;

    parse_signal_message_body(env, &env.dbx, &body, aor_id).await
}

async fn parse_signal_message_body<C>(
    env: &Env,
    dbx: &C,
    body: &str,
    aor_id: Option<i64>,
) -> Result<DirectSubmitParseRsp, AppError>
where
    C: ConnectionTrait,
{
    let callsign_tokens =
        crate::rer_importer::callsigns::find_known_callsigns(&env.rq, body)
            .await
            .c(h!())?;
    let callsigns = crate::utils::uniq_via_btreeset(
        &callsign_tokens
            .iter()
            .map(|callsign| callsign.etalon.clone())
            .collect::<Vec<_>>(),
    );
    let coords = crate::rer_importer::coordinates::extract_coords(body).await;
    let coords =
        crate::location::peleng::filter_allowed_peleng_coords(coords, dbx)
            .await
            .c(h!())?;
    let unit_and_location = crate::unit::parser::extract_unit_with_aor(
        env.settlements.clone(),
        body,
        callsigns.clone(),
        aor_id,
    )
    .c(h!())?;
    let text = if env.config.sigint_comment_parsing_enabled()? {
        crate::sigint::parser::extract_text_without_top_comment(body)?
    } else {
        crate::rer_importer::body_noheader::extract_text(body)?
    };
    let timezone = crate::config::get_tz();
    let local_now = chrono::Local::now().with_timezone(&timezone);
    let timestamp =
        crate::rer_importer::datetime::extract_datetime(local_now, body)?
            .and_then(|datetime| {
                timezone.from_local_datetime(&datetime).single()
            })
            .map(|datetime| {
                datetime.to_rfc3339_opts(SecondsFormat::Secs, true)
            });
    let comments = crate::sigint::parser::parse_comments(body);

    Ok(DirectSubmitParseRsp {
        text: text.body,
        freq: crate::rer_importer::frequency::extract_freq(body)?
            .map(|freq| crate::rer_importer::frequency::etalon(&freq)),
        coords: coords
            .into_iter()
            .map(|coords| crate::rer_importer::types::SubmitCoordinates {
                lat: coords.lat,
                lon: coords.lng,
            })
            .collect(),
        to: callsigns,
        timestamp,
        comment: comments.bottom.or(comments.top),
        post: crate::rer_importer::post::extract_post(body)?,
        unit: unit_and_location.unit,
        locations: unit_and_location.locality.into_iter().collect(),
    })
}

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
    use crate::functest::tests::cleanup;
    use serial_test::serial;

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

    #[tokio::test]
    #[serial]
    async fn direct_submit_parse_suggests_inbox_fields() {
        let env = cleanup().await.unwrap();
        let body = "01.04.2023_15:00 F=411,7500(МГЦ)\n49.12345, 37.12345\nТекст повідомлення";

        let parsed = parse_signal_message_body(&env, &env.dbx, body, None)
            .await
            .unwrap();

        assert_eq!(parsed.freq.as_deref(), Some("411.7500"));
        assert_eq!(parsed.coords.len(), 1);
        assert!(parsed.text.contains("Текст повідомлення"));
        assert!(parsed.timestamp.is_some());
    }
}
