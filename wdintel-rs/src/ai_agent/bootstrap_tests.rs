use super::*;
use crate::entities::{ai_agent_conversation, organism};
use crate::functest::tests::{cleanup_locked, mk_login, mk_organism};
use actix_identity::IdentityMiddleware;
use actix_session::{storage::RedisSessionStore, SessionMiddleware};
use actix_web::{
    cookie::{Cookie, Key},
    dev::{ServiceFactory, ServiceRequest, ServiceResponse},
    http::StatusCode,
    test, web, App, HttpMessage, HttpRequest, HttpResponse,
};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, IntoActiveModel, TransactionTrait,
};
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
                human.roles = Set(serde_json::json!(["Basic"]))
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
        .route("/test-human-login", web::post().to(test_human_login))
        .service(exchange_bootstrap)
        .service(crate::users::api_user)
        .service(crate::ai_agent::maps::prepare_map)
        .service(crate::ai_agent::maps::get_map)
        .service(crate::ai_agent::maps::download_csv)
        .service(crate::ai_agent::maps::download_kmz)
}

async fn test_human_login(
    req: HttpRequest,
    login_id: web::Json<Uuid>,
) -> HttpResponse {
    actix_identity::Identity::login(&req.extensions(), login_id.to_string())
        .unwrap();
    HttpResponse::NoContent().finish()
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
async fn issue_3568_cyber_agent_startup_is_bound_restricted_and_revocable() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = AgentFixture::new(&env).await;
    let mut human = fixture.human.clone().into_active_model();
    human.roles = Set(serde_json::json!(["Cyber"]));
    human.update(&env.dbx).await.unwrap();
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

// Regression: https://github.com/echoua/echo/issues/3064
#[actix_web::test]
#[serial]
async fn message_citations_survive_reload_without_cross_request_sources() {
    use crate::ai_agent::{conversation_detail, events};
    use crate::entities::ai_agent_request_event;
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = AgentFixture::new(&env).await;
    let request = running_request(&env, &fixture).await;
    let payload = serde_json::json!({"citations": [
        {"messageId": 77, "messageIdentifier": "source-77"},
        {"messageId": 78, "messageIdentifier": "unused-78"}
    ]});
    for _ in 0..2 {
        assert!(events::append_runner(
            &env.dbx,
            request.id,
            "message_citations",
            payload.clone()
        )
        .await
        .unwrap());
    }
    let response = "Evidence [джерело](/rer-analysis-neo?m=source-77)";
    let mut completed = request.clone().into_active_model();
    completed.state = Set("completed".to_string());
    completed.response = Set(Some(response.to_string()));
    completed.update(&env.dbx).await.unwrap();
    let other = running_request(&env, &fixture).await;
    assert!(events::append_runner(
        &env.dbx,
        other.id,
        "message_citations",
        serde_json::json!({
            "citations": [{"messageId": 99, "messageIdentifier": "other-99"}]
        }),
    )
    .await
    .unwrap());
    let conversation =
        ai_agent_conversation::Entity::find_by_id(request.conversation_id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
    let detail = conversation_detail(&env.dbx, conversation).await.unwrap();
    assert!(detail.messages[0].citations.is_empty());
    assert_eq!(detail.messages[1].citations.len(), 1);
    assert_eq!(detail.messages[1].citations[0].message_id, 77);
    let txn = env.dbx.begin().await.unwrap();
    crate::ai_agent::citations::persist_referenced(&txn, request.id, response)
        .await
        .unwrap();
    txn.commit().await.unwrap();
    let citation_events = ai_agent_request_event::Entity::find()
        .filter(ai_agent_request_event::Column::RequestId.eq(request.id))
        .filter(
            ai_agent_request_event::Column::EventType.eq("message_citations"),
        )
        .all(&env.dbx)
        .await
        .unwrap();
    assert_eq!(citation_events.len(), 1);
    let stored =
        crate::ai_agent::citations::parse(&citation_events[0].payload).unwrap();
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].message_id, 77);
    let detail = conversation_detail(
        &env.dbx,
        ai_agent_conversation::Entity::find_by_id(request.conversation_id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(detail.messages[1].citations.len(), 1);
    assert_eq!(detail.messages[1].citations[0].message_id, 77);
    let other_events = ai_agent_request_event::Entity::find()
        .filter(ai_agent_request_event::Column::RequestId.eq(other.id))
        .filter(
            ai_agent_request_event::Column::EventType.eq("message_citations"),
        )
        .all(&env.dbx)
        .await
        .unwrap();
    assert_eq!(other_events.len(), 1);
    assert!(!events::append_runner(
        &env.dbx,
        request.id,
        "message_citations",
        payload
    )
    .await
    .unwrap());
    assert!(events::normalize_runner_event(serde_json::json!({
        "type": "message_citations", "citations": [{"messageId": -1, "messageIdentifier": "invalid"}]
    })).is_none());
    for stale in [&request, &other] {
        ai_agent_request::Entity::delete_by_id(stale.id)
            .exec(&env.dbx)
            .await
            .unwrap();
        ai_agent_conversation::Entity::delete_by_id(stale.conversation_id)
            .exec(&env.dbx)
            .await
            .unwrap();
        ai_engine::Entity::delete_by_id(stale.ai_engine_id)
            .exec(&env.dbx)
            .await
            .unwrap();
    }
    fixture.cleanup(&env).await;
}

// Regression: https://github.com/echoua/echo/issues/3064
#[actix_web::test]
#[serial]
async fn map_publication_replay_cancellation_and_access_follow_request_ownership(
) {
    use crate::ai_agent::maps::types::*;
    use crate::ai_agent::types::AiAgentMessageCitation;
    use crate::ai_agent::{events, maps};
    use crate::entities::{ai_agent_request_event, signal_message};
    let (mut env, _guard) = cleanup_locked().await.unwrap();
    Arc::get_mut(&mut env).unwrap().config.static_path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../wdintel-web/static")
            .to_str()
            .unwrap()
            .to_string();
    let fixture = AgentFixture::new(&env).await;
    let request = running_request(&env, &fixture).await;
    let zone =
        crate::functest::tests::mk_sigint_zone(&env.dbx, Default::default())
            .await
            .unwrap();
    for login in [&fixture.human, &fixture.agent] {
        let mut login = login.clone().into_active_model();
        login.sigint_zone_id = Set(Some(zone.id));
        login.update(&env.dbx).await.unwrap();
    }
    let source = crate::functest::tests::mk_signal_message(
        &env.dbx,
        signal_message::ActiveModel {
            id_uuid: Set(Some(Uuid::new_v4())),
            datasource_group_id: Set(None),
            login_id: Set(Some(fixture.human.id)),
            sender: Set(Some(fixture.human.id.to_string())),
            body: Set(Some("Synthetic map source".to_string())),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let input = AiAgentMapRecordInput {
        sidc: "10062000001209020000".to_string(),
        name: "Подія".to_string(),
        observation_datetime: None,
        coordinate_system: "msk2000".to_string(),
        x: "5215227".to_string(),
        y: "6548669".to_string(),
        comments: vec!["Коментар".to_string()],
        sources: vec![AiAgentMessageCitation {
            message_id: source.id,
            message_identifier: source.id_uuid.unwrap().to_string(),
        }],
    };
    let app = test::init_service(bootstrap_app(env.clone()).await).await;
    let (token, correlation_id) =
        issue_bootstrap(&env, fixture.agent.id, Some(request.id), false)
            .await
            .unwrap();
    let mut agent = fixture.agent.clone().into_active_model();
    agent.deleted = Set(false);
    agent.update(&env.dbx).await.unwrap();
    let mut bound = request.clone().into_active_model();
    bound.correlation_id = Set(Some(correlation_id));
    bound.update(&env.dbx).await.unwrap();
    let response =
        test::call_service(&app, exchange(&token).to_request()).await;
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = response.response().cookies().next().unwrap().into_owned();
    let api = |path: &str| {
        test::TestRequest::post()
            .uri(path)
            .cookie(cookie.clone())
            .insert_header((
                crate::config::AI_AGENT_CORRELATION_HEADER,
                correlation_id.to_string(),
            ))
    };
    let response = test::call_service(
        &app,
        api("/api/ai-agent/maps/prepare")
            .set_json(AiAgentMapPrepareReq {
                records: vec![input.clone(); 17],
            })
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let response = test::call_service(
        &app,
        api("/api/ai-agent/maps/prepare")
            .set_json(AiAgentMapPrepareReq {
                records: vec![input],
            })
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let prepared: AiAgentMapPrepareRsp = test::read_body_json(response).await;
    assert!(maps::load_documents(&env.dbx, &[request.id])
        .await
        .unwrap()
        .is_empty());
    let mut document = AiAgentMapDocument {
        id: Uuid::new_v4().to_string(),
        title: "Головна мапа".to_string(),
        is_main: true,
        records: prepared.records,
        warnings: Vec::new(),
        total_count: 999,
        valid_count: 999,
        invalid_count: 999,
    };
    for _ in 0..2 {
        assert!(events::append_runner(
            &env.dbx,
            request.id,
            "map_artifact",
            serde_json::json!({ "document": document })
        )
        .await
        .unwrap());
    }
    document.title = "Змінена мапа".to_string();
    assert!(events::append_runner(
        &env.dbx,
        request.id,
        "map_artifact",
        serde_json::json!({ "document": document })
    )
    .await
    .is_err());
    let stored = ai_agent_request_event::Entity::find()
        .filter(ai_agent_request_event::Column::RequestId.eq(request.id))
        .all(&env.dbx)
        .await
        .unwrap();
    assert_eq!(stored.len(), 1);
    let stored_summary = stored[0].map_summary.as_ref().unwrap();
    assert_eq!(stored_summary["totalCount"], 1);
    assert_eq!(stored_summary["validCount"], 1);
    assert_eq!(stored_summary["invalidCount"], 0);
    assert!(stored_summary.get("records").is_none());
    let published_event = stored[0].clone();
    let mut state = crate::ai_agent::SseState {
        dbx: env.dbx.clone(),
        request_id: request.id,
        after: 0,
    };
    let replay =
        crate::ai_agent::render_sse_events(&mut state, stored).unwrap();
    let replay = std::str::from_utf8(&replay).unwrap();
    assert!(replay.contains("map_artifact"));
    assert!(!replay.contains("records") && !replay.contains("Коментар"));
    let req = AiAgentMapGetReq {
        request_id: request.id.to_string(),
        map_id: document.id.clone(),
    };
    let response = test::call_service(
        &app,
        api("/api/ai-agent/maps/get").set_json(&req).to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let loaded: AiAgentMapDocument = test::read_body_json(response).await;
    assert_eq!(
        (loaded.total_count, loaded.valid_count, loaded.invalid_count),
        (1, 1, 0)
    );
    assert_eq!(loaded.title, "Головна мапа");
    let outsider = mk_login(&env.dbx, Default::default()).await.unwrap();
    assert!(maps::document_for_owner(&env, outsider.id, &req)
        .await
        .is_err());
    let denied = test::try_call_service(
        &app,
        api("/api/ai-agent/maps/csv").set_json(&req).to_request(),
    )
    .await
    .unwrap_err();
    assert_eq!(
        denied.as_response_error().status_code(),
        StatusCode::FORBIDDEN
    );
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/test-human-login")
            .set_json(fixture.human.id)
            .to_request(),
    )
    .await;
    let human_cookie =
        response.response().cookies().next().unwrap().into_owned();
    let human_api = |path: &str| {
        test::TestRequest::post()
            .uri(path)
            .cookie(human_cookie.clone())
    };
    let response = test::call_service(
        &app,
        human_api("/api/ai-agent/maps/csv")
            .set_json(&req)
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get("Cache-Control")
            .unwrap()
            .to_str()
            .unwrap(),
        "private, no-store"
    );
    assert!(std::str::from_utf8(&test::read_body(response).await)
        .unwrap()
        .contains("\"CAPDOC\""));
    let response = test::call_service(
        &app,
        human_api("/api/ai-agent/maps/kmz")
            .set_json(&req)
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(
        test::read_body(response).await,
    ))
    .unwrap();
    assert!(archive.by_name("doc.kml").is_ok());
    let mut invalid = loaded.clone();
    invalid.id = Uuid::new_v4().to_string();
    invalid.is_main = false;
    invalid.records[0].original_y = "654866".to_string();
    assert!(events::append_runner(
        &env.dbx,
        request.id,
        "map_artifact",
        serde_json::json!({ "document": invalid })
    )
    .await
    .unwrap());
    let invalid_req = AiAgentMapGetReq {
        map_id: invalid.id,
        ..req.clone()
    };
    let response = test::call_service(
        &app,
        human_api("/api/ai-agent/maps/kmz")
            .set_json(&invalid_req)
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let response = test::call_service(
        &app,
        human_api("/api/ai-agent/maps/csv")
            .set_json(&invalid_req)
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(std::str::from_utf8(&test::read_body(response).await)
        .unwrap()
        .contains("\"INVALID\""));
    let mut cancelled = request.clone().into_active_model();
    cancelled.cancellation_requested = Set(true);
    cancelled.state = Set("cancelled".to_string());
    cancelled.update(&env.dbx).await.unwrap();
    assert!(!events::append_runner(
        &env.dbx,
        request.id,
        "map_artifact",
        serde_json::json!({ "document": loaded })
    )
    .await
    .unwrap());
    let conversation =
        ai_agent_conversation::Entity::find_by_id(request.conversation_id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
    let mut without_payload = published_event.clone().into_active_model();
    without_payload.payload = Set(serde_json::json!({}));
    without_payload.update(&env.dbx).await.unwrap();
    let detail =
        crate::ai_agent::conversation_detail(&env.dbx, conversation.clone())
            .await
            .unwrap();
    assert!(detail.messages[0].maps.is_empty());
    assert_eq!(detail.messages[1].maps[0].id, req.map_id);
    let followup = running_request(&env, &fixture).await;
    let mut followup = followup.into_active_model();
    followup.conversation_id = Set(request.conversation_id);
    let followup = followup.update(&env.dbx).await.unwrap();
    let history = crate::ai_agent::worker::load_history(&env, &followup)
        .await
        .unwrap();
    assert_eq!(history[1]["maps"][0]["id"], req.map_id);
    assert!(history[1]["content"]
        .as_str()
        .unwrap()
        .contains("echo-map:"));
    let mut restored = published_event.clone().into_active_model();
    restored.payload = Set(published_event.payload);
    restored.update(&env.dbx).await.unwrap();
    assert!(maps::document_for_owner(&env, fixture.human.id, &req)
        .await
        .is_ok());
    let mut revoked = source.into_active_model();
    revoked.login_id = Set(Some(outsider.id));
    revoked.sender = Set(Some(outsider.id.to_string()));
    revoked.update(&env.dbx).await.unwrap();
    assert!(maps::document_for_owner(&env, fixture.human.id, &req)
        .await
        .is_err());
    for path in [
        "/api/ai-agent/maps/get",
        "/api/ai-agent/maps/csv",
        "/api/ai-agent/maps/kmz",
    ] {
        let response = test::call_service(
            &app,
            human_api(path).set_json(&req).to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "{path}");
    }
    ai_agent_request::Entity::delete_by_id(followup.id)
        .exec(&env.dbx)
        .await
        .unwrap();
    let mut deleted = conversation.into_active_model();
    deleted.deleted_at = Set(Some(chrono::Utc::now().naive_utc()));
    deleted.update(&env.dbx).await.unwrap();
    assert!(maps::document_for_owner(&env, fixture.human.id, &req)
        .await
        .is_err());
    ai_agent_request::Entity::delete_by_id(request.id)
        .exec(&env.dbx)
        .await
        .unwrap();
    ai_agent_conversation::Entity::delete_by_id(request.conversation_id)
        .exec(&env.dbx)
        .await
        .unwrap();
    fixture.cleanup(&env).await;
}
