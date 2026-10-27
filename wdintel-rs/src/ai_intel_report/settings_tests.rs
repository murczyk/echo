use crate::entities::login;
use actix_identity::{Identity, IdentityMiddleware};
use actix_session::{storage::RedisSessionStore, SessionMiddleware};
use actix_web::{
    cookie::Key, http::StatusCode, test, web, App, HttpMessage, HttpRequest,
    HttpResponse,
};
use sea_orm::Set;
use sea_orm::{ActiveModelTrait, IntoActiveModel};

async fn sign_in(
    request: HttpRequest,
    login: web::Path<String>,
) -> HttpResponse {
    Identity::login(&request.extensions(), login.into_inner()).unwrap();
    HttpResponse::NoContent().finish()
}

#[actix_web::test]
#[serial_test::serial]
async fn generation_settings_persist_validate_and_require_admin() {
    let (env, _guard) = crate::functest::tests::cleanup_locked().await.unwrap();
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
            .service(super::get_settings)
            .service(super::save_settings)
            .service(super::list_attempts),
    )
    .await;
    let primary =
        super::tests::engine_record("http://127.0.0.1:8000/v1".into())
            .into_active_model()
            .insert(&env.dbx)
            .await
            .unwrap();
    let fallback =
        super::tests::engine_record("http://127.0.0.1:8001/v1".into())
            .into_active_model()
            .insert(&env.dbx)
            .await
            .unwrap();
    let defaults = super::load_settings_item(&env.dbx).await.unwrap();
    assert_eq!(defaults.total_timeout_secs, 20);
    assert_eq!(defaults.primary_timeout_secs, 20);
    assert_eq!(defaults.fallback_timeout_secs, 20);
    assert!(defaults
        .engine_budgets
        .iter()
        .all(|budget| budget.max_tokens == 512));
    let settings_uri = "/api/admin/ai-intel-report/settings";
    let req = serde_json::json!({
        "quickSuggestionEnabled": true,
        "quickAiEngineId": primary.id.to_string(),
        "fallbackAiEngineId": fallback.id.to_string(),
        "engineBudgets": [
            {"aiEngineId": primary.id.to_string(), "maxTokens": 1024},
            {"aiEngineId": fallback.id.to_string(), "maxTokens": 2048}
        ],
        "primaryTimeoutSecs": 5,
        "fallbackTimeoutSecs": 10,
        "totalTimeoutSecs": 15
    });
    let anonymous = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(settings_uri)
            .set_json(&req)
            .to_request(),
    )
    .await;
    assert!(!anonymous.status().is_success());
    for (role, allowed) in [("Rer", false), ("Admin", true)] {
        let actor = crate::functest::tests::mk_login(
            &env.dbx,
            login::ActiveModel {
                roles: Set(serde_json::json!([role])),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri(&format!("/test/login/{}", actor.id))
                .to_request(),
        )
        .await;
        let cookie = response.response().cookies().next().unwrap().into_owned();
        for (method, uri) in [
            ("GET", settings_uri),
            ("POST", settings_uri),
            ("POST", "/api/admin/ai-intel-report/attempts/list"),
        ] {
            let response = test::call_service(
                &app,
                test::TestRequest::default()
                    .method(method.parse().unwrap())
                    .uri(uri)
                    .cookie(cookie.clone())
                    .set_json(&req)
                    .to_request(),
            )
            .await;
            if !allowed {
                assert_eq!(response.status(), StatusCode::FORBIDDEN);
            } else {
                assert!(response.status().is_success());
            }
        }
        if !allowed {
            continue;
        }
        let saved = super::load_settings_item(&env.dbx).await.unwrap();
        assert_eq!(saved.primary_timeout_secs, 5);
        assert_eq!(saved.fallback_timeout_secs, 10);
        assert_eq!(saved.total_timeout_secs, 15);
        assert_eq!(saved.fallback_ai_engine_id, Some(fallback.id.to_string()));
        assert_eq!(
            super::settings::load_engine_budget(&env.dbx, primary.id)
                .await
                .unwrap(),
            1024
        );
        assert_eq!(
            super::settings::load_engine_budget(&env.dbx, fallback.id)
                .await
                .unwrap(),
            2048
        );
        assert!(super::ensure_engine_not_used(&env.dbx, primary.id)
            .await
            .is_err());
        assert!(super::ensure_engine_not_used(&env.dbx, fallback.id)
            .await
            .is_err());
        for invalid in [
            serde_json::json!({"engineBudgets": [{"aiEngineId": primary.id.to_string(), "maxTokens": 0}]}),
            serde_json::json!({"engineBudgets": [{"aiEngineId": primary.id.to_string(), "maxTokens": 32769}]}),
            serde_json::json!({"engineBudgets": [{"aiEngineId": uuid::Uuid::now_v7().to_string(), "maxTokens": 512}]}),
            serde_json::json!({"engineBudgets": [
                {"aiEngineId": primary.id.to_string(), "maxTokens": 512},
                {"aiEngineId": primary.id.to_string(), "maxTokens": 1024}
            ]}),
            serde_json::json!({"primaryTimeoutSecs": 0}),
            serde_json::json!({"fallbackTimeoutSecs": 181}),
            serde_json::json!({"totalTimeoutSecs": 181}),
            serde_json::json!({"fallbackAiEngineId": primary.id.to_string()}),
        ] {
            let mut invalid_req = req.clone();
            invalid_req
                .as_object_mut()
                .unwrap()
                .extend(invalid.as_object().unwrap().clone());
            let response = test::call_service(
                &app,
                test::TestRequest::post()
                    .uri(settings_uri)
                    .cookie(cookie.clone())
                    .set_json(&invalid_req)
                    .to_request(),
            )
            .await;
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
            assert_eq!(
                super::load_settings_item(&env.dbx).await.unwrap(),
                saved
            );
        }
        let response = test::call_service(
            &app,
            test::TestRequest::post().uri(settings_uri).cookie(cookie)
                .set_json(serde_json::json!({"quickSuggestionEnabled": false, "quickAiEngineId": null}))
                .to_request(),
        )
        .await;
        assert!(response.status().is_success());
        let preserved: super::types::AiIntelReportSettingsItem =
            test::read_body_json(response).await;
        assert_eq!(preserved.engine_budgets, saved.engine_budgets);
        assert_eq!(preserved.primary_timeout_secs, saved.primary_timeout_secs);
        assert_eq!(
            preserved.fallback_timeout_secs,
            saved.fallback_timeout_secs
        );
        assert_eq!(preserved.total_timeout_secs, saved.total_timeout_secs);
        assert_eq!(
            preserved.fallback_ai_engine_id,
            saved.fallback_ai_engine_id
        );
    }
}
