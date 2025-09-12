use self::types::*;
use crate::entities::*;
use crate::error::AppError;
use crate::organism::bl::*;
use crate::types::*;
use actix_web::post;
use actix_web::web::Json;
use sea_orm::*;

pub mod bl;
pub mod oneoff;
pub mod types;

#[post("/api/organism/add-group")]
pub async fn add_group_to_organism(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AddGroupToOrganismReq>,
) -> Result<Json<()>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Admin").await?;
    debug!(
        "Adding group {} to organism {}",
        req.group_name, req.organism_id
    );

    let organism = organism::Entity::find_by_id(req.organism_id)
        .filter(organism::Column::DeletedPermanently.eq(false))
        .one(&env.dbx)
        .await
        .context(h!())?
        .context(h!())?;

    let group = signal_group::Entity::find()
        .filter(signal_group::Column::Deleted.eq(false))
        .filter(signal_group::Column::MasterKey.eq(&req.group_name))
        .one(&env.dbx)
        .await
        .context(h!())?
        .context(h!())?;

    // // checking if adding is allowed here
    // let organism_groups =
    //     crate::organism::load_organism_group_ids(&env.dbx, organism.id)
    //         .await
    //         .context(h!())?;
    // if organism.parent_id.is_some()
    //     && !organism_groups.available_keys.contains(&group.master_key)
    // {
    //     return Err(AppError::from(
    //         anyhow!(
    //             "Not adding group {} to organism {} because it is not available due to its parent chain rights",
    //             req.group_name, req.organism_id
    //         )
    //             .context(h!()))
    //     );
    // }

    organism_group::ActiveModel {
        organism_id: Set(organism.id),
        signal_group_master_key: Set(group.master_key.clone()),
    }
    .insert(&env.dbx)
    .await
    .context(h!())?;

    Ok(Json(()))
}

#[post("/api/organism/remove-group")]
pub async fn remove_group_from_organism(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<RemoveGroupFromOrganismReq>,
) -> Result<Json<()>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Admin").await?;

    let (organism, children) =
        load_organism_with_children(req.organism_id, &env.dbx)
            .await
            .context(h!())?;
    let mut organism_ids = children.iter().map(|x| x.id).collect::<Vec<_>>();
    organism_ids.push(organism.id);

    organism_group::Entity::delete_many()
        .filter(organism_group::Column::OrganismId.is_in(organism_ids))
        .filter(
            organism_group::Column::SignalGroupMasterKey
                .eq(req.group_name.clone()),
        )
        .exec(&env.dbx)
        .await?;

    Ok(Json(()))
}

#[post("/api/organism/delete")]
pub async fn delete_organism(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<i64>,
) -> Result<Json<()>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Admin").await?;

    if let Some(model) = organism::Entity::find_by_id(req.0)
        .one(&env.dbx)
        .await
        .context(h!())?
    {
        let mut rec = model.into_active_model();
        rec.deleted_permanently = Set(true);
        rec.update(&env.dbx).await.context(h!())?;
    }

    Ok(Json(()))
}

#[post("/api/organism/update")]
pub async fn update_organism(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<UpdateOrganismReq>,
) -> Result<Json<Organism>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Admin").await?;

    let organism = bl::update_organism(&env.dbx, &req).await.context(h!())?;

    Ok(Json(Organism {
        id: organism.id,
        parent_id: organism.parent_id,
        name: organism.name,
        created_at: organism.created_at.and_utc().timestamp_millis(),
        roles: serde_json::from_value(organism.roles).unwrap_or_default(),
        enabled: req.enabled,
        aor_ids: req.aor_ids.clone().unwrap_or_default(),
    }))
}

#[post("/api/organism/all-groups")]
pub async fn group_list(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<Vec<SignalGroupFull>>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Admin").await?;

    Ok(Json(
        signal_group::Entity::find()
            .filter(signal_group::Column::Deleted.eq(false))
            .all(&env.dbx)
            .await?
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
    crate::users::has_role(&env.dbx, &user.id()?, "Admin").await?;

    Ok(Json(
        organism_group::Entity::find()
            .all(&env.dbx)
            .await?
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
    crate::users::has_role(&env.dbx, &user.id()?, "Admin").await?;
    let groups = load_organism_group_ids(&env.dbx, req.into_inner())
        .await
        .context(h!())?;

    let groups_list = signal_group::Entity::find()
        .filter(signal_group::Column::Deleted.eq(false))
        .filter(signal_group::Column::MasterKey.is_in(groups.available_keys))
        .all(&env.dbx)
        .await
        .context(h!())?;
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

#[post("/api/organism/create")]
pub async fn create_organism(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<CreateOrganismReq>,
) -> Result<Json<Organism>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Admin").await?;

    let organism = bl::create_organism(&env.dbx, &req).await.context(h!())?;

    Ok(Json(Organism {
        id: organism.id,
        parent_id: organism.parent_id,
        name: organism.name,
        created_at: organism.created_at.and_utc().timestamp_millis(),
        roles: serde_json::from_value(organism.roles).unwrap_or_default(),
        enabled: organism.enabled,
        aor_ids: req.aor_ids.clone().unwrap_or_default(),
    }))
}

#[post("/api/organisms")]
pub async fn list_organisms(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ListOrganismsReq>,
) -> Result<Json<Vec<Organism>>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Admin").await?;
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
        .context(h!())?;

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
        };
        list.push(org);
    }

    if default_sorting {
        list.sort_by_key(|e| e.parent_id.unwrap_or(-1)); // first goes root elements, then the others
    }
    Ok(Json(list))
}
