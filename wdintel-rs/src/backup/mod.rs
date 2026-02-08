use crate::config::Config;
use crate::error::AppError;
use crate::types::*;
use log::*;
use regex::Regex;
use std::fs;
use std::path::{Path, PathBuf};
use xshell::{cmd, Shell};

async fn sleep_before_backup(config: &Config, nowait: bool) {
    if nowait {
        return;
    }
    if let Some(sleep_before_backup_mins) = config.sleep_before_backup_mins {
        if sleep_before_backup_mins > 0 {
            info!(
                "sleeping for {sleep_before_backup_mins} minutes before backup"
            );
            tokio::time::sleep(tokio::time::Duration::from_secs(
                sleep_before_backup_mins * 60,
            ))
            .await;
        }
    }
}

fn pgbackrest_conf_path() -> &'static str {
    crate::config::PGBACKREST_CONF_PATH
}

fn pgbackrest_conf_include_dir() -> &'static str {
    crate::config::PGBACKREST_CONF_INCLUDE_DIR
}

fn detect_stanza_conf_files(dir: &Path) -> anyhow::Result<Vec<PathBuf>> {
    let mut files = vec![];
    let entries = fs::read_dir(dir).c(h!())?;
    for entry in entries {
        let entry = entry.c(h!())?;
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if name.starts_with(crate::config::PGBACKREST_STANZA_CONF_PREFIX)
            && name.ends_with(crate::config::PGBACKREST_STANZA_CONF_SUFFIX)
        {
            files.push(path);
        }
    }
    files.sort();
    Ok(files)
}

fn detect_stanza_conf_file() -> anyhow::Result<PathBuf> {
    let dir = Path::new(pgbackrest_conf_include_dir());
    if !dir.is_dir() {
        bail!(
            "pgBackRest include dir missing: {}",
            pgbackrest_conf_include_dir()
        );
    }
    let files = detect_stanza_conf_files(dir)?;
    match files.len() {
        0 => bail!(
            "no stanza config found in {} (expected {}*{})",
            pgbackrest_conf_include_dir(),
            crate::config::PGBACKREST_STANZA_CONF_PREFIX,
            crate::config::PGBACKREST_STANZA_CONF_SUFFIX
        ),
        1 => Ok(files[0].clone()),
        _ => bail!(
            "multiple stanza configs found in {}: {:?}",
            pgbackrest_conf_include_dir(),
            files
        ),
    }
}

fn parse_stanza_name(conf_file: &Path) -> anyhow::Result<String> {
    let content = fs::read_to_string(conf_file).c(h!())?;
    let re =
        Regex::new(r"(?m)^[[:space:]]*\[([^\]]+)\][[:space:]]*$").c(h!())?;
    for caps in re.captures_iter(&content) {
        let Some(name) = caps.get(1).map(|m| m.as_str().trim()) else {
            continue;
        };
        if name == "global" || name.starts_with("global:") {
            continue;
        }
        if !name.is_empty() {
            return Ok(name.to_string());
        }
    }
    bail!("failed to detect stanza from {}", conf_file.display())
}

fn detect_pgbackrest_stanza() -> anyhow::Result<String> {
    let conf = Path::new(pgbackrest_conf_path());
    if !conf.is_file() {
        bail!(
            "pgBackRest config missing: {} (run setup-pgbackrest)",
            pgbackrest_conf_path()
        );
    }
    let conf_file = detect_stanza_conf_file()?;
    parse_stanza_name(&conf_file)
}

fn run_pgbackrest_backup(stanza: &str) -> anyhow::Result<()> {
    let sh = Shell::new().c(h!())?;
    let conf = pgbackrest_conf_path();
    let include = pgbackrest_conf_include_dir();

    // Cron runs as root; use postgres for correct perms and config expectations.
    cmd!(
        sh,
        "sudo -n -u postgres pgbackrest --config={conf} --config-include-path={include} --stanza={stanza} --log-level-console=info backup"
    )
    .run()
    .c(h!())?;
    Ok(())
}

pub async fn backup(mode: Mode, nowait: bool) -> Result<(), AppError> {
    let config = crate::config::read_config(mode)?;
    sleep_before_backup(&config, nowait).await;

    // Only launch this command for tailscale domains (our server deployments).
    if !config.public_host.ends_with(".ts.net") {
        return Ok(());
    }

    info!("starting pgBackRest backup");
    let stanza = detect_pgbackrest_stanza().c(h!())?;
    info!("pgBackRest stanza: {stanza}");
    run_pgbackrest_backup(&stanza).c(h!())?;
    info!("pgBackRest backup done");
    Ok(())
}
