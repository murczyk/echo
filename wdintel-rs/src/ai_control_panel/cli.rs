use super::{session_log::SessionLog, worker, Action, Options};
use crate::{
    h,
    types::{Mode, ShortContext},
};
use anyhow::bail;
use serde_json::{json, Value};
use std::{sync::mpsc::TryRecvError, time::Duration};

pub(super) async fn run(
    mode: Mode,
    mut options: Options,
) -> anyhow::Result<()> {
    options.repo = options.repo.canonicalize().c(h!())?;
    let (action, release, reconcile_orphans, dry_run, json_output) =
        match &options.action {
            Some(Action::Scan { json }) => ("scan", "", false, false, *json),
            Some(Action::Upgrade {
                release,
                reconcile_orphans,
                dry_run,
            }) => (
                "upgrade",
                release.as_str(),
                *reconcile_orphans,
                *dry_run,
                false,
            ),
            Some(Action::Recover) => ("recover", "", false, false, false),
            None => unreachable!(),
        };
    if action != "scan" && options.host.is_empty() {
        bail!("Specify --host for each rollout target");
    }
    if action == "recover" && options.host.len() != 1 {
        bail!("Recovery requires exactly one --host");
    }
    let mut log = SessionLog::new().c(h!())?;
    eprintln!("AI control panel log: {}", log.path.display());
    let cancel_file = worker::cancel_file(&options).c(h!())?;
    let request = json!({"hosts": options.host, "selected": options.host, "release": release,
        "reconcile_orphans": reconcile_orphans, "dry_run": dry_run, "cancel_file": cancel_file});
    let events = worker::start(mode, &options, action, request).c(h!())?;
    let interrupt = tokio::signal::ctrl_c();
    tokio::pin!(interrupt);
    let mut interrupted = false;
    let mut failed = false;
    loop {
        match events.try_recv() {
            Ok(event) => {
                log.write(&event.to_string()).c(h!())?;
                failed |= event["error"] == true;
                print_event(&event, json_output, reconcile_orphans, release);
                if event["done"] == true {
                    let _ = std::fs::remove_file(&cancel_file);
                    if failed || event["success"] != true || interrupted {
                        bail!(
                            "{action} failed or was cancelled; see {}",
                            log.path.display()
                        );
                    }
                    return Ok(());
                }
            }
            Err(TryRecvError::Disconnected) => {
                bail!("Rollout worker disconnected")
            }
            Err(TryRecvError::Empty) => {
                tokio::select! {
                    result = &mut interrupt, if !interrupted => {
                        result.c(h!())?;
                        std::fs::write(&cancel_file, b"cancel").c(h!())?;
                        interrupted = true;
                        eprintln!("Cancellation requested; waiting for a safe boundary.");
                    }
                    _ = tokio::time::sleep(Duration::from_millis(crate::config::AI_CONTROL_PANEL_POLL_MS)) => {}
                }
            }
        }
    }
}

fn print_event(
    event: &Value,
    json_output: bool,
    reconcile_orphans: bool,
    target: &str,
) {
    if json_output {
        println!("{event}");
    } else if let Some(message) = event["message"].as_str() {
        println!("{message}");
    } else if let Some(hosts) = event["hosts"].as_array() {
        if let Some(releases) = event["releases"].as_array() {
            for release in releases {
                println!(
                    "Harness {}: {}",
                    release["release"].as_str().unwrap_or("?"),
                    release["availability"].as_str().unwrap_or("?")
                );
            }
        }
        let eligibility = if reconcile_orphans {
            "eligibility_reconciled"
        } else {
            "eligibility"
        };
        for host in hosts {
            let target = if target.is_empty() {
                host["required_release"]
                    .as_str()
                    .or_else(|| event["releases"][0]["release"].as_str())
                    .unwrap_or("")
            } else {
                target
            };
            println!(
                "{} | {} | {} | {} | requires {} | target {}: {}",
                host["host"].as_str().unwrap_or("?"),
                host["agent_host"].as_str().unwrap_or("agent host unknown"),
                host["namespace"].as_str().unwrap_or("?"),
                host["deployed"].as_str().unwrap_or("?"),
                host["required_release"].as_str().unwrap_or("unknown"),
                target,
                host[eligibility][target]
                    .as_str()
                    .or_else(|| host["routing_error"].as_str())
                    .unwrap_or("Unknown compatibility")
            );
        }
    }
}
