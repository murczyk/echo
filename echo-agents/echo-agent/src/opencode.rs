use anyhow::{Context, Result, bail};
use serde_json::Value;
use std::env;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;

const SYSTEM_SHARE_DIR: &str = "/usr/share/echo-agent";
const OPENCODE_CONFIG_RELATIVE_PATH: &str = "opencode/opencode.jsonc";

pub fn resolve_share_dir(share_dir: Option<&Path>) -> Result<PathBuf> {
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

pub fn resolve_opencode_bin(opencode_bin: Option<&Path>) -> PathBuf {
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

pub fn run_opencode(
    opencode_bin: &Path,
    share_dir: &Path,
    model_name: Option<&str>,
    prompt: &str,
    extra_env: Option<(String, OsString)>,
) -> Result<String> {
    let opencode_config = share_dir.join(OPENCODE_CONFIG_RELATIVE_PATH);
    let current_executable = env::current_exe()
        .context("failed to determine current executable path")?;

    let mut command = Command::new(opencode_bin);
    command
        .arg("run")
        .arg("--format")
        .arg("json")
        .arg("--dir")
        .arg(share_dir)
        .arg(prompt)
        .env("OPENCODE_CONFIG", &opencode_config)
        .env("ECHO_AGENT_SHARE_DIR", share_dir)
        .env("ECHO_AGENT_BIN", current_executable)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some((key, value)) = extra_env {
        command.env(key, value);
    }

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

    let mut text_output = String::new();
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

        push_text_from_event(&mut text_output, &event);

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

    if text_output.trim().is_empty() {
        bail!("opencode returned no text content");
    }

    Ok(text_output)
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

fn push_text_from_event(output: &mut String, event: &Value) {
    if event.get("type").and_then(Value::as_str) != Some("text") {
        return;
    }

    if event.pointer("/part/type").and_then(Value::as_str) != Some("text") {
        return;
    }

    if let Some(text) = event.pointer("/part/text").and_then(Value::as_str) {
        output.push_str(text);
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
