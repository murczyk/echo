use crate::entities::*;
use crate::error::{AppError, ContextAndError};
use crate::h;
use crate::messenger::bl::list_linked_accounts;
use crate::messenger::types::EchoAccountF1;
use crate::types::Env;
use anyhow::Context;
use chrono::*;
use echo_im::types::{MessageF1, MessageSource, SendMessageReq};
use log::*;
use sea_orm::*;
use std::collections::BTreeMap;
use std::sync::{Arc, RwLock};

pub async fn receive_thread_nofail(
    env: Arc<Env>,
) {
    if let Err(e) =
        echo_im::enable_verbose_logging_for_all_signal_clients(&env.dbx).await
    {
        error!("failed to enable verbose logging: {:?}", e);
    };
    let mut client_groups_sync_ts_map =
        BTreeMap::<String, NaiveDateTime>::new();
    loop {
        let clients = match list_clients(&env.dbx).await {
            Ok(txn) => txn,
            Err(e) => {
                error!("failed to load clients: {e:?}");
                continue;
            }
        };
        for cli in clients {
            let client_name = cli.name;
            if let Err(e) = receive_thread(
               env.clone(),
                &client_name,
                &mut client_groups_sync_ts_map,
            )
            .await
            {
                println!("> {client_name}::receive_thread_nofail error: {e:?}");
            }
        }
        tokio::time::sleep(tokio::time::Duration::from_secs(10)).await;
    }
}

async fn receive_thread(
    env: Arc<Env>,
    client_name: &str,
    client_groups_sync_ts_map: &mut BTreeMap<String, NaiveDateTime>,
) -> Result<(), AppError> {
    echo_im::worker::signal_worker_tick_once(client_name, &env.dbx)
        .await
        .context(h!())?;
    echo_im::worker::whatsapp_worker_tick_once(client_name, &env.dbx)
        .await
        .context(h!())?;
    let txn = (&env.dbx).begin().await.context(h!())?;
    sync_groups(&txn, client_name, client_groups_sync_ts_map)
        .await
        .context(h!())?;
    txn.commit().await.context(h!())?;
    sync_inbox(Utc::now(), &env.dbx, client_name, env.clone())
        .await
        .context(h!())?;
    tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
    Ok(())
}

async fn sync_groups(
    txn: &DatabaseTransaction,
    client_name: &str,
    client_groups_sync_ts_map: &mut BTreeMap<String, NaiveDateTime>,
) -> anyhow::Result<()> {
    let now = Utc::now().naive_utc();
    if let Some(last_updated_ts) =
        client_groups_sync_ts_map.get(client_name).cloned()
    {
        let stale_at = last_updated_ts + chrono::TimeDelta::minutes(2);
        if now <= stale_at {
            return Ok(()); // already in sync
        }
    }
    let unsorted_groups =
        echo_im::list_groups(client_name, txn).await.context(h!())?;
    let mut groups = vec![];
    let mut deleted_groups = vec![];
    for g in unsorted_groups {
        if g.deleted_by_messenger {
            deleted_groups.push(g);
        } else {
            groups.push(g);
        }
    }
    let group_master_keys =
        groups.iter().map(|x| x.id.clone()).collect::<Vec<_>>();
    let mut existing_groups = BTreeMap::new();
    let groups_raw = signal_group::Entity::find()
        .filter(signal_group::Column::MasterKey.is_in(group_master_keys))
        .all(txn)
        .await
        .cae(h!())?;
    for g in groups_raw {
        if let Some(master_key) = &g.master_key {
            let key = master_key.clone();
            match existing_groups.get(master_key) {
                None => {
                    existing_groups.insert(key, g);
                }
                Some(g2) => {
                    if g.created_at > g2.created_at {
                        existing_groups.insert(key, g);
                    } else {
                        existing_groups.insert(key, g2.clone());
                    }
                }
            }
        }
    }

    for g in groups {
        match existing_groups.remove(&g.id.clone()) {
            None => match g.message_source {
                MessageSource::Signal => {
                    signal_group::ActiveModel {
                        name: Set(g.name),
                        datasource_id: NotSet,
                        created_at: NotSet,
                        ignore_operativny: NotSet,
                        master_key: Set(Some(g.id.clone())),
                        is_secret: NotSet,
                    }
                    .insert(txn)
                    .await
                    .context(h!())?;
                }
                MessageSource::Whatsapp => {
                    whatsapp_group::ActiveModel {
                        name: Set(g.name),
                        created_at: NotSet,
                        jid: Set(Some(g.id.clone())),
                        owner_jid: NotSet,
                    }
                    .insert(txn)
                    .await
                    .context(h!())?;
                }
            },
            Some(group_model) => {
                if group_model.name != g.name {
                    let mut model = group_model.into_active_model();
                    model.name = Set(g.name.clone());
                    model.update(txn).await.context(h!())?;
                }
            }
        }
    }

    let mut signal_ids_to_delete = vec![];
    let mut whatsapp_ids_to_delete = vec![];
    for g in deleted_groups {
        if !g.id.is_empty() {
            signal_ids_to_delete.push(g.id.clone());
            if g.message_source == MessageSource::Whatsapp {
                whatsapp_ids_to_delete.push(g.id);
            }
        }
    }
    if !signal_ids_to_delete.is_empty() {
        signal_group::Entity::delete_many()
            .filter(signal_group::Column::MasterKey.is_in(signal_ids_to_delete))
            .exec(txn)
            .await
            .context(h!())?;
    }
    if !whatsapp_ids_to_delete.is_empty() {
        whatsapp_group::Entity::delete_many()
            .filter(whatsapp_group::Column::Jid.is_in(whatsapp_ids_to_delete))
            .exec(txn)
            .await
            .context(h!())?;
    }
    client_groups_sync_ts_map.insert(client_name.to_string(), now);
    Ok(())
}
async fn sync_inbox(
    inbox_sync_at: DateTime<Utc>,
    db: &DatabaseConnection,
    client_name: &str,
    env: Arc<Env>,
) -> anyhow::Result<()> {
    debug!("syncing inbox for client_name={client_name}");
    // let time = inbox_sync_at;
    let time = inbox_sync_at - TimeDelta::seconds(100); // double-check maybe we missed messages not labeled as seen
    let txn = db.begin().await.context(h!())?;
    let inbox_messages =
        echo_im::list_inbox_since(client_name, time.naive_utc(), &txn)
            .await
            .context(h!())?;
    txn.commit().await.context(h!())?;

    for (i, m) in inbox_messages.iter().enumerate() {
        {
            debug!(
                "processing inbox message {} of {}; m.id={}",
                i + 1,
                inbox_messages.len(),
                m.id.clone().unwrap_or("".to_string())
            );
            let txn = db.begin().await.context(h!())?;
            process_inbox_message_nofail(
                &txn,
                client_name,
                env.clone(),
                m.clone(),
            )
            .await;
            echo_im::mark_inbox_as_seen(client_name, vec![m.internal_id], &txn)
                .await
                .context(h!())?;
            txn.commit().await.context(h!())?;
        }
    }
    Ok(())
}

