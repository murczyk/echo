use super::super::{SetSettingsCommand, SettingsCommand};
use super::*;
use crate::file_registry::entities::device_audio_asr_setting as setting;
use sea_orm::{ConnectionTrait, QuerySelect, TransactionTrait};

fn scope(actor_id: Uuid, device_id: Uuid) -> SettingsCommand {
    SettingsCommand {
        actor_id,
        device_id,
    }
}

async fn set(
    env: &crate::types::Env,
    actor: Uuid,
    device: Uuid,
    enabled: bool,
) -> anyhow::Result<types::DeviceAudioAsrSettingsRsp> {
    super::super::set_settings(
        &env.device_audio,
        SetSettingsCommand {
            scope: scope(actor, device),
            enabled,
        },
    )
    .await
}

async fn get(
    env: &crate::types::Env,
    actor: Uuid,
    device: Uuid,
) -> anyhow::Result<types::DeviceAudioAsrSettingsRsp> {
    super::super::settings(&env.device_audio, scope(actor, device)).await
}

async fn wait_setting_lock(files: &sea_orm::DatabaseConnection) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let row = files.query_one_raw(sea_orm::Statement::from_string(sea_orm::DbBackend::Postgres,
                "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%device_audio_asr_setting%') AS waiting")).await.unwrap().unwrap();
            if row.try_get::<bool>("", "waiting").unwrap() { break; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.unwrap();
}

#[actix_web::test]
#[serial_test::serial]
async fn missing_setting_is_read_only_and_concurrent_false_cannot_be_overwritten_by_default(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    let files = env.device_audio.file_database().unwrap();
    let response = get(&env, actor, device).await.unwrap();
    assert!(response.enabled && response.can_manage_setting);
    assert!(setting::Entity::find_by_id(device)
        .one(files)
        .await
        .unwrap()
        .is_none());
    let publication = async {
        let txn = files.begin().await.unwrap();
        super::super::admission::lock_setting(&txn, device)
            .await
            .unwrap();
        txn.commit().await.unwrap();
    };
    let writes = futures_util::future::join_all(
        (0..10).map(|_| set(&env, actor, device, false)),
    );
    let (_, replies) = tokio::join!(publication, writes);
    assert!(replies.into_iter().all(|reply| !reply.unwrap().enabled));
    let before = setting::Entity::find_by_id(device)
        .one(files)
        .await
        .unwrap()
        .unwrap();
    assert!(!set(&env, actor, device, false).await.unwrap().enabled);
    let after = setting::Entity::find_by_id(device)
        .one(files)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(before.updated_at, after.updated_at);
    assert_eq!(after.updated_by_login_id, Some(actor));
}

#[actix_web::test]
#[serial_test::serial]
async fn setting_respects_edit_roles_visibility_archive_and_other_devices() {
    use super::super::super::tests::{
        audio_actor, audio_device, audio_organism,
    };
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    let login = crate::entities::login::Entity::find_by_id(actor)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    let org = login.organism_id.unwrap();
    let viewer = audio_actor(&env.dbx, org, &["CyberViewer"]).await;
    let source = audio_actor(&env.dbx, org, &["DeviceSource"]).await;
    let admin = audio_actor(&env.dbx, org, &["Admin"]).await;
    let other = audio_device(&env.dbx, &login, org, false).await;
    let archived = audio_device(&env.dbx, &login, org, true).await;
    let foreign_org = audio_organism(&env.dbx, None).await;
    let foreign = audio_actor(&env.dbx, foreign_org.id, &["Cyber"]).await;
    let response = get(&env, viewer.id, device).await.unwrap();
    assert!(!response.can_manage_setting);
    assert!(response.blocked_reason.is_some());
    for unauthorized in [viewer.id, source.id, foreign.id] {
        assert!(set(&env, unauthorized, device, false).await.is_err());
    }
    assert!(get(&env, source.id, device).await.is_err());
    assert!(get(&env, foreign.id, device).await.is_err());
    assert!(
        !get(&env, actor, archived.id)
            .await
            .unwrap()
            .can_manage_setting
    );
    assert!(set(&env, actor, archived.id, false).await.is_err());
    assert!(!set(&env, actor, device, false).await.unwrap().enabled);
    assert!(get(&env, actor, other.id).await.unwrap().enabled);
    assert!(set(&env, admin.id, device, true).await.unwrap().enabled);
}

