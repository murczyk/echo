use crate::config::ENCRYPTION_KEY_PLACEHOLDER;
use crate::entities::*;
use crate::error::AppError;
use crate::h;
use crate::types::ShortContext;
use anyhow::Context;
use sea_orm::*;
use std::collections::HashMap;

pub struct EncryptionKeyData {
    pub id: Option<i64>,
    pub key: String,
}

pub async fn load_freq_keys<'a, 'async_trait, C>(
    db: &'a C,
    user_login: &str,
    freq_ids: Vec<i64>,
) -> Result<HashMap<i64, EncryptionKeyData>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let organism_id = login::Entity::find_by_id(user_login.to_string())
        .select_only()
        .column(login::Column::OrganismId)
        .into_tuple::<i32>()
        .one(db)
        .await
        .c(h!())?;
    let Some(organism_id) = organism_id else {
        return Ok(HashMap::new());
    };
    Ok(sigint_network_encryption_key::Entity::find()
        .filter(sigint_network_encryption_key::Column::Deleted.eq(false))
        .filter(
            sigint_network_encryption_key::Column::SigintNetworkFreqId
                .is_in(freq_ids),
        )
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .flat_map(|e| {
            e.sigint_network_freq_id.map(|id| {
                let data = if e.organism_id.eq(&(organism_id as i64)) {
                    EncryptionKeyData {
                        id: Some(e.id),
                        key: e.key,
                    }
                } else {
                    EncryptionKeyData {
                        id: None,
                        key: ENCRYPTION_KEY_PLACEHOLDER.to_string(),
                    }
                };
                (id, data)
            })
        })
        .collect::<HashMap<_, _>>())
}

pub async fn update_network_encryption_key(
    txn: &DatabaseTransaction,
    network_freq_id: i64,
    encryption_key_id: i64,
    encryption_key: String,
    organism_id: i64,
) -> Result<(), AppError> {
    let old_key = sigint_network_encryption_key::Entity::find_by_id(encryption_key_id)
        .filter(sigint_network_encryption_key::Column::Deleted.eq(false))
        .filter(
            sigint_network_encryption_key::Column::OrganismId.eq(organism_id),
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
) -> Result<(), AppError> {
    sigint_network_encryption_key::ActiveModel {
        id: NotSet,
        key: Set(encryption_key),
        sigint_network_freq_id: Set(Some(network_freq.id)),
        organism_id: Set(organism_id),
        deleted: NotSet,
        created_at: NotSet,
    }
    .insert(txn)
    .await
    .context(h!())?;
    Ok(())
}
