use crate::entities::*;
use crate::organism::bl::load_organism_group_ids;
use crate::organism::types::OrganismGroups;
use crate::sigint::aor::bl::collect_group_aors;
use crate::types::*;
use crate::utils::orm::ArrayColumnOps;
use chrono::Utc;
use echo_migration::{Expr, JoinType};
use sea_orm::*;

pub mod handlers;
pub mod oneoff;
#[cfg(test)]
pub mod tests;
pub mod types;

#[derive(Clone, Copy, Default)]
pub struct CollectGroupsOpts {
    pub skip_group_stats: bool,
}

pub async fn collect_groups(
    keys: Vec<String>,
    txn: &DatabaseConnection,
    is_admin: bool,
    opts: CollectGroupsOpts,
) -> Result<Vec<types::SignalGroupEntry>, AppError> {
    let signal_groups = signal_group::Entity::find()
        .filter(signal_group::Column::Deleted.eq(false))
        .filter(signal_group::Column::MasterKey.eq_any(keys.clone()))
        .all(txn)
        .await
        .context(h!())?;
    let group_stats = if opts.skip_group_stats {
        BTreeMap::new()
    } else {
        collect_group_stats(keys.clone(), txn).await.context(h!())?
    };

    let group_aors = if is_admin {
        collect_group_aors(keys.clone(), txn).await.context(h!())?
    } else {
        BTreeMap::new()
    };

    let group_admin_data = if is_admin {
        collect_group_admin_data(keys, txn).await.context(h!())?
    } else {
        BTreeMap::new()
    };

    let data: Vec<types::SignalGroupEntry> = signal_groups
        .iter()
        .filter_map(|g| {
            let stats = group_stats
                .get(g.master_key.as_str())
                .cloned()
                .unwrap_or_default();
            let aors = group_aors.get(g.master_key.as_str()).cloned();
            let group_admin_data =
                group_admin_data.get(g.master_key.as_str()).cloned();
            g.name.clone().map(|name| types::SignalGroupEntry {
                name,
                master_key: g.master_key.clone(),
                ignore_operativny: g.ignore_operativny,
                group_stats: stats,
                admin_data: group_admin_data,
                areas_of_responsibility: aors,
            })
        })
        .collect();
    Ok(data)
}

pub async fn collect_groups_f2(
    keys: Vec<String>,
    txn: &DatabaseConnection,
) -> Result<Vec<types::SignalGroupEntryF2>, AppError> {
    #[derive(FromQueryResult, Eq, PartialEq, Hash)]
    struct GroupRow {
        pub name: String,
        pub master_key: String,
        pub kind: String,
    }
    let signal_groups = signal_group::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_group::Relation::DatasourceGroup.def(),
        )
        .join(
            JoinType::InnerJoin,
            datasource_group::Relation::Datasource.def(),
        )
        .filter(signal_group::Column::Deleted.eq(false))
        .filter(signal_group::Column::Name.is_not_null())
        .filter(signal_group::Column::MasterKey.eq_any(keys.clone()))
        .select_only()
        .column(signal_group::Column::Name)
        .column(signal_group::Column::MasterKey)
        .column(datasource::Column::Kind)
        .into_model::<GroupRow>()
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .collect::<HashSet<_>>();
    let group_stats =
        collect_group_stats(keys.clone(), txn).await.context(h!())?;
    let data: Vec<types::SignalGroupEntryF2> = signal_groups
        .into_iter()
        .map(|group| {
            let stats = group_stats
                .get(group.master_key.as_str())
                .cloned()
                .unwrap_or_default();
            types::SignalGroupEntryF2 {
                name: group.name,
                master_key: group.master_key.clone(),
                kind: group.kind,
                group_stats: stats,
            }
        })
        .collect();
    Ok(data)
}

pub async fn add_group<'a, 'async_trait, C>(
    group: signal_group::ActiveModel,
    dbx: &'a C,
) -> anyhow::Result<signal_group::Model>
where
    C: ConnectionTrait + 'async_trait,
{
    // Capture the master_key before the insert consumes the model
    let master_key = match group.master_key.clone() {
        Set(v) => v,
        _ => bail!("master_key must be set when adding group"),
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
            error!("failed to insert group's area of responsibility: {e:?}");
        } else {
            info!("added {}", g.master_key);
            if let Err(e) =
                crate::sigint::inbox::invalidate_network_inbox_for_group(db, &g)
                    .await
            {
                error!("invalidate_network_inbox_for_group failed: {e:#?}")
            }
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
        master_key: Set(master_key.clone()),
        aor_id: Set(aor.id),
        created_at: NotSet,
        id: NotSet,
    };
    model.insert(dbx).await.context(h!())?;
    if let Err(e) =
        crate::sigint::inbox::invalidate_network_inbox_for_group_with_key(
            dbx,
            &master_key,
        )
        .await
    {
        error!("invalidate_network_inbox_for_group failed: {e:#?}")
    }
    Ok(Some(aor))
}

