use super::types::{
    UnitHierarchyGroup, UnitHierarchyReq, UnitHierarchyRsp,
    UnitHierarchySelection, UnitHierarchyUnit,
};
use crate::config::{
    ROLE_CYBER_VIEWER_RESTRICTED, SIGINT_UNIT_TREE_ADVISORY_LOCK_KEY,
    SIGINT_UNIT_TREE_DIRTY_REDIS_KEY, SIGINT_UNIT_TREE_RECONCILE_SECS,
    SIGINT_UNIT_TREE_REDIS_KEY,
};
use crate::entities::sigint_unit;
use crate::error::AppError;
use crate::h;
use crate::types::{Env, Mode, ShortContext};
use crate::users::{has_any_role, login_id_from_identity};
use actix_identity::Identity;
use actix_web::{
    post,
    web::{Data, Json},
};
use redis::aio::ConnectionLike;
use sea_orm::{
    ColumnTrait, ConnectionTrait, DbBackend, EntityTrait, FromQueryResult,
    QueryFilter, QueryOrder, QuerySelect, Statement, TransactionTrait,
};
use std::collections::{BTreeSet, HashMap};

#[cfg(test)]
mod tests;

#[derive(FromQueryResult)]
struct HierarchySource {
    id: i64,
    name: String,
    army_region: String,
    military_district: String,
    army: String,
    corps: String,
    division: String,
    brigade: String,
    regiment: String,
    battalion: String,
    company: String,
    platoon: String,
    squad: String,
    section: String,
    team_or_crew: String,
    other: String,
}

#[post("/api/sigint/units/hierarchy")]
pub async fn unit_hierarchy(
    user: Identity,
    env: Data<Env>,
    req: Json<UnitHierarchyReq>,
) -> Result<Json<Option<UnitHierarchyRsp>>, AppError> {
    let login = login_id_from_identity(&user).c(h!())?;
    has_any_role(
        &env.dbx,
        &login,
        vec!["Rer", ROLE_CYBER_VIEWER_RESTRICTED, "Api"],
    )
    .await
    .c(h!())?;
    let tree = load(&env).await.c(h!())?;
    let tree = scope_tree(tree, &req).c(h!())?;
    Ok(Json(
        (req.known_revision.as_deref() != Some(tree.revision.as_str()))
            .then_some(tree),
    ))
}

fn scope_tree(
    mut tree: UnitHierarchyRsp,
    req: &UnitHierarchyReq,
) -> anyhow::Result<UnitHierarchyRsp> {
    let Some(unit_ids) = &req.unit_ids else {
        return Ok(tree);
    };
    let mut included_units = unit_ids.iter().copied().collect::<BTreeSet<_>>();
    let mut selections = req.selection_values.clone().unwrap_or_default();
    selections.sort();
    selections.dedup();
    for value in selections {
        if let Some(selection) = resolve_selection(&tree, &value) {
            included_units.extend(&selection.exact_unit_ids);
            if let Some(id) = selection.unit_ids.first() {
                included_units.insert(*id);
            }
            tree.selections.push(selection);
        }
    }
    tree.units.retain(|unit| included_units.contains(&unit.id));
    retain_ancestor_paths(&mut tree);
    tree.revision.clear();
    tree.revision = sha256::digest(serde_json::to_vec(&tree).c(h!())?);
    Ok(tree)
}

fn retain_ancestor_paths(tree: &mut UnitHierarchyRsp) {
    let mut included_groups = BTreeSet::new();
    for unit in &tree.units {
        let mut index = unit.group_index;
        while let Some(current) = index {
            if !included_groups.insert(current) {
                break;
            }
            index = tree.groups[current as usize].parent_index;
        }
    }
    let indices = included_groups
        .iter()
        .enumerate()
        .map(|(next, previous)| (*previous, next as u32))
        .collect::<HashMap<_, _>>();
    tree.groups = included_groups
        .into_iter()
        .map(|index| {
            let mut group = tree.groups[index as usize].clone();
            group.parent_index =
                group.parent_index.map(|index| indices[&index]);
            group
        })
        .collect();
    for unit in &mut tree.units {
        unit.group_index = unit.group_index.map(|index| indices[&index]);
    }
}

