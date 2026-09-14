use std::sync::Arc;
use std::time::Instant;

use actix_identity::{Identity, IdentityMiddleware};
use actix_session::storage::RedisSessionStore;
use actix_session::SessionMiddleware;
use actix_web::cookie::{Cookie, Key};
use actix_web::http::{Method, StatusCode};
use actix_web::{test, web, App, HttpMessage, HttpRequest, HttpResponse};
use base64::Engine;
use chrono::{Duration, Utc};
use futures_util::stream;
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ConnectionTrait, DatabaseConnection,
    EntityTrait, IntoActiveModel,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::repository::{CreateOutcome, NewUpload, Upload, UploadStatus};
use super::{
    finalizer, protocol, repository, runtime_for_test, worker,
    DeviceFileContentRuntime,
};
use crate::devices::ROLE_DEVICE_SOURCE;
use crate::entities::{device, login, organism, system_settings};
use crate::file_registry::entities::{
    file_content, file_content_upload, file_device_source_state, file_entry,
    file_revision, sea_orm_active_enums::FileEntryKind,
};
use crate::functest::tests::{cleanup_locked, mk_login, mk_organism};
use crate::types::Env;

async fn finalize(
    env: &Env,
    runtime: &DeviceFileContentRuntime,
    login_id: Uuid,
    upload: Upload,
    spool: &super::LockedSpool,
) -> Result<repository::CompletedContent, protocol::ContentError> {
    let permit = match finalizer::acquire_permit(runtime).await {
        Ok(permit) => permit,
        Err(error) => {
            return finalizer::refresh_retryable_upload(runtime, &upload, error)
                .await
        }
    };
    finalizer::finalize(env, runtime, login_id, upload, spool, permit).await
}

struct Fixture {
    login: login::Model,
    device: device::Model,
    root: file_entry::Model,
    spool: tempfile::TempDir,
    runtime: Arc<DeviceFileContentRuntime>,
}

