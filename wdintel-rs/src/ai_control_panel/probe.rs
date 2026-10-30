use crate::config::{
    read_config, AI_AGENT_HARNESS_RELEASE, AI_CONTROL_PANEL_LOCK_KEY,
    APP_BUILD_VERSION,
};
use crate::h;
use crate::types::{Mode, ShortContext};
use anyhow::{bail, Context};
use sea_orm::{
    ConnectionTrait, DatabaseBackend, DatabaseConnection, DatabaseTransaction,
    Statement, TransactionTrait,
};
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::os::unix::fs::MetadataExt;

const INVENTORY_SQL: &str =
    include_str!("../../../deploy/ai-control-panel/inventory.sql");

pub async fn try_lock_lifecycle(
    txn: &DatabaseTransaction,
) -> anyhow::Result<bool> {
    let row = txn
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "select pg_try_advisory_xact_lock_shared($1) as acquired",
            [AI_CONTROL_PANEL_LOCK_KEY.into()],
        ))
        .await
        .c(h!())?
        .context(h!())?;
    row.try_get("", "acquired").c(h!())
}

pub async fn lock_lifecycle(txn: &DatabaseTransaction) -> anyhow::Result<()> {
    if !try_lock_lifecycle(txn).await.c(h!())? {
        bail!("AI namespace upgrade is in progress; retry after it finishes");
    }
    Ok(())
}

async fn inventory(db: &DatabaseConnection) -> anyhow::Result<Value> {
    let row = db
        .query_one_raw(Statement::from_string(
            DatabaseBackend::Postgres,
            INVENTORY_SQL,
        ))
        .await
        .c(h!())?
        .context(h!())?;
    row.try_get("", "inventory").c(h!())
}

#[derive(serde::Serialize)]
struct RunningProcess {
    pid: u32,
    role: String,
    cwd: std::path::PathBuf,
    executable: std::path::PathBuf,
    device: u64,
    inode: u64,
    matches: bool,
}

struct RunningStatus {
    matches: bool,
    details: String,
    processes: Vec<RunningProcess>,
}

fn checkout_root(path: &std::path::Path) -> &std::path::Path {
    path.ancestors()
        .find(|path| path.join("wdintel-rs/Cargo.toml").is_file())
        .unwrap_or(path)
}

fn read_running_process(
    path: &std::path::Path,
    mode: Mode,
    cwd: &std::path::Path,
    current: &std::fs::Metadata,
) -> Option<RunningProcess> {
    let pid = path.file_name()?.to_str()?.parse().ok()?;
    let cmdline = std::fs::read(path.join("cmdline")).ok()?;
    let args: Vec<_> = cmdline.split(|byte| *byte == 0).collect();
    let role = args.iter().find(|arg| {
        [b"server".as_slice(), b"bgworker", b"report-worker"].contains(arg)
    })?;
    let mode = mode.to_string();
    let mode_flag = format!("--mode={mode}");
    if !args.contains(&mode_flag.as_bytes())
        && !args
            .windows(2)
            .any(|pair| pair == [b"--mode", mode.as_bytes()])
    {
        return None;
    }
    let executable = std::fs::read_link(path.join("exe")).ok()?;
    if !executable.to_string_lossy().contains("wdintel-rs") {
        return None;
    }
    let process_cwd = std::fs::read_link(path.join("cwd")).ok()?;
    if mode != "live" && checkout_root(&process_cwd) != checkout_root(cwd) {
        return None;
    }
    let metadata = std::fs::metadata(path.join("exe")).ok()?;
    Some(RunningProcess {
        pid,
        role: String::from_utf8_lossy(role).into_owned(),
        cwd: process_cwd,
        executable,
        device: metadata.dev(),
        inode: metadata.ino(),
        matches: metadata.dev() == current.dev()
            && metadata.ino() == current.ino(),
    })
}

fn running_executable_status(
    mode: Mode,
    proc_root: &std::path::Path,
    cwd: &std::path::Path,
) -> anyhow::Result<RunningStatus> {
    let current = std::fs::metadata(proc_root.join("self/exe")).c(h!())?;
    let mut processes = Vec::new();
    for entry in std::fs::read_dir(proc_root).c(h!())? {
        if let Some(process) =
            read_running_process(&entry.c(h!())?.path(), mode, cwd, &current)
        {
            processes.push(process);
        }
    }
    processes.sort_by_key(|process| process.pid);
    let found_server = processes.iter().any(|process| process.role == "server");
    let mismatches = processes
        .iter()
        .filter(|process| !process.matches)
        .map(|process| {
            format!(
                "{} PID {} (device {}, inode {})",
                process.role, process.pid, process.device, process.inode
            )
        })
        .collect::<Vec<_>>();
    let matches = found_server && mismatches.is_empty();
    let mut issues = Vec::new();
    if !found_server {
        issues.push(format!(
            "No Echo server found for mode {mode} in {}",
            checkout_root(cwd).display()
        ));
    }
    if !mismatches.is_empty() {
        issues.push(format!(
            "Different executable: {}; probe uses device {}, inode {}",
            mismatches.join(", "),
            current.dev(),
            current.ino()
        ));
    }
    if !matches {
        issues.push(if mode == Mode::Debug {
            "Restart the backend and workers (just dev-tmux-stop && just dev-tmux), then rescan".to_string()
        } else {
            "Start/restart Echo server and worker services with the installed build, then rescan".to_string()
        });
    }
    Ok(RunningStatus {
        matches,
        details: if matches {
            format!(
                "{} Echo processes match the probed executable",
                processes.len()
            )
        } else {
            issues.join(". ")
        },
        processes,
    })
}

