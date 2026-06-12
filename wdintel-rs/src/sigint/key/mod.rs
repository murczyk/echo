use crate::config::*;
use crate::entities::*;
use crate::error::AppError;
use crate::h;
use crate::types::*;
use crate::types::{Deserialize, Env, Serialize, ShortContext};
use actix_web::post;
use actix_web::web::Json;
use anyhow::Context;
use elm_rs::{Elm, ElmDecode, ElmEncode};
use sea_orm::*;

pub mod admin;

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct EncryptionKeyData {
    pub id: Option<i64>,
    pub sigint_network_freq_ids: Vec<i64>,
    pub sigint_network_id: Option<i64>,
    pub key: Option<String>,
    pub key_hash: Option<String>,
    pub description: Option<String>,
    pub encryption_id: Option<i64>,
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
    pub sigint_network_freq_ids: Vec<i64>,
    pub key: Option<String>,
    pub key_hash: Option<String>,
    pub description: Option<String>,
    pub encryption_id: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UpdateEncryptionKeyReq {
    pub id: i64,
    pub sigint_network_freq_ids: Vec<i64>,
    pub key: Option<String>,
    pub key_hash: Option<String>,
    pub description: Option<String>,
    pub encryption_id: Option<i64>,
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
        .await?;

    let keys = load_keys_list(&env.dbx, &user_login, req.sigint_network_id)
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

    validate_key_freqs(
        &env.dbx,
        req.sigint_network_id,
        &req.sigint_network_freq_ids,
    )
    .await
    .c(h!())?;

    let txn = env.dbx.begin().await.c(h!())?;
    let key = insert_new_key(
        &txn,
        req.sigint_network_id,
        req.sigint_network_freq_ids.clone(),
        req.key.clone(),
        req.key_hash.clone(),
        req.description.clone(),
        normalize_encryption_id(req.encryption_id),
        organism_id,
    )
    .await
    .context(h!())?;

    txn.commit().await.c(h!())?;

    Ok(Json(map_key_for_list(
        &vec![organism_id],
        key,
        req.sigint_network_freq_ids.clone(),
    )))
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
    let key = sigint_network_encryption_key::Entity::find_by_id(req.id)
        .filter(sigint_network_encryption_key::Column::Deleted.eq(false))
        .filter(
            sigint_network_encryption_key::Column::OrganismId.eq(organism_id),
        )
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;

    let network_id = key.sigint_network_id.ok_or(AppError::NotFound)?;
    validate_key_freqs(&env.dbx, network_id, &req.sigint_network_freq_ids)
        .await
        .c(h!())?;

    let txn = env.dbx.begin().await.c(h!())?;
    let key = update_network_encryption_key(
        &txn,
        req.sigint_network_freq_ids.clone(),
        req.id,
        req.key.clone(),
        req.key_hash.clone(),
        req.description.clone(),
        normalize_encryption_id(req.encryption_id),
        key.organism_id,
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

    let freq_ids = load_key_freq_ids(&env.dbx, vec![key.id])
        .await
        .c(h!())?
        .remove(&key.id)
        .unwrap_or_default();
    Ok(Json(map_key_for_list(&vec![organism_id], key, freq_ids)))
}

pub async fn load_freq_keys<'async_trait, C>(
    db: &C,
    user_login: &str,
    freq_ids: Vec<i64>,
) -> Result<HashMap<i64, Vec<EncryptionKeyData>>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    load_latest_keys_by_freq(db, user_login, freq_ids).await
}

