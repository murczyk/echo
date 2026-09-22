use super::*;
use crate::entities::{ai_agent_conversation, organism};
use crate::functest::tests::{cleanup_locked, mk_login, mk_organism};
use actix_identity::IdentityMiddleware;
use actix_session::{storage::RedisSessionStore, SessionMiddleware};
use actix_web::{
    cookie::{Cookie, Key},
    dev::{ServiceFactory, ServiceRequest, ServiceResponse},
    http::StatusCode,
    test, web, App,
};
use sea_orm::{ActiveModelTrait, ActiveValue::Set, IntoActiveModel};
use serial_test::serial;
use std::sync::Arc;

struct AgentFixture {
    human: login::Model,
    agent: login::Model,
    organism: organism::Model,
}

impl AgentFixture {
    async fn new(env: &Env) -> Self {
        let organism = mk_organism(&env.dbx, Default::default()).await.unwrap();
        let human = mk_login(
            &env.dbx,
            login::ActiveModel {
                organism_id: Set(Some(organism.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let agent = mk_login(
            &env.dbx,
            login::ActiveModel {
                organism_id: Set(human.organism_id),
                roles: Set(serde_json::json!(["ApiAgent", "Rer", "Cyber"])),
                deleted: Set(true),
                password_auth_enabled: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        ai_agent_user_link::ActiveModel {
            id: Set(Uuid::now_v7()),
            human_login_id: Set(human.id),
            agent_login_id: Set(agent.id),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        Self {
            human,
            agent,
            organism,
        }
    }

    async fn cleanup(&self, env: &Env) {
        revoke_login_credentials(env, self.agent.id).await.unwrap();
        ai_agent_user_link::Entity::delete_many()
            .filter(ai_agent_user_link::Column::AgentLoginId.eq(self.agent.id))
            .exec(&env.dbx)
            .await
            .unwrap();
    }

    async fn invalidate(&self, env: &Env, reason: &str) {
        let mut agent = self.agent.clone().into_active_model();
        let mut human = self.human.clone().into_active_model();
        let mut organism = self.organism.clone().into_active_model();
        match reason {
            "unlinked" => {
                ai_agent_user_link::Entity::delete_many()
                    .filter(
                        ai_agent_user_link::Column::AgentLoginId
                            .eq(self.agent.id),
                    )
                    .exec(&env.dbx)
                    .await
                    .unwrap();
            }
            "agent_removed" => agent.deleted_permanently = Set(true),
            "extra_role" => {
                agent.roles = Set(serde_json::json!([
                    "ApiAgent", "Rer", "Cyber", "Admin"
                ]))
            }
            "password_enabled" => agent.password_auth_enabled = Set(true),
            "password_present" => {
                agent.password = Set(Some("unexpected".to_string()))
            }
            "human_blocked" => human.deleted = Set(true),
            "human_removed" => human.deleted_permanently = Set(true),
            "human_role_revoked" => {
                human.roles = Set(serde_json::json!(["Cyber"]))
            }
            "organism_disabled" => organism.enabled = Set(false),
            "organism_removed" => organism.deleted_permanently = Set(true),
            "scope_changed" => agent.organism_id = Set(None),
            _ => panic!("unknown denial reason: {reason}"),
        }
        agent.update(&env.dbx).await.unwrap();
        human.update(&env.dbx).await.unwrap();
        organism.update(&env.dbx).await.unwrap();
    }
}

async fn bootstrap_app(
    env: Arc<Env>,
) -> App<
    impl ServiceFactory<
        ServiceRequest,
        Config = (),
        Response = ServiceResponse,
        Error = actix_web::Error,
        InitError = (),
    >,
> {
    let store =
        RedisSessionStore::new(crate::redis_conn_string(&env.config).unwrap())
            .await
            .unwrap();
    App::new()
        .wrap(IdentityMiddleware::default())
        .wrap(actix_web::middleware::from_fn(
            crate::ai_agent::middleware::enforce_agent_routes,
        ))
        .wrap(SessionMiddleware::new(store, Key::generate()))
        .app_data(web::Data::from(env))
        .service(exchange_bootstrap)
        .service(crate::users::api_user)
}

fn exchange(token: &str) -> test::TestRequest {
    test::TestRequest::post()
        .uri("/api/ai-agent/bootstrap/exchange")
        .set_json(serde_json::json!({ "token": token }))
}

fn identity(
    cookie: Cookie<'static>,
    correlation_id: Uuid,
) -> test::TestRequest {
    test::TestRequest::get()
        .uri("/api/user")
        .cookie(cookie)
        .insert_header((
            crate::config::AI_AGENT_CORRELATION_HEADER,
            correlation_id.to_string(),
        ))
}

#[actix_web::test]
#[serial]
async fn disabled_agent_startup_test_is_bound_restricted_and_revocable() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = AgentFixture::new(&env).await;
    let app = test::init_service(bootstrap_app(env.clone()).await).await;
    let (token, correlation_id) =
        issue_bootstrap(&env, fixture.agent.id, None, true)
            .await
            .unwrap();
    let response =
        test::call_service(&app, exchange(&token).to_request()).await;
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = response.response().cookies().next().unwrap().into_owned();
    let body: serde_json::Value = test::read_body_json(response).await;
    assert_eq!(body["correlationId"], correlation_id.to_string());
    let ttl: i64 = env
        .redis
        .clone()
        .ttl(credential_key(correlation_id))
        .await
        .unwrap();
    assert!((1..=AI_AGENT_BOOTSTRAP_TTL_SEC as i64).contains(&ttl));

    let response = test::call_service(
        &app,
        identity(cookie.clone(), correlation_id).to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(response).await;
    assert_eq!(body["id"], fixture.agent.id.to_string());
    assert_eq!(body["roles"], fixture.agent.roles);
    let unchanged = login::Entity::find_by_id(fixture.agent.id)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    assert!(unchanged.deleted);
    assert_eq!(unchanged.last_active_at, fixture.agent.last_active_at);

    assert_eq!(
        test::call_service(&app, exchange(&token).to_request())
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    for request in [
        identity(cookie.clone(), correlation_id).uri("/api/ai-agent/status"),
        identity(cookie.clone(), correlation_id)
            .method(actix_web::http::Method::POST),
    ] {
        let response = test::try_call_service(&app, request.to_request())
            .await
            .unwrap_err();
        assert_eq!(
            response.as_response_error().status_code(),
            StatusCode::FORBIDDEN
        );
    }
    revoke_correlation(&env, Some(fixture.agent.id), correlation_id)
        .await
        .unwrap();
    let error = test::try_call_service(
        &app,
        identity(cookie, correlation_id).to_request(),
    )
    .await
    .unwrap_err();
    assert_eq!(
        error.as_response_error().status_code(),
        StatusCode::FORBIDDEN
    );
    fixture.cleanup(&env).await;
}

#[actix_web::test]
#[serial]
async fn bootstrap_rejects_ineligible_managed_identities() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let app = test::init_service(bootstrap_app(env.clone()).await).await;
    for reason in [
        "unlinked",
        "agent_removed",
        "extra_role",
        "password_enabled",
        "password_present",
        "human_blocked",
        "human_removed",
        "human_role_revoked",
        "organism_disabled",
        "organism_removed",
        "scope_changed",
    ] {
        let fixture = AgentFixture::new(&env).await;
        let (token, correlation_id) =
            issue_bootstrap(&env, fixture.agent.id, None, true)
                .await
                .unwrap();
        fixture.invalidate(&env, reason).await;
        let response =
            test::call_service(&app, exchange(&token).to_request()).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{reason}");
        assert!(!env
            .redis
            .clone()
            .exists::<_, bool>(credential_key(correlation_id))
            .await
            .unwrap());
        fixture.cleanup(&env).await;
    }
    let fixture = AgentFixture::new(&env).await;
    let (token, _) = issue_bootstrap(&env, fixture.agent.id, None, true)
        .await
        .unwrap();
    env.redis
        .clone()
        .expire::<_, ()>(bootstrap_key(&token), 0)
        .await
        .unwrap();
    assert_eq!(
        test::call_service(&app, exchange(&token).to_request())
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    fixture.cleanup(&env).await;
}

#[actix_web::test]
#[serial]
async fn startup_identity_rechecks_binding_and_current_access() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let app = test::init_service(bootstrap_app(env.clone()).await).await;
    for reason in [
        "missing_correlation",
        "wrong_correlation",
        "wrong_session_binding",
        "expired",
        "human_blocked",
        "organism_disabled",
        "scope_changed",
    ] {
        let fixture = AgentFixture::new(&env).await;
        let (token, correlation_id) =
            issue_bootstrap(&env, fixture.agent.id, None, true)
                .await
                .unwrap();
        let response =
            test::call_service(&app, exchange(&token).to_request()).await;
        assert_eq!(response.status(), StatusCode::OK);
        let cookie = response.response().cookies().next().unwrap().into_owned();
        let request = match reason {
            "missing_correlation" => {
                test::TestRequest::get().uri("/api/user").cookie(cookie)
            }
            "wrong_correlation" => identity(cookie, Uuid::now_v7()),
            "wrong_session_binding" => {
                let (token, other_correlation) =
                    issue_bootstrap(&env, fixture.agent.id, None, true)
                        .await
                        .unwrap();
                let response =
                    test::call_service(&app, exchange(&token).to_request())
                        .await;
                assert_eq!(response.status(), StatusCode::OK);
                identity(cookie, other_correlation)
            }
            "expired" => {
                env.redis
                    .clone()
                    .expire::<_, ()>(credential_key(correlation_id), 0)
                    .await
                    .unwrap();
                identity(cookie, correlation_id)
            }
            _ => {
                fixture.invalidate(&env, reason).await;
                identity(cookie, correlation_id)
            }
        };
        let error = test::try_call_service(&app, request.to_request())
            .await
            .unwrap_err();
        assert_eq!(
            error.as_response_error().status_code(),
            StatusCode::FORBIDDEN,
            "{reason}"
        );
        fixture.cleanup(&env).await;
    }
}

async fn running_request(
    env: &Env,
    fixture: &AgentFixture,
) -> ai_agent_request::Model {
    let ai_engine = ai_engine::ActiveModel {
        id: Set(Uuid::now_v7()),
        name: Set(format!("bootstrap-test-{}", Uuid::now_v7())),
        url: Set("http://127.0.0.1:8000/v1".to_string()),
        model_name: Set("test".to_string()),
        ..Default::default()
    }
    .insert(&env.dbx)
    .await
    .unwrap();
    let conversation = ai_agent_conversation::ActiveModel {
        id: Set(Uuid::now_v7()),
        human_login_id: Set(fixture.human.id),
        ai_engine_id: Set(ai_engine.id),
        title: Set("Bootstrap regression".to_string()),
        ..Default::default()
    }
    .insert(&env.dbx)
    .await
    .unwrap();
    ai_agent_request::ActiveModel {
        id: Set(Uuid::now_v7()),
        conversation_id: Set(conversation.id),
        human_login_id: Set(fixture.human.id),
        agent_login_id: Set(Some(fixture.agent.id)),
        ai_engine_id: Set(ai_engine.id),
        prompt: Set("Test".to_string()),
        state: Set("running".to_string()),
        ..Default::default()
    }
    .insert(&env.dbx)
    .await
    .unwrap()
}

#[actix_web::test]
#[serial]
async fn request_bootstrap_requires_active_account_and_running_request() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = AgentFixture::new(&env).await;
    let app = test::init_service(bootstrap_app(env.clone()).await).await;
    let request = running_request(&env, &fixture).await;
    for (active, state, cancelled, expected) in [
        (false, "running", false, StatusCode::UNAUTHORIZED),
        (true, "queued", false, StatusCode::UNAUTHORIZED),
        (true, "running", true, StatusCode::UNAUTHORIZED),
        (true, "running", false, StatusCode::OK),
    ] {
        let mut agent = fixture.agent.clone().into_active_model();
        agent.deleted = Set(!active);
        agent.update(&env.dbx).await.unwrap();
        let (token, correlation_id) =
            issue_bootstrap(&env, fixture.agent.id, Some(request.id), false)
                .await
                .unwrap();
        let mut current = request.clone().into_active_model();
        current.state = Set(state.to_string());
        current.cancellation_requested = Set(cancelled);
        current.correlation_id = Set(Some(correlation_id));
        current.update(&env.dbx).await.unwrap();
        let response =
            test::call_service(&app, exchange(&token).to_request()).await;
        assert_eq!(response.status(), expected);
        if expected == StatusCode::OK {
            let cookie =
                response.response().cookies().next().unwrap().into_owned();
            assert_eq!(
                test::call_service(
                    &app,
                    identity(cookie.clone(), correlation_id).to_request()
                )
                .await
                .status(),
                StatusCode::OK
            );
            let mut cancelled = request.clone().into_active_model();
            cancelled.cancellation_requested = Set(true);
            cancelled.update(&env.dbx).await.unwrap();
            let error = test::try_call_service(
                &app,
                identity(cookie, correlation_id).to_request(),
            )
            .await
            .unwrap_err();
            assert_eq!(
                error.as_response_error().status_code(),
                StatusCode::FORBIDDEN
            );
        }
    }
    ai_agent_request::Entity::delete_by_id(request.id)
        .exec(&env.dbx)
        .await
        .unwrap();
    ai_agent_conversation::Entity::delete_by_id(request.conversation_id)
        .exec(&env.dbx)
        .await
        .unwrap();
    ai_engine::Entity::delete_by_id(request.ai_engine_id)
        .exec(&env.dbx)
        .await
        .unwrap();
    fixture.cleanup(&env).await;
}
