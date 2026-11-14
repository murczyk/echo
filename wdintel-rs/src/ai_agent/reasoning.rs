use super::types::{AiAgentReasoningPreset, AiAgentReasoningPresetItem};
use crate::config::{self, Config};
use crate::entities::{ai_agent_request, ai_engine};
use crate::h;
use crate::types::ShortContext;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderApi {
    OpenaiCompletions,
    OpenaiResponses,
}

impl ProviderApi {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OpenaiCompletions => "openai-completions",
            Self::OpenaiResponses => "openai-responses",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionPolicy {
    pub preset: AiAgentReasoningPreset,
    pub api: ProviderApi,
    pub reasoning_effort: Option<String>,
    pub checkpoint_effort: Option<String>,
    pub synthesis_effort: Option<String>,
    pub max_runtime_seconds: u64,
    pub finalization_seconds: u64,
    /// A Fast or Balanced request that builds a document, on the document
    /// tier's budget.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub document_task: bool,
}

/// Per-request counters and timeouts; a 4-hour Deep run gets larger ones so
/// that the clock, not a counter, bounds its research.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RequestLimits {
    pub api_calls: i64,
    pub provider_calls: i64,
    pub runner_events: usize,
    pub event_bytes: usize,
    /// One provider turn; `None` keeps the engine's default timeout.
    pub provider_turn_timeout_sec: Option<u64>,
}

