use crate::config::read_config;
use crate::types::*;

pub async fn oneoff_create_database(mode: Mode) -> Result<(), AppError> {
    let config = read_config(mode).c(h!())?;
    let file_registry_config =
        config
            .file_registry
            .as_ref()
            .ok_or_else(|| AppError::BL {
                msg: "The [file_registry] section is missing from the Echo configuration. Add pg_host, pg_port, pg_user, pg_password, and pg_dbname under [file_registry], then rerun this command.".to_string(),
            })?;
    let (host, port, user, password, database) =
        crate::wdfile_connection_parts(file_registry_config, mode);

    let mut connection_config = tokio_postgres::Config::new();
    connection_config
        .host(&host)
        .port(port)
        .user(&user)
        .password(password)
        .dbname("postgres");

    let (client, connection) = connection_config
        .connect(tokio_postgres::NoTls)
        .await
        .c(h!())?;
    let _connection_task = tokio::spawn(async move {
        if let Err(error) = connection.await {
            error!("file registry provisioning connection failed: {error}");
        }
    });

    let exists = client
        .query_opt("select 1 from pg_database where datname = $1", &[&database])
        .await
        .c(h!())?
        .is_some();
    if exists {
        println!("File database \"{database}\" already exists.");
        return Ok(());
    }

    let quoted_database: String = client
        .query_one("select quote_ident($1)", &[&database])
        .await
        .c(h!())?
        .try_get(0)
        .c(h!())?;
    match client
        .batch_execute(&format!("create database {quoted_database}"))
        .await
    {
        Ok(()) => {
            println!("File database \"{database}\" created.");
            Ok(())
        }
        Err(error) if error.code().is_some_and(|code| code.code() == "42P04") => {
            println!("File database \"{database}\" already exists.");
            Ok(())
        }
        Err(error) if error.code().is_some_and(|code| code.code() == "42501") => {
            Err(AppError::BL {
                msg: format!(
                    "File database \"{database}\" was not created: PostgreSQL user \"{user}\" needs CREATEDB. Grant it or create the database manually, then restart the backend."
                ),
            })
        }
        Err(error) => Err(AppError::AnyhowError {
            source: error.into(),
        }),
    }
}
