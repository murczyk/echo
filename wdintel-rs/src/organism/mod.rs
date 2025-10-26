use self::types::*;
use crate::entities::*;
use crate::error::AppError;
use crate::organism::bl::*;
use crate::types::*;
use actix_web::post;
use actix_web::web::Json;
use sea_orm::sea_query::Expr;
use sea_orm::*;
use std::collections::{HashMap, HashSet};

pub mod bl;
pub mod oneoff;
pub mod types;

#[post("/api/organism/add-group")]
pub async fn add_group_to_organism(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AddGroupToOrganismReq>,
) -> Result<Json<()>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Admin")
        .await
        .c(h!())?;
    debug!(
        "Adding group {} to organism {}",
        req.group_name, req.organism_id
    );

    let organism = organism::Entity::find_by_id(req.organism_id)
        .filter(organism::Column::DeletedPermanently.eq(false))
        .one(&env.dbx)
        .await
        .c(h!())?
        .c(h!())?;

    let group = signal_group::Entity::find()
        .filter(signal_group::Column::Deleted.eq(false))
        .filter(signal_group::Column::MasterKey.eq(&req.group_name))
        .one(&env.dbx)
        .await
        .c(h!())?
        .c(h!())?;

    // // checking if adding is allowed here
    // let organism_groups =
    //     crate::organism::load_organism_group_ids(&env.dbx, organism.id)
    //         .await
    //         .c(h!())?;
    // if organism.parent_id.is_some()
    //     && !organism_groups.available_keys.contains(&group.master_key)
    // {
    //     return Err(AppError::from(
    //         anyhow!(
    //             "Not adding group {} to organism {} because it is not available due to its parent chain rights",
    //             req.group_name, req.organism_id
    //         )
    //             .c(h!()))
    //     );
    // }

    organism_group::ActiveModel {
        organism_id: Set(organism.id),
        signal_group_master_key: Set(group.master_key.clone()),
    }
    .insert(&env.dbx)
    .await
    .c(h!())?;

    Ok(Json(()))
}

#[post("/api/organism/remove-group")]
pub async fn remove_group_from_organism(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<RemoveGroupFromOrganismReq>,
) -> Result<Json<()>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Admin")
        .await
        .c(h!())?;

    let (organism, children) =
        load_organism_with_children(req.organism_id, &env.dbx)
            .await
            .c(h!())?;
    let mut organism_ids = children.iter().map(|x| x.id).collect::<Vec<_>>();
    organism_ids.push(organism.id);

    organism_group::Entity::delete_many()
        .filter(organism_group::Column::OrganismId.is_in(organism_ids))
        .filter(
            organism_group::Column::SignalGroupMasterKey
                .eq(req.group_name.clone()),
        )
        .exec(&env.dbx)
        .await
        .c(h!())?;

    Ok(Json(()))
}

#[post("/api/organism/delete")]
pub async fn delete_organism(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<i64>,
) -> Result<Json<()>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Admin")
        .await
        .c(h!())?;

    if let Some(model) = organism::Entity::find_by_id(req.0)
        .one(&env.dbx)
        .await
        .c(h!())?
    {
        let mut rec = model.into_active_model();
        rec.deleted_permanently = Set(true);
        rec.update(&env.dbx).await.c(h!())?;
    }

    Ok(Json(()))
}

#[post("/api/organism/update")]
pub async fn update_organism(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<UpdateOrganismReq>,
) -> Result<Json<Organism>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Admin")
        .await
        .c(h!())?;

    let txn = env.dbx.begin().await.c(h!())?;
    let organism = bl::update_organism(&txn, &req).await.c(h!())?;
    txn.commit().await.c(h!())?;
    let login_counts =
        fetch_login_counts(&env.dbx, &[organism.id]).await.c(h!())?;

    Ok(Json(Organism {
        id: organism.id,
        parent_id: organism.parent_id,
        name: organism.name,
        created_at: organism.created_at.and_utc().timestamp_millis(),
        roles: serde_json::from_value(organism.roles).unwrap_or_default(),
        enabled: req.enabled,
        aor_ids: req.aor_ids.clone().unwrap_or_default(),
        logins_count: login_counts
            .get(&organism.id)
            .copied()
            .unwrap_or_default(),
    }))
}

