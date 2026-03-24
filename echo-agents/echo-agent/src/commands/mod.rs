mod api;
mod freeform;
mod service;
mod sigint;

use anyhow::Result;

use crate::cli::{Cli, Commands};
use crate::config::AgentConfigPath;

pub fn run(cli: Cli) -> Result<()> {
    let Cli {
        share_dir,
        config,
        command,
    } = cli;
    let config_path = AgentConfigPath::new(config.as_deref());

    match command.unwrap_or(Commands::Run) {
        Commands::Run => service::run(),
        Commands::Freeform {
            output,
            opencode_bin,
            model_name,
            prompt,
        } => freeform::run(
            output,
            share_dir.as_deref(),
            opencode_bin.as_deref(),
            model_name.as_deref(),
            &prompt,
            &config_path,
        ),
        Commands::SigintExtractCallsigns {
            input,
            opencode_bin,
            model_name,
        } => sigint::run_extract_callsigns(
            share_dir.as_deref(),
            opencode_bin.as_deref(),
            model_name.as_deref(),
            input,
            &config_path,
        ),
        Commands::Api { command } => api::run(command, &config_path),
    }
}
