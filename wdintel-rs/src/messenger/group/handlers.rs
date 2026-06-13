use super::types::*;
use crate::entities::*;
use crate::messenger::group::{collect_group_admin_data, collect_group_stats};
use crate::sigint::aor::bl::collect_group_aors;
use crate::types::*;
use actix_web::post;
use actix_web::web::Json;
use chrono::{Duration, Utc};
use echo_migration::JoinType;
use itertools::Itertools;
use sea_orm::{
    ColumnTrait, EntityTrait, QueryFilter, QuerySelect, RelationTrait,
};
use std::collections::{HashMap, HashSet};

/// Отримує список груп, які не прив'язані до жодного напрямку
///
/// # Повертає
///
/// Список неприв'язаних до напрямків груп у форматі Vec<[`OrphanSignalGroupEntry`]>,
///
#[post("/api/rer-importer/orphan-signal-groups")]
pub async fn orphan_signal_groups(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<Vec<OrphanSignalGroupEntry>>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Admin")
        .await
        .context(h!())?;

    // Отримати всі master_key, які вже прив'язані
    let assigned_keys = sigint_zone_datasource::Entity::find()
        .select_only()
        .filter(sigint_zone_datasource::Column::DatasourceId.is_not_null())
        .column(sigint_zone_datasource::Column::GroupMasterKey)
        .column(sigint_zone_datasource::Column::DatasourceId)
        .into_tuple::<(String, i64)>()
        .all(&env.dbx)
        .await
        .context(h!())?
        .into_iter()
        .collect::<HashSet<_>>();

    // Find all datasource_group mappings and related signal_groups; filter out those already assigned
    let orphan_pairs: Vec<(signal_group::Model, i64)> =
        datasource_group::Entity::find()
            .find_also_related(signal_group::Entity)
            .join(
                JoinType::InnerJoin,
                datasource_group::Relation::Datasource.def(),
            )
            .filter(datasource::Column::Deleted.eq(false))
            .all(&env.dbx)
            .await
            .context(h!())?
            .into_iter()
            .filter_map(|(dg, m_group)| m_group.map(|g| (g, dg.datasource_id)))
            .filter(|(g, dsid)| {
                !assigned_keys.contains(&(g.master_key.clone(), *dsid))
            })
            .collect();

    let keys: Vec<String> = orphan_pairs
        .iter()
        .map(|(g, _)| g.master_key.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let stats = collect_group_stats(keys.clone(), &env.dbx)
        .await
        .context(h!())?;
    let group_aors = collect_group_aors(keys.clone(), &env.dbx)
        .await
        .context(h!())?;
    let group_admin_data = collect_group_admin_data(keys, &env.dbx)
        .await
        .context(h!())?;
    let data: Vec<OrphanSignalGroupEntry> = orphan_pairs
        .into_iter()
        .filter_map(|(g, dsid)| {
            let master_key = g.master_key.clone();
            let stats = stats.get(&master_key).cloned().unwrap_or_default();
            let group_admin_data = group_admin_data.get(&master_key).cloned();
            let aors = group_aors.get(&master_key).cloned();
            g.name.clone().map(|name| OrphanSignalGroupEntry {
                name,
                master_key: g.master_key,
                ignore_operativny: g.ignore_operativny,
                datasource_id: Some(dsid),
                created_at: g.created_at.and_utc().timestamp_millis(),
                group_stats: stats,
                group_admin_data,
                areas_of_responsibility: aors,
            })
        })
        .collect();

    Ok(Json(data))
}

#[post("/api/rer-importer/group-stats-timeline")]
pub async fn group_stats_timeline(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<SignalGroupStatsTimelineReq>,
) -> Result<Json<SignalGroupStatsTimelineRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Admin")
        .await
        .context(h!())?;

    let req = req.into_inner();
    let master_keys = req
        .master_keys
        .into_iter()
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty())
        .unique()
        .collect_vec();
    let period_hours = req.period_hours.unwrap_or(24 * 90).clamp(1, 24 * 90);
    let dt_till = Utc::now().naive_utc();
    let dt_since = dt_till - Duration::hours(period_hours);

    let mut data = crate::stats::read_group_stats_timeline_cached(
        &env.dbx,
        master_keys.clone(),
        dt_since,
        dt_till,
    )
    .await
    .context(h!())?;

    let mut data_by_key = data
        .drain(..)
        .map(|entry| (entry.master_key.clone(), entry))
        .collect::<HashMap<_, _>>();
    let data = master_keys
        .into_iter()
        .map(|master_key| {
            data_by_key.remove(&master_key).unwrap_or(
                SignalGroupStatsTimelineEntry {
                    master_key,
                    points: vec![],
                },
            )
        })
        .collect_vec();

    Ok(Json(SignalGroupStatsTimelineRsp { data }))
}
