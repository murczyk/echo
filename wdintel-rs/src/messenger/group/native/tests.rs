use super::*;
use crate::functest::tests::*;

fn settings(admin: &login::Model) -> NativeGroupSettings {
    NativeGroupSettings {
        name: "Група Echo".to_string(),
        color_key: None,
        short_note: Some("Коротка нотатка".to_string()),
        long_note: None,
        is_secret: true,
        user_logins: vec![admin.id.to_string()],
        organism_ids: vec![],
        admin_logins: vec![admin.id.to_string()],
        area_of_responsibility_ids: vec![],
        zone_ids: vec![],
        interseption_kind: InterseptionKind::InterseptionRer,
        disable_network_assignment: false,
        is_aviation_group: false,
        ai_transcript_analysis_enabled: None,
    }
}

#[serial]
#[tokio::test]
async fn native_group_creation_info_preserves_creator_on_replay_and_edit() {
    let env = cleanup().await.unwrap();
    let txn = env.dbx.begin().await.unwrap();
    let creator = mk_login(&txn, Default::default()).await.unwrap();
    let admin = mk_login(&txn, Default::default()).await.unwrap();
    let request = NativeGroupCreateReq {
        request_id: Uuid::new_v4().to_string(),
        settings: settings(&admin),
    };
    let group = create_group(&txn, creator.id, request.clone())
        .await
        .unwrap();
    let creation = super::super::creation::read(&txn, &group.master_key)
        .await
        .unwrap();
    assert_eq!(creation.created_by, Some(creator.login.clone()));
    let stored = signal_group::Entity::find_by_id(group.master_key.clone())
        .one(&txn)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        creation.created_at,
        stored.created_at.and_utc().timestamp_millis()
    );
    create_group(&txn, admin.id, request).await.unwrap();
    let mut settings = group.settings;
    settings.name = "Перейменована група".to_string();
    update_group(
        &txn,
        NativeGroupUpdateReq {
            master_key: group.master_key.clone(),
            settings,
        },
    )
    .await
    .unwrap();
    let after_edit = super::super::creation::read(&txn, &group.master_key)
        .await
        .unwrap();
    assert_eq!(after_edit.created_by, creation.created_by);
    assert_eq!(after_edit.created_at, creation.created_at);
    let legacy = signal_group::ActiveModel {
        master_key: Set(Uuid::new_v4().to_string()),
        name: Set(Some("Група без автора".to_string())),
        ..Default::default()
    }
    .insert(&txn)
    .await
    .unwrap();
    let legacy_info = super::super::creation::read(&txn, &legacy.master_key)
        .await
        .unwrap();
    assert_eq!(legacy_info.created_by, None);
    assert_eq!(
        legacy_info.created_at,
        legacy.created_at.and_utc().timestamp_millis()
    );
    txn.rollback().await.unwrap();
}

