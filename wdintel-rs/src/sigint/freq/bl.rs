use crate::entities::*;
use crate::error::AppError;
use crate::rer_importer::analysis::message_in_groups_exists;
use crate::types::*;
use crate::utils::*;
use sea_orm::{sea_query::extension::postgres::PgExpr, *};
use sea_query::Expr;

use super::types::*;

pub async fn bl_callsigns_for_filter(
    dbx: &DatabaseConnection,
    user_id: &uuid::Uuid,
    req: &CallsignsForFreqReq,
) -> Result<Vec<FreqCallsign>, AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms)?;
    let dt_till = dt_from_millis(req.till_date_noninclusive_ms)?;

    let master_keys =
        crate::messenger::group::get_identity_sigint_groups(dbx, user_id)
            .await
            .c(h!())?;

    let mut query = sigint_inbox_item::Entity::find()
        .select_only()
        .distinct()
        .column(sigint_inbox_item::Column::Id)
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .filter(message_in_groups_exists(master_keys))
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till))
        .filter(Expr::cust(crate::inbox::callsigns::sql_exists_condition(
            "sigint_inbox_item",
        )));
    if let Some(freq) = &req.freq {
        query = query
            .filter(sigint_inbox_item::Column::Freq.like(format!("{freq}%")));
    };

    if let Some(unit) = &req.unit {
        query = query.filter(
            Expr::col(sigint_inbox_item::Column::UnitV2)
                .ilike(format!("{unit}%")),
        );
    };
    let inbox_item_ids = query.into_tuple::<i64>().all(dbx).await.c(h!())?;
    let callsigns =
        crate::inbox::callsigns::load_by_item_ids(dbx, &inbox_item_ids).await?;
    let callsign_prefix = req
        .callsign
        .as_deref()
        .map(str::trim)
        .map(str::to_lowercase);
    let mut callsigns = inbox_item_ids
        .into_iter()
        .filter_map(|inbox_item_id| callsigns.get(&inbox_item_id))
        .flat_map(|callsigns| callsigns.effective())
        .filter(|callsign| !callsign.is_empty())
        .filter(|callsign| {
            callsign_prefix
                .as_ref()
                .is_none_or(|prefix| callsign.starts_with(prefix))
        })
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    callsigns.sort();
    Ok(callsigns
        .into_iter()
        .map(|callsign| FreqCallsign { callsign })
        .collect())
}
