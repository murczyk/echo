use crate::entities::*;
use crate::h;
use crate::palitra::sync_delete_palitra_from_connected_organisms;
use crate::palitra::types::*;
use crate::types::*;
use crate::utils::orm::ArrayColumnOps;
use actix_web::web::Data;
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

    let palitra_geometries = palitra_geometry::Entity::find()
        .filter(palitra_geometry::Column::PalitraId.is_in(palitra_ids.clone()))
        .filter(palitra_geometry::Column::Deleted.eq(false))
        .select_only()
        .column(palitra_geometry::Column::Id)
        .column(palitra_geometry::Column::PalitraId)
        .into_tuple::<(i64, i64)>()
        .all(dbx)
        .await
        .c(h!())?;
    let palitra_geometry_id_to_palitra_id = palitra_geometries
        .iter()
        .copied()
        .collect::<HashMap<_, _>>();
    let palitra_geometry_ids = palitra_geometries
        .into_iter()
        .map(|(id, _)| id)
        .collect_vec();
    if palitra_geometry_ids.is_empty() {
        return Ok(vec![]);
    }

    let points = palitra_point::Entity::find()
        .select_only()
        .column(palitra_point::Column::PalitraGeometryId)
        .column(palitra_point::Column::Lat)
        .column(palitra_point::Column::Lng)
        .column(palitra_point::Column::Label)
        .filter(
            palitra_point::Column::PalitraGeometryId
                .is_in(palitra_geometry_ids.clone()),
        )
        .filter(palitra_point::Column::Deleted.eq(false))
        .filter(palitra_point::Column::Label.is_not_null())
        .filter(label_condition)
        .into_tuple::<(i64, f64, f64, Option<String>)>()
        .all(dbx)
        .await
        .c(h!())?;

    let mut points_by_palitra_id: HashMap<i64, Vec<PalitraPoint>> =
        HashMap::new();
    for (palitra_geometry_id, lat, lng, label) in points {
        let Some(palitra_id) = palitra_geometry_id_to_palitra_id
            .get(&palitra_geometry_id)
            .copied()
        else {
            warn!(
                "palitra_geometry {} is missing palitra_id mapping while searching points by labels",
                palitra_geometry_id
            );
            continue;
        };
        if let Some(label_value) = label.clone() {
            if let Some(normalized_label) = normalize_label_cache(&label_value)
            {
                let mut matched_any = false;
                for pattern in &label_patterns {
                    if pattern.matches(&normalized_label) {
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

        points_by_palitra_id.entry(palitra_id).or_default().push(
            PalitraPoint {
                label,
                coords: Coords { lat, lng },
                color: None,
            },
        );
    }

    let result = palitra_ids
        .into_iter()
        .filter_map(|palitra_id| {
            let points =
                points_by_palitra_id.remove(&palitra_id).unwrap_or_default();
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

    let palitra_geometries = palitra_geometry::Entity::find()
        .filter(palitra_geometry::Column::PalitraId.is_in(palitra_ids))
        .filter(palitra_geometry::Column::Deleted.eq(false))
        .select_only()
        .column(palitra_geometry::Column::Id)
        .column(palitra_geometry::Column::PalitraId)
        .into_tuple::<(i64, i64)>()
        .all(dbx)
        .await
        .c(h!())?;
    let palitra_geometry_id_to_palitra_id = palitra_geometries
        .iter()
        .copied()
        .collect::<HashMap<_, _>>();
    let palitra_geometry_ids = palitra_geometries
        .into_iter()
        .map(|(id, _)| id)
        .collect_vec();
    if palitra_geometry_ids.is_empty() {
        return Ok(vec![]);
    }

    let labels = palitra_point::Entity::find()
        .select_only()
        .column(palitra_point::Column::PalitraGeometryId)
        .column(palitra_point::Column::Label)
        .filter(
            palitra_point::Column::PalitraGeometryId
                .is_in(palitra_geometry_ids.clone()),
        )
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
        .filter_map(|(palitra_geometry_id, label)| {
            palitra_geometry_id_to_palitra_id
                .get(&palitra_geometry_id)
                .copied()
                .map(|palitra_id| PalitraPointLabelSuggestRsp {
                    palitra_id,
                    label: label.unwrap_or_default(),
                })
        })
        .collect();

    if labels.len() < limit as usize {
        let remaining = limit - labels.len() as u64;
        let similar_pattern = build_label_pattern(&normalized_prefix, true);
        let mut similar_query = palitra_point::Entity::find()
            .select_only()
            .column(palitra_point::Column::PalitraGeometryId)
            .column(palitra_point::Column::Label)
            .filter(
                palitra_point::Column::PalitraGeometryId
                    .is_in(palitra_geometry_ids),
            )
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

        labels.extend(similar.into_iter().filter_map(
            |(palitra_geometry_id, label)| {
                palitra_geometry_id_to_palitra_id
                    .get(&palitra_geometry_id)
                    .copied()
                    .map(|palitra_id| PalitraPointLabelSuggestRsp {
                        palitra_id,
                        label: label.unwrap_or_default(),
                    })
            },
        ));
    }

    let mut seen = HashSet::new();
    labels.retain(|item| seen.insert((item.palitra_id, item.label.clone())));
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

    let palitra_geometries = palitra_geometry::Entity::find()
        .filter(palitra_geometry::Column::PalitraId.is_in(palitra_ids.clone()))
        .filter(palitra_geometry::Column::Deleted.eq(false))
        .select_only()
        .column(palitra_geometry::Column::Id)
        .column(palitra_geometry::Column::PalitraId)
        .into_tuple::<(i64, i64)>()
        .all(dbx)
        .await
        .c(h!())?;
    let palitra_geometry_id_to_palitra_id = palitra_geometries
        .iter()
        .copied()
        .collect::<HashMap<_, _>>();
    let palitra_geometry_ids = palitra_geometries
        .into_iter()
        .map(|(id, _)| id)
        .collect_vec();

    if palitra_geometry_ids.is_empty() {
        return Ok(vec![]);
    }

    let viewport_bounds = normalize_viewport_bounds(req.viewport_bounds);
    let points = palitra_point::Entity::find()
        .filter(
            palitra_point::Column::PalitraGeometryId
                .eq_any(palitra_geometry_ids.clone()),
        )
        .filter(palitra_point::Column::Deleted.eq(false))
        .filter(palitra_point::Column::Lat.gte(viewport_bounds.min_lat))
        .filter(palitra_point::Column::Lat.lte(viewport_bounds.max_lat))
        .filter(palitra_point::Column::Lng.gte(viewport_bounds.min_lng))
        .filter(palitra_point::Column::Lng.lte(viewport_bounds.max_lng))
        .all(dbx)
        .await
        .c(h!())?;

    let mut points_by_palitra_id: HashMap<i64, Vec<PalitraPoint>> =
        HashMap::new();
    for point in points {
        let Some(palitra_id) = palitra_geometry_id_to_palitra_id
            .get(&point.palitra_geometry_id)
            .copied()
        else {
            warn!(
                "palitra_geometry {} is missing palitra_id mapping while listing points by viewport",
                point.palitra_geometry_id
            );
            continue;
        };
        points_by_palitra_id.entry(palitra_id).or_default().push(
            PalitraPoint {
                label: point.label,
                coords: Coords {
                    lat: point.lat,
                    lng: point.lng,
                },
                color: None,
            },
        );
    }

    let result = palitra_ids
        .into_iter()
        .map(|palitra_id| PalitraPoints {
            palitra_id,
            points: points_by_palitra_id
                .remove(&palitra_id)
                .unwrap_or_default(),
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
    existing_access: PalitraAccess,
    env: &Data<Env>,
) -> anyhow::Result<()> {
    palitra::Entity::update_many()
        .filter(palitra::Column::Id.eq(id))
        .filter(palitra::Column::Deleted.eq(false))
        .col_expr(palitra::Column::Deleted, Expr::value(true))
        .exec(txn)
        .await
        .c(h!())?;
    let palitra_geometries = palitra_geometry::Entity::find()
        .filter(palitra_geometry::Column::PalitraId.eq(id))
        .filter(palitra_geometry::Column::Deleted.eq(false))
        .all(txn)
        .await
        .c(h!())?;
    let mut palitra_geometry_ids = vec![];
    for geometry in palitra_geometries {
        palitra_geometry_ids.push(geometry.id);
        sync_delete_palitra_from_connected_organisms(
            &env.dbx, // even if transaction rolls back we must save these changes to db because they perform some changes to filesystem
            &existing_access,
            &geometry.source_file_name,
        )
        .await
        .c(h!())?;
    }

    palitra_geometry::Entity::update_many()
        .filter(palitra_geometry::Column::PalitraId.eq(id))
        .filter(palitra_geometry::Column::Deleted.eq(false))
        .col_expr(palitra_geometry::Column::Deleted, Expr::value(true))
        .exec(txn)
        .await
        .c(h!())?;
    for palitra_geometry_id in palitra_geometry_ids {
        delete_existing_palitra_points(palitra_geometry_id, txn)
            .await
            .c(h!())?;
    }
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
    let palitra_geometries = palitra_geometry::Entity::find()
        .filter(palitra_geometry::Column::PalitraId.is_in(palitra_ids.clone()))
        .filter(palitra_geometry::Column::Deleted.eq(false))
        .select_only()
        .column(palitra_geometry::Column::Id)
        .column(palitra_geometry::Column::PalitraId)
        .into_tuple::<(i64, i64)>()
        .all(txn)
        .await
        .c(h!())?;
    let palitra_geometry_id_to_palitra_id = palitra_geometries
        .iter()
        .copied()
        .collect::<HashMap<_, _>>();
    let mut palitra_geometry_ids_by_palitra_id: HashMap<i64, Vec<i64>> =
        HashMap::new();
    for (palitra_geometry_id, palitra_id) in palitra_geometries {
        palitra_geometry_ids_by_palitra_id
            .entry(palitra_id)
            .or_default()
            .push(palitra_geometry_id);
    }
    for (palitra_id, geometry_ids) in &palitra_geometry_ids_by_palitra_id {
        if geometry_ids.len() > 1 {
            warn!(
                "palitra {palitra_id} has {} active geometries; list-detailed currently merges points into one palitra response",
                geometry_ids.len()
            );
        }
    }

    let all_palitra_geometry_ids = palitra_geometry_id_to_palitra_id
        .keys()
        .copied()
        .collect_vec();
    let points = if all_palitra_geometry_ids.is_empty() {
        vec![]
    } else {
        palitra_point::Entity::find()
            .filter(
                palitra_point::Column::PalitraGeometryId
                    .is_in(all_palitra_geometry_ids),
            )
            .filter(palitra_point::Column::Deleted.eq(false))
            .all(txn)
            .await
            .c(h!())?
    };

    let mut points_by_palitra_id: HashMap<i64, Vec<PalitraPoint>> =
        HashMap::new();
    for point in points {
        let Some(palitra_id) = palitra_geometry_id_to_palitra_id
            .get(&point.palitra_geometry_id)
            .copied()
        else {
            warn!(
                "palitra_geometry {} is missing palitra_id mapping while rendering palitra details",
                point.palitra_geometry_id
            );
            continue;
        };
        points_by_palitra_id.entry(palitra_id).or_default().push(
            PalitraPoint {
                label: point.label,
                coords: Coords {
                    lat: point.lat,
                    lng: point.lng,
                },
                color: None,
            },
        );
    }

    let mut result = vec![];
    for palitra_id in palitra_ids {
        let points =
            points_by_palitra_id.remove(&palitra_id).unwrap_or_default();
        let palitra = render_palitra(Either::Right(palitra_id), txn)
            .await
            .c(h!())?;
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
    palitra_geometry_id: i64,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'async_trait,
{
    let query = r"
        UPDATE palitra_geometry as p
        SET center = sub.calculated_center
        FROM (
            SELECT
                palitra_geometry_id,
                ST_Centroid(ST_Collect(ST_SetSRID(ST_MakePoint(lng, lat), 4326))) AS calculated_center
            FROM
                palitra_point
            WHERE
                deleted = FALSE
            GROUP BY
                palitra_geometry_id
        ) AS sub
        WHERE
            p.id = $1
            AND p.id = sub.palitra_geometry_id;
    ";
    dbx.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        query,
        [palitra_geometry_id.into()],
    ))
    .await
    .context(h!())?;
    Ok(())
}

/// calculates outer perimeter for points in palitra
async fn recalculate_convex_hull<'a, 'async_trait, C>(
    dbx: &'a C,
    palitra_geometry_id: i64,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'async_trait,
{
    let query = r"
        UPDATE palitra_geometry
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
                palitra_geometry_id = $1
                AND deleted = FALSE
            HAVING COUNT(id) > 2
        )
        WHERE
            id = $1;
    ";
    dbx.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        query,
        [palitra_geometry_id.into()],
    ))
    .await
    .context(h!())?;
    Ok(())
}

async fn read_palitra_convex_hull<'a, 'async_trait, C>(
    dbx: &'a C,
    palitra_geometry_id: i64,
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
            palitra_geometry,
            ST_DumpPoints(palitra_geometry.convex_hull) AS dp
        WHERE
            palitra_geometry.id = $1
            and palitra_geometry.convex_hull is not null
        ORDER BY
            sequence_index;
    ";
    let mut convex_hull: Vec<Geometry> =
        Geometry::find_by_statement(Statement::from_sql_and_values(
            DbBackend::Postgres,
            query,
            [palitra_geometry_id.into()],
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
    palitra_geometry_id: i64,
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
            palitra_geometry
        WHERE
            palitra_geometry.id = $1
            and center is not null;
    ";
    let center = Geometry::find_by_statement(Statement::from_sql_and_values(
        DbBackend::Postgres,
        query,
        [palitra_geometry_id.into()],
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
    palitra_geometry_id: i64,
    coords: Vec<PalitraPoint>,
    txn: &DatabaseTransaction,
) -> anyhow::Result<()> {
    let palitra_geometry =
        palitra_geometry::Entity::find_by_id(palitra_geometry_id)
            .one(txn)
            .await
            .c(h!())?;
    let Some(palitra_geometry) = palitra_geometry else {
        error!("palitra_geometry not found by id {palitra_geometry_id}");
        return Ok(());
    };
    delete_existing_palitra_points(palitra_geometry_id, txn)
        .await
        .c(h!())?;
    let mut points_batch =
        Vec::with_capacity(crate::config::PALITRA_POINTS_INSERT_BATCH_SIZE);
    let mut points_with_fallback_color = 0usize;
    let mut skipped_points_with_unexpected_color = 0usize;
    for point in coords {
        let point_color = point.color.unwrap_or_else(|| {
            crate::config::PALITRA_POINT_FALLBACK_COLOR_HEX.to_string()
        });
        let is_fallback_color =
            point_color == crate::config::PALITRA_POINT_FALLBACK_COLOR_HEX;
        if is_fallback_color {
            points_with_fallback_color += 1;
        }
        if !is_fallback_color && !palitra_geometry.hex.eq(&point_color) {
            skipped_points_with_unexpected_color += 1;
            continue;
        }
        points_batch.push(palitra_point::ActiveModel {
            id: NotSet,
            label: Set(point.label),
            palitra_geometry_id: Set(palitra_geometry_id),
            lat: Set(point.coords.lat),
            lng: Set(point.coords.lng),
            deleted: NotSet,
            deleted_at: NotSet,
            created_at: NotSet,
            palitra_id_legacy: NotSet,
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
    if points_with_fallback_color > 0 {
        error!(
            "palitra geometry {} received {} points with fallback color {} while mapping KMZ data",
            palitra_geometry_id,
            points_with_fallback_color,
            crate::config::PALITRA_POINT_FALLBACK_COLOR_HEX
        );
    }
    if skipped_points_with_unexpected_color > 0 {
        warn!(
            "skipped {} points in geometry {} due to color mismatch with selected geometry color {}",
            skipped_points_with_unexpected_color,
            palitra_geometry_id,
            palitra_geometry.hex
        );
    }
    if !points_batch.is_empty() {
        palitra_point::Entity::insert_many(points_batch)
            .exec(txn)
            .await
            .context(h!())?;
    }
    recalculate_center(txn, palitra_geometry_id).await.c(h!())?;
    recalculate_convex_hull(txn, palitra_geometry_id)
        .await
        .c(h!())?;
    Ok(())
}

async fn delete_existing_palitra_points(
    palitra_geometry_id: i64,
    txn: &DatabaseTransaction,
) -> anyhow::Result<()> {
    let now = Utc::now().naive_utc();
    palitra_point::Entity::update_many()
        .filter(
            palitra_point::Column::PalitraGeometryId.eq(palitra_geometry_id),
        )
        .filter(palitra_point::Column::Deleted.eq(false))
        .col_expr(palitra_point::Column::Deleted, Expr::value(true))
        .col_expr(palitra_point::Column::DeletedAt, Expr::value(now))
        .exec(txn)
        .await
        .context(h!())?;
    Ok(())
}

async fn read_latest_palitra_geometry_with_warning<'a, 'async_trait, C>(
    dbx: &'a C,
    palitra_id: i64,
) -> anyhow::Result<Option<palitra_geometry::Model>>
where
    C: ConnectionTrait + 'async_trait,
{
    let palitra_geometries = palitra_geometry::Entity::find()
        .filter(palitra_geometry::Column::PalitraId.eq(palitra_id))
        .filter(palitra_geometry::Column::Deleted.eq(false))
        .order_by_desc(palitra_geometry::Column::UpdatedAt)
        .all(dbx)
        .await
        .c(h!())?;
    if palitra_geometries.len() > 1 {
        warn!(
            "palitra {palitra_id} has {} active geometries; using latest one for single-geometry flow",
            palitra_geometries.len()
        );
    }
    Ok(palitra_geometries.into_iter().next())
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
    let (
        color_hex,
        source_file_name,
        last_uploaded_at_ts,
        m_palitra_geometry_id,
    ) = match read_latest_palitra_geometry_with_warning(dbx, palitra_id)
        .await
        .c(h!())?
    {
        None => {
            error!("no palitra geometry found for palitra {palitra_id}!");
            ("#ff0000".to_string(), None, None, None)
        }
        Some(pg) => (
            pg.hex,
            pg.source_file_name,
            pg.last_uploaded_at
                .map(|ts| ts.and_utc().timestamp_millis()),
            Some(pg.id),
        ),
    };
    let (center, convex_hull) = match m_palitra_geometry_id {
        Some(palitra_geometry_id) => {
            let center = read_palitra_center(dbx, palitra_geometry_id)
                .await
                .c(h!())?;
            let convex_hull = match read_palitra_convex_hull(
                dbx,
                palitra_geometry_id,
            )
            .await
            {
                Ok(c) => Some(c),
                Err(e) => {
                    error!("failed to calculate convex hull center: {e:#?}");
                    None
                }
            };
            (center, convex_hull)
        }
        None => (None, None),
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
        color_hex,
        author: palitra_model.author,
        source_file_name,
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
    let request = req.clone();
    let mut palitra = palitra_val;
    palitra.name = Set(req.name);
    let parse_uploaded_at = |ts| {
        DateTime::from_timestamp_millis(ts)
            .map(|dt| dt.naive_utc())
            .ok_or_else(|| anyhow::anyhow!("Invalid timestamp: {ts}"))
    };
    let palitra = match action {
        PalitraUpdateAction::Update => palitra.update(txn).await.c(h!())?,
        PalitraUpdateAction::Insert => palitra.insert(txn).await.c(h!())?,
    };
    let palitra_id = palitra.id;
    let last_uploaded_at_ts = req
        .last_uploaded_at_ts
        .map(parse_uploaded_at)
        .transpose()
        .c(h!())?;
    let _palitra_geometry = match action {
        PalitraUpdateAction::Insert => insert_new_palitra_geometry(
            &request,
            txn,
            &palitra,
            last_uploaded_at_ts,
        )
        .await
        .c(h!())?,
        PalitraUpdateAction::Update => {
            let request = request.clone();
            let palitra_geometries = palitra_geometry::Entity::find()
                .filter(palitra_geometry::Column::PalitraId.eq(palitra_id))
                .filter(palitra_geometry::Column::Hex.eq(req.color_hex.clone()))
                .filter(palitra_geometry::Column::Deleted.eq(false))
                .order_by_desc(palitra_geometry::Column::UpdatedAt)
                .all(txn)
                .await
                .c(h!())?;
            if palitra_geometries.len() > 1 {
                warn!(
                    "palitra {palitra_id} has {} active geometries with color {}; using latest for update",
                    palitra_geometries.len(),
                    req.color_hex
                );
            }
            if let Some(palitra_geometry) =
                palitra_geometries.into_iter().next()
            {
                let mut palitra_geometry = palitra_geometry.into_active_model();
                if let Some(source_file_name) = req.source_file_name {
                    palitra_geometry.source_file_name =
                        Set(Some(source_file_name));
                }
                if let Some(last_uploaded_at_ts) = req.last_uploaded_at_ts {
                    palitra_geometry.last_uploaded_at = Set(Some(
                        parse_uploaded_at(last_uploaded_at_ts).c(h!())?,
                    ));
                }
                palitra_geometry.update(txn).await.c(h!())?
            } else {
                warn!(
                    "palitra {palitra_id} has no active geometry with color {}; creating a new geometry as fallback",
                    req.color_hex
                );
                insert_new_palitra_geometry(
                    &request,
                    txn,
                    &palitra,
                    last_uploaded_at_ts,
                )
                .await
                .c(h!())?
            }
        }
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

async fn insert_new_palitra_geometry<'a, 'async_trait, C>(
    req: &CreatePalitraReq,
    txn: &'a C,
    palitra: &palitra::Model,
    last_uploaded_at_ts: Option<NaiveDateTime>,
) -> anyhow::Result<palitra_geometry::Model>
where
    C: ConnectionTrait + 'async_trait,
{
    palitra_geometry::ActiveModel {
        id: NotSet,
        palitra_id: Set(palitra.id),
        hex: Set(req.color_hex.clone()),
        source_file_name: Set(req.source_file_name.clone()),
        deleted: NotSet,
        created_at: NotSet,
        last_uploaded_at: Set(last_uploaded_at_ts),
        updated_at: NotSet,
        convex_hull: NotSet,
        center: NotSet,
    }
    .insert(txn)
    .await
    .c(h!())
}

#[cfg(test)]
mod tests {
    use crate::functest::tests::{
        cleanup, find_test_login, find_test_palitra, mk_palitra_point,
    };
    use crate::palitra::bl::search_palitra_points_by_labels;
    use crate::palitra::types::PalitraSearchPointsReq;
    use serial_test::serial;

    #[serial]
    #[tokio::test]
    async fn test_palitra_search_full_phrase() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();

        let label = "лісосмуга 12".to_string();
        let palitra = find_test_palitra(&env.dbx).await.unwrap();
        mk_palitra_point(label.clone(), palitra.id, &env.dbx)
            .await
            .unwrap();

        let req =
            create_palitra_search_request(palitra.id, vec![label.clone()])
                .await;
        let res = search_palitra_points_by_labels(login.login, req, &env.dbx)
            .await
            .unwrap();
        assert_eq!(res.len(), 1);
        assert_eq!(res[0].points.len(), 1);
        assert_eq!(res[0].points[0].label.as_deref(), Some("лісосмуга 12"));
    }

    #[serial]
    #[tokio::test]
    async fn test_palitra_search_prefix() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();

        let labels = ["1лісосмуга 12".to_string(), "2лісосмуга 12".to_string()];
        let label_search = "*лісосмуга 12".to_string();
        let palitra = find_test_palitra(&env.dbx).await.unwrap();
        mk_palitra_point(labels[0].clone(), palitra.id, &env.dbx)
            .await
            .unwrap();
        mk_palitra_point(labels[1].clone(), palitra.id, &env.dbx)
            .await
            .unwrap();

        let req = create_palitra_search_request(
            palitra.id,
            vec![label_search.clone()],
        )
        .await;
        let res = search_palitra_points_by_labels(login.login, req, &env.dbx)
            .await
            .unwrap();
        assert_eq!(res.len(), 1);
        assert_eq!(res[0].points.len(), 2);
        assert_eq!(res[0].points[0].label.as_deref(), Some("1лісосмуга 12"));
        assert_eq!(res[0].points[1].label.as_deref(), Some("2лісосмуга 12"));
    }

    #[serial]
    #[tokio::test]
    async fn test_palitra_search_suffix() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();

        let labels = ["лісосмуга 12".to_string(), "лісосмуга 13".to_string()];
        let label_search = "лісосмуга 1*".to_string();
        let palitra = find_test_palitra(&env.dbx).await.unwrap();
        mk_palitra_point(labels[0].clone(), palitra.id, &env.dbx)
            .await
            .unwrap();
        mk_palitra_point(labels[1].clone(), palitra.id, &env.dbx)
            .await
            .unwrap();

        let req = create_palitra_search_request(
            palitra.id,
            vec![label_search.clone()],
        )
        .await;
        let res = search_palitra_points_by_labels(login.login, req, &env.dbx)
            .await
            .unwrap();
        assert_eq!(res.len(), 1);
        assert_eq!(res[0].points.len(), 2);
        assert_eq!(res[0].points[0].label.as_deref(), Some("лісосмуга 12"));
        assert_eq!(res[0].points[1].label.as_deref(), Some("лісосмуга 13"));
    }

    #[serial]
    #[tokio::test]
    async fn test_palitra_search_prefix_and_suffix() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();

        let labels = ["1лісосмуга 12".to_string(), "2лісосмуга 13".to_string()];
        let label_search = "*лісосмуга 1*".to_string();
        let palitra = find_test_palitra(&env.dbx).await.unwrap();
        mk_palitra_point(labels[0].clone(), palitra.id, &env.dbx)
            .await
            .unwrap();
        mk_palitra_point(labels[1].clone(), palitra.id, &env.dbx)
            .await
            .unwrap();

        let req = create_palitra_search_request(
            palitra.id,
            vec![label_search.clone()],
        )
        .await;
        let res = search_palitra_points_by_labels(login.login, req, &env.dbx)
            .await
            .unwrap();
        assert_eq!(res.len(), 1);
        assert_eq!(res[0].points.len(), 2);
        assert_eq!(res[0].points[0].label.as_deref(), Some("1лісосмуга 12"));
        assert_eq!(res[0].points[1].label.as_deref(), Some("2лісосмуга 13"));
    }

    async fn create_palitra_search_request(
        palitra_id: i64,
        labels: Vec<String>,
    ) -> PalitraSearchPointsReq {
        PalitraSearchPointsReq {
            palitra_ids: vec![palitra_id],
            point_labels: labels,
        }
    }
}
