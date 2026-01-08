use crate::config::ENCRYPTION_KEY_PLACEHOLDER;
use crate::entities::*;
use crate::error::AppError;
use crate::h;
use crate::types::{Deserialize, Env, Serialize, ShortContext};
use actix_web::post;
use actix_web::web::Json;
use anyhow::Context;
use echo_migration::{Query, SimpleExpr};
use elm_rs::{Elm, ElmDecode, ElmEncode};
use sea_orm::*;
use std::collections::HashMap;

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct EncryptionKeyData {
    pub id: Option<i64>,
    pub sigint_network_freq_id: Option<i64>,
    pub sigint_network_id: Option<i64>,
    pub key: String,
    pub description: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListKeysReq {
    pub sigint_network_id: i32,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListKeysRsp {
    pub keys: Vec<EncryptionKeyData>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CreateEncryptionKeyReq {
    pub sigint_network_id: i64,
    pub sigint_network_freq_id: Option<i64>,
    pub key: String,
    pub description: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UpdateEncryptionKeyReq {
    pub id: i64,
    pub sigint_network_freq_id: Option<i64>,
    pub key: String,
    pub description: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct DeleteEncryptionKeyReq {
    pub id: i64,
}

#[post("/api/sigint/keys")]
pub async fn list_keys(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ListKeysReq>,
) -> Result<Json<ListKeysRsp>, AppError> {
    let user_login = user.id().c(h!())?;
    crate::users::has_any_role(&env.dbx, &user_login, vec!["Rer", "Api"])
        .await
        .c(h!())?;

    let freq_query = Query::select()
        .column(sigint_network_freq::Column::Id)
        .from(sigint_network_freq::Entity)
        .and_where(
            sigint_network_freq::Column::NetworkId
                .eq(req.sigint_network_id as i64),
        )
        .and_where(sigint_network_freq::Column::Deleted.eq(false))
        .to_owned();

    let filter_expr: SimpleExpr =
        sigint_network_encryption_key::Column::SigintNetworkId
            .eq(req.sigint_network_id as i64)
            .or(sigint_network_encryption_key::Column::SigintNetworkFreqId
                .in_subquery(freq_query));

    let keys = load_keys_list(&env.dbx, &user_login, filter_expr)
        .await
        .c(h!())?;

    Ok(Json(ListKeysRsp { keys }))
}

#[post("/api/sigint/keys/create")]
pub async fn create_key(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<CreateEncryptionKeyReq>,
) -> Result<Json<EncryptionKeyData>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .context(h!())?;
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "UnitsEditor")
        .await
        .context(h!())?;

    let user_id = user.id().c(h!())?;
    let organism_id = load_organism_id(&user_id, &env.dbx).await.c(h!())?;

    let txn = env.dbx.begin().await.c(h!())?;
    let key = insert_new_key(
        &txn,
        req.sigint_network_id,
        req.sigint_network_freq_id,
        req.key.clone(),
        req.description.clone(),
        organism_id,
    )
    .await
    .context(h!())?;

    txn.commit().await.c(h!())?;

    Ok(Json(map_key_for_list(&organism_id, key)))
}

#[post("/api/sigint/keys/update")]
pub async fn update_key(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<UpdateEncryptionKeyReq>,
) -> Result<Json<EncryptionKeyData>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .context(h!())?;
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "UnitsEditor")
        .await
        .context(h!())?;

    let user_id = user.id().c(h!())?;
    let organism_id = load_organism_id(&user_id, &env.dbx).await.c(h!())?;

    if let Some(freq_id) = req.sigint_network_freq_id {
        let freq_exists = sigint_network_freq::Entity::find()
            .filter(sigint_network_freq::Column::Id.eq(freq_id))
            .filter(sigint_network_freq::Column::Deleted.eq(false))
            .one(&env.dbx)
            .await
            .c(h!())?;
        if freq_exists.is_none() {
            return Err(AppError::NotFound);
        }
    }

    let txn = env.dbx.begin().await.c(h!())?;
    let key = update_network_encryption_key(
        &txn,
        req.sigint_network_freq_id,
        None,
        req.id,
        req.key.clone(),
        req.description.clone(),
        organism_id,
    )
    .await
    .c(h!())?;

    txn.commit().await.c(h!())?;

    Ok(Json(key))
}

#[post("/api/sigint/keys/delete")]
pub async fn delete_key(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<DeleteEncryptionKeyReq>,
) -> Result<Json<EncryptionKeyData>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .context(h!())?;
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "UnitsEditor")
        .await
        .context(h!())?;

    let user_id = user.id().c(h!())?;
    let organism_id = load_organism_id(&user_id, &env.dbx).await.c(h!())?;

    let key = sigint_network_encryption_key::Entity::find_by_id(req.id)
        .filter(sigint_network_encryption_key::Column::Deleted.eq(false))
        .filter(
            sigint_network_encryption_key::Column::OrganismId.eq(organism_id),
        )
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;

    let mut key_am = key.into_active_model();
    key_am.deleted = Set(true);
    let key = key_am.update(&env.dbx).await.c(h!())?;

    Ok(Json(map_key_for_list(&organism_id, key)))
}

