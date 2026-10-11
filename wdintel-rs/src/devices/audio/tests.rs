use super::*;
use crate::devices::tests::schema::device_active_model;
use crate::entities::{device, login, organism, system_settings};
use crate::functest::tests::{cleanup_locked, mk_login, mk_organism};
use actix_web::{http::StatusCode, ResponseError};
use sea_orm::{ActiveModelTrait, IntoActiveModel, Set};
use serde_json::json;

#[actix_web::test]
#[serial_test::serial]
async fn audio_list_keyset_scopes_and_preserves_microseconds() {
    use super::acceptance_tests::{
        enabled_audio_device, native_audio_bytes, receive_command,
    };
    use super::types::*;
    use crate::file_registry::entities::device_audio;
    use sea_orm::{EntityTrait, QueryOrder};
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor_id, device_id) = enabled_audio_device(&env).await;
    let bytes = native_audio_bytes().await;
    let db = env.device_audio.file_database().unwrap();
    for index in 0..61 {
        let mut command = receive_command(
            &env.device_audio,
            actor_id,
            device_id,
            &format!("ordered-{index}"),
            bytes.clone(),
        )
        .await;
        command.recording_started_at +=
            chrono::Duration::microseconds(index / 2);
        let ReceiveDeviceAudioOutcome::Accepted(response) =
            receive(&env.device_audio, actor_id, command).await.unwrap()
        else {
            panic!("new audio must be accepted")
        };
        assert_eq!(response.audio.name, format!("ordered-{index}"));
        let audio = device_audio::Entity::find_by_id(
            Uuid::parse_str(&response.audio.id).unwrap(),
        )
        .one(db)
        .await
        .unwrap()
        .unwrap();
        let mut audio = audio.into_active_model();
        audio.processed = Set(index % 3 == 0);
        audio.transcription = Set("\n Літеральний  текст \n".into());
        audio.update(db).await.unwrap();
    }
    let expected = device_audio::Entity::find()
        .order_by_desc(device_audio::Column::RecordingStartedAt)
        .order_by_desc(device_audio::Column::Id)
        .all(db)
        .await
        .unwrap();
    let expected_ids: Vec<_> =
        expected.iter().map(|audio| audio.id.to_string()).collect();
    let no_s3 = build_runtime(
        &env.config,
        &env.dbx,
        env.file_registry_db.as_ref(),
        None,
        env.metrics.clone(),
    );
    let command = ListDeviceAudioCommand {
        device_id,
        unprocessed_only: false,
        limit: 50,
        cursor: None,
    };
    let first = list(&no_s3, actor_id, command.clone()).await.unwrap();
    assert_eq!(first.audio.len(), 50);
    assert_eq!(first.audio[0].name, expected[0].name);
    assert!(first.next_cursor.is_some());
    assert_eq!(
        first.audio[0].recording_started_at,
        expected[0]
            .recording_started_at
            .with_timezone(&chrono::Utc)
            .to_rfc3339_opts(chrono::SecondsFormat::Micros, true)
    );
    let cursor = first.next_cursor.clone().unwrap();
    use sea_orm::{DbBackend, QueryTrait};
    let boundary = cursor::decode(&ListDeviceAudioCommand {
        cursor: Some(cursor.clone()),
        ..command.clone()
    })
    .unwrap()
    .unwrap();
    let mut queries = serde_json::Map::new();
    for (label, unprocessed_only, boundary) in [
        ("all-first", false, None),
        ("all-seek", false, Some(&boundary)),
        ("unprocessed-seek", true, Some(&boundary)),
    ] {
        let command = ListDeviceAudioCommand {
            unprocessed_only,
            ..command.clone()
        };
        queries.insert(
            label.into(),
            json!(query::page_query(&command, boundary)
                .build(DbBackend::Postgres)
                .to_string()),
        );
    }
    std::fs::write(
        std::path::Path::new(&std::env::var("AUDIO_TEST_ROOT").unwrap())
            .join("audio-list-queries.json"),
        serde_json::to_vec(
            &json!({"device_id": device_id, "queries": queries}),
        )
        .unwrap(),
    )
    .unwrap();
    let mut page = ListDeviceAudioCommand {
        limit: 7,
        ..command.clone()
    };
    let mut visited_ids = Vec::new();
    loop {
        let response = list(&no_s3, actor_id, page.clone()).await.unwrap();
        visited_ids.extend(response.audio.into_iter().map(|audio| audio.id));
        let Some(cursor) = response.next_cursor else {
            break;
        };
        page.cursor = Some(cursor);
    }
    let unique_ids: std::collections::HashSet<_> = visited_ids.iter().collect();
    assert_eq!(visited_ids.len(), unique_ids.len());
    assert_eq!(visited_ids, expected_ids);
    let unprocessed = list(
        &no_s3,
        actor_id,
        ListDeviceAudioCommand {
            unprocessed_only: true,
            limit: 200,
            ..command.clone()
        },
    )
    .await
    .unwrap();
    assert_eq!(unprocessed.audio.len(), 40);
    assert!(unprocessed.audio.iter().all(|audio| !audio.processed));
    let actor = login::Entity::find_by_id(actor_id)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    let empty_device =
        audio_device(&env.dbx, &actor, actor.organism_id.unwrap(), false).await;
    assert!(list(
        &no_s3,
        actor_id,
        ListDeviceAudioCommand {
            device_id: empty_device.id,
            ..command.clone()
        }
    )
    .await
    .unwrap()
    .audio
    .is_empty());
    for invalid in [
        ListDeviceAudioCommand {
            device_id: empty_device.id,
            cursor: Some(cursor.clone()),
            ..command.clone()
        },
        ListDeviceAudioCommand {
            unprocessed_only: true,
            cursor: Some(cursor.clone()),
            ..command.clone()
        },
        ListDeviceAudioCommand {
            cursor: Some("malformed".into()),
            ..command.clone()
        },
        ListDeviceAudioCommand {
            limit: 0,
            ..command.clone()
        },
        ListDeviceAudioCommand {
            limit: 201,
            ..command.clone()
        },
    ] {
        assert_status(
            list(&no_s3, actor_id, invalid).await,
            StatusCode::BAD_REQUEST,
        );
    }
    use base64::Engine;
    let decoded: serde_json::Value = serde_json::from_slice(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(cursor)
            .unwrap(),
    )
    .unwrap();
    for (field, value) in [
        ("version", json!(255)),
        ("id", json!("invalid")),
        ("start_us", json!(i64::MIN)),
        ("extra", json!(true)),
    ] {
        let mut invalid = decoded.clone();
        invalid[field] = value;
        let cursor = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&invalid).unwrap());
        assert_status(
            list(
                &no_s3,
                actor_id,
                ListDeviceAudioCommand {
                    cursor: Some(cursor),
                    ..command.clone()
                },
            )
            .await,
            StatusCode::BAD_REQUEST,
        );
    }
    let missing_files =
        build_runtime(&env.config, &env.dbx, None, None, env.metrics.clone());
    assert_status(
        list(&missing_files, actor_id, command.clone()).await,
        StatusCode::SERVICE_UNAVAILABLE,
    );
    let mut actor = actor.into_active_model();
    actor.roles = Set(json!([]));
    actor.update(&env.dbx).await.unwrap();
    assert_status(list(&no_s3, actor_id, page).await, StatusCode::FORBIDDEN);
}

