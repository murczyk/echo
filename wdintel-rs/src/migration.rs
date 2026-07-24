use crate::config::read_config;
use crate::types::*;
use sea_orm_migration::MigratorTrait;
use std::path::Path;
use tokio::process::Command;
// use std::env;

pub async fn run_migration(mode: Mode) -> Result<(), AppError> {
    run_migration_1(mode).await.context(h!())?;
    Ok(())
}

pub async fn run_migration_1(mode: Mode) -> Result<(), AppError> {
    let config = read_config(mode).context(h!())?;
    if config.is_slave.unwrap_or(false) {
        warn!("skipping DB migrations, running in slave mode");
        return Ok(());
    }
    println!("Running migration");
    let dbx = crate::new_pg_pool_from_mode(mode).await.context(h!())?;

    echo_im::run_migration(&dbx).await.context(h!())?;
    echo_gpu_client::run_migration(&dbx).await.context(h!())?;
    echo_migration::Migrator::up(&dbx, None)
        .await
        .context(h!())?;
    println!("Running migration: done");
    Ok(())
}

pub async fn request_analytics_table_reconciliation() {
    if !Path::new(crate::config::ANALYTICS_SOURCE_CONFIG_PATH).exists() {
        return;
    }

    match Command::new("sudo")
        .args([
            "-n",
            "systemctl",
            "start",
            "--no-block",
            crate::config::ANALYTICS_TABLE_RECONCILE_SERVICE,
        ])
        .output()
        .await
    {
        Ok(output) if output.status.success() => {
            debug!("requested analytics table reconciliation");
        }
        Ok(output) => {
            warn!(
                "could not request analytics table reconciliation: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Err(error) => {
            warn!("could not request analytics table reconciliation: {error}");
        }
    }
}
