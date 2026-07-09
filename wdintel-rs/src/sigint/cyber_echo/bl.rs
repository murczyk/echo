use super::query;
use super::tus::TusHandler;
use super::types::{
    CreateCyberEchoSignalMessagePayload, CreateCyberEchoSignalMessageRsp,
};
use crate::config::FEATURE_DELETE_UPLOADED_ATTACHMENT_DEFAULT;
use crate::error::AppError;
use crate::rer_importer::types::InboxSubmitItem;
use crate::types::*;
use chrono::{SecondsFormat, Utc};
use sea_orm::TransactionTrait;

pub async fn create_signal_message(
    login: &str,
    env: &Env,
    payload: CreateCyberEchoSignalMessagePayload,
) -> Result<CreateCyberEchoSignalMessageRsp, AppError> {
    crate::system_settings::ensure_devices_section_enabled(&env.dbx)
        .await
        .c(h!())?;

    let body = payload
        .text
        .as_deref()
        .or(payload.body.as_deref())
        .unwrap_or_default()
        .trim()
        .replace("\r\n", "\n");
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
    .await?;
    let sender_uuid = query::ensure_current_user_sender(&txn, login)
        .await
        .c(h!())?;
    query::validate_device_name_id(&txn, payload.device_name_id).await?;
    let logins = crate::users::get_organism_logins_by_login(&txn, login)
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
        cyber_echo_payload_to_submit_item(&payload, body, sender_uuid);
    let submitted = crate::rer_importer::inbox::submit_bl::submit_inbox_item_with_groups_create_missing_uid(
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

    query::set_inbox_items_device_name(
        &txn,
        vec![inbox_item_id],
        payload.device_name_id,
    )
    .await
    .c(h!())?;

    let media = crate::messenger::media::store_media_attachments(
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

    Ok(CreateCyberEchoSignalMessageRsp {
        signal_message_id,
        message_uid: Some(submitted.message_uid),
        inbox_item_id,
        media_ids: media.media.into_iter().map(|media| media.id).collect(),
    })
}

fn cyber_echo_payload_to_submit_item(
    payload: &CreateCyberEchoSignalMessagePayload,
    text: String,
    sender: String,
) -> InboxSubmitItem {
    InboxSubmitItem {
        message_uid: payload.message_uid.clone(),
        text,
        freq: payload.freq.clone(),
        coords: payload.coords.clone(),
        from_callsign: payload.from_callsign.clone(),
        to: payload.to_callsigns.clone(),
        tags: payload.tags.clone(),
        timestamp: payload.timestamp.clone().unwrap_or_else(|| {
            Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
        }),
        sender: Some(sender),
        full_body: payload.full_body.clone(),
        post: payload.post.clone(),
        unit: payload.unit.clone(),
        locations: payload.locations.clone(),
        group_names: None,
        network: payload.network.clone(),
        dmr: vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::{
        device_name, sigint_comment, sigint_inbox_item, sigint_inbox_item_tag,
        sigint_search, signal_group, signal_message, signal_message_group,
        system_settings, tag,
    };
    use crate::functest::tests::{cleanup, mk_signal_group, mk_tag};
    use crate::rer_importer::types::SubmitCoordinates;
    use sea_orm::{
        ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, NotSet,
        PaginatorTrait, QueryFilter, Set,
    };
    use serial_test::serial;

    const TEST_LOGIN: &str = "Tester";
    const TEST_SIGNAL_GROUP_KEY: &str = "vukho-test-master-key";

    fn payload(
        body: &str,
        signal_group_master_key: &str,
        device_name_id: i64,
        upload_urls: Option<Vec<String>>,
    ) -> CreateCyberEchoSignalMessagePayload {
        CreateCyberEchoSignalMessagePayload {
            message_uid: None,
            body: None,
            text: Some(body.to_string()),
            freq: None,
            coords: vec![],
            from_callsign: None,
            to_callsigns: vec![],
            tags: None,
            timestamp: None,
            full_body: None,
            post: None,
            unit: None,
            locations: vec![],
            network: None,
            signal_group_master_key: signal_group_master_key.to_string(),
            device_name_id,
            upload_urls,
        }
    }

    async fn insert_settings(dbx: &DatabaseConnection, enabled: bool) {
        let now = Utc::now().naive_utc();
        system_settings::ActiveModel {
            id: NotSet,
            rer_analysis_units_exact_match_only_default: Set(false),
            created_at: Set(now),
            updated_at: Set(now),
            updated_by: Set(None),
            deleted: Set(false),
            rer_duty_test_enabled: Set(false),
            rer_duty_test_since_ms: Set(0),
            rer_duty_test_limit: Set(0),
            rer_duty_poll_interval_sec: Set(0),
            rer_duty_insert_historical_interceptions: Set(false),
            short_url_enabled: Set(false),
            support_non_rer_interceptions: Set(false),
            peleng_bounds_enabled: Set(false),
            peleng_bounds_top_left_lat: Set(None),
            peleng_bounds_top_left_lng: Set(None),
            peleng_bounds_bottom_right_lat: Set(None),
            peleng_bounds_bottom_right_lng: Set(None),
            default_neo_analysis: Set(false),
            echo_im_sync_since: Set(now),
            autofix_echoim_missing_messages: Set(false),
            echo_im_sync_since_inbox_message_id: Set(0),
            devices_section_enabled: Set(enabled),
            echo_restapi_error_discord_webhook_url: Set(None),
            sigint_comment_parsing_enabled: Set(true),
            do_not_store_duplicate_echoim_failures: Set(false),
        }
        .insert(dbx)
        .await
        .unwrap();
    }

    async fn insert_device_name(dbx: &DatabaseConnection) -> i64 {
        let device_name = device_name::ActiveModel {
            id: NotSet,
            name: Set(Some("southend".to_string())),
            login: Set(TEST_LOGIN.to_string()),
            created_at: NotSet,
            search_tsv: NotSet,
        };
        device_name::Entity::insert(device_name)
            .exec(dbx)
            .await
            .unwrap()
            .last_insert_id
    }

    fn assert_bl_error(err: AppError, expected: &str) {
        match err {
            AppError::BL { msg } => assert!(msg.contains(expected)),
            err => panic!("expected BL error, got {err:?}"),
        }
    }

    #[tokio::test]
    #[serial]
    async fn cyber_echo_create_rejects_when_setting_missing() {
        let env = cleanup().await.unwrap();

        let err = create_signal_message(
            TEST_LOGIN,
            &env,
            payload("message", TEST_SIGNAL_GROUP_KEY, 1, None),
        )
        .await
        .unwrap_err();

        assert!(matches!(err, AppError::Forbidden(_)));
    }

    #[tokio::test]
    #[serial]
    async fn cyber_echo_create_rejects_when_setting_disabled() {
        let env = cleanup().await.unwrap();
        insert_settings(&env.dbx, false).await;

        let err = create_signal_message(
            TEST_LOGIN,
            &env,
            payload("message", TEST_SIGNAL_GROUP_KEY, 1, None),
        )
        .await
        .unwrap_err();

        assert!(matches!(err, AppError::Forbidden(_)));
    }

    #[tokio::test]
    #[serial]
    async fn cyber_echo_create_rejects_empty_body() {
        let env = cleanup().await.unwrap();
        insert_settings(&env.dbx, true).await;

        let err = create_signal_message(
            TEST_LOGIN,
            &env,
            payload(" \r\n ", TEST_SIGNAL_GROUP_KEY, 1, None),
        )
        .await
        .unwrap_err();

        assert_bl_error(err, "message body cannot be empty");
    }

    #[tokio::test]
    #[serial]
    async fn cyber_echo_create_rejects_inaccessible_group() {
        let env = cleanup().await.unwrap();
        insert_settings(&env.dbx, true).await;
        let device_name_id = insert_device_name(&env.dbx).await;
        let foreign_group_key = "foreign-cyber-echo-group";
        mk_signal_group(
            &env.dbx,
            signal_group::ActiveModel {
                master_key: Set(foreign_group_key.to_string()),
                name: Set(Some("Foreign".to_string())),
                deleted: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let err = create_signal_message(
            TEST_LOGIN,
            &env,
            payload("message", foreign_group_key, device_name_id, None),
        )
        .await
        .unwrap_err();

        assert!(matches!(err, AppError::Forbidden(_)));
    }

    #[tokio::test]
    #[serial]
    async fn cyber_echo_create_rejects_unknown_device_name_id() {
        let env = cleanup().await.unwrap();
        insert_settings(&env.dbx, true).await;

        let err = create_signal_message(
            TEST_LOGIN,
            &env,
            payload("message", TEST_SIGNAL_GROUP_KEY, i64::MAX, None),
        )
        .await
        .unwrap_err();

        assert!(matches!(err, AppError::NotFound));
    }

    #[tokio::test]
    #[serial]
    async fn cyber_echo_create_with_extended_fields_creates_inbox_item() {
        let env = cleanup().await.unwrap();
        insert_settings(&env.dbx, true).await;
        let device_name_id = insert_device_name(&env.dbx).await;
        let tag = mk_tag(
            &env.dbx,
            tag::ActiveModel {
                label: Set("cyber-echo-submit-tag".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let payload = CreateCyberEchoSignalMessagePayload {
            message_uid: Some("cyber-echo-manual-1".to_string()),
            text: Some("рос абонент ЯРУС викликав СВЕТЛЫЙ".to_string()),
            freq: Some("145.02678".to_string()),
            coords: vec![SubmitCoordinates {
                lat: 49.12345,
                lon: 37.12345,
            }],
            from_callsign: Some("ЯРУС".to_string()),
            to_callsigns: vec!["СВЕТЛЫЙ".to_string()],
            tags: Some(vec![
                "cyber-echo-submit-tag".to_string(),
                "missing-cyber-echo-tag".to_string(),
            ]),
            timestamp: Some("2026-06-25T12:34:56Z".to_string()),
            full_body: Some("Повна форма Cyber Echo".to_string()),
            post: Some("SC1".to_string()),
            unit: Some("42 мсд".to_string()),
            locations: vec!["ЛИМАН ПЕРШИЙ".to_string()],
            signal_group_master_key: TEST_SIGNAL_GROUP_KEY.to_string(),
            device_name_id,
            body: None,
            network: None,
            upload_urls: None,
        };

        let rsp = create_signal_message(TEST_LOGIN, &env, payload)
            .await
            .unwrap();

        assert_eq!(rsp.message_uid.as_deref(), Some("cyber-echo-manual-1"));
        assert_eq!(rsp.signal_message_id, rsp.inbox_item_id);
        assert!(rsp.media_ids.is_empty());

        let signal_message =
            signal_message::Entity::find_by_id(rsp.signal_message_id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(
            signal_message.body.as_deref(),
            Some("рос абонент ЯРУС викликав СВЕТЛЫЙ")
        );
        assert_eq!(signal_message.sender.as_deref(), Some(TEST_LOGIN));

        let signal_message_group = signal_message_group::Entity::find()
            .filter(
                signal_message_group::Column::SignalMessageId
                    .eq(rsp.signal_message_id),
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            signal_message_group.group_master_key.as_deref(),
            Some(TEST_SIGNAL_GROUP_KEY)
        );
        assert_eq!(
            signal_message_group.message_uid.as_deref(),
            Some("cyber-echo-manual-1")
        );

        let inbox_item =
            sigint_inbox_item::Entity::find_by_id(rsp.inbox_item_id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(inbox_item.freq.as_deref(), Some("145.0267"));
        assert_eq!(inbox_item.coords.as_deref(), Some("49.12345, 37.12345"));
        assert_eq!(inbox_item.lat, Some(49.12345));
        assert_eq!(inbox_item.lng, Some(37.12345));
        assert_eq!(inbox_item.device_name_id, Some(device_name_id));
        assert_eq!(inbox_item.unit.as_deref(), Some("42 мсд"));
        assert_eq!(inbox_item.location.as_deref(), Some("ЛИМАН ПЕРШИЙ"));

        let comment = sigint_comment::Entity::find()
            .filter(
                sigint_comment::Column::SignalMessageId
                    .eq(rsp.signal_message_id),
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(comment.comment, "Повна форма Cyber Echo");

        let inbox_tag = sigint_inbox_item_tag::Entity::find()
            .filter(
                sigint_inbox_item_tag::Column::SigintInboxItemId
                    .eq(rsp.inbox_item_id),
            )
            .filter(
                sigint_inbox_item_tag::Column::Login
                    .eq(Some(TEST_LOGIN.to_string())),
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(inbox_tag.tag_id, tag.id);

        assert!(sigint_search::Entity::find_by_id(rsp.inbox_item_id)
            .one(&env.dbx)
            .await
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    #[serial]
    async fn cyber_echo_create_with_existing_message_uid_updates_existing_rows()
    {
        let env = cleanup().await.unwrap();
        insert_settings(&env.dbx, true).await;
        let device_name_id = insert_device_name(&env.dbx).await;
        let message_uid = "cyber-echo-manual-update-1";
        let mut first_payload = payload(
            "first cyber echo body",
            TEST_SIGNAL_GROUP_KEY,
            device_name_id,
            None,
        );
        first_payload.message_uid = Some(message_uid.to_string());
        first_payload.freq = Some("145.02678".to_string());
        first_payload.unit = Some("first unit".to_string());
        first_payload.locations = vec!["FIRST LOCATION".to_string()];

        let first_rsp = create_signal_message(TEST_LOGIN, &env, first_payload)
            .await
            .unwrap();

        let mut second_payload = payload(
            "updated cyber echo body",
            TEST_SIGNAL_GROUP_KEY,
            device_name_id,
            None,
        );
        second_payload.message_uid = Some(message_uid.to_string());
        second_payload.freq = Some("146.12345".to_string());
        second_payload.unit = Some("updated unit".to_string());
        second_payload.locations = vec!["UPDATED LOCATION".to_string()];

        let second_rsp =
            create_signal_message(TEST_LOGIN, &env, second_payload)
                .await
                .unwrap();

        assert_eq!(second_rsp.signal_message_id, first_rsp.signal_message_id);
        assert_eq!(second_rsp.inbox_item_id, first_rsp.inbox_item_id);

        let signal_message_count = signal_message::Entity::find()
            .filter(signal_message::Column::MessageUid.eq(message_uid))
            .count(&env.dbx)
            .await
            .unwrap();
        assert_eq!(signal_message_count, 1);

        let signal_message_group_count = signal_message_group::Entity::find()
            .filter(signal_message_group::Column::MessageUid.eq(message_uid))
            .count(&env.dbx)
            .await
            .unwrap();
        assert_eq!(signal_message_group_count, 1);

        let signal_message =
            signal_message::Entity::find_by_id(first_rsp.signal_message_id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(
            signal_message.body.as_deref(),
            Some("updated cyber echo body")
        );

        let inbox_item =
            sigint_inbox_item::Entity::find_by_id(first_rsp.inbox_item_id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(inbox_item.freq.as_deref(), Some("146.1234"));
        assert_eq!(inbox_item.unit.as_deref(), Some("updated unit"));
        assert_eq!(inbox_item.location.as_deref(), Some("UPDATED LOCATION"));
        assert_eq!(inbox_item.device_name_id, Some(device_name_id));
    }

    #[tokio::test]
    #[serial]
    #[ignore = "temporarily disabled while local test S3 config is being settled"]
    async fn cyber_echo_create_rejects_attachments_without_s3() {
        let env = cleanup().await.unwrap();
        insert_settings(&env.dbx, true).await;
        let device_name_id = insert_device_name(&env.dbx).await;

        let err = create_signal_message(
            TEST_LOGIN,
            &env,
            payload(
                "message",
                TEST_SIGNAL_GROUP_KEY,
                device_name_id,
                Some(vec![
                    "/api/sigint/cyber-echo/tus/not-a-real-file.1".to_string()
                ]),
            ),
        )
        .await
        .unwrap_err();

        assert_bl_error(err, "s3 config is required");
    }

    #[tokio::test]
    async fn cyber_echo_tus_rejects_too_many_upload_urls() {
        let temp_dir = tempfile::tempdir().unwrap();
        let tus_handler = TusHandler::new(
            temp_dir.path().to_string_lossy().to_string(),
            super::super::CYBER_ECHO_TUS_PATH_BASE,
        );
        let upload_urls = (0..=super::super::tus::MAX_COMPLETED_UPLOADS)
            .map(|idx| {
                format!("/api/sigint/cyber-echo/tus/not-a-real-file-{idx}.1")
            })
            .collect::<Vec<_>>();

        let err = tus_handler
            .resolve_completed_uploads(TEST_LOGIN, &upload_urls)
            .await
            .unwrap_err();

        assert_bl_error(err, "too many attachments");
    }

    #[tokio::test]
    async fn cyber_echo_tus_rejects_unknown_upload_url() {
        let temp_dir = tempfile::tempdir().unwrap();
        let tus_handler = TusHandler::new(
            temp_dir.path().to_string_lossy().to_string(),
            super::super::CYBER_ECHO_TUS_PATH_BASE,
        );

        let err = tus_handler
            .resolve_completed_uploads(
                TEST_LOGIN,
                &["/api/sigint/cyber-echo/tus/not-a-real-file.1".to_string()],
            )
            .await
            .unwrap_err();

        assert_bl_error(err, "upload not found or incomplete");
    }
}