#[actix_web::test]
#[serial_test::serial]
async fn setting_rechecks_role_and_organization_after_waiting_for_row_lock() {
    use super::super::super::tests::audio_organism;
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    set(&env, actor, device, true).await.unwrap();
    let foreign_org = audio_organism(&env.dbx, None).await;
    let original = crate::entities::login::Entity::find_by_id(actor)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    for revoke_role in [true, false] {
        let files = env.device_audio.file_database().unwrap();
        let txn = files.begin().await.unwrap();
        setting::Entity::find_by_id(device)
            .lock_exclusive()
            .one(&txn)
            .await
            .unwrap();
        let runtime = env.device_audio.clone();
        let pending = tokio::spawn(async move {
            super::super::set_settings(
                &runtime,
                SetSettingsCommand {
                    scope: scope(actor, device),
                    enabled: false,
                },
            )
            .await
        });
        wait_setting_lock(files).await;
        let mut login = original.clone().into_active_model();
        if revoke_role {
            login.roles = Set(serde_json::json!(["CyberViewer"]));
        } else {
            login.organism_id = Set(Some(foreign_org.id));
        }
        login.update(&env.dbx).await.unwrap();
        txn.commit().await.unwrap();
        assert!(pending.await.unwrap().is_err());
        assert!(
            setting::Entity::find_by_id(device)
                .one(files)
                .await
                .unwrap()
                .unwrap()
                .enabled
        );
        let mut restored = original.clone().into_active_model();
        restored.roles = Set(original.roles.clone());
        restored.organism_id = Set(original.organism_id);
        restored.update(&env.dbx).await.unwrap();
    }
}

#[actix_web::test]
#[serial_test::serial]
async fn device_disable_fences_dispatch_but_keeps_running_result_and_pauses_retry(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    enable_asr(&env).await;
    let audio = accepted(&env, actor, device).await;
    let claim = asr_query::claim(&env.device_audio, Uuid::new_v4())
        .await
        .unwrap()
        .unwrap();
    set(&env, actor, device, false).await.unwrap();
    assert!(!asr_query::dispatch(
        &env.device_audio,
        &claim,
        Uuid::new_v4(),
        Uuid::new_v4()
    )
    .await
    .unwrap());
    assert!(asr_query::claim(&env.device_audio, Uuid::new_v4())
        .await
        .unwrap()
        .is_none());
    set(&env, actor, device, true).await.unwrap();
    let claim = asr_query::claim(&env.device_audio, Uuid::new_v4())
        .await
        .unwrap()
        .unwrap();
    asr_query::fail(
        &env.device_audio,
        &claim,
        super::super::Failure::Safe("connect"),
    )
    .await
    .unwrap();
    let files = env.device_audio.file_database().unwrap();
    let mut retry = recovery_tests::job(&env, audio.id)
        .await
        .into_active_model();
    retry.next_attempt_at = Set(Some(chrono::Utc::now().fixed_offset()));
    retry.update(files).await.unwrap();
    set(&env, actor, device, false).await.unwrap();
    assert!(asr_query::claim(&env.device_audio, Uuid::new_v4())
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        recovery_tests::job(&env, audio.id).await.state,
        "retry_wait"
    );
    set(&env, actor, device, true).await.unwrap();
    let claim = asr_query::claim(&env.device_audio, Uuid::new_v4())
        .await
        .unwrap()
        .unwrap();
    assert!(asr_query::dispatch(
        &env.device_audio,
        &claim,
        Uuid::new_v4(),
        Uuid::new_v4()
    )
    .await
    .unwrap());
    set(&env, actor, device, false).await.unwrap();
    assert!(asr_query::complete(
        &env.device_audio,
        &claim,
        "kept after disable"
    )
    .await
    .unwrap());
    let current = device_audio::Entity::find_by_id(audio.id)
        .one(files)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        current.automatic_transcription.as_deref(),
        Some("kept after disable")
    );
    assert_eq!(current.text_version, audio.text_version);
    assert_eq!(current.processing_version, audio.processing_version);
}

#[actix_web::test]
#[serial_test::serial]
async fn enabling_does_not_discover_history_or_revive_suppressed_jobs() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    enable_asr(&env).await;
    set(&env, actor, device, false).await.unwrap();
    let suppressed = accepted(&env, actor, device).await;
    let historical = accepted(&env, actor, device).await;
    let files = env.device_audio.file_database().unwrap();
    device_audio_asr_job::Entity::delete_by_id(historical.id)
        .exec(files)
        .await
        .unwrap();
    assert_eq!(
        recovery_tests::job(&env, suppressed.id).await.state,
        "suppressed"
    );
    set(&env, actor, device, true).await.unwrap();
    asr_query::resolve_pending(&env.device_audio).await.unwrap();
    assert!(asr_query::claim(&env.device_audio, Uuid::new_v4())
        .await
        .unwrap()
        .is_none());
    assert!(device_audio_asr_job::Entity::find_by_id(historical.id)
        .one(files)
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        recovery_tests::job(&env, suppressed.id).await.state,
        "suppressed"
    );
}

