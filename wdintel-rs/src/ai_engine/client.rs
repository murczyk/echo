use super::metrics::{
    ProviderCallAttempt, ProviderMetricsSink, StreamBodyTimer,
};
use super::{cooldown::ProviderCooldown, gov};
use crate::config::{
    AI_AGENT_OPENAI_GPT_6_LUNA, AI_AGENT_OPENAI_GPT_6_SOL,
    AI_ENGINE_GLM_5_3_MODEL, AI_ENGINE_REQUEST_TIMEOUT_SEC, AI_GOV_UA_API_BASE,
    AI_GOV_UA_API_HOST, AI_GOV_UA_AUTH_BASE, AI_GOV_UA_TOKEN_REFRESH_SKEW_SEC,
    AI_GOV_UA_TOKEN_REQUEST_TIMEOUT_SEC,
};
use crate::entities::{ai_engine, ai_gov_ua_settings};
use crate::h;
use crate::telemetry::Metrics;
use crate::types::{info, Deserialize, ShortContext};
use sea_orm::DatabaseConnection;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use url::Url;

pub struct AiEngineClient {
    http: reqwest::Client,
    dbx: DatabaseConnection,
    secret_key: Option<String>,
    token: Mutex<Option<CachedToken>>,
    government_cooldowns: Arc<Mutex<HashMap<String, Arc<ProviderCooldown>>>>,
    preview_settings: Option<ai_gov_ua_settings::Model>,
    metrics: Option<ProviderMetricsSink>,
    #[cfg(test)]
    token_endpoint: Option<Url>,
}

struct CachedToken {
    settings: ai_gov_ua_settings::Model,
    value: String,
    refresh_at: Instant,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: u64,
    token_type: String,
}

impl AiEngineClient {
    pub fn new(
        dbx: DatabaseConnection,
        secret_key: Option<String>,
    ) -> anyhow::Result<Self> {
        Ok(Self {
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .c(h!())?,
            dbx,
            secret_key,
            token: Mutex::new(None),
            government_cooldowns: Arc::default(),
            preview_settings: None,
            metrics: None,
            #[cfg(test)]
            token_endpoint: None,
        })
    }

    pub fn with_metrics(
        mut self,
        metrics: Option<Metrics>,
        process: &'static str,
    ) -> Self {
        self.metrics = metrics.map(|metrics| ProviderMetricsSink {
            metrics: Arc::new(metrics),
            process,
        });
        self
    }

    pub(crate) fn start_stream_body_timer(
        &self,
        engine: &ai_engine::Model,
    ) -> Option<StreamBodyTimer> {
        self.metrics
            .as_ref()
            .map(|sink| StreamBodyTimer::start(sink, engine))
    }

    pub(super) fn preview(&self, settings: ai_gov_ua_settings::Model) -> Self {
        Self {
            http: self.http.clone(),
            dbx: self.dbx.clone(),
            secret_key: self.secret_key.clone(),
            token: Mutex::new(None),
            government_cooldowns: self.government_cooldowns.clone(),
            preview_settings: Some(settings),
            metrics: self.metrics.clone(),
            #[cfg(test)]
            token_endpoint: self.token_endpoint.clone(),
        }
    }

    pub async fn send(
        &self,
        engine: &ai_engine::Model,
        body: Value,
        timeout: Duration,
    ) -> anyhow::Result<reqwest::Response> {
        self.send_agent_request(engine, body, timeout, false)
            .await
            .c(h!())
    }

    pub async fn send_responses(
        &self,
        engine: &ai_engine::Model,
        body: Value,
        timeout: Duration,
    ) -> anyhow::Result<reqwest::Response> {
        self.send_agent_request(engine, body, timeout, true)
            .await
            .c(h!())
    }

    async fn send_agent_request(
        &self,
        engine: &ai_engine::Model,
        body: Value,
        timeout: Duration,
        responses: bool,
    ) -> anyhow::Result<reqwest::Response> {
        let mut attempt = ProviderCallAttempt::start(
            self.metrics.as_ref(),
            engine,
            is_streaming(Some(&body)),
        );
        let result = self
            .send_after_cooldown(engine, body, timeout, responses, &mut attempt)
            .await;
        attempt.finish(&result);
        result
    }

