use std::time::Duration;

use crate::entities::*;
use crate::event_stream::fanout_mult;
use crate::event_stream::types::{EventMsg, EventType};
use crate::inbox::resolve_message_aor_ids_by_group;
use crate::palitra::types::PalitraAccess;
use crate::rer_importer::points::{
    build_palitra_access_filter, build_palitra_pattern, highlight_points,
};
use crate::rer_importer::types::PalitraPattern;
use crate::types::*;
use crate::utils::orm::ArrayColumnOps;
use sea_orm::prelude::*;
use sea_orm::*;
use tokio::sync::RwLock;

const PALITRA_WORKER_MESSAGES_PER_BATCH: usize = 50;

#[derive(Default)]
pub struct PalitraPatternCache {
    data: HashMap<i64, PalitraPattern>,
}

#[derive(Default)]
pub struct PalitraWorkerContext {
    pattern_cache: RwLock<PalitraPatternCache>,
}

impl PalitraWorkerContext {
    pub async fn flush_cache(&self, palitra_id: i64) {
        let mut lock = self.pattern_cache.write().await;
        lock.data.remove(&palitra_id);
    }

    pub async fn get_pattern<'async_trait, C>(
        &self,
        txn: &C,
        palitra_id: i64,
    ) -> anyhow::Result<PalitraPattern>
    where
        C: ConnectionTrait + 'async_trait,
    {
        {
            let lock = self.pattern_cache.read().await;

            if let Some(pattern) = lock.data.get(&palitra_id) {
                return Ok(pattern.clone());
            }
        }

        let mut lock = self.pattern_cache.write().await;
        let pattern = build_palitra_pattern(txn, palitra_id).await?;
        let inserted = lock.data.entry(palitra_id).or_insert(pattern).clone();
        Ok(inserted)
    }
}

