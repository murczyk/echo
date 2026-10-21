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
        C: ConnectionTrait,
    {
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
            Some(read_settlement_ids(dbx, item_id).await.c(h!())?)
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
        C: ConnectionTrait,
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

async fn read_settlement_ids<C>(
    dbx: &C,
    item_id: i64,
) -> anyhow::Result<BTreeSet<i32>>
where
    C: ConnectionTrait,
{
    sigint_inbox_item_settlement::Entity::find()
        .filter(sigint_inbox_item_settlement::Column::ItemId.eq(item_id))
        .filter(
            sigint_inbox_item_settlement::Column::SettlementId.is_not_null(),
        )
        .select_only()
        .column(sigint_inbox_item_settlement::Column::SettlementId)
        .into_tuple::<i32>()
        .all(dbx)
        .await
        .c(h!())
        .map(|ids| ids.into_iter().collect())
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
