use crate::entities::*;
use crate::h;
use crate::palitra::types::*;
use crate::types::*;
use crate::utils::orm::ArrayColumnOps;
use anyhow::Context;
use chrono::{DateTime, Utc};
use itertools::{Either, Itertools};
use redis::AsyncCommands;
use sea_orm::prelude::*;
use sea_orm::sea_query::SimpleExpr;
use sea_orm::*;
use serde::de::DeserializeOwned;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone)]
enum LabelPattern {
    Exact(String),
    Prefix(String),
    Suffix(String),
    Contains(String),
}

impl LabelPattern {
    fn parse(label: &str) -> Option<Self> {
        let normalized = normalize_label_cache(label)?;
        let has_prefix_star = normalized.starts_with('*');
        let has_suffix_star = normalized.ends_with('*');

        let trimmed = normalized
            .trim_start_matches('*')
            .trim_end_matches('*')
            .trim()
            .to_string();

        let pattern = match (has_prefix_star, has_suffix_star) {
            (false, false) => LabelPattern::Exact(normalized),
            (true, false) => {
                if trimmed.is_empty() {
                    return None;
                }
                LabelPattern::Suffix(trimmed)
            }
            (false, true) => {
                if trimmed.is_empty() {
                    return None;
                }
                LabelPattern::Prefix(trimmed)
            }
            (true, true) => {
                if trimmed.is_empty() {
                    return None;
                }
                LabelPattern::Contains(trimmed)
            }
        };
        Some(pattern)
    }

    fn to_expr(&self) -> SimpleExpr {
        match self {
            LabelPattern::Exact(value) => {
                Expr::cust_with_values("lower(label) = $1", vec![value.clone()])
            }
            LabelPattern::Prefix(value) => Expr::cust_with_values(
                "lower(label) LIKE $1 ESCAPE '\\'",
                vec![format!("{}%", escape_like(value))],
            ),
            LabelPattern::Suffix(value) => Expr::cust_with_values(
                "lower(label) LIKE $1 ESCAPE '\\'",
                vec![format!("%{}", escape_like(value))],
            ),
            LabelPattern::Contains(value) => Expr::cust_with_values(
                "lower(label) LIKE $1 ESCAPE '\\'",
                vec![format!("%{}%", escape_like(value))],
            ),
        }
    }

    fn matches(&self, normalized_label: &str) -> bool {
        match self {
            LabelPattern::Exact(value) => normalized_label == value,
            LabelPattern::Prefix(value) => normalized_label.starts_with(value),
            LabelPattern::Suffix(value) => normalized_label.ends_with(value),
            LabelPattern::Contains(value) => normalized_label.contains(value),
        }
    }
}

enum PalitraUpdateAction {
    Insert,
    Update,
}

pub async fn collect_palitra_access_logins<'a, 'async_trait, C>(
    txn: &'a C,
    palitra_id: i64,
) -> anyhow::Result<Vec<String>>
where
    C: ConnectionTrait + 'async_trait,
{
    crate::entities::palitra_access_login::Entity::find()
        .filter(palitra_access_login::Column::PalitraId.eq(palitra_id))
        .select_only()
        .column(palitra_access_login::Column::Login)
        .into_tuple::<String>()
        .all(txn)
        .await
        .c(h!())
}

pub async fn collect_palitra_access_organisms<'a, 'async_trait, C>(
    txn: &'a C,
    palitra_id: i64,
) -> anyhow::Result<Vec<i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    palitra_access_organism::Entity::find()
        .filter(palitra_access_organism::Column::PalitraId.eq(palitra_id))
        .select_only()
        .column(palitra_access_organism::Column::OrganismId)
        .into_tuple::<i64>()
        .all(txn)
        .await
        .c(h!())
}

pub async fn collect_palitra_access_aors<'a, 'async_trait, C>(
    txn: &'a C,
    palitra_id: i64,
) -> anyhow::Result<Vec<i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    palitra_access_aor::Entity::find()
        .filter(palitra_access_aor::Column::PalitraId.eq(palitra_id))
        .select_only()
        .column(palitra_access_aor::Column::AorId)
        .into_tuple::<i64>()
        .all(txn)
        .await
        .c(h!())
}

