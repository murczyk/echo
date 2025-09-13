use crate::entities::*;
use crate::error::AppError;
use crate::h;
use crate::types::Mode;
use anyhow::Context;
use chrono::Utc;
use echo_migration::JoinType;
use sea_orm::*;
use std::sync::{Arc, RwLock};

pub async fn run_operator_inbox_worker_nofail(mode: Mode) {
    let (config, settlements, rq, mut redis, dbx) =
        crate::utils::setup_worker(mode).await.unwrap();
    let mut all_datasources = vec![];
    let mut datasource_list_next_sync_at = Utc::now().naive_utc();
    loop {
        let now = Utc::now().naive_utc();
        if datasource_list_next_sync_at <= now {
            datasource_list_next_sync_at =
                (Utc::now() + tokio::time::Duration::from_secs(5)).naive_utc();
            all_datasources = datasource::Entity::find()
                .filter(datasource::Column::Kind.eq("echo_operator"))
                .order_by_asc(datasource::Column::Id)
                .all(&dbx)
                .await
                .context(h!())
                .unwrap_or(vec![]);
        }
        if all_datasources.is_empty() {
            tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
            continue;
        }
        for datasource in all_datasources.iter() {
            if let Err(e) = receive_once(
                settlements.clone(),
                &config,
                &dbx,
                &rq,
                &mut redis,
                datasource,
            )
            .await
            .context(h!())
            {
                println!("> echo_operator::receive_thread_nofail error: {e:?}");
            }
        }
    }
}

async fn receive_once(
    settlements: Arc<RwLock<crate::location::SettlementsData>>,
    config: &crate::config::Config,
    dbx: &DatabaseConnection,
    rq: &reqwest::Client,
    redis: &mut redis::aio::ConnectionManager,
    datasource: &datasource::Model,
) -> Result<(), AppError> {
    let now = Utc::now();
    let echo_operator_queue = signal_message::Entity::find()
        .select_only()
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::DatasourceGroup.def(),
        )
        .column(signal_message::Column::Id)
        .join(
            JoinType::LeftJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .filter(sigint_inbox_item::Column::Id.is_null())
        .filter(datasource_group::Column::DatasourceId.eq(datasource.id))
        .filter(
            signal_message::Column::CreatedAt
                .lte(now - chrono::Duration::seconds(3)),
        )
        .order_by_asc(signal_message::Column::CreatedAt)
        .limit(50)
        .into_tuple::<i64>()
        .all(dbx)
        .await
        .context(h!())?;
    for id in echo_operator_queue {
        let txn = dbx.begin().await.context(h!())?;
        crate::rer_importer::bgworker::inbox_item_oneoff_nofail(
            settlements.clone(),
            &txn,
            rq,
            config,
            redis,
            id,
            None,
        )
        .await;

        crate::sigint::worker::incoming_message_after_insert(&txn, id)
            .await
            .context(h!())?;
        txn.commit().await.context(h!())?;
    }
    Ok(())
}
