use super::Options;
use crate::{
    h,
    types::{Mode, ShortContext},
};
use anyhow::Context;
use serde_json::{json, Value};
use std::{
    io::{self, BufRead, Write},
    os::unix::{ffi::OsStrExt, process::CommandExt},
    path::PathBuf,
    process::{Command, Stdio},
    sync::mpsc::{self, Receiver},
};

pub(super) fn cancel_file(options: &Options) -> anyhow::Result<PathBuf> {
    let directory = options.repo.join(".dev-runtime/ai-control-panel");
    std::fs::create_dir_all(&directory).c(h!())?;
    Ok(directory.join(format!("cancel-{}", uuid::Uuid::now_v7())))
}

pub(super) fn start(
    mode: Mode,
    options: &Options,
    action: &str,
    request: Value,
) -> anyhow::Result<Receiver<Value>> {
    let script = options.repo.join("deploy/ai-control-panel/control.py");
    let executable = std::env::current_exe().c(h!())?;
    let executable = executable.as_os_str().as_bytes();
    let executable = std::ffi::OsStr::from_bytes(
        executable.strip_suffix(b" (deleted)").unwrap_or(executable),
    );
    let mut child = Command::new("python3")
        .process_group(0)
        .current_dir(&options.repo)
        .arg(script)
        .arg(action)
        .arg("--repo")
        .arg(&options.repo)
        .arg("--executable")
        .arg(executable)
        .arg("--agent-host")
        .arg(&options.agent_host)
        .arg("--mode")
        .arg(mode.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .c(h!())?;
    child
        .stdin
        .take()
        .context(h!())?
        .write_all(request.to_string().as_bytes())
        .c(h!())?;
    let stdout = child.stdout.take().context(h!())?;
    let stderr = child.stderr.take().context(h!())?;
    let (tx, rx) = mpsc::channel();
    let action = action.to_string();
    let errors = tx.clone();
    let stderr_thread = std::thread::spawn(move || {
        for line in io::BufReader::new(stderr).lines().map_while(Result::ok) {
            let _ = errors.send(json!({"message": line}));
        }
    });
    let worker_action = action.clone();
    std::thread::spawn(move || {
        let mut reported_error = false;
        for line in io::BufReader::new(stdout).lines().map_while(Result::ok) {
            let value = serde_json::from_str::<Value>(&line).unwrap_or_else(|_| {
                json!({"diagnostic": format!("Unparsed worker output: {line}")})
            });
            reported_error |= value["error"] == true;
            let _ = tx.send(value);
        }
        let status = child.wait();
        let _ = stderr_thread.join();
        match status {
            Ok(status) => {
                if !status.success() && !reported_error {
                    let _ = tx.send(json!({"message": format!("{worker_action} failed ({status})"), "error": true}));
                }
                let _ = tx.send(json!({"done": true, "action": worker_action, "success": status.success(), "exit_code": status.code()}));
            }
            Err(error) => {
                let _ = tx.send(json!({"message": format!("Could not wait for {worker_action}: {error}"), "error": true}));
                let _ = tx.send(json!({"done": true}));
            }
        }
    });
    Ok(rx)
}