pub async fn palitra_highlight_worker_nofail(
    rq: &reqwest::Client,
    dbx: &DatabaseConnection,
    redis: &mut redis::aio::ConnectionManager,
    context: &Arc<PalitraWorkerContext>,
) {
    loop {
        let no_messages = match palitra_highlight_worker_impl(
            rq, dbx, redis, context,
        )
        .await
        {
            Ok(no_messages) => no_messages,
            Err(e) => {
                log::error!("palitra_highlight_worker error: {e}");
                false
            }
        };

        if no_messages {
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    }
}

async fn palitra_highlight_worker_impl(
    rq: &reqwest::Client,
    dbx: &DatabaseConnection,
    redis: &mut redis::aio::ConnectionManager,
    context: &Arc<PalitraWorkerContext>,
) -> anyhow::Result<bool> {
    let subquery = format!(
        r#"
        SELECT "sigint_inbox_item_id" FROM "palitra_highlight_worker_job"
        ORDER BY "sigint_inbox_item_id"
        FOR UPDATE SKIP LOCKED
        LIMIT {PALITRA_WORKER_MESSAGES_PER_BATCH}
        "#
    );

    let expr = Expr::cust(format!("sigint_inbox_item_id IN ({subquery})"));

    let txn = dbx.begin().await?;
    let message_ids: Vec<i64> =
        palitra_highlight_worker_job::Entity::delete_many()
            .filter(expr)
            .exec_with_returning(&txn)
            .await
            .c(h!())?
            .into_iter()
            .map(|item| item.sigint_inbox_item_id)
            .collect();

    let no_messages = message_ids.is_empty();
    let (_total, changed_message_ids) = if !no_messages {
        do_palitra_highlight(message_ids, rq, &txn, context).await?
    } else {
        (0, vec![])
    };

    txn.commit().await?;
    let events: Vec<EventMsg> = changed_message_ids
        .into_iter()
        .map(EventType::ETInboxChanged)
        .map(EventMsg::new)
        .collect();
    fanout_mult(redis, events).await.c(h!())?;

    Ok(no_messages)
}

pub async fn do_palitra_highlight<'a, C>(
    message_ids: Vec<i64>,
    rq: &reqwest::Client,
    txn: &'a C,
    context: &Arc<PalitraWorkerContext>,
) -> anyhow::Result<(u64, Vec<i64>)>
where
    C: ConnectionTrait + 'a,
{
    let messages = signal_message::Entity::find()
        .filter(signal_message::Column::Id.eq_any(message_ids.clone()))
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintInboxItemPointToken.def(),
        )
        .filter(signal_message::Column::Body.is_not_null())
        .filter(signal_message::Column::Body.ne(""))
        .filter(sigint_inbox_item_point_token::Column::Id.is_null())
        .select_only()
        .column(signal_message::Column::Id)
        .column(signal_message::Column::Body)
        .into_tuple::<(i64, Option<String>)>()
        .all(txn)
        .await
        .c(h!())?;

    let message_networks = sigint_inbox_item_network::Entity::find()
        .filter(
            sigint_inbox_item_network::Column::SigintInboxItemId
                .eq_any(message_ids),
        )
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item_network::Relation::SigintNetwork.def(),
        )
        .filter(sigint_network::Column::Deleted.eq(false))
        .select_only()
        .column(sigint_inbox_item_network::Column::SigintInboxItemId)
        .column(sigint_inbox_item_network::Column::SigintNetworkId)
        .into_tuple::<(i64, i64)>()
        .all(txn)
        .await
        .c(h!())?;

    let mut message_networks_map: HashMap<i64, Vec<i64>> = HashMap::new();
    for (message_id, network_id) in message_networks {
        message_networks_map
            .entry(message_id)
            .or_default()
            .push(network_id);
    }

    let mut changed_message_ids = Vec::new();
    let mut total = 0;
    for (message_id, message_body) in messages {
        let Some(body) = message_body else {
            continue;
        };

        let network_ids: Vec<i64> =
            message_networks_map.remove(&message_id).unwrap_or_default();

        let mut palitra_aor_ids =
            resolve_aor_ids_by_networks(txn, network_ids).await?;

        if palitra_aor_ids.is_empty() {
            palitra_aor_ids =
                resolve_message_aor_ids_by_group(txn, message_id).await?;
        }

        let exact = false;
        let access = PalitraAccess::ByAor {
            aor_ids: palitra_aor_ids,
        };

        let palitra_ids: Vec<i64> = palitra::Entity::find()
            .filter(palitra::Column::Deleted.eq(false))
            .filter(build_palitra_access_filter(access, exact))
            .select_only()
            .column(palitra::Column::Id)
            .into_tuple::<i64>()
            .all(txn)
            .await?;

        let mut patterns = Vec::with_capacity(palitra_ids.len());
        for palitra_id in palitra_ids {
            let pattern = context.get_pattern(txn, palitra_id).await?;
            patterns.push(pattern);
        }

        let message_palitra_highlights =
            highlight_points(rq, &body, &patterns).await?;
        let inbox_item_point_tokens: Vec<_> = message_palitra_highlights
            .iter()
            .map(|highlight| {
                let point_tokens = serde_json::json!(&highlight.points);
                sigint_inbox_item_point_token::ActiveModel {
                    palitra_id: Set(highlight.palitra_id),
                    point_tokens: Set(point_tokens),
                    sigint_inbox_item_id: Set(message_id),
                    ..Default::default()
                }
            })
            .collect();
        if !inbox_item_point_tokens.is_empty() {
            let count = sigint_inbox_item_point_token::Entity::insert_many(
                inbox_item_point_tokens,
            )
            .on_conflict(
                sea_query::OnConflict::columns([
                    sigint_inbox_item_point_token::Column::SigintInboxItemId,
                    sigint_inbox_item_point_token::Column::PalitraId,
                ])
                .do_nothing()
                .to_owned(),
            )
            .exec_without_returning(txn)
            .await
            .c(h!())?;
            total += count;
            if count > 0 {
                changed_message_ids.push(message_id);
            }
        }
    }

    Ok((total, changed_message_ids))
}

async fn resolve_aor_ids_by_networks<'a, 'async_trait, C>(
    txn: &'a C,
    network_ids: Vec<i64>,
) -> Result<Vec<i64>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    if network_ids.is_empty() {
        return Ok(vec![]);
    };
    let m_aor_ids = sigint_network::Entity::find()
        .filter(sigint_network::Column::Id.eq_any(network_ids))
        .filter(sigint_network::Column::Deleted.eq(false))
        .join(
            JoinType::InnerJoin,
            sigint_network::Relation::SigintNetworkAor.def(),
        )
        .join(
            JoinType::InnerJoin,
            sigint_network_aor::Relation::AreaOfResponsibility.def(),
        )
        .filter(area_of_responsibility::Column::Deleted.eq(false))
        .select_only()
        .column(area_of_responsibility::Column::Id)
        .into_tuple::<i64>()
        .all(txn)
        .await
        .c(h!())?;
    Ok(m_aor_ids)
}
