use crate::battle_line::types::*;
use crate::config::{
    BATTLE_LINE_ADMIN_PAGE_SIZE, BATTLE_LINE_ALLOWED_UPLOAD_EXTENSIONS,
    BATTLE_LINE_AOR_ANCHOR_LATITUDE, BATTLE_LINE_AOR_ANCHOR_LONGITUDE,
    BATTLE_LINE_CLIP_EXTENT_METERS, BATTLE_LINE_NETWORKS_LOOKBACK_DAYS,
    BATTLE_LINE_NETWORKS_MAP_POINTS_PER_UNIT_LIMIT,
    BATTLE_LINE_NETWORKS_PAGE_SIZE,
    BATTLE_LINE_SETTLEMENT_CANONICAL_MATCH_MAX_DISTANCE_METERS,
    BATTLE_LINE_SETTLEMENT_MAX_DISTANCE_EAST_METERS,
    BATTLE_LINE_SETTLEMENT_MAX_DISTANCE_WEST_METERS,
    BATTLE_LINE_SOURCE_KIND_ADMIN_UPLOAD, BATTLE_LINE_SOURCE_KIND_DELTA_KML,
    BATTLE_LINE_UPLOAD_ADVISORY_LOCK_KEY, BATTLE_LINE_UPLOAD_MAX_BYTES,
};
use crate::entities::*;
use crate::error::AppError;
use crate::geometry_import::{
    parse_point_line_features, sanitize_upload_filename, ImportedCoordinate,
    ImportedGeometryFeature,
};
use crate::h;
use crate::types::{Env, ShortContext};
use actix_multipart::Multipart;
use actix_web::web::{Data, Json};
use actix_web::{get, post};
use anyhow::Context;
use chrono::{NaiveDateTime, Utc};
use log::warn;
use sea_orm::sea_query::{Alias, Expr, Query, SelectStatement, SimpleExpr};
use sea_orm::*;
use serde_json::Value as JsonValue;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, RwLock};

pub mod cleanup;
pub mod oneoff;
pub mod peleng_distance;
pub mod settlement_queue;
pub mod types;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BattleLineImportSource {
    pub kind: String,
    pub identifier: Option<String>,
}

impl BattleLineImportSource {
    pub fn admin_upload() -> Self {
        Self {
            kind: BATTLE_LINE_SOURCE_KIND_ADMIN_UPLOAD.to_string(),
            identifier: None,
        }
    }

