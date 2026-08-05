use crate::config::{
    AI_AGENT_EVENT_PAYLOAD_MAX_BYTES, AI_AGENT_PROGRESS_MAX_CHARS,
};
use crate::entities::{ai_agent_request, ai_agent_request_event};
use crate::error::AppError;
use crate::h;
use crate::types::ShortContext;
use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, DatabaseConnection,
    DatabaseTransaction, EntityTrait, QueryFilter, QueryOrder, QuerySelect,
    TransactionTrait,
};
use serde_json::Value;
use uuid::Uuid;

const EVENT_TYPES: &[&str] = &[
    "request_start",
    "progress",
    "assistant_delta",
    "tool_start",
    "tool_update",
    "tool_end",
    "source",
    "completion",
    "cancellation",
    "error",
];

const HIDDEN_EVENT_TYPES: &[&str] = &[
    "reasoning",
    "thinking",
    "analysis",
    "hidden_reasoning",
    "chain_of_thought",
];

const RUNNER_EVENT_TYPES: &[&str] = &[
    "progress",
    "assistant_delta",
    "tool_start",
    "tool_update",
    "tool_end",
    "source",
];

pub async fn append_runner(
    dbx: &DatabaseConnection,
    request_id: Uuid,
    event_type: &str,
    payload: Value,
) -> Result<bool, AppError> {
    if !RUNNER_EVENT_TYPES.contains(&event_type) {
        return Err(AppError::BL {
            msg: "Unsupported AI agent runner event type".to_string(),
        });
    }
    append_while_running(dbx, request_id, event_type, payload).await
}

pub async fn append_request_start(
    dbx: &DatabaseConnection,
    request_id: Uuid,
    payload: Value,
) -> Result<bool, AppError> {
    append_while_running(dbx, request_id, "request_start", payload).await
}

async fn append_while_running(
    dbx: &DatabaseConnection,
    request_id: Uuid,
    event_type: &str,
    payload: Value,
) -> Result<bool, AppError> {
    let txn = dbx.begin().await.c(h!())?;
    let request = ai_agent_request::Entity::find_by_id(request_id)
        .lock_exclusive()
        .one(&txn)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    if request.state != "running" || request.cancellation_requested {
        txn.commit().await.c(h!())?;
        return Ok(false);
    }
    append_in_transaction(&txn, request_id, event_type, payload).await?;
    txn.commit().await.c(h!())?;
    Ok(true)
}

pub async fn append_in_transaction(
    txn: &DatabaseTransaction,
    request_id: Uuid,
    event_type: &str,
    payload: Value,
) -> Result<ai_agent_request_event::Model, AppError> {
    let payload = prepare_payload(event_type, payload)?;
    let sequence = ai_agent_request_event::Entity::find()
        .filter(ai_agent_request_event::Column::RequestId.eq(request_id))
        .order_by_desc(ai_agent_request_event::Column::Sequence)
        .one(txn)
        .await
        .c(h!())?
        .map_or(1, |event| event.sequence + 1);
    let event = ai_agent_request_event::ActiveModel {
        request_id: Set(request_id),
        sequence: Set(sequence),
        event_type: Set(event_type.to_string()),
        payload: Set(payload),
        created_at: Set(Utc::now().naive_utc()),
    }
    .insert(txn)
    .await
    .c(h!())?;
    Ok(event)
}

fn prepare_payload(
    event_type: &str,
    payload: Value,
) -> Result<Value, AppError> {
    if !EVENT_TYPES.contains(&event_type) {
        return Err(AppError::BL {
            msg: "Unsupported AI agent event type".to_string(),
        });
    }
    let payload = sanitize(payload);
    if serde_json::to_vec(&payload).c(h!())?.len()
        > AI_AGENT_EVENT_PAYLOAD_MAX_BYTES
    {
        return Err(AppError::BL {
            msg: "AI agent event payload is too large".to_string(),
        });
    }
    Ok(payload)
}

pub fn normalize_runner_event(event: Value) -> Option<(String, Value)> {
    let event_type = event
        .get("eventType")
        .or_else(|| event.get("event_type"))
        .or_else(|| event.get("type"))
        .and_then(Value::as_str)?;
    let event_type = normalize_event_type(event_type);
    if HIDDEN_EVENT_TYPES.contains(&event_type.as_str())
        || !RUNNER_EVENT_TYPES.contains(&event_type.as_str())
    {
        return None;
    }
    let mut payload = event
        .get("payload")
        .cloned()
        .unwrap_or_else(|| event.clone());
    if let Value::Object(payload) = &mut payload {
        payload.remove("type");
        payload.remove("eventType");
        payload.remove("event_type");
    }
    payload = sanitize(payload);
    if event_type == "progress" {
        payload = normalize_progress(payload);
    }
    Some((event_type, payload))
}