impl Fixture {
    async fn new(env: &Arc<Env>) -> Self {
        system_settings::ActiveModel {
            devices_section_enabled: Set(true),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let organism = mk_organism(
            &env.dbx,
            organism::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let login = mk_login(
            &env.dbx,
            login::ActiveModel {
                login: Set(format!("upload-acceptance-{}", Uuid::new_v4())),
                roles: Set(json!([ROLE_DEVICE_SOURCE])),
                organism_id: Set(Some(organism.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let device = device::ActiveModel {
            id: Set(Uuid::new_v4()),
            name: Set(Some("Upload acceptance".to_owned())),
            created_by: Set(login.login.clone()),
            organism_id: Set(organism.id),
            unit_id: Set(None),
            tags: Set(json!([])),
            external_url: Set(None),
            archived: Set(false),
            archived_at: Set(None),
            custom_fields: Set(json!({})),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let root_id = Uuid::new_v4();
        let now = Utc::now().naive_utc();
        let root = file_entry::ActiveModel {
            id: Set(root_id),
            device_id: Set(device.id),
            parent_id: Set(None),
            kind: Set(FileEntryKind::Directory),
            name: Set("C:\\".to_owned()),
            absolute_path: Set(None),
            hierarchy_path: Set(format!("n{}", root_id.simple())),
            created_at: Set(now),
            updated_at: Set(now),
            ..Default::default()
        }
        .insert(env.file_registry_db().unwrap().connection())
        .await
        .unwrap();
        let spool = tempfile::tempdir().unwrap();
        let storage =
            opendal::Operator::new(opendal::services::Memory::default())
                .unwrap()
                .finish();
        let runtime = runtime_for_test(
            env.file_registry_db().unwrap().clone(),
            spool.path().to_path_buf(),
            storage,
            None,
        )
        .await;
        Self {
            login,
            device,
            root,
            spool,
            runtime,
        }
    }

    fn db(&self) -> &DatabaseConnection {
        self.runtime.file_registry_db.connection()
    }

    async fn file(&self, name: &str) -> file_entry::Model {
        let id = Uuid::new_v4();
        let now = Utc::now().naive_utc();
        crate::file_registry::test_support::insert_entry(
            self.db(),
            file_entry::ActiveModel {
                id: Set(id),
                device_id: Set(self.device.id),
                parent_id: Set(Some(self.root.id)),
                kind: Set(FileEntryKind::File),
                name: Set(format!("{id}-{name}")),
                absolute_path: Set(Some(format!("C:\\{id}-{name}"))),
                hierarchy_path: Set(format!(
                    "{}.n{}",
                    self.root.hierarchy_path,
                    id.simple()
                )),
                mime_type: Set(Some("video/mp4".to_owned())),
                extension: Set(Some("mp4".to_owned())),
                created_at: Set(now),
                updated_at: Set(now),
                ..Default::default()
            },
        )
        .await
    }

    fn request(&self, file: &file_entry::Model, bytes: &[u8]) -> NewUpload {
        NewUpload {
            device_id: self.device.id,
            file_id: file.id,
            revision: file.revision.unwrap(),
            created_by_login_id: self.login.id,
            upload_length: bytes.len() as u64,
            expected_sha256: Sha256::digest(bytes).into(),
            available_spool_bytes: u64::MAX,
            now: Utc::now().fixed_offset(),
        }
    }

    async fn upload(&self, file: &file_entry::Model, bytes: &[u8]) -> Upload {
        match repository::create_or_replay(
            self.db(),
            self.request(file, bytes),
            &self.runtime.config,
        )
        .await
        .unwrap()
        {
            CreateOutcome::Created(upload) => upload,
            outcome => panic!("unexpected creation outcome: {outcome:?}"),
        }
    }

    async fn seed_bytes(
        &self,
        upload: &Upload,
        bytes: &[u8],
    ) -> super::LockedSpool {
        let locked = self.runtime.spool.acquire(upload.id).await.unwrap();
        let payload = stream::iter([Ok(bytes::Bytes::copy_from_slice(bytes))]);
        let appended = locked
            .append(payload, 0, upload.upload_length)
            .await
            .unwrap();
        assert_eq!(appended.offset, bytes.len() as u64);
        locked
    }

    async fn persisted(&self, upload: &Upload) -> file_content_upload::Model {
        file_content_upload::Entity::find_by_id(upload.id)
            .one(self.db())
            .await
            .unwrap()
            .unwrap()
    }
}

async fn sign_in(
    request: HttpRequest,
    login: web::Path<String>,
) -> HttpResponse {
    Identity::login(&request.extensions(), login.into_inner()).unwrap();
    HttpResponse::NoContent().finish()
}

macro_rules! app {
    ($env:expr) => {{
        let session = RedisSessionStore::new(
            crate::redis_conn_string(&$env.config).unwrap(),
        )
        .await
        .unwrap();
        test::init_service(
            App::new()
                .app_data(web::Data::from($env.clone()))
                .wrap(IdentityMiddleware::default())
                .wrap(SessionMiddleware::new(session, Key::generate()))
                .route("/test/login/{login}", web::post().to(sign_in))
                .service(super::routes()),
        )
        .await
    }};
}

macro_rules! cookie {
    ($app:expr, $login:expr) => {{
        let response = test::call_service(
            &$app,
            test::TestRequest::post()
                .uri(&format!("/test/login/{}", $login))
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        response.response().cookies().next().unwrap().into_owned()
    }};
}

async fn assert_error(
    error: protocol::ContentError,
    expected: StatusCode,
    code: Option<&str>,
) {
    let response = protocol::render(Err(error), false);
    assert_eq!(response.status(), expected);
    assert_eq!(response.headers().get("tus-resumable").unwrap(), "1.0.0");
    if let Some(code) = code {
        let body = actix_web::body::to_bytes(response.into_body())
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap()["code"],
            code
        );
    }
}

#[actix_web::test]
#[serial_test::serial]
async fn acceptance_legacy_file_sync_survives_unavailable_content_upload_startup(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let mut config = env.config.clone();
    config.storage_dir = fixture.spool.path().display().to_string();
    config.device_file_content.upload_max_bytes = 16;
    config.device_file_content.max_reserved_per_login = 16;
    config.device_file_content.max_reserved_bytes = 32;
    config.device_file_content.spool_min_free_bytes = 1;
    config.s3_config = Some(crate::config::S3Config {
        s3_access_key_id: "startup-test-access".to_owned(),
        s3_secret_access_key: "startup-test-secret".to_owned(),
        s3_endpoint: String::new(),
        s3_region: "us-east-1".to_owned(),
        s3_bucket: "legacy-file-registry".to_owned(),
        strongbox_key: crate::storage::generate_strongbox_key_b64(),
    });
    for mode in [crate::types::Mode::Live, crate::types::Mode::Debug] {
        let mut legacy_env = env.as_ref().clone();
        legacy_env.mode = mode;
        legacy_env.config = config.clone();
        (legacy_env.s3_config, legacy_env.s3) =
            crate::server::build_runtime_storage(&legacy_env.config, mode);
        assert!(super::build_runtime(
            &legacy_env.config,
            legacy_env.s3.as_ref(),
            legacy_env.file_registry_db.as_ref(),
            None,
            mode,
        )
        .await
        .is_some());
        for failure in [
            "missing-s3",
            "invalid-key",
            "empty-bucket",
            "capacity-overflow",
            "semaphore-overflow",
            "lifetime-duration-overflow",
            "lifetime-date-overflow",
            "idle-duration-overflow",
            "cleanup-retry-overflow",
            "cleanup-poll-overflow",
            "cleanup-batch-overflow",
        ] {
            if failure == "cleanup-batch-overflow"
                && i64::try_from(usize::MAX).is_ok()
            {
                continue;
            }
            assert_legacy_sync_after_content_startup_failure(
                legacy_env.clone(),
                &fixture,
                failure,
            )
            .await;
        }
    }
}

async fn assert_legacy_sync_after_content_startup_failure(
    mut env: Env,
    fixture: &Fixture,
    failure: &str,
) {
    match failure {
        "missing-s3" => {
            env.config.s3_config = None;
            env.s3 = None;
        }
        "invalid-key" => {
            env.config.s3_config.as_mut().unwrap().strongbox_key =
                "invalid".to_owned();
        }
        "empty-bucket" => {
            let config = env.config.s3_config.as_mut().unwrap();
            config.s3_bucket.clear();
            let error = crate::config::mk_s3_config(&env.config).unwrap_err();
            let error = format!("{error:#?}");
            assert!(!error.contains("startup-test-access"));
            assert!(!error.contains("startup-test-secret"));
        }
        "capacity-overflow" => {
            env.config.device_file_content.max_reserved_bytes = u64::MAX;
        }
        "semaphore-overflow" => {
            env.config.device_file_content.finalization_max_concurrent =
                tokio::sync::Semaphore::MAX_PERMITS + 1;
        }
        "lifetime-duration-overflow" => {
            env.config.device_file_content.upload_max_lifetime_secs =
                i64::MAX as u64;
        }
        "lifetime-date-overflow" => {
            env.config.device_file_content.upload_max_lifetime_secs =
                10_000_000_000_000;
        }
        "idle-duration-overflow" => {
            env.config.device_file_content.upload_idle_ttl_secs =
                i64::MAX as u64;
            env.config.device_file_content.upload_max_lifetime_secs =
                i64::MAX as u64;
        }
        "cleanup-retry-overflow" => {
            env.config.device_file_content.cleanup_retry_delay_secs =
                i64::MAX as u64;
        }
        "cleanup-poll-overflow" => {
            env.config.device_file_content.cleanup_poll_interval_secs =
                u64::MAX;
        }
        "cleanup-batch-overflow" => {
            env.config.device_file_content.cleanup_batch_size = usize::MAX;
        }
        _ => unreachable!(),
    }
    (env.s3_config, env.s3) =
        crate::server::build_runtime_storage(&env.config, env.mode);
    env.device_file_content = super::build_runtime(
        &env.config,
        env.s3.as_ref(),
        env.file_registry_db.as_ref(),
        None,
        env.mode,
    )
    .await;
    assert!(env.device_file_content.is_none(), "{failure}");
    let file = fixture.file(failure).await;
    resync_file(&env, fixture, &file).await;
    let updated = file_entry::Entity::find_by_id(file.id)
        .one(env.file_registry_db().unwrap().connection())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(updated.revision, Some(2));
    assert_eq!(updated.absolute_path, file.absolute_path);
    assert_eq!(updated.mime_type, file.mime_type);
    assert!(updated.content_path.is_none());
}

#[actix_web::test]
#[serial_test::serial]
async fn acceptance_concurrent_creation_enforces_all_reservation_limits() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let file = fixture.file("same-target").await;
    let started = Instant::now();
    let attempts = (0..32).map(|_| {
        repository::create_or_replay(
            fixture.db(),
            fixture.request(&file, b"0123456789"),
            &fixture.runtime.config,
        )
    });
    let outcomes = futures_util::future::join_all(attempts).await;
    let mut ids = std::collections::BTreeSet::new();
    let mut created = 0;
    for outcome in outcomes {
        match outcome.unwrap() {
            CreateOutcome::Created(upload) => {
                created += 1;
                ids.insert(upload.id);
            }
            CreateOutcome::Replayed(upload) => {
                ids.insert(upload.id);
            }
            outcome => panic!("concurrent exact replay failed: {outcome:?}"),
        }
    }
    assert_eq!(created, 1);
    assert_eq!(ids.len(), 1);
    eprintln!(
        "UPLOAD_METRIC concurrent_same_target_requests=32 created=1 unique_uploads=1 elapsed_ms={}",
        started.elapsed().as_millis()
    );

    let cases = [
        ("global_bytes", 40, 40, 100, 100, 10, 3),
        ("creator_bytes", 1000, 30, 100, 100, 10, 2),
        ("global_count", 1000, 1000, 4, 4, 0, 3),
        ("creator_count", 1000, 1000, 100, 3, 0, 2),
    ];
    for (
        name,
        global_bytes,
        creator_bytes,
        global_count,
        creator_count,
        length,
        expected_new,
    ) in cases
    {
        let mut config = fixture.runtime.config.clone();
        config.max_reserved_bytes = global_bytes;
        config.max_reserved_per_login = creator_bytes;
        config.max_reserved_count = global_count;
        config.max_count_per_login = creator_count;
        let mut files = Vec::new();
        for index in 0..12 {
            files.push(fixture.file(&format!("{name}-{index}")).await);
        }
        let data = vec![1_u8; length];
        let started = Instant::now();
        let attempts = files.iter().map(|file| {
            repository::create_or_replay(
                fixture.db(),
                fixture.request(file, &data),
                &config,
            )
        });
        let outcomes = futures_util::future::join_all(attempts).await;
        let mut accepted = Vec::new();
        for outcome in outcomes {
            match outcome.unwrap() {
                CreateOutcome::Created(upload) => accepted.push(upload),
                CreateOutcome::CapacityUnavailable => (),
                outcome => panic!("{name}: {outcome:?}"),
            }
        }
        assert_eq!(accepted.len(), expected_new, "{name}");
        eprintln!(
            "UPLOAD_METRIC capacity_case={name} concurrent_requests=12 accepted={} rejected={} elapsed_ms={}",
            accepted.len(),
            12 - accepted.len(),
            started.elapsed().as_millis()
        );
        for upload in accepted {
            repository::transition_open(
                fixture.db(),
                &upload,
                UploadStatus::Aborted,
                Utc::now().fixed_offset(),
                None,
            )
            .await
            .unwrap();
            worker::cleanup_one_for_test(&fixture.runtime, upload.id)
                .await
                .unwrap();
        }
    }
    let mut replay = fixture.request(&file, b"0123456789");
    replay.created_by_login_id = Uuid::new_v4();
    replay.available_spool_bytes = 0;
    assert!(matches!(
        repository::create_or_replay(
            fixture.db(),
            replay,
            &fixture.runtime.config
        )
        .await
        .unwrap(),
        CreateOutcome::Replayed(_)
    ));
    let mut conflict = fixture.request(&file, b"different");
    assert!(matches!(
        repository::create_or_replay(
            fixture.db(),
            conflict,
            &fixture.runtime.config
        )
        .await
        .unwrap(),
        CreateOutcome::InProgress(_)
    ));
    conflict = fixture.request(&file, b"0123456789");
    conflict.now += Duration::days(8);
    assert!(matches!(
        repository::create_or_replay(
            fixture.db(),
            conflict,
            &fixture.runtime.config
        )
        .await
        .unwrap(),
        CreateOutcome::InProgress(_)
    ));
    let file = fixture.file("free-space").await;
    let mut request = fixture.request(&file, b"1");
    request.available_spool_bytes =
        fixture.runtime.config.spool_min_free_bytes + 10;
    assert!(matches!(
        repository::create_or_replay(
            fixture.db(),
            request,
            &fixture.runtime.config
        )
        .await
        .unwrap(),
        CreateOutcome::CapacityUnavailable
    ));
}

#[actix_web::test]
#[serial_test::serial]
async fn acceptance_finalization_digest_retry_capacity_and_immutable_metadata()
{
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let file = fixture.file("misleading-video.mp4").await;
    let upload = fixture.upload(&file, b"source bytes").await;
    let locked = fixture.seed_bytes(&upload, b"source bytes").await;
    let before = fixture.persisted(&upload).await;
    let permits = fixture
        .runtime
        .finalization_permits
        .clone()
        .acquire_many_owned(
            fixture.runtime.config.finalization_max_concurrent as u32,
        )
        .await
        .unwrap();
    let started = Instant::now();
    let error = finalize(
        &env,
        &fixture.runtime,
        fixture.login.id,
        upload.clone(),
        &locked,
    )
    .await
    .unwrap_err();
    assert_error(
        error,
        StatusCode::SERVICE_UNAVAILABLE,
        Some("finalization_busy"),
    )
    .await;
    assert!(started.elapsed().as_secs() < 2);
    drop(permits);
    let after = fixture.persisted(&upload).await;
    assert_eq!(after.status, before.status);
    assert_eq!(after.last_activity_at, before.last_activity_at);
    assert_eq!(after.expected_sha256, before.expected_sha256);
    assert_eq!(after.hard_expires_at, before.hard_expires_at);
    assert!(
        after.expires_at >= before.expires_at
            && after.expires_at <= after.hard_expires_at
    );
    assert_eq!(locked.offset().unwrap(), upload.upload_length);

    let mut broken = (*fixture.runtime).clone();
    broken.storage_config.prefix = "invalid-prefix".to_owned();
    let error =
        finalize(&env, &broken, fixture.login.id, upload.clone(), &locked)
            .await
            .unwrap_err();
    assert_error(
        error,
        StatusCode::SERVICE_UNAVAILABLE,
        Some("storage_unavailable"),
    )
    .await;
    assert_eq!(fixture.persisted(&upload).await.status, before.status);
    assert_eq!(locked.offset().unwrap(), upload.upload_length);
    assert!(file_content::Entity::find_by_id((file.id, 1))
        .one(fixture.db())
        .await
        .unwrap()
        .is_none());

    let completed = finalize(
        &env,
        &fixture.runtime,
        fixture.login.id,
        upload.clone(),
        &locked,
    )
    .await
    .unwrap();
    assert_eq!(completed.upload_id, upload.id);
    let content = file_content::Entity::find_by_id((file.id, 1))
        .one(fixture.db())
        .await
        .unwrap()
        .unwrap();
    assert!(
        content.is_encrypted,
        "MIME/name/extension must not force plaintext"
    );
    assert_eq!(
        content.source_sha256,
        Sha256::digest(b"source bytes").to_vec()
    );
    let mut expected = file.clone();
    expected.content_path = Some(upload.object_key.clone());
    assert_eq!(
        file_entry::Entity::find_by_id(file.id)
            .one(fixture.db())
            .await
            .unwrap()
            .unwrap(),
        expected
    );
    assert!(!fixture
        .spool
        .path()
        .join(format!("{}.data", upload.id))
        .exists());
    assert!(!fixture
        .spool
        .path()
        .join(format!("{}.lock", upload.id))
        .exists());
    finalizer::safe_delete_object(&fixture.runtime, &upload).await;
    assert!(fixture
        .runtime
        .storage
        .stat(&upload.object_key)
        .await
        .is_ok());
    worker::cleanup_one_for_test(&fixture.runtime, upload.id)
        .await
        .unwrap();
    assert!(fixture
        .runtime
        .storage
        .stat(&upload.object_key)
        .await
        .is_ok());

    let wrong_file = fixture.file("wrong-sha").await;
    let wrong = fixture.upload(&wrong_file, b"good").await;
    let wrong_locked = fixture.seed_bytes(&wrong, b"evil").await;
    let error = finalize(
        &env,
        &fixture.runtime,
        fixture.login.id,
        wrong.clone(),
        &wrong_locked,
    )
    .await
    .unwrap_err();
    assert_error(
        error,
        StatusCode::UNPROCESSABLE_ENTITY,
        Some("sha256_mismatch"),
    )
    .await;
    assert_eq!(
        repository::load_upload(fixture.db(), wrong.id)
            .await
            .unwrap()
            .unwrap()
            .status,
        UploadStatus::Rejected
    );
    assert!(file_content::Entity::find_by_id((wrong_file.id, 1))
        .one(fixture.db())
        .await
        .unwrap()
        .is_none());
    assert!(fixture
        .runtime
        .storage
        .stat(&wrong.object_key)
        .await
        .is_err());
    eprintln!(
        "UPLOAD_METRIC finalizer_scenarios=6 forbidden_publications=0 referenced_object_deletions=0"
    );
}

#[actix_web::test]
#[serial_test::serial]
async fn acceptance_final_authorization_revocation_removes_unpublished_object()
{
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    for revocation in ["role", "archived", "section"] {
        let file = fixture.file(revocation).await;
        let upload = fixture.upload(&file, b"private bytes").await;
        let locked = fixture.seed_bytes(&upload, b"private bytes").await;
        crate::devices::access::authorize_file_sync_snapshot(
            &env.dbx,
            &fixture.login.id,
            fixture.device.id,
        )
        .await
        .unwrap();
        let sql = match revocation {
            "role" => format!(
                "update login set roles = '[]'::jsonb where id = '{}'",
                fixture.login.id
            ),
            "archived" => format!(
                "update device set archived = true, archived_at = now() where id = '{}'",
                fixture.device.id
            ),
            _ => "update system_settings set devices_section_enabled = false"
                .to_owned(),
        };
        env.dbx.execute_unprepared(&sql).await.unwrap();
        let error = finalize(
            &env,
            &fixture.runtime,
            fixture.login.id,
            upload.clone(),
            &locked,
        )
        .await
        .unwrap_err();
        let response = protocol::render(Err(error), false);
        assert_eq!(
            response.status(),
            if revocation == "archived" {
                StatusCode::BAD_REQUEST
            } else {
                StatusCode::FORBIDDEN
            },
            "{revocation}"
        );
        assert!(file_content::Entity::find_by_id((file.id, 1))
            .one(fixture.db())
            .await
            .unwrap()
            .is_none());
        assert!(fixture
            .runtime
            .storage
            .stat(&upload.object_key)
            .await
            .is_err());
        assert_eq!(
            repository::load_upload(fixture.db(), upload.id)
                .await
                .unwrap()
                .unwrap()
                .status,
            UploadStatus::Open
        );
        assert_eq!(locked.offset().unwrap(), upload.upload_length);
        env.dbx
            .execute_unprepared(&format!(
                "update login set roles = '[\"{}\"]'::jsonb where id = '{}'",
                ROLE_DEVICE_SOURCE, fixture.login.id
            ))
            .await
            .unwrap();
        env.dbx.execute_unprepared(&format!("update device set archived = false, archived_at = null where id = '{}'", fixture.device.id)).await.unwrap();
        env.dbx
            .execute_unprepared(
                "update system_settings set devices_section_enabled = true",
            )
            .await
            .unwrap();
        finalize(&env, &fixture.runtime, fixture.login.id, upload, &locked)
            .await
            .unwrap();
    }
    eprintln!(
        "UPLOAD_METRIC revocation_cases=3 denied_publications=3 restored_retries=3 orphan_objects=0"
    );
}

#[actix_web::test]
#[serial_test::serial]
async fn acceptance_terminal_http_matrix_never_recreates_spool() {
    let (mut env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    Arc::get_mut(&mut env).unwrap().device_file_content =
        Some(fixture.runtime.clone());
    let app = app!(env);
    let cookie: Cookie<'static> = cookie!(app, fixture.login.id);
    let mut requests = 0;
    for status in [
        UploadStatus::Completed,
        UploadStatus::Aborted,
        UploadStatus::Expired,
        UploadStatus::Stale,
        UploadStatus::Rejected,
    ] {
        let file = fixture.file(status.database_value()).await;
        let upload = fixture.upload(&file, b"abc").await;
        if status == UploadStatus::Completed {
            let locked = fixture.seed_bytes(&upload, b"abc").await;
            finalize(
                &env,
                &fixture.runtime,
                fixture.login.id,
                upload.clone(),
                &locked,
            )
            .await
            .unwrap();
        } else {
            repository::transition_open(
                fixture.db(),
                &upload,
                status,
                Utc::now().fixed_offset(),
                None,
            )
            .await
            .unwrap();
        }
        let snapshot = fixture.persisted(&upload).await;
        for (method, override_method, complete) in [
            (Method::HEAD, None, false),
            (Method::PATCH, None, false),
            (Method::DELETE, None, false),
            (Method::POST, Some("PATCH"), false),
            (Method::POST, Some("DELETE"), false),
            (Method::POST, None, true),
        ] {
            let path = format!(
                "{}{}",
                super::resource_location(upload.id),
                if complete { "/complete" } else { "" }
            );
            let is_head = method == Method::HEAD;
            let mut request = test::TestRequest::default()
                .method(method)
                .uri(&path)
                .cookie(cookie.clone())
                .insert_header(("tus-resumable", "1.0.0"));
            if let Some(override_method) = override_method {
                request = request
                    .insert_header(("x-http-method-override", override_method));
            }
            if !is_head && !complete {
                request = request.set_payload("must not append");
            }
            let response = test::call_service(&app, request.to_request()).await;
            let expected = if status != UploadStatus::Completed {
                StatusCode::GONE
            } else if is_head {
                StatusCode::NO_CONTENT
            } else if complete {
                StatusCode::OK
            } else {
                StatusCode::CONFLICT
            };
            assert_eq!(
                response.status(),
                expected,
                "{status:?} {path} {override_method:?}"
            );
            assert_eq!(
                response.headers().get("tus-resumable").unwrap(),
                "1.0.0"
            );
            if is_head {
                assert_eq!(
                    response.headers().get("cache-control").unwrap(),
                    "no-store"
                );
                assert!(!response.headers().contains_key("upload-expires"));
                if status == UploadStatus::Completed {
                    assert_eq!(
                        response.headers().get("upload-offset").unwrap(),
                        "3"
                    );
                    assert_eq!(
                        response.headers().get("upload-length").unwrap(),
                        "3"
                    );
                    assert_eq!(
                        response.headers().get("upload-metadata").unwrap(),
                        protocol::canonical_metadata(&upload.expected_sha256)
                            .as_str()
                    );
                }
                assert!(test::read_body(response).await.is_empty());
            }
            assert_eq!(fixture.persisted(&upload).await, snapshot);
            assert!(!fixture
                .spool
                .path()
                .join(format!("{}.lock", upload.id))
                .exists());
            assert!(!fixture
                .spool
                .path()
                .join(format!("{}.data", upload.id))
                .exists());
            requests += 1;
        }
    }
    eprintln!(
        "UPLOAD_METRIC terminal_matrix_requests={requests} unexpected_mutations=0 recreated_locks=0"
    );
}

#[actix_web::test]
#[serial_test::serial]
async fn acceptance_cleanup_releases_bytes_but_retains_count_until_object_deleted(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let file = fixture.file("cleanup").await;
    let upload = fixture.upload(&file, b"1234567890").await;
    let locked = fixture.seed_bytes(&upload, b"1234567890").await;
    drop(locked);
    repository::transition_open(
        fixture.db(),
        &upload,
        UploadStatus::Aborted,
        Utc::now().fixed_offset(),
        None,
    )
    .await
    .unwrap();
    let storage_root = tempfile::tempdir().unwrap();
    let unavailable_root = storage_root.path().join("unavailable");
    std::fs::create_dir(&unavailable_root).unwrap();
    let broken_storage = opendal::Operator::new(
        opendal::services::Fs::default()
            .root(unavailable_root.to_str().unwrap()),
    )
    .unwrap()
    .finish();
    std::fs::remove_dir(&unavailable_root).unwrap();
    std::fs::write(&unavailable_root, b"not a directory").unwrap();
    let mut broken = (*fixture.runtime).clone();
    broken.storage = broken_storage;
    assert!(worker::cleanup_one_for_test(&broken, upload.id)
        .await
        .is_err());
    let persisted = fixture.persisted(&upload).await;
    assert!(persisted.spool_removed_at.is_some());
    assert!(!fixture
        .spool
        .path()
        .join(format!("{}.data", upload.id))
        .exists());
    let now = Utc::now().fixed_offset();
    repository::schedule_cleanup_retry(
        fixture.db(),
        upload.id,
        now,
        now + Duration::minutes(5),
    )
    .await
    .unwrap();
    assert!(fixture.persisted(&upload).await.next_cleanup_at.unwrap() > now);
    let next = fixture.file("after-cleanup-failure").await;
    let mut config = fixture.runtime.config.clone();
    config.max_reserved_bytes = 10;
    config.max_reserved_per_login = 10;
    config.max_reserved_count = 1;
    config.max_count_per_login = 1;
    assert!(matches!(
        repository::create_or_replay(
            fixture.db(),
            fixture.request(&next, b"1234567890"),
            &config
        )
        .await
        .unwrap(),
        CreateOutcome::CapacityUnavailable
    ));
    config.max_reserved_count = 2;
    config.max_count_per_login = 2;
    let next_upload = match repository::create_or_replay(
        fixture.db(),
        fixture.request(&next, b"1234567890"),
        &config,
    )
    .await
    .unwrap()
    {
        CreateOutcome::Created(upload) => upload,
        outcome => {
            panic!("local bytes not released after S3 failure: {outcome:?}")
        }
    };
    repository::transition_open(
        fixture.db(),
        &next_upload,
        UploadStatus::Aborted,
        Utc::now().fixed_offset(),
        None,
    )
    .await
    .unwrap();
    worker::cleanup_one_for_test(&fixture.runtime, next_upload.id)
        .await
        .unwrap();
    assert!(repository::load_upload(fixture.db(), next_upload.id)
        .await
        .unwrap()
        .is_none());
    assert!(repository::load_upload(fixture.db(), upload.id)
        .await
        .unwrap()
        .is_some());
    worker::cleanup_one_for_test(&fixture.runtime, upload.id)
        .await
        .unwrap();
    worker::cleanup_one_for_test(&fixture.runtime, upload.id)
        .await
        .unwrap();
    assert!(repository::load_upload(fixture.db(), upload.id)
        .await
        .unwrap()
        .is_none());
    eprintln!(
        "UPLOAD_METRIC cleanup_faults=1 bytes_released=10 count_held_until_object_cleanup=1 later_rows_cleaned=1 idempotent_retries=1"
    );
}

#[actix_web::test]
#[serial_test::serial]
async fn acceptance_open_http_error_matrix_and_concurrent_patch_recovery() {
    let (mut env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    Arc::get_mut(&mut env).unwrap().device_file_content =
        Some(fixture.runtime.clone());
    let app = app!(env);
    let cookie: Cookie<'static> = cookie!(app, fixture.login.id);
    let file = fixture.file("http-open").await;
    let upload = fixture.upload(&file, b"abcdef").await;
    let path = super::resource_location(upload.id);
    let snapshot = fixture.persisted(&upload).await;
    let cases = [
        (
            "missing-version",
            Method::PATCH,
            None,
            Some("0"),
            Some(protocol::CONTENT_TYPE_PATCH),
            "abc",
            412,
        ),
        (
            "invalid-version",
            Method::PATCH,
            Some("0.2"),
            Some("0"),
            Some(protocol::CONTENT_TYPE_PATCH),
            "abc",
            412,
        ),
        (
            "missing-offset",
            Method::PATCH,
            Some("1.0.0"),
            None,
            Some(protocol::CONTENT_TYPE_PATCH),
            "abc",
            400,
        ),
        (
            "negative-offset",
            Method::PATCH,
            Some("1.0.0"),
            Some("-1"),
            Some(protocol::CONTENT_TYPE_PATCH),
            "abc",
            400,
        ),
        (
            "overflow-offset",
            Method::PATCH,
            Some("1.0.0"),
            Some("18446744073709551616"),
            Some(protocol::CONTENT_TYPE_PATCH),
            "abc",
            400,
        ),
        (
            "mismatch-offset",
            Method::PATCH,
            Some("1.0.0"),
            Some("1"),
            Some(protocol::CONTENT_TYPE_PATCH),
            "abc",
            409,
        ),
        (
            "missing-content-type",
            Method::PATCH,
            Some("1.0.0"),
            Some("0"),
            None,
            "abc",
            415,
        ),
        (
            "wrong-content-type",
            Method::PATCH,
            Some("1.0.0"),
            Some("0"),
            Some("application/json"),
            "abc",
            415,
        ),
        (
            "oversized-body",
            Method::PATCH,
            Some("1.0.0"),
            Some("0"),
            Some(protocol::CONTENT_TYPE_PATCH),
            "1234567",
            413,
        ),
        (
            "unsupported-method",
            Method::PUT,
            Some("1.0.0"),
            Some("0"),
            Some(protocol::CONTENT_TYPE_PATCH),
            "abc",
            405,
        ),
        (
            "post-without-override",
            Method::POST,
            Some("1.0.0"),
            Some("0"),
            Some(protocol::CONTENT_TYPE_PATCH),
            "abc",
            405,
        ),
    ];
    let request_count = cases.len();
    for (name, method, version, offset, content_type, payload, expected) in
        cases
    {
        let mut request = test::TestRequest::default()
            .method(method)
            .uri(&path)
            .cookie(cookie.clone())
            .set_payload(payload);
        if let Some(version) = version {
            request = request.insert_header(("tus-resumable", version));
        }
        if let Some(offset) = offset {
            request = request.insert_header(("upload-offset", offset));
        }
        if let Some(content_type) = content_type {
            request = request.insert_header(("content-type", content_type));
        }
        let response = test::call_service(&app, request.to_request()).await;
        assert_eq!(response.status().as_u16(), expected, "{name}");
        assert_eq!(
            response.headers().get("tus-resumable").unwrap(),
            "1.0.0",
            "{name}"
        );
        if expected == 412 {
            assert_eq!(response.headers().get("tus-version").unwrap(), "1.0.0");
        }
        if name == "mismatch-offset" || name == "oversized-body" {
            assert_eq!(response.headers().get("upload-offset").unwrap(), "0");
        }
        assert_eq!(fixture.persisted(&upload).await, snapshot, "{name}");
        assert!(
            !fixture
                .spool
                .path()
                .join(format!("{}.data", upload.id))
                .exists(),
            "{name}"
        );
    }
    let incomplete = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&format!("{path}/complete"))
            .cookie(cookie.clone())
            .insert_header(("tus-resumable", "1.0.0"))
            .to_request(),
    )
    .await;
    assert_eq!(incomplete.status(), StatusCode::CONFLICT);
    assert_eq!(
        test::read_body_json::<Value, _>(incomplete).await["code"],
        "upload_incomplete"
    );
    let nonempty = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&format!("{path}/complete"))
            .cookie(cookie.clone())
            .insert_header(("tus-resumable", "1.0.0"))
            .set_payload("unexpected")
            .to_request(),
    )
    .await;
    assert_eq!(nonempty.status(), StatusCode::BAD_REQUEST);
    let make_patch = || {
        test::TestRequest::patch()
            .uri(&path)
            .cookie(cookie.clone())
            .insert_header(("tus-resumable", "1.0.0"))
            .insert_header(("upload-offset", "0"))
            .insert_header(("content-type", protocol::CONTENT_TYPE_PATCH))
            .set_payload("abc")
            .to_request()
    };
    let started = Instant::now();
    let responses = futures_util::future::join_all(
        (0..8).map(|_| test::call_service(&app, make_patch())),
    )
    .await;
    let mut accepted = 0;
    let mut conflicts = 0;
    for response in responses {
        match response.status() {
            StatusCode::NO_CONTENT => accepted += 1,
            StatusCode::CONFLICT => conflicts += 1,
            status => panic!("concurrent PATCH status {status}"),
        }
        assert_eq!(response.headers().get("upload-offset").unwrap(), "3");
    }
    assert_eq!((accepted, conflicts), (1, 7));
    assert_eq!(
        std::fs::read(fixture.spool.path().join(format!("{}.data", upload.id)))
            .unwrap(),
        b"abc"
    );
    let progressed = fixture.persisted(&upload).await;
    let empty = test::call_service(
        &app,
        test::TestRequest::patch()
            .uri(&path)
            .cookie(cookie.clone())
            .insert_header(("tus-resumable", "1.0.0"))
            .insert_header(("upload-offset", "3"))
            .insert_header(("content-type", protocol::CONTENT_TYPE_PATCH))
            .to_request(),
    )
    .await;
    assert_eq!(empty.status(), StatusCode::NO_CONTENT);
    assert_eq!(fixture.persisted(&upload).await, progressed);
    let head = test::call_service(
        &app,
        test::TestRequest::default()
            .method(Method::HEAD)
            .uri(&path)
            .cookie(cookie.clone())
            .insert_header(("tus-resumable", "1.0.0"))
            .to_request(),
    )
    .await;
    assert_eq!(head.status(), StatusCode::NO_CONTENT);
    assert_eq!(head.headers().get("upload-offset").unwrap(), "3");
    assert_eq!(fixture.persisted(&upload).await, progressed);
    let patch = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&path)
            .cookie(cookie)
            .insert_header(("tus-resumable", "1.0.0"))
            .insert_header(("upload-offset", "3"))
            .insert_header(("x-http-method-override", "patch"))
            .insert_header(("content-type", protocol::CONTENT_TYPE_PATCH))
            .set_payload("def")
            .to_request(),
    )
    .await;
    assert_eq!(patch.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        std::fs::read(fixture.spool.path().join(format!("{}.data", upload.id)))
            .unwrap(),
        b"abcdef"
    );
    assert!(file_content::Entity::find_by_id((file.id, 1))
        .one(fixture.db())
        .await
        .unwrap()
        .is_none());
    eprintln!(
        "UPLOAD_METRIC open_error_cases={request_count} concurrent_patch_requests=8 accepted=1 offset_conflicts=7 concurrent_elapsed_ms={} bytes_after_resume=6 unexpected_publications=0",
        started.elapsed().as_millis()
    );
}

#[actix_web::test]
#[serial_test::serial]
async fn acceptance_spool_disconnect_restart_chunked_rollback_and_expiry_bounds(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let file = fixture.file("disconnect").await;
    let upload = fixture.upload(&file, b"abcdef").await;
    let locked = fixture.runtime.spool.acquire(upload.id).await.unwrap();
    let disconnected = stream::iter([
        Ok(bytes::Bytes::from_static(b"abc")),
        Err(actix_web::error::PayloadError::Incomplete(None)),
    ]);
    assert!(matches!(
        locked.append(disconnected, 0, 6).await,
        Err(super::AppendError::Payload(_))
    ));
    assert_eq!(locked.offset().unwrap(), 3);
    drop(locked);
    let restarted = super::Spool::for_test(fixture.spool.path().to_path_buf())
        .await
        .unwrap();
    let locked = restarted.acquire(upload.id).await.unwrap();
    assert_eq!(locked.offset().unwrap(), 3);
    let oversized = stream::iter([
        Ok(bytes::Bytes::from_static(b"de")),
        Ok(bytes::Bytes::from_static(b"fg")),
    ]);
    assert!(matches!(
        locked.append(oversized, 3, 6).await,
        Err(super::AppendError::ExceedsLength { offset: 3 })
    ));
    assert_eq!(locked.offset().unwrap(), 3);
    assert_eq!(
        std::fs::read(fixture.spool.path().join(format!("{}.data", upload.id)))
            .unwrap(),
        b"abc"
    );
    let before = fixture.persisted(&upload).await;
    let refreshed = repository::refresh_open(
        fixture.db(),
        &upload,
        upload.expires_at - Duration::seconds(1),
        true,
        &fixture.runtime.config,
        None,
    )
    .await
    .unwrap();
    assert!(matches!(refreshed, repository::RevalidateOutcome::Open(_)));
    let mut current = repository::load_upload(fixture.db(), upload.id)
        .await
        .unwrap()
        .unwrap();
    for _ in 0..10 {
        let when = (current.expires_at - Duration::seconds(1))
            .min(current.hard_expires_at - Duration::seconds(1));
        match repository::refresh_open(
            fixture.db(),
            &current,
            when,
            false,
            &fixture.runtime.config,
            None,
        )
        .await
        .unwrap()
        {
            repository::RevalidateOutcome::Open(upload) => current = upload,
            outcome => panic!("unexpected refresh: {outcome:?}"),
        }
    }
    assert_eq!(current.expires_at, before.hard_expires_at);
    assert_eq!(current.hard_expires_at, before.hard_expires_at);
    assert!(matches!(
        repository::revalidate_open(
            fixture.db(),
            &current,
            current.hard_expires_at,
            None,
        )
        .await
        .unwrap(),
        repository::RevalidateOutcome::Terminal(UploadStatus::Expired)
    ));
    eprintln!(
        "UPLOAD_METRIC disconnect_retained_bytes=3 restart_authoritative_offset=3 chunked_rollback_bytes=2 hard_expiry_extensions=0"
    );
}

#[actix_web::test]
#[serial_test::serial]
async fn acceptance_request_driven_expiry_records_terminal_metric() {
    let (mut env, _guard) = cleanup_locked().await.unwrap();
    let mut fixture = Fixture::new(&env).await;
    let (metrics, recorder) = crate::telemetry::Metrics::recording(&env.config);
    Arc::get_mut(&mut fixture.runtime).unwrap().metrics = Some(metrics.clone());
    Arc::get_mut(&mut env).unwrap().device_file_content =
        Some(fixture.runtime.clone());
    let file = fixture.file("expired-metric").await;
    let mut request = fixture.request(&file, b"abc");
    request.now -= Duration::days(2);
    let upload = match repository::create_or_replay(
        fixture.db(),
        request,
        &fixture.runtime.config,
    )
    .await
    .unwrap()
    {
        CreateOutcome::Created(upload) => upload,
        outcome => panic!("{outcome:?}"),
    };
    let app = app!(env);
    let cookie: Cookie<'static> = cookie!(app, fixture.login.id);
    let response = test::call_service(
        &app,
        test::TestRequest::default()
            .method(Method::HEAD)
            .uri(&super::resource_location(upload.id))
            .cookie(cookie.clone())
            .insert_header(("tus-resumable", "1.0.0"))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::GONE);
    assert_eq!(
        repository::load_upload(fixture.db(), upload.id)
            .await
            .unwrap()
            .unwrap()
            .status,
        UploadStatus::Expired
    );
    for _ in 0..3 {
        let replay = test::call_service(
            &app,
            test::TestRequest::default()
                .method(Method::HEAD)
                .uri(&super::resource_location(upload.id))
                .cookie(cookie.clone())
                .insert_header(("tus-resumable", "1.0.0"))
                .to_request(),
        )
        .await;
        assert_eq!(replay.status(), StatusCode::GONE);
        repository::refresh_open(
            fixture.db(),
            &upload,
            Utc::now().fixed_offset(),
            false,
            &fixture.runtime.config,
            Some(&metrics),
        )
        .await
        .unwrap();
        repository::transition_open(
            fixture.db(),
            &upload,
            UploadStatus::Aborted,
            Utc::now().fixed_offset(),
            Some(&metrics),
        )
        .await
        .unwrap();
        repository::publish(
            fixture.db(),
            &upload,
            true,
            Utc::now().fixed_offset(),
            Some(&metrics),
        )
        .await
        .unwrap();
    }
    metrics.force_flush_for_test();
    let observed = recorder.counter_value(
        "echo.device_files.content_upload.terminal.count",
        &[("status", "expired")],
    );
    eprintln!(
        "UPLOAD_METRIC request_driven_expired_rows=1 terminal_counter={observed:?}"
    );
    assert_eq!(
        observed,
        Some(1),
        "request-driven expiry must be counted once"
    );
}

#[actix_web::test]
#[serial_test::serial]
async fn acceptance_publication_database_failure_rolls_back_and_retries() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let file = fixture.file("publication-db-failure").await;
    let upload = fixture.upload(&file, b"publication bytes").await;
    let locked = fixture.seed_bytes(&upload, b"publication bytes").await;
    fixture.db().execute_unprepared(r#"
        create function public.test_upload_reject_publication() returns trigger language plpgsql as $$
        begin raise exception 'injected publication database failure'; end $$;
        create trigger test_upload_reject_publication_trg before update of content_path on public.file_entry
        for each row when (new.content_path is not null) execute function public.test_upload_reject_publication();
    "#).await.unwrap();
    let result = finalize(
        &env,
        &fixture.runtime,
        fixture.login.id,
        upload.clone(),
        &locked,
    )
    .await;
    fixture
        .db()
        .execute_unprepared(
            r#"
        drop trigger test_upload_reject_publication_trg on public.file_entry;
        drop function public.test_upload_reject_publication();
    "#,
        )
        .await
        .unwrap();
    assert_error(
        result.unwrap_err(),
        StatusCode::SERVICE_UNAVAILABLE,
        Some("file_registry_unavailable"),
    )
    .await;
    assert_eq!(
        repository::load_upload(fixture.db(), upload.id)
            .await
            .unwrap()
            .unwrap()
            .status,
        UploadStatus::Open
    );
    assert!(file_content::Entity::find_by_id((file.id, 1))
        .one(fixture.db())
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        file_entry::Entity::find_by_id(file.id)
            .one(fixture.db())
            .await
            .unwrap()
            .unwrap(),
        file
    );
    assert_eq!(locked.offset().unwrap(), upload.upload_length);
    assert!(fixture
        .runtime
        .storage
        .stat(&upload.object_key)
        .await
        .is_err());
    let completed = finalize(
        &env,
        &fixture.runtime,
        fixture.login.id,
        upload.clone(),
        &locked,
    )
    .await
    .unwrap();
    assert_eq!(
        repository::reconcile_publication(fixture.db(), upload.id)
            .await
            .unwrap(),
        Some(completed)
    );
    assert!(fixture
        .runtime
        .storage
        .stat(&upload.object_key)
        .await
        .is_ok());
    eprintln!(
        "UPLOAD_METRIC injected_publication_db_failures=1 partial_content_rows=0 orphan_objects=0 successful_retries=1"
    );
}

async fn resync_file(env: &Env, fixture: &Fixture, file: &file_entry::Model) {
    let result = crate::devices::files::sync::automatic(
        &env.dbx,
        env.file_registry_db().unwrap(),
        &fixture.login,
        fixture.device.id,
        vec![crate::devices::files::types::RawSyncDeviceFileItem {
            absolute_path: file.absolute_path.clone().unwrap(),
            mime_type: file.mime_type.clone(),
            extension: file.extension.clone(),
            file_metadata_created_at: None,
            file_metadata_modified_at: None,
            source_file_state: None,
        }],
    )
    .await
    .unwrap();
    assert!(
        matches!(&result.results[0], crate::devices::files::types::FileSyncResult::Accepted { file_id, revision: 2, .. } if file_id == &file.id.to_string())
    );
}

#[actix_web::test]
#[serial_test::serial]
async fn acceptance_metadata_publication_both_orders_preserve_revision_binding()
{
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    for publication_first in [true, false] {
        let file = fixture
            .file(if publication_first {
                "publish-first"
            } else {
                "metadata-first"
            })
            .await;
        let upload = fixture.upload(&file, b"revision one").await;
        let locked = fixture.seed_bytes(&upload, b"revision one").await;
        if publication_first {
            finalize(
                &env,
                &fixture.runtime,
                fixture.login.id,
                upload.clone(),
                &locked,
            )
            .await
            .unwrap();
            resync_file(&env, &fixture, &file).await;
            let content = file_content::Entity::find_by_id((file.id, 1))
                .one(fixture.db())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(content.object_key, upload.object_key);
            assert!(fixture
                .runtime
                .storage
                .stat(&upload.object_key)
                .await
                .is_ok());
            assert!(repository::reconcile_publication(fixture.db(), upload.id)
                .await
                .unwrap()
                .is_some());
        } else {
            resync_file(&env, &fixture, &file).await;
            let error = finalize(
                &env,
                &fixture.runtime,
                fixture.login.id,
                upload.clone(),
                &locked,
            )
            .await
            .unwrap_err();
            assert_error(error, StatusCode::GONE, Some("upload_stale")).await;
            assert!(file_content::Entity::find_by_id((file.id, 1))
                .one(fixture.db())
                .await
                .unwrap()
                .is_none());
            assert!(fixture
                .runtime
                .storage
                .stat(&upload.object_key)
                .await
                .is_err());
            assert_eq!(
                repository::load_upload(fixture.db(), upload.id)
                    .await
                    .unwrap()
                    .unwrap()
                    .status,
                UploadStatus::Stale
            );
        }
        let current = file_entry::Entity::find_by_id(file.id)
            .one(fixture.db())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(current.revision, Some(2));
        assert!(current.content_path.is_none());
        assert!(file_content::Entity::find_by_id((file.id, 2))
            .one(fixture.db())
            .await
            .unwrap()
            .is_none());
    }
    eprintln!(
        "UPLOAD_METRIC publication_metadata_orders=2 historical_content_preserved=1 stale_publications_denied=1 implicit_content_carryovers=0"
    );
}

#[actix_web::test]
#[serial_test::serial]
async fn acceptance_nonempty_complete_is_rejected_after_concurrent_publication()
{
    let (mut env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    Arc::get_mut(&mut env).unwrap().device_file_content =
        Some(fixture.runtime.clone());
    let app = app!(env);
    let cookie: Cookie<'static> = cookie!(app, fixture.login.id);
    let file = fixture.file("complete-body-race").await;
    let upload = fixture.upload(&file, b"abc").await;
    let locked = fixture.seed_bytes(&upload, b"abc").await;
    let request = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&format!("{}/complete", super::resource_location(upload.id)))
            .cookie(cookie)
            .insert_header(("tus-resumable", "1.0.0"))
            .set_payload("unexpected body")
            .to_request(),
    );
    let publish = async {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        finalize(&env, &fixture.runtime, fixture.login.id, upload, &locked)
            .await
            .unwrap();
        drop(locked);
    };
    let (response, ()) = tokio::join!(request, publish);
    eprintln!(
        "UPLOAD_METRIC concurrent_complete_nonempty_body_status={}",
        response.status().as_u16()
    );
    assert_eq!(
        response.status(),
        StatusCode::BAD_REQUEST,
        "non-empty complete must be rejected even after waiting for another finalizer"
    );
}

#[actix_web::test]
async fn acceptance_content_routes_do_not_shadow_following_application_routes()
{
    let app = test::init_service(App::new().service(super::routes()).route(
        "/api/unrelated-after-upload",
        web::post().to(|| async { HttpResponse::Ok().finish() }),
    ))
    .await;
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/unrelated-after-upload")
            .to_request(),
    )
    .await;
    eprintln!(
        "UPLOAD_METRIC unrelated_route_after_content_status={}",
        response.status().as_u16()
    );
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "device content registration must preserve unrelated routes"
    );
}

