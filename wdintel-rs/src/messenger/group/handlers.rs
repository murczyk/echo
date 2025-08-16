use super::types::*;
use crate::entities::*;
use crate::messenger::group::collect_group_stats;
use crate::rer_importer::collect_group_admin_data;
use crate::rer_importer::collect_group_aors;
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
    let assigned_keys: Vec<String> = sigint_zone_datasource::Entity::find()
        .select_only()
        .column(sigint_zone_datasource::Column::GroupMasterKey)
        .into_tuple::<String>()
        .all(&env.dbx)
        .await
        .context(h!())?;

    // Знайти всі signal_group, яких немає серед assigned_keys
    // Сортувати за часом створення (найновіші першими)
    let orphan_groups = signal_group::Entity::find()
        .filter(signal_group::Column::MasterKey.is_not_in(assigned_keys))
        .order_by_desc(signal_group::Column::CreatedAt)
        .all(&env.dbx)
        .await
        .context(h!())?;

    let keys: Vec<String> =
        orphan_groups.iter().map(|b| b.master_key.clone()).collect();
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
            let stats = stats.get(&g.master_key).cloned().unwrap_or_default();
            let group_admin_data =
                group_admin_data.get(g.master_key.as_str()).cloned();
            let aor = group_aors.get(g.master_key.as_str()).cloned();
            g.name.clone().map(|name| OrphanSignalGroupEntry {
                name,
                master_key: g.master_key,
                ignore_operativny: g.ignore_operativny,
                datasource_id: g.datasource_id,
                created_at: g.created_at.and_utc().timestamp_millis(),
                group_stats: stats,
                group_admin_data,
                areas_of_responsibility: aor.map(|a| vec![a]),
            })
        })
        .collect();

    Ok(Json(data))
}
