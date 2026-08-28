use super::access;
use super::auth;
use super::dispatcher::{DispatcherClient, DispatcherResponse};
use crate::config::{
    AI_AGENT_CONTAINER_NAME_PREFIX, AI_AGENT_HARNESS_RELEASE,
    AI_AGENT_LINKED_LOGIN_SUFFIX, AI_AGENT_MAX_RUNNING_CONTAINERS,
    AI_AGENT_ROLE_API, AI_AGENT_ROLE_CYBER, AI_AGENT_ROLE_RER,
    AI_AGENT_TEMPLATE_LOGIN_NAME,
};
use crate::entities::sea_orm_active_enums::DeactivationReasonEnum;
use crate::entities::{
    ai_agent_container, ai_agent_dispatcher, ai_agent_echo_proxy,
    ai_agent_request, ai_agent_user_link, ai_engine, login, secret_group_user,
};
use crate::error::AppError;
use crate::h;
use crate::types::{warn, Env, ShortContext};
use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ActiveValue::NotSet, ActiveValue::Set, ColumnTrait,
    ConnectionTrait, DatabaseBackend, DatabaseConnection, DatabaseTransaction,
    EntityTrait, IntoActiveModel, PaginatorTrait, QueryFilter, Statement,
    TransactionTrait,
};
use serde_json::json;
use url::Url;
use uuid::Uuid;

pub struct LinkedAgent {
    pub link: ai_agent_user_link::Model,
    pub login: login::Model,
    pub container: ai_agent_container::Model,
}

pub async fn reconcile_template_login(
    dbx: &DatabaseConnection,
) -> Result<login::Model, AppError> {
    let settings = access::settings(dbx).await?;
    let template_login_id = access::template_login_id(&settings)?;
    reconcile_template_login_id(dbx, template_login_id).await
}

pub async fn reconcile_template_login_id<C>(
    dbx: &C,
    template_login_id: Uuid,
) -> Result<login::Model, AppError>
where
    C: ConnectionTrait,
{
    let by_id = login::Entity::find_by_id(template_login_id)
        .one(dbx)
        .await
        .c(h!())?;
    let by_name = login::Entity::find()
        .filter(login::Column::Login.eq(AI_AGENT_TEMPLATE_LOGIN_NAME))
        .one(dbx)
        .await
        .c(h!())?;
    if by_id
        .as_ref()
        .is_some_and(|login| login.login != AI_AGENT_TEMPLATE_LOGIN_NAME)
        || by_name
            .as_ref()
            .is_some_and(|login| login.id != template_login_id)
    {
        return Err(AppError::BL {
            msg: "Template login UUID/name is owned by another account"
                .to_string(),
        });
    }
    let roles = agent_roles_json()?;
    let now = Utc::now().naive_utc();
    let template = match by_id.or(by_name) {
        Some(template) => {
            if template.deleted_permanently {
                return Err(AppError::BL {
                    msg: "Template login is permanently deleted".to_string(),
                });
            }
            let mut template = template.into_active_model();
            template.password = Set(None);
            template.password_auth_enabled = Set(false);
            template.roles = Set(roles);
            template.deleted = Set(true);
            template.deactivation_reason =
                Set(Some(DeactivationReasonEnum::Admin));
            template.update(dbx).await.c(h!())?
        }
        None => login::ActiveModel {
            login: Set(AI_AGENT_TEMPLATE_LOGIN_NAME.to_string()),
            password: Set(None),
            roles: Set(roles),
            created_at: Set(now),
            sigint_zone_id: Set(None),
            organism_id: Set(None),
            deleted: Set(true),
            delta_login_id: Set(None),
            last_active_at: Set(None),
            deactivation_reason: Set(Some(DeactivationReasonEnum::Admin)),
            deleted_permanently: Set(false),
            last_release_seen: Set(None),
            description: Set(Some(
                "Disabled template identity for the AI agent harness"
                    .to_string(),
            )),
            id: Set(template_login_id),
            password_auth_enabled: Set(false),
            totp_secret: Set(None),
        }
        .insert(dbx)
        .await
        .c(h!())?,
    };
    Ok(template)
}

pub async fn ensure_linked_agent(
    env: &Env,
    human_login_id: Uuid,
) -> Result<LinkedAgent, AppError> {
    crate::ai_agent::ensure_valid_human_target(&env.dbx, human_login_id)
        .await?;
    let txn = env.dbx.begin().await.c(h!())?;
    let human = login::Entity::find_by_id(human_login_id)
        .one(&txn)
        .await
        .c(h!())?
        .filter(|human| !human.deleted && !human.deleted_permanently)
        .ok_or(AppError::NotFound)?;
    let linked_name =
        format!("{}{}", human.login, AI_AGENT_LINKED_LOGIN_SUFFIX);
    let existing_link = ai_agent_user_link::Entity::find()
        .filter(ai_agent_user_link::Column::HumanLoginId.eq(human.id))
        .one(&txn)
        .await
        .c(h!())?;
    let (link, agent) = match existing_link {
        Some(link) => {
            let agent = login::Entity::find_by_id(link.agent_login_id)
                .one(&txn)
                .await
                .c(h!())?
                .ok_or_else(|| AppError::BL {
                    msg: "Linked AI agent login is missing".to_string(),
                })?;
            let agent =
                reconcile_linked_login_name(&txn, &link, &agent, &linked_name)
                    .await?;
            (link, agent)
        }
        None => create_link(&txn, &human, linked_name).await?,
    };
    let container = ensure_container(&txn, &link).await?;
    let agent = synchronize_agent_scope(&txn, &human, agent).await?;
    synchronize_direct_hidden_groups(&txn, human.id, agent.id).await?;
    crate::sigint::zone::bl::refresh_secret_group_memberships(&txn)
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(LinkedAgent {
        link,
        login: agent,
        container,
    })
}

async fn reconcile_linked_login_name(
    txn: &DatabaseTransaction,
    link: &ai_agent_user_link::Model,
    agent: &login::Model,
    linked_name: &str,
) -> Result<login::Model, AppError> {
    let name_owner = login::Entity::find()
        .filter(login::Column::Login.eq(linked_name))
        .one(txn)
        .await
        .c(h!())?;
    if agent.deleted_permanently
        || name_owner.is_some_and(|owner| owner.id != link.agent_login_id)
    {
        return Err(AppError::BL {
            msg: "Linked AI agent UUID/name ownership conflict".to_string(),
        });
    }
    if agent.login == linked_name {
        return Ok(agent.clone());
    }
    let human_login = linked_name
        .strip_suffix(AI_AGENT_LINKED_LOGIN_SUFFIX)
        .unwrap_or(linked_name);
    let mut agent = agent.clone().into_active_model();
    agent.login = Set(linked_name.to_string());
    agent.description = Set(Some(format!("AI agent linked to {human_login}")));
    agent.update(txn).await.c(h!()).map_err(Into::into)
}

async fn create_link(
    txn: &DatabaseTransaction,
    human: &login::Model,
    linked_name: String,
) -> Result<(ai_agent_user_link::Model, login::Model), AppError> {
    if login::Entity::find()
        .filter(login::Column::Login.eq(&linked_name))
        .one(txn)
        .await
        .c(h!())?
        .is_some()
    {
        return Err(AppError::BL {
            msg: "Linked AI agent login name is already owned".to_string(),
        });
    }
    let now = Utc::now().naive_utc();
    let agent_login_id = Uuid::now_v7();
    let agent = login::ActiveModel {
        login: Set(linked_name),
        password: Set(None),
        roles: Set(agent_roles_json()?),
        created_at: Set(now),
        sigint_zone_id: Set(human.sigint_zone_id),
        organism_id: Set(human.organism_id),
        deleted: Set(true),
        delta_login_id: Set(None),
        last_active_at: Set(None),
        deactivation_reason: Set(Some(DeactivationReasonEnum::Admin)),
        deleted_permanently: Set(false),
        last_release_seen: Set(None),
        description: Set(Some(format!("AI agent linked to {}", human.login))),
        id: Set(agent_login_id),
        password_auth_enabled: Set(false),
        totp_secret: Set(None),
    }
    .insert(txn)
    .await
    .c(h!())?;
    let link = ai_agent_user_link::ActiveModel {
        id: Set(Uuid::now_v7()),
        human_login_id: Set(human.id),
        agent_login_id: Set(agent.id),
        created_at: Set(now),
        updated_at: Set(now),
    }
    .insert(txn)
    .await
    .c(h!())?;
    Ok((link, agent))
}