pub async fn update_palitra(
    palitra_id: i64,
    req: CreatePalitraReq,
    txn: &DatabaseTransaction,
) -> anyhow::Result<PalitraDetails> {
    let palitra = palitra::Entity::find_by_id(palitra_id)
        .one(txn)
        .await
        .c(h!())?
        .c(h!())?
        .into_active_model();

    let palitra =
        update_palitra_from_req(req, palitra, txn, PalitraUpdateAction::Update)
            .await
            .c(h!())?;

    let result = render_palitra_details(txn, vec![palitra.id])
        .await
        .c(h!())?
        .into_iter()
        .next()
        .c(h!())?;
    Ok(result)
}

pub async fn list_all_palitras_detailed(
    login: String,
    dbx: &DatabaseConnection,
) -> anyhow::Result<Vec<PalitraDetails>> {
    let palitra_ids = collect_palitra_ids(login, dbx).await.c(h!())?;
    let result = render_palitra_details(dbx, palitra_ids).await.c(h!())?;
    Ok(result)
}

pub async fn search_palitra_points_by_labels(
    login: String,
    req: PalitraSearchPointsReq,
    dbx: &DatabaseConnection,
) -> anyhow::Result<Vec<PalitraPoints>> {
    let allowed_palitra_ids = collect_palitra_ids(login, dbx).await.c(h!())?;
    let allowed_palitra_ids: HashSet<i64> =
        allowed_palitra_ids.into_iter().collect();
    let palitra_ids: Vec<i64> = req
        .palitra_ids
        .into_iter()
        .filter(|id| allowed_palitra_ids.contains(id))
        .collect();
    if palitra_ids.is_empty() {
        return Ok(vec![]);
    }
    dbg!("{:?}", &palitra_ids);

    let label_patterns: Vec<LabelPattern> = req
        .point_labels
        .iter()
        .filter_map(|point| LabelPattern::parse(point))
        .collect();
    if label_patterns.is_empty() {
        return Ok(vec![]);
    }

    let mut label_condition = Condition::any();
    for pattern in &label_patterns {
        label_condition = label_condition.add(pattern.to_expr());
    }

    let points = palitra_point::Entity::find()
        .select_only()
        .column(palitra_point::Column::PalitraId)
        .column(palitra_point::Column::Lat)
        .column(palitra_point::Column::Lng)
        .column(palitra_point::Column::Label)
        .filter(palitra_point::Column::PalitraId.eq_any(palitra_ids.clone()))
        .filter(palitra_point::Column::Deleted.eq(false))
        .filter(palitra_point::Column::Label.is_not_null())
        .filter(label_condition)
        .into_tuple::<(i64, f64, f64, Option<String>)>()
        .all(dbx)
        .await
        .c(h!())?;

    let mut points_by_id: HashMap<i64, Vec<PalitraPoint>> = HashMap::new();
    let mut matched_labels: HashMap<i64, HashSet<usize>> = HashMap::new();
    for (palitra_id, lat, lng, label) in points {
        if let Some(label_value) = label.clone() {
            if let Some(normalized_label) = normalize_label_cache(&label_value)
            {
                let mut matched_any = false;
                for (idx, pattern) in label_patterns.iter().enumerate() {
                    if pattern.matches(&normalized_label) {
                        matched_labels
                            .entry(palitra_id)
                            .or_default()
                            .insert(idx);
                        matched_any = true;
                    }
                }
                if !matched_any {
                    continue;
                }
            } else {
                continue;
            }
        } else {
            continue;
        }

        points_by_id
            .entry(palitra_id)
            .or_default()
            .push(PalitraPoint {
                label,
                coords: Coords { lat, lng },
            });
    }

    let result = palitra_ids
        .into_iter()
        .filter_map(|palitra_id| {
            let points = points_by_id.remove(&palitra_id).unwrap_or_default();
            if points.is_empty() {
                return None;
            }
            Some(PalitraPoints { palitra_id, points })
        })
        .collect();
    Ok(result)
}

