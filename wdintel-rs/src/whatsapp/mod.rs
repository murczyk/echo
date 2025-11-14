use crate::entities::*;
use crate::messenger::id;
use crate::types::*;
use chrono::prelude::*;
use sea_orm::*;

pub mod types;

pub async fn receive_thread_nofail(
    settlements: Arc<RwLock<crate::location::SettlementsData>>,
    config: &crate::config::Config,
    dbx: &sea_orm::DatabaseConnection,
    redis: &mut redis::aio::ConnectionManager,
    datasource: &datasource::Model,
) {
    if config.whatsapp_api_phone.is_empty() {
        println!("> whatsapp::receive_thread_nofail: whatsapp_api_phone is empty, skipping");
        return;
    }
    let datasource_id = datasource.id;
    loop {
        let should_exit = datasource::Entity::find_by_id(datasource_id)
            .filter(datasource::Column::EchoClientLockId.is_not_null())
            .count(dbx)
            .await
            .c(h!())
            .unwrap_or(1)
            > 0;
        if should_exit {
            info!("datasource {datasource_id} is handled by echo-im, quitting legacy worker...");
            return;
        }
        if let Err(e) =
            receive_thread(settlements.clone(), config, dbx, redis, datasource)
                .await
        {
            println!("> whatsapp::receive_thread_nofail error: {e:?}");
        }
        tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
    }
}

async fn receive_thread(
    settlements: Arc<RwLock<crate::location::SettlementsData>>,
    config: &crate::config::Config,
    dbx: &sea_orm::DatabaseConnection,
    redis: &mut redis::aio::ConnectionManager,
    datasource: &datasource::Model,
) -> Result<(), AppError> {
    let rq: reqwest::Client = reqwest::Client::builder()
        .timeout(core::time::Duration::from_secs(
            crate::config::RQ_TIMEOUT_SIGNAL_API,
        ))
        .build()
        .c(h!())?;
    let mut last_groups_sync_t = std::time::SystemTime::now();
    if let Err(e) = sync_groups(dbx, datasource).await.c(h!()) {
        error!("failed to sync whatsapp groups: {e:?}");
    }

    loop {
        let groups_are_stale = last_groups_sync_t
            .elapsed()
            .map(|ts| ts.as_secs() > 60)
            .unwrap_or(true);
        if groups_are_stale {
            if let Err(e) = sync_groups(dbx, datasource).await.c(h!()) {
                error!("failed to sync whatsapp groups: {e:?}");
            } else {
                last_groups_sync_t = std::time::SystemTime::now();
            }
        }
        if let Err(e) = receive_once(
            settlements.clone(),
            config,
            dbx,
            &rq,
            redis,
            datasource,
        )
        .await
        {
            error!("failed to sync whatsapp messages: {e:?}");
        }

        tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
    }
}