async fn synchronize_agent_scope(
    txn: &DatabaseTransaction,
    human: &login::Model,
    agent: login::Model,
) -> Result<login::Model, AppError> {
    let mut agent = agent.into_active_model();
    agent.password = Set(None);
    agent.password_auth_enabled = Set(false);
    agent.roles = Set(agent_roles_json()?);
    agent.sigint_zone_id = Set(human.sigint_zone_id);
    agent.organism_id = Set(human.organism_id);
    agent.delta_login_id = Set(None);
    agent.deleted = Set(true);
    agent.deactivation_reason = Set(Some(DeactivationReasonEnum::Admin));
    agent.update(txn).await.c(h!()).map_err(Into::into)
}

async fn synchronize_direct_hidden_groups(
    txn: &DatabaseTransaction,
    human_login_id: Uuid,
    agent_login_id: Uuid,
) -> Result<(), AppError> {
    secret_group_user::Entity::delete_many()
        .filter(secret_group_user::Column::LoginId.eq(agent_login_id))
        .filter(secret_group_user::Column::SecretGroupOrganismId.is_null())
        .exec(txn)
        .await
        .c(h!())?;
    let direct_groups = secret_group_user::Entity::find()
        .filter(secret_group_user::Column::LoginId.eq(human_login_id))
        .filter(secret_group_user::Column::SecretGroupOrganismId.is_null())
        .all(txn)
        .await
        .c(h!())?;
    for direct_group in direct_groups {
        secret_group_user::ActiveModel {
            id: NotSet,
            master_key: Set(direct_group.master_key),
            login_id: Set(agent_login_id),
            secret_group_organism_id: Set(None),
        }
        .insert(txn)
        .await
        .c(h!())?;
    }
    Ok(())
}

async fn ensure_container(
    txn: &DatabaseTransaction,
    link: &ai_agent_user_link::Model,
) -> Result<ai_agent_container::Model, AppError> {
    if let Some(container) = ai_agent_container::Entity::find_by_id(link.id)
        .one(txn)
        .await
        .c(h!())?
    {
        return Ok(container);
    }
    let now = Utc::now().naive_utc();
    ai_agent_container::ActiveModel {
        ai_agent_user_link_id: Set(link.id),
        instance_name: Set(format!(
            "{AI_AGENT_CONTAINER_NAME_PREFIX}{}",
            link.agent_login_id
        )),
        state: Set("absent".to_string()),
        last_error: Set(None),
        stats: Set(None),
        started_at: Set(None),
        stopped_at: Set(None),
        last_activity_at: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
    }
    .insert(txn)
    .await
    .c(h!())
    .map_err(Into::into)
}

pub async fn start_for_user(
    env: &Env,
    human_login_id: Uuid,
    ai_engine: Option<&ai_engine::Model>,
) -> Result<LinkedAgent, AppError> {
    crate::ai_agent::ensure_valid_human_target(&env.dbx, human_login_id)
        .await?;
    let lifecycle_lock = env.dbx.begin().await.c(h!())?;
    lock_user_lifecycle(&lifecycle_lock, human_login_id).await?;
    if ai_engine.is_none() {
        ensure_manual_start_allowed(&lifecycle_lock, human_login_id).await?;
    }
    let result = start_for_user_locked(env, human_login_id, ai_engine).await;
    lifecycle_lock.commit().await.c(h!())?;
    result
}

pub async fn start_for_request(
    env: &Env,
    request_id: Uuid,
    human_login_id: Uuid,
    ai_engine: &ai_engine::Model,
) -> Result<Option<LinkedAgent>, AppError> {
    crate::ai_agent::ensure_valid_human_target(&env.dbx, human_login_id)
        .await?;
    let Some(lifecycle_lock) =
        begin_request_start_lifecycle(&env.dbx, request_id, human_login_id)
            .await?
    else {
        return Ok(None);
    };
    let result = start_for_user_locked(env, human_login_id, Some(ai_engine))
        .await
        .map(Some);
    lifecycle_lock.commit().await.c(h!())?;
    result
}

async fn begin_request_start_lifecycle(
    dbx: &DatabaseConnection,
    request_id: Uuid,
    human_login_id: Uuid,
) -> Result<Option<DatabaseTransaction>, AppError> {
    let lifecycle_lock = dbx.begin().await.c(h!())?;
    lock_user_lifecycle(&lifecycle_lock, human_login_id).await?;
    let request_is_running = ai_agent_request::Entity::find_by_id(request_id)
        .filter(ai_agent_request::Column::HumanLoginId.eq(human_login_id))
        .filter(ai_agent_request::Column::State.eq("running"))
        .filter(ai_agent_request::Column::CancellationRequested.eq(false))
        .one(&lifecycle_lock)
        .await
        .c(h!())?
        .is_some();
    if !request_is_running {
        lifecycle_lock.commit().await.c(h!())?;
        return Ok(None);
    }
    Ok(Some(lifecycle_lock))
}

async fn ensure_manual_start_allowed(
    lifecycle_lock: &DatabaseTransaction,
    human_login_id: Uuid,
) -> Result<(), AppError> {
    let has_active = ai_agent_request::Entity::find()
        .filter(ai_agent_request::Column::HumanLoginId.eq(human_login_id))
        .filter(ai_agent_request::Column::State.is_in(["queued", "running"]))
        .one(lifecycle_lock)
        .await
        .c(h!())?
        .is_some();
    manual_start_guard(has_active)
}

fn manual_start_guard(has_active: bool) -> Result<(), AppError> {
    if has_active {
        return Err(AppError::BL {
            msg:
                "AI agent cannot be started manually while requests are active"
                    .to_string(),
        });
    }
    Ok(())
}

async fn start_for_user_locked(
    env: &Env,
    human_login_id: Uuid,
    ai_engine: Option<&ai_engine::Model>,
) -> Result<LinkedAgent, AppError> {
    crate::users::ensure_rer_role_by_id(&env.dbx, &human_login_id).await?;
    let template = reconcile_template_login(&env.dbx).await?;
    preflight_template(env, template.id).await?;
    let mut linked = ensure_linked_agent(env, human_login_id).await?;
    auth::revoke_login_credentials(env, linked.login.id).await?;
    enforce_running_limit(&env.dbx, linked.link.id).await?;
    set_container_state(env, &linked.container, "starting", None).await?;
    let result = start_instance(env, template.id, &linked, ai_engine).await;
    if let Err(err) = result {
        cleanup_failed_start(env, &linked, &err).await;
        return Err(err);
    }
    linked.login = match activate_login_with_current_scope(
        &env.dbx,
        human_login_id,
        linked.login.id,
    )
    .await
    {
        Ok(login) => login,
        Err(err) => {
            cleanup_failed_start(env, &linked, &err).await;
            return Err(err);
        }
    };
    linked.container = match set_container_running(env, &linked.container).await
    {
        Ok(container) => container,
        Err(err) => {
            cleanup_failed_start(env, &linked, &err).await;
            return Err(err);
        }
    };
    Ok(linked)
}

async fn cleanup_failed_start(env: &Env, linked: &LinkedAgent, err: &AppError) {
    if let Err(cleanup_err) =
        auth::revoke_login_credentials(env, linked.login.id).await
    {
        warn!(
            "Could not revoke credentials after AI agent start failure: {cleanup_err:#?}"
        );
    }
    if let Err(cleanup_err) = disable_login(&env.dbx, linked.login.id).await {
        warn!(
            "Could not disable login after AI agent start failure: {cleanup_err:#?}"
        );
    }
    if let Ok(dispatcher) = DispatcherClient::from_env(env).await {
        if let Err(cleanup_err) = dispatcher
            .call(
                "stop",
                Some(linked.login.id),
                json!({ "timeout_seconds": 30 }),
            )
            .await
        {
            warn!(
                "Could not stop container after AI agent start failure: {cleanup_err:#?}"
            );
        }
    }
    let message = access::truncate(
        format!("{err:#}"),
        crate::config::AI_AGENT_ERROR_MAX_CHARS,
    );
    if let Err(cleanup_err) =
        set_container_state(env, &linked.container, "error", Some(message))
            .await
    {
        warn!("Could not persist AI agent start failure: {cleanup_err:#?}");
    }
}

