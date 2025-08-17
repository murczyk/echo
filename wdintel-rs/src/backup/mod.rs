use crate::error::AppError;
use crate::types::*;
use chrono::prelude::*;
use log::*;
use xshell::{cmd, Shell};

pub async fn backup(mode: Mode) -> Result<(), AppError> {
    let config = crate::config::read_config(mode)?;
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
    // only launch this command for tailscale domains
    if !config.public_host.ends_with(".ts.net") {
        return Ok(());
    }
    info!("starting backup");
    let sh = Shell::new()?;
    let pgpwd = crate::config::DEFAULT_PG_PASSWORD.to_string();
    let server = config.public_host;
    let now = Utc::now();
    let day_s = now.format("%Y-%m-%d").to_string();
    let dt1 = now.format("%Y-%m-%d-%H-%M-%S").to_string();
    let Some(backup_key_id) = config.backup_key_id else {
        return Ok(());
    };
    let Some(backup_key) = config.backup_key else {
        return Ok(());
    };
    info!("> postgresql backup begin");
    cmd!(sh, "mkdir -p /tmp2/backup").run()?;
    cmd!(
        sh,
        "pg_dump --user wd -Fc wd --file wd-{server}-{dt1}.pgrestore"
    )
    .env("PGPASSWORD", pgpwd)
    .run()?;
    cmd!(sh, "ls -lah wd-{server}-{dt1}.pgrestore").run()?;
    cmd!(
        sh,
        "gpg --encrypt --recipient 'Echo' wd-{server}-{dt1}.pgrestore"
    )
    .run()?;
    cmd!(sh, "ls -lah wd-{server}-{dt1}.pgrestore.gpg").run()?;
    cmd!(sh, "b2 upload-file echouabackup ./wd-{server}-{dt1}.pgrestore.gpg backup/echo/{day_s}/wd-{server}-{dt1}.pgrestore.gpg")
        .env("B2_APPLICATION_KEY_ID", backup_key_id.clone())
        .env("B2_APPLICATION_KEY", backup_key.clone())
        .run()?;
    cmd!(sh, "rm wd-{server}-{dt1}.pgrestore.gpg").run()?;
    cmd!(sh, "rm wd-{server}-{dt1}.pgrestore").run()?;
    info!("postgresql backup done");
    Ok(())
}

#[allow(dead_code)]
pub async fn backup_to_b2(mode: Mode) -> Result<(), AppError> {
    let config = crate::config::read_config(mode)?;
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
    // only launch this command for tailscale domains
    if !config.public_host.ends_with(".ts.net") {
        return Ok(());
    }
    info!("starting backup");
    let sh = Shell::new()?;
    let pgpwd = crate::config::DEFAULT_PG_PASSWORD.to_string();
    let server = config.public_host;
    let now = Utc::now();
    let day_s = now.format("%Y-%m-%d").to_string();
    let dt1 = now.format("%Y-%m-%d-%H-%M-%S").to_string();
    let Some(backup_key_id) = config.backup_key_id else {
        return Ok(());
    };
    let Some(backup_key) = config.backup_key else {
        return Ok(());
    };
    info!("> postgresql backup begin");
    cmd!(sh, "mkdir -p /tmp2/backup").run()?;
    cmd!(
        sh,
        "pg_dump --user wd -Fc wd --file wd-{server}-{dt1}.pgrestore"
    )
    .env("PGPASSWORD", pgpwd)
    .run()?;
    cmd!(sh, "ls -lah wd-{server}-{dt1}.pgrestore").run()?;
    cmd!(
        sh,
        "gpg --encrypt --recipient 'Echo' wd-{server}-{dt1}.pgrestore"
    )
    .run()?;
    cmd!(sh, "ls -lah wd-{server}-{dt1}.pgrestore.gpg").run()?;
    cmd!(sh, "b2 upload-file echouabackup ./wd-{server}-{dt1}.pgrestore.gpg backup/echo/{day_s}/wd-{server}-{dt1}.pgrestore.gpg")
        .env("B2_APPLICATION_KEY_ID", backup_key_id.clone())
        .env("B2_APPLICATION_KEY", backup_key.clone())
        .run()?;
    cmd!(sh, "rm wd-{server}-{dt1}.pgrestore.gpg").run()?;
    cmd!(sh, "rm wd-{server}-{dt1}.pgrestore").run()?;
    info!("postgresql backup done");
    Ok(())
}