pub async fn suggest_palitra_point_labels(
    login: String,
    req: PalitraPointLabelSuggestReq,
    dbx: &DatabaseConnection,
) -> anyhow::Result<Vec<PalitraPointLabelSuggestRsp>> {
    let allowed_palitra_ids = collect_palitra_ids(login, dbx).await.c(h!())?;
    let allowed_palitra_ids: HashSet<i64> =
        allowed_palitra_ids.into_iter().collect();
    let palitra_ids: Vec<i64> = req
        .palitra_ids
        .into_iter()
        .filter(|id| allowed_palitra_ids.contains(id))
        .collect();
    if palitra_ids.is_empty() {
        return Ok(vec![]);
    }

    let prefix = normalize_label_cache(&req.prefix).unwrap_or_default();
    if prefix.is_empty() {
        return Ok(vec![]);
    }
    let limit = req.limit.unwrap_or(15).min(50);
    let normalized_prefix = prefix.to_lowercase();
    let prefix_pattern = build_label_pattern(&normalized_prefix, false);

    let labels = palitra_point::Entity::find()
        .select_only()
        .column(palitra_point::Column::PalitraId)
        .column(palitra_point::Column::Label)
        .filter(palitra_point::Column::PalitraId.eq_any(palitra_ids.clone()))
        .filter(palitra_point::Column::Deleted.eq(false))
        .filter(palitra_point::Column::Label.is_not_null())
        .filter(Expr::cust_with_values(
            "lower(label) LIKE $1 ESCAPE '\\'",
            vec![prefix_pattern],
        ))
        .order_by_asc(palitra_point::Column::Label)
        .distinct()
        .limit(limit)
        .into_tuple::<(i64, Option<String>)>()
        .all(dbx)
        .await
        .c(h!())?;

    let mut labels: Vec<PalitraPointLabelSuggestRsp> = labels
        .into_iter()
        .map(|(palitra_id, label)| PalitraPointLabelSuggestRsp {
            palitra_id,
            label: label.unwrap_or_default(),
        })
        .collect();

    if labels.len() < limit as usize {
        let remaining = limit - labels.len() as u64;
        let similar_pattern = build_label_pattern(&normalized_prefix, true);
        let mut similar_query = palitra_point::Entity::find()
            .select_only()
            .column(palitra_point::Column::PalitraId)
            .column(palitra_point::Column::Label)
            .filter(palitra_point::Column::PalitraId.eq_any(palitra_ids))
            .filter(palitra_point::Column::Deleted.eq(false))
            .filter(palitra_point::Column::Label.is_not_null())
            .filter(Expr::cust_with_values(
                "lower(label) LIKE $1 ESCAPE '\\'",
                vec![similar_pattern],
            ))
            .order_by_asc(palitra_point::Column::Label)
            .distinct();

        let used_labels: Vec<String> =
            labels.iter().map(|item| item.label.clone()).collect();
        if !used_labels.is_empty() {
            similar_query = similar_query
                .filter(palitra_point::Column::Label.is_not_in(used_labels));
        }

        let similar = similar_query
            .limit(remaining)
            .into_tuple::<(i64, Option<String>)>()
            .all(dbx)
            .await
            .c(h!())?;

        labels.extend(similar.into_iter().map(|(palitra_id, label)| {
            PalitraPointLabelSuggestRsp {
                palitra_id,
                label: label.unwrap_or_default(),
            }
        }));
    }

    Ok(labels)
}

fn normalize_label_cache(label: &str) -> Option<String> {
    let trimmed = label.trim();
    if trimmed.is_empty() {
        None
    } else {
        let normalized = trimmed
            .split_whitespace()
            .filter(|part| !part.is_empty())
            .join(" ");
        Some(normalized.to_lowercase())
    }
}

