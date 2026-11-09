//! One model call per message. Candidates are numbered keys, mapped back to
//! network ids here, so the model cannot name a network that is not a
//! candidate.

use super::context::MatchInput;
use super::NetworkMatchCandidate;
use crate::ai_engine::{
    extraction_output_tokens, request_structured_ai_response, AiEngineMessage,
    AiEngineResponse,
};
use crate::ai_position::extract::strip_code_fence;
use crate::config::{
    AI_CHAT_ROLE_ASSISTANT, AI_CHAT_ROLE_SYSTEM, AI_CHAT_ROLE_USER,
    AI_NETWORK_MATCH_MAX_CANDIDATES, AI_NETWORK_MATCH_OUTPUT_MAX_TOKENS,
    AI_NETWORK_MATCH_PROMPT, AI_NETWORK_MATCH_REASON_MAX_CHARS,
    AI_NETWORK_MATCH_REPAIR_PROMPT,
};
use crate::entities::ai_engine;
use crate::h;
use crate::types::ShortContext;
use anyhow::Context as _;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;

const TEMPERATURE: f32 = 0.0;

#[derive(Debug, Deserialize)]
struct ModelResponse {
    networks: Vec<ModelNetwork>,
}

#[derive(Debug, Deserialize)]
struct ModelNetwork {
    key: i64,
    certainty: f64,
    #[serde(default)]
    reason: String,
}

/// One entry per `network_ids` item, in the same order.
pub(super) async fn score(
    ai_client: &crate::ai_engine::AiEngineClient,
    engine: &ai_engine::Model,
    input: &MatchInput,
    network_ids: &[i64],
) -> anyhow::Result<Vec<NetworkMatchCandidate>> {
    let input = serde_json::to_string(input).c(h!())?;
    let base = || {
        vec![
            message(AI_CHAT_ROLE_SYSTEM, AI_NETWORK_MATCH_PROMPT),
            message(AI_CHAT_ROLE_USER, &input),
        ]
    };
    let response = request(ai_client, engine, base()).await.c(h!())?;
    let parsed = match parse_response(&response) {
        Ok(parsed) => parsed,
        Err(_) => repair(ai_client, engine, base(), response).await.c(h!())?,
    };
    validate(parsed, network_ids)
}

/// Small models sometimes break the JSON; one repair request usually fixes
/// it.
async fn repair(
    ai_client: &crate::ai_engine::AiEngineClient,
    engine: &ai_engine::Model,
    mut messages: Vec<AiEngineMessage>,
    response: AiEngineResponse,
) -> anyhow::Result<ModelResponse> {
    messages.push(message(AI_CHAT_ROLE_ASSISTANT, &response.content));
    messages.push(message(AI_CHAT_ROLE_USER, AI_NETWORK_MATCH_REPAIR_PROMPT));
    let response = request(ai_client, engine, messages).await.c(h!())?;
    parse_response(&response)
        .with_context(|| format!("відповідь ШІ: {}", response.content))
}

fn message(role: &str, content: &str) -> AiEngineMessage {
    AiEngineMessage {
        role: role.to_string(),
        content: content.to_string(),
    }
}

async fn request(
    ai_client: &crate::ai_engine::AiEngineClient,
    engine: &ai_engine::Model,
    messages: Vec<AiEngineMessage>,
) -> anyhow::Result<AiEngineResponse> {
    request_structured_ai_response(
        ai_client,
        engine,
        messages,
        TEMPERATURE,
        extraction_output_tokens(engine, AI_NETWORK_MATCH_OUTPUT_MAX_TOKENS),
        response_format(),
    )
    .await
    .c(h!())
}

fn parse_response(
    response: &AiEngineResponse,
) -> anyhow::Result<ModelResponse> {
    let finish_reason = response.finish_reason.as_deref();
    anyhow::ensure!(
        finish_reason.is_none_or(|reason| reason == "stop"),
        "AI response did not finish: finish_reason={finish_reason:?}"
    );
    serde_json::from_str(strip_code_fence(&response.content)).c(h!())
}

