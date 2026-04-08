use crate::entities::*;
use crate::palitra::sync_delete_palitra_from_connected_organisms;
use crate::palitra::types::*;
use crate::sigint::aor::bl::expand_aor_ids_to_descendants;
use crate::types::*;
use crate::utils::orm::ArrayColumnOps;
use crate::{h, nlp};
use actix_web::web::Data;
use anyhow::Context;
use chrono::{DateTime, NaiveDateTime, Utc};
use itertools::{Either, Itertools};
use redis::AsyncCommands;
use sea_orm::prelude::*;
use sea_orm::sea_query::IntoCondition;
use sea_orm::sea_query::OnConflict;
use sea_orm::sea_query::SelectStatement;
use sea_orm::sea_query::SimpleExpr;
use sea_orm::*;
use serde::de::DeserializeOwned;
use std::collections::{HashMap, HashSet};
use std::path::Path;

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

#[derive(Debug, Clone)]
struct LoginAccessScope {
    organism_ids: HashSet<i64>,
    aor_ids: HashSet<i64>,
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

pub async fn update_palitra_v2(
    palitra_id: i64,
    req: UpdatePalitraV2Req,
    txn: &DatabaseTransaction,
) -> anyhow::Result<PalitraReadV2> {
    let palitra = palitra::Entity::find_by_id(palitra_id)
        .one(txn)
        .await
        .c(h!())?
        .c(h!())?
        .into_active_model();

    let palitra = update_palitra_from_v2_req(req, palitra, txn)
        .await
        .c(h!())?;
    render_palitra_v2(Either::Left(palitra), txn).await.c(h!())
}

pub async fn list_all_palitras_detailed(
    login: String,
    dbx: &DatabaseConnection,
) -> anyhow::Result<Vec<PalitraDetails>> {
    let palitra_ids =
        collect_accessible_palitra_ids(login, dbx).await.c(h!())?;
    let result = render_palitra_details(dbx, palitra_ids).await.c(h!())?;
    Ok(result)
}

pub async fn list_all_palitras_v2(
    login: String,
    dbx: &DatabaseConnection,
) -> anyhow::Result<Vec<PalitraReadV2>> {
    let palitra_ids =
        collect_accessible_palitra_ids(login, dbx).await.c(h!())?;
    let mut result = Vec::with_capacity(palitra_ids.len());
    for palitra_id in palitra_ids {
        result.push(
            render_palitra_v2_without_points(Either::Right(palitra_id), dbx)
                .await
                .c(h!())?,
        );
    }
    Ok(result)
}

pub async fn read_palitra_v2(
    login: String,
    palitra_id: i64,
    dbx: &DatabaseConnection,
) -> anyhow::Result<PalitraReadV2> {
    let palitra_ids =
        collect_accessible_palitra_ids(login, dbx).await.c(h!())?;
    if !palitra_ids.contains(&palitra_id) {
        anyhow::bail!(
            "Palitra {palitra_id} is not accessible for current user"
        );
    }
    render_palitra_v2(Either::Right(palitra_id), dbx)
        .await
        .c(h!())
}

pub async fn search_palitra_points_by_labels(
    login: String,
    req: PalitraSearchPointsReq,
    dbx: &DatabaseConnection,
) -> anyhow::Result<Vec<PalitraPoints>> {
    let allowed_palitra_ids =
        collect_accessible_palitra_ids(login, dbx).await.c(h!())?;
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
    let allowed_palitra_ids =
        collect_accessible_palitra_ids(login, dbx).await.c(h!())?;
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
    let allowed_palitra_ids =
        collect_accessible_palitra_ids(login, dbx).await.c(h!())?;
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
    let palitra_ids =
        collect_accessible_palitra_ids(login, dbx).await.c(h!())?;
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

pub async fn create_palitra<'a, 'async_trait, C>(
    author_login: String,
    req: CreatePalitraReq,
    dbx: &'a C,
) -> anyhow::Result<Palitra>
where
    C: ConnectionTrait + 'async_trait,
{
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

pub async fn update_palitra_s3_id<'a, 'async_trait, C>(
    txn: &'a C,
    palitra_id: i64,
    s3_id: Option<String>,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'async_trait,
{
    let palitra = palitra::Entity::find_by_id(palitra_id)
        .one(txn)
        .await
        .c(h!())?
        .c(h!())?;
    let mut palitra = palitra.into_active_model();
    palitra.s3_id = Set(s3_id);
    palitra.update(txn).await.c(h!())?;
    Ok(())
}

pub fn normalize_palitra_folder(folder: &str) -> anyhow::Result<String> {
    let trimmed = folder.trim();
    if trimmed.is_empty() {
        anyhow::bail!("Palitra folder may not be empty");
    }
    let parts = trimmed.split('/').map(str::trim).collect_vec();
    if parts.iter().any(|part| part.is_empty()) {
        anyhow::bail!(
            "Palitra folder may not contain empty path segments: {folder}"
        );
    }
    Ok(parts.join("/"))
}

pub fn normalize_palitra_folder_from_db(
    folder: Option<String>,
) -> Option<String> {
    folder.and_then(|folder| normalize_palitra_folder(&folder).ok())
}

fn folder_matches_prefix(folder: Option<&str>, prefix: &str) -> bool {
    let Some(folder) = folder else {
        return false;
    };
    folder == prefix || folder.starts_with(&format!("{prefix}/"))
}

fn replace_folder_prefix(
    folder: Option<&str>,
    from_folder: &str,
    to_folder: &str,
) -> Option<String> {
    let folder = folder?;
    if folder == from_folder {
        return Some(to_folder.to_string());
    }
    let suffix = folder.strip_prefix(&format!("{from_folder}/"))?;
    Some(format!("{to_folder}/{suffix}"))
}

pub async fn update_accessible_palitra_archive_flag(
    login: String,
    palitra_id: i64,
    is_archived: bool,
    dbx: &DatabaseConnection,
    txn: &DatabaseTransaction,
) -> anyhow::Result<Option<Palitra>> {
    let palitra = collect_mutable_palitra_models(login, vec![palitra_id], dbx)
        .await
        .c(h!())?
        .into_iter()
        .next();
    let Some(palitra) = palitra else {
        return Ok(None);
    };
    let mut palitra = palitra.into_active_model();
    palitra.is_archived = Set(is_archived);
    let palitra = palitra.update(txn).await.c(h!())?;
    render_palitra(Either::Left(palitra), txn)
        .await
        .map(Some)
        .c(h!())
}

pub async fn assign_folder_to_accessible_palitras(
    login: String,
    palitra_ids: Vec<i64>,
    folder: String,
    dbx: &DatabaseConnection,
    txn: &DatabaseTransaction,
) -> anyhow::Result<Vec<i64>> {
    let folder = normalize_palitra_folder(&folder).c(h!())?;
    let palitra_ids = collect_mutable_palitra_models(login, palitra_ids, dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|palitra| palitra.id)
        .collect_vec();
    if palitra_ids.is_empty() {
        return Ok(vec![]);
    }
    palitra::Entity::update_many()
        .filter(palitra::Column::Id.is_in(palitra_ids.clone()))
        .filter(palitra::Column::Deleted.eq(false))
        .col_expr(palitra::Column::Folder, Expr::value(folder))
        .exec(txn)
        .await
        .c(h!())?;
    Ok(palitra_ids)
}

pub async fn rename_accessible_palitra_folder(
    login: String,
    from_folder: String,
    to_folder: String,
    dbx: &DatabaseConnection,
    txn: &DatabaseTransaction,
) -> anyhow::Result<Vec<i64>> {
    let from_folder = normalize_palitra_folder(&from_folder).c(h!())?;
    let to_folder = normalize_palitra_folder(&to_folder).c(h!())?;
    let mutable_palitras =
        collect_mutable_palitra_models_for_accessible_login(login, dbx)
            .await
            .c(h!())?;
    if mutable_palitras.is_empty() {
        return Ok(vec![]);
    }
    let mut updated_ids = Vec::new();
    for palitra in mutable_palitras {
        let old_folder =
            normalize_palitra_folder_from_db(palitra.folder.clone());
        let Some(new_folder) = replace_folder_prefix(
            old_folder.as_deref(),
            &from_folder,
            &to_folder,
        ) else {
            continue;
        };
        let mut palitra = palitra.into_active_model();
        palitra.folder = Set(Some(new_folder));
        let palitra = palitra.update(txn).await.c(h!())?;
        updated_ids.push(palitra.id);
    }
    Ok(updated_ids)
}

pub async fn archive_accessible_palitra_folder(
    login: String,
    folder: String,
    is_archived: bool,
    dbx: &DatabaseConnection,
    txn: &DatabaseTransaction,
) -> anyhow::Result<Vec<i64>> {
    let palitra_ids =
        collect_accessible_palitra_ids_in_folder(login.clone(), folder, dbx)
            .await
            .c(h!())?;
    let palitra_ids = collect_mutable_palitra_models(login, palitra_ids, dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|palitra| palitra.id)
        .collect_vec();
    if palitra_ids.is_empty() {
        return Ok(vec![]);
    }
    palitra::Entity::update_many()
        .filter(palitra::Column::Id.is_in(palitra_ids.clone()))
        .filter(palitra::Column::Deleted.eq(false))
        .col_expr(palitra::Column::IsArchived, Expr::value(is_archived))
        .exec(txn)
        .await
        .c(h!())?;
    Ok(palitra_ids)
}

async fn has_admin_role(
    login: &str,
    dbx: &DatabaseConnection,
) -> anyhow::Result<bool> {
    Ok(crate::users::has_role(dbx, login, "Admin").await.is_ok())
}

async fn collect_mutable_palitra_models_for_accessible_login(
    login: String,
    dbx: &DatabaseConnection,
) -> anyhow::Result<Vec<palitra::Model>> {
    if has_admin_role(&login, dbx).await.c(h!())? {
        return palitra::Entity::find()
            .filter(palitra::Column::Deleted.eq(false))
            .all(dbx)
            .await
            .c(h!());
    }
    let login_filter = login;
    palitra::Entity::find()
        .filter(palitra::Column::Author.eq(login_filter))
        .filter(palitra::Column::Deleted.eq(false))
        .all(dbx)
        .await
        .c(h!())
}

async fn collect_accessible_requested_palitra_ids(
    login: String,
    palitra_ids: Vec<i64>,
    dbx: &DatabaseConnection,
) -> anyhow::Result<Vec<i64>> {
    let accessible_ids = collect_accessible_palitra_ids(login.clone(), dbx)
        .await
        .c(h!())?;
    let accessible_ids: HashSet<i64> = accessible_ids.into_iter().collect();
    Ok(palitra_ids
        .into_iter()
        .filter(|palitra_id| accessible_ids.contains(palitra_id))
        .collect_vec())
}

async fn collect_mutable_palitra_models(
    login: String,
    palitra_ids: Vec<i64>,
    dbx: &DatabaseConnection,
) -> anyhow::Result<Vec<palitra::Model>> {
    let palitra_ids = palitra_ids.into_iter().unique().collect_vec();
    if palitra_ids.is_empty() {
        return Ok(vec![]);
    }
    if has_admin_role(&login, dbx).await.c(h!())? {
        return palitra::Entity::find()
            .filter(palitra::Column::Id.is_in(palitra_ids))
            .filter(palitra::Column::Deleted.eq(false))
            .all(dbx)
            .await
            .c(h!());
    }
    let palitra_ids = collect_accessible_requested_palitra_ids(
        login.clone(),
        palitra_ids,
        dbx,
    )
    .await
    .c(h!())?;
    if palitra_ids.is_empty() {
        return Ok(vec![]);
    }
    let mut palitras = palitra::Entity::find()
        .filter(palitra::Column::Id.is_in(palitra_ids))
        .filter(palitra::Column::Deleted.eq(false))
        .all(dbx)
        .await
        .c(h!())?;
    palitras
        .retain(|palitra| palitra.author.as_deref() == Some(login.as_str()));
    Ok(palitras)
}

pub async fn collect_accessible_palitra_ids_in_folder(
    login: String,
    folder: String,
    dbx: &DatabaseConnection,
) -> anyhow::Result<Vec<i64>> {
    let folder = normalize_palitra_folder(&folder).c(h!())?;
    let mut palitras = palitra::Entity::find()
        .filter(palitra::Column::Deleted.eq(false))
        .all(dbx)
        .await
        .c(h!())?;
    if !has_admin_role(&login, dbx).await.c(h!())? {
        let accessible_ids =
            collect_accessible_palitra_ids(login, dbx).await.c(h!())?;
        let accessible_ids: HashSet<i64> = accessible_ids.into_iter().collect();
        palitras.retain(|palitra| accessible_ids.contains(&palitra.id));
    }
    Ok(palitras
        .into_iter()
        .filter_map(|palitra| {
            let folder_value =
                normalize_palitra_folder_from_db(palitra.folder.clone());
            if folder_matches_prefix(folder_value.as_deref(), &folder) {
                Some(palitra.id)
            } else {
                None
            }
        })
        .collect())
}

pub async fn collect_downloadable_palitra_files(
    login: String,
    palitra_ids: Vec<i64>,
    dbx: &DatabaseConnection,
) -> anyhow::Result<Vec<(palitra::Model, Option<palitra_geometry::Model>)>> {
    let accessible_ids =
        collect_accessible_palitra_ids(login, dbx).await.c(h!())?;
    let accessible_ids: HashSet<i64> = accessible_ids.into_iter().collect();
    let palitra_ids = palitra_ids
        .into_iter()
        .filter(|palitra_id| accessible_ids.contains(palitra_id))
        .unique()
        .collect_vec();
    if palitra_ids.is_empty() {
        return Ok(vec![]);
    }
    let palitras = palitra::Entity::find()
        .filter(palitra::Column::Id.is_in(palitra_ids))
        .filter(palitra::Column::Deleted.eq(false))
        .all(dbx)
        .await
        .c(h!())?;
    let mut result = Vec::with_capacity(palitras.len());
    for palitra in palitras {
        let geometry =
            read_latest_palitra_geometry_with_warning(dbx, palitra.id)
                .await
                .c(h!())?;
        result.push((palitra, geometry));
    }
    Ok(result)
}

pub fn build_palitra_download_file_name(
    palitra: &palitra::Model,
    geometry: Option<&palitra_geometry::Model>,
) -> String {
    let source_file_name = geometry
        .and_then(|geometry| geometry.source_file_name.as_deref())
        .map(crate::palitra::kmz::sanitize_upload_filename);
    let timestamp = geometry
        .and_then(|geometry| geometry.last_uploaded_at)
        .map(|ts| ts.and_utc().format("%Y%m%dT%H%M%SZ").to_string())
        .unwrap_or_else(|| "unknown-ts".to_string());
    let fallback_extension = palitra
        .s3_id
        .as_deref()
        .and_then(|s3_id| Path::new(s3_id).extension())
        .and_then(|ext| ext.to_str())
        .filter(|ext| !ext.is_empty())
        .unwrap_or("kmz");
    let fallback_name =
        format!("palitra_{}.{}", palitra.id, fallback_extension);
    let source_file_name = source_file_name.unwrap_or(fallback_name);
    format!("{:06}_{}_{}", palitra.id, timestamp, source_file_name)
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
    let reset_query = r"
        UPDATE palitra_geometry
        SET center = NULL
        WHERE id = $1;
    ";
    dbx.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        reset_query,
        [palitra_geometry_id.into()],
    ))
    .await
    .context(h!())?;

    let calculate_query = r"
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
        calculate_query,
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
    let reset_query = r"
        UPDATE palitra_geometry
        SET convex_hull = NULL
        WHERE id = $1;
    ";
    dbx.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        reset_query,
        [palitra_geometry_id.into()],
    ))
    .await
    .context(h!())?;