    async fn send_after_cooldown(
        &self,
        engine: &ai_engine::Model,
        body: Value,
        timeout: Duration,
        responses: bool,
        attempt: &mut ProviderCallAttempt,
    ) -> anyhow::Result<reqwest::Response> {
        if !is_government_url(&engine.url) {
            attempt.mark_provider_start();
            return self
                .send_agent_request_inner(engine, body, timeout, responses)
                .await
                .c(h!());
        }
        let cooldown = self.government_cooldown(&engine.model_name).await;
        let deadline = tokio::time::Instant::now() + timeout;
        tokio::time::timeout_at(deadline, async {
            cooldown.wait().await;
            let timeout =
                deadline.saturating_duration_since(tokio::time::Instant::now());
            anyhow::ensure!(
                !timeout.is_zero(),
                "Government provider request deadline elapsed during provider cooldown"
            );
            attempt.mark_provider_start();
            let response = self
                .send_agent_request_inner(engine, body, timeout, responses)
                .await
                .c(h!())?;
            cooldown
                .observe(response.status(), response.headers())
                .await
                .c(h!())?;
            Ok(response)
        })
        .await
        .c(h!())?
    }

    async fn government_cooldown(
        &self,
        model_name: &str,
    ) -> Arc<ProviderCooldown> {
        self.government_cooldowns
            .lock()
            .await
            .entry(model_name.to_owned())
            .or_default()
            .clone()
    }

    async fn send_agent_request_inner(
        &self,
        engine: &ai_engine::Model,
        mut body: Value,
        timeout: Duration,
        responses: bool,
    ) -> anyhow::Result<reqwest::Response> {
        let mut endpoint = super::chat_completions_url(&engine.url).c(h!())?;
        if responses {
            let prefix =
                endpoint.path().strip_suffix("/chat/completions").c(h!())?;
            endpoint.set_path(&format!("{prefix}/responses"));
        }
        if is_government_url(&engine.url) {
            if !responses {
                adapt_government_request(&engine.model_name, &mut body);
            }
            let settings = self.government_settings().await.c(h!())?;
            return self
                .send_government(endpoint, Some(body), timeout, settings)
                .await
                .c(h!());
        }
        anyhow::ensure!(
            endpoint.host_str() != Some(AI_GOV_UA_API_HOST),
            "Некоректний URL державного шлюзу ШІ"
        );
        let mut request = self
            .http
            .post(endpoint)
            .timeout(timeout)
            .header(reqwest::header::ACCEPT, response_content_type(Some(&body)))
            .json(&body);
        if let Some(token) = engine.token.as_deref() {
            request = request.bearer_auth(token);
        }
        request.send().await.c(h!())
    }

    async fn government_settings(
        &self,
    ) -> anyhow::Result<ai_gov_ua_settings::Model> {
        let settings = match &self.preview_settings {
            Some(settings) => settings.clone(),
            None => gov::load(&self.dbx).await.c(h!())?,
        };
        anyhow::ensure!(settings.enabled == Some(true), gov::GovernmentCheckError("Налаштуйте та увімкніть державний шлюз ШІ в адміністративній панелі".into()));
        Ok(settings)
    }

    async fn send_government(
        &self,
        endpoint: Url,
        body: Option<Value>,
        timeout: Duration,
        settings: ai_gov_ua_settings::Model,
    ) -> anyhow::Result<reqwest::Response> {
        let token = self.government_token(&settings, None).await.c(h!())?;
        let response = self
            .send_authenticated(
                endpoint.clone(),
                body.as_ref(),
                timeout,
                &token,
            )
            .await
            .c(h!())?;
        if response.status() != reqwest::StatusCode::UNAUTHORIZED {
            return Ok(response);
        }
        drop(response);
        let settings = self.government_settings().await.c(h!())?;
        let token = self
            .government_token(&settings, Some(&token))
            .await
            .c(h!())?;
        self.send_authenticated(endpoint, body.as_ref(), timeout, &token)
            .await
            .c(h!())
    }

    async fn send_authenticated(
        &self,
        endpoint: Url,
        body: Option<&Value>,
        timeout: Duration,
        token: &str,
    ) -> anyhow::Result<reqwest::Response> {
        let request = match body {
            Some(body) => self.http.post(endpoint).json(body),
            None => self.http.get(endpoint),
        };
        request
            .timeout(timeout)
            .header(reqwest::header::ACCEPT, response_content_type(body))
            .bearer_auth(token)
            .send()
            .await
            .c(h!())
    }

    async fn government_token(
        &self,
        settings: &ai_gov_ua_settings::Model,
        rejected: Option<&str>,
    ) -> anyhow::Result<String> {
        let mut cached = self.token.lock().await;
        if let Some(token) = cached.as_ref() {
            if token.settings == *settings
                && token.refresh_at > Instant::now()
                && rejected != Some(token.value.as_str())
            {
                return Ok(token.value.clone());
            }
        }
        let token = self.acquire_token(settings).await.c(h!())?;
        let value = token.value.clone();
        *cached = Some(token);
        info!("Government AI access token renewed");
        Ok(value)
    }