fn escape_like(input: &str) -> String {
    input
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn build_label_pattern(label: &str, surround: bool) -> String {
    let pattern = label
        .split_whitespace()
        .filter(|part| !part.is_empty())
        .map(escape_like)
        .join("%");
    if surround {
        format!("%{}%", pattern)
    } else {
        format!("{}%", pattern)
    }
}

pub(crate) fn palitra_search_cache_key(
    login: &str,
    req: &PalitraSearchPointsReq,
) -> String {
    let mut palitra_ids = req.palitra_ids.clone();
    palitra_ids.sort_unstable();
    palitra_ids.dedup();
    let labels: Vec<String> = req
        .point_labels
        .iter()
        .filter_map(|label| normalize_label_cache(label))
        .scan(HashSet::new(), |used, label| {
            if used.insert(label.clone()) {
                Some(label)
            } else {
                None
            }
        })
        .collect();
    format!(
        "palitra:points:search:{login}:{}:{}",
        palitra_ids.iter().join(","),
        labels.join(",")
    )
}

pub(crate) fn palitra_suggest_cache_key(
    login: &str,
    req: &PalitraPointLabelSuggestReq,
) -> String {
    let mut palitra_ids = req.palitra_ids.clone();
    palitra_ids.sort_unstable();
    palitra_ids.dedup();
    let prefix = normalize_label_cache(&req.prefix).unwrap_or_default();
    let limit = req.limit.unwrap_or(15).min(50);
    format!(
        "palitra:points:label-suggest:{login}:{}:{prefix}:{limit}",
        palitra_ids.iter().join(",")
    )
}

pub(crate) async fn read_cached_json<T: DeserializeOwned>(
    redis: &mut redis::aio::ConnectionManager,
    key: &str,
) -> anyhow::Result<Option<T>> {
    let raw: Option<String> = redis.get(key).await.c(h!())?;
    match raw {
        Some(raw) => Ok(Some(serde_json::from_str(&raw).c(h!())?)),
        None => Ok(None),
    }
}

pub(crate) async fn write_cached_json<T: Serialize>(
    redis: &mut redis::aio::ConnectionManager,
    key: &str,
    ttl_sec: u64,
    value: &T,
) -> anyhow::Result<()> {
    let raw = serde_json::to_string(value).c(h!())?;
    let _: () = redis.set(key, raw).await.c(h!())?;
    let _: () = redis.expire(key, ttl_sec as i64).await.c(h!())?;
    Ok(())
}

pub async fn list_palitra_points_by_viewport_bounds(
    login: String,
    req: PalitraPointsReq,
    dbx: &DatabaseConnection,
) -> anyhow::Result<Vec<PalitraPoints>> {
    let allowed_palitra_ids = collect_palitra_ids(login, dbx).await.c(h!())?;
    let allowed_palitra_ids: HashSet<i64> =
        allowed_palitra_ids.into_iter().collect();
    let palitra_ids: Vec<i64> = req
        .palitra_ids
        .into_iter()
        .filter(|id| allowed_palitra_ids.contains(id))
        .collect();
    if palitra_ids.is_empty() {
        return Ok(vec![]);
    }

    let viewport_bounds = normalize_viewport_bounds(req.viewport_bounds);
    let points = palitra_point::Entity::find()
        .filter(palitra_point::Column::PalitraId.eq_any(palitra_ids.clone()))
        .filter(palitra_point::Column::Deleted.eq(false))
        .filter(palitra_point::Column::Lat.gte(viewport_bounds.min_lat))
        .filter(palitra_point::Column::Lat.lte(viewport_bounds.max_lat))
        .filter(palitra_point::Column::Lng.gte(viewport_bounds.min_lng))
        .filter(palitra_point::Column::Lng.lte(viewport_bounds.max_lng))
        .all(dbx)
        .await
        .c(h!())?;

    let mut points_by_id: HashMap<i64, Vec<PalitraPoint>> = HashMap::new();
    for point in points {
        points_by_id
            .entry(point.palitra_id)
            .or_default()
            .push(PalitraPoint {
                label: point.label,
                coords: Coords {
                    lat: point.lat,
                    lng: point.lng,
                },
            });
    }

    let result = palitra_ids
        .into_iter()
        .map(|palitra_id| PalitraPoints {
            palitra_id,
            points: points_by_id.remove(&palitra_id).unwrap_or_default(),
        })
        .collect();
    Ok(result)
}

pub async fn list_all_palitras(
    login: String,
    dbx: &DatabaseConnection,
) -> anyhow::Result<Vec<Palitra>> {
    let palitra_ids = collect_palitra_ids(login, dbx).await.c(h!())?;
    let mut result = vec![];
    for id in palitra_ids {
        let palitra = render_palitra(Either::Right(id), dbx).await.c(h!())?;
        result.push(palitra);
    }
    Ok(result)
}

pub async fn delete_palitra(
    id: i64,
    txn: &DatabaseTransaction,
) -> anyhow::Result<()> {
    palitra::Entity::update_many()
        .filter(palitra::Column::Id.eq(id))
        .filter(palitra::Column::Deleted.eq(false))
        .col_expr(palitra::Column::Deleted, Expr::value(true))
        .exec(txn)
        .await
        .c(h!())?;
    delete_existing_palitra_points(id, txn).await.c(h!())?;
    Ok(())
}

pub async fn create_palitra(
    author_login: String,
    req: CreatePalitraReq,
    dbx: &DatabaseConnection,
) -> anyhow::Result<Palitra> {
    let palitra_am = palitra::ActiveModel {
        author: Set(Some(author_login)),
        ..Default::default()
    };
    let palitra = update_palitra_from_req(
        req,
        palitra_am,
        dbx,
        PalitraUpdateAction::Insert,
    )
    .await
    .c(h!())?;
    render_palitra(Either::Left(palitra), dbx).await
}

async fn render_palitra_details<'a, 'async_trait, C>(
    txn: &'a C,
    palitra_ids: Vec<i64>,
) -> anyhow::Result<Vec<PalitraDetails>>
where
    C: ConnectionTrait + 'async_trait,
{
    let points = palitra_point::Entity::find()
        .filter(palitra_point::Column::PalitraId.eq_any(palitra_ids.clone()))
        .filter(palitra_point::Column::Deleted.eq(false))
        .all(txn)
        .await
        .c(h!())?;
    let mut result = vec![];
    for id in palitra_ids {
        let points = points
            .iter()
            .filter(|p| p.palitra_id.eq(&id))
            .map(|p| PalitraPoint {
                label: p.label.clone(),
                coords: Coords {
                    lat: p.lat,
                    lng: p.lng,
                },
            })
            .collect_vec();
        let palitra = render_palitra(Either::Right(id), txn).await.c(h!())?;
        result.push(PalitraDetails { palitra, points });
    }
    Ok(result)
}

fn normalize_viewport_bounds(
    viewport_bounds: ViewportBounds,
) -> ViewportBounds {
    let min_lat = viewport_bounds.min_lat.min(viewport_bounds.max_lat);
    let max_lat = viewport_bounds.min_lat.max(viewport_bounds.max_lat);
    let min_lng = viewport_bounds.min_lng.min(viewport_bounds.max_lng);
    let max_lng = viewport_bounds.min_lng.max(viewport_bounds.max_lng);
    ViewportBounds {
        min_lat,
        min_lng,
        max_lat,
        max_lng,
    }
}

async fn recalculate_center<'a, 'async_trait, C>(
    dbx: &'a C,
    palitra_id: i64,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'async_trait,
{
    let query = r"
        UPDATE palitra as p
        SET center = sub.calculated_center
        FROM (
            SELECT
                palitra_id,
                ST_Centroid(ST_Collect(ST_SetSRID(ST_MakePoint(lng, lat), 4326))) AS calculated_center
            FROM
                palitra_point
            WHERE
                deleted = FALSE
            GROUP BY
                palitra_id
        ) AS sub
        WHERE
            p.id = $1
            AND p.id = sub.palitra_id;
    ";
    dbx.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        query,
        [palitra_id.into()],
    ))
    .await
    .context(h!())?;
    Ok(())
}