    let calculate_query = r"
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
        calculate_query,
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

async fn read_palitra_line_strings<'a, 'async_trait, C>(
    dbx: &'a C,
    palitra_geometry_id: i64,
) -> anyhow::Result<Option<Vec<Vec<Coords>>>>
where
    C: ConnectionTrait + 'async_trait,
{
    #[derive(Debug, FromQueryResult)]
    pub struct LinePoint {
        sequence_index: i32,
        lat: f64,
        lon: f64,
    }
    #[derive(Debug, FromQueryResult)]
    pub struct MultiLinePoint {
        line_index: i32,
        sequence_index: i32,
        lat: f64,
        lon: f64,
    }
    let single_query = r"
        SELECT
            (dp.path[1] - 1)::int4 AS sequence_index,
            ST_X(dp.geom) AS lon,
            ST_Y(dp.geom) AS lat
        FROM
            palitra_geometry,
            ST_DumpPoints(palitra_geometry.line_string) AS dp
        WHERE
            palitra_geometry.id = $1
            and palitra_geometry.line_string is not null
        ORDER BY
            sequence_index;
    ";
    let mut single_points: Vec<LinePoint> =
        LinePoint::find_by_statement(Statement::from_sql_and_values(
            DbBackend::Postgres,
            single_query,
            [palitra_geometry_id.into()],
        ))
        .all(dbx)
        .await
        .context(h!())?;
    if !single_points.is_empty() {
        single_points.sort_by_key(|p| p.sequence_index);
        let line = single_points
            .into_iter()
            .map(|p| Coords {
                lat: p.lat,
                lng: p.lon,
            })
            .collect::<Vec<Coords>>();
        return Ok(Some(vec![line]));
    }

    let multi_query = r"
        SELECT
            (dp.path[1] - 1)::int4 AS line_index,
            (dp.path[2] - 1)::int4 AS sequence_index,
            ST_X(dp.geom) AS lon,
            ST_Y(dp.geom) AS lat
        FROM
            palitra_geometry,
            ST_DumpPoints(palitra_geometry.multi_line_string) AS dp
        WHERE
            palitra_geometry.id = $1
            and palitra_geometry.multi_line_string is not null
        ORDER BY
            line_index,
            sequence_index;
    ";
    let mut multi_points: Vec<MultiLinePoint> =
        MultiLinePoint::find_by_statement(Statement::from_sql_and_values(
            DbBackend::Postgres,
            multi_query,
            [palitra_geometry_id.into()],
        ))
        .all(dbx)
        .await
        .context(h!())?;
    if multi_points.is_empty() {
        return Ok(None);
    }
    multi_points.sort_by_key(|p| (p.line_index, p.sequence_index));
    let mut grouped: HashMap<i32, Vec<Coords>> = HashMap::new();
    for point in multi_points {
        grouped.entry(point.line_index).or_default().push(Coords {
            lat: point.lat,
            lng: point.lon,
        });
    }
    let mut lines = grouped.into_iter().collect_vec();
    lines.sort_by_key(|(index, _)| *index);
    Ok(Some(lines.into_iter().map(|(_, coords)| coords).collect()))
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
    rq: &reqwest::Client,
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
            insert_many_points(points_batch, txn, rq)
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
        insert_many_points(points_batch, txn, rq)
            .await
            .context(h!())?;
    }
    recalculate_center(txn, palitra_geometry_id).await.c(h!())?;
    recalculate_convex_hull(txn, palitra_geometry_id)
        .await
        .c(h!())?;
    Ok(())
}

