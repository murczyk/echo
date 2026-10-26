use super::*;
use actix_identity::IdentityMiddleware;
use actix_session::{storage::RedisSessionStore, SessionMiddleware};
use actix_web::{
    cookie::Key, test, web, App, HttpMessage, HttpRequest, HttpResponse,
};
use echo_migration::{MigratorTrait, SchemaManager};
use sea_orm::ConnectionTrait;
use serial_test::serial;

async fn sign_in(
    request: HttpRequest,
    login: web::Path<String>,
) -> HttpResponse {
    Identity::login(&request.extensions(), login.into_inner()).unwrap();
    HttpResponse::NoContent().finish()
}

#[actix_web::test]
#[serial]
async fn issue_3620_migration_enables_existing_users_and_preserves_later_opt_outs(
) {
    let env = crate::functest::tests::cleanup().await.unwrap();
    let sessions =
        RedisSessionStore::new(crate::redis_conn_string(&env.config).unwrap())
            .await
            .unwrap();
    let app = test::init_service(
        App::new()
            .app_data(Data::from(env.clone()))
            .wrap(IdentityMiddleware::default())
            .wrap(SessionMiddleware::new(sessions, Key::generate()))
            .route("/test/login/{login}", web::post().to(sign_in))
            .service(user_settings_get)
            .service(user_settings_put),
    )
    .await;
    let mut cookies = Vec::new();
    for value in [Some(false), Some(true), None] {
        let login = crate::functest::tests::mk_login(
            &env.dbx,
            login::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        env.dbx.execute_raw(sea_orm::Statement::from_sql_and_values(
            sea_orm::DbBackend::Postgres,
            "insert into user_settings (login_id, message_auto_parse_enabled) values ($1, $2)",
            vec![login.id.into(), value.into()],
        )).await.unwrap();
        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri(&format!("/test/login/{}", login.id))
                .to_request(),
        )
        .await;
        cookies
            .push(response.response().cookies().next().unwrap().into_owned());
    }
    let migration = echo_migration::Migrator::migrations()
        .into_iter()
        .find(|migration| {
            migration.name().ends_with("_enable_message_auto_parse")
        })
        .unwrap();
    let manager = SchemaManager::new(&env.dbx);
    migration.up(&manager).await.unwrap();
    assert!(user_settings::Entity::find()
        .all(&env.dbx)
        .await
        .unwrap()
        .iter()
        .all(|settings| settings.message_auto_parse_enabled == Some(true)));
    let login = crate::functest::tests::mk_login(
        &env.dbx,
        login::ActiveModel {
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&format!("/test/login/{}", login.id))
            .to_request(),
    )
    .await;
    cookies.push(response.response().cookies().next().unwrap().into_owned());
    for cookie in cookies {
        let settings: UserDutySettingsDto = test::call_and_read_body_json(
            &app,
            test::TestRequest::get()
                .uri("/api/user/settings")
                .cookie(cookie.clone())
                .to_request(),
        )
        .await;
        assert!(settings.message_auto_parse_enabled);
        let mut settings = serde_json::to_value(settings).unwrap();
        settings["messageAutoParseEnabled"] = false.into();
        let saved: UserDutySettingsDto = test::call_and_read_body_json(
            &app,
            test::TestRequest::put()
                .uri("/api/user/settings")
                .cookie(cookie.clone())
                .set_json(&settings)
                .to_request(),
        )
        .await;
        assert!(!saved.message_auto_parse_enabled);
        settings
            .as_object_mut()
            .unwrap()
            .remove("messageAutoParseEnabled");
        settings["tagsLayout"] = "hidden".into();
        let saved: UserDutySettingsDto = test::call_and_read_body_json(
            &app,
            test::TestRequest::put()
                .uri("/api/user/settings")
                .cookie(cookie.clone())
                .set_json(&settings)
                .to_request(),
        )
        .await;
        assert!(!saved.message_auto_parse_enabled);
        assert_eq!(saved.tags_layout, DutyTagsLayout::Hidden);
        migration.down(&manager).await.unwrap();
        let settings: UserDutySettingsDto = test::call_and_read_body_json(
            &app,
            test::TestRequest::get()
                .uri("/api/user/settings")
                .cookie(cookie)
                .to_request(),
        )
        .await;
        assert!(!settings.message_auto_parse_enabled);
    }
    env.dbx.execute_raw(sea_orm::Statement::from_sql_and_values(sea_orm::DbBackend::Postgres, "update user_settings set message_auto_parse_enabled = null where login_id = $1", vec![login.id.into()])).await.unwrap();
    let row = user_settings::Entity::find()
        .filter(user_settings::Column::LoginId.eq(login.id))
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    assert!(model_to_dto(&row).message_auto_parse_enabled);
}

