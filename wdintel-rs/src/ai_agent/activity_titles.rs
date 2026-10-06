use super::types::AiAgentActivityPresentation;
use super::{access, events};
use crate::ai_engine::{request_structured_ai_response, AiEngineMessage};
use crate::config::{
    AI_AGENT_ACTIVITY_DETAIL_MAX_CHARS, AI_AGENT_ACTIVITY_PURPOSE_MAX_CHARS,
    AI_AGENT_ACTIVITY_TITLE_CONCURRENCY, AI_AGENT_ACTIVITY_TITLE_MAX_CHARS,
    AI_AGENT_ACTIVITY_TITLE_MAX_GENERATIONS,
    AI_AGENT_ACTIVITY_TITLE_MAX_TOKENS, AI_AGENT_ACTIVITY_TITLE_PROMPT,
    AI_AGENT_ACTIVITY_TITLE_TIMEOUT_MS, AI_CHAT_ROLE_SYSTEM, AI_CHAT_ROLE_USER,
};
use crate::entities::ai_engine;
use crate::h;
use crate::types::{info, warn, Context, Deserialize, ShortContext};
use regex::Regex;
use sea_orm::DatabaseConnection;
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
    let mut engines = access::allowed_engines(dbx).await.context(h!())?;
    engines.retain(|engine| {
        access::agent_provider_transport(engine)
            == Some(access::AgentProviderTransport::DirectHttp)
            || crate::ai_engine::client::is_government_url(&engine.url)
    });
    engines.sort_by(|left, right| {
        (&left.name, left.id).cmp(&(&right.name, right.id))
    });
    if let Some(index) = engines.iter().position(|engine| {
        crate::ai_engine::client::is_government_url(&engine.url)
            && engine.model_name == crate::config::AI_AGENT_OPENAI_GPT_6_LUNA
    }) {
        return Ok(Some(engines.remove(index)));
    }
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
    use super::parse_title;

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
