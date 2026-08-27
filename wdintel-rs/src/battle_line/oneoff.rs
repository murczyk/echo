use crate::battle_line::peleng_distance::fill_peleng_distances;
use crate::battle_line::{
    activate_battle_line_import, ensure_active_battle_line,
    prepare_battle_line_import, BattleLineImportOutcome,
    BattleLineImportSource,
};
use crate::config::{
    get_enemy_units_kml_path, mk_s3, mk_s3_config, read_config, Config,
    BATTLE_LINE_DELTA_KML_SOURCE_PREFIX,
    BATTLE_LINE_PELENG_DISTANCE_LATITUDE_MAX,
    BATTLE_LINE_PELENG_DISTANCE_LATITUDE_MIN,
    BATTLE_LINE_PELENG_DISTANCE_LONGITUDE_MAX,
    BATTLE_LINE_PELENG_DISTANCE_LONGITUDE_MIN,
    BATTLE_LINE_PELENG_DISTANCE_ONEOFF_BATCH_SIZE,
};
use crate::entities::{
    enemy_units_geojson, sea_orm_active_enums, sigint_inbox_item, sigint_peleng,
};
use crate::h;
use crate::types::{AppError, Mode, ShortContext};
use crate::utils::parse_local_datetime;
use crate::{new_pg_pool_from_config, storage};
use crate::{
    OneoffBackfillPelengBattleLineDistancePs,
    OneoffImportBattleLineFromDeltaKmlPs,
};
use anyhow::Context;
use chrono::{Duration, NaiveDateTime, Utc};
use log::warn;
use sea_orm::{
    ColumnTrait, DatabaseConnection, EntityTrait, FromQueryResult, JoinType,
    PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, RelationTrait,
};
use std::time::Instant;
use tokio::fs;

#[derive(Clone, Copy, Debug, FromQueryResult)]
struct PelengDistanceBackfillRow {
    datetime: NaiveDateTime,
    peleng_id: i64,
}

pub async fn oneoff_backfill_peleng_battle_line_distance(
    mode: Mode,
    ps: &OneoffBackfillPelengBattleLineDistancePs,
) -> Result<(), AppError> {
    let config = read_config(mode).c(h!())?;
    let dbx = new_pg_pool_from_config(&config).await.c(h!())?;
    let battle_line_version_id =
        ensure_active_battle_line(&dbx).await.c(h!())?;
    let (since_ts, until_ts) = peleng_distance_window(ps).c(h!())?;
    let total = count_peleng_distance_backfill_rows(&dbx, since_ts, until_ts)
        .await
        .c(h!())?;
    println!(
        "Peleng Battle Line distance backfill: version={battle_line_version_id}, since={since_ts}, until={until_ts}, total={total}"
    );
    let started_at = Instant::now();
    let mut cursor = None;
    let mut scanned = 0_u64;
    let mut updated = 0_u64;
    loop {
        let rows = load_peleng_distance_backfill_page(
            &dbx,
            since_ts,
            until_ts,
            cursor,
            BATTLE_LINE_PELENG_DISTANCE_ONEOFF_BATCH_SIZE,
        )
        .await
        .c(h!())?;
        if rows.is_empty() {
            break;
        }
        let peleng_ids =
            rows.iter().map(|row| row.peleng_id).collect::<Vec<_>>();
        let page_updated =
            fill_peleng_distances(&dbx, battle_line_version_id, &peleng_ids)
                .await
                .c(h!())?;
        scanned += rows.len() as u64;
        updated += page_updated;
        cursor = rows.last().map(|row| (row.datetime, row.peleng_id));
        print_peleng_distance_backfill_progress(
            cursor, scanned, updated, total, started_at,
        );
        if rows.len() < BATTLE_LINE_PELENG_DISTANCE_ONEOFF_BATCH_SIZE as usize {
            break;
        }
    }
    println!(
        "Peleng Battle Line distance backfill done: scanned={scanned}, updated={updated}, unresolved={}",
        scanned.saturating_sub(updated)
    );
    Ok(())
}