#[actix_web::test]
#[serial]
async fn settings_opt_ins_survive_older_clients_3064_3324() {
    let env = crate::functest::tests::cleanup().await.unwrap();
    let login = crate::functest::tests::find_test_login(&env.dbx)
        .await
        .unwrap();
    let sessions =
        RedisSessionStore::new(crate::redis_conn_string(&env.config).unwrap())
            .await
            .unwrap();
    let app = test::init_service(
        App::new()
            .app_data(Data::from(env.clone()))
            .wrap(IdentityMiddleware::default())
            .wrap(SessionMiddleware::new(sessions, Key::generate()))
            .route("/test/login/{login}", web::post().to(sign_in))
            .service(user_settings_get)
            .service(user_settings_put),
    )
    .await;
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&format!("/test/login/{}", login.id))
            .to_request(),
    )
    .await;
    let cookie = response.response().cookies().next().unwrap().into_owned();
    user_settings::Entity::insert(user_settings::ActiveModel {
        login_id: Set(login.id),
        ..Default::default()
    })
    .exec(&env.dbx)
    .await
    .unwrap();
    let settings: UserDutySettingsDto = test::call_and_read_body_json(
        &app,
        test::TestRequest::get()
            .uri("/api/user/settings")
            .cookie(cookie.clone())
            .to_request(),
    )
    .await;
    assert!(!settings.ai_position_highlights_enabled);
    assert!(!settings.large_media_previews);
    let mut settings = serde_json::to_value(settings).unwrap();
    settings["aiPositionHighlightsEnabled"] = true.into();
    settings["largeMediaPreviews"] = true.into();
    let saved: UserDutySettingsDto = test::call_and_read_body_json(
        &app,
        test::TestRequest::put()
            .uri("/api/user/settings")
            .cookie(cookie.clone())
            .set_json(&settings)
            .to_request(),
    )
    .await;
    assert!(saved.ai_position_highlights_enabled);
    assert!(saved.large_media_previews);
    settings
        .as_object_mut()
        .unwrap()
        .remove("aiPositionHighlightsEnabled");
    settings
        .as_object_mut()
        .unwrap()
        .remove("largeMediaPreviews");
    settings["tagsLayout"] = "hidden".into();
    let saved: UserDutySettingsDto = test::call_and_read_body_json(
        &app,
        test::TestRequest::put()
            .uri("/api/user/settings")
            .cookie(cookie.clone())
            .set_json(&settings)
            .to_request(),
    )
    .await;
    assert!(saved.ai_position_highlights_enabled);
    assert!(saved.large_media_previews);
    assert_eq!(saved.tags_layout, DutyTagsLayout::Hidden);
    settings["aiPositionHighlightsEnabled"] = false.into();
    settings["largeMediaPreviews"] = false.into();
    let _: UserDutySettingsDto = test::call_and_read_body_json(
        &app,
        test::TestRequest::put()
            .uri("/api/user/settings")
            .cookie(cookie.clone())
            .set_json(&settings)
            .to_request(),
    )
    .await;
    let settings: UserDutySettingsDto = test::call_and_read_body_json(
        &app,
        test::TestRequest::get()
            .uri("/api/user/settings")
            .cookie(cookie)
            .to_request(),
    )
    .await;
    assert!(!settings.ai_position_highlights_enabled);
    assert!(!settings.large_media_previews);
}
