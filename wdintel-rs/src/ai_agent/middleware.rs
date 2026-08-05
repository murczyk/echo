use super::auth::{
    api_call_count_key, credential_key, AgentSessionBinding, CredentialGrant,
};
use crate::config::{
    AI_AGENT_API_CALL_LIMIT, AI_AGENT_CORRELATION_HEADER,
    AI_AGENT_CREDENTIAL_TTL_SEC, AI_AGENT_ROLE_API,
    AI_AGENT_SESSION_BINDING_KEY,
};
use crate::entities::{ai_agent_request, login};
use crate::types::{warn, Env};
use actix_session::SessionExt;
use actix_web::{
    body::MessageBody,
    dev::{ServiceRequest, ServiceResponse},
    middleware::Next,
    Error,
};
use redis::AsyncCommands;
use sea_orm::{
    ColumnTrait, DatabaseBackend, EntityTrait, FromQueryResult, QueryFilter,
    Statement,
};
use uuid::Uuid;

#[derive(Debug, FromQueryResult)]
struct ManagedAgentLoginMarker {
    id: Uuid,
    human_login_id: Uuid,
}

pub async fn enforce_agent_routes<B>(
    req: ServiceRequest,
    next: Next<B>,
) -> Result<ServiceResponse<B>, Error>
where
    B: MessageBody,
{
    let Some(login_id) = session_login_id(&req)? else {
        return next.call(req).await;
    };
    let Some(env) = req.app_data::<actix_web::web::Data<Env>>() else {
        return next.call(req).await;
    };
    let agent_login = ManagedAgentLoginMarker::find_by_statement(
        Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
select link.agent_login_id as id, link.human_login_id
from ai_agent_user_link link
where link.agent_login_id = $1
        "#,
            [login_id.into()],
        ),
    )
    .one(&env.dbx)
    .await
    .map_err(actix_web::error::ErrorInternalServerError)?;
    let Some(agent_login) = agent_login else {
        return next.call(req).await;
    };
    let login = login::Entity::find_by_id(agent_login.id)
        .one(&env.dbx)
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?
        .ok_or_else(|| {
            actix_web::error::ErrorUnauthorized("Agent login missing")
        })?;
    authorize_agent_request(&req, env, &login, agent_login.human_login_id)
        .await?;
    next.call(req).await
}

fn session_login_id(req: &ServiceRequest) -> Result<Option<Uuid>, Error> {
    let identity = req
        .get_session()
        .get::<String>(crate::config::IDENTITY_SESSION_USER_ID_KEY)
        .map_err(actix_web::error::ErrorInternalServerError)?;
    Ok(identity.and_then(|identity| Uuid::parse_str(&identity).ok()))
}

async fn authorize_agent_request(
    req: &ServiceRequest,
    env: &actix_web::web::Data<Env>,
    login: &login::Model,
    human_login_id: Uuid,
) -> Result<(), Error> {
    let login_id = login.id;
    let path = req.path();
    let Some(correlation_id) = req
        .headers()
        .get(AI_AGENT_CORRELATION_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| Uuid::parse_str(value).ok())
    else {
        return Err(purge_agent_session(req, "Missing agent correlation"));
    };
    let session = req.get_session();
    let binding = session
        .get::<AgentSessionBinding>(AI_AGENT_SESSION_BINDING_KEY)
        .map_err(actix_web::error::ErrorInternalServerError)?;
    let session_id = crate::event_stream::get_session_id(&session)
        .map_err(actix_web::error::ErrorInternalServerError)?;
    let grant: Option<String> = env
        .redis
        .clone()
        .get(credential_key(correlation_id))
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;
    let Some(grant) = grant
        .and_then(|grant| serde_json::from_str::<CredentialGrant>(&grant).ok())
    else {
        warn!("AI agent denied revoked correlation login_id={login_id}");
        return Err(purge_agent_session(req, "Agent correlation revoked"));
    };
    let binding_is_valid = binding.as_ref().is_some_and(|binding| {
        session_binding_matches(
            binding,
            session_id,
            login_id,
            correlation_id,
            &grant,
        )
    });
    if !binding_is_valid {
        warn!("AI agent denied mismatched session binding login_id={login_id}");
        return Err(purge_agent_session(
            req,
            "Agent session correlation mismatch",
        ));
    }
    let is_test = grant.allow_disabled && grant.request_id.is_none();
    let identity_is_valid = grant.login_id == login_id
        && !login.deleted_permanently
        && (!login.deleted || is_test)
        && has_exact_agent_security_profile(login);
    if !identity_is_valid {
        warn!("AI agent denied revoked correlation login_id={login_id}");
        return Err(purge_agent_session(req, "Agent correlation revoked"));
    }
    if !super::access::linked_human_scope_is_current(
        &env.dbx,
        human_login_id,
        login,
    )
    .await
    .map_err(actix_web::error::ErrorInternalServerError)?
    {
        warn!("AI agent denied changed human access login_id={login_id}");
        return Err(purge_agent_session(req, "Linked human access changed"));
    }
    if is_test {
        if req.method() != actix_web::http::Method::GET || path != "/api/user" {
            return Err(actix_web::error::ErrorForbidden(
                "Agent test credential route denied",
            ));
        }
        return Ok(());
    }
    let Some(request_id) = grant.request_id else {
        return Err(actix_web::error::ErrorForbidden(
            "Agent request credential is invalid",
        ));
    };
    let request_is_active = ai_agent_request::Entity::find_by_id(request_id)
        .filter(ai_agent_request::Column::State.eq("running"))
        .filter(ai_agent_request::Column::CancellationRequested.eq(false))
        .filter(ai_agent_request::Column::AgentLoginId.eq(login_id))
        .filter(ai_agent_request::Column::CorrelationId.eq(correlation_id))
        .one(&env.dbx)
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?
        .is_some();
    if !request_is_active {
        return Err(actix_web::error::ErrorForbidden(
            "Agent request credential is no longer active",
        ));
    }
    let call_count: i64 = redis::Script::new(
        r#"
local value = redis.call('INCR', KEYS[1])
if value == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return value
        "#,
    )
    .key(api_call_count_key(correlation_id))
    .arg(AI_AGENT_CREDENTIAL_TTL_SEC)
    .invoke_async(&mut env.redis.clone())
    .await
    .map_err(actix_web::error::ErrorInternalServerError)?;
    if call_count > AI_AGENT_API_CALL_LIMIT {
        if call_count == AI_AGENT_API_CALL_LIMIT + 1 {
            let payload = serde_json::json!({
                "tool": "echo_api",
                "method": req.method().as_str(),
                "path": super::access::truncate(path, 500),
                "status": 429,
                "denied": true,
                "reason": "request_call_limit",
            });
            if let Err(err) = super::events::append_runner(
                &env.dbx, request_id, "tool_end", payload,
            )
            .await
            {
                warn!(
                    "Could not audit AI agent call limit request_id={request_id}: {err:#?}"
                );
            }
        }
        return Err(actix_web::error::ErrorTooManyRequests(
            "Agent request call limit exceeded",
        ));
    }
    if path.starts_with("/api/ai-agent")
        || !super::route_registry::is_allowed(req.method(), path)
    {
        let payload = serde_json::json!({
            "tool": "echo_api",
            "method": req.method().as_str(),
            "path": super::access::truncate(path, 500),
            "status": 403,
            "denied": true,
        });
        if let Err(err) = super::events::append_runner(
            &env.dbx, request_id, "tool_end", payload,
        )
        .await
        {
            warn!(
                "Could not audit denied AI agent route request_id={request_id}: {err:#?}"
            );
        }
        warn!(
            "AI agent denied unlisted or harness request login_id={login_id} method={} path={path}",
            req.method()
        );
        return Err(actix_web::error::ErrorForbidden("AI agent route denied"));
    }
    Ok(())
}