pub async fn load_freq_keys<'a, 'async_trait, C>(
    db: &'a C,
    user_login: &str,
    freq_ids: Vec<i64>,
) -> Result<HashMap<i64, Vec<EncryptionKeyData>>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let filter_expr: SimpleExpr =
        sigint_network_encryption_key::Column::SigintNetworkFreqId
            .is_in(freq_ids);
    load_latest_keys_by_freq(db, user_login, filter_expr).await
}

async fn load_keys_list<'a, 'async_trait, C>(
    db: &'a C,
    user_login: &str,
    filter_expr: SimpleExpr,
) -> Result<Vec<EncryptionKeyData>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let Ok(organism_id) = load_organism_id(user_login, db).await else {
        return Ok(vec![]);
    };
    Ok(sigint_network_encryption_key::Entity::find()
        .filter(sigint_network_encryption_key::Column::Deleted.eq(false))
        .filter(filter_expr)
        .order_by_desc(sigint_network_encryption_key::Column::CreatedAt)
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .map(|e| map_key_for_list(&organism_id, e))
        .collect::<Vec<_>>())
}

async fn load_latest_keys_by_freq<'a, 'async_trait, C>(
    db: &'a C,
    user_login: &str,
    filter_expr: SimpleExpr,
) -> Result<HashMap<i64, Vec<EncryptionKeyData>>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let organism_id = login::Entity::find_by_id(user_login.to_string())
        .select_only()
        .column(login::Column::OrganismId)
        .into_tuple::<i64>()
        .one(db)
        .await
        .c(h!())?;
    let Some(organism_id) = organism_id else {
        return Ok(HashMap::new());
    };
    let keys = sigint_network_encryption_key::Entity::find()
        .filter(sigint_network_encryption_key::Column::Deleted.eq(false))
        .filter(filter_expr)
        .order_by_desc(sigint_network_encryption_key::Column::CreatedAt)
        .all(db)
        .await
        .c(h!())?;

    let mut by_freq: HashMap<i64, Vec<EncryptionKeyData>> = HashMap::new();
    for key in keys {
        if let Some((freq_id, key_data)) = map_key_for_freq(&organism_id, key) {
            by_freq.entry(freq_id).or_default().push(key_data);
        }
    }

    Ok(by_freq)
}

fn map_key_for_freq(
    organism_id: &i64,
    e: sigint_network_encryption_key::Model,
) -> Option<(i64, EncryptionKeyData)> {
    e.sigint_network_freq_id.map(|id| {
        let data = if e.organism_id.eq(organism_id) {
            EncryptionKeyData {
                id: Some(e.id),
                sigint_network_freq_id: e.sigint_network_freq_id,
                sigint_network_id: e.sigint_network_id,
                key: e.key,
                description: e.description,
            }
        } else {
            EncryptionKeyData {
                id: None,
                sigint_network_freq_id: e.sigint_network_freq_id,
                sigint_network_id: e.sigint_network_id,
                key: ENCRYPTION_KEY_PLACEHOLDER.to_string(),
                description: None,
            }
        };
        (id, data)
    })
}

