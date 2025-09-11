use crate::entities::*;
use crate::rer_importer::count_group_messages;
use crate::rer_importer::types::SignalGroupStats;
use crate::types::*;
use echo_migration::JoinType;
use sea_orm::*;

pub mod handlers;
pub mod oneoff;
#[cfg(test)]
pub mod tests;
pub mod types;

pub async fn add_group<'a, 'async_trait, C>(
    group: signal_group::ActiveModel,
    dbx: &'a C,
) -> anyhow::Result<signal_group::Model>
where
    C: ConnectionTrait + 'async_trait,
{
    // Capture the master_key before the insert consumes the model
    let master_key = match group.master_key.clone() {
        sea_orm::ActiveValue::Set(v) => v,
        _ => anyhow::bail!("master_key must be set when adding group"),
    };

    // Upsert by primary key to avoid duplicate key violations when the group
    // already exists (e.g., from concurrent syncs or prior runs). Also revive
    // soft-deleted groups by setting deleted=false and refresh the name.
    signal_group::Entity::insert(group)
        .on_conflict(
            sea_query::OnConflict::column(signal_group::Column::MasterKey)
                .update_columns([
                    signal_group::Column::Name,
                    signal_group::Column::Deleted,
                ])
                .to_owned(),
        )
        .exec(dbx)
        .await
        .c(h!())?;

    // Load the resulting row to return a full Model
    let new_group = signal_group::Entity::find_by_id(master_key)
        .one(dbx)
        .await
        .c(h!())?
        .c(h!())?;

    if let Err(e) = insert_group_aor(dbx, &new_group).await {
        error!("failed to insert group's area of responsibility: {e:?}")
    }
    Ok(new_group)
}

pub async fn fix_group_areas_of_responsibility(
    db: &DatabaseConnection,
) -> Result<(), AppError> {
    let groups = signal_group::Entity::find()
        .filter(signal_group::Column::Deleted.eq(false))
        .join(
            JoinType::LeftJoin,
            signal_group::Relation::SignalGroupAor.def(),
        )
        .filter(signal_group_aor::Column::Id.is_null())
        .all(db)
        .await
        .c(h!())?;
    for g in groups {
        if let Err(e) = insert_group_aor(db, &g).await {
            error!("failed to insert group's area of responsibility: {e:?}")
        } else {
            info!("added  ")
        }
    }
    Ok(())
}

async fn insert_group_aor<'a, 'async_trait, C>(
    dbx: &'a C,
    group: &signal_group::Model,
) -> anyhow::Result<Option<area_of_responsibility::Model>>
where
    C: ConnectionTrait + 'async_trait,
{
    let master_key = group.master_key.clone();

    // Check if group already has AOR assignments
    let existing_aors = signal_group_aor::Entity::find()
        .filter(signal_group_aor::Column::MasterKey.eq(&master_key))
        .count(dbx)
        .await
        .context(h!())?;

    if existing_aors > 0 {
        info!("[group={master_key}] skipped assigning group's area of responsibility: group already has AOR assignments");
        return Ok(None);
    }

    let datasource_id = match datasource_group::Entity::find()
        .filter(
            datasource_group::Column::GroupMasterKey
                .eq(group.master_key.clone()),
        )
        .one(dbx)
        .await
        .context(h!())?
    {
        Some(dg) => dg.datasource_id,
        None => {
            info!("[group={master_key}] skipped assigning group's area of responsibility: no datasource mapping found for the group");
            return Ok(None);
        }
    };
    let aor = area_of_responsibility::Entity::find()
        .join(
            JoinType::InnerJoin,
            area_of_responsibility::Relation::Datasource.def(),
        )
        .filter(datasource::Column::Id.eq(datasource_id))
        .one(dbx)
        .await
        .context(h!())?;
    let Some(aor) = aor else {
        info!("[group={master_key}] skipped assigning group's area of responsibility: no area of responsibility is assigned for datasource {datasource_id}");
        return Ok(None);
    };
    let model = signal_group_aor::ActiveModel {
        master_key: Set(master_key),
        aor_id: Set(aor.id),
        created_at: NotSet,
        id: NotSet,
    };
    model.insert(dbx).await.context(h!())?;
    Ok(Some(aor))
}

pub async fn collect_group_stats<'a, 'async_trait, C>(
    keys: Vec<String>,
    txn: &'a C,
) -> Result<BTreeMap<String, SignalGroupStats>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let signal_message_counts_last_day =
        count_group_messages(keys.clone(), txn, 1)
            .await
            .context(h!())?;
    let signal_message_counts_last_week =
        count_group_messages(keys.clone(), txn, 7)
            .await
            .context(h!())?;
    let mut result = BTreeMap::new();
    for k in keys {
        let activity_last_day =
            signal_message_counts_last_day.get(&k).cloned().unwrap_or(0);
        let activity_last_week = signal_message_counts_last_week
            .get(&k)
            .cloned()
            .unwrap_or(0);
        result.insert(
            k,
            SignalGroupStats {
                activity_last_day,
                activity_last_week,
            },
        );
    }
    Ok(result)
}

pub async fn ensure_datasource_group_id<'a, 'async_trait, C>(
    db: &C,
    master_key: String,
    datasource_id: i64,
) -> anyhow::Result<i64>
where
    C: ConnectionTrait + 'async_trait,
{
    let (group_name, datasource_group_id) = signal_group::Entity::find()
        .left_join(datasource_group::Entity)
        .filter(signal_group::Column::MasterKey.eq(master_key.clone()))
        .filter(
            datasource_group::Column::Id.is_null().or(
                datasource_group::Column::GroupMasterKey
                    .eq(master_key.clone())
                    .and(
                        datasource_group::Column::DatasourceId
                            .eq(datasource_id),
                    ),
            ),
        )
        .select_only()
        .column(signal_group::Column::Name)
        .column(datasource_group::Column::Id)
        .into_tuple::<(Option<String>, Option<i64>)>()
        .one(db)
        .await
        .context(h!())?
        .unwrap_or((None, None));
    if let Some(datasource_group_id) = datasource_group_id {
        return Ok(datasource_group_id);
    };
    let group_name = group_name.unwrap_or_default();
    let new_group = datasource_group::ActiveModel {
        group_master_key: Set(master_key),
        name: Set(group_name),
        datasource_id: Set(datasource_id),
        created_at: NotSet,
        id: NotSet,
        last_sync_at: NotSet,
        deleted: NotSet,
    }
    .insert(db)
    .await
    .context(h!())?;
    Ok(new_group.id)
}
