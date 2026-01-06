use crate::entities::{login, organism, sigint_network_encryption_key};
use crate::error::AppError;
use crate::h;
use crate::types::ShortContext;
use anyhow::Context;
use sea_orm::*;
use std::collections::HashMap;

pub async fn load_freq_keys<'a, 'async_trait, C>(
    db: &'a C,
    user_login: &str,
    freq_ids: Vec<i64>,
) -> Result<HashMap<i64, String>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    Ok(sigint_network_encryption_key::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_network_encryption_key::Relation::Organism.def(),
        )
        .join(JoinType::InnerJoin, organism::Relation::Login.def())
        .filter(login::Column::Login.eq(user_login.to_string()))
        .filter(sigint_network_encryption_key::Column::Deleted.eq(false))
        .filter(
            sigint_network_encryption_key::Column::SigintNetworkFreqId
                .is_in(freq_ids),
        )
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .flat_map(|e| e.sigint_network_freq_id.map(|id| (id, e.key)))
        .collect::<HashMap<_, _>>())
}

pub async fn update_network_encryption_key(
    txn: &DatabaseTransaction,
    network_freq_id: i64,
    encryption_key: String,
    organism_id: i64,
) -> Result<(), AppError> {
    let old_key = sigint_network_encryption_key::Entity::find()
        .filter(sigint_network_encryption_key::Column::Deleted.eq(false))
        .filter(
            sigint_network_encryption_key::Column::SigintNetworkFreqId
                .eq(network_freq_id),
        )
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
