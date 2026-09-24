use super::types::{AiAgentBootstrapExchangeReq, AiAgentBootstrapExchangeRsp};
use crate::config::{
    AI_AGENT_API_CALL_COUNT_REDIS_PREFIX, AI_AGENT_BOOTSTRAP_REDIS_PREFIX,
    AI_AGENT_BOOTSTRAP_TTL_SEC, AI_AGENT_CORRELATION_SESSION_REDIS_PREFIX,
    AI_AGENT_CREDENTIAL_REDIS_PREFIX, AI_AGENT_CREDENTIAL_TTL_SEC,
    AI_AGENT_LOGIN_CREDENTIALS_REDIS_PREFIX,
    AI_AGENT_PENDING_BOOTSTRAP_REDIS_PREFIX,
    AI_AGENT_PROVIDER_CAPABILITY_CALLS_REDIS_PREFIX,
    AI_AGENT_PROVIDER_CAPABILITY_CALL_LIMIT,
    AI_AGENT_PROVIDER_CAPABILITY_CORRELATION_REDIS_PREFIX,
    AI_AGENT_PROVIDER_CAPABILITY_REDIS_PREFIX,
    AI_AGENT_PROVIDER_CAPABILITY_TTL_SEC, AI_AGENT_SESSION_BINDING_KEY,
    REDIS_SESSIONS_KEY,
};
use crate::entities::{ai_agent_request, ai_agent_user_link, ai_engine, login};
use crate::error::AppError;
use crate::h;
use crate::types::{warn, Deserialize, Env, Serialize, ShortContext};
use actix_session::SessionExt;
use actix_web::{post, web::Json, HttpRequest};
use base64::Engine;
use rand::Rng;
use redis::AsyncCommands;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapGrant {
    login_id: Uuid,
    request_id: Option<Uuid>,
    correlation_id: Uuid,
    allow_disabled: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialGrant {
    pub login_id: Uuid,
    pub request_id: Option<Uuid>,
    pub allow_disabled: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionBinding {
    pub login_id: Uuid,
    pub request_id: Option<Uuid>,
    pub correlation_id: Uuid,
    pub allow_disabled: bool,
    pub session_id: Uuid,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderCapabilityGrant {
    login_id: Uuid,
    request_id: Uuid,
    correlation_id: Uuid,
    ai_engine_id: Uuid,
    model_name: String,
}

pub async fn issue_bootstrap(
    env: &Env,
    login_id: Uuid,
    request_id: Option<Uuid>,
    allow_disabled: bool,
) -> Result<(String, Uuid), AppError> {
    if allow_disabled != request_id.is_none() {
        return Err(AppError::BL {
            msg: "AI agent bootstrap kind is inconsistent".to_string(),
        });
    }
    let mut random = [0_u8; 32];
    rand::rng().fill(&mut random);
    let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random);
    let correlation_id = Uuid::now_v7();
    let grant = serde_json::to_string(&BootstrapGrant {
        login_id,
        request_id,
        correlation_id,
        allow_disabled,
    })
    .c(h!())?;
    let bootstrap_key = bootstrap_key(&token);
    let pending_key = pending_bootstrap_key(correlation_id);
    let login_key = login_credentials_key(login_id);
    let mut redis = env.redis.clone();
    let mut pipe = redis::pipe();
    pipe.atomic();
    pipe.set_ex(&bootstrap_key, grant, AI_AGENT_BOOTSTRAP_TTL_SEC)
        .ignore()
        .set_ex(pending_key, bootstrap_key, AI_AGENT_BOOTSTRAP_TTL_SEC)
        .ignore()
        .sadd(&login_key, correlation_id.to_string())
        .ignore()
        .expire(&login_key, AI_AGENT_CREDENTIAL_TTL_SEC as i64)
        .ignore();
    pipe.query_async::<()>(&mut redis).await.c(h!())?;
    Ok((token, correlation_id))
}

pub async fn issue_provider_capability(
    env: &Env,
    login_id: Uuid,
    request_id: Uuid,
    correlation_id: Uuid,
    ai_engine_id: Uuid,
    model_name: String,
) -> Result<String, AppError> {
    let mut random = [0_u8; 32];
    rand::rng().fill(&mut random);
    let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random);
    let digest = sha256::digest(token.as_bytes());
    let grant = serde_json::to_string(&ProviderCapabilityGrant {
        login_id,
        request_id,
        correlation_id,
        ai_engine_id,
        model_name,
    })
    .c(h!())?;
    let mut redis = env.redis.clone();
    let mut pipe = redis::pipe();
    pipe.atomic();
    pipe.set_ex(
        provider_capability_key(&digest),
        grant,
        AI_AGENT_PROVIDER_CAPABILITY_TTL_SEC,
    )
    .ignore()
    .set_ex(
        provider_capability_correlation_key(correlation_id),
        digest,
        AI_AGENT_PROVIDER_CAPABILITY_TTL_SEC,
    )
    .ignore();
    pipe.query_async::<()>(&mut redis).await.c(h!())?;
    Ok(token)
}

pub async fn authorize_provider_capability(
    env: &Env,
    token: &str,
) -> Result<Option<ai_engine::Model>, AppError> {
    let digest = sha256::digest(token.as_bytes());
    let (raw, calls): (Option<String>, i64) = redis::Script::new(
        r#"
local value = redis.call('GET', KEYS[1])
if not value then return {false, 0} end
local calls = redis.call('INCR', KEYS[2])
if calls == 1 then redis.call('EXPIRE', KEYS[2], ARGV[1]) end
return {value, calls}
        "#,
    )
    .key(provider_capability_key(&digest))
    .key(provider_capability_calls_key(&digest))
    .arg(AI_AGENT_PROVIDER_CAPABILITY_TTL_SEC)
    .invoke_async(&mut env.redis.clone())
    .await
    .c(h!())?;
    if calls > AI_AGENT_PROVIDER_CAPABILITY_CALL_LIMIT {
        return Ok(None);
    }
    let Some(raw) = raw else {
        return Ok(None);
    };
    let grant: ProviderCapabilityGrant = serde_json::from_str(&raw).c(h!())?;
    if !super::access::settings(&env.dbx).await?.feature_enabled {
        return Ok(None);
    }
    let request = ai_agent_request::Entity::find_by_id(grant.request_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .filter(|request| {
            request.state == "running"
                && !request.cancellation_requested
                && request.agent_login_id == Some(grant.login_id)
                && request.correlation_id == Some(grant.correlation_id)
                && request.ai_engine_id == grant.ai_engine_id
        });
    let Some(request) = request else {
        return Ok(None);
    };
    let agent = login::Entity::find_by_id(grant.login_id)
        .one(&env.dbx)
        .await
        .c(h!())?;
    let Some(agent) = agent else {
        return Ok(None);
    };
    if !super::access::linked_human_scope_is_current(
        &env.dbx,
        request.human_login_id,
        &agent,
    )
    .await?
    {
        warn!(
            "AI agent provider capability denied changed human access request_id={}",
            request.id
        );
        revoke_correlation(env, Some(grant.login_id), grant.correlation_id)
            .await?;
        return Ok(None);
    }
    let ai_engine =
        super::access::allowed_engine_by_id(&env.dbx, grant.ai_engine_id)
            .await?;
    if super::access::agent_provider_transport(&ai_engine)
        != Some(super::access::AgentProviderTransport::EchoGateway)
        || ai_engine.model_name != grant.model_name
        || ai_engine
            .token
            .as_deref()
            .is_none_or(|token| token.trim().is_empty())
    {
        return Ok(None);
    }
    Ok(Some(ai_engine))
}

#[post("/api/ai-agent/bootstrap/exchange")]
pub async fn exchange_bootstrap(
    env: actix_web::web::Data<Env>,
    http_req: HttpRequest,
    req: Json<AiAgentBootstrapExchangeReq>,
) -> Result<Json<AiAgentBootstrapExchangeRsp>, AppError> {
    let mut redis = env.redis.clone();
    let raw: Option<String> = redis::Script::new(
        r#"
local value = redis.call('GET', KEYS[1])
if value then redis.call('DEL', KEYS[1]) end
return value
        "#,
    )
    .key(bootstrap_key(&req.token))
    .invoke_async(&mut redis)
    .await
    .c(h!())?;
    let raw = raw
        .ok_or(AppError::Unauthenticated)
        .inspect_err(|_| warn!("AI agent bootstrap failed stage=consume_grant"))
        .c(h!())?;
    let grant: BootstrapGrant = serde_json::from_str(&raw).c(h!())?;
    if let Err(err) = validate_grant(&env, &grant).await {
        log_bootstrap_failure(&grant, "validate_grant");
        revoke_after_exchange_failure(&env, &grant).await;
        return Err(err);
    }
    if let Err(err) = activate_credential(&env, &grant).await {
        log_bootstrap_failure(&grant, "activate_credential");
        revoke_after_exchange_failure(&env, &grant).await;
        return Err(err);
    }
    if let Err(err) = start_bootstrap_session(&env, &http_req, &grant).await {
        log_bootstrap_failure(&grant, "start_session");
        cleanup_exchange_session(&env, &http_req, &grant).await;
        return Err(err.into());
    }
    if let Err(err) = bind_agent_session(&env, &http_req, &grant).await {
        log_bootstrap_failure(&grant, "bind_session");
        cleanup_exchange_session(&env, &http_req, &grant).await;
        return Err(err);
    }
    Ok(Json(AiAgentBootstrapExchangeRsp {
        correlation_id: grant.correlation_id.to_string(),
    }))
}

async fn start_bootstrap_session(
    env: &actix_web::web::Data<Env>,
    http_req: &HttpRequest,
    grant: &BootstrapGrant,
) -> anyhow::Result<()> {
    if grant.allow_disabled {
        crate::users::initialize_user_session(env, http_req, grant.login_id)
            .await
            .c(h!())?;
    } else {
        crate::users::start_user_session(
            env,
            http_req,
            grant.login_id,
            &env.dbx,
        )
        .await
        .c(h!())?;
    }
    Ok(())
}

fn log_bootstrap_failure(grant: &BootstrapGrant, stage: &str) {
    warn!(
        "AI agent bootstrap failed stage={stage} correlation_id={} login_id={} test={}",
        grant.correlation_id, grant.login_id, grant.allow_disabled
    );
}

async fn bind_agent_session(
    env: &Env,
    http_req: &HttpRequest,
    grant: &BootstrapGrant,
) -> Result<(), AppError> {
    let session = http_req.get_session();
    let session_id = crate::event_stream::get_session_id(&session)
        .c(h!())?
        .ok_or(AppError::Unauthenticated)?;
    session
        .insert(
            AI_AGENT_SESSION_BINDING_KEY,
            AgentSessionBinding {
                login_id: grant.login_id,
                request_id: grant.request_id,
                correlation_id: grant.correlation_id,
                allow_disabled: grant.allow_disabled,
                session_id,
            },
        )
        .c(h!())?;
    track_agent_session(env, grant, session_id).await
}

async fn track_agent_session(
    env: &Env,
    grant: &BootstrapGrant,
    session_id: Uuid,
) -> Result<(), AppError> {
    let ttl = credential_ttl(grant.allow_disabled);
    let tracked: i64 = redis::Script::new(
        r#"
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[2])
return 1
        "#,
    )
    .key(credential_key(grant.correlation_id))
    .key(correlation_session_key(grant.correlation_id))
    .arg(session_id.to_string())
    .arg(ttl)
    .invoke_async(&mut env.redis.clone())
    .await
    .c(h!())?;
    if tracked != 1 {
        return Err(AppError::Unauthenticated);
    }
    Ok(())
}

async fn cleanup_exchange_session(
    env: &Env,
    http_req: &HttpRequest,
    grant: &BootstrapGrant,
) {
    let session = http_req.get_session();
    if let Ok(Some(session_id)) = crate::event_stream::get_session_id(&session)
    {
        if let Err(err) = delete_session_records(env, session_id).await {
            warn!("Could not clean failed AI agent session records: {err:#?}");
        }
    }
    session.purge();
    revoke_after_exchange_failure(env, grant).await;
}

async fn revoke_after_exchange_failure(env: &Env, grant: &BootstrapGrant) {
    if let Err(err) =
        revoke_correlation(env, Some(grant.login_id), grant.correlation_id)
            .await
    {
        warn!("Could not revoke failed AI agent bootstrap: {err:#?}");
    }
}

async fn validate_grant(
    env: &Env,
    grant: &BootstrapGrant,
) -> Result<(), AppError> {
    if grant.allow_disabled != grant.request_id.is_none() {
        return Err(AppError::Unauthenticated);
    }
    let linked = ai_agent_user_link::Entity::find()
        .filter(ai_agent_user_link::Column::AgentLoginId.eq(grant.login_id))
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::Unauthenticated)
        .c(h!())?;
    let login = login::Entity::find_by_id(grant.login_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .filter(|login| {
            !login.deleted_permanently
                && (grant.allow_disabled || !login.deleted)
                && super::middleware::has_exact_agent_security_profile(login)
        })
        .ok_or(AppError::Unauthenticated)
        .c(h!())?;
    if !super::access::linked_human_scope_is_current(
        &env.dbx,
        linked.human_login_id,
        &login,
    )
    .await
    .c(h!())?
    {
        return Err(AppError::Unauthenticated);
    }
    if let Some(request_id) = grant.request_id {
        let request = ai_agent_request::Entity::find_by_id(request_id)
            .one(&env.dbx)
            .await
            .c(h!())?
            .filter(|request| {
                request.state == "running"
                    && !request.cancellation_requested
                    && request.agent_login_id == Some(grant.login_id)
                    && request.correlation_id == Some(grant.correlation_id)
            });
        if request.is_none() {
            return Err(AppError::Unauthenticated);
        }
    }
    Ok(())
}

async fn activate_credential(
    env: &Env,
    grant: &BootstrapGrant,
) -> Result<(), AppError> {
    let credential = serde_json::to_string(&CredentialGrant {
        login_id: grant.login_id,
        request_id: grant.request_id,
        allow_disabled: grant.allow_disabled,
    })
    .c(h!())?;
    let ttl = credential_ttl(grant.allow_disabled);
    let mut redis = env.redis.clone();
    let set_key = login_credentials_key(grant.login_id);
    let mut pipe = redis::pipe();
    pipe.atomic();
    pipe.set_ex(credential_key(grant.correlation_id), credential, ttl)
        .ignore()
        .del(pending_bootstrap_key(grant.correlation_id))
        .ignore()
        .sadd(&set_key, grant.correlation_id.to_string())
        .ignore()
        .expire(&set_key, AI_AGENT_CREDENTIAL_TTL_SEC as i64)
        .ignore();
    pipe.query_async::<()>(&mut redis).await.c(h!())?;
    Ok(())
}

pub async fn revoke_request(
    env: &Env,
    request_id: Uuid,
) -> Result<(), AppError> {
    let request = ai_agent_request::Entity::find_by_id(request_id)
        .one(&env.dbx)
        .await
        .c(h!())?;
    if let Some(request) = request {
        if let Some(correlation_id) = request.correlation_id {
            revoke_correlation(env, request.agent_login_id, correlation_id)
                .await?;
        }
    }
    Ok(())
}

pub async fn revoke_login_credentials(
    env: &Env,
    login_id: Uuid,
) -> Result<(), AppError> {
    let mut redis = env.redis.clone();
    let set_key = login_credentials_key(login_id);
    let ids: Vec<String> = redis.smembers(&set_key).await.c(h!())?;
    let mut pipe = redis::pipe();
    pipe.atomic();
    for correlation_id in ids {
        if let Ok(correlation_id) = Uuid::parse_str(&correlation_id) {
            let pending_key = pending_bootstrap_key(correlation_id);
            let session_key = correlation_session_key(correlation_id);
            let (bootstrap_key, session_id, provider_digest): (
                Option<String>,
                Option<String>,
                Option<String>,
            ) = redis::pipe()
                .get(&pending_key)
                .get(&session_key)
                .get(provider_capability_correlation_key(correlation_id))
                .query_async(&mut redis)
                .await
                .c(h!())?;
            pipe.del(credential_key(correlation_id)).ignore();
            pipe.del(api_call_count_key(correlation_id)).ignore();
            pipe.del(pending_key).ignore();
            pipe.del(session_key).ignore();
            if let Some(bootstrap_key) = bootstrap_key {
                pipe.del(bootstrap_key).ignore();
            }
            append_provider_capability_deletion(
                &mut pipe,
                correlation_id,
                provider_digest,
            );
            append_session_record_deletion(
                &mut pipe,
                session_id
                    .and_then(|session_id| Uuid::parse_str(&session_id).ok()),
            );
        }
    }
    pipe.del(set_key).ignore();
    pipe.query_async::<()>(&mut redis).await.c(h!())?;
    Ok(())
}

pub async fn revoke_correlation(
    env: &Env,
    login_id: Option<Uuid>,
    correlation_id: Uuid,
) -> Result<(), AppError> {
    let mut redis = env.redis.clone();
    let pending_key = pending_bootstrap_key(correlation_id);
    let session_key = correlation_session_key(correlation_id);
    let (bootstrap_key, session_id, provider_digest): (
        Option<String>,
        Option<String>,
        Option<String>,
    ) = redis::pipe()
        .get(&pending_key)
        .get(&session_key)
        .get(provider_capability_correlation_key(correlation_id))
        .query_async(&mut redis)
        .await
        .c(h!())?;
    let mut pipe = redis::pipe();
    pipe.atomic();
    pipe.del(credential_key(correlation_id)).ignore();
    pipe.del(api_call_count_key(correlation_id)).ignore();
    pipe.del(pending_key).ignore();
    pipe.del(session_key).ignore();
    if let Some(bootstrap_key) = bootstrap_key {
        pipe.del(bootstrap_key).ignore();
    }
    append_provider_capability_deletion(
        &mut pipe,
        correlation_id,
        provider_digest,
    );
    if let Some(login_id) = login_id {
        pipe.srem(login_credentials_key(login_id), correlation_id.to_string())
            .ignore();
    }
    append_session_record_deletion(
        &mut pipe,
        session_id.and_then(|session_id| Uuid::parse_str(&session_id).ok()),
    );
    pipe.query_async::<()>(&mut redis).await.c(h!())?;
    Ok(())
}

async fn delete_session_records(
    env: &Env,
    session_id: Uuid,
) -> Result<(), AppError> {
    let mut redis = env.redis.clone();
    let mut pipe = redis::pipe();
    pipe.atomic();
    append_session_record_deletion(&mut pipe, Some(session_id));
    pipe.query_async::<()>(&mut redis).await.c(h!())?;
    Ok(())
}

fn append_session_record_deletion(
    pipe: &mut redis::Pipeline,
    session_id: Option<Uuid>,
) {
    if let Some(session_id) = session_id {
        pipe.del(crate::event_stream::get_sess_key(session_id))
            .ignore();
        pipe.del(crate::event_stream::session_stream_id(session_id))
            .ignore();
        pipe.srem(REDIS_SESSIONS_KEY, session_id.to_string())
            .ignore();
    }
}

fn append_provider_capability_deletion(
    pipe: &mut redis::Pipeline,
    correlation_id: Uuid,
    digest: Option<String>,
) {
    pipe.del(provider_capability_correlation_key(correlation_id))
        .ignore();
    if let Some(digest) = digest {
        pipe.del(provider_capability_key(&digest)).ignore();
        pipe.del(provider_capability_calls_key(&digest)).ignore();
    }
}

fn credential_ttl(allow_disabled: bool) -> u64 {
    if allow_disabled {
        AI_AGENT_BOOTSTRAP_TTL_SEC
    } else {
        AI_AGENT_CREDENTIAL_TTL_SEC
    }
}

fn bootstrap_key(token: &str) -> String {
    format!(
        "{AI_AGENT_BOOTSTRAP_REDIS_PREFIX}{}",
        sha256::digest(token.as_bytes())
    )
}

pub fn credential_key(correlation_id: Uuid) -> String {
    format!("{AI_AGENT_CREDENTIAL_REDIS_PREFIX}{correlation_id}")
}

pub fn api_call_count_key(correlation_id: Uuid) -> String {
    format!("{AI_AGENT_API_CALL_COUNT_REDIS_PREFIX}{correlation_id}")
}

fn pending_bootstrap_key(correlation_id: Uuid) -> String {
    format!("{AI_AGENT_PENDING_BOOTSTRAP_REDIS_PREFIX}{correlation_id}")
}

fn login_credentials_key(login_id: Uuid) -> String {
    format!("{AI_AGENT_LOGIN_CREDENTIALS_REDIS_PREFIX}{login_id}")
}

fn correlation_session_key(correlation_id: Uuid) -> String {
    format!("{AI_AGENT_CORRELATION_SESSION_REDIS_PREFIX}{correlation_id}")
}

fn provider_capability_key(digest: &str) -> String {
    format!("{AI_AGENT_PROVIDER_CAPABILITY_REDIS_PREFIX}{digest}")
}

fn provider_capability_calls_key(digest: &str) -> String {
    format!("{AI_AGENT_PROVIDER_CAPABILITY_CALLS_REDIS_PREFIX}{digest}")
}

fn provider_capability_correlation_key(correlation_id: Uuid) -> String {
    format!(
        "{AI_AGENT_PROVIDER_CAPABILITY_CORRELATION_REDIS_PREFIX}{correlation_id}"
    )
}

#[cfg(test)]
#[path = "bootstrap_tests.rs"]
mod bootstrap_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bootstrap_storage_never_contains_plain_token_in_key() {
        let token = "very-secret-bootstrap-token";
        let key = bootstrap_key(token);
        assert!(!key.contains(token));
        assert!(key.starts_with(AI_AGENT_BOOTSTRAP_REDIS_PREFIX));
    }

    #[test]
    fn correlation_session_storage_is_scoped_to_exact_correlation() {
        let first = Uuid::now_v7();
        let second = Uuid::now_v7();
        assert_ne!(
            correlation_session_key(first),
            correlation_session_key(second)
        );
        assert!(correlation_session_key(first)
            .starts_with(AI_AGENT_CORRELATION_SESSION_REDIS_PREFIX));
    }

    #[test]
    fn provider_capability_storage_never_contains_plain_token_in_key() {
        let token = "very-secret-provider-capability";
        let digest = sha256::digest(token.as_bytes());
        let key = provider_capability_key(&digest);
        assert!(!key.contains(token));
        assert!(key.starts_with(AI_AGENT_PROVIDER_CAPABILITY_REDIS_PREFIX));
    }
}