    pub fn delta_kml(identifier: String) -> Self {
        Self {
            kind: BATTLE_LINE_SOURCE_KIND_DELTA_KML.to_string(),
            identifier: Some(identifier),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct BattleLineImportBounds {
    pub min_lat: f64,
    pub min_lon: f64,
    pub max_lat: f64,
    pub max_lon: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BattleLineImportSummary {
    pub point_count: usize,
    pub line_string_count: usize,
    pub empty_point_count: usize,
    pub empty_line_string_count: usize,
    pub zero_length_line_string_count: usize,
    pub coordinate_count: usize,
    pub bounds: BattleLineImportBounds,
}

#[derive(Clone, Debug)]
pub struct PreparedBattleLineImport {
    geometry_wkt: String,
    pub source_file_name: String,
    pub source_sha256: String,
    pub source_summary: BattleLineImportSummary,
    pub cleanup_stats: cleanup::BattleLineCleanupStats,
    pub summary: BattleLineImportSummary,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BattleLineImportOutcome {
    Imported(i64),
    AlreadyImported(i64),
    RequiresForce(i64),
}

#[derive(Clone, Debug)]
pub struct BattleLineCandidatePoint {
    pub lat: f64,
    pub lon: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BattleLineMatch {
    pub candidate_index: usize,
    pub distance_m: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BattleLineMatchOutcome {
    pub matched: Option<BattleLineMatch>,
    pub invalid_aor_ids: Vec<i64>,
}

#[derive(Clone, Debug)]
pub struct InboxItemAorContext {
    pub group_master_keys: Vec<String>,
    pub aor_ids: Vec<i64>,
}

#[derive(Debug, FromQueryResult)]
struct VersionRow {
    id: i64,
    source_file_name: String,
    uploader_login: String,
    uploaded_at: NaiveDateTime,
    retired_at: Option<NaiveDateTime>,
    geometry_geojson: Option<JsonValue>,
}

#[derive(Debug, FromQueryResult)]
struct AorGeometryRow {
    aor_id: i64,
    aor_name: String,
    geometry_geojson: JsonValue,
    snapped_start_geojson: JsonValue,
    snapped_end_geojson: JsonValue,
}

#[derive(Debug, FromQueryResult)]
struct MatchRow {
    candidate_index: i64,
    distance_m: f64,
    is_west: bool,
}

#[derive(Debug, FromQueryResult)]
struct CanonicalSettlementRow {
    location_index: i64,
    settlement_id: i32,
    name: String,
    district: String,
    region: String,
    lat: f64,
    lon: f64,
}

#[derive(Debug, FromQueryResult)]
struct UnitMapPointRow {
    unit_id: i64,
    lat: f64,
    lon: f64,
}

#[derive(Clone, Debug, PartialEq)]
struct BattleLineCandidateDistance {
    candidate_index: usize,
    distance_m: f64,
    is_west: bool,
}

#[derive(Clone, Debug, PartialEq)]
struct BattleLineRankOutcome {
    ranked: Vec<BattleLineCandidateDistance>,
    invalid_aor_ids: Vec<i64>,
}

#[derive(Clone, Debug)]
struct LocationResolutionDraft {
    location: String,
    candidates: Vec<BattleLineSettlementCandidate>,
    battle_line_distances: BTreeMap<usize, BattleLineCandidateDistance>,
    chosen_candidate_index: Option<usize>,
    invalid_aor_ids: Vec<i64>,
}

#[get("/api/battle-line")]
pub async fn read_battle_line(
    user: actix_identity::Identity,
    env: Data<Env>,
) -> Result<Json<BattleLineState>, AppError> {
    crate::users::ensure_admin(&env.dbx, &user).await.c(h!())?;
    Ok(Json(read_battle_line_state(&env.dbx).await.c(h!())?))
}

#[post("/api/battle-line/upload")]
pub async fn upload_battle_line(
    user: actix_identity::Identity,
    env: Data<Env>,
    mut payload: Multipart,
) -> Result<Json<BattleLineState>, AppError> {
    crate::users::ensure_admin(&env.dbx, &user).await.c(h!())?;
    let login_id = crate::users::login_id_from_identity(&user).c(h!())?;
    let (field, data) = crate::utils::multipart::extract_limited(
        &mut payload,
        BATTLE_LINE_UPLOAD_MAX_BYTES,
    )
    .await
    .c(h!())?;
    let raw_file_name = field
        .content_disposition()
        .and_then(|disposition| disposition.get_filename())
        .unwrap_or("battle-line.kml");
    let prepared = prepare_battle_line_import(raw_file_name, &data)
        .await
        .c(h!())?;
    activate_battle_line_import(
        &env.dbx,
        &prepared,
        login_id,
        &BattleLineImportSource::admin_upload(),
        true,
    )
    .await
    .c(h!())?;
    Ok(Json(read_battle_line_state(&env.dbx).await.c(h!())?))
}

#[post("/api/battle-line/test")]
pub async fn test_battle_line(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<BattleLineTestReq>,
) -> Result<Json<BattleLineTestRsp>, AppError> {
    crate::users::ensure_admin(&env.dbx, &user).await.c(h!())?;
    ensure_active_battle_line(&env.dbx).await.c(h!())?;
    let inbox_item_ids = resolve_test_inbox_item_ids(
        &env.dbx,
        req.inbox_item_id.as_deref(),
        req.message_uid.as_deref(),
    )
    .await
    .c(h!())?;
    if inbox_item_ids.is_empty() {
        return Err(AppError::NotFound);
    }
    let login_id = crate::users::login_id_from_identity(&user).c(h!())?;
    let organism_logins = crate::users::get_organism_login_ids(&env.dbx, user)
        .await
        .c(h!())?;
    let inbox_req = crate::rer_importer::types::InboxMessagesReq {
        highlight_points: Some(true),
        ..Default::default()
    };
    let messages = crate::rer_importer::inbox::messages_by_id_bl(
        &login_id,
        &organism_logins,
        &env,
        &inbox_item_ids,
        &inbox_req,
    )
    .await
    .c(h!())?;
    let mut messages = messages.into_iter().collect::<BTreeMap<_, _>>();
    let Some((inbox_item_id, message)) =
        inbox_item_ids.into_iter().find_map(|inbox_item_id| {
            messages
                .remove(&inbox_item_id)
                .map(|message| (inbox_item_id, message))
        })
    else {
        return Err(AppError::NotFound);
    };
    let location_v2 = sigint_inbox_item::Entity::find_by_id(inbox_item_id)
        .select_only()
        .column(sigint_inbox_item::Column::LocationV2)
        .into_tuple::<Option<String>>()
        .one(&env.dbx)
        .await
        .c(h!())?
        .flatten();
    let allowed_groups = crate::messenger::group::get_identity_sigint_groups(
        &env.dbx, &login_id,
    )
    .await
    .c(h!())?
    .into_iter()
    .collect::<BTreeSet<_>>();
    let aor_context =
        resolve_inbox_item_aors(&env.dbx, inbox_item_id, Some(&allowed_groups))
            .await
            .c(h!())?;
    let locations = location_v2
        .as_deref()
        .map(crate::location::utils::to_location_list)
        .unwrap_or_default()
        .into_iter()
        .collect::<Vec<_>>();
    let locations =
        resolve_locations_to_settlements(&env, locations, &aor_context.aor_ids)
            .await
            .c(h!())?;
    Ok(Json(BattleLineTestRsp {
        inbox_item_id,
        message,
        group_master_keys: aor_context.group_master_keys,
        aor_ids: aor_context.aor_ids,
        locations,
        battle_line: read_battle_line_state(&env.dbx).await.c(h!())?,
    }))
}

async fn resolve_test_inbox_item_ids<C>(
    dbx: &C,
    inbox_item_id: Option<&str>,
    message_uid: Option<&str>,
) -> anyhow::Result<Vec<i64>>
where
    C: ConnectionTrait,
{
    let message_uid = match (inbox_item_id, message_uid) {
        (Some(inbox_item_id), None) => {
            return Ok(inbox_item_id
                .trim()
                .parse::<i64>()
                .ok()
                .into_iter()
                .collect());
        }
        (None, Some(message_uid)) => message_uid.trim(),
        _ => return Ok(vec![]),
    };
    if message_uid.is_empty() {
        return Ok(vec![]);
    }
    sigint_inbox_item::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .filter(signal_message::Column::MessageUid.eq(message_uid))
        .filter(signal_message::Column::Deleted.eq(false))
        .order_by_desc(sigint_inbox_item::Column::Id)
        .select_only()
        .column(sigint_inbox_item::Column::Id)
        .into_tuple::<i64>()
        .all(dbx)
        .await
        .c(h!())
}

#[post("/api/battle-line/unlinked-inbox")]
pub async fn list_unlinked_inbox_items(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<BattleLineAdminPageReq>,
) -> Result<Json<BattleLineUnlinkedInboxRsp>, AppError> {
    crate::users::ensure_admin(&env.dbx, &user).await.c(h!())?;
    let login_id = crate::users::login_id_from_identity(&user).c(h!())?;
    let allowed_groups = crate::messenger::group::get_identity_sigint_groups(
        &env.dbx, &login_id,
    )
    .await
    .c(h!())?;
    let page = std::cmp::Ord::max(req.page, 1);
    let offset = page
        .saturating_sub(1)
        .saturating_mul(BATTLE_LINE_ADMIN_PAGE_SIZE);
    let total = unlinked_inbox_query(&allowed_groups)
        .count(&env.dbx)
        .await
        .c(h!())?;
    let ids = unlinked_inbox_query(&allowed_groups)
        .order_by_desc(sigint_inbox_item::Column::Datetime)
        .order_by_desc(sigint_inbox_item::Column::Id)
        .offset(offset)
        .limit(BATTLE_LINE_ADMIN_PAGE_SIZE)
        .select_only()
        .column(sigint_inbox_item::Column::Id)
        .into_tuple::<i64>()
        .all(&env.dbx)
        .await
        .c(h!())?;
    let organism_logins = crate::users::get_organism_login_ids(&env.dbx, user)
        .await
        .c(h!())?;
    let inbox_req = crate::rer_importer::types::InboxMessagesReq {
        highlight_points: Some(true),
        ..Default::default()
    };
    let loaded = crate::rer_importer::inbox::messages_by_id_bl(
        &login_id,
        &organism_logins,
        &env,
        &ids,
        &inbox_req,
    )
    .await
    .c(h!())?;
    let loaded = loaded
        .into_iter()
        .collect::<std::collections::BTreeMap<_, _>>();
    let items = ids
        .into_iter()
        .filter_map(|id| loaded.get(&id).cloned().map(|message| (id, message)))
        .collect();
    Ok(Json(BattleLineUnlinkedInboxRsp {
        items,
        total,
        page_size: BATTLE_LINE_ADMIN_PAGE_SIZE,
    }))
}

fn unlinked_inbox_query(
    allowed_groups: &[String],
) -> Select<sigint_inbox_item::Entity> {
    sigint_inbox_item::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(message_is_accessible(allowed_groups))
        .filter(
            Expr::exists(
                sigint_inbox_item_settlement::Entity::find()
                    .filter(
                        Expr::col((
                            sigint_inbox_item_settlement::Entity,
                            sigint_inbox_item_settlement::Column::ItemId,
                        ))
                        .equals((
                            sigint_inbox_item::Entity,
                            sigint_inbox_item::Column::Id,
                        )),
                    )
                    .select_only()
                    .column(sigint_inbox_item_settlement::Column::Id)
                    .into_query(),
            )
            .not(),
        )
}

#[post("/api/battle-line/unresolved-locations")]
pub async fn list_unresolved_locations(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<BattleLineAdminPageReq>,
) -> Result<Json<BattleLineUnresolvedLocationsRsp>, AppError> {
    crate::users::ensure_admin(&env.dbx, &user).await.c(h!())?;
    let login_id = crate::users::login_id_from_identity(&user).c(h!())?;
    let allowed_groups = crate::messenger::group::get_identity_sigint_groups(
        &env.dbx, &login_id,
    )
    .await
    .c(h!())?;
    let page = std::cmp::Ord::max(req.page, 1);
    let offset = page
        .saturating_sub(1)
        .saturating_mul(BATTLE_LINE_ADMIN_PAGE_SIZE);
    #[derive(Debug, FromQueryResult)]
    struct Row {
        settlement_text: String,
        item_count: i64,
    }
    let rows = unresolved_locations_query(&allowed_groups)
        .select_only()
        .column(sigint_inbox_item_settlement::Column::SettlementText)
        .column_as(
            Expr::col((
                sigint_inbox_item_settlement::Entity,
                sigint_inbox_item_settlement::Column::ItemId,
            ))
            .count_distinct(),
            "item_count",
        )
        .group_by(sigint_inbox_item_settlement::Column::SettlementText)
        .order_by_desc(Expr::cust("item_count"))
        .order_by_asc(sigint_inbox_item_settlement::Column::SettlementText)
        .offset(offset)
        .limit(BATTLE_LINE_ADMIN_PAGE_SIZE)
        .into_model::<Row>()
        .all(&env.dbx)
        .await
        .c(h!())?;
    let total = unresolved_locations_query(&allowed_groups)
        .select_only()
        .column_as(
            Expr::col((
                sigint_inbox_item_settlement::Entity,
                sigint_inbox_item_settlement::Column::SettlementText,
            ))
            .count_distinct(),
            "count",
        )
        .into_tuple::<i64>()
        .one(&env.dbx)
        .await
        .c(h!())?
        .unwrap_or(0) as u64;
    Ok(Json(BattleLineUnresolvedLocationsRsp {
        items: rows
            .into_iter()
            .map(|row| BattleLineUnresolvedLocation {
                settlement_text: row.settlement_text,
                item_count: row.item_count as u64,
            })
            .collect(),
        total,
        page_size: BATTLE_LINE_ADMIN_PAGE_SIZE,
    }))
}

fn unresolved_locations_query(
    allowed_groups: &[String],
) -> Select<sigint_inbox_item_settlement::Entity> {
    sigint_inbox_item_settlement::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item_settlement::Relation::SigintInboxItem.def(),
        )
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(message_is_accessible(allowed_groups))
        .filter(sigint_inbox_item_settlement::Column::SettlementId.is_null())
        .filter(sigint_inbox_item_settlement::Column::IsUndefined.eq(true))
}

#[post("/api/battle-line/networks")]
pub async fn list_network_maps(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<BattleLineAdminPageReq>,
) -> Result<Json<BattleLineNetworksRsp>, AppError> {
    crate::users::ensure_admin(&env.dbx, &user).await.c(h!())?;
    let login_id = crate::users::login_id_from_identity(&user).c(h!())?;
    let allowed_groups = crate::messenger::group::get_identity_sigint_groups(
        &env.dbx, &login_id,
    )
    .await
    .c(h!())?;
    let response = read_network_maps(
        &env.dbx,
        &allowed_groups,
        req.page,
        Utc::now().naive_utc(),
    )
    .await
    .c(h!())?;
    Ok(Json(response))
}

async fn read_network_maps<C>(
    dbx: &C,
    allowed_groups: &[String],
    page: u64,
    now: NaiveDateTime,
) -> anyhow::Result<BattleLineNetworksRsp>
where
    C: ConnectionTrait,
{
    let page = std::cmp::Ord::max(page, 1);
    let offset = page
        .saturating_sub(1)
        .saturating_mul(BATTLE_LINE_NETWORKS_PAGE_SIZE);
    let total = live_network_units_query(now).count(dbx).await.c(h!())?;
    let units = live_network_units_query(now)
        .order_by_desc(sigint_network::Column::CreatedAt.max())
        .order_by_desc(sigint_unit::Column::Id)
        .offset(offset)
        .limit(BATTLE_LINE_NETWORKS_PAGE_SIZE)
        .all(dbx)
        .await
        .c(h!())?;
    let unit_ids = units.iter().map(|unit| unit.id).collect::<Vec<_>>();
    let cutoff =
        now - chrono::Duration::days(BATTLE_LINE_NETWORKS_LOOKBACK_DAYS);
    let settlement_points = load_network_settlement_points(
        dbx,
        allowed_groups,
        &unit_ids,
        cutoff,
        now,
    )
    .await
    .c(h!())?;
    let peleng_points =
        load_network_peleng_points(dbx, allowed_groups, &unit_ids, cutoff, now)
            .await
            .c(h!())?;

    Ok(BattleLineNetworksRsp {
        items: units
            .into_iter()
            .map(|unit| BattleLineNetworkUnitMap {
                unit_id: unit.id,
                unit_name: unit.name,
                settlement_points: settlement_points
                    .get(&unit.id)
                    .cloned()
                    .unwrap_or_default(),
                peleng_points: peleng_points
                    .get(&unit.id)
                    .cloned()
                    .unwrap_or_default(),
            })
            .collect(),
        total,
        page_size: BATTLE_LINE_NETWORKS_PAGE_SIZE,
    })
}

fn live_network_units_query(now: NaiveDateTime) -> Select<sigint_unit::Entity> {
    sigint_unit::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_unit::Relation::SigintNetworkUnit.def(),
        )
        .join(
            JoinType::InnerJoin,
            sigint_network_unit::Relation::SigintNetwork.def(),
        )
        .filter(sigint_unit::Column::Active.eq(true))
        .filter(sigint_unit::Column::Deleted.eq(false))
        .filter(sigint_network::Column::Deleted.eq(false))
        .filter(sigint_network::Column::ActiveTo.is_null())
        .filter(
            sigint_network::Column::ActiveFrom
                .is_null()
                .or(sigint_network::Column::ActiveFrom.lte(now)),
        )
        .group_by(sigint_unit::Column::Id)
}

async fn load_network_settlement_points<C>(
    dbx: &C,
    allowed_groups: &[String],
    unit_ids: &[i64],
    cutoff: NaiveDateTime,
    now: NaiveDateTime,
) -> anyhow::Result<BTreeMap<i64, Vec<BattleLineNetworkMapPoint>>>
where
    C: ConnectionTrait,
{
    if unit_ids.is_empty() {
        return Ok(BTreeMap::new());
    }
    let ranked_points =
        network_point_query(allowed_groups, unit_ids, cutoff, now)
            .join(
                JoinType::InnerJoin,
                sigint_inbox_item::Relation::SigintInboxItemSettlement.def(),
            )
            .join(
                JoinType::InnerJoin,
                sigint_inbox_item_settlement::Relation::Settlement.def(),
            )
            .filter(settlement::Column::Lat.is_not_null())
            .filter(settlement::Column::Lon.is_not_null())
            .filter(settlement::Column::Lat.between(-90.0, 90.0))
            .filter(settlement::Column::Lon.between(-180.0, 180.0))
            .select_only()
            .column(sigint_network_unit::Column::UnitId)
            .column_as(settlement::Column::Lat, "lat")
            .column_as(settlement::Column::Lon, "lon")
            .column_as(
                Expr::cust(
                    r#"ROW_NUMBER() OVER (
                    PARTITION BY "sigint_network_unit"."unit_id"
                    ORDER BY MAX("sigint_inbox_item"."datetime") DESC,
                             "settlement"."lat", "settlement"."lon"
                )"#,
                ),
                "point_rank",
            )
            .group_by(sigint_network_unit::Column::UnitId)
            .group_by(settlement::Column::Lat)
            .group_by(settlement::Column::Lon)
            .into_query();
    load_bounded_unit_map_points(dbx, ranked_points)
        .await
        .c(h!())
}

async fn load_network_peleng_points<C>(
    dbx: &C,
    allowed_groups: &[String],
    unit_ids: &[i64],
    cutoff: NaiveDateTime,
    now: NaiveDateTime,
) -> anyhow::Result<BTreeMap<i64, Vec<BattleLineNetworkMapPoint>>>
where
    C: ConnectionTrait,
{
    if unit_ids.is_empty() {
        return Ok(BTreeMap::new());
    }
    let ranked_points =
        network_point_query(allowed_groups, unit_ids, cutoff, now)
            .join(
                JoinType::InnerJoin,
                sigint_inbox_item::Relation::SigintPeleng.def(),
            )
            .filter(sigint_peleng::Column::Deleted.eq(false))
            .filter(sigint_peleng::Column::Lat.between(-90.0, 90.0))
            .filter(sigint_peleng::Column::Lng.between(-180.0, 180.0))
            .select_only()
            .column(sigint_network_unit::Column::UnitId)
            .column_as(sigint_peleng::Column::Lat, "lat")
            .column_as(sigint_peleng::Column::Lng, "lon")
            .column_as(
                Expr::cust(
                    r#"ROW_NUMBER() OVER (
                    PARTITION BY "sigint_network_unit"."unit_id"
                    ORDER BY MAX("sigint_inbox_item"."datetime") DESC,
                             "sigint_peleng"."lat", "sigint_peleng"."lng"
                )"#,
                ),
                "point_rank",
            )
            .group_by(sigint_network_unit::Column::UnitId)
            .group_by(sigint_peleng::Column::Lat)
            .group_by(sigint_peleng::Column::Lng)
            .into_query();
    load_bounded_unit_map_points(dbx, ranked_points)
        .await
        .c(h!())
}

async fn load_bounded_unit_map_points<C>(
    dbx: &C,
    ranked_points: SelectStatement,
) -> anyhow::Result<BTreeMap<i64, Vec<BattleLineNetworkMapPoint>>>
where
    C: ConnectionTrait,
{
    let ranked_points_alias = Alias::new("ranked_points");
    let query = Query::select()
        .columns([
            (ranked_points_alias.clone(), Alias::new("unit_id")),
            (ranked_points_alias.clone(), Alias::new("lat")),
            (ranked_points_alias.clone(), Alias::new("lon")),
        ])
        .from_subquery(ranked_points, ranked_points_alias.clone())
        .and_where(
            Expr::col((ranked_points_alias, Alias::new("point_rank")))
                .lte(BATTLE_LINE_NETWORKS_MAP_POINTS_PER_UNIT_LIMIT),
        )
        .to_owned();
    let rows = UnitMapPointRow::find_by_statement(
        dbx.get_database_backend().build(&query),
    )
    .all(dbx)
    .await
    .c(h!())?;
    Ok(group_unit_map_points(rows))
}

fn network_point_query(
    allowed_groups: &[String],
    unit_ids: &[i64],
    cutoff: NaiveDateTime,
    now: NaiveDateTime,
) -> Select<sigint_network_unit::Entity> {
    sigint_network_unit::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_network_unit::Relation::SigintNetwork.def(),
        )
        .join(
            JoinType::InnerJoin,
            sigint_network::Relation::SigintInboxItemNetwork.def(),
        )
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item_network::Relation::SigintInboxItem.def(),
        )
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .filter(sigint_network_unit::Column::UnitId.is_in(unit_ids.to_vec()))
        .filter(sigint_network::Column::Deleted.eq(false))
        .filter(sigint_network::Column::ActiveTo.is_null())
        .filter(
            sigint_network::Column::ActiveFrom
                .is_null()
                .or(sigint_network::Column::ActiveFrom.lte(now)),
        )
        .filter(sigint_inbox_item::Column::Datetime.gte(cutoff))
        .filter(sigint_inbox_item::Column::Datetime.lte(now))
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(message_is_accessible(allowed_groups))
}

fn group_unit_map_points(
    rows: Vec<UnitMapPointRow>,
) -> BTreeMap<i64, Vec<BattleLineNetworkMapPoint>> {
    let mut points = BTreeMap::<i64, Vec<_>>::new();
    for row in rows {
        if !is_valid_map_coordinate(row.lat, row.lon) {
            continue;
        }
        points.entry(row.unit_id).or_default().push(
            BattleLineNetworkMapPoint {
                lat: row.lat,
                lon: row.lon,
            },
        );
    }
    points
}

fn is_valid_map_coordinate(lat: f64, lon: f64) -> bool {
    lat.is_finite()
        && lon.is_finite()
        && (-90.0..=90.0).contains(&lat)
        && (-180.0..=180.0).contains(&lon)
}

fn message_is_accessible(allowed_groups: &[String]) -> SimpleExpr {
    Expr::exists(
        signal_message_group::Entity::find()
            .filter(
                Expr::col((
                    signal_message_group::Entity,
                    signal_message_group::Column::SignalMessageId,
                ))
                .equals((signal_message::Entity, signal_message::Column::Id)),
            )
            .filter(
                signal_message_group::Column::GroupMasterKey
                    .is_in(allowed_groups.to_vec()),
            )
            .select_only()
            .column(signal_message_group::Column::Id)
            .into_query(),
    )
}

pub async fn ensure_active_battle_line<C>(dbx: &C) -> anyhow::Result<i64>
where
    C: ConnectionTrait,
{
    active_battle_line_id(dbx)
        .await
        .c(h!())?
        .context("No active Battle Line is configured")
}

pub async fn active_battle_line_id<C>(dbx: &C) -> anyhow::Result<Option<i64>>
where
    C: ConnectionTrait,
{
    battle_line_version::Entity::find()
        .filter(battle_line_version::Column::RetiredAt.is_null())
        .select_only()
        .column(battle_line_version::Column::Id)
        .into_tuple::<i64>()
        .one(dbx)
        .await
        .c(h!())
}

pub async fn prepare_battle_line_import(
    file_name: &str,
    data: &[u8],
) -> anyhow::Result<PreparedBattleLineImport> {
    if data.len() > BATTLE_LINE_UPLOAD_MAX_BYTES {
        anyhow::bail!(
            "Battle Line file exceeds the {BATTLE_LINE_UPLOAD_MAX_BYTES} byte limit"
        );
    }
    let source_file_name = sanitize_upload_filename(file_name);
    validate_battle_line_extension(&source_file_name).c(h!())?;
    let parsed = parse_point_line_features(&source_file_name, data)
        .await
        .c(h!())?;
    let mut source_summary = summarize_features(&parsed.features).c(h!())?;
    source_summary.empty_point_count = parsed.empty_point_count;
    source_summary.empty_line_string_count = parsed.empty_line_string_count;
    let cleanup = cleanup::clean_features(parsed.features).c(h!())?;
    let summary = summarize_features(&cleanup.features).c(h!())?;
    let features = cleanup.features;
    let geometry_wkt = features_to_wkt(&features).c(h!())?;
    Ok(PreparedBattleLineImport {
        geometry_wkt,
        source_file_name,
        source_sha256: sha256::digest(data),
        source_summary,
        cleanup_stats: cleanup.stats,
        summary,
    })
}

fn validate_battle_line_extension(
    source_file_name: &str,
) -> anyhow::Result<()> {
    let extension = std::path::Path::new(source_file_name)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !BATTLE_LINE_ALLOWED_UPLOAD_EXTENSIONS.contains(&extension.as_str()) {
        anyhow::bail!(
            "Only .kml and .kmz files are supported: {source_file_name}"
        );
    }
    Ok(())
}

pub async fn activate_battle_line_import(
    dbx: &DatabaseConnection,
    prepared: &PreparedBattleLineImport,
    uploaded_by_login_id: uuid::Uuid,
    source: &BattleLineImportSource,
    replace_existing: bool,
) -> anyhow::Result<BattleLineImportOutcome> {
    let txn = dbx.begin().await.c(h!())?;
    let outcome = activate_battle_line_import_in_transaction(
        &txn,
        prepared,
        uploaded_by_login_id,
        source,
        replace_existing,
    )
    .await
    .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(outcome)
}

async fn activate_battle_line_import_in_transaction<C>(
    dbx: &C,
    prepared: &PreparedBattleLineImport,
    uploaded_by_login_id: uuid::Uuid,
    source: &BattleLineImportSource,
    replace_existing: bool,
) -> anyhow::Result<BattleLineImportOutcome>
where
    C: ConnectionTrait,
{
    lock_updates(dbx).await.c(h!())?;
    let previous_id = battle_line_version::Entity::find()
        .filter(battle_line_version::Column::RetiredAt.is_null())
        .select_only()
        .column(battle_line_version::Column::Id)
        .into_tuple::<i64>()
        .one(dbx)
        .await
        .c(h!())?;
    if !replace_existing {
        if let Some(version_id) = find_existing_active_source_version(
            dbx,
            source,
            &prepared.source_sha256,
        )
        .await
        .c(h!())?
        {
            return Ok(BattleLineImportOutcome::AlreadyImported(version_id));
        }
        if let Some(previous_id) = previous_id {
            return Ok(BattleLineImportOutcome::RequiresForce(previous_id));
        }
    }
    if let Some(previous_id) = previous_id {
        battle_line_aor_geometry::Entity::delete_many()
            .filter(battle_line_aor_geometry::Column::VersionId.eq(previous_id))
            .exec(dbx)
            .await
            .c(h!())?;
        battle_line_version::Entity::update_many()
            .col_expr(
                battle_line_version::Column::RetiredAt,
                Expr::cust("now() at time zone 'utc'"),
            )
            .filter(battle_line_version::Column::Id.eq(previous_id))
            .exec(dbx)
            .await
            .c(h!())?;
    }
    let row = dbx
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
insert into battle_line_version
    (
        geometry,
        source_file_name,
        uploaded_by_login_id,
        source_kind,
        source_identifier,
        source_sha256
    )
values (ST_GeomFromText($1, 4326), $2, $3, $4, $5, $6)
returning id
            "#,
            [
                prepared.geometry_wkt.clone().into(),
                prepared.source_file_name.clone().into(),
                uploaded_by_login_id.into(),
                source.kind.clone().into(),
                source.identifier.clone().into(),
                prepared.source_sha256.clone().into(),
            ],
        ))
        .await
        .c(h!())?
        .c(h!())?;
    let version_id: i64 = row.try_get("", "id").c(h!())?;
    let aor_ids = area_of_responsibility::Entity::find()
        .filter(area_of_responsibility::Column::Deleted.eq(false))
        .filter(area_of_responsibility::Column::LeftLat.is_not_null())
        .filter(area_of_responsibility::Column::LeftLon.is_not_null())
        .filter(area_of_responsibility::Column::RightLat.is_not_null())
        .filter(area_of_responsibility::Column::RightLon.is_not_null())
        .select_only()
        .column(area_of_responsibility::Column::Id)
        .into_tuple::<i64>()
        .all(dbx)
        .await
        .c(h!())?;
    for aor_id in aor_ids {
        refresh_aor_geometry(dbx, aor_id).await.c(h!())?;
    }
    Ok(BattleLineImportOutcome::Imported(version_id))
}

