use crate::config::read_config;
use crate::types::*;
use sea_orm::{ConnectionTrait, DatabaseConnection};
use sea_orm_migration::MigratorTrait;
use std::{fs, path::Path};
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
    require_current_analytics_exclusions(mode).context(h!())?;
    println!("Running migration");
    let dbx = crate::new_pg_pool_from_mode(mode).await.context(h!())?;

    echo_im::run_migration(&dbx).await.context(h!())?;
    ensure_echo_gpu_uuid_v7_generator(&dbx)
        .await
        .context(h!())?;
    echo_gpu_client::run_migration(&dbx).await.context(h!())?;
    echo_migration::Migrator::up(&dbx, None)
        .await
        .context(h!())?;
    println!("Running migration: done");
    Ok(())
}

fn require_current_analytics_exclusions(mode: Mode) -> anyhow::Result<()> {
    if mode != Mode::Live {
        read_analytics_exclusions(
            crate::config::ANALYTICS_LOCAL_EXCLUSIONS_PATH,
        )?;
        return Ok(());
    }

    if !Path::new(crate::config::ANALYTICS_SOURCE_CONFIG_PATH).exists() {
        return Ok(());
    }

    let installed = read_analytics_exclusions(
        crate::config::ANALYTICS_SOURCE_EXCLUSIONS_PATH,
    )?;
    let packaged = read_analytics_exclusions(
        crate::config::ANALYTICS_PACKAGED_EXCLUSIONS_PATH,
    )?;
    if installed == packaged {
        return Ok(());
    }

    let missing = packaged
        .difference(&installed)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    let unexpected = installed
        .difference(&packaged)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    bail!(
        "analytics table exclusions are stale; run \
         /opt/echo-peerdb/bin/source-sync-exclusions-if-needed.sh --yes \
         before migrations (missing: [{}]; unexpected: [{}])",
        missing,
        unexpected
    )
}

fn read_analytics_exclusions(path: &str) -> anyhow::Result<BTreeSet<String>> {
    let contents = fs::read_to_string(path).with_context(|| {
        format!("failed to read analytics exclusions from {path}")
    })?;
    parse_analytics_exclusions(&contents, path)
}

fn parse_analytics_exclusions(
    contents: &str,
    path: &str,
) -> anyhow::Result<BTreeSet<String>> {
    let mut exclusions = BTreeSet::new();
    for (index, line) in contents.lines().enumerate() {
        let table = line.split('#').next().unwrap_or_default().trim();
        if table.is_empty() {
            continue;
        }
        let Some((schema, relation)) = table.split_once('.') else {
            bail!("invalid analytics exclusion at {path}:{}", index + 1);
        };
        if !is_unquoted_identifier(schema) || !is_unquoted_identifier(relation)
        {
            bail!("invalid analytics exclusion at {path}:{}", index + 1);
        }
        exclusions.insert(table.to_owned());
    }
    Ok(exclusions)
}

fn is_unquoted_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    matches!(chars.next(), Some('a'..='z' | '_'))
        && chars
            .all(|character| matches!(character, 'a'..='z' | '0'..='9' | '_'))
}

async fn ensure_echo_gpu_uuid_v7_generator(
    dbx: &DatabaseConnection,
) -> Result<(), AppError> {
    dbx.execute_unprepared(
        r#"
do $$
begin
    if to_regprocedure('uuid_generate_v7()') is null then
        if to_regprocedure('uuidv7()') is not null then
            execute 'create function uuid_generate_v7() returns uuid language sql volatile parallel safe as ''select pg_catalog.uuidv7()''';
        else
            create extension if not exists pg_uuidv7;
        end if;
    end if;
end
$$;
"#,
    )
    .await
    .context(h!())?;
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

#[cfg(test)]
mod tests {
    use super::parse_analytics_exclusions;
    use std::collections::BTreeSet;

    #[test]
    fn analytics_exclusions_ignore_comments_order_and_duplicates() {
        let exclusions = parse_analytics_exclusions(
            "# comment\n public.second # inline\npublic.first\npublic.second\n",
            "test",
        )
        .unwrap();

        assert_eq!(
            exclusions,
            BTreeSet::from([
                "public.first".to_owned(),
                "public.second".to_owned()
            ])
        );
    }

    #[test]
    fn analytics_exclusions_reject_quoted_or_unqualified_names() {
        assert!(parse_analytics_exclusions("public_table", "test").is_err());
        assert!(parse_analytics_exclusions("public.MixedCase", "test").is_err());
    }
}
