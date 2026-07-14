use super::query;
use super::types::{
    DirectSubmitParsePayload, DirectSubmitParseRsp, DirectSubmitPayload,
    DirectSubmitRsp,
};
use crate::config::FEATURE_DELETE_UPLOADED_ATTACHMENT_DEFAULT;
use crate::error::AppError;
use crate::messenger::media::MediaUploadInput;
use crate::rer_importer::inbox::submit_bl::SubmittedInboxItem;
use crate::rer_importer::types::InboxSubmitItem;
use crate::types::*;
use chrono::TimeZone;
use chrono::{SecondsFormat, Utc};
use sea_orm::{ConnectionTrait, DatabaseTransaction, TransactionTrait, EntityTrait, QueryFilter, ColumnTrait};

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
    let master_key = payload
        .signal_group_master_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty());
    // The group only refines unit/location extraction; parsing works without it.
    let aor_id = if let Some(master_key) = master_key {
        query::find_available_signal_group(&env.dbx, login, master_key).await?;
        query::resolve_group_aor_id(&env.dbx, master_key)
            .await
            .c(h!())?
    } else {
        None
    };

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
        locations: unit_and_location
            .locality
            .map(|l| {
                l.split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default(),
    })
}

pub async fn submit_signal_message(
    login: &str,
    env: &Env,
    payload: DirectSubmitPayload,
) -> Result<DirectSubmitRsp, AppError> {
    save_signal_message(login, env, None, payload).await
}

pub async fn edit_signal_message(
    login: &str,
    env: &Env,
    signal_message_id: i64,
    payload: DirectSubmitPayload,
) -> Result<DirectSubmitRsp, AppError> {
    save_signal_message(login, env, Some(signal_message_id), payload).await
}

async fn save_signal_message(
    login: &str,
    env: &Env,
    signal_message_id: Option<i64>,
    payload: DirectSubmitPayload,
) -> Result<DirectSubmitRsp, AppError> {
    validate_direct_submit_payload(env, &payload)?;
    let upload_urls = payload.upload_urls.clone().unwrap_or_default();
    let uploads =
        resolve_direct_submit_uploads(env, login, &upload_urls).await?;
    let deleted_media_ids = payload.deleted_media_ids.clone().unwrap_or_default();
    let delete_uploaded_attachments = env
        .config
        .feature_delete_uploaded_attachment
        .unwrap_or(FEATURE_DELETE_UPLOADED_ATTACHMENT_DEFAULT);
    let txn = env.dbx.begin().await.c(h!())?;
    let signal_group = query::find_available_signal_group(
        &txn,
        login,
        &payload.signal_group_master_key,
    )
    .await?;
    let signal_message = match signal_message_id {
        Some(signal_message_id) => Some(
            query::find_editable_signal_message(
                &txn,
                signal_message_id,
                &signal_group.master_key,
            )
            .await?,
        ),
        None => None,
    };
    let sender = match signal_message
        .as_ref()
        .and_then(|signal_message| signal_message.sender.clone())
    {
        Some(sender) => sender,
        None => query::ensure_current_user_sender(&txn, login)
            .await
            .c(h!())?,
    };
    if let Some(device_name_id) = payload.device_name_id {
        query::validate_device_name_id(&txn, device_name_id).await?;
    }
    let logins = crate::users::get_organism_logins_by_login(&txn, login)
        .await
        .c(h!())?;
    let previous_timestamp =
        signal_message.and_then(|signal_message| signal_message.timestamp);
    let submit_item =
        direct_submit_payload_to_item(&payload, sender, previous_timestamp)
            .c(h!())?;
    let submitted = persist_direct_submit_item(
        env,
        &txn,
        signal_message_id,
        signal_group,
        login,
        &logins,
        submit_item,
        !uploads.is_empty(),
    )
    .await?;
    let mut rsp = finish_direct_submit(
        env,
        txn,
        submitted,
        payload.device_name_id,
        &uploads,
        delete_uploaded_attachments,
    )
    .await?;

    if !deleted_media_ids.is_empty() {
        if let Some(signal_message_id) = signal_message_id {
            let txn2 = env.dbx.begin().await.c(h!())?;
            let media_to_delete = crate::entities::signal_message_media::Entity::find()
                .filter(crate::entities::signal_message_media::Column::SignalMessageId.eq(signal_message_id))
                .filter(crate::entities::signal_message_media::Column::Id.is_in(deleted_media_ids.clone()))
                .all(&txn2)
                .await
                .c(h!())?;

            if !media_to_delete.is_empty() {
                crate::messenger::media::delete_stored_media_files(
                    &media_to_delete,
                    &env.config,
                    &env.s3,
                ).await;

                let _delete_result = crate::entities::signal_message_media::Entity::delete_many()
                    .filter(crate::entities::signal_message_media::Column::Id.is_in(deleted_media_ids))
                    .exec(&txn2)
                    .await
                    .c(h!())?;
            }
            txn2.commit().await.c(h!())?;
        }
    }

    let req = crate::rer_importer::types::InboxMessagesReq {
        highlight_points: Some(true),
        ..Default::default()
    };
    let messages = crate::rer_importer::inbox::messages_by_id_bl(
        login,
        &logins,
        env,
        &[rsp.signal_message_id],
        &req,
    )
    .await?;
    if let Some((_, message)) = messages.into_iter().next() {
        rsp.message = Some(message);
    }

    Ok(rsp)
}

