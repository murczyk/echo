use super::super::{ActorAudioCommand, AudioTarget};
use super::*;

fn command(actor: Uuid, device: Uuid, audio: Uuid) -> ActorAudioCommand {
    ActorAudioCommand {
        actor_id: actor,
        target: AudioTarget {
            device_id: device,
            audio_id: audio,
        },
    }
}

#[actix_web::test]
#[serial_test::serial]
async fn cached_historical_manual_audio_is_admitted_on_open() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    let audio = accepted(&env, actor, device).await;
    let files = env.device_audio.file_database().unwrap();
    env.device_audio.preparation.tasks.close();
    env.device_audio.preparation.tasks.wait().await;
    assert!(content::readiness(&env.device_audio, audio.id)
        .await
        .unwrap()
        .into_iter()
        .all(|ready| ready));
    device_audio_asr_job::Entity::delete_by_id(audio.id)
        .exec(files)
        .await
        .unwrap();
    save_transcription(
        &env.device_audio,
        actor,
        types::SaveDeviceAudioTranscriptionCommand {
            device_id: device,
            audio_id: audio.id,
            text: "old manual".into(),
            expected_text_version: audio.text_version,
        },
    )
    .await
    .unwrap();
    enable_asr(&env).await;
    let rejected = super::super::retry(
        &env.device_audio,
        command(actor, device, audio.id),
    )
    .await
    .unwrap_err();
    assert!(format!("{:?}", AppError::from(rejected))
        .contains("retry_not_available"));
    for _ in 0..2 {
        let prepared = preparation::prepare(
            env.device_audio.clone(),
            actor,
            device,
            audio.id,
            false,
        )
        .await
        .unwrap();
        assert_eq!(prepared.content, types::DeviceAudioPreparationState::Ready);
    }
    let job = device_audio_asr_job::Entity::find_by_id(audio.id)
        .one(files)
        .await
        .unwrap();
    assert!(
        job.is_some(),
        "cached old audio must get durable interactive admission"
    );
    let job = job.unwrap();
    assert_eq!(job.state, "queued");
    assert_eq!(job.priority, 0);
    assert_eq!(job.trigger, "interactive");
    assert_eq!(job.attempt_count, 0);
    let current = device_audio::Entity::find_by_id(audio.id)
        .one(files)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(current.transcription, "old manual");
    assert_eq!(current.processing_version, audio.processing_version);
}

async fn set_job_state(env: &crate::types::Env, id: Uuid, state: &str) {
    let mut job = super::recovery_tests::job(env, id)
        .await
        .into_active_model();
    job.state = Set(state.into());
    job.next_attempt_at = Set(None);
    job.update(env.device_audio.file_database().unwrap())
        .await
        .unwrap();
}

