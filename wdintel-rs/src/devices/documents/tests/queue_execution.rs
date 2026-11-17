use super::*;
use crate::devices::documents::worker;
use actix_web::{web, App, HttpResponse, HttpServer};
use sea_orm::{ConnectionTrait, TransactionTrait};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;

#[tokio::test]
#[serial_test::serial]
async fn document_queue_preserves_priority_and_submitted_only_claims() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let human = reader(&env).await;
    let visible = device(&env, &human).await;
    let first = file(&env, visible.id, "first.txt", true, human.id).await;
    let second = file(&env, visible.id, "second.txt", true, human.id).await;
    let third = file(&env, visible.id, "third.txt", true, human.id).await;
    let db = env.file_registry_db().unwrap().connection();
    execute(db, "update file_document_job set created_at=now()-interval '3 minutes' where file_id=$1", vec![first.id.into()]).await.unwrap();
    execute(db, "update file_document_job set created_at=now()-interval '2 minutes',payload=jsonb_build_object('extractorJobId','accepted') where file_id=$1", vec![second.id.into()]).await.unwrap();
    execute(db, "update file_document_job set created_at=now()-interval '1 minute' where file_id=$1", vec![third.id.into()]).await.unwrap();
    let submitted = queue::claim_submitted(&env, "extract")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(submitted.file_id, second.id);
    assert!(queue::claim_submitted(&env, "extract")
        .await
        .unwrap()
        .is_none());
    let newest = queue::claim(&env, "extract").await.unwrap().unwrap();
    assert_eq!(newest.file_id, third.id);
    let oldest = queue::claim(&env, "extract").await.unwrap().unwrap();
    assert_eq!(oldest.file_id, first.id);
    queue::finish(
        &env,
        &submitted,
        Ok(queue::JobOutcome::Deferred(Duration::from_secs(90))),
    )
    .await
    .unwrap();
    #[derive(FromQueryResult)]
    struct Deferred {
        attempts: i32,
        deferred: bool,
    }
    let saved = rows::<Deferred, _>(db, "select attempts,next_attempt_at>=now()+interval '85 seconds' as deferred from file_document_job where id=$1",vec![submitted.id.into()]).await.unwrap().pop().unwrap();
    assert_eq!(saved.attempts, 0);
    assert!(saved.deferred);
    // PR #4240: retain recent-work priority beyond the candidate window.
    execute(db, r#"
        insert into file_document_job(id,file_id,revision,generation,kind,created_at,next_attempt_at)
        select uuid_generate_v7(),d.file_id,d.revision,d.generation,'inspect',
          now()-make_interval(secs=>g),now()-make_interval(secs=>g)
        from file_document d cross join generate_series(1::bigint,$2) g where d.file_id=$1
    "#, vec![first.id.into(), (crate::devices::config::DEVICE_DOCUMENT_CLAIM_CANDIDATE_LIMIT as i64).into()]).await.unwrap();
    let recent = Uuid::now_v7();
    execute(db, "insert into file_document_job(id,file_id,revision,generation,kind) select $1,file_id,revision,generation,'inspect' from file_document where file_id=$2", vec![recent.into(),first.id.into()]).await.unwrap();
    assert_eq!(
        queue::claim(&env, "inspect").await.unwrap().unwrap().id,
        recent
    );
}

#[tokio::test]
#[serial_test::serial]
async fn document_queue_claims_are_concurrent_and_skip_stale_generations() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let human = reader(&env).await;
    let visible = device(&env, &human).await;
    let first = file(&env, visible.id, "first.txt", true, human.id).await;
    let second = file(&env, visible.id, "second.txt", true, human.id).await;
    let stale = file(&env, visible.id, "stale.txt", true, human.id).await;
    let db = env.file_registry_db().unwrap().connection();
    execute(db, "update file_document set generation=uuid_generate_v7() where file_id=$1",vec![stale.id.into()]).await.unwrap();
    let (one, two) = tokio::join!(
        queue::claim(&env, "extract"),
        queue::claim(&env, "extract")
    );
    let one = one.unwrap().unwrap();
    let two = two.unwrap().unwrap();
    assert_ne!(one.id, two.id);
    assert!([first.id, second.id].contains(&one.file_id));
    assert!([first.id, second.id].contains(&two.file_id));
    assert!(queue::claim(&env, "extract").await.unwrap().is_none());
}