pub fn assistant_delta(payload: &Value) -> Option<&str> {
    payload
        .get("delta")
        .or_else(|| payload.get("content"))
        .and_then(Value::as_str)
        .or_else(|| payload.as_str())
}

fn normalize_event_type(event_type: &str) -> String {
    match event_type {
        "requestStart" => "request_start",
        "assistantDelta" => "assistant_delta",
        "toolStart" => "tool_start",
        "toolUpdate" => "tool_update",
        "toolEnd" => "tool_end",
        other => other,
    }
    .to_string()
}

fn normalize_progress(payload: Value) -> Value {
    let summary = payload
        .get("summary")
        .or_else(|| payload.get("content"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let summary = summary
        .split_terminator(['.', '!', '?', '\n'])
        .next()
        .unwrap_or_default()
        .chars()
        .take(AI_AGENT_PROGRESS_MAX_CHARS)
        .collect::<String>();
    serde_json::json!({ "summary": summary })
}

fn sanitize(value: Value) -> Value {
    match value {
        Value::Object(mut object) => {
            object.retain(|key, _| !is_hidden_reasoning_key(key));
            for (key, value) in &mut object {
                if is_sensitive_key(key) {
                    *value = Value::String("[redacted]".to_string());
                }
            }
            Value::Object(
                object
                    .into_iter()
                    .map(|(key, value)| (key, sanitize(value)))
                    .collect(),
            )
        }
        Value::Array(values) => {
            Value::Array(values.into_iter().map(sanitize).collect())
        }
        other => other,
    }
}

fn is_hidden_reasoning_key(key: &str) -> bool {
    matches!(
        normalize_protected_key(key).as_str(),
        "reasoning"
            | "thinking"
            | "analysis"
            | "hiddenreasoning"
            | "chainofthought"
    )
}

fn is_sensitive_key(key: &str) -> bool {
    matches!(
        normalize_protected_key(key).as_str(),
        "authorization"
            | "cookie"
            | "setcookie"
            | "token"
            | "accesstoken"
            | "refreshtoken"
            | "bootstraptoken"
            | "apikey"
            | "password"
            | "credential"
            | "credentials"
    )
}

fn normalize_protected_key(key: &str) -> String {
    key.to_ascii_lowercase().replace(['_', '-'], "")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discards_reasoning_events_and_fields() {
        assert!(normalize_runner_event(
            serde_json::json!({"type":"reasoning","content":"secret"})
        )
        .is_none());
        let (_, payload) = normalize_runner_event(serde_json::json!({
            "type":"tool_start",
            "payload":{"tool":"search","reasoning":"secret","nested":{"thinking":"secret"}}
        }))
        .unwrap();
        let encoded = payload.to_string();
        assert!(!encoded.contains("secret"));
    }

    #[test]
    fn discards_case_and_separator_variants_of_reasoning_fields() {
        let (_, payload) = normalize_runner_event(serde_json::json!({
            "type": "tool_start",
            "payload": {
                "tool": "search",
                "Reasoning": "secret-a",
                "hidden-reasoning": "secret-b",
                "chain-of-thought": "secret-c",
                "nested": [{
                    "ANALYSIS": "secret-d",
                    "Hidden_Reasoning": "secret-e",
                    "safe": "visible"
                }]
            }
        }))
        .unwrap();
        let encoded = payload.to_string();
        assert!(!encoded.contains("secret-"));
        assert!(encoded.contains("visible"));
    }

    #[test]
    fn progress_is_one_short_sentence() {
        let (_, payload) = normalize_runner_event(serde_json::json!({
            "type":"progress",
            "payload":{"summary":"First sentence. Second sentence."}
        }))
        .unwrap();
        assert_eq!(payload["summary"], "First sentence");
    }

    #[test]
    fn discards_runner_lifecycle_events() {
        for event_type in
            ["request_start", "completion", "cancellation", "error"]
        {
            assert!(normalize_runner_event(serde_json::json!({
                "type": event_type,
                "payload": {}
            }))
            .is_none());
        }
    }

    #[test]
    fn redacts_credentials_recursively() {
        let (_, payload) = normalize_runner_event(serde_json::json!({
            "type": "tool_start",
            "payload": {
                "tool": "echo_current_user",
                "bootstrapToken": "secret-a",
                "nested": {"authorization": "secret-b"}
            }
        }))
        .unwrap();
        let encoded = payload.to_string();
        assert!(!encoded.contains("secret-a"));
        assert!(!encoded.contains("secret-b"));
        assert!(encoded.contains("[redacted]"));
    }
}