async fn load_keys_list<'async_trait, C>(
    db: &C,
    user_login: &str,
    network_id: i32,
) -> Result<Vec<EncryptionKeyData>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let Ok(organism_ids) = load_available_organism_ids(user_login, db).await
    else {
        return Ok(vec![]);
    };

    let freq_ids = sigint_network_freq::Entity::find()
        .filter(sigint_network_freq::Column::NetworkId.eq(network_id as i64))
        .filter(sigint_network_freq::Column::Deleted.eq(false))
        .select_only()
        .column(sigint_network_freq::Column::Id)
        .into_tuple::<i64>()
        .all(db)
        .await
        .c(h!())?;

    let key_ids_from_freqs = if freq_ids.is_empty() {
        vec![]
    } else {
        sigint_network_encryption_key_freq::Entity::find()
            .filter(
                sigint_network_encryption_key_freq::Column::SigintNetworkFreqId
                    .is_in(freq_ids),
            )
            .select_only()
            .column(
                sigint_network_encryption_key_freq::Column::SigintNetworkEncryptionKeyId,
            )
            .into_tuple::<i64>()
            .all(db)
            .await
            .c(h!())?
    };

    let mut condition = Condition::any().add(
        sigint_network_encryption_key::Column::SigintNetworkId
            .eq(network_id as i64),
    );
    if !key_ids_from_freqs.is_empty() {
        condition = condition.add(
            sigint_network_encryption_key::Column::Id.is_in(key_ids_from_freqs),
        );
    }

    let keys = sigint_network_encryption_key::Entity::find()
        .filter(sigint_network_encryption_key::Column::Deleted.eq(false))
        .filter(condition)
        .order_by_desc(sigint_network_encryption_key::Column::CreatedAt)
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .collect::<Vec<_>>();

    let key_ids = keys.iter().map(|key| key.id).collect::<Vec<_>>();
    let mut key_freqs = load_key_freq_ids(db, key_ids).await.c(h!())?;

    Ok(keys
        .into_iter()
        .map(|key| {
            let freq_ids = key_freqs.remove(&key.id).unwrap_or_default();
            map_key_for_list(&organism_ids, key, freq_ids)
        })
        .collect::<Vec<_>>())
}

async fn load_latest_keys_by_freq<'async_trait, C>(
    db: &C,
    user_login: &str,
    freq_ids: Vec<i64>,
) -> Result<HashMap<i64, Vec<EncryptionKeyData>>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let organism_ids =
        load_available_organism_ids(user_login, db).await.c(h!())?;
    if organism_ids.is_empty() {
        return Ok(HashMap::new());
    };
    if freq_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let links = sigint_network_encryption_key_freq::Entity::find()
        .filter(
            sigint_network_encryption_key_freq::Column::SigintNetworkFreqId
                .is_in(freq_ids),
        )
        .find_also_related(sigint_network_encryption_key::Entity)
        .all(db)
        .await
        .c(h!())?;

    let mut key_freqs: HashMap<i64, Vec<i64>> = HashMap::new();
    let mut freq_key_ids: HashMap<i64, Vec<i64>> = HashMap::new();
    let mut key_models: HashMap<i64, sigint_network_encryption_key::Model> =
        HashMap::new();

    for (link, key) in links {
        let Some(key) = key else { continue };
        if key.deleted {
            continue;
        }
        key_models.entry(key.id).or_insert(key);
        key_freqs
            .entry(link.sigint_network_encryption_key_id)
            .or_default()
            .push(link.sigint_network_freq_id);
        freq_key_ids
            .entry(link.sigint_network_freq_id)
            .or_default()
            .push(link.sigint_network_encryption_key_id);
    }

    let mut by_freq: HashMap<i64, Vec<EncryptionKeyData>> = HashMap::new();
    for (freq_id, key_ids) in freq_key_ids {
        let mut key_list = Vec::new();
        for key_id in key_ids {
            let Some(key) = key_models.get(&key_id).cloned() else {
                continue;
            };
            let freq_list = key_freqs.get(&key_id).cloned().unwrap_or_default();
            key_list.push(map_key_for_list(&organism_ids, key, freq_list));
        }
        by_freq.insert(freq_id, key_list);
    }

    Ok(by_freq)
}

fn map_key_for_list(
    organism_ids: &Vec<i64>,
    e: sigint_network_encryption_key::Model,
    freq_ids: Vec<i64>,
) -> EncryptionKeyData {
    let has_description = e.description.is_some();
    if organism_ids.contains(&e.organism_id) {
        EncryptionKeyData {
            id: Some(e.id),
            sigint_network_freq_ids: freq_ids,
            sigint_network_id: e.sigint_network_id,
            key: e.key,
            key_hash: e.key_hash,
            description: e.description,
            encryption_id: e.encryption_id,
        }
    } else {
        EncryptionKeyData {
            id: Some(e.id),
            sigint_network_freq_ids: vec![],
            sigint_network_id: e.sigint_network_id,
            key: Some(ENCRYPTION_KEY_PLACEHOLDER.to_string()),
            key_hash: Some(ENCRYPTION_KEY_PLACEHOLDER.to_string()),
            description: if has_description {
                Some(ENCRYPTION_KEY_DESCRIPTION_PLACEHOLDER.to_string())
            } else {
                None
            },
            encryption_id: None,
        }
    }
}

