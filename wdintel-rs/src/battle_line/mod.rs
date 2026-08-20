use crate::battle_line::types::*;
use crate::config::{
    BATTLE_LINE_ADMIN_PAGE_SIZE, BATTLE_LINE_ALLOWED_UPLOAD_EXTENSIONS,
    BATTLE_LINE_CLIP_EXTENT_METERS, BATTLE_LINE_UPLOAD_ADVISORY_LOCK_KEY,
    BATTLE_LINE_UPLOAD_MAX_BYTES,
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
use chrono::NaiveDateTime;
use log::warn;
use sea_orm::sea_query::{Expr, SimpleExpr};
use sea_orm::*;
use serde_json::Value as JsonValue;
use std::collections::BTreeSet;

pub mod settlement_queue;
pub mod types;

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
    let source_file_name = sanitize_upload_filename(raw_file_name);
    let extension = std::path::Path::new(&source_file_name)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !BATTLE_LINE_ALLOWED_UPLOAD_EXTENSIONS.contains(&extension.as_str()) {
        return Err(AppError::BL {
            msg: format!(
                "Підтримуються лише файли .kml та .kmz: {source_file_name}"
            ),
        });
    }
    let features = parse_point_line_features(&source_file_name, &data)
        .await
        .c(h!())?;
    let geometry_wkt = features_to_wkt(&features).c(h!())?;
    replace_active_battle_line(
        &env.dbx,
        &geometry_wkt,
        &source_file_name,
        login_id,
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
    let login_id = crate::users::login_id_from_identity(&user).c(h!())?;
    let organism_logins = crate::users::get_organism_login_ids(&env.dbx, user)
        .await
        .c(h!())?;
    let inbox_req = crate::rer_importer::types::InboxMessagesReq {
        highlight_points: Some(true),
        ..Default::default()
    };
    let mut messages = crate::rer_importer::inbox::messages_by_id_bl(
        &login_id,
        &organism_logins,
        &env,
        &[req.inbox_item_id],
        &inbox_req,
    )
    .await
    .c(h!())?;
    let Some((_, message)) = messages.pop() else {
        return Err(AppError::NotFound);
    };
    let location_v2 = sigint_inbox_item::Entity::find_by_id(req.inbox_item_id)
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
    let aor_context = resolve_inbox_item_aors(
        &env.dbx,
        req.inbox_item_id,
        Some(&allowed_groups),
    )
    .await
    .c(h!())?;
    let mut locations = vec![];
    for location in location_v2
        .as_deref()
        .map(crate::location::utils::to_location_list)
        .unwrap_or_default()
    {
        locations.push(
            resolve_location_to_settlement(
                &env,
                location,
                &aor_context.aor_ids,
            )
            .await
            .c(h!())?,
        );
    }
    Ok(Json(BattleLineTestRsp {
        inbox_item_id: req.inbox_item_id,
        message,
        group_master_keys: aor_context.group_master_keys,
        aor_ids: aor_context.aor_ids,
        locations,
        battle_line: read_battle_line_state(&env.dbx).await.c(h!())?,
    }))
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

async fn replace_active_battle_line(
    dbx: &DatabaseConnection,
    geometry_wkt: &str,
    source_file_name: &str,
    uploaded_by_login_id: uuid::Uuid,
) -> anyhow::Result<i64> {
    let txn = dbx.begin().await.c(h!())?;
    lock_updates(&txn).await.c(h!())?;
    let previous_id = battle_line_version::Entity::find()
        .filter(battle_line_version::Column::RetiredAt.is_null())
        .select_only()
        .column(battle_line_version::Column::Id)
        .into_tuple::<i64>()
        .one(&txn)
        .await
        .c(h!())?;
    if let Some(previous_id) = previous_id {
        battle_line_aor_geometry::Entity::delete_many()
            .filter(battle_line_aor_geometry::Column::VersionId.eq(previous_id))
            .exec(&txn)
            .await
            .c(h!())?;
        battle_line_version::Entity::update_many()
            .col_expr(
                battle_line_version::Column::RetiredAt,
                Expr::cust("now() at time zone 'utc'"),
            )
            .filter(battle_line_version::Column::Id.eq(previous_id))
            .exec(&txn)
            .await
            .c(h!())?;
    }
    let row = txn
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
insert into battle_line_version
    (geometry, source_file_name, uploaded_by_login_id)
values (ST_GeomFromText($1, 4326), $2, $3)
returning id
            "#,
            [
                geometry_wkt.into(),
                source_file_name.into(),
                uploaded_by_login_id.into(),
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
        .all(&txn)
        .await
        .c(h!())?;
    for aor_id in aor_ids {
        refresh_aor_geometry(&txn, aor_id).await.c(h!())?;
    }
    requeue_settlement_links(&txn).await.c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(version_id)
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
        [aor_id.into(), BATTLE_LINE_CLIP_EXTENT_METERS.into()],
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
        ST_Transform(ST_SetSRID(ST_MakePoint(a.right_lon, a.right_lat), 4326), 3857) as end_hint
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
        ST_ClosestPoint(full_geometry, start_hint) as snapped_start,
        ST_ClosestPoint(full_geometry, end_hint) as snapped_end
    from input
), directed as (
    select *,
        ST_X(snapped_end) - ST_X(snapped_start) as dx,
        ST_Y(snapped_end) - ST_Y(snapped_start) as dy,
        ST_Distance(snapped_start, snapped_end) as guide_length
    from snapped
), clipped as (
    select *, ST_SetSRID(ST_MakePolygon(ST_MakeLine(array[
        ST_MakePoint(ST_X(snapped_start) - dy / guide_length * $2, ST_Y(snapped_start) + dx / guide_length * $2),
        ST_MakePoint(ST_X(snapped_end) - dy / guide_length * $2, ST_Y(snapped_end) + dx / guide_length * $2),
        ST_MakePoint(ST_X(snapped_end) + dy / guide_length * $2, ST_Y(snapped_end) - dx / guide_length * $2),
        ST_MakePoint(ST_X(snapped_start) + dy / guide_length * $2, ST_Y(snapped_start) - dx / guide_length * $2),
        ST_MakePoint(ST_X(snapped_start) - dy / guide_length * $2, ST_Y(snapped_start) + dx / guide_length * $2)
    ])), 3857) as span
    from directed
    where guide_length > 0.01
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
        ST_Transform(ST_Collect(clipped_points, clipped_lines), 4326)
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
        return Ok(BattleLineMatchOutcome {
            matched: None,
            invalid_aor_ids,
        });
    }
    if candidates.is_empty() {
        return Ok(BattleLineMatchOutcome {
            matched: None,
            invalid_aor_ids,
        });
    }
    let matched = rank_candidates(
        dbx,
        candidates,
        requested_aor_ids.as_ref().map(|_| &valid_aor_ids),
    )
    .await
    .c(h!())?;
    Ok(BattleLineMatchOutcome {
        matched,
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

async fn rank_candidates<C>(
    dbx: &C,
    candidates: &[BattleLineCandidatePoint],
    aor_ids: Option<&BTreeSet<i64>>,
) -> anyhow::Result<Option<BattleLineMatch>>
where
    C: ConnectionTrait,
{
    let mut values = vec![];
    let selected_sql = if let Some(aor_ids) = aor_ids {
        let placeholders = aor_ids
            .iter()
            .map(|aor_id| {
                values.push((*aor_id).into());
                format!("${}", values.len())
            })
            .collect::<Vec<_>>()
            .join(", ");
        format!(
            "select ST_Collect(geometry) as geometry from battle_line_aor_geometry where version_id = (select id from battle_line_version where retired_at is null) and aor_id in ({placeholders})"
        )
    } else {
        "select geometry from battle_line_version where retired_at is null"
            .to_string()
    };
    let candidate_rows = candidates
        .iter()
        .enumerate()
        .map(|(index, candidate)| {
            values.push((index as i64).into());
            let index_placeholder = values.len();
            values.push(candidate.lon.into());
            let lon_placeholder = values.len();
            values.push(candidate.lat.into());
            let lat_placeholder = values.len();
            format!(
                "(${index_placeholder}::bigint, ${lon_placeholder}::double precision, ${lat_placeholder}::double precision)"
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        r#"
with selected as ({selected_sql}),
components as (
    select (dumped).geom as geometry
    from selected
    cross join lateral ST_Dump(selected.geometry) as dumped
),
candidates(candidate_index, lon, lat) as (values {candidate_rows})
select
    candidates.candidate_index,
    min(ST_Distance(
        ST_SetSRID(ST_MakePoint(candidates.lon, candidates.lat), 4326)::geography,
        components.geometry::geography
    )) as distance_m
from candidates
cross join components
group by candidates.candidate_index
order by distance_m, candidates.candidate_index
limit 1
        "#
    );
    let row = MatchRow::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        sql,
        values,
    ))
    .one(dbx)
    .await
    .c(h!())?;
    Ok(row.map(|row| BattleLineMatch {
        candidate_index: row.candidate_index as usize,
        distance_m: row.distance_m,
    }))
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
    resolve_location_to_settlement_with_db(&env.dbx, env, location, aor_ids)
        .await
        .c(h!())
}

pub(crate) async fn resolve_location_to_settlement_with_db<C>(
    dbx: &C,
    env: &Env,
    location: String,
    aor_ids: &[i64],
) -> anyhow::Result<BattleLineLocationResult>
where
    C: ConnectionTrait,
{
    let aor_scope = (!aor_ids.is_empty()).then_some(aor_ids);
    let settlements = crate::location::find_settlements_by_name_scope(
        env.settlements.clone(),
        location.clone(),
        None,
        None,
        aor_scope,
    )
    .c(h!())?;
    let settlements = prefer_exact_settlement_names(&location, settlements);
    let mut seen = BTreeSet::new();
    let candidates = settlements
        .into_iter()
        .filter_map(|settlement| {
            let settlement_id = settlement.id?;
            let (lat, lon) = settlement.coords?;
            seen.insert(settlement_id).then_some(
                BattleLineSettlementCandidate {
                    settlement_id,
                    name: settlement.name,
                    region: settlement.region,
                    coordinate: BattleLineCoordinate { lat, lon },
                },
            )
        })
        .collect::<Vec<_>>();
    let points = candidates
        .iter()
        .map(|candidate| BattleLineCandidatePoint {
            lat: candidate.coordinate.lat,
            lon: candidate.coordinate.lon,
        })
        .collect::<Vec<_>>();
    let matched = match_battle_line_candidates(dbx, &points, aor_scope)
        .await
        .c(h!())?;
    let (chosen_settlement_id, distance_m) = matched
        .matched
        .as_ref()
        .map(|matched| {
            (
                Some(candidates[matched.candidate_index].settlement_id),
                Some(matched.distance_m),
            )
        })
        .unwrap_or((None, None));
    Ok(BattleLineLocationResult {
        location,
        candidates,
        chosen_settlement_id,
        distance_m,
        invalid_aor_ids: matched.invalid_aor_ids,
    })
}

fn prefer_exact_settlement_names(
    location: &str,
    mut settlements: Vec<crate::location::types::SettlementDetails>,
) -> Vec<crate::location::types::SettlementDetails> {
    let location = location.to_uppercase();
    if settlements
        .iter()
        .any(|settlement| settlement.name == location)
    {
        settlements.retain(|settlement| settlement.name == location);
    }
    settlements
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
        "Point" => features.push(BattleLineFeature {
            kind: "Point".to_string(),
            coordinates: vec![
                coordinate_from_json(&geometry["coordinates"]).c(h!())?
            ],
        }),
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
    fn prefers_exact_settlement_names_over_containing_names() {
        let settlements = vec![
            crate::location::types::SettlementDetails {
                id: Some(1),
                name: "НОВОІВАНІВКА".to_string(),
                ..Default::default()
            },
            crate::location::types::SettlementDetails {
                id: Some(2),
                name: "ІВАНІВКА".to_string(),
                ..Default::default()
            },
        ];

        let settlements =
            prefer_exact_settlement_names("Іванівка", settlements);

        assert_eq!(settlements.len(), 1);
        assert_eq!(settlements[0].id, Some(2));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn clips_aor_geometry_at_snapped_perpendicular_boundaries() {
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
    ST_GeomFromText('GEOMETRYCOLLECTION(POINT(31 49),POINT(34 49),LINESTRING(29 49,34 49,29 49.1,34 49.1),LINESTRING(29 48,30 49))', 4326),
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
set left_lat = 49, left_lon = 30, right_lat = 49, right_lon = 33
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
        assert_eq!(line_count, 3);
        assert!((min_lon - 30.0).abs() < 0.000_001);
        assert!((max_lon - 33.0).abs() < 0.000_001);
        assert!((start_lon - 30.0).abs() < 0.000_001);
        assert!((end_lon - 33.0).abs() < 0.000_001);

        let candidates = vec![
            BattleLineCandidatePoint {
                lat: 49.0,
                lon: 34.0,
            },
            BattleLineCandidatePoint {
                lat: 49.0,
                lon: 31.0,
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
                    lon: 31.0,
                },
                BattleLineCandidatePoint {
                    lat: 49.0,
                    lon: 31.0,
                },
            ],
            Some(&[aor_id]),
        )
        .await
        .unwrap();
        assert_eq!(tie.matched.unwrap().candidate_index, 0);
        txn.rollback().await.unwrap();
    }
}
