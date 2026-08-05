use crate::config::{
    AI_AGENT_ROLE_API, AI_AGENT_SETTINGS_ID, AI_AGENT_TEMPLATE_LOGIN_ID,
};
use crate::entities::{
    ai_agent_allowed_engine, ai_agent_settings, ai_engine, login,
};
use crate::error::AppError;
use crate::h;
use crate::types::ShortContext;
use actix_identity::Identity;
use once_cell::sync::Lazy;
use regex::Regex;
use sea_orm::{
    ColumnTrait, ConnectionTrait, DatabaseConnection, EntityTrait, QueryFilter,
};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;
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

static DISPATCHER_HOSTNAME_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$",
    )
    .expect("dispatcher hostname regex is valid")
});

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
    crate::users::ensure_rer_role_by_id(dbx, &login.id).await?;
    if require_feature && !settings(dbx).await?.feature_enabled {
        return Err(AppError::Forbidden(
            "AI agent harness is disabled".to_string(),
        ));
    }
    Ok(login)
}

pub async fn allowed_engines(
    dbx: &DatabaseConnection,
) -> Result<Vec<ai_engine::Model>, AppError> {
    let ids = ai_agent_allowed_engine::Entity::find()
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|allowed| allowed.ai_engine_id)
        .collect::<Vec<_>>();
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let ai_engines = ai_engine::Entity::find()
        .filter(ai_engine::Column::Id.is_in(ids))
        .filter(ai_engine::Column::Enabled.eq(true))
        .all(dbx)
        .await
        .c(h!())?;
    Ok(ai_engines.into_iter().filter(is_agent_engine).collect())
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
    if url.scheme() == "http"
        && url.host_str().is_some_and(is_dispatcher_upstream_host)
        && url.port_or_known_default().is_some()
    {
        return Some(AgentProviderTransport::DirectHttp);
    }
    if url.scheme() == "https"
        && url.host_str() == Some("api.openai.com")
        && url.port().is_none_or(|port| port == 443)
        && ai_engine
            .token
            .as_deref()
            .is_some_and(|token| !token.trim().is_empty())
    {
        return Some(AgentProviderTransport::EchoGateway);
    }
    None
}

pub fn is_agent_engine(ai_engine: &ai_engine::Model) -> bool {
    agent_provider_transport(ai_engine).is_some()
}

pub fn is_dispatcher_hostname(hostname: &str) -> bool {
    !hostname.is_empty()
        && hostname.len() <= 253
        && DISPATCHER_HOSTNAME_RE.is_match(hostname)
}

pub fn validate_mattermost_webhook(
    webhook: Option<&str>,
) -> Result<(), AppError> {
    let Some(webhook) = webhook else {
        return Ok(());
    };
    let url = Url::parse(webhook).map_err(|_| AppError::BL {
        msg: "Mattermost webhook URL is invalid".to_string(),
    })?;
    let host_is_safe = url.host_str().is_some_and(|host| {
        host.parse::<IpAddr>().map_or_else(
            |_| is_dispatcher_hostname(host),
            |address| match address {
                IpAddr::V4(address) => {
                    !address.is_private()
                        && !address.is_loopback()
                        && !address.is_link_local()
                        && !address.is_unspecified()
                        && !address.is_multicast()
                }
                IpAddr::V6(address) => {
                    !address.is_loopback()
                        && !address.is_unspecified()
                        && !address.is_multicast()
                        && !address.is_unique_local()
                }
            },
        )
    });
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || !host_is_safe
    {
        return Err(AppError::BL {
            msg: "Mattermost webhook must use HTTPS without embedded credentials or private IPs"
                .to_string(),
        });
    }
    Ok(())
}

pub struct MattermostWebhookTarget {
    url: Url,
    hostname: Option<String>,
    addresses: Vec<SocketAddr>,
}

impl MattermostWebhookTarget {
    pub fn url(&self) -> &Url {
        &self.url
    }
}

