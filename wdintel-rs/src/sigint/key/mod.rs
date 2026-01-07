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
    pub key: String,
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
            sigint_network_freq::Column::NetworkId.eq(req.sigint_network_id),
        )
        .and_where(sigint_network_freq::Column::Deleted.eq(false))
        .to_owned();

    let filter_expr: SimpleExpr =
        sigint_network_encryption_key::Column::SigintNetworkFreqId
            .in_subquery(freq_query);
    let keys_map = load_keys(&env.dbx, &user_login, filter_expr)
        .await
        .c(h!())?;
    let mut keys = vec![];
    for (_, k) in keys_map {
        keys.push(EncryptionKeyData {
            id: k.id,
            sigint_network_freq_id: k.sigint_network_freq_id,
            key: k.key,
        });
    }
    Ok(Json(ListKeysRsp { keys }))
}

pub async fn load_freq_keys<'a, 'async_trait, C>(
    db: &'a C,
    user_login: &str,
    freq_ids: Vec<i64>,
) -> Result<HashMap<i64, EncryptionKeyData>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let filter_expr: SimpleExpr =
        sigint_network_encryption_key::Column::SigintNetworkFreqId
            .is_in(freq_ids);
    load_keys(db, user_login, filter_expr).await
}

async fn load_keys<'a, 'async_trait, C>(
    db: &'a C,
    user_login: &str,
    filter_expr: SimpleExpr,
) -> Result<HashMap<i64, EncryptionKeyData>, AppError>
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
    Ok(sigint_network_encryption_key::Entity::find()
        .filter(sigint_network_encryption_key::Column::Deleted.eq(false))
        .filter(filter_expr)
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .flat_map(|e| map_key(&organism_id, e))
        .collect::<HashMap<_, _>>())
}

fn map_key(
    organism_id: &i64,
    e: sigint_network_encryption_key::Model,
) -> Option<(i64, EncryptionKeyData)> {
    e.sigint_network_freq_id.map(|id| {
        let data = if e.organism_id.eq(organism_id) {
            EncryptionKeyData {
                id: Some(e.id),
                sigint_network_freq_id: e.sigint_network_freq_id,
                key: e.key,
            }
        } else {
            EncryptionKeyData {
                id: None,
                sigint_network_freq_id: e.sigint_network_freq_id,
                key: ENCRYPTION_KEY_PLACEHOLDER.to_string(),
            }
        };
        (id, data)
    })
}

pub async fn update_network_encryption_key(
    txn: &DatabaseTransaction,
    network_freq_id: i64,
    encryption_key_id: i64,
    encryption_key: String,
    organism_id: i64,
) -> Result<(), AppError> {
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

    if let Some(old_key) = old_key {
        if old_key.key.eq(&encryption_key) {
            return Ok(()); // key did not change
        } else {
            let mut key_am = old_key.into_active_model();
            key_am.deleted = Set(true);
            key_am.update(txn).await.c(h!())?;
        }
    }

    if !encryption_key.is_empty() {
        sigint_network_encryption_key::ActiveModel {
            id: NotSet,
            key: Set(encryption_key),
            sigint_network_freq_id: Set(Some(network_freq_id)),
            organism_id: Set(organism_id),
            deleted: NotSet,
            created_at: NotSet,
        }
        .insert(txn)
        .await
        .context(h!())?;
    }
    Ok(())
}

pub async fn insert_new_key(
    txn: &DatabaseTransaction,
    network_freq: sigint_network_freq::Model,
    encryption_key: String,
    organism_id: i64,
) -> anyhow::Result<()> {
    if encryption_key.replace(" ", "").is_empty() {
        return Ok(());
    }
    let sigint_network_freq_id = network_freq.id;
    let existing_live_freq_keys_count =
        sigint_network_encryption_key::Entity::find()
            .filter(
                sigint_network_encryption_key::Column::SigintNetworkFreqId
                    .eq(sigint_network_freq_id),
            )
            .filter(sigint_network_encryption_key::Column::Deleted.eq(false))
            .count(txn)
            .await
            .c(h!())?;
    if existing_live_freq_keys_count > 0 {
        anyhow::bail!("Live key for SigintNetworkFreq with ID={sigint_network_freq_id} already exists!");
    }

    sigint_network_encryption_key::ActiveModel {
        id: NotSet,
        key: Set(encryption_key),
        sigint_network_freq_id: Set(Some(sigint_network_freq_id)),
        organism_id: Set(organism_id),
        deleted: NotSet,
        created_at: NotSet,
    }
    .insert(txn)
    .await
    .context(h!())?;
    Ok(())
}
