use crate::entities::*;
use crate::sigint::network::types::ListNetworksSortBy;
use sea_orm::sea_query::*;
use sea_orm::*;

pub(crate) fn network_first_freq_sort_sql() -> &'static str {
    "(SELECT MIN(sigint_network_freq.freq COLLATE \"ru-x-icu\") \
      FROM sigint_network_freq \
      WHERE sigint_network_freq.network_id = sigint_network.id \
        AND sigint_network_freq.deleted = false \
        AND sigint_network_freq.active_to IS NULL)"
}

pub(crate) fn network_first_aor_sort_sql() -> &'static str {
    "(SELECT MIN(area_of_responsibility.name COLLATE \"ru-x-icu\") \
      FROM sigint_network_aor \
      INNER JOIN area_of_responsibility ON area_of_responsibility.id = sigint_network_aor.aor_id \
      WHERE sigint_network_aor.network_id = sigint_network.id \
        AND area_of_responsibility.deleted = false)"
}

fn network_recent_activity_exists_expr() -> SimpleExpr {
    Expr::cust(
        "EXISTS (SELECT 1 \
         FROM sigint_inbox_item_network \
         INNER JOIN sigint_inbox_item ON sigint_inbox_item.id = sigint_inbox_item_network.sigint_inbox_item_id \
         INNER JOIN signal_message ON signal_message.id = sigint_inbox_item.id \
         WHERE sigint_inbox_item_network.sigint_network_id = sigint_network.id \
           AND sigint_inbox_item.datetime >= CURRENT_TIMESTAMP - INTERVAL '10 days' \
           AND signal_message.deleted = false)",
    )
}

fn order_by_nulls_last(
    query: Select<sigint_network::Entity>,
    sort_sql: &str,
    descending: bool,
) -> Select<sigint_network::Entity> {
    let null_rank_sql =
        format!("CASE WHEN {sort_sql} IS NULL THEN 1 ELSE 0 END");
    let query = query.order_by_asc(Expr::cust(null_rank_sql));
    if descending {
        query.order_by_desc(Expr::cust(sort_sql))
    } else {
        query.order_by_asc(Expr::cust(sort_sql))
    }
}

pub(crate) fn apply_network_sort(
    query: Select<sigint_network::Entity>,
    sort_by: &ListNetworksSortBy,
) -> Select<sigint_network::Entity> {
    match sort_by {
        ListNetworksSortBy::NameAsc => query
            .order_by_asc(sigint_network::Column::Name)
            .order_by_asc(sigint_network::Column::Id),
        ListNetworksSortBy::NameDesc => query
            .order_by_desc(sigint_network::Column::Name)
            .order_by_asc(sigint_network::Column::Id),
        ListNetworksSortBy::LastActivityAsc => query
            .order_by_asc(sigint_network::Column::UpdatedAt)
            .order_by_asc(sigint_network::Column::Name)
            .order_by_asc(sigint_network::Column::Id),
        ListNetworksSortBy::LastActivityDesc => query
            .order_by_desc(sigint_network::Column::UpdatedAt)
            .order_by_asc(sigint_network::Column::Name)
            .order_by_asc(sigint_network::Column::Id),
        ListNetworksSortBy::HasRecentActivityAsc => query
            .order_by_asc(network_recent_activity_exists_expr())
            .order_by_desc(sigint_network::Column::UpdatedAt)
            .order_by_asc(sigint_network::Column::Name)
            .order_by_asc(sigint_network::Column::Id),
        ListNetworksSortBy::HasRecentActivityDesc => query
            .order_by_desc(network_recent_activity_exists_expr())
            .order_by_desc(sigint_network::Column::UpdatedAt)
            .order_by_asc(sigint_network::Column::Name)
            .order_by_asc(sigint_network::Column::Id),
        ListNetworksSortBy::AorAsc => {
            order_by_nulls_last(query, network_first_aor_sort_sql(), false)
                .order_by_asc(sigint_network::Column::Name)
                .order_by_asc(sigint_network::Column::Id)
        }
        ListNetworksSortBy::AorDesc => {
            order_by_nulls_last(query, network_first_aor_sort_sql(), true)
                .order_by_asc(sigint_network::Column::Name)
                .order_by_asc(sigint_network::Column::Id)
        }
        ListNetworksSortBy::NetworkFreqAsc => {
            order_by_nulls_last(query, network_first_freq_sort_sql(), false)
                .order_by_asc(sigint_network::Column::Name)
                .order_by_asc(sigint_network::Column::Id)
        }
        ListNetworksSortBy::NetworkFreqDesc => {
            order_by_nulls_last(query, network_first_freq_sort_sql(), true)
                .order_by_asc(sigint_network::Column::Name)
                .order_by_asc(sigint_network::Column::Id)
        }
        ListNetworksSortBy::LocationAsc => query
            .order_by_asc(sigint_network::Column::Location)
            .order_by_asc(sigint_network::Column::Name)
            .order_by_asc(sigint_network::Column::Id),
        ListNetworksSortBy::LocationDesc => query
            .order_by_desc(sigint_network::Column::Location)
            .order_by_asc(sigint_network::Column::Name)
            .order_by_asc(sigint_network::Column::Id),
    }
}

pub(crate) fn apply_network_sorts(
    query: Select<sigint_network::Entity>,
    sort_by: Option<&Vec<ListNetworksSortBy>>,
) -> Select<sigint_network::Entity> {
    if let Some(sort_by) = sort_by.and_then(|items| items.first()) {
        apply_network_sort(query, sort_by)
    } else {
        query
            .order_by_asc(sigint_network::Column::Name)
            .order_by_asc(sigint_network::Column::Id)
    }
}
