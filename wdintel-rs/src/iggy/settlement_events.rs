use crate::entities::sigint_inbox_item_settlement;
use crate::types::*;
use sea_orm::*;

pub(crate) struct SettlementLinkEvents {
    item_id: i64,
    previous_settlement_ids: Option<BTreeSet<i32>>,
}

impl SettlementLinkEvents {
    pub(crate) async fn capture<C>(
        dbx: &C,
        item_id: i64,
    ) -> anyhow::Result<Self>
    where
        C: ConnectionTrait + TransactionSession,
    {
        let settlement_ids = read_settlement_ids(dbx, item_id).await.c(h!())?;
        let publisher = dbx
            .query_one_raw(Statement::from_string(
                DatabaseBackend::Postgres,
                "select api_integration_iggy_has_publisher() as enabled",
            ))
            .await
            .c(h!())?
            .c(h!())?
            .try_get::<bool>("", "enabled")
            .c(h!())?;
        let previous_settlement_ids = if publisher {
            Some(settlement_ids)
        } else {
            None
        };
        Ok(Self {
            item_id,
            previous_settlement_ids,
        })
    }

    pub(crate) async fn enqueue_changes<C>(self, dbx: &C) -> anyhow::Result<()>
    where
        C: ConnectionTrait + TransactionSession,
    {
        let Some(previous) = self.previous_settlement_ids else {
            return Ok(());
        };
        let current = read_settlement_ids(dbx, self.item_id).await.c(h!())?;
        for settlement_id in previous.difference(&current) {
            enqueue_event(
                dbx,
                self.item_id,
                *settlement_id,
                "sigint_inbox_item_settlement_unlinked",
            )
            .await
            .c(h!())?;
        }
        for settlement_id in current.difference(&previous) {
            enqueue_event(
                dbx,
                self.item_id,
                *settlement_id,
                "sigint_inbox_item_settlement_linked",
            )
            .await
            .c(h!())?;
        }
        Ok(())
    }
}

pub(crate) async fn persist_settlement_resolution<C>(
    dbx: &C,
    row: sigint_inbox_item_settlement::Model,
    settlement_id: Option<i32>,
) -> anyhow::Result<i64>
where
    C: ConnectionTrait + TransactionTrait,
{
    let txn = dbx.begin().await.c(h!())?;
    let item_id = row.item_id;
    let events = SettlementLinkEvents::capture(&txn, item_id).await.c(h!())?;
    let matched = settlement_id.is_some();
    let mut row = row.into_active_model();
    row.settlement_id = Set(settlement_id);
    row.is_undefined = Set(Some(!matched));
    row.update(&txn).await.c(h!())?;
    events.enqueue_changes(&txn).await.c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(item_id)
}

async fn read_settlement_ids<C>(
    dbx: &C,
    item_id: i64,
) -> anyhow::Result<BTreeSet<i32>>
where
    C: ConnectionTrait,
{
    sigint_inbox_item_settlement::Entity::find()
        .filter(sigint_inbox_item_settlement::Column::ItemId.eq(item_id))
        .order_by_asc(sigint_inbox_item_settlement::Column::Id)
        .lock(sea_orm::sea_query::LockType::Update)
        .select_only()
        .column(sigint_inbox_item_settlement::Column::SettlementId)
        .into_tuple::<Option<i32>>()
        .all(dbx)
        .await
        .c(h!())
        .map(|ids| ids.into_iter().flatten().collect())
}

async fn enqueue_event<C>(
    dbx: &C,
    item_id: i64,
    settlement_id: i32,
    event_type: &str,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    dbx.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "select queue_api_integration_iggy_event($1, $2)",
        [
            item_id.into(),
            serde_json::json!({
                "event_type": event_type,
                "settlement_id": settlement_id,
            })
            .into(),
        ],
    ))
    .await
    .c(h!())?;
    Ok(())
}
