use super::super::{recovery, Failure};
use super::*;
use crate::file_registry::entities::device_audio_asr_scheduler;

async fn running(
    env: &crate::types::Env,
    actor: Uuid,
    device: Uuid,
) -> (device_audio::Model, super::super::Claim) {
    let audio = accepted(env, actor, device).await;
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
    (audio, claim)
}

pub(super) async fn job(
    env: &crate::types::Env,
    id: Uuid,
) -> device_audio_asr_job::Model {
    device_audio_asr_job::Entity::find_by_id(id)
        .one(env.device_audio.file_database().unwrap())
        .await
        .unwrap()
        .unwrap()
}

async fn make_due(env: &crate::types::Env, id: Uuid) {
    let mut job = job(env, id).await.into_active_model();
    job.next_attempt_at = Set(Some(
        (chrono::Utc::now() - chrono::Duration::seconds(1)).fixed_offset(),
    ));
    job.update(env.device_audio.file_database().unwrap())
        .await
        .unwrap();
}

#[actix_web::test]
#[serial_test::serial]
async fn uncertain_dispatch_keeps_slot_across_stale_recovery_and_accepts_only_matching_late_result(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    enable_asr(&env).await;
    let (audio, claim) = running(&env, actor, device).await;
    asr_query::fail(&env.device_audio, &claim, Failure::Unknown)
        .await
        .unwrap();
    let mut old = job(&env, audio.id).await.into_active_model();
    old.heartbeat_at = Set(Some(
        (chrono::Utc::now() - chrono::Duration::hours(1)).fixed_offset(),
    ));
    old.update(env.device_audio.file_database().unwrap())
        .await
        .unwrap();
    asr_query::recover_stale(&env.device_audio).await.unwrap();
    assert_eq!(job(&env, audio.id).await.state, "outcome_unknown");
    assert!(asr_query::claim(&env.device_audio, Uuid::new_v4())
        .await
        .unwrap()
        .is_none());
    let slot = device_audio_asr_scheduler::Entity::find_by_id(1_i16)
        .one(env.device_audio.file_database().unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(slot.slot_attempt_id, Some(claim.token.attempt_id));
    let mut wrong = claim.clone();
    wrong.token.attempt_id = Uuid::new_v4();
    assert!(!asr_query::complete(&env.device_audio, &wrong, "wrong")
        .await
        .unwrap());
    assert!(
        asr_query::complete(&env.device_audio, &claim, "late definite")
            .await
            .unwrap()
    );
    assert_eq!(job(&env, audio.id).await.state, "succeeded");
}

#[actix_web::test]
#[serial_test::serial]
async fn stale_preparation_revokes_its_token_and_safe_retries_stop_at_budget() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    enable_asr(&env).await;
    let audio = accepted(&env, actor, device).await;
    let old = asr_query::claim(&env.device_audio, Uuid::new_v4())
        .await
        .unwrap()
        .unwrap();
    let mut stale = job(&env, audio.id).await.into_active_model();
    stale.heartbeat_at = Set(Some(
        (chrono::Utc::now() - chrono::Duration::hours(1)).fixed_offset(),
    ));
    stale
        .update(env.device_audio.file_database().unwrap())
        .await
        .unwrap();
    asr_query::recover_stale(&env.device_audio).await.unwrap();
    assert_eq!(job(&env, audio.id).await.state, "retry_wait");
    assert!(!asr_query::dispatch(
        &env.device_audio,
        &old,
        Uuid::new_v4(),
        Uuid::new_v4()
    )
    .await
    .unwrap());
    assert!(asr_query::claim(&env.device_audio, Uuid::new_v4())
        .await
        .unwrap()
        .is_none());
    for expected_attempt in 2..=8 {
        make_due(&env, audio.id).await;
        let claim = asr_query::claim(&env.device_audio, Uuid::new_v4())
            .await
            .unwrap()
            .unwrap();
        assert_ne!(claim.token.attempt_id, old.token.attempt_id);
        assert_eq!(job(&env, audio.id).await.attempt_count, expected_attempt);
        asr_query::fail(
            &env.device_audio,
            &claim,
            Failure::Safe("source_unavailable"),
        )
        .await
        .unwrap();
    }
    assert_eq!(job(&env, audio.id).await.state, "failed");
    assert!(asr_query::claim(&env.device_audio, Uuid::new_v4())
        .await
        .unwrap()
        .is_none());
    assert!(!asr_query::complete(&env.device_audio, &old, "old result")
        .await
        .unwrap());
}

#[actix_web::test]
#[serial_test::serial]
async fn operator_recovery_is_exact_audited_and_fences_old_results() {
    use super::super::{RecoveryCommand, RecoveryOutcome};
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    enable_asr(&env).await;
    let (audio, claim) = running(&env, actor, device).await;
    asr_query::fail(&env.device_audio, &claim, Failure::Unknown)
        .await
        .unwrap();
    let command = |expected_attempt_id, note: &str| RecoveryCommand {
        audio_id: audio.id,
        expected_attempt_id,
        verification_note: note.into(),
        operator: "uid:501".into(),
    };
    assert!(matches!(
        recovery::recover(
            &env.device_audio,
            command(Uuid::new_v4(), "verified stopped")
        )
        .await
        .unwrap(),
        RecoveryOutcome::TokenMismatch
    ));
    assert!(recovery::recover(
        &env.device_audio,
        command(claim.token.attempt_id, " \n")
    )
    .await
    .is_err());
    assert_eq!(job(&env, audio.id).await.state, "outcome_unknown");
    assert!(matches!(
        recovery::recover(
            &env.device_audio,
            command(claim.token.attempt_id, "verified stopped")
        )
        .await
        .unwrap(),
        RecoveryOutcome::Recovered
    ));
    let recovered = job(&env, audio.id).await;
    assert_eq!(recovered.state, "failed");
    assert_eq!(recovered.recovered_attempt_id, Some(claim.token.attempt_id));
    assert_eq!(recovered.recovery_note.as_deref(), Some("verified stopped"));
    assert_eq!(recovered.recovery_verified_by.as_deref(), Some("uid:501"));
    assert!(recovered.recovery_verified_at.is_some());
    assert!(recovered.attempt_id.is_none());
    assert!(
        !asr_query::complete(&env.device_audio, &claim, "late result")
            .await
            .unwrap()
    );
    assert!(device_audio::Entity::find_by_id(audio.id)
        .one(env.device_audio.file_database().unwrap())
        .await
        .unwrap()
        .unwrap()
        .automatic_transcription
        .is_none());
    assert!(device_audio_asr_scheduler::Entity::find_by_id(1_i16)
        .one(env.device_audio.file_database().unwrap())
        .await
        .unwrap()
        .unwrap()
        .slot_audio_id
        .is_none());
}

#[actix_web::test]
#[serial_test::serial]
async fn matching_late_definite_failure_resolves_unknown_without_operator_reset(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    enable_asr(&env).await;
    let (audio, claim) = running(&env, actor, device).await;
    asr_query::fail(&env.device_audio, &claim, Failure::Unknown)
        .await
        .unwrap();
    asr_query::fail(
        &env.device_audio,
        &claim,
        Failure::Safe("provider_not_ready"),
    )
    .await
    .unwrap();
    assert_eq!(job(&env, audio.id).await.state, "retry_wait");
    assert!(device_audio_asr_scheduler::Entity::find_by_id(1_i16)
        .one(env.device_audio.file_database().unwrap())
        .await
        .unwrap()
        .unwrap()
        .slot_audio_id
        .is_none());
}
