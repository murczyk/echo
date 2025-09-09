use crate::entities::*;
use crate::error::AppError;
use crate::organism::types::{
    CreateOrganismReq, OrganismGroups, UpdateOrganismReq,
};
use crate::types::*;
use actix_web::web::Json;
use sea_orm::*;

pub async fn load_organism_group_ids<'a, 'async_trait, C>(
    txn: &'a C,
    organism_id: i64,
) -> Result<OrganismGroups, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let (_organism, parents) =
        load_organism_with_parents_chain(organism_id, txn)
            .await
            .context(h!())?;
    let mut organism_ids: Vec<i64> =
        parents.into_iter().map(|x| x.id).collect();
    organism_ids.push(organism_id);
    let organism_aors = area_of_responsibility::Entity::find()
        .join(
            JoinType::InnerJoin,
            area_of_responsibility::Relation::OrganismAor.def(),
        )
        .filter(organism_aor::Column::OrganismId.eq(organism_id))
        .all(txn)
        .await
        .context(h!())?;
    let m_aor_filter = if organism_aors.is_empty() {
        None
    } else {
        let mut conditions = vec![];
        for organism_aor in organism_aors {
            let condition_1 = area_of_responsibility::Column::LeftBound
                .gt(organism_aor.right_bound);
            let condition_2 = area_of_responsibility::Column::RightBound
                .lt(organism_aor.left_bound);
            let condition = condition_1.or(condition_2);
            conditions.push(condition.not());
        }
        let conditions = conditions
            .into_iter()
            .reduce(|a, b| a.or(b))
            .context(h!())?;
        let filter = signal_group_aor::Column::Id
            .is_not_null()
            .and(area_of_responsibility::Column::Id.is_not_null())
            .and(conditions);
        Some(filter)
    };

    let mut group_ids = signal_group::Entity::find()
        .join(
            JoinType::LeftJoin,
            signal_group::Relation::SignalGroupAor.def(),
        )
        .join(
            JoinType::LeftJoin,
            signal_group_aor::Relation::AreaOfResponsibility.def(),
        )
        .filter(signal_group::Column::Deleted.eq(false))
        .apply_if(m_aor_filter, |q, f| q.filter(f))
        .join(
            JoinType::InnerJoin,
            signal_group::Relation::SigintZoneDatasource.def(),
        )
        .select_only()
        .column(signal_group::Column::MasterKey)
        .distinct()
        .into_tuple::<String>()
        .all(txn)
        .await
        .context(h!())?;
    let organism_groups = organism_group::Entity::find()
        .filter(organism_group::Column::OrganismId.is_in(organism_ids.clone()))
        .all(txn)
        .await
        .context(h!())?;
    let mut selected_keys = vec![];
    for organism_id in organism_ids {
        selected_keys = organism_groups
            .iter()
            .filter(|x| x.organism_id == organism_id)
            .map(|x| x.signal_group_master_key.clone())
            .collect_vec();
        if !selected_keys.is_empty() {
            group_ids = group_ids
                .iter()
                .filter(|id| selected_keys.contains(id))
                .cloned()
                .collect();
        }
    }
    Ok(OrganismGroups {
        available_keys: group_ids,
        selected_keys,
    })
}

pub(crate) async fn load_organism_with_children(
    organism_id: i64,
    db: &DatabaseConnection,
) -> anyhow::Result<(organism::Model, Vec<organism::Model>)> {
    let mut all_organisms = organism::Entity::find()
        .filter(organism::Column::DeletedPermanently.eq(false))
        .all(db)
        .await
        .context(h!())?
        .into_iter()
        .map(|x| (x.id, x))
        .collect::<BTreeMap<_, _>>();

    fn collect_children(
        organisms: &BTreeMap<i64, organism::Model>,
        parent_id: i64,
    ) -> Vec<i64> {
        let mut result = vec![];
        for o in organisms.values() {
            let Some(actual_parent_id) = &o.parent_id else {
                continue;
            };
            if parent_id.eq(actual_parent_id) {
                result.push(o.id);
                for rec in collect_children(organisms, o.id) {
                    result.push(rec);
                }
            }
        }
        result
    }
    let children_ids = collect_children(&all_organisms, organism_id);
    let parent = all_organisms.remove(&organism_id).context(h!())?;
    let mut children = vec![];
    for child_id in children_ids {
        children.push(all_organisms.remove(&child_id).context(h!())?);
    }
    Ok((parent, children))
}