fn resolve_selection(
    tree: &UnitHierarchyRsp,
    value: &str,
) -> Option<UnitHierarchySelection> {
    let parent = value.strip_prefix("unit-parent:");
    let id = value
        .strip_prefix("unit-id:")
        .and_then(|id| id.parse::<i64>().ok());
    let mut groups = BTreeSet::new();
    let mut exact_unit_ids = BTreeSet::new();
    let mut label = value.to_string();
    if let Some(parent) = parent {
        if let Some((index, group)) = tree
            .groups
            .iter()
            .enumerate()
            .find(|(_, group)| group.id == parent)
        {
            groups.insert(index as u32);
            label = group.label.clone();
            exact_unit_ids.extend(
                tree.units
                    .iter()
                    .filter(|unit| unit.group_index == Some(index as u32))
                    .map(|unit| unit.id),
            );
        }
    } else {
        for unit in tree.units.iter().filter(|unit| {
            id == Some(unit.id) || (id.is_none() && unit.name.trim() == value)
        }) {
            exact_unit_ids.insert(unit.id);
            label = unit.name.clone();
            if let Some(index) = unit.group_index {
                groups.insert(index);
            }
        }
        if exact_unit_ids.is_empty() {
            return None;
        }
    }
    let unit_ids = descendant_unit_ids(tree, groups, &exact_unit_ids);
    Some(UnitHierarchySelection {
        value: value.to_string(),
        label,
        unit_ids,
        exact_unit_ids: exact_unit_ids.into_iter().collect(),
    })
}

fn descendant_unit_ids(
    tree: &UnitHierarchyRsp,
    groups: BTreeSet<u32>,
    exact_unit_ids: &BTreeSet<i64>,
) -> Vec<i64> {
    let mut descendants = groups;
    for (index, group) in tree.groups.iter().enumerate() {
        if group
            .parent_index
            .is_some_and(|parent| descendants.contains(&parent))
        {
            descendants.insert(index as u32);
        }
    }
    tree.units
        .iter()
        .filter(|unit| {
            exact_unit_ids.contains(&unit.id)
                || unit
                    .group_index
                    .is_some_and(|index| descendants.contains(&index))
        })
        .map(|unit| unit.id)
        .collect()
}

pub(crate) async fn mark_dirty(
    redis: &mut impl ConnectionLike,
) -> anyhow::Result<()> {
    redis::cmd("SET")
        .arg(SIGINT_UNIT_TREE_DIRTY_REDIS_KEY)
        .arg(true)
        .query_async::<()>(redis)
        .await
        .c(h!())
}

pub(crate) async fn mark_dirty_for_mode(mode: Mode) -> anyhow::Result<()> {
    let config = crate::config::read_config(mode).c(h!())?;
    let mut redis = crate::new_redis(&config).await.c(h!())?;
    mark_dirty(&mut redis).await.c(h!())
}

pub(crate) async fn invalidate_after<T>(
    mode: Mode,
    operation: impl std::future::Future<Output = Result<T, AppError>>,
) -> Result<T, AppError> {
    let result = operation.await;
    let invalidation = mark_dirty_for_mode(mode).await.c(h!());
    match result {
        Ok(value) => {
            invalidation.c(h!())?;
            Ok(value)
        }
        Err(error) => {
            if let Err(invalidation) = invalidation {
                log::error!(
                    "unit hierarchy invalidation also failed: {invalidation:#}"
                );
            }
            Err(error).c(h!()).map_err(AppError::from)
        }
    }
}

async fn read_cached(
    redis: &mut impl ConnectionLike,
) -> anyhow::Result<Option<UnitHierarchyRsp>> {
    let (dirty, tree, ttl): (Option<bool>, Option<String>, i64) = redis::pipe()
        .atomic()
        .get(SIGINT_UNIT_TREE_DIRTY_REDIS_KEY)
        .get(SIGINT_UNIT_TREE_REDIS_KEY)
        .ttl(SIGINT_UNIT_TREE_REDIS_KEY)
        .query_async(redis)
        .await
        .c(h!())?;
    if dirty.unwrap_or(false) || ttl < 0 {
        return Ok(None);
    }
    let Some(tree) = tree else {
        return Ok(None);
    };
    match serde_json::from_str(&tree) {
        Ok(tree) => Ok(Some(tree)),
        Err(error) => {
            log::warn!("rebuilding invalid unit hierarchy cache: {error}");
            Ok(None)
        }
    }
}

pub(crate) async fn load(env: &Env) -> anyhow::Result<UnitHierarchyRsp> {
    loop {
        if let Some(tree) = read_cached(&mut env.redis.clone()).await.c(h!())? {
            return Ok(tree);
        }
        if let Some(tree) = rebuild(env).await.c(h!())? {
            return Ok(tree);
        }
    }
}

