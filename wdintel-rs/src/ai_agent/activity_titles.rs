use super::types::AiAgentActivityPresentation;
use super::{access, events};
use crate::ai_engine::client::{
    government_model, government_route_available, is_gpt_luna,
};
use crate::ai_engine::{request_structured_ai_response, AiEngineMessage};
use crate::config::{
    AI_AGENT_ACTIVITY_DETAIL_MAX_CHARS, AI_AGENT_ACTIVITY_PURPOSE_MAX_CHARS,
    AI_AGENT_ACTIVITY_TITLE_CONCURRENCY, AI_AGENT_ACTIVITY_TITLE_MAX_CHARS,
    AI_AGENT_ACTIVITY_TITLE_MAX_GENERATIONS,
    AI_AGENT_ACTIVITY_TITLE_MAX_TOKENS, AI_AGENT_ACTIVITY_TITLE_PROMPT,
    AI_AGENT_ACTIVITY_TITLE_TIMEOUT_MS, AI_AGENT_OPENAI_GPT_6_LUNA,
    AI_AGENT_OPENAI_GPT_LUNA, AI_CHAT_ROLE_SYSTEM, AI_CHAT_ROLE_USER,
    AI_GOV_UA_PROXY_MODEL_PREFIX,
};
use crate::entities::ai_engine;
use crate::h;
use crate::types::{info, warn, Context, Deserialize, ShortContext};
use regex::Regex;
use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::LazyLock;
use std::time::{Duration, Instant};
use tokio::sync::{watch, Semaphore};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

static TITLE_SLOTS: Semaphore =
    Semaphore::const_new(AI_AGENT_ACTIVITY_TITLE_CONCURRENCY);
static PRIVATE_TEXT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)https?://\S+|/api/\S+|\b(?:echo_[a-z0-9_]+|report_progress)\b|\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b|\b[a-z0-9]{4}(?:-[a-z0-9]{4}){2}\b|[A-Za-z0-9+/_=-]{24,}",
    )
    .expect("activity text pattern is valid")
});

#[derive(Clone)]
pub(super) struct ActivityInput {
    presentation: AiAgentActivityPresentation,
    action: String,
}

pub(super) struct ActivityTitles {
    next_key: i64,
    input: watch::Sender<Option<ActivityInput>>,
    task: JoinHandle<()>,
}

impl ActivityTitles {
    pub fn new(
        ai_client: std::sync::Arc<crate::ai_engine::AiEngineClient>,
        dbx: DatabaseConnection,
        request_id: Uuid,
        purpose: &str,
        cancellation: &CancellationToken,
    ) -> Self {
        let purpose = public_text(purpose, AI_AGENT_ACTIVITY_PURPOSE_MAX_CHARS);
        let (input, receiver) = watch::channel(None);
        let cancellation = cancellation.child_token();
        let task = tokio::spawn(async move {
            generate_titles(
                ai_client,
                dbx,
                request_id,
                purpose,
                receiver,
                cancellation,
            )
            .await;
        });
        Self {
            next_key: 0,
            input,
            task,
        }
    }

    pub fn prepare(
        &mut self,
        event_type: &str,
        payload: &mut Value,
    ) -> Option<ActivityInput> {
        let object = payload.as_object_mut()?;
        object.remove("activityPresentation");
        object.remove("activityOnly");
        let label = match event_type {
            "progress" => object.get("summary"),
            "tool_start" | "tool_update" | "tool_end" => {
                object.get("toolLabel")
            }
            _ => return None,
        }?
        .as_str()?;
        let label = public_text(label, AI_AGENT_ACTIVITY_DETAIL_MAX_CHARS);
        if label.is_empty() {
            return None;
        }
        self.next_key = self.next_key.saturating_add(1);
        let first = label.split(" · ").next().unwrap_or(&label);
        let action = first.split(": ").next().unwrap_or(first).to_string();
        let detail = if first != action
            || action.chars().count() > AI_AGENT_ACTIVITY_TITLE_MAX_CHARS
        {
            Some(label.clone())
        } else {
            label
                .strip_prefix(first)
                .map(|detail| {
                    detail.trim_start_matches(" · ").trim().to_string()
                })
                .filter(|detail| !detail.is_empty())
        };
        let presentation = AiAgentActivityPresentation {
            key: self.next_key,
            title: access::truncate(&action, AI_AGENT_ACTIVITY_TITLE_MAX_CHARS),
            detail,
        };
        object.insert("activityPresentation".to_string(), json!(presentation));
        Some(ActivityInput {
            presentation,
            action,
        })
    }

