use super::types::*;
use crate::entities::*;
use crate::messenger::group::collect_group_stats;
use crate::rer_importer::collect_group_admin_data;
use crate::sigint::aor::bl::collect_group_aors;
use crate::types::*;
use actix_web::post;
use actix_web::web::Json;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect};

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
    crate::users::has_role(&env.dbx, &user.id()?, "Admin")
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

    let orphan_groups = signal_group::Entity::find()
        .filter(signal_group::Column::DatasourceId.is_not_null())
        .order_by_desc(signal_group::Column::CreatedAt)
        .all(&env.dbx)
        .await
        .context(h!())?
        .into_iter()
        .filter(|g| match g.datasource_id {
            None => true,
            Some(id) => !assigned_keys.contains(&(g.master_key.clone(), id)),
        })
        .collect::<Vec<_>>();

    let keys: Vec<String> = orphan_groups
        .iter()
        .map(|g| g.master_key.clone())
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
    let data: Vec<OrphanSignalGroupEntry> = orphan_groups
        .into_iter()
        .filter_map(|g| {
            let master_key = g.master_key.clone();
            let stats = stats.get(&master_key).cloned().unwrap_or_default();
            let group_admin_data = group_admin_data.get(&master_key).cloned();
            let aors = group_aors.get(&master_key).cloned();
            g.name.clone().map(|name| OrphanSignalGroupEntry {
                name,
                master_key: g.master_key,
                ignore_operativny: g.ignore_operativny,
                datasource_id: g.datasource_id,
                created_at: g.created_at.and_utc().timestamp_millis(),
                group_stats: stats,
                group_admin_data,
                areas_of_responsibility: aors,
            })
        })
        .collect();

    Ok(Json(data))
}