fn map_key_for_list(
    organism_id: &i64,
    e: sigint_network_encryption_key::Model,
) -> EncryptionKeyData {
    if e.organism_id.eq(organism_id) {
        EncryptionKeyData {
            id: Some(e.id),
            sigint_network_freq_id: e.sigint_network_freq_id,
            sigint_network_id: e.sigint_network_id,
            key: e.key,
            description: e.description,
        }
    } else {
        EncryptionKeyData {
            id: Some(e.id),
            sigint_network_freq_id: e.sigint_network_freq_id,
            sigint_network_id: e.sigint_network_id,
            key: ENCRYPTION_KEY_PLACEHOLDER.to_string(),
            description: None,
        }
    }
}

pub async fn update_network_encryption_key(
    txn: &DatabaseTransaction,
    network_freq_id: Option<i64>,
    network_id: Option<i64>,
    encryption_key_id: i64,
    encryption_key: String,
    description: Option<String>,
    organism_id: i64,
) -> Result<EncryptionKeyData, AppError> {
    let old_key =
        sigint_network_encryption_key::Entity::find_by_id(encryption_key_id)
            .filter(sigint_network_encryption_key::Column::Deleted.eq(false))
            .filter(
                sigint_network_encryption_key::Column::OrganismId
                    .eq(organism_id),
            )
            .one(txn)
            .await
            .c(h!())?;

    let old_key = old_key.ok_or(AppError::NotFound)?;
    let previous_description = old_key.description.clone();
    let updated_description = description.or(previous_description);
    let resolved_network_id = network_id.or(old_key.sigint_network_id);

    let Some(network_id) = resolved_network_id else {
        return Err(AppError::BL {
            msg: "Ключ шифрування не прив'язаний до мережі".to_string(),
        });
    };

    if old_key.key.eq(&encryption_key) {
        let mut key_am = old_key.into_active_model();
        key_am.sigint_network_freq_id = Set(network_freq_id);
        key_am.description = Set(updated_description);
        let key = key_am.update(txn).await.c(h!())?;
        return Ok(map_key_for_list(&organism_id, key));
    }

    let mut key_am = old_key.into_active_model();
    key_am.deleted = Set(true);
    key_am.update(txn).await.c(h!())?;

    let key = sigint_network_encryption_key::ActiveModel {
        id: NotSet,
        key: Set(encryption_key),
        sigint_network_freq_id: Set(network_freq_id),
        sigint_network_id: Set(Some(network_id)),
        description: Set(updated_description),
        organism_id: Set(organism_id),
        deleted: NotSet,
        created_at: NotSet,
    }
    .insert(txn)
    .await
    .context(h!())?;

    Ok(map_key_for_list(&organism_id, key))
}

pub async fn insert_new_key(
    txn: &DatabaseTransaction,
    network_id: i64,
    network_freq_id: Option<i64>,
    encryption_key: String,
    description: Option<String>,
    organism_id: i64,
) -> anyhow::Result<sigint_network_encryption_key::Model> {
    let key = sigint_network_encryption_key::ActiveModel {
        id: NotSet,
        key: Set(encryption_key),
        sigint_network_freq_id: Set(network_freq_id),
        sigint_network_id: Set(Some(network_id)),
        description: Set(description),
        organism_id: Set(organism_id),
        deleted: NotSet,
        created_at: NotSet,
    }
    .insert(txn)
    .await
    .context(h!())?;
    Ok(key)
}

async fn load_organism_id<'a, 'async_trait, C>(
    user_login: &str,
    db: &'a C,
) -> Result<i64, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    login::Entity::find_by_id(user_login.to_string())
        .select_only()
        .column(login::Column::OrganismId)
        .into_tuple::<i64>()
        .one(db)
        .await
        .c(h!())?
        .ok_or_else(|| AppError::BL {
            msg: "User has no organism assigned".to_string(),
        })
}
