use std::sync::Arc;
use std::time::Instant;

use actix_identity::{Identity, IdentityMiddleware};
use actix_session::storage::RedisSessionStore;
use actix_session::SessionMiddleware;
use actix_web::cookie::{Cookie, Key};
use actix_web::http::{header, Method, StatusCode};
use actix_web::{test, web, App, HttpMessage, HttpRequest, HttpResponse};
use base64::Engine;
use chrono::{Duration, Utc};
use futures_util::stream;
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ConnectionTrait, DatabaseConnection,
    EntityTrait, IntoActiveModel, TransactionTrait,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::repository::{CreateOutcome, NewUpload, Upload, UploadStatus};
use super::{
    finalizer, protocol, repository, runtime_for_test, worker,
    DeviceFileContentRuntime,
};
use crate::devices::config::{
    DEVICE_FILE_CONTENT_FINALIZATION_MAX_WAITING,
    DEVICE_FILE_PREVIEW_GEODATA_CONVERTER_VERSION,
};
use crate::devices::ROLE_CYBER;
use crate::entities::{device, login, organism, system_settings};
use crate::file_registry::entities::{
    device_upload_finalization_attempt, device_upload_finalization_budget,
    device_upload_finalization_job, file_content, file_content_upload,
    file_content_upload_object, file_device_source_state, file_entry,
    file_revision, sea_orm_active_enums::FileEntryKind,
};
use crate::functest::tests::{cleanup_locked, mk_login, mk_organism};
use crate::types::{DeviceUploadFinalizationSettings, Env};

#[path = "archive_access_tests.rs"]
mod archive_access_tests;

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
                roles: Set(json!([ROLE_CYBER])),
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
        self.file_with_metadata(name, "video/mp4", "mp4").await
    }

    async fn file_with_metadata(
        &self,
        name: &str,
        mime_type: &str,
        extension: &str,
    ) -> file_entry::Model {
        let id = Uuid::new_v4();
        let now = Utc::now().naive_utc();
        crate::file_registry::test_support::insert_entry(
            self.db(),
            file_entry::ActiveModel {
                archive_file_id: sea_orm::ActiveValue::NotSet,
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
                mime_type: Set(Some(mime_type.to_owned())),
                extension: Set(Some(extension.to_owned())),
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
                .configure(crate::devices::upload_finalization::config)
                .service(crate::devices::files::content::routes()),
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

#[path = "../archive/access_tests.rs"]
mod archive_http_access_tests;

#[path = "thumbnail_acceptance_tests.rs"]
mod thumbnail_acceptance_tests;

#[path = "reuse/acceptance_tests.rs"]
mod reuse_tests;

#[path = "preview_tests.rs"]
mod preview_tests;

#[path = "local_cache_tests.rs"]
mod local_cache_tests;

#[path = "async_replay_tests.rs"]
mod async_replay_tests;

#[path = "async_recovery_tests.rs"]
mod async_recovery_tests;

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

async fn assert_no_finalization_jobs(fixture: &Fixture) {
    assert!(device_upload_finalization_job::Entity::find()
        .all(fixture.db())
        .await
        .unwrap()
        .is_empty());
}

async fn assert_finalization_source_unpublished(
    fixture: &Fixture,
    upload: &Upload,
    expected_bytes: &[u8],
) {
    assert_eq!(
        fixture.persisted(upload).await.status,
        crate::file_registry::entities::sea_orm_active_enums::FileContentUploadStatus::Open
    );
    assert!(file_content::Entity::find_by_id((
        upload.file_id,
        upload.revision
    ))
    .one(fixture.db())
    .await
    .unwrap()
    .is_none());
    assert_eq!(
        std::fs::read(fixture.spool.path().join(format!("{}.data", upload.id)))
            .unwrap(),
        expected_bytes
    );
}

fn async_file_env(env: &Env, fixture: &Fixture, enabled: bool) -> Arc<Env> {
    let mut env = env.clone();
    env.device_file_content = Some(fixture.runtime.clone());
    env.config.storage_dir = fixture.spool.path().display().to_string();
    env.config.device_upload_finalization =
        Some(DeviceUploadFinalizationSettings {
            enabled,
            file_slots: 1,
            encryption_slots: 1,
            readback_slots: 1,
            ..Default::default()
        });
    Arc::new(env)
}

async fn admit_file_source(fixture: &Fixture, upload: &Upload) -> Uuid {
    use crate::devices::upload_finalization::{
        admission,
        types::{FinalizationCommand, FinalizationTarget},
    };

    let source = fixture.runtime.spool.acquire(upload.id).await.unwrap();
    source.make_durable(upload.upload_length).await.unwrap();
    admission::admit(
        fixture.db(),
        &FinalizationCommand {
            created_by_login_id: fixture.login.id,
            device_id: fixture.device.id,
            source_size_bytes: upload.upload_length as i64,
            source_locator: Some(format!("{}.data", upload.id)),
            target: FinalizationTarget::File {
                upload_id: upload.id,
                file_id: upload.file_id,
                revision: upload.revision,
            },
        },
        &DeviceUploadFinalizationSettings {
            enabled: true,
            ..Default::default()
        },
    )
    .await
    .unwrap()
    .job_id
}

async fn assert_file_job_reserved(
    fixture: &Fixture,
    upload: &Upload,
    job_id: Uuid,
) {
    let job = device_upload_finalization_job::Entity::find_by_id(job_id)
        .one(fixture.db())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(job.kind, "file");
    assert_eq!(job.source_identity, upload.id.to_string());
    assert_eq!(job.created_by_login_id, fixture.login.id);
    assert_eq!(job.device_id, fixture.device.id);
    assert_eq!(job.file_upload_id, Some(upload.id));
    assert_eq!(job.file_id, Some(upload.file_id));
    assert_eq!(job.revision, Some(upload.revision));
    assert_eq!(job.source_size_bytes, upload.upload_length as i64);
    assert_eq!(job.source_release_state, "held");
    assert!(job.source_released_at.is_none());
    assert!(job.quota_released_at.is_none());
    assert_eq!(job.status, "queued");
    assert!(job.result.is_none());
    assert!(job.finished_at.is_none());
    assert!(job.active_attempt_id.is_none());
    for scope in [
        "global:file".to_owned(),
        format!("actor:{}:file", fixture.login.id),
    ] {
        let budget =
            device_upload_finalization_budget::Entity::find_by_id(scope)
                .one(fixture.db())
                .await
                .unwrap()
                .unwrap();
        assert_eq!(budget.reserved_jobs, 1);
        assert_eq!(budget.reserved_source_bytes, upload.upload_length as i64);
        assert_eq!(budget.unresolved_writes, 0);
    }
}

#[actix_web::test]
#[serial_test::serial]
async fn phase4_async_file_acceptance_commits_ownership_without_heavy_slots_or_hashing(
) {
    use crate::devices::upload_finalization::resources::{self, ResourceKind};

    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let file = fixture.file("async-admission").await;
    let upload = fixture.upload(&file, b"expected").await;
    drop(fixture.seed_bytes(&upload, b"tampered").await);
    let before = fixture.persisted(&upload).await;
    let _permits = fixture
        .runtime
        .finalization_permits
        .clone()
        .acquire_many_owned(
            fixture.runtime.config.finalization_max_concurrent as u32,
        )
        .await
        .unwrap();
    let _slots: Vec<_> = [
        ResourceKind::File,
        ResourceKind::Encryption,
        ResourceKind::Readback,
    ]
    .into_iter()
    .map(|kind| {
        resources::try_acquire_file(fixture.spool.path(), kind, 1)
            .unwrap()
            .unwrap()
    })
    .collect();
    let mut accepted_job = None;
    for enabled in [true, false] {
        let env = async_file_env(&env, &fixture, enabled);
        let app = app!(env);
        let cookie: Cookie<'static> = cookie!(app, fixture.login.id);
        let started = Instant::now();
        let response = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            test::call_service(
                &app,
                test::TestRequest::post()
                    .uri(&format!(
                        "{}/complete",
                        super::resource_location(upload.id)
                    ))
                    .cookie(cookie)
                    .insert_header(("tus-resumable", "1.0.0"))
                    .set_json(json!({ "async_finalization": true }))
                    .to_request(),
            ),
        )
        .await
        .expect("async admission waited for a heavy execution slot");
        let elapsed = started.elapsed();
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        eprintln!(
            "UPLOAD_METRIC async_file_admission enabled={enabled} replay={} elapsed_ms={} held_slots=file,encryption,readback legacy_permits_held={} no_hash_admission=true storage_fixture=memory",
            !enabled,
            elapsed.as_millis(),
            fixture.runtime.config.finalization_max_concurrent,
        );
        assert_eq!(response.headers().get("tus-resumable").unwrap(), "1.0.0");
        assert_eq!(response.headers().get(header::RETRY_AFTER).unwrap(), "1");
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "private, no-store"
        );
        let location =
            response.headers().get(header::LOCATION).unwrap().clone();
        let body: Value = test::read_body_json(response).await;
        let job_id = Uuid::parse_str(body["job_id"].as_str().unwrap()).unwrap();
        assert_eq!(body, json!({ "status": "queued", "job_id": job_id }));
        assert_eq!(
            location.to_str().unwrap(),
            format!("/api/device/upload-finalization-jobs/{job_id}")
        );
        if let Some(original) = accepted_job {
            assert_eq!(job_id, original);
        }
        accepted_job = Some(job_id);
        assert_file_job_reserved(&fixture, &upload, job_id).await;
        assert_finalization_source_unpublished(&fixture, &upload, b"tampered")
            .await;
        assert_eq!(
            fixture.persisted(&upload).await.hard_expires_at,
            before.hard_expires_at
        );
        assert!(fixture.runtime.storage.list("").await.unwrap().is_empty());
    }
    assert_eq!(
        device_upload_finalization_job::Entity::find()
            .all(fixture.db())
            .await
            .unwrap()
            .len(),
        1
    );
}

#[actix_web::test]
#[serial_test::serial]
async fn phase4_async_file_acceptance_rejects_incomplete_oversized_and_stale_sources(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let env = async_file_env(&env, &fixture, true);
    let app = app!(env);
    let cookie: Cookie<'static> = cookie!(app, fixture.login.id);
    for (name, bytes, status, code) in [
        ("incomplete", b"part".as_slice(), 409, "upload_incomplete"),
        (
            "oversized",
            b"too many bytes".as_slice(),
            409,
            "upload_incomplete",
        ),
        ("stale", b"complete".as_slice(), 410, "upload_stale"),
    ] {
        let file = fixture.file(name).await;
        let upload = fixture.upload(&file, b"complete").await;
        let path = fixture.spool.path().join(format!("{}.data", upload.id));
        std::fs::write(&path, bytes).unwrap();
        if name == "stale" {
            resync_file(&env, &fixture, &file).await;
        }
        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri(&format!(
                    "{}/complete",
                    super::resource_location(upload.id)
                ))
                .cookie(cookie.clone())
                .insert_header(("tus-resumable", "1.0.0"))
                .set_json(json!({ "async_finalization": true }))
                .to_request(),
        )
        .await;
        assert_eq!(response.status().as_u16(), status, "{name}");
        assert!(!response.headers().contains_key(header::LOCATION));
        assert_eq!(
            test::read_body_json::<Value, _>(response).await["code"],
            code
        );
        assert_no_finalization_jobs(&fixture).await;
        assert_eq!(std::fs::read(path).unwrap(), bytes);
        assert!(file_content::Entity::find_by_id((file.id, 1))
            .one(fixture.db())
            .await
            .unwrap()
            .is_none());
    }
}

#[actix_web::test]
#[serial_test::serial]
async fn phase4_async_file_acceptance_owns_zero_byte_source_without_data_file()
{
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let env = async_file_env(&env, &fixture, true);
    let file = fixture.file("empty-async").await;
    let upload = fixture.upload(&file, b"").await;
    assert!(!fixture
        .spool
        .path()
        .join(format!("{}.data", upload.id))
        .exists());
    let app = app!(env);
    let cookie: Cookie<'static> = cookie!(app, fixture.login.id);
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&format!("{}/complete", super::resource_location(upload.id)))
            .cookie(cookie)
            .insert_header(("tus-resumable", "1.0.0"))
            .set_json(json!({ "async_finalization": true }))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let body: Value = test::read_body_json(response).await;
    let job_id = Uuid::parse_str(body["job_id"].as_str().unwrap()).unwrap();
    assert_file_job_reserved(&fixture, &upload, job_id).await;
    let locked = fixture.runtime.spool.acquire(upload.id).await.unwrap();
    assert_eq!(locked.offset().unwrap(), 0);
}