#[tokio::test]
#[serial_test::serial]
async fn document_worker_full_capacity_only_polls_submitted_jobs() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let mut env = env.as_ref().clone();
    let human = reader(&env).await;
    let visible = device(&env, &human).await;
    let pending = file_with_extension(
        &env,
        visible.id,
        "pending.exe",
        "exe",
        true,
        human.id,
    )
    .await;
    let submitted =
        file(&env, visible.id, "submitted.txt", true, human.id).await;
    let db = env.file_registry_db().unwrap().connection().clone();
    execute(&db,"update file_document_job set payload=jsonb_build_object('extractorJobId','accepted') where file_id=$1",vec![submitted.id.into()]).await.unwrap();
    let settings = system_settings::ActiveModel {
        devices_section_enabled: Set(true),
        ..Default::default()
    }
    .insert(&env.dbx)
    .await
    .unwrap();
    execute(
        &env.dbx,
        "update device_document_settings set enabled=true where id=1",
        vec![],
    )
    .await
    .unwrap();
    let capacity_requests = Arc::new(AtomicUsize::new(0));
    let polls = Arc::new(AtomicUsize::new(0));
    let available = Arc::new(AtomicUsize::new(0));
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let cap = capacity_requests.clone();
    let pol = polls.clone();
    let av = available.clone();
    let server=HttpServer::new(move||{
        let cap=cap.clone();let pol=pol.clone();let av=av.clone();
        App::new().route("/v1/capacity",web::get().to(move||{
            let cap=cap.clone();let av=av.clone();async move {
                cap.fetch_add(1,Ordering::SeqCst);let slots=av.load(Ordering::SeqCst);
                HttpResponse::Ok().json(json!({"limit":1,"active":1-slots,"available":slots,"retry_after_seconds":30}))
            }
        })).route("/v1/jobs/{id}",web::get().to(move||{
            let pol=pol.clone();async move {pol.fetch_add(1,Ordering::SeqCst);HttpResponse::Ok().json(json!({"state":"running"}))}
        }))
    }).workers(1).disable_signals().listen(listener).unwrap().run();
    let handle = server.handle();
    let server = tokio::spawn(server);
    env.config.ocr = Some(crate::config::OcrConfig {
        base_url: format!("http://{address}"),
        instance_id: "queue-test".into(),
        gateway_url: None,
        max_in_flight_jobs: 1,
    });
    env.s3 = Some(
        opendal::Operator::new(opendal::services::Memory::default())
            .unwrap()
            .finish(),
    );
    let storage = crate::config::S3Config {
        s3_access_key_id: "test".into(),
        s3_secret_access_key: "test".into(),
        s3_endpoint: String::new(),
        s3_region: String::new(),
        s3_bucket: "test".into(),
        strongbox_key: crate::storage::generate_strongbox_key_b64(),
    };
    env.s3_config = Some(crate::storage::S3Config::from(&storage));
    env.config.s3_config = Some(storage);
    let _environment = ExtractorEnvironment::new(address);
    let admission = worker::shared_admission();
    let mut state = worker::WorkerState::default();
    for _ in 0..4 {
        assert!(!worker::step(&env, "extract", &admission, &mut state)
            .await
            .unwrap()
            .is_zero());
    }
    #[derive(FromQueryResult)]
    struct Attempts {
        attempts: i32,
        state: String,
    }
    let untouched = rows::<Attempts, _>(
        &db,
        "select attempts,state from file_document_job where file_id=$1",
        vec![pending.id.into()],
    )
    .await
    .unwrap()
    .pop()
    .unwrap();
    assert_eq!(untouched.attempts, 0);
    assert_eq!(untouched.state, "queued");
    assert_eq!(capacity_requests.load(Ordering::SeqCst), 1);
    assert_eq!(polls.load(Ordering::SeqCst), 1);
    available.store(1, Ordering::SeqCst);
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(31)).await;
    tokio::time::resume();
    assert!(worker::step(&env, "extract", &admission, &mut state)
        .await
        .unwrap()
        .is_zero());
    let completed = rows::<Attempts, _>(
        &db,
        "select attempts,state from file_document_job where file_id=$1",
        vec![pending.id.into()],
    )
    .await
    .unwrap()
    .pop()
    .unwrap();
    assert_eq!(completed.state, "completed");
    assert_eq!(capacity_requests.load(Ordering::SeqCst), 2);
    handle.stop(false).await;
    server.await.unwrap().unwrap();
    let waiting =
        file(&env, visible.id, "unavailable.txt", true, human.id).await;
    for _ in 0..2 {
        assert!(!worker::step(&env, "extract", &admission, &mut state)
            .await
            .unwrap()
            .is_zero());
    }
    let untouched = rows::<Attempts, _>(
        &db,
        "select attempts,state from file_document_job where file_id=$1",
        vec![waiting.id.into()],
    )
    .await
    .unwrap()
    .pop()
    .unwrap();
    assert_eq!(untouched.attempts, 0);
    settings.into_active_model().delete(&env.dbx).await.unwrap();
    execute(
        &env.dbx,
        "update device_document_settings set enabled=false where id=1",
        vec![],
    )
    .await
    .unwrap();
}

