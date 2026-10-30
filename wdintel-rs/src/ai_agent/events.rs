use super::types::AiAgentMessageCitation;
use crate::config::{
    AI_AGENT_EVENT_PAYLOAD_MAX_BYTES, AI_AGENT_PROGRESS_MAX_CHARS,
};
use crate::entities::{ai_agent_request, ai_agent_request_event};
use crate::error::AppError;
use crate::h;
use crate::types::{Context, ShortContext};
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
    "assistant_snapshot",
    "completion_metadata",
    "tool_start",
    "tool_update",
    "tool_end",
    "source",
    "message_citations",
    "file_citations",
    "map_artifact",
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
    "assistant_snapshot",
    "completion_metadata",
    "tool_start",
    "tool_update",
    "tool_end",
    "source",
    "message_citations",
    "file_citations",
    "map_artifact",
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
    if event_type == "map_artifact" {
        let document = super::maps::parse(&payload)
            .ok_or_else(|| AppError::BL {
                msg: "Invalid map document".to_string(),
            })
            .c(h!())?;
        let document = super::maps::prepare::canonicalize(document).c(h!())?;
        let published = super::maps::load_documents(&txn, &[request_id])
            .await
            .c(h!())?
            .remove(&request_id)
            .unwrap_or_default();
        if let Some(existing) =
            published.iter().find(|existing| existing.id == document.id)
        {
            if existing != &document {
                return Err(AppError::BL {
                    msg: "Published maps are immutable".to_string(),
                });
            }
            txn.commit().await.c(h!())?;
            return Ok(true);
        }
        if published.len() >= crate::config::AI_AGENT_MAP_MAX_DOCUMENTS {
            return Err(AppError::BL {
                msg: "Map document limit reached".to_string(),
            });
        }
        append_in_transaction(
            &txn,
            request_id,
            event_type,
            serde_json::json!({ "document": document }),
        )
        .await
        .context(h!())?;
        txn.commit().await.c(h!())?;
        return Ok(true);
    }
    append_in_transaction(&txn, request_id, event_type, payload).await?;
    txn.commit().await.c(h!())?;
    Ok(true)
}

pub(super) async fn replace_message_citations(
    txn: &DatabaseTransaction,
    request_id: Uuid,
    citations: &[AiAgentMessageCitation],
) -> Result<(), AppError> {
    ai_agent_request_event::Entity::delete_many()
        .filter(ai_agent_request_event::Column::RequestId.eq(request_id))
        .filter(
            ai_agent_request_event::Column::EventType.eq("message_citations"),
        )
        .exec(txn)
        .await
        .c(h!())?;
    for payload in citation_event_payloads(citations) {
        append_in_transaction(txn, request_id, "message_citations", payload)
            .await
            .context(h!())?;
    }
    Ok(())
}

fn citation_payload_fits(citations: &[&AiAgentMessageCitation]) -> bool {
    let payload = serde_json::json!({ "citations": citations });
    serde_json::to_vec(&payload)
        .map(|encoded| encoded.len() <= AI_AGENT_EVENT_PAYLOAD_MAX_BYTES)
        .unwrap_or(false)
}

fn citation_event_payloads(citations: &[AiAgentMessageCitation]) -> Vec<Value> {
    let mut payloads = Vec::new();
    let mut batch: Vec<&AiAgentMessageCitation> = Vec::new();
    for citation in citations {
        batch.push(citation);
        if citation_payload_fits(&batch) {
            continue;
        }
        batch.pop();
        if !batch.is_empty() {
            payloads.push(serde_json::json!({ "citations": &batch }));
            batch.clear();
        }
        batch.push(citation);
        if !citation_payload_fits(&batch) {
            batch.clear();
        }
    }
    if !batch.is_empty() {
        payloads.push(serde_json::json!({ "citations": &batch }));
    }
    payloads
}

pub async fn append_in_transaction(
    txn: &DatabaseTransaction,
    request_id: Uuid,
    event_type: &str,
    payload: Value,
) -> Result<ai_agent_request_event::Model, AppError> {
    let payload = prepare_payload(event_type, payload)?;
    let map_summary = if event_type == "map_artifact" {
        let document =
            super::maps::parse(&payload).ok_or_else(|| AppError::BL {
                msg: "Invalid map document".to_string(),
            })?;
        Some(serde_json::to_value(document.summary(request_id)).c(h!())?)
    } else {
        None
    };
    let sequence = ai_agent_request_event::Entity::find()
        .select_only()
        .column(ai_agent_request_event::Column::Sequence)
        .filter(ai_agent_request_event::Column::RequestId.eq(request_id))
        .order_by_desc(ai_agent_request_event::Column::Sequence)
        .into_tuple::<i64>()
        .one(txn)
        .await
        .c(h!())?
        .map_or(1, |sequence| sequence + 1);
    let event = ai_agent_request_event::ActiveModel {
        request_id: Set(request_id),
        sequence: Set(sequence),
        event_type: Set(event_type.to_string()),
        payload: Set(payload),
        created_at: Set(Utc::now().naive_utc()),
        map_summary: Set(map_summary),
    }
    .insert(txn)
    .await
    .c(h!())?;
    Ok(event)
}