#[actix_web::test]
#[serial_test::serial]
async fn phase4_async_file_pin_rejects_patch_and_delete_with_admission_disabled(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let file = fixture.file("pinned-source").await;
    let upload = fixture.upload(&file, b"retained").await;
    drop(fixture.seed_bytes(&upload, b"retained").await);
    let job_id = admit_file_source(&fixture, &upload).await;
    let before = fixture.persisted(&upload).await;
    let env = async_file_env(&env, &fixture, false);
    let app = app!(env);
    let cookie: Cookie<'static> = cookie!(app, fixture.login.id);
    for method in [Method::PATCH, Method::DELETE] {
        let response = test::call_service(
            &app,
            test::TestRequest::default()
                .method(method.clone())
                .uri(&super::resource_location(upload.id))
                .cookie(cookie.clone())
                .insert_header(("tus-resumable", "1.0.0"))
                .insert_header(("upload-offset", "8"))
                .insert_header((
                    header::CONTENT_TYPE,
                    "application/offset+octet-stream",
                ))
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::CONFLICT, "{method}");
        assert_eq!(fixture.persisted(&upload).await, before);
        assert_finalization_source_unpublished(&fixture, &upload, b"retained")
            .await;
        assert_file_job_reserved(&fixture, &upload, job_id).await;
    }
}

#[actix_web::test]
#[serial_test::serial]
async fn phase4_async_file_pin_survives_hard_expiry_head_and_cleanup() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let mut fixture = Fixture::new(&env).await;
    let limits = &mut Arc::get_mut(&mut fixture.runtime).unwrap().config;
    limits.upload_idle_ttl_secs = 3;
    limits.upload_max_lifetime_secs = 3;
    let file = fixture.file("pinned-expiry").await;
    let upload = fixture.upload(&file, b"retained").await;
    drop(fixture.seed_bytes(&upload, b"retained").await);
    let job_id = admit_file_source(&fixture, &upload).await;
    let until_expiry = (upload.hard_expires_at - Utc::now().fixed_offset())
        .to_std()
        .expect("fixture expired before admission");
    tokio::time::sleep(until_expiry + std::time::Duration::from_millis(20))
        .await;
    let env = async_file_env(&env, &fixture, false);
    let app = app!(env);
    let cookie: Cookie<'static> = cookie!(app, fixture.login.id);
    let response = test::call_service(
        &app,
        test::TestRequest::default()
            .method(Method::HEAD)
            .uri(&super::resource_location(upload.id))
            .cookie(cookie)
            .insert_header(("tus-resumable", "1.0.0"))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(response.headers().get("upload-offset").unwrap(), "8");
    worker::cleanup_one_for_test(&env, &fixture.runtime, upload.id)
        .await
        .unwrap();
    assert_finalization_source_unpublished(&fixture, &upload, b"retained")
        .await;
    assert_eq!(
        fixture.persisted(&upload).await.hard_expires_at,
        upload.hard_expires_at
    );
    assert_file_job_reserved(&fixture, &upload, job_id).await;
}

#[actix_web::test]
#[serial_test::serial]
async fn phase4_async_file_pin_retains_stale_filesync_source_during_cleanup() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let file = fixture.file("pinned-filesync").await;
    let upload = fixture.upload(&file, b"revision one").await;
    drop(fixture.seed_bytes(&upload, b"revision one").await);
    let job_id = admit_file_source(&fixture, &upload).await;
    let ((), cleanup) = tokio::join!(
        resync_file(&env, &fixture, &file),
        worker::cleanup_one_for_test(&env, &fixture.runtime, upload.id),
    );
    cleanup.unwrap();
    worker::cleanup_one_for_test(&env, &fixture.runtime, upload.id)
        .await
        .unwrap();
    assert_eq!(
        std::fs::read(fixture.spool.path().join(format!("{}.data", upload.id)))
            .unwrap(),
        b"revision one"
    );
    let persisted = fixture.persisted(&upload).await;
    assert_eq!(
        persisted.status,
        crate::file_registry::entities::sea_orm_active_enums::FileContentUploadStatus::Stale
    );
    assert!(persisted.spool_removed_at.is_none());
    assert_eq!(persisted.hard_expires_at, upload.hard_expires_at);
    assert_file_job_reserved(&fixture, &upload, job_id).await;
}

async fn claim_file_job(
    fixture: &Fixture,
    job_id: Uuid,
) -> crate::devices::upload_finalization::types::ClaimedFinalizationJob {
    use crate::devices::upload_finalization::{
        types::FinalizationKind,
        worker::{claim_due, ClaimLane},
    };

    let claim = claim_due(
        fixture.db(),
        FinalizationKind::FinalizationFileKind,
        Uuid::new_v4(),
        ClaimLane::Work,
        60,
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(claim.job_id, job_id);
    claim
}

async fn assert_selected_file_bytes(
    fixture: &Fixture,
    upload: &Upload,
    job_id: Uuid,
    bytes: &[u8],
) {
    let content = file_content::Entity::find_by_id((upload.file_id, 1))
        .one(fixture.db())
        .await
        .unwrap()
        .unwrap();
    let provenance = file_content_upload_object::Entity::find_by_id(upload.id)
        .one(fixture.db())
        .await
        .unwrap()
        .unwrap();
    let attempt = device_upload_finalization_attempt::Entity::find_by_id(
        provenance.attempt_id.unwrap(),
    )
    .one(fixture.db())
    .await
    .unwrap()
    .unwrap();
    let file = file_entry::Entity::find_by_id(upload.file_id)
        .one(fixture.db())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(attempt.job_id, job_id);
    assert_eq!(attempt.phase, "selected");
    assert!(attempt.verified_at.is_some());
    assert!(!attempt.write_credit_held);
    assert_eq!(content.upload_id, Some(upload.id));
    assert_eq!(content.object_key, attempt.object_key);
    assert_eq!(content.object_key, provenance.object_key);
    assert_ne!(content.object_key, upload.object_key);
    assert_eq!(
        file.content_path.as_deref(),
        Some(content.object_key.as_str())
    );
    assert_eq!(content.source_size_bytes, bytes.len() as i64);
    assert_eq!(content.source_sha256, Sha256::digest(bytes).to_vec());
    assert!(content.is_encrypted);
    let downloaded =
        crate::storage::download_and_decrypt_from_s3_with_operator(
            &Some(fixture.runtime.storage.clone()),
            &Some(fixture.runtime.storage_config.clone()),
            &fixture.runtime.strongbox_key,
            &content.object_key,
        )
        .await
        .unwrap();
    assert_eq!(downloaded, bytes);
    finalizer::safe_delete_object(&fixture.runtime, upload).await;
    assert!(fixture
        .runtime
        .storage
        .stat(&content.object_key)
        .await
        .is_ok());
}

#[actix_web::test]
#[serial_test::serial]
async fn phase4_async_file_worker_publishes_exact_receipt_and_empty_content() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let env = async_file_env(&env, &fixture, true);
    let app = app!(env);
    let cookie: Cookie<'static> = cookie!(app, fixture.login.id);
    for (name, bytes) in [
        ("worker-content", b"original async content".as_slice()),
        ("worker-empty", b"".as_slice()),
    ] {
        let file = fixture.file(name).await;
        let upload = fixture.upload(&file, bytes).await;
        if !bytes.is_empty() {
            drop(fixture.seed_bytes(&upload, bytes).await);
        }
        let job_id = admit_file_source(&fixture, &upload).await;
        let claim = claim_file_job(&fixture, job_id).await;
        finalizer::finalize_claim(&env, &fixture.runtime, claim)
            .await
            .unwrap();
        let job = device_upload_finalization_job::Entity::find_by_id(job_id)
            .one(fixture.db())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(job.status, "completed");
        assert!(job.finished_at.is_some());
        assert!(job.winning_attempt_id.is_some());
        assert_eq!(fixture.persisted(&upload).await.status, crate::file_registry::entities::sea_orm_active_enums::FileContentUploadStatus::Completed);
        assert_selected_file_bytes(&fixture, &upload, job_id, bytes).await;
        let receipt = json!({
            "upload_id": upload.id,
            "file_id": file.id,
            "revision": 1,
            "status": "completed",
        });
        resync_file(&env, &fixture, &file).await;
        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri(&format!(
                    "{}/complete",
                    super::resource_location(upload.id)
                ))
                .cookie(cookie.clone())
                .insert_header(("tus-resumable", "1.0.0"))
                .set_json(json!({ "async_finalization": true }))
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = test::read_body_json(response).await;
        assert_eq!(body["job_id"], json!(job_id));
        assert_eq!(body["status"], "completed");
        assert_eq!(body["result"], receipt);
        assert!(body["error"].is_null());
        assert!(body["retry_after_seconds"].is_null());
        let after = device_upload_finalization_job::Entity::find_by_id(job_id)
            .one(fixture.db())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(after.result, job.result);
        assert_eq!(after.winning_attempt_id, job.winning_attempt_id);
        assert_eq!(after.attempt_count, 1);
    }
}

#[actix_web::test]
#[serial_test::serial]
async fn phase4_async_file_worker_rejects_digest_without_publication() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let env = async_file_env(&env, &fixture, true);
    let file = fixture.file("worker-digest").await;
    let upload = fixture.upload(&file, b"good").await;
    drop(fixture.seed_bytes(&upload, b"evil").await);
    let job_id = admit_file_source(&fixture, &upload).await;
    let claim = claim_file_job(&fixture, job_id).await;
    let _ = finalizer::finalize_claim(&env, &fixture.runtime, claim).await;
    let job = device_upload_finalization_job::Entity::find_by_id(job_id)
        .one(fixture.db())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(job.status, "failed");
    assert_eq!(job.error_code.as_deref(), Some("source_digest_mismatch"));
    assert_eq!(job.error_action.as_deref(), Some("new_upload"));
    assert!(job.finished_at.is_some());
    assert!(job.result.is_none());
    assert!(job.winning_attempt_id.is_none());
    assert!(fixture.runtime.storage.list("").await.unwrap().is_empty());
    assert!(file_content::Entity::find_by_id((file.id, 1))
        .one(fixture.db())
        .await
        .unwrap()
        .is_none());
    assert!(file_content_upload_object::Entity::find_by_id(upload.id)
        .one(fixture.db())
        .await
        .unwrap()
        .is_none());
}

#[actix_web::test]
#[serial_test::serial]
async fn phase4_async_file_worker_keeps_source_when_storage_write_is_uncertain()
{
    let (env, _guard) = cleanup_locked().await.unwrap();
    let mut fixture = Fixture::new(&env).await;
    let storage_root = tempfile::tempdir().unwrap();
    let unavailable_root = storage_root.path().join("unavailable");
    std::fs::create_dir(&unavailable_root).unwrap();
    let storage = opendal::Operator::new(
        opendal::services::Fs::default()
            .root(unavailable_root.to_str().unwrap()),
    )
    .unwrap()
    .finish();
    std::fs::remove_dir(&unavailable_root).unwrap();
    std::fs::write(&unavailable_root, b"not a directory").unwrap();
    let runtime = Arc::get_mut(&mut fixture.runtime).unwrap();
    runtime.managed_storage = Arc::new(
        crate::storage::finalization::ManagedStorage::for_test(
            storage.clone(),
            runtime.storage_config.clone(),
            &runtime.strongbox_key,
        )
        .unwrap(),
    );
    runtime.storage = storage;
    let env = async_file_env(&env, &fixture, true);
    let file = fixture.file("worker-unknown").await;
    let upload = fixture.upload(&file, b"retained").await;
    drop(fixture.seed_bytes(&upload, b"retained").await);
    let job_id = admit_file_source(&fixture, &upload).await;
    let claim = claim_file_job(&fixture, job_id).await;
    let _ = finalizer::finalize_claim(&env, &fixture.runtime, claim).await;
    let job = device_upload_finalization_job::Entity::find_by_id(job_id)
        .one(fixture.db())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(job.status, "outcome_unknown");
    assert_eq!(job.error_code.as_deref(), Some("storage_outcome_unknown"));
    assert_eq!(job.error_action.as_deref(), Some("retry_poll"));
    assert!(job.finished_at.is_none());
    assert!(job.result.is_none());
    assert_eq!(job.source_release_state, "held");
    assert!(job.source_released_at.is_none());
    assert!(job.quota_released_at.is_none());
    let attempt = device_upload_finalization_attempt::Entity::find_by_id(
        job.active_attempt_id.unwrap(),
    )
    .one(fixture.db())
    .await
    .unwrap()
    .unwrap();
    assert!(attempt.write_intent_at.is_some());
    assert!(attempt.write_credit_held);
    assert!(attempt.verified_at.is_none());
    worker::cleanup_one_for_test(&env, &fixture.runtime, upload.id)
        .await
        .unwrap();
    assert_finalization_source_unpublished(&fixture, &upload, b"retained")
        .await;
}