/// Unknown and duplicate keys reject the reply; a candidate the model left
/// out scores 0.
fn validate(
    parsed: ModelResponse,
    network_ids: &[i64],
) -> anyhow::Result<Vec<NetworkMatchCandidate>> {
    let mut by_index = HashMap::new();
    for network in parsed.networks {
        let index = usize::try_from(network.key)
            .ok()
            .and_then(|key| key.checked_sub(1))
            .filter(|index| *index < network_ids.len())
            .ok_or_else(|| {
                anyhow::anyhow!("AI returned unknown key {}", network.key)
            })?;
        let candidate = NetworkMatchCandidate {
            network_id: network_ids[index],
            certainty: network.certainty.round().clamp(0.0, 100.0) as i32,
            reason: network
                .reason
                .trim()
                .chars()
                .take(AI_NETWORK_MATCH_REASON_MAX_CHARS)
                .collect(),
        };
        anyhow::ensure!(
            by_index.insert(index, candidate).is_none(),
            "AI returned key {} twice",
            network.key
        );
    }
    Ok(network_ids
        .iter()
        .enumerate()
        .map(|(index, network_id)| {
            by_index.remove(&index).unwrap_or(NetworkMatchCandidate {
                network_id: *network_id,
                certainty: 0,
                reason: String::new(),
            })
        })
        .collect())
}

fn response_format() -> Value {
    json!({
        "type": "json_schema",
        "json_schema": {
            "name": "network_match",
            "strict": true,
            "schema": {
                "type": "object",
                "additionalProperties": false,
                "required": ["networks"],
                "properties": {
                    "networks": {
                        "type": "array",
                        "maxItems": AI_NETWORK_MATCH_MAX_CANDIDATES,
                        "items": {
                            "type": "object",
                            "additionalProperties": false,
                            "required": ["key", "certainty", "reason"],
                            "properties": {
                                "key": {
                                    "type": "integer",
                                    "minimum": 1,
                                    "maximum": AI_NETWORK_MATCH_MAX_CANDIDATES
                                },
                                "certainty": {
                                    "type": "integer",
                                    "minimum": 0,
                                    "maximum": 100
                                },
                                "reason": {
                                    "type": "string",
                                    "maxLength": AI_NETWORK_MATCH_REASON_MAX_CHARS
                                }
                            }
                        }
                    }
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(networks: Vec<(i64, f64)>) -> ModelResponse {
        ModelResponse {
            networks: networks
                .into_iter()
                .map(|(key, certainty)| ModelNetwork {
                    key,
                    certainty,
                    reason: " збіг позивних ".to_string(),
                })
                .collect(),
        }
    }

    #[test]
    fn validate_maps_keys_fills_missing_and_clamps() {
        let scored =
            validate(parsed(vec![(2, 140.0), (1, 12.4)]), &[10, 20, 30])
                .unwrap();
        assert_eq!(
            scored
                .iter()
                .map(|c| (c.network_id, c.certainty))
                .collect::<Vec<_>>(),
            vec![(10, 12), (20, 100), (30, 0)]
        );
        assert_eq!(scored[0].reason, "збіг позивних");
        assert_eq!(scored[2].reason, "");
    }

    #[test]
    fn validate_rejects_unknown_and_duplicate_keys() {
        assert!(validate(parsed(vec![(3, 50.0)]), &[10, 20]).is_err());
        assert!(validate(parsed(vec![(0, 50.0)]), &[10, 20]).is_err());
        assert!(
            validate(parsed(vec![(1, 50.0), (1, 60.0)]), &[10, 20]).is_err()
        );
    }

    #[test]
    fn parse_response_accepts_fenced_json_and_rejects_cut_off_replies() {
        let response =
            |content: &str, finish_reason: Option<&str>| AiEngineResponse {
                content: content.to_string(),
                finish_reason: finish_reason.map(str::to_string),
                model_name: None,
            };
        let fenced = "```json\n{\"networks\":[{\"key\":1,\"certainty\":90,\"reason\":\"\"}]}\n```";
        assert_eq!(
            parse_response(&response(fenced, Some("stop")))
                .unwrap()
                .networks
                .len(),
            1
        );
        assert!(parse_response(&response(fenced, None)).is_ok());
        assert!(parse_response(&response(fenced, Some("length"))).is_err());
    }
}