async fn enforce_running_limit(
    dbx: &DatabaseConnection,
    current_link_id: Uuid,
) -> Result<(), AppError> {
    let running = ai_agent_container::Entity::find()
        .filter(
            ai_agent_container::Column::State.is_in(["starting", "running"]),
        )
        .filter(
            ai_agent_container::Column::AiAgentUserLinkId.ne(current_link_id),
        )
        .count(dbx)
        .await
        .c(h!())?;
    if running >= AI_AGENT_MAX_RUNNING_CONTAINERS {
        return Err(AppError::ServiceUnavailable {
            msg: "Maximum number of running AI agent containers reached"
                .to_string(),
            retry_after_secs: 30,
        });
    }
    Ok(())
}

pub async fn preflight_template(
    env: &Env,
    template_login_id: Uuid,
) -> Result<(), AppError> {
    preflight_template_for_db(&env.dbx, template_login_id).await
}

pub(crate) async fn preflight_template_for_db(
    dbx: &DatabaseConnection,
    template_login_id: Uuid,
) -> Result<(), AppError> {
    let dispatcher = ai_agent_dispatcher::Entity::find_by_id(
        crate::config::AI_AGENT_DISPATCHER_ID,
    )
    .one(dbx)
    .await
    .c(h!())?
    .ok_or_else(|| AppError::ServiceUnavailable {
        msg: "AI agent dispatcher is not configured".to_string(),
        retry_after_secs: 30,
    })?;
    let dispatcher = DispatcherClient::from_record(&dispatcher)?;
    preflight_template_with_dispatcher(&dispatcher, template_login_id).await
}

async fn preflight_template_with_dispatcher(
    dispatcher: &DispatcherClient,
    template_login_id: Uuid,
) -> Result<(), AppError> {
    let expected_namespace = dispatcher.namespace().to_string();
    let response = dispatcher
        .call(
            "preflight",
            None,
            json!({ "template_id": template_login_id }),
        )
        .await?;
    validate_preflight_result(
        &response.result,
        template_login_id,
        &expected_namespace,
    )
}

fn validate_preflight_result(
    result: &serde_json::Value,
    template_login_id: Uuid,
    expected_namespace: &str,
) -> Result<(), AppError> {
    let ready = result
        .get("template_ready")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let selected_template_matches = result
        .get("template_id")
        .and_then(|value| value.as_str())
        .is_some_and(|value| value == template_login_id.to_string());
    let namespace_matches = result
        .get("namespace")
        .and_then(|value| value.as_str())
        .is_some_and(|value| value == expected_namespace);
    if !ready || !selected_template_matches || !namespace_matches {
        return Err(AppError::BL {
            msg: "Configured AI agent template is not ready".to_string(),
        });
    }
    validate_harness_release(result)
}

async fn start_instance(
    env: &Env,
    template_login_id: Uuid,
    linked: &LinkedAgent,
    requested_engine: Option<&ai_engine::Model>,
) -> Result<(), AppError> {
    let dispatcher = DispatcherClient::from_env(env).await?;
    let ai_engine = match requested_engine {
        Some(ai_engine) => ai_engine.clone(),
        None => access::allowed_engine(&env.dbx, None).await?,
    };
    let echo_proxy = enabled_echo_proxy(env).await?;
    let provider_transport = access::agent_provider_transport(&ai_engine)
        .ok_or_else(|| {
            AppError::Forbidden(
                "AI engine is not supported by the agent harness".to_string(),
            )
        })?;
    let status = dispatcher
        .call("status", Some(linked.login.id), json!({}))
        .await;
    match status {
        Ok(status) => validate_compatible_instance(
            &status.result,
            &linked.container.instance_name,
            linked.login.id,
            dispatcher.namespace(),
            None,
        )?,
        Err(_) => {
            let cloned = dispatcher
                .call(
                    "clone",
                    Some(linked.login.id),
                    json!({ "template_id": template_login_id }),
                )
                .await?;
            validate_compatible_instance(
                &cloned.result,
                &linked.container.instance_name,
                linked.login.id,
                dispatcher.namespace(),
                Some("stopped"),
            )?;
        }
    }
    let started = dispatcher
        .call("start", Some(linked.login.id), json!({}))
        .await?;
    validate_compatible_instance(
        &started.result,
        &linked.container.instance_name,
        linked.login.id,
        dispatcher.namespace(),
        Some("running"),
    )?;
    let mut proxy_config = json!({
        "echo_hostname": echo_proxy.hostname,
        "echo_upstream": format!("{}:{}", echo_proxy.upstream_host, echo_proxy.upstream_port),
        "provider_transport": provider_transport.as_str(),
    });
    if provider_transport == access::AgentProviderTransport::DirectHttp {
        let engine_url = Url::parse(&ai_engine.url).c(h!())?;
        let engine_host = engine_url.host_str().c(h!())?;
        let engine_port = engine_url.port_or_known_default().c(h!())?;
        proxy_config["vllm_upstream"] =
            json!(format!("{engine_host}:{engine_port}"));
    }
    dispatcher
        .call("configure_proxies", Some(linked.login.id), proxy_config)
        .await?;
    test_connection_internal(env, linked).await?;
    Ok(())
}

fn validate_compatible_instance(
    result: &serde_json::Value,
    instance_name: &str,
    agent_login_id: Uuid,
    namespace: &str,
    expected_status: Option<&str>,
) -> Result<(), AppError> {
    let instance = result
        .get("instance")
        .ok_or_else(invalid_instance_inventory)?;
    let status = validated_instance_status(
        instance,
        instance_name,
        agent_login_id,
        namespace,
    )?;
    if expected_status.is_some_and(|expected| status != expected) {
        return Err(invalid_instance_inventory());
    }
    validate_harness_release(instance)
}

fn validate_harness_release(value: &serde_json::Value) -> Result<(), AppError> {
    if value
        .get("harness_release")
        .and_then(|release| release.as_str())
        != Some(AI_AGENT_HARNESS_RELEASE)
    {
        return Err(AppError::BL {
            msg: format!(
                "AI agent harness release is incompatible; expected {AI_AGENT_HARNESS_RELEASE}"
            ),
        });
    }
    Ok(())
}

async fn enabled_echo_proxy(
    env: &Env,
) -> Result<ai_agent_echo_proxy::Model, AppError> {
    ai_agent_echo_proxy::Entity::find()
        .filter(
            ai_agent_echo_proxy::Column::Hostname.eq(&env.config.public_host),
        )
        .filter(ai_agent_echo_proxy::Column::Enabled.eq(true))
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or_else(|| AppError::BL {
            msg: "No enabled Echo proxy matches public_host".to_string(),
        })
}

pub async fn test_connection(
    env: &Env,
    human_login_id: Uuid,
) -> Result<(), AppError> {
    let linked = load_linked_agent(env, human_login_id).await?;
    test_connection_internal(env, &linked).await
}

async fn test_connection_internal(
    env: &Env,
    linked: &LinkedAgent,
) -> Result<(), AppError> {
    let dispatcher = DispatcherClient::from_env(env).await?;
    let (token, correlation_id) =
        auth::issue_bootstrap(env, linked.login.id, None, true).await?;
    let roles = expected_agent_roles();
    let response = dispatcher
        .call(
            "test_connection",
            Some(linked.login.id),
            json!({
                "payload": {
                    "echoPublicHost": env.config.public_host,
                    "bootstrapToken": token,
                    "correlationId": correlation_id,
                    "correlationHeader": crate::config::AI_AGENT_CORRELATION_HEADER,
                    "expectedIdentity": {
                        "id": linked.login.id,
                        "name": linked.login.login.clone(),
                        "roles": roles,
                    },
                }
            }),
        )
        .await;
    auth::revoke_correlation(env, Some(linked.login.id), correlation_id)
        .await?;
    validate_test_response(response?, linked.login.id, &linked.login.login)
}