async fn seed_corrupt_file_attempt(
    fixture: &Fixture,
    upload: &Upload,
    claim: &crate::devices::upload_finalization::types::ClaimedFinalizationJob,
    acknowledged: bool,
) -> Uuid {
    use crate::devices::upload_finalization::{
        query, recovery,
        types::{FinalizationFailure, WriteResolution},
    };

    let attempt_id = query::create_attempt(fixture.db(), claim, true)
        .await
        .unwrap();
    assert!(query::prepare_attempt(
        fixture.db(),
        claim,
        attempt_id,
        upload.upload_length as i64,
        &upload.expected_sha256,
        None,
    )
    .await
    .unwrap());
    assert!(
        query::record_write_intent(fixture.db(), claim, attempt_id, 4)
            .await
            .unwrap()
    );
    let attempt =
        device_upload_finalization_attempt::Entity::find_by_id(attempt_id)
            .one(fixture.db())
            .await
            .unwrap()
            .unwrap();
    crate::storage::upload_encrypted_to_s3_with_operator(
        &Some(fixture.runtime.storage.clone()),
        &fixture.runtime.storage_config,
        &fixture.runtime.strongbox_key,
        &attempt.object_key,
        web::Bytes::from_static(b"corrupt content"),
    )
    .await
    .unwrap();
    if acknowledged {
        assert!(query::record_write_resolution(
            fixture.db(),
            claim,
            attempt_id,
            WriteResolution::Acknowledged,
        )
        .await
        .unwrap());
        assert!(query::release_write_credit(fixture.db(), attempt_id)
            .await
            .unwrap());
    }
    assert!(recovery::schedule_retry(
        fixture.db(),
        claim,
        &FinalizationFailure::StorageOutcomeUnknown,
        true,
        1,
    )
    .await
    .unwrap());
    sqlx::query("update device_upload_finalization_job set next_run_at=clock_timestamp()-interval '1 second' where id=$1")
        .bind(claim.job_id)
        .execute(fixture.db().get_postgres_connection_pool())
        .await
        .unwrap();
    attempt_id
}

#[actix_web::test]
#[serial_test::serial]
async fn phase4_async_file_worker_reconciles_full_remote_digest_before_publication(
) {
    use crate::devices::upload_finalization::{
        types::FinalizationKind,
        worker::{claim_due, ClaimLane},
    };

    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let env = async_file_env(&env, &fixture, true);
    for acknowledged in [true, false] {
        let file = fixture.file("remote-corruption").await;
        let upload = fixture.upload(&file, b"correct content").await;
        drop(fixture.seed_bytes(&upload, b"correct content").await);
        let job_id = admit_file_source(&fixture, &upload).await;
        let claim = claim_file_job(&fixture, job_id).await;
        let attempt_id =
            seed_corrupt_file_attempt(&fixture, &upload, &claim, acknowledged)
                .await;
        let claim = claim_due(
            fixture.db(),
            FinalizationKind::FinalizationFileKind,
            Uuid::new_v4(),
            ClaimLane::Reconcile,
            60,
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(claim.job_id, job_id);
        let _ = finalizer::finalize_claim(&env, &fixture.runtime, claim).await;
        let job = device_upload_finalization_job::Entity::find_by_id(job_id)
            .one(fixture.db())
            .await
            .unwrap()
            .unwrap();
        assert!(job.result.is_none());
        assert!(job.winning_attempt_id.is_none());
        assert!(file_content::Entity::find_by_id((file.id, 1))
            .one(fixture.db())
            .await
            .unwrap()
            .is_none());
        assert!(file_content_upload_object::Entity::find_by_id(upload.id)
            .one(fixture.db())
            .await
            .unwrap()
            .is_none());
        let attempt =
            device_upload_finalization_attempt::Entity::find_by_id(attempt_id)
                .one(fixture.db())
                .await
                .unwrap()
                .unwrap();
        assert!(attempt.verified_at.is_none());
        assert_ne!(attempt.phase, "selected");
        assert_eq!(attempt.write_credit_held, !acknowledged);
        assert_eq!(job.status, "outcome_unknown");
        assert_eq!(job.error_action.as_deref(), Some("retry_poll"));
        assert!(job.finished_at.is_none());
        assert!(job.lease_owner.is_none());
        assert!(job.lease_until.is_none());
        assert_eq!(job.source_release_state, "held");
        assert_eq!(job.active_attempt_id, Some(attempt_id));
        worker::cleanup_one_for_test(&env, &fixture.runtime, upload.id)
            .await
            .unwrap();
        assert_finalization_source_unpublished(
            &fixture,
            &upload,
            b"correct content",
        )
        .await;
        sqlx::query("update device_upload_finalization_job set next_run_at=clock_timestamp()+interval '1 day' where id=$1")
            .bind(job_id)
            .execute(fixture.db().get_postgres_connection_pool())
            .await
            .unwrap();
    }
}

async fn persisted_file_job(
    fixture: &Fixture,
    job_id: Uuid,
) -> device_upload_finalization_job::Model {
    device_upload_finalization_job::Entity::find_by_id(job_id)
        .one(fixture.db())
        .await
        .unwrap()
        .unwrap()
}

async fn assert_file_budget(fixture: &Fixture, jobs: i64, bytes: i64) {
    for scope in [
        "global:file".to_owned(),
        format!("actor:{}:file", fixture.login.id),
    ] {
        let budget =
            device_upload_finalization_budget::Entity::find_by_id(scope)
                .one(fixture.db())
                .await
                .unwrap()
                .unwrap();
        assert_eq!(budget.reserved_jobs, jobs);
        assert_eq!(budget.reserved_source_bytes, bytes);
    }
}

#[actix_web::test]
#[serial_test::serial]
async fn phase4_async_file_cleanup_retries_source_removal_before_releasing_quota(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let env = async_file_env(&env, &fixture, true);
    let file = fixture.file("cleanup-retry").await;
    let upload = fixture.upload(&file, b"retained").await;
    drop(fixture.seed_bytes(&upload, b"retained").await);
    let job_id = admit_file_source(&fixture, &upload).await;
    let claim = claim_file_job(&fixture, job_id).await;
    finalizer::finalize_claim(&env, &fixture.runtime, claim)
        .await
        .unwrap();
    let completed = persisted_file_job(&fixture, job_id).await;
    assert_eq!(completed.status, "completed");
    assert_eq!(completed.source_release_state, "release_pending");
    assert_file_budget(&fixture, 1, 8).await;
    let data = fixture.spool.path().join(format!("{}.data", upload.id));
    let retained = fixture.spool.path().join(format!("{}.retained", upload.id));
    std::fs::rename(&data, &retained).unwrap();
    std::fs::create_dir(&data).unwrap();
    assert!(worker::cleanup_finalization_for_test(
        &env,
        &fixture.runtime,
        job_id
    )
    .await
    .is_err());
    let after_failure = persisted_file_job(&fixture, job_id).await;
    assert_eq!(after_failure.result, completed.result);
    assert_eq!(after_failure.source_release_state, "release_pending");
    assert!(after_failure.source_released_at.is_none());
    assert!(after_failure.quota_released_at.is_none());
    assert!(fixture.persisted(&upload).await.spool_removed_at.is_none());
    assert_file_budget(&fixture, 1, 8).await;
    assert_eq!(std::fs::read(&retained).unwrap(), b"retained");
    std::fs::remove_dir(&data).unwrap();
    std::fs::rename(&retained, &data).unwrap();
    for _ in 0..2 {
        worker::cleanup_finalization_for_test(&env, &fixture.runtime, job_id)
            .await
            .unwrap();
        assert!(!data.exists());
        let released = persisted_file_job(&fixture, job_id).await;
        assert_eq!(released.status, "completed");
        assert_eq!(released.result, completed.result);
        assert_eq!(released.winning_attempt_id, completed.winning_attempt_id);
        assert_eq!(released.source_release_state, "released");
        assert!(released.source_released_at.is_some());
        assert!(released.quota_released_at.is_some());
        assert!(fixture.persisted(&upload).await.spool_removed_at.is_some());
        assert_file_budget(&fixture, 0, 0).await;
    }
    assert_selected_file_bytes(&fixture, &upload, job_id, b"retained").await;
}

#[actix_web::test]
#[serial_test::serial]
async fn phase4_async_file_cleanup_keeps_selected_object_and_late_write_tombstone(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let env = async_file_env(&env, &fixture, true);
    let file = fixture.file("cleanup-object").await;
    let upload = fixture.upload(&file, b"selected").await;
    drop(fixture.seed_bytes(&upload, b"selected").await);
    let job_id = admit_file_source(&fixture, &upload).await;
    let claim = claim_file_job(&fixture, job_id).await;
    finalizer::finalize_claim(&env, &fixture.runtime, claim)
        .await
        .unwrap();
    let completed = persisted_file_job(&fixture, job_id).await;
    let canonical = device_upload_finalization_attempt::Entity::find()
        .all(fixture.db())
        .await
        .unwrap()
        .into_iter()
        .find(|attempt| {
            attempt.job_id == job_id && attempt.origin == "legacy_cleanup"
        })
        .unwrap();
    assert_eq!(canonical.phase, "retired");
    assert_eq!(canonical.object_key, upload.object_key);
    for _ in 0..2 {
        fixture
            .runtime
            .storage
            .write(&canonical.object_key, b"late write".to_vec())
            .await
            .unwrap();
        assert!(fixture
            .runtime
            .managed_storage
            .cleanup_retired(
                fixture.db(),
                canonical.id,
                std::time::Duration::from_secs(5)
            )
            .await
            .unwrap());
        assert_eq!(
            fixture
                .runtime
                .storage
                .stat(&canonical.object_key)
                .await
                .unwrap_err()
                .kind(),
            opendal::ErrorKind::NotFound
        );
        let retired = device_upload_finalization_attempt::Entity::find_by_id(
            canonical.id,
        )
        .one(fixture.db())
        .await
        .unwrap()
        .unwrap();
        assert!(retired.late_write_possible);
        assert!(retired.cleanup_confirmed_at.is_some());
        assert!(retired.cleanup_next_at.is_some());
    }
    assert!(!fixture
        .runtime
        .managed_storage
        .cleanup_retired(
            fixture.db(),
            completed.winning_attempt_id.unwrap(),
            std::time::Duration::from_secs(5)
        )
        .await
        .unwrap());
    assert_selected_file_bytes(&fixture, &upload, job_id, b"selected").await;
}

#[actix_web::test]
#[serial_test::serial]
async fn phase4_async_file_failed_cleanup_preserves_terminal_replay_and_sync_gone(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let env = async_file_env(&env, &fixture, true);
    let file = fixture.file("failed-cleanup").await;
    let upload = fixture.upload(&file, b"good").await;
    drop(fixture.seed_bytes(&upload, b"evil").await);
    let job_id = admit_file_source(&fixture, &upload).await;
    let claim = claim_file_job(&fixture, job_id).await;
    finalizer::finalize_claim(&env, &fixture.runtime, claim)
        .await
        .unwrap();
    assert_eq!(persisted_file_job(&fixture, job_id).await.status, "failed");
    assert_file_budget(&fixture, 1, 4).await;
    worker::cleanup_finalization_for_test(&env, &fixture.runtime, job_id)
        .await
        .unwrap();
    assert_file_budget(&fixture, 0, 0).await;
    assert!(!fixture
        .spool
        .path()
        .join(format!("{}.data", upload.id))
        .exists());
    let app = app!(env);
    let cookie: Cookie<'static> = cookie!(app, fixture.login.id);
    for asynchronous in [false, true] {
        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri(&format!(
                    "{}/complete",
                    super::resource_location(upload.id)
                ))
                .cookie(cookie.clone())
                .insert_header(("tus-resumable", "1.0.0"))
                .set_json(json!({"async_finalization": asynchronous}))
                .to_request(),
        )
        .await;
        assert_eq!(
            response.status(),
            if asynchronous {
                StatusCode::OK
            } else {
                StatusCode::GONE
            }
        );
        let body: Value = test::read_body_json(response).await;
        if asynchronous {
            assert_eq!(body["job_id"], json!(job_id));
            assert_eq!(body["status"], "failed");
            assert_eq!(body["error"]["code"], "source_digest_mismatch");
        } else {
            assert_eq!(body, json!({"code": "upload_rejected"}));
        }
    }
    assert_eq!(persisted_file_job(&fixture, job_id).await.attempt_count, 1);
}