pub async fn rewrite_palitra_line_strings(
    palitra_geometry_id: i64,
    mut line_strings: Vec<crate::palitra::kmz::PalitraLineString>,
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
    let reset_query = r"
        UPDATE palitra_geometry
        SET line_string = NULL,
            multi_line_string = NULL
        WHERE id = $1;
    ";
    txn.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        reset_query,
        [palitra_geometry_id.into()],
    ))
    .await
    .context(h!())?;

    line_strings.retain(|line| line.coords.len() >= 2);
    let mut lines_with_fallback_color = 0usize;
    let mut skipped_lines_with_unexpected_color = 0usize;
    let mut filtered_lines = Vec::with_capacity(line_strings.len());
    for line_string in line_strings {
        let line_color = line_string.color.clone().unwrap_or_else(|| {
            crate::config::PALITRA_POINT_FALLBACK_COLOR_HEX.to_string()
        });
        let is_fallback_color =
            line_color == crate::config::PALITRA_POINT_FALLBACK_COLOR_HEX;
        if is_fallback_color {
            lines_with_fallback_color += 1;
        }
        if !is_fallback_color && !palitra_geometry.hex.eq(&line_color) {
            skipped_lines_with_unexpected_color += 1;
            continue;
        }
        filtered_lines.push(line_string);
    }
    if lines_with_fallback_color > 0 {
        error!(
            "palitra geometry {} received {} line strings with fallback color {} while mapping KMZ data",
            palitra_geometry_id,
            lines_with_fallback_color,
            crate::config::PALITRA_POINT_FALLBACK_COLOR_HEX
        );
    }
    if skipped_lines_with_unexpected_color > 0 {
        warn!(
            "skipped {} line strings in geometry {} due to color mismatch with selected geometry color {}",
            skipped_lines_with_unexpected_color,
            palitra_geometry_id,
            palitra_geometry.hex
        );
    }
    if filtered_lines.is_empty() {
        return Ok(());
    }

    let mut line_wkts = Vec::with_capacity(filtered_lines.len());
    for line_string in filtered_lines {
        let coords = line_string
            .coords
            .into_iter()
            .map(|coords| format!("{} {}", coords.lng, coords.lat))
            .collect_vec();
        line_wkts.push(format!("({})", coords.join(", ")));
    }
    let (geometry_kind, wkt) = if line_wkts.len() == 1 {
        ("LineString", format!("LINESTRING{}", line_wkts[0]))
    } else {
        (
            "MultiLineString",
            format!("MULTILINESTRING({})", line_wkts.join(", ")),
        )
    };
    let update_query = match geometry_kind {
        "LineString" => {
            r"
            UPDATE palitra_geometry
            SET line_string = ST_GeomFromText($2, 4326)
            WHERE id = $1;
            "
        }
        _ => {
            r"
            UPDATE palitra_geometry
            SET multi_line_string = ST_GeomFromText($2, 4326)
            WHERE id = $1;
            "
        }
    };
    txn.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        update_query,
        [palitra_geometry_id.into(), wkt.into()],
    ))
    .await
    .context(h!())?;
    Ok(())
}