async fn find_existing_active_source_version<C>(
    dbx: &C,
    source: &BattleLineImportSource,
    source_sha256: &str,
) -> anyhow::Result<Option<i64>>
where
    C: ConnectionTrait,
{
    let Some(source_identifier) = source.identifier.as_ref() else {
        return Ok(None);
    };
    battle_line_version::Entity::find()
        .filter(battle_line_version::Column::SourceKind.eq(&source.kind))
        .filter(
            battle_line_version::Column::SourceIdentifier.eq(source_identifier),
        )
        .filter(battle_line_version::Column::SourceSha256.eq(source_sha256))
        .filter(battle_line_version::Column::RetiredAt.is_null())
        .select_only()
        .column(battle_line_version::Column::Id)
        .into_tuple::<i64>()
        .one(dbx)
        .await
        .c(h!())
}

pub(crate) async fn requeue_settlement_links<C>(dbx: &C) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    sigint_inbox_item_settlement::Entity::update_many()
        .col_expr(
            sigint_inbox_item_settlement::Column::SettlementId,
            Expr::value(Option::<i32>::None),
        )
        .col_expr(
            sigint_inbox_item_settlement::Column::IsUndefined,
            Expr::value(Option::<bool>::None),
        )
        .exec(dbx)
        .await
        .c(h!())?;
    Ok(())
}

pub(crate) async fn requeue_settlement_links_for_group<C>(
    dbx: &C,
    group_master_key: &str,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    sigint_inbox_item_settlement::Entity::update_many()
        .col_expr(
            sigint_inbox_item_settlement::Column::SettlementId,
            Expr::value(Option::<i32>::None),
        )
        .col_expr(
            sigint_inbox_item_settlement::Column::IsUndefined,
            Expr::value(Option::<bool>::None),
        )
        .filter(Expr::exists(
            signal_message_group::Entity::find()
                .filter(
                    Expr::col((
                        signal_message_group::Entity,
                        signal_message_group::Column::SignalMessageId,
                    ))
                    .equals((
                        sigint_inbox_item_settlement::Entity,
                        sigint_inbox_item_settlement::Column::ItemId,
                    )),
                )
                .filter(
                    signal_message_group::Column::GroupMasterKey
                        .eq(group_master_key),
                )
                .select_only()
                .column(signal_message_group::Column::Id)
                .into_query(),
        ))
        .exec(dbx)
        .await
        .c(h!())?;
    Ok(())
}

pub async fn lock_updates<C>(dbx: &C) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    dbx.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "select pg_advisory_xact_lock($1)",
        [BATTLE_LINE_UPLOAD_ADVISORY_LOCK_KEY.into()],
    ))
    .await
    .c(h!())?;
    Ok(())
}

pub async fn refresh_aor_geometry<C>(dbx: &C, aor_id: i64) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    dbx.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
delete from battle_line_aor_geometry
where aor_id = $1
  and version_id in (
      select id from battle_line_version where retired_at is null
  )
        "#,
        [aor_id.into()],
    ))
    .await
    .c(h!())?;
    dbx.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        AOR_GEOMETRY_INSERT_SQL,
        [
            aor_id.into(),
            BATTLE_LINE_CLIP_EXTENT_METERS.into(),
            BATTLE_LINE_AOR_ANCHOR_LONGITUDE.into(),
            BATTLE_LINE_AOR_ANCHOR_LATITUDE.into(),
        ],
    ))
    .await
    .c(h!())?;
    Ok(())
}

const AOR_GEOMETRY_INSERT_SQL: &str = r#"
with input as (
    select
        bl.id as version_id,
        a.id as aor_id,
        ST_Transform(bl.geometry, 3857) as full_geometry,
        ST_Transform(ST_SetSRID(ST_MakePoint(a.left_lon, a.left_lat), 4326), 3857) as start_hint,
        ST_Transform(ST_SetSRID(ST_MakePoint(a.right_lon, a.right_lat), 4326), 3857) as end_hint,
        ST_Transform(ST_SetSRID(ST_MakePoint($3, $4), 4326), 3857) as anchor
    from battle_line_version bl
    join area_of_responsibility a on a.id = $1
    where bl.retired_at is null
      and not a.deleted
      and a.left_lat is not null
      and a.left_lon is not null
      and a.right_lat is not null
      and a.right_lon is not null
), snapped as (
    select
        version_id,
        aor_id,
        full_geometry,
        start_hint,
        end_hint,
        anchor,
        ST_ClosestPoint(full_geometry, start_hint) as snapped_start,
        ST_ClosestPoint(full_geometry, end_hint) as snapped_end
    from input
), directed as (
    select *,
        ST_X(start_hint) - ST_X(anchor) as start_dx,
        ST_Y(start_hint) - ST_Y(anchor) as start_dy,
        ST_X(end_hint) - ST_X(anchor) as end_dx,
        ST_Y(end_hint) - ST_Y(anchor) as end_dy,
        ST_Distance(anchor, start_hint) as start_length,
        ST_Distance(anchor, end_hint) as end_length,
        ST_Distance(snapped_start, snapped_end) as guide_length
    from snapped
), clipped as (
    select *, ST_SetSRID(ST_MakePolygon(ST_MakeLine(array[
        ST_MakePoint(ST_X(anchor), ST_Y(anchor)),
        ST_MakePoint(
            ST_X(anchor) + start_dx / start_length * $2,
            ST_Y(anchor) + start_dy / start_length * $2
        ),
        ST_MakePoint(
            ST_X(anchor) + end_dx / end_length * $2,
            ST_Y(anchor) + end_dy / end_length * $2
        ),
        ST_MakePoint(ST_X(anchor), ST_Y(anchor))
    ])), 3857) as span
    from directed
    where guide_length > 0.01
      and start_length > 0.01
      and end_length > 0.01
), geometry_parts as (
    select *,
        ST_Intersection(ST_CollectionExtract(full_geometry, 1), span) as clipped_points,
        ST_CollectionExtract(
            ST_Intersection(ST_CollectionExtract(full_geometry, 2), span),
            2
        ) as clipped_lines
    from clipped
), result as (
    select *, ST_ForceCollection(
        ST_Transform(ST_Collect(
            case when ST_IsEmpty(clipped_points) then null else clipped_points end,
            case when ST_IsEmpty(clipped_lines) then null else clipped_lines end
        ), 4326)
    ) as geometry
    from geometry_parts
)
insert into battle_line_aor_geometry
    (version_id, aor_id, geometry, snapped_start, snapped_end)
select
    version_id,
    aor_id,
    geometry,
    ST_Transform(snapped_start, 4326),
    ST_Transform(snapped_end, 4326)
from result
where not ST_IsEmpty(geometry)
"#;

pub async fn match_battle_line_candidates<C>(
    dbx: &C,
    candidates: &[BattleLineCandidatePoint],
    aor_ids: Option<&[i64]>,
) -> anyhow::Result<BattleLineMatchOutcome>
where
    C: ConnectionTrait,
{
    let ranked = rank_battle_line_candidates(dbx, candidates, aor_ids)
        .await
        .c(h!())?;
    Ok(BattleLineMatchOutcome {
        matched: ranked.ranked.first().map(|ranked| BattleLineMatch {
            candidate_index: ranked.candidate_index,
            distance_m: ranked.distance_m,
        }),
        invalid_aor_ids: ranked.invalid_aor_ids,
    })
}

async fn rank_battle_line_candidates<C>(
    dbx: &C,
    candidates: &[BattleLineCandidatePoint],
    aor_ids: Option<&[i64]>,
) -> anyhow::Result<BattleLineRankOutcome>
where
    C: ConnectionTrait,
{
    ensure_active_battle_line(dbx).await.c(h!())?;
    validate_candidate_points(candidates).c(h!())?;
    let requested_aor_ids = aor_ids
        .filter(|aor_ids| !aor_ids.is_empty())
        .map(|aor_ids| aor_ids.iter().copied().collect::<BTreeSet<_>>());
    let valid_aor_ids = match requested_aor_ids.as_ref() {
        Some(aor_ids) => load_valid_aor_ids(dbx, aor_ids).await.c(h!())?,
        None => BTreeSet::new(),
    };
    let invalid_aor_ids = requested_aor_ids
        .as_ref()
        .map(|requested| {
            requested.difference(&valid_aor_ids).copied().collect()
        })
        .unwrap_or_default();
    if requested_aor_ids.is_some() && valid_aor_ids.is_empty() {
        return Ok(BattleLineRankOutcome {
            ranked: vec![],
            invalid_aor_ids,
        });
    }
    if candidates.is_empty() {
        return Ok(BattleLineRankOutcome {
            ranked: vec![],
            invalid_aor_ids,
        });
    }
    let ranked = rank_candidate_distances(
        dbx,
        candidates,
        requested_aor_ids.as_ref().map(|_| &valid_aor_ids),
    )
    .await
    .c(h!())?;
    Ok(BattleLineRankOutcome {
        ranked,
        invalid_aor_ids,
    })
}