fn running_status(mode: Mode) -> anyhow::Result<RunningStatus> {
    running_executable_status(
        mode,
        std::path::Path::new("/proc"),
        &std::env::current_dir().c(h!())?,
    )
    .c(h!())
}

pub async fn inspect(mode: Mode) -> anyhow::Result<Value> {
    let config = read_config(mode).c(h!())?;
    let db = crate::new_pg_pool_from_config(&config).await.c(h!())?;
    let mut result = inventory(&db).await.c(h!())?;
    result["protocol"] = json!(1);
    result["required_release"] = json!(AI_AGENT_HARNESS_RELEASE);
    result["public_host"] = json!(config.public_host);
    let running = running_status(mode).c(h!())?;
    result["running_match"] = json!(running.matches);
    result["running_details"] = json!(running.details);
    result["running_processes"] = json!(running.processes);
    result["build"] = json!(APP_BUILD_VERSION);
    Ok(result)
}

fn emit(value: Value) -> anyhow::Result<()> {
    println!("{value}");
    std::io::stdout().flush().c(h!())
}

async fn set_enabled(
    db: &DatabaseConnection,
    enabled: bool,
) -> anyhow::Result<()> {
    db.execute_raw(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "update ai_agent_settings set feature_enabled=$1, updated_at=now() where id=1",
        [enabled.into()],
    )).await.c(h!())?;
    Ok(())
}

async fn verify_maintenance_command(
    mode: Mode,
    db: &DatabaseConnection,
    before: &Value,
    command: &Value,
) -> anyhow::Result<()> {
    if command["action"] == "verify_template" {
        let template_id = before["template_id"]
            .as_str()
            .context(h!())?
            .parse()
            .c(h!())?;
        crate::ai_agent::lifecycle::preflight_template_for_db(db, template_id)
            .await
            .c(h!())?;
    } else {
        let human_id = command["human_id"]
            .as_str()
            .context(h!())?
            .parse()
            .c(h!())?;
        crate::ai_agent::lifecycle::prepare_maintenance_connection_test(
            db, human_id,
        )
        .await
        .c(h!())?;
        let env = crate::server::new_readonly_env(mode).await.c(h!())?;
        crate::ai_agent::lifecycle::test_connection(&env, human_id)
            .await
            .c(h!())?;
    }
    Ok(())
}