pub async fn update_network_encryption_key(
    txn: &DatabaseTransaction,
    network_freq_ids: Vec<i64>,
    encryption_key_id: i64,
    encryption_key: Option<String>,
    encryption_key_hash: Option<String>,
    description: Option<String>,
    encryption_id: Option<i64>,
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
    let Some(network_id) = old_key.sigint_network_id else {
        return Err(AppError::BL {
            msg: "Ключ шифрування не прив'язаний до мережі".to_string(),
        });
    };

    validate_key_freqs(txn, network_id, &network_freq_ids)
        .await
        .c(h!())?;

    if old_key.key.eq(&encryption_key) {
        let mut key_am = old_key.into_active_model();
        key_am.description = Set(updated_description);
        key_am.key_hash = Set(encryption_key_hash);
        key_am.encryption_id = Set(encryption_id);
        let key = key_am.update(txn).await.c(h!())?;
        replace_key_freq_links(txn, key.id, &network_freq_ids)
            .await
            .c(h!())?;
        return Ok(map_key_for_list(&vec![organism_id], key, network_freq_ids));
    }

    let mut key_am = old_key.into_active_model();
    key_am.deleted = Set(true);
    key_am.update(txn).await.c(h!())?;

    let key = sigint_network_encryption_key::ActiveModel {
        id: NotSet,
        key: Set(encryption_key),
        key_hash: Set(encryption_key_hash),
        sigint_network_freq_id: Set(None),
        sigint_network_id: Set(Some(network_id)),
        description: Set(updated_description),
        organism_id: Set(organism_id),
        encryption_id: Set(encryption_id),
        deleted: NotSet,
        created_at: NotSet,
    }
    .insert(txn)
    .await
    .context(h!())?;

    replace_key_freq_links(txn, key.id, &network_freq_ids)
        .await
        .c(h!())?;

    Ok(map_key_for_list(&vec![organism_id], key, network_freq_ids))
}

pub async fn insert_new_key(
    txn: &DatabaseTransaction,
    network_id: i64,
    network_freq_ids: Vec<i64>,
    encryption_key: Option<String>,
    encryption_key_hash: Option<String>,
    description: Option<String>,
    encryption_id: Option<i64>,
    organism_id: i64,
) -> anyhow::Result<sigint_network_encryption_key::Model> {
    let key = sigint_network_encryption_key::ActiveModel {
        id: NotSet,
        key_hash: Set(encryption_key_hash),
        key: Set(encryption_key),
        sigint_network_freq_id: Set(None),
        sigint_network_id: Set(Some(network_id)),
        description: Set(description),
        organism_id: Set(organism_id),
        encryption_id: Set(encryption_id),
        deleted: NotSet,
        created_at: NotSet,
    }
    .insert(txn)
    .await
    .context(h!())?;
    replace_key_freq_links(txn, key.id, &network_freq_ids)
        .await
        .c(h!())?;
    Ok(key)
}

async fn validate_key_freqs<C>(
    db: &C,
    network_id: i64,
    freq_ids: &[i64],
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    if freq_ids.is_empty() {
        return Ok(());
    }
    let count = sigint_network_freq::Entity::find()
        .filter(sigint_network_freq::Column::NetworkId.eq(network_id))
        .filter(sigint_network_freq::Column::Id.is_in(freq_ids.to_vec()))
        .filter(sigint_network_freq::Column::Deleted.eq(false))
        .count(db)
        .await
        .c(h!())?;
    if count as usize != freq_ids.len() {
        return Err(AppError::NotFound);
    }
    Ok(())
}