pub(super) async fn interrupted_text(
    dbx: &DatabaseConnection,
    request_id: Uuid,
) -> anyhow::Result<String> {
    let snapshot = ai_agent_request_event::Entity::find()
        .filter(ai_agent_request_event::Column::RequestId.eq(request_id))
        .filter(
            ai_agent_request_event::Column::EventType.eq("assistant_snapshot"),
        )
        .order_by_desc(ai_agent_request_event::Column::Sequence)
        .one(dbx)
        .await
        .c(h!())?;
    let mut after = snapshot.as_ref().map_or(0, |event| event.sequence);
    let mut text = snapshot
        .as_ref()
        .and_then(|event| event.payload.get("text")?.as_str())
        .unwrap_or_default()
        .to_string();
    loop {
        let events = ai_agent_request_event::Entity::find()
            .filter(ai_agent_request_event::Column::RequestId.eq(request_id))
            .filter(ai_agent_request_event::Column::Sequence.gt(after))
            .filter(
                ai_agent_request_event::Column::EventType.eq("assistant_delta"),
            )
            .order_by_asc(ai_agent_request_event::Column::Sequence)
            .limit(crate::config::AI_AGENT_HISTORY_EVENT_BATCH)
            .all(dbx)
            .await
            .c(h!())?;
        if events.is_empty() {
            break;
        }
        for event in events {
            after = event.sequence;
            if let Some(delta) = assistant_delta(&event.payload) {
                text.push_str(delta);
            }
        }
        if text.len() >= crate::config::AI_AGENT_RESPONSE_MAX_BYTES {
            break;
        }
    }
    truncate_serialized_text(
        &text,
        crate::config::AI_AGENT_HISTORY_DRAFT_MAX_BYTES,
    )
}