#[serial]
#[tokio::test]
async fn native_group_create_replay_rename_assign_and_archive_preserve_access_settings(
) {
    let env = cleanup().await.unwrap();
    let txn = env.dbx.begin().await.unwrap();
    let admin = mk_login(&txn, Default::default()).await.unwrap();
    let mut initial_settings = settings(&admin);
    initial_settings.color_key = Some(SignalGroupColor::Blue);
    let req = NativeGroupCreateReq {
        request_id: Uuid::new_v4().to_string(),
        settings: initial_settings,
    };
    let created = create_group(&txn, admin.id, req.clone()).await.unwrap();
    let mut replay = req;
    replay.settings.name = "Повторний запит не перейменовує".to_string();
    replay.settings.color_key = Some(SignalGroupColor::Red);
    let replayed = create_group(&txn, admin.id, replay).await.unwrap();
    assert_eq!(replayed.master_key, created.master_key);
    assert_eq!(replayed.settings.name, created.settings.name);
    assert_eq!(created.settings.color_key, Some(SignalGroupColor::Blue));
    assert_eq!(replayed.settings.color_key, created.settings.color_key);
    assert_eq!(replayed.settings.admin_logins, vec![admin.id.to_string()]);
    assert_eq!(replayed.settings.user_logins, vec![admin.id.to_string()]);
    assert!(created.settings.zone_ids.is_empty());
    assert!(created.settings.area_of_responsibility_ids.is_empty());
    assert_eq!(
        datasource_group::Entity::find()
            .filter(
                datasource_group::Column::GroupMasterKey
                    .eq(&created.master_key)
            )
            .count(&txn)
            .await
            .unwrap(),
        1
    );
    assert!(require_external_group(&txn, &created.master_key)
        .await
        .is_err());

    let first_zone = mk_sigint_zone(&txn, Default::default()).await.unwrap();
    let second_zone = mk_sigint_zone(&txn, Default::default()).await.unwrap();
    let aor = mk_aor(&txn, Default::default()).await.unwrap();
    let mut edited = created.settings;
    edited.name = " Перейменована група ".to_string();
    edited.color_key = Some(SignalGroupColor::Teal);
    edited.zone_ids = vec![first_zone.id, second_zone.id];
    edited.area_of_responsibility_ids = vec![aor.id];
    let updated = update_group(
        &txn,
        NativeGroupUpdateReq {
            master_key: created.master_key.clone(),
            settings: edited,
        },
    )
    .await
    .unwrap();
    assert_eq!(updated.settings.name, "Перейменована група");
    assert_eq!(updated.settings.color_key, Some(SignalGroupColor::Teal));
    assert_eq!(updated.settings.zone_ids.len(), 2);
    assert_eq!(updated.settings.admin_logins, vec![admin.id.to_string()]);
    assert_eq!(updated.settings.user_logins, vec![admin.id.to_string()]);
    let mapping = datasource_group::Entity::find()
        .filter(
            datasource_group::Column::GroupMasterKey.eq(&created.master_key),
        )
        .one(&txn)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(mapping.name, updated.settings.name);
    assert_eq!(
        mapping.datasource_id,
        native_source::load(&txn).await.unwrap().id
    );

    let mut legacy_settings = updated.settings.clone();
    legacy_settings.color_key = None;
    let legacy_updated = update_group(
        &txn,
        NativeGroupUpdateReq {
            master_key: created.master_key.clone(),
            settings: legacy_settings,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        legacy_updated.settings.color_key,
        Some(SignalGroupColor::Teal)
    );

    super::super::set_signal_group_archived(&txn, &created.master_key, true)
        .await
        .unwrap();
    let archived = detail(&txn, &created.master_key).await.unwrap();
    assert!(archived.is_archived);
    assert!(archived.settings.zone_ids.is_empty());
    assert_eq!(archived.settings.color_key, Some(SignalGroupColor::Teal));
    assert_eq!(
        archived.settings.admin_logins,
        updated.settings.admin_logins
    );
    assert!(update_group(
        &txn,
        NativeGroupUpdateReq {
            master_key: created.master_key.clone(),
            settings: updated.settings,
        }
    )
    .await
    .is_err());
    super::super::set_signal_group_archived(&txn, &created.master_key, false)
        .await
        .unwrap();
    let restored = detail(&txn, &created.master_key).await.unwrap();
    assert!(!restored.is_archived);
    assert_eq!(restored.settings.color_key, Some(SignalGroupColor::Teal));
    assert!(restored.settings.zone_ids.is_empty());
    txn.rollback().await.unwrap();
}

#[serial]
#[tokio::test]
async fn invalid_native_group_settings_do_not_leave_partial_changes() {
    let env = cleanup().await.unwrap();
    let txn = env.dbx.begin().await.unwrap();
    let admin = mk_login(&txn, Default::default()).await.unwrap();
    let request_id = Uuid::new_v4().to_string();
    let mut invalid = settings(&admin);
    invalid.user_logins.push(Uuid::new_v4().to_string());
    assert!(create_group(
        &txn,
        admin.id,
        NativeGroupCreateReq {
            request_id: request_id.clone(),
            settings: invalid,
        }
    )
    .await
    .is_err());
    let key = format!("{DATASOURCE_ECHO_NATIVE_GROUP_PREFIX}{request_id}");
    assert!(signal_group::Entity::find_by_id(key.clone())
        .one(&txn)
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        datasource_group::Entity::find()
            .filter(datasource_group::Column::GroupMasterKey.eq(&key))
            .count(&txn)
            .await
            .unwrap(),
        0
    );
    let created = create_group(
        &txn,
        admin.id,
        NativeGroupCreateReq {
            request_id,
            settings: settings(&admin),
        },
    )
    .await
    .unwrap();
    let mut invalid = created.settings.clone();
    invalid.name = "Не має зберегтись".to_string();
    invalid.admin_logins.clear();
    assert!(update_group(
        &txn,
        NativeGroupUpdateReq {
            master_key: key.clone(),
            settings: invalid,
        }
    )
    .await
    .is_err());
    assert_eq!(
        detail(&txn, &key).await.unwrap().settings.name,
        created.settings.name
    );
    assert!(zone_bl::replace_group_admin_logins(&txn, &key, vec![])
        .await
        .is_err());
    assert_eq!(
        detail(&txn, &key).await.unwrap().settings.admin_logins,
        vec![admin.id.to_string()]
    );
    txn.rollback().await.unwrap();
}

#[serial]
#[tokio::test]
async fn native_publish_acl_and_lock_exclude_concurrent_archival() {
    let mut env = cleanup().await.unwrap().as_ref().clone();
    let upload_dir = tempfile::tempdir().unwrap();
    let s3_config = crate::config::S3Config {
        s3_access_key_id: "test".into(),
        s3_secret_access_key: "test".into(),
        s3_endpoint: String::new(),
        s3_region: String::new(),
        s3_bucket: "test".into(),
        strongbox_key: crate::storage::generate_strongbox_key_b64(),
    };
    env.s3_config = Some(crate::storage::S3Config::from(&s3_config));
    env.config.s3_config = Some(s3_config);
    env.config.storage_dir = upload_dir.path().display().to_string();
    env.s3 = Some(
        opendal::Operator::new(opendal::services::Memory::default())
            .unwrap()
            .finish(),
    );
    let txn = env.dbx.begin().await.unwrap();
    let zone = mk_sigint_zone(&txn, Default::default()).await.unwrap();
    let organism = mk_organism(&txn, Default::default()).await.unwrap();
    let aor = mk_aor(&txn, Default::default()).await.unwrap();
    mk_organism_aor(
        &txn,
        organism_aor::ActiveModel {
            organism_id: Set(organism.id),
            aor_id: Set(aor.id),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let admin = mk_login(
        &txn,
        login::ActiveModel {
            organism_id: Set(Some(organism.id)),
            sigint_zone_id: Set(Some(zone.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let outsider = mk_login(
        &txn,
        login::ActiveModel {
            organism_id: Set(Some(organism.id)),
            sigint_zone_id: Set(Some(zone.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let mut settings = settings(&admin);
    settings.zone_ids = vec![zone.id];
    settings.area_of_responsibility_ids = vec![aor.id];
    let created = create_group(
        &txn,
        admin.id,
        NativeGroupCreateReq {
            request_id: Uuid::new_v4().to_string(),
            settings,
        },
    )
    .await
    .unwrap();
    txn.commit().await.unwrap();

    let tus = crate::sigint::file_upload::tus::TusHandler::new(
        env.config.storage_dir.clone(),
        crate::sigint::file_upload::TUS_PATH_BASE,
    );
    let upload = tus
        .create_completed_upload(
            &admin.id,
            crate::sigint::file_upload::tus::TusUploadMetadata {
                filename: Some("note.txt".into()),
                meta_type: Some("text/plain".into()),
                ..Default::default()
            },
            futures_util::stream::iter([Ok(
                actix_web::web::Bytes::from_static(b"native group attachment"),
            )]),
        )
        .await
        .unwrap();
    let crate::sigint::file_upload::tus::CompletedUploadWriteResult::Stored {
        upload_url,
        ..
    } = upload
    else {
        panic!("upload was not stored")
    };
    let payload = serde_json::from_value(serde_json::json!({
        "text": "Повідомлення з Echo",
        "signal_group_master_key": created.master_key,
        "upload_urls": [upload_url],
    }))
    .unwrap();
    let submitted = crate::sigint::direct_submit::bl::submit_signal_message(
        &admin.id, &env, payload,
    )
    .await
    .unwrap();
    let message =
        signal_message::Entity::find_by_id(submitted.signal_message_id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
    let mapping = datasource_group::Entity::find_by_id(
        message.datasource_group_id.unwrap(),
    )
    .one(&env.dbx)
    .await
    .unwrap()
    .unwrap();
    assert_eq!(mapping.group_master_key, created.master_key);
    assert_eq!(
        mapping.datasource_id,
        native_source::load(&env.dbx).await.unwrap().id
    );

    let media = signal_message_media::Entity::find()
        .filter(signal_message_media::Column::SignalMessageId.eq(message.id))
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(media.file_name.as_deref(), Some("note.txt"));
    assert!(media.is_encrypted);
    assert!(media.storage_key.is_some());
    crate::messenger::media::ensure_media_access(
        &env.dbx, &admin.id, message.id,
    )
    .await
    .unwrap();
    assert!(crate::messenger::media::ensure_media_access(
        &env.dbx,
        &outsider.id,
        message.id
    )
    .await
    .is_err());

    let denied = env.dbx.begin().await.unwrap();
    assert!(lock_for_publish_if_native(
        &denied,
        &created.master_key,
        &outsider.id
    )
    .await
    .is_err());
    denied.rollback().await.unwrap();
    let publishing = env.dbx.begin().await.unwrap();
    lock_for_publish_if_native(&publishing, &created.master_key, &admin.id)
        .await
        .unwrap();
    let archiving = env.dbx.begin().await.unwrap();
    archiving
        .execute_unprepared("SET LOCAL lock_timeout = '50ms'")
        .await
        .unwrap();
    assert!(super::super::set_signal_group_archived(
        &archiving,
        &created.master_key,
        true
    )
    .await
    .is_err());
    archiving.rollback().await.unwrap();
    publishing.commit().await.unwrap();
    let archiving = env.dbx.begin().await.unwrap();
    super::super::set_signal_group_archived(
        &archiving,
        &created.master_key,
        true,
    )
    .await
    .unwrap();
    archiving.commit().await.unwrap();
    let publishing = env.dbx.begin().await.unwrap();
    assert!(lock_for_publish_if_native(
        &publishing,
        &created.master_key,
        &admin.id
    )
    .await
    .is_err());
    publishing.rollback().await.unwrap();
}

#[serial]
#[actix_web::test]
async fn native_group_routes_require_system_admin_even_for_group_admin() {
    use actix_identity::{Identity, IdentityMiddleware};
    use actix_session::{storage::RedisSessionStore, SessionMiddleware};
    use actix_web::{
        cookie::Key, http::StatusCode, test, web, App, HttpMessage,
        HttpRequest, HttpResponse,
    };

    async fn test_login(
        request: HttpRequest,
        login: web::Path<String>,
    ) -> HttpResponse {
        Identity::login(&request.extensions(), login.into_inner()).unwrap();
        HttpResponse::NoContent().finish()
    }

    let env = cleanup().await.unwrap();
    let existing_login = find_test_login(&env.dbx).await.unwrap();
    let aor = find_test_aor(&env.dbx).await.unwrap();
    let source = native_source::load(&env.dbx).await.unwrap();
    let reader = mk_login(
        &env.dbx,
        login::ActiveModel {
            roles: Set(serde_json::json!(["Rer"])),
            organism_id: Set(existing_login.organism_id),
            sigint_zone_id: Set(existing_login.sigint_zone_id),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let admin = mk_login(
        &env.dbx,
        login::ActiveModel {
            roles: Set(serde_json::json!(["Admin"])),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let session =
        RedisSessionStore::new(crate::redis_conn_string(&env.config).unwrap())
            .await
            .unwrap();
    let app = test::init_service(
        App::new()
            .app_data(web::Data::from(env.clone()))
            .wrap(IdentityMiddleware::default())
            .wrap(SessionMiddleware::new(session, Key::generate()))
            .route("/test/login/{login}", web::post().to(test_login))
            .service(super::create)
            .service(super::get)
            .service(super::update)
            .service(crate::messenger::group::creation::get)
            .service(crate::datasource::datasource_group_list)
            .service(crate::messenger::group::handlers::signal_group_archive),
    )
    .await;
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&format!("/test/login/{}", admin.id))
            .to_request(),
    )
    .await;
    let admin_cookie =
        response.response().cookies().next().unwrap().into_owned();
    let req = NativeGroupCreateReq {
        request_id: Uuid::new_v4().to_string(),
        settings: settings(&reader),
    };
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/messenger/native-groups/create")
            .cookie(admin_cookie.clone())
            .set_json(&req)
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let created: NativeGroupDetail = test::read_body_json(response).await;
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/messenger/group-creation-info")
            .cookie(admin_cookie.clone())
            .set_json(&created.master_key)
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let creation: super::super::types::GroupCreationInfo =
        test::read_body_json(response).await;
    assert_eq!(creation.created_by, Some(admin.login.clone()));
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&format!("/test/login/{}", reader.id))
            .to_request(),
    )
    .await;
    let reader_cookie =
        response.response().cookies().next().unwrap().into_owned();
    macro_rules! list_groups {
        ($cookie:expr) => {{
            let response = test::call_service(
                &app,
                test::TestRequest::post()
                    .uri("/api/datasources/group-list")
                    .cookie($cookie.clone())
                    .set_json(source.id)
                    .to_request(),
            )
            .await;
            assert_eq!(response.status(), StatusCode::OK);
            test::read_body_json::<Vec<String>, _>(response).await
        }};
    }
    assert_eq!(list_groups!(admin_cookie), vec![created.master_key.clone()]);
    assert!(list_groups!(reader_cookie).is_empty());
    assert_eq!(
        signal_message_group::Entity::find()
            .filter(
                signal_message_group::Column::GroupMasterKey
                    .eq(&created.master_key)
            )
            .count(&env.dbx)
            .await
            .unwrap(),
        0
    );

    let update_req = NativeGroupUpdateReq {
        master_key: created.master_key.clone(),
        settings: created.settings.clone(),
    };
    for (path, body) in [
        (
            "/api/messenger/native-groups/create",
            serde_json::to_value(&req).unwrap(),
        ),
        (
            "/api/messenger/native-groups/get",
            serde_json::json!(created.master_key),
        ),
        (
            "/api/messenger/group-creation-info",
            serde_json::json!(created.master_key),
        ),
        (
            "/api/messenger/native-groups/update",
            serde_json::to_value(update_req).unwrap(),
        ),
        (
            "/api/rer-importer/signal-group-archive",
            serde_json::json!({"master_key": created.master_key}),
        ),
    ] {
        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri(path)
                .cookie(reader_cookie.clone())
                .set_json(body)
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "{path}");
    }

    let mut settings = created.settings;
    settings.zone_ids = vec![reader.sigint_zone_id.unwrap()];
    settings.area_of_responsibility_ids = vec![aor.id];
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/messenger/native-groups/update")
            .cookie(admin_cookie.clone())
            .set_json(NativeGroupUpdateReq {
                master_key: created.master_key.clone(),
                settings,
            })
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        list_groups!(reader_cookie),
        vec![created.master_key.clone()]
    );

    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/rer-importer/signal-group-archive")
            .cookie(admin_cookie.clone())
            .set_json(serde_json::json!({"master_key": created.master_key}))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(list_groups!(admin_cookie).is_empty());
    assert!(list_groups!(reader_cookie).is_empty());
}

#[serial]
#[tokio::test]
async fn direct_edit_preserves_native_or_external_message_origin() {
    use crate::sigint::direct_submit::bl::{
        edit_signal_message, submit_signal_message,
    };

    let env = cleanup().await.unwrap();
    let admin = find_test_login(&env.dbx).await.unwrap();
    let aor = find_test_aor(&env.dbx).await.unwrap();
    let external_key = "vukho-test-master-key";
    let mut settings = settings(&admin);
    settings.zone_ids = vec![admin.sigint_zone_id.unwrap()];
    settings.area_of_responsibility_ids = vec![aor.id];
    let txn = env.dbx.begin().await.unwrap();
    let created = create_group(
        &txn,
        admin.id,
        NativeGroupCreateReq {
            request_id: Uuid::new_v4().to_string(),
            settings,
        },
    )
    .await
    .unwrap();
    txn.commit().await.unwrap();
    let payload = |key: Option<&str>, text: &str| {
        serde_json::from_value(serde_json::json!({
            "text": text, "signal_group_master_key": key,
        }))
        .unwrap()
    };
    let external = submit_signal_message(
        &admin.id,
        &env,
        payload(Some(external_key), "external original"),
    )
    .await
    .unwrap();
    let native = submit_signal_message(
        &admin.id,
        &env,
        payload(Some(&created.master_key), "native original"),
    )
    .await
    .unwrap();
    for (message_id, destination) in [
        (
            external.signal_message_id,
            Some(created.master_key.as_str()),
        ),
        (native.signal_message_id, Some(external_key)),
        (native.signal_message_id, None),
    ] {
        assert!(edit_signal_message(
            &admin.id,
            &env,
            message_id,
            payload(destination, "must not persist")
        )
        .await
        .is_err());
    }
    let mut copied = crate::sigint::direct_submit::bl::copy_signal_messages(
        &admin.id,
        &env,
        vec![external.signal_message_id],
    )
    .await
    .unwrap()
    .payloads
    .remove(0);
    copied.signal_group_master_key = Some(created.master_key.clone());
    let copied = submit_signal_message(&admin.id, &env, copied)
        .await
        .unwrap();
    assert_ne!(copied.signal_message_id, external.signal_message_id);
    for (message_id, expected) in [
        (external.signal_message_id, "external original"),
        (native.signal_message_id, "native original"),
    ] {
        let message = signal_message::Entity::find_by_id(message_id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(message.body.as_deref(), Some(expected));
    }
    edit_signal_message(
        &admin.id,
        &env,
        native.signal_message_id,
        payload(Some(&created.master_key), "native edited"),
    )
    .await
    .unwrap();
    edit_signal_message(
        &admin.id,
        &env,
        external.signal_message_id,
        payload(Some(external_key), "external edited"),
    )
    .await
    .unwrap();
}
