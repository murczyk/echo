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
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum ProviderPurpose {
    #[default]
    Research,
    Checkpoint,
    Synthesis,
}

impl ProviderPurpose {
    pub fn parse(value: Option<&str>) -> Option<Self> {
        match value {
            None | Some("research") => Some(Self::Research),
            Some("checkpoint") => Some(Self::Checkpoint),
            Some("synthesis") => Some(Self::Synthesis),
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
        let policy = resolve(config, engine, preset);
        AiAgentReasoningPresetItem {
            preset,
            max_runtime_seconds: policy.max_runtime_seconds as i32,
            reasoning_effort: policy.reasoning_effort,
        }
    })
    .collect()
}

pub fn resolve(
    config: &Config,
    engine: &ai_engine::Model,
    preset: AiAgentReasoningPreset,
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
    let (max_runtime_seconds, finalization_seconds) = match preset {
        AiAgentReasoningPreset::Fast => (
            config::AI_AGENT_FAST_RUNTIME_SEC,
            config::AI_AGENT_FAST_FINALIZATION_SEC,
        ),
        AiAgentReasoningPreset::Balanced => (
            config::AI_AGENT_BALANCED_RUNTIME_SEC,
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
        finalization_seconds,
    }
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
