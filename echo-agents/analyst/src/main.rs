use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand, ValueEnum};
use serde::Deserialize;
use serde_json::json;
use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Parser, Debug)]
#[command(author, version, about)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Produce end-user-facing output through OpenCode.
    Freeform {
        /// Output mode for the final response.
        #[arg(long, value_enum, default_value_t = OutputMode::Markdown)]
        output: OutputMode,

        /// Override the OpenCode binary path. Defaults to $OPENCODE_BIN or `opencode`.
        #[arg(long)]
        opencode_bin: Option<PathBuf>,

        /// Override the configured model.
        #[arg(long)]
        model: Option<String>,

        /// User request to pass to the analyst.
        prompt: String,
    },
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, ValueEnum)]
enum OutputMode {
    Markdown,
    Json,
}

#[derive(Debug, Deserialize)]
struct OpencodeEvent {
    #[serde(rename = "type")]
    event_type: String,
    part: Option<OpencodePart>,
}

#[derive(Debug, Deserialize)]
struct OpencodePart {
    #[serde(rename = "type")]
    part_type: String,
    text: Option<String>,
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Commands::Freeform {
            output,
            opencode_bin,
            model,
            prompt,
        } => run_freeform(
            output,
            opencode_bin.as_deref(),
            model.as_deref(),
            &prompt,
        ),
    }
}

fn run_freeform(
    output: OutputMode,
    opencode_bin: Option<&Path>,
    model: Option<&str>,
    prompt: &str,
) -> Result<()> {
    let project_root = project_root()?;
    let opencode_config = project_root.join("opencode").join("opencode.jsonc");
    let opencode_bin = resolve_opencode_bin(opencode_bin);

    let request = freeform_request(prompt);
    let raw_events = run_opencode(
        opencode_bin.as_path(),
        &project_root,
        &opencode_config,
        model,
        &request,
    )?;
    let markdown = extract_markdown(&raw_events)?;

    match output {
        OutputMode::Markdown => {
            print!("{markdown}");
            if !markdown.ends_with('\n') {
                println!();
            }
        }
        OutputMode::Json => {
            let payload = json!({
                "format": "markdown",
                "content": markdown.trim_end(),
            });
            println!(
                "{}",
                serde_json::to_string_pretty(&payload)
                    .context("failed to serialize JSON output")?
            );
        }
    }

    Ok(())
}

fn resolve_opencode_bin(opencode_bin: Option<&Path>) -> PathBuf {
    if let Some(opencode_bin) = opencode_bin {
        return opencode_bin.to_path_buf();
    }

    env::var_os("OPENCODE_BIN")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("opencode"))
}

fn project_root() -> Result<PathBuf> {
    let analyst_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    analyst_dir
        .parent()
        .map(Path::to_path_buf)
        .context("failed to determine project root")
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

fn run_opencode(
    opencode_bin: &Path,
    project_root: &Path,
    opencode_config: &Path,
    model: Option<&str>,
    prompt: &str,
) -> Result<String> {
    let mut command = Command::new(opencode_bin);
    command
        .arg("run")
        .arg("--format")
        .arg("json")
        .arg("--dir")
        .arg(project_root)
        .arg(prompt)
        .env("OPENCODE_CONFIG", opencode_config);

    if let Some(model) = model {
        command.arg("--model").arg(model);
    }

    let output = command.output().with_context(|| {
        format!(
            "failed to launch opencode binary at {}",
            opencode_bin.display()
        )
    })?;

    if !output.status.success() {
        bail!(
            "opencode failed with status {}:\n{}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    String::from_utf8(output.stdout)
        .context("opencode stdout was not valid UTF-8")
}

fn extract_markdown(raw_events: &str) -> Result<String> {
    let mut markdown = String::new();

    for line in raw_events.lines().filter(|line| !line.trim().is_empty()) {
        let event: OpencodeEvent = serde_json::from_str(line)
            .with_context(|| format!("failed to parse event line: {line}"))?;

        if event.event_type != "text" {
            continue;
        }

        let Some(part) = event.part else {
            continue;
        };

        if part.part_type != "text" {
            continue;
        }

        if let Some(text) = part.text {
            markdown.push_str(&text);
        }
    }

    if markdown.trim().is_empty() {
        bail!("opencode returned no text content")
    }

    Ok(markdown)
}