#[actix_web::test]
#[serial_test::serial]
async fn audio_detail_keeps_manual_metadata_during_storage_outage() {
    use super::acceptance_tests::{
        enabled_audio_device, native_audio_bytes, receive_command,
    };
    use super::types::*;
    use crate::file_registry::entities::device_audio;
    use sea_orm::EntityTrait;
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor_id, device_id) = enabled_audio_device(&env).await;
    let command = receive_command(
        &env.device_audio,
        actor_id,
        device_id,
        "detail",
        native_audio_bytes().await,
    )
    .await;
    let ReceiveDeviceAudioOutcome::Accepted(response) =
        receive(&env.device_audio, actor_id, command).await.unwrap()
    else {
        panic!("new audio must be accepted")
    };
    let audio_id = Uuid::parse_str(&response.audio.id).unwrap();
    let mut audio = device_audio::Entity::find_by_id(audio_id)
        .one(env.device_audio.file_database().unwrap())
        .await
        .unwrap()
        .unwrap()
        .into_active_model();
    audio.transcription = Set(" \n буквальний текст  \n ".into());
    let audio = audio
        .update(env.device_audio.file_database().unwrap())
        .await
        .unwrap();
    let no_s3 = build_runtime(
        &env.config,
        &env.dbx,
        env.file_registry_db.as_ref(),
        None,
        env.metrics.clone(),
    );
    let command = DeviceAudioDetailCommand {
        device_id,
        audio_id,
    };
    let response = detail(&no_s3, actor_id, command.clone()).await.unwrap();
    assert_eq!(response.audio.name, audio.name);
    assert_eq!(response.transcription.text, audio.transcription);
    assert_eq!(
        response.transcription.text_version,
        audio.text_version.to_string()
    );
    assert!(response.can_edit);
    assert_status(
        detail(
            &no_s3,
            actor_id,
            DeviceAudioDetailCommand {
                audio_id: Uuid::new_v4(),
                ..command.clone()
            },
        )
        .await,
        StatusCode::NOT_FOUND,
    );
    let actor = login::Entity::find_by_id(actor_id)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    let other =
        audio_device(&env.dbx, &actor, actor.organism_id.unwrap(), false).await;
    assert_status(
        detail(
            &no_s3,
            actor_id,
            DeviceAudioDetailCommand {
                device_id: other.id,
                ..command.clone()
            },
        )
        .await,
        StatusCode::NOT_FOUND,
    );
    let mut device = device::Entity::find_by_id(device_id)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap()
        .into_active_model();
    device.archived = Set(true);
    device.archived_at = Set(Some(chrono::Utc::now().naive_utc()));
    device.update(&env.dbx).await.unwrap();
    assert!(
        !detail(&no_s3, actor_id, command.clone())
            .await
            .unwrap()
            .can_edit
    );
    let basic_actor =
        audio_actor(&env.dbx, actor.organism_id.unwrap(), &["Basic"]).await;
    assert_status(
        detail(&no_s3, basic_actor.id, command).await,
        StatusCode::FORBIDDEN,
    );
}