/// calculates outer perimeter for points in palitra
async fn recalculate_convex_hull<'a, 'async_trait, C>(
    dbx: &'a C,
    palitra_id: i64,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'async_trait,
{
    let query = r"
        UPDATE palitra
        SET convex_hull = (
            SELECT
                ST_ExteriorRing(
                    ST_ConvexHull(
                        ST_Collect(ST_SetSRID(ST_MakePoint(lng, lat), 4326))
                    )
                )
            FROM
                palitra_point
            WHERE
                palitra_id = $1
                AND deleted = FALSE
            HAVING COUNT(id) > 2
        )
        WHERE
            id = $1;
    ";
    dbx.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        query,
        [palitra_id.into()],
    ))
    .await
    .context(h!())?;
    Ok(())
}

async fn read_palitra_convex_hull<'a, 'async_trait, C>(
    dbx: &'a C,
    palitra_id: i64,
) -> anyhow::Result<Vec<Coords>>
where
    C: ConnectionTrait + 'async_trait,
{
    #[derive(Debug, FromQueryResult)]
    pub struct Geometry {
        sequence_index: i32,
        lat: f64,
        lon: f64,
    }
    let query = r"
        SELECT
            (dp.path[1] - 1)::int4 AS sequence_index,
            ST_X(dp.geom) AS lon,
            ST_Y(dp.geom) AS lat
        FROM
            palitra,
            ST_DumpPoints(palitra.convex_hull) AS dp
        WHERE
            palitra.id = $1
            and palitra.convex_hull is not null
        ORDER BY
            sequence_index;
    ";
    let mut convex_hull: Vec<Geometry> =
        Geometry::find_by_statement(Statement::from_sql_and_values(
            DbBackend::Postgres,
            query,
            [palitra_id.into()],
        ))
        .all(dbx)
        .await
        .context(h!())?;
    convex_hull.sort_by_key(|g| g.sequence_index);
    Ok(convex_hull
        .into_iter()
        .map(|c| Coords {
            lat: c.lat,
            lng: c.lon,
        })
        .collect())
}