async fn load_organism_with_parents_chain<'a, 'async_trait, C>(
    organism_id: i64,
    txn: &'a C,
) -> anyhow::Result<(organism::Model, Vec<organism::Model>)>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut all_organisms: BTreeMap<_, _> = organism::Entity::find()
        .filter(organism::Column::DeletedPermanently.eq(false))
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .map(|x| (x.id, x))
        .collect();
    let parent_ids =
        find_parent_chain(&all_organisms, organism_id, 10).context(h!())?;
    let child = all_organisms.remove(&organism_id).context(h!())?;
    let mut parents = vec![];
    for parent in parent_ids {
        parents.push(all_organisms.remove(&parent).context(h!())?);
    }
    Ok((child, parents))
}

fn find_parent_chain(
    organisms: &BTreeMap<i64, organism::Model>,
    child_id: i64,
    fuel: usize,
) -> anyhow::Result<Vec<i64>> {
    if fuel == 0 {
        return Err(
            anyhow::anyhow!("Maximum recursion depth reached").context(h!())
        );
    }
    let child = organisms.get(&child_id).context(h!())?.clone();
    let Some(parent_id) = child.parent_id else {
        return Ok(vec![]);
    };
    let mut parents_chain =
        find_parent_chain(organisms, parent_id, fuel - 1).context(h!())?;
    parents_chain.push(parent_id);
    Ok(parents_chain)
}

pub async fn create_organism(
    dbx: &DatabaseConnection,
    req: &Json<CreateOrganismReq>,
) -> Result<organism::Model, AppError> {
    let txn = dbx.begin().await.context(h!())?;
    let parent_id = match req.parent_id {
        None => None,
        Some(parent_id) => {
            let has_organism = organism::Entity::find_by_id(parent_id)
                .filter(organism::Column::DeletedPermanently.eq(false))
                .count(&txn)
                .await
                .context(h!())?
                == 1;
            if has_organism {
                Some(parent_id)
            } else {
                None
            }
        }
    };

    let organism = organism::ActiveModel {
        id: NotSet,
        name: Set(req.name.clone()),
        roles: Set(serde_json::to_value(req.roles.clone()).context(h!())?),
        group_auto_link: Set(Some(req.group_auto_link.unwrap_or(false))),
        created_at: NotSet,
        enabled: NotSet,
        parent_id: Set(parent_id),
        deleted_permanently: NotSet,
    }
    .insert(&txn)
    .await?;

    upsert_organism_aors(&txn, req.aor_ids.clone(), organism.id)
        .await
        .context(h!())?;

    txn.commit().await.context(h!())?;
    Ok(organism)
}

pub async fn update_organism(
    dbx: &DatabaseConnection,
    req: &UpdateOrganismReq,
) -> Result<organism::Model, AppError> {
    let txn = dbx.begin().await.context(h!())?;

    let parent_id = match req.parent_id {
        None => None,
        Some(parent_id) => {
            let has_organism = organism::Entity::find_by_id(parent_id)
                .filter(organism::Column::DeletedPermanently.eq(false))
                .count(&txn)
                .await
                .context(h!())?
                == 1;
            if has_organism {
                Some(parent_id)
            } else {
                None
            }
        }
    };

    let organism_obj = organism::Entity::find()
        .filter(organism::Column::DeletedPermanently.eq(false))
        .filter(organism::Column::Id.eq(req.id))
        .one(&txn)
        .await
        .context(h!())?
        .ok_or(AppError::NotFound)?;

    let mut organism: organism::ActiveModel = organism_obj.into();

    if let Some(name) = req.name.clone() {
        organism.name = Set(name);
    }
    organism.parent_id = Set(parent_id);
    if let Some(roles) = req.roles.clone() {
        organism.roles = Set(serde_json::to_value(roles).context(h!())?);
    }
    if let Some(group_auto_link) = req.group_auto_link {
        organism.group_auto_link = Set(Some(group_auto_link));
    }
    organism.enabled = Set(req.enabled);

    let organism = organism.update(&txn).await.context(h!())?;

    upsert_organism_aors(&txn, req.aor_ids.clone(), req.id)
        .await
        .context(h!())?;

    txn.commit().await.context(h!())?;
    Ok(organism)
}

