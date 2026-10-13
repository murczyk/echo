use super::super::{backfill_query as backfill, Failure};
use super::*;
use crate::file_registry::entities::{
    device_audio_asr_backfill as runs, device_audio_asr_backfill_item as items,
};
use sea_orm::{ColumnTrait, ConnectionTrait, QueryFilter, TransactionTrait};

#[actix_web::test]
#[serial_test::serial]
async fn backfill_snapshot_is_finite_with_ties_and_late_commits_and_rolls_back_unsealed(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    let audio = accepted(&env, actor, device).await;
    let db = env.device_audio.file_database().unwrap();
    db.execute_unprepared(&format!(
        "UPDATE device_audio SET transcription='manual only' WHERE id='{}'",
        audio.id
    ))
    .await
    .unwrap();
    let late = db.begin().await.unwrap();
    clone_audio(&late, audio.id, 1).await;
    let (snapshot, run) =
        backfill::begin_snapshot(&env.device_audio, Some(device))
            .await
            .unwrap();
    late.commit().await.unwrap();
    let upper = backfill::snapshot_page(&snapshot, run, Some(device), None)
        .await
        .unwrap();
    assert!(upper.is_some());
    assert!(backfill::snapshot_page(&snapshot, run, Some(device), upper)
        .await
        .unwrap()
        .is_none());
    backfill::seal_snapshot(snapshot, run, upper).await.unwrap();
    let members = items::Entity::find()
        .filter(items::Column::RunId.eq(run))
        .all(db)
        .await
        .unwrap();
    assert_eq!(members.len(), 1, "late commit must not enter the snapshot");
    assert_eq!(members[0].audio_id, audio.id);
    let (snapshot, unsealed) =
        backfill::begin_snapshot(&env.device_audio, Some(device))
            .await
            .unwrap();
    backfill::snapshot_page(&snapshot, unsealed, Some(device), None)
        .await
        .unwrap();
    snapshot.rollback().await.unwrap();
    assert!(runs::Entity::find_by_id(unsealed)
        .one(db)
        .await
        .unwrap()
        .is_none());
    clone_audio(db, audio.id, 205).await;
    let run = backfill::snapshot(&env.device_audio, Some(device))
        .await
        .unwrap();
    assert_eq!(
        items::Entity::find()
            .filter(items::Column::RunId.eq(run))
            .all(db)
            .await
            .unwrap()
            .len(),
        207
    );
}

#[actix_web::test]
#[serial_test::serial]
async fn backfill_owner_fences_accounting_resumes_current_and_never_retries_finalized_items(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    let audio = accepted(&env, actor, device).await;
    enable_asr(&env).await;
    let db = env.device_audio.file_database().unwrap();
    let run = backfill::snapshot(&env.device_audio, Some(device))
        .await
        .unwrap();
    let owner = Uuid::new_v4();
    backfill::acquire(&env.device_audio, run, owner)
        .await
        .unwrap();
    assert!(backfill::acquire(&env.device_audio, run, Uuid::new_v4())
        .await
        .is_err());
    assert_eq!(
        backfill::step(&env.device_audio, run, owner).await.unwrap(),
        backfill::Step::Waiting
    );
    let claim = asr_query::claim(&env.device_audio, owner)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claim.target.audio_id, audio.id);
    asr_query::dispatch(
        &env.device_audio,
        &claim,
        Uuid::new_v4(),
        Uuid::new_v4(),
    )
    .await
    .unwrap();
    asr_query::complete(&env.device_audio, &claim, "")
        .await
        .unwrap();
    backfill::release(&env.device_audio, run, owner, false)
        .await
        .unwrap();
    let next = Uuid::new_v4();
    backfill::acquire(&env.device_audio, run, next)
        .await
        .unwrap();
    assert!(backfill::step(&env.device_audio, run, owner).await.is_err());
    assert_eq!(
        backfill::step(&env.device_audio, run, next).await.unwrap(),
        backfill::Step::Finalized
    );
    assert_eq!(
        backfill::step(&env.device_audio, run, next).await.unwrap(),
        backfill::Step::Done
    );
    let record = runs::Entity::find_by_id(run)
        .one(db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!((record.checked, record.no_speech, record.failed), (1, 1, 0));
    assert_eq!(
        recovery_tests::job(&env, audio.id).await.generation,
        claim.token.generation
    );
    let fresh = backfill::snapshot(&env.device_audio, Some(device))
        .await
        .unwrap();
    backfill::acquire(&env.device_audio, fresh, next)
        .await
        .unwrap();
    backfill::step(&env.device_audio, fresh, next)
        .await
        .unwrap();
    assert_ne!(
        recovery_tests::job(&env, audio.id).await.generation,
        claim.token.generation
    );
}