    async fn acquire_token(
        &self,
        settings: &ai_gov_ua_settings::Model,
    ) -> anyhow::Result<CachedToken> {
        let started = Instant::now();
        let response = self.request_azure_token(settings).await.c(h!())?;
        anyhow::ensure!(
            response.token_type.eq_ignore_ascii_case("bearer")
                && !response.access_token.is_empty()
                && response.expires_in > 0,
            gov::GovernmentCheckError(
                "Azure AI authentication returned an invalid access token"
                    .into()
            )
        );
        let lifetime = response
            .expires_in
            .saturating_sub(AI_GOV_UA_TOKEN_REFRESH_SKEW_SEC)
            .max(response.expires_in / 2);
        let refresh_at =
            started.checked_add(Duration::from_secs(lifetime)).c(h!())?;
        Ok(CachedToken {
            settings: settings.clone(),
            value: response.access_token,
            refresh_at,
        })
    }

    async fn request_azure_token(
        &self,
        settings: &ai_gov_ua_settings::Model,
    ) -> anyhow::Result<TokenResponse> {
        let tenant = settings.tenant_id.as_deref().c(h!())?;
        let tenant = uuid::Uuid::parse_str(tenant).c(h!())?;
        let endpoint = Url::parse(&format!(
            "{AI_GOV_UA_AUTH_BASE}/{tenant}/oauth2/v2.0/token"
        ))
        .c(h!())?;
        #[cfg(test)]
        let endpoint = self.token_endpoint.clone().unwrap_or(endpoint);
        let secret = gov::decrypt_secret(
            self.secret_key.as_deref(),
            settings.client_secret_encrypted.as_deref().c(h!())?,
        )
        .c(h!())?;
        let response = self
            .http
            .post(endpoint)
            .timeout(Duration::from_secs(AI_GOV_UA_TOKEN_REQUEST_TIMEOUT_SEC))
            .form(&[
                ("grant_type", "client_credentials"),
                ("client_id", settings.client_id.as_deref().c(h!())?),
                ("scope", settings.scope.as_deref().c(h!())?),
                ("client_secret", secret.as_str()),
            ])
            .send()
            .await
            .c(h!())?;
        anyhow::ensure!(
            response.status().is_success(),
            gov::GovernmentCheckError(format!(
                "Azure AI authentication returned HTTP {}",
                response.status()
            ))
        );
        response.json().await.c(h!())
    }

    pub async fn government_models(&self) -> anyhow::Result<Vec<String>> {
        let settings = self.government_settings().await.c(h!())?;
        let response = self
            .send_government(
                Url::parse(&format!("{AI_GOV_UA_API_BASE}/models")).c(h!())?,
                None,
                Duration::from_secs(AI_ENGINE_REQUEST_TIMEOUT_SEC),
                settings,
            )
            .await
            .c(h!())?;
        anyhow::ensure!(
            response.status().is_success(),
            gov::GovernmentCheckError(format!(
                "Державний шлюз ШІ повернув HTTP {}",
                response.status()
            ))
        );
        let response: Value = response.json().await.c(h!())?;
        let models = response.get("data").and_then(Value::as_array).c(h!())?;
        models
            .iter()
            .map(|entry| {
                entry
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .c(h!())
            })
            .collect()
    }
}

fn is_streaming(body: Option<&Value>) -> bool {
    body.and_then(|body| body.get("stream"))
        .and_then(Value::as_bool)
        == Some(true)
}

fn response_content_type(body: Option<&Value>) -> &'static str {
    if is_streaming(body) {
        "text/event-stream"
    } else {
        "application/json"
    }
}

pub(super) fn is_government_glm(engine: &ai_engine::Model) -> bool {
    engine.model_name == AI_ENGINE_GLM_5_3_MODEL
        && is_government_url(&engine.url)
}

pub fn is_government_url(value: &str) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    url.scheme() == "https"
        && url.host_str() == Some(AI_GOV_UA_API_HOST)
        && url.port().is_none_or(|port| port == 443)
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && matches!(
            url.path().trim_end_matches('/'),
            "/v1" | "/v1/chat/completions"
        )
}

fn adapt_government_request(name: &str, body: &mut Value) {
    if !matches!(name, AI_AGENT_OPENAI_GPT_6_SOL | AI_AGENT_OPENAI_GPT_6_LUNA) {
        return;
    }
    let Some(body) = body.as_object_mut() else {
        return;
    };
    if let Some(tokens) = body.remove("max_tokens") {
        body.entry("max_completion_tokens").or_insert(tokens);
    }
    body.remove("temperature");
    body.insert("reasoning_effort".to_string(), json!("none"));
    body.insert(
        "allowed_openai_params".to_string(),
        json!(["reasoning_effort"]),
    );
}

#[cfg(test)]
#[path = "client_tests.rs"]
mod tests;