async fn process_inbox_message_nofail(
    txn: &DatabaseTransaction,
    client_name: &str,
    env: Arc<Env>,
    m: MessageF1,
) {
    debug!(
        "process_inbox_message_nofail client_name={}; message_id={}",
        client_name,
        m.id.clone().unwrap_or("".to_string())
    );
    // let current_time = Utc::now().naive_utc();
    // if m.timestamp < current_time - TimeDelta::minutes(15) {
    //     warn!(
    //         "[{}] message is too old: created at {}, current time: {}; skipping: [{}] {}",
    //         client_name, m.timestamp, current_time, m.internal_id, m.text
    //     );
    //     return;
    // }
    let process_result =
        try_process_message(&m, client_name, txn, env.clone()).await;
    match process_result {
        Err(e) => {
            warn!("bot failed to process a message: {:?}", e)
        }
        Ok(result) => {
            if result {
                return;
            } else {
                if let Some(phone_number) = &m.sender_phone_number {
                    if let Err(e) = maybe_respond_plusplus(
                        txn,
                        phone_number,
                        &m,
                        client_name,
                        env.clone(),
                    )
                    .await
                    .context(h!())
                    {
                        error!("failed to exchange ++: {:?}", e);
                    }
                }
            }
        }
    }
}

pub async fn maybe_respond_plusplus(
    txn: &DatabaseTransaction,
    phone: &String,
    message: &MessageF1,
    client_name: &str,
    env: Arc<Env>,
) -> Result<(), AppError> {
    if message.text.trim() == "+" && message.group_id.is_none() {
        let recipient_phone_numbers = vec![phone.to_string()];
        let req = SendMessageReq {
            source: message.message_source.clone(),
            text: String::from("+"),
            recipient_phone_numbers,
            group_ids: vec![],
            attachments: vec![],
        };
        echo_im::send_message(
            req,
            client_name,
            txn,
            env.config.echo_im_config.clone(),
        )
        .await
        .map_err(Into::<AppError>::into)
        .context(h!())?;
    }
    Ok(())
}

async fn list_clients(
    dbx: &DatabaseConnection,
) -> anyhow::Result<Vec<EchoAccountF1>> {
    let txn = dbx.begin().await.context(h!())?;
    let live_clients = list_linked_accounts(&txn).await.context(h!())?;
    txn.commit().await.context(h!())?;
    Ok(live_clients)
}