pub(super) fn truncate_serialized_text(
    text: &str,
    max_bytes: usize,
) -> anyhow::Result<String> {
    if serde_json::to_vec(text).c(h!())?.len() <= max_bytes {
        return Ok(text.to_string());
    }
    let marker = "\n[Saved draft truncated to fit context.]";
    let chars: Vec<_> = text.chars().collect();
    let (mut low, mut high) = (0, chars.len());
    while low < high {
        let middle = (low + high).div_ceil(2);
        let candidate = chars[..middle].iter().collect::<String>() + marker;
        if serde_json::to_vec(&candidate).c(h!())?.len() <= max_bytes {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    Ok(chars[..low].iter().collect::<String>() + marker)
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

pub fn completion_diagnostic(event: &Value) -> Option<Value> {
    if event.get("type")?.as_str()? != "completion_diagnostic" {
        return None;
    }
    let stage = event.get("stage")?.as_str()?;
    if !matches!(stage, "research" | "synthesis" | "answer") {
        return None;
    }
    let outcome = event.get("outcome")?.as_str()?;
    if !matches!(
        outcome,
        "complete"
            | "output_limit"
            | "empty"
            | "provider_error"
            | "transient_error"
            | "aborted"
            | "authorization"
            | "content_filter"
            | "no_evidence"
            | "citation_rejected"
            | "fallback"
            | "inability"
            | "tool_error"
            | "context_limit"
            | "time_limit"
            | "tool_limit"
    ) {
        return None;
    }
    let mut diagnostic =
        serde_json::json!({ "stage": stage, "outcome": outcome });
    for key in ["stopReason", "rawStopReason"] {
        if let Some(value) = event.get(key).and_then(Value::as_str) {
            if matches!(
                value,
                "stop"
                    | "length"
                    | "toolUse"
                    | "tool_calls"
                    | "error"
                    | "aborted"
                    | "content_filter"
                    | "end_turn"
                    | "unknown"
            ) {
                diagnostic[key] = Value::String(value.to_string());
            }
        }
    }
    for key in [
        "inputTokens",
        "outputTokens",
        "textCharacters",
        "toolCalls",
        "durationMs",
        "remainingMs",
        "maxTokens",
        "attempt",
    ] {
        if let Some(value) = event.get(key).and_then(Value::as_u64) {
            diagnostic[key] = Value::from(value);
        }
    }
    Some(diagnostic)
}

pub fn tool_diagnostic(event: &Value) -> Option<Value> {
    if event.get("type")?.as_str()? != "tool_diagnostic" {
        return None;
    }
    let reason = event.get("reason")?.as_str()?;
    if !matches!(
        reason,
        "research_checkpoint_required"
            | "research_pagination_required"
            | "http_error"
            | "invalid_arguments"
            | "cancelled"
            | "network_error"
            | "tool_error"
    ) {
        return None;
    }
    let tool = event.get("tool").and_then(Value::as_str).unwrap_or("");
    let tool = if matches!(tool, "report_progress" | "update_research")
        || tool.strip_prefix("echo_").is_some_and(|skill| {
            super::route_registry::ROUTES
                .iter()
                .any(|route| route.skill == skill)
        }) {
        tool
    } else {
        "unknown"
    };
    let mut diagnostic = serde_json::json!({ "tool": tool, "reason": reason });
    if let Some(private) =
        event.get("handledPrivately").and_then(Value::as_bool)
    {
        diagnostic["handledPrivately"] = Value::Bool(private);
    }
    if reason == "http_error" {
        if let Some(status) = event.get("httpStatus").and_then(Value::as_u64) {
            if (400..=599).contains(&status) {
                diagnostic["httpStatus"] = Value::from(status);
            }
        }
    }
    Some(diagnostic)
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
        payload.remove("activityPresentation");
        payload.remove("activityOnly");
    }
    payload = sanitize(payload);
    if event_type == "completion_metadata" {
        let metadata: super::types::AiAgentCompletionMetadata =
            serde_json::from_value(payload).ok()?;
        if !metadata.coverage_limited
            || !matches!(
                metadata.reason.as_str(),
                "time_limit"
                    | "tool_limit"
                    | "context_limit"
                    | "provider_error"
            )
        {
            return None;
        }
        payload = serde_json::to_value(metadata).ok()?;
    }
    if event_type == "file_citations" {
        let citations = super::file_citations::parse(&payload)?;
        payload = serde_json::json!({ "citations": citations });
    }
    if event_type == "message_citations" {
        let citations = super::citations::parse(&payload)?;
        payload = serde_json::json!({ "citations": citations });
    }
    if event_type == "map_artifact" {
        let document = super::maps::parse(&payload)?;
        payload = serde_json::json!({ "document": document });
    }
    if event_type == "assistant_snapshot" {
        let text = payload.get("text").and_then(Value::as_str)?;
        if text.is_empty() {
            return None;
        }
        let stored = serde_json::json!({ "text": text });
        let Ok(encoded) = serde_json::to_vec(&stored) else {
            return None;
        };
        if encoded.len() > AI_AGENT_EVENT_PAYLOAD_MAX_BYTES {
            return None;
        }
        payload = stored;
    }
    if event_type == "progress" {
        payload = normalize_progress(payload);
    }
    Some((event_type, payload))
}

#[derive(Debug)]
pub enum AssistantTextUpdate {
    Append(String),
    Replace(String),
}

pub fn assistant_text_update(
    event_type: &str,
    payload: &Value,
) -> Option<AssistantTextUpdate> {
    match event_type {
        "assistant_snapshot" => Some(AssistantTextUpdate::Replace(
            payload.get("text")?.as_str()?.to_string(),
        )),
        "assistant_delta" => Some(AssistantTextUpdate::Append(
            assistant_delta(payload)?.to_string(),
        )),
        _ => None,
    }
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
        "assistantSnapshot" => "assistant_snapshot",
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
    fn issue_3572_kept_completion_diagnostics_private_and_allowlisted() {
        let event = serde_json::json!({
            "type": "completion_diagnostic", "stage": "synthesis",
            "outcome": "output_limit", "stopReason": "length",
            "rawStopReason": "secret provider response", "outputTokens": 8192,
            "inputTokens": "secret", "remainingMs": -1,
            "text": "private research", "arguments": {"token": "secret"}
        });
        assert_eq!(
            completion_diagnostic(&event).unwrap(),
            serde_json::json!({
                "stage": "synthesis", "outcome": "output_limit",
                "stopReason": "length", "outputTokens": 8192
            })
        );
        assert!(normalize_runner_event(event).is_none());
        assert!(completion_diagnostic(&serde_json::json!({
            "type": "completion_diagnostic", "stage": "secret", "outcome": "complete"
        })).is_none());
    }

    #[test]
    fn issue_3572_kept_tool_failure_diagnostics_private_and_allowlisted() {
        let event = serde_json::json!({
            "type": "tool_diagnostic", "tool": "echo_inbox_messages",
            "reason": "research_pagination_required", "handledPrivately": true,
            "httpStatus": 503, "text": "private research",
            "arguments": {"token": "secret"}, "error": "secret"
        });
        assert_eq!(
            tool_diagnostic(&event).unwrap(),
            serde_json::json!({
                "tool": "echo_inbox_messages",
                "reason": "research_pagination_required", "handledPrivately": true
            })
        );
        assert!(normalize_runner_event(event).is_none());
        assert_eq!(
            tool_diagnostic(&serde_json::json!({
                "type": "tool_diagnostic", "tool": "secret",
                "reason": "http_error", "httpStatus": 503,
                "handledPrivately": "secret"
            }))
            .unwrap(),
            serde_json::json!({"tool": "unknown", "reason": "http_error", "httpStatus": 503})
        );
        assert!(tool_diagnostic(&serde_json::json!({
            "type": "tool_diagnostic", "tool": "echo_inbox_messages",
            "reason": "secret", "httpStatus": 999
        }))
        .is_none());
        assert!(tool_diagnostic(&serde_json::json!({
            "type": "tool_diagnostic", "reason": "http_error", "httpStatus": 999
        }))
        .unwrap()
        .get("httpStatus")
        .is_none());
    }

    #[test]
    fn snapshot_replaces_text_and_drops_empty_or_oversized_payloads() {
        let (_, payload) = normalize_runner_event(serde_json::json!({
            "type": "assistant_snapshot",
            "text": "Final [джерело](/rer-analysis-neo?m=77)"
        }))
        .unwrap();
        match assistant_text_update("assistant_snapshot", &payload) {
            Some(AssistantTextUpdate::Replace(text)) => {
                assert!(text.contains("m=77"));
            }
            other => panic!("expected replacement, got {other:?}"),
        }
        assert!(normalize_runner_event(serde_json::json!({
            "type": "assistant_snapshot",
            "text": ""
        }))
        .is_none());
        let huge = "x".repeat(crate::config::AI_AGENT_EVENT_PAYLOAD_MAX_BYTES);
        assert!(normalize_runner_event(serde_json::json!({
            "type": "assistant_snapshot",
            "text": huge
        }))
        .is_none());
        let mut response = "draft".to_string();
        let mut response_chars = response.chars().count();
        if let Some(AssistantTextUpdate::Append(delta)) = assistant_text_update(
            "assistant_delta",
            &serde_json::json!({ "delta": " more" }),
        ) {
            response_chars =
                response_chars.saturating_add(delta.chars().count());
            response.push_str(&delta);
        }
        if let Some(AssistantTextUpdate::Replace(text)) =
            assistant_text_update("assistant_snapshot", &payload)
        {
            response.clear();
            response.push_str(&text);
            response_chars = text.chars().count();
        }
        assert_eq!(response, payload["text"].as_str().unwrap());
        assert_eq!(response_chars, response.chars().count());
        assert!(!response.contains("draft"));
    }

    #[test]
    fn issue_3724_preserves_context_limited_completion() {
        let (_, payload) = normalize_runner_event(serde_json::json!({
            "type": "completion_metadata",
            "coverageLimited": true,
            "reason": "context_limit"
        }))
        .unwrap();
        assert_eq!(payload["reason"], "context_limit");
        assert_eq!(payload["coverageLimited"], true);
        let (_, payload) = normalize_runner_event(serde_json::json!({
            "type": "completion_metadata",
            "coverageLimited": true,
            "reason": "provider_error"
        }))
        .unwrap();
        assert_eq!(payload["reason"], "provider_error", "#3572");
        assert!(normalize_runner_event(serde_json::json!({
            "type": "completion_metadata",
            "coverageLimited": true,
            "reason": "unknown_reason"
        }))
        .is_none());
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
    fn citation_events_stay_within_the_payload_cap() {
        let citations = (0..500)
            .map(|index| {
                let prefix = format!("{index:03}-");
                AiAgentMessageCitation {
                    message_id: index + 1,
                    message_identifier: format!(
                        "{prefix}{}",
                        "m".repeat(512 - prefix.len())
                    ),
                }
            })
            .collect::<Vec<_>>();
        let payloads = citation_event_payloads(&citations);
        assert!(payloads.len() >= 2);
        let mut count = 0_usize;
        for payload in &payloads {
            let encoded = serde_json::to_vec(payload).unwrap();
            assert!(encoded.len() <= AI_AGENT_EVENT_PAYLOAD_MAX_BYTES);
            count += payload["citations"].as_array().unwrap().len();
        }
        assert_eq!(count, citations.len());
    }

    #[test]
    fn redacts_credentials_recursively() {
        let (_, payload) = normalize_runner_event(serde_json::json!({
            "type": "tool_start",
            "payload": {
                "tool": "echo_current_user",
                "bootstrapToken": "secret-a",
                "nested": {"authorization": "secret-b"},
                "activityPresentation": {"key": 99, "title": "Forged"},
                "activityOnly": true
            }
        }))
        .unwrap();
        let encoded = payload.to_string();
        assert!(!encoded.contains("secret-a"));
        assert!(!encoded.contains("secret-b"));
        assert!(encoded.contains("[redacted]"));
        assert!(payload.get("activityPresentation").is_none());
        assert!(payload.get("activityOnly").is_none());
    }
}
