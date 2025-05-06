use crate::entities::{
    prelude::{Organism as OrganismEntity, OrganismGroup, SignalGroup},
    *,
};
use crate::error::AppError;
use crate::types::*;
use actix_web::post;
use actix_web::web::Json;
use sea_orm::*;

use self::types::*;
pub mod types;

pub async fn has_role(
    dbx: &sea_orm::DatabaseConnection,
    organism_id: i64,
    role: &str,
) -> Result<(), AppError> {
    let Some(organism) =
        OrganismEntity::find_by_id(organism_id).one(dbx).await?
    else {
        println!("organism not found: {}", organism_id);
        return Err(AppError::Unauthenticated);
    };
    let roles: Vec<String> =
        serde_json::from_value(organism.roles).context(h!())?;
    let is_good = roles.contains(&role.to_string());
    if !is_good {
        return Err(AppError::Forbidden(format!(
            "required role {}, only has {}",
            role,
            roles.join(", ")
        )));
    }
    Ok(())
}

#[post("/api/organism/add-group")]
pub async fn add_group_to_organism(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AddGroupToOrganismReq>,
) -> Result<Json<()>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Admin").await?;

    let organism = OrganismEntity::find_by_id(req.organism_id)
        .one(&env.dbx)
        .await?
        .ok_or(AppError::NotFound)?;

    let group = SignalGroup::find()
        .filter(signal_group::Column::MasterKey.eq(&req.group_name))
        .one(&env.dbx)
        .await?
        .ok_or(AppError::NotFound)?;

    organism_group::ActiveModel {
        organism_id: Set(organism.id),
        signal_group_master_key: Set(group.master_key.clone()),
    }
    .insert(&env.dbx)
    .await?;

    Ok(Json(()))
}

#[post("/api/organism/remove-group")]
pub async fn remove_group_from_organism(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<RemoveGroupFromOrganismReq>,
) -> Result<Json<()>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Admin").await?;

    OrganismGroup::find()
        .filter(organism_group::Column::OrganismId.eq(req.organism_id))
        .filter(
            organism_group::Column::SignalGroupMasterKey
                .eq(req.group_name.clone()),
        )
        .one(&env.dbx)
        .await?
        .ok_or(AppError::NotFound)?
        .delete(&env.dbx)
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

    OrganismEntity::delete_by_id(req.0).exec(&env.dbx).await?;

    Ok(Json(()))
}

#[post("/api/organism/update")]
pub async fn update_organism(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<UpdateOrganismReq>,
) -> Result<Json<Organism>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Admin").await?;

    let organism_obj = OrganismEntity::find()
        .filter(organism::Column::Id.eq(req.id))
        .one(&env.dbx)
        .await?
        .ok_or(AppError::NotFound)?;

    let mut organism: organism::ActiveModel = organism_obj.into();

    if let Some(name) = req.name.clone() {
        organism.name = Set(name);
    }
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
        SignalGroup::find()
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

#[post("/api/organism/create")]
pub async fn create_organism(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<CreateOrganismReq>,
) -> Result<Json<Organism>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Admin").await?;

    let organism = organism::ActiveModel {
        id: NotSet,
        name: Set(req.name.clone()),
        roles: Set(serde_json::to_value(req.roles.clone()).context(h!())?),
        group_auto_link: Set(Some(req.group_auto_link.unwrap_or(false))),
        created_at: NotSet,
        enabled: NotSet,
    }
    .insert(&env.dbx)
    .await?;

    Ok(Json(Organism {
        id: organism.id,
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

    Ok(Json(
        OrganismEntity::find()
            .find_with_related(OrganismGroup)
            .order_by(sort_by, order)
            .all(&env.dbx)
            .await?
            .into_iter()
            .map(|(o, og)| Organism {
                id: o.id,
                name: o.name,
                enabled: o.enabled,
                created_at: o.created_at.and_utc().timestamp_millis(),
                roles: serde_json::from_value(o.roles).unwrap_or(vec![]),
                group_auto_link: o.group_auto_link.unwrap_or(false),
                groups: og
                    .into_iter()
                    .map(|og| og.signal_group_master_key)
                    .collect(),
            })
            .collect(),
    ))
}