fn validate_test_response(
    response: DispatcherResponse,
    expected_login_id: Uuid,
    expected_login_name: &str,
) -> Result<(), AppError> {
    let data = response
        .events
        .iter()
        .find_map(connection_test_data)
        .or_else(|| connection_test_data(&response.result))
        .ok_or_else(|| AppError::BL {
            msg: "Connection test returned no identity".to_string(),
        })?;
    let login_id = data
        .get("id")
        .and_then(|value| value.as_str())
        .and_then(|value| Uuid::parse_str(value).ok());
    let login_name = data.get("name").and_then(|value| value.as_str());
    let role_values = data
        .get("roles")
        .and_then(|value| value.as_array())
        .ok_or_else(|| AppError::BL {
            msg: "Connection test returned unexpected identity or roles"
                .to_string(),
        })?;
    let mut roles = role_values
        .iter()
        .map(|value| value.as_str().map(str::to_string))
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| AppError::BL {
            msg: "Connection test returned unexpected identity or roles"
                .to_string(),
        })?;
    roles.sort();
    let mut expected_roles = expected_agent_roles();
    expected_roles.sort();
    if login_id != Some(expected_login_id)
        || login_name != Some(expected_login_name)
        || roles != expected_roles
    {
        return Err(AppError::BL {
            msg: "Connection test returned unexpected identity or roles"
                .to_string(),
        });
    }
    Ok(())
}

pub async fn force_stop_for_user(
    env: &Env,
    human_login_id: Uuid,
) -> Result<(), AppError> {
    let lifecycle_lock = env.dbx.begin().await.c(h!())?;
    lock_user_lifecycle(&lifecycle_lock, human_login_id).await?;
    let mut failures = StopFailures::default();
    if let Err(err) =
        crate::ai_agent::cancel_all_for_user(env, human_login_id).await
    {
        failures.record("request cancellation", &err);
    }
    stop_for_user_locked(env, human_login_id, &mut failures).await;
    lifecycle_lock.commit().await.c(h!())?;
    failures.into_result()
}

pub async fn stop_for_user_if_idle(
    env: &Env,
    human_login_id: Uuid,
) -> Result<bool, AppError> {
    let lifecycle_lock = env.dbx.begin().await.c(h!())?;
    lock_user_lifecycle(&lifecycle_lock, human_login_id).await?;
    let has_active = crate::entities::ai_agent_request::Entity::find()
        .filter(
            crate::entities::ai_agent_request::Column::HumanLoginId
                .eq(human_login_id),
        )
        .filter(
            crate::entities::ai_agent_request::Column::State
                .is_in(["queued", "running"]),
        )
        .one(&lifecycle_lock)
        .await
        .c(h!())?
        .is_some();
    if has_active {
        lifecycle_lock.commit().await.c(h!())?;
        return Ok(false);
    }
    let mut failures = StopFailures::default();
    stop_for_user_locked(env, human_login_id, &mut failures).await;
    lifecycle_lock.commit().await.c(h!())?;
    failures.into_result()?;
    Ok(true)
}

pub(crate) async fn stop_after_request_interruption(
    env: &Env,
    human_login_id: Uuid,
    request_id: Uuid,
) -> Result<bool, AppError> {
    fail_safe_stop_for_user(
        env,
        human_login_id,
        Some(request_id),
        &["creating", "starting", "running", "stopping", "error"],
        false,
    )
    .await
}

pub(crate) async fn stop_after_worker_recovery(
    env: &Env,
    human_login_id: Uuid,
) -> Result<bool, AppError> {
    fail_safe_stop_for_user(
        env,
        human_login_id,
        None,
        &["creating", "starting", "running", "stopping", "error"],
        false,
    )
    .await
}

pub(crate) async fn reconcile_abandoned_container(
    env: &Env,
    human_login_id: Uuid,
) -> Result<bool, AppError> {
    fail_safe_stop_for_user(
        env,
        human_login_id,
        None,
        &["creating", "starting", "stopping", "error"],
        true,
    )
    .await
}

async fn fail_safe_stop_for_user(
    env: &Env,
    human_login_id: Uuid,
    allowed_running_request_id: Option<Uuid>,
    target_states: &[&str],
    try_lock: bool,
) -> Result<bool, AppError> {
    let Some((lifecycle_lock, linked)) = prepare_fail_safe_stop(
        env,
        human_login_id,
        allowed_running_request_id,
        target_states,
        try_lock,
    )
    .await?
    else {
        return Ok(false);
    };
    let mut failures = StopFailures::default();
    stop_linked_agent_locked(env, &linked, &mut failures).await;
    lifecycle_lock.commit().await.c(h!())?;
    failures.into_result()?;
    Ok(true)
}

async fn prepare_fail_safe_stop(
    env: &Env,
    human_login_id: Uuid,
    allowed_running_request_id: Option<Uuid>,
    target_states: &[&str],
    try_lock: bool,
) -> Result<Option<(DatabaseTransaction, LinkedAgent)>, AppError> {
    let lifecycle_lock = env.dbx.begin().await.c(h!())?;
    let locked = if try_lock {
        try_lock_user_lifecycle(&lifecycle_lock, human_login_id).await?
    } else {
        lock_user_lifecycle(&lifecycle_lock, human_login_id).await?;
        true
    };
    if !locked {
        lifecycle_lock.commit().await.c(h!())?;
        return Ok(None);
    }
    let running_request_ids = ai_agent_request::Entity::find()
        .filter(ai_agent_request::Column::HumanLoginId.eq(human_login_id))
        .filter(ai_agent_request::Column::State.eq("running"))
        .all(&lifecycle_lock)
        .await
        .c(h!())?
        .into_iter()
        .map(|request| request.id)
        .collect::<Vec<_>>();
    let linked =
        match load_linked_agent_on(&lifecycle_lock, human_login_id).await {
            Ok(linked) => linked,
            Err(AppError::NotFound) => {
                lifecycle_lock.commit().await.c(h!())?;
                return Ok(None);
            }
            Err(err) => return Err(err),
        };
    let should_stop = fail_safe_stop_guard(
        &running_request_ids,
        allowed_running_request_id,
        &linked.container.state,
        target_states,
    );
    if !should_stop {
        lifecycle_lock.commit().await.c(h!())?;
        return Ok(None);
    }
    Ok(Some((lifecycle_lock, linked)))
}

fn fail_safe_stop_guard(
    running_request_ids: &[Uuid],
    allowed_running_request_id: Option<Uuid>,
    container_state: &str,
    target_states: &[&str],
) -> bool {
    let requests_allow_stop = match running_request_ids {
        [] => true,
        [request_id] => allowed_running_request_id == Some(*request_id),
        _ => false,
    };
    requests_allow_stop && target_states.contains(&container_state)
}

async fn stop_for_user_locked(
    env: &Env,
    human_login_id: Uuid,
    failures: &mut StopFailures,
) {
    let linked = match load_linked_agent(env, human_login_id).await {
        Ok(linked) => linked,
        Err(err) => {
            failures.record("linked agent lookup", &err);
            return;
        }
    };
    stop_linked_agent_locked(env, &linked, failures).await;
}

