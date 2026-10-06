use super::gov;
use super::types::SaveAiGovUaSettingsReq;
use crate::entities::login;
use crate::functest::tests::{cleanup_locked, mk_login};
use actix_identity::{Identity, IdentityMiddleware};
use actix_session::{storage::RedisSessionStore, SessionMiddleware};
use actix_web::{
    cookie::Key, test, web, App, HttpMessage, HttpRequest, HttpResponse,
};
use sea_orm::Set;
use serial_test::serial;

async fn sign_in(
    request: HttpRequest,
    login: web::Path<String>,
) -> HttpResponse {
    Identity::login(&request.extensions(), login.into_inner()).unwrap();
    HttpResponse::NoContent().finish()
}

// Regression: https://github.com/echoua/echo/issues/3682
#[actix_web::test]
#[serial]
async fn provider_settings_and_discovery_require_admin() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let sessions =
        RedisSessionStore::new(crate::redis_conn_string(&env.config).unwrap())
            .await
            .unwrap();
    let app = test::init_service(
        App::new()
            .app_data(web::Data::from(env.clone()))
            .wrap(IdentityMiddleware::default())
            .wrap(SessionMiddleware::new(sessions, Key::generate()))
            .route("/test/login/{login}", web::post().to(sign_in))
            .service(gov::get_settings)
            .service(gov::save_settings)
            .service(gov::list_models)
            .service(gov::check_models),
    )
    .await;
    let req = SaveAiGovUaSettingsReq {
        enabled: false,
        tenant_id: String::new(),
        client_id: String::new(),
        scope: String::new(),
        client_secret: None,
        clear_client_secret: false,
    };
    let regular = mk_login(
        &env.dbx,
        login::ActiveModel {
            roles: Set(serde_json::json!(["Rer"])),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&format!("/test/login/{}", regular.id))
            .to_request(),
    )
    .await;
    let cookie = response.response().cookies().next().unwrap().into_owned();
    for path in ["settings", "save", "models", "check"] {
        let uri = format!("/api/admin/ai-engines/gov/{path}");
        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri(&uri)
                .set_json(&req)
                .to_request(),
        )
        .await;
        assert!(!response.status().is_success());
        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri(&uri)
                .cookie(cookie.clone())
                .set_json(&req)
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), actix_web::http::StatusCode::FORBIDDEN);
    }
    let admin = mk_login(
        &env.dbx,
        login::ActiveModel {
            roles: Set(serde_json::json!(["Admin"])),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&format!("/test/login/{}", admin.id))
            .to_request(),
    )
    .await;
    let cookie = response.response().cookies().next().unwrap().into_owned();
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/admin/ai-engines/gov/settings")
            .cookie(cookie.clone())
            .to_request(),
    )
    .await;
    assert!(response.status().is_success());
    let body: serde_json::Value = test::read_body_json(response).await;
    assert!(body.get("clientSecret").is_none());
    assert!(body.get("clientSecretEncrypted").is_none());
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/admin/ai-engines/gov/check")
            .cookie(cookie)
            .set_json(&req)
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), actix_web::http::StatusCode::BAD_REQUEST);
    let body = test::read_body(response).await;
    assert!(std::str::from_utf8(&body).unwrap().contains("Tenant ID"));
}