#[post("/api/organism/all-groups")]
pub async fn group_list(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<Vec<SignalGroupFull>>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Admin")
        .await
        .c(h!())?;

    Ok(Json(
        signal_group::Entity::find()
            .filter(signal_group::Column::Deleted.eq(false))
            .all(&env.dbx)
            .await
            .c(h!())?
            .into_iter()
            .map(|g| SignalGroupFull {
                master_key: g.master_key,
                name: g.name.unwrap_or("".to_string()),
                origin_datasource_id: g.datasource_id.unwrap_or(0),
            })
            .collect(),
    ))
}

#[post("/api/organism/group-list")]
pub async fn organism_group_list(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<Vec<OrganismGroup>>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Admin")
        .await
        .c(h!())?;

    Ok(Json(
        organism_group::Entity::find()
            .all(&env.dbx)
            .await
            .c(h!())?
            .into_iter()
            .map(|g| OrganismGroup {
                master_key: g.signal_group_master_key,
                organism_id: g.organism_id,
            })
            .collect(),
    ))
}

// this method returns actual list of all groups that are available for users from it
#[post("/api/organism/available-groups")]
pub async fn organism_available_groups(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<i64>,
) -> Result<Json<Vec<SignalGroupFull>>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Admin")
        .await
        .c(h!())?;
    let groups = load_organism_group_ids(&env.dbx, req.into_inner())
        .await
        .c(h!())?;

    let groups_list = signal_group::Entity::find()
        .filter(signal_group::Column::Deleted.eq(false))
        .filter(signal_group::Column::MasterKey.is_in(groups.available_keys))
        .all(&env.dbx)
        .await
        .c(h!())?;
    Ok(Json(
        groups_list
            .into_iter()
            .map(|g| SignalGroupFull {
                master_key: g.master_key,
                name: g.name.unwrap_or("".to_string()),
                origin_datasource_id: g.datasource_id.unwrap_or(0),
            })
            .collect(),
    ))
}

// this method returns actual list of all groups that are available for users after update
#[post("/api/organism/compute-available-groups")]
pub async fn organism_compute_available_groups(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<UpdateOrganismReq>,
) -> Result<Json<Vec<SignalGroupFull>>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Admin")
        .await
        .c(h!())?;

    let txn = env.dbx.begin().await.c(h!())?; // DO NOT COMMIT IT!!!
    let organism = bl::update_organism(&txn, &req).await.c(h!())?;

    let groups = load_organism_group_ids(&txn, organism.id).await.c(h!())?;

    let groups_list = signal_group::Entity::find()
        .filter(signal_group::Column::Deleted.eq(false))
        .filter(signal_group::Column::MasterKey.is_in(groups.available_keys))
        .all(&txn)
        .await
        .c(h!())?;
    Ok(Json(
        groups_list
            .into_iter()
            .map(|g| SignalGroupFull {
                master_key: g.master_key,
                name: g.name.unwrap_or("".to_string()),
                origin_datasource_id: g.datasource_id.unwrap_or(0),
            })
            .collect(),
    ))
}

// this method returns actual list of all groups that are available for users after create
#[post("/api/organism/compute-available-groups-for-new")]
pub async fn organism_compute_available_groups_for_new(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<CreateOrganismReq>,
) -> Result<Json<Vec<SignalGroupFull>>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Admin")
        .await
        .c(h!())?;

    let txn = env.dbx.begin().await.c(h!())?; // DO NOT COMMIT IT!!!
    let organism = bl::create_organism(&env.dbx, &req).await.c(h!())?;

    let groups = load_organism_group_ids(&txn, organism.id).await.c(h!())?;

    let groups_list = signal_group::Entity::find()
        .filter(signal_group::Column::Deleted.eq(false))
        .filter(signal_group::Column::MasterKey.is_in(groups.available_keys))
        .all(&txn)
        .await
        .c(h!())?;
    Ok(Json(
        groups_list
            .into_iter()
            .map(|g| SignalGroupFull {
                master_key: g.master_key,
                name: g.name.unwrap_or("".to_string()),
                origin_datasource_id: g.datasource_id.unwrap_or(0),
            })
            .collect(),
    ))
}