async fn load_valid_aor_ids<C>(
    dbx: &C,
    requested: &BTreeSet<i64>,
) -> anyhow::Result<BTreeSet<i64>>
where
    C: ConnectionTrait,
{
    Ok(battle_line_aor_geometry::Entity::find()
        .join(
            JoinType::InnerJoin,
            battle_line_aor_geometry::Relation::BattleLineVersion.def(),
        )
        .join(
            JoinType::InnerJoin,
            battle_line_aor_geometry::Relation::AreaOfResponsibility.def(),
        )
        .filter(battle_line_version::Column::RetiredAt.is_null())
        .filter(area_of_responsibility::Column::Deleted.eq(false))
        .filter(
            battle_line_aor_geometry::Column::AorId
                .is_in(requested.iter().copied()),
        )
        .select_only()
        .column(battle_line_aor_geometry::Column::AorId)
        .into_tuple::<i64>()
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .collect())
}

async fn rank_candidate_distances<C>(
    dbx: &C,
    candidates: &[BattleLineCandidatePoint],
    aor_ids: Option<&BTreeSet<i64>>,
) -> anyhow::Result<Vec<BattleLineCandidateDistance>>
where
    C: ConnectionTrait,
{
    let mut values = vec![];
    let selected_sql = if let Some(aor_ids) = aor_ids {
        values.push(aor_ids.iter().copied().collect::<Vec<_>>().into());
        let aor_ids_placeholder = values.len();
        format!(
            "select ST_Collect(geometry) as geometry from battle_line_aor_geometry where version_id = (select id from battle_line_version where retired_at is null) and aor_id = any(${aor_ids_placeholder}::bigint[])"
        )
    } else {
        "select geometry from battle_line_version where retired_at is null"
            .to_string()
    };
    let candidate_indices = candidates
        .iter()
        .enumerate()
        .map(|(index, _)| index as i64)
        .collect::<Vec<_>>();
    let longitudes = candidates
        .iter()
        .map(|candidate| candidate.lon)
        .collect::<Vec<_>>();
    let latitudes = candidates
        .iter()
        .map(|candidate| candidate.lat)
        .collect::<Vec<_>>();
    values.push(candidate_indices.into());
    let candidate_indices_placeholder = values.len();
    values.push(longitudes.into());
    let longitudes_placeholder = values.len();
    values.push(latitudes.into());
    let latitudes_placeholder = values.len();
    let sql = format!(
        r#"
with selected as ({selected_sql}),
components as (
    select (dumped).geom as geometry
    from selected
    cross join lateral ST_Dump(selected.geometry) as dumped
), candidates as (
    select
        candidate_index,
        lon,
        ST_SetSRID(ST_MakePoint(lon, lat), 4326) as geometry
    from unnest(
        ${candidate_indices_placeholder}::bigint[],
        ${longitudes_placeholder}::double precision[],
        ${latitudes_placeholder}::double precision[]
    ) as candidate(candidate_index, lon, lat)
)
select
    candidates.candidate_index,
    matched.distance_m,
    candidates.lon < matched.closest_lon as is_west
from candidates
cross join lateral (
    select
        ST_Distance(
            candidates.geometry::geography,
            components.geometry::geography
        ) as distance_m,
        ST_X(
            ST_ClosestPoint(components.geometry, candidates.geometry)
        ) as closest_lon
    from components
    order by distance_m, ST_AsEWKB(components.geometry)
    limit 1
) matched
order by distance_m, candidates.candidate_index
        "#
    );
    let rows = MatchRow::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        sql,
        values,
    ))
    .all(dbx)
    .await
    .c(h!())?;
    Ok(rows
        .into_iter()
        .map(|row| BattleLineCandidateDistance {
            candidate_index: row.candidate_index as usize,
            distance_m: row.distance_m,
            is_west: row.is_west,
        })
        .collect())
}

pub async fn resolve_inbox_item_aors<C>(
    dbx: &C,
    inbox_item_id: i64,
    allowed_groups: Option<&BTreeSet<String>>,
) -> anyhow::Result<InboxItemAorContext>
where
    C: ConnectionTrait,
{
    let mut group_master_keys = signal_message_group::Entity::find()
        .filter(signal_message_group::Column::SignalMessageId.eq(inbox_item_id))
        .filter(signal_message_group::Column::GroupMasterKey.is_not_null())
        .select_only()
        .column(signal_message_group::Column::GroupMasterKey)
        .into_tuple::<String>()
        .all(dbx)
        .await
        .c(h!())?;
    group_master_keys.sort();
    group_master_keys.dedup();
    if let Some(allowed_groups) = allowed_groups {
        group_master_keys.retain(|group| allowed_groups.contains(group));
    }
    let aor_ids = if group_master_keys.is_empty() {
        vec![]
    } else {
        signal_group_aor::Entity::find()
            .join(
                JoinType::InnerJoin,
                signal_group_aor::Relation::AreaOfResponsibility.def(),
            )
            .filter(
                signal_group_aor::Column::MasterKey
                    .is_in(group_master_keys.clone()),
            )
            .filter(area_of_responsibility::Column::Deleted.eq(false))
            .order_by_asc(signal_group_aor::Column::AorId)
            .select_only()
            .column(signal_group_aor::Column::AorId)
            .distinct()
            .into_tuple::<i64>()
            .all(dbx)
            .await
            .c(h!())?
    };
    Ok(InboxItemAorContext {
        group_master_keys,
        aor_ids,
    })
}

pub async fn resolve_location_to_settlement(
    env: &Env,
    location: String,
    aor_ids: &[i64],
) -> anyhow::Result<BattleLineLocationResult> {
    let mut results =
        resolve_locations_to_settlements(env, vec![location], aor_ids)
            .await
            .c(h!())?;
    results.pop().c(h!())
}

pub async fn resolve_locations_to_settlements(
    env: &Env,
    locations: Vec<String>,
    aor_ids: &[i64],
) -> anyhow::Result<Vec<BattleLineLocationResult>> {
    resolve_locations_to_settlements_with_db(
        &env.dbx,
        env.settlements.clone(),
        locations,
        aor_ids,
    )
    .await
    .c(h!())
}

pub(crate) async fn resolve_locations_to_settlements_with_db<C>(
    dbx: &C,
    settlements: Arc<RwLock<crate::location::SettlementsDataConfig>>,
    locations: Vec<String>,
    aor_ids: &[i64],
) -> anyhow::Result<Vec<BattleLineLocationResult>>
where
    C: ConnectionTrait,
{
    let mut results = resolve_location_groups_to_settlements_with_db(
        dbx,
        settlements,
        vec![locations],
        aor_ids,
    )
    .await
    .c(h!())?;
    results.pop().c(h!())
}

pub(crate) async fn resolve_location_groups_to_settlements_with_db<C>(
    dbx: &C,
    settlements: Arc<RwLock<crate::location::SettlementsDataConfig>>,
    location_groups: Vec<Vec<String>>,
    aor_ids: &[i64],
) -> anyhow::Result<Vec<Vec<BattleLineLocationResult>>>
where
    C: ConnectionTrait,
{
    let group_lengths =
        location_groups.iter().map(Vec::len).collect::<Vec<_>>();
    let locations = location_groups.into_iter().flatten().collect();
    let drafts =
        load_location_resolution_drafts(dbx, settlements, locations, aor_ids)
            .await
            .c(h!())?;
    let mut drafts = drafts.into_iter();
    Ok(group_lengths
        .into_iter()
        .map(|group_length| {
            drafts
                .by_ref()
                .take(group_length)
                .map(location_result_from_draft)
                .collect()
        })
        .collect())
}

async fn load_location_resolution_drafts<C>(
    dbx: &C,
    settlements: Arc<RwLock<crate::location::SettlementsDataConfig>>,
    locations: Vec<String>,
    aor_ids: &[i64],
) -> anyhow::Result<Vec<LocationResolutionDraft>>
where
    C: ConnectionTrait,
{
    let aor_scope = (!aor_ids.is_empty()).then_some(aor_ids);
    let candidates =
        load_settlement_candidates(dbx, settlements, &locations, aor_scope)
            .await
            .c(h!())?;
    let mut drafts = locations
        .into_iter()
        .zip(candidates)
        .map(|(location, candidates)| LocationResolutionDraft {
            location,
            candidates,
            battle_line_distances: BTreeMap::new(),
            chosen_candidate_index: None,
            invalid_aor_ids: vec![],
        })
        .collect::<Vec<_>>();
    apply_battle_line_distances(dbx, &mut drafts, aor_scope)
        .await
        .c(h!())?;
    Ok(drafts)
}

async fn load_settlement_candidates<C>(
    dbx: &C,
    settlements: Arc<RwLock<crate::location::SettlementsDataConfig>>,
    locations: &[String],
    aor_ids: Option<&[i64]>,
) -> anyhow::Result<Vec<Vec<BattleLineSettlementCandidate>>>
where
    C: ConnectionTrait,
{
    let mut candidates = vec![vec![]; locations.len()];
    let alias_candidates = locations
        .iter()
        .enumerate()
        .filter(|(location_index, location)| {
            candidates[*location_index].is_empty()
                && !normalize_settlement_name(location).is_empty()
        })
        .map(|(location_index, location)| {
            let settlements = crate::location::find_settlements_by_name_scope(
                settlements.clone(),
                location.clone(),
                None,
                None,
                aor_ids,
            )
            .c(h!())?;
            Ok((
                location_index,
                prefer_exact_settlement_names(location, settlements),
            ))
        })
        .collect::<anyhow::Result<Vec<_>>>()
        .c(h!())?;
    apply_canonical_alias_candidates(dbx, &mut candidates, alias_candidates)
        .await
        .c(h!())?;
    Ok(candidates)
}

async fn apply_canonical_alias_candidates<C>(
    dbx: &C,
    candidates: &mut [Vec<BattleLineSettlementCandidate>],
    alias_candidates: Vec<(
        usize,
        Vec<crate::location::types::SettlementDetails>,
    )>,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    let alias_coordinates = collect_alias_coordinates(alias_candidates);
    let rows = load_canonical_alias_rows(dbx, &alias_coordinates)
        .await
        .c(h!())?;
    append_canonical_alias_rows(candidates, rows).c(h!())?;
    Ok(())
}

fn collect_alias_coordinates(
    alias_candidates: Vec<(
        usize,
        Vec<crate::location::types::SettlementDetails>,
    )>,
) -> Vec<(usize, (f64, f64))> {
    alias_candidates
        .into_iter()
        .flat_map(|(location_index, settlements)| {
            settlements.into_iter().filter_map(move |settlement| {
                settlement
                    .coords
                    .map(|coordinate| (location_index, coordinate))
            })
        })
        .collect()
}

async fn load_canonical_alias_rows<C>(
    dbx: &C,
    alias_coordinates: &[(usize, (f64, f64))],
) -> anyhow::Result<Vec<CanonicalSettlementRow>>
where
    C: ConnectionTrait,
{
    if alias_coordinates.is_empty() {
        return Ok(vec![]);
    }
    let location_indices = alias_coordinates
        .iter()
        .map(|(location_index, _)| i64::try_from(*location_index).c(h!()))
        .collect::<anyhow::Result<Vec<_>>>()
        .c(h!())?;
    let latitudes = alias_coordinates
        .iter()
        .map(|(_, (lat, _))| *lat)
        .collect::<Vec<_>>();
    let longitudes = alias_coordinates
        .iter()
        .map(|(_, (_, lon))| *lon)
        .collect::<Vec<_>>();
    CanonicalSettlementRow::find_by_statement(
        Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
with candidates as (
    select
        ordinality as candidate_index,
        location_index,
        latitude,
        longitude
    from unnest($1::bigint[], $2::double precision[], $3::double precision[])
        with ordinality as candidate(location_index, latitude, longitude, ordinality)
)
select
    candidate.location_index,
    matched.id as settlement_id,
    matched.name,
    coalesce(matched.district, '') as district,
    coalesce(matched.region, '') as region,
    matched.lat,
    matched.lon
from candidates candidate
cross join lateral (
    select settlement.id, settlement.name, settlement.district,
        settlement.region, settlement.lat, settlement.lon
    from settlement
    where settlement.lat is not null
      and settlement.lon is not null
      and ST_DWithin(
          ST_SetSRID(ST_MakePoint(settlement.lon, settlement.lat), 4326)::geography,
          ST_SetSRID(ST_MakePoint(candidate.longitude, candidate.latitude), 4326)::geography,
          $4
      )
    order by
        ST_DistanceSphere(
            ST_SetSRID(ST_MakePoint(settlement.lon, settlement.lat), 4326),
            ST_SetSRID(ST_MakePoint(candidate.longitude, candidate.latitude), 4326)
        ),
        settlement.id
    limit 1
) matched
order by candidate.candidate_index
            "#,
            [
                location_indices.into(),
                latitudes.into(),
                longitudes.into(),
                BATTLE_LINE_SETTLEMENT_CANONICAL_MATCH_MAX_DISTANCE_METERS
                    .into(),
            ],
        ),
    )
    .all(dbx)
    .await
    .c(h!())
}

fn append_canonical_alias_rows(
    candidates: &mut [Vec<BattleLineSettlementCandidate>],
    rows: Vec<CanonicalSettlementRow>,
) -> anyhow::Result<()> {
    let mut seen = candidates
        .iter()
        .map(|candidates| {
            candidates
                .iter()
                .map(|candidate| candidate.settlement_id)
                .collect::<BTreeSet<_>>()
        })
        .collect::<Vec<_>>();
    for row in rows {
        let location_index = usize::try_from(row.location_index).c(h!())?;
        if !seen
            .get_mut(location_index)
            .c(h!())?
            .insert(row.settlement_id)
        {
            continue;
        }
        candidates.get_mut(location_index).c(h!())?.push(
            BattleLineSettlementCandidate {
                settlement_id: row.settlement_id,
                name: row.name,
                district: row.district,
                region: row.region,
                coordinate: BattleLineCoordinate {
                    lat: row.lat,
                    lon: row.lon,
                },
            },
        );
    }
    Ok(())
}