async fn insert_many_points(
    points_batch: Vec<palitra_point::ActiveModel>,
    txn: &DatabaseTransaction,
    rq: &reqwest::Client,
) -> anyhow::Result<()> {
    let mut point_lexeme_actives: Vec<palitra_point_lexeme::ActiveModel> =
        Vec::new();
    let inserted_points = palitra_point::Entity::insert_many(points_batch)
        .exec_with_returning_many(txn)
        .await
        .context(h!())?;

    let mut palitra_point_ids = Vec::new();
    let mut palitra_point_labels = Vec::new();

    for point in inserted_points.into_iter() {
        if let Some(label) = point.label {
            palitra_point_ids.push(point.id);
            palitra_point_labels.push(label);
        }
    }

    let lexemes_batch = nlp::token_lexemes_batch(rq, palitra_point_labels)
        .await
        .context(h!())?;
    let mut uniq = HashSet::new();

    for (point_id, lexemes) in palitra_point_ids.into_iter().zip(lexemes_batch)
    {
        for lexeme in lexemes {
            let lexeme = lexeme.to_lowercase().trim().to_string();
            if !uniq.contains(&lexeme) {
                uniq.insert(lexeme.clone());
                point_lexeme_actives.push(palitra_point_lexeme::ActiveModel {
                    palitra_point_id: Set(point_id),
                    lexeme: Set(lexeme),
                    ..Default::default()
                });
            }
        }
        uniq.clear();
    }

    if point_lexeme_actives.is_empty() {
        return Ok(());
    }
    palitra_point_lexeme::Entity::insert_many(point_lexeme_actives)
        .on_conflict(
            OnConflict::columns([
                palitra_point_lexeme::Column::PalitraPointId,
                palitra_point_lexeme::Column::Lexeme,
            ])
            .do_nothing()
            .to_owned(),
        )
        .exec(txn)
        .await
        .context(h!())?;

    Ok(())
}

