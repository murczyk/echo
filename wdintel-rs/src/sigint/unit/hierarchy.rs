use super::types::{
    UnitHierarchyGroup, UnitHierarchyReq, UnitHierarchyRsp, UnitHierarchyUnit,
};
use crate::config::{
    ROLE_CYBER_VIEWER_RESTRICTED, SIGINT_UNIT_TREE_ADVISORY_LOCK_KEY,
    SIGINT_UNIT_TREE_DIRTY_REDIS_KEY, SIGINT_UNIT_TREE_REDIS_KEY,
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
use std::collections::HashMap;

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
    Ok(Json(
        (req.known_revision.as_deref() != Some(tree.revision.as_str()))
            .then_some(tree),
    ))
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
    mark_dirty_for_mode(mode).await.c(h!())?;
    result
}

async fn read_cached(
    redis: &mut impl ConnectionLike,
) -> anyhow::Result<Option<UnitHierarchyRsp>> {
    let (dirty, tree): (Option<bool>, Option<String>) = redis::cmd("MGET")
        .arg(&[SIGINT_UNIT_TREE_DIRTY_REDIS_KEY, SIGINT_UNIT_TREE_REDIS_KEY])
        .query_async(redis)
        .await
        .c(h!())?;
    if dirty.unwrap_or(false) {
        return Ok(None);
    }
    tree.map(|tree| serde_json::from_str(&tree).c(h!()))
        .transpose()
}

pub(crate) async fn load(env: &Env) -> anyhow::Result<UnitHierarchyRsp> {
    if let Some(tree) = read_cached(&mut env.redis.clone()).await.c(h!())? {
        return Ok(tree);
    }
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
        return Ok(tree);
    }
    redis::cmd("WATCH")
        .arg(&[SIGINT_UNIT_TREE_REDIS_KEY, SIGINT_UNIT_TREE_DIRTY_REDIS_KEY])
        .query_async::<()>(&mut redis)
        .await
        .c(h!())?;
    let tree = build(load_sources(&transaction).await.c(h!())?);
    publish(&mut redis, &tree).await.c(h!())?;
    transaction.commit().await.c(h!())?;
    Ok(tree)
}

async fn publish(
    redis: &mut impl ConnectionLike,
    tree: &UnitHierarchyRsp,
) -> anyhow::Result<Option<()>> {
    let serialized = serde_json::to_string(tree).c(h!())?;
    redis::pipe()
        .atomic()
        .set(SIGINT_UNIT_TREE_REDIS_KEY, serialized)
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

fn build(units: Vec<HierarchySource>) -> UnitHierarchyRsp {
    let mut tree = UnitHierarchyRsp {
        revision: uuid::Uuid::new_v4().to_string(),
        groups: Vec::new(),
        units: Vec::with_capacity(units.len()),
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
    tree
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
