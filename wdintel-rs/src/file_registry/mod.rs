use crate::config::*;
use crate::types::*;
use sea_orm::{ConnectionTrait, DatabaseConnection, DbErr};
use sea_orm_migration::MigratorTrait;
use std::error::Error as StdError;

pub mod entities;
pub mod provisioning;

#[cfg(test)]
mod tests;

#[derive(Clone)]
pub struct FileRegistryDb {
    connection: DatabaseConnection,
}

impl FileRegistryDb {
    pub(crate) fn connection(&self) -> &DatabaseConnection {
        &self.connection
    }
}

pub async fn connect_runtime(
    config: &Config,
    mode: Mode,
) -> Result<FileRegistryDb, AppError> {
    let connection = crate::new_pg_pool_from_conn_string_with_max_connections(
        crate::mk_wdfile_conn_string(config, mode),
        PG_WDFILE_POOL_MAX_CONNECTIONS,
    )
    .await
    .map_err(|error| map_connection_error(error, config, mode))?;
    connection
        .execute_unprepared("select 1")
        .await
        .map_err(|error| map_connection_error(error, config, mode))?;

    Ok(FileRegistryDb { connection })
}

pub async fn run_migrations(
    config: &Config,
    mode: Mode,
) -> Result<(), AppError> {
    let connection = crate::new_pg_pool_from_conn_string_with_max_connections(
        crate::mk_wdfile_conn_string(config, mode),
        PG_WDFILE_MIGRATION_POOL_MAX_CONNECTIONS,
    )
    .await
    .map_err(|error| map_connection_error(error, config, mode))?;
    let migration_result =
        wdfiles_migration::Migrator::up(&connection, None).await;
    let close_result = connection.close().await;

    migration_result
        .map_err(|error| map_connection_error(error, config, mode))?;
    close_result.map_err(|error| map_connection_error(error, config, mode))?;
    Ok(())
}

fn map_connection_error(error: DbErr, config: &Config, mode: Mode) -> AppError {
    if has_postgres_error_code(&error, "3D000") {
        let (_, _, _, _, database) =
            crate::wdfile_connection_parts(config, mode);
        let source: anyhow::Error = error.into();
        return AppError::AnyhowError {
            source: source.context(format!(
                "File database \"{database}\" does not exist. Create it with `just create-file-registry-database --mode={mode}`, then restart the backend."
            )),
        };
    }

    let source: anyhow::Error = error.into();
    AppError::AnyhowError {
        source: source.context(h!()),
    }
}

fn has_postgres_error_code(
    error: &(dyn StdError + 'static),
    code: &str,
) -> bool {
    let mut source = Some(error);
    while let Some(error) = source {
        if let Some(sqlx::Error::Database(database_error)) =
            error.downcast_ref::<sqlx::Error>()
        {
            if database_error.code().as_deref() == Some(code) {
                return true;
            }
        }
        source = error.source();
    }
    false
}
