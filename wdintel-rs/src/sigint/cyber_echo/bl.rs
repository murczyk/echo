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
    .await?;
    let sender_uuid = query::ensure_current_user_sender(&txn, login)
        .await
        .c(h!())?;
    query::validate_computer_name_id(&txn, payload.computer_name_id).await?;

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
        false,
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

    if delete_uploaded_attachments {
        crate::messenger::media::delete_uploaded_attachment_files(&uploads)
            .await;
    }

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::{computer_name, signal_group, system_settings};
    use crate::functest::tests::{cleanup, mk_signal_group};
    use sea_orm::{
        ActiveModelTrait, DatabaseConnection, EntityTrait, NotSet, Set,
    };
    use serial_test::serial;

    const TEST_LOGIN: &str = "Tester";
    const TEST_SIGNAL_GROUP_KEY: &str = "vukho-test-master-key";

    fn payload(
        body: &str,
        signal_group_master_key: &str,
        computer_name_id: i64,
        upload_urls: Option<Vec<String>>,
    ) -> CreateCyberEchoSignalMessagePayload {
        CreateCyberEchoSignalMessagePayload {
            body: body.to_string(),
            signal_group_master_key: signal_group_master_key.to_string(),
            computer_name_id,
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
            cyber_echo_enabled: Set(enabled),
            echo_restapi_error_discord_webhook_url: Set(None),
        }
        .insert(dbx)
        .await
        .unwrap();
    }

    async fn insert_computer_name(dbx: &DatabaseConnection) -> i64 {
        let computer_name = computer_name::ActiveModel {
            id: NotSet,
            name: Set(Some("southend".to_string())),
            login: Set(TEST_LOGIN.to_string()),
            created_at: NotSet,
            search_tsv: NotSet,
        };
        computer_name::Entity::insert(computer_name)
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
        let computer_name_id = insert_computer_name(&env.dbx).await;
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
            payload("message", foreign_group_key, computer_name_id, None),
        )
        .await
        .unwrap_err();

        assert!(matches!(err, AppError::Forbidden(_)));
    }

    #[tokio::test]
    #[serial]
    async fn cyber_echo_create_rejects_unknown_computer_name_id() {
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
    #[ignore = "temporarily disabled while local test S3 config is being settled"]
    async fn cyber_echo_create_rejects_attachments_without_s3() {
        let env = cleanup().await.unwrap();
        insert_settings(&env.dbx, true).await;
        let computer_name_id = insert_computer_name(&env.dbx).await;

        let err = create_signal_message(
            TEST_LOGIN,
            &env,
            payload(
                "message",
                TEST_SIGNAL_GROUP_KEY,
                computer_name_id,
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
