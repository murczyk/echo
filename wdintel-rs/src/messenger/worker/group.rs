use crate::entities::sea_orm_active_enums::*;
use crate::entities::*;
use crate::error::*;
use crate::utils::orm::ArrayColumnOps;
use crate::{
    messenger::{group::ensure_signal_group, worker::sources_eq},
    types::*,
};
use chrono::*;
use echo_migration::Expr;
use sea_orm::*;

pub async fn sync_groups(
    txn: &DatabaseTransaction,
    client_name: &str,
    client_groups_sync_ts_map: &mut BTreeMap<String, NaiveDateTime>,
) -> anyhow::Result<()> {
    let datasource =
        crate::messenger::worker::load_client_datasource(txn, client_name)
            .await
            .c(h!())?;
    let now = Utc::now().naive_utc();
    if let Some(last_updated_ts) =
        client_groups_sync_ts_map.get(client_name).cloned()
    {
        let stale_at = last_updated_ts + TimeDelta::minutes(2);
        if now <= stale_at {
            return Ok(()); // already in sync
        }
    }
    let unsorted_groups =
        echo_im::list_groups(client_name, txn).await.c(h!())?;
    let group_statuses = unsorted_groups
        .iter()
        .map(|g| (g.id.clone(), g.name.clone(), g.deleted_by_messenger))
        .collect_vec();
    let datasource_groups =
        datasource_group::Entity::find().all(txn).await.c(h!())?;
    let messenger_profiles = echo_client_lock::Entity::find()
        .join(
            JoinType::InnerJoin,
            echo_client_lock::Relation::EchoClient.def(),
        )
        .join(
            JoinType::InnerJoin,
            echo_client_lock::Relation::EchoAccount.def(),
        )
        .join(
            JoinType::InnerJoin,
            echo_client_lock::Relation::Datasource.def(),
        )
        .filter(echo_client::Column::Name.eq(client_name))
        .select_only()
        .column(datasource::Column::Id)
        .column(echo_account::Column::Source)
        .into_tuple::<(i64, EchoMessageSource)>()
        .all(txn)
        .await
        .c(h!())?;

    let mut groups = vec![];
    let mut deleted_groups = vec![];
    for g in unsorted_groups.clone() {
        if g.deleted_by_messenger {
            deleted_groups.push(g);
        } else {
            groups.push(g);
        }
    }
    let group_master_keys =
        groups.iter().map(|x| x.id.clone()).collect::<Vec<_>>();

    let mut existing_groups: BTreeMap<(String, i64), GroupData> =
        BTreeMap::new();

    #[derive(Clone)]
    struct GroupData {
        id: String,
        name: Option<String>,
        created_at: NaiveDateTime,
        model_a: Option<signal_group::Model>,
        model_b: Option<whatsapp_group::Model>,
        datasource_id: i64,
    }

    let mut groups_raw = vec![];
    let group_models = signal_group::Entity::find()
        .filter(signal_group::Column::Deleted.eq(false))
        .filter(
            signal_group::Column::MasterKey.eq_any(group_master_keys.clone()),
        )
        .all(txn)
        .await
        .cae(h!())?;
    for g in group_models {
        groups_raw.push(GroupData {
            model_a: Some(g.clone()),
            model_b: None,
            id: g.master_key.clone(),
            name: g.name,
            created_at: g.created_at,
            datasource_id: datasource.id,
        })
    }
    whatsapp_group::Entity::find()
        .filter(whatsapp_group::Column::Deleted.eq(false))
        .filter(whatsapp_group::Column::Jid.eq_any(group_master_keys))
        .all(txn)
        .await
        .cae(h!())?
        .into_iter()
        .for_each(|g| {
            groups_raw.push(GroupData {
                model_a: None,
                model_b: Some(g.clone()),
                id: g.jid,
                name: Some(g.name),
                created_at: g.created_at,
                datasource_id: datasource.id,
            })
        });
    let mut groups_by_dsid = HashMap::new();
    for g in groups_raw {
        let datasource_id = g.datasource_id;
        let mut groups =
            groups_by_dsid.remove(&datasource_id).unwrap_or(vec![]);
        groups.push(g);
        groups_by_dsid.insert(datasource_id, groups);
    }
    for (datasource_id, groups_raw) in groups_by_dsid {
        for g in groups_raw {
            let key = (g.id.clone(), datasource_id);
            match existing_groups.get(&key) {
                None => {
                    existing_groups.insert(key, g);
                }
                Some(g2) => {
                    if g.created_at > g2.created_at {
                        existing_groups.insert(key, g.clone());
                    } else {
                        existing_groups.insert(key, g2.clone());
                    }
                }
            }
        }
    }

    for g in groups {
        let group_id = g.id.clone();
        match existing_groups.get(&(group_id.clone(), datasource.id)) {
            None => {
                let model = signal_group::ActiveModel {
                    name: Set(Some(g.name.clone())),
                    datasource_id: Set(Some(datasource.id)),
                    created_at: NotSet,
                    ignore_operativny: NotSet,
                    master_key: Set(group_id.clone()),
                    is_secret: NotSet,
                    deleted: NotSet,
                    is_archived: NotSet,
                    is_rer: NotSet,
                };
                crate::messenger::group::add_group(model, txn)
                    .await
                    .c(h!())?;
                if g.message_source
                    .eq(&echo_im::types::MessageSource::Whatsapp)
                {
                    whatsapp_group::ActiveModel {
                        name: Set(g.name.clone()),
                        created_at: NotSet,
                        jid: Set(group_id.clone()),
                        owner_jid: NotSet,
                        deleted: NotSet,
                    }
                    .insert(txn)
                    .await
                    .c(h!())?;
                }
            }
            Some(group_model) => {
                let name = Some(g.name.clone());
                if group_model.name != name {
                    if let Some(ref model) = group_model.model_a {
                        let mut model = model.clone().into_active_model();
                        model.name = Set(name);
                        model.update(txn).await.c(h!())?;
                    } else {
                        let mut model = group_model
                            .model_b
                            .clone()
                            .c(h!())?
                            .into_active_model();
                        model.name = Set(g.name.clone());
                        model.update(txn).await.c(h!())?;
                    }
                }
            }
        }
    }

    let mut datasource_groups_to_delete = vec![];

    for g in deleted_groups {
        let datasource_ids = messenger_profiles
            .iter()
            .filter(|(_, source)| sources_eq(&g.message_source, source))
            .map(|(id, _)| *id)
            .collect_vec();
        for id in datasource_ids {
            datasource_groups_to_delete.push((g.id.clone(), id));
        }
    }
    for (master_key, datasource_id) in datasource_groups_to_delete.clone() {
        datasource_group::Entity::update_many()
            .filter(datasource_group::Column::DatasourceId.eq(datasource_id))
            .filter(datasource_group::Column::GroupMasterKey.eq(master_key))
            .col_expr(datasource_group::Column::Deleted, Expr::value(true))
            .exec(txn)
            .await
            .c(h!())?;
    }
    client_groups_sync_ts_map.insert(client_name.to_string(), now);

    for g in unsorted_groups.clone() {
        let datasource_ids = messenger_profiles
            .iter()
            .filter(|(_, source)| sources_eq(&g.message_source, source))
            .map(|(id, _)| *id)
            .collect_vec();
        let should_skip = datasource_ids.iter().any(|id| {
            datasource_groups_to_delete.contains(&(g.id.clone(), *id))
        });
        if should_skip {
            continue;
        }
        let datasource_id = datasource_ids.into_iter().next().c(h!())?;
        let datasource_group = datasource_groups
            .iter()
            .filter(|d| d.group_master_key == g.id)
            .find(|d| d.datasource_id.eq(&datasource_id))
            .cloned();
        match datasource_group {
            None => {
                let master_key = ensure_signal_group(
                    txn,
                    g.id.clone(),
                    Some(g.name.clone()),
                    datasource_id,
                )
                .await
                .c(h!())?;
                datasource_group::ActiveModel {
                    id: NotSet,
                    group_master_key: Set(master_key),
                    datasource_id: Set(datasource_id),
                    last_sync_at: NotSet,
                    created_at: NotSet,
                    name: Set(g.name),
                    deleted: NotSet,
                }
                .insert(txn)
                .await
                .c(h!())?;
            }
            Some(rec) => {
                let mut rec = rec.into_active_model();
                rec.last_sync_at = Set(Utc::now().naive_utc());
                rec.name = Set(g.name);
                rec.update(txn).await.c(h!())?;
            }
        }
    }
    // now correct deleted and anonymous groups
    let deleted_noname_signal_groups = signal_group::Entity::find()
        .filter(
            signal_group::Column::Deleted
                .eq(true)
                .or(signal_group::Column::Name.eq("".to_string())),
        )
        .all(txn)
        .await
        .c(h!())?;
    for g in deleted_noname_signal_groups {
        let Some((name, deleted)) = group_statuses
            .iter()
            .filter(|(id, _name, _deleted)| g.master_key.eq(id))
            .map(|(_id, name, deleted)| (name.clone(), *deleted))
            .reduce(|(a_name, a_deleted), (b_name, b_deleted)| {
                (
                    Some(a_name).filter(|s| !s.is_empty()).unwrap_or(b_name),
                    a_deleted && b_deleted,
                )
            })
        else {
            continue;
        };
        if g.name.eq(&Some(name.clone())) && g.deleted == deleted {
            continue;
        }
        let mut rec = g.into_active_model();
        rec.name = Set(Some(name));
        rec.deleted = Set(deleted);
        rec.update(txn).await.c(h!())?;
    }
    Ok(())
}