    pub fn submitted(&self, activity: Option<ActivityInput>) {
        if let Some(activity) = activity {
            self.input.send_replace(Some(activity));
        }
    }
}

impl Drop for ActivityTitles {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn load_title_engine(
    dbx: &DatabaseConnection,
) -> anyhow::Result<Option<ai_engine::Model>> {
    let settings = access::settings(dbx).await.context(h!())?;
    if !settings.feature_enabled {
        return Ok(None);
    }
    if let Some(engine) = government_luna_engine(dbx).await.context(h!())? {
        return Ok(Some(engine));
    }
    let mut engines = access::allowed_engines(dbx).await.context(h!())?;
    engines.retain(|engine| {
        access::agent_provider_transport(engine)
            == Some(access::AgentProviderTransport::DirectHttp)
            || crate::ai_engine::client::government_model(engine).is_some()
    });
    engines.sort_by(|left, right| {
        (&left.name, left.id).cmp(&(&right.name, right.id))
    });
    for preferred in [
        settings.default_ai_engine_id,
        settings.reviewer_ai_engine_id,
    ]
    .into_iter()
    .flatten()
    {
        if let Some(index) =
            engines.iter().position(|engine| engine.id == preferred)
        {
            return Ok(Some(engines.remove(index)));
        }
    }
    Ok(engines.into_iter().next())
}

/// A government Luna, reached directly (while the Azure gateway is enabled)
/// or through a credentials proxy (with its key), whichever sorts first.
async fn government_luna_engine(
    dbx: &DatabaseConnection,
) -> anyhow::Result<Option<ai_engine::Model>> {
    let gateway_enabled =
        crate::ai_engine::gov::gateway_enabled(dbx).await.c(h!())?;
    let model_names = [AI_AGENT_OPENAI_GPT_6_LUNA, AI_AGENT_OPENAI_GPT_LUNA]
        .into_iter()
        .flat_map(|name| {
            [
                name.to_string(),
                format!("{AI_GOV_UA_PROXY_MODEL_PREFIX}{name}"),
            ]
        });
    let engines = ai_engine::Entity::find()
        .filter(ai_engine::Column::Enabled.eq(true))
        .filter(ai_engine::Column::ModelName.is_in(model_names))
        .all(dbx)
        .await
        .c(h!())?;
    Ok(engines
        .into_iter()
        .filter(|engine| {
            government_model(engine).is_some_and(is_gpt_luna)
                && government_route_available(engine, gateway_enabled)
        })
        .min_by(|left, right| {
            (&left.name, left.id).cmp(&(&right.name, right.id))
        }))
}

async fn generate_titles(
    ai_client: std::sync::Arc<crate::ai_engine::AiEngineClient>,
    dbx: DatabaseConnection,
    request_id: Uuid,
    purpose: String,
    mut receiver: watch::Receiver<Option<ActivityInput>>,
    cancellation: CancellationToken,
) {
    let engine = tokio::select! {
        _ = cancellation.cancelled() => return,
        result = tokio::time::timeout(title_timeout(), load_title_engine(&dbx)) => {
            match result {
                Ok(Ok(Some(engine))) => engine,
                _ => {
                    warn!("AI agent activity titles have no available allowed engine");
                    return;
                }
            }
        }
    };
    let mut cache: HashMap<String, Option<String>> = HashMap::new();
    let mut pending = None;
    loop {
        let mut activity = if let Some(activity) = pending.take() {
            activity
        } else {
            tokio::select! {
                _ = cancellation.cancelled() => return,
                changed = receiver.changed() => {
                    if changed.is_err() { return; }
                    let Some(activity) = receiver.borrow_and_update().clone() else { continue; };
                    activity
                }
            }
        };
        let title = if let Some(title) = cache.get(&activity.action) {
            title.clone()
        } else if cache.len() < AI_AGENT_ACTIVITY_TITLE_MAX_GENERATIONS {
            let generated = tokio::select! {
                _ = cancellation.cancelled() => return,
                title = generate_title(&ai_client, &engine, &purpose, &activity.action) => title,
            };
            cache.insert(activity.action.clone(), generated.clone());
            generated
        } else {
            None
        };
        let latest = receiver.borrow_and_update().clone();
        if let Some(latest) = latest {
            if latest.presentation.key != activity.presentation.key {
                if latest.action != activity.action {
                    pending = Some(latest);
                    continue;
                }
                activity = latest;
            }
        }
        let Some(title) = title else {
            continue;
        };
        activity.presentation.title = title;
        if !append_title(&dbx, request_id, &activity.presentation).await {
            return;
        }
    }
}

async fn append_title(
    dbx: &DatabaseConnection,
    request_id: Uuid,
    presentation: &AiAgentActivityPresentation,
) -> bool {
    match events::append_runner(
        dbx,
        request_id,
        "progress",
        json!({ "activityPresentation": presentation, "activityOnly": true }),
    )
    .await
    {
        Ok(appended) => appended,
        Err(_) => {
            warn!("AI agent activity title could not be stored");
            false
        }
    }
}

fn title_timeout() -> Duration {
    Duration::from_millis(AI_AGENT_ACTIVITY_TITLE_TIMEOUT_MS)
}

async fn generate_title(
    ai_client: &crate::ai_engine::AiEngineClient,
    engine: &ai_engine::Model,
    purpose: &str,
    action: &str,
) -> Option<String> {
    let started = Instant::now();
    let response = tokio::time::timeout(title_timeout(), async {
        let _slot = TITLE_SLOTS.acquire().await.c(h!())?;
        request_structured_ai_response(
            ai_client,
            engine,
            vec![
                AiEngineMessage { role: AI_CHAT_ROLE_SYSTEM.to_string(), content: AI_AGENT_ACTIVITY_TITLE_PROMPT.to_string() },
                AiEngineMessage { role: AI_CHAT_ROLE_USER.to_string(), content: json!({ "requestPurpose": purpose, "currentAction": action }).to_string() },
            ],
            0.0,
            AI_AGENT_ACTIVITY_TITLE_MAX_TOKENS,
            json!({
                "type": "json_schema",
                "json_schema": {
                    "name": "public_activity_title", "strict": true,
                    "schema": {
                        "type": "object",
                        "properties": { "title": { "type": "string", "minLength": 1, "maxLength": AI_AGENT_ACTIVITY_TITLE_MAX_CHARS } },
                        "required": ["title"], "additionalProperties": false
                    }
                }
            }),
        )
        .await
        .context(h!())
    })
    .await;
    let title = match response {
        Ok(Ok(response))
            if response
                .finish_reason
                .as_deref()
                .is_none_or(|reason| reason == "stop") =>
        {
            parse_title(&response.content).ok()
        }
        _ => None,
    };
    if title.is_some() {
        info!("AI agent public activity title generated engine_id={} duration_ms={}", engine.id, started.elapsed().as_millis());
    } else {
        warn!("AI agent activity title unavailable; keeping factual public action");
    }
    title
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GeneratedTitle {
    title: String,
}

fn parse_title(response: &str) -> anyhow::Result<String> {
    let response: GeneratedTitle = serde_json::from_str(response).c(h!())?;
    let title = response.title.trim();
    anyhow::ensure!(
        !title.is_empty()
            && title.chars().count() <= AI_AGENT_ACTIVITY_TITLE_MAX_CHARS
            && (3..=7).contains(&title.split_whitespace().count())
            && !title
                .chars()
                .any(|character| character.is_control()
                    || character.is_numeric())
            && !title.contains(['<', '>', '{', '}', '`'])
            && !PRIVATE_TEXT.is_match(title),
        "invalid public activity title"
    );
    Ok(title.split_whitespace().collect::<Vec<_>>().join(" "))
}

fn public_text(text: &str, max_chars: usize) -> String {
    let text = PRIVATE_TEXT.replace_all(text, "");
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    access::truncate(text, max_chars)
}

#[cfg(test)]
mod tests {
    use super::{access, load_title_engine, parse_title};
    use crate::config::{
        AI_AGENT_GLM_5_3, AI_AGENT_OPENAI_GPT_6_LUNA, AI_GOV_UA_API_BASE,
        AI_GOV_UA_SETTINGS_ID,
    };
    use crate::entities::{
        ai_agent_allowed_engine, ai_engine, ai_gov_ua_settings,
    };
    use sea_orm::{
        sea_query::Expr, ActiveModelTrait, ActiveValue::Set, ColumnTrait,
        DatabaseConnection, EntityTrait, IntoActiveModel, QueryFilter,
    };
    use serial_test::serial;
    use uuid::Uuid;

    async fn government_engine(
        dbx: &DatabaseConnection,
        model_name: &str,
    ) -> ai_engine::Model {
        ai_engine::ActiveModel {
            id: Set(Uuid::now_v7()),
            name: Set(format!("issue-4079-{model_name}-{}", Uuid::now_v7())),
            url: Set(AI_GOV_UA_API_BASE.to_string()),
            model_name: Set(model_name.to_string()),
            enabled: Set(true),
            ..Default::default()
        }
        .insert(dbx)
        .await
        .unwrap()
    }

    // Regression: https://github.com/echoua/echo/issues/4079
    #[tokio::test]
    #[serial]
    async fn issue_4079_titles_use_enabled_government_luna_outside_allowed_models(
    ) {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let dbx = &env.dbx;
        // ai_engine rows outlive cleanup; other fixtures may hold luna.
        let other_luna_ids = ai_engine::Entity::find()
            .filter(ai_engine::Column::Enabled.eq(true))
            .filter(ai_engine::Column::ModelName.eq(AI_AGENT_OPENAI_GPT_6_LUNA))
            .all(dbx)
            .await
            .unwrap()
            .into_iter()
            .map(|engine| engine.id)
            .collect::<Vec<_>>();
        set_engines_enabled(dbx, &other_luna_ids, false).await;
        let glm = government_engine(dbx, AI_AGENT_GLM_5_3).await;
        ai_agent_allowed_engine::ActiveModel {
            ai_engine_id: Set(glm.id),
            ..Default::default()
        }
        .insert(dbx)
        .await
        .unwrap();
        let luna = government_engine(dbx, AI_AGENT_OPENAI_GPT_6_LUNA).await;
        let settings = access::settings(dbx).await.unwrap();
        let mut enabled = settings.clone().into_active_model();
        enabled.feature_enabled = Set(true);
        enabled.default_ai_engine_id = Set(Some(glm.id));
        enabled.update(dbx).await.unwrap();
        let gateway =
            ai_gov_ua_settings::Entity::find_by_id(AI_GOV_UA_SETTINGS_ID)
                .one(dbx)
                .await
                .unwrap()
                .unwrap();
        set_gateway_enabled(dbx, &gateway, true).await;

        let title_engine = load_title_engine(dbx).await.unwrap();
        assert_eq!(title_engine.map(|engine| engine.id), Some(luna.id));
        set_gateway_enabled(dbx, &gateway, false).await;
        let title_engine = load_title_engine(dbx).await.unwrap();
        assert_eq!(title_engine.map(|engine| engine.id), Some(glm.id));
        set_gateway_enabled(dbx, &gateway, true).await;
        let mut luna = luna.into_active_model();
        luna.enabled = Set(false);
        luna.update(dbx).await.unwrap();
        let title_engine = load_title_engine(dbx).await.unwrap();
        assert_eq!(title_engine.map(|engine| engine.id), Some(glm.id));

        settings
            .into_active_model()
            .reset_all()
            .update(dbx)
            .await
            .unwrap();
        ai_agent_allowed_engine::Entity::delete_by_id(glm.id)
            .exec(dbx)
            .await
            .unwrap();
        set_engines_enabled(dbx, &other_luna_ids, true).await;
        gateway
            .into_active_model()
            .reset_all()
            .update(dbx)
            .await
            .unwrap();
    }

    #[tokio::test]
    #[serial]
    async fn titles_use_a_proxied_government_luna_without_the_azure_gateway() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let dbx = &env.dbx;
        let luna_names = [AI_AGENT_OPENAI_GPT_6_LUNA, "gpt-luna"]
            .into_iter()
            .flat_map(|name| {
                [name.to_string(), format!("inference.ai.mod.gov.ua/{name}")]
            });
        let other_luna_ids = ai_engine::Entity::find()
            .filter(ai_engine::Column::Enabled.eq(true))
            .filter(ai_engine::Column::ModelName.is_in(luna_names))
            .all(dbx)
            .await
            .unwrap()
            .into_iter()
            .map(|engine| engine.id)
            .collect::<Vec<_>>();
        set_engines_enabled(dbx, &other_luna_ids, false).await;
        let glm = government_engine(dbx, AI_AGENT_GLM_5_3).await;
        ai_agent_allowed_engine::ActiveModel {
            ai_engine_id: Set(glm.id),
            ..Default::default()
        }
        .insert(dbx)
        .await
        .unwrap();
        let settings = access::settings(dbx).await.unwrap();
        let mut enabled = settings.clone().into_active_model();
        enabled.feature_enabled = Set(true);
        enabled.default_ai_engine_id = Set(Some(glm.id));
        enabled.update(dbx).await.unwrap();
        let gateway =
            ai_gov_ua_settings::Entity::find_by_id(AI_GOV_UA_SETTINGS_ID)
                .one(dbx)
                .await
                .unwrap()
                .unwrap();
        set_gateway_enabled(dbx, &gateway, false).await;
        let proxied = |model_name: &str| ai_engine::ActiveModel {
            id: Set(Uuid::now_v7()),
            name: Set(format!("proxied-{model_name}-{}", Uuid::now_v7())),
            url: Set("http://proxy.internal:8080/v1".to_string()),
            token: Set(Some("sk-bf-test".to_string())),
            model_name: Set(model_name.to_string()),
            enabled: Set(true),
            ..Default::default()
        };
        let mistyped = proxied("inference.ai.mod.gov.au/gpt-luna")
            .insert(dbx)
            .await
            .unwrap();
        let title_engine = load_title_engine(dbx).await.unwrap();
        assert_eq!(
            title_engine.map(|engine| engine.id),
            Some(glm.id),
            "a mistyped proxy prefix is never a government Luna"
        );

        let luna = proxied("inference.ai.mod.gov.ua/gpt-luna")
            .insert(dbx)
            .await
            .unwrap();
        let title_engine = load_title_engine(dbx).await.unwrap();
        assert_eq!(
            title_engine.map(|engine| engine.id),
            Some(luna.id),
            "a proxied Luna needs no Azure gateway"
        );

        let mut keyless = luna.clone().into_active_model();
        keyless.token = Set(None);
        keyless.update(dbx).await.unwrap();
        let title_engine = load_title_engine(dbx).await.unwrap();
        assert_eq!(
            title_engine.map(|engine| engine.id),
            Some(glm.id),
            "a proxied Luna without its key is skipped"
        );

        set_engines_enabled(dbx, &[luna.id, mistyped.id, glm.id], false).await;
        settings
            .into_active_model()
            .reset_all()
            .update(dbx)
            .await
            .unwrap();
        ai_agent_allowed_engine::Entity::delete_by_id(glm.id)
            .exec(dbx)
            .await
            .unwrap();
        set_engines_enabled(dbx, &other_luna_ids, true).await;
        gateway
            .into_active_model()
            .reset_all()
            .update(dbx)
            .await
            .unwrap();
    }

    async fn set_gateway_enabled(
        dbx: &DatabaseConnection,
        gateway: &ai_gov_ua_settings::Model,
        enabled: bool,
    ) {
        let mut gateway = gateway.clone().into_active_model();
        gateway.enabled = Set(Some(enabled));
        gateway.update(dbx).await.unwrap();
    }

    async fn set_engines_enabled(
        dbx: &DatabaseConnection,
        ids: &[Uuid],
        enabled: bool,
    ) {
        ai_engine::Entity::update_many()
            .col_expr(ai_engine::Column::Enabled, Expr::value(enabled))
            .filter(ai_engine::Column::Id.is_in(ids.iter().copied()))
            .exec(dbx)
            .await
            .unwrap();
    }

    // Regression: https://github.com/echoua/echo/issues/3064
    #[test]
    fn parses_public_title_without_reasoning_or_invented_counts() {
        assert_eq!(
            parse_title(r#"{"title":"Переглядаю повідомлення за тиждень"}"#)
                .unwrap(),
            "Переглядаю повідомлення за тиждень"
        );
        for response in [
            r#"{"title":"Переглядаю повідомлення за тиждень", "reasoning":"private"}"#,
            r#"{"title":"Відібрано 20 головних подій"}"#,
            r#"{"title":"Переглядаю повідомлення https://private.invalid"}"#,
            r#"{"title":"Викликаю echo_inbox_messages для пошуку"}"#,
            r#"{"title":"Переглядаю <think>internal</think> повідомлення"}"#,
            r#"{"title":"Переглядаю\nповідомлення за тиждень"}"#,
        ] {
            assert!(parse_title(response).is_err());
        }
    }
}
