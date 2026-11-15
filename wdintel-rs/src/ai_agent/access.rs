use crate::config::{
    AI_AGENT_ROLE_API, AI_AGENT_ROLE_RER, AI_AGENT_SETTINGS_ID,
    AI_AGENT_TEMPLATE_LOGIN_ID,
};
use crate::entities::{
    ai_agent_allowed_engine, ai_agent_settings, ai_agent_user_link, ai_engine,
    login, organism, secret_group_user,
};
use crate::error::AppError;
use crate::h;
use crate::types::ShortContext;
use actix_identity::Identity;
use anyhow::Context;
use sea_orm::{
    ColumnTrait, ConnectionTrait, DatabaseConnection, EntityTrait, QueryFilter,
};
use std::collections::HashSet;
use std::net::Ipv4Addr;
use url::Url;
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentProviderTransport {
    DirectHttp,
    EchoGateway,
}

impl AgentProviderTransport {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DirectHttp => "direct_http",
            Self::EchoGateway => "echo_gateway",
        }
    }
}

pub async fn settings(
    dbx: &DatabaseConnection,
) -> Result<ai_agent_settings::Model, AppError> {
    ai_agent_settings::Entity::find_by_id(AI_AGENT_SETTINGS_ID)
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
}

pub fn template_login_id(
    settings: &ai_agent_settings::Model,
) -> Result<Uuid, AppError> {
    settings
        .template_login_id
        .map(Ok)
        .unwrap_or_else(|| Uuid::parse_str(AI_AGENT_TEMPLATE_LOGIN_ID).c(h!()))
        .map_err(Into::into)
}

pub async fn current_human_login(
    dbx: &DatabaseConnection,
    user: &Identity,
    require_feature: bool,
) -> Result<login::Model, AppError> {
    let login_id = crate::users::login_id_from_identity(user)?;
    let login = login::Entity::find_by_id(login_id)
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::Unauthenticated)?;
    let roles: Vec<String> =
        serde_json::from_value(login.roles.clone()).c(h!())?;
    if roles.iter().any(|role| role == AI_AGENT_ROLE_API) {
        return Err(AppError::Forbidden(
            "ApiAgent cannot use the AI agent harness".to_string(),
        ));
    }
    crate::users::ensure_base_role_by_id(dbx, &login.id)
        .await
        .c(h!())?;
    if require_feature && !settings(dbx).await?.feature_enabled {
        return Err(AppError::Forbidden(
            "AI agent harness is disabled".to_string(),
        ));
    }
    Ok(login)
}

pub async fn linked_human_scope_is_current<C>(
    dbx: &C,
    human_login_id: Uuid,
    agent: &login::Model,
) -> Result<bool, AppError>
where
    C: ConnectionTrait,
{
    let linked = ai_agent_user_link::Entity::find()
        .filter(ai_agent_user_link::Column::HumanLoginId.eq(human_login_id))
        .filter(ai_agent_user_link::Column::AgentLoginId.eq(agent.id))
        .one(dbx)
        .await
        .c(h!())?
        .is_some();
    if !linked {
        return Ok(false);
    }
    let human = login::Entity::find_by_id(human_login_id)
        .find_also_related(organism::Entity)
        .one(dbx)
        .await
        .c(h!())?;
    let Some((human, organism)) = human else {
        return Ok(false);
    };
    if human.deleted
        || human.deleted_permanently
        || !has_rer_or_cyber_role(&human.roles)
        || agent.sigint_zone_id != human.sigint_zone_id
        || agent.organism_id != human.organism_id
        || (human.organism_id.is_some()
            && !organism.is_some_and(|organism| {
                organism.enabled && !organism.deleted_permanently
            }))
    {
        return Ok(false);
    }
    let human_groups = direct_secret_group_keys(dbx, human.id).await?;
    let agent_groups = direct_secret_group_keys(dbx, agent.id).await?;
    Ok(human_groups == agent_groups)
}