#[actix_web::test]
#[serial_test::serial]
async fn phase4_async_file_http_acceptance_runs_to_completion_without_polling()
{
    use tokio_util::sync::CancellationToken;

    let (env, _guard) = cleanup_locked().await.unwrap();
    let mut fixture = Fixture::new(&env).await;
    Arc::get_mut(&mut fixture.runtime)
        .unwrap()
        .config
        .cleanup_poll_interval_secs = 1;
    let mut env = async_file_env(&env, &fixture, true);
    Arc::get_mut(&mut env)
        .unwrap()
        .config
        .device_upload_finalization
        .as_mut()
        .unwrap()
        .poll_seconds = 1;
    let file = fixture.file("autonomous-http").await;
    let upload = fixture.upload(&file, b"autonomous").await;
    drop(fixture.seed_bytes(&upload, b"autonomous").await);
    let app = app!(env);
    let cookie: Cookie<'static> = cookie!(app, fixture.login.id);
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&format!("{}/complete", super::resource_location(upload.id)))
            .cookie(cookie.clone())
            .insert_header(("tus-resumable", "1.0.0"))
            .set_json(json!({"async_finalization": true}))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let location = response
        .headers()
        .get(header::LOCATION)
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    let body: Value = test::read_body_json(response).await;
    let job_id = Uuid::parse_str(body["job_id"].as_str().unwrap()).unwrap();
    let cancellation = CancellationToken::new();
    let _cancel_on_drop = cancellation.clone().drop_guard();
    let background =
        tokio::spawn(crate::devices::upload_finalization::worker::run_files(
            env.clone(),
            fixture.runtime.clone(),
            cancellation.clone(),
        ));
    let completed = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        async {
            loop {
                let job = persisted_file_job(&fixture, job_id).await;
                assert_ne!(job.status, "failed", "{:?}", job.error_code);
                if job.status == "completed" && job.quota_released_at.is_some()
                {
                    break job;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        },
    )
    .await
    .expect(
        "registered worker did not publish and clean the HTTP-accepted source",
    );
    cancellation.cancel();
    tokio::time::timeout(std::time::Duration::from_secs(5), background)
        .await
        .unwrap()
        .unwrap();
    let response = test::call_service(
        &app,
        test::TestRequest::get()
            .uri(&location)
            .cookie(cookie)
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get(header::CACHE_CONTROL).unwrap(),
        "private, no-store"
    );
    let body: Value = test::read_body_json(response).await;
    assert_eq!(body["status"], "completed");
    assert_eq!(
        body["result"],
        json!({"upload_id": upload.id, "file_id": file.id, "revision": 1, "status": "completed"})
    );
    assert_eq!(completed.attempt_count, 1);
    assert!(!fixture
        .spool
        .path()
        .join(format!("{}.data", upload.id))
        .exists());
    assert_file_budget(&fixture, 0, 0).await;
    assert_selected_file_bytes(&fixture, &upload, job_id, b"autonomous").await;
}

#[actix_web::test]
#[serial_test::serial]
async fn phase4_async_file_failure_retires_inherited_canonical_object() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let env = async_file_env(&env, &fixture, true);
    let file = fixture.file("legacy-canonical-failure").await;
    let upload = fixture.upload(&file, b"good").await;
    drop(fixture.seed_bytes(&upload, b"evil").await);
    fixture
        .runtime
        .storage
        .write(&upload.object_key, b"interrupted legacy write".to_vec())
        .await
        .unwrap();
    let job_id = admit_file_source(&fixture, &upload).await;
    let claim = claim_file_job(&fixture, job_id).await;
    finalizer::finalize_claim(&env, &fixture.runtime, claim)
        .await
        .unwrap();
    let failed = persisted_file_job(&fixture, job_id).await;
    assert_eq!(failed.status, "failed");
    assert_eq!(failed.error_code.as_deref(), Some("source_digest_mismatch"));
    assert!(failed.winning_attempt_id.is_none());
    let canonical = device_upload_finalization_attempt::Entity::find()
        .all(fixture.db()).await.unwrap().into_iter()
        .find(|attempt| attempt.job_id == job_id && attempt.origin == "legacy_cleanup")
        .expect("failed async job left inherited canonical object without durable cleanup ownership");
    assert_eq!(canonical.object_key, upload.object_key);
    assert_eq!(canonical.phase, "retired");
    assert!(canonical.late_write_possible);
    assert!(fixture
        .runtime
        .managed_storage
        .cleanup_retired(
            fixture.db(),
            canonical.id,
            std::time::Duration::from_secs(5)
        )
        .await
        .unwrap());
    assert_eq!(
        fixture
            .runtime
            .storage
            .stat(&upload.object_key)
            .await
            .unwrap_err()
            .kind(),
        opendal::ErrorKind::NotFound
    );
    assert!(file_content_upload_object::Entity::find_by_id(upload.id)
        .one(fixture.db())
        .await
        .unwrap()
        .is_none());
}

#[actix_web::test]
#[serial_test::serial]
async fn phase4_async_file_missing_source_keeps_ownership_until_access_recovers(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let env = async_file_env(&env, &fixture, true);
    let file = fixture.file("temporarily-missing-source").await;
    let upload = fixture.upload(&file, b"retained").await;
    drop(fixture.seed_bytes(&upload, b"retained").await);
    let job_id = admit_file_source(&fixture, &upload).await;
    let data = fixture.spool.path().join(format!("{}.data", upload.id));
    let hidden = fixture
        .spool
        .path()
        .join(format!("{}.unavailable", upload.id));
    std::fs::rename(&data, &hidden).unwrap();
    let claim = claim_file_job(&fixture, job_id).await;
    finalizer::finalize_claim(&env, &fixture.runtime, claim)
        .await
        .unwrap();
    let deferred = persisted_file_job(&fixture, job_id).await;
    assert_eq!(deferred.status, "retry_wait");
    assert_eq!(deferred.error_action.as_deref(), Some("retry_poll"));
    assert!(deferred.finished_at.is_none());
    assert_eq!(deferred.source_release_state, "held");
    assert!(deferred.quota_released_at.is_none());
    worker::cleanup_finalization_for_test(&env, &fixture.runtime, job_id)
        .await
        .unwrap();
    assert_file_budget(&fixture, 1, 8).await;
    assert_eq!(std::fs::read(&hidden).unwrap(), b"retained");
    assert_eq!(fixture.persisted(&upload).await.status, crate::file_registry::entities::sea_orm_active_enums::FileContentUploadStatus::Open);
    std::fs::rename(&hidden, &data).unwrap();
    sqlx::query("update device_upload_finalization_job set next_run_at=clock_timestamp()-interval '1 second' where id=$1")
        .bind(job_id).execute(fixture.db().get_postgres_connection_pool()).await.unwrap();
    let claim = claim_file_job(&fixture, job_id).await;
    finalizer::finalize_claim(&env, &fixture.runtime, claim)
        .await
        .unwrap();
    assert_eq!(
        persisted_file_job(&fixture, job_id).await.status,
        "completed"
    );
    assert_selected_file_bytes(&fixture, &upload, job_id, b"retained").await;
}

#[actix_web::test]
#[serial_test::serial]
async fn phase4_async_file_foreign_actor_cannot_probe_source_or_admission_state(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let other = mk_login(
        &env.dbx,
        login::ActiveModel {
            login: Set(format!("upload-other-{}", Uuid::new_v4())),
            roles: Set(json!([ROLE_CYBER])),
            organism_id: Set(fixture.login.organism_id),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    crate::devices::access::authorize_file_sync_snapshot(
        &env.dbx,
        &other.id,
        fixture.device.id,
    )
    .await
    .unwrap();
    for (enabled, name) in [
        (true, "incomplete"),
        (false, "disabled"),
        (true, "rejected"),
    ] {
        let file = fixture.file(name).await;
        let upload = fixture.upload(&file, b"retained").await;
        drop(
            fixture
                .seed_bytes(
                    &upload,
                    if name == "incomplete" {
                        b"part"
                    } else {
                        b"retained"
                    },
                )
                .await,
        );
        if name == "rejected" {
            repository::transition_open(
                fixture.db(),
                &upload,
                UploadStatus::Rejected,
                Utc::now().fixed_offset(),
                None,
            )
            .await
            .unwrap();
        }
        let before = fixture.persisted(&upload).await;
        let env = async_file_env(&env, &fixture, enabled);
        let app = app!(env);
        let cookie: Cookie<'static> = cookie!(app, other.id);
        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri(&format!(
                    "{}/complete",
                    super::resource_location(upload.id)
                ))
                .cookie(cookie)
                .insert_header(("tus-resumable", "1.0.0"))
                .set_json(json!({"async_finalization": true}))
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{name}");
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "private, no-store"
        );
        assert_eq!(
            test::read_body_json::<Value, _>(response).await,
            json!({"code": "not_found"})
        );
        assert_eq!(fixture.persisted(&upload).await, before);
        assert_no_finalization_jobs(&fixture).await;
    }
}

async fn block_s3_delete(
    listener: tokio::net::TcpListener,
    entered: tokio::sync::oneshot::Sender<String>,
    release: tokio::sync::oneshot::Receiver<()>,
) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let (mut connection, _) = listener.accept().await.unwrap();
    let mut request = Vec::new();
    let mut buffer = [0; 1024];
    loop {
        let read = connection.read(&mut buffer).await.unwrap();
        assert!(read > 0, "S3 request ended before headers");
        request.extend_from_slice(&buffer[..read]);
        assert!(
            request.len() <= 64 * 1024,
            "S3 request headers exceeded limit"
        );
        if request.windows(4).any(|part| part == b"\r\n\r\n") {
            break;
        }
    }
    let request = String::from_utf8(request).unwrap();
    entered
        .send(request.lines().next().unwrap().to_owned())
        .unwrap();
    let _ = release.await;
    let _ = connection.write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
}

async fn failed_file_job(
    env: &Env,
    fixture: &Fixture,
    name: &str,
) -> (Upload, Uuid) {
    let file = fixture.file(name).await;
    let upload = fixture.upload(&file, b"good").await;
    drop(fixture.seed_bytes(&upload, b"evil").await);
    let job = admit_file_source(fixture, &upload).await;
    let claim = claim_file_job(fixture, job).await;
    finalizer::finalize_claim(env, &fixture.runtime, claim)
        .await
        .unwrap();
    assert_eq!(persisted_file_job(fixture, job).await.status, "failed");
    (upload, job)
}