async fn read_palitra_center<'a, 'async_trait, C>(
    dbx: &'a C,
    palitra_id: i64,
) -> anyhow::Result<Option<Coords>>
where
    C: ConnectionTrait + 'async_trait,
{
    #[derive(Debug, FromQueryResult)]
    pub struct Geometry {
        lat: f64,
        lon: f64,
    }
    let query = r"
       SELECT
            ST_Y(center) AS lat,
            ST_X(center) AS lon
        FROM
            palitra
        WHERE
            palitra.id = $1
            and center is not null;
    ";
    let center = Geometry::find_by_statement(Statement::from_sql_and_values(
        DbBackend::Postgres,
        query,
        [palitra_id.into()],
    ))
    .one(dbx)
    .await
    .context(h!())?;
    Ok(center.map(|c| Coords {
        lat: c.lat,
        lng: c.lon,
    }))
}

pub async fn rewrite_palitra_points(
    palitra_id: i64,
    coords: Vec<PalitraPoint>,
    txn: &DatabaseTransaction,
) -> anyhow::Result<()> {
    let now = Utc::now().naive_utc();
    palitra::Entity::update_many()
        .filter(palitra::Column::Id.eq(palitra_id))
        .col_expr(palitra::Column::LastUploadedAt, Expr::value(now))
        .exec(txn)
        .await
        .c(h!())?;
    delete_existing_palitra_points(palitra_id, txn)
        .await
        .c(h!())?;
    let mut points_batch =
        Vec::with_capacity(crate::config::PALITRA_POINTS_INSERT_BATCH_SIZE);
    for point in coords {
        points_batch.push(palitra_point::ActiveModel {
            id: NotSet,
            label: Set(point.label),
            palitra_id: Set(palitra_id),
            lat: Set(point.coords.lat),
            lng: Set(point.coords.lng),
            deleted: NotSet,
            deleted_at: NotSet,
            created_at: NotSet,
        });
        if points_batch.len() >= crate::config::PALITRA_POINTS_INSERT_BATCH_SIZE
        {
            palitra_point::Entity::insert_many(points_batch)
                .exec(txn)
                .await
                .context(h!())?;
            points_batch = Vec::with_capacity(
                crate::config::PALITRA_POINTS_INSERT_BATCH_SIZE,
            );
        }
    }
    if !points_batch.is_empty() {
        palitra_point::Entity::insert_many(points_batch)
            .exec(txn)
            .await
            .context(h!())?;
    }
    recalculate_center(txn, palitra_id).await.c(h!())?;
    recalculate_convex_hull(txn, palitra_id).await.c(h!())?;
    Ok(())
}

async fn delete_existing_palitra_points(
    palitra_id: i64,
    txn: &DatabaseTransaction,
) -> anyhow::Result<()> {
    let now = Utc::now().naive_utc();
    palitra_point::Entity::update_many()
        .filter(palitra_point::Column::PalitraId.eq(palitra_id))
        .filter(palitra_point::Column::Deleted.eq(false))
        .col_expr(palitra_point::Column::Deleted, Expr::value(true))
        .col_expr(palitra_point::Column::DeletedAt, Expr::value(now))
        .exec(txn)
        .await
        .context(h!())?;
    Ok(())
}