fn validate_direct_submit_payload(
    env: &Env,
    payload: &DirectSubmitPayload,
) -> Result<(), AppError> {
    let upload_urls = payload.upload_urls.as_deref().unwrap_or_default();
    if !has_direct_submit_content(payload) {
        return Err(AppError::BL {
            msg: "full_body, text, or upload_urls cannot be empty".to_string(),
        });
    }
    if !upload_urls.is_empty()
        && (env.config.s3_config.is_none() || env.s3.is_none())
    {
        return Err(AppError::BL {
            msg: "s3 config is required for attachment upload".to_string(),
        });
    }
    Ok(())
}

fn has_direct_submit_content(payload: &DirectSubmitPayload) -> bool {
    payload
        .full_body
        .as_deref()
        .is_some_and(|body| !body.trim().is_empty())
        || payload
            .text
            .as_deref()
            .is_some_and(|body| !body.trim().is_empty())
        || payload
            .upload_urls
            .as_ref()
            .is_some_and(|upload_urls| !upload_urls.is_empty())
}

async fn resolve_direct_submit_uploads(
    env: &Env,
    login: &str,
    upload_urls: &[String],
) -> Result<Vec<MediaUploadInput>, AppError> {
    let tus_handler = crate::sigint::file_upload::tus::TusHandler::new(
        env.config.storage_dir.clone(),
        crate::sigint::file_upload::TUS_PATH_BASE,
    );
    Ok(tus_handler
        .resolve_completed_uploads(login, upload_urls)
        .await
        .c(h!())?)
}

async fn persist_direct_submit_item(
    env: &Env,
    txn: &DatabaseTransaction,
    signal_message_id: Option<i64>,
    signal_group: crate::entities::signal_group::Model,
    login: &str,
    logins: &Vec<String>,
    submit_item: InboxSubmitItem,
    allow_empty_content: bool,
) -> Result<SubmittedInboxItem, AppError> {
    let datasource_id = signal_group.datasource_id.unwrap_or(
        query::resolve_datasource_id_for_group(txn, &signal_group.master_key)
            .await
            .c(h!())?,
    );
    let datasource_group_id =
        crate::messenger::group::ensure_datasource_group_id(
            txn,
            signal_group.master_key.clone(),
            datasource_id,
        )
        .await
        .c(h!())?;
    let groups = [(signal_group.master_key.clone(), datasource_group_id)];
    Ok(match signal_message_id {
        Some(signal_message_id) => {
            crate::rer_importer::inbox::submit_bl::edit_inbox_item_with_groups(
                env,
                txn,
                signal_message_id,
                datasource_id,
                &groups,
                login,
                logins,
                submit_item,
                allow_empty_content,
            )
            .await
            .c(h!())?
        }
        None => {
            crate::rer_importer::inbox::submit_bl::submit_inbox_item_with_groups(
                env,
                txn,
                datasource_id,
                &groups,
                login,
                logins,
                submit_item,
                allow_empty_content,
            )
            .await
            .c(h!())?
        }
    })
}