struct ExtractorEnvironment {
    previous_token: Option<std::ffi::OsString>,
    previous_url: Option<std::ffi::OsString>,
}

impl ExtractorEnvironment {
    fn new(address: std::net::SocketAddr) -> Self {
        let previous_token = std::env::var_os(crate::config::OCR_TOKEN_ENV);
        let previous_url =
            std::env::var_os(crate::config::ATTACHMENT_EXTRACTOR_URL_ENV);
        std::env::set_var(crate::config::OCR_TOKEN_ENV, "x".repeat(48));
        std::env::set_var(
            crate::config::ATTACHMENT_EXTRACTOR_URL_ENV,
            format!("http://{address}"),
        );
        Self {
            previous_token,
            previous_url,
        }
    }
}

impl Drop for ExtractorEnvironment {
    fn drop(&mut self) {
        for (key, previous) in [
            (crate::config::OCR_TOKEN_ENV, self.previous_token.take()),
            (
                crate::config::ATTACHMENT_EXTRACTOR_URL_ENV,
                self.previous_url.take(),
            ),
        ] {
            match previous {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
    }
}

#[tokio::test]
#[serial_test::serial]
#[ignore = "large isolated queue performance regression; run explicitly"]
async fn document_queue_large_backlog_uses_indexes_without_spilling() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let db = env.file_registry_db().unwrap().connection();
    let tx = db.begin().await.unwrap();
    tx.execute_unprepared(r#"
        set local temp_buffers='128MB';
        create temporary table file_document (like public.file_document including all) on commit drop;
        create temporary table file_document_job (like public.file_document_job including all) on commit drop;
        do $$ declare entry record; begin
          for entry in select indexrelid::regclass as name from pg_index
            where indrelid='pg_temp.file_document_job'::regclass
              and pg_get_indexdef(indexrelid) like '%(kind, created_at DESC, id)%'
          loop execute format('drop index %s',entry.name); end loop;
        end $$;
        set local work_mem='4MB';
        insert into file_document(file_id,revision,device_id,generation)
        select md5('file-'||g)::uuid,1,md5('device')::uuid,md5('generation-'||g)::uuid
        from generate_series(1,616000) g;
        analyze file_document;
        analyze file_document_job;
    "#).await.unwrap();
    tx.execute_unprepared(&large_jobs_sql(false)).await.unwrap();
    let original_sql = r#"with selected as (
        select j.id from file_document_job j join file_document d on d.file_id=j.file_id and d.revision=j.revision
        where j.kind=$1 and (j.kind='inspect' or j.generation=d.generation) and j.next_attempt_at<=now()
          and (j.state in ('queued','retry_wait') or j.state='running' and j.lease_until<now())
        order by j.created_at desc,j.id limit 1 for update of j skip locked
      ) update file_document_job j set state='running',lease=$2,lease_until=now()+make_interval(secs=>$3),attempts=attempts+1
        from selected where j.id=selected.id returning j.*"#;
    for mode in ["force_custom_plan", "force_generic_plan"] {
        tx.execute_unprepared(&format!("set local plan_cache_mode={mode}; prepare original_document_claim(text,uuid,float8) as {original_sql}")).await.unwrap();
        let attempt = tx.begin().await.unwrap();
        let row=attempt.query_one_raw(sea_orm::Statement::from_string(sea_orm::DbBackend::Postgres,
            "explain (analyze,buffers,format json) execute original_document_claim('extract','00000000-0000-0000-0000-000000000001',900)".to_owned())).await.unwrap().unwrap();
        let plan: serde_json::Value = row.try_get_by_index(0).unwrap();
        println!("document_queue_baseline mode={mode} execution_ms={} temp_written_blocks={}",plan[0]["Execution Time"],plan[0]["Plan"]["Temp Written Blocks"]);
        attempt.rollback().await.unwrap();
        tx.execute_unprepared("deallocate original_document_claim")
            .await
            .unwrap();
    }
    for index in [
        "file_document_job_claim_order_idx",
        "file_document_job_poll_order_idx",
        "file_document_job_poll_due_idx",
    ] {
        let row=tx.query_one_raw(sea_orm::Statement::from_sql_and_values(sea_orm::DbBackend::Postgres,
            "select pg_get_indexdef(('public.'||$1)::regclass) as definition",[index.into()])).await.unwrap().unwrap();
        let definition: String = row.try_get_by_index(0).unwrap();
        tx.execute_unprepared(&definition.replace(
            "ON public.file_document_job ",
            "ON pg_temp.file_document_job ",
        ))
        .await
        .unwrap();
    }
    tx.execute_unprepared("analyze file_document_job")
        .await
        .unwrap();
    benchmark_claims(&tx, "interleaved", None).await;
    // PR #4240: recent future retries must not hide the oldest ready job.
    tx.execute_unprepared(r#"
        update file_document_job set next_attempt_at=now()+interval '1 day',
          payload=jsonb_build_object('extractorJobId',id::text) where kind='extract';
    "#).await.unwrap();
    #[derive(FromQueryResult)]
    struct Ready {
        id: Uuid,
    }
    let ready = rows::<Ready, _>(
        &tx,
        "update file_document_job set next_attempt_at=now()-interval '1 day' where id=md5('job-1')::uuid returning id",
        vec![],
    )
    .await
    .unwrap()
    .pop()
    .unwrap();
    tx.execute_unprepared("analyze file_document_job")
        .await
        .unwrap();
    benchmark_claims(&tx, "clustered_retries", Some(ready.id)).await;
    tx.execute_unprepared("truncate file_document_job")
        .await
        .unwrap();
    tx.execute_unprepared(&large_jobs_sql(true)).await.unwrap();
    benchmark_claims(&tx, "all_future", None).await;
    tx.rollback().await.unwrap();
}

async fn benchmark_claims(
    tx: &sea_orm::DatabaseTransaction,
    scenario: &str,
    expected: Option<Uuid>,
) {
    for mode in ["force_custom_plan", "force_generic_plan"] {
        tx.execute_unprepared(&format!("set local plan_cache_mode={mode}"))
            .await
            .unwrap();
        for submitted in [false, true] {
            tx.execute_unprepared(&format!(
                "prepare document_queue_claim(text,uuid,float8) as {}",
                queue::claim_sql(submitted)
            ))
            .await
            .unwrap();
            let mut timings = Vec::new();
            for _ in 0..20 {
                let attempt = tx.begin().await.unwrap();
                let row=attempt.query_one_raw(sea_orm::Statement::from_string(sea_orm::DbBackend::Postgres,
                    "explain (analyze,buffers,format json) execute document_queue_claim('extract','00000000-0000-0000-0000-000000000001',900)".to_owned())).await.unwrap().unwrap();
                let plan: serde_json::Value = row.try_get_by_index(0).unwrap();
                assert_indexed_claim(&plan[0]["Plan"]);
                if let Some(expected) = expected {
                    let claimed = rows::<queue::Job, _>(
                        &attempt,
                        "select * from file_document_job where id=$1 and state='running' and lease='00000000-0000-0000-0000-000000000001'",
                        vec![expected.into()],
                    )
                    .await
                    .unwrap();
                    assert_eq!(claimed.len(), 1, "ready job was not claimed");
                }
                timings.push(plan[0]["Execution Time"].as_f64().unwrap());
                attempt.rollback().await.unwrap();
            }
            timings.sort_by(f64::total_cmp);
            println!("document_queue_benchmark scenario={scenario} mode={mode} submitted={submitted} p95_ms={:.3} max_ms={:.3}",timings[18],timings[19]);
            assert!(
                timings[18] < 100.0,
                "claim p95 exceeded 100ms: {timings:?}"
            );
            tx.execute_unprepared("deallocate document_queue_claim")
                .await
                .unwrap();
        }
    }
}

fn large_jobs_sql(all_future: bool) -> String {
    let next_attempt = if all_future {
        "now()+interval '1 day'"
    } else {
        "now()+case when g%100=0 then interval '1 day' else interval '-1 day' end"
    };
    r#"
        insert into file_document_job(id,file_id,revision,generation,kind,state,created_at,next_attempt_at,payload)
        select md5('job-'||g)::uuid,md5('file-'||((g-1)%616000+1))::uuid,1,
          md5('generation-'||((g-1)%616000+1))::uuid,
          case when g<=616000 then 'extract' else 'summary' end,
          case when g<=578000 then 'queued' else 'completed' end,
          now()-make_interval(secs=>650000-g),
          $next_attempt,
          case when g<=5600 then jsonb_build_object('extractorJobId',g::text) else '{}'::jsonb end
        from generate_series(1,650000) g;
        analyze file_document_job;
"#.replace("$next_attempt",next_attempt)
}

fn assert_indexed_claim(plan: &serde_json::Value) {
    assert!(
        plan["Rows Removed by Filter"].as_u64().unwrap_or(0)
            <= crate::devices::config::DEVICE_DOCUMENT_CLAIM_CANDIDATE_LIMIT,
        "unbounded candidate filtering: {plan}"
    );
    assert_ne!(
        plan["Node Type"], "Hash Join",
        "unexpected global join: {plan}"
    );
    assert_ne!(
        plan["Node Type"], "Seq Scan",
        "unexpected table scan: {plan}"
    );
    assert_eq!(
        plan["Temp Read Blocks"].as_u64().unwrap_or(0),
        0,
        "temporary reads: {plan}"
    );
    assert_eq!(
        plan["Temp Written Blocks"].as_u64().unwrap_or(0),
        0,
        "temporary writes: {plan}"
    );
    if let Some(children) = plan["Plans"].as_array() {
        for child in children {
            assert_indexed_claim(child);
        }
    }
}