#[tokio::test]
#[serial_test::serial]
async fn audio_access_role_org_archive_matrix() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let mut settings = system_settings::ActiveModel {
        devices_section_enabled: Set(true),
        ..Default::default()
    }
    .insert(&env.dbx)
    .await
    .unwrap()
    .into_active_model();
    let runtime = build_runtime(
        &env.config,
        &env.dbx,
        env.file_registry_db.as_ref(),
        None,
        env.metrics.clone(),
    );
    let parent = audio_organism(&env.dbx, None).await;
    let child = audio_organism(&env.dbx, Some(parent.id)).await;
    let foreign = audio_organism(&env.dbx, None).await;
    let creator = audio_actor(&env.dbx, parent.id, &["Admin"]).await;
    let active = audio_device(&env.dbx, &creator, child.id, false).await;
    let parent_device =
        audio_device(&env.dbx, &creator, parent.id, false).await;
    let archived = audio_device(&env.dbx, &creator, child.id, true).await;
    let foreign_device =
        audio_device(&env.dbx, &creator, foreign.id, false).await;

    for (roles, source, read, edit) in [
        (vec!["Cyber"], true, true, true),
        (vec!["Admin"], true, true, true),
        (vec!["Api", "Cyber"], true, true, true),
        (vec!["Rer"], false, false, false),
        (vec!["Full"], false, false, false),
        (vec!["Basic"], false, false, false),
        (vec!["ApiAgent"], false, false, false),
        (vec!["DeviceSource"], false, false, false),
        (vec!["CyberViewer"], false, true, false),
        (vec!["Api"], false, false, false),
        (vec![], false, false, false),
    ] {
        let actor = audio_actor(&env.dbx, parent.id, &roles).await;
        assert_eq!(
            authorize_source(&runtime, actor.id, active.id)
                .await
                .is_ok(),
            source,
            "source {roles:?}"
        );
        assert_eq!(
            authorize_read(&runtime, actor.id, active.id).await.is_ok(),
            read,
            "read {roles:?}"
        );
        assert_eq!(
            authorize_edit(&runtime, actor.id, active.id).await.is_ok(),
            edit,
            "edit {roles:?}"
        );
        if read {
            assert!(authorize_read(&runtime, actor.id, archived.id)
                .await
                .is_ok());
            assert_status(
                authorize_edit(&runtime, actor.id, archived.id).await,
                StatusCode::FORBIDDEN,
            );
            assert_status(
                authorize_read(&runtime, actor.id, foreign_device.id).await,
                StatusCode::NOT_FOUND,
            );
            assert_status(
                authorize_read(&runtime, actor.id, Uuid::new_v4()).await,
                StatusCode::NOT_FOUND,
            );
            let child_actor = audio_actor(&env.dbx, child.id, &roles).await;
            assert!(authorize_read(&runtime, child_actor.id, active.id)
                .await
                .is_ok());
            assert_status(
                authorize_read(&runtime, child_actor.id, parent_device.id)
                    .await,
                StatusCode::NOT_FOUND,
            );
        } else {
            assert_status(
                authorize_read(&runtime, actor.id, active.id).await,
                StatusCode::FORBIDDEN,
            );
            assert_status(
                authorize_edit(&runtime, actor.id, active.id).await,
                StatusCode::FORBIDDEN,
            );
        }
        if source {
            assert_status(
                authorize_source(&runtime, actor.id, archived.id).await,
                StatusCode::FORBIDDEN,
            );
            assert_status(
                authorize_source(&runtime, actor.id, foreign_device.id).await,
                StatusCode::NOT_FOUND,
            );
        }
    }
    let foreign_admin = audio_actor(&env.dbx, foreign.id, &["Admin"]).await;
    assert_status(
        authorize_read(&runtime, foreign_admin.id, active.id).await,
        StatusCode::NOT_FOUND,
    );
    assert_status(
        authorize_read(&runtime, Uuid::new_v4(), active.id).await,
        StatusCode::UNAUTHORIZED,
    );
    settings.devices_section_enabled = Set(false);
    settings.update(&env.dbx).await.unwrap();
    for access in [
        bl::AudioAccess::Read,
        bl::AudioAccess::Source,
        bl::AudioAccess::Edit,
    ] {
        assert_status(
            bl::authorize(&runtime, creator.id, active.id, access).await,
            StatusCode::FORBIDDEN,
        );
    }
}

