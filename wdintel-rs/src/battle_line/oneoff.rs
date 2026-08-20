use crate::battle_line::{
    activate_battle_line_import, prepare_battle_line_import,
    BattleLineImportOutcome, BattleLineImportSource,
};
use crate::config::{
    mk_s3, mk_s3_config, read_config, BATTLE_LINE_DELTA_KML_SOURCE_PREFIX,
};
use crate::entities::{enemy_units_geojson, sea_orm_active_enums};
use crate::h;
use crate::types::{AppError, Mode, ShortContext};
use crate::OneoffImportBattleLineFromDeltaKmlPs;
use crate::{new_pg_pool_from_config, storage};
use anyhow::Context;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};

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
    let kml_key = delta_kml.kml_s3_id.as_deref().with_context(|| {
        format!(
            "enemy_units_geojson row {} has no KML object key",
            delta_kml.id
        )
    })?;
    let s3 = mk_s3(&config).c(h!())?;
    let s3_config = mk_s3_config(&config).c(h!())?;
    let strongbox_key = config
        .s3_config
        .as_ref()
        .context("S3 is not configured")
        .c(h!())?
        .strongbox_key
        .clone();
    let data = storage::download_and_decrypt_from_s3_with_operator(
        &s3,
        &s3_config,
        &strongbox_key,
        kml_key,
    )
    .await
    .c(h!())?;
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
    }
    Ok(())
}

fn print_import_summary(
    source_id: i32,
    prepared: &crate::battle_line::PreparedBattleLineImport,
) {
    let summary = &prepared.summary;
    println!("Delta KML source row: {source_id}");
    println!("Source SHA-256: {}", prepared.source_sha256);
    println!(
        "Features: {} points, {} line strings, {} coordinates",
        summary.point_count,
        summary.line_string_count,
        summary.coordinate_count
    );
    println!(
        "Zero-length line strings excluded from stored geometry: {}",
        summary.zero_length_line_string_count
    );
    println!(
        "Bounds: lat {}..{}, lon {}..{}",
        summary.bounds.min_lat,
        summary.bounds.max_lat,
        summary.bounds.min_lon,
        summary.bounds.max_lon
    );
}
