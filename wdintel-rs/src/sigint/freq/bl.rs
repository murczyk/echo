use crate::entities::*;
use crate::error::AppError;
use crate::rer_importer::analysis::message_in_groups_exists;
use crate::types::*;
use crate::utils::*;
use sea_orm::{
    sea_query::{extension::postgres::PgExpr, PostgresQueryBuilder},
    *,
};
use sea_query::{Alias, CommonTableExpression, Expr, Query};

use super::types::*;

pub async fn bl_callsigns_for_filter(
    dbx: &DatabaseConnection,
    user_id: &str,
    req: &CallsignsForFreqReq,
) -> Result<Vec<FreqCallsign>, AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms)?;
    let dt_till = dt_from_millis(req.till_date_noninclusive_ms)?;

    let master_keys =
        crate::messenger::group::get_identity_sigint_groups(dbx, user_id)
            .await
            .c(h!())?;

    let callsign_alias = Alias::new("callsign");
    let mut q = Query::select();
    q.expr_as(
        Expr::cust("jsonb_array_elements_text(sigint_inbox_item.callsigns)"),
        callsign_alias.clone(),
    )
    .from(sigint_inbox_item::Entity)
    .inner_join(
        signal_message::Entity,
        Expr::col((sigint_inbox_item::Entity, sigint_inbox_item::Column::Id))
            .equals((signal_message::Entity, signal_message::Column::Id)),
    )
    .and_where(message_in_groups_exists(master_keys))
    .and_where(signal_message::Column::Deleted.eq(false))
    .and_where(sigint_inbox_item::Column::Callsigns.is_not_null())
    .and_where(sigint_inbox_item::Column::Datetime.gte(dt_since))
    .and_where(sigint_inbox_item::Column::Datetime.lt(dt_till));
    if let Some(freq) = &req.freq {
        q.and_where(sigint_inbox_item::Column::Freq.like(format!("{freq}%")));
    };

    if let Some(unit) = &req.unit {
        q.and_where(
            Expr::col(sigint_inbox_item::Column::UnitV2)
                .ilike(format!("{unit}%")),
        );
    };

    let cte_alias = Alias::new("callsigns_cte");
    let callsigns_cte = CommonTableExpression::new()
        .query(q.to_owned())
        .table_name(cte_alias.clone())
        .to_owned();

    let mut main_query = Query::select();
    main_query
        .distinct()
        .from(cte_alias.clone())
        .column(callsign_alias.clone())
        .order_by(callsign_alias.clone(), Order::Asc);
    if let Some(callsign) = &req.callsign {
        main_query.and_where(
            Expr::col(Alias::new("callsign"))
                .like(format!("{}%", callsign.trim().to_lowercase())),
        );
    }

    let combined_query =
        Query::with().cte(callsigns_cte).clone().query(main_query);

    let stmt = combined_query.to_string(PostgresQueryBuilder);

    // debug!("callsigns filter sql: {stmt}");

    let res = dbx
        .query_all(Statement::from_string(DbBackend::Postgres, stmt))
        .await
        .c(h!())?
        .into_iter()
        .map(|r| FreqCallsign {
            callsign: r.try_get("", "callsign").unwrap_or_default(),
        })
        .filter(|r| !r.callsign.is_empty())
        .collect();

    Ok(res)
}
