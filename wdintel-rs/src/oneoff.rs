use crate::error::AppError;
use crate::types::{error, info};
use crate::types::{Mode, ShortContext};
use crate::{h, new_pg_pool_from_mode};
use anyhow::{bail, Context};
use milgeo_rs::coordinates::usk2000::usk2000_to_wgs84;
use milgeo_rs::coordinates::Usk2000;
use sea_orm::{ConnectionTrait, DbBackend, Statement};
use xshell::{cmd, Shell};

pub async fn oneoff_kill_old_queries(
    mode: Mode,
    ps: &crate::OneoffKillOldQueriesPs,
) -> Result<(), AppError> {
    let db = new_pg_pool_from_mode(mode).await.c(h!())?;
    let rows = db
        .query_all_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"
SELECT pid,
       usename,
       application_name,
       client_addr::text AS client_addr,
       (clock_timestamp() - query_start)::text AS age,
       query,
       pg_cancel_backend(pid) AS cancelled
FROM pg_stat_activity
WHERE backend_type = 'client backend'
  AND state = 'active'
  AND usename = current_user
  AND pid <> pg_backend_pid()
  AND query_start < clock_timestamp() - ($1::bigint * interval '1 minute')
ORDER BY query_start
"#,
            [ps.minutes.into()],
        ))
        .await
        .context(h!())?;

    let mut cancelled_count = 0;
    for row in &rows {
        let pid: i32 = row.try_get("", "pid").context(h!())?;
        let usename: String = row.try_get("", "usename").context(h!())?;
        let application_name: String =
            row.try_get("", "application_name").context(h!())?;
        let client_addr: Option<String> =
            row.try_get("", "client_addr").context(h!())?;
        let age: String = row.try_get("", "age").context(h!())?;
        let query: String = row.try_get("", "query").context(h!())?;
        let cancelled: bool = row.try_get("", "cancelled").context(h!())?;
        cancelled_count += usize::from(cancelled);
        let query = query.split_whitespace().collect::<Vec<_>>().join(" ");
        let query: String = query
            .chars()
            .take(crate::config::ONEOFF_KILL_OLD_QUERIES_QUERY_PREVIEW_CHARS)
            .collect();
        println!(
            "pid={pid} user={usename} application={application_name:?} client={client_addr:?} age={age} cancelled={cancelled} query={query}"
        );
    }

    println!(
        "matched={} cancelled={} threshold_minutes={}",
        rows.len(),
        cancelled_count,
        ps.minutes
    );
    Ok(())
}

pub async fn oneoff_restart_echo(
    mode: Mode,
    ps: &crate::OneoffRestartEchoPs,
) -> Result<(), AppError> {
    if ps.restart_postgres.unwrap_or(false) {
        restart_process("postgresql")?;
    }
    if ps.restart_messengers.unwrap_or(false) {
        let config = crate::config::read_config(mode).c(h!())?;
        let redis = crate::new_redis(&config).await.c(h!())?;
        let db = new_pg_pool_from_mode(mode).await.c(h!())?;
        let options = crate::messenger::signal_restart::signal_worker_options(
            crate::messenger::signal_restart::RedisSignalRestartCoordinator::new(redis),
            None,
        );
        echo_im::restart_live_messengers_that_fall_behind_with_options(
            540, &db, &options,
        )
        .await
        .context(h!())?
    }
    restart_process("wdintel-rs")?;
    restart_process_if_exists("wdintel-rs-bgworker")?;

    Ok(())
}

fn nested_logging_error_level_1() -> anyhow::Result<()> {
    nested_logging_error_level_2()
        .context("level 1 context: processing logging macro test")
}

fn nested_logging_error_level_2() -> anyhow::Result<()> {
    nested_logging_error_level_3()
        .context("level 2 context: preparing nested error")
}

fn nested_logging_error_level_3() -> anyhow::Result<()> {
    nested_logging_error_level_4()
        .context("level 3 context: loading synthetic input")
}

fn nested_logging_error_level_4() -> anyhow::Result<()> {
    bail!("level 4 root cause: synthetic nested logging failure")
}

pub fn oneoff_test_logging_error_macro(_mode: Mode) -> Result<(), AppError> {
    if let Err(err) = nested_logging_error_level_1() {
        error!("nested logging macro test error: {:?}", err);
    }

    Ok(())
}

pub fn restart_process(process_name: &str) -> anyhow::Result<()> {
    let sh = Shell::new().c(h!())?;
    cmd!(sh, "sudo -S systemctl restart {process_name}")
        .run()
        .context(h!())?;
    Ok(())
}

fn restart_process_if_exists(process_name: &str) -> anyhow::Result<()> {
    let sh = Shell::new().c(h!())?;
    cmd!(
        sh,
        "bash -lc \"if systemctl cat {process_name} >/dev/null 2>&1; then sudo -S systemctl restart {process_name}; fi\""
    )
    .run()
    .context(h!())?;
    Ok(())
}

pub fn oneoff_batch_usk_to_wgs(
    _mode: Mode,
    ps: &crate::OneoffBatchUskToWgsPs,
) -> Result<(), AppError> {
    // read ps.input
    let input = std::fs::read_to_string(&ps.input)?;
    // for file containing lines like this:
    // 5262996;7277848
    // convert them into Vec<Usk2000>
    let mut usk2000s = vec![];
    for line in input.lines() {
        let mut parts = line.split(';');
        let Ok(x) = parts.next().ok_or("No x")?.parse::<i64>() else {
            continue;
        };
        let Ok(y) = parts.next().ok_or("No y")?.parse::<i64>() else {
            continue;
        };
        usk2000s.push(Usk2000 { x, y });
    }
    println!("> found {} points", usk2000s.len());
    // convert Vec<Usk2000> into Vec<Wgs84> and write to output as a csv format
    let mut wgs84s = vec![];
    for usk2000 in usk2000s {
        let wgs84 = usk2000_to_wgs84(usk2000)?;
        wgs84s.push(wgs84);
    }
    println!("> converted to wgs84");
    let output = format!("{}-wgs84.csv", ps.input);
    let mut wtr = csv::Writer::from_path(&output).c(h!())?;
    for wgs84 in wgs84s {
        wtr.serialize(wgs84).c(h!())?;
    }
    wtr.flush().c(h!())?;
    println!("> written to {output}");
    Ok(())
}

pub async fn oneoff_fix_areas_of_responsibility(
    mode: Mode,
    force_all_networks: bool,
) -> Result<(), AppError> {
    info!("starting oneoff_fix_areas_of_responsibility...");
    let config = crate::config::read_config(mode)?;
    let db = crate::new_pg_pool_from_config(&config).await?;
    // Step 1: ensure each datasource has default_aor_id set
    crate::datasource::fix_datasource_default_aor(&db).await?;
    crate::messenger::group::fix_group_areas_of_responsibility(&db).await?;
    crate::sigint::network::fix_network_areas_of_responsibility(
        &db,
        force_all_networks,
    )
    .await?;
    crate::organism::oneoff::oneoff_fix_organism_aors(&db).await?;
    info!("done oneoff_fix_areas_of_responsibility");
    Ok(())
}
