use super::*;
use actix_web::{http::StatusCode, web, App, HttpResponse, HttpServer};
use std::sync::{atomic::AtomicUsize, atomic::Ordering, Arc};

const PRESSURE_ERROR: &str = "HTTP status server error (507 Insufficient Storage) for url (http://127.0.0.1:18080/v1/jobs)";
const RECOVERY_SQL: &str = include_str!("../recover_storage_pressure.sql");

#[derive(FromQueryResult)]
struct RetryState {
    state: String,
    attempts: i32,
    retry_scheduled: bool,
    extractor_job_id: Option<String>,
}

#[derive(FromQueryResult)]
struct Snapshot {
    snapshot: serde_json::Value,
}

async fn recovery_snapshot(env: &Env, eligible: Uuid) -> Snapshot {
    rows(env.file_registry_db().unwrap().connection(),
        "select jsonb_build_object(
         'documents',(select jsonb_agg(to_jsonb(d) order by file_id) from file_document d where file_id<>$1),
         'jobs',(select jsonb_agg(to_jsonb(j) order by id) from file_document_job j where file_id<>$1),
         'eligibleDocument',(select to_jsonb(d)-array['state','last_error'] from file_document d where file_id=$1),
         'eligibleJob',(select to_jsonb(j)-array['state','attempts','last_error','next_attempt_at','lease','lease_until'] from file_document_job j where file_id=$1),
         'generations',(select jsonb_agg(to_jsonb(g) order by id) from file_document_generation g),
         'backfill',(select to_jsonb(b) from file_document_backfill b where id=1)) as snapshot",
        vec![eligible.into()]).await.unwrap().pop().unwrap()
}

async fn retry_state(env: &Env, id: Uuid) -> RetryState {
    rows(env.file_registry_db().unwrap().connection(),"select state,attempts,next_attempt_at>now() as retry_scheduled,payload->>'extractorJobId' as extractor_job_id from file_document_job where id=$1",vec![id.into()])
        .await.unwrap().pop().unwrap()
}

fn memory_storage(env: &Env) -> Env {
    let mut env = env.clone();
    env.s3 = Some(
        opendal::Operator::new(opendal::services::Memory::default())
            .unwrap()
            .finish(),
    );
    let config = crate::config::S3Config {
        s3_access_key_id: "test".into(),
        s3_secret_access_key: "test".into(),
        s3_endpoint: String::new(),
        s3_region: String::new(),
        s3_bucket: "documents-test".into(),
        strongbox_key: crate::storage::generate_strongbox_key_b64(),
    };
    let mut storage_config = crate::storage::S3Config::from(&config);
    storage_config.prefix.clear();
    env.s3_config = Some(storage_config);
    env.config.s3_config = Some(config);
    env
}