async fn rebuild(env: &Env) -> anyhow::Result<Option<UnitHierarchyRsp>> {
    let transaction = env.dbx.begin().await.c(h!())?;
    transaction
        .execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "select pg_advisory_xact_lock($1)",
            [SIGINT_UNIT_TREE_ADVISORY_LOCK_KEY.into()],
        ))
        .await
        .c(h!())?;
    let mut redis = env
        .redisb
        .get_multiplexed_async_connection()
        .await
        .c(h!())?;
    if let Some(tree) = read_cached(&mut redis).await.c(h!())? {
        transaction.commit().await.c(h!())?;
        return Ok(Some(tree));
    }
    redis::cmd("WATCH")
        .arg(&[SIGINT_UNIT_TREE_REDIS_KEY, SIGINT_UNIT_TREE_DIRTY_REDIS_KEY])
        .query_async::<()>(&mut redis)
        .await
        .c(h!())?;
    let tree = build(load_sources(&transaction).await.c(h!())?).c(h!())?;
    let published = publish(&mut redis, &tree).await.c(h!())?;
    transaction.commit().await.c(h!())?;
    Ok(published.map(|()| tree))
}

async fn publish(
    redis: &mut impl ConnectionLike,
    tree: &UnitHierarchyRsp,
) -> anyhow::Result<Option<()>> {
    let serialized = serde_json::to_string(tree).c(h!())?;
    redis::pipe()
        .atomic()
        .set_ex(
            SIGINT_UNIT_TREE_REDIS_KEY,
            serialized,
            SIGINT_UNIT_TREE_RECONCILE_SECS,
        )
        .ignore()
        .set(SIGINT_UNIT_TREE_DIRTY_REDIS_KEY, false)
        .ignore()
        .query_async(redis)
        .await
        .c(h!())
}

async fn load_sources(
    db: &impl ConnectionTrait,
) -> anyhow::Result<Vec<HierarchySource>> {
    use sigint_unit::Column::*;
    sigint_unit::Entity::find()
        .select_only()
        .columns([
            Id,
            Name,
            ArmyRegion,
            MilitaryDistrict,
            Army,
            Corps,
            Division,
            Brigade,
            Regiment,
            Battalion,
            Company,
            Platoon,
            Squad,
            Section,
            TeamOrCrew,
            Other,
        ])
        .filter(Deleted.eq(false))
        .order_by_asc(Id)
        .into_model::<HierarchySource>()
        .all(db)
        .await
        .c(h!())
}

fn build(units: Vec<HierarchySource>) -> anyhow::Result<UnitHierarchyRsp> {
    let mut tree = UnitHierarchyRsp {
        revision: String::new(),
        groups: Vec::new(),
        units: Vec::with_capacity(units.len()),
        selections: Vec::new(),
    };
    let mut groups = HashMap::new();
    for unit in units {
        let parts = [
            &unit.army_region,
            &unit.military_district,
            &unit.army,
            &unit.corps,
            &unit.division,
            &unit.brigade,
            &unit.regiment,
            &unit.battalion,
            &unit.company,
            &unit.platoon,
            &unit.squad,
            &unit.section,
            &unit.team_or_crew,
            &unit.other,
        ];
        let group_index = append_groups(&parts, &mut tree.groups, &mut groups);
        tree.units.push(UnitHierarchyUnit {
            id: unit.id,
            name: unit.name,
            group_index,
        });
    }
    tree.revision = sha256::digest(serde_json::to_vec(&tree).c(h!())?);
    Ok(tree)
}

fn append_groups(
    parts: &[&String; 14],
    nodes: &mut Vec<UnitHierarchyGroup>,
    groups: &mut HashMap<String, u32>,
) -> Option<u32> {
    let first = if !parts[0].trim().is_empty() {
        0
    } else if !parts[1].trim().is_empty() {
        1
    } else {
        2
    };
    let last = parts.iter().rposition(|part| !part.trim().is_empty())?;
    let mut path = String::from("group:");
    let mut parent_index = None;
    for (level, part) in parts.iter().enumerate().take(last + 1).skip(first) {
        if level > first {
            path.push('|');
        }
        let label = part.trim();
        let encoded = match label {
            "" => "__EMPTY__".to_string(),
            "__EMPTY__" => "%5F%5FEMPTY%5F%5F".to_string(),
            _ => label.replace('%', "%25").replace('|', "%7C"),
        };
        path.push_str(&format!("{level}:{encoded}"));
        if label.is_empty() {
            continue;
        }
        let index = *groups.entry(path.clone()).or_insert_with(|| {
            let index = nodes.len() as u32;
            nodes.push(UnitHierarchyGroup {
                id: path.clone(),
                label: label.to_string(),
                level: level as u32,
                parent_index,
            });
            index
        });
        parent_index = Some(index);
    }
    parent_index
}