#[actix_web::test]
#[serial_test::serial]
async fn settings_save_serializes_with_archive_and_global_settings_replacement()
{
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    enable_asr(&env).await;
    set(&env, actor, device, true).await.unwrap();
    let files = env.device_audio.file_database().unwrap();
    let txn = files.begin().await.unwrap();
    setting::Entity::find_by_id(device)
        .lock_exclusive()
        .one(&txn)
        .await
        .unwrap();
    let runtime = env.device_audio.clone();
    let pending = tokio::spawn(async move {
        super::super::set_settings(
            &runtime,
            SetSettingsCommand {
                scope: scope(actor, device),
                enabled: false,
            },
        )
        .await
    });
    wait_setting_lock(files).await;
    let dbx = env.dbx.clone();
    let archive = tokio::spawn(async move {
        let mut device = crate::entities::device::Entity::find_by_id(device)
            .one(&dbx)
            .await
            .unwrap()
            .unwrap()
            .into_active_model();
        device.archived = Set(true);
        device.archived_at = Set(Some(chrono::Utc::now().naive_utc()));
        device.update(&dbx).await.unwrap();
    });
    let dbx = env.dbx.clone();
    let replacement = tokio::spawn(async move {
        let txn = dbx.begin().await.unwrap();
        let current = crate::system_settings::get_active_system_settings(&txn)
            .await
            .unwrap()
            .unwrap();
        let mut previous = current.clone().into_active_model();
        previous.deleted = Set(true);
        previous.update(&txn).await.unwrap();
        let mut replacement = current.into_active_model();
        replacement.id = sea_orm::ActiveValue::NotSet;
        replacement.enable_audio_transcription = Set(false);
        replacement.insert(&txn).await.unwrap();
        txn.commit().await.unwrap();
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let row = env.dbx.query_one_raw(sea_orm::Statement::from_string(sea_orm::DbBackend::Postgres,
                "SELECT count(*)::bigint AS waiting FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND (query LIKE 'UPDATE%device%' OR query LIKE 'UPDATE%system_settings%')")).await.unwrap().unwrap();
            if row.try_get::<i64>("", "waiting").unwrap() == 2 { break; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.unwrap();
    txn.commit().await.unwrap();
    assert!(!pending.await.unwrap().unwrap().enabled);
    archive.await.unwrap();
    replacement.await.unwrap();
    let saved = get(&env, actor, device).await.unwrap();
    assert!(
        !saved.enabled && !saved.global_enabled && !saved.can_manage_setting
    );
    assert!(set(&env, actor, device, true).await.is_err());
}

#[actix_web::test]
#[serial_test::serial]
async fn lost_main_guard_rolls_back_setting_and_single_connection_save_can_finish(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    set(&env, actor, device, true).await.unwrap();
    let mut runtime = (*env.device_audio).clone();
    runtime.dbx = crate::new_pg_pool_from_conn_string_with_max_connections(
        crate::mk_conn_string(&env.config),
        1,
    )
    .await
    .unwrap();
    let row = runtime
        .dbx
        .query_one_raw(sea_orm::Statement::from_string(
            sea_orm::DbBackend::Postgres,
            "SELECT pg_backend_pid() AS pid",
        ))
        .await
        .unwrap()
        .unwrap();
    let pid: i32 = row.try_get("", "pid").unwrap();
    let files = env.device_audio.file_database().unwrap();
    let txn = files.begin().await.unwrap();
    setting::Entity::find_by_id(device)
        .lock_exclusive()
        .one(&txn)
        .await
        .unwrap();
    let pending_runtime = runtime.clone();
    let pending = tokio::spawn(async move {
        super::super::set_settings(
            &pending_runtime,
            SetSettingsCommand {
                scope: scope(actor, device),
                enabled: false,
            },
        )
        .await
    });
    wait_setting_lock(files).await;
    env.dbx
        .execute_unprepared(&format!("SELECT pg_terminate_backend({pid})"))
        .await
        .unwrap();
    txn.commit().await.unwrap();
    assert!(pending.await.unwrap().is_err());
    assert!(get(&env, actor, device).await.unwrap().enabled);
    let saved = tokio::time::timeout(
        Duration::from_secs(3),
        super::super::set_settings(
            &runtime,
            SetSettingsCommand {
                scope: scope(actor, device),
                enabled: false,
            },
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(!saved.enabled);
}