async fn stop_linked_agent_locked(
    env: &Env,
    linked: &LinkedAgent,
    failures: &mut StopFailures,
) {
    if let Err(err) = auth::revoke_login_credentials(env, linked.login.id).await
    {
        failures.record("credential revocation", &err);
    }
    if let Err(err) = disable_login(&env.dbx, linked.login.id).await {
        failures.record("login disabling", &err);
    }
    if let Err(err) = refresh_container_stats(env, &linked.container).await {
        warn!(
            "Could not refresh AI agent container stats before stop: {err:#?}"
        );
    }
    if let Err(err) =
        set_container_state(env, &linked.container, "stopping", None).await
    {
        failures.record("container state update", &err);
    }
    if let Err(err) = reconcile_physical_stop(env, linked).await {
        failures.record("physical container stop", &err);
        if let Err(state_err) = set_container_state(
            env,
            &linked.container,
            "error",
            Some(access::truncate(
                format!("{err:#}"),
                crate::config::AI_AGENT_ERROR_MAX_CHARS,
            )),
        )
        .await
        {
            failures.record("stop failure persistence", &state_err);
        }
    }
    if failures.has_failures() {
        let message = failures.state_error_message();
        if let Err(err) =
            set_container_state(env, &linked.container, "error", Some(message))
                .await
        {
            failures.record("stop failure persistence", &err);
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum HostInstanceStopState {
    Absent,
    Stopped,
    NeedsStop,
}

async fn reconcile_physical_stop(
    env: &Env,
    linked: &LinkedAgent,
) -> Result<(), AppError> {
    let dispatcher = DispatcherClient::from_env(env).await?;
    let inventory = dispatcher.call("list", None, json!({})).await?;
    match host_instance_stop_state(
        &inventory.result,
        &linked.container.instance_name,
        linked.login.id,
        dispatcher.namespace(),
    )? {
        HostInstanceStopState::Absent => {
            set_container_state(env, &linked.container, "absent", None).await?;
        }
        HostInstanceStopState::Stopped => {
            set_container_stopped(env, &linked.container).await?;
        }
        HostInstanceStopState::NeedsStop => {
            let response = dispatcher
                .call(
                    "stop",
                    Some(linked.login.id),
                    json!({ "timeout_seconds": 30 }),
                )
                .await?;
            validate_stopped_instance(
                &response.result,
                &linked.container.instance_name,
                linked.login.id,
                dispatcher.namespace(),
            )?;
            set_container_stopped(env, &linked.container).await?;
        }
    }
    Ok(())
}

fn host_instance_stop_state(
    result: &serde_json::Value,
    instance_name: &str,
    agent_login_id: Uuid,
    namespace: &str,
) -> Result<HostInstanceStopState, AppError> {
    let instances = result
        .get("instances")
        .and_then(|instances| instances.as_array())
        .ok_or_else(invalid_instance_inventory)?;
    let mut found = None;
    for instance in instances {
        let name = instance
            .get("name")
            .and_then(|name| name.as_str())
            .ok_or_else(invalid_instance_inventory)?;
        if name == instance_name {
            if found.is_some() {
                return Err(invalid_instance_inventory());
            }
            found = Some(instance);
        }
    }
    let Some(instance) = found else {
        return Ok(HostInstanceStopState::Absent);
    };
    let status = validated_instance_status(
        instance,
        instance_name,
        agent_login_id,
        namespace,
    )?;
    if status == "stopped" {
        Ok(HostInstanceStopState::Stopped)
    } else {
        Ok(HostInstanceStopState::NeedsStop)
    }
}

fn validate_stopped_instance(
    result: &serde_json::Value,
    instance_name: &str,
    agent_login_id: Uuid,
    namespace: &str,
) -> Result<(), AppError> {
    let instance = result
        .get("instance")
        .ok_or_else(invalid_instance_inventory)?;
    let status = validated_instance_status(
        instance,
        instance_name,
        agent_login_id,
        namespace,
    )?;
    if status != "stopped" {
        return Err(invalid_instance_inventory());
    }
    Ok(())
}

fn validated_instance_status(
    instance: &serde_json::Value,
    instance_name: &str,
    agent_login_id: Uuid,
    namespace: &str,
) -> Result<String, AppError> {
    let identity_matches = instance
        .get("name")
        .and_then(|name| name.as_str())
        .is_some_and(|name| name == instance_name)
        && instance
            .get("agent_id")
            .and_then(|agent_id| agent_id.as_str())
            .is_some_and(|agent_id| agent_id == agent_login_id.to_string())
        && instance
            .get("namespace")
            .and_then(|value| value.as_str())
            .is_some_and(|value| value == namespace);
    if !identity_matches {
        return Err(invalid_instance_inventory());
    }
    instance
        .get("status")
        .and_then(|status| status.as_str())
        .map(str::to_string)
        .ok_or_else(invalid_instance_inventory)
}

fn invalid_instance_inventory() -> AppError {
    AppError::BL {
        msg: "AI agent dispatcher returned invalid instance state".to_string(),
    }
}

#[derive(Default)]
struct StopFailures {
    steps: Vec<&'static str>,
}

impl StopFailures {
    fn record(&mut self, step: &'static str, err: &AppError) {
        warn!("AI agent stop step failed ({step}): {err:#?}");
        if !self.steps.contains(&step) {
            self.steps.push(step);
        }
    }

    fn into_result(self) -> Result<(), AppError> {
        if self.steps.is_empty() {
            return Ok(());
        }
        Err(AppError::BL {
            msg: format!(
                "AI agent stop encountered failures after all safety steps were attempted: {}",
                self.steps.join(", ")
            ),
        })
    }

    fn has_failures(&self) -> bool {
        !self.steps.is_empty()
    }

    fn state_error_message(&self) -> String {
        access::truncate(
            format!("AI agent stop incomplete: {}", self.steps.join(", ")),
            crate::config::AI_AGENT_ERROR_MAX_CHARS,
        )
    }
}

pub async fn lock_user_lifecycle(
    txn: &DatabaseTransaction,
    human_login_id: Uuid,
) -> Result<(), AppError> {
    txn.query_one_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "select pg_advisory_xact_lock($1)",
        [user_lifecycle_lock_key(human_login_id).into()],
    ))
    .await
    .c(h!())?;
    Ok(())
}

async fn try_lock_user_lifecycle(
    txn: &DatabaseTransaction,
    human_login_id: Uuid,
) -> Result<bool, AppError> {
    let row = txn
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "select pg_try_advisory_xact_lock($1) as acquired",
            [user_lifecycle_lock_key(human_login_id).into()],
        ))
        .await
        .c(h!())?
        .c(h!())?;
    row.try_get("", "acquired").c(h!()).map_err(Into::into)
}

fn user_lifecycle_lock_key(human_login_id: Uuid) -> i64 {
    let mut key = [0_u8; 8];
    key.copy_from_slice(&human_login_id.as_bytes()[..8]);
    i64::from_be_bytes(key)
}

pub(crate) async fn touch_container_activity_in_transaction(
    txn: &DatabaseTransaction,
    human_login_id: Uuid,
    now: chrono::NaiveDateTime,
) -> Result<(), AppError> {
    let link = ai_agent_user_link::Entity::find()
        .filter(ai_agent_user_link::Column::HumanLoginId.eq(human_login_id))
        .one(txn)
        .await
        .c(h!())?;
    if let Some(link) = link {
        let Some(container) = ai_agent_container::Entity::find_by_id(link.id)
            .one(txn)
            .await
            .c(h!())?
        else {
            return Ok(());
        };
        let mut container = container.into_active_model();
        container.last_activity_at = Set(Some(now));
        container.updated_at = Set(now);
        container.update(txn).await.c(h!())?;
    }
    Ok(())
}

pub async fn destroy_container(
    env: &Env,
    container: &ai_agent_container::Model,
) -> Result<(), AppError> {
    let link =
        ai_agent_user_link::Entity::find_by_id(container.ai_agent_user_link_id)
            .one(&env.dbx)
            .await
            .c(h!())?
            .ok_or(AppError::NotFound)?;
    let lifecycle_lock = env.dbx.begin().await.c(h!())?;
    lock_user_lifecycle(&lifecycle_lock, link.human_login_id).await?;
    let Some(container) = ai_agent_container::Entity::find_by_id(link.id)
        .one(&lifecycle_lock)
        .await
        .c(h!())?
    else {
        lifecycle_lock.commit().await.c(h!())?;
        return Ok(());
    };
    let expired = container.state == "stopped"
        && container.stopped_at.is_some_and(|stopped_at| {
            stopped_at
                <= Utc::now().naive_utc()
                    - chrono::Duration::days(
                        crate::config::AI_AGENT_DESTROY_STOPPED_DAYS,
                    )
        });
    let has_active = crate::entities::ai_agent_request::Entity::find()
        .filter(
            crate::entities::ai_agent_request::Column::HumanLoginId
                .eq(link.human_login_id),
        )
        .filter(
            crate::entities::ai_agent_request::Column::State
                .is_in(["queued", "running"]),
        )
        .one(&lifecycle_lock)
        .await
        .c(h!())?
        .is_some();
    if !expired || has_active {
        lifecycle_lock.commit().await.c(h!())?;
        return Ok(());
    }
    let container = refresh_container_stats(env, &container).await?;
    DispatcherClient::from_env(env)
        .await?
        .call("destroy", Some(link.agent_login_id), json!({}))
        .await?;
    set_container_state(env, &container, "absent", None).await?;
    lifecycle_lock.commit().await.c(h!())?;
    Ok(())
}

pub async fn load_linked_agent(
    env: &Env,
    human_login_id: Uuid,
) -> Result<LinkedAgent, AppError> {
    load_linked_agent_on(&env.dbx, human_login_id).await
}

