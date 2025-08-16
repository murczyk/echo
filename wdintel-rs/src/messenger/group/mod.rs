use crate::entities::*;
use crate::error::AppError;
use crate::h;
use crate::types::*;
use anyhow::Context;
use echo_migration::JoinType;
use log::error;
use sea_orm::*;

#[cfg(test)]
pub mod tests;

pub async fn add_group<'a, 'async_trait, C>(
    group: signal_group::ActiveModel,
    dbx: &'a C,
) -> anyhow::Result<signal_group::Model>
where
    C: ConnectionTrait + 'async_trait,
{
    let new_group = group.insert(dbx).await.context(h!())?;
    if let Err(e) = insert_group_aor(dbx, &new_group).await {
        error!("failed to insert group's area of responsibility: {e:?}")
    }
    Ok(new_group)
}

pub async fn fix_group_areas_of_responsibility(
    db: &DatabaseConnection,
) -> Result<(), AppError> {
    let groups = signal_group::Entity::find()
        .join(
            JoinType::LeftJoin,
            signal_group::Relation::SignalGroupAor.def(),
        )
        .filter(signal_group_aor::Column::Id.is_null())
        .all(db)
        .await
        .context(h!())?;
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

    let Some(datasource_id) = group.datasource_id else {
        info!("[group={master_key}] skipped assigning group's area of responsibility: no datasource specified for the group");
        return Ok(None);
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