#[tokio::test]
#[serial_test::serial]
async fn device_document_storage_pressure_keeps_retry_budget_3743() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let env = memory_storage(&env);
    let human = reader(&env).await;
    let visible = device(&env, &human).await;
    let db = env.file_registry_db().unwrap().connection();
    let first =
        uploaded_document(&env, visible.id, human.id, "pressure.txt").await;
    let source = extraction::source(&env, &first).await.unwrap();
    let responses = [507, 507, 507, 507, 507, 507, 429, 503, 202, 400];
    let next = Arc::new(AtomicUsize::new(0));
    let index = next.clone();
    let accepted = Uuid::now_v7().to_string();
    let response_id = accepted.clone();
    let (server, address) = submission_server(responses, index, response_id);
    let handle = server.handle();
    let server = tokio::spawn(server);
    let config = crate::ocr::OcrRuntimeConfig {
        base_url: format!("http://{address}"),
        instance_id: "test".into(),
        token: "test-token".into(),
        max_in_flight_jobs: 1,
        gateway_url: None,
        gateway_signing_key: None,
    };
    let mut job = first;
    for _ in 0..8 {
        let result =
            extraction::submit_extractor(&env, &job, &source, &config, "txt")
                .await
                .unwrap();
        assert!(result.is_none());
        queue::finish(&env, &job, Ok(false)).await.unwrap();
        let state = retry_state(&env, job.id).await;
        assert_eq!(state.state, "queued");
        assert_eq!(state.attempts, 0);
        assert!(state.retry_scheduled);
        assert!(state.extractor_job_id.is_none());
        execute(
            db,
            "update file_document_job set next_attempt_at=now() where id=$1",
            vec![job.id.into()],
        )
        .await
        .unwrap();
        job = queue::claim(&env, "extract").await.unwrap().unwrap();
        assert_eq!(job.attempts, 1);
    }
    assert!(
        extraction::submit_extractor(&env, &job, &source, &config, "txt")
            .await
            .unwrap()
            .is_none()
    );
    queue::finish(&env, &job, Ok(false)).await.unwrap();
    assert_eq!(
        retry_state(&env, job.id).await.extractor_job_id.as_deref(),
        Some(accepted.as_str())
    );

    let job =
        uploaded_document(&env, visible.id, human.id, "invalid.txt").await;
    let source = extraction::source(&env, &job).await.unwrap();
    let result =
        extraction::submit_extractor(&env, &job, &source, &config, "txt").await;
    assert!(result.is_err());
    queue::finish(&env, &job, result.map(|package| package.is_some()))
        .await
        .unwrap();
    let state = retry_state(&env, job.id).await;
    assert_eq!(state.state, "retry_wait");
    assert_eq!(state.attempts, 1);
    assert_eq!(next.load(Ordering::SeqCst), responses.len());
    handle.stop(true).await;
    server.await.unwrap().unwrap();
}

fn submission_server(
    responses: [u16; 10],
    index: Arc<AtomicUsize>,
    response_id: String,
) -> (actix_web::dev::Server, std::net::SocketAddr) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = HttpServer::new(move || {
        let index = index.clone();
        let response_id = response_id.clone();
        App::new().route("/v1/jobs", web::post().to(move |body: web::Bytes| {
            let status = responses[index.fetch_add(1, Ordering::SeqCst)];
            let id = response_id.clone();
            async move {
                assert!(!body.is_empty());
                HttpResponse::build(StatusCode::from_u16(status).unwrap())
                    .json(json!({"id":id,"detail":"spool capacity limit reached"}))
            }
        }))
    }).workers(1).disable_signals().listen(listener).unwrap().run();
    (server, address)
}

async fn uploaded_document(
    env: &Env,
    device: Uuid,
    human: Uuid,
    name: &str,
) -> queue::Job {
    let document = file(env, device, name, true, human).await;
    let job = queue::claim(env, "extract").await.unwrap().unwrap();
    assert_eq!(job.file_id, document.id);
    let source = extraction::source(env, &job).await.unwrap();
    crate::storage::upload_device_content_encrypted(
        env.s3.as_ref().unwrap(),
        env.s3_config.as_ref().unwrap(),
        &env.config.s3_config.as_ref().unwrap().strongbox_key,
        &source.object_key,
        web::Bytes::from_static(b"x"),
        None,
    )
    .await
    .unwrap();
    job
}

async fn failed_document(
    env: &Env,
    device: Uuid,
    human: Uuid,
    name: &str,
) -> Uuid {
    let document = file(env, device, name, true, human).await;
    let db = env.file_registry_db().unwrap().connection();
    execute(db,"update file_document_job set state='failed',attempts=5,last_error=$2 where file_id=$1",vec![document.id.into(),PRESSURE_ERROR.into()]).await.unwrap();
    execute(db,"update file_document set state='failed',last_error=$2 where file_id=$1",vec![document.id.into(),PRESSURE_ERROR.into()]).await.unwrap();
    document.id
}

