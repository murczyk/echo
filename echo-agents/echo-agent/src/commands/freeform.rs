use anyhow::Result;
use std::path::Path;

use crate::cli::OutputMode;
use crate::config::AgentConfigPath;
use crate::opencode::{resolve_opencode_bin, resolve_share_dir, run_opencode};
use crate::output::{print_markdown, print_wrapped_markdown};

pub fn run(
    output: OutputMode,
    share_dir: Option<&Path>,
    opencode_bin: Option<&Path>,
    model_name: Option<&str>,
    prompt: &str,
    config_path: &AgentConfigPath,
) -> Result<()> {
    let share_dir = resolve_share_dir(share_dir)?;
    let opencode_bin = resolve_opencode_bin(opencode_bin);
    let request = freeform_request(prompt);
    let markdown = run_opencode(
        opencode_bin.as_path(),
        &share_dir,
        model_name,
        &request,
        config_path.optional_env(),
    )?;

    match output {
        OutputMode::Markdown => print_markdown(&markdown),
        OutputMode::Json => print_wrapped_markdown(&markdown)?,
    }

    Ok(())
}

fn freeform_request(prompt: &str) -> String {
    format!(
        "You are an analyst producing end-user-facing output.\n\
Respond in Markdown only.\n\
Use tables when useful.\n\
Do not wrap the entire answer in a code fence.\n\
\n\
User request:\n\
{prompt}"
    )
}
