use crate::entities::{organism, sigint_key_share_policy};
use crate::error::AppError;
use crate::h;
use crate::types::{Deserialize, Env, Serialize, ShortContext};
use actix_web::post;
use actix_web::web::{Data, Json};
use elm_rs::{Elm, ElmDecode, ElmEncode};
use sea_orm::*;

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SigintKeySharePolicy {
    pub id: i64,
    pub grant_from: i64,
    pub grant_to: i64,
    pub author: String,
    pub created_at: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CreateSigintKeySharePolicyReq {
    pub grant_from: i64,
    pub grant_to: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct DeleteSigintKeySharePolicyReq {
    pub id: i64,
}

#[post("/api/sigint/key-share-policy/list")]
pub async fn list_key_share_policies(
    user: actix_identity::Identity,
    env: Data<Env>,
    _req: Json<()>,
) -> Result<Json<Vec<SigintKeySharePolicy>>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Admin")
        .await
        .c(h!())?;

    let policies = sigint_key_share_policy::Entity::find()
        .filter(sigint_key_share_policy::Column::Deleted.eq(false))
        .order_by_desc(sigint_key_share_policy::Column::CreatedAt)
        .all(&env.dbx)
        .await
        .c(h!())?;

    Ok(Json(
        policies.into_iter().map(map_policy).collect::<Vec<_>>(),
    ))
}

#[post("/api/sigint/key-share-policy/create")]
pub async fn create_key_share_policy(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<CreateSigintKeySharePolicyReq>,
) -> Result<Json<SigintKeySharePolicy>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Admin")
        .await
        .c(h!())?;

    ensure_organism_exists(&env.dbx, req.grant_from).await?;
    ensure_organism_exists(&env.dbx, req.grant_to).await?;

    let model = sigint_key_share_policy::ActiveModel {
        grant_from: Set(req.grant_from),
        grant_to: Set(req.grant_to),
        author: Set(login),
        deleted: Set(false),
        ..Default::default()
    };
    let policy = model.insert(&env.dbx).await.c(h!())?;

    Ok(Json(map_policy(policy)))
}

#[post("/api/sigint/key-share-policy/delete")]
pub async fn delete_key_share_policy(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<DeleteSigintKeySharePolicyReq>,
) -> Result<Json<()>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Admin")
        .await
        .c(h!())?;

    let policy = sigint_key_share_policy::Entity::find_by_id(req.id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;

    let mut policy_am = policy.into_active_model();
    policy_am.deleted = Set(true);
    policy_am.author = Set(login);
    policy_am.update(&env.dbx).await.c(h!())?;

    Ok(Json(()))
}

async fn ensure_organism_exists<'a, C>(
    db: &'a C,
    organism_id: i64,
) -> Result<(), AppError>
where
    C: ConnectionTrait + 'a,
{
    let organism = organism::Entity::find_by_id(organism_id)
        .filter(organism::Column::DeletedPermanently.eq(false))
        .one(db)
        .await
        .c(h!())?;

    organism.ok_or(AppError::NotFound)?;
    Ok(())
}

fn map_policy(model: sigint_key_share_policy::Model) -> SigintKeySharePolicy {
    SigintKeySharePolicy {
        id: model.id,
        grant_from: model.grant_from,
        grant_to: model.grant_to,
        author: model.author,
        created_at: model.created_at.and_utc().timestamp_millis(),
    }
}
