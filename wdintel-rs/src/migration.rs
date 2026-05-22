use crate::config::read_config;
use crate::types::*;
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
    echo_migration::Migrator::up(&dbx, None)
        .await
        .context(h!())?;
    println!("Running migration: done");
    Ok(())
}
