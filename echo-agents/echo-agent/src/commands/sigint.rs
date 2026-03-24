use anyhow::{Context, Result};
use std::path::Path;

use crate::callsign_extraction::{
    build_extract_callsigns_request, normalize_callsign_candidates,
};
use crate::cli::MessageInputArgs;
use crate::config::{AgentConfigPath, try_load_agent_config};
use crate::echo_api::EchoApiClient;
use crate::opencode::{resolve_opencode_bin, resolve_share_dir, run_opencode};

pub fn run_extract_callsigns(
    share_dir: Option<&Path>,
    opencode_bin: Option<&Path>,
    model_name: Option<&str>,
    input: MessageInputArgs,
    config_path: &AgentConfigPath,
) -> Result<()> {
    let share_dir = resolve_share_dir(share_dir)?;
    let opencode_bin = resolve_opencode_bin(opencode_bin);
    let loaded_config = match input.message_id {
        Some(_) => Some(config_path.load_required()?),
        None => try_load_agent_config(config_path)?,
    };
    let echo_client = loaded_config
        .as_ref()
        .map(|loaded| EchoApiClient::login(&loaded.config))
        .transpose()?;

    let request = match (input.message_id, input.body.as_deref()) {
        (Some(message_id), None) => {
            let echo_client = echo_client.as_ref().with_context(|| {
                format!("message id {message_id} requires ECHO config")
            })?;
            let target_message = echo_client.message_by_id(message_id)?;
            build_extract_callsigns_request(
                share_dir.as_path(),
                Some(message_id),
                None,
                Some(&target_message),
                loaded_config.as_ref(),
            )
        }
        (None, Some(body)) => build_extract_callsigns_request(
            share_dir.as_path(),
            None,
            Some(body),
            None,
            loaded_config.as_ref(),
        ),
        _ => unreachable!("clap enforces exactly one input variant"),
    };

    let model_output = run_opencode(
        opencode_bin.as_path(),
        &share_dir,
        model_name,
        &request,
        config_path.optional_env(),
    )?;
    let candidates = normalize_callsign_candidates(&model_output)?;

    println!("{}", serde_json::to_string_pretty(&candidates)?);
    Ok(())
}