async fn load_linked_agent_on<C>(
    dbx: &C,
    human_login_id: Uuid,
) -> Result<LinkedAgent, AppError>
where
    C: ConnectionTrait,
{
    let link = ai_agent_user_link::Entity::find()
        .filter(ai_agent_user_link::Column::HumanLoginId.eq(human_login_id))
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    let agent = login::Entity::find_by_id(link.agent_login_id)
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    let container = ai_agent_container::Entity::find_by_id(link.id)
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    Ok(LinkedAgent {
        link,
        login: agent,
        container,
    })
}

pub async fn refresh_container_stats(
    env: &Env,
    container: &ai_agent_container::Model,
) -> Result<ai_agent_container::Model, AppError> {
    let link =
        ai_agent_user_link::Entity::find_by_id(container.ai_agent_user_link_id)
            .one(&env.dbx)
            .await
            .c(h!())?
            .ok_or(AppError::NotFound)?;
    let response = DispatcherClient::from_env(env)
        .await?
        .call("stats", Some(link.agent_login_id), json!({}))
        .await?;
    let mut container = container.clone().into_active_model();
    container.stats = Set(Some(response.result));
    container.updated_at = Set(Utc::now().naive_utc());
    container.update(&env.dbx).await.c(h!()).map_err(Into::into)
}

async fn activate_login_with_current_scope(
    dbx: &DatabaseConnection,
    human_login_id: Uuid,
    agent_login_id: Uuid,
) -> Result<login::Model, AppError> {
    let txn = dbx.begin().await.c(h!())?;
    let agent = activate_login_with_current_scope_in_transaction(
        &txn,
        human_login_id,
        agent_login_id,
    )
    .await?;
    txn.commit().await.c(h!())?;
    Ok(agent)
}

async fn activate_login_with_current_scope_in_transaction(
    txn: &DatabaseTransaction,
    human_login_id: Uuid,
    agent_login_id: Uuid,
) -> Result<login::Model, AppError> {
    let human = login::Entity::find_by_id(human_login_id)
        .one(txn)
        .await
        .c(h!())?
        .filter(|human| !human.deleted && !human.deleted_permanently)
        .ok_or(AppError::NotFound)?;
    let link = ai_agent_user_link::Entity::find()
        .filter(ai_agent_user_link::Column::HumanLoginId.eq(human_login_id))
        .filter(ai_agent_user_link::Column::AgentLoginId.eq(agent_login_id))
        .one(txn)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    let agent = login::Entity::find_by_id(agent_login_id)
        .one(txn)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    let linked_name =
        format!("{}{}", human.login, AI_AGENT_LINKED_LOGIN_SUFFIX);
    let agent =
        reconcile_linked_login_name(txn, &link, &agent, &linked_name).await?;
    let agent = synchronize_agent_scope(txn, &human, agent).await?;
    synchronize_direct_hidden_groups(txn, human.id, agent.id).await?;
    let mut agent = agent.into_active_model();
    agent.deleted = Set(false);
    agent.deactivation_reason = Set(None);
    agent.last_active_at = Set(Some(Utc::now().naive_utc()));
    let agent = agent.update(txn).await.c(h!())?;
    crate::sigint::zone::bl::refresh_secret_group_memberships(txn)
        .await
        .c(h!())?;
    Ok(agent)
}

async fn disable_login(
    dbx: &DatabaseConnection,
    login_id: Uuid,
) -> Result<login::Model, AppError> {
    let login = login::Entity::find_by_id(login_id)
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    let mut login = login.into_active_model();
    login.deleted = Set(true);
    login.deactivation_reason = Set(Some(DeactivationReasonEnum::Admin));
    login.update(dbx).await.c(h!()).map_err(Into::into)
}

async fn set_container_state(
    env: &Env,
    container: &ai_agent_container::Model,
    state: &str,
    last_error: Option<String>,
) -> Result<ai_agent_container::Model, AppError> {
    let mut container = container.clone().into_active_model();
    container.state = Set(state.to_string());
    container.last_error = Set(last_error);
    container.updated_at = Set(Utc::now().naive_utc());
    container.update(&env.dbx).await.c(h!()).map_err(Into::into)
}

async fn set_container_running(
    env: &Env,
    container: &ai_agent_container::Model,
) -> Result<ai_agent_container::Model, AppError> {
    let now = Utc::now().naive_utc();
    let mut container = container.clone().into_active_model();
    container.state = Set("running".to_string());
    container.last_error = Set(None);
    container.started_at = Set(Some(now));
    container.stopped_at = Set(None);
    container.last_activity_at = Set(Some(now));
    container.updated_at = Set(now);
    container.update(&env.dbx).await.c(h!()).map_err(Into::into)
}

async fn set_container_stopped(
    env: &Env,
    container: &ai_agent_container::Model,
) -> Result<ai_agent_container::Model, AppError> {
    let now = Utc::now().naive_utc();
    let mut container = container.clone().into_active_model();
    container.state = Set("stopped".to_string());
    container.last_error = Set(None);
    container.stopped_at = Set(Some(now));
    container.updated_at = Set(now);
    container.update(&env.dbx).await.c(h!()).map_err(Into::into)
}

fn agent_roles_json() -> Result<serde_json::Value, AppError> {
    serde_json::to_value(expected_agent_roles())
        .c(h!())
        .map_err(Into::into)
}

fn connection_test_data(
    value: &serde_json::Value,
) -> Option<&serde_json::Value> {
    if has_exact_identity_shape(value) {
        return Some(value);
    }
    value
        .get("payload")
        .filter(|payload| has_exact_identity_shape(payload))
}

fn has_exact_identity_shape(value: &serde_json::Value) -> bool {
    value.as_object().is_some_and(|identity| {
        identity.len() == 3
            && identity.contains_key("id")
            && identity.contains_key("name")
            && identity.contains_key("roles")
    })
}