async fn finish_direct_submit(
    env: &Env,
    txn: DatabaseTransaction,
    submitted: SubmittedInboxItem,
    device_name_id: Option<i64>,
    uploads: &[MediaUploadInput],
    delete_uploaded_attachments: bool,
) -> Result<DirectSubmitRsp, AppError> {
    let signal_message_id = submitted.signal_message_id;
    let inbox_item_id = submitted.inbox_id;

    query::set_inbox_items_device_name(
        &txn,
        vec![inbox_item_id],
        device_name_id,
    )
    .await
    .c(h!())?;

    crate::messenger::media::store_media_attachments(
        uploads,
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
        crate::messenger::media::delete_uploaded_attachment_files(uploads)
            .await;
    }
    let mut redis = env.redis.clone();
    crate::inbox::fanout_inbox_changes(&mut redis, vec![inbox_item_id])
        .await
        .c(h!())?;

    Ok(DirectSubmitRsp { signal_message_id, message: None })
}

fn direct_submit_payload_to_item(
    payload: &DirectSubmitPayload,
    sender: String,
    previous_timestamp: Option<chrono::NaiveDateTime>,
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
            previous_timestamp
                .map(|timestamp| {
                    timestamp
                        .and_utc()
                        .to_rfc3339_opts(SecondsFormat::Millis, true)
                })
                .unwrap_or_else(|| {
                    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
                })
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
    use crate::entities::{
        device_name, palitra, palitra_highlight_worker_job, sigint_comment,
        sigint_inbox_item, sigint_inbox_item_point_token,
        sigint_inbox_item_tag, signal_message, tag,
        tag_suggestion_worker_queue,
    };
    use crate::functest::tests::cleanup;
    use sea_orm::{
        ActiveModelTrait, ColumnTrait, EntityTrait, IntoActiveModel,
        PaginatorTrait, QueryFilter, Set,
    };
    use serial_test::serial;

    const TEST_LOGIN: &str = "Tester";
    const TEST_SIGNAL_GROUP_KEY: &str = "vukho-test-master-key";

    fn direct_submit_payload(text: &str) -> DirectSubmitPayload {
        DirectSubmitPayload {
            full_body: None,
            text: Some(text.to_string()),
            comment: None,
            freq: None,
            coords: vec![],
            from_callsign: None,
            to: vec![],
            tags: None,
            timestamp: None,
            post: None,
            unit: None,
            locations: vec![],
            network: None,
            dmr: vec![],
            signal_group_master_key: TEST_SIGNAL_GROUP_KEY.to_string(),
            device_name_id: None,
            upload_urls: None,
            deleted_media_ids: None,
        }
    }

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
            direct_submit_payload_to_item(&payload, "sender".to_string(), None)
                .unwrap();

        assert_eq!(item.full_body.as_deref(), Some("full source"));
        assert_eq!(item.text.as_deref(), Some("body only"));
        assert_eq!(item.comment.as_deref(), Some("operator comment"));
        assert_eq!(item.from_callsign.as_deref(), Some("ALPHA"));
        assert_eq!(item.to, vec!["BRAVO"]);
        assert!(!item.parse_body_coordinates);
    }

    #[test]
    fn direct_submit_accepts_attachment_without_text() {
        let mut payload = direct_submit_payload("");
        payload.upload_urls = Some(vec!["attachment-url".to_string()]);

        assert!(has_direct_submit_content(&payload));
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

    #[tokio::test]
    #[serial]
    async fn direct_edit_updates_existing_message_by_id() {
        let env = cleanup().await.unwrap();
        let device_name_id =
            device_name::Entity::insert(device_name::ActiveModel {
                name: Set(Some("edit-test-device".to_string())),
                login: Set(TEST_LOGIN.to_string()),
                ..Default::default()
            })
            .exec(&env.dbx)
            .await
            .unwrap()
            .last_insert_id;
        let mut create_payload = direct_submit_payload("original body");
        create_payload.timestamp = Some("2026-07-11T12:34:56Z".to_string());
        create_payload.freq = Some("145.025".to_string());
        create_payload.device_name_id = Some(device_name_id);
        create_payload.comment = Some("old comment".to_string());
        let created = submit_signal_message(TEST_LOGIN, &env, create_payload)
            .await
            .unwrap();

        let inbox_item =
            sigint_inbox_item::Entity::find_by_id(created.signal_message_id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(inbox_item.device_name_id, Some(device_name_id));
        let mut inbox_item = inbox_item.into_active_model();
        inbox_item.callsigns_alg1 =
            Set(Some(serde_json::json!(["OLD_CALLSIGN_1"])));
        inbox_item.callsigns_alg2 =
            Set(Some(serde_json::json!(["OLD_CALLSIGN_2"])));
        inbox_item.signal_tokens = Set(Some(serde_json::json!([{
            "text": "old signal",
            "start": 0,
            "end": 10
        }])));
        inbox_item.update(&env.dbx).await.unwrap();
        let palitra = palitra::Entity::find()
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        sigint_inbox_item_point_token::ActiveModel {
            sigint_inbox_item_id: Set(created.signal_message_id),
            palitra_id: Set(palitra.id),
            point_tokens: Set(serde_json::json!([{
                "text": "old point",
                "start": 0,
                "end": 9
            }])),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let tag = tag::Entity::find().one(&env.dbx).await.unwrap().unwrap();
        sigint_inbox_item_tag::ActiveModel {
            sigint_inbox_item_id: Set(created.signal_message_id),
            tag_id: Set(tag.id),
            confidence: Set(0.9),
            login: Set(None),
            model: Set(Some("old-model".to_string())),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        let mut edit_payload = direct_submit_payload("updated body");
        edit_payload.freq = Some("146.125".to_string());
        let edited = edit_signal_message(
            TEST_LOGIN,
            &env,
            created.signal_message_id,
            edit_payload,
        )
        .await
        .unwrap();

        assert_eq!(edited.signal_message_id, created.signal_message_id);
        let signal_message =
            signal_message::Entity::find_by_id(created.signal_message_id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(signal_message.body.as_deref(), Some("updated body"));
        assert_eq!(signal_message.sender.as_deref(), Some(TEST_LOGIN));
        assert_eq!(
            signal_message.timestamp,
            Some(
                chrono::DateTime::parse_from_rfc3339("2026-07-11T12:34:56Z")
                    .unwrap()
                    .naive_utc()
            )
        );
        let inbox_item =
            sigint_inbox_item::Entity::find_by_id(created.signal_message_id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(inbox_item.freq.as_deref(), Some("146.1250"));
        assert_eq!(inbox_item.device_name_id, None);
        assert_eq!(inbox_item.callsigns_alg1, None);
        assert_eq!(inbox_item.callsigns_alg2, None);
        assert_eq!(inbox_item.signal_tokens, None);
        assert_eq!(
            sigint_comment::Entity::find()
                .filter(
                    sigint_comment::Column::SignalMessageId
                        .eq(created.signal_message_id)
                )
                .filter(sigint_comment::Column::Login.eq(TEST_LOGIN))
                .count(&env.dbx)
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            sigint_inbox_item_tag::Entity::find()
                .filter(
                    sigint_inbox_item_tag::Column::SigintInboxItemId
                        .eq(created.signal_message_id)
                )
                .filter(sigint_inbox_item_tag::Column::Model.is_not_null())
                .count(&env.dbx)
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            sigint_inbox_item_point_token::Entity::find()
                .filter(
                    sigint_inbox_item_point_token::Column::SigintInboxItemId
                        .eq(created.signal_message_id)
                )
                .count(&env.dbx)
                .await
                .unwrap(),
            0
        );
        assert!(tag_suggestion_worker_queue::Entity::find_by_id(
            created.signal_message_id
        )
        .one(&env.dbx)
        .await
        .unwrap()
        .is_some());
        assert!(palitra_highlight_worker_job::Entity::find_by_id(
            created.signal_message_id
        )
        .one(&env.dbx)
        .await
        .unwrap()
        .is_some());
        assert_eq!(
            signal_message::Entity::find()
                .count(&env.dbx)
                .await
                .unwrap(),
            1
        );
    }
}
