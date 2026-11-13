use crate::entities::{sigint_group_sender_organism, signal_group};
use crate::types::*;
use actix_web::{
    post,
    web::{Data, Json},
};
use elm_rs::{Elm, ElmDecode, ElmEncode};
use sea_orm::*;

mod delivery;
#[cfg(test)]
mod tests;
pub(crate) use delivery::enqueue;

#[derive(Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct GroupSendingSettings {
    pub can_send_messages: bool,
    pub send_messages: bool,
    pub sender_organism_ids: Vec<i64>,
}

#[post("/api/messenger/group-sending-settings")]
pub async fn get(
    env: Data<Env>,
    user: actix_identity::Identity,
    master_key: Json<String>,
) -> Result<Json<GroupSendingSettings>, AppError> {
    crate::users::ensure_admin(&env.dbx, &user).await.c(h!())?;
    Ok(Json(read(&env.dbx, &master_key).await.c(h!())?))
}

pub async fn read<C: ConnectionTrait>(
    db: &C,
    master_key: &str,
) -> anyhow::Result<GroupSendingSettings> {
    let group = signal_group::Entity::find_by_id(master_key)
        .filter(signal_group::Column::Deleted.eq(false))
        .one(db)
        .await
        .c(h!())?
        .c(h!())?;
    let can_send_messages = can_send(db, master_key).await.c(h!())?;
    let sender_organism_ids = sigint_group_sender_organism::Entity::find()
        .filter(sigint_group_sender_organism::Column::MasterKey.eq(master_key))
        .select_only()
        .column(sigint_group_sender_organism::Column::OrganismId)
        .order_by_asc(sigint_group_sender_organism::Column::OrganismId)
        .into_tuple::<i64>()
        .all(db)
        .await
        .c(h!())?;
    Ok(GroupSendingSettings {
        can_send_messages,
        send_messages: group.send_messages.unwrap_or(false),
        sender_organism_ids,
    })
}

async fn can_send<C: ConnectionTrait>(
    db: &C,
    master_key: &str,
) -> anyhow::Result<bool> {
    let row = db.query_one_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "select exists(select 1 from datasource_group dg join datasource d on d.id = dg.datasource_id where dg.group_master_key = $1 and not dg.deleted and not d.deleted and d.kind in ('signal', 'whatsapp') and d.can_send_messages is true) as allowed",
        vec![master_key.into()],
    )).await.c(h!())?.c(h!())?;
    row.try_get("", "allowed").c(h!())
}

pub async fn set(
    txn: &DatabaseTransaction,
    master_key: &str,
    send_messages: Option<bool>,
    sender_organism_ids: Option<&[i64]>,
) -> anyhow::Result<()> {
    if send_messages.is_none() && sender_organism_ids.is_none() {
        return Ok(());
    }
    let group = signal_group::Entity::find_by_id(master_key)
        .lock_exclusive()
        .one(txn)
        .await
        .c(h!())?
        .c(h!())?;
    if send_messages == Some(true)
        && !can_send(txn, master_key).await.c(h!())?
    {
        anyhow::bail!(
            "Надсилання повідомлень вимкнено для месенджера цієї групи."
        );
    }
    if let Some(send_messages) = send_messages {
        let mut group = group.into_active_model();
        group.send_messages = Set(Some(send_messages));
        group.update(txn).await.c(h!())?;
    }
    if let Some(sender_organism_ids) = sender_organism_ids {
        sigint_group_sender_organism::Entity::delete_many()
            .filter(
                sigint_group_sender_organism::Column::MasterKey.eq(master_key),
            )
            .exec(txn)
            .await
            .c(h!())?;
        for organism_id in sender_organism_ids
            .iter()
            .copied()
            .collect::<std::collections::BTreeSet<_>>()
        {
            sigint_group_sender_organism::ActiveModel {
                master_key: Set(master_key.to_owned()),
                organism_id: Set(organism_id),
            }
            .insert(txn)
            .await
            .c(h!())?;
        }
    }
    Ok(())
}