#[actix_web::test]
#[serial_test::serial]
async fn backfill_recovery_reopens_only_audited_attempt_and_preserves_manual_text(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    let audio = accepted(&env, actor, device).await;
    enable_asr(&env).await;
    let db = env.device_audio.file_database().unwrap();
    db.execute_unprepared(&format!(
        "UPDATE device_audio SET transcription='keep manual' WHERE id='{}'",
        audio.id
    ))
    .await
    .unwrap();
    let run = backfill::snapshot(&env.device_audio, Some(device))
        .await
        .unwrap();
    let owner = Uuid::new_v4();
    backfill::acquire(&env.device_audio, run, owner)
        .await
        .unwrap();
    backfill::step(&env.device_audio, run, owner).await.unwrap();
    let claim = asr_query::claim(&env.device_audio, owner)
        .await
        .unwrap()
        .unwrap();
    asr_query::dispatch(
        &env.device_audio,
        &claim,
        Uuid::new_v4(),
        Uuid::new_v4(),
    )
    .await
    .unwrap();
    asr_query::fail(&env.device_audio, &claim, Failure::Unknown)
        .await
        .unwrap();
    assert_eq!(
        backfill::step(&env.device_audio, run, owner).await.unwrap(),
        backfill::Step::RecoveryRequired
    );
    backfill::release(&env.device_audio, run, owner, false)
        .await
        .unwrap();
    backfill::acquire(&env.device_audio, run, owner)
        .await
        .unwrap();
    let record = runs::Entity::find_by_id(run)
        .one(db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!((record.checked, record.recovery_required), (1, 1));
    backfill::release(&env.device_audio, run, owner, false)
        .await
        .unwrap();
    super::super::recovery::recover(
        &env.device_audio,
        super::super::RecoveryCommand {
            audio_id: audio.id,
            expected_attempt_id: claim.token.attempt_id,
            verification_note: "test provider is stopped".into(),
            operator: "test".into(),
        },
    )
    .await
    .unwrap();
    backfill::acquire(&env.device_audio, run, owner)
        .await
        .unwrap();
    let record = runs::Entity::find_by_id(run)
        .one(db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!((record.checked, record.recovery_required), (0, 0));
    backfill::step(&env.device_audio, run, owner).await.unwrap();
    let next = asr_query::claim(&env.device_audio, owner)
        .await
        .unwrap()
        .unwrap();
    asr_query::dispatch(
        &env.device_audio,
        &next,
        Uuid::new_v4(),
        Uuid::new_v4(),
    )
    .await
    .unwrap();
    asr_query::complete(&env.device_audio, &next, "automatic")
        .await
        .unwrap();
    backfill::step(&env.device_audio, run, owner).await.unwrap();
    let audio = device_audio::Entity::find_by_id(audio.id)
        .one(db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(audio.transcription, "keep manual");
    assert_eq!(audio.automatic_transcription.as_deref(), Some("automatic"));
    let record = runs::Entity::find_by_id(run)
        .one(db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (record.checked, record.succeeded, record.recovery_required),
        (1, 1, 0)
    );
}

async fn clone_audio(db: &impl ConnectionTrait, id: Uuid, count: i32) {
    db.execute_unprepared(&format!(r#"
WITH ids AS MATERIALIZED (
 SELECT gen_random_uuid() AS audio_id, gen_random_uuid() AS ingest_id FROM generate_series(1,{count})
), source AS MATERIALIZED (SELECT * FROM device_audio WHERE id='{id}'),
cloned AS (
 INSERT INTO device_audio_ingest
 SELECT (jsonb_populate_record(NULL::device_audio_ingest, to_jsonb(i) ||
 jsonb_build_object('id',ids.ingest_id,'audio_id',ids.audio_id,'status','finalizing',
 'tus_upload_id',ids.ingest_id,'tus_upload_ref',ids.ingest_id::text,
 'name',ids.audio_id::text,'name_key',convert_to(ids.audio_id::text,'UTF8'),
 'storage_key','device-audio/'||i.device_id::text||'/'||ids.audio_id::text||'/'||ids.ingest_id::text))).*
 FROM device_audio_ingest i JOIN source s ON s.ingest_id=i.id CROSS JOIN ids RETURNING *
)
INSERT INTO device_audio
 SELECT (jsonb_populate_record(NULL::device_audio, to_jsonb(s) ||
 jsonb_build_object('id',i.audio_id,'ingest_id',i.id,'name',i.name,'name_key',i.name_key,'storage_key',i.storage_key))).*
 FROM source s CROSS JOIN cloned i;
UPDATE device_audio_ingest SET status='storing' WHERE status='finalizing' AND audio_id IN (SELECT id FROM device_audio);
UPDATE device_audio_ingest SET status='ready' WHERE status='storing' AND audio_id IN (SELECT id FROM device_audio);
"#)).await.unwrap();
}

#[actix_web::test]
#[serial_test::serial]
async fn backfill_accounting_rolls_back_with_cursor_and_distinguishes_already_present(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    let audio = accepted(&env, actor, device).await;
    let db = env.device_audio.file_database().unwrap();
    enable_asr(&env).await;
    let run = backfill::snapshot(&env.device_audio, Some(device))
        .await
        .unwrap();
    let owner = Uuid::new_v4();
    backfill::acquire(&env.device_audio, run, owner)
        .await
        .unwrap();
    db.execute_unprepared(&format!("UPDATE device_audio SET automatic_transcription='already there', automatic_transcribed_at=now() WHERE id='{}'", audio.id)).await.unwrap();
    db.execute_unprepared("CREATE FUNCTION reject_backfill_accounting() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.checked > OLD.checked THEN RAISE EXCEPTION 'injected accounting failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_backfill_accounting BEFORE UPDATE ON device_audio_asr_backfill FOR EACH ROW EXECUTE FUNCTION reject_backfill_accounting();").await.unwrap();
    assert!(backfill::step(&env.device_audio, run, owner).await.is_err());
    let item = items::Entity::find_by_id((run, audio.id))
        .one(db)
        .await
        .unwrap()
        .unwrap();
    assert!(item.outcome.is_none());
    let record = runs::Entity::find_by_id(run)
        .one(db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(record.checked, 0);
    assert!(record.cursor_id.is_none());
    db.execute_unprepared("DROP TRIGGER reject_backfill_accounting ON device_audio_asr_backfill; DROP FUNCTION reject_backfill_accounting();").await.unwrap();
    assert_eq!(
        backfill::step(&env.device_audio, run, owner).await.unwrap(),
        backfill::Step::Finalized
    );
    let item = items::Entity::find_by_id((run, audio.id))
        .one(db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(item.reason_code.as_deref(), Some("already_present"));
    let record = runs::Entity::find_by_id(run)
        .one(db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (record.checked, record.skipped, record.succeeded),
        (1, 1, 0)
    );
    let empty = backfill::snapshot(&env.device_audio, Some(device))
        .await
        .unwrap();
    assert!(items::Entity::find()
        .filter(items::Column::RunId.eq(empty))
        .all(db)
        .await
        .unwrap()
        .is_empty());
}

async fn unknown_backfill(
    env: &crate::types::Env,
    device: Uuid,
    account: bool,
) -> (Uuid, super::super::Claim) {
    let run = backfill::snapshot(&env.device_audio, Some(device))
        .await
        .unwrap();
    let owner = Uuid::new_v4();
    backfill::acquire(&env.device_audio, run, owner)
        .await
        .unwrap();
    backfill::step(&env.device_audio, run, owner).await.unwrap();
    let claim = asr_query::claim(&env.device_audio, owner)
        .await
        .unwrap()
        .unwrap();
    asr_query::dispatch(
        &env.device_audio,
        &claim,
        Uuid::new_v4(),
        Uuid::new_v4(),
    )
    .await
    .unwrap();
    asr_query::fail(&env.device_audio, &claim, Failure::Unknown)
        .await
        .unwrap();
    if account {
        assert_eq!(
            backfill::step(&env.device_audio, run, owner).await.unwrap(),
            backfill::Step::RecoveryRequired
        );
    }
    backfill::release(&env.device_audio, run, owner, false)
        .await
        .unwrap();
    (run, claim)
}

async fn verify_stopped(env: &crate::types::Env, claim: &super::super::Claim) {
    super::super::recovery::recover(
        &env.device_audio,
        super::super::RecoveryCommand {
            audio_id: claim.target.audio_id,
            expected_attempt_id: claim.token.attempt_id,
            verification_note: "test attempt is stopped".into(),
            operator: "test".into(),
        },
    )
    .await
    .unwrap();
}

#[actix_web::test]
#[serial_test::serial]
async fn backfill_resumes_audited_unfinished_item_before_unknown_was_accounted()
{
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    accepted(&env, actor, device).await;
    enable_asr(&env).await;
    let (run, claim) = unknown_backfill(&env, device, false).await;
    verify_stopped(&env, &claim).await;
    let owner = Uuid::new_v4();
    backfill::acquire(&env.device_audio, run, owner)
        .await
        .unwrap();
    assert_eq!(
        backfill::step(&env.device_audio, run, owner).await.unwrap(),
        backfill::Step::Waiting
    );
    let next = asr_query::claim(&env.device_audio, owner)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(next.token.generation, claim.token.generation);
}

#[actix_web::test]
#[serial_test::serial]
async fn backfill_keeps_recovery_evidence_after_a_later_run_was_also_recovered()
{
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    accepted(&env, actor, device).await;
    enable_asr(&env).await;
    let (first, claim) = unknown_backfill(&env, device, true).await;
    verify_stopped(&env, &claim).await;
    let (second, next) = unknown_backfill(&env, device, true).await;
    verify_stopped(&env, &next).await;
    let owner = Uuid::new_v4();
    backfill::acquire(&env.device_audio, first, owner)
        .await
        .unwrap();
    let record = runs::Entity::find_by_id(first)
        .one(env.device_audio.file_database().unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!((record.checked, record.recovery_required), (0, 0));
    let other = runs::Entity::find_by_id(second)
        .one(env.device_audio.file_database().unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (other.checked, other.recovery_required),
        (1, 1),
        "another run's counters change only on its own resume"
    );
}

#[actix_web::test]
#[serial_test::serial]
async fn backfill_reconciles_late_definite_result_without_a_new_attempt() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    accepted(&env, actor, device).await;
    enable_asr(&env).await;
    let (run, claim) = unknown_backfill(&env, device, true).await;
    assert!(
        asr_query::complete(&env.device_audio, &claim, "late automatic")
            .await
            .unwrap()
    );
    let owner = Uuid::new_v4();
    backfill::acquire(&env.device_audio, run, owner)
        .await
        .unwrap();
    assert_eq!(
        backfill::step(&env.device_audio, run, owner).await.unwrap(),
        backfill::Step::Done
    );
    let report = backfill::report(&env.device_audio, run).await.unwrap();
    assert_eq!(
        (report.checked, report.succeeded, report.recovery_required),
        (1, 1, 0)
    );
    assert_eq!(
        recovery_tests::job(&env, claim.target.audio_id)
            .await
            .generation,
        claim.token.generation
    );
    assert!(asr_query::claim(&env.device_audio, owner)
        .await
        .unwrap()
        .is_none());
}

#[actix_web::test]
#[serial_test::serial]
async fn backfill_reconciles_late_archive_cancellation() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    accepted(&env, actor, device).await;
    enable_asr(&env).await;
    let (run, claim) = unknown_backfill(&env, device, true).await;
    let mut archived = crate::entities::device::Entity::find_by_id(device)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap()
        .into_active_model();
    archived.archived = Set(true);
    archived.archived_at = Set(Some(chrono::Utc::now().naive_utc()));
    archived.update(&env.dbx).await.unwrap();
    asr_query::complete(&env.device_audio, &claim, "late response")
        .await
        .unwrap();
    assert_eq!(
        recovery_tests::job(&env, claim.target.audio_id).await.state,
        "cancelled"
    );
    assert_eq!(
        backfill::report(&env.device_audio, run)
            .await
            .unwrap()
            .recovery_required,
        1
    );
    backfill::acquire(&env.device_audio, run, Uuid::new_v4())
        .await
        .unwrap();
    let report = backfill::report(&env.device_audio, run).await.unwrap();
    assert_eq!(
        (report.checked, report.skipped, report.recovery_required),
        (1, 1, 0)
    );
}

#[actix_web::test]
#[serial_test::serial]
async fn backfill_reconciles_late_safe_failure_without_retrying_exhausted_work()
{
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    accepted(&env, actor, device).await;
    enable_asr(&env).await;
    let (run, claim) = unknown_backfill(&env, device, true).await;
    let mut exhausted = recovery_tests::job(&env, claim.target.audio_id)
        .await
        .into_active_model();
    exhausted.attempt_count =
        Set(crate::devices::config::DEVICE_AUDIO_ASR_MAX_ATTEMPTS);
    exhausted
        .update(env.device_audio.file_database().unwrap())
        .await
        .unwrap();
    asr_query::fail(
        &env.device_audio,
        &claim,
        Failure::Safe("provider_not_ready"),
    )
    .await
    .unwrap();
    assert_eq!(
        recovery_tests::job(&env, claim.target.audio_id).await.state,
        "failed"
    );
    let owner = Uuid::new_v4();
    backfill::acquire(&env.device_audio, run, owner)
        .await
        .unwrap();
    let report = backfill::report(&env.device_audio, run).await.unwrap();
    assert_eq!(
        (report.checked, report.failed, report.recovery_required),
        (1, 1, 0)
    );
    assert!(asr_query::claim(&env.device_audio, owner)
        .await
        .unwrap()
        .is_none());
}

#[actix_web::test]
#[serial_test::serial]
async fn backfill_keeps_late_no_speech_after_another_generation_succeeded() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    accepted(&env, actor, device).await;
    enable_asr(&env).await;
    let (run, claim) = unknown_backfill(&env, device, true).await;
    asr_query::complete(&env.device_audio, &claim, "")
        .await
        .unwrap();
    let owner = Uuid::new_v4();
    let newer = backfill::snapshot(&env.device_audio, Some(device))
        .await
        .unwrap();
    backfill::acquire(&env.device_audio, newer, owner)
        .await
        .unwrap();
    backfill::step(&env.device_audio, newer, owner)
        .await
        .unwrap();
    let next = asr_query::claim(&env.device_audio, owner)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(claim.token.generation, next.token.generation);
    asr_query::dispatch(
        &env.device_audio,
        &next,
        Uuid::new_v4(),
        Uuid::new_v4(),
    )
    .await
    .unwrap();
    asr_query::complete(&env.device_audio, &next, "new result")
        .await
        .unwrap();
    backfill::acquire(&env.device_audio, run, owner)
        .await
        .unwrap();
    let report = backfill::report(&env.device_audio, run).await.unwrap();
    assert_eq!(
        (report.checked, report.no_speech, report.recovery_required),
        (1, 1, 0)
    );
}