pub async fn resolve_mattermost_webhook(
    webhook: &str,
) -> Result<MattermostWebhookTarget, AppError> {
    validate_mattermost_webhook(Some(webhook))?;
    let url = Url::parse(webhook).map_err(|_| AppError::BL {
        msg: "Mattermost webhook URL is invalid".to_string(),
    })?;
    let host = url
        .host_str()
        .ok_or_else(|| AppError::BL {
            msg: "Mattermost webhook URL is invalid".to_string(),
        })?
        .to_string();
    let port = url.port_or_known_default().ok_or_else(|| AppError::BL {
        msg: "Mattermost webhook URL is invalid".to_string(),
    })?;
    let addresses = tokio::net::lookup_host((host.as_str(), port))
        .await
        .map_err(|_| AppError::BL {
            msg: "Mattermost webhook host did not resolve".to_string(),
        })?
        .collect::<Vec<_>>();
    validate_mattermost_webhook_addresses(&addresses)?;
    Ok(MattermostWebhookTarget {
        url,
        hostname: host.parse::<IpAddr>().is_err().then_some(host),
        addresses,
    })
}

pub fn mattermost_webhook_client(
    target: &MattermostWebhookTarget,
    timeout: Duration,
) -> Result<reqwest::Client, AppError> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout);
    let client = if let Some(hostname) = target.hostname.as_deref() {
        client.resolve_to_addrs(hostname, &target.addresses)
    } else {
        client
    };
    client.build().map_err(|_| AppError::BL {
        msg: "Mattermost client initialization failed".to_string(),
    })
}

fn validate_mattermost_webhook_addresses(
    addresses: &[SocketAddr],
) -> Result<(), AppError> {
    if addresses.is_empty()
        || addresses.iter().any(|address| !is_public_ip(address.ip()))
    {
        return Err(AppError::BL {
            msg: "Mattermost webhook must resolve only to public IPs"
                .to_string(),
        });
    }
    Ok(())
}

fn is_public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            !address.is_private()
                && !address.is_loopback()
                && !address.is_link_local()
                && !address.is_unspecified()
                && !address.is_multicast()
                && !address.is_broadcast()
                && !address.is_documentation()
        }
        IpAddr::V6(address) => address.to_ipv4_mapped().map_or_else(
            || {
                !address.is_loopback()
                    && !address.is_unspecified()
                    && !address.is_multicast()
                    && !address.is_unique_local()
                    && !address.is_unicast_link_local()
            },
            |address| is_public_ip(IpAddr::V4(address)),
        ),
    }
}

pub fn is_dispatcher_upstream_host(host: &str) -> bool {
    host.parse::<Ipv4Addr>().is_ok() || is_dispatcher_hostname(host)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_mattermost_webhook_addresses_are_rejected() {
        let addresses = [SocketAddr::from(([127, 0, 0, 1], 443))];

        assert!(validate_mattermost_webhook_addresses(&addresses).is_err());
    }

    #[tokio::test]
    async fn mattermost_client_does_not_follow_redirects() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            use tokio::io::AsyncWriteExt;
            stream
                .write_all(
                    b"HTTP/1.1 307 Temporary Redirect\r\nLocation: http://127.0.0.1/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await
                .unwrap();
        });
        let target = MattermostWebhookTarget {
            url: Url::parse(&format!("http://{address}")).unwrap(),
            hostname: None,
            addresses: vec![],
        };

        let response =
            mattermost_webhook_client(&target, Duration::from_secs(1))
                .unwrap()
                .post(target.url().clone())
                .send()
                .await
                .unwrap();

        assert_eq!(response.status(), reqwest::StatusCode::TEMPORARY_REDIRECT);
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
        }
    }

    #[test]
    fn harness_engine_accepts_internal_http_and_exact_openai_base() {
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
        assert_eq!(
            agent_provider_transport(&engine(
                "https://api.openai.com/v1",
                Some("real-token"),
                true,
            )),
            Some(AgentProviderTransport::EchoGateway)
        );
        assert_eq!(
            agent_provider_transport(&engine(
                "https://api.openai.com:443/v1/",
                Some("real-token"),
                true,
            )),
            Some(AgentProviderTransport::EchoGateway)
        );
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