async fn render_palitra<'a, 'async_trait, C>(
    e_palitra_model: Either<palitra::Model, i64>,
    dbx: &'a C,
) -> anyhow::Result<Palitra>
where
    C: ConnectionTrait + 'async_trait,
{
    let palitra_model = match e_palitra_model {
        Either::Left(model) => model,
        Either::Right(id) => palitra::Entity::find_by_id(id)
            .one(dbx)
            .await
            .c(h!())?
            .c(h!())?,
    };
    let palitra_id = palitra_model.id;
    let last_uploaded_at_ts = palitra_model
        .last_uploaded_at
        .map(|ts| ts.and_utc().timestamp_millis());
    let center = read_palitra_center(dbx, palitra_id).await.c(h!())?;
    let convex_hull = match read_palitra_convex_hull(dbx, palitra_id).await {
        Ok(c) => Some(c),
        Err(e) => {
            error!("failed to calculate convex hull center: {e:#?}");
            None
        }
    };
    let geometry = match (center, convex_hull) {
        (Some(center), Some(perimeter_linear_ring)) => Some(Geometry {
            center,
            perimeter_linear_ring,
        }),
        _ => None,
    };
    let access_aor_ids =
        collect_palitra_access_aors(dbx, palitra_id).await.c(h!())?;
    let access_organism_ids = collect_palitra_access_organisms(dbx, palitra_id)
        .await
        .c(h!())?;
    let access_logins = collect_palitra_access_logins(dbx, palitra_id)
        .await
        .c(h!())?;
    Ok(Palitra {
        id: palitra_id,
        name: palitra_model.name,
        color_hex: palitra_model.hex,
        author: palitra_model.author,
        source_file_name: palitra_model.source_file_name,
        last_uploaded_at_ts,
        geometry,
        access_aor_id: access_aor_ids,
        access_organism_ids,
        access_logins,
    })
}

async fn collect_palitra_ids(
    login: String,
    dbx: &DatabaseConnection,
) -> anyhow::Result<Vec<i64>> {
    // only direct organism (no parents), only AOR with is_top_level = true
    let organism_aors = organism_aor::Entity::find()
        .join(JoinType::InnerJoin, organism_aor::Relation::Organism.def())
        .join(JoinType::InnerJoin, organism::Relation::Login.def())
        .filter(login::Column::Login.eq(login.clone()))
        .all(dbx)
        .await
        .c(h!())?;
    let login_organism_ids = organism_aors
        .iter()
        .map(|o| o.organism_id)
        .collect::<Vec<_>>();
    let login_aor_ids = organism_aors
        .into_iter()
        .map(|x| x.aor_id)
        .collect::<Vec<_>>();
    let login_filter = Condition::any()
        .add(login::Column::Login.contains(login))
        .add(login::Column::Login.is_null());
    let organism_filter = Condition::any()
        .add(organism::Column::Id.eq_any(login_organism_ids))
        .add(organism::Column::Id.is_null());
    let aor_filter = Condition::any()
        .add(area_of_responsibility::Column::Id.eq_any(login_aor_ids))
        .add(area_of_responsibility::Column::Id.is_null());
    let filter = Condition::all()
        .add(login_filter)
        .add(aor_filter)
        .add(organism_filter);
    palitra::Entity::find()
        .join(
            JoinType::LeftJoin,
            palitra::Relation::PalitraAccessAor.def(),
        )
        .join(
            JoinType::LeftJoin,
            palitra::Relation::PalitraAccessLogin.def(),
        )
        .join(
            JoinType::LeftJoin,
            palitra::Relation::PalitraAccessOrganism.def(),
        )
        .join(
            JoinType::LeftJoin,
            palitra_access_aor::Relation::AreaOfResponsibility.def(),
        )
        .join(
            JoinType::LeftJoin,
            palitra_access_login::Relation::Login.def(),
        )
        .join(
            JoinType::LeftJoin,
            palitra_access_organism::Relation::Organism.def(),
        )
        .select_only()
        .column(palitra::Column::Id)
        .group_by(palitra::Column::Id)
        .filter(palitra::Column::Deleted.eq(false))
        .filter(filter)
        .into_tuple::<i64>()
        .all(dbx)
        .await
        .c(h!())
}