pub async fn collect_group_stats<'a, 'async_trait, C>(
    keys: Vec<String>,
    txn: &'a C,
) -> Result<BTreeMap<String, types::SignalGroupStats>, AppError>
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
            types::SignalGroupStats {
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

    let master_key = ensure_signal_group(
        db,
        master_key.clone(),
        group_name.clone(),
        datasource_id,
    )
    .await
    .c(h!())?;
    let new_group = datasource_group::ActiveModel {
        group_master_key: Set(master_key),
        name: Set(group_name.unwrap_or_default()),
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

pub async fn ensure_signal_group<'a, 'async_trait, C>(
    db: &C,
    master_key: String,
    group_name: Option<String>,
    datasource_id: i64,
) -> anyhow::Result<String>
where
    C: ConnectionTrait + 'async_trait,
{
    let signal_group = signal_group::Entity::find_by_id(master_key.clone())
        .one(db)
        .await
        .c(h!())?;

    let saved = match signal_group {
        None => signal_group::ActiveModel {
            master_key: Set(master_key),
            name: Set(group_name),
            datasource_id: Set(Some(datasource_id)),
            created_at: NotSet,
            ignore_operativny: NotSet,
            is_secret: NotSet,
            deleted: NotSet,
        }
        .insert(db)
        .await
        .c(h!())?,
        Some(sg) => sg,
    };

    Ok(saved.master_key)
}

pub async fn collect_group_admin_data<'a, 'async_trait, C>(
    keys: Vec<String>,
    txn: &'a C,
) -> Result<BTreeMap<String, types::GroupAdminData>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let result = group_admin_data::Entity::find()
        .filter(group_admin_data::Column::GroupMasterKey.eq_any(keys.clone()))
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .map(|g| {
            (
                g.group_master_key.clone(),
                types::GroupAdminData {
                    short_note: g.short_note,
                    long_note: g.long_note,
                },
            )
        })
        .flat_map(|(m_id, data)| m_id.map(|m_id| (m_id, data)))
        .collect::<BTreeMap<String, types::GroupAdminData>>();
    Ok(result)
}

pub async fn count_group_messages<'a, 'async_trait, C>(
    keys: Vec<String>,
    txn: &'a C,
    num_days: i64,
) -> Result<BTreeMap<String, i64>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let cutoff = Utc::now().naive_utc() - chrono::Duration::days(num_days);
    let signal_message_counts = signal_message_group::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message_group::Relation::SignalMessage.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message_group::Relation::SignalGroup.def(),
        )
        .select_only()
        .column(signal_group::Column::MasterKey)
        .column_as(Expr::cust("count(*)"), "count")
        .group_by(signal_group::Column::MasterKey)
        .filter(signal_group::Column::Deleted.eq(false))
        .filter(signal_group::Column::MasterKey.eq_any(keys))
        .filter(signal_message::Column::Timestamp.gte(cutoff))
        .into_tuple::<(String, i64)>()
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .collect();
    Ok(signal_message_counts)
}

pub async fn get_identity_sigint_groups<'a, 'async_trait, C>(
    txn: &'a C,
    login: &str,
) -> Result<Vec<String>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let login_obj = login::Entity::find()
        .filter(login::Column::Login.eq(login))
        .filter(login::Column::DeletedPermanently.eq(false))
        .one(txn)
        .await
        .context(h!())?
        .context(h!())?;
    let zone_id: i64 = login_obj
        .sigint_zone_id
        .context(h!())
        .context(format!("Zone must be set for user: {login}"))?;
    let organism_id: i64 = login_obj
        .organism_id
        .context(h!())
        .context(format!("Organism must be set for user: {login}"))?;

    let organism_groups: OrganismGroups =
        load_organism_group_ids(txn, organism_id)
            .await
            .context(h!())?;
    let group_query = signal_group::Entity::find()
        .filter(signal_group::Column::Deleted.eq(false))
        .filter(
            signal_group::Column::MasterKey
                .eq_any(organism_groups.available_keys),
        )
        .filter(
            Expr::col((signal_group::Entity, signal_group::Column::MasterKey))
                .equals((
                    sigint_zone_datasource::Entity,
                    sigint_zone_datasource::Column::GroupMasterKey,
                )),
        )
        .join(
            JoinType::InnerJoin,
            signal_group::Relation::DatasourceGroup.def(),
        )
        .join(
            JoinType::InnerJoin,
            datasource_group::Relation::Datasource.def(),
        )
        .join(
            JoinType::InnerJoin,
            datasource::Relation::SigintZoneDatasource.def(),
        )
        .filter(sigint_zone_datasource::Column::SigintZoneId.eq(zone_id));

    #[derive(FromQueryResult)]
    struct OrganismGroupsRes {
        pub master_key: String,
    }

    let organism_groups_obj =
        crate::sigint::zone::filter_out_ineligible_secret_chats(
            group_query,
            login,
        )
        .select_only()
        .column(signal_group::Column::MasterKey)
        .distinct()
        .into_model::<OrganismGroupsRes>()
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .map(|og| og.master_key)
        .collect();

    Ok(organism_groups_obj)
}

/// Gets group keys similar to get_identity_sigint_groups but without the import group id
pub async fn get_identity_sigint_groups_noimport(
    dbx: &DatabaseConnection,
    user: &actix_identity::Identity,
    _config: &crate::config::Config,
) -> Result<Vec<String>, AppError> {
    let login = user.id().c(h!())?;
    let master_keys = get_identity_sigint_groups(dbx, &login)
        .await
        .context(h!())?;
    // let mut master_keys = get_identity_sigint_groups(dbx, user).await.context(h!())?;
    // if let Some(import_group) = signal_group::Entity::find()
    //     .filter(
    //         signal_group::Column::Name
    //             .eq(config.signal_import_group_name.clone()),
    //     )
    //     .one(dbx)
    //     .await.context(h!())?
    // {
    //     master_keys = master_keys
    //         .clone()
    //         .into_iter()
    //         .filter(|key| key != &import_group.master_key)
    //         .collect::<Vec<_>>();
    // }
    Ok(master_keys)
}
