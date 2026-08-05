use crate::entities::{sigint_inbox_item, sigint_network_freq};
use chrono::NaiveDateTime;
use echo_migration::SimpleExpr;
use sea_orm::{ColumnTrait, EntityTrait, ExprTrait, RelationDef};

pub(crate) fn inbox_item_network_freq_relation() -> RelationDef {
    sigint_inbox_item::Entity::belongs_to(sigint_network_freq::Entity)
        .from(sigint_inbox_item::Column::Freq)
        .to(sigint_network_freq::Column::Freq)
        .into()
}

pub fn filter_by_active_ts(
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> SimpleExpr {
    let no_active_to = sigint_network_freq::Column::ActiveTo.is_null();
    let active_to_ok = sigint_network_freq::Column::ActiveTo.gte(dt_since);
    let filter_active_to = no_active_to.or(active_to_ok);
    let filter_from = sigint_network_freq::Column::ActiveFrom.lte(dt_till);

    filter_active_to
        .and(filter_from)
        .and(sigint_network_freq::Column::Deleted.eq(false))
}
