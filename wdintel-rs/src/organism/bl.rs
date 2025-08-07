use crate::entities::*;
use crate::error::AppError;
use crate::organism::types::OrganismGroups;
use crate::types::*;
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
    let mut organism_ids =
        parents.into_iter().map(|x| x.id).collect::<Vec<_>>();
    organism_ids.push(organism_id);
    let mut group_ids = signal_group::Entity::find()
        .select_only()
        .column(signal_group::Column::MasterKey)
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
        for (_id, o) in organisms {
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
    let mut all_organisms = organism::Entity::find()
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .map(|x| (x.id, x))
        .collect::<BTreeMap<_, _>>();
    let parent_ids =
        find_parent_chain(&all_organisms, organism_id).context(h!())?;
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
) -> anyhow::Result<Vec<i64>> {
    let child = organisms.get(&child_id).context(h!())?.clone();
    let Some(parent_id) = child.parent_id else {
        return Ok(vec![]);
    };
    let mut parents_chain =
        find_parent_chain(organisms, parent_id).context(h!())?;
    parents_chain.push(parent_id);
    Ok(parents_chain)
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
            let parents = find_parent_chain(&organisms, id).unwrap();
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
        }
    }
}
