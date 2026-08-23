use crate::battle_line::{
    activate_battle_line_import, prepare_battle_line_import,
    BattleLineImportOutcome, BattleLineImportSource,
};
use crate::config::{
    get_enemy_units_kml_path, mk_s3, mk_s3_config, read_config, Config,
    BATTLE_LINE_DELTA_KML_SOURCE_PREFIX,
};
use crate::entities::{enemy_units_geojson, sea_orm_active_enums};
use crate::h;
use crate::types::{AppError, Mode, ShortContext};
use crate::OneoffImportBattleLineFromDeltaKmlPs;
use crate::{new_pg_pool_from_config, storage};
use anyhow::Context;
use log::warn;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use tokio::fs;

pub async fn oneoff_import_battle_line_from_delta_kml(
    mode: Mode,
    ps: &OneoffImportBattleLineFromDeltaKmlPs,
) -> Result<(), AppError> {
    let config = read_config(mode).c(h!())?;
    let dbx = new_pg_pool_from_config(&config).await.c(h!())?;
    let delta_kml = enemy_units_geojson::Entity::find_by_id(ps.source_id)
        .filter(
            enemy_units_geojson::Column::Status
                .eq(sea_orm_active_enums::StatusEnum::Success),
        )
        .one(&dbx)
        .await
        .c(h!())?
        .with_context(|| {
            format!(
                "Successful enemy_units_geojson row {} does not exist",
                ps.source_id
            )
        })
        .c(h!())?;
    let data = load_delta_kml(&config, &delta_kml).await.c(h!())?;
    let source_file_name = format!("enemy-units-{}.kml", delta_kml.id);
    let prepared = prepare_battle_line_import(&source_file_name, &data)
        .await
        .c(h!())?;
    print_import_summary(delta_kml.id, &prepared);
    if ps.dry_run {
        println!("Dry run completed; Battle Line was not changed");
        return Ok(());
    }

    let source_identifier =
        format!("{BATTLE_LINE_DELTA_KML_SOURCE_PREFIX}{}", delta_kml.id);
    let outcome = activate_battle_line_import(
        &dbx,
        &prepared,
        delta_kml.created_by_login_id,
        &BattleLineImportSource::delta_kml(source_identifier),
        ps.force,
    )
    .await
    .c(h!())?;
    match outcome {
        BattleLineImportOutcome::Imported(version_id) => {
            println!("Imported Battle Line version {version_id}");
        }
        BattleLineImportOutcome::AlreadyImported(version_id) => {
            println!(
                "Delta KML was already imported as Battle Line version {version_id}; no changes made"
            );
        }
        BattleLineImportOutcome::RequiresForce(version_id) => {
            warn!(
                "Battle Line import was skipped because active version {version_id} already exists; try again with the '--force' flag to import Delta KML as a new version"
            );
        }
    }
    Ok(())
}

async fn load_delta_kml(
    config: &Config,
    delta_kml: &enemy_units_geojson::Model,
) -> anyhow::Result<Vec<u8>> {
    let Some(kml_key) = delta_kml.kml_s3_id.as_deref() else {
        let path = get_enemy_units_kml_path(config, delta_kml.id);
        return fs::read(&path)
            .await
            .with_context(|| format!("Failed to read {}", path.display()))
            .c(h!());
    };
    let s3 = mk_s3(config).c(h!())?;
    let s3_config = mk_s3_config(config).c(h!())?;
    let strongbox_key = config
        .s3_config
        .as_ref()
        .context("S3 is not configured")
        .c(h!())?
        .strongbox_key
        .clone();
    storage::download_and_decrypt_from_s3_with_operator(
        &s3,
        &s3_config,
        &strongbox_key,
        kml_key,
    )
    .await
    .c(h!())
}

fn print_import_summary(
    source_id: i32,
    prepared: &crate::battle_line::PreparedBattleLineImport,
) {
    let source_summary = &prepared.source_summary;
    let summary = &prepared.summary;
    println!("Delta KML source row: {source_id}");
    println!("Source SHA-256: {}", prepared.source_sha256);
    println!(
        "Source features: {} points, {} line strings, {} coordinates",
        source_summary.point_count,
        source_summary.line_string_count,
        source_summary.coordinate_count
    );
    println!(
        "Cleaned features: {} points, {} line strings, {} coordinates",
        summary.point_count,
        summary.line_string_count,
        summary.coordinate_count
    );
    println!(
        "Cleanup removed {} points, {} short line strings (including zero-length), and {} duplicate segments; minimum retained line length: {:.1} m",
        prepared.cleanup_stats.removed_point_count,
        prepared.cleanup_stats.removed_short_line_string_count,
        prepared.cleanup_stats.removed_duplicate_segment_count,
        prepared.cleanup_stats.minimum_line_length_m
    );
    println!(
        "Zero-length line strings in source geometry: {}",
        source_summary.zero_length_line_string_count
    );
    println!(
        "Empty geometry placeholders excluded: {} points, {} line strings",
        source_summary.empty_point_count,
        source_summary.empty_line_string_count
    );
    println!(
        "Cleaned bounds: lat {}..{}, lon {}..{}",
        summary.bounds.min_lat,
        summary.bounds.max_lat,
        summary.bounds.min_lon,
        summary.bounds.max_lon
    );
}