fn peleng_distance_window(
    ps: &OneoffBackfillPelengBattleLineDistancePs,
) -> Result<(NaiveDateTime, NaiveDateTime), AppError> {
    let until_ts = Utc::now().naive_utc();
    let since_ts = ps
        .since_ts
        .as_deref()
        .map(parse_local_datetime)
        .transpose()
        .c(h!())?;
    Ok((since_ts.unwrap_or(until_ts - Duration::days(1)), until_ts))
}

fn peleng_distance_backfill_query(
    since_ts: NaiveDateTime,
    until_ts: NaiveDateTime,
) -> sea_orm::Select<sigint_peleng::Entity> {
    sigint_peleng::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_peleng::Relation::SigintInboxItem.def(),
        )
        .filter(sigint_peleng::Column::BattleLineDistance.is_null())
        .filter(sigint_peleng::Column::Deleted.eq(false))
        .filter(sigint_peleng::Column::Lat.between(
            BATTLE_LINE_PELENG_DISTANCE_LATITUDE_MIN,
            BATTLE_LINE_PELENG_DISTANCE_LATITUDE_MAX,
        ))
        .filter(sigint_peleng::Column::Lng.between(
            BATTLE_LINE_PELENG_DISTANCE_LONGITUDE_MIN,
            BATTLE_LINE_PELENG_DISTANCE_LONGITUDE_MAX,
        ))
        .filter(sigint_inbox_item::Column::Datetime.gte(since_ts))
        .filter(sigint_inbox_item::Column::Datetime.lte(until_ts))
}

async fn count_peleng_distance_backfill_rows(
    dbx: &DatabaseConnection,
    since_ts: NaiveDateTime,
    until_ts: NaiveDateTime,
) -> anyhow::Result<u64> {
    peleng_distance_backfill_query(since_ts, until_ts)
        .count(dbx)
        .await
        .c(h!())
}

async fn load_peleng_distance_backfill_page(
    dbx: &DatabaseConnection,
    since_ts: NaiveDateTime,
    until_ts: NaiveDateTime,
    cursor: Option<(NaiveDateTime, i64)>,
    limit: u64,
) -> anyhow::Result<Vec<PelengDistanceBackfillRow>> {
    let mut query = peleng_distance_backfill_query(since_ts, until_ts)
        .order_by_asc(sigint_inbox_item::Column::Datetime)
        .order_by_asc(sigint_peleng::Column::Id);
    if let Some((datetime, peleng_id)) = cursor {
        query = query
            .filter(sigint_inbox_item::Column::Datetime.gte(datetime))
            .filter(
                sea_orm::Condition::any()
                    .add(sigint_inbox_item::Column::Datetime.gt(datetime))
                    .add(
                        sea_orm::Condition::all()
                            .add(
                                sigint_inbox_item::Column::Datetime
                                    .eq(datetime),
                            )
                            .add(sigint_peleng::Column::Id.gt(peleng_id)),
                    ),
            );
    }
    query
        .select_only()
        .column(sigint_inbox_item::Column::Datetime)
        .column_as(sigint_peleng::Column::Id, "peleng_id")
        .limit(limit)
        .into_model::<PelengDistanceBackfillRow>()
        .all(dbx)
        .await
        .c(h!())
}

