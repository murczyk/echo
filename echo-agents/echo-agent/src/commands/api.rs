use anyhow::Result;

use crate::cli::ApiCommands;
use crate::config::AgentConfigPath;
use crate::echo_api::EchoApiClient;

pub fn run(command: ApiCommands, config_path: &AgentConfigPath) -> Result<()> {
    let loaded_config = config_path.load_required()?;
    let echo_client = EchoApiClient::login(&loaded_config.config)?;
    let payload = match command {
        ApiCommands::MessageById { message_id } => {
            echo_client.message_by_id(message_id)?
        }
        ApiCommands::SameFrequencyContext {
            message_id,
            hours_before,
            hours_after,
            limit,
        } => echo_client.same_frequency_context(
            message_id,
            hours_before,
            hours_after,
            limit,
        )?,
        ApiCommands::CallsignsSearch { query, limit } => {
            echo_client.callsigns_search(&query, limit)?
        }
        ApiCommands::NetworkInfo { network_ids } => {
            echo_client.network_info(&network_ids)?
        }
        ApiCommands::NetworkCallsigns { network_id } => {
            echo_client.network_callsigns(network_id)?
        }
    };

    println!("{}", serde_json::to_string_pretty(&payload)?);
    Ok(())
}
