use crate::entities::*;
use crate::error::AppError;
use crate::types::*;
use sea_orm::*;

pub async fn load_organism_group_ids<'a, 'async_trait, C>(
    txn: &'a C,
    organism_id: i64,
) -> Result<Vec<String>, AppError>
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
    let groups = organism_group::Entity::find()
        .filter(organism_group::Column::OrganismId.is_in(organism_ids.clone()))
        .all(txn)
        .await
        .context(h!())?;
    let mut group_ids = vec![];
    for organism_id in organism_ids {
        let new_group_ids = groups
            .iter()
            .filter(|x| x.organism_id == organism_id)
            .map(|x| x.signal_group_master_key.clone())
            .filter(|x| group_ids.is_empty() || group_ids.contains(x))
            .collect_vec();
        if !new_group_ids.is_empty() {
            group_ids = new_group_ids;
        }
    }
    Ok(group_ids)
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

    fn find_parent_chain(
        organisms: &BTreeMap<i64, organism::Model>,
        child_id: i64,
    ) -> Vec<i64> {
        if let Some(child) = organisms.get(&child_id) {
            let Some(parent_id) = &child.parent_id else {
                return vec![];
            };
            let mut parents_chain = find_parent_chain(organisms, *parent_id);
            parents_chain.push(*parent_id);
        }
        vec![]
    }
    let parent_ids = find_parent_chain(&all_organisms, organism_id);
    let child = all_organisms.remove(&organism_id).context(h!())?;
    let mut parents = vec![];
    for parent in parent_ids {
        parents.push(all_organisms.remove(&parent).context(h!())?);
    }
    Ok((child, parents))
}