async fn update_palitra_from_req<'a, 'async_trait, C>(
    req: CreatePalitraReq,
    palitra_val: palitra::ActiveModel,
    txn: &'a C,
    action: PalitraUpdateAction,
) -> anyhow::Result<palitra::Model>
where
    C: ConnectionTrait + 'async_trait,
{
    info!("updating palitra:\n old value {palitra_val:?}\n changes requested: {req:?}");
    let mut palitra = palitra_val;
    palitra.name = Set(req.name);
    palitra.hex = Set(req.color_hex);
    let parse_uploaded_at = |ts| {
        DateTime::from_timestamp_millis(ts)
            .map(|dt| dt.naive_utc())
            .ok_or_else(|| anyhow::anyhow!("Invalid timestamp: {ts}"))
    };
    match action {
        PalitraUpdateAction::Update => {
            if let Some(source_file_name) = req.source_file_name {
                palitra.source_file_name = Set(Some(source_file_name));
            }
            if let Some(last_uploaded_at_ts) = req.last_uploaded_at_ts {
                palitra.last_uploaded_at =
                    Set(Some(parse_uploaded_at(last_uploaded_at_ts).c(h!())?));
            }
        }
        PalitraUpdateAction::Insert => {
            palitra.source_file_name = Set(req.source_file_name);
            palitra.last_uploaded_at = Set(req
                .last_uploaded_at_ts
                .map(parse_uploaded_at)
                .transpose()
                .c(h!())?);
        }
    }
    let palitra = match action {
        PalitraUpdateAction::Update => palitra.update(txn).await.c(h!())?,
        PalitraUpdateAction::Insert => palitra.insert(txn).await.c(h!())?,
    };
    palitra_access_login::Entity::delete_many()
        .filter(palitra_access_login::Column::PalitraId.eq(palitra.id))
        .exec(txn)
        .await
        .c(h!())?;
    palitra_access_organism::Entity::delete_many()
        .filter(palitra_access_organism::Column::PalitraId.eq(palitra.id))
        .exec(txn)
        .await
        .c(h!())?;
    palitra_access_aor::Entity::delete_many()
        .filter(palitra_access_aor::Column::PalitraId.eq(palitra.id))
        .exec(txn)
        .await
        .c(h!())?;
    match req.access {
        PalitraAccess::ByLogins { logins } => {
            if !logins.is_empty() {
                let logins = logins
                    .into_iter()
                    .map(|login| palitra_access_login::ActiveModel {
                        id: NotSet,
                        palitra_id: Set(palitra.id),
                        login: Set(login),
                        created_at: NotSet,
                    })
                    .collect_vec();
                palitra_access_login::Entity::insert_many(logins)
                    .exec(txn)
                    .await
                    .c(h!())?;
            }
        }
        PalitraAccess::ByOrganisms { organism_ids } => {
            if !organism_ids.is_empty() {
                let organisms = organism_ids
                    .into_iter()
                    .map(|organism_id| palitra_access_organism::ActiveModel {
                        id: NotSet,
                        palitra_id: Set(palitra.id),
                        organism_id: Set(organism_id),
                        created_at: NotSet,
                    })
                    .collect_vec();
                palitra_access_organism::Entity::insert_many(organisms)
                    .exec(txn)
                    .await
                    .c(h!())?;
            }
        }
        PalitraAccess::ByAor { aor_ids } => {
            if !aor_ids.is_empty() {
                let aors = aor_ids
                    .into_iter()
                    .map(|aor_id| palitra_access_aor::ActiveModel {
                        id: NotSet,
                        palitra_id: Set(palitra.id),
                        aor_id: Set(aor_id),
                        created_at: NotSet,
                    })
                    .collect_vec();
                palitra_access_aor::Entity::insert_many(aors)
                    .exec(txn)
                    .await
                    .c(h!())?;
            }
        }
    }
    Ok(palitra)
}
