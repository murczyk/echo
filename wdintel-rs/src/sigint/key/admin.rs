use crate::entities::{organism, sigint_key_share_policy};
use crate::error::AppError;
use crate::h;
use crate::types::{Deserialize, Env, Serialize, ShortContext};
use crate::users::{ensure_admin, login_id_from_identity};
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
    ensure_admin(&env.dbx, &user).await.c(h!())?;

    let policies = sigint_key_share_policy::Entity::find()
        .filter(sigint_key_share_policy::Column::Deleted.eq(false))
        .order_by_desc(sigint_key_share_policy::Column::CreatedAt)
        .all(&env.dbx)
        .await
        .c(h!())?;
    let login_names = crate::users::login_names_by_ids(
        &env.dbx,
        policies
            .iter()
            .map(|policy| policy.author_login_id)
            .collect(),
    )
    .await?;

    Ok(Json(
        policies
            .into_iter()
            .map(|policy| {
                let author = login_names[&policy.author_login_id].clone();
                map_policy(policy, author)
            })
            .collect::<Vec<_>>(),
    ))
}

#[post("/api/sigint/key-share-policy/create")]
pub async fn create_key_share_policy(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<CreateSigintKeySharePolicyReq>,
) -> Result<Json<SigintKeySharePolicy>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;

    ensure_organism_exists(&env.dbx, req.grant_from).await?;
    ensure_organism_exists(&env.dbx, req.grant_to).await?;

    let model = sigint_key_share_policy::ActiveModel {
        grant_from: Set(req.grant_from),
        grant_to: Set(req.grant_to),
        author_login_id: Set(login),
        deleted: Set(false),
        ..Default::default()
    };
    let policy = model.insert(&env.dbx).await.c(h!())?;
    let login_names =
        crate::users::login_names_by_ids(&env.dbx, vec![login]).await?;

    Ok(Json(map_policy(policy, login_names[&login].clone())))
}

#[post("/api/sigint/key-share-policy/delete")]
pub async fn delete_key_share_policy(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<DeleteSigintKeySharePolicyReq>,
) -> Result<Json<()>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;

    let policy = sigint_key_share_policy::Entity::find_by_id(req.id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;

    let mut policy_am = policy.into_active_model();
    policy_am.deleted = Set(true);
    policy_am.author_login_id = Set(login);
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

fn map_policy(
    policy: sigint_key_share_policy::Model,
    author: String,
) -> SigintKeySharePolicy {
    SigintKeySharePolicy {
        id: policy.id,
        grant_from: policy.grant_from,
        grant_to: policy.grant_to,
        author,
        created_at: policy.created_at.and_utc().timestamp_millis(),
    }
}