fn print_peleng_distance_backfill_progress(
    cursor: Option<(NaiveDateTime, i64)>,
    scanned: u64,
    updated: u64,
    total: u64,
    started_at: Instant,
) {
    let elapsed_seconds = started_at.elapsed().as_secs_f64().max(0.001);
    let rate = scanned as f64 / elapsed_seconds;
    let remaining_seconds =
        (total.saturating_sub(scanned) as f64 / rate).ceil() as u64;
    let cursor = cursor
        .map(|(datetime, peleng_id)| format!("{datetime}:{peleng_id}"))
        .unwrap_or_else(|| "none".to_string());
    println!(
        "Peleng Battle Line distance backfill: cursor={cursor}, scanned={scanned}/{total}, updated={updated}, rate={rate:.1}/s, estimated_remaining_seconds={remaining_seconds}"
    );
}

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::{
        area_of_responsibility, signal_group, signal_group_aor, signal_message,
        signal_message_group,
    };
    use milgeo_rs::coordinates::Coords;
    use sea_orm::{
        ConnectionTrait, DatabaseBackend, Set, Statement, TransactionTrait,
    };

    async fn insert_test_battle_line(
        txn: &sea_orm::DatabaseTransaction,
        aor_lines: &[(i64, f64)],
    ) -> i64 {
        txn.execute_unprepared(
            "update battle_line_version set retired_at = now() at time zone 'utc' where retired_at is null",
        )
        .await
        .unwrap();
        let row = txn
            .query_one_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                r#"
insert into battle_line_version
    (geometry, source_file_name, uploaded_by_login_id, source_kind, source_sha256)
select
    ST_GeomFromText('GEOMETRYCOLLECTION(LINESTRING(0 0,10 0),LINESTRING(0 1,10 1))', 4326),
    'peleng-distance-test.kml',
    id,
    'admin_upload',
    $1
from login
where not deleted
order by created_at
limit 1
returning id
                "#,
                [uuid::Uuid::now_v7()
                    .to_string()
                    .replace('-', "")
                    .repeat(2)
                    .into()],
            ))
            .await
            .unwrap()
            .unwrap();
        let version_id: i64 = row.try_get("", "id").unwrap();
        for (aor_id, latitude) in aor_lines {
            txn.execute_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                r#"
insert into battle_line_aor_geometry
    (version_id, aor_id, geometry, snapped_start, snapped_end)
values (
    $1,
    $2,
    ST_GeomFromText($3, 4326),
    ST_SetSRID(ST_MakePoint(0, $4), 4326),
    ST_SetSRID(ST_MakePoint(10, $4), 4326)
)
                "#,
                [
                    version_id.into(),
                    (*aor_id).into(),
                    format!(
                        "GEOMETRYCOLLECTION(LINESTRING(0 {latitude},10 {latitude}))"
                    )
                    .into(),
                    (*latitude).into(),
                ],
            ))
            .await
            .unwrap();
        }
        version_id
    }

    // Regression: https://github.com/echoua/echo/issues/2287
    #[tokio::test]
    #[serial_test::serial]
    async fn calculates_new_pelengs_without_recomputing_existing_distances() {
        let config = read_config(Mode::Test).unwrap();
        let dbx = new_pg_pool_from_config(&config).await.unwrap();
        let txn = dbx.begin().await.unwrap();
        let first_aor = crate::functest::tests::mk_aor(
            &txn,
            area_of_responsibility::ActiveModel::default(),
        )
        .await
        .unwrap();
        let second_aor = crate::functest::tests::mk_aor(
            &txn,
            area_of_responsibility::ActiveModel::default(),
        )
        .await
        .unwrap();
        let irrelevant_aor = crate::functest::tests::mk_aor(
            &txn,
            area_of_responsibility::ActiveModel::default(),
        )
        .await
        .unwrap();
        insert_test_battle_line(
            &txn,
            &[
                (first_aor.id, 0.0),
                (second_aor.id, 1.0),
                (irrelevant_aor.id, 0.24),
            ],
        )
        .await;
        let group = crate::functest::tests::mk_signal_group(
            &txn,
            signal_group::ActiveModel::default(),
        )
        .await
        .unwrap();
        for aor_id in [first_aor.id, second_aor.id] {
            crate::functest::tests::mk_signal_group_aor(
                &txn,
                signal_group_aor::ActiveModel {
                    master_key: Set(group.master_key.clone()),
                    aor_id: Set(aor_id),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        }
        let message = crate::functest::tests::mk_signal_message(
            &txn,
            signal_message::ActiveModel::default(),
        )
        .await
        .unwrap();
        crate::functest::tests::mk_signal_message_group(
            &txn,
            signal_message_group::ActiveModel {
                signal_message_id: Set(message.id),
                group_master_key: Set(Some(group.master_key.clone())),
                datasource_group_id: Set(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let datetime = Utc::now().naive_utc();
        crate::functest::tests::mk_sigint_inbox_item(
            &txn,
            sigint_inbox_item::ActiveModel {
                id: Set(message.id),
                datetime: Set(Some(datetime)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let peleng = crate::functest::tests::mk_sigint_peleng(
            &txn,
            sigint_peleng::ActiveModel {
                source_inbox_item_id: Set(message.id),
                lat: Set(0.25),
                lng: Set(1.0),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let existing = crate::functest::tests::mk_sigint_peleng(
            &txn,
            sigint_peleng::ActiveModel {
                source_inbox_item_id: Set(message.id),
                lat: Set(0.25),
                lng: Set(1.0),
                battle_line_distance: Set(Some(7)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let pending = crate::functest::tests::mk_sigint_peleng(
            &txn,
            sigint_peleng::ActiveModel {
                source_inbox_item_id: Set(message.id),
                lat: Set(0.25),
                lng: Set(2.0),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let invalid = crate::functest::tests::mk_sigint_peleng(
            &txn,
            sigint_peleng::ActiveModel {
                source_inbox_item_id: Set(message.id),
                lat: Set(91.0),
                lng: Set(1.0),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(
            crate::battle_line::peleng_distance::fill_new_peleng_distances(
                &txn,
                &[peleng.id],
            )
            .await
            .unwrap(),
            1
        );
        assert_eq!(
            crate::battle_line::peleng_distance::fill_new_peleng_distances(
                &txn,
                &[peleng.id],
            )
            .await
            .unwrap(),
            0
        );
        let peleng = sigint_peleng::Entity::find_by_id(peleng.id)
            .one(&txn)
            .await
            .unwrap()
            .unwrap();
        let existing = sigint_peleng::Entity::find_by_id(existing.id)
            .one(&txn)
            .await
            .unwrap()
            .unwrap();
        let pending = sigint_peleng::Entity::find_by_id(pending.id)
            .one(&txn)
            .await
            .unwrap()
            .unwrap();
        let invalid = sigint_peleng::Entity::find_by_id(invalid.id)
            .one(&txn)
            .await
            .unwrap()
            .unwrap();
        assert!(
            (27_000..29_000).contains(&peleng.battle_line_distance.unwrap())
        );
        assert_eq!(existing.battle_line_distance, Some(7));
        assert_eq!(pending.battle_line_distance, None);
        assert_eq!(invalid.battle_line_distance, None);
        crate::messenger::bl::upsert_group_area_of_responsibility(
            &txn,
            &group.master_key,
            Some(vec![second_aor.id]),
        )
        .await
        .unwrap();
        let peleng = sigint_peleng::Entity::find_by_id(peleng.id)
            .one(&txn)
            .await
            .unwrap()
            .unwrap();
        let existing = sigint_peleng::Entity::find_by_id(existing.id)
            .one(&txn)
            .await
            .unwrap()
            .unwrap();
        let pending = sigint_peleng::Entity::find_by_id(pending.id)
            .one(&txn)
            .await
            .unwrap()
            .unwrap();
        assert!(
            (27_000..29_000).contains(&peleng.battle_line_distance.unwrap())
        );
        assert_eq!(existing.battle_line_distance, Some(7));
        assert_eq!(pending.battle_line_distance, None);
        crate::location::peleng::insert_pelengs(
            vec![Coords {
                lat: 0.75,
                lng: 1.0,
                text: "0.75, 1.0".to_string(),
                mgrs: String::new(),
                capture: "0.75, 1.0".to_string(),
            }],
            message.id,
            datetime,
            None,
            &txn,
        )
        .await
        .unwrap();
        let inserted = sigint_peleng::Entity::find()
            .filter(sigint_peleng::Column::SourceInboxItemId.eq(message.id))
            .filter(sigint_peleng::Column::Lat.eq(0.75))
            .one(&txn)
            .await
            .unwrap()
            .unwrap();
        assert!(
            (27_000..29_000).contains(&inserted.battle_line_distance.unwrap())
        );
        txn.rollback().await.unwrap();
    }
}