fn expected_agent_roles() -> Vec<String> {
    vec![
        AI_AGENT_ROLE_API.to_string(),
        AI_AGENT_ROLE_RER.to_string(),
        AI_AGENT_ROLE_CYBER.to_string(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::{
        ai_agent_conversation, ai_engine, secret_group_organism, signal_group,
    };
    use serial_test::serial;

    #[test]
    fn linked_account_roles_are_least_privilege() {
        let roles: Vec<String> =
            serde_json::from_value(agent_roles_json().unwrap()).unwrap();
        assert_eq!(roles, vec!["ApiAgent", "Rer", "Cyber"]);
        assert!(!roles.iter().any(|role| {
            matches!(role.as_str(), "Admin" | "UnitsEditor" | "CallsignsEditor")
        }));
    }

    #[test]
    fn expected_harness_release_matches_bundle() {
        let expected = format!("HARNESS_RELEASE={AI_AGENT_HARNESS_RELEASE}");
        assert!(include_str!("../../../echo-ai-agent/versions.env")
            .lines()
            .any(|line| line == expected));
    }

    #[test]
    fn manual_start_rejects_active_requests_before_lifecycle_work() {
        assert!(manual_start_guard(false).is_ok());
        assert!(manual_start_guard(true).is_err());
    }

    #[test]
    fn fail_safe_stop_preserves_unrelated_active_requests() {
        let timed_out_request_id = Uuid::now_v7();
        let other_request_id = Uuid::now_v7();
        let risky_states =
            ["creating", "starting", "running", "stopping", "error"];

        assert!(fail_safe_stop_guard(&[], None, "creating", &risky_states));
        assert!(fail_safe_stop_guard(
            &[timed_out_request_id],
            Some(timed_out_request_id),
            "running",
            &risky_states
        ));
        assert!(!fail_safe_stop_guard(
            &[other_request_id],
            Some(timed_out_request_id),
            "starting",
            &risky_states
        ));
        assert!(!fail_safe_stop_guard(
            &[timed_out_request_id],
            None,
            "error",
            &risky_states
        ));
        assert!(!fail_safe_stop_guard(&[], None, "stopped", &risky_states));
    }

    #[test]
    fn physical_stop_reconciles_host_inventory_fail_closed() {
        let agent_login_id = Uuid::now_v7();
        let instance_name = format!("echo-ai-agent-{agent_login_id}");
        let instance = || {
            json!({
                "name": instance_name,
                "status": "running",
                "agent_id": agent_login_id,
                "namespace": "echo-staging",
            })
        };
        assert_eq!(
            host_instance_stop_state(
                &json!({ "instances": [] }),
                &instance_name,
                agent_login_id,
                "echo-staging",
            )
            .unwrap(),
            HostInstanceStopState::Absent
        );
        assert_eq!(
            host_instance_stop_state(
                &json!({ "instances": [instance()] }),
                &instance_name,
                agent_login_id,
                "echo-staging",
            )
            .unwrap(),
            HostInstanceStopState::NeedsStop
        );
        let mut stopped = instance();
        stopped["status"] = json!("stopped");
        assert_eq!(
            host_instance_stop_state(
                &json!({ "instances": [stopped.clone()] }),
                &instance_name,
                agent_login_id,
                "echo-staging",
            )
            .unwrap(),
            HostInstanceStopState::Stopped
        );
        validate_stopped_instance(
            &json!({ "instance": stopped }),
            &instance_name,
            agent_login_id,
            "echo-staging",
        )
        .unwrap();

        let mut wrong_owner = instance();
        wrong_owner["agent_id"] = json!(Uuid::now_v7());
        assert!(host_instance_stop_state(
            &json!({ "instances": [wrong_owner] }),
            &instance_name,
            agent_login_id,
            "echo-staging",
        )
        .is_err());
        assert!(host_instance_stop_state(
            &json!({ "instances": [{}] }),
            &instance_name,
            agent_login_id,
            "echo-staging",
        )
        .is_err());
    }

    #[tokio::test]
    #[serial]
    async fn abandoned_reconciliation_skips_an_active_lifecycle_lock() {
        crate::tests::test::init().await;
        let dbx = crate::new_pg_pool_from_mode(crate::types::Mode::Test)
            .await
            .unwrap();
        let human_login_id = Uuid::now_v7();
        let active_start = dbx.begin().await.unwrap();
        lock_user_lifecycle(&active_start, human_login_id)
            .await
            .unwrap();
        let reconciliation = dbx.begin().await.unwrap();

        assert!(!try_lock_user_lifecycle(&reconciliation, human_login_id)
            .await
            .unwrap());
        active_start.rollback().await.unwrap();
        assert!(try_lock_user_lifecycle(&reconciliation, human_login_id)
            .await
            .unwrap());
        reconciliation.rollback().await.unwrap();
    }

    #[test]
    fn stop_failures_are_aggregated_after_safety_steps() {
        let mut failures = StopFailures::default();
        failures.record("credential revocation", &AppError::NotFound);
        failures.record("credential revocation", &AppError::NotFound);
        failures.record("physical container stop", &AppError::NotFound);

        assert_eq!(
            failures.steps,
            vec!["credential revocation", "physical container stop"]
        );
        let Err(AppError::BL { msg }) = failures.into_result() else {
            panic!("stop failures must be returned as one business error");
        };
        assert!(msg.contains("credential revocation"));
        assert!(msg.contains("physical container stop"));
    }

    #[test]
    fn connection_test_requires_exact_identity_and_roles() {
        let login_id = Uuid::now_v7();
        let valid = || DispatcherResponse {
            result: json!({
                "id": login_id,
                "name": "ziggy-ai-agent",
                "roles": ["ApiAgent", "Rer", "Cyber"],
            }),
            events: vec![],
        };
        assert!(
            validate_test_response(valid(), login_id, "ziggy-ai-agent").is_ok()
        );

        let mut wrong_id = valid();
        wrong_id.result["id"] = json!(Uuid::now_v7());
        assert!(validate_test_response(wrong_id, login_id, "ziggy-ai-agent")
            .is_err());

        let mut elevated = valid();
        elevated.result["roles"] = json!(["ApiAgent", "Rer", "Cyber", "Admin"]);
        assert!(validate_test_response(elevated, login_id, "ziggy-ai-agent")
            .is_err());

        let mut malformed = valid();
        malformed.result["roles"] = json!(["ApiAgent", "Rer", "Cyber", 1]);
        assert!(
            validate_test_response(malformed, login_id, "ziggy-ai-agent")
                .is_err()
        );

        let mut extra_field = valid();
        extra_field.result["password"] = json!("secret");
        assert!(validate_test_response(
            extra_field,
            login_id,
            "ziggy-ai-agent"
        )
        .is_err());
    }

    #[test]
    fn preflight_requires_exact_dispatcher_identity_and_release() {
        let template_login_id = Uuid::now_v7();
        let result = json!({
            "template_ready": true,
            "template_id": template_login_id,
            "namespace": "echo-staging",
            "harness_release": AI_AGENT_HARNESS_RELEASE,
        });

        assert!(validate_preflight_result(
            &result,
            template_login_id,
            "echo-staging"
        )
        .is_ok());
        assert!(validate_preflight_result(
            &result,
            template_login_id,
            "echo-production"
        )
        .is_err());

        let mut missing_namespace = result.clone();
        missing_namespace
            .as_object_mut()
            .unwrap()
            .remove("namespace");
        assert!(validate_preflight_result(
            &missing_namespace,
            template_login_id,
            "echo-staging"
        )
        .is_err());

        let mut missing_release = result.clone();
        missing_release
            .as_object_mut()
            .unwrap()
            .remove("harness_release");
        assert!(validate_preflight_result(
            &missing_release,
            template_login_id,
            "echo-staging"
        )
        .is_err());

        let mut wrong_release = result;
        wrong_release["harness_release"] = json!("2026.08.22.1");
        assert!(validate_preflight_result(
            &wrong_release,
            template_login_id,
            "echo-staging"
        )
        .is_err());
    }

    #[test]
    fn started_instance_requires_exact_identity_state_and_release() {
        let agent_login_id = Uuid::now_v7();
        let instance_name = format!("echo-ai-agent-{agent_login_id}");
        let result = json!({
            "instance": {
                "name": instance_name,
                "status": "running",
                "agent_id": agent_login_id,
                "namespace": "echo-staging",
                "harness_release": AI_AGENT_HARNESS_RELEASE,
            }
        });

        assert!(validate_compatible_instance(
            &result,
            &instance_name,
            agent_login_id,
            "echo-staging",
            Some("running")
        )
        .is_ok());

        let mut wrong_release = result.clone();
        wrong_release["instance"]["harness_release"] = json!("2026.08.22.1");
        assert!(validate_compatible_instance(
            &wrong_release,
            &instance_name,
            agent_login_id,
            "echo-staging",
            Some("running")
        )
        .is_err());

        assert!(validate_compatible_instance(
            &result,
            &instance_name,
            agent_login_id,
            "echo-staging",
            Some("stopped")
        )
        .is_err());
        assert!(validate_compatible_instance(
            &result,
            &instance_name,
            Uuid::now_v7(),
            "echo-staging",
            Some("running")
        )
        .is_err());
    }

    #[tokio::test]
    #[serial]
    async fn request_start_rechecks_cancellation_after_lifecycle_lock() {
        let (env, _cleanup_guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let human = crate::functest::tests::find_test_login(&env.dbx)
            .await
            .unwrap();
        let now = Utc::now().naive_utc();
        let ai_engine = ai_engine::ActiveModel {
            id: Set(Uuid::now_v7()),
            name: Set(format!("lifecycle-race-{}", Uuid::now_v7())),
            url: Set("http://127.0.0.1:18000/v1".to_string()),
            token: Set(None),
            model_name: Set("test".to_string()),
            created_at: Set(now),
            updated_at: Set(now),
            enabled: Set(true),
            callsign_enabled: Set(true),
            ocr_enabled: Set(false),
            ocr_request_profile: Set("openai_vision".to_string()),
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let conversation = ai_agent_conversation::ActiveModel {
            id: Set(Uuid::now_v7()),
            human_login_id: Set(human.id),
            ai_engine_id: Set(ai_engine.id),
            title: Set("Lifecycle race".to_string()),
            created_at: Set(now),
            updated_at: Set(now),
            deleted_at: Set(None),
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let request = ai_agent_request::ActiveModel {
            id: Set(Uuid::now_v7()),
            conversation_id: Set(conversation.id),
            human_login_id: Set(human.id),
            agent_login_id: Set(None),
            ai_engine_id: Set(ai_engine.id),
            prompt: Set("race".to_string()),
            response: Set(None),
            state: Set("running".to_string()),
            cancellation_requested: Set(false),
            error: Set(None),
            correlation_id: Set(None),
            queued_at: Set(now),
            started_at: Set(Some(now)),
            completed_at: Set(None),
            updated_at: Set(now),
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let request_id = request.id;

        let blocker = env.dbx.begin().await.unwrap();
        lock_user_lifecycle(&blocker, human.id).await.unwrap();
        let mut waiter = Box::pin(begin_request_start_lifecycle(
            &env.dbx, request_id, human.id,
        ));
        assert!(tokio::time::timeout(
            std::time::Duration::from_millis(100),
            waiter.as_mut(),
        )
        .await
        .is_err());

        let request = ai_agent_request::Entity::find_by_id(request_id)
            .one(&blocker)
            .await
            .unwrap()
            .unwrap();
        let mut request = request.into_active_model();
        request.state = Set("cancelled".to_string());
        request.cancellation_requested = Set(true);
        request.completed_at = Set(Some(now));
        request.updated_at = Set(now);
        request.update(&blocker).await.unwrap();
        blocker.commit().await.unwrap();

        let lifecycle_lock =
            tokio::time::timeout(std::time::Duration::from_secs(2), waiter)
                .await
                .unwrap()
                .unwrap();
        assert!(lifecycle_lock.is_none());

        ai_agent_request::Entity::delete_by_id(request_id)
            .exec(&env.dbx)
            .await
            .unwrap();
        ai_agent_conversation::Entity::delete_by_id(conversation.id)
            .exec(&env.dbx)
            .await
            .unwrap();
        ai_engine::Entity::delete_by_id(ai_engine.id)
            .exec(&env.dbx)
            .await
            .unwrap();
    }

    #[tokio::test]
    #[serial]
    async fn activation_materializes_latest_direct_and_organism_scope() {
        let (env, _cleanup_guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let human = crate::functest::tests::find_test_login(&env.dbx)
            .await
            .unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let direct_group = crate::functest::tests::mk_signal_group(
            &txn,
            signal_group::ActiveModel {
                master_key: Set(format!("agent-direct-{}", Uuid::now_v7())),
                is_secret: Set(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let organism_group = crate::functest::tests::mk_signal_group(
            &txn,
            signal_group::ActiveModel {
                master_key: Set(format!("agent-organism-{}", Uuid::now_v7())),
                is_secret: Set(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        crate::functest::tests::mk_secret_group_user(
            &txn,
            secret_group_user::ActiveModel {
                master_key: Set(direct_group.master_key.clone()),
                login_id: Set(human.id),
                secret_group_organism_id: Set(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let invite = secret_group_organism::ActiveModel {
            id: NotSet,
            master_key: Set(organism_group.master_key.clone()),
            organism_id: Set(human.organism_id.unwrap()),
            created_at: Set(Utc::now().naive_utc()),
        }
        .insert(&txn)
        .await
        .unwrap();
        let agent = crate::functest::tests::mk_login(
            &txn,
            login::ActiveModel {
                id: NotSet,
                login: Set(format!(
                    "{}{}",
                    human.login, AI_AGENT_LINKED_LOGIN_SUFFIX
                )),
                password: Set(Some("stale".to_string())),
                password_auth_enabled: Set(true),
                roles: Set(json!(["Admin"])),
                sigint_zone_id: Set(None),
                organism_id: Set(None),
                deleted: Set(true),
                deactivation_reason: Set(Some(DeactivationReasonEnum::Admin)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let link = ai_agent_user_link::ActiveModel {
            id: Set(Uuid::now_v7()),
            human_login_id: Set(human.id),
            agent_login_id: Set(agent.id),
            created_at: Set(Utc::now().naive_utc()),
            updated_at: Set(Utc::now().naive_utc()),
        }
        .insert(&txn)
        .await
        .unwrap();

        let agent = activate_login_with_current_scope_in_transaction(
            &txn, human.id, agent.id,
        )
        .await
        .unwrap();
        assert!(!agent.deleted);
        assert_eq!(agent.password, None);
        assert!(!agent.password_auth_enabled);
        assert_eq!(agent.organism_id, human.organism_id);
        assert_eq!(agent.sigint_zone_id, human.sigint_zone_id);
        let roles: Vec<String> = serde_json::from_value(agent.roles).unwrap();
        assert_eq!(roles, expected_agent_roles());
        let memberships = secret_group_user::Entity::find()
            .filter(secret_group_user::Column::LoginId.eq(agent.id))
            .all(&txn)
            .await
            .unwrap();
        assert!(memberships.iter().any(|membership| {
            membership.master_key == direct_group.master_key
                && membership.secret_group_organism_id.is_none()
        }));
        assert!(memberships.iter().any(|membership| {
            membership.master_key == organism_group.master_key
                && membership.secret_group_organism_id == Some(invite.id)
        }));
        assert_eq!(link.agent_login_id, agent.id);

        txn.rollback().await.unwrap();
    }

    #[tokio::test]
    #[serial]
    async fn activation_reconciles_linked_login_after_human_rename() {
        let (env, _cleanup_guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let human = crate::functest::tests::find_test_login(&env.dbx)
            .await
            .unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let agent = crate::functest::tests::mk_login(
            &txn,
            login::ActiveModel {
                id: NotSet,
                login: Set(format!(
                    "{}{}",
                    human.login, AI_AGENT_LINKED_LOGIN_SUFFIX
                )),
                password: Set(None),
                password_auth_enabled: Set(false),
                roles: Set(json!(["ApiAgent", "Rer", "Cyber"])),
                deleted: Set(true),
                deactivation_reason: Set(Some(DeactivationReasonEnum::Admin)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        ai_agent_user_link::ActiveModel {
            id: Set(Uuid::now_v7()),
            human_login_id: Set(human.id),
            agent_login_id: Set(agent.id),
            created_at: Set(Utc::now().naive_utc()),
            updated_at: Set(Utc::now().naive_utc()),
        }
        .insert(&txn)
        .await
        .unwrap();
        let renamed_login = format!("agent-rename-{}", Uuid::now_v7());
        let mut human = human.into_active_model();
        human.login = Set(renamed_login.clone());
        let human = human.update(&txn).await.unwrap();

        let agent = activate_login_with_current_scope_in_transaction(
            &txn, human.id, agent.id,
        )
        .await
        .unwrap();

        assert_eq!(
            agent.login,
            format!("{renamed_login}{AI_AGENT_LINKED_LOGIN_SUFFIX}")
        );
        assert_eq!(
            agent.description,
            Some(format!("AI agent linked to {renamed_login}"))
        );

        txn.rollback().await.unwrap();
    }

    #[tokio::test]
    #[serial]
    async fn cancellation_activity_resets_container_idle_window() {
        let (env, _cleanup_guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let human = crate::functest::tests::find_test_login(&env.dbx)
            .await
            .unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let agent = crate::functest::tests::mk_login(
            &txn,
            login::ActiveModel {
                id: NotSet,
                login: Set(format!("activity-agent-{}", Uuid::now_v7())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let now = Utc::now().naive_utc();
        let old_activity = now - chrono::Duration::hours(1);
        let link = ai_agent_user_link::ActiveModel {
            id: Set(Uuid::now_v7()),
            human_login_id: Set(human.id),
            agent_login_id: Set(agent.id),
            created_at: Set(old_activity),
            updated_at: Set(old_activity),
        }
        .insert(&txn)
        .await
        .unwrap();
        ai_agent_container::ActiveModel {
            ai_agent_user_link_id: Set(link.id),
            instance_name: Set(format!(
                "activity-container-{}",
                Uuid::now_v7()
            )),
            state: Set("running".to_string()),
            last_error: Set(None),
            stats: Set(None),
            started_at: Set(Some(old_activity)),
            stopped_at: Set(None),
            last_activity_at: Set(Some(old_activity)),
            created_at: Set(old_activity),
            updated_at: Set(old_activity),
        }
        .insert(&txn)
        .await
        .unwrap();

        touch_container_activity_in_transaction(&txn, human.id, now)
            .await
            .unwrap();
        let container = ai_agent_container::Entity::find_by_id(link.id)
            .one(&txn)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            container
                .last_activity_at
                .unwrap()
                .and_utc()
                .timestamp_micros(),
            now.and_utc().timestamp_micros()
        );
        assert_eq!(
            container.updated_at.and_utc().timestamp_micros(),
            now.and_utc().timestamp_micros()
        );

        txn.rollback().await.unwrap();
    }
}