async fn receive_once(
    settlements: Arc<RwLock<crate::location::SettlementsData>>,
    config: &crate::config::Config,
    dbx: &sea_orm::DatabaseConnection,
    rq: &reqwest::Client,
    redis: &mut redis::aio::ConnectionManager,
    datasource: &datasource::Model,
) -> Result<(), AppError> {
    let now = Utc::now();
    // created at least 3 seconds ago. needed to ensure images are downloaded. will rework properly eventually
    let whatsapp_queue = whatsapp_queue::Entity::find()
        .filter(
            whatsapp_queue::Column::CreatedAt
                .lte(now - chrono::Duration::seconds(3)),
        )
        .order_by_asc(whatsapp_queue::Column::Id)
        .limit(50)
        .all(dbx)
        .await
        .c(h!())?;
    for wq in whatsapp_queue {
        if wq.group_jid.is_empty() || wq.group_jid.ends_with("@s.whatsapp.net")
        {
            info!("deleting whatsapp queue entry: {wq:?}");
            wq.delete(dbx).await.c(h!())?;
            continue;
        }
        let txn = dbx.begin().await.c(h!())?;
        let body = wq.body.clone();
        // Normalize body
        let body = body.replace("\r\n", "\n");

        let datasource_group_id =
            crate::messenger::group::ensure_datasource_group_id(
                &txn,
                wq.group_jid.clone(),
                datasource.id,
            )
            .await
            .c(h!())?;

        let signal_message = signal_message::ActiveModel {
            id: NotSet,
            body: Set(Some(body.clone())),
            created_at: NotSet,
            timestamp: Set(Some(wq.timestamp)),
            sender: Set(Some(wq.from_jid.clone())),
            format: NotSet,
            deleted: Set(true),
            external_id: NotSet,
            message_uid: NotSet,
            duplicate_of: NotSet,
            datasource_group_id: Set(Some(datasource_group_id)),
        }
        .insert(&txn)
        .await
        .c(h!())?;

        let m_duplicate_of = crate::sigint::find_duplicate_of(
            &txn,
            &body,
            Some(wq.timestamp),
            signal_message.id,
            redis,
        )
        .await
        .c(h!())?;

        let res = crate::sigint::worker::unstage_message(
            &txn,
            &wq.group_jid,
            signal_message,
            m_duplicate_of,
        )
        .await
        .c(h!())?;
        if res.is_duplicate {
            wq.delete(&txn).await.c(h!())?;
            txn.commit().await.c(h!())?;
            return Ok(());
        };

        let signal_message =
            id::update_message_with_uid(&txn, config, res.message)
                .await
                .c(h!())?;

        if let Some(whatsapp_id) = wq.whatsapp_id.as_ref() {
            // attachments if any
            let attachments = whatsapp_queue_attachment::Entity::find()
                .filter(
                    whatsapp_queue_attachment::Column::WhatsappId
                        .eq(whatsapp_id),
                )
                .all(&txn)
                .await
                .c(h!())?;
            for a in attachments {
                let _signal_attachment = signal_attachment::ActiveModel {
                    id: NotSet,
                    signal_message_id: Set(signal_message.id),
                    path: Set(a.path.clone()),
                    created_at: NotSet,
                }
                .insert(&txn)
                .await
                .c(h!())?;
                a.delete(&txn).await.c(h!())?;
            }
        }

        crate::rer_importer::bgworker::inbox_item_oneoff_nofail(
            settlements.clone(),
            &txn,
            rq,
            config,
            redis,
            signal_message.id,
            None,
        )
        .await;

        crate::sigint::worker::incoming_message_after_insert(
            &txn,
            signal_message.id,
        )
        .await
        .c(h!())?;

        wq.delete(&txn).await.c(h!())?;
        txn.commit().await.c(h!())?;
    }
    Ok(())
}

pub async fn sync_groups(
    dbx: &sea_orm::DatabaseConnection,
    datasource: &datasource::Model,
) -> Result<(), AppError> {
    let whatsapp_groups = whatsapp_group::Entity::find()
        .filter(whatsapp_group::Column::Deleted.eq(false))
        .all(dbx)
        .await
        .c(h!())?;

    for wg in whatsapp_groups {
        let signal_group = signal_group::Entity::find()
            .filter(signal_group::Column::Deleted.eq(false))
            .filter(signal_group::Column::MasterKey.eq(wg.jid.clone()))
            .one(dbx)
            .await
            .c(h!())?;
        match signal_group {
            Some(signal_group) => {
                // update name
                if signal_group.name != Some(wg.name.clone())
                    && !wg.name.is_empty()
                {
                    info!(
                        "> whatsapp::sync_groups: updated signal_group {} - changed name from {} to {} ",
                        signal_group.master_key,
                        signal_group.name.clone().unwrap_or(String::from("<null>")),
                        wg.name.clone()
                    );
                    let mut signal_group = signal_group.into_active_model();
                    signal_group.name = Set(Some(wg.name.clone()));
                    signal_group.update(dbx).await.c(h!())?;
                }
            }
            None => {
                let group = signal_group::ActiveModel {
                    master_key: Set(wg.jid.clone()),
                    name: Set(Some(wg.name.clone())),
                    datasource_id: NotSet,
                    created_at: NotSet,
                    is_secret: Set(false),
                    ignore_operativny: Default::default(),
                    deleted: NotSet,
                };
                let signal_group =
                    crate::messenger::group::add_group(group, dbx)
                        .await
                        .c(h!())?;
                // ensure datasource_group mapping
                let _ = datasource_group::ActiveModel {
                    id: NotSet,
                    group_master_key: Set(signal_group.master_key.clone()),
                    datasource_id: Set(datasource.id),
                    last_sync_at: NotSet,
                    created_at: NotSet,
                    name: Set(wg.name.clone()),
                    deleted: NotSet,
                }
                .insert(dbx)
                .await
                .c(h!())?;
                println!(
                    "> whatsapp::sync_groups: created signal_group master_key={}, name={}",
                    signal_group.master_key, wg.name
                );
            }
        }
    }

    Ok(())
}