#[actix_web::test]
#[serial_test::serial]
async fn phase4_async_file_source_cleanup_progresses_while_remote_delete_blocks(
) {
    use tokio_util::sync::CancellationToken;

    let (env, _guard) = cleanup_locked().await.unwrap();
    let mut fixture = Fixture::new(&env).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let remote =
        tokio::spawn(block_s3_delete(listener, entered_tx, release_rx));
    let runtime = Arc::get_mut(&mut fixture.runtime).unwrap();
    runtime.config.cleanup_poll_interval_secs = 1;
    runtime.managed_storage = Arc::new(
        crate::storage::finalization::ManagedStorage::new(
            crate::storage::S3Config {
                endpoint,
                region: "us-east-1".to_owned(),
                access_key_id: "fixture-access".to_owned(),
                secret_access_key: "fixture-secret".to_owned(),
                ..runtime.storage_config.clone()
            },
            &runtime.strongbox_key,
        )
        .unwrap(),
    );
    let mut env = async_file_env(&env, &fixture, true);
    Arc::get_mut(&mut env)
        .unwrap()
        .config
        .device_upload_finalization
        .as_mut()
        .unwrap()
        .file_phase_seconds = 60;
    let (first, first_job) =
        failed_file_job(&env, &fixture, "blocked-delete").await;
    let cancellation = CancellationToken::new();
    let _cancel_on_drop = cancellation.clone().drop_guard();
    let cleanup = tokio::spawn(worker::run_finalization_cleanup_nofail(
        env.clone(),
        fixture.runtime.clone(),
        cancellation.clone(),
    ));
    let request =
        tokio::time::timeout(std::time::Duration::from_secs(10), entered_rx)
            .await
            .expect("retired canonical cleanup never reached S3")
            .unwrap();
    assert!(
        request.starts_with("DELETE "),
        "unexpected S3 request: {request}"
    );
    assert!(
        request.contains(&first.id.to_string()),
        "wrong cleanup key: {request}"
    );
    let (second, second_job) =
        failed_file_job(&env, &fixture, "independent-source").await;
    let removed =
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let first = persisted_file_job(&fixture, first_job).await;
                let second = persisted_file_job(&fixture, second_job).await;
                if first.quota_released_at.is_some()
                    && second.quota_released_at.is_some()
                {
                    break second;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await;
    cancellation.cancel();
    let stopped =
        tokio::time::timeout(std::time::Duration::from_secs(5), cleanup).await;
    release_tx.send(()).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), remote)
        .await
        .unwrap()
        .unwrap();
    stopped
        .expect("cleanup did not cancel its blocked DELETE")
        .unwrap();
    let removed = removed.expect(
        "remote DELETE blocked independent source removal and quota release",
    );
    assert_eq!(removed.source_release_state, "released");
    assert!(removed.source_released_at.is_some());
    assert!(!fixture
        .spool
        .path()
        .join(format!("{}.data", second.id))
        .exists());
    assert!(fixture.persisted(&second).await.spool_removed_at.is_some());
    assert_file_budget(&fixture, 0, 0).await;
    let attempts = device_upload_finalization_attempt::Entity::find()
        .all(fixture.db())
        .await
        .unwrap();
    let pending = attempts
        .iter()
        .find(|attempt| {
            attempt.job_id == first_job && attempt.origin == "legacy_cleanup"
        })
        .unwrap();
    assert!(pending.cleanup_confirmed_at.is_none());
    assert!(pending.cleanup_next_at.is_some());
}

#[actix_web::test]
#[serial_test::serial]
async fn phase4_async_file_cleanup_rejects_replaced_spool_root_until_restored()
{
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let env = async_file_env(&env, &fixture, true);
    for failed in [false, true] {
        let file = fixture
            .file(if failed {
                "failed-root"
            } else {
                "completed-root"
            })
            .await;
        let upload = fixture.upload(&file, b"good").await;
        let bytes = if failed { b"evil" } else { b"good" };
        drop(fixture.seed_bytes(&upload, bytes).await);
        let job = admit_file_source(&fixture, &upload).await;
        let claim = claim_file_job(&fixture, job).await;
        finalizer::finalize_claim(&env, &fixture.runtime, claim)
            .await
            .unwrap();
        let terminal = persisted_file_job(&fixture, job).await;
        assert_eq!(
            terminal.status,
            if failed { "failed" } else { "completed" }
        );
        assert_eq!(terminal.source_release_state, "release_pending");
        let retained = tempfile::tempdir().unwrap();
        let original = retained.path().join("original-spool");
        std::fs::rename(fixture.spool.path(), &original).unwrap();
        std::fs::create_dir(fixture.spool.path()).unwrap();
        drop(fixture.runtime.spool.acquire(upload.id).await.unwrap());
        for _ in 0..2 {
            let _ = worker::cleanup_finalization_for_test(
                &env,
                &fixture.runtime,
                job,
            )
            .await;
            let deferred = persisted_file_job(&fixture, job).await;
            assert_eq!(deferred.source_release_state, "release_pending");
            assert!(deferred.source_released_at.is_none());
            assert!(deferred.quota_released_at.is_none());
            assert_eq!(deferred.result, terminal.result);
            assert!(fixture
                .persisted(&upload)
                .await
                .spool_removed_at
                .is_none());
            assert_file_budget(&fixture, 1, 4).await;
            assert_eq!(
                std::fs::read(original.join(format!("{}.data", upload.id)))
                    .unwrap(),
                bytes
            );
        }
        std::fs::remove_dir_all(fixture.spool.path()).unwrap();
        std::fs::rename(&original, fixture.spool.path()).unwrap();
        for _ in 0..2 {
            worker::cleanup_finalization_for_test(&env, &fixture.runtime, job)
                .await
                .unwrap();
            let released = persisted_file_job(&fixture, job).await;
            assert_eq!(released.status, terminal.status);
            assert_eq!(released.result, terminal.result);
            assert_eq!(released.source_release_state, "released");
            assert!(released.source_released_at.is_some());
            assert!(released.quota_released_at.is_some());
            assert!(!fixture
                .spool
                .path()
                .join(format!("{}.data", upload.id))
                .exists());
            assert_file_budget(&fixture, 0, 0).await;
        }
    }
}

#[actix_web::test]
async fn phase4_async_file_locked_cleanup_keeps_original_directory_identity() {
    let directory = tempfile::tempdir().unwrap();
    let active = directory.path().join("active");
    let original = directory.path().join("original");
    let spool = super::Spool::for_test(active.clone()).await.unwrap();
    let upload_id = Uuid::new_v4();
    let source = spool.acquire(upload_id).await.unwrap();
    source
        .append(
            stream::iter([Ok(bytes::Bytes::from_static(b"owned source"))]),
            0,
            12,
        )
        .await
        .unwrap();
    source.make_durable(12).await.unwrap();
    std::fs::rename(&active, &original).unwrap();
    std::fs::create_dir(&active).unwrap();
    let replacement_data = active.join(format!("{upload_id}.data"));
    let replacement_lock = active.join(format!("{upload_id}.lock"));
    std::fs::write(&replacement_data, b"unrelated replacement source").unwrap();
    std::fs::write(&replacement_lock, b"unrelated replacement lock").unwrap();
    source.remove_durable_source().await.unwrap();
    assert!(
        !original.join(format!("{upload_id}.data")).exists(),
        "cleanup reported durable removal while leaving the accepted bytes behind"
    );
    assert_eq!(
        std::fs::read(&replacement_data).unwrap(),
        b"unrelated replacement source"
    );
    assert_eq!(
        std::fs::read(&replacement_lock).unwrap(),
        b"unrelated replacement lock"
    );
    assert!(original.join(format!("{upload_id}.lock")).exists());
    assert!(source.open_source().unwrap().is_none());
}