#[actix_web::test]
#[serial_test::serial]
async fn opens_promote_without_bypassing_safe_retry_and_ten_retries_converge() {
    use super::super::{open, retry, Failure};
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    enable_asr(&env).await;
    let audio = accepted(&env, actor, device).await;
    let request = command(actor, device, audio.id);
    let before = super::recovery_tests::job(&env, audio.id).await;
    open(&env.device_audio, request).await.unwrap();
    let promoted = super::recovery_tests::job(&env, audio.id).await;
    assert_eq!(promoted.priority, 0);
    assert_eq!(promoted.generation, before.generation);
    let claim = asr_query::claim(&env.device_audio, Uuid::new_v4())
        .await
        .unwrap()
        .unwrap();
    asr_query::fail(&env.device_audio, &claim, Failure::Safe("connect"))
        .await
        .unwrap();
    let waiting = super::recovery_tests::job(&env, audio.id).await;
    for _ in 0..10 {
        open(&env.device_audio, request).await.unwrap();
    }
    let still_waiting = super::recovery_tests::job(&env, audio.id).await;
    assert_eq!(still_waiting.next_attempt_at, waiting.next_attempt_at);
    assert_eq!(still_waiting.generation, waiting.generation);
    assert!(asr_query::claim(&env.device_audio, Uuid::new_v4())
        .await
        .unwrap()
        .is_none());
    set_job_state(&env, audio.id, "failed").await;
    let replies = futures_util::future::join_all(
        (0..10).map(|_| retry(&env.device_audio, request)),
    )
    .await;
    let dispositions: Vec<_> = replies
        .into_iter()
        .map(|reply| {
            serde_json::to_value(reply.unwrap()).unwrap()["disposition"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect();
    assert_eq!(
        dispositions
            .iter()
            .filter(|value| *value == "queued")
            .count(),
        1
    );
    assert_eq!(
        dispositions
            .iter()
            .filter(|value| *value == "already_active")
            .count(),
        9
    );
    let retried = super::recovery_tests::job(&env, audio.id).await;
    assert_ne!(retried.generation, waiting.generation);
    assert_eq!(retried.attempt_count, 0);
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
    for response in futures_util::future::join_all(
        (0..10).map(|_| retry(&env.device_audio, request)),
    )
    .await
    {
        assert_eq!(
            serde_json::to_value(response.unwrap()).unwrap()["disposition"],
            "already_active"
        );
    }
    assert_eq!(
        super::recovery_tests::job(&env, audio.id).await.attempt_id,
        Some(claim.token.attempt_id)
    );
    let (completed, concurrent_retry) = tokio::join!(
        asr_query::complete(&env.device_audio, &claim, "auto"),
        retry(&env.device_audio, request),
    );
    assert!(completed.unwrap());
    assert!(["already_active", "already_completed"].contains(
        &serde_json::to_value(concurrent_retry.unwrap()).unwrap()
            ["disposition"]
            .as_str()
            .unwrap()
    ));
    assert_eq!(
        serde_json::to_value(retry(&env.device_audio, request).await.unwrap())
            .unwrap()["disposition"],
        "already_completed"
    );
}

#[actix_web::test]
#[serial_test::serial]
async fn ordinary_opens_keep_terminal_unknown_and_policy_blocks_retry() {
    use super::super::{open, retry, Failure};
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    enable_asr(&env).await;
    let audio = accepted(&env, actor, device).await;
    let request = command(actor, device, audio.id);
    for state in ["no_speech", "failed", "cancelled"] {
        set_job_state(&env, audio.id, state).await;
        let before = super::recovery_tests::job(&env, audio.id).await;
        open(&env.device_audio, request).await.unwrap();
        preparation::prepare(
            env.device_audio.clone(),
            actor,
            device,
            audio.id,
            true,
        )
        .await
        .unwrap();
        let after = super::recovery_tests::job(&env, audio.id).await;
        assert_eq!(after.state, state);
        assert_eq!(after.generation, before.generation);
    }
    set_job_state(&env, audio.id, "no_speech").await;
    retry(&env.device_audio, request).await.unwrap();
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
    asr_query::fail(&env.device_audio, &claim, Failure::Unknown)
        .await
        .unwrap();
    open(&env.device_audio, request).await.unwrap();
    let error = retry(&env.device_audio, request).await.unwrap_err();
    assert!(
        format!("{:?}", AppError::from(error)).contains("recovery_required")
    );
    assert_eq!(
        super::recovery_tests::job(&env, audio.id).await.attempt_id,
        Some(claim.token.attempt_id)
    );
    assert!(asr_query::complete(&env.device_audio, &claim, "late auto")
        .await
        .unwrap());
    let mut setting = crate::file_registry::entities::device_audio_asr_setting::Entity::find_by_id(device).one(env.device_audio.file_database().unwrap()).await.unwrap().unwrap().into_active_model();
    setting.enabled = Set(false);
    setting
        .update(env.device_audio.file_database().unwrap())
        .await
        .unwrap();
    assert!(format!(
        "{:?}",
        AppError::from(retry(&env.device_audio, request).await.unwrap_err())
    )
    .contains("transcription_disabled"));
    env.device_audio.preparation.shutdown().await;
}

#[actix_web::test]
#[serial_test::serial]
async fn viewer_can_open_and_retry_but_source_foreign_and_revoked_actor_cannot()
{
    use super::super::super::tests::{
        audio_actor, audio_device, audio_organism,
    };
    use super::super::{open, retry};
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    enable_asr(&env).await;
    let audio = accepted(&env, actor, device).await;
    let request = command(actor, device, audio.id);
    let login = crate::entities::login::Entity::find_by_id(actor)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    let viewer =
        audio_actor(&env.dbx, login.organism_id.unwrap(), &["CyberViewer"])
            .await;
    let source_actor =
        audio_actor(&env.dbx, login.organism_id.unwrap(), &["DeviceSource"])
            .await;
    let foreign_org = audio_organism(&env.dbx, None).await;
    let foreign = audio_actor(&env.dbx, foreign_org.id, &["Cyber"]).await;
    let other_device =
        audio_device(&env.dbx, &foreign, foreign_org.id, false).await;
    set_job_state(&env, audio.id, "failed").await;
    open(&env.device_audio, command(viewer.id, device, audio.id))
        .await
        .unwrap();
    let reply = retry(&env.device_audio, command(viewer.id, device, audio.id))
        .await
        .unwrap();
    assert!(!reply.availability.can_edit_manual);
    for request in [
        command(source_actor.id, device, audio.id),
        command(foreign.id, device, audio.id),
        command(foreign.id, other_device.id, audio.id),
    ] {
        assert!(open(&env.device_audio, request).await.is_err());
        assert!(retry(&env.device_audio, request).await.is_err());
    }
    let mut login = login.into_active_model();
    login.roles = Set(serde_json::json!([]));
    login.update(&env.dbx).await.unwrap();
    assert!(open(&env.device_audio, request).await.is_err());
    assert!(retry(&env.device_audio, request).await.is_err());
}

#[actix_web::test]
#[serial_test::serial]
async fn admission_rechecks_revoked_roles_after_waiting_for_policy_lock() {
    use sea_orm::{ConnectionTrait, QuerySelect, TransactionTrait};
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    enable_asr(&env).await;
    let audio = accepted(&env, actor, device).await;
    set_job_state(&env, audio.id, "failed").await;
    let files = env.device_audio.file_database().unwrap();
    let transaction = files.begin().await.unwrap();
    crate::file_registry::entities::device_audio_asr_setting::Entity::find_by_id(device).lock_exclusive().one(&transaction).await.unwrap();
    let runtime = env.device_audio.clone();
    let pending = tokio::spawn(async move {
        super::super::retry(&runtime, command(actor, device, audio.id)).await
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let row = files.query_one_raw(sea_orm::Statement::from_string(sea_orm::DbBackend::Postgres,
                "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%device_audio_asr_setting%') AS waiting".to_owned())).await.unwrap().unwrap();
            if row.try_get::<bool>("", "waiting").unwrap() { break; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.unwrap();
    let mut login = crate::entities::login::Entity::find_by_id(actor)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap()
        .into_active_model();
    login.roles = Set(serde_json::json!([]));
    login.update(&env.dbx).await.unwrap();
    transaction.commit().await.unwrap();
    assert!(pending.await.unwrap().is_err());
    assert_eq!(
        super::recovery_tests::job(&env, audio.id).await.state,
        "failed"
    );
}

#[actix_web::test]
#[serial_test::serial]
async fn admission_failure_returns_sanitized_error_without_blocking_cached_media(
) {
    use sea_orm::ConnectionTrait;
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    let audio = accepted(&env, actor, device).await;
    env.device_audio.preparation.tasks.close();
    env.device_audio.preparation.tasks.wait().await;
    enable_asr(&env).await;
    let files = env.device_audio.file_database().unwrap();
    files.execute_unprepared("CREATE FUNCTION test_reject_asr_setting() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private provider credential'; END $$; CREATE TRIGGER test_reject_asr_setting BEFORE INSERT ON device_audio_asr_setting FOR EACH ROW EXECUTE FUNCTION test_reject_asr_setting();").await.unwrap();
    let result = preparation::prepare(
        env.device_audio.clone(),
        actor,
        device,
        audio.id,
        false,
    )
    .await;
    files.execute_unprepared("DROP TRIGGER test_reject_asr_setting ON device_audio_asr_setting; DROP FUNCTION test_reject_asr_setting();").await.unwrap();
    let prepared = result.unwrap();
    assert_eq!(prepared.content, types::DeviceAudioPreparationState::Ready);
    let error = prepared.transcription_admission_error.unwrap();
    assert_eq!(error.code, "transcription_unavailable");
    assert!(!error.message.contains("private"));
}

#[actix_web::test]
#[serial_test::serial]
async fn interactive_admission_does_not_need_a_second_main_pool_connection() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    enable_asr(&env).await;
    let audio = accepted(&env, actor, device).await;
    let mut runtime = (*env.device_audio).clone();
    runtime.dbx = crate::new_pg_pool_from_conn_string_with_max_connections(
        crate::mk_conn_string(&env.config),
        1,
    )
    .await
    .unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(2),
        super::super::open(&runtime, command(actor, device, audio.id)),
    )
    .await;
    assert!(result.is_ok(), "interactive admission must not wait for a second main connection while holding its guard");
    result.unwrap().unwrap();
}