async fn replace_key_freq_links<C>(
    db: &C,
    key_id: i64,
    freq_ids: &[i64],
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    sigint_network_encryption_key_freq::Entity::delete_many()
        .filter(
            sigint_network_encryption_key_freq::Column::SigintNetworkEncryptionKeyId
                .eq(key_id),
        )
        .exec(db)
        .await
        .c(h!())?;

    if freq_ids.is_empty() {
        return Ok(());
    }

    let models = freq_ids
        .iter()
        .map(|freq_id| sigint_network_encryption_key_freq::ActiveModel {
            id: NotSet,
            sigint_network_encryption_key_id: Set(key_id),
            sigint_network_freq_id: Set(*freq_id),
            created_at: NotSet,
        })
        .collect::<Vec<_>>();

    sigint_network_encryption_key_freq::Entity::insert_many(models)
        .exec(db)
        .await
        .c(h!())?;

    Ok(())
}

pub async fn replace_freq_key_links(
    txn: &DatabaseTransaction,
    network_id: i64,
    freq_id: i64,
    key_ids: &[i64],
    organism_id: i64,
) -> Result<(), AppError> {
    sigint_network_encryption_key_freq::Entity::delete_many()
        .filter(
            sigint_network_encryption_key_freq::Column::SigintNetworkFreqId
                .eq(freq_id),
        )
        .exec(txn)
        .await
        .c(h!())?;

    if key_ids.is_empty() {
        return Ok(());
    }

    let unique_key_ids = {
        let mut ids = key_ids.to_vec();
        ids.sort();
        ids.dedup();
        ids
    };

    let count = sigint_network_encryption_key::Entity::find()
        .filter(
            sigint_network_encryption_key::Column::Id
                .is_in(unique_key_ids.clone()),
        )
        .filter(sigint_network_encryption_key::Column::Deleted.eq(false))
        .filter(
            sigint_network_encryption_key::Column::OrganismId.eq(organism_id),
        )
        .filter(
            sigint_network_encryption_key::Column::SigintNetworkId
                .eq(network_id),
        )
        .count(txn)
        .await
        .c(h!())?;
    if count as usize != unique_key_ids.len() {
        return Err(AppError::NotFound);
    }

    let models = unique_key_ids
        .into_iter()
        .map(|key_id| sigint_network_encryption_key_freq::ActiveModel {
            id: NotSet,
            sigint_network_encryption_key_id: Set(key_id),
            sigint_network_freq_id: Set(freq_id),
            created_at: NotSet,
        })
        .collect::<Vec<_>>();

    sigint_network_encryption_key_freq::Entity::insert_many(models)
        .exec(txn)
        .await
        .c(h!())?;

    Ok(())
}

async fn load_key_freq_ids<C>(
    db: &C,
    key_ids: Vec<i64>,
) -> Result<HashMap<i64, Vec<i64>>, AppError>
where
    C: ConnectionTrait,
{
    if key_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let links = sigint_network_encryption_key_freq::Entity::find()
        .filter(
            sigint_network_encryption_key_freq::Column::SigintNetworkEncryptionKeyId
                .is_in(key_ids),
        )
        .all(db)
        .await
        .c(h!())?;
    let mut by_key: HashMap<i64, Vec<i64>> = HashMap::new();
    for link in links {
        by_key
            .entry(link.sigint_network_encryption_key_id)
            .or_default()
            .push(link.sigint_network_freq_id);
    }
    Ok(by_key)
}

fn normalize_encryption_id(encryption_id: Option<i64>) -> Option<i64> {
    match encryption_id {
        Some(-1) => None,
        _ => encryption_id,
    }
}

async fn load_organism_id<'async_trait, C>(
    user_login: &str,
    db: &C,
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

async fn load_available_organism_ids<'async_trait, C>(
    user_login: &str,
    db: &C,
) -> Result<Vec<i64>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let primary_id = load_organism_id(user_login, db).await.c(h!())?;
    let mut other_available_organism_ids =
        sigint_key_share_policy::Entity::find()
            .select_only()
            .column(sigint_key_share_policy::Column::GrantFrom)
            .filter(sigint_key_share_policy::Column::GrantTo.eq(primary_id))
            .filter(sigint_key_share_policy::Column::Deleted.eq(false))
            .into_tuple::<i64>()
            .all(db)
            .await
            .c(h!())?;
    other_available_organism_ids.push(primary_id);
    Ok(other_available_organism_ids)
}
