//! JSON Schemas of the request bodies the AI agent sends, generated from the
//! Rust request types so the harness cannot drift from them.
//!
//! A passthrough route (`request_kind: "json"`) sends its schema with the route
//! definition, and the runner uses it as the tool's parameters. An adapted
//! route keeps a model-facing schema in the runner; its request schema is
//! exported to `CONTRACT_FILE`, and the runner tests check every request
//! builder against it.

use crate::ai_position::types::AiPositionLookupReq;
use crate::rer_importer::types::{
    AnalysisCallsignFrequencyMatchesReq, AnalysisStatsReq,
    BatchMessageCommentsReq, InboxItemContextReq, InboxMessagesReq,
    MessageIdsReq, MessageUuidsReq,
};
use crate::sigint::unit::types::ListUnitsReq;
use schemars::{generate::SchemaSettings, JsonSchema};
use serde_json::Value;

/// Exported request schemas of every route that has one, relative to the crate.
#[cfg(test)]
pub const CONTRACT_FILE: &str = "src/ai_agent/request_schemas.json";

/// The schema of the body the agent may send to a route, if it has one.
pub fn request_schema(skill: &str) -> Option<Value> {
    Some(match skill {
        "messages_by_uuid" => agent_schema::<MessageUuidsReq>(),
        "message_comments_batch" => agent_schema::<BatchMessageCommentsReq>(),
        "messages_by_id" => agent_schema::<MessageIdsReq>(),
        "inbox_messages" | "direction_findings" => {
            agent_schema::<InboxMessagesReq>()
        }
        "frequency_summary"
        | "new_callsigns"
        | "daily_activity"
        | "callsign_relations"
        | "metadata_statistics"
        | "network_statistics" => agent_schema::<AnalysisStatsReq>(),
        "callsign_frequency_matches" => {
            agent_schema::<AnalysisCallsignFrequencyMatchesReq>()
        }
        "interception_context" => agent_schema::<InboxItemContextReq>(),
        "position_lookup" => agent_schema::<AiPositionLookupReq>(),
        "unit_lookup" => agent_schema::<ListUnitsReq>(),
        _ => return None,
    })
}

/// Request schemas by skill, as exported to `CONTRACT_FILE`.
#[cfg(test)]
pub fn contract() -> std::collections::BTreeMap<&'static str, Value> {
    super::route_registry::ROUTES
        .iter()
        .filter_map(|route| Some((route.skill, request_schema(route.skill)?)))
        .collect()
}

// Inlined subschemas: some OpenAI-compatible backends reject `$ref` in tools.
fn agent_schema<T: JsonSchema>() -> Value {
    let mut schema = SchemaSettings::draft07()
        .with(|settings| {
            settings.inline_subschemas = true;
            settings.meta_schema = None;
        })
        .into_generator()
        .into_root_schema_for::<T>()
        .to_value();
    if let Some(root) = schema.as_object_mut() {
        root.remove("title");
    }
    close_objects(&mut schema);
    schema
}

/// The agent may send only the fields a request type declares, so a renamed
/// field fails the contract instead of being silently ignored by serde.
fn close_objects(schema: &mut Value) {
    let Some(object) = schema.as_object_mut() else {
        return;
    };
    let has_properties = match object.get_mut("properties") {
        Some(Value::Object(properties)) => {
            properties.values_mut().for_each(close_objects);
            true
        }
        _ => false,
    };
    if has_properties {
        object.insert("additionalProperties".into(), Value::Bool(false));
    }
    if let Some(items) = object.get_mut("items") {
        close_objects(items);
    }
    for key in ["anyOf", "oneOf", "allOf"] {
        if let Some(Value::Array(branches)) = object.get_mut(key) {
            branches.iter_mut().for_each(close_objects);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const UPDATE_ENV: &str = "ECHO_UPDATE_AGENT_REQUEST_SCHEMAS";

    #[test]
    fn contract_file_is_current() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join(CONTRACT_FILE);
        let expected =
            format!("{}\n", serde_json::to_string_pretty(&contract()).unwrap());
        if std::env::var_os(UPDATE_ENV).is_some() {
            std::fs::write(&path, &expected).unwrap();
            return;
        }
        let actual = std::fs::read_to_string(&path).unwrap_or_default();
        assert!(
            actual == expected,
            "AI agent request schemas changed: run `just gen-ai-agent-schemas`, \
             then make the runner's request builders match (`cd echo-ai-agent && npm test`)"
        );
    }

    #[test]
    fn schemas_are_inline_and_closed() {
        for (skill, schema) in contract() {
            let text = schema.to_string();
            assert!(!text.contains("$ref"), "{skill} schema has a $ref");
            assert!(!text.contains("definitions"), "{skill} has definitions");
            assert_eq!(
                schema["additionalProperties"],
                Value::Bool(false),
                "{skill} schema accepts unknown fields"
            );
        }
    }

    #[test]
    fn passthrough_schemas_describe_the_model_arguments() {
        let schema = request_schema("messages_by_uuid").unwrap();
        assert_eq!(schema["required"], serde_json::json!(["message_uuids"]));
        let uuids = &schema["properties"]["message_uuids"];
        assert_eq!(uuids["items"]["format"], "uuid");
        assert_eq!(uuids["maxItems"], 100);
        assert!(uuids["description"].as_str().unwrap().contains("m="));
        assert!(schema["properties"].get("inbox_req").is_none());
        let comments = request_schema("message_comments_batch").unwrap();
        assert_eq!(
            comments["properties"]["messages"]["items"]["required"],
            serde_json::json!(["message_id"])
        );
        assert!(request_schema("accessible_group_details").is_none());
    }

    #[test]
    fn passthrough_schema_accepts_what_echo_deserializes() {
        let body = serde_json::json!({
            "message_uuids": ["01a1ba32-c862-7bcc-b685-d71d1d326f77"]
        });
        let request: MessageUuidsReq = serde_json::from_value(body).unwrap();
        assert_eq!(request.message_uuids.len(), 1);
        assert!(request.inbox_req.is_none());
    }
}
