use crate::error::AppError;
use crate::types::{Mode, ShortContext};
use crate::{h, new_pg_pool_from_mode};
use anyhow::Context;
use log::info;
use milgeo_rs::coordinates::usk2000::usk2000_to_wgs84;
use milgeo_rs::coordinates::Usk2000;
use xshell::{cmd, Shell};

pub async fn oneoff_restart_echo(
    mode: Mode,
    ps: &crate::OneoffRestartEchoPs,
) -> Result<(), AppError> {
    if ps.restart_postgres.unwrap_or(false) {
        restart_process("postgresql")?;
    }
    if ps.restart_messengers.unwrap_or(false) {
        let db = new_pg_pool_from_mode(mode).await.c(h!())?;
        echo_im::restart_live_messengers_that_fall_behind(540, &db)
            .await
            .context(h!())?
    }
    restart_process("wdintel-rs")?;
    restart_process_if_exists("wdintel-rs-bgworker")?;

    Ok(())
}

fn restart_process(process_name: &str) -> anyhow::Result<()> {
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
