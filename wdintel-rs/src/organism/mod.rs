use self::types::*;
use crate::entities::*;
use crate::error::AppError;
use crate::organism::bl::{
    load_organism_group_ids, load_organism_with_children,
};
use crate::types::*;
use actix_web::post;
use actix_web::web::Json;
use sea_orm::*;

pub mod bl;
pub mod types;

#[post("/api/organism/add-group")]
pub async fn add_group_to_organism(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AddGroupToOrganismReq>,
) -> Result<Json<()>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Admin").await?;

    let organism = organism::Entity::find_by_id(req.organism_id)
        .one(&env.dbx)
        .await?
        .ok_or(AppError::NotFound)?;

    let parent_filter = if let Some(parent_id) = organism.parent_id {
        load_organism_group_ids(&env.dbx, parent_id)
            .await
            .context(h!())
            .ok()
    } else {
        None
    };

    let group = signal_group::Entity::find()
        .filter(signal_group::Column::MasterKey.eq(&req.group_name))
        .one(&env.dbx)
        .await?
        .ok_or(AppError::NotFound)?;

    let skip_adding = if let Some(parent_filter) = parent_filter {
        !parent_filter.contains(&group.master_key)
    } else {
        false
    };

    if !skip_adding {
        organism_group::ActiveModel {
            organism_id: Set(organism.id),
            signal_group_master_key: Set(group.master_key.clone()),
        }
        .insert(&env.dbx)
        .await?;
    } else {
        return Err(AppError::BL {
            msg: "won't add, absent in parent".to_string(),
        });
    }

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

    organism::Entity::delete_by_id(req.0).exec(&env.dbx).await?;

    Ok(Json(()))
}

#[post("/api/organism/update")]
pub async fn update_organism(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<UpdateOrganismReq>,
) -> Result<Json<Organism>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Admin").await?;

    let parent_id = match req.parent_id.clone() {
        None => None,
        Some(parent_id) => {
            let has_organism = organism::Entity::find_by_id(parent_id)
                .count(&env.dbx)
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
        .filter(organism::Column::Id.eq(req.id))
        .one(&env.dbx)
        .await?
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

    let organism = organism.update(&env.dbx).await?;

    Ok(Json(Organism {
        id: organism.id,
        parent_id: organism.parent_id,
        name: organism.name,
        created_at: organism.created_at.and_utc().timestamp_millis(),
        roles: serde_json::from_value(organism.roles).unwrap_or(vec![]),
        group_auto_link: req.group_auto_link.unwrap_or(false),
        groups: vec![],
        enabled: req.enabled,
    }))
}

#[post("/api/organism/group-list")]
pub async fn organism_group_list(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<Vec<SignalGroupFull>>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Admin").await?;

    Ok(Json(
        signal_group::Entity::find()
            .all(&env.dbx)
            .await?
            .into_iter()
            .map(|g| SignalGroupFull {
                master_key: g.master_key,
                name: g.name.unwrap_or("".to_string()),
                datasource_id: g.datasource_id.unwrap_or(0),
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
        .filter(signal_group::Column::MasterKey.is_in(groups))
        .all(&env.dbx)
        .await
        .context(h!())?;
    Ok(Json(
        groups_list
            .into_iter()
            .map(|g| SignalGroupFull {
                master_key: g.master_key,
                name: g.name.unwrap_or("".to_string()),
                datasource_id: g.datasource_id.unwrap_or(0),
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

    let parent_id = match req.parent_id.clone() {
        None => None,
        Some(parent_id) => {
            let has_organism = organism::Entity::find_by_id(parent_id)
                .count(&env.dbx)
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
    }
    .insert(&env.dbx)
    .await?;

    Ok(Json(Organism {
        id: organism.id,
        parent_id: organism.parent_id,
        name: organism.name,
        created_at: organism.created_at.and_utc().timestamp_millis(),
        roles: serde_json::from_value(organism.roles).unwrap_or(vec![]),
        group_auto_link: req.group_auto_link.unwrap_or(false),
        groups: vec![],
        enabled: organism.enabled,
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
        .order_by(sort_by, order)
        .all(&env.dbx)
        .await
        .context(h!())?;
    let organism_ids = organisms.iter().map(|x| x.id).collect::<Vec<i64>>();
    let organism_groups = organism_group::Entity::find()
        .filter(organism_group::Column::OrganismId.is_in(organism_ids))
        .all(&env.dbx)
        .await
        .context(h!())?;

    let mut list = organisms
        .into_iter()
        .map(|o| Organism {
            id: o.id,
            parent_id: o.parent_id,
            name: o.name,
            enabled: o.enabled,
            created_at: o.created_at.and_utc().timestamp_millis(),
            roles: serde_json::from_value(o.roles).unwrap_or(vec![]),
            group_auto_link: o.group_auto_link.unwrap_or(false),
            groups: organism_groups
                .iter()
                .filter(|x| x.organism_id.eq(&o.id))
                .map(|og| og.signal_group_master_key.clone())
                .collect(),
        })
        .collect_vec();
    if default_sorting {
        list.sort_by_key(|e| e.parent_id.map(|id| id * 0).unwrap_or(-1)); // first goes root elements, then the others
    }
    Ok(Json(list))
}