#[actix_web::test]
#[serial_test::serial]
async fn acceptance_creation_input_matrix_and_cross_login_replay() {
    let (mut env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    Arc::get_mut(&mut env).unwrap().device_file_content =
        Some(fixture.runtime.clone());
    let app = app!(env);
    let cookie: Cookie<'static> = cookie!(app, fixture.login.id);
    let file = fixture.file("create-input").await;
    let path = format!(
        "/api/device/files/{}/{}/revisions/1/content-uploads",
        fixture.device.id, file.id
    );
    let metadata = protocol::canonical_metadata(&Sha256::digest(b"abc").into());
    let too_large = (fixture.runtime.config.upload_max_bytes + 1).to_string();
    let encoded_31 = format!(
        "sha256 {}",
        base64::engine::general_purpose::STANDARD.encode([1_u8; 31])
    );
    let encoded_33 = format!(
        "sha256 {}",
        base64::engine::general_purpose::STANDARD.encode([1_u8; 33])
    );
    let encoded_hex = format!(
        "sha256 {}",
        base64::engine::general_purpose::STANDARD.encode(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        )
    );
    let duplicate_metadata = format!("{metadata},{metadata}");
    let unknown_metadata = format!("{metadata},filename ZXZpbA==");
    let extra_metadata = format!("{metadata} extra");
    let cases: Vec<(&str, Vec<&str>, Vec<&str>, &str, u16)> = vec![
        ("missing-length", vec![], vec![&metadata], "", 400),
        ("negative-length", vec!["-1"], vec![&metadata], "", 400),
        ("fractional-length", vec!["1.5"], vec![&metadata], "", 400),
        ("empty-length", vec![""], vec![&metadata], "", 400),
        (
            "overflow-length",
            vec!["18446744073709551616"],
            vec![&metadata],
            "",
            400,
        ),
        ("max-plus-one", vec![&too_large], vec![&metadata], "", 413),
        ("duplicate-length", vec!["3", "3"], vec![&metadata], "", 400),
        (
            "conflicting-length",
            vec!["3", "4"],
            vec![&metadata],
            "",
            400,
        ),
        ("missing-metadata", vec!["3"], vec![], "", 400),
        ("empty-metadata", vec!["3"], vec![""], "", 400),
        ("key-without-digest", vec!["3"], vec!["sha256"], "", 400),
        ("unknown-key", vec!["3"], vec!["filename ZXZpbA=="], "", 400),
        ("invalid-base64", vec!["3"], vec!["sha256 %%%"], "", 400),
        ("digest-31-bytes", vec!["3"], vec![&encoded_31], "", 400),
        ("digest-33-bytes", vec!["3"], vec![&encoded_33], "", 400),
        (
            "base64-of-hex-digest",
            vec!["3"],
            vec![&encoded_hex],
            "",
            400,
        ),
        (
            "duplicate-csv-metadata",
            vec!["3"],
            vec![&duplicate_metadata],
            "",
            400,
        ),
        (
            "unknown-csv-metadata",
            vec!["3"],
            vec![&unknown_metadata],
            "",
            400,
        ),
        (
            "duplicate-header-metadata",
            vec!["3"],
            vec![&metadata, &metadata],
            "",
            400,
        ),
        (
            "extra-metadata-token",
            vec!["3"],
            vec![&extra_metadata],
            "",
            400,
        ),
        ("zero-length-wrong-sha", vec!["0"], vec![&metadata], "", 422),
        ("creation-body", vec!["3"], vec![&metadata], "body", 400),
    ];
    let invalid_cases = cases.len();
    for (name, lengths, metadata, body, expected) in cases {
        let mut request = test::TestRequest::post()
            .uri(&path)
            .cookie(cookie.clone())
            .insert_header(("tus-resumable", "1.0.0"));
        for length in lengths {
            request = request.append_header(("upload-length", length));
        }
        for metadata in metadata {
            request = request.append_header(("upload-metadata", metadata));
        }
        if !body.is_empty() {
            request = request.set_payload(body);
        }
        let response = test::call_service(&app, request.to_request()).await;
        assert_eq!(response.status().as_u16(), expected, "{name}");
        assert_eq!(
            response.headers().get("tus-resumable").unwrap(),
            "1.0.0",
            "{name}"
        );
        assert!(
            file_content_upload::Entity::find()
                .all(fixture.db())
                .await
                .unwrap()
                .is_empty(),
            "{name}"
        );
        assert_eq!(
            std::fs::read_dir(fixture.spool.path()).unwrap().count(),
            0,
            "{name}"
        );
    }
    let created = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&path)
            .cookie(cookie.clone())
            .insert_header(("tus-resumable", "1.0.0"))
            .insert_header(("upload-length", "3"))
            .insert_header(("upload-metadata", metadata.clone()))
            .to_request(),
    )
    .await;
    assert_eq!(created.status(), StatusCode::CREATED);
    let location = created
        .headers()
        .get("location")
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    let second = mk_login(
        &env.dbx,
        login::ActiveModel {
            login: Set(format!("upload-second-{}", Uuid::new_v4())),
            organism_id: Set(fixture.login.organism_id),
            roles: Set(json!([ROLE_DEVICE_SOURCE])),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let second_cookie: Cookie<'static> = cookie!(app, second.id);
    let replay = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&path)
            .cookie(second_cookie.clone())
            .insert_header(("tus-resumable", "1.0.0"))
            .insert_header(("upload-length", "3"))
            .insert_header(("upload-metadata", metadata.clone()))
            .to_request(),
    )
    .await;
    assert_eq!(replay.status(), StatusCode::CREATED);
    assert_eq!(
        replay.headers().get("location").unwrap().to_str().unwrap(),
        location
    );
    let conflict = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&path)
            .cookie(second_cookie.clone())
            .insert_header(("tus-resumable", "1.0.0"))
            .insert_header(("upload-length", "4"))
            .insert_header(("upload-metadata", metadata))
            .to_request(),
    )
    .await;
    assert_eq!(conflict.status(), StatusCode::CONFLICT);
    assert_eq!(
        conflict
            .headers()
            .get("location")
            .unwrap()
            .to_str()
            .unwrap(),
        location
    );
    assert!(conflict.headers().contains_key("retry-after"));
    assert_eq!(
        test::read_body_json::<Value, _>(conflict).await["code"],
        "upload_in_progress"
    );
    let patch = test::call_service(
        &app,
        test::TestRequest::patch()
            .uri(&location)
            .cookie(second_cookie.clone())
            .insert_header(("tus-resumable", "1.0.0"))
            .insert_header(("upload-offset", "0"))
            .insert_header(("content-type", protocol::CONTENT_TYPE_PATCH))
            .set_payload("abc")
            .to_request(),
    )
    .await;
    assert_eq!(patch.status(), StatusCode::NO_CONTENT);
    let completed = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&format!("{location}/complete"))
            .cookie(second_cookie)
            .insert_header(("tus-resumable", "1.0.0"))
            .to_request(),
    )
    .await;
    assert_eq!(completed.status(), StatusCode::OK);
    let rows = file_content_upload::Entity::find()
        .all(fixture.db())
        .await
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].created_by_login_id, fixture.login.id);
    eprintln!(
        "UPLOAD_METRIC invalid_creation_cases={invalid_cases} unexpected_reservations=0 cross_login_replays=1 cross_login_patch_complete=1 target_conflicts=1 creator_changed=0"
    );
}