pub fn limits(policy: Option<&ExecutionPolicy>) -> RequestLimits {
    if policy.is_some_and(|policy| {
        policy.preset == AiAgentReasoningPreset::Deep
            && policy.max_runtime_seconds >= config::AI_AGENT_DEEP_RUNTIME_SEC
    }) {
        RequestLimits {
            api_calls: config::AI_AGENT_DEEP_API_CALL_LIMIT,
            provider_calls:
                config::AI_AGENT_DEEP_PROVIDER_CAPABILITY_CALL_LIMIT,
            runner_events: config::AI_AGENT_DEEP_REQUEST_MAX_RUNNER_EVENTS,
            event_bytes: config::AI_AGENT_DEEP_REQUEST_MAX_EVENT_BYTES,
            provider_turn_timeout_sec: Some(
                config::AI_AGENT_DEEP_PROVIDER_REQUEST_TIMEOUT_SEC,
            ),
        }
    } else {
        RequestLimits {
            api_calls: config::AI_AGENT_API_CALL_LIMIT,
            provider_calls: config::AI_AGENT_PROVIDER_CAPABILITY_CALL_LIMIT,
            runner_events: config::AI_AGENT_REQUEST_MAX_RUNNER_EVENTS,
            event_bytes: config::AI_AGENT_REQUEST_MAX_EVENT_BYTES,
            provider_turn_timeout_sec: None,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum ProviderPurpose {
    #[default]
    Research,
    Checkpoint,
    Synthesis,
    Rewrite,
}

impl ProviderPurpose {
    pub fn parse(value: Option<&str>) -> Option<Self> {
        match value {
            None | Some("research") => Some(Self::Research),
            Some("checkpoint") => Some(Self::Checkpoint),
            Some("synthesis") => Some(Self::Synthesis),
            Some("rewrite") => Some(Self::Rewrite),
            _ => None,
        }
    }
}

pub fn enabled(config: &Config) -> bool {
    config.ai_agent_reasoning_presets_enabled == Some(true)
}

pub fn reasoning_available(config: &Config, engine: &ai_engine::Model) -> bool {
    enabled(config)
        && config
            .ai_agent_reasoning_verified_engine_ids
            .as_ref()
            .is_some_and(|ids| ids.contains(&engine.id))
        && matches!(
            engine.model_name.as_str(),
            config::AI_AGENT_GLM_5_3
                | config::AI_AGENT_OPENAI_GPT_6_SOL
                | config::AI_AGENT_OPENAI_GPT_6_1_SOL
        )
        && super::access::agent_provider_transport(engine)
            == Some(super::access::AgentProviderTransport::EchoGateway)
}

pub fn presets(
    config: &Config,
    engine: &ai_engine::Model,
) -> Vec<AiAgentReasoningPresetItem> {
    if !enabled(config) {
        return Vec::new();
    }
    [
        AiAgentReasoningPreset::Fast,
        AiAgentReasoningPreset::Balanced,
        AiAgentReasoningPreset::Deep,
    ]
    .into_iter()
    .map(|preset| {
        let policy = resolve(config, engine, preset, false);
        AiAgentReasoningPresetItem {
            preset,
            max_runtime_seconds: policy.max_runtime_seconds as i32,
            reasoning_effort: policy.reasoning_effort,
        }
    })
    .collect()
}

/// The policy of a new request. A Fast or Balanced request that builds a
/// document keeps its reasoning effort but gets the document tier's time,
/// enough to search Echo, fill the template and save it.
pub fn resolve(
    config: &Config,
    engine: &ai_engine::Model,
    preset: AiAgentReasoningPreset,
    document_task: bool,
) -> ExecutionPolicy {
    let verified = reasoning_available(config, engine);
    let name = engine.model_name.as_str();
    let (api, effort, lowest) =
        if verified && name == config::AI_AGENT_GLM_5_3 {
            (
                ProviderApi::OpenaiCompletions,
                Some(match preset {
                    AiAgentReasoningPreset::Fast => "low",
                    AiAgentReasoningPreset::Balanced => "high",
                    AiAgentReasoningPreset::Deep => "max",
                }),
                Some("low"),
            )
        } else if verified {
            let lowest = if name == config::AI_AGENT_OPENAI_GPT_6_SOL {
                "none"
            } else {
                "low"
            };
            (
                ProviderApi::OpenaiResponses,
                Some(match preset {
                    AiAgentReasoningPreset::Fast => lowest,
                    AiAgentReasoningPreset::Balanced => "medium",
                    AiAgentReasoningPreset::Deep => "max",
                }),
                Some(lowest),
            )
        } else if name == config::AI_AGENT_GLM_FLASH {
            // Research keeps Flash's default thinking. Synthesis and checkpoints
            // run at GLM-5.3's lowest effort: by default, Flash's hidden
            // reasoning used the whole output allowance of a third of them
            // (incident 01a1d9d0).
            (ProviderApi::OpenaiCompletions, None, Some("low"))
        } else {
            let effort = if name == config::AI_AGENT_GLM_5_3 {
                Some("max")
            } else if name.starts_with(
                config::AI_AGENT_OPENAI_REASONING_NONE_MODEL_PREFIX,
            ) || matches!(
                name,
                config::AI_AGENT_OPENAI_GPT_6_SOL
                    | config::AI_AGENT_OPENAI_GPT_6_LUNA
            ) {
                Some("none")
            } else {
                None
            };
            (ProviderApi::OpenaiCompletions, effort, effort)
        };
    let document_task = document_task && preset != AiAgentReasoningPreset::Deep;
    let (max_runtime_seconds, finalization_seconds) = match preset {
        _ if document_task => (
            config::AI_AGENT_DOCUMENT_RUNTIME_SEC,
            config::AI_AGENT_DOCUMENT_FINALIZATION_SEC,
        ),
        AiAgentReasoningPreset::Fast => (
            config::AI_AGENT_FAST_RUNTIME_SEC,
            config::AI_AGENT_FAST_FINALIZATION_SEC,
        ),
        AiAgentReasoningPreset::Balanced => (
            if bounded_research(name) {
                config::AI_AGENT_BOUNDED_BALANCED_RUNTIME_SEC
            } else {
                config::AI_AGENT_BALANCED_RUNTIME_SEC
            },
            config::AI_AGENT_BALANCED_FINALIZATION_SEC,
        ),
        AiAgentReasoningPreset::Deep => (
            config::AI_AGENT_DEEP_RUNTIME_SEC,
            config::AI_AGENT_DEEP_FINALIZATION_SEC,
        ),
    };
    ExecutionPolicy {
        preset,
        api,
        reasoning_effort: effort.map(str::to_owned),
        checkpoint_effort: lowest.map(str::to_owned),
        synthesis_effort: lowest.map(str::to_owned),
        max_runtime_seconds,
        finalization_seconds: if bounded_research(name) {
            finalization_seconds
                * config::AI_AGENT_BOUNDED_RESEARCH_FINALIZATION_MULTIPLIER
        } else {
            finalization_seconds
        },
        document_task,
    }
}

/// Every non-OpenAI engine (GLM, Gemma) runs the runner's bounded research
/// harness, which reserves twice the base finalization time for synthesis.
fn bounded_research(model_name: &str) -> bool {
    !openai_model(model_name)
}

/// OpenAI-family engines are the ones the refusal rewrite layer serves: only
/// they produce the policy refusals the layer retries.
pub fn openai_model(model_name: &str) -> bool {
    config::AI_AGENT_OPENAI_MODEL_PREFIXES
        .iter()
        .any(|prefix| model_name.starts_with(prefix))
}

pub fn request_policy(
    request: &ai_agent_request::Model,
) -> anyhow::Result<Option<ExecutionPolicy>> {
    request
        .execution_policy
        .clone()
        .map(serde_json::from_value)
        .transpose()
        .c(h!())
}

pub fn deadline_millis(
    request: &ai_agent_request::Model,
    policy: &ExecutionPolicy,
) -> Option<i64> {
    request.started_at.map(|started| {
        started.and_utc().timestamp_millis()
            + policy.max_runtime_seconds as i64 * 1000
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_every_provider_purpose() {
        assert_eq!(
            ProviderPurpose::parse(None),
            Some(ProviderPurpose::Research)
        );
        for (value, expected) in [
            ("research", ProviderPurpose::Research),
            ("checkpoint", ProviderPurpose::Checkpoint),
            ("synthesis", ProviderPurpose::Synthesis),
            ("rewrite", ProviderPurpose::Rewrite),
        ] {
            assert_eq!(
                ProviderPurpose::parse(Some(value)),
                Some(expected),
                "{value}"
            );
        }
        assert_eq!(ProviderPurpose::parse(Some("other")), None);
    }

    #[test]
    fn openai_model_prefixes_select_the_refusal_rewrite_layer() {
        assert!(openai_model("gpt-6.1-sol"));
        assert!(openai_model("gpt-6-luna"));
        assert!(openai_model("o3-mini"));
        assert!(!openai_model(crate::config::AI_AGENT_GLM_5_3));
        assert!(!openai_model("gemma-4"));
    }
}
