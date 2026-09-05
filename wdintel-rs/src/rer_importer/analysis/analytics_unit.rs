use super::{
    expand_unit_filter_values, selected_unit_network_ids_query,
    AnalyticsMessageIdScope,
};
use crate::entities::{prelude::*, *};
use crate::error::AppError;
use crate::h;
use anyhow::Context;
use sea_orm::*;
use sea_query::{
    Alias, Condition, Expr, SelectStatement, SimpleExpr, UnionType,
};

#[derive(Clone, Debug, Default)]
pub(in crate::rer_importer) struct ResolvedAnalyticsUnitFilter {
    pub ordinary_names: Vec<String>,
    pub includes_undefined: bool,
    pub linked_network_ids: Vec<i64>,
    pub present: bool,
}

#[derive(Clone, Debug, Default)]
pub(in crate::rer_importer) struct ResolvedAnalyticsUnitFilters {
    pub selected: ResolvedAnalyticsUnitFilter,
    pub denied: ResolvedAnalyticsUnitFilter,
    pub all_unit_network_ids: Vec<i64>,
}

impl ResolvedAnalyticsUnitFilters {
    pub fn has_filters(&self) -> bool {
        self.selected.present || self.denied.present
    }
}

pub(in crate::rer_importer) async fn resolve_analytics_unit_filters(
    source_db: &DatabaseConnection,
    selected_units: &Option<Vec<String>>,
    denied_units: &Option<Vec<String>>,
    units_exact_match_only: Option<bool>,
) -> Result<ResolvedAnalyticsUnitFilters, AppError> {
    let mut selected = split_analytics_unit_filter(selected_units);
    let mut denied = split_analytics_unit_filter(denied_units);
    selected.linked_network_ids = resolve_unit_network_ids(
        source_db,
        &selected.ordinary_names,
        units_exact_match_only,
    )
    .await
    .context(h!())?;
    denied.linked_network_ids = resolve_unit_network_ids(
        source_db,
        &denied.ordinary_names,
        units_exact_match_only,
    )
    .await
    .context(h!())?;
    let needs_all_unit_networks =
        selected.includes_undefined || denied.includes_undefined;
    let all_unit_network_ids = if needs_all_unit_networks {
        SigintNetworkUnit::find()
            .join(
                JoinType::InnerJoin,
                sigint_network_unit::Relation::SigintUnit.def(),
            )
            .select_only()
            .column(sigint_network_unit::Column::NetworkId)
            .filter(sigint_unit::Column::Deleted.eq(false))
            .distinct()
            .into_tuple::<i64>()
            .all(source_db)
            .await
            .context(h!())?
    } else {
        Vec::new()
    };
    Ok(ResolvedAnalyticsUnitFilters {
        selected,
        denied,
        all_unit_network_ids,
    })
}

pub(in crate::rer_importer) fn split_analytics_unit_filter(
    units: &Option<Vec<String>>,
) -> ResolvedAnalyticsUnitFilter {
    let units = expand_unit_filter_values(units);
    ResolvedAnalyticsUnitFilter {
        ordinary_names: units.ordinary_names,
        includes_undefined: units.includes_undefined,
        linked_network_ids: Vec::new(),
        present: units.present,
    }
}

async fn resolve_unit_network_ids(
    source_db: &DatabaseConnection,
    ordinary_names: &[String],
    units_exact_match_only: Option<bool>,
) -> Result<Vec<i64>, AppError> {
    if ordinary_names.is_empty() {
        return Ok(Vec::new());
    }
    let query = selected_unit_network_ids_query(
        &Some(ordinary_names.to_vec()),
        &units_exact_match_only,
    )
    .context(h!())?;
    #[derive(FromQueryResult)]
    struct NetworkIdRow {
        network_id: i64,
    }
    Ok(
        NetworkIdRow::find_by_statement(DbBackend::Postgres.build(&query))
            .all(source_db)
            .await
            .context(h!())?
            .into_iter()
            .map(|row| row.network_id)
            .collect(),
    )
}

