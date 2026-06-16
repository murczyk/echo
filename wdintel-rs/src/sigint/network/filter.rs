use crate::entities::*;
use crate::sigint::network::types::{
    ListNetworksReq, ListNetworksStatusFilter,
};
use crate::utils::orm::ArrayColumnOps;
use sea_orm::sea_query::*;
use sea_orm::*;

#[derive(Copy, Clone)]
enum SearchScope {
    Global,
    NetworkLabel,
    Location,
}

fn normalize_search_token(token: &str) -> Option<String> {
    let trimmed = token.trim().trim_matches(|ch: char| {
        matches!(
            ch,
            ',' | '.'
                | ':'
                | ';'
                | '"'
                | '\''
                | '('
                | ')'
                | '['
                | ']'
                | '{'
                | '}'
                | '!'
                | '?'
        )
    });
    if trimmed.is_empty() {
        return None;
    }

    let lowered = trimmed.to_lowercase();
    if matches!(lowered.as_str(), "р/м" | "рм") {
        return None;
    }

    Some(lowered)
}

pub(crate) fn tokenize_search_text(search_text: &str) -> Vec<String> {
    search_text
        .split_whitespace()
        .filter_map(normalize_search_token)
        .collect()
}

fn token_like_expr(column_sql: &str, token: &str) -> SimpleExpr {
    let pattern = format!("%{}%", token);
    Expr::cust_with_values(column_sql, vec![pattern])
}

fn network_unit_exists_for_token(token: &str) -> SimpleExpr {
    let unit_exists = sigint_network_unit::Entity::find()
        .select_only()
        .expr(Expr::value(1))
        .filter(
            sigint_network_unit::Column::NetworkId
                .into_simple_expr()
                .eq(sigint_network::Column::Id.into_simple_expr()),
        )
        .join_as(
            JoinType::InnerJoin,
            sigint_network_unit::Relation::SigintUnit.def(),
            Alias::new("sigint_unit"),
        )
        .filter(token_like_expr(
            "lower(sigint_unit.name collate \"ru-x-icu\") ilike $1",
            token,
        ))
        .into_query();
    Expr::exists(unit_exists)
}

fn network_freq_exists_for_token(token: &str) -> SimpleExpr {
    let freq_exists = sigint_network_freq::Entity::find()
        .select_only()
        .expr(Expr::value(1))
        .filter(
            sigint_network_freq::Column::NetworkId
                .into_simple_expr()
                .eq(sigint_network::Column::Id.into_simple_expr()),
        )
        .filter(sigint_network_freq::Column::Deleted.eq(false))
        .filter(token_like_expr(
            "lower(sigint_network_freq.freq collate \"ru-x-icu\") ilike $1",
            token,
        ))
        .into_query();
    Expr::exists(freq_exists)
}

fn network_aor_exists_for_token(token: &str) -> SimpleExpr {
    let aor_exists = sigint_network_aor::Entity::find()
        .select_only()
        .expr(Expr::value(1))
        .filter(
            sigint_network_aor::Column::NetworkId
                .into_simple_expr()
                .eq(sigint_network::Column::Id.into_simple_expr()),
        )
        .join_as(
            JoinType::InnerJoin,
            sigint_network_aor::Relation::AreaOfResponsibility.def(),
            Alias::new("sigint_aor"),
        )
        .filter(Expr::cust("\"sigint_aor\".\"deleted\" = false"))
        .filter(token_like_expr(
            "lower(sigint_aor.name collate \"ru-x-icu\") ilike $1",
            token,
        ))
        .into_query();
    Expr::exists(aor_exists)
}

fn network_name_matches_token(token: &str) -> SimpleExpr {
    token_like_expr(
        "lower(sigint_network.name collate \"ru-x-icu\") ilike $1",
        token,
    )
}

fn network_location_matches_token(token: &str) -> SimpleExpr {
    token_like_expr(
        "lower(sigint_network.location collate \"ru-x-icu\") ilike $1",
        token,
    )
}

fn network_radio_station_matches_token(token: &str) -> SimpleExpr {
    token_like_expr(
        "lower(sigint_network.radio_station collate \"ru-x-icu\") ilike $1",
        token,
    )
}