pub async fn maintenance(mode: Mode) -> anyhow::Result<()> {
    let config = read_config(mode).c(h!())?;
    let db = crate::new_pg_pool_from_config(&config).await.c(h!())?;
    let lease = db.begin().await.c(h!())?;
    lease
        .execute_unprepared("SET LOCAL idle_in_transaction_session_timeout = 0")
        .await
        .c(h!())?;
    let row = lease
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "select pg_try_advisory_xact_lock($1) as acquired",
            [AI_CONTROL_PANEL_LOCK_KEY.into()],
        ))
        .await
        .c(h!())?
        .context(h!())?;
    if !row.try_get::<bool>("", "acquired").c(h!())? {
        bail!("AI lifecycle is busy");
    }
    let running = running_status(mode).c(h!())?;
    if !running.matches {
        bail!("{}", running.details);
    }
    let before = inventory(&db).await.c(h!())?;
    if before["active_requests"].as_i64() != Some(0) {
        bail!("AI requests are queued or running");
    }
    let enabled = before["enabled"].as_bool().context(h!())?;
    emit(json!({"ready": true, "inventory": before, "required_release": AI_AGENT_HARNESS_RELEASE})).c(h!())?;
    let input = std::io::stdin();
    let mut disabled = false;
    for line in input.lock().lines() {
        let command: Value = serde_json::from_str(&line.c(h!())?).c(h!())?;
        match command["action"].as_str() {
            Some("ping") => {
                lease.execute_unprepared("SELECT 1").await.c(h!())?;
                emit(json!({"ok": true})).c(h!())?;
            }
            Some("begin") => {
                set_enabled(&db, false).await.c(h!())?;
                disabled = true;
                emit(json!({"ok": true})).c(h!())?;
            }
            Some("verify_template" | "verify") if disabled => {
                let response = match verify_maintenance_command(
                    mode, &db, &before, &command,
                )
                .await
                {
                    Ok(()) => json!({"ok": true}),
                    Err(error) => {
                        json!({"ok": false, "error": format!("{error:#}")})
                    }
                };
                emit(response).c(h!())?;
            }
            Some("finish") if disabled => {
                let states = command["states"].as_array().context(h!())?;
                for state in states {
                    let name = state["name"].as_str().context(h!())?;
                    let status = state["state"].as_str().context(h!())?;
                    if !["stopped", "running"].contains(&status) {
                        bail!("Invalid container state");
                    }
                    db.execute_raw(Statement::from_sql_and_values(DatabaseBackend::Postgres,
                        "update ai_agent_container set state=$1, stats=null, last_error=null, updated_at=now() where instance_name=$2",
                        [status.into(), name.into()],
                    )).await.c(h!())?;
                }
                set_enabled(
                    &db,
                    command["enabled"].as_bool().unwrap_or(enabled),
                )
                .await
                .c(h!())?;
                emit(json!({"ok": true})).c(h!())?;
                lease.commit().await.c(h!())?;
                return Ok(());
            }
            Some("abort") if !disabled => {
                emit(json!({"ok": true})).c(h!())?;
                return Ok(());
            }
            _ => bail!("Unknown maintenance command"),
        }
    }
    if disabled {
        bail!("Rollout interrupted; AI remains disabled until recovery");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn process_fixture(
        proc_root: &std::path::Path,
        pid: u32,
        role: &str,
        cwd: &std::path::Path,
        executable: &std::path::Path,
    ) {
        let directory = proc_root.join(pid.to_string());
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            directory.join("cmdline"),
            format!("wdintel-rs\0--mode=debug\0{role}\0"),
        )
        .unwrap();
        std::os::unix::fs::symlink(cwd, directory.join("cwd")).unwrap();
        std::os::unix::fs::symlink(executable, directory.join("exe")).unwrap();
    }

    #[test]
    fn checkout_process_detection_handles_crate_cwd_and_rejects_stale_workers()
    {
        let directory = tempfile::tempdir().unwrap();
        let repo = directory.path().join("echo");
        let crate_dir = repo.join("wdintel-rs");
        std::fs::create_dir_all(&crate_dir).unwrap();
        std::fs::write(crate_dir.join("Cargo.toml"), "").unwrap();
        let executable = repo.join("wdintel-rs-current");
        let previous = repo.join("wdintel-rs-previous");
        std::fs::write(&executable, "current").unwrap();
        std::fs::write(&previous, "previous").unwrap();
        let proc_root = directory.path().join("proc");
        std::fs::create_dir_all(proc_root.join("self")).unwrap();
        std::os::unix::fs::symlink(&executable, proc_root.join("self/exe"))
            .unwrap();
        process_fixture(&proc_root, 10, "server", &crate_dir, &executable);
        process_fixture(&proc_root, 20, "bgworker", &repo, &executable);
        let other_repo = directory.path().join("other");
        std::fs::create_dir_all(other_repo.join("wdintel-rs")).unwrap();
        std::fs::write(other_repo.join("wdintel-rs/Cargo.toml"), "").unwrap();
        process_fixture(&proc_root, 30, "server", &other_repo, &previous);
        let status =
            running_executable_status(Mode::Debug, &proc_root, &repo).unwrap();
        assert!(status.matches);
        assert_eq!(status.processes.len(), 2);
        process_fixture(&proc_root, 40, "report-worker", &crate_dir, &previous);
        let status =
            running_executable_status(Mode::Debug, &proc_root, &repo).unwrap();
        assert!(!status.matches);
        assert!(status.details.contains("report-worker PID 40"));
        assert!(status
            .details
            .contains("just dev-tmux-stop && just dev-tmux"));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn rollout_lease_excludes_lifecycle_until_released() {
        let db = crate::new_pg_pool_from_mode(Mode::Test).await.unwrap();
        let rollout = db.begin().await.unwrap();
        rollout
            .execute_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "select pg_advisory_xact_lock($1)",
                [AI_CONTROL_PANEL_LOCK_KEY.into()],
            ))
            .await
            .unwrap();
        let lifecycle = db.begin().await.unwrap();
        assert!(!try_lock_lifecycle(&lifecycle).await.unwrap());
        rollout.rollback().await.unwrap();
        assert!(try_lock_lifecycle(&lifecycle).await.unwrap());
        let rollout = db.begin().await.unwrap();
        let row = rollout
            .query_one_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "select pg_try_advisory_xact_lock($1) as acquired",
                [AI_CONTROL_PANEL_LOCK_KEY.into()],
            ))
            .await
            .unwrap()
            .unwrap();
        assert!(!row.try_get::<bool>("", "acquired").unwrap());
        lifecycle.rollback().await.unwrap();
        rollout.rollback().await.unwrap();
    }
}