pub(in crate::rer_importer) async fn resolve_analysis_unit_filters_for_analytics(
    source_db: &DatabaseConnection,
    selected_units: &Option<Vec<String>>,
    units_exact_match_only: Option<bool>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Option<ResolvedAnalyticsUnitFilters>, AppError> {
    if scope.is_none() || selected_units.as_ref().is_none_or(Vec::is_empty) {
        return Ok(None);
    }
    Ok(Some(
        resolve_analytics_unit_filters(
            source_db,
            selected_units,
            &None,
            units_exact_match_only,
        )
        .await
        .context(h!())?,
    ))
}

pub(in crate::rer_importer) async fn resolve_analysis_unit_filter_variants_for_analytics(
    source_db: &DatabaseConnection,
    selected_units: &Option<Vec<String>>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<
    (
        Option<ResolvedAnalyticsUnitFilters>,
        Option<ResolvedAnalyticsUnitFilters>,
    ),
    AppError,
> {
    if scope.is_none() || selected_units.as_ref().is_none_or(Vec::is_empty) {
        return Ok((None, None));
    }

    let split = split_analytics_unit_filter(selected_units);
    let mut queries = Vec::new();
    if !split.ordinary_names.is_empty() {
        let exact = selected_unit_network_ids_query(
            &Some(split.ordinary_names.clone()),
            &Some(true),
        )
        .context(h!())?;
        queries.push(unit_network_variant_query(exact, "exact"));
        let combined = selected_unit_network_ids_query(
            &Some(split.ordinary_names.clone()),
            &Some(false),
        )
        .context(h!())?;
        queries.push(unit_network_variant_query(combined, "combined"));
    }
    if split.includes_undefined {
        queries.push(unit_network_variant_query(
            SigintNetworkUnit::find()
                .join(
                    JoinType::InnerJoin,
                    sigint_network_unit::Relation::SigintUnit.def(),
                )
                .select_only()
                .column(sigint_network_unit::Column::NetworkId)
                .filter(sigint_unit::Column::Deleted.eq(false))
                .distinct()
                .into_query(),
            "all",
        ));
    }

    let mut queries = queries.into_iter();
    let mut query = queries.next().context(h!())?;
    for variant in queries {
        query.union(UnionType::All, variant);
    }
    #[derive(FromQueryResult)]
    struct NetworkIdVariantRow {
        network_id: i64,
        resolution_kind: String,
    }
    let rows = NetworkIdVariantRow::find_by_statement(
        DbBackend::Postgres.build(&query),
    )
    .all(source_db)
    .await
    .context(h!())?;
    let exact_network_ids = rows
        .iter()
        .filter(|row| row.resolution_kind == "exact")
        .map(|row| row.network_id)
        .collect();
    let combined_network_ids = rows
        .iter()
        .filter(|row| row.resolution_kind == "combined")
        .map(|row| row.network_id)
        .collect();
    let all_unit_network_ids = rows
        .iter()
        .filter(|row| row.resolution_kind == "all")
        .map(|row| row.network_id)
        .collect::<Vec<_>>();
    Ok((
        Some(resolved_analysis_unit_filters(
            split.clone(),
            exact_network_ids,
            all_unit_network_ids.clone(),
        )),
        Some(resolved_analysis_unit_filters(
            split,
            combined_network_ids,
            all_unit_network_ids,
        )),
    ))
}

fn unit_network_variant_query(
    mut query: SelectStatement,
    resolution_kind: &str,
) -> SelectStatement {
    query.expr_as(Expr::value(resolution_kind), Alias::new("resolution_kind"));
    query
}

fn resolved_analysis_unit_filters(
    mut selected: ResolvedAnalyticsUnitFilter,
    linked_network_ids: Vec<i64>,
    all_unit_network_ids: Vec<i64>,
) -> ResolvedAnalyticsUnitFilters {
    selected.linked_network_ids = linked_network_ids;
    ResolvedAnalyticsUnitFilters {
        selected,
        denied: ResolvedAnalyticsUnitFilter::default(),
        all_unit_network_ids,
    }
}

pub(in crate::rer_importer) fn apply_analysis_unit_filters<E>(
    query: Select<E>,
    selected_units: &Option<Vec<String>>,
    selected_unit_ids: &Option<Vec<i64>>,
    units_exact_match_only: &Option<bool>,
    dt_since: chrono::NaiveDateTime,
    dt_till: chrono::NaiveDateTime,
    scope: Option<&AnalyticsMessageIdScope>,
    resolved: Option<&ResolvedAnalyticsUnitFilters>,
) -> Result<Select<E>, AppError>
where
    E: EntityTrait,
{
    if let Some(scope) = scope {
        if selected_units.as_ref().is_none_or(Vec::is_empty) {
            return Ok(query.apply_if(
                selected_unit_ids.as_ref().filter(|ids| !ids.is_empty()),
                |query, ids| {
                    query.filter(super::message_has_linked_unit_ids_with_scope(
                        ids,
                        false,
                        Some(scope),
                    ))
                },
            ));
        } else {
            let resolved = resolved
                .ok_or_else(|| {
                    anyhow::anyhow!("analytics unit filters were not resolved")
                })
                .context(h!())?;
            return Ok(apply_resolved_analytics_unit_filters_with_ids(
                query,
                resolved,
                scope,
                units_exact_match_only.unwrap_or(false),
                selected_unit_ids,
            ));
        }
    }
    Ok(super::filter_selected_units_or_ids_for_period(
        query,
        selected_units,
        selected_unit_ids,
        units_exact_match_only,
        dt_since,
        dt_till,
    )
    .context(h!())?)
}

#[cfg(test)]
pub(in crate::rer_importer) fn apply_resolved_analytics_unit_filters<E>(
    query: Select<E>,
    resolved: &ResolvedAnalyticsUnitFilters,
    scope: &AnalyticsMessageIdScope,
    exact_match_only: bool,
) -> Select<E>
where
    E: EntityTrait,
{
    apply_resolved_analytics_unit_filters_with_ids(
        query,
        resolved,
        scope,
        exact_match_only,
        &None,
    )
}

pub(in crate::rer_importer) fn apply_resolved_analytics_unit_filters_with_ids<
    E,
>(
    mut query: Select<E>,
    resolved: &ResolvedAnalyticsUnitFilters,
    scope: &AnalyticsMessageIdScope,
    exact_match_only: bool,
    selected_unit_ids: &Option<Vec<i64>>,
) -> Select<E>
where
    E: EntityTrait,
{
    let selected_link = analytics_unit_link_match(
        "analytics_selected_unit",
        &resolved.selected.linked_network_ids,
        scope,
    );
    let denied_link = analytics_unit_link_match(
        "analytics_denied_unit",
        &resolved.denied.linked_network_ids,
        scope,
    );
    let any_link = if resolved.selected.includes_undefined
        || resolved.denied.includes_undefined
    {
        analytics_unit_link_match(
            "analytics_any_unit",
            &resolved.all_unit_network_ids,
            scope,
        )
    } else {
        None
    };

    let selected_units = resolved.selected.present.then(|| {
        analytics_unit_filter_match(
            &resolved.selected,
            selected_link.as_ref(),
            any_link.as_ref(),
            exact_match_only,
        )
    });
    let selected_unit_ids = selected_unit_ids
        .as_ref()
        .filter(|unit_ids| !unit_ids.is_empty())
        .map(|unit_ids| {
            super::message_has_linked_unit_ids_with_scope(
                unit_ids,
                false,
                Some(scope),
            )
        });
    match (selected_units, selected_unit_ids) {
        (None, None) => {}
        (None, Some(condition)) | (Some(condition), None) => {
            query = query.filter(condition);
        }
        (Some(units), Some(unit_ids)) => {
            query = query.filter(units.or(unit_ids));
        }
    }
    if resolved.denied.present {
        query = query.filter(
            analytics_unit_filter_match(
                &resolved.denied,
                denied_link.as_ref(),
                any_link.as_ref(),
                exact_match_only,
            )
            .not(),
        );
    }
    query
}

fn analytics_unit_filter_match(
    unit_filter: &ResolvedAnalyticsUnitFilter,
    linked_frequency_match: Option<&SimpleExpr>,
    any_frequency_match: Option<&SimpleExpr>,
    exact_match_only: bool,
) -> SimpleExpr {
    let linked_match = linked_frequency_match.cloned();
    let ordinary_match = (!unit_filter.ordinary_names.is_empty()).then(|| {
        let linked_match = linked_match.unwrap_or_else(|| Expr::value(false));
        if exact_match_only {
            linked_match
        } else {
            analytics_header_unit_matches(&unit_filter.ordinary_names)
                .or(linked_match)
        }
    });
    let undefined_match = unit_filter.includes_undefined.then(|| {
        analytics_header_unit_is_undefined().and(
            any_frequency_match
                .cloned()
                .map(SimpleExpr::not)
                .unwrap_or_else(|| Expr::value(true)),
        )
    });
    match (ordinary_match, undefined_match) {
        (Some(ordinary), Some(undefined)) => ordinary.or(undefined),
        (Some(ordinary), None) => ordinary,
        (None, Some(undefined)) => undefined,
        (None, None) => Expr::value(false),
    }
}

fn analytics_header_unit_matches(units: &[String]) -> SimpleExpr {
    let units = expand_unit_filter_values(&Some(units.to_vec())).ordinary_names;
    let header = Expr::col(sigint_inbox_item::Column::UnitV2);
    header
        .clone()
        .is_not_null()
        .and(header.clone().ne(""))
        .and(header.is_in(units))
}

fn analytics_header_unit_is_undefined() -> SimpleExpr {
    let header = Expr::col(sigint_inbox_item::Column::UnitV2);
    header.clone().is_null().or(header.eq(""))
}

fn analytics_unit_link_match(
    prefix: &str,
    network_ids: &[i64],
    scope: &AnalyticsMessageIdScope,
) -> Option<SimpleExpr> {
    if network_ids.is_empty() {
        return None;
    }
    let link_alias = Alias::new(format!("{prefix}_link"));
    let network_alias = Alias::new(format!("{prefix}_network"));
    let frequency_alias = Alias::new(format!("{prefix}_frequency"));
    let message_datetime = Expr::col(sigint_inbox_item::Column::Datetime);
    let mut query = sea_query::Query::select();
    query
        .expr(Expr::value(1))
        .from_as(
            (
                Alias::new("echo_clickhouse_derived"),
                Alias::new("message_network_link"),
            ),
            link_alias.clone(),
        )
        .join_as(
            JoinType::InnerJoin,
            sigint_network::Entity,
            network_alias.clone(),
            analytics_unit_network_join_condition(
                network_alias.clone(),
                link_alias.clone(),
                message_datetime.clone(),
            ),
        )
        .join_as(
            JoinType::InnerJoin,
            sigint_network_freq::Entity,
            frequency_alias.clone(),
            analytics_unit_frequency_join_condition(
                frequency_alias,
                network_alias,
                message_datetime,
            ),
        )
        .cond_where(analytics_unit_link_join_condition(
            link_alias,
            network_ids,
            scope,
        ));
    Some(Expr::exists(query))
}

fn analytics_unit_link_join_condition(
    link_alias: Alias,
    network_ids: &[i64],
    scope: &AnalyticsMessageIdScope,
) -> Condition {
    Condition::all()
        .add(
            Expr::col((link_alias.clone(), Alias::new("sigint_inbox_item_id")))
                .equals((
                    sigint_inbox_item::Entity,
                    sigint_inbox_item::Column::Id,
                )),
        )
        .add(
            Expr::col((link_alias.clone(), Alias::new("sigint_network_id")))
                .is_in(network_ids.to_vec()),
        )
        .add(scope.condition((link_alias, Alias::new("sigint_inbox_item_id"))))
}

fn analytics_unit_network_join_condition(
    network_alias: Alias,
    link_alias: Alias,
    message_datetime: SimpleExpr,
) -> Condition {
    Condition::all()
        .add(
            Expr::col((network_alias.clone(), sigint_network::Column::Id))
                .equals((link_alias, Alias::new("sigint_network_id"))),
        )
        .add(
            Expr::col((network_alias.clone(), sigint_network::Column::Deleted))
                .eq(false),
        )
        .add(
            Expr::col((
                network_alias.clone(),
                sigint_network::Column::ActiveFrom,
            ))
            .is_null()
            .or(Expr::col((
                network_alias.clone(),
                sigint_network::Column::ActiveFrom,
            ))
            .lte(message_datetime.clone())),
        )
        .add(
            Expr::col((
                network_alias.clone(),
                sigint_network::Column::ActiveTo,
            ))
            .is_null()
            .or(Expr::col((
                network_alias,
                sigint_network::Column::ActiveTo,
            ))
            .gte(message_datetime)),
        )
}

fn analytics_unit_frequency_join_condition(
    frequency_alias: Alias,
    network_alias: Alias,
    message_datetime: SimpleExpr,
) -> Condition {
    Condition::all()
        .add(
            Expr::col((
                frequency_alias.clone(),
                sigint_network_freq::Column::NetworkId,
            ))
            .equals((network_alias, sigint_network::Column::Id)),
        )
        .add(
            Expr::col((
                frequency_alias.clone(),
                sigint_network_freq::Column::Freq,
            ))
            .equals((
                sigint_inbox_item::Entity,
                sigint_inbox_item::Column::Freq,
            )),
        )
        .add(
            Expr::col((
                frequency_alias.clone(),
                sigint_network_freq::Column::Deleted,
            ))
            .eq(false),
        )
        .add(
            Expr::col((
                frequency_alias.clone(),
                sigint_network_freq::Column::ActiveFrom,
            ))
            .lte(message_datetime.clone()),
        )
        .add(
            Expr::col((
                frequency_alias.clone(),
                sigint_network_freq::Column::ActiveTo,
            ))
            .is_null()
            .or(Expr::col((
                frequency_alias,
                sigint_network_freq::Column::ActiveTo,
            ))
            .gte(message_datetime)),
        )
}