fn filter_network_tokens(
    query: Select<sigint_network::Entity>,
    search_text: &str,
    scope: SearchScope,
) -> Select<sigint_network::Entity> {
    let tokens = tokenize_search_text(search_text);
    if tokens.is_empty() {
        return query;
    }

    let condition =
        tokens
            .into_iter()
            .fold(Condition::all(), |condition, token| {
                let mut token_condition = Condition::any();

                match scope {
                    SearchScope::Global => {
                        token_condition = token_condition
                            .add(network_name_matches_token(&token))
                            .add(network_location_matches_token(&token))
                            .add(network_radio_station_matches_token(&token))
                            .add(network_unit_exists_for_token(&token))
                            .add(network_freq_exists_for_token(&token))
                            .add(network_aor_exists_for_token(&token));
                    }
                    SearchScope::NetworkLabel => {
                        token_condition = token_condition
                            .add(network_name_matches_token(&token))
                            .add(network_unit_exists_for_token(&token));
                    }
                    SearchScope::Location => {
                        token_condition = token_condition
                            .add(network_location_matches_token(&token));
                    }
                }

                condition.add(token_condition)
            });

    query.filter(condition)
}

fn network_text_filter(
    query: Select<sigint_network::Entity>,
    filter_text: &str,
) -> Select<sigint_network::Entity> {
    filter_network_tokens(query, filter_text, SearchScope::Global)
}

fn network_name_filter(
    query: Select<sigint_network::Entity>,
    filter_name: &str,
) -> Select<sigint_network::Entity> {
    filter_network_tokens(query, filter_name, SearchScope::NetworkLabel)
}

fn network_location_filter(
    query: Select<sigint_network::Entity>,
    filter_location: &str,
) -> Select<sigint_network::Entity> {
    filter_network_tokens(query, filter_location, SearchScope::Location)
}

fn network_status_filter(
    query: Select<sigint_network::Entity>,
    req: &ListNetworksReq,
    include_status_filter: bool,
) -> Select<sigint_network::Entity> {
    if !include_status_filter {
        return query;
    }

    if let Some(status_filter) = &req.status_filter {
        return match status_filter {
            ListNetworksStatusFilter::ListNetworksActive => query
                .filter(sigint_network::Column::Deleted.eq(false))
                .filter(sigint_network::Column::ActiveTo.is_null()),
            ListNetworksStatusFilter::ListNetworksInactive => query
                .filter(sigint_network::Column::Deleted.eq(false))
                .filter(sigint_network::Column::ActiveTo.is_not_null()),
            ListNetworksStatusFilter::ListNetworksArchived => {
                query.filter(sigint_network::Column::Deleted.eq(true))
            }
        };
    }

    let query = query.filter(
        sigint_network::Column::Deleted
            .eq(req.show_only_deleted.unwrap_or(false)),
    );

    if req.show_inactive.unwrap_or(false) {
        query
    } else {
        query.filter(sigint_network::Column::ActiveTo.is_null())
    }
}

fn network_ids_filter(
    query: Select<sigint_network::Entity>,
    ids: Option<&Vec<i64>>,
) -> Select<sigint_network::Entity> {
    if let Some(ids) = ids.filter(|ids| !ids.is_empty()) {
        query.filter(sigint_network::Column::Id.is_in(ids.clone()))
    } else {
        query
    }
}

fn network_unit_filter(
    query: Select<sigint_network::Entity>,
    filter_unit: Option<&str>,
) -> Select<sigint_network::Entity> {
    let Some(filter_unit) = filter_unit else {
        return query;
    };

    let pattern = format!("%{}%", filter_unit.to_lowercase());
    let unit_exists = sigint_network_unit::Entity::find()
        .select_only()
        .expr(Expr::value(1))
        .filter(
            sigint_network_unit::Column::NetworkId
                .into_simple_expr()
                .eq(sigint_network::Column::Id.into_simple_expr()),
        )
        .join_as(
            JoinType::InnerJoin,
            sigint_network_unit::Relation::SigintUnit.def(),
            Alias::new("sigint_unit"),
        )
        .filter(Expr::cust_with_values(
            "lower(sigint_unit.name collate \"ru-x-icu\") ilike $1",
            vec![pattern],
        ))
        .into_query();

    query.filter(Expr::exists(unit_exists))
}

