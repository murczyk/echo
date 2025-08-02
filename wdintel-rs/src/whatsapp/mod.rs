use crate::entities::*;
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
    loop {
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
        .build()?;
    let mut last_groups_sync_t = std::time::SystemTime::now();

    loop {
        receive_once(settlements.clone(), config, dbx, &rq, redis, datasource)
            .await
            .context(h!())?;

        if last_groups_sync_t.elapsed().unwrap().as_secs() > 60 {
            sync_groups(dbx, datasource).await.context(h!())?;
            last_groups_sync_t = std::time::SystemTime::now();
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
        .context(h!())?;
    for wq in whatsapp_queue {
        if wq.group_jid.is_empty() {
            continue;
        }
        let txn = dbx.begin().await.context(h!())?;
        let body = wq.body.clone();
        // Normalize body
        let body = body.replace("\r\n", "\n");
        let m_duplicate = crate::sigint::find_duplicate(&txn, &body)
            .await
            .context(h!())?;
        let m_duplicate_id = m_duplicate.as_ref().map(|x| x.id);
        if config.read_from_legacy_data_sources.unwrap_or(true) {
            let signal_message = signal_message::ActiveModel {
                id: NotSet,
                body: Set(Some(body.clone())),
                created_at: NotSet,
                group_master_key: Set(Some(wq.group_jid.clone())),
                timestamp: Set(Some(wq.timestamp.clone())),
                sender: Set(Some(wq.from_jid.clone())),
                duplicate_of: Set(m_duplicate_id),
                format: NotSet,
                datasource_id: Set(Some(datasource.id)),
                deleted: NotSet,
            }
            .insert(&txn)
            .await
            .context(h!())?;

            if let Some(whatsapp_id) = wq.whatsapp_id.as_ref() {
                // attachments if any
                let attachments = whatsapp_queue_attachment::Entity::find()
                    .filter(
                        whatsapp_queue_attachment::Column::WhatsappId
                            .eq(whatsapp_id),
                    )
                    .all(&txn)
                    .await
                    .context(h!())?;
                for a in attachments {
                    let _signal_attachment = signal_attachment::ActiveModel {
                        id: NotSet,
                        signal_message_id: Set(signal_message.id),
                        path: Set(a.path.clone()),
                        created_at: NotSet,
                    }
                    .insert(&txn)
                    .await
                    .context(h!())?;
                    a.delete(&txn).await.context(h!())?;
                }
            }

            crate::rer_importer::bgworker::inbox_item_oneoff_nofail(
                settlements.clone(),
                &txn,
                &rq,
                &config,
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
            .context(h!())?;
        }
        wq.delete(&txn).await.context(h!())?;
        txn.commit().await.context(h!())?;
    }
    Ok(())
}

pub async fn sync_groups(
    dbx: &sea_orm::DatabaseConnection,
    datasource: &datasource::Model,
) -> Result<(), AppError> {
    let whatsapp_groups = whatsapp_group::Entity::find()
        .all(dbx)
        .await
        .context(h!())?;

    for wg in whatsapp_groups {
        let signal_group = signal_group::Entity::find()
            .filter(signal_group::Column::MasterKey.eq(wg.jid.clone()))
            .one(dbx)
            .await
            .context(h!())?;
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
                    signal_group.update(dbx).await.context(h!())?;
                }
            }
            None => {
                let signal_group = signal_group::ActiveModel {
                    master_key: Set(wg.jid.clone()),
                    name: Set(Some(wg.name.clone())),
                    created_at: NotSet,
                    is_secret: Set(false),
                    datasource_id: Set(Some(datasource.id)),
                    ignore_operativny: Default::default(),
                }
                .insert(dbx)
                .await
                .context(h!())?;
                println!(
                    "> whatsapp::sync_groups: created signal_group master_key={}, name={}",
                    signal_group.master_key, wg.name
                );
            }
        }
    }

    Ok(())
}