fn prefer_exact_settlement_names(
    location: &str,
    mut settlements: Vec<crate::location::types::SettlementDetails>,
) -> Vec<crate::location::types::SettlementDetails> {
    let location = normalize_settlement_name(location);
    if settlements.iter().any(|settlement| {
        normalize_settlement_name(&settlement.name) == location
    }) {
        settlements.retain(|settlement| {
            normalize_settlement_name(&settlement.name) == location
        });
    }
    settlements
}

async fn apply_battle_line_distances<C>(
    dbx: &C,
    drafts: &mut [LocationResolutionDraft],
    aor_ids: Option<&[i64]>,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    if drafts.is_empty() {
        return Ok(());
    }
    let candidate_locations = drafts
        .iter()
        .enumerate()
        .flat_map(|(location_index, draft)| {
            draft.candidates.iter().enumerate().map(
                move |(candidate_index, candidate)| {
                    (
                        location_index,
                        candidate_index,
                        BattleLineCandidatePoint {
                            lat: candidate.coordinate.lat,
                            lon: candidate.coordinate.lon,
                        },
                    )
                },
            )
        })
        .collect::<Vec<_>>();
    let points = candidate_locations
        .iter()
        .map(|(_, _, point)| point.clone())
        .collect::<Vec<_>>();
    let ranked = rank_battle_line_candidates(dbx, &points, aor_ids)
        .await
        .c(h!())?;
    for draft in drafts.iter_mut() {
        draft.invalid_aor_ids = ranked.invalid_aor_ids.clone();
    }
    for distance in ranked.ranked {
        let (location_index, candidate_index, _) =
            candidate_locations.get(distance.candidate_index).c(h!())?;
        let draft = drafts.get_mut(*location_index).c(h!())?;
        draft
            .battle_line_distances
            .insert(*candidate_index, distance);
        if draft.chosen_candidate_index.is_none() {
            draft.chosen_candidate_index = Some(*candidate_index);
        }
    }
    Ok(())
}

fn location_result_from_draft(
    draft: LocationResolutionDraft,
) -> BattleLineLocationResult {
    let (chosen_settlement_id, distance_m) = draft
        .chosen_candidate_index
        .and_then(|candidate_index| {
            let candidate = draft.candidates.get(candidate_index)?;
            let matched = draft.battle_line_distances.get(&candidate_index)?;
            let max_distance_m = settlement_max_distance_m(matched.is_west);
            if matched.distance_m > max_distance_m {
                warn!(
                    "Skipping incorrect inbox settlement mapping: location={:?}, settlement_id={}, settlement={:?}, region={:?}, side={}, distance_m={:.0}, max_distance_m={:.0}",
                    draft.location,
                    candidate.settlement_id,
                    candidate.name,
                    candidate.region,
                    if matched.is_west { "west" } else { "east" },
                    matched.distance_m,
                    max_distance_m,
                );
                return Some((None, Some(matched.distance_m)));
            }
            Some((Some(candidate.settlement_id), Some(matched.distance_m)))
        })
        .unwrap_or((None, None));
    BattleLineLocationResult {
        location: draft.location,
        candidates: draft.candidates,
        chosen_settlement_id,
        distance_m,
        invalid_aor_ids: draft.invalid_aor_ids,
    }
}

fn settlement_max_distance_m(is_west: bool) -> f64 {
    if is_west {
        BATTLE_LINE_SETTLEMENT_MAX_DISTANCE_WEST_METERS
    } else {
        BATTLE_LINE_SETTLEMENT_MAX_DISTANCE_EAST_METERS
    }
}

fn normalize_settlement_name(name: &str) -> String {
    name.trim().to_uppercase().replace(['\'', 'ʼ', '`'], "’")
}

async fn read_battle_line_state<C>(dbx: &C) -> anyhow::Result<BattleLineState>
where
    C: ConnectionTrait,
{
    let active = VersionRow::find_by_statement(Statement::from_string(
        DatabaseBackend::Postgres,
        format!("{VERSION_SELECT_SQL} where bl.retired_at is null limit 1"),
    ))
    .one(dbx)
    .await
    .c(h!())?;
    let previous = VersionRow::find_by_statement(Statement::from_string(
        DatabaseBackend::Postgres,
        VERSION_HISTORY_SELECT_SQL,
    ))
    .all(dbx)
    .await
    .c(h!())?;
    let aor_geometries = if active.is_some() {
        AorGeometryRow::find_by_statement(Statement::from_string(
            DatabaseBackend::Postgres,
            r#"
select
    bag.aor_id,
    a.name as aor_name,
    ST_AsGeoJSON(bag.geometry)::jsonb as geometry_geojson,
    ST_AsGeoJSON(bag.snapped_start)::jsonb as snapped_start_geojson,
    ST_AsGeoJSON(bag.snapped_end)::jsonb as snapped_end_geojson
from battle_line_aor_geometry bag
join battle_line_version bl on bl.id = bag.version_id and bl.retired_at is null
join area_of_responsibility a on a.id = bag.aor_id and not a.deleted
order by bag.aor_id
            "#,
        ))
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(aor_geometry_from_row)
        .collect::<anyhow::Result<Vec<_>>>()
        .c(h!())?
    } else {
        vec![]
    };
    let active_features = active
        .as_ref()
        .and_then(|row| row.geometry_geojson.as_ref())
        .map(features_from_geojson)
        .transpose()
        .c(h!())?
        .unwrap_or_default();
    Ok(BattleLineState {
        active_version: active.as_ref().map(version_summary),
        active_features,
        aor_geometries,
        previous_versions: previous.iter().map(version_summary).collect(),
    })
}

const VERSION_SELECT_SQL: &str = r#"
select
    bl.id,
    bl.source_file_name,
    l.login as uploader_login,
    bl.uploaded_at,
    bl.retired_at,
    ST_AsGeoJSON(bl.geometry)::jsonb as geometry_geojson
from battle_line_version bl
join login l on l.id = bl.uploaded_by_login_id
"#;

const VERSION_HISTORY_SELECT_SQL: &str = r#"
select
    bl.id,
    bl.source_file_name,
    l.login as uploader_login,
    bl.uploaded_at,
    bl.retired_at,
    null::jsonb as geometry_geojson
from battle_line_version bl
join login l on l.id = bl.uploaded_by_login_id
where bl.retired_at is not null
order by bl.uploaded_at desc, bl.id desc
"#;

fn version_summary(row: &VersionRow) -> BattleLineVersionSummary {
    BattleLineVersionSummary {
        id: row.id,
        source_file_name: row.source_file_name.clone(),
        uploader_login: row.uploader_login.clone(),
        uploaded_at_ts: row.uploaded_at.and_utc().timestamp_millis(),
        retired_at_ts: row
            .retired_at
            .map(|retired_at| retired_at.and_utc().timestamp_millis()),
    }
}

fn aor_geometry_from_row(
    row: AorGeometryRow,
) -> anyhow::Result<BattleLineAorGeometry> {
    Ok(BattleLineAorGeometry {
        aor_id: row.aor_id,
        aor_name: row.aor_name,
        features: features_from_geojson(&row.geometry_geojson).c(h!())?,
        snapped_start: point_from_geojson(&row.snapped_start_geojson)
            .c(h!())?,
        snapped_end: point_from_geojson(&row.snapped_end_geojson).c(h!())?,
    })
}

fn features_to_wkt(
    features: &[ImportedGeometryFeature],
) -> anyhow::Result<String> {
    let features = features
        .iter()
        .map(|feature| match feature {
            ImportedGeometryFeature::Point(coordinate) => {
                validate_coordinate(coordinate).map(|_| {
                    format!("POINT({} {})", coordinate.lon, coordinate.lat)
                })
            }
            ImportedGeometryFeature::LineString(coordinates) => {
                line_string_to_wkt(coordinates)
            }
        })
        .collect::<anyhow::Result<Vec<_>>>()
        .c(h!())?;
    if features.is_empty() {
        anyhow::bail!(
            "The uploaded file contains no valid Point or LineString geometry"
        );
    }
    Ok(format!("GEOMETRYCOLLECTION({})", features.join(",")))
}

fn summarize_features(
    features: &[ImportedGeometryFeature],
) -> anyhow::Result<BattleLineImportSummary> {
    let mut point_count = 0;
    let mut line_string_count = 0;
    let mut zero_length_line_string_count = 0;
    let mut coordinate_count = 0;
    let mut bounds = None;
    for feature in features {
        match feature {
            ImportedGeometryFeature::Point(coordinate) => {
                validate_coordinate(coordinate).c(h!())?;
                point_count += 1;
                coordinate_count += 1;
                extend_import_bounds(&mut bounds, coordinate);
            }
            ImportedGeometryFeature::LineString(coordinates) => {
                for coordinate in coordinates {
                    validate_coordinate(coordinate).c(h!())?;
                }
                line_string_count += 1;
                if !line_has_length(coordinates) {
                    zero_length_line_string_count += 1;
                }
                coordinate_count += coordinates.len();
                for coordinate in coordinates {
                    extend_import_bounds(&mut bounds, coordinate);
                }
            }
        }
    }
    Ok(BattleLineImportSummary {
        point_count,
        line_string_count,
        empty_point_count: 0,
        empty_line_string_count: 0,
        zero_length_line_string_count,
        coordinate_count,
        bounds: bounds
            .context("Battle Line contains no coordinates")
            .context(h!())?,
    })
}

fn extend_import_bounds(
    bounds: &mut Option<BattleLineImportBounds>,
    coordinate: &ImportedCoordinate,
) {
    match bounds {
        Some(bounds) => {
            bounds.min_lat = bounds.min_lat.min(coordinate.lat);
            bounds.min_lon = bounds.min_lon.min(coordinate.lon);
            bounds.max_lat = bounds.max_lat.max(coordinate.lat);
            bounds.max_lon = bounds.max_lon.max(coordinate.lon);
        }
        None => {
            *bounds = Some(BattleLineImportBounds {
                min_lat: coordinate.lat,
                min_lon: coordinate.lon,
                max_lat: coordinate.lat,
                max_lon: coordinate.lon,
            });
        }
    }
}

fn line_string_to_wkt(
    coordinates: &[ImportedCoordinate],
) -> anyhow::Result<String> {
    for coordinate in coordinates {
        validate_coordinate(coordinate).c(h!())?;
    }
    if !line_has_length(coordinates) {
        let coordinate = coordinates.first().c(h!())?;
        warn!(
            "Poorly supported zero-length LineString geometry was replaced with a Point at {}, {}",
            coordinate.lon, coordinate.lat
        );
        return Ok(format!("POINT({} {})", coordinate.lon, coordinate.lat));
    }
    Ok(format!(
        "LINESTRING({})",
        coordinates
            .iter()
            .map(|coordinate| format!("{} {}", coordinate.lon, coordinate.lat))
            .collect::<Vec<_>>()
            .join(",")
    ))
}

fn validate_coordinate(coordinate: &ImportedCoordinate) -> anyhow::Result<()> {
    if !coordinate.lat.is_finite()
        || !coordinate.lon.is_finite()
        || !(-90.0..=90.0).contains(&coordinate.lat)
        || !(-180.0..=180.0).contains(&coordinate.lon)
    {
        anyhow::bail!(
            "Invalid WGS84 coordinate: {}, {}",
            coordinate.lat,
            coordinate.lon
        );
    }
    Ok(())
}

fn validate_candidate_points(
    candidates: &[BattleLineCandidatePoint],
) -> anyhow::Result<()> {
    for candidate in candidates {
        validate_coordinate(&ImportedCoordinate {
            lat: candidate.lat,
            lon: candidate.lon,
        })
        .c(h!())?;
    }
    Ok(())
}

fn line_has_length(coordinates: &[ImportedCoordinate]) -> bool {
    coordinates
        .windows(2)
        .any(|pair| pair[0].lat != pair[1].lat || pair[0].lon != pair[1].lon)
}

fn features_from_geojson(
    geometry: &JsonValue,
) -> anyhow::Result<Vec<BattleLineFeature>> {
    let mut features = vec![];
    append_geojson_features(geometry, &mut features).c(h!())?;
    Ok(features)
}

fn append_geojson_features(
    geometry: &JsonValue,
    features: &mut Vec<BattleLineFeature>,
) -> anyhow::Result<()> {
    let geometry_type = geometry["type"].as_str().c(h!())?;
    match geometry_type {
        "GeometryCollection" => {
            for geometry in geometry["geometries"].as_array().c(h!())? {
                append_geojson_features(geometry, features).c(h!())?;
            }
        }
        "Point" => {
            let coordinates = geometry["coordinates"].as_array().c(h!())?;
            if !coordinates.is_empty() {
                features.push(BattleLineFeature {
                    kind: "Point".to_string(),
                    coordinates: vec![coordinate_from_json(
                        &geometry["coordinates"],
                    )
                    .c(h!())?],
                });
            }
        }
        "LineString" => features.push(BattleLineFeature {
            kind: "LineString".to_string(),
            coordinates: coordinates_from_json(&geometry["coordinates"])
                .c(h!())?,
        }),
        "MultiPoint" => {
            for coordinate in geometry["coordinates"].as_array().c(h!())? {
                features.push(BattleLineFeature {
                    kind: "Point".to_string(),
                    coordinates: vec![coordinate_from_json(coordinate).c(h!())?],
                });
            }
        }
        "MultiLineString" => {
            for coordinates in geometry["coordinates"].as_array().c(h!())? {
                features.push(BattleLineFeature {
                    kind: "LineString".to_string(),
                    coordinates: coordinates_from_json(coordinates).c(h!())?,
                });
            }
        }
        other => {
            anyhow::bail!("Unsupported Battle Line GeoJSON geometry: {other}")
        }
    }
    Ok(())
}