#[post("/api/organism/available-groups-batch")]
pub async fn organism_available_groups_batch(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<Vec<i64>>,
) -> Result<Json<HashMap<i64, Vec<SignalGroupFull>>>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Admin")
        .await
        .c(h!())?;
    let mut keys_map = HashMap::new();
    let mut keys_list = HashSet::new();
    for organism_id in req.into_inner() {
        let groups = load_organism_group_ids(&env.dbx, organism_id)
            .await
            .c(h!())?;
        keys_map.insert(organism_id, groups.available_keys.clone());
        for key in groups.available_keys {
            keys_list.insert(key);
        }
    }
    let keys_list = keys_list.into_iter().collect_vec();

    let groups_dictionary = signal_group::Entity::find()
        .filter(signal_group::Column::Deleted.eq(false))
        .filter(signal_group::Column::MasterKey.is_in(keys_list))
        .all(&env.dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|g| {
            (
                g.master_key.clone(),
                SignalGroupFull {
                    master_key: g.master_key,
                    name: g.name.unwrap_or("".to_string()),
                    origin_datasource_id: g.datasource_id.unwrap_or(0),
                },
            )
        })
        .collect::<HashMap<_, _>>();
    let result = keys_map
        .into_iter()
        .map(|(organism_id, groups)| {
            let groups = groups
                .into_iter()
                .flat_map(|id| groups_dictionary.get(&id).cloned())
                .collect();
            (organism_id, groups)
        })
        .collect();
    Ok(Json(result))
}

#[post("/api/organism/create")]
pub async fn create_organism(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<CreateOrganismReq>,
) -> Result<Json<Organism>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Admin")
        .await
        .c(h!())?;

    let organism = bl::create_organism(&env.dbx, &req).await.c(h!())?;

    Ok(Json(Organism {
        id: organism.id,
        parent_id: organism.parent_id,
        name: organism.name,
        created_at: organism.created_at.and_utc().timestamp_millis(),
        roles: serde_json::from_value(organism.roles).unwrap_or_default(),
        enabled: organism.enabled,
        aor_ids: req.aor_ids.clone().unwrap_or_default(),
        logins_count: 0,
    }))
}

#[post("/api/organisms")]
pub async fn list_organisms(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ListOrganismsReq>,
) -> Result<Json<Vec<Organism>>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Admin")
        .await
        .c(h!())?;
    let default_sorting = req.sort_by.is_none();

    let (sort_by, order) = match req.sort_by {
        Some(ListOrganismsSortBy::OrganismCreatedAtDesc) => {
            (organism::Column::CreatedAt, Order::Desc)
        }
        Some(ListOrganismsSortBy::OrganismCreatedAtAsc) => {
            (organism::Column::CreatedAt, Order::Asc)
        }
        Some(ListOrganismsSortBy::OrganismNameAsc) => {
            (organism::Column::Name, Order::Asc)
        }
        Some(ListOrganismsSortBy::OrganismNameDesc) => {
            (organism::Column::Name, Order::Desc)
        }
        None => (organism::Column::CreatedAt, Order::Desc),
    };

    let organisms = organism::Entity::find()
        .find_with_related(organism_aor::Entity)
        .filter(organism::Column::DeletedPermanently.eq(false))
        .order_by(sort_by, order)
        .all(&env.dbx)
        .await
        .c(h!())?;

    let organism_ids: Vec<i64> = organisms.iter().map(|(o, _)| o.id).collect();
    let login_counts =
        fetch_login_counts(&env.dbx, &organism_ids).await.c(h!())?;

    let mut list = vec![];
    for (o, aors) in organisms {
        let aor_ids = aors.into_iter().map(|a| a.aor_id).collect::<Vec<_>>();
        let org = Organism {
            aor_ids,
            id: o.id,
            parent_id: o.parent_id,
            name: o.name,
            enabled: o.enabled,
            created_at: o.created_at.and_utc().timestamp_millis(),
            roles: serde_json::from_value(o.roles).unwrap_or_default(),
            logins_count: login_counts.get(&o.id).copied().unwrap_or_default(),
        };
        list.push(org);
    }

    if default_sorting {
        list.sort_by_key(|e| e.parent_id.unwrap_or(-1)); // first goes root elements, then the others
    }
    Ok(Json(list))
}

async fn fetch_login_counts(
    db: &DatabaseConnection,
    organism_ids: &[i64],
) -> Result<HashMap<i64, i64>, AppError> {
    if organism_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let ids = organism_ids.to_vec();

    let rows: Vec<(Option<i64>, i64)> = login::Entity::find()
        .select_only()
        .column(login::Column::OrganismId)
        .column_as(Expr::col(login::Column::Login).count(), "count")
        .filter(login::Column::Deleted.eq(false))
        .filter(login::Column::DeletedPermanently.eq(false))
        .filter(login::Column::OrganismId.is_in(ids))
        .group_by(login::Column::OrganismId)
        .into_tuple()
        .all(db)
        .await
        .c(h!())?;

    let mut counts = HashMap::new();
    for (organism_id, count) in rows {
        if let Some(id) = organism_id {
            counts.insert(id, count);
        }
    }

    Ok(counts)
}
