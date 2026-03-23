use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand, ValueEnum};
use serde_json::{Value, json};
use std::env;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

const SYSTEM_SHARE_DIR: &str = "/usr/share/echo-agent";
const OPENCODE_CONFIG_RELATIVE_PATH: &str = "opencode/opencode.jsonc";

#[derive(Parser, Debug)]
#[command(author, version, about)]
struct Cli {
    /// Override the bundled share directory. Defaults to $ECHO_AGENT_SHARE_DIR or auto-detection.
    #[arg(long, global = true)]
    share_dir: Option<PathBuf>,

    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Run the long-lived agent worker loop.
    Run,

    /// Produce end-user-facing output through OpenCode.
    Freeform {
        /// Output mode for the final response.
        #[arg(long, value_enum, default_value_t = OutputMode::Markdown)]
        output: OutputMode,

        /// Override the OpenCode binary path. Defaults to $OPENCODE_BIN or common install paths.
        #[arg(long)]
        opencode_bin: Option<PathBuf>,

        /// Override the configured model.
        #[arg(long = "model")]
        model_name: Option<String>,

        /// User request to pass to the analyst.
        prompt: String,
    },
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, ValueEnum)]
enum OutputMode {
    Markdown,
    Json,
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    match cli.command.unwrap_or(Commands::Run) {
        Commands::Run => run_service_loop(),
        Commands::Freeform {
            output,
            opencode_bin,
            model_name,
            prompt,
        } => run_freeform(
            output,
            cli.share_dir.as_deref(),
            opencode_bin.as_deref(),
            model_name.as_deref(),
            &prompt,
        ),
    }
}

fn run_service_loop() -> Result<()> {
    loop {
        thread::sleep(Duration::from_secs(3600));
    }
}

fn run_freeform(
    output: OutputMode,
    share_dir: Option<&Path>,
    opencode_bin: Option<&Path>,
    model_name: Option<&str>,
    prompt: &str,
) -> Result<()> {
    let share_dir = resolve_share_dir(share_dir)?;
    let opencode_config = share_dir.join(OPENCODE_CONFIG_RELATIVE_PATH);
    let opencode_bin = resolve_opencode_bin(opencode_bin);
    let request = freeform_request(prompt);
    let markdown = run_opencode(
        opencode_bin.as_path(),
        &share_dir,
        &opencode_config,
        model_name,
        &request,
    )?;

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

fn resolve_share_dir(share_dir: Option<&Path>) -> Result<PathBuf> {
    if let Some(share_dir) = share_dir {
        return Ok(share_dir.to_path_buf());
    }

    if let Some(share_dir) = env::var_os("ECHO_AGENT_SHARE_DIR") {
        return Ok(PathBuf::from(share_dir));
    }

    for candidate in share_dir_candidates()? {
        if candidate.join(OPENCODE_CONFIG_RELATIVE_PATH).is_file() {
            return Ok(candidate);
        }
    }

    bail!(
        "failed to locate echo-agent share dir; set --share-dir or ECHO_AGENT_SHARE_DIR"
    )
}

fn share_dir_candidates() -> Result<Vec<PathBuf>> {
    let current_executable = env::current_exe()
        .context("failed to determine current executable path")?;
    let mut candidates = vec![PathBuf::from(SYSTEM_SHARE_DIR)];

    for ancestor in current_executable.ancestors() {
        candidates.push(ancestor.to_path_buf());
        candidates.push(ancestor.join("share/echo-agent"));
    }

    Ok(candidates)
}

fn resolve_opencode_bin(opencode_bin: Option<&Path>) -> PathBuf {
    if let Some(opencode_bin) = opencode_bin {
        return opencode_bin.to_path_buf();
    }

    if let Some(opencode_bin) = env::var_os("OPENCODE_BIN") {
        return PathBuf::from(opencode_bin);
    }

    for candidate in [
        PathBuf::from("/usr/bin/opencode"),
        PathBuf::from("/root/.opencode/bin/opencode"),
        PathBuf::from("/home/echo/.opencode/bin/opencode"),
    ] {
        if candidate.is_file() {
            return candidate;
        }
    }

    PathBuf::from("opencode")
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
    share_dir: &Path,
    opencode_config: &Path,
    model_name: Option<&str>,
    prompt: &str,
) -> Result<String> {
    let mut command = Command::new(opencode_bin);
    command
        .arg("run")
        .arg("--format")
        .arg("json")
        .arg("--dir")
        .arg(share_dir)
        .arg(prompt)
        .env("OPENCODE_CONFIG", opencode_config)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(model_name) = model_name {
        command.arg("--model").arg(model_name);
    }

    let mut child = command.spawn().with_context(|| {
        format!(
            "failed to launch opencode binary at {}",
            opencode_bin.display()
        )
    })?;

    let stdout = child
        .stdout
        .take()
        .context("failed to capture opencode stdout")?;
    let stderr = child
        .stderr
        .take()
        .context("failed to capture opencode stderr")?;
    let stderr_handle = thread::spawn(move || read_stderr(stderr));

    let mut markdown = String::new();
    let mut saw_step_finish = false;
    let mut error_message = None;

    for line in BufReader::new(stdout).lines() {
        let line = line.context("failed to read opencode stdout")?;
        let line = line.trim();
        if line.is_empty() || !line.starts_with('{') {
            continue;
        }

        let event: Value = serde_json::from_str(line)
            .with_context(|| format!("failed to parse event line: {line}"))?;

        if let Some(message) = opencode_error_message(&event) {
            error_message = Some(message);
            break;
        }

        push_text_from_event(&mut markdown, &event);

        if event.get("type").and_then(Value::as_str) == Some("step_finish") {
            saw_step_finish = true;
            break;
        }
    }

    if child
        .try_wait()
        .context("failed to query opencode process status")?
        .is_none()
    {
        let _ = child.kill();
    }

    let status = child
        .wait()
        .context("failed to wait for opencode process")?;
    let stderr_output = stderr_handle.join().map_err(|_| {
        anyhow::anyhow!("failed to join opencode stderr reader")
    })??;

    if let Some(error_message) = error_message {
        bail!("opencode returned error event: {error_message}");
    }

    if !status.success() && !saw_step_finish {
        bail!("opencode failed with status {}:\n{}", status, stderr_output);
    }

    if markdown.trim().is_empty() {
        bail!("opencode returned no text content")
    }

    Ok(markdown)
}

fn push_text_from_event(markdown: &mut String, event: &Value) {
    if event.get("type").and_then(Value::as_str) != Some("text") {
        return;
    }

    if event.pointer("/part/type").and_then(Value::as_str) != Some("text") {
        return;
    }

    if let Some(text) = event.pointer("/part/text").and_then(Value::as_str) {
        markdown.push_str(text);
    }
}

fn opencode_error_message(event: &Value) -> Option<String> {
    if event.get("type").and_then(Value::as_str) != Some("error") {
        return None;
    }

    if let Some(message) = event.get("message").and_then(Value::as_str) {
        return Some(message.to_owned());
    }

    if let Some(message) =
        event.pointer("/error/message").and_then(Value::as_str)
    {
        return Some(message.to_owned());
    }

    Some(event.to_string())
}

fn read_stderr(mut stderr: impl Read) -> Result<String> {
    let mut stderr_output = String::new();
    stderr
        .read_to_string(&mut stderr_output)
        .context("failed to read opencode stderr")?;
    Ok(stderr_output)
}