fn coordinates_from_json(
    value: &JsonValue,
) -> anyhow::Result<Vec<BattleLineCoordinate>> {
    value
        .as_array()
        .c(h!())?
        .iter()
        .map(coordinate_from_json)
        .collect::<anyhow::Result<Vec<_>>>()
        .c(h!())
}

fn coordinate_from_json(
    value: &JsonValue,
) -> anyhow::Result<BattleLineCoordinate> {
    let values = value.as_array().c(h!())?;
    Ok(BattleLineCoordinate {
        lon: values.first().and_then(JsonValue::as_f64).c(h!())?,
        lat: values.get(1).and_then(JsonValue::as_f64).c(h!())?,
    })
}

fn point_from_geojson(
    geometry: &JsonValue,
) -> anyhow::Result<BattleLineCoordinate> {
    if geometry["type"] != "Point" {
        anyhow::bail!("Expected Point geometry");
    }
    coordinate_from_json(&geometry["coordinates"]).c(h!())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn insert_test_settlement(
        txn: &DatabaseTransaction,
        id: i32,
        name: &str,
        lat: f64,
        lon: f64,
    ) -> anyhow::Result<()> {
        use crate::entities::sea_orm_active_enums::SettlementKind;

        settlement::ActiveModel {
            id: Set(id),
            kind: Set(SettlementKind::Village),
            name: Set(name.to_string()),
            district: Set(Some("#2287 DISTRICT".to_string())),
            region: Set(Some("#2287 REGION".to_string())),
            lat: Set(Some(lat)),
            lon: Set(Some(lon)),
            ..Default::default()
        }
        .insert(txn)
        .await
        .c(h!())?;
        Ok(())
    }

    fn test_settlements_for_aor(
        aor_id: i64,
        settlements: Vec<crate::location::types::SettlementDetails>,
    ) -> Arc<RwLock<crate::location::SettlementsDataConfig>> {
        let settlements_by_id = settlements
            .iter()
            .map(|settlement| (settlement.id.unwrap(), settlement.clone()))
            .collect();
        let mut settlements_by_name = BTreeMap::new();
        for settlement in settlements {
            settlements_by_name
                .entry(settlement.name.clone())
                .or_insert_with(Vec::new)
                .push(settlement);
        }
        let settlements_data = Arc::new((
            vec![],
            vec![],
            crate::location::trie::Trie::new(),
            settlements_by_id,
            settlements_by_name,
        ));
        let mut config = crate::location::SettlementsDataConfig::default();
        config
            .aor_id_to_settlements_data
            .insert(aor_id, settlements_data);
        Arc::new(RwLock::new(config))
    }

    async fn insert_test_battle_line_segment(
        txn: &DatabaseTransaction,
    ) -> anyhow::Result<i64> {
        txn.execute_unprepared(
            "update battle_line_version set retired_at = now() at time zone 'utc' where retired_at is null",
        )
        .await
        .c(h!())?;
        let aor_id = area_of_responsibility::Entity::find()
            .filter(area_of_responsibility::Column::Deleted.eq(false))
            .select_only()
            .column(area_of_responsibility::Column::Id)
            .into_tuple::<i64>()
            .one(txn)
            .await
            .c(h!())?
            .context("test database must contain an AOR")
            .context(h!())?;
        let row = txn
            .query_one_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                r#"
insert into battle_line_version
    (geometry, source_file_name, uploaded_by_login_id, source_kind, source_sha256)
select
    ST_GeomFromText('GEOMETRYCOLLECTION(LINESTRING(0 0,10 0))', 4326),
    'independent-resolution-test.kml',
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
            .c(h!())?
            .context("test database must contain a login")
            .context(h!())?;
        let version_id: i64 = row.try_get("", "id").c(h!())?;
        txn.execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
insert into battle_line_aor_geometry
    (version_id, aor_id, geometry, snapped_start, snapped_end)
values (
    $1,
    $2,
    ST_GeomFromText('GEOMETRYCOLLECTION(LINESTRING(0 0,10 0))', 4326),
    ST_SetSRID(ST_MakePoint(0, 0), 4326),
    ST_SetSRID(ST_MakePoint(10, 0), 4326)
)
            "#,
            [version_id.into(), aor_id.into()],
        ))
        .await
        .c(h!())?;
        Ok(aor_id)
    }

    async fn insert_network_map_item(
        txn: &DatabaseTransaction,
        group_master_key: &str,
        network_id: i64,
        settlement_id: i32,
        datetime: NaiveDateTime,
        peleng: (f64, f64),
    ) -> anyhow::Result<()> {
        let message = crate::functest::tests::mk_signal_message(
            txn,
            signal_message::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .c(h!())?;
        crate::functest::tests::mk_signal_message_group(
            txn,
            signal_message_group::ActiveModel {
                signal_message_id: Set(message.id),
                group_master_key: Set(Some(group_master_key.to_string())),
                datasource_group_id: Set(None),
                ..Default::default()
            },
        )
        .await
        .c(h!())?;
        crate::functest::tests::mk_sigint_inbox_item(
            txn,
            sigint_inbox_item::ActiveModel {
                id: Set(message.id),
                datetime: Set(Some(datetime)),
                ..Default::default()
            },
        )
        .await
        .c(h!())?;
        crate::functest::tests::mk_sigint_inbox_item_network(
            txn,
            sigint_inbox_item_network::ActiveModel {
                sigint_inbox_item_id: Set(message.id),
                sigint_network_id: Set(network_id),
                ..Default::default()
            },
        )
        .await
        .c(h!())?;
        sigint_inbox_item_settlement::ActiveModel {
            item_id: Set(message.id),
            settlement_text: Set(format!("settlement-{settlement_id}")),
            settlement_id: Set(Some(settlement_id)),
            is_undefined: Set(None),
            ..Default::default()
        }
        .insert(txn)
        .await
        .c(h!())?;
        crate::functest::tests::mk_sigint_peleng(
            txn,
            sigint_peleng::ActiveModel {
                source_inbox_item_id: Set(message.id),
                lat: Set(peleng.0),
                lng: Set(peleng.1),
                ..Default::default()
            },
        )
        .await
        .c(h!())?;
        Ok(())
    }

    // Regression: https://github.com/echoua/echo/issues/2287
    #[tokio::test]
    #[serial_test::serial]
    async fn paginates_units_by_newest_live_network_and_maps_live_points() {
        let config =
            crate::config::read_config(crate::types::Mode::Test).unwrap();
        let dbx = crate::new_pg_pool_from_config(&config).await.unwrap();
        let txn = dbx.begin().await.unwrap();
        let now = Utc::now().naive_utc();
        let group = crate::functest::tests::mk_signal_group(
            &txn,
            signal_group::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let other_group = crate::functest::tests::mk_signal_group(
            &txn,
            signal_group::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let mut units = Vec::new();
        for index in 0..7 {
            units.push(
                crate::functest::tests::mk_sigint_unit(
                    &txn,
                    sigint_unit::ActiveModel {
                        name: Set(format!("#2287 map unit {index}")),
                        created_at: Set(now
                            + chrono::Duration::days(1)
                            + chrono::Duration::seconds(index)),
                        ..Default::default()
                    },
                )
                .await
                .unwrap(),
            );
        }
        let network = crate::functest::tests::mk_sigint_network(
            &txn,
            sigint_network::ActiveModel {
                name: Set("#2287 map network".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        for unit in &units[..6] {
            crate::functest::tests::mk_sigint_network_unit(
                &txn,
                sigint_network_unit::ActiveModel {
                    network_id: Set(network.id),
                    unit_id: Set(unit.id),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        }
        let newest_network = crate::functest::tests::mk_sigint_network(
            &txn,
            sigint_network::ActiveModel {
                name: Set("#2287 newest map network".to_string()),
                created_at: Set(now + chrono::Duration::days(2)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        crate::functest::tests::mk_sigint_network_unit(
            &txn,
            sigint_network_unit::ActiveModel {
                network_id: Set(newest_network.id),
                unit_id: Set(units[0].id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let archived_network = crate::functest::tests::mk_sigint_network(
            &txn,
            sigint_network::ActiveModel {
                name: Set("#2287 archived map network".to_string()),
                created_at: Set(now + chrono::Duration::days(3)),
                active_to: Set(Some(now)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        for unit in [&units[0], &units[6]] {
            crate::functest::tests::mk_sigint_network_unit(
                &txn,
                sigint_network_unit::ActiveModel {
                    network_id: Set(archived_network.id),
                    unit_id: Set(unit.id),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        }
        insert_test_settlement(&txn, 2_287_301, "Recent", 48.1, 35.2)
            .await
            .unwrap();
        insert_test_settlement(&txn, 2_287_302, "Old", 47.1, 34.2)
            .await
            .unwrap();
        insert_test_settlement(&txn, 2_287_303, "Inaccessible", 46.1, 33.2)
            .await
            .unwrap();
        insert_test_settlement(&txn, 2_287_304, "Invalid", 95.0, 190.0)
            .await
            .unwrap();
        insert_test_settlement(&txn, 2_287_305, "Future", 45.1, 32.2)
            .await
            .unwrap();
        insert_test_settlement(&txn, 2_287_306, "Archived", 44.1, 31.2)
            .await
            .unwrap();
        insert_network_map_item(
            &txn,
            &group.master_key,
            network.id,
            2_287_301,
            now - chrono::Duration::days(1),
            (48.3, 35.4),
        )
        .await
        .unwrap();
        insert_network_map_item(
            &txn,
            &group.master_key,
            network.id,
            2_287_301,
            now - chrono::Duration::days(1),
            (48.3, 35.4),
        )
        .await
        .unwrap();
        insert_network_map_item(
            &txn,
            &other_group.master_key,
            network.id,
            2_287_303,
            now - chrono::Duration::days(1),
            (46.3, 33.4),
        )
        .await
        .unwrap();
        insert_network_map_item(
            &txn,
            &group.master_key,
            network.id,
            2_287_304,
            now - chrono::Duration::days(1),
            (95.0, 190.0),
        )
        .await
        .unwrap();
        insert_network_map_item(
            &txn,
            &group.master_key,
            network.id,
            2_287_302,
            now - chrono::Duration::days(8),
            (47.3, 34.4),
        )
        .await
        .unwrap();
        insert_network_map_item(
            &txn,
            &group.master_key,
            network.id,
            2_287_305,
            now + chrono::Duration::days(1),
            (45.3, 32.4),
        )
        .await
        .unwrap();
        insert_network_map_item(
            &txn,
            &group.master_key,
            archived_network.id,
            2_287_306,
            now - chrono::Duration::days(1),
            (44.3, 31.4),
        )
        .await
        .unwrap();

        let first = read_network_maps(&txn, &[group.master_key], 1, now)
            .await
            .unwrap();
        assert_eq!(first.page_size, 5);
        assert_eq!(first.items.len(), 5);
        assert_eq!(
            first
                .items
                .iter()
                .map(|item| item.unit_id)
                .collect::<Vec<_>>(),
            vec![
                units[0].id,
                units[5].id,
                units[4].id,
                units[3].id,
                units[2].id,
            ]
        );
        assert_eq!(
            first.items[0].settlement_points,
            vec![BattleLineNetworkMapPoint {
                lat: 48.1,
                lon: 35.2,
            }]
        );
        assert_eq!(
            first.items[0].peleng_points,
            vec![BattleLineNetworkMapPoint {
                lat: 48.3,
                lon: 35.4,
            }]
        );
        let second = read_network_maps(&txn, &[], 2, now).await.unwrap();
        assert_eq!(second.items[0].unit_id, units[1].id);
        assert!(second.total >= 6);
        txn.rollback().await.unwrap();
    }

    #[test]
    fn keeps_disconnected_features_in_wkt_order() {
        let features = vec![
            ImportedGeometryFeature::Point(ImportedCoordinate {
                lat: 49.0,
                lon: 31.0,
            }),
            ImportedGeometryFeature::LineString(vec![
                ImportedCoordinate {
                    lat: 49.0,
                    lon: 31.0,
                },
                ImportedCoordinate {
                    lat: 50.0,
                    lon: 32.0,
                },
            ]),
        ];
        assert_eq!(
            features_to_wkt(&features).unwrap(),
            "GEOMETRYCOLLECTION(POINT(31 49),LINESTRING(31 49,32 50))"
        );
    }

    #[test]
    fn summarizes_point_and_line_features() {
        let features = vec![
            ImportedGeometryFeature::Point(ImportedCoordinate {
                lat: 49.0,
                lon: 31.0,
            }),
            ImportedGeometryFeature::LineString(vec![
                ImportedCoordinate {
                    lat: 48.0,
                    lon: 30.0,
                },
                ImportedCoordinate {
                    lat: 50.0,
                    lon: 33.0,
                },
            ]),
        ];

        assert_eq!(
            summarize_features(&features).unwrap(),
            BattleLineImportSummary {
                point_count: 1,
                line_string_count: 1,
                empty_point_count: 0,
                empty_line_string_count: 0,
                zero_length_line_string_count: 0,
                coordinate_count: 3,
                bounds: BattleLineImportBounds {
                    min_lat: 48.0,
                    min_lon: 30.0,
                    max_lat: 50.0,
                    max_lon: 33.0,
                },
            }
        );
    }

    #[tokio::test]
    async fn cleans_features_before_storing_geometry() {
        let kml = br#"<kml><Document><Placemark><MultiGeometry>
<Point><coordinates>31,49,0</coordinates></Point>
<LineString><coordinates>32,50,0 32,50,0</coordinates></LineString>
<LineString><coordinates>31,49,0 32,50,0</coordinates></LineString>
</MultiGeometry></Placemark></Document></kml>"#;
        let prepared =
            prepare_battle_line_import("legacy.kml", kml).await.unwrap();

        assert_eq!(prepared.summary.point_count, 0);
        assert_eq!(prepared.summary.line_string_count, 1);
        assert_eq!(prepared.summary.zero_length_line_string_count, 0);
        assert_eq!(prepared.summary.coordinate_count, 2);
        assert_eq!(prepared.source_summary.point_count, 1);
        assert_eq!(prepared.source_summary.line_string_count, 2);
        assert_eq!(prepared.source_summary.zero_length_line_string_count, 1);
        assert_eq!(prepared.cleanup_stats.removed_point_count, 1);
        assert_eq!(prepared.cleanup_stats.removed_short_line_string_count, 1);
        assert_eq!(prepared.cleanup_stats.removed_duplicate_segment_count, 0);
        assert_eq!(
            prepared.geometry_wkt,
            "GEOMETRYCOLLECTION(LINESTRING(31 49,32 50))"
        );
    }

    #[test]
    fn rejects_empty_geometry_and_replaces_degenerate_line_with_point() {
        assert!(features_to_wkt(&[]).is_err());
        assert_eq!(
            features_to_wkt(&[
                ImportedGeometryFeature::Point(ImportedCoordinate {
                    lat: 50.0,
                    lon: 32.0,
                }),
                ImportedGeometryFeature::LineString(vec![
                    ImportedCoordinate {
                        lat: 49.0,
                        lon: 31.0,
                    };
                    2
                ]),
            ])
            .unwrap(),
            "GEOMETRYCOLLECTION(POINT(32 50),POINT(31 49))"
        );
    }

    #[test]
    fn ignores_empty_point_geojson_2287() {
        let geometry = serde_json::json!({
            "type": "GeometryCollection",
            "geometries": [
                { "type": "Point", "coordinates": [] },
                {
                    "type": "LineString",
                    "coordinates": [[31.0, 49.0], [32.0, 50.0]]
                }
            ]
        });

        assert_eq!(
            features_from_geojson(&geometry).unwrap(),
            vec![BattleLineFeature {
                kind: "LineString".to_string(),
                coordinates: vec![
                    BattleLineCoordinate {
                        lat: 49.0,
                        lon: 31.0,
                    },
                    BattleLineCoordinate {
                        lat: 50.0,
                        lon: 32.0,
                    },
                ],
            }]
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn maps_configured_aliases_to_canonical_database_settlements() {
        let config =
            crate::config::read_config(crate::types::Mode::Test).unwrap();
        let dbx = crate::new_pg_pool_from_config(&config).await.unwrap();
        let txn = dbx.begin().await.unwrap();
        let suffix = uuid::Uuid::now_v7();
        let alias_name = format!("#2287 ALIAS {suffix}").to_uppercase();
        let canonical_name = format!("#2287 CANONICAL {suffix}");
        let canonical_id = 2_287_203;
        insert_test_settlement(&txn, canonical_id, &canonical_name, 10.0, 10.0)
            .await
            .unwrap();
        let alias = crate::location::types::SettlementDetails {
            id: Some(6_615_355),
            name: alias_name.clone(),
            region: "#2287 ALIAS REGION".to_string(),
            language: crate::location::types::Language::Ru,
            coords: Some((10.005, 10.005)),
        };
        let mut settlements_by_id = BTreeMap::new();
        settlements_by_id.insert(alias.id.unwrap(), alias.clone());
        let mut settlements_by_name = BTreeMap::new();
        settlements_by_name.insert(alias.name.clone(), vec![alias]);
        let settlements_data = (
            vec![],
            vec![],
            crate::location::trie::Trie::new(),
            settlements_by_id,
            settlements_by_name,
        );
        let settlements =
            Arc::new(RwLock::new(crate::location::SettlementsDataConfig {
                default_settlements_data: Arc::new(settlements_data),
                ..Default::default()
            }));
        let candidates = load_settlement_candidates(
            &txn,
            settlements,
            std::slice::from_ref(&alias_name),
            None,
        )
        .await
        .unwrap();

        assert_eq!(candidates[0][0].settlement_id, canonical_id);
        txn.rollback().await.unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn restricts_database_matches_to_aor_settlement_catalog() {
        let config =
            crate::config::read_config(crate::types::Mode::Test).unwrap();
        let dbx = crate::new_pg_pool_from_config(&config).await.unwrap();
        let txn = dbx.begin().await.unwrap();
        let suffix = uuid::Uuid::now_v7();
        let settlement_name = format!("#2287 SCOPED {suffix}").to_uppercase();
        insert_test_settlement(&txn, 2_287_204, &settlement_name, 10.0, 10.0)
            .await
            .unwrap();
        insert_test_settlement(&txn, 2_287_205, &settlement_name, 20.0, 20.0)
            .await
            .unwrap();
        let scoped_settlement = crate::location::types::SettlementDetails {
            id: Some(6_615_356),
            name: settlement_name.clone(),
            region: "#2287 SCOPED REGION".to_string(),
            language: crate::location::types::Language::Ua,
            coords: Some((20.0, 20.0)),
        };
        let mut settlements_by_id = BTreeMap::new();
        settlements_by_id
            .insert(scoped_settlement.id.unwrap(), scoped_settlement.clone());
        let mut settlements_by_name = BTreeMap::new();
        settlements_by_name
            .insert(scoped_settlement.name.clone(), vec![scoped_settlement]);
        let settlements_data = Arc::new((
            vec![],
            vec![],
            crate::location::trie::Trie::new(),
            settlements_by_id,
            settlements_by_name,
        ));
        let mut settlements_config =
            crate::location::SettlementsDataConfig::default();
        settlements_config
            .aor_id_to_settlements_data
            .insert(2_287, settlements_data);

        let candidates = load_settlement_candidates(
            &txn,
            Arc::new(RwLock::new(settlements_config)),
            std::slice::from_ref(&settlement_name),
            Some(&[2_287]),
        )
        .await
        .unwrap();

        assert_eq!(candidates[0].len(), 1);
        assert_eq!(candidates[0][0].settlement_id, 2_287_205);
        txn.rollback().await.unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn restricts_database_matches_to_default_settlement_catalog_2287() {
        let config =
            crate::config::read_config(crate::types::Mode::Test).unwrap();
        let dbx = crate::new_pg_pool_from_config(&config).await.unwrap();
        let txn = dbx.begin().await.unwrap();
        let suffix = uuid::Uuid::now_v7();
        let settlement_name = format!("#2287 DEFAULT {suffix}").to_uppercase();
        insert_test_settlement(&txn, 2_287_206, &settlement_name, 10.0, 10.0)
            .await
            .unwrap();
        insert_test_settlement(&txn, 2_287_207, &settlement_name, 20.0, 20.0)
            .await
            .unwrap();
        let default_settlement = crate::location::types::SettlementDetails {
            id: Some(6_615_357),
            name: settlement_name.clone(),
            region: "#2287 DEFAULT REGION".to_string(),
            language: crate::location::types::Language::Ua,
            coords: Some((20.0, 20.0)),
        };
        let mut settlements_by_id = BTreeMap::new();
        settlements_by_id
            .insert(default_settlement.id.unwrap(), default_settlement.clone());
        let mut settlements_by_name = BTreeMap::new();
        settlements_by_name
            .insert(default_settlement.name.clone(), vec![default_settlement]);
        let settlements_data = (
            vec![],
            vec![],
            crate::location::trie::Trie::new(),
            settlements_by_id,
            settlements_by_name,
        );
        let settlements =
            Arc::new(RwLock::new(crate::location::SettlementsDataConfig {
                default_settlements_data: Arc::new(settlements_data),
                ..Default::default()
            }));

        let candidates = load_settlement_candidates(
            &txn,
            settlements,
            std::slice::from_ref(&settlement_name),
            None,
        )
        .await
        .unwrap();

        assert_eq!(candidates[0].len(), 1);
        assert_eq!(candidates[0][0].settlement_id, 2_287_207);
        txn.rollback().await.unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn resolves_ambiguous_locations_independently_2287() {
        let config =
            crate::config::read_config(crate::types::Mode::Test).unwrap();
        let dbx = crate::new_pg_pool_from_config(&config).await.unwrap();
        let txn = dbx.begin().await.unwrap();
        let aor_id = insert_test_battle_line_segment(&txn).await.unwrap();
        let suffix = uuid::Uuid::now_v7();
        let unique_name = format!("#2287 UNIQUE {suffix}");
        let repeated_name = format!("#2287 SAME {suffix}");
        insert_test_settlement(&txn, 2_287_211, &unique_name, 0.10, 1.0)
            .await
            .unwrap();
        insert_test_settlement(&txn, 2_287_212, &repeated_name, 0.01, 9.0)
            .await
            .unwrap();
        insert_test_settlement(&txn, 2_287_213, &repeated_name, 0.11, 1.02)
            .await
            .unwrap();
        let settlements = test_settlements_for_aor(
            aor_id,
            vec![
                crate::location::types::SettlementDetails {
                    id: Some(2_287_211),
                    name: unique_name.to_uppercase(),
                    coords: Some((0.10, 1.0)),
                    ..Default::default()
                },
                crate::location::types::SettlementDetails {
                    id: Some(2_287_212),
                    name: repeated_name.to_uppercase(),
                    coords: Some((0.01, 9.0)),
                    ..Default::default()
                },
                crate::location::types::SettlementDetails {
                    id: Some(2_287_213),
                    name: repeated_name.to_uppercase(),
                    coords: Some((0.11, 1.02)),
                    ..Default::default()
                },
            ],
        );

        let results = resolve_locations_to_settlements_with_db(
            &txn,
            settlements,
            vec![unique_name, repeated_name],
            &[aor_id],
        )
        .await
        .unwrap();

        assert_eq!(results[0].chosen_settlement_id, Some(2_287_211));
        assert_eq!(results[1].chosen_settlement_id, Some(2_287_212));
        assert!(
            results[1].distance_m.unwrap() < results[0].distance_m.unwrap()
        );
        txn.rollback().await.unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn rejects_distant_settlements_by_battle_line_side_2287() {
        let config =
            crate::config::read_config(crate::types::Mode::Test).unwrap();
        let dbx = crate::new_pg_pool_from_config(&config).await.unwrap();
        let txn = dbx.begin().await.unwrap();
        let aor_id = insert_test_battle_line_segment(&txn).await.unwrap();
        let suffix = uuid::Uuid::now_v7();
        let west_name = format!("#2287 WEST {suffix}");
        let east_name = format!("#2287 EAST {suffix}");
        let far_east_name = format!("#2287 FAR EAST {suffix}");
        let test_settlements = [
            (2_287_216, &west_name, 0.0, -0.7),
            (2_287_217, &east_name, 0.0, 10.7),
            (2_287_218, &far_east_name, 0.0, 11.4),
        ];
        for (id, name, lat, lon) in &test_settlements {
            insert_test_settlement(&txn, *id, name, *lat, *lon)
                .await
                .unwrap();
        }
        let settlements = test_settlements_for_aor(
            aor_id,
            test_settlements
                .into_iter()
                .map(|(id, name, lat, lon)| {
                    crate::location::types::SettlementDetails {
                        id: Some(id),
                        name: name.to_uppercase(),
                        coords: Some((lat, lon)),
                        ..Default::default()
                    }
                })
                .collect(),
        );

        let results = resolve_locations_to_settlements_with_db(
            &txn,
            settlements,
            vec![west_name, east_name, far_east_name],
            &[aor_id],
        )
        .await
        .unwrap();

        assert_eq!(results[0].chosen_settlement_id, None);
        assert!(
            results[0].distance_m.unwrap()
                > BATTLE_LINE_SETTLEMENT_MAX_DISTANCE_WEST_METERS
        );
        assert_eq!(results[1].chosen_settlement_id, Some(2_287_217));
        assert!(
            results[1].distance_m.unwrap()
                < BATTLE_LINE_SETTLEMENT_MAX_DISTANCE_EAST_METERS
        );
        assert_eq!(results[2].chosen_settlement_id, None);
        assert!(
            results[2].distance_m.unwrap()
                > BATTLE_LINE_SETTLEMENT_MAX_DISTANCE_EAST_METERS
        );
        txn.rollback().await.unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn resolves_battle_line_test_input_by_id_or_message_uid() {
        let config =
            crate::config::read_config(crate::types::Mode::Test).unwrap();
        let dbx = crate::new_pg_pool_from_config(&config).await.unwrap();
        let txn = dbx.begin().await.unwrap();
        let message_uid = format!("battle-line-test-{}", uuid::Uuid::now_v7());
        let message = signal_message::ActiveModel {
            message_uid: Set(Some(message_uid.clone())),
            ..Default::default()
        }
        .insert(&txn)
        .await
        .unwrap();
        sigint_inbox_item::ActiveModel {
            id: Set(message.id),
            ..Default::default()
        }
        .insert(&txn)
        .await
        .unwrap();
        let newer_message = signal_message::ActiveModel {
            message_uid: Set(Some(message_uid.clone())),
            ..Default::default()
        }
        .insert(&txn)
        .await
        .unwrap();
        sigint_inbox_item::ActiveModel {
            id: Set(newer_message.id),
            ..Default::default()
        }
        .insert(&txn)
        .await
        .unwrap();
        let deleted_message = signal_message::ActiveModel {
            message_uid: Set(Some(message_uid.clone())),
            deleted: Set(true),
            ..Default::default()
        }
        .insert(&txn)
        .await
        .unwrap();
        sigint_inbox_item::ActiveModel {
            id: Set(deleted_message.id),
            ..Default::default()
        }
        .insert(&txn)
        .await
        .unwrap();
        let numeric_message_uid = i64::MAX.to_string();
        let numeric_uid_message = signal_message::ActiveModel {
            message_uid: Set(Some(numeric_message_uid.clone())),
            ..Default::default()
        }
        .insert(&txn)
        .await
        .unwrap();
        sigint_inbox_item::ActiveModel {
            id: Set(numeric_uid_message.id),
            ..Default::default()
        }
        .insert(&txn)
        .await
        .unwrap();

        assert_eq!(
            resolve_test_inbox_item_ids(
                &txn,
                Some(&message.id.to_string()),
                None
            )
            .await
            .unwrap(),
            vec![message.id]
        );
        assert_eq!(
            resolve_test_inbox_item_ids(&txn, None, Some(&message_uid))
                .await
                .unwrap(),
            vec![newer_message.id, message.id]
        );
        assert_eq!(
            resolve_test_inbox_item_ids(&txn, None, Some(&numeric_message_uid))
                .await
                .unwrap(),
            vec![numeric_uid_message.id]
        );
        assert_eq!(
            resolve_test_inbox_item_ids(
                &txn,
                None,
                Some("missing-battle-line-message-uid")
            )
            .await
            .unwrap(),
            Vec::<i64>::new()
        );
        txn.rollback().await.unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn clips_aor_geometry_to_anchor_ray_sector() {
        let config =
            crate::config::read_config(crate::types::Mode::Test).unwrap();
        let dbx = crate::new_pg_pool_from_config(&config).await.unwrap();
        let txn = dbx.begin().await.unwrap();
        txn.execute_unprepared(
            "update battle_line_version set retired_at = now() at time zone 'utc' where retired_at is null",
        )
        .await
        .unwrap();
        let aor_id = area_of_responsibility::Entity::find()
            .filter(area_of_responsibility::Column::Deleted.eq(false))
            .select_only()
            .column(area_of_responsibility::Column::Id)
            .into_tuple::<i64>()
            .one(&txn)
            .await
            .unwrap()
            .expect("test database must contain an AOR");
        txn.execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
insert into battle_line_version
    (geometry, source_file_name, uploaded_by_login_id)
select
    ST_GeomFromText('GEOMETRYCOLLECTION(POINT(31 48),POINT(35 49),LINESTRING(29 49,38 49),LINESTRING(31 48,32 48))', 4326),
    'test.kml',
    id
from login
where not deleted
order by created_at
limit 1
            "#,
            [],
        ))
        .await
        .unwrap();
        txn.execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
update area_of_responsibility
set left_lat = 49, left_lon = 34, right_lat = 49, right_lon = 36
where id = $1
            "#,
            [aor_id.into()],
        ))
        .await
        .unwrap();

        refresh_aor_geometry(&txn, aor_id).await.unwrap();

        let row = txn
            .query_one_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                r#"
select
    ST_NumGeometries(ST_CollectionExtract(geometry, 1)) as point_count,
    ST_NumGeometries(ST_CollectionExtract(geometry, 2)) as line_count,
    ST_XMin(ST_Envelope(ST_CollectionExtract(geometry, 2))) as min_lon,
    ST_XMax(ST_Envelope(ST_CollectionExtract(geometry, 2))) as max_lon,
    ST_X(snapped_start) as start_lon,
    ST_X(snapped_end) as end_lon
from battle_line_aor_geometry
where aor_id = $1
  and version_id = (select id from battle_line_version where retired_at is null)
                "#,
                [aor_id.into()],
            ))
            .await
            .unwrap()
            .expect("derived AOR geometry");
        let point_count: i32 = row.try_get("", "point_count").unwrap();
        let line_count: i32 = row.try_get("", "line_count").unwrap();
        let min_lon: f64 = row.try_get("", "min_lon").unwrap();
        let max_lon: f64 = row.try_get("", "max_lon").unwrap();
        let start_lon: f64 = row.try_get("", "start_lon").unwrap();
        let end_lon: f64 = row.try_get("", "end_lon").unwrap();
        assert_eq!(point_count, 1);
        assert_eq!(line_count, 1);
        assert!((min_lon - 34.0).abs() < 0.000_001);
        assert!((max_lon - 36.0).abs() < 0.000_001);
        assert!((start_lon - 34.0).abs() < 0.000_001);
        assert!((end_lon - 36.0).abs() < 0.000_001);

        let candidates = vec![
            BattleLineCandidatePoint {
                lat: 48.0,
                lon: 31.0,
            },
            BattleLineCandidatePoint {
                lat: 49.1,
                lon: 35.0,
            },
        ];
        let unrestricted =
            match_battle_line_candidates(&txn, &candidates, None)
                .await
                .unwrap();
        assert_eq!(unrestricted.matched.unwrap().candidate_index, 0);

        let restricted =
            match_battle_line_candidates(&txn, &candidates, Some(&[aor_id]))
                .await
                .unwrap();
        assert_eq!(restricted.matched.unwrap().candidate_index, 1);
        assert!(restricted.invalid_aor_ids.is_empty());

        let partially_invalid = match_battle_line_candidates(
            &txn,
            &candidates,
            Some(&[aor_id, i64::MAX]),
        )
        .await
        .unwrap();
        assert_eq!(partially_invalid.matched.unwrap().candidate_index, 1);
        assert_eq!(partially_invalid.invalid_aor_ids, vec![i64::MAX]);

        let invalid =
            match_battle_line_candidates(&txn, &candidates, Some(&[i64::MAX]))
                .await
                .unwrap();
        assert_eq!(invalid.matched, None);
        assert_eq!(invalid.invalid_aor_ids, vec![i64::MAX]);

        let empty =
            match_battle_line_candidates(&txn, &[], Some(&[aor_id, i64::MAX]))
                .await
                .unwrap();
        assert_eq!(empty.matched, None);
        assert_eq!(empty.invalid_aor_ids, vec![i64::MAX]);

        let tie = match_battle_line_candidates(
            &txn,
            &[
                BattleLineCandidatePoint {
                    lat: 49.0,
                    lon: 35.0,
                },
                BattleLineCandidatePoint {
                    lat: 49.0,
                    lon: 35.0,
                },
            ],
            Some(&[aor_id]),
        )
        .await
        .unwrap();
        assert_eq!(tie.matched.unwrap().candidate_index, 0);
        txn.rollback().await.unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn delta_force_import_keeps_peleng_distances_and_settlements() {
        let config =
            crate::config::read_config(crate::types::Mode::Test).unwrap();
        let dbx = crate::new_pg_pool_from_config(&config).await.unwrap();
        let txn = dbx.begin().await.unwrap();
        battle_line_aor_geometry::Entity::delete_many()
            .exec(&txn)
            .await
            .unwrap();
        battle_line_version::Entity::update_many()
            .col_expr(
                battle_line_version::Column::RetiredAt,
                Expr::cust("now() at time zone 'utc'"),
            )
            .filter(battle_line_version::Column::RetiredAt.is_null())
            .exec(&txn)
            .await
            .unwrap();
        let login_id = login::Entity::find()
            .filter(login::Column::Deleted.eq(false))
            .select_only()
            .column(login::Column::Id)
            .into_tuple::<uuid::Uuid>()
            .one(&txn)
            .await
            .unwrap()
            .expect("test database must contain a login");
        let aor_id = area_of_responsibility::Entity::find()
            .filter(area_of_responsibility::Column::Deleted.eq(false))
            .select_only()
            .column(area_of_responsibility::Column::Id)
            .into_tuple::<i64>()
            .one(&txn)
            .await
            .unwrap()
            .expect("test database must contain an AOR");
        txn.execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
update area_of_responsibility
set left_lat = 52, left_lon = 33, right_lat = 48, right_lon = 39
where id = $1
            "#,
            [aor_id.into()],
        ))
        .await
        .unwrap();
        let prepared = test_prepared_import("a");
        let initial = activate_battle_line_import_in_transaction(
            &txn,
            &prepared,
            login_id,
            &BattleLineImportSource::admin_upload(),
            true,
        )
        .await
        .unwrap();
        let BattleLineImportOutcome::Imported(initial_version_id) = initial
        else {
            panic!("expected an initial Battle Line version");
        };

        let signal_message = signal_message::ActiveModel {
            ..Default::default()
        }
        .insert(&txn)
        .await
        .unwrap();
        let item_id = signal_message.id;
        let inbox_item = sigint_inbox_item::ActiveModel {
            id: Set(item_id),
            ..Default::default()
        }
        .insert(&txn)
        .await
        .unwrap();
        let peleng = crate::functest::tests::mk_sigint_peleng(
            &txn,
            sigint_peleng::ActiveModel {
                source_inbox_item_id: Set(item_id),
                battle_line_distance: Set(Some(7)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let settlement_link = sigint_inbox_item_settlement::ActiveModel {
            id: NotSet,
            item_uuid: Set(inbox_item.id_uuid),
            created_at: NotSet,
            item_id: Set(item_id),
            settlement_text: Set(format!("test-{}", uuid::Uuid::now_v7())),
            settlement_id: Set(None),
            is_undefined: Set(Some(true)),
        }
        .insert(&txn)
        .await
        .unwrap();

        let delta_source = BattleLineImportSource::delta_kml(
            "enemy_units_geojson:test".to_string(),
        );
        let delta_prepared = test_prepared_import("b");
        assert_eq!(
            activate_battle_line_import_in_transaction(
                &txn,
                &delta_prepared,
                login_id,
                &delta_source,
                false,
            )
            .await
            .unwrap(),
            BattleLineImportOutcome::RequiresForce(initial_version_id)
        );
        let imported = activate_battle_line_import_in_transaction(
            &txn,
            &delta_prepared,
            login_id,
            &delta_source,
            true,
        )
        .await
        .unwrap();
        let BattleLineImportOutcome::Imported(version_id) = imported else {
            panic!("expected a new Battle Line version");
        };
        assert_eq!(
            active_battle_line_id(&txn).await.unwrap(),
            Some(version_id)
        );
        assert_eq!(
            sigint_peleng::Entity::find_by_id(peleng.id)
                .one(&txn)
                .await
                .unwrap()
                .unwrap()
                .battle_line_distance,
            Some(7)
        );
        assert!(battle_line_version::Entity::find_by_id(initial_version_id)
            .one(&txn)
            .await
            .unwrap()
            .unwrap()
            .retired_at
            .is_some());
        assert!(
            battle_line_aor_geometry::Entity::find()
                .filter(
                    battle_line_aor_geometry::Column::VersionId.eq(version_id)
                )
                .filter(battle_line_aor_geometry::Column::AorId.eq(aor_id))
                .count(&txn)
                .await
                .unwrap()
                > 0
        );
        assert_eq!(
            activate_battle_line_import_in_transaction(
                &txn,
                &delta_prepared,
                login_id,
                &delta_source,
                false,
            )
            .await
            .unwrap(),
            BattleLineImportOutcome::AlreadyImported(version_id)
        );

        let forced_again = activate_battle_line_import_in_transaction(
            &txn,
            &delta_prepared,
            login_id,
            &delta_source,
            true,
        )
        .await
        .unwrap();
        let BattleLineImportOutcome::Imported(forced_version_id) = forced_again
        else {
            panic!("expected --force to create a new Battle Line version");
        };
        assert_ne!(forced_version_id, version_id);

        let admin = activate_battle_line_import_in_transaction(
            &txn,
            &test_prepared_import("c"),
            login_id,
            &BattleLineImportSource::admin_upload(),
            true,
        )
        .await
        .unwrap();
        let BattleLineImportOutcome::Imported(admin_version_id) = admin else {
            panic!("expected a new admin Battle Line version");
        };
        assert_eq!(
            activate_battle_line_import_in_transaction(
                &txn,
                &delta_prepared,
                login_id,
                &delta_source,
                false,
            )
            .await
            .unwrap(),
            BattleLineImportOutcome::RequiresForce(admin_version_id)
        );

        let restored = activate_battle_line_import_in_transaction(
            &txn,
            &delta_prepared,
            login_id,
            &delta_source,
            true,
        )
        .await
        .unwrap();
        let BattleLineImportOutcome::Imported(restored_version_id) = restored
        else {
            panic!("expected --force to reimport the retired Delta source");
        };
        assert_ne!(restored_version_id, version_id);
        assert_ne!(restored_version_id, forced_version_id);
        assert_eq!(
            active_battle_line_id(&txn).await.unwrap(),
            Some(restored_version_id)
        );
        assert_eq!(
            battle_line_version::Entity::find()
                .filter(
                    battle_line_version::Column::SourceIdentifier
                        .eq(delta_source.identifier.as_deref().unwrap())
                )
                .filter(
                    battle_line_version::Column::SourceSha256
                        .eq(&delta_prepared.source_sha256)
                )
                .count(&txn)
                .await
                .unwrap(),
            3
        );

        let settlement_link = sigint_inbox_item_settlement::Entity::find_by_id(
            settlement_link.id,
        )
        .one(&txn)
        .await
        .unwrap()
        .unwrap();
        assert_eq!(settlement_link.is_undefined, Some(true));
        txn.rollback().await.unwrap();
    }

    fn test_prepared_import(
        digest_character: &str,
    ) -> PreparedBattleLineImport {
        PreparedBattleLineImport {
            geometry_wkt:
                "GEOMETRYCOLLECTION(POINT(34 51),LINESTRING(33 52,39 48))"
                    .to_string(),
            source_file_name: "test.kml".to_string(),
            source_sha256: digest_character.repeat(64),
            source_summary: BattleLineImportSummary {
                point_count: 1,
                line_string_count: 1,
                empty_point_count: 0,
                empty_line_string_count: 0,
                zero_length_line_string_count: 0,
                coordinate_count: 3,
                bounds: BattleLineImportBounds {
                    min_lat: 48.0,
                    min_lon: 33.0,
                    max_lat: 52.0,
                    max_lon: 39.0,
                },
            },
            cleanup_stats: cleanup::BattleLineCleanupStats {
                minimum_line_length_m: 0.0,
                removed_point_count: 0,
                removed_short_line_string_count: 0,
                removed_duplicate_segment_count: 0,
            },
            summary: BattleLineImportSummary {
                point_count: 1,
                line_string_count: 1,
                empty_point_count: 0,
                empty_line_string_count: 0,
                zero_length_line_string_count: 0,
                coordinate_count: 3,
                bounds: BattleLineImportBounds {
                    min_lat: 48.0,
                    min_lon: 33.0,
                    max_lat: 52.0,
                    max_lon: 39.0,
                },
            },
        }
    }
}
