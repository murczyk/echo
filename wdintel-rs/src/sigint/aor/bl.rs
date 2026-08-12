use crate::entities::*;
use crate::sigint::aor::render_aor;
use crate::sigint::aor::types::AreaOfResponsibility;
use crate::types::*;
use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, JoinType, QueryFilter,
    QuerySelect, RelationTrait,
};
use std::collections::{BTreeMap, HashSet};

pub async fn collect_group_aors<'a, 'async_trait, C>(
    keys: Vec<String>,
    txn: &'a C,
) -> Result<BTreeMap<String, Vec<AreaOfResponsibility>>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut result = BTreeMap::new();
    let aors = area_of_responsibility::Entity::find()
        .find_with_related(signal_group_aor::Entity)
        .filter(signal_group_aor::Column::MasterKey.eq_any(keys.clone()))
        .all(txn)
        .await
        .c(h!())?;
    for (aor, signal_aors) in aors {
        for signal_aor in signal_aors.into_iter() {
            let aor = render_aor(aor.clone());
            result
                .entry(signal_aor.master_key)
                .or_insert_with(Vec::new)
                .push(aor);
        }
    }
    Ok(result)
}

pub fn aor_bounds_overlap(
    left_bound: f64,
    right_bound: f64,
    other_left_bound: f64,
    other_right_bound: f64,
) -> bool {
    !(left_bound > other_right_bound || right_bound < other_left_bound)
}

pub fn aor_bounds_within(
    left_bound: f64,
    right_bound: f64,
    container_left_bound: f64,
    container_right_bound: f64,
) -> bool {
    left_bound >= container_left_bound && right_bound <= container_right_bound
}

pub async fn expand_aor_ids_to_descendants<'a, 'async_trait, C>(
    dbx: &'a C,
    direct_aor_ids: &[i64],
) -> anyhow::Result<HashSet<i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    if direct_aor_ids.is_empty() {
        return Ok(HashSet::new());
    }
    let all_aors = area_of_responsibility::Entity::find()
        .filter(area_of_responsibility::Column::Deleted.eq(false))
        .all(dbx)
        .await
        .c(h!())?;
    let user_aor_bounds = all_aors
        .iter()
        .filter(|aor| direct_aor_ids.contains(&aor.id))
        .map(|aor| (aor.left_bound, aor.right_bound))
        .collect::<Vec<_>>();
    Ok(all_aors
        .into_iter()
        .filter(|candidate| {
            user_aor_bounds.iter().any(|(left_bound, right_bound)| {
                aor_bounds_within(
                    candidate.left_bound,
                    candidate.right_bound,
                    *left_bound,
                    *right_bound,
                )
            })
        })
        .map(|aor| aor.id)
        .collect())
}

pub async fn login_aor_ids_with_descendants<'a, 'async_trait, C>(
    dbx: &'a C,
    login_id: &uuid::Uuid,
) -> anyhow::Result<HashSet<i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let direct_aor_ids = organism_aor::Entity::find()
        .join(JoinType::InnerJoin, organism_aor::Relation::Organism.def())
        .join(JoinType::InnerJoin, organism::Relation::Login.def())
        .filter(login::Column::Id.eq(*login_id))
        .select_only()
        .column(organism_aor::Column::AorId)
        .into_tuple::<i64>()
        .all(dbx)
        .await
        .c(h!())?;
    expand_aor_ids_to_descendants(dbx, &direct_aor_ids).await
}

#[cfg(test)]
mod tests {
    use super::{aor_bounds_overlap, aor_bounds_within};

    #[test]
    fn aor_overlap_detects_intersection() {
        assert!(aor_bounds_overlap(10.0, 20.0, 15.0, 25.0));
        assert!(aor_bounds_overlap(10.0, 20.0, 20.0, 30.0));
        assert!(!aor_bounds_overlap(10.0, 20.0, 21.0, 30.0));
    }

    #[test]
    fn aor_within_detects_descendant_interval() {
        assert!(aor_bounds_within(12.0, 18.0, 10.0, 20.0));
        assert!(aor_bounds_within(10.0, 20.0, 10.0, 20.0));
        assert!(!aor_bounds_within(5.0, 18.0, 10.0, 20.0));
        assert!(!aor_bounds_within(12.0, 22.0, 10.0, 20.0));
    }
}
