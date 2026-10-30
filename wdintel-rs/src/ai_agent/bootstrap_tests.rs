use super::*;
use crate::entities::{
    ai_agent_allowed_engine, ai_agent_conversation, ai_agent_settings, organism,
};
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
        .service(crate::ai_agent::maps::workspace::open_workspace)
        .service(crate::ai_agent::maps::workspace::edit_map)
        .service(crate::ai_agent::maps::workspace::undo_map)
        .service(crate::ai_agent::maps::workspace::redo_map)
        .service(crate::ai_agent::cancel_request)
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
async fn issue_3572_maintenance_refreshed_existing_scope_without_relaxing_bootstrap(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = AgentFixture::new(&env).await;
    let linked =
        crate::ai_agent::lifecycle::ensure_linked_agent(&env, fixture.human.id)
            .await
            .unwrap();
    for login_id in [fixture.human.id, fixture.agent.id] {
        crate::functest::tests::mk_secret_group_user(
            &env.dbx,
            crate::entities::secret_group_user::ActiveModel {
                login_id: Set(login_id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    }
    let app = test::init_service(bootstrap_app(env.clone()).await).await;
    let (token, _) = issue_bootstrap(&env, fixture.agent.id, None, true)
        .await
        .unwrap();
    assert_eq!(
        test::call_service(&app, exchange(&token).to_request())
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let prepared =
        crate::ai_agent::lifecycle::prepare_maintenance_connection_test(
            &env.dbx,
            fixture.human.id,
        )
        .await
        .unwrap();
    assert_eq!(prepared.link.id, linked.link.id);
    assert_eq!(prepared.login.id, fixture.agent.id);
    assert_eq!(
        prepared.container.instance_name,
        linked.container.instance_name
    );
    assert!(prepared.login.deleted);
    assert!(prepared.login.password.is_none());
    assert!(!prepared.login.password_auth_enabled);
    let (token, _) = issue_bootstrap(&env, fixture.agent.id, None, true)
        .await
        .unwrap();
    assert_eq!(
        test::call_service(&app, exchange(&token).to_request())
            .await
            .status(),
        StatusCode::OK
    );
    for reason in ["human_blocked", "human_role_revoked", "organism_disabled"] {
        let fixture = AgentFixture::new(&env).await;
        crate::ai_agent::lifecycle::ensure_linked_agent(&env, fixture.human.id)
            .await
            .unwrap();
        fixture.invalidate(&env, reason).await;
        assert!(
            crate::ai_agent::lifecycle::prepare_maintenance_connection_test(
                &env.dbx,
                fixture.human.id
            )
            .await
            .is_err(),
            "{reason}"
        );
        fixture.cleanup(&env).await;
    }
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

async fn checkpoint_request_fixture(
    env: &Env,
    fixture: &AgentFixture,
    correlation_id: Uuid,
) -> (ai_agent_request::Model, ai_engine::Model) {
    let request = running_request(env, fixture).await;
    let mut ai_engine = ai_engine::Entity::find_by_id(request.ai_engine_id)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap()
        .into_active_model();
    let url = format!("https://{}/v1", crate::config::AI_GOV_UA_API_HOST);
    ai_engine.url = Set(url.clone());
    ai_engine.model_name = Set(crate::config::AI_AGENT_GLM_5_3.to_string());
    ai_engine.enabled = Set(true);
    ai_engine.update(&env.dbx).await.unwrap();
    let checkpoint = ai_engine::ActiveModel {
        id: Set(Uuid::now_v7()),
        name: Set(format!("checkpoint-test-{}", Uuid::now_v7())),
        url: Set(url),
        model_name: Set(crate::config::AI_AGENT_OPENAI_GPT_6_LUNA.to_string()),
        enabled: Set(true),
        ..Default::default()
    }
    .insert(&env.dbx)
    .await
    .unwrap();
    for ai_engine_id in [request.ai_engine_id, checkpoint.id] {
        ai_agent_allowed_engine::ActiveModel {
            ai_engine_id: Set(ai_engine_id),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
    }
    let mut request = request.into_active_model();
    request.correlation_id = Set(Some(correlation_id));
    (request.update(&env.dbx).await.unwrap(), checkpoint)
}

async fn checkpoint_test_settings(env: &Env) -> ai_agent_settings::Model {
    let settings = ai_agent_settings::Entity::find_by_id(1_i16)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    let mut enabled = settings.clone().into_active_model();
    enabled.feature_enabled = Set(true);
    enabled.update(&env.dbx).await.unwrap();
    settings
}

async fn restore_checkpoint_test_settings(
    env: &Env,
    settings: ai_agent_settings::Model,
) {
    let feature_enabled = settings.feature_enabled;
    let mut settings = settings.into_active_model();
    settings.feature_enabled = Set(feature_enabled);
    settings.update(&env.dbx).await.unwrap();
}

async fn issue_test_provider(
    env: &Env,
    request: &ai_agent_request::Model,
    checkpoint: Option<&ai_engine::Model>,
) -> String {
    issue_provider_capability(
        env,
        request.agent_login_id.unwrap(),
        request.id,
        request.correlation_id.unwrap(),
        request.ai_engine_id,
        crate::config::AI_AGENT_GLM_5_3.to_string(),
        checkpoint.map(|checkpoint| CheckpointProviderGrant {
            ai_engine_id: checkpoint.id,
            model_name: checkpoint.model_name.clone(),
            max_output_tokens: 8_192,
        }),
    )
    .await
    .unwrap()
}

async fn authorize_test_provider(
    env: &Env,
    token: &str,
    model_name: &str,
) -> Option<AuthorizedProvider> {
    authorize_provider_capability(env, token, model_name)
        .await
        .unwrap()
}

#[actix_web::test]
#[serial]
async fn issue_3724_checkpoint_capability_shared_limits_and_revocation() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = AgentFixture::new(&env).await;
    let settings = checkpoint_test_settings(&env).await;
    let correlation_id = Uuid::now_v7();
    let (request, checkpoint) =
        checkpoint_request_fixture(&env, &fixture, correlation_id).await;
    let token = issue_test_provider(&env, &request, None).await;
    assert!(
        authorize_test_provider(&env, &token, &checkpoint.model_name)
            .await
            .is_none()
    );
    assert!(authorize_test_provider(
        &env,
        &token,
        crate::config::AI_AGENT_GLM_5_3
    )
    .await
    .is_some());
    revoke_correlation(&env, Some(fixture.agent.id), correlation_id)
        .await
        .unwrap();
    let token = issue_test_provider(&env, &request, Some(&checkpoint)).await;
    for (model_name, ai_engine_id, checkpoint_max_tokens) in [
        (checkpoint.model_name.as_str(), checkpoint.id, Some(8_192)),
        (crate::config::AI_AGENT_GLM_5_3, request.ai_engine_id, None),
    ] {
        let authorization = authorize_test_provider(&env, &token, model_name)
            .await
            .unwrap();
        assert_eq!(authorization.ai_engine.id, ai_engine_id);
        assert_eq!(authorization.checkpoint_max_tokens, checkpoint_max_tokens);
    }
    assert!(authorize_test_provider(&env, &token, "ungranted-provider")
        .await
        .is_none());
    let digest = sha256::digest(token.as_bytes());
    let calls_key = provider_capability_calls_key(&digest);
    let mut redis = env.redis.clone();
    let calls: i64 = redis.get(&calls_key).await.unwrap();
    redis
        .incr::<_, _, i64>(
            &calls_key,
            AI_AGENT_PROVIDER_CAPABILITY_CALL_LIMIT - 1 - calls,
        )
        .await
        .unwrap();
    assert!(
        authorize_test_provider(&env, &token, &checkpoint.model_name)
            .await
            .is_some()
    );
    assert!(authorize_test_provider(
        &env,
        &token,
        crate::config::AI_AGENT_GLM_5_3
    )
    .await
    .is_none());
    revoke_correlation(&env, Some(fixture.agent.id), correlation_id)
        .await
        .unwrap();
    assert!(!redis.exists::<_, bool>(&calls_key).await.unwrap());
    for model_name in [
        checkpoint.model_name.as_str(),
        crate::config::AI_AGENT_GLM_5_3,
    ] {
        assert!(authorize_test_provider(&env, &token, model_name)
            .await
            .is_none());
    }
    restore_checkpoint_test_settings(&env, settings).await;
    fixture.cleanup(&env).await;
}

#[actix_web::test]
#[serial]
async fn issue_3724_reasoning_policy_reserved_synthesis_and_kept_its_deadline()
{
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = AgentFixture::new(&env).await;
    let settings = checkpoint_test_settings(&env).await;
    let correlation_id = Uuid::now_v7();
    let (request, _) =
        checkpoint_request_fixture(&env, &fixture, correlation_id).await;
    let engine = ai_engine::Entity::find_by_id(request.ai_engine_id)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    let mut config = env.config.clone();
    config.ai_agent_reasoning_presets_enabled = Some(true);
    config.ai_agent_reasoning_verified_engine_ids = Some(vec![engine.id]);
    use crate::ai_agent::types::AiAgentReasoningPreset as Preset;
    let mut flash = engine.clone();
    flash.model_name = crate::config::AI_AGENT_GLM_FLASH.to_string();
    let mut gemma = engine.clone();
    gemma.model_name = "gemma-4".to_string();
    let mut sol = engine.clone();
    sol.model_name = crate::config::AI_AGENT_OPENAI_GPT_6_SOL.to_string();
    for (preset, runtime, reserve) in [
        (Preset::Fast, 120, 60),
        (Preset::Balanced, 300, 120),
        (Preset::Deep, 1800, 240),
    ] {
        let flash_policy = reasoning::resolve(&config, &flash, preset);
        let original = reasoning::resolve(&config, &engine, preset);
        assert_eq!(flash_policy.max_runtime_seconds, runtime, "#3572");
        assert_eq!(flash_policy.finalization_seconds, reserve, "#3572");
        assert_eq!(original.max_runtime_seconds, runtime, "#3572");
        // Every non-OpenAI engine reserves the longer synthesis window; OpenAI keeps the base.
        assert_eq!(original.finalization_seconds, reserve, "glm-5.3");
        assert_eq!(
            reasoning::resolve(&config, &gemma, preset).finalization_seconds,
            reserve,
            "gemma"
        );
        assert_eq!(
            reasoning::resolve(&config, &sol, preset).finalization_seconds,
            reserve / 2,
            "gpt"
        );
        assert!(flash_policy.reasoning_effort.is_none());
    }
    let policy = reasoning::resolve(
        &config,
        &engine,
        crate::ai_agent::types::AiAgentReasoningPreset::Balanced,
    );
    let mut request = request.into_active_model();
    request.started_at = Set(Some(chrono::Utc::now().naive_utc()));
    request.execution_policy =
        Set(Some(serde_json::to_value(&policy).unwrap()));
    let request = request.update(&env.dbx).await.unwrap();
    let token = issue_test_provider(&env, &request, Some(&engine)).await;
    let authorization = authorize_provider_call(
        &env,
        &token,
        &engine.model_name,
        ProviderPurpose::Checkpoint,
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        authorization
            .execution_policy
            .as_ref()
            .unwrap()
            .checkpoint_effort
            .as_deref(),
        Some("low")
    );
    assert_eq!(authorization.checkpoint_max_tokens, Some(8192));
    let deadline = authorization.deadline_at;
    let calls_key =
        provider_capability_calls_key(&sha256::digest(token.as_bytes()));
    env.redis
        .clone()
        .set::<_, _, ()>(
            &calls_key,
            AI_AGENT_PROVIDER_CAPABILITY_CALL_LIMIT - 1,
        )
        .await
        .unwrap();
    let research = authorize_provider_call(
        &env,
        &token,
        &engine.model_name,
        ProviderPurpose::Research,
    )
    .await
    .unwrap()
    .unwrap();
    assert!(research.research_limit_reached);
    let synthesis = authorize_provider_call(
        &env,
        &token,
        &engine.model_name,
        ProviderPurpose::Synthesis,
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(synthesis.deadline_at, deadline);
    assert!(!synthesis.research_limit_reached);
    assert!(authorize_provider_call(
        &env,
        &token,
        &engine.model_name,
        ProviderPurpose::Synthesis
    )
    .await
    .unwrap()
    .is_none());
    revoke_correlation(&env, Some(fixture.agent.id), correlation_id)
        .await
        .unwrap();
    let mut request = request.into_active_model();
    request.started_at = Set(Some(
        (chrono::Utc::now() - chrono::Duration::seconds(241)).naive_utc(),
    ));
    let request = request.update(&env.dbx).await.unwrap();
    let limited = issue_test_provider(&env, &request, Some(&engine)).await;
    for purpose in [ProviderPurpose::Research, ProviderPurpose::Checkpoint] {
        assert!(
            authorize_provider_call(
                &env,
                &limited,
                &engine.model_name,
                purpose
            )
            .await
            .unwrap()
            .unwrap()
            .research_limit_reached
        );
    }
    assert!(
        !authorize_provider_call(
            &env,
            &limited,
            &engine.model_name,
            ProviderPurpose::Synthesis,
        )
        .await
        .unwrap()
        .unwrap()
        .research_limit_reached
    );
    revoke_correlation(&env, Some(fixture.agent.id), correlation_id)
        .await
        .unwrap();
    let mut request = request.into_active_model();
    request.started_at = Set(Some(
        (chrono::Utc::now() - chrono::Duration::seconds(301)).naive_utc(),
    ));
    let request = request.update(&env.dbx).await.unwrap();
    let expired = issue_test_provider(&env, &request, Some(&engine)).await;
    assert!(authorize_provider_call(
        &env,
        &expired,
        &engine.model_name,
        ProviderPurpose::Synthesis
    )
    .await
    .unwrap()
    .is_none());
    revoke_correlation(&env, Some(fixture.agent.id), correlation_id)
        .await
        .unwrap();
    restore_checkpoint_test_settings(&env, settings).await;
    fixture.cleanup(&env).await;
}

#[actix_web::test]
#[serial]
async fn issue_3724_checkpoint_capability_checked_live_request_and_access() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = AgentFixture::new(&env).await;
    let settings = checkpoint_test_settings(&env).await;
    let correlation_id = Uuid::now_v7();
    let (request, checkpoint) =
        checkpoint_request_fixture(&env, &fixture, correlation_id).await;
    let token = issue_test_provider(&env, &request, Some(&checkpoint)).await;
    let mut cancelled = request.clone().into_active_model();
    cancelled.cancellation_requested = Set(true);
    cancelled.update(&env.dbx).await.unwrap();
    for model_name in [
        checkpoint.model_name.as_str(),
        crate::config::AI_AGENT_GLM_5_3,
    ] {
        assert!(authorize_test_provider(&env, &token, model_name)
            .await
            .is_none());
    }
    let mut running = request.into_active_model();
    running.cancellation_requested = Set(false);
    running.update(&env.dbx).await.unwrap();
    ai_agent_allowed_engine::Entity::delete_by_id(checkpoint.id)
        .exec(&env.dbx)
        .await
        .unwrap();
    assert!(authorize_provider_capability(
        &env,
        &token,
        &checkpoint.model_name
    )
    .await
    .is_err());
    assert!(authorize_test_provider(
        &env,
        &token,
        crate::config::AI_AGENT_GLM_5_3
    )
    .await
    .is_some());
    ai_agent_allowed_engine::ActiveModel {
        ai_engine_id: Set(checkpoint.id),
        ..Default::default()
    }
    .insert(&env.dbx)
    .await
    .unwrap();
    fixture.invalidate(&env, "human_blocked").await;
    for model_name in [
        checkpoint.model_name.as_str(),
        crate::config::AI_AGENT_GLM_5_3,
    ] {
        assert!(authorize_test_provider(&env, &token, model_name)
            .await
            .is_none());
    }
    restore_checkpoint_test_settings(&env, settings).await;
    fixture.cleanup(&env).await;
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
    use crate::ai_agent::types::{
        AiAgentMessageCitation, AiAgentRequestCancelRsp, AiAgentRequestIdReq,
    };
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
        file_sources: vec![],
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
                records: vec![input.clone(); 33],
            })
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    for count in [18, 32] {
        let response = test::call_service(
            &app,
            api("/api/ai-agent/maps/prepare")
                .set_json(AiAgentMapPrepareReq {
                    records: vec![input.clone(); count],
                })
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let prepared: AiAgentMapPrepareRsp =
            test::read_body_json(response).await;
        assert_eq!(prepared.records.len(), count);
    }
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
        revision: None,
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
    for _ in 0..2 {
        let response = test::call_service(
            &app,
            human_api("/api/ai-agent/requests/cancel")
                .set_json(AiAgentRequestIdReq {
                    request_id: request.id.to_string(),
                })
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let cancelled: AiAgentRequestCancelRsp =
            test::read_body_json(response).await;
        assert_eq!(cancelled.state, "cancelled");
    }
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

// Regression: https://github.com/echoua/echo/issues/3064
#[actix_web::test]
#[serial]
async fn map_revisions_edit_undo_redo_and_replay_without_side_effects() {
    use crate::ai_agent::events;
    use crate::ai_agent::maps::prepare::prepare_record;
    use crate::ai_agent::maps::types::*;
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = AgentFixture::new(&env).await;
    let request = running_request(&env, &fixture).await;
    let record = prepare_record(AiAgentMapRecordInput {
        sidc: "10062000001209020000".to_string(),
        name: "Подія".to_string(),
        observation_datetime: None,
        coordinate_system: "msk2000".to_string(),
        x: "5215227".to_string(),
        y: "6548669".to_string(),
        comments: Vec::new(),
        file_sources: Vec::new(),
        sources: Vec::new(),
    })
    .unwrap();
    let document = AiAgentMapDocument {
        id: Uuid::new_v4().to_string(),
        title: "Мапа".to_string(),
        is_main: true,
        records: vec![record],
        warnings: Vec::new(),
        total_count: 1,
        valid_count: 1,
        invalid_count: 0,
    };
    assert!(events::append_runner(
        &env.dbx,
        request.id,
        "map_artifact",
        serde_json::json!({ "document": document })
    )
    .await
    .unwrap());
    let app = test::init_service(bootstrap_app(env.clone()).await).await;
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/test-human-login")
            .set_json(fixture.human.id)
            .to_request(),
    )
    .await;
    let cookie = response.response().cookies().next().unwrap().into_owned();
    let call = |path: &str, body: serde_json::Value| {
        test::TestRequest::post()
            .uri(path)
            .cookie(cookie.clone())
            .set_json(body)
            .to_request()
    };
    let ids = serde_json::json!({
        "requestId": request.id.to_string(),
        "mapId": document.id,
    });
    let with = |extra: serde_json::Value| {
        let mut body = ids.clone();
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        body
    };
    let edit = |key: &str, revision: i32, identity: &str| {
        with(serde_json::json!({
            "expectedRevision": revision,
            "idempotencyKey": key,
            "operations": [{
                "op": "setComponents",
                "selector": { "all": true, "expect": "many" },
                "components": { "identity": identity },
            }],
        }))
    };
    let response =
        test::call_service(&app, call("/api/ai-agent/maps/get", ids.clone()))
            .await;
    assert_eq!(response.status(), StatusCode::OK);
    use sea_orm::ConnectionTrait;
    let row = env
        .dbx
        .query_one_raw(sea_orm::Statement::from_string(
            sea_orm::DatabaseBackend::Postgres,
            "select count(*)::int8 as count from ai_agent_map".to_string(),
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.try_get::<i64>("", "count").unwrap(), 0);

    let response = test::call_service(
        &app,
        call("/api/ai-agent/maps/workspace", ids.clone()),
    )
    .await;
    let opened: AiAgentMapWorkspaceRsp = test::read_body_json(response).await;
    assert_eq!(opened.revision, 1);
    assert!(!opened.can_undo && !opened.can_redo);
    assert_eq!(opened.document.records[0].id, document.records[0].id);

    let response = test::call_service(
        &app,
        call("/api/ai-agent/maps/edit", edit("edit-key-0001", 1, "3")),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let edited: AiAgentMapEditRsp = test::read_body_json(response).await;
    assert_eq!((edited.revision, edited.updated_count), (2, 1));
    let response = test::call_service(
        &app,
        call("/api/ai-agent/maps/edit", edit("edit-key-0001", 1, "3")),
    )
    .await;
    let replayed: AiAgentMapEditRsp = test::read_body_json(response).await;
    assert_eq!(replayed, edited);
    let stale = test::try_call_service(
        &app,
        call("/api/ai-agent/maps/edit", edit("edit-key-0002", 1, "5")),
    )
    .await;
    let status = match stale {
        Ok(response) => response.status(),
        Err(error) => error.as_response_error().status_code(),
    };
    assert_eq!(status, StatusCode::CONFLICT);

    let response = test::call_service(
        &app,
        call(
            "/api/ai-agent/maps/undo",
            with(serde_json::json!({ "expectedRevision": 2 })),
        ),
    )
    .await;
    let undone: AiAgentMapWorkspaceRsp = test::read_body_json(response).await;
    assert_eq!(undone.revision, 1);
    assert!(undone.can_redo && !undone.can_undo);
    assert_eq!(&undone.document.records[0].sidc[3..4], "6");

    let response = test::call_service(
        &app,
        call("/api/ai-agent/maps/edit", edit("edit-key-0003", 1, "4")),
    )
    .await;
    let branched: AiAgentMapEditRsp = test::read_body_json(response).await;
    assert_eq!(branched.revision, 3);
    let response = test::call_service(
        &app,
        call(
            "/api/ai-agent/maps/undo",
            with(serde_json::json!({ "expectedRevision": 3 })),
        ),
    )
    .await;
    let undone: AiAgentMapWorkspaceRsp = test::read_body_json(response).await;
    assert_eq!(undone.revision, 1);
    let response = test::call_service(
        &app,
        call(
            "/api/ai-agent/maps/redo",
            with(serde_json::json!({ "expectedRevision": 1 })),
        ),
    )
    .await;
    let redone: AiAgentMapWorkspaceRsp = test::read_body_json(response).await;
    assert_eq!(redone.revision, 3);
    assert_eq!(&redone.document.records[0].sidc[3..4], "4");
    assert_eq!(redone.changes.updated_count, 1);
    assert_eq!(redone.revisions.len(), 3);
    assert_eq!(redone.revisions[0].origin, "user");

    let response =
        test::call_service(&app, call("/api/ai-agent/maps/get", ids.clone()))
            .await;
    let head: AiAgentMapDocument = test::read_body_json(response).await;
    assert_eq!(&head.records[0].sidc[3..4], "4");
    let response = test::call_service(
        &app,
        call(
            "/api/ai-agent/maps/get",
            with(serde_json::json!({ "revision": 2 })),
        ),
    )
    .await;
    let second: AiAgentMapDocument = test::read_body_json(response).await;
    assert_eq!(&second.records[0].sidc[3..4], "3");
}

#[actix_web::test]
#[serial]
async fn issue_3770_interrupted_history_and_completion_metadata_survive_storage(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = AgentFixture::new(&env).await;
    let request = running_request(&env, &fixture).await;
    for (kind, payload) in [
        (
            "assistant_delta",
            serde_json::json!({"delta":"discarded draft"}),
        ),
        (
            "assistant_snapshot",
            serde_json::json!({"text":"saved evidence"}),
        ),
        (
            "assistant_delta",
            serde_json::json!({"delta":" with source"}),
        ),
        (
            "completion_metadata",
            serde_json::json!({"coverageLimited":true,"reason":"time_limit"}),
        ),
    ] {
        assert!(crate::ai_agent::events::append_runner(
            &env.dbx, request.id, kind, payload
        )
        .await
        .unwrap());
    }
    for _ in 0..4 {
        crate::ai_agent::events::append_runner(
            &env.dbx,
            request.id,
            "assistant_delta",
            serde_json::json!({"delta":"🧭\n".repeat(35_000)}),
        )
        .await
        .unwrap();
    }
    let mut failed = request.clone().into_active_model();
    failed.state = Set("failed".to_string());
    failed.prompt = Set("Original subjects and search scope".to_string());
    failed.update(&env.dbx).await.unwrap();
    let mut cancelled = request.clone().into_active_model();
    cancelled.id = Set(Uuid::now_v7());
    cancelled.state = Set("cancelled".to_string());
    cancelled.prompt = Set("Also search device files".to_string());
    cancelled.queued_at = Set(request.queued_at + chrono::Duration::seconds(1));
    cancelled.insert(&env.dbx).await.unwrap();
    let mut followup = request.clone();
    followup.id = Uuid::now_v7();
    followup.queued_at = request.queued_at + chrono::Duration::seconds(2);
    let history = crate::ai_agent::worker::load_history(&env, &followup)
        .await
        .unwrap();
    assert_eq!(history.len(), 4);
    assert_eq!(history[0]["content"], "Original subjects and search scope");
    let draft = history[1]["content"].as_str().unwrap();
    assert!(draft.contains("failed") && draft.contains("incomplete"));
    assert!(draft.contains("saved evidence with source"));
    assert!(!draft.contains("discarded draft"));
    assert!(draft.contains("truncated to fit context"));
    let payload = crate::ai_agent::worker::bounded_runner_payload(
        serde_json::json!({"prompt":"Also search files","skills":[]}),
        history.clone(),
    )
    .unwrap();
    assert_eq!(
        payload["history"][0]["content"],
        "Original subjects and search scope"
    );
    assert!(
        serde_json::to_vec(&payload).unwrap().len()
            <= crate::config::AI_AGENT_RUNNER_PAYLOAD_MAX_BYTES
    );
    assert_eq!(history[2]["content"], "Also search device files");
    assert!(history[3]["content"]
        .as_str()
        .unwrap()
        .contains("cancelled"));
    let mut running = request.clone().into_active_model();
    running.id = Set(Uuid::now_v7());
    running.insert(&env.dbx).await.unwrap();
    assert_eq!(
        crate::ai_agent::worker::load_history(&env, &followup)
            .await
            .unwrap()
            .len(),
        4
    );
    let zone =
        crate::functest::tests::mk_sigint_zone(&env.dbx, Default::default())
            .await
            .unwrap();
    let mut human = fixture.human.clone().into_active_model();
    human.sigint_zone_id = Set(Some(zone.id));
    human.update(&env.dbx).await.unwrap();
    let source = crate::functest::tests::mk_signal_message(
        &env.dbx,
        crate::entities::signal_message::ActiveModel {
            id_uuid: Set(Some(Uuid::new_v4())),
            datasource_group_id: Set(None),
            login_id: Set(Some(fixture.human.id)),
            sender: Set(Some(fixture.human.id.to_string())),
            body: Set(Some("saved evidence".to_string())),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let txn = env.dbx.begin().await.unwrap();
    crate::ai_agent::events::append_in_transaction(&txn, request.id, "message_citations", serde_json::json!({"citations":[{"messageId":source.id,"messageIdentifier":source.id_uuid.unwrap().to_string()}]})).await.unwrap();
    txn.commit().await.unwrap();
    assert!(crate::ai_agent::worker::load_history(&env, &followup)
        .await
        .unwrap()[1]["content"]
        .as_str()
        .unwrap()
        .contains("saved evidence"));
    let mut source = source.into_active_model();
    source.deleted = Set(true);
    let source = source.update(&env.dbx).await.unwrap();
    let revoked = crate::ai_agent::worker::load_history(&env, &followup)
        .await
        .unwrap();
    assert_eq!(revoked[0]["content"], "Original subjects and search scope");
    assert!(!revoked[1]["content"]
        .as_str()
        .unwrap()
        .contains("saved evidence"));
    assert_eq!(revoked[1]["citations"], serde_json::json!([]));
    let mut source = source.into_active_model();
    source.deleted = Set(false);
    source.update(&env.dbx).await.unwrap();
    let txn = env.dbx.begin().await.unwrap();
    crate::ai_agent::events::append_in_transaction(&txn, request.id, "file_citations", serde_json::json!({
        "citations": [{"deviceId":Uuid::new_v4(),"fileId":Uuid::new_v4(),"revision":1,"extractionRevision":null,"section":null}]
    })).await.unwrap();
    txn.commit().await.unwrap();
    let history = crate::ai_agent::worker::load_history(&env, &followup)
        .await
        .unwrap();
    assert_eq!(history[0]["content"], "Original subjects and search scope");
    let hidden = history[1]["content"].as_str().unwrap();
    assert!(
        hidden.contains("unavailable") && !hidden.contains("saved evidence")
    );
    assert_eq!(history[1]["fileCitations"], serde_json::json!([]));
    followup.queued_at = request.queued_at;
    followup.id = request.id;
    assert!(crate::ai_agent::worker::load_history(&env, &followup)
        .await
        .unwrap()
        .is_empty());
    fixture.cleanup(&env).await;
}

#[actix_web::test]
#[serial]
async fn issue_3770_work_survives_cancellation_with_pagination_and_source_revalidation(
) {
    use crate::ai_agent::types::AiAgentMessageCitation;
    use crate::ai_agent::work_memory::{self, ReadWork, WorkRecord};
    use crate::entities::signal_message;
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = AgentFixture::new(&env).await;
    let request = running_request(&env, &fixture).await;
    let zone =
        crate::functest::tests::mk_sigint_zone(&env.dbx, Default::default())
            .await
            .unwrap();
    let mut human = fixture.human.clone().into_active_model();
    human.sigint_zone_id = Set(Some(zone.id));
    human.update(&env.dbx).await.unwrap();
    let source = crate::functest::tests::mk_signal_message(
        &env.dbx,
        signal_message::ActiveModel {
            id_uuid: Set(Some(Uuid::new_v4())),
            datasource_group_id: Set(None),
            login_id: Set(Some(fixture.human.id)),
            sender: Set(Some(fixture.human.id.to_string())),
            body: Set(Some("Retained evidence".to_string())),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let record = WorkRecord {
        version: 1,
        sequence: 1,
        kind: "tool".to_string(),
        tool: Some("echo_inbox_messages".to_string()),
        query: serde_json::json!({"cursor":"next-page"}),
        content: "Доказ ".repeat(5_000),
        citations: vec![AiAgentMessageCitation {
            message_id: source.id,
            message_identifier: source.id_uuid.unwrap().to_string(),
        }],
        file_citations: vec![],
        covers_through: None,
    };
    let (first, retry) = tokio::join!(
        work_memory::append_record(&env, &request, &record),
        work_memory::append_record(&env, &request, &record)
    );
    first.unwrap();
    retry.unwrap();
    let mut conflicting = record.clone();
    conflicting.content = "different".to_string();
    assert!(work_memory::append_record(&env, &request, &conflicting)
        .await
        .is_err());
    let checkpoint = WorkRecord {
        sequence: 2,
        kind: "checkpoint".to_string(),
        tool: None,
        content: serde_json::json!({
            "research": {
                "checklist": [{"task": "Summarize archive", "status": "pending"}],
                "draft": format!("Saved findings [джерело](/rer-analysis-neo?m={})", source.id_uuid.unwrap()),
                "gaps": ["next-page remains unread"]
            },
            "retrievals": [{"tool": "echo_inbox_messages", "query": {"search": "archive"}, "continuation": {"nextCursor": 42}}]
        }).to_string(),
        covers_through: Some(1),
        ..record.clone()
    };
    work_memory::append_record(&env, &request, &checkpoint)
        .await
        .unwrap();
    let newest = WorkRecord {
        sequence: 3,
        content: "Newest evidence".to_string(),
        ..record.clone()
    };
    work_memory::append_record(&env, &request, &newest)
        .await
        .unwrap();
    let oversized = WorkRecord {
        sequence: 4,
        content: "x".repeat(crate::config::AI_AGENT_WORK_RECORD_MAX_BYTES),
        ..record.clone()
    };
    assert!(work_memory::append_record(&env, &request, &oversized)
        .await
        .is_err());
    let out_of_order = WorkRecord {
        sequence: 5,
        ..record.clone()
    };
    assert!(work_memory::append_record(&env, &request, &out_of_order)
        .await
        .is_err());
    let mut cancelled = request.clone().into_active_model();
    cancelled.state = Set("cancelled".to_string());
    cancelled.cancellation_requested = Set(true);
    cancelled.update(&env.dbx).await.unwrap();
    assert!(work_memory::append_record(&env, &request, &checkpoint)
        .await
        .is_err());
    let mut followup = request.clone();
    followup.id = Uuid::now_v7();
    followup.queued_at += chrono::Duration::seconds(1);
    let query = ReadWork {
        request_id: request.id,
        after: 0,
        offset: 0,
    };
    let first = work_memory::read_records(&env, &followup, &query)
        .await
        .unwrap();
    assert_eq!(
        first["records"][0]["content"]
            .as_str()
            .unwrap()
            .chars()
            .count(),
        crate::config::AI_AGENT_WORK_READ_CHARS
    );
    assert_eq!(first["nextAfter"], 0);
    let second = work_memory::read_records(
        &env,
        &followup,
        &ReadWork {
            request_id: request.id,
            after: 0,
            offset: crate::config::AI_AGENT_WORK_READ_CHARS,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        format!(
            "{}{}",
            first["records"][0]["content"].as_str().unwrap(),
            second["records"][0]["content"].as_str().unwrap()
        ),
        record.content
    );
    let recap = work_memory::initial_context(&env, &followup).await.unwrap();
    assert!(recap["recap"].as_str().unwrap().contains("Saved findings"));
    assert!(
        recap["recap"].as_str().unwrap().contains("nextCursor"),
        "#3572"
    );
    assert!(
        recap["recap"]
            .as_str()
            .unwrap()
            .contains("Summarize archive"),
        "#3572"
    );
    assert!(recap["recap"].as_str().unwrap().contains("Newest evidence"));
    let last = work_memory::read_records(
        &env,
        &followup,
        &ReadWork {
            request_id: request.id,
            after: 2,
            offset: 0,
        },
    )
    .await
    .unwrap();
    assert!(last["nextAfter"].is_null());
    let mut outsider = followup.clone();
    outsider.human_login_id = Uuid::new_v4();
    assert!(work_memory::read_records(&env, &outsider, &query)
        .await
        .is_err());
    outsider = followup.clone();
    outsider.conversation_id = Uuid::new_v4();
    assert!(work_memory::read_records(&env, &outsider, &query)
        .await
        .is_err());
    assert!(work_memory::read_records(&env, &request, &query)
        .await
        .is_err());
    let mut revoked = source.into_active_model();
    revoked.deleted = Set(true);
    revoked.update(&env.dbx).await.unwrap();
    let hidden = work_memory::read_records(&env, &followup, &query)
        .await
        .unwrap();
    assert_eq!(hidden["records"][0]["unavailable"], true);
    let hidden = work_memory::read_records(
        &env,
        &followup,
        &ReadWork {
            request_id: request.id,
            after: 1,
            offset: 0,
        },
    )
    .await
    .unwrap();
    assert_eq!(hidden["records"][0]["unavailable"], true);
    assert!(
        !work_memory::initial_context(&env, &followup).await.unwrap()["recap"]
            .as_str()
            .unwrap()
            .contains("Saved findings")
    );
    let mut conversation =
        ai_agent_conversation::Entity::find_by_id(request.conversation_id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap()
            .into_active_model();
    conversation.deleted_at = Set(Some(chrono::Utc::now().naive_utc()));
    conversation.update(&env.dbx).await.unwrap();
    assert!(work_memory::read_records(&env, &followup, &query)
        .await
        .is_err());
    fixture.cleanup(&env).await;
}

#[actix_web::test]
#[serial]
async fn issue_3770_internal_work_append_requires_live_binding_without_spending_tool_calls(
) {
    use crate::ai_agent::work_memory;
    let (mut env, _guard) = cleanup_locked().await.unwrap();
    Arc::get_mut(&mut env)
        .unwrap()
        .config
        .ai_agent_work_memory_enabled = Some(true);
    let fixture = AgentFixture::new(&env).await;
    let request = running_request(&env, &fixture).await;
    let (token, correlation) =
        issue_bootstrap(&env, fixture.agent.id, Some(request.id), false)
            .await
            .unwrap();
    let mut agent = fixture.agent.clone().into_active_model();
    agent.deleted = Set(false);
    agent.update(&env.dbx).await.unwrap();
    let mut bound = request.clone().into_active_model();
    bound.correlation_id = Set(Some(correlation));
    bound.update(&env.dbx).await.unwrap();
    let app = test::init_service(
        bootstrap_app(env.clone())
            .await
            .service(work_memory::append)
            .service(work_memory::list)
            .service(work_memory::read),
    )
    .await;
    let response =
        test::call_service(&app, exchange(&token).to_request()).await;
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = response.response().cookies().next().unwrap().into_owned();
    let record = serde_json::json!({"version":1,"sequence":1,"kind":"tool","tool":"echo_current_user","query":null,"content":"profile checked","citations":[],"fileCitations":[],"coversThrough":null});
    let response = test::call_service(
        &app,
        identity(cookie.clone(), correlation)
            .method(actix_web::http::Method::POST)
            .uri(crate::config::AI_AGENT_WORK_APPEND_PATH)
            .set_json(&record)
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    use redis::AsyncCommands;
    let calls: Option<i64> = env
        .redis
        .clone()
        .get(api_call_count_key(correlation))
        .await
        .unwrap();
    assert_eq!(calls, None);
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(crate::config::AI_AGENT_WORK_APPEND_PATH)
            .set_json(&record)
            .to_request(),
    )
    .await;
    assert_ne!(response.status(), StatusCode::OK);
    revoke_request(&env, request.id).await.unwrap();
    assert!(test::try_call_service(
        &app,
        identity(cookie, correlation)
            .method(actix_web::http::Method::POST)
            .uri(crate::config::AI_AGENT_WORK_APPEND_PATH)
            .set_json(&record)
            .to_request()
    )
    .await
    .is_err());
    fixture.cleanup(&env).await;
}