async fn upsert_organism_aors(
    txn: &DatabaseTransaction,
    m_aor_ids: Option<Vec<i64>>,
    organism_id: i64,
) -> Result<(), AppError> {
    match m_aor_ids {
        None => {
            organism_aor::Entity::delete_many()
                .filter(organism_aor::Column::OrganismId.eq(organism_id))
                .exec(txn)
                .await
                .context(h!())?;
        }
        Some(aor_ids) => {
            organism_aor::Entity::delete_many()
                .filter(organism_aor::Column::OrganismId.eq(organism_id))
                .filter(organism_aor::Column::AorId.is_not_in(aor_ids.clone()))
                .exec(txn)
                .await
                .context(h!())?;
            let existing_ids = organism_aor::Entity::find()
                .filter(organism_aor::Column::OrganismId.eq(organism_id))
                .filter(organism_aor::Column::AorId.is_in(aor_ids.clone()))
                .select_only()
                .column(organism_aor::Column::AorId)
                .into_tuple::<i64>()
                .all(txn)
                .await
                .context(h!())?
                .into_iter()
                .collect::<HashSet<_>>();
            for id in aor_ids {
                if existing_ids.contains(&id) {
                    continue;
                }
                organism_aor::ActiveModel {
                    id: NotSet,
                    organism_id: Set(organism_id),
                    aor_id: Set(id),
                    created_at: NotSet,
                }
                .insert(txn)
                .await
                .context(h!())?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_find_parent_chain() {
        let mut organisms = BTreeMap::new();
        organisms.insert(1, mk_organism_with_parent(1, -1));
        organisms.insert(2, mk_organism_with_parent(2, -1));
        organisms.insert(3, mk_organism_with_parent(3, -1));
        organisms.insert(11, mk_organism_with_parent(11, 1));
        organisms.insert(12, mk_organism_with_parent(12, 1));
        organisms.insert(13, mk_organism_with_parent(13, 1));
        organisms.insert(21, mk_organism_with_parent(21, 2));
        organisms.insert(111, mk_organism_with_parent(111, 11));
        organisms.insert(121, mk_organism_with_parent(121, 12));
        organisms.insert(122, mk_organism_with_parent(122, 12));

        fn assert_parents(
            expected_parents: Vec<i64>,
            id: i64,
            organisms: &BTreeMap<i64, organism::Model>,
        ) {
            let parents = find_parent_chain(organisms, id, 10).unwrap();
            assert_eq!(expected_parents, parents);
        }

        assert_parents(vec![], 1, &organisms);
        assert_parents(vec![], 2, &organisms);
        assert_parents(vec![], 3, &organisms);
        assert_parents(vec![1], 11, &organisms);
        assert_parents(vec![1], 12, &organisms);
        assert_parents(vec![1], 13, &organisms);
        assert_parents(vec![2], 21, &organisms);
        assert_parents(vec![1, 11], 111, &organisms);
        assert_parents(vec![1, 12], 121, &organisms);
        assert_parents(vec![1, 12], 122, &organisms);
    }

    fn mk_organism_with_parent(id: i64, parent_id: i64) -> organism::Model {
        let parent_id = if parent_id < 0 { None } else { Some(parent_id) };
        organism::Model {
            id,
            parent_id,
            name: "".to_string(),
            created_at: Default::default(),
            roles: Default::default(),
            group_auto_link: None,
            enabled: true,
            deleted_permanently: false,
        }
    }
}
