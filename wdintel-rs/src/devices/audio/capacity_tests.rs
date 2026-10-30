use super::*;
use crate::devices::upload_finalization::resources::{self, ResourceKind};

#[actix_web::test]
#[serial_test::serial]
async fn phase8_file_storage_saturation_leaves_real_audio_publication_capacity()
{
    let (env, _guard) = cleanup_locked().await.unwrap();
    let directory = tempfile::tempdir().unwrap();
    let env = phase5_env(&env, directory.path(), memory_storage());
    let (actor, device) = enabled_audio_device(&env).await;
    let settings = env.config.device_upload_finalization.as_ref().unwrap();
    let mut file_guards = Vec::new();
    for (kind, count) in [
        (ResourceKind::Encryption, settings.encryption_slots),
        (ResourceKind::Readback, settings.readback_slots),
    ] {
        for _ in 0..count {
            file_guards.push(
                resources::legacy_slot(&env, kind).await.unwrap().unwrap(),
            );
        }
        assert!(resources::legacy_slot(&env, kind).await.is_err());
    }
    let command = receive_command(
        &env.device_audio,
        actor,
        device,
        "audio while files hold storage",
        native_audio_bytes().await,
    )
    .await;
    let job_id = phase5_enqueue(env.clone(), actor, &command).await;
    let claim = claim_audio(&env, job_id, false).await;
    ingest::finalize_claim(&env, &env.device_audio, claim)
        .await
        .unwrap();
    let job = persisted_job(&env, job_id).await;
    assert_eq!(
        job.status, "completed",
        "file storage slots blocked audio: {:?}",
        job.error_code
    );
    let audio = device_audio::Entity::find_by_id(job.audio_id.unwrap())
        .one(env.device_audio.file_database().unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(audio.name, command.name);
    let synchronous = receive_command(
        &env.device_audio,
        actor,
        device,
        "sync audio while files hold storage",
        native_audio_bytes().await,
    )
    .await;
    assert!(matches!(
        receive(&env.device_audio, actor, synchronous)
            .await
            .unwrap(),
        types::ReceiveDeviceAudioOutcome::Accepted(_)
    ));
    drop(file_guards);
}