#[tokio::test]
#[serial_test::serial]
async fn device_document_storage_pressure_recovery_is_scoped_3743() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let human = reader(&env).await;
    let visible = device(&env, &human).await;
    let db = env.file_registry_db().unwrap().connection();
    let eligible =
        failed_document(&env, visible.id, human.id, "eligible.txt").await;
    let published = Uuid::now_v7();
    execute(db,"insert into file_document_generation(id,file_id,revision,complete,parser_version,summary) values($2,$1,1,true,'previous-parser','Published result')",vec![eligible.into(),published.into()]).await.unwrap();
    execute(
        db,
        "update file_document set published_generation=$2 where file_id=$1",
        vec![eligible.into(), published.into()],
    )
    .await
    .unwrap();
    let stale = failed_document(&env, visible.id, human.id, "stale.txt").await;
    let completed =
        failed_document(&env, visible.id, human.id, "completed.txt").await;
    let leased =
        failed_document(&env, visible.id, human.id, "leased.txt").await;
    let unrelated =
        failed_document(&env, visible.id, human.id, "unrelated.txt").await;
    let accepted =
        failed_document(&env, visible.id, human.id, "accepted.txt").await;
    execute(
        db,
        "update file_document set generation=$2 where file_id=$1",
        vec![stale.into(), Uuid::now_v7().into()],
    )
    .await
    .unwrap();
    execute(
        db,
        "update file_document_job set state='completed' where file_id=$1",
        vec![completed.into()],
    )
    .await
    .unwrap();
    execute(db,"update file_document_job set lease=$2,lease_until=now()+interval '15 minutes' where file_id=$1",vec![leased.into(),Uuid::now_v7().into()]).await.unwrap();
    execute(db,"update file_document_job set last_error='HTTP 400 malformed input' where file_id=$1",vec![unrelated.into()]).await.unwrap();
    execute(db,"update file_document_job set payload=jsonb_build_object('extractorJobId',$2::text) where file_id=$1",vec![accepted.into(),Uuid::now_v7().to_string().into()]).await.unwrap();
    let before = recovery_snapshot(&env, eligible).await;
    #[derive(FromQueryResult)]
    struct Count {
        recovered: i64,
    }
    let count: Count =
        rows(db, RECOVERY_SQL, vec![]).await.unwrap().pop().unwrap();
    assert_eq!(count.recovered, 1);
    let after = recovery_snapshot(&env, eligible).await;
    assert_eq!(before.snapshot, after.snapshot);
    let job = queue::claim(&env, "extract").await.unwrap().unwrap();
    assert_eq!(job.file_id, eligible);
    assert_eq!(job.attempts, 1);

    let extractor = Uuid::now_v7();
    execute(db,"update file_document_job set payload=jsonb_build_object('extractorJobId',$2::text) where file_id=$1",vec![accepted.into(),extractor.to_string().into()]).await.unwrap();
    let published = Uuid::now_v7();
    execute(db,"insert into file_document_generation(id,file_id,revision,complete,parser_version,summary) values($2,$1,1,true,'previous-parser','Published result')",vec![accepted.into(),published.into()]).await.unwrap();
    execute(
        db,
        "update file_document set published_generation=$2 where file_id=$1",
        vec![accepted.into(), published.into()],
    )
    .await
    .unwrap();
    let before = recovery_snapshot(&env, accepted).await;
    #[derive(FromQueryResult)]
    struct Candidate {
        id: Uuid,
        extractor_id: String,
        generation: Uuid,
    }
    let candidates: Vec<Candidate> = rows(db,"select id,generation,coalesce(payload->>'extractorJobId',$2) as extractor_id from file_document_job where file_id=any($1)",vec![vec![accepted,stale,completed,leased,unrelated].into(),extractor.to_string().into()]).await.unwrap();
    let requested = json!(candidates
        .iter()
        .map(|row| json!({"id":row.id,"extractor_id":row.extractor_id,"generation":row.generation}))
        .collect::<Vec<_>>());
    #[derive(FromQueryResult)]
    struct Recovered {
        id: Uuid,
    }
    let recovered: Vec<Recovered> = rows(
        db,
        include_str!("../recover_upstream_storage_pressure.sql"),
        vec![requested.into()],
    )
    .await
    .unwrap();
    assert_eq!(recovered.len(), 1);
    let after = recovery_snapshot(&env, accepted).await;
    assert_eq!(before.snapshot, after.snapshot);
    let state = retry_state(&env, recovered[0].id).await;
    assert_eq!(state.state, "queued");
    assert_eq!(state.attempts, 0);
    assert_eq!(state.extractor_job_id, Some(extractor.to_string()));
}