fn purge_agent_session(req: &ServiceRequest, message: &'static str) -> Error {
    req.get_session().purge();
    actix_web::error::ErrorForbidden(message)
}

fn session_binding_matches(
    binding: &AgentSessionBinding,
    session_id: Option<Uuid>,
    login_id: Uuid,
    correlation_id: Uuid,
    grant: &CredentialGrant,
) -> bool {
    session_id == Some(binding.session_id)
        && binding.login_id == login_id
        && binding.login_id == grant.login_id
        && binding.correlation_id == correlation_id
        && binding.request_id == grant.request_id
        && binding.allow_disabled == grant.allow_disabled
}

fn has_exact_agent_security_profile(login: &login::Model) -> bool {
    has_exact_agent_roles(&login.roles)
        && login.password.is_none()
        && !login.password_auth_enabled
}

fn has_exact_agent_roles(roles: &serde_json::Value) -> bool {
    let mut roles = serde_json::from_value::<Vec<String>>(roles.clone())
        .unwrap_or_default();
    roles.sort();
    roles
        == [
            AI_AGENT_ROLE_API.to_string(),
            crate::config::AI_AGENT_ROLE_CYBER.to_string(),
            crate::config::AI_AGENT_ROLE_RER.to_string(),
        ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requires_exact_managed_agent_roles() {
        assert!(has_exact_agent_roles(&serde_json::json!([
            "ApiAgent", "Rer", "Cyber"
        ])));
        assert!(!has_exact_agent_roles(&serde_json::json!([
            "ApiAgent", "Rer", "Cyber", "Admin"
        ])));
        assert!(!has_exact_agent_roles(&serde_json::json!(["ApiAgent"])));
    }

    #[test]
    fn session_binding_requires_exact_correlation_and_grant() {
        let login_id = Uuid::now_v7();
        let request_id = Uuid::now_v7();
        let correlation_id = Uuid::now_v7();
        let session_id = Uuid::now_v7();
        let binding = AgentSessionBinding {
            login_id,
            request_id: Some(request_id),
            correlation_id,
            allow_disabled: false,
            session_id,
        };
        let grant = CredentialGrant {
            login_id,
            request_id: Some(request_id),
            allow_disabled: false,
        };

        assert!(session_binding_matches(
            &binding,
            Some(session_id),
            login_id,
            correlation_id,
            &grant,
        ));
        assert!(!session_binding_matches(
            &binding,
            Some(session_id),
            login_id,
            Uuid::now_v7(),
            &grant,
        ));
        assert!(!session_binding_matches(
            &binding,
            Some(Uuid::now_v7()),
            login_id,
            correlation_id,
            &grant,
        ));
        assert!(!session_binding_matches(
            &binding,
            Some(session_id),
            Uuid::now_v7(),
            correlation_id,
            &grant,
        ));

        let later_grant = CredentialGrant {
            login_id,
            request_id: Some(Uuid::now_v7()),
            allow_disabled: false,
        };
        assert!(!session_binding_matches(
            &binding,
            Some(session_id),
            login_id,
            correlation_id,
            &later_grant,
        ));
    }
}
