use crate::entities::sigint_network;
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

fn network_last_activity_source_sql(
    activity_timestamp: &str,
    source_filter: &str,
) -> String {
    format!(
        "SELECT {activity_timestamp} AS activity_at \
         FROM sigint_inbox_item inbox_item \
         JOIN signal_message \
           ON signal_message.id = inbox_item.id \
         JOIN datasource_group \
           ON datasource_group.id = signal_message.datasource_group_id \
         JOIN signal_group \
           ON signal_group.master_key = datasource_group.group_master_key \
         JOIN sigint_inbox_item_network network_link \
           ON network_link.sigint_inbox_item_id = inbox_item.id \
         WHERE network_link.sigint_network_id = sigint_network.id \
           AND {source_filter} \
           AND signal_message.deleted = false \
           AND datasource_group.group_master_key = ANY($1) \
           AND signal_group.deleted = false \
           AND signal_group.is_archived = false \
           AND (sigint_network.active_from IS NULL \
             OR {activity_timestamp} >= sigint_network.active_from) \
           AND (sigint_network.active_to IS NULL \
             OR {activity_timestamp} <= sigint_network.active_to) \
           AND EXISTS ( \
             SELECT 1 \
             FROM sigint_network_freq network_freq \
             WHERE network_freq.network_id = sigint_network.id \
               AND network_freq.freq = inbox_item.freq \
               AND network_freq.deleted = false \
               AND {activity_timestamp} >= network_freq.active_from \
               AND (network_freq.active_to IS NULL \
                 OR {activity_timestamp} <= network_freq.active_to)) \
         ORDER BY {activity_timestamp} DESC \
         LIMIT 1",
    )
}

fn network_last_activity_sql() -> String {
    let inbox_datetime = network_last_activity_source_sql(
        "inbox_item.datetime",
        "inbox_item.datetime IS NOT NULL",
    );
    let message_timestamp = network_last_activity_source_sql(
        "signal_message.timestamp",
        "inbox_item.datetime IS NULL AND signal_message.timestamp IS NOT NULL",
    );
    let message_created_at = network_last_activity_source_sql(
        "signal_message.created_at",
        "inbox_item.datetime IS NULL AND signal_message.timestamp IS NULL",
    );
    format!(
        "(SELECT MAX(activity_at) \
         FROM (({inbox_datetime}) UNION ALL ({message_timestamp}) UNION ALL ({message_created_at})) activity_candidates)"
    )
}

pub(crate) fn network_last_activity_sort_expr(groups: &[String]) -> SimpleExpr {
    if groups.is_empty() {
        Expr::cust("NULL::timestamp without time zone")
    } else {
        Expr::cust_with_values(network_last_activity_sql(), [groups.to_vec()])
    }
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
        query.order_by_desc(Expr::cust(sort_sql.to_owned()))
    } else {
        query.order_by_asc(Expr::cust(sort_sql.to_owned()))
    }
}

fn order_by_expr_nulls_last(
    query: Select<sigint_network::Entity>,
    sort_expr: SimpleExpr,
    descending: bool,
) -> Select<sigint_network::Entity> {
    query.order_by_with_nulls(
        sort_expr,
        if descending { Order::Desc } else { Order::Asc },
        NullOrdering::Last,
    )
}

pub(crate) fn apply_network_sort(
    query: Select<sigint_network::Entity>,
    sort_by: &ListNetworksSortBy,
    groups: &[String],
) -> Select<sigint_network::Entity> {
    match sort_by {
        ListNetworksSortBy::NameAsc => query
            .order_by_asc(sigint_network::Column::Name)
            .order_by_asc(sigint_network::Column::Id),
        ListNetworksSortBy::NameDesc => query
            .order_by_desc(sigint_network::Column::Name)
            .order_by_asc(sigint_network::Column::Id),
        ListNetworksSortBy::LastActivityAsc => order_by_expr_nulls_last(
            query,
            network_last_activity_sort_expr(groups),
            false,
        )
        .order_by_asc(sigint_network::Column::Name)
        .order_by_asc(sigint_network::Column::Id),
        ListNetworksSortBy::LastActivityDesc => order_by_expr_nulls_last(
            query,
            network_last_activity_sort_expr(groups),
            true,
        )
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
    groups: &[String],
) -> Select<sigint_network::Entity> {
    if let Some(sort_by) = sort_by.and_then(|items| items.first()) {
        apply_network_sort(query, sort_by, groups)
    } else {
        query
            .order_by_asc(sigint_network::Column::Name)
            .order_by_asc(sigint_network::Column::Id)
    }
}
