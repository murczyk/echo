use crate::error::AppError;
use crate::h;
use crate::types::Mode;
use anyhow::Context;
use log::info;
use milgeo_rs::coordinates::usk2000::usk2000_to_wgs84;
use milgeo_rs::coordinates::Usk2000;

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
    let mut wtr = csv::Writer::from_path(&output)?;
    for wgs84 in wgs84s {
        wtr.serialize(wgs84)?;
    }
    wtr.flush()?;
    println!("> written to {output}");
    Ok(())
}

pub async fn oneoff_fix_areas_of_responsibility(
    mode: Mode,
    force_all_networks: bool,
) -> Result<(), AppError> {
    info!("starting oneoff_fix_areas_of_responsibility...");
    let config = crate::config::read_config(mode).context(h!())?;
    let db = crate::new_pg_pool_from_config(&config)
        .await
        .context(h!())?;
    // Step 1: ensure each datasource has default_aor_id set
    crate::datasource::fix_datasource_default_aor(&db)
        .await
        .context(h!())?;
    crate::messenger::group::fix_group_areas_of_responsibility(&db)
        .await
        .context(h!())?;
    crate::sigint::network::fix_network_areas_of_responsibility(
        &db,
        force_all_networks,
    )
    .await
    .context(h!())?;
    crate::organism::oneoff::oneoff_fix_organism_aors(&db)
        .await
        .context(h!())?;
    info!("done oneoff_fix_areas_of_responsibility");
    Ok(())
}