pub(super) fn assert_status<T: std::fmt::Debug>(
    result: anyhow::Result<T>,
    status: StatusCode,
) {
    let error = AppError::from(result.unwrap_err());
    assert_eq!(error.error_response().status(), status, "{error:?}");
}

pub(super) async fn audio_organism(
    dbx: &DatabaseConnection,
    parent_id: Option<i64>,
) -> organism::Model {
    mk_organism(
        dbx,
        organism::ActiveModel {
            parent_id: Set(parent_id),
            ..Default::default()
        },
    )
    .await
    .unwrap()
}

pub(super) async fn audio_actor(
    dbx: &DatabaseConnection,
    organism_id: i64,
    roles: &[&str],
) -> login::Model {
    mk_login(
        dbx,
        login::ActiveModel {
            login: Set(format!("device-audio-{}", Uuid::new_v4())),
            organism_id: Set(Some(organism_id)),
            roles: Set(json!(roles)),
            ..Default::default()
        },
    )
    .await
    .unwrap()
}

pub(super) async fn audio_device(
    dbx: &DatabaseConnection,
    actor: &login::Model,
    organism_id: i64,
    archived: bool,
) -> device::Model {
    device_active_model(
        &actor.login,
        organism_id,
        None,
        json!({}),
        archived,
        archived.then(|| chrono::Utc::now().naive_utc()),
    )
    .insert(dbx)
    .await
    .unwrap()
}

#[tokio::test]
#[serial_test::serial]
async fn audio_runtime_without_optional_storage_keeps_database_capability() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let mut config = env.config.clone();
    config.s3_config = None;
    let runtime = build_runtime(
        &config,
        &env.dbx,
        env.file_registry_db.as_ref(),
        None,
        env.metrics.clone(),
    );
    runtime.file_database().unwrap().ping().await.unwrap();
    assert!(runtime.byte_store().is_err());
    env.device_audio
        .file_database()
        .unwrap()
        .ping()
        .await
        .unwrap();
    config.s3_config = Some(crate::config::S3Config {
        s3_access_key_id: "test".to_string(),
        s3_secret_access_key: "test".to_string(),
        s3_endpoint: "http://127.0.0.1:1".to_string(),
        s3_region: "us-east-1".to_string(),
        s3_bucket: "device-audio-test".to_string(),
        strongbox_key: String::new(),
    });
    let storage = opendal::Operator::new(opendal::services::Memory::default())
        .unwrap()
        .finish();
    let missing_key = build_runtime(
        &config,
        &env.dbx,
        env.file_registry_db.as_ref(),
        Some(&storage),
        env.metrics.clone(),
    );
    missing_key.file_database().unwrap().ping().await.unwrap();
    assert!(missing_key.byte_store().is_err());
    let unavailable =
        build_runtime(&config, &env.dbx, None, None, env.metrics.clone());
    let error = AppError::from(unavailable.file_database().unwrap_err());
    assert_eq!(
        error.error_response().status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
}
