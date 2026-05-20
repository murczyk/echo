use crate::config::read_config;
use crate::types::*;
use sea_orm::ConnectionTrait;
use sea_orm_migration::MigratorTrait;
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
    if let Err(error) = echo_migration::Migrator::up(&dbx, None).await {
        let error_msg = format!("{error:?}");
        if let Some(version) = missing_migration_version(&error_msg) {
            warn!("repairing missing migration history entry for {version}");
            dbx.execute_unprepared(&format!(
                "delete from seaql_migrations where version = '{version}'"
            ))
            .await
            .context(h!())?;
            echo_migration::Migrator::up(&dbx, None)
                .await
                .context(h!())?;
        } else {
            let error: anyhow::Error = error.into();
            return Err(error.c(h!()));
        }
    }
    println!("Running migration: done");
    Ok(())
}

fn missing_migration_version(error_msg: &str) -> Option<String> {
    let needle = "Migration file of version '";
    let start = error_msg.find(needle)? + needle.len();
    let rest = &error_msg[start..];
    let end = rest.find('\'')?;
    Some(rest[..end].to_string())
}