#[actix_web::test]
#[serial_test::serial]
async fn acceptance_terminal_metrics_count_only_committed_transitions() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let (metrics, recorder) = crate::telemetry::Metrics::recording(&env.config);
    for status in [
        UploadStatus::Stale,
        UploadStatus::Rejected,
        UploadStatus::Aborted,
        UploadStatus::Completed,
    ] {
        let file = fixture.file(status.database_value()).await;
        let upload = fixture.upload(&file, b"metric").await;
        if status == UploadStatus::Stale {
            let mut revision =
                file_revision::Entity::find_by_id((file.id, upload.revision))
                    .one(fixture.db())
                    .await
                    .unwrap()
                    .unwrap()
                    .into_active_model();
            let source_sequence = *revision.source_sequence.as_ref() + 1;
            revision.revision = Set(upload.revision + 1);
            revision.source_sequence = Set(source_sequence);
            revision.insert(fixture.db()).await.unwrap();
            file_device_source_state::ActiveModel {
                id: Set(file.device_id),
                last_source_sequence: Set(source_sequence),
            }
            .update(fixture.db())
            .await
            .unwrap();
            file_entry::ActiveModel {
                id: Set(file.id),
                revision: Set(Some(upload.revision + 1)),
                ..Default::default()
            }
            .update(fixture.db())
            .await
            .unwrap();
        }
        for _ in 0..3 {
            if status == UploadStatus::Completed {
                repository::publish(
                    fixture.db(),
                    &upload,
                    true,
                    Utc::now().fixed_offset(),
                    Some(&metrics),
                )
                .await
                .unwrap();
            } else if matches!(
                status,
                UploadStatus::Aborted | UploadStatus::Rejected
            ) {
                repository::transition_open(
                    fixture.db(),
                    &upload,
                    status,
                    Utc::now().fixed_offset(),
                    Some(&metrics),
                )
                .await
                .unwrap();
            } else {
                repository::revalidate_open(
                    fixture.db(),
                    &upload,
                    Utc::now().fixed_offset(),
                    Some(&metrics),
                )
                .await
                .unwrap();
                repository::refresh_open(
                    fixture.db(),
                    &upload,
                    Utc::now().fixed_offset(),
                    false,
                    &fixture.runtime.config,
                    Some(&metrics),
                )
                .await
                .unwrap();
                repository::publish(
                    fixture.db(),
                    &upload,
                    true,
                    Utc::now().fixed_offset(),
                    Some(&metrics),
                )
                .await
                .unwrap();
            }
        }
        assert_eq!(
            repository::load_upload(fixture.db(), upload.id)
                .await
                .unwrap()
                .unwrap()
                .status,
            status
        );
        metrics.force_flush_for_test();
        assert_eq!(
            recorder.counter_value(
                "echo.device_files.content_upload.terminal.count",
                &[("status", status.database_value())]
            ),
            Some(1),
            "{status:?}"
        );
    }
    let file = fixture.file("failed-transition-metric").await;
    let upload = fixture.upload(&file, b"rollback").await;
    fixture.db().execute_unprepared(r#"
        create function public.test_reject_upload_terminal_metric() returns trigger language plpgsql as $$
        begin raise exception 'injected terminal transition failure'; end $$;
        create trigger test_reject_upload_terminal_metric before update of status on public.file_content_upload
        for each row execute function public.test_reject_upload_terminal_metric();
    "#).await.unwrap();
    let result = repository::transition_open(
        fixture.db(),
        &upload,
        UploadStatus::Aborted,
        Utc::now().fixed_offset(),
        Some(&metrics),
    )
    .await;
    fixture.db().execute_unprepared(r#"
        drop trigger test_reject_upload_terminal_metric on public.file_content_upload;
        drop function public.test_reject_upload_terminal_metric();
    "#).await.unwrap();
    assert!(result.is_err());
    assert_eq!(
        repository::load_upload(fixture.db(), upload.id)
            .await
            .unwrap()
            .unwrap()
            .status,
        UploadStatus::Open
    );
    metrics.force_flush_for_test();
    assert_eq!(
        recorder.counter_value(
            "echo.device_files.content_upload.terminal.count",
            &[("status", "aborted")]
        ),
        Some(1)
    );
}

#[actix_web::test]
async fn spool_failure_response_reports_current_offset_or_requires_head() {
    let directory = tempfile::tempdir().unwrap();
    let spool = super::Spool::for_test(directory.path().to_path_buf())
        .await
        .unwrap();
    let id = Uuid::new_v4();
    let locked = spool.acquire(id).await.unwrap();
    for (offset, bytes) in [(0, b"abc".as_slice()), (3, b"de".as_slice())] {
        locked
            .append(
                stream::iter([Ok(bytes::Bytes::copy_from_slice(bytes))]),
                offset,
                6,
            )
            .await
            .unwrap();
    }
    let response = protocol::render(
        Err(super::spool_unavailable_with_offset(
            &locked,
            std::io::Error::from_raw_os_error(28).into(),
        )),
        false,
    );
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(response.headers().get("upload-offset").unwrap(), "5");
    assert_eq!(response.headers().get("tus-resumable").unwrap(), "1.0.0");
    assert!(response.headers().contains_key("retry-after"));
    assert_eq!(
        actix_web::body::to_bytes(response.into_body())
            .await
            .unwrap(),
        r#"{"code":"spool_unavailable"}"#,
    );
    let data = directory.path().join(format!("{id}.data"));
    assert_eq!(std::fs::read(&data).unwrap(), b"abcde");
    std::fs::remove_file(&data).unwrap();
    std::fs::create_dir(&data).unwrap();
    let unavailable_offset = protocol::render(
        Err(super::spool_unavailable_with_offset(
            &locked,
            std::io::Error::from_raw_os_error(28).into(),
        )),
        false,
    );
    assert_eq!(unavailable_offset.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(!unavailable_offset.headers().contains_key("upload-offset"));
    assert!(unavailable_offset.headers().contains_key("retry-after"));
}

async fn seed_cleanup_upload(fixture: &Fixture, name: &str) -> Upload {
    let file = fixture.file(name).await;
    let upload = fixture.upload(&file, b"cleanup bytes").await;
    drop(fixture.seed_bytes(&upload, b"cleanup bytes").await);
    repository::transition_open(
        fixture.db(),
        &upload,
        UploadStatus::Aborted,
        Utc::now().fixed_offset(),
        None,
    )
    .await
    .unwrap();
    upload
}

async fn wait_for_cleanup_uploads(fixture: &Fixture, ids: &[Uuid]) {
    tokio::time::timeout(std::time::Duration::from_secs(8), async {
        loop {
            let mut remaining = false;
            for id in ids {
                remaining |= repository::load_upload(fixture.db(), *id)
                    .await
                    .unwrap()
                    .is_some();
            }
            if !remaining {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("autonomous worker did not clean expected uploads");
}

async fn cleanup_lease_pids(fixture: &Fixture) -> Vec<i32> {
    fixture
        .db()
        .query_all_raw(sea_orm::Statement::from_string(
            sea_orm::DatabaseBackend::Postgres,
            r#"
select pid from pg_locks
where locktype = 'advisory' and granted and objsubid = 1
  and database = (select oid from pg_database where datname = current_database())
  and classid::bigint = ((hashtextextended('echo:device-file-content-cleanup', 0) >> 32) & 4294967295)
  and objid::bigint = (hashtextextended('echo:device-file-content-cleanup', 0) & 4294967295)
"#,
        ))
        .await
        .unwrap()
        .into_iter()
        .map(|row| row.try_get("", "pid").unwrap())
        .collect()
}

async fn wait_for_cleanup_lease(
    fixture: &Fixture,
    previous: Option<i32>,
) -> i32 {
    tokio::time::timeout(std::time::Duration::from_secs(8), async {
        loop {
            let owners = cleanup_lease_pids(fixture).await;
            assert!(owners.len() <= 1, "multiple cleanup lease holders");
            if let [owner] = owners.as_slice() {
                if Some(*owner) != previous {
                    return *owner;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("cleanup worker did not acquire its singleton lease")
}

#[actix_web::test]
#[serial_test::serial]
async fn acceptance_autonomous_cleanup_skips_busy_poison_and_takes_over_lease()
{
    let (env, _guard) = cleanup_locked().await.unwrap();
    let mut fixture = Fixture::new(&env).await;
    let (metrics, recorder) = crate::telemetry::Metrics::recording(&env.config);
    let runtime = Arc::get_mut(&mut fixture.runtime).unwrap();
    runtime.config.cleanup_batch_size = 1;
    runtime.config.cleanup_poll_interval_secs = 1;
    runtime.config.cleanup_retry_delay_secs = 2;
    runtime.metrics = Some(metrics.clone());
    let busy = seed_cleanup_upload(&fixture, "worker-busy").await;
    let held = fixture.runtime.spool.acquire(busy.id).await.unwrap();
    let poison = seed_cleanup_upload(&fixture, "worker-poison").await;
    let poison_path = fixture.spool.path().join(format!("{}.data", poison.id));
    std::fs::remove_file(&poison_path).unwrap();
    std::fs::create_dir(&poison_path).unwrap();
    let healthy = seed_cleanup_upload(&fixture, "worker-healthy").await;
    let initial_poison = fixture.persisted(&poison).await;
    let candidates = repository::list_cleanup_candidates(
        fixture.db(),
        None,
        Utc::now().fixed_offset(),
        10,
    )
    .await
    .unwrap();
    assert_eq!(
        candidates.iter().map(|row| row.id).collect::<Vec<_>>(),
        vec![busy.id, poison.id, healthy.id]
    );

    let first_cancel = tokio_util::sync::CancellationToken::new();
    let _first_cancel_guard = first_cancel.clone().drop_guard();
    let started = Instant::now();
    let first = tokio::spawn(worker::run_nofail(
        fixture.runtime.clone(),
        first_cancel.clone(),
    ));
    let first_pid = wait_for_cleanup_lease(&fixture, None).await;
    wait_for_cleanup_uploads(&fixture, &[healthy.id]).await;
    let healthy_elapsed = started.elapsed().as_millis();
    assert_eq!(held.offset().unwrap(), busy.upload_length);
    assert!(repository::load_upload(fixture.db(), busy.id)
        .await
        .unwrap()
        .is_some());
    let failed_poison = fixture.persisted(&poison).await;
    assert!(failed_poison.spool_removed_at.is_none());
    assert!(failed_poison.next_cleanup_at > initial_poison.next_cleanup_at);
    metrics.force_flush_for_test();
    assert!(
        recorder
            .counter_value(
                "echo.device_files.content_upload.failures.count",
                &[("stage", "cleanup")],
            )
            .unwrap_or(0)
            >= 1
    );

    let second_cancel = tokio_util::sync::CancellationToken::new();
    let _second_cancel_guard = second_cancel.clone().drop_guard();
    let second = tokio::spawn(worker::run_nofail(
        fixture.runtime.clone(),
        second_cancel.clone(),
    ));
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert_eq!(cleanup_lease_pids(&fixture).await, vec![first_pid]);
    first_cancel.cancel();
    tokio::time::timeout(std::time::Duration::from_secs(3), first)
        .await
        .unwrap()
        .unwrap();
    let takeover_started = Instant::now();
    let second_pid = wait_for_cleanup_lease(&fixture, Some(first_pid)).await;
    let takeover_elapsed = takeover_started.elapsed().as_millis();
    assert_ne!(first_pid, second_pid);
    std::fs::remove_dir(&poison_path).unwrap();
    drop(held);
    wait_for_cleanup_uploads(&fixture, &[busy.id, poison.id]).await;

    let file = fixture.file("worker-lease-loss").await;
    let connection_loss = fixture.upload(&file, b"cleanup bytes").await;
    let held = fixture.seed_bytes(&connection_loss, b"cleanup bytes").await;
    repository::transition_open(
        fixture.db(),
        &connection_loss,
        UploadStatus::Aborted,
        Utc::now().fixed_offset(),
        None,
    )
    .await
    .unwrap();
    fixture
        .db()
        .execute_unprepared(&format!(
            "select pg_terminate_backend({second_pid})"
        ))
        .await
        .unwrap();
    let replacement_pid =
        wait_for_cleanup_lease(&fixture, Some(second_pid)).await;
    assert_ne!(second_pid, replacement_pid);
    drop(held);
    wait_for_cleanup_uploads(&fixture, &[connection_loss.id]).await;
    second_cancel.cancel();
    tokio::time::timeout(std::time::Duration::from_secs(3), second)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(std::fs::read_dir(fixture.spool.path()).unwrap().count(), 0);
    eprintln!(
        "UPLOAD_METRIC autonomous_cleanup_rows=4 batch_size=1 busy_prefix_skipped=1 poison_backoff=1 healthy_cleanup_ms={healthy_elapsed} graceful_lease_takeover_ms={takeover_elapsed} terminated_lease_recoveries=1 remaining_spool_files=0"
    );
}

async fn wait_for_finalization_queue(runtime: &DeviceFileContentRuntime) {
    tokio::time::timeout(std::time::Duration::from_millis(500), async {
        while runtime.finalization_waiters.available_permits()
            == crate::config::DEVICE_FILE_CONTENT_FINALIZATION_MAX_WAITING
        {
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
}

#[actix_web::test]
#[serial_test::serial]
async fn acceptance_queued_finalization_releases_spool_and_rechecks_authorization(
) {
    let (mut env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    Arc::get_mut(&mut env).unwrap().device_file_content =
        Some(fixture.runtime.clone());
    let app = app!(env);
    let cookie: Cookie<'static> = cookie!(app, fixture.login.id);
    for revoke in [false, true] {
        let file = fixture
            .file(if revoke {
                "queued-denied"
            } else {
                "queued-success"
            })
            .await;
        let upload = fixture.upload(&file, b"queued source").await;
        drop(fixture.seed_bytes(&upload, b"queued source").await);
        let held = fixture
            .runtime
            .finalization_permits
            .clone()
            .acquire_many_owned(
                fixture.runtime.config.finalization_max_concurrent as u32,
            )
            .await
            .unwrap();
        let request = test::call_service(
            &app,
            test::TestRequest::post()
                .uri(&format!(
                    "{}/complete",
                    super::resource_location(upload.id)
                ))
                .cookie(cookie.clone())
                .insert_header(("tus-resumable", "1.0.0"))
                .to_request(),
        );
        let release = async {
            wait_for_finalization_queue(&fixture.runtime).await;
            let response = tokio::time::timeout(
                std::time::Duration::from_millis(300),
                test::call_service(
                    &app,
                    test::TestRequest::default()
                        .method(Method::HEAD)
                        .uri(&super::resource_location(upload.id))
                        .cookie(cookie.clone())
                        .insert_header(("tus-resumable", "1.0.0"))
                        .to_request(),
                ),
            )
            .await
            .unwrap();
            assert_eq!(response.status(), StatusCode::NO_CONTENT);
            assert_eq!(response.headers().get("upload-offset").unwrap(), "13");
            if revoke {
                env.dbx
                    .execute_unprepared(&format!(
                        "update login set roles = '[]'::jsonb where id = '{}'",
                        fixture.login.id
                    ))
                    .await
                    .unwrap();
            }
            drop(held);
        };
        let (response, ()) = tokio::join!(request, release);
        assert_eq!(
            response.status(),
            if revoke {
                StatusCode::FORBIDDEN
            } else {
                StatusCode::OK
            }
        );
        let current = fixture.persisted(&upload).await;
        assert_eq!(
            current.status,
            if revoke {
                crate::file_registry::entities::sea_orm_active_enums::FileContentUploadStatus::Open
            } else {
                crate::file_registry::entities::sea_orm_active_enums::FileContentUploadStatus::Completed
            }
        );
        assert_eq!(
            fixture.runtime.finalization_waiters.available_permits(),
            crate::config::DEVICE_FILE_CONTENT_FINALIZATION_MAX_WAITING
        );
        assert_eq!(
            fixture.runtime.finalization_permits.available_permits(),
            fixture.runtime.config.finalization_max_concurrent
        );
    }
}

#[actix_web::test]
#[serial_test::serial]
async fn acceptance_finalization_timeout_does_not_refresh_revoked_upload() {
    let (mut env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    Arc::get_mut(&mut env).unwrap().device_file_content =
        Some(fixture.runtime.clone());
    let app = app!(env);
    let cookie: Cookie<'static> = cookie!(app, fixture.login.id);
    let file = fixture.file("queued-timeout-denied").await;
    let upload = fixture.upload(&file, b"queued source").await;
    drop(fixture.seed_bytes(&upload, b"queued source").await);
    let _held = fixture
        .runtime
        .finalization_permits
        .clone()
        .acquire_many_owned(
            fixture.runtime.config.finalization_max_concurrent as u32,
        )
        .await
        .unwrap();
    let before = fixture.persisted(&upload).await;
    let request = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&format!("{}/complete", super::resource_location(upload.id)))
            .cookie(cookie)
            .insert_header(("tus-resumable", "1.0.0"))
            .to_request(),
    );
    let revoke = async {
        wait_for_finalization_queue(&fixture.runtime).await;
        env.dbx
            .execute_unprepared(&format!(
                "update login set roles = '[]'::jsonb where id = '{}'",
                fixture.login.id
            ))
            .await
            .unwrap();
    };
    let (response, ()) = tokio::join!(request, revoke);
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let after = fixture.persisted(&upload).await;
    assert_eq!(after.status, before.status);
    assert_eq!(after.expires_at, before.expires_at);
    assert_eq!(after.last_activity_at, before.last_activity_at);
    assert_eq!(
        fixture.runtime.finalization_waiters.available_permits(),
        crate::config::DEVICE_FILE_CONTENT_FINALIZATION_MAX_WAITING
    );
}

#[actix_web::test]
#[serial_test::serial]
async fn acceptance_finalization_queue_is_bounded_and_cancellation_releases_slots(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let held = fixture
        .runtime
        .finalization_permits
        .clone()
        .acquire_many_owned(
            fixture.runtime.config.finalization_max_concurrent as u32,
        )
        .await
        .unwrap();
    let mut waiting = Box::pin(finalizer::acquire_permit(&fixture.runtime));
    tokio::select! {
        result = &mut waiting => panic!("permit unexpectedly acquired: {result:?}"),
        () = wait_for_finalization_queue(&fixture.runtime) => {}
    }
    drop(waiting);
    assert_eq!(
        fixture.runtime.finalization_waiters.available_permits(),
        crate::config::DEVICE_FILE_CONTENT_FINALIZATION_MAX_WAITING
    );
    let full = fixture
        .runtime
        .finalization_waiters
        .clone()
        .acquire_many_owned(
            crate::config::DEVICE_FILE_CONTENT_FINALIZATION_MAX_WAITING as u32,
        )
        .await
        .unwrap();
    let error = tokio::time::timeout(
        std::time::Duration::from_millis(100),
        finalizer::acquire_permit(&fixture.runtime),
    )
    .await
    .unwrap()
    .unwrap_err();
    assert_error(
        error,
        StatusCode::SERVICE_UNAVAILABLE,
        Some("finalization_busy"),
    )
    .await;
    drop(full);
    drop(held);
    let permit = finalizer::acquire_permit(&fixture.runtime).await.unwrap();
    assert_eq!(
        fixture.runtime.finalization_permits.available_permits(),
        fixture.runtime.config.finalization_max_concurrent - 1
    );
    drop(permit);
}

#[actix_web::test]
#[serial_test::serial]
async fn acceptance_database_lock_wait_counts_toward_upload_expiry() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let mut config = fixture.runtime.config.clone();
    config.upload_idle_ttl_secs = 1;
    config.upload_max_lifetime_secs = 1;
    for operation in
        ["replay", "revalidate", "refresh", "transition", "publish"]
    {
        let file = fixture.file(operation).await;
        let request = fixture.request(&file, b"deadline");
        let upload =
            match repository::create_or_replay(fixture.db(), request, &config)
                .await
                .unwrap()
            {
                CreateOutcome::Created(upload) => upload,
                outcome => panic!("unexpected creation outcome: {outcome:?}"),
            };
        let pool = fixture.db().get_postgres_connection_pool();
        let mut blocker = pool.begin().await.unwrap();
        let blocker_pid: i32 = sqlx::query_scalar("select pg_backend_pid()")
            .fetch_one(&mut *blocker)
            .await
            .unwrap();
        sqlx::query("select id from file_entry where id = $1 for update")
            .bind(file.id)
            .fetch_one(&mut *blocker)
            .await
            .unwrap();
        let now = Utc::now().fixed_offset();
        assert!(now < upload.hard_expires_at);
        let check = async {
            match operation {
                "replay" => {
                    let mut request = fixture.request(&file, b"deadline");
                    request.now = now;
                    assert!(matches!(
                        repository::create_or_replay(
                            fixture.db(),
                            request,
                            &config,
                        )
                        .await
                        .unwrap(),
                        CreateOutcome::InProgress(_)
                    ));
                }
                "publish" => {
                    assert!(matches!(
                        repository::publish(
                            fixture.db(),
                            &upload,
                            false,
                            now,
                            None,
                        )
                        .await
                        .unwrap(),
                        repository::PublishOutcome::Terminal(
                            UploadStatus::Expired
                        )
                    ));
                }
                _ => {
                    let outcome = match operation {
                        "revalidate" => repository::revalidate_open(
                            fixture.db(),
                            &upload,
                            now,
                            None,
                        )
                        .await
                        .unwrap(),
                        "refresh" => repository::refresh_open(
                            fixture.db(),
                            &upload,
                            now,
                            true,
                            &config,
                            None,
                        )
                        .await
                        .unwrap(),
                        "transition" => repository::transition_open(
                            fixture.db(),
                            &upload,
                            UploadStatus::Aborted,
                            now,
                            None,
                        )
                        .await
                        .unwrap(),
                        _ => unreachable!(),
                    };
                    assert!(
                        matches!(
                            outcome,
                            repository::RevalidateOutcome::Terminal(
                                UploadStatus::Expired
                            )
                        ),
                        "{operation}: {outcome:?}"
                    );
                }
            }
        };
        let release = async {
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                loop {
                    let waiting: i64 = sqlx::query_scalar(
                        "select count(*) from pg_stat_activity where $1 = any(pg_blocking_pids(pid))",
                    ).bind(blocker_pid).fetch_one(pool).await.unwrap();
                    if waiting > 0 { break; }
                    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                }
            }).await.expect("upload operation must reach the held row lock");
            let remaining = (upload.hard_expires_at
                - Utc::now().fixed_offset())
            .to_std()
            .unwrap_or_default();
            tokio::time::sleep(
                remaining + std::time::Duration::from_millis(30),
            )
            .await;
            blocker.commit().await.unwrap();
        };
        tokio::join!(check, release);
        assert!(repository::reconcile_publication(fixture.db(), upload.id)
            .await
            .unwrap()
            .is_none());
    }
}

#[actix_web::test]
async fn acceptance_duration_boundaries_fail_closed_without_panicking() {
    let config = crate::config::DeviceFileContentConfig::default();
    assert!(config.validate().is_ok());
    let now = Utc::now().fixed_offset();
    for seconds in [u64::MAX, i64::MAX as u64, 10_000_000_000_000] {
        assert!(repository::deadline_after(now, seconds).is_err());
        for field in ["idle", "lifetime", "retry"] {
            let mut config = config.clone();
            match field {
                "idle" => {
                    config.upload_idle_ttl_secs = seconds;
                    config.upload_max_lifetime_secs = seconds;
                }
                "lifetime" => config.upload_max_lifetime_secs = seconds,
                "retry" => config.cleanup_retry_delay_secs = seconds,
                _ => unreachable!(),
            }
            assert!(config.validate().is_err(), "{field}: {seconds}");
        }
    }
    let mut config = config.clone();
    config.cleanup_poll_interval_secs = u64::MAX;
    assert!(config.validate().is_err());
    assert!(repository::deadline_after(
        chrono::DateTime::<Utc>::MAX_UTC.fixed_offset(),
        1,
    )
    .is_err());
    assert_eq!(
        repository::deadline_after(now, 60).unwrap(),
        now + Duration::seconds(60)
    );
}