pub async fn soft_delete_palitra_geometry(
    palitra_geometry_id: i64,
    txn: &DatabaseTransaction,
) -> anyhow::Result<()> {
    palitra_geometry::Entity::update_many()
        .filter(palitra_geometry::Column::Id.eq(palitra_geometry_id))
        .filter(palitra_geometry::Column::Deleted.eq(false))
        .col_expr(palitra_geometry::Column::Deleted, Expr::value(true))
        .exec(txn)
        .await
        .c(h!())?;
    delete_existing_palitra_points(palitra_geometry_id, txn)
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

fn order_by_primary_geometry(
    query: Select<palitra_geometry::Entity>,
) -> Select<palitra_geometry::Entity> {
    query
        .order_by_desc(palitra_geometry::Column::UpdatedAt)
        .order_by_desc(palitra_geometry::Column::Id)
}

async fn read_latest_palitra_geometry_with_warning<'a, 'async_trait, C>(
    dbx: &'a C,
    palitra_id: i64,
) -> anyhow::Result<Option<palitra_geometry::Model>>
where
    C: ConnectionTrait + 'async_trait,
{
    order_by_primary_geometry(palitra_geometry::Entity::find())
        .filter(palitra_geometry::Column::PalitraId.eq(palitra_id))
        .filter(palitra_geometry::Column::Deleted.eq(false))
        .one(dbx)
        .await
        .c(h!())
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
    let (center, convex_hull, line_strings) = match m_palitra_geometry_id {
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
            let line_strings =
                read_palitra_line_strings(dbx, palitra_geometry_id)
                    .await
                    .c(h!())?;
            (center, convex_hull, line_strings)
        }
        None => (None, None, None),
    };
    let geometry = if convex_hull.is_some() || line_strings.is_some() {
        Some(Geometry {
            center,
            perimeter_linear_ring: convex_hull,
            line_strings,
        })
    } else {
        None
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
        folder: normalize_palitra_folder_from_db(palitra_model.folder),
        is_archived: palitra_model.is_archived,
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

async fn render_palitra_v2<'a, 'async_trait, C>(
    e_palitra_model: Either<palitra::Model, i64>,
    dbx: &'a C,
) -> anyhow::Result<PalitraReadV2>
where
    C: ConnectionTrait + 'async_trait,
{
    render_palitra_v2_inner(e_palitra_model, dbx, true)
        .await
        .c(h!())
}

async fn render_palitra_v2_without_points<'a, 'async_trait, C>(
    e_palitra_model: Either<palitra::Model, i64>,
    dbx: &'a C,
) -> anyhow::Result<PalitraReadV2>
where
    C: ConnectionTrait + 'async_trait,
{
    render_palitra_v2_inner(e_palitra_model, dbx, false)
        .await
        .c(h!())
}

async fn render_palitra_v2_inner<'a, 'async_trait, C>(
    e_palitra_model: Either<palitra::Model, i64>,
    dbx: &'a C,
    include_points: bool,
) -> anyhow::Result<PalitraReadV2>
where
    C: ConnectionTrait + 'async_trait,
{
    let palitra = render_palitra(e_palitra_model, dbx).await.c(h!())?;
    let palitra_geometry_models =
        order_by_primary_geometry(palitra_geometry::Entity::find())
            .filter(palitra_geometry::Column::PalitraId.eq(palitra.id))
            .filter(palitra_geometry::Column::Deleted.eq(false))
            .all(dbx)
            .await
            .c(h!())?;
    let palitra_geometry_ids = palitra_geometry_models
        .iter()
        .map(|palitra_geometry| palitra_geometry.id)
        .collect_vec();
    let points = if !include_points || palitra_geometry_ids.is_empty() {
        vec![]
    } else {
        palitra_point::Entity::find()
            .filter(
                palitra_point::Column::PalitraGeometryId
                    .is_in(palitra_geometry_ids),
            )
            .filter(palitra_point::Column::Deleted.eq(false))
            .all(dbx)
            .await
            .c(h!())?
    };
    let mut points_by_palitra_geometry_id: HashMap<i64, Vec<PalitraPoint>> =
        HashMap::new();
    for point in points {
        points_by_palitra_geometry_id
            .entry(point.palitra_geometry_id)
            .or_default()
            .push(PalitraPoint {
                label: point.label,
                coords: Coords {
                    lat: point.lat,
                    lng: point.lng,
                },
                color: None,
            });
    }

    let mut geometries = Vec::with_capacity(palitra_geometry_models.len());
    for palitra_geometry in palitra_geometry_models {
        let palitra_geometry_id = palitra_geometry.id;
        let color_hex = palitra_geometry.hex.clone();
        let center = read_palitra_center(dbx, palitra_geometry_id)
            .await
            .c(h!())?;
        let convex_hull = match read_palitra_convex_hull(
            dbx,
            palitra_geometry_id,
        )
        .await
        {
            Ok(convex_hull) => Some(convex_hull),
            Err(e) => {
                error!(
                        "failed to calculate convex hull for palitra geometry {}: {e:#?}",
                        palitra_geometry_id
                    );
                None
            }
        };
        let line_strings = read_palitra_line_strings(dbx, palitra_geometry_id)
            .await
            .c(h!())?;
        let geometry = if convex_hull.is_some() || line_strings.is_some() {
            Some(Geometry {
                center,
                perimeter_linear_ring: convex_hull,
                line_strings,
            })
        } else {
            None
        };
        let mut points = points_by_palitra_geometry_id
            .remove(&palitra_geometry_id)
            .unwrap_or_default();
        for point in &mut points {
            point.color = Some(color_hex.clone());
        }
        geometries.push(PalitraGeometryDetails {
            id: palitra_geometry_id,
            color_hex: palitra_geometry.hex,
            source_file_name: palitra_geometry.source_file_name,
            last_uploaded_at_ts: palitra_geometry
                .last_uploaded_at
                .map(|ts| ts.and_utc().timestamp_millis()),
            geometry,
            points,
        });
    }
    Ok(PalitraReadV2 {
        palitra,
        geometries,
    })
}

pub(crate) async fn collect_accessible_palitra_ids<'a, 'async_trait, C>(
    login: String,
    dbx: &'a C,
) -> anyhow::Result<Vec<i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let scope = load_login_access_scope(dbx, &login).await.c(h!())?;
    let mut filter = Condition::any()
        .add(palitra::Column::Author.eq(login.clone()))
        .add(
            Expr::exists(build_palitra_access_login_exists(login))
                .into_condition(),
        );
    let organism_ids = scope.organism_ids.iter().copied().collect_vec();
    if !organism_ids.is_empty() {
        filter = filter.add(
            Expr::exists(build_palitra_access_organism_exists(organism_ids))
                .into_condition(),
        );
    }
    let aor_ids = scope.aor_ids.iter().copied().collect_vec();
    if !aor_ids.is_empty() {
        filter = filter.add(
            Expr::exists(build_palitra_access_aor_exists(aor_ids))
                .into_condition(),
        );
    }
    palitra::Entity::find()
        .filter(palitra::Column::Deleted.eq(false))
        .filter(filter)
        .select_only()
        .column(palitra::Column::Id)
        .into_tuple::<i64>()
        .all(dbx)
        .await
        .c(h!())
}

async fn load_login_access_scope<'a, 'async_trait, C>(
    dbx: &'a C,
    login_name: &str,
) -> anyhow::Result<LoginAccessScope>
where
    C: ConnectionTrait + 'async_trait,
{
    let organism_aors = organism_aor::Entity::find()
        .join(JoinType::InnerJoin, organism_aor::Relation::Organism.def())
        .join(JoinType::InnerJoin, organism::Relation::Login.def())
        .filter(login::Column::Login.eq(login_name.to_string()))
        .all(dbx)
        .await
        .c(h!())?;
    let organism_ids = organism_aors
        .iter()
        .map(|organism_aor| organism_aor.organism_id)
        .collect::<HashSet<_>>();
    let direct_aor_ids = organism_aors
        .into_iter()
        .map(|organism_aor| organism_aor.aor_id)
        .collect_vec();
    let aor_ids = expand_aor_ids_to_descendants(dbx, &direct_aor_ids)
        .await
        .c(h!())?;
    Ok(LoginAccessScope {
        organism_ids,
        aor_ids,
    })
}

fn build_palitra_access_organism_exists(
    organism_ids: Vec<i64>,
) -> SelectStatement {
    palitra_access_organism::Entity::find()
        .filter(
            palitra_access_organism::Column::OrganismId.eq_any(organism_ids),
        )
        .filter(
            Expr::col((
                palitra_access_organism::Entity,
                palitra_access_organism::Column::PalitraId,
            ))
            .equals((palitra::Entity, palitra::Column::Id)),
        )
        .select_only()
        .expr(Expr::cust("1"))
        .into_query()
}

fn build_palitra_access_login_exists(login: String) -> SelectStatement {
    palitra_access_login::Entity::find()
        .filter(palitra_access_login::Column::Login.eq(login))
        .filter(
            Expr::col((
                palitra_access_login::Entity,
                palitra_access_login::Column::PalitraId,
            ))
            .equals((palitra::Entity, palitra::Column::Id)),
        )
        .select_only()
        .expr(Expr::cust("1"))
        .into_query()
}

fn build_palitra_access_aor_exists(aor_ids: Vec<i64>) -> SelectStatement {
    palitra_access_aor::Entity::find()
        .filter(palitra_access_aor::Column::AorId.eq_any(aor_ids))
        .filter(
            Expr::col((
                palitra_access_aor::Entity,
                palitra_access_aor::Column::PalitraId,
            ))
            .equals((palitra::Entity, palitra::Column::Id)),
        )
        .select_only()
        .expr(Expr::cust("1"))
        .into_query()
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
    let palitra = match action {
        PalitraUpdateAction::Update => palitra.update(txn).await.c(h!())?,
        PalitraUpdateAction::Insert => palitra.insert(txn).await.c(h!())?,
    };
    let palitra_id = palitra.id;
    let last_uploaded_at_ts =
        parse_uploaded_at_ts(req.last_uploaded_at_ts).c(h!())?;
    let now = Utc::now().naive_utc();
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
            let palitra_geometries =
                order_by_primary_geometry(palitra_geometry::Entity::find())
                    .filter(palitra_geometry::Column::PalitraId.eq(palitra_id))
                    .filter(palitra_geometry::Column::Deleted.eq(false))
                    .all(txn)
                    .await
                    .c(h!())?;
            let palitra_geometry = palitra_geometries
                .iter()
                .find(|geometry| geometry.hex == req.color_hex)
                .cloned()
                .or_else(|| palitra_geometries.into_iter().next());
            if let Some(palitra_geometry) = palitra_geometry {
                let mut palitra_geometry = palitra_geometry.into_active_model();
                palitra_geometry.hex = Set(req.color_hex.clone());
                if let Some(source_file_name) = request.source_file_name.clone()
                {
                    palitra_geometry.source_file_name =
                        Set(Some(source_file_name));
                }
                if let Some(last_uploaded_at) = last_uploaded_at_ts {
                    palitra_geometry.last_uploaded_at =
                        Set(Some(last_uploaded_at));
                }
                palitra_geometry.updated_at = Set(now);
                palitra_geometry.update(txn).await.c(h!())?
            } else {
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
    replace_palitra_access(txn, palitra.id, req.access)
        .await
        .c(h!())?;
    Ok(palitra)
}

async fn update_palitra_from_v2_req<'a, 'async_trait, C>(
    req: UpdatePalitraV2Req,
    palitra_val: palitra::ActiveModel,
    txn: &'a C,
) -> anyhow::Result<palitra::Model>
where
    C: ConnectionTrait + 'async_trait,
{
    info!("updating palitra via v2:\n old value {palitra_val:?}\n changes requested: {req:?}");
    let mut palitra = palitra_val;
    palitra.name = Set(req.name);
    let palitra = palitra.update(txn).await.c(h!())?;
    let last_uploaded_at_ts =
        parse_uploaded_at_ts(req.last_uploaded_at_ts).c(h!())?;
    let palitra_geometry =
        palitra_geometry::Entity::find_by_id(req.geometry_id)
            .filter(palitra_geometry::Column::PalitraId.eq(palitra.id))
            .filter(palitra_geometry::Column::Deleted.eq(false))
            .one(txn)
            .await
            .c(h!())?
            .with_context(|| {
                format!(
                    "No active geometry {} for palitra {}",
                    req.geometry_id, palitra.id
                )
            })
            .c(h!())?;

    let mut palitra_geometry = palitra_geometry.into_active_model();
    palitra_geometry.hex = Set(req.color_hex);
    if let Some(source_file_name) = req.source_file_name {
        palitra_geometry.source_file_name = Set(Some(source_file_name));
    }
    if let Some(last_uploaded_at) = last_uploaded_at_ts {
        palitra_geometry.last_uploaded_at = Set(Some(last_uploaded_at));
    }
    palitra_geometry.updated_at = Set(Utc::now().naive_utc());
    palitra_geometry.update(txn).await.c(h!())?;

    replace_palitra_access(txn, palitra.id, req.access)
        .await
        .c(h!())?;
    Ok(palitra)
}

fn parse_uploaded_at_ts(
    uploaded_at_ts: Option<i64>,
) -> anyhow::Result<Option<NaiveDateTime>> {
    uploaded_at_ts
        .map(|ts| {
            DateTime::from_timestamp_millis(ts)
                .map(|dt| dt.naive_utc())
                .ok_or_else(|| anyhow::anyhow!("Invalid timestamp: {ts}"))
        })
        .transpose()
}

async fn replace_palitra_access<'a, 'async_trait, C>(
    txn: &'a C,
    palitra_id: i64,
    access: PalitraAccess,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'async_trait,
{
    if access.is_empty() {
        anyhow::bail!("Palitra must have explicit access scope");
    }
    palitra_access_login::Entity::delete_many()
        .filter(palitra_access_login::Column::PalitraId.eq(palitra_id))
        .exec(txn)
        .await
        .c(h!())?;
    palitra_access_organism::Entity::delete_many()
        .filter(palitra_access_organism::Column::PalitraId.eq(palitra_id))
        .exec(txn)
        .await
        .c(h!())?;
    palitra_access_aor::Entity::delete_many()
        .filter(palitra_access_aor::Column::PalitraId.eq(palitra_id))
        .exec(txn)
        .await
        .c(h!())?;
    match access {
        PalitraAccess::ByLogins { logins } => {
            if logins.is_empty() {
                return Ok(());
            }
            let logins = logins
                .into_iter()
                .map(|login| palitra_access_login::ActiveModel {
                    id: NotSet,
                    palitra_id: Set(palitra_id),
                    login: Set(login),
                    created_at: NotSet,
                })
                .collect_vec();
            palitra_access_login::Entity::insert_many(logins)
                .exec(txn)
                .await
                .c(h!())?;
        }
        PalitraAccess::ByOrganisms { organism_ids } => {
            if organism_ids.is_empty() {
                return Ok(());
            }
            let organisms = organism_ids
                .into_iter()
                .map(|organism_id| palitra_access_organism::ActiveModel {
                    id: NotSet,
                    palitra_id: Set(palitra_id),
                    organism_id: Set(organism_id),
                    created_at: NotSet,
                })
                .collect_vec();
            palitra_access_organism::Entity::insert_many(organisms)
                .exec(txn)
                .await
                .c(h!())?;
        }
        PalitraAccess::ByAor { aor_ids } => {
            if aor_ids.is_empty() {
                return Ok(());
            }
            let aors = aor_ids
                .into_iter()
                .map(|aor_id| palitra_access_aor::ActiveModel {
                    id: NotSet,
                    palitra_id: Set(palitra_id),
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
    Ok(())
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
    }
    .insert(txn)
    .await
    .c(h!())
}

#[cfg(test)]
mod tests {
    use crate::entities::{
        area_of_responsibility, login, organism, organism_aor, palitra,
        palitra_access_aor, palitra_access_login, palitra_access_organism,
        palitra_geometry,
    };
    use crate::functest::tests::{
        cleanup, find_test_login, find_test_palitra, mk_aor, mk_login,
        mk_organism, mk_organism_aor, mk_palitra, mk_palitra_geometry,
        mk_palitra_point,
    };
    use crate::palitra::bl::{
        collect_accessible_palitra_ids, normalize_palitra_folder,
        replace_folder_prefix, search_palitra_points_by_labels, update_palitra,
        update_palitra_v2,
    };
    use crate::palitra::types::{
        CreatePalitraReq, PalitraAccess, PalitraSearchPointsReq,
        UpdatePalitraV2Req,
    };
    use chrono::Utc;
    use sea_orm::{
        ActiveModelTrait, ColumnTrait, EntityTrait, NotSet, QueryFilter, Set,
        TransactionTrait,
    };
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

    #[serial]
    #[tokio::test]
    async fn test_update_palitra_changes_primary_geometry_without_creating_new_one(
    ) {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let palitra = find_test_palitra(&env.dbx).await.unwrap();
        let req = CreatePalitraReq {
            name: "Updated Palitra".to_string(),
            color_hex: "#00ff00".to_string(),
            access: PalitraAccess::ByLogins {
                logins: vec![login.login.clone()],
            },
            source_file_name: None,
            last_uploaded_at_ts: None,
        };

        let txn = env.dbx.begin().await.unwrap();
        let _result = update_palitra(palitra.id, req, &txn).await.unwrap();
        txn.commit().await.unwrap();

        let active_palitra_geometries = palitra_geometry::Entity::find()
            .filter(palitra_geometry::Column::PalitraId.eq(palitra.id))
            .filter(palitra_geometry::Column::Deleted.eq(false))
            .all(&env.dbx)
            .await
            .unwrap();
        assert_eq!(active_palitra_geometries.len(), 1);
        assert_eq!(active_palitra_geometries[0].hex, "#00ff00");
    }

    #[serial]
    #[tokio::test]
    async fn test_update_palitra_v2_updates_requested_geometry() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let palitra = find_test_palitra(&env.dbx).await.unwrap();
        let extra_geometry = palitra_geometry::ActiveModel {
            id: NotSet,
            palitra_id: Set(palitra.id),
            hex: Set("#123456".to_string()),
            source_file_name: Set(None),
            deleted: NotSet,
            created_at: NotSet,
            last_uploaded_at: NotSet,
            updated_at: NotSet,
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let req = UpdatePalitraV2Req {
            geometry_id: extra_geometry.id,
            name: "Updated Palitra V2".to_string(),
            color_hex: "#abcdef".to_string(),
            access: PalitraAccess::ByLogins {
                logins: vec![login.login.clone()],
            },
            source_file_name: Some("updated-file.kmz".to_string()),
            last_uploaded_at_ts: None,
        };

        let txn = env.dbx.begin().await.unwrap();
        let result = update_palitra_v2(palitra.id, req, &txn).await.unwrap();
        txn.commit().await.unwrap();

        let updated_geometry = result
            .geometries
            .iter()
            .find(|geometry| geometry.id == extra_geometry.id)
            .unwrap();
        assert_eq!(updated_geometry.color_hex, "#abcdef");
        assert_eq!(
            updated_geometry.source_file_name.as_deref(),
            Some("updated-file.kmz")
        );

        let active_palitra_geometries = palitra_geometry::Entity::find()
            .filter(palitra_geometry::Column::PalitraId.eq(palitra.id))
            .filter(palitra_geometry::Column::Deleted.eq(false))
            .all(&env.dbx)
            .await
            .unwrap();
        assert_eq!(active_palitra_geometries.len(), 2);
    }

    #[serial]
    #[tokio::test]
    async fn test_collect_accessible_palitra_ids_includes_author_without_explicit_access(
    ) {
        let env = cleanup().await.unwrap();
        let palitra = find_test_palitra(&env.dbx).await.unwrap();

        palitra_access_login::Entity::delete_many()
            .filter(palitra_access_login::Column::PalitraId.eq(palitra.id))
            .exec(&env.dbx)
            .await
            .unwrap();

        let login = find_test_login(&env.dbx).await.unwrap();
        let palitra_ids = collect_accessible_palitra_ids(login.login, &env.dbx)
            .await
            .unwrap();

        assert!(palitra_ids.contains(&palitra.id));
    }

    #[serial]
    #[tokio::test]
    async fn test_collect_accessible_palitra_ids_grants_login_scoped_access() {
        let env = cleanup().await.unwrap();
        let now = Utc::now().naive_utc();
        let login = find_test_login(&env.dbx).await.unwrap();
        let palitra = mk_palitra(
            &env.dbx,
            palitra::ActiveModel {
                name: Set("Login Scoped Palitra".to_string()),
                hex_legacy: Set(Some("#abcdef".into())),
                author: Set(None),
                deleted: Set(false),
                created_at: Set(now),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_palitra_geometry(
            &env.dbx,
            palitra_geometry::ActiveModel {
                palitra_id: Set(palitra.id),
                hex: Set("#abcdef".into()),
                deleted: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        palitra_access_login::ActiveModel {
            id: NotSet,
            palitra_id: Set(palitra.id),
            login: Set(login.login.clone()),
            created_at: Set(now),
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        let palitra_ids = collect_accessible_palitra_ids(login.login, &env.dbx)
            .await
            .unwrap();

        assert!(palitra_ids.contains(&palitra.id));
    }

    #[serial]
    #[tokio::test]
    async fn test_collect_accessible_palitra_ids_grants_organism_scoped_access()
    {
        let env = cleanup().await.unwrap();
        let now = Utc::now().naive_utc();
        let login = find_test_login(&env.dbx).await.unwrap();
        let organism_id = login.organism_id.unwrap();
        let palitra = mk_palitra(
            &env.dbx,
            palitra::ActiveModel {
                name: Set("Organism Scoped Palitra".to_string()),
                hex_legacy: Set(Some("#123abc".into())),
                author: Set(None),
                deleted: Set(false),
                created_at: Set(now),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_palitra_geometry(
            &env.dbx,
            palitra_geometry::ActiveModel {
                palitra_id: Set(palitra.id),
                hex: Set("#123abc".into()),
                deleted: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        palitra_access_organism::ActiveModel {
            id: NotSet,
            palitra_id: Set(palitra.id),
            organism_id: Set(organism_id),
            created_at: Set(now),
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        let palitra_ids = collect_accessible_palitra_ids(login.login, &env.dbx)
            .await
            .unwrap();

        assert!(palitra_ids.contains(&palitra.id));
    }

    #[serial]
    #[tokio::test]
    async fn test_collect_accessible_palitra_ids_grants_parent_aor_access_to_child_scoped_palitra(
    ) {
        let env = cleanup().await.unwrap();
        let now = Utc::now().naive_utc();
        let child_aor = mk_aor(
            &env.dbx,
            area_of_responsibility::ActiveModel {
                name: Set("Child AOR".to_string()),
                left_bound: Set(10.0),
                right_bound: Set(20.0),
                is_top_level: Set(false),
                is_default: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let parent_organism = mk_organism(
            &env.dbx,
            organism::ActiveModel {
                name: Set("Parent Organism".to_string()),
                created_at: Set(now),
                enabled: Set(true),
                deleted_permanently: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let parent_login = mk_login(
            &env.dbx,
            login::ActiveModel {
                login: Set("parent-aor-login".to_string()),
                organism_id: Set(Some(parent_organism.id)),
                created_at: Set(now),
                deleted: Set(false),
                deleted_permanently: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let root_aor = crate::functest::tests::find_test_aor(&env.dbx)
            .await
            .unwrap();
        mk_organism_aor(
            &env.dbx,
            organism_aor::ActiveModel {
                organism_id: Set(parent_organism.id),
                aor_id: Set(root_aor.id),
                created_at: Set(now),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let palitra = find_test_palitra(&env.dbx).await.unwrap();
        palitra_access_login::Entity::delete_many()
            .filter(palitra_access_login::Column::PalitraId.eq(palitra.id))
            .exec(&env.dbx)
            .await
            .unwrap();
        palitra_access_aor::ActiveModel {
            id: NotSet,
            palitra_id: Set(palitra.id),
            aor_id: Set(child_aor.id),
            created_at: Set(now),
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        let palitra_ids =
            collect_accessible_palitra_ids(parent_login.login, &env.dbx)
                .await
                .unwrap();

        assert!(palitra_ids.contains(&palitra.id));
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

    #[test]
    fn test_normalize_palitra_folder_rejects_empty_segments() {
        assert!(normalize_palitra_folder("foo//bar").is_err());
        assert!(normalize_palitra_folder(" / ").is_err());
    }

    #[test]
    fn test_replace_folder_prefix_handles_exact_and_nested_paths() {
        assert_eq!(
            replace_folder_prefix(Some("foo"), "foo", "bar"),
            Some("bar".to_string())
        );
        assert_eq!(
            replace_folder_prefix(Some("foo/baz"), "foo", "bar"),
            Some("bar/baz".to_string())
        );
        assert_eq!(replace_folder_prefix(Some("foobar"), "foo", "bar"), None);
    }
}
