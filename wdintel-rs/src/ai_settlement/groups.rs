use super::types::AiSettlementGroupItem;
use crate::entities::{
    ai_settlement_settings, signal_group, signal_message_group,
};
use crate::{h, types::ShortContext};
use sea_orm::sea_query::{Expr, ExprTrait, Query, SimpleExpr};
use sea_orm::{
    ColumnTrait, ConnectionTrait, DatabaseTransaction, EntityTrait,
    QueryFilter, QueryOrder, QuerySelect,
};

#[derive(Clone, Default)]
pub(super) struct GroupFilter {
    pub except: bool,
    pub master_keys: Vec<String>,
}

impl GroupFilter {
    pub fn from_settings(settings: &ai_settlement_settings::Model) -> Self {
        Self {
            except: settings.worker_groups_except.unwrap_or_default(),
            master_keys: settings
                .worker_group_master_keys
                .clone()
                .unwrap_or_default(),
        }
    }

    pub fn condition(&self, message_id: SimpleExpr) -> Option<SimpleExpr> {
        if self.master_keys.is_empty() {
            return None;
        }
        let membership = Expr::exists(
            Query::select()
                .expr(Expr::val(1))
                .from(signal_message_group::Entity)
                .and_where(
                    Expr::col((
                        signal_message_group::Entity,
                        signal_message_group::Column::SignalMessageId,
                    ))
                    .eq(message_id),
                )
                .and_where(
                    signal_message_group::Column::GroupMasterKey
                        .is_in(self.master_keys.clone()),
                )
                .to_owned(),
        );
        Some(if self.except {
            membership.not()
        } else {
            membership
        })
    }

    pub async fn allows<C: ConnectionTrait>(
        &self,
        dbx: &C,
        message_id: i64,
    ) -> anyhow::Result<bool> {
        if self.master_keys.is_empty() {
            return Ok(true);
        }
        let belongs = signal_message_group::Entity::find()
            .filter(
                signal_message_group::Column::SignalMessageId.eq(message_id),
            )
            .filter(
                signal_message_group::Column::GroupMasterKey
                    .is_in(self.master_keys.clone()),
            )
            .select_only()
            .column(signal_message_group::Column::Id)
            .into_tuple::<i64>()
            .one(dbx)
            .await
            .c(h!())?
            .is_some();
        Ok(belongs != self.except)
    }
}

pub(super) async fn list_active_groups<C: ConnectionTrait>(
    dbx: &C,
) -> anyhow::Result<Vec<AiSettlementGroupItem>> {
    signal_group::Entity::find()
        .filter(signal_group::Column::Deleted.eq(false))
        .filter(signal_group::Column::IsArchived.eq(false))
        .select_only()
        .columns([signal_group::Column::MasterKey, signal_group::Column::Name])
        .order_by_asc(signal_group::Column::Name)
        .order_by_asc(signal_group::Column::MasterKey)
        .into_model::<AiSettlementGroupItem>()
        .all(dbx)
        .await
        .c(h!())
}

pub(super) async fn validate_groups(
    transaction: &DatabaseTransaction,
    master_keys: &[String],
) -> anyhow::Result<bool> {
    if master_keys.is_empty() {
        return Ok(true);
    }
    let groups = signal_group::Entity::find()
        .filter(signal_group::Column::MasterKey.is_in(master_keys.to_vec()))
        .filter(signal_group::Column::Deleted.eq(false))
        .filter(signal_group::Column::IsArchived.eq(false))
        .select_only()
        .column(signal_group::Column::MasterKey)
        .lock_shared()
        .into_tuple::<String>()
        .all(transaction)
        .await
        .c(h!())?;
    Ok(groups.len() == master_keys.len())
}
