use super::*;

#[tokio::test]
#[serial_test::serial]
async fn phase7_repair_releases_only_proven_accounting_once_and_preserves_receipts(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let db = env.file_registry_db.as_ref().unwrap().connection();
    let actor = Uuid::new_v4();
    let mut jobs = Vec::new();
    let mut attempts = Vec::new();
    for resolved in [false, true] {
        let job = admission::admit(db, &audio_command(actor), &settings())
            .await
            .unwrap();
        let claim = worker::claim_due(
            db,
            FinalizationKind::FinalizationAudioKind,
            Uuid::new_v4(),
            worker::ClaimLane::Work,
            60,
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(claim.job_id, job.job_id);
        let attempt = query::create_attempt(db, &claim, true).await.unwrap();
        query::prepare_attempt(
            db,
            &claim,
            attempt,
            64,
            &[7; 32],
            Some(&prepared_audio()),
        )
        .await
        .unwrap();
        assert!(query::record_write_intent(db, &claim, attempt, 4)
            .await
            .unwrap());
        if resolved {
            assert!(query::record_write_resolution(
                db,
                &claim,
                attempt,
                WriteResolution::Acknowledged
            )
            .await
            .unwrap());
        }
        jobs.push(job.job_id);
        attempts.push(attempt);
    }
    let command = audio_command(actor);
    let terminal = admission::admit(db, &command, &settings()).await.unwrap();
    db.execute_unprepared(&format!("update device_upload_finalization_job set status='failed',finished_at=clock_timestamp(),error_code='invalid_audio',error_message='invalid audio',error_action='new_upload',source_release_state='released',source_released_at=clock_timestamp() where id='{}'", terminal.job_id)).await.unwrap();
    let snapshot = admission::admit(db, &command, &settings()).await.unwrap();
    assert_eq!(counters(db, "global:audio").await, (3, 192, 2));
    super::super::cleanup::repair_accounting(
        db,
        FinalizationKind::FinalizationAudioKind,
    )
    .await
    .unwrap();
    super::super::cleanup::repair_accounting(
        db,
        FinalizationKind::FinalizationAudioKind,
    )
    .await
    .unwrap();
    assert_eq!(counters(db, "global:audio").await, (2, 128, 1));
    assert_eq!(
        counters(db, &format!("actor:{actor}:audio")).await,
        (2, 128, 0)
    );
    let retained: Vec<(Uuid,bool)> = sqlx::query_as("select id,write_credit_held from device_upload_finalization_attempt order by ordinal,id")
        .fetch_all(db.get_postgres_connection_pool()).await.unwrap();
    assert!(retained.contains(&(attempts[0], true)));
    assert!(retained.contains(&(attempts[1], false)));
    for id in jobs {
        assert_eq!(
            query::read_job(db, id)
                .await
                .unwrap()
                .unwrap()
                .0
                .source_release_state,
            "held"
        );
    }
    let replay = admission::admit(
        db,
        &command,
        &DeviceUploadFinalizationSettings::default(),
    )
    .await
    .unwrap();
    assert_eq!(
        serde_json::to_value(replay).unwrap(),
        serde_json::to_value(snapshot).unwrap()
    );
}
