use std::sync::Arc;

use actix_identity::{Identity, IdentityMiddleware};
use actix_session::{storage::RedisSessionStore, SessionMiddleware};
use actix_web::cookie::{Cookie, Key};
use actix_web::http::{header, StatusCode};
use actix_web::{test, web, App, HttpMessage, HttpRequest, HttpResponse};
use chrono::{DateTime, Duration, Utc};
use sea_orm::{
    ActiveModelTrait, Database, DatabaseConnection, EntityTrait,
    IntoActiveModel, Set,
};
use serde_json::{json, Value};
use uuid::Uuid;

use super::admission;
use super::types::{FinalizationCommand, FinalizationKind, FinalizationTarget};
use crate::devices::tests::schema::device_active_model;
use crate::entities::{device, login, system_settings};
use crate::file_registry::entities::{
    device_upload_finalization_job, file_content_upload, file_entry,
    sea_orm_active_enums::{FileContentUploadStatus, FileEntryKind},
};
use crate::functest::tests::{cleanup_locked, mk_login, mk_organism};
use crate::types::{DeviceUploadFinalizationSettings, Env};

struct Fixture {
    actor: login::Model,
    device: device::Model,
}

impl Fixture {
    async fn new(env: &Env) -> Self {
        system_settings::ActiveModel {
            devices_section_enabled: Set(true),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let organism = mk_organism(&env.dbx, Default::default()).await.unwrap();
        let actor = Self::actor(env, organism.id).await;
        let device = device_active_model(
            &actor.login,
            organism.id,
            None,
            json!({}),
            false,
            None,
        )
        .insert(&env.dbx)
        .await
        .unwrap();
        Self { actor, device }
    }

    async fn actor(env: &Env, organism_id: i64) -> login::Model {
        mk_login(
            &env.dbx,
            login::ActiveModel {
                login: Set(format!("finalization-status-{}", Uuid::new_v4())),
                organism_id: Set(Some(organism_id)),
                roles: Set(json!(["Cyber"])),
                ..Default::default()
            },
        )
        .await
        .unwrap()
    }

    async fn command(
        &self,
        db: &DatabaseConnection,
        kind: FinalizationKind,
    ) -> FinalizationCommand {
        let target = match kind {
            FinalizationKind::FinalizationFileKind => {
                self.file_target(db).await
            }
            FinalizationKind::FinalizationAudioKind => {
                FinalizationTarget::Audio {
                    tus_id: Uuid::new_v4(),
                    audio_id: Uuid::new_v4(),
                    name: format!("Original {}", Uuid::new_v4()),
                    recording_started_at: "2026-10-14T08:00:00.123456Z"
                        .parse()
                        .unwrap(),
                    pin_token: Uuid::new_v4(),
                }
            }
        };
        FinalizationCommand {
            created_by_login_id: self.actor.id,
            device_id: self.device.id,
            source_size_bytes: 64,
            source_locator: Some(format!("private-source/{}", Uuid::new_v4())),
            target,
        }
    }

    async fn file_target(&self, db: &DatabaseConnection) -> FinalizationTarget {
        let file_id = Uuid::new_v4();
        let now = Utc::now();
        let root_id = Uuid::new_v4();
        let root = file_entry::ActiveModel {
            id: Set(root_id),
            device_id: Set(self.device.id),
            parent_id: Set(None),
            kind: Set(FileEntryKind::Directory),
            name: Set(format!("root-{root_id}")),
            hierarchy_path: Set(format!("n{}", root_id.simple())),
            created_at: Set(now.naive_utc()),
            updated_at: Set(now.naive_utc()),
            ..Default::default()
        }
        .insert(db)
        .await
        .unwrap();
        let file = crate::file_registry::test_support::insert_entry(
            db,
            file_entry::ActiveModel {
                id: Set(file_id),
                device_id: Set(self.device.id),
                parent_id: Set(Some(root.id)),
                kind: Set(FileEntryKind::File),
                name: Set(format!("{file_id}.txt")),
                absolute_path: Set(Some(format!("C:\\{file_id}.txt"))),
                hierarchy_path: Set(format!(
                    "{}.n{}",
                    root.hierarchy_path,
                    file_id.simple()
                )),
                created_at: Set(now.naive_utc()),
                updated_at: Set(now.naive_utc()),
                ..Default::default()
            },
        )
        .await;
        let upload_id = Uuid::new_v4();
        let revision = file.revision.unwrap();
        file_content_upload::ActiveModel {
            id: Set(upload_id),
            device_id: Set(self.device.id),
            file_id: Set(file_id),
            revision: Set(revision),
            created_by_login_id: Set(self.actor.id),
            upload_length: Set(64),
            expected_sha256: Set(vec![1; 32]),
            object_key: Set(format!(
                "device-file-content/{}/{file_id}/{revision}/{upload_id}",
                self.device.id
            )),
            status: Set(FileContentUploadStatus::Open),
            created_at: Set(now.fixed_offset()),
            last_activity_at: Set(now.fixed_offset()),
            expires_at: Set((now + Duration::hours(1)).fixed_offset()),
            hard_expires_at: Set((now + Duration::days(1)).fixed_offset()),
            spool_removed_at: Set(None),
            next_cleanup_at: Set(None),
            finalization_job_id: Set(None),
            stats_epoch: sea_orm::ActiveValue::NotSet,
        }
        .insert(db)
        .await
        .unwrap();
        FinalizationTarget::File {
            upload_id,
            file_id,
            revision,
        }
    }
}

async fn sign_in(
    request: HttpRequest,
    actor: web::Path<String>,
) -> HttpResponse {
    Identity::login(&request.extensions(), actor.into_inner()).unwrap();
    HttpResponse::NoContent().finish()
}

macro_rules! app {
    ($env:expr) => {{
        let sessions = RedisSessionStore::new(
            crate::redis_conn_string(&$env.config).unwrap(),
        )
        .await
        .unwrap();
        test::init_service(
            App::new()
                .app_data(web::Data::from($env.clone()))
                .wrap(IdentityMiddleware::default())
                .wrap(SessionMiddleware::new(sessions, Key::generate()))
                .route("/test/login/{actor}", web::post().to(sign_in))
                .configure(crate::devices::upload_finalization::config),
        )
        .await
    }};
}

macro_rules! cookie {
    ($app:expr, $actor:expr) => {{
        let response = test::call_service(
            &$app,
            test::TestRequest::post()
                .uri(&format!("/test/login/{}", $actor))
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        response.response().cookies().next().unwrap().into_owned()
    }};
}

fn path(job_id: Uuid) -> String {
    format!("/api/device/upload-finalization-jobs/{job_id}")
}

fn completed_result(command: &FinalizationCommand) -> Value {
    match &command.target {
        FinalizationTarget::File {
            upload_id,
            file_id,
            revision,
        } => json!({
            "upload_id": upload_id,
            "file_id": file_id,
            "revision": revision,
            "status": "completed",
        }),
        FinalizationTarget::Audio { audio_id, name, .. } => json!({
            "audio": {
                "id": audio_id,
                "device_id": command.device_id,
                "name": name,
                "recording_started_at": "2026-10-14T08:00:00.123456Z",
                "recording_ended_at": "2026-10-14T08:00:01.123456Z",
                "duration_seconds": 1.0,
                "processed": false,
                "processing_version": "019a0000-0000-7000-8000-000000000001",
            }
        }),
    }
}

async fn seed_job(
    db: &DatabaseConnection,
    command: &FinalizationCommand,
    status: &str,
) -> device_upload_finalization_job::Model {
    let snapshot = admission::admit(
        db,
        command,
        &DeviceUploadFinalizationSettings {
            enabled: true,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let job = persisted(db, snapshot.job_id).await;
    if status == "queued" {
        return job;
    }
    let now = Utc::now().fixed_offset();
    let mut job = job.into_active_model();
    job.status = Set(status.into());
    job.updated_at = Set(now);
    if status == "processing" {
        job.lease_owner = Set(Some(Uuid::new_v4()));
        job.lease_epoch = Set(1);
        job.lease_until = Set(Some(now + Duration::seconds(60)));
    }
    if matches!(status, "completed" | "failed") {
        job.finished_at = Set(Some(now));
    }
    if status == "completed" {
        job.result = Set(Some(json!({
            "version": 1,
            "value": completed_result(command),
        })));
    }
    let diagnostic = match status {
        "retry_wait" => Some(("dependency_unavailable", "retry_poll")),
        "outcome_unknown" => Some(("storage_outcome_unknown", "retry_poll")),
        "failed" => Some(("source_digest_mismatch", "new_upload")),
        _ => None,
    };
    if let Some((code, action)) = diagnostic {
        job.error_code = Set(Some(code.into()));
        job.error_message = Set(Some("Safe diagnostic".into()));
        job.error_action = Set(Some(action.into()));
    }
    if status == "retry_wait" {
        job.next_run_at = Set(now + Duration::seconds(600));
    }
    job.update(db).await.unwrap()
}

async fn persisted(
    db: &DatabaseConnection,
    job_id: Uuid,
) -> device_upload_finalization_job::Model {
    device_upload_finalization_job::Entity::find_by_id(job_id)
        .one(db)
        .await
        .unwrap()
        .unwrap()
}

#[actix_web::test]
#[serial_test::serial]
async fn phase4_status_http_reads_every_state_without_mutating_jobs() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let db = env.file_registry_db.as_ref().unwrap().connection();
    let app = app!(env);
    let cookie: Cookie<'static> = cookie!(app, fixture.actor.id);
    for (kind, kind_name) in [
        (FinalizationKind::FinalizationFileKind, "file"),
        (FinalizationKind::FinalizationAudioKind, "audio"),
    ] {
        for status in [
            "queued",
            "processing",
            "retry_wait",
            "outcome_unknown",
            "completed",
            "failed",
        ] {
            let command = fixture.command(db, kind).await;
            let job = seed_job(db, &command, status).await;
            for _ in 0..2 {
                let response = test::call_service(
                    &app,
                    test::TestRequest::get()
                        .uri(&path(job.id))
                        .cookie(cookie.clone())
                        .to_request(),
                )
                .await;
                assert_eq!(
                    response.status(),
                    StatusCode::OK,
                    "{kind_name}/{status}"
                );
                assert_eq!(
                    response.headers().get(header::CACHE_CONTROL).unwrap(),
                    "private, no-store"
                );
                let terminal = matches!(status, "completed" | "failed");
                let retry =
                    response.headers().get(header::RETRY_AFTER).cloned();
                let body: Value = test::read_body_json(response).await;
                assert_eq!(body.as_object().unwrap().len(), 9);
                assert_eq!(body["job_id"], job.id.to_string());
                assert_eq!(body["kind"], kind_name);
                assert_eq!(body["status"], status);
                for field in ["created_at", "updated_at"] {
                    DateTime::parse_from_rfc3339(body[field].as_str().unwrap())
                        .unwrap();
                }
                if terminal {
                    DateTime::parse_from_rfc3339(
                        body["finished_at"].as_str().unwrap(),
                    )
                    .unwrap();
                    assert_eq!(body["retry_after_seconds"], Value::Null);
                    assert!(retry.is_none());
                } else {
                    assert_eq!(body["finished_at"], Value::Null);
                    let seconds = if status == "retry_wait" { 300 } else { 1 };
                    assert_eq!(body["retry_after_seconds"], seconds);
                    assert_eq!(
                        retry.unwrap().to_str().unwrap(),
                        seconds.to_string()
                    );
                }
                assert_eq!(
                    body["result"],
                    if status == "completed" {
                        completed_result(&command)
                    } else {
                        Value::Null
                    }
                );
                let error = match status {
                    "retry_wait" => {
                        json!({"code": "dependency_unavailable", "message": "Safe diagnostic", "action": "retry_poll"})
                    }
                    "outcome_unknown" => {
                        json!({"code": "storage_outcome_unknown", "message": "Safe diagnostic", "action": "retry_poll"})
                    }
                    "failed" => {
                        json!({"code": "source_digest_mismatch", "message": "Safe diagnostic", "action": "new_upload"})
                    }
                    _ => Value::Null,
                };
                assert_eq!(body["error"], error);
                assert!(!body.to_string().contains("private-source"));
                assert_eq!(persisted(db, job.id).await, job);
            }
        }
    }
}

#[actix_web::test]
#[serial_test::serial]
async fn phase4_status_http_requires_owner_current_visibility_and_valid_identity(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let db = env.file_registry_db.as_ref().unwrap().connection();
    let command = fixture
        .command(db, FinalizationKind::FinalizationAudioKind)
        .await;
    let job = seed_job(db, &command, "queued").await;
    let app = app!(env);
    let owner: Cookie<'static> = cookie!(app, fixture.actor.id);
    let owner_new_session: Cookie<'static> = cookie!(app, fixture.actor.id);
    let other = Fixture::actor(&env, fixture.actor.organism_id.unwrap()).await;
    let other: Cookie<'static> = cookie!(app, other.id);
    let invalid: Cookie<'static> = cookie!(app, "not-an-account");
    let unknown: Cookie<'static> = cookie!(app, Uuid::new_v4());
    let malformed = [
        "not-a-uuid".to_owned(),
        job.id.simple().to_string(),
        job.id.to_string().to_uppercase(),
    ];
    let mut cases = vec![
        (path(job.id), None, StatusCode::UNAUTHORIZED),
        (path(job.id), Some(invalid), StatusCode::UNAUTHORIZED),
        (path(job.id), Some(unknown), StatusCode::UNAUTHORIZED),
        (path(job.id), Some(other), StatusCode::NOT_FOUND),
        (
            path(Uuid::new_v4()),
            Some(owner.clone()),
            StatusCode::NOT_FOUND,
        ),
        (path(job.id), Some(owner.clone()), StatusCode::OK),
        (path(job.id), Some(owner_new_session), StatusCode::OK),
    ];
    cases.extend(malformed.into_iter().map(|id| {
        (
            format!("/api/device/upload-finalization-jobs/{id}"),
            Some(owner.clone()),
            StatusCode::BAD_REQUEST,
        )
    }));
    for (uri, cookie, expected) in cases {
        let mut request = test::TestRequest::get().uri(&uri);
        if let Some(cookie) = cookie {
            request = request.cookie(cookie);
        }
        let response = test::call_service(&app, request.to_request()).await;
        assert_eq!(response.status(), expected, "{uri}");
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "private, no-store"
        );
        if expected == StatusCode::NOT_FOUND {
            assert_eq!(test::read_body(response).await, "Not found");
        }
    }
    let mut actor = fixture.actor.into_active_model();
    actor.roles = Set(json!(["CyberViewer"]));
    let actor = actor.update(&env.dbx).await.unwrap();
    let response = test::call_service(
        &app,
        test::TestRequest::get()
            .uri(&path(job.id))
            .cookie(owner.clone())
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let mut actor = actor.into_active_model();
    actor.roles = Set(json!([]));
    actor.update(&env.dbx).await.unwrap();
    let response = test::call_service(
        &app,
        test::TestRequest::get()
            .uri(&path(job.id))
            .cookie(owner)
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        response.headers().get(header::CACHE_CONTROL).unwrap(),
        "private, no-store"
    );
    assert_eq!(test::read_body(response).await, "Not found");
}

#[actix_web::test]
#[serial_test::serial]
async fn phase4_status_http_reports_unavailable_dependencies_without_false_absence(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let db = env.file_registry_db.as_ref().unwrap().connection();
    let command = fixture
        .command(db, FinalizationKind::FinalizationAudioKind)
        .await;
    let job = seed_job(db, &command, "queued").await;
    for unavailable in [
        "registry_missing",
        "registry_closed",
        "authorization_closed",
    ] {
        let mut unavailable_env = (*env).clone();
        match unavailable {
            "registry_missing" => unavailable_env.file_registry_db = None,
            "registry_closed" => {
                let database = crate::file_registry::connect_runtime(
                    &env.config,
                    env.mode,
                )
                .await
                .unwrap()
                .unwrap();
                database.connection().clone().close().await.unwrap();
                unavailable_env.file_registry_db = Some(database);
            }
            _ => {
                let database =
                    Database::connect(crate::mk_conn_string(&env.config))
                        .await
                        .unwrap();
                database.clone().close().await.unwrap();
                unavailable_env.dbx = database;
            }
        }
        let unavailable_env = Arc::new(unavailable_env);
        let app = app!(unavailable_env);
        let cookie: Cookie<'static> = cookie!(app, fixture.actor.id);
        let response = test::call_service(
            &app,
            test::TestRequest::get()
                .uri(&path(job.id))
                .cookie(cookie)
                .to_request(),
        )
        .await;
        assert_eq!(
            response.status(),
            StatusCode::SERVICE_UNAVAILABLE,
            "{unavailable}"
        );
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "private, no-store"
        );
        assert_eq!(response.headers().get(header::RETRY_AFTER).unwrap(), "1");
        assert_eq!(
            test::read_body(response).await,
            "Upload finalization is temporarily unavailable"
        );
        assert_eq!(persisted(db, job.id).await, job);
    }
}

async fn edit_published_content(
    db: &DatabaseConnection,
    command: &FinalizationCommand,
) {
    match &command.target {
        FinalizationTarget::File { file_id, .. } => {
            use crate::file_registry::entities::file_revision;
            let revision = file_revision::Entity::find_by_id((*file_id, 1))
                .one(db)
                .await
                .unwrap()
                .unwrap();
            let mut revision = revision.into_active_model();
            revision.revision = Set(2);
            revision.source_sequence = Set(Some(100));
            revision.name = Set("changed.txt".into());
            revision.insert(db).await.unwrap();
            let file = file_entry::Entity::find_by_id(*file_id)
                .one(db)
                .await
                .unwrap()
                .unwrap();
            let mut file = file.into_active_model();
            file.revision = Set(Some(2));
            file.name = Set("changed.txt".into());
            file.update(db).await.unwrap();
        }
        FinalizationTarget::Audio {
            tus_id,
            audio_id,
            name,
            recording_started_at,
            ..
        } => {
            let ingest_id = Uuid::new_v4();
            let key = format!(
                "device-audio/{}/{audio_id}/{ingest_id}",
                command.device_id
            );
            sqlx::query("insert into device_audio_ingest(id,audio_id,device_id,actor_id,tus_upload_ref,tus_upload_id,tus_owner_id,name,name_key,recording_started_at,created_at,storage_key,status,lease_token,heartbeat_at,source_size_bytes,source_sha256,duration_us,mime_type) values($1,$2,$3,$4,$5,$6,$4,$7,convert_to($7,'UTF8'),$8,clock_timestamp(),$9,'finalizing',$10,clock_timestamp(),64,$11,1000000,'audio/wav')")
                .bind(ingest_id).bind(audio_id).bind(command.device_id).bind(command.created_by_login_id)
                .bind(format!("/api/device/audio/{}/uploads/{tus_id}.64", command.device_id))
                .bind(tus_id).bind(name).bind(recording_started_at).bind(&key)
                .bind(Uuid::new_v4()).bind(vec![1_u8; 32])
                .execute(db.get_postgres_connection_pool()).await.unwrap();
            for status in ["storing", "ready"] {
                sqlx::query(
                    "update device_audio_ingest set status=$2 where id=$1",
                )
                .bind(ingest_id)
                .bind(status)
                .execute(db.get_postgres_connection_pool())
                .await
                .unwrap();
            }
            sqlx::query("insert into device_audio(id,device_id,ingest_id,name,name_key,recording_started_at,duration_us,recording_ended_at,created_at,mime_type,source_size_bytes,source_sha256,storage_key,transcription,text_version,processed,processing_version) values($1,$2,$3,$4,convert_to($4,'UTF8'),$5,1000000,$5+interval '1 second',clock_timestamp(),'audio/wav',64,$6,$7,'',$8,false,'019a0000-0000-7000-8000-000000000001')")
                .bind(audio_id).bind(command.device_id).bind(ingest_id).bind(name)
                .bind(recording_started_at).bind(vec![1_u8; 32]).bind(&key).bind(Uuid::new_v4())
                .execute(db.get_postgres_connection_pool()).await.unwrap();
            let edited = sqlx::query("update device_audio set processed=true,processing_version=$2,transcription='Edited later',text_version=$3 where id=$1")
                .bind(audio_id).bind(Uuid::new_v4()).bind(Uuid::new_v4())
                .execute(db.get_postgres_connection_pool()).await.unwrap();
            assert_eq!(edited.rows_affected(), 1);
        }
    }
}

#[actix_web::test]
#[serial_test::serial]
async fn phase4_status_http_keeps_terminal_result_after_content_edits_and_source_release(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let db = env.file_registry_db.as_ref().unwrap().connection();
    let app = app!(env);
    let cookie: Cookie<'static> = cookie!(app, fixture.actor.id);
    for kind in [
        FinalizationKind::FinalizationFileKind,
        FinalizationKind::FinalizationAudioKind,
    ] {
        let command = fixture.command(db, kind).await;
        let job = seed_job(db, &command, "completed").await;
        let response = test::call_service(
            &app,
            test::TestRequest::get()
                .uri(&path(job.id))
                .cookie(cookie.clone())
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let before: Value = test::read_body_json(response).await;
        assert_eq!(before["result"], completed_result(&command));
        edit_published_content(db, &command).await;
        let mut released = job.clone().into_active_model();
        released.source_release_state = Set("released".into());
        released.source_released_at = Set(Some(Utc::now().fixed_offset()));
        released.update(db).await.unwrap();
        let response = test::call_service(
            &app,
            test::TestRequest::get()
                .uri(&path(job.id))
                .cookie(cookie.clone())
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let after: Value = test::read_body_json(response).await;
        assert_eq!(after, before);
    }
}

#[path = "security_tests.rs"]
mod security_tests;
