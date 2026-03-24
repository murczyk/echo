use crate::config::LoadedAgentConfig;
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CallsignCandidate {
    pub callsign: String,
    pub conf: f64,
}

pub fn build_extract_callsigns_request(
    share_dir: &Path,
    message_id: Option<i64>,
    body: Option<&str>,
    target_message: Option<&Value>,
    loaded_config: Option<&LoadedAgentConfig>,
) -> String {
    let skills_dir = share_dir.join("opencode/skills");
    let skills_dir = skills_dir.display();
    let api_availability = if let Some(loaded_config) = loaded_config {
        format!(
            "ECHO API helpers are available through `${{ECHO_AGENT_BIN:-echo-agent}} api ...` and use config at `{}`.\n\
Use the local skills in `{skills_dir}` when helpful.",
            loaded_config.path.display(),
        )
    } else {
        format!(
            "ECHO API helpers may be unavailable because no agent config was loaded.\n\
You can still work from the message body and the heuristic skills in `{skills_dir}`."
        )
    };

    let input_block = match (message_id, body, target_message) {
        (Some(message_id), _, Some(target_message)) => format!(
            "Target message id: {message_id}\n\
Prefetched target message JSON:\n\
{}\n\
\n\
Before answering, inspect same-frequency context with `${{ECHO_AGENT_BIN:-echo-agent}} api same-frequency-context --message-id {message_id}`.\n\
If a candidate callsign needs confirmation or typo normalization, use `${{ECHO_AGENT_BIN:-echo-agent}} api callsigns-search <query>`.",
            serde_json::to_string_pretty(target_message).unwrap_or_default(),
        ),
        (None, Some(body), _) => format!("Raw message body:\n{body}"),
        _ => String::from("No message input provided."),
    };

    format!(
        "You extract speaker callsigns from SIGINT messages.\n\
Return JSON only.\n\
Do not wrap the answer in Markdown fences.\n\
Preferred output schema:\n\
[\n\
  {{\"callsign\": \"УЧИТЕЛЬ\", \"conf\": 0.95}},\n\
  {{\"callsign\": \"ШЫШ\", \"conf\": 0.95}}\n\
]\n\
\n\
Rules:\n\
- Extract only the callsigns of actual speakers participating in the conversation.\n\
- Ignore third-party mentions that are not speaking.\n\
- Normalize obvious OCR or typing errors to the most likely intended callsign.\n\
- Preserve uppercase Cyrillic form when the intended callsign is clear.\n\
- Deduplicate equivalent callsigns.\n\
- Confidence must be a float between 0 and 1.\n\
- If there are no reliable speaker callsigns, return [].\n\
\n\
{api_availability}\n\
\n\
Suggested workflow:\n\
1. Read the skills under `{skills_dir}`.\n\
2. If a message id is available, inspect same-frequency context and any linked network callsigns.\n\
3. Use the callsign DB helper when a typo or normalization question remains.\n\
4. Return only the final JSON array.\n\
\n\
Input:\n\
{input_block}"
    )
}

pub fn normalize_callsign_candidates(
    output: &str,
) -> Result<Vec<CallsignCandidate>> {
    let output = strip_code_fence(output).trim();
    let value: Value = serde_json::from_str(output).with_context(|| {
        format!("model did not return valid JSON: {output}")
    })?;
    let mut candidates = parse_candidate_value(&value)?;
    normalize_candidate_list(&mut candidates);
    Ok(candidates)
}

fn parse_candidate_value(value: &Value) -> Result<Vec<CallsignCandidate>> {
    if let Some(entries) = value.as_array() {
        return entries
            .iter()
            .map(parse_single_candidate)
            .collect::<Result<Vec<_>>>();
    }

    if value.get("callsign").is_some() {
        return Ok(vec![parse_single_candidate(value)?]);
    }

    if let Some(entries) = value.get("callsigns").and_then(Value::as_array) {
        return entries
            .iter()
            .map(parse_single_candidate)
            .collect::<Result<Vec<_>>>();
    }

    bail!("unexpected callsign extraction JSON shape");
}

fn parse_single_candidate(value: &Value) -> Result<CallsignCandidate> {
    let callsign = value
        .get("callsign")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|callsign| !callsign.is_empty())
        .ok_or_else(|| anyhow::anyhow!("candidate is missing callsign"))?;
    let conf = value.get("conf").and_then(Value::as_f64).unwrap_or(1.0);

    if !(0.0..=1.0).contains(&conf) {
        bail!("candidate confidence must be between 0 and 1");
    }

    Ok(CallsignCandidate {
        callsign: callsign.to_owned(),
        conf,
    })
}

fn normalize_candidate_list(candidates: &mut Vec<CallsignCandidate>) {
    let mut deduped = BTreeMap::<String, CallsignCandidate>::new();
    for candidate in candidates.drain(..) {
        let key = candidate.callsign.to_uppercase();
        match deduped.get_mut(&key) {
            Some(existing) => {
                if candidate.conf > existing.conf {
                    *existing = candidate;
                }
            }
            None => {
                deduped.insert(key, candidate);
            }
        }
    }

    *candidates = deduped.into_values().collect();
    candidates.sort_by(|left, right| {
        right
            .conf
            .partial_cmp(&left.conf)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.callsign.cmp(&right.callsign))
    });
}

fn strip_code_fence(output: &str) -> &str {
    let trimmed = output.trim();
    if let Some(trimmed) = trimmed.strip_prefix("```json") {
        return trimmed.trim().trim_end_matches("```").trim();
    }
    if let Some(trimmed) = trimmed.strip_prefix("```") {
        return trimmed.trim().trim_end_matches("```").trim();
    }
    trimmed
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_json_array() {
        let output = r#"[{"callsign":"УЧИТЕЛЬ","conf":0.95},{"callsign":"ШЫШ","conf":0.93}]"#;
        let parsed = normalize_callsign_candidates(output).unwrap();
        assert_eq!(
            parsed,
            vec![
                CallsignCandidate {
                    callsign: "УЧИТЕЛЬ".to_owned(),
                    conf: 0.95,
                },
                CallsignCandidate {
                    callsign: "ШЫШ".to_owned(),
                    conf: 0.93,
                },
            ]
        );
    }

    #[test]
    fn parses_single_object_and_dedupes_by_uppercase() {
        let output = json!({
            "callsigns": [
                { "callsign": "МРНЫЙ", "conf": 0.55 },
                { "callsign": "МИРНЫЙ", "conf": 0.97 }
            ]
        })
        .to_string();
        let parsed = normalize_callsign_candidates(&output).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].callsign, "МИРНЫЙ");
    }
}
