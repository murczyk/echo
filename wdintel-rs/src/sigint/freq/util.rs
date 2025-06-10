use crate::entities::sigint_network_freq;
use chrono::NaiveDateTime;
use echo_migration::SimpleExpr;
use sea_orm::ColumnTrait;

pub fn filter_by_active_ts(
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> SimpleExpr {
    let no_active_to = sigint_network_freq::Column::ActiveTo.is_null();
    let active_to_ok =
        sigint_network_freq::Column::ActiveTo.gte(dt_since.clone());
    let filter_active_to = no_active_to.or(active_to_ok);
    let filter_from =
        sigint_network_freq::Column::ActiveFrom.lte(dt_till.clone());

    let filter_active_ts = filter_active_to.and(filter_from);
    filter_active_ts
}
