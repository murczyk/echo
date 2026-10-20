use super::*;
use crate::entities::system_settings;
use sea_orm::{ActiveModelTrait, ConnectionTrait, Set};

#[actix_web::test]
#[serial_test::serial]
async fn disabled_devices_skip_registry_dependencies_and_workers() {
    let (base, _guard) =
        crate::functest::tests::cleanup_locked().await.unwrap();
    system_settings::ActiveModel {
        devices_section_enabled: Set(false),
        enable_audio_transcription: Set(true),
        ..Default::default()
    }
    .insert(&base.dbx)
    .await
    .unwrap();
    let actor = crate::functest::tests::find_test_login(&base.dbx)
        .await
        .unwrap();
    for configured in [false, true] {
        let mut config = base.config.clone();
        if configured {
            let files = config.file_registry.as_mut().unwrap();
            files.pg_host = Some("127.0.0.1".into());
            files.pg_port = Some(1);
        } else {
            config.file_registry = None;
        }
        tokio::time::timeout(
            core::time::Duration::from_secs(5),
            crate::file_registry::migrate_if_enabled(
                &config,
                Mode::Test,
                &base.dbx,
            ),
        )
        .await
        .unwrap()
        .unwrap();
        let env = new_env_from_config(Mode::Test, true, config).await.unwrap();
        assert!(env.file_registry_db.is_none());
        assert!(env.device_file_content.is_none());
        let mut tasks = JoinSet::new();
        let cancellation = CancellationToken::new();
        spawn_device_audio_workers(&mut tasks, env.clone(), cancellation, true);
        assert!(tasks.is_empty());
        let error = crate::devices::audio::detail(
            &env.device_audio,
            actor.id,
            crate::devices::audio::types::DeviceAudioDetailCommand {
                device_id: Uuid::now_v7(),
                audio_id: Uuid::now_v7(),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(
            actix_web::ResponseError::error_response(
                &crate::devices::audio::DeviceAudioHttpError::from(error),
            )
            .status(),
            actix_web::http::StatusCode::FORBIDDEN
        );
    }
    base.dbx
        .execute_unprepared(
            "update system_settings set devices_section_enabled = true",
        )
        .await
        .unwrap();
    crate::file_registry::migrate_if_enabled(
        &base.config,
        Mode::Test,
        &base.dbx,
    )
    .await
    .unwrap();
    let enabled = new_env_from_config(Mode::Test, true, base.config.clone())
        .await
        .unwrap();
    enabled
        .file_registry_db()
        .unwrap()
        .connection()
        .execute_unprepared("select 1 from device_audio limit 1")
        .await
        .unwrap();
    let mut tasks = JoinSet::new();
    let cancellation = CancellationToken::new();
    spawn_device_audio_workers(&mut tasks, enabled, cancellation, true);
    assert!(!tasks.is_empty());
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
}