fn network_further_investigation_filter(
    query: Select<sigint_network::Entity>,
    show_only_further_inverstigation: bool,
) -> Select<sigint_network::Entity> {
    if !show_only_further_inverstigation {
        return query;
    }

    let unit_exists = sigint_network_unit::Entity::find()
        .select_only()
        .expr(Expr::value(1))
        .filter(
            sigint_network_unit::Column::NetworkId
                .into_simple_expr()
                .eq(sigint_network::Column::Id.into_simple_expr()),
        )
        .into_query();

    query.filter(Expr::exists(unit_exists).not())
}

fn network_aor_filter(
    query: Select<sigint_network::Entity>,
    aor_ids: Option<&Vec<i64>>,
) -> Select<sigint_network::Entity> {
    let Some(aor_ids) = aor_ids.filter(|ids| !ids.is_empty()) else {
        return query;
    };

    let has_no_aor = aor_ids.contains(&-1);
    let regular_aor_ids = aor_ids
        .iter()
        .copied()
        .filter(|id| *id != -1)
        .collect::<Vec<_>>();

    if has_no_aor && regular_aor_ids.is_empty() {
        let any_aor_exists = sigint_network_aor::Entity::find()
            .select_only()
            .expr(Expr::value(1))
            .filter(
                sigint_network_aor::Column::NetworkId
                    .into_simple_expr()
                    .eq(sigint_network::Column::Id.into_simple_expr()),
            )
            .into_query();
        return query.filter(Expr::exists(any_aor_exists).not());
    }

    let regular_aor_exists = sigint_network_aor::Entity::find()
        .select_only()
        .expr(Expr::value(1))
        .filter(
            sigint_network_aor::Column::NetworkId
                .into_simple_expr()
                .eq(sigint_network::Column::Id.into_simple_expr()),
        )
        .filter(sigint_network_aor::Column::AorId.eq_any(regular_aor_ids))
        .into_query();

    if has_no_aor {
        let any_aor_exists = sigint_network_aor::Entity::find()
            .select_only()
            .expr(Expr::value(1))
            .filter(
                sigint_network_aor::Column::NetworkId
                    .into_simple_expr()
                    .eq(sigint_network::Column::Id.into_simple_expr()),
            )
            .into_query();
        query.filter(
            Condition::any()
                .add(Expr::exists(regular_aor_exists))
                .add(Expr::exists(any_aor_exists).not()),
        )
    } else {
        query.filter(Expr::exists(regular_aor_exists))
    }
}

fn network_freq_filter(
    query: Select<sigint_network::Entity>,
    filter_freq: Option<&str>,
) -> Select<sigint_network::Entity> {
    let Some(filter_freq) = filter_freq else {
        return query;
    };

    let pattern = format!("{filter_freq}%");
    let freq_exists = sigint_network_freq::Entity::find()
        .select_only()
        .column(sigint_network_freq::Column::Freq)
        .filter(
            sigint_network_freq::Column::NetworkId
                .into_simple_expr()
                .eq(sigint_network::Column::Id.into_simple_expr()),
        )
        .filter(sigint_network_freq::Column::Deleted.eq(false))
        .filter(Expr::cust_with_values(
            "sigint_network_freq.freq ilike $1",
            vec![pattern],
        ))
        .into_query();

    query.filter(Expr::exists(freq_exists))
}

pub(crate) fn apply_network_list_filters(
    query: Select<sigint_network::Entity>,
    req: &ListNetworksReq,
    include_status_filter: bool,
) -> Select<sigint_network::Entity> {
    let mut query = query;

    if let Some(filter_text) = req
        .filter_text
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        query = network_text_filter(query, filter_text);
    }
    if let Some(filter_name) = req
        .filter_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        query = network_name_filter(query, filter_name);
    }
    if let Some(filter_location) = req
        .filter_location
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        query = network_location_filter(query, filter_location);
    }

    query = network_status_filter(query, req, include_status_filter);
    query = network_ids_filter(query, req.ids.as_ref());
    query = network_unit_filter(query, req.filter_unit.as_deref());
    query = network_further_investigation_filter(
        query,
        req.show_only_further_inverstigation.unwrap_or(false),
    );
    query = network_aor_filter(query, req.aor_ids.as_ref());
    network_freq_filter(query, req.filter_freq.as_deref())
}