#[actix_web::test]
#[serial_test::serial]
async fn finalization_contract_sync_defaults_preserve_original_receipt() {
    let (mut env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    Arc::get_mut(&mut env).unwrap().device_file_content =
        Some(fixture.runtime.clone());
    let app = app!(env);
    let cookie: Cookie<'static> = cookie!(app, fixture.login.id);
    let cases = [
        ("empty", String::new(), ""),
        ("object", "{}".to_owned(), ""),
        ("false", r#"{"async_finalization":false}"#.to_owned(), ""),
        ("limit", format!("{}{{}}", " ".repeat(1022)), ""),
        ("query-only", String::new(), "?async_finalization=true"),
    ];
    for (name, payload, query) in cases {
        let file = fixture.file(name).await;
        let upload = fixture.upload(&file, b"original content").await;
        drop(fixture.seed_bytes(&upload, b"original content").await);
        let receipt = json!({
            "upload_id": upload.id,
            "file_id": file.id,
            "revision": 1,
            "status": "completed",
        });
        for replay in [false, true] {
            let mut request = test::TestRequest::post()
                .uri(&format!(
                    "{}/complete{query}",
                    super::resource_location(upload.id)
                ))
                .cookie(cookie.clone())
                .insert_header(("tus-resumable", "1.0.0"))
                .set_payload(payload.clone());
            if !payload.is_empty() {
                request = request
                    .insert_header((header::CONTENT_TYPE, "application/json"));
            }
            let response = test::call_service(&app, request.to_request()).await;
            assert_eq!(response.status(), StatusCode::OK, "{name}: {replay}");
            assert_eq!(
                response.headers().get("tus-resumable").unwrap(),
                "1.0.0"
            );
            assert!(!response.headers().contains_key(header::LOCATION));
            assert_eq!(
                test::read_body_json::<Value, _>(response).await,
                receipt
            );
            assert!(file_content::Entity::find_by_id((file.id, 1))
                .one(fixture.db())
                .await
                .unwrap()
                .is_some());
            assert_no_finalization_jobs(&fixture).await;
            if !replay {
                resync_file(&env, &fixture, &file).await;
            }
        }
    }
}

#[actix_web::test]
#[serial_test::serial]
async fn finalization_contract_true_unavailable_preserves_source() {
    let (mut env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    Arc::get_mut(&mut env).unwrap().device_file_content =
        Some(fixture.runtime.clone());
    let app = app!(env);
    let cookie: Cookie<'static> = cookie!(app, fixture.login.id);
    let file = fixture.file("async-unavailable").await;
    let upload = fixture.upload(&file, b"retained source").await;
    drop(fixture.seed_bytes(&upload, b"retained source").await);
    let before = fixture.persisted(&upload).await;
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&format!("{}/complete", super::resource_location(upload.id)))
            .cookie(cookie)
            .insert_header(("tus-resumable", "1.0.0"))
            .insert_header((header::CONTENT_TYPE, "application/json"))
            .set_payload(r#"{"async_finalization":true}"#)
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(response.headers().get("tus-resumable").unwrap(), "1.0.0");
    assert!(
        response
            .headers()
            .get(header::RETRY_AFTER)
            .unwrap()
            .to_str()
            .unwrap()
            .parse::<u64>()
            .unwrap()
            > 0
    );
    assert_eq!(
        response.headers().get(header::CACHE_CONTROL).unwrap(),
        "private, no-store"
    );
    assert!(!response.headers().contains_key(header::LOCATION));
    let body: Value = test::read_body_json(response).await;
    assert!(body["code"].as_str().is_some_and(|code| !code.is_empty()));
    assert!(body.get("job_id").is_none());
    assert!(body.get("status").is_none());
    assert_eq!(fixture.persisted(&upload).await, before);
    assert_finalization_source_unpublished(
        &fixture,
        &upload,
        b"retained source",
    )
    .await;
    assert_no_finalization_jobs(&fixture).await;
}

#[actix_web::test]
#[serial_test::serial]
async fn finalization_contract_rejects_invalid_json_without_acceptance() {
    let (mut env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    Arc::get_mut(&mut env).unwrap().device_file_content =
        Some(fixture.runtime.clone());
    let app = app!(env);
    let cookie: Cookie<'static> = cookie!(app, fixture.login.id);
    let file = fixture.file("strict-complete-json").await;
    let upload = fixture.upload(&file, b"unpublished").await;
    drop(fixture.seed_bytes(&upload, b"unpublished").await);
    let before = fixture.persisted(&upload).await;
    for payload in [
        r#"{"async_finalization":null}"#,
        r#"{"async_finalization":"true"}"#,
        r#"{"async_finalization":1}"#,
        r#"{"async_finalization":0}"#,
        r#"{"async_finalization":[]}"#,
        r#"{"async_finalization":{}}"#,
        r#"{"async_finalization":true,"unknown":false}"#,
        r#"{"unknown":false}"#,
        r#"{"async_finalization":true,"async_finalization":false}"#,
        r#"{"async_finalization":true"#,
        r#"{"async_finalization":false}{}"#,
        "null",
        "true",
        "[]",
        " ",
    ] {
        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri(&format!(
                    "{}/complete",
                    super::resource_location(upload.id)
                ))
                .cookie(cookie.clone())
                .insert_header(("tus-resumable", "1.0.0"))
                .insert_header((header::CONTENT_TYPE, "application/json"))
                .set_payload(payload)
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{payload}");
        assert_eq!(response.headers().get("tus-resumable").unwrap(), "1.0.0");
        let body: Value = test::read_body_json(response).await;
        assert!(body["code"].is_string(), "{payload}: {body}");
        assert!(body.get("job_id").is_none(), "{payload}: {body}");
        assert_eq!(fixture.persisted(&upload).await, before, "{payload}");
        assert_finalization_source_unpublished(
            &fixture,
            &upload,
            b"unpublished",
        )
        .await;
        assert_no_finalization_jobs(&fixture).await;
    }
}

#[actix_web::test]
#[serial_test::serial]
async fn finalization_contract_enforces_json_size_and_content_type() {
    let (mut env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    Arc::get_mut(&mut env).unwrap().device_file_content =
        Some(fixture.runtime.clone());
    let app = app!(env);
    let cookie: Cookie<'static> = cookie!(app, fixture.login.id);
    let file = fixture.file("complete-envelope").await;
    let upload = fixture.upload(&file, b"unpublished").await;
    drop(fixture.seed_bytes(&upload, b"unpublished").await);
    let before = fixture.persisted(&upload).await;
    let cases = [
        (
            Some("application/json"),
            format!("{}{{}}", " ".repeat(1023)),
            413,
        ),
        (None, "{}".to_owned(), 415),
        (Some("text/plain"), "{}".to_owned(), 415),
        (Some("application/octet-stream"), "{}".to_owned(), 415),
    ];
    for (content_type, payload, expected) in cases {
        let mut request = test::TestRequest::post()
            .uri(&format!("{}/complete", super::resource_location(upload.id)))
            .cookie(cookie.clone())
            .insert_header(("tus-resumable", "1.0.0"))
            .set_payload(payload);
        if let Some(content_type) = content_type {
            request =
                request.insert_header((header::CONTENT_TYPE, content_type));
        }
        let response = test::call_service(&app, request.to_request()).await;
        assert_eq!(response.status().as_u16(), expected, "{content_type:?}");
        assert_eq!(response.headers().get("tus-resumable").unwrap(), "1.0.0");
        assert_eq!(fixture.persisted(&upload).await, before);
        assert_finalization_source_unpublished(
            &fixture,
            &upload,
            b"unpublished",
        )
        .await;
        assert_no_finalization_jobs(&fixture).await;
    }
}

#[actix_web::test]
#[serial_test::serial]
async fn finalization_contract_preserves_tus_and_incomplete_errors() {
    let (mut env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    Arc::get_mut(&mut env).unwrap().device_file_content =
        Some(fixture.runtime.clone());
    let app = app!(env);
    let cookie: Cookie<'static> = cookie!(app, fixture.login.id);
    let file = fixture.file("complete-errors").await;
    let upload = fixture.upload(&file, b"incomplete").await;
    let before = fixture.persisted(&upload).await;
    for payload in ["", r#"{"async_finalization":false}"#] {
        for version in [None, Some("0.2.2"), Some("1.0.0")] {
            let mut request = test::TestRequest::post()
                .uri(&format!(
                    "{}/complete",
                    super::resource_location(upload.id)
                ))
                .cookie(cookie.clone())
                .insert_header((header::CONTENT_TYPE, "application/json"))
                .set_payload(payload);
            if let Some(version) = version {
                request = request.insert_header(("tus-resumable", version));
            }
            let response = test::call_service(&app, request.to_request()).await;
            let valid_version = version == Some("1.0.0");
            assert_eq!(
                response.status(),
                if valid_version {
                    StatusCode::CONFLICT
                } else {
                    StatusCode::PRECONDITION_FAILED
                },
                "{version:?}: {payload}"
            );
            assert_eq!(
                response.headers().get("tus-resumable").unwrap(),
                "1.0.0"
            );
            if !valid_version {
                assert_eq!(
                    response.headers().get("tus-version").unwrap(),
                    "1.0.0"
                );
            }
            assert_eq!(
                test::read_body_json::<Value, _>(response).await,
                json!({ "code": if valid_version { "upload_incomplete" } else { "unsupported_tus_version" } })
            );
            assert_eq!(fixture.persisted(&upload).await, before);
            assert_no_finalization_jobs(&fixture).await;
        }
    }
}

#[actix_web::test]
#[serial_test::serial]
async fn finalization_contract_active_job_blocks_sync_when_admission_disabled()
{
    use crate::devices::upload_finalization::{
        admission,
        types::{FinalizationCommand, FinalizationTarget},
    };
    use crate::types::DeviceUploadFinalizationSettings;

    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let file = fixture.file("async-owned").await;
    let upload = fixture.upload(&file, b"owned source").await;
    drop(fixture.seed_bytes(&upload, b"owned source").await);
    let settings = DeviceUploadFinalizationSettings {
        enabled: true,
        ..Default::default()
    };
    let job = admission::admit(
        fixture.db(),
        &FinalizationCommand {
            created_by_login_id: fixture.login.id,
            device_id: fixture.device.id,
            source_size_bytes: upload.upload_length as i64,
            source_locator: Some(format!("{}.data", upload.id)),
            target: FinalizationTarget::File {
                upload_id: upload.id,
                file_id: file.id,
                revision: 1,
            },
        },
        &settings,
    )
    .await
    .unwrap();
    let original_job =
        device_upload_finalization_job::Entity::find_by_id(job.job_id)
            .one(fixture.db())
            .await
            .unwrap()
            .unwrap();
    for enabled in [true, false] {
        let mut env = env.as_ref().clone();
        env.device_file_content = Some(fixture.runtime.clone());
        env.config.device_upload_finalization =
            Some(DeviceUploadFinalizationSettings {
                enabled,
                ..settings.clone()
            });
        let env = Arc::new(env);
        let app = app!(env);
        let cookie: Cookie<'static> = cookie!(app, fixture.login.id);
        for payload in ["", r#"{"async_finalization":false}"#] {
            let started = Instant::now();
            let response = test::call_service(
                &app,
                test::TestRequest::post()
                    .uri(&format!(
                        "{}/complete",
                        super::resource_location(upload.id)
                    ))
                    .cookie(cookie.clone())
                    .insert_header(("tus-resumable", "1.0.0"))
                    .insert_header((header::CONTENT_TYPE, "application/json"))
                    .set_payload(payload)
                    .to_request(),
            )
            .await;
            assert_eq!(
                response.status(),
                StatusCode::SERVICE_UNAVAILABLE,
                "enabled={enabled}: {payload}"
            );
            assert!(started.elapsed().as_secs() < 2);
            assert!(
                response
                    .headers()
                    .get(header::RETRY_AFTER)
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .parse::<u64>()
                    .unwrap()
                    > 0
            );
            assert_finalization_source_unpublished(
                &fixture,
                &upload,
                b"owned source",
            )
            .await;
            assert_eq!(
                device_upload_finalization_job::Entity::find_by_id(job.job_id)
                    .one(fixture.db())
                    .await
                    .unwrap()
                    .unwrap(),
                original_job
            );
        }
    }
}

fn available_finalization_file_slots(root: &std::path::Path) -> usize {
    use crate::devices::upload_finalization::resources::{self, ResourceKind};

    let count =
        crate::types::DeviceUploadFinalizationSettings::default().file_slots;
    let mut guards = Vec::new();
    while let Some(guard) =
        resources::try_acquire(root, ResourceKind::File, count).unwrap()
    {
        guards.push(guard);
    }
    guards.len()
}

#[actix_web::test]
#[serial_test::serial]
async fn finalization_contract_cancelled_waiter_retains_source_and_file_slot() {
    use sea_orm::{DbBackend, Statement};
    use std::time::Duration;

    let (mut env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let resource_root = tempfile::tempdir().unwrap();
    Arc::get_mut(&mut env).unwrap().config.storage_dir =
        resource_root.path().display().to_string();
    Arc::get_mut(&mut env)
        .unwrap()
        .config
        .device_upload_finalization = None;
    let initial_slots = available_finalization_file_slots(resource_root.path());
    let file = fixture.file("cancelled-publication").await;
    let upload = fixture.upload(&file, b"owned until publication").await;
    let locked = fixture
        .seed_bytes(&upload, b"owned until publication")
        .await;
    let barrier = fixture.db().begin().await.unwrap();
    let blocker: i32 = barrier
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "select pg_backend_pid() as blocker from file_entry where id = $1 for update",
            [file.id.into()],
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "blocker")
        .unwrap();
    let mut finalization = Box::pin(finalize(
        &env,
        &fixture.runtime,
        fixture.login.id,
        upload.clone(),
        &locked,
    ));
    let publication_blocked = async {
        loop {
            let stored = fixture
                .runtime
                .storage
                .stat(&upload.object_key)
                .await
                .is_ok();
            let blocked: bool = barrier
                .query_one_raw(Statement::from_sql_and_values(
                    DbBackend::Postgres,
                    "select exists(select 1 from pg_stat_activity where datname = current_database() and $1 = any(pg_blocking_pids(pid))) as blocked",
                    [blocker.into()],
                ))
                .await
                .unwrap()
                .unwrap()
                .try_get("", "blocked")
                .unwrap();
            if stored && blocked {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    };
    let reached_publication = tokio::select! {
        _ = &mut finalization => false,
        result = tokio::time::timeout(Duration::from_secs(5), publication_blocked) => result.is_ok(),
    };
    drop(finalization);
    drop(locked);
    let source_lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(fixture.spool.path().join(format!("{}.lock", upload.id)))
        .unwrap();
    let source_lock_held = matches!(
        fs2::FileExt::try_lock_exclusive(&source_lock),
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock
    );
    drop(source_lock);
    let remaining_slots =
        available_finalization_file_slots(resource_root.path());
    barrier.rollback().await.unwrap();
    let completed = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let persisted = fixture.persisted(&upload).await;
            if persisted.status
                == crate::file_registry::entities::sea_orm_active_enums::FileContentUploadStatus::Completed
                && persisted.spool_removed_at.is_some()
                && available_finalization_file_slots(resource_root.path())
                    == initial_slots
            {
                break persisted;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    let released_slots =
        available_finalization_file_slots(resource_root.path());
    eprintln!(
        "UPLOAD_METRIC cancellation_publication_barrier={reached_publication} source_lock_retained={source_lock_held} initial_slots={initial_slots} cancelled_slots={remaining_slots} released_slots={released_slots} completed={}",
        completed.is_ok()
    );
    assert!(
        reached_publication,
        "must cancel after storage, during blocked publication"
    );
    assert!(
        source_lock_held,
        "detached finalization must retain the source flock"
    );
    assert_eq!(
        remaining_slots + 1,
        initial_slots,
        "detached finalization must retain one shared File slot"
    );
    assert!(
        completed.is_ok(),
        "detached finalization must publish, clean its source and release its File slot"
    );
    assert_eq!(released_slots, initial_slots);
    assert!(!fixture
        .spool
        .path()
        .join(format!("{}.data", upload.id))
        .exists());
    assert!(file_content::Entity::find_by_id((file.id, 1))
        .one(fixture.db())
        .await
        .unwrap()
        .is_some());
}

#[actix_web::test]
#[serial_test::serial]
async fn acceptance_legacy_file_sync_survives_unavailable_content_upload_startup(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let mut config = env.config.clone();
    config.storage_dir = fixture.spool.path().display().to_string();
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
        for failure in ["missing-s3", "invalid-key", "empty-bucket"] {
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
            worker::cleanup_one_for_test(&env, &fixture.runtime, upload.id)
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
    worker::cleanup_one_for_test(&env, &fixture.runtime, upload.id)
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
    for revocation in ["role", "section"] {
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
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "{revocation}");
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
                ROLE_CYBER, fixture.login.id
            ))
            .await
            .unwrap();
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
    assert!(worker::cleanup_one_for_test(&env, &broken, upload.id)
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
    worker::cleanup_one_for_test(&env, &fixture.runtime, next_upload.id)
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
    worker::cleanup_one_for_test(&env, &fixture.runtime, upload.id)
        .await
        .unwrap();
    worker::cleanup_one_for_test(&env, &fixture.runtime, upload.id)
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
            .insert_header((header::CONTENT_TYPE, "application/json"))
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
    let mut busy_retries = 0;
    for response in responses {
        let response = if response.status() == StatusCode::SERVICE_UNAVAILABLE {
            assert_eq!(
                test::read_body_json::<Value, _>(response).await["code"],
                "upload_busy"
            );
            busy_retries += 1;
            test::call_service(&app, make_patch()).await
        } else {
            response
        };
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
        "UPLOAD_METRIC open_error_cases={request_count} concurrent_patch_requests=8 busy_retries={busy_retries} accepted=1 offset_conflicts=7 concurrent_elapsed_ms={} bytes_after_resume=6 unexpected_publications=0",
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
            .insert_header((header::CONTENT_TYPE, "application/json"))
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
            roles: Set(json!([ROLE_CYBER])),
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
            let source_sequence =
                revision.source_sequence.as_ref().unwrap() + 1;
            revision.revision = Set(upload.revision + 1);
            revision.source_sequence = Set(Some(source_sequence));
            revision.insert(fixture.db()).await.unwrap();
            file_device_source_state::ActiveModel {
                id: Set(file.device_id),
                last_source_sequence: Set(source_sequence),
            }
            .update(fixture.db())
            .await
            .unwrap();
            file_entry::ActiveModel {
                archive_file_id: sea_orm::ActiveValue::NotSet,
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
        env.clone(),
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
        env.clone(),
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
            == DEVICE_FILE_CONTENT_FINALIZATION_MAX_WAITING
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
            DEVICE_FILE_CONTENT_FINALIZATION_MAX_WAITING
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
        DEVICE_FILE_CONTENT_FINALIZATION_MAX_WAITING
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
        DEVICE_FILE_CONTENT_FINALIZATION_MAX_WAITING
    );
    let full = fixture
        .runtime
        .finalization_waiters
        .clone()
        .acquire_many_owned(DEVICE_FILE_CONTENT_FINALIZATION_MAX_WAITING as u32)
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
    let now = Utc::now().fixed_offset();
    for seconds in [u64::MAX, i64::MAX as u64, 10_000_000_000_000] {
        assert!(repository::deadline_after(now, seconds).is_err());
    }
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

#[actix_web::test]
#[serial_test::serial]
async fn acceptance_content_read_requires_visible_device_and_exact_publication()
{
    let (mut env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let bytes = "Текст для перегляду\n<script>read only</script>".as_bytes();
    let file = fixture.file("звіт.txt").await;
    let upload = fixture.upload(&file, bytes).await;
    let locked = fixture.seed_bytes(&upload, bytes).await;
    finalize(
        &env,
        &fixture.runtime,
        fixture.login.id,
        upload.clone(),
        &locked,
    )
    .await
    .unwrap();
    let reader = mk_login(
        &env.dbx,
        login::ActiveModel {
            login: Set(format!("content-reader-{}", Uuid::new_v4())),
            roles: Set(json!([crate::devices::ROLE_CYBER])),
            organism_id: Set(fixture.login.organism_id),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let other_organism =
        mk_organism(&env.dbx, Default::default()).await.unwrap();
    let outsider = mk_login(
        &env.dbx,
        login::ActiveModel {
            login: Set(format!("content-outsider-{}", Uuid::new_v4())),
            roles: Set(json!([crate::devices::ROLE_CYBER])),
            organism_id: Set(Some(other_organism.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let basic = mk_login(
        &env.dbx,
        login::ActiveModel {
            login: Set(format!("content-basic-{}", Uuid::new_v4())),
            roles: Set(json!(["Basic"])),
            organism_id: Set(fixture.login.organism_id),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let env_mut = Arc::get_mut(&mut env).unwrap();
    env_mut.s3 = Some(fixture.runtime.storage.clone());
    env_mut.s3_config = Some(crate::storage::S3Config {
        prefix: crate::config::S3_MEDIA_ROOT_PREFIX.to_string(),
        ..fixture.runtime.storage_config.clone()
    });
    env_mut.config.s3_config = Some(crate::config::S3Config {
        s3_access_key_id: String::new(),
        s3_secret_access_key: String::new(),
        s3_endpoint: String::new(),
        s3_region: String::new(),
        s3_bucket: fixture.runtime.storage_config.bucket.clone(),
        strongbox_key: fixture.runtime.strongbox_key.clone(),
    });
    let app = app!(env);
    let reader_cookie: Cookie<'static> = cookie!(app, reader.id);
    let expired_cookie: Cookie<'static> = cookie!(app, Uuid::new_v4());
    let basic_cookie: Cookie<'static> = cookie!(app, basic.id);
    let outsider_cookie: Cookie<'static> = cookie!(app, outsider.id);
    let path = format!(
        "/api/device/files/{}/{}/revisions/1/content",
        fixture.device.id, file.id
    );
    for method in [Method::GET, Method::HEAD] {
        for (cookie, status) in [
            (None, StatusCode::UNAUTHORIZED),
            (Some(expired_cookie.clone()), StatusCode::UNAUTHORIZED),
            (Some(basic_cookie.clone()), StatusCode::FORBIDDEN),
            (Some(outsider_cookie.clone()), StatusCode::NOT_FOUND),
        ] {
            let mut request = test::TestRequest::default()
                .method(method.clone())
                .uri(&path);
            if let Some(cookie) = cookie {
                request = request.cookie(cookie);
            }
            let response = test::call_service(&app, request.to_request()).await;
            assert_eq!(response.status(), status);
        }
        let response = test::call_service(
            &app,
            test::TestRequest::default()
                .method(method.clone())
                .uri(&path)
                .cookie(reader_cookie.clone())
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get("content-length").unwrap(),
            bytes.len().to_string().as_str()
        );
        assert_eq!(
            response.headers().get("content-type").unwrap(),
            "application/octet-stream"
        );
        assert_eq!(
            response.headers().get("content-encoding").unwrap(),
            "identity"
        );
        if method == Method::HEAD {
            use actix_web::body::{BodySize, MessageBody};
            assert_eq!(
                response.response().body().size(),
                BodySize::Sized(bytes.len() as u64)
            );
            assert_eq!(
                response.headers().get("content-encoding").unwrap(),
                "identity"
            );
        }
        assert_eq!(
            response.headers().get("cache-control").unwrap(),
            "private, no-store"
        );
        assert_eq!(
            response.headers().get("x-content-type-options").unwrap(),
            "nosniff"
        );
        assert!(response
            .headers()
            .get("content-disposition")
            .unwrap()
            .as_bytes()
            .starts_with(b"attachment;"));
        let body = test::read_body(response).await;
        if method == Method::GET {
            assert_eq!(body.as_ref(), bytes);
        } else {
            assert!(body.is_empty());
        }
    }
    let missing = fixture.file("not-uploaded.txt").await;
    for uri in [
        path.replace("/revisions/1/", "/revisions/2/"),
        path.replace(&file.id.to_string(), &missing.id.to_string()),
        path.replace(
            &fixture.device.id.to_string(),
            &Uuid::new_v4().to_string(),
        ),
    ] {
        let response = test::call_service(
            &app,
            test::TestRequest::get()
                .uri(&uri)
                .cookie(reader_cookie.clone())
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
    // #3390: a later sync must not hide the published bytes of the selected session.
    resync_file(&env, &fixture, &file).await;
    for method in [Method::GET, Method::HEAD] {
        let response = test::call_service(
            &app,
            test::TestRequest::default()
                .method(method.clone())
                .uri(&path)
                .cookie(reader_cookie.clone())
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = test::read_body(response).await;
        if method == Method::GET {
            assert_eq!(body.as_ref(), bytes);
        } else {
            assert!(body.is_empty());
        }
    }
}

#[actix_web::test]
#[serial_test::serial]
async fn acceptance_content_read_streams_plaintext_without_upload_runtime() {
    let (mut env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let mut reader = fixture.login.clone().into_active_model();
    reader.roles = Set(json!([crate::devices::ROLE_CYBER]));
    let reader = reader.update(&env.dbx).await.unwrap();
    let env_mut = Arc::get_mut(&mut env).unwrap();
    env_mut.s3 = Some(fixture.runtime.storage.clone());
    env_mut.s3_config = Some(crate::storage::S3Config {
        prefix: crate::config::S3_MEDIA_ROOT_PREFIX.to_string(),
        ..fixture.runtime.storage_config.clone()
    });
    assert!(env_mut.device_file_content.is_none());
    let app = app!(env);
    let cookie: Cookie<'static> = cookie!(app, reader.id);
    for bytes in [b"original plaintext bytes".as_slice(), b"".as_slice()] {
        let file = fixture.file("plain.txt").await;
        let upload = fixture.upload(&file, bytes).await;
        fixture
            .runtime
            .storage
            .write(
                &fixture
                    .runtime
                    .storage_config
                    .prefixed_key(&upload.object_key),
                bytes.to_vec(),
            )
            .await
            .unwrap();
        repository::publish(
            fixture.db(),
            &upload,
            false,
            Utc::now().fixed_offset(),
            None,
        )
        .await
        .unwrap();
        let path = format!(
            "/api/device/files/{}/{}/revisions/1/content",
            fixture.device.id, file.id
        );
        let response = test::call_service(
            &app,
            test::TestRequest::get()
                .uri(&path)
                .cookie(cookie.clone())
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(test::read_body(response).await.as_ref(), bytes);
    }
}

async fn publish_historical_revisions(
    env: &Env,
    fixture: &Fixture,
) -> file_entry::Model {
    let file = fixture
        .file_with_metadata(
            "historical \"report\"\r\n.txt",
            "text/plain",
            "txt",
        )
        .await;
    let absolute_path = format!("C:\\{}-historical.txt", file.id);
    let mut file = file.into_active_model();
    file.absolute_path = Set(Some(absolute_path));
    let file = file.update(fixture.db()).await.unwrap();
    let original = b"selected historical bytes";
    let upload = fixture.upload(&file, original).await;
    let locked = fixture.seed_bytes(&upload, original).await;
    finalize(env, &fixture.runtime, fixture.login.id, upload, &locked)
        .await
        .unwrap();
    drop(locked);
    let mut resync_source = file.clone();
    resync_source.mime_type = Some("video/mp4".to_owned());
    resync_source.extension = Some("mp4".to_owned());
    resync_file(env, fixture, &resync_source).await;
    let current = file_entry::Entity::find_by_id(file.id)
        .one(fixture.db())
        .await
        .unwrap()
        .unwrap();
    let mut current = current.into_active_model();
    current.name = Set("current.mp4".to_owned());
    current.mime_type = Set(Some("video/mp4".to_owned()));
    current.extension = Set(Some("mp4".to_owned()));
    let current = current.update(fixture.db()).await.unwrap();
    let current_bytes = b"different current revision bytes";
    let upload = fixture.upload(&current, current_bytes).await;
    let locked = fixture.seed_bytes(&upload, current_bytes).await;
    finalize(env, &fixture.runtime, fixture.login.id, upload, &locked)
        .await
        .unwrap();
    drop(locked);
    file
}

async fn assert_historical_snapshot(
    env: &Env,
    fixture: &Fixture,
    file_id: Uuid,
) {
    let published = super::read::load_published_content(
        env,
        &fixture.login,
        fixture.device.id,
        file_id,
        1,
    )
    .await
    .unwrap();
    assert_eq!(
        published.name,
        format!("{}-historical \"report\"\r\n.txt", file_id)
    );
    assert_eq!(published.extension.as_deref(), Some("txt"));
    assert_eq!(published.mime_type.as_deref(), Some("text/plain"));
    assert_eq!(
        published.source_sha256,
        Sha256::digest(b"selected historical bytes").to_vec()
    );
    assert_eq!(published.source_size_bytes, 25);
    assert!(published.is_encrypted);
    let current = super::read::load_published_content(
        env,
        &fixture.login,
        fixture.device.id,
        file_id,
        2,
    )
    .await
    .unwrap();
    assert_ne!(published.object_key, current.object_key);
    assert_eq!(current.extension.as_deref(), Some("mp4"));
    assert_eq!(current.mime_type.as_deref(), Some("video/mp4"));
}

fn assert_historical_download_headers(
    headers: &header::HeaderMap,
    file_id: Uuid,
) {
    assert_eq!(
        headers.get("content-type").unwrap(),
        "application/octet-stream"
    );
    assert_eq!(headers.get("content-encoding").unwrap(), "identity");
    assert_eq!(headers.get("content-length").unwrap(), "25");
    assert_eq!(headers.get("cache-control").unwrap(), "private, no-store");
    assert_eq!(headers.get("x-content-type-options").unwrap(), "nosniff");
    let disposition = header::ContentDisposition::from_raw(
        headers.get("content-disposition").unwrap(),
    )
    .unwrap();
    assert_eq!(disposition.disposition, header::DispositionType::Attachment);
    assert_eq!(
        disposition.get_filename(),
        Some(format!("{}-historical \"report\"%0D%0A.txt", file_id).as_str())
    );
}

#[actix_web::test]
#[serial_test::serial]
async fn acceptance_content_read_preserves_historical_identity_on_archived_device(
) {
    let (mut env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let file = publish_historical_revisions(&env, &fixture).await;
    let original = b"selected historical bytes";
    let mut archived = fixture.device.clone().into_active_model();
    archived.archived = Set(true);
    archived.archived_at = Set(Some(Utc::now().naive_utc()));
    archived.update(&env.dbx).await.unwrap();
    assert_historical_snapshot(&env, &fixture, file.id).await;
    assert!(matches!(
        crate::devices::devices::query::authorize_file_registry_access(
            &env.dbx,
            &fixture.login,
            fixture.device.id,
            crate::devices::devices::query::FileRegistryDeviceAccess::FileSync,
        )
        .await,
        Ok(device_id) if device_id == fixture.device.id
    ));
    let mut other_device = fixture.device.clone().into_active_model();
    other_device.id = Set(Uuid::new_v4());
    let other_device = other_device.insert(&env.dbx).await.unwrap();
    let env_mut = Arc::get_mut(&mut env).unwrap();
    env_mut.s3 = Some(fixture.runtime.storage.clone());
    env_mut.s3_config = Some(fixture.runtime.storage_config.clone());
    env_mut.config.s3_config = Some(crate::config::S3Config {
        s3_access_key_id: String::new(),
        s3_secret_access_key: String::new(),
        s3_endpoint: String::new(),
        s3_region: String::new(),
        s3_bucket: fixture.runtime.storage_config.bucket.clone(),
        strongbox_key: fixture.runtime.strongbox_key.clone(),
    });
    assert!(env_mut.device_file_content.is_none());
    let app = app!(env);
    let cookie: Cookie<'static> = cookie!(app, fixture.login.id);
    for method in [Method::GET, Method::HEAD] {
        let path = format!(
            "/api/device/files/{}/{}/revisions/1/content",
            fixture.device.id, file.id
        );
        let response = test::call_service(
            &app,
            test::TestRequest::default()
                .method(method.clone())
                .uri(&path)
                .cookie(cookie.clone())
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_historical_download_headers(response.headers(), file.id);
        let body = test::read_body(response).await;
        if method == Method::GET {
            assert_eq!(body.as_ref(), original);
        } else {
            assert!(body.is_empty());
        }
        let path = path.replace(
            &fixture.device.id.to_string(),
            &other_device.id.to_string(),
        );
        let response = test::call_service(
            &app,
            test::TestRequest::default()
                .method(method)
                .uri(&path)
                .cookie(cookie.clone())
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}

#[actix_web::test]
#[serial_test::serial]
async fn acceptance_historical_endpoint_matrix_rechecks_access_and_source() {
    let (mut env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let geodata = fixture
        .file_with_metadata("history.gpx", "application/gpx+xml", "gpx")
        .await;
    let media = fixture
        .file_with_metadata("history.wav", "audio/wav", "wav")
        .await;
    let original = b"immutable selected revision";
    for file in [&geodata, &media] {
        let upload = fixture.upload(file, original).await;
        let spool = fixture.seed_bytes(&upload, original).await;
        finalize(&env, &fixture.runtime, fixture.login.id, upload, &spool)
            .await
            .unwrap();
        drop(spool);
        resync_file(&env, &fixture, file).await;
    }
    let generation = Uuid::new_v4();
    let output_key = format!("device-file-preview/{generation}");
    let result = b"exact derivative bytes";
    let result_hash = Sha256::digest(result).to_vec();
    fixture.db().execute_raw(sea_orm::Statement::from_sql_and_values(sea_orm::DatabaseBackend::Postgres,
        "insert into file_preview (generation,device_id,file_id,revision,source_file_id,source_revision,kind,converter_version,is_current,state,run_id,attempt,source_object_key,source_sha256,source_size_bytes,source_is_encrypted,source_name,source_extension,not_before,output_object_key,retryable,created_at,updated_at,result_size_bytes,result_sha256,result_encrypted,expires_at,cleanup_after) select $1,r.device_id,r.id,r.revision,c.file_id,c.revision,'geodata_kmz',$6,true,'ready',$1,1,c.object_key,c.source_sha256,c.source_size_bytes,c.is_encrypted,r.name,r.extension,now(),$2,false,now(),now(),$3,$4,true,now()+interval '1 day',now()+interval '1 day' from file_revision r join file_content c on c.file_id=r.id and c.revision=r.revision where r.id=$5 and r.revision=1",
        [generation.into(), output_key.clone().into(), (result.len() as i64).into(), result_hash.into(), geodata.id.into(), DEVICE_FILE_PREVIEW_GEODATA_CONVERTER_VERSION.into()])).await.unwrap();
    crate::storage::upload_device_content_encrypted(
        &fixture.runtime.storage,
        &fixture.runtime.storage_config,
        &fixture.runtime.strongbox_key,
        &output_key,
        result.to_vec().into(),
        None,
    )
    .await
    .unwrap();
    let env_mut = Arc::get_mut(&mut env).unwrap();
    env_mut.s3 = Some(fixture.runtime.storage.clone());
    env_mut.s3_config = Some(fixture.runtime.storage_config.clone());
    env_mut.config.s3_config = Some(crate::config::S3Config {
        s3_access_key_id: String::new(),
        s3_secret_access_key: String::new(),
        s3_endpoint: String::new(),
        s3_region: String::new(),
        s3_bucket: fixture.runtime.storage_config.bucket.clone(),
        strongbox_key: fixture.runtime.strongbox_key.clone(),
    });
    let session =
        RedisSessionStore::new(crate::redis_conn_string(&env.config).unwrap())
            .await
            .unwrap();
    let app = test::init_service(
        App::new()
            .app_data(web::Data::from(env.clone()))
            .wrap(IdentityMiddleware::default())
            .wrap(SessionMiddleware::new(session, Key::generate()))
            .route("/test/login/{login}", web::post().to(sign_in))
            .service(super::routes())
            .service(crate::devices::files::preview::routes()),
    )
    .await;
    let cookie: Cookie<'static> = cookie!(app, fixture.login.id);
    let base = format!(
        "/api/device/files/{}/{}/revisions/1",
        fixture.device.id, geodata.id
    );
    let map = format!("{base}/preview/geodata");
    let result_path = format!("{map}/{generation}/content");
    let media_path = format!(
        "/api/device/files/{}/{}/revisions/1/preview/media",
        fixture.device.id, media.id
    );
    let endpoints = [
        (Method::GET, format!("{base}/content"), StatusCode::OK),
        (Method::HEAD, format!("{base}/content"), StatusCode::OK),
        (Method::GET, media_path.clone(), StatusCode::OK),
        (Method::HEAD, media_path, StatusCode::OK),
        (Method::GET, map.clone(), StatusCode::OK),
        (Method::POST, map.clone(), StatusCode::OK),
        (Method::POST, format!("{map}/retry"), StatusCode::CONFLICT),
        (Method::GET, result_path.clone(), StatusCode::OK),
        (Method::HEAD, result_path, StatusCode::OK),
    ];
    let mut other_device = fixture.device.clone().into_active_model();
    other_device.id = Set(Uuid::new_v4());
    let other_device = other_device.insert(&env.dbx).await.unwrap();
    let other_organism =
        mk_organism(&env.dbx, Default::default()).await.unwrap();
    for (phase, expected) in [
        ("archived", None),
        ("unauthenticated", Some(StatusCode::UNAUTHORIZED)),
        ("other_device", Some(StatusCode::NOT_FOUND)),
        ("other_scope", Some(StatusCode::NOT_FOUND)),
        ("revoked", Some(StatusCode::FORBIDDEN)),
        ("deleted_source", Some(StatusCode::NOT_FOUND)),
    ] {
        match phase {
            "archived" => {
                env.dbx.execute_unprepared(&format!("update device set archived=true,archived_at=now() where id='{}'",fixture.device.id)).await.unwrap();
            }
            "revoked" => {
                env.dbx
                    .execute_unprepared(&format!(
                        "update login set roles='[]'::jsonb where id='{}'",
                        fixture.login.id
                    ))
                    .await
                    .unwrap();
            }
            "other_scope" => {
                env.dbx
                    .execute_unprepared(&format!(
                        "update login set organism_id={} where id='{}'",
                        other_organism.id, fixture.login.id
                    ))
                    .await
                    .unwrap();
            }
            "deleted_source" => {
                env.dbx.execute_unprepared(&format!("update login set roles='[\"{ROLE_CYBER}\"]'::jsonb,organism_id={} where id='{}'",fixture.login.organism_id.unwrap(),fixture.login.id)).await.unwrap();
                let transaction = fixture.db().begin().await.unwrap();
                transaction.execute_unprepared(&format!("update file_entry set content_path=null where id in ('{}','{}'); alter table file_content disable trigger file_content_immutable_trg; delete from file_content where file_id in ('{}','{}'); alter table file_content enable trigger file_content_immutable_trg",geodata.id,media.id,geodata.id,media.id)).await.unwrap();
                transaction.commit().await.unwrap();
            }
            _ => {}
        }
        for (method, uri, allowed) in &endpoints {
            let uri = if phase == "other_device" {
                uri.replace(
                    &fixture.device.id.to_string(),
                    &other_device.id.to_string(),
                )
            } else {
                uri.clone()
            };
            let mut request = test::TestRequest::default()
                .method(method.clone())
                .uri(&uri);
            if phase != "unauthenticated" {
                request = request.cookie(cookie.clone());
            }
            if uri.ends_with("/retry") {
                request =
                    request.set_json(json!({"expected_generation":generation}));
            }
            let response = test::call_service(&app, request.to_request()).await;
            assert_eq!(
                response.status(),
                expected.unwrap_or(*allowed),
                "phase={phase}, method={method}, uri={uri}"
            );
            if uri.contains("/preview/") || expected.is_none() {
                assert_eq!(
                    response.headers().get(header::CACHE_CONTROL).unwrap(),
                    "private, no-store"
                );
            }
            let body = test::read_body(response).await;
            if expected.is_some() {
                assert!(!body
                    .windows(original.len())
                    .any(|window| window == original));
            } else if method == Method::GET
                && (uri.ends_with("/content") || uri.ends_with("/media"))
            {
                assert_eq!(
                    body.as_ref(),
                    if uri.contains("/preview/geodata/") {
                        result.as_slice()
                    } else {
                        original.as_slice()
                    }
                );
            }
        }
        if phase != "deleted_source" {
            for file in [&geodata, &media] {
                let content = file_content::Entity::find_by_id((file.id, 1))
                    .one(fixture.db())
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(
                    content.source_sha256,
                    Sha256::digest(original).to_vec()
                );
            }
        }
    }
}

#[path = "security_tests.rs"]
mod security_tests;

#[path = "capacity_tests.rs"]
mod capacity_tests;

#[path = "review_fix_tests.rs"]
mod review_fix_tests;