async fn direct_secret_group_keys<C>(
    dbx: &C,
    login_id: Uuid,
) -> Result<HashSet<String>, AppError>
where
    C: ConnectionTrait,
{
    Ok(secret_group_user::Entity::find()
        .filter(secret_group_user::Column::LoginId.eq(login_id))
        .filter(secret_group_user::Column::SecretGroupOrganismId.is_null())
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|group| group.master_key)
        .collect())
}

fn has_rer_or_cyber_role(roles: &serde_json::Value) -> bool {
    let Ok(roles) = serde_json::from_value::<Vec<String>>(roles.clone()) else {
        return false;
    };
    [
        AI_AGENT_ROLE_RER,
        crate::config::ROLE_CYBER_VIEWER_RESTRICTED,
    ]
    .iter()
    .any(|role| crate::users::role_matches(&roles, role).unwrap_or(false))
}

pub async fn allowed_engines(
    dbx: &DatabaseConnection,
) -> Result<Vec<ai_engine::Model>, AppError> {
    Ok(ordered_allowed_engines(dbx)
        .await
        .context(h!())?
        .into_iter()
        .filter(|ai_engine| ai_engine.enabled)
        .filter(is_agent_engine)
        .collect())
}

/// Allowlisted engines in chat order: the admin's position, then engine name.
pub async fn ordered_allowed_engines<C>(
    dbx: &C,
) -> Result<Vec<ai_engine::Model>, AppError>
where
    C: ConnectionTrait,
{
    let mut allowed = ai_agent_allowed_engine::Entity::find()
        .find_also_related(ai_engine::Entity)
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .filter_map(|(allowed, ai_engine)| {
            ai_engine.map(|ai_engine| (allowed.position, ai_engine))
        })
        .collect::<Vec<_>>();
    // Engines the admin has not ordered yet follow the ordered ones.
    allowed.sort_by(|(left_position, left), (right_position, right)| {
        (left_position.is_none(), left_position)
            .cmp(&(right_position.is_none(), right_position))
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(allowed
        .into_iter()
        .map(|(_, ai_engine)| ai_engine)
        .collect())
}

pub async fn allowed_engine(
    dbx: &DatabaseConnection,
    requested: Option<Uuid>,
) -> Result<ai_engine::Model, AppError> {
    let settings = settings(dbx).await?;
    let ai_engine_id =
        requested.or(settings.default_ai_engine_id).ok_or_else(|| {
            AppError::BL {
                msg: "Не налаштовано ШІ провайдера за замовчуванням"
                    .to_string(),
            }
        })?;
    allowed_engine_by_id(dbx, ai_engine_id).await
}

pub async fn allowed_engine_by_id<C>(
    dbx: &C,
    ai_engine_id: Uuid,
) -> Result<ai_engine::Model, AppError>
where
    C: ConnectionTrait,
{
    let allowed = ai_agent_allowed_engine::Entity::find_by_id(ai_engine_id)
        .one(dbx)
        .await
        .c(h!())?
        .is_some();
    let ai_engine = ai_engine::Entity::find_by_id(ai_engine_id)
        .one(dbx)
        .await
        .c(h!())?
        .filter(is_agent_engine);
    if !allowed {
        return Err(AppError::Forbidden(
            "AI engine is not allowed".to_string(),
        ));
    }
    ai_engine.ok_or_else(|| {
        AppError::Forbidden("AI engine is not allowed".to_string())
    })
}

pub fn parse_uuid(value: &str) -> Result<Uuid, AppError> {
    Uuid::parse_str(value).map_err(|_| AppError::BL {
        msg: "Некоректний ідентифікатор".to_string(),
    })
}

pub fn truncate(value: impl AsRef<str>, max_chars: usize) -> String {
    value.as_ref().chars().take(max_chars).collect()
}

pub fn agent_provider_transport(
    ai_engine: &ai_engine::Model,
) -> Option<AgentProviderTransport> {
    if !ai_engine.enabled {
        return None;
    }
    let url = Url::parse(&ai_engine.url).ok()?;
    let common_valid = url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url.path().trim_end_matches('/') == "/v1";
    if !common_valid {
        return None;
    }
    if url.host_str() == Some(crate::config::AI_GOV_UA_API_HOST) {
        return crate::ai_engine::client::is_government_url(&ai_engine.url)
            .then_some(AgentProviderTransport::EchoGateway);
    }
    // A proxy holding the government gateway's credentials is reached only
    // by Echo, so its key never enters an agent container.
    if crate::ai_engine::client::is_government_proxy(ai_engine) {
        return Some(AgentProviderTransport::EchoGateway);
    }
    if crate::ai_engine::client::has_unknown_host_prefix(ai_engine) {
        return None;
    }
    if url.scheme() == "http"
        && url.host_str().is_some_and(is_dispatcher_upstream_host)
        && url.port_or_known_default().is_some()
    {
        return Some(AgentProviderTransport::DirectHttp);
    }
    None
}

pub fn is_agent_engine(ai_engine: &ai_engine::Model) -> bool {
    agent_provider_transport(ai_engine).is_some()
}

pub fn is_dispatcher_hostname(hostname: &str) -> bool {
    crate::utils::http::is_valid_hostname(hostname)
}

pub fn is_dispatcher_upstream_host(host: &str) -> bool {
    host.parse::<Ipv4Addr>().is_ok() || is_dispatcher_hostname(host)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm::{
        ActiveModelTrait,
        ActiveValue::{NotSet, Set},
        TransactionTrait,
    };
    use serial_test::serial;

    #[test]
    fn issue_3568_linked_human_requires_rer_or_cyber_role() {
        assert!(has_rer_or_cyber_role(&serde_json::json!(["Rer", "Cyber"])));
        assert!(has_rer_or_cyber_role(&serde_json::json!([
            "Admin",
            "NoAutoLogout"
        ])));
        assert!(has_rer_or_cyber_role(&serde_json::json!(["Full"])));
        assert!(has_rer_or_cyber_role(&serde_json::json!(["Cyber"])));
        assert!(has_rer_or_cyber_role(&serde_json::json!(["CyberViewer"])));
        assert!(has_rer_or_cyber_role(&serde_json::json!([
            "CyberViewerRestricted"
        ])));
        assert!(has_rer_or_cyber_role(&serde_json::json!(["Rer"])));
        assert!(!has_rer_or_cyber_role(&serde_json::json!(["Basic"])));
        assert!(!has_rer_or_cyber_role(&serde_json::json!(["ApiAgent"])));
        assert!(!has_rer_or_cyber_role(&serde_json::json!(["Cyber", 1])));
    }

    #[tokio::test]
    #[serial]
    async fn linked_human_scope_rejects_removed_direct_group() {
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
                login: Set(format!("access-agent-{}", Uuid::now_v7())),
                sigint_zone_id: Set(human.sigint_zone_id),
                organism_id: Set(human.organism_id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        ai_agent_user_link::ActiveModel {
            id: Set(Uuid::now_v7()),
            human_login_id: Set(human.id),
            agent_login_id: Set(agent.id),
            created_at: Set(chrono::Utc::now().naive_utc()),
            updated_at: Set(chrono::Utc::now().naive_utc()),
        }
        .insert(&txn)
        .await
        .unwrap();
        let groups = secret_group_user::Entity::find()
            .filter(secret_group_user::Column::LoginId.eq(human.id))
            .filter(secret_group_user::Column::SecretGroupOrganismId.is_null())
            .all(&txn)
            .await
            .unwrap();
        for group in groups {
            secret_group_user::ActiveModel {
                id: NotSet,
                master_key: Set(group.master_key),
                login_id: Set(agent.id),
                secret_group_organism_id: Set(None),
            }
            .insert(&txn)
            .await
            .unwrap();
        }
        assert!(linked_human_scope_is_current(&txn, human.id, &agent)
            .await
            .unwrap());

        let group = crate::functest::tests::mk_signal_group(
            &txn,
            crate::entities::signal_group::ActiveModel {
                master_key: Set(format!("access-revoked-{}", Uuid::now_v7())),
                is_secret: Set(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        secret_group_user::ActiveModel {
            id: NotSet,
            master_key: Set(group.master_key),
            login_id: Set(human.id),
            secret_group_organism_id: Set(None),
        }
        .insert(&txn)
        .await
        .unwrap();

        assert!(!linked_human_scope_is_current(&txn, human.id, &agent)
            .await
            .unwrap());
        txn.rollback().await.unwrap();
    }

    use chrono::Utc;

    fn engine(
        url: &str,
        token: Option<&str>,
        enabled: bool,
    ) -> ai_engine::Model {
        let now = Utc::now().naive_utc();
        ai_engine::Model {
            id: Uuid::nil(),
            name: "test".to_string(),
            url: url.to_string(),
            token: token.map(str::to_string),
            model_name: "test-model".to_string(),
            created_at: now,
            updated_at: now,
            enabled,
            callsign_enabled: true,
            ocr_enabled: false,
            ocr_request_profile: "openai_vision".to_string(),
            unhealthy: None,
            health_message: None,
            health_updated_at: None,
            health_updated_by_login_id: None,
        }
    }

    #[test]
    fn government_proxy_engines_use_the_echo_gateway_only() {
        let proxied = |url: &str, model_name: &str| ai_engine::Model {
            model_name: model_name.to_string(),
            ..engine(url, Some("sk-bf-key"), true)
        };
        for url in [
            "http://proxy.internal:8080/v1",
            "https://proxy.example.ts.net/v1",
        ] {
            assert_eq!(
                agent_provider_transport(&proxied(
                    url,
                    "inference.ai.mod.gov.ua/glm-5.3"
                )),
                Some(AgentProviderTransport::EchoGateway),
                "{url}: the proxy key must stay on the server"
            );
        }
        assert_eq!(
            agent_provider_transport(&proxied(
                "http://proxy.internal:8080/v1",
                "inference.ai.mod.gov.au/glm-5.3"
            )),
            None,
            "a mistyped proxy prefix never hands its key to a container"
        );
        assert_eq!(
            agent_provider_transport(&proxied(
                "http://vllm.example:8000/v1",
                "google/gemma-3-27b-it"
            )),
            Some(AgentProviderTransport::DirectHttp)
        );
        assert_eq!(
            agent_provider_transport(&proxied(
                "http://proxy.internal:8080/v1?key=secret",
                "inference.ai.mod.gov.ua/glm-5.3"
            )),
            None
        );
    }

    #[test]
    fn harness_engine_accepts_internal_http_and_refuses_direct_openai() {
        assert_eq!(
            agent_provider_transport(&engine(
                "http://vllm.example:8000/v1",
                None,
                true,
            )),
            Some(AgentProviderTransport::DirectHttp)
        );
        assert_eq!(
            agent_provider_transport(&engine(
                "http://vllm.example:8000/v1",
                Some("budget-limited-token"),
                true,
            )),
            Some(AgentProviderTransport::DirectHttp)
        );
        assert!(!is_agent_engine(&engine(
            "https://api.openai.com/v1",
            Some("real-token"),
            true,
        )));
        assert!(!is_agent_engine(&engine(
            "https://api.openai.com:443/v1/",
            Some("real-token"),
            true,
        )));
        assert!(!is_agent_engine(&engine(
            "http://vllm.example:8000",
            None,
            true,
        )));
        assert!(!is_agent_engine(&engine(
            "http://vllm.example:8000/custom",
            None,
            true,
        )));
        assert!(!is_agent_engine(&engine(
            "https://vllm.example/v1",
            Some("token"),
            true,
        )));
        assert!(!is_agent_engine(&engine(
            "https://api.openai.com/v1",
            None,
            true,
        )));
        assert!(!is_agent_engine(&engine(
            "https://api.openai.com:444/v1",
            Some("token"),
            true,
        )));
        assert!(!is_agent_engine(&engine(
            "http://user:password@vllm.example:8000/v1",
            None,
            true,
        )));
    }
}
