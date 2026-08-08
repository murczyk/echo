use crate::config::ANALYSIS_CALLSIGN_FREQUENCY_MATCH_LIMIT;
use crate::rer_importer::types::SenderFrequencyBreakdown;
use crate::sigint::network::types::NetworkCallsignRelationMessage;
use crate::types::ShortContext;
use crate::types::{debug, warn};
use crate::users::login_id_from_identity;
use actix_identity::Identity;
use actix_web::web::Json;
use chrono::{Duration, NaiveDate, Utc};
use echo_migration::{Expr, JoinType};
use once_cell::sync::Lazy;
use sea_orm::sea_query::{
    CommonTableExpression, Order, SelectStatement, SimpleExpr, UnionType,
    WithQuery,
};
use sea_orm::FromQueryResult;
use sea_orm::*;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::error::Error as StdError;
use std::future::Future;
use std::sync::Arc;
use tokio::sync::{Mutex, Notify};

use crate::entities::sigint_inbox_item::Entity;
use crate::entities::{
    login, sigint_inbox_item, sigint_inbox_item_metadata, sigint_post,
    signal_message, signal_message_group, tag,
};
use crate::error::AppError;
use crate::h;
use crate::rer_importer::analysis::*;
use crate::stats::*;
use crate::types::Env;

#[derive(FromQueryResult)]
struct DistinctCountRes {
    count: i64,
}

#[derive(Clone)]
pub(in crate::rer_importer) struct AnalyticsTagAccess {
    pub(in crate::rer_importer) accessible_tag_ids: Vec<i64>,
    pub(in crate::rer_importer) unit_login_ids: Vec<uuid::Uuid>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum AnalysisFacet {
    Groups,
    Senders,
    Frequencies,
    Posts,
    Callsigns,
    Units,
    Locations,
    Tags,
    Aors,
    Networks,
}

#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq)]
struct AnalyticsMessageIdScopeKey {
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    freshness_max_age_ms: u64,
}

struct AnalyticsMessageIdScopeFlight {
    result: std::sync::Mutex<Option<Result<AnalyticsMessageIdScope, String>>>,
    finished: Notify,
}

static ANALYTICS_MESSAGE_ID_SCOPE_FLIGHTS: Lazy<
    Mutex<
        HashMap<AnalyticsMessageIdScopeKey, Arc<AnalyticsMessageIdScopeFlight>>,
    >,
> = Lazy::new(|| Mutex::new(HashMap::new()));

pub(super) fn request_without_facet_filter(
    req: &AnalysisStatsReq,
    facet: AnalysisFacet,
) -> AnalysisStatsReq {
    let mut req = req.clone();
    match facet {
        AnalysisFacet::Groups => req.selected_groups = None,
        AnalysisFacet::Senders => req.selected_senders = None,
        AnalysisFacet::Frequencies => req.selected_freqs = None,
        AnalysisFacet::Posts => req.selected_posts = None,
        AnalysisFacet::Callsigns => req.selected_callsigns = None,
        AnalysisFacet::Units => {
            req.selected_units = None;
            req.units_exact_match_only = None;
        }
        AnalysisFacet::Locations => req.selected_locations = None,
        AnalysisFacet::Tags => {
            req.selected_tags = None;
            req.denied_tags = None;
            req.tag_presence = None;
            req.filter_tags_option = None;
            req.without_model_tags = None;
            req.report_tags_only_this_unit = None;
        }
        AnalysisFacet::Aors => req.selected_aors = None,
        AnalysisFacet::Networks => {
            req.selected_networks = None;
            req.without_network = None;
        }
    }
    req
}

pub(super) fn callsign_frequency_match_search_req(
    req: &AnalysisStatsReq,
) -> AnalysisStatsReq {
    let req = request_without_facet_filter(req, AnalysisFacet::Callsigns);
    request_without_facet_filter(&req, AnalysisFacet::Frequencies)
}

pub(in crate::rer_importer) async fn resolve_analytics_tag_access(
    db: &DatabaseConnection,
    login_id: &uuid::Uuid,
    report_tags_only_this_unit: bool,
) -> Result<AnalyticsTagAccess, AppError> {
    let login_row = login::Entity::find_by_id(*login_id)
        .one(db)
        .await
        .context(h!())?;
    let owner_organism_id = login_row
        .as_ref()
        .filter(|login_row| !login_row.deleted_permanently)
        .and_then(|login_row| login_row.organism_id);
    let unit_organism_id =
        login_row.and_then(|login_row| login_row.organism_id);
    let accessible_tag_ids = tag::Entity::find()
        .filter(crate::tags::query::accessible_tag_condition(
            owner_organism_id,
        ))
        .select_only()
        .column(tag::Column::Id)
        .into_tuple::<i64>()
        .all(db)
        .await
        .context(h!())?;
    let unit_login_ids =
        if report_tags_only_this_unit && unit_organism_id.is_some() {
            login::Entity::find()
                .filter(login::Column::OrganismId.eq(unit_organism_id))
                .select_only()
                .column(login::Column::Id)
                .into_tuple::<uuid::Uuid>()
                .all(db)
                .await
                .context(h!())?
        } else {
            Vec::new()
        };
    Ok(AnalyticsTagAccess {
        accessible_tag_ids,
        unit_login_ids,
    })
}

pub(super) async fn resolve_analytics_message_id_scope(
    req: &AnalysisStatsReq,
    db: &DatabaseConnection,
    freshness_max_age_ms: u64,
) -> Result<AnalyticsMessageIdScope, AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    resolve_analytics_message_id_scope_for_range(
        dt_since,
        dt_till,
        db,
        freshness_max_age_ms,
    )
    .await
}

pub(in crate::rer_importer) async fn resolve_analytics_message_id_scope_for_range(
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    db: &DatabaseConnection,
    freshness_max_age_ms: u64,
) -> Result<AnalyticsMessageIdScope, AppError> {
    let key = AnalyticsMessageIdScopeKey {
        dt_since,
        dt_till,
        freshness_max_age_ms,
    };
    let db = db.clone();
    resolve_analytics_message_id_scope_singleflight(key, move || async move {
        resolve_analytics_message_id_scope_for_range_uncached(
            dt_since,
            dt_till,
            &db,
            freshness_max_age_ms,
        )
        .await
    })
    .await
}

async fn resolve_analytics_message_id_scope_singleflight<F, Fut>(
    key: AnalyticsMessageIdScopeKey,
    resolve: F,
) -> Result<AnalyticsMessageIdScope, AppError>
where
    F: FnOnce() -> Fut + Send + 'static,
    Fut: Future<Output = Result<AnalyticsMessageIdScope, AppError>>
        + Send
        + 'static,
{
    let mut resolve = Some(resolve);
    let flight = {
        let mut flights = ANALYTICS_MESSAGE_ID_SCOPE_FLIGHTS.lock().await;
        if let Some(flight) = flights.get(&key) {
            flight.clone()
        } else {
            let flight = Arc::new(AnalyticsMessageIdScopeFlight {
                result: std::sync::Mutex::new(None),
                finished: Notify::new(),
            });
            flights.insert(key, flight.clone());
            let runner_flight = flight.clone();
            let resolve = resolve.take().context(h!())?;
            tokio::spawn(async move {
                let result = resolve().await.map_err(|err| format!("{err:?}"));
                {
                    let mut flights =
                        ANALYTICS_MESSAGE_ID_SCOPE_FLIGHTS.lock().await;
                    if flights.get(&key).is_some_and(|current| {
                        Arc::ptr_eq(current, &runner_flight)
                    }) {
                        flights.remove(&key);
                    }
                }
                *runner_flight
                    .result
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) =
                    Some(result);
                runner_flight.finished.notify_waiters();
            });
            flight
        }
    };

    loop {
        let finished = flight.finished.notified();
        let result = flight
            .result
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        if let Some(result) = result {
            return result.map_err(Into::into);
        }
        finished.await;
    }
}

async fn resolve_analytics_message_id_scope_for_range_uncached(
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    db: &DatabaseConnection,
    freshness_max_age_ms: u64,
) -> Result<AnalyticsMessageIdScope, AppError> {
    #[derive(FromQueryResult)]
    struct MessageIdBounds {
        min_id: Option<i64>,
        max_id: Option<i64>,
    }

    let bounds = MessageIdBounds::find_by_statement(
        analytics_message_id_scope_statement(dt_since, dt_till),
    )
    .one(db)
    .await
    .context(h!())?
    .unwrap_or(MessageIdBounds {
        min_id: None,
        max_id: None,
    });
    let (Some(min_id), Some(max_id)) = (bounds.min_id, bounds.max_id) else {
        return Ok(AnalyticsMessageIdScope::Empty);
    };

    let freshness_max_age_ms =
        <i64 as std::convert::TryFrom<u64>>::try_from(freshness_max_age_ms)
            .context(h!())?;
    let closed_range_cutoff =
        Utc::now().naive_utc() - Duration::milliseconds(freshness_max_age_ms);
    if dt_till <= closed_range_cutoff {
        Ok(AnalyticsMessageIdScope::Inclusive { min_id, max_id })
    } else {
        Ok(AnalyticsMessageIdScope::From(min_id))
    }
}

fn analytics_message_id_scope_statement(
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> Statement {
    Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"
SELECT min(id) AS min_id, max(id) AS max_id
FROM public.sigint_inbox_item
WHERE datetime >= $1
  AND datetime < $2
"#,
        [dt_since.into(), dt_till.into()],
    )
}

struct AnalyticsFrequencyScopes {
    current: AnalyticsMessageIdScope,
    comparison: AnalyticsMessageIdScope,
}

async fn resolve_analytics_frequency_scopes(
    req: &AnalysisStatsReq,
    db: &DatabaseConnection,
    freshness_max_age_ms: u64,
) -> Result<AnalyticsFrequencyScopes, AppError> {
    const COMPARISON_PERIOD_DAYS: u8 = 10;

    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let comparison_period_start = dt_since
        - Duration::try_days(COMPARISON_PERIOD_DAYS.into())
            .context(h!())
            .map_err(Into::<AppError>::into)?;
    let current = resolve_analytics_message_id_scope_for_range(
        dt_since,
        dt_till,
        db,
        freshness_max_age_ms,
    )
    .await?;
    let comparison = resolve_analytics_message_id_scope_for_range(
        comparison_period_start,
        dt_since,
        db,
        freshness_max_age_ms,
    )
    .await?;
    Ok(AnalyticsFrequencyScopes {
        current,
        comparison,
    })
}

fn apply_analytics_message_id_scope<E>(
    query: Select<E>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Select<E>
where
    E: EntityTrait,
{
    match scope {
        Some(scope) => query
            .filter(scope.condition((
                sigint_inbox_item::Entity,
                sigint_inbox_item::Column::Id,
            )))
            .filter(scope.condition((
                signal_message::Entity,
                signal_message::Column::Id,
            ))),
        None => query,
    }
}

fn apply_analytics_group_message_id_scope<E>(
    query: Select<E>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Select<E>
where
    E: EntityTrait,
{
    match scope {
        Some(scope) => query.filter(scope.condition((
            signal_message_group::Entity,
            signal_message_group::Column::SignalMessageId,
        ))),
        None => query,
    }
}

fn filter_selected_networks_for_scope<E>(
    query: Select<E>,
    selected_networks: &Option<Vec<i64>>,
    without_network: &Option<bool>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Select<E>, AppError>
where
    E: EntityTrait,
{
    if scope.is_some() {
        filter_selected_networks_analytics(
            query,
            selected_networks,
            without_network,
            scope,
        )
    } else {
        filter_selected_networks(query, selected_networks, without_network)
    }
}

pub(in crate::rer_importer) fn filter_selected_aors_for_scope<E>(
    mut query: Select<E>,
    selected_aors: &Option<Vec<i64>>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Select<E>, AppError>
where
    E: EntityTrait,
{
    let Some(selected_aors) =
        selected_aors.as_ref().filter(|aors| !aors.is_empty())
    else {
        return Ok(query);
    };
    let Some(scope) = scope else {
        return Ok(filter_selected_aors(query, &Some(selected_aors.clone()))
            .context(h!())?);
    };

    let link_alias = Alias::new("analytics_message_aor_link");
    let selected_aor_alias = Alias::new("analytics_selected_aor");
    let matches_alias = Alias::new("analytics_selected_aor_message");
    let mut matches = Query::select();
    matches
        .distinct()
        .column((link_alias.clone(), Alias::new("sigint_inbox_item_id")))
        .from_as(
            (
                Alias::new("echo_clickhouse_derived"),
                Alias::new("message_aor_link"),
            ),
            link_alias.clone(),
        )
        .join_as(
            JoinType::InnerJoin,
            area_of_responsibility::Entity,
            selected_aor_alias.clone(),
            Condition::all()
                .add(
                    Expr::col((
                        selected_aor_alias.clone(),
                        area_of_responsibility::Column::Id,
                    ))
                    .is_in(selected_aors.clone()),
                )
                .add(aor_bounds_overlap_condition(
                    link_alias.clone(),
                    selected_aor_alias,
                )),
        )
        .and_where(
            scope.condition((link_alias, Alias::new("sigint_inbox_item_id"))),
        );
    QuerySelect::query(&mut query).join_subquery(
        JoinType::InnerJoin,
        matches.to_owned(),
        matches_alias.clone(),
        Expr::col((matches_alias, Alias::new("sigint_inbox_item_id")))
            .equals((sigint_inbox_item::Entity, sigint_inbox_item::Column::Id)),
    );
    Ok(query)
}

async fn count_distinct_with_db<E>(
    query: Select<E>,
    expression: SimpleExpr,
    db: &DatabaseConnection,
) -> Result<i64, AppError>
where
    E: EntityTrait,
{
    let result = build_distinct_count_query(query, expression)
        .into_model::<DistinctCountRes>()
        .one(db)
        .await
        .context(h!())?
        .unwrap_or(DistinctCountRes { count: 0 });
    Ok(result.count)
}

fn build_distinct_count_query<E>(
    query: Select<E>,
    expression: SimpleExpr,
) -> Select<E>
where
    E: EntityTrait,
{
    query.select_only().column_as(
        Expr::cust_with_expr("COUNT(DISTINCT $1)", expression),
        "count",
    )
}

pub async fn fetch_groups(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsGroup>, AppError> {
    let login_value = login_id_from_identity(user)?;
    fetch_groups_for_login(&req.0, &login_value, env, master_keys).await
}

pub async fn fetch_groups_for_login(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsGroup>, AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).c(h!())?;
    let dt_till = dt_from_millis(req.till_date_noninclusive_ms).c(h!())?;
    let req_json = Json(req.clone());

    if let Some((dt_since, dt_till)) =
        stats_aggregated_range(&req_json, env, dt_since, dt_till).c(h!())?
    {
        let result = read_group_stats_aggregated_for_env(
            env,
            master_keys,
            dt_since,
            dt_till,
        )
        .await
        .c(h!())?;
        return Ok(result);
    }
    fetch_groups_for_login_with_db(
        req,
        login_str,
        &env.dbx,
        master_keys,
        dt_since,
        dt_till,
        None,
    )
    .await
}

pub(super) async fn fetch_groups_raw_with_db(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Vec<AnalysisStatsGroup>, AppError> {
    if scope.is_some_and(|scope| scope.is_empty()) {
        return Ok(Vec::new());
    }
    let login_value = login_id_from_identity(user)?;
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).c(h!())?;
    let dt_till = dt_from_millis(req.till_date_noninclusive_ms).c(h!())?;
    fetch_groups_for_login_with_db(
        &req.0,
        &login_value,
        db,
        master_keys,
        dt_since,
        dt_till,
        scope,
    )
    .await
}

pub(super) async fn fetch_group_activity_stats_with_db(
    db: &DatabaseConnection,
    group_keys: Vec<String>,
) -> Result<
    BTreeMap<String, crate::messenger::group::types::SignalGroupStats>,
    AppError,
> {
    if group_keys.is_empty() {
        return Ok(BTreeMap::new());
    }

    let now = Utc::now().naive_utc();
    let day_cutoff = now - Duration::days(1);
    let week_cutoff = now - Duration::days(7);
    let min_id = signal_message::Entity::find()
        .select_only()
        .column_as(signal_message::Column::Id.min(), "min_id")
        .filter(signal_message::Column::Timestamp.gte(week_cutoff))
        .into_tuple::<Option<i64>>()
        .one(db)
        .await
        .context(h!())?
        .flatten();
    let scope = match min_id {
        Some(min_id) => AnalyticsMessageIdScope::From(min_id),
        None => AnalyticsMessageIdScope::Empty,
    };
    let rows = build_group_activity_stats_query(
        group_keys.clone(),
        day_cutoff,
        week_cutoff,
        &scope,
    )
    .into_tuple::<(String, i64, i64)>()
    .all(db)
    .await
    .context(h!())?;
    let counts = rows
        .into_iter()
        .map(|(master_key, activity_last_day, activity_last_week)| {
            (
                master_key,
                crate::messenger::group::types::SignalGroupStats {
                    activity_last_day,
                    activity_last_week,
                },
            )
        })
        .collect::<BTreeMap<_, _>>();
    Ok(group_keys
        .into_iter()
        .map(|key| {
            let stats = counts.get(&key).cloned().unwrap_or_default();
            (key, stats)
        })
        .collect())
}

pub(super) fn build_group_activity_stats_query(
    group_keys: Vec<String>,
    day_cutoff: NaiveDateTime,
    week_cutoff: NaiveDateTime,
    scope: &AnalyticsMessageIdScope,
) -> Select<signal_message_group::Entity> {
    let query = signal_message_group::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message_group::Relation::SignalMessage.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message_group::Relation::SignalGroup.def(),
        )
        .select_only()
        .column(signal_group::Column::MasterKey)
        .column_as(
            Expr::cust_with_expr(
                "COUNT(*) FILTER (WHERE $1)",
                Expr::col(signal_message::Column::Timestamp).gte(day_cutoff),
            ),
            "activity_last_day",
        )
        .column_as(Expr::cust("COUNT(*)"), "activity_last_week")
        .group_by(signal_group::Column::MasterKey)
        .filter(signal_group::Column::Deleted.eq(false))
        .filter(signal_group::Column::MasterKey.eq_any(group_keys))
        .filter(signal_message::Column::Timestamp.gte(week_cutoff));
    let query = apply_analytics_message_id_scope(query, Some(scope));
    apply_analytics_group_message_id_scope(query, Some(scope))
}

async fn fetch_groups_for_login_with_db(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Vec<AnalysisStatsGroup>, AppError> {
    let instant = std::time::Instant::now();
    trace!("get identity master keys op took: {:?}", instant.elapsed());
    #[derive(FromQueryResult)]
    struct GroupsRes {
        master_key: Option<String>,
        count: i64,
    }
    let instant = std::time::Instant::now();

    let groups_res = build_groups_query(
        req,
        login_str,
        dt_since,
        dt_till,
        master_keys,
        scope,
    )?;

    let groups_res: Vec<GroupsRes> =
        groups_res.into_model::<GroupsRes>().all(db).await.c(h!())?;
    let mut groups = vec![];
    for x in groups_res {
        let Some(master_key) = x.master_key else {
            continue;
        };
        groups.push(AnalysisStatsGroup {
            master_key,
            count: x.count,
        });
    }
    debug!("groups op took: {:?}", instant.elapsed());
    Ok(groups)
}

fn apply_metadata_filters<E>(
    query: Select<E>,
    req: &AnalysisStatsReq,
) -> Result<Select<E>, AppError>
where
    E: EntityTrait,
{
    Ok(
        filter_selected_metadata_for_analysis_stats(query, req)
            .context(h!())?,
    )
}

fn effective_groups_with_access(
    selected_groups: &Option<Vec<String>>,
    allowed_groups: &[String],
) -> Vec<String> {
    let allowed_groups_set = allowed_groups.iter().collect::<HashSet<_>>();

    selected_groups
        .as_ref()
        .filter(|groups| !groups.is_empty())
        .map(|groups| {
            groups
                .iter()
                .filter(|group| allowed_groups_set.contains(group))
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| allowed_groups.to_vec())
}

fn apply_joined_group_rows_filter<Q>(
    query: Q,
    selected_groups: &Option<Vec<String>>,
    selected_senders: &Option<Vec<String>>,
    allowed_groups: &[String],
) -> Q
where
    Q: QueryFilter,
{
    let effective_groups =
        effective_groups_with_access(selected_groups, allowed_groups);

    let query = if effective_groups.is_empty() {
        query.filter(Expr::cust("FALSE"))
    } else {
        query.filter(
            signal_message_group::Column::GroupMasterKey
                .eq_any(effective_groups),
        )
    };

    match selected_senders
        .as_ref()
        .filter(|senders| !senders.is_empty())
    {
        Some(selected_senders) => query.filter(
            signal_message_group::Column::Sender
                .eq_any(selected_senders.clone()),
        ),
        None => query,
    }
}

fn apply_message_access_filter<E>(
    mut query: Select<E>,
    selected_groups: &Option<Vec<String>>,
    selected_senders: &Option<Vec<String>>,
    allowed_groups: &[String],
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Select<E>, AppError>
where
    E: EntityTrait,
{
    let Some(scope) = scope else {
        let query =
            query.filter(message_in_groups_exists(allowed_groups.to_vec()));
        return filter_selected_groups_and_senders_with_access(
            query,
            selected_groups,
            selected_senders,
            allowed_groups,
        );
    };

    let effective_groups =
        effective_groups_with_access(selected_groups, allowed_groups);
    if effective_groups.is_empty() {
        return Ok(query.filter(Expr::cust("FALSE")));
    }

    let access_alias = Alias::new("analytics_message_access");
    QuerySelect::query(&mut query).join_as(
        JoinType::InnerJoin,
        signal_message_group::Entity,
        access_alias.clone(),
        Expr::col((
            access_alias.clone(),
            signal_message_group::Column::SignalMessageId,
        ))
        .equals((signal_message::Entity, signal_message::Column::Id)),
    );
    query = query
        .filter(
            Expr::col((
                access_alias.clone(),
                signal_message_group::Column::GroupMasterKey,
            ))
            .is_in(effective_groups),
        )
        .filter(scope.condition((
            access_alias.clone(),
            signal_message_group::Column::SignalMessageId,
        )));
    if let Some(selected_senders) = selected_senders
        .as_ref()
        .filter(|senders| !senders.is_empty())
    {
        query = query.filter(
            Expr::col((access_alias, signal_message_group::Column::Sender))
                .is_in(selected_senders.clone()),
        );
    }
    Ok(query)
}

pub async fn count_groups(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<i64, AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).c(h!())?;
    let dt_till = dt_from_millis(req.till_date_noninclusive_ms).c(h!())?;
    let read_db = env.replica();
    let login_value = login_id_from_identity(user)?;
    let groups_res = build_groups_query(
        &req.0,
        &login_value,
        dt_since,
        dt_till,
        master_keys,
        None,
    )?;
    let count = groups_res.count(&read_db).await.c(h!())?;
    Ok(count as i64)
}

pub(super) fn build_groups_query(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
    let req = request_without_facet_filter(req, AnalysisFacet::Groups);
    let accessible_groups = master_keys.clone();
    let groups_res = sigint_inbox_item::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintPost.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SignalMessageGroup.def(),
        )
        .select_only()
        .column_as(
            Expr::col((
                signal_message_group::Entity,
                signal_message_group::Column::GroupMasterKey,
            )),
            "master_key",
        )
        .column_as(
            Expr::cust(
                r#"COUNT(DISTINCT "signal_message_group"."signal_message_id")"#,
            ),
            "count",
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till))
        .group_by(Expr::col((
            signal_message_group::Entity,
            signal_message_group::Column::GroupMasterKey,
        )));
    apply_group_stats_filters(
        groups_res,
        &None,
        &req.selected_senders,
        &req,
        login_str,
        accessible_groups,
        dt_since,
        dt_till,
        scope,
    )
}

fn apply_group_stats_filters(
    query: Select<sigint_inbox_item::Entity>,
    selected_groups: &Option<Vec<String>>,
    selected_senders: &Option<Vec<String>>,
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    accessible_groups: Vec<String>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
    let include_peleng_locations =
        req.include_peleng_locations.unwrap_or(false);
    let query = apply_analytics_message_id_scope(query, scope);
    let query = apply_analytics_group_message_id_scope(query, scope);
    let query = apply_joined_group_rows_filter(
        query,
        selected_groups,
        selected_senders,
        &accessible_groups,
    );
    let query =
        filter_selected_freqs(query, &req.selected_freqs).context(h!())?;
    let query =
        filter_selected_posts(query, &req.selected_posts).context(h!())?;
    let query = filter_selected_units_for_period(
        query,
        &req.selected_units,
        &req.units_exact_match_only,
        dt_since,
        dt_till,
    )
    .context(h!())?;
    let query = filter_selected_locations(
        query,
        &req.selected_locations,
        include_peleng_locations,
    )
    .context(h!())?;
    let query = filter_selected_callsigns(query, &req.selected_callsigns)
        .context(h!())?;
    let query = filter_selected_networks_for_scope(
        query,
        &req.selected_networks,
        &req.without_network,
        scope,
    )
    .context(h!())?;
    let query = apply_metadata_filters(query, req)?;
    let query = filter_search(query, &req.search).context(h!())?;
    let query =
        filter_selected_device_names(query, &req.selected_device_names)?;
    let query =
        filter_selected_aors_for_scope(query, &req.selected_aors, scope)?;
    let query = match selected_aor_group_facet_condition(&req.selected_aors) {
        Some(condition) => query.filter(condition),
        None => query,
    };
    Ok(filter_selected_tags_with_scope(
        query,
        &req.selected_tags,
        &req.denied_tags,
        &req.tag_presence,
        &req.or_bookmarked,
        &req.or_important,
        &req.or_with_coords,
        &req.or_without_coords,
        &req.or_with_extended_form,
        &req.filter_tags_option,
        &req.without_model_tags,
        login_str,
        req.report_tags_only_this_unit.unwrap_or(false),
        scope,
    )
    .context(h!())?)
}

#[derive(FromQueryResult)]
pub(super) struct AnalysisDailyGroupActivity {
    pub(super) msg_date: NaiveDate,
    pub(super) group: String,
    pub(super) value: i64,
}

pub(super) async fn fetch_daily_group_activity_with_db(
    req: &AnalysisStatsReq,
    user: &Identity,
    db: &DatabaseConnection,
    accessible_groups: Vec<String>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Vec<AnalysisDailyGroupActivity>, AppError> {
    let login = login_id_from_identity(user)?;
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let query = sigint_inbox_item::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintPost.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SignalMessageGroup.def(),
        )
        .join(
            JoinType::LeftJoin,
            signal_message_group::Relation::SignalGroup.def(),
        )
        .select_only()
        .column_as(
            Expr::cust(
                "(sigint_inbox_item.datetime AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Kyiv')::date",
            ),
            "msg_date",
        )
        .column_as(
            Expr::cust(
                "coalesce(signal_group.name, signal_message_group.group_master_key)",
            ),
            "group",
        )
        .column_as(
            Expr::cust(
                r#"COUNT(DISTINCT "signal_message_group"."signal_message_id")"#,
            ),
            "value",
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till))
        .group_by(Expr::cust("1, 2"))
        .order_by_desc(Expr::cust("1"));
    let query = apply_group_stats_filters(
        query,
        &req.selected_groups,
        &req.selected_senders,
        req,
        &login,
        accessible_groups,
        dt_since,
        dt_till,
        scope,
    )?;
    Ok(query
        .into_model::<AnalysisDailyGroupActivity>()
        .all(db)
        .await
        .context(h!())?)
}

#[derive(FromQueryResult)]
struct AnalysisCallsignRelationMessageRow {
    message_id: i64,
    freq: Option<String>,
    callsigns: serde_json::Value,
}

fn callsign_relation_messages_query(
    req: &AnalysisStatsReq,
    required_callsigns: Option<&[String]>,
    user: &Identity,
    accessible_groups: Vec<String>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
    let login = login_id_from_identity(user)?;
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let query = sigint_inbox_item::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintPost.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SignalMessageGroup.def(),
        )
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SigintInboxItemCallsign.def(),
        )
        .select_only()
        .column_as(signal_message::Column::Id, "message_id")
        .column_as(sigint_inbox_item::Column::Freq, "freq")
        .column_as(
            Expr::cust(
                "jsonb_agg(sigint_inbox_item_callsign.callsign order by sigint_inbox_item_callsign.ordering, sigint_inbox_item_callsign.id)",
            ),
            "callsigns",
        )
        .group_by(signal_message::Column::Id)
        .group_by(sigint_inbox_item::Column::Freq)
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till))
        .filter(Expr::cust(crate::inbox::callsigns::sql_exists_condition("sigint_inbox_item")))
        .filter(sigint_inbox_item_callsign::Column::Deleted.eq(false));
    let query = if let Some(required_callsigns) = required_callsigns {
        let required_callsigns = required_callsigns
            .iter()
            .map(|callsign| callsign.trim())
            .filter(|callsign| !callsign.is_empty())
            .collect::<Vec<_>>();
        if required_callsigns.is_empty() {
            query.filter(Expr::cust("FALSE"))
        } else {
            let condition = required_callsigns.into_iter().fold(
                Condition::any(),
                |condition, callsign| {
                    condition.add(Expr::cust_with_values(
                        "exists (select 1 from sigint_inbox_item_callsign siic where siic.sigint_inbox_item_id = sigint_inbox_item.id and not siic.deleted and siic.callsign = $1)",
                        vec![callsign],
                    ))
                },
            );
            query.filter(condition)
        }
    } else {
        query
    };
    apply_group_stats_filters(
        query,
        &req.selected_groups,
        &req.selected_senders,
        req,
        &login,
        accessible_groups,
        dt_since,
        dt_till,
        scope,
    )
}

pub(super) async fn fetch_callsign_relation_messages_with_db(
    req: &AnalysisStatsReq,
    required_callsigns: Option<&[String]>,
    user: &Identity,
    db: &DatabaseConnection,
    accessible_groups: Vec<String>,
    scope: Option<&AnalyticsMessageIdScope>,
    row_limit: Option<u64>,
) -> Result<Vec<NetworkCallsignRelationMessage>, AppError> {
    let query = callsign_relation_messages_query(
        req,
        required_callsigns,
        user,
        accessible_groups,
        scope,
    )?;
    let query = match row_limit {
        Some(row_limit) => query.limit(row_limit),
        None => query,
    };
    let rows = query
        .into_model::<AnalysisCallsignRelationMessageRow>()
        .all(db)
        .await
        .context(h!())?;

    rows.into_iter()
        .map(|row| {
            Ok(NetworkCallsignRelationMessage {
                id: row.message_id,
                timestamp: None,
                freq: row.freq,
                text: String::new(),
                callsigns: serde_json::from_value(row.callsigns)
                    .context(h!())?,
            })
        })
        .collect()
}

#[derive(FromQueryResult)]
struct AnalysisCallsignFrequencyMatchRow {
    freq: String,
    callsigns: serde_json::Value,
    message_count: i64,
}

fn callsign_frequency_matches_statement(
    filtered_messages: Select<sigint_inbox_item::Entity>,
    required_callsigns: Vec<String>,
    min_matches: i64,
) -> Statement {
    let filtered_messages = filtered_messages.into_query().to_owned();
    let filtered_alias = Alias::new("filtered_callsign_messages");
    let filtered_cte = CommonTableExpression::new()
        .query(filtered_messages)
        .table_name(filtered_alias.clone())
        .to_owned();

    let message_id_alias = Alias::new("message_id");
    let freq_alias = Alias::new("freq");
    let callsigns_alias = Alias::new("callsigns");
    let callsign_alias = Alias::new("callsign");
    let expanded_alias = Alias::new("expanded_callsign_messages");
    let expanded_query = Query::select()
        .column((filtered_alias.clone(), message_id_alias.clone()))
        .column((filtered_alias.clone(), freq_alias.clone()))
        .expr_as(
            Expr::cust("jsonb_array_elements_text(callsigns)"),
            callsign_alias.clone(),
        )
        .from(filtered_alias)
        .to_owned();
    let expanded_cte = CommonTableExpression::new()
        .query(expanded_query)
        .table_name(expanded_alias.clone())
        .to_owned();

    let mut matches_query = Query::select()
        .column((expanded_alias.clone(), freq_alias.clone()))
        .expr_as(
            Expr::cust("jsonb_agg(DISTINCT callsign ORDER BY callsign)"),
            callsigns_alias,
        )
        .expr_as(
            Expr::cust("COUNT(DISTINCT message_id)"),
            Alias::new("message_count"),
        )
        .from(expanded_alias)
        .and_where(Expr::col(freq_alias.clone()).is_not_null())
        .and_where(Expr::cust("btrim(freq) <> ''"))
        .and_where(Expr::cust_with_values(
            "callsign = ANY($1)",
            vec![required_callsigns],
        ))
        .add_group_by([Expr::col(freq_alias.clone())])
        .and_having(Expr::cust_with_values(
            "COUNT(DISTINCT callsign) >= $1",
            vec![std::cmp::max(min_matches, 1)],
        ))
        .order_by_expr(Expr::cust("COUNT(DISTINCT callsign)"), Order::Desc)
        .order_by_expr(Expr::cust("message_count"), Order::Desc)
        .order_by_expr(Expr::col(freq_alias), Order::Asc)
        .to_owned();
    matches_query.limit(ANALYSIS_CALLSIGN_FREQUENCY_MATCH_LIMIT);
    let matches_query = Query::with()
        .cte(filtered_cte)
        .cte(expanded_cte)
        .clone()
        .query(matches_query);
    DbBackend::Postgres.build(&matches_query)
}

pub(super) async fn fetch_callsign_frequency_matches_with_db(
    req: &AnalysisStatsReq,
    required_callsigns: &[String],
    min_matches: i64,
    user: &Identity,
    db: &DatabaseConnection,
    accessible_groups: Vec<String>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Vec<AnalysisCallsignFrequencyMatch>, AppError> {
    let required_callsigns = required_callsigns
        .iter()
        .map(|callsign| callsign.trim())
        .filter(|callsign| !callsign.is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    if required_callsigns.is_empty() {
        return Ok(Vec::new());
    }

    let filtered_messages = callsign_relation_messages_query(
        req,
        Some(&required_callsigns),
        user,
        accessible_groups,
        scope,
    )?;
    let statement = callsign_frequency_matches_statement(
        filtered_messages,
        required_callsigns,
        min_matches,
    );
    let rows = AnalysisCallsignFrequencyMatchRow::find_by_statement(statement)
        .all(db)
        .await
        .context(h!())?;

    rows.into_iter()
        .map(|row| {
            Ok(AnalysisCallsignFrequencyMatch {
                freq: row.freq,
                callsigns: serde_json::from_value(row.callsigns)
                    .context(h!())?,
                message_count: row.message_count,
            })
        })
        .collect()
}

pub async fn fetch_senders(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsSender>, AppError> {
    let login_value = login_id_from_identity(user)?;
    fetch_senders_for_login(&req.0, &login_value, env, master_keys).await
}

pub async fn fetch_senders_for_login(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsSender>, AppError> {
    let req = Json(req.clone());
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;

    if let Some((dt_since, dt_till)) =
        stats_aggregated_range(&req, env, dt_since, dt_till).c(h!())?
    {
        let result =
            read_sender_stats_aggregated(env, master_keys, dt_since, dt_till)
                .await
                .c(h!())?;
        return Ok(result);
    }

    fetch_senders_for_login_with_db(
        &req,
        login_str,
        env,
        &env.dbx,
        master_keys,
        None,
    )
    .await
}

pub(super) async fn fetch_senders_raw_with_db(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &Env,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
    freshness_max_age_ms: u64,
) -> Result<Vec<AnalysisStatsSender>, AppError> {
    let login_value = login_id_from_identity(user)?;
    let scope =
        resolve_analytics_message_id_scope(&req.0, db, freshness_max_age_ms)
            .await?;
    if scope.is_empty() {
        return Ok(Vec::new());
    }
    fetch_senders_for_login_with_db(
        req,
        &login_value,
        env,
        db,
        master_keys,
        Some(&scope),
    )
    .await
}

async fn fetch_senders_for_login_with_db(
    req: &Json<AnalysisStatsReq>,
    login_str: &uuid::Uuid,
    env: &Env,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Vec<AnalysisStatsSender>, AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;

    #[derive(FromQueryResult)]
    struct SenderBreakdownRes {
        uuid: Option<String>,
        freq: Option<String>,
        post_id: Option<i64>,
        date: String,
        count: i64,
    }

    let instant = std::time::Instant::now();
    let breakdown_query = build_sender_breakdown_query(
        req,
        login_str,
        dt_since,
        dt_till,
        master_keys,
        scope,
    )?;
    let breakdown_rows: Vec<SenderBreakdownRes> = breakdown_query
        .into_model::<SenderBreakdownRes>()
        .all(db)
        .await
        .context(h!())?;

    let post_ids = breakdown_rows
        .iter()
        .filter_map(|row| row.post_id)
        .collect::<BTreeSet<_>>();
    let post_ids = post_ids.into_iter().collect::<Vec<_>>();
    let post_names = if post_ids.is_empty() {
        BTreeMap::new()
    } else {
        sigint_post::Entity::find()
            .filter(sigint_post::Column::Id.eq_any(post_ids))
            .all(&env.dbx)
            .await
            .context(h!())?
            .into_iter()
            .map(|post| (post.id, post.name))
            .collect::<BTreeMap<_, _>>()
    };
    let mut sender_counts = BTreeMap::<String, i64>::new();
    let mut freq_map =
        BTreeMap::<String, BTreeMap<(Option<String>, Option<i64>), i64>>::new();
    let mut per_day_map: BTreeMap<String, BTreeMap<String, i64>> =
        BTreeMap::new();
    for row in breakdown_rows {
        let Some(uuid) = row.uuid else { continue };
        sender_counts
            .entry(uuid.clone())
            .and_modify(|count| *count += row.count)
            .or_insert(row.count);
        freq_map
            .entry(uuid.clone())
            .or_default()
            .entry((row.freq, row.post_id))
            .and_modify(|count| *count += row.count)
            .or_insert(row.count);
        per_day_map
            .entry(uuid)
            .or_default()
            .entry(row.date)
            .and_modify(|c| *c += row.count)
            .or_insert(row.count);
    }

    let mut senders = vec![];
    for (uuid, count) in sender_counts {
        let freq_breakdown = freq_map
            .remove(&uuid)
            .unwrap_or_default()
            .into_iter()
            .map(|((freq, post_id), count)| SenderFrequencyBreakdown {
                freq,
                post: post_id.and_then(|id| post_names.get(&id).cloned()),
                count,
            })
            .collect();
        let per_day = per_day_map.remove(&uuid).unwrap_or_default();
        senders.push(AnalysisStatsSender {
            uuid,
            count,
            freq_breakdown,
            per_day,
        });
    }
    debug!("senders op took: {:?}", instant.elapsed());
    Ok(senders)
}

pub(super) fn build_sender_breakdown_query(
    req: &Json<AnalysisStatsReq>,
    login_str: &uuid::Uuid,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
    let req =
        Json(request_without_facet_filter(&req.0, AnalysisFacet::Senders));
    let sender_stats_groups = sender_stats_groups(&req, &master_keys);
    let per_day_expr = Expr::cust_with_exprs(
        "to_char(($1 AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Kyiv')::date, 'DD.MM.YYYY')",
        [Expr::col(sigint_inbox_item::Column::Datetime).into_simple_expr()],
    );
    let breakdown_query =
        build_join_for_sender_stats(&sender_stats_groups, scope)
            .select_only()
            .column_as(signal_message_group::Column::Sender, "uuid")
            .column(sigint_inbox_item::Column::Freq)
            .column(sigint_inbox_item::Column::PostId)
            .column_as(per_day_expr.clone(), "date")
            .column_as(
                Expr::cust(r#"COUNT(DISTINCT "signal_message"."id")"#),
                "count",
            )
            .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
            .filter(sigint_inbox_item::Column::Datetime.lt(dt_till))
            .group_by(signal_message_group::Column::Sender)
            .group_by(sigint_inbox_item::Column::Freq)
            .group_by(sigint_inbox_item::Column::PostId)
            .group_by(per_day_expr);
    let breakdown_query = apply_sender_dimension_filters(breakdown_query, &req);
    let breakdown_query = apply_sender_filters_for_login(
        breakdown_query,
        &req,
        dt_since,
        dt_till,
        login_str,
        master_keys,
        scope,
        true,
    )?;
    Ok(breakdown_query)
}

pub async fn count_senders(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<i64, AppError> {
    let read_db = env.replica();
    count_senders_with_db(req, user, &read_db, master_keys, None).await
}

pub(super) async fn count_senders_with_db(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<i64, AppError> {
    if scope.is_some_and(|scope| scope.is_empty()) {
        return Ok(0);
    }
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let login_value = login_id_from_identity(user)?;

    let instant = std::time::Instant::now();
    trace!("get identity master keys op took: {:?}", instant.elapsed());
    let senders_res = build_senders_filtered_query(
        &req,
        &login_value,
        dt_since,
        dt_till,
        master_keys,
        scope,
    )?;
    count_distinct_with_db(
        senders_res,
        Expr::col((
            signal_message_group::Entity,
            signal_message_group::Column::Sender,
        )),
        db,
    )
    .await
}

fn build_senders_filtered_query(
    req: &&Json<AnalysisStatsReq>,
    login_str: &uuid::Uuid,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
    let req =
        Json(request_without_facet_filter(&req.0, AnalysisFacet::Senders));
    let include_peleng_locations =
        req.include_peleng_locations.unwrap_or(false);
    let sender_stats_groups = sender_stats_groups(&req, &master_keys);
    let senders_res = build_join_for_sender_stats(&sender_stats_groups, scope)
        // .filter(signal_message::Column::DuplicateOf.is_null())
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till));
    let senders_res = apply_sender_dimension_filters(senders_res, &req);
    let senders_res = if scope.is_some() {
        senders_res
    } else {
        filter_selected_groups_and_senders_with_access(
            senders_res,
            &req.selected_groups,
            &req.selected_senders,
            &master_keys,
        )
        .context(h!())?
    };
    let senders_res = filter_selected_freqs(senders_res, &req.selected_freqs)
        .context(h!())?;
    let senders_res = filter_selected_posts(senders_res, &req.selected_posts)
        .context(h!())?;
    let senders_res = filter_selected_units_for_period(
        senders_res,
        &req.selected_units,
        &req.units_exact_match_only,
        dt_since,
        dt_till,
    )
    .context(h!())?;
    let senders_res = filter_selected_locations(
        senders_res,
        &req.selected_locations,
        include_peleng_locations,
    )
    .context(h!())?;
    let senders_res =
        filter_selected_callsigns(senders_res, &req.selected_callsigns)
            .context(h!())?;
    let senders_res = filter_selected_tags_with_scope(
        senders_res,
        &req.selected_tags,
        &req.denied_tags,
        &req.tag_presence,
        &req.or_bookmarked,
        &req.or_important,
        &req.or_with_coords,
        &req.or_without_coords,
        &req.or_with_extended_form,
        &req.filter_tags_option,
        &req.without_model_tags,
        login_str,
        req.report_tags_only_this_unit.unwrap_or(false),
        scope,
    )
    .context(h!())?;
    let senders_res = filter_selected_networks_for_scope(
        senders_res,
        &req.selected_networks,
        &req.without_network,
        scope,
    )
    .context(h!())?;
    let senders_res = apply_metadata_filters(senders_res, &req.0)?;
    let senders_res = filter_search(senders_res, &req.search).context(h!())?;
    let senders_res =
        filter_selected_device_names(senders_res, &req.selected_device_names)?;
    filter_selected_aors_for_scope(senders_res, &req.selected_aors, scope)
}

fn sender_stats_groups(
    req: &Json<AnalysisStatsReq>,
    master_keys: &[String],
) -> Vec<String> {
    effective_groups_with_access(&req.selected_groups, master_keys)
}

fn build_join_for_sender_stats(
    sender_stats_groups: &[String],
    scope: Option<&AnalyticsMessageIdScope>,
) -> Select<Entity> {
    let sender_stats_groups = sender_stats_groups.to_vec();

    let query = build_join_for_sigint_inbox_item().join(
        JoinType::InnerJoin,
        signal_message::Relation::SignalMessageGroup.def(),
    );

    let query = apply_analytics_message_id_scope(query, scope);
    let query = apply_analytics_group_message_id_scope(query, scope);

    if sender_stats_groups.is_empty() {
        query.filter(Expr::cust("FALSE"))
    } else {
        query.filter(
            signal_message_group::Column::GroupMasterKey
                .eq_any(sender_stats_groups),
        )
    }
}

fn apply_sender_dimension_filters(
    query: Select<Entity>,
    req: &Json<AnalysisStatsReq>,
) -> Select<Entity> {
    match req
        .selected_senders
        .as_ref()
        .filter(|senders| !senders.is_empty())
    {
        Some(selected_senders) => query.filter(
            signal_message_group::Column::Sender
                .eq_any(selected_senders.clone()),
        ),
        None => query,
    }
}

fn apply_sender_filters_for_login<E>(
    query: Select<E>,
    req: &Json<AnalysisStatsReq>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    login_str: &uuid::Uuid,
    master_keys: Vec<String>,
    scope: Option<&AnalyticsMessageIdScope>,
    group_access_already_filtered: bool,
) -> Result<Select<E>, AppError>
where
    E: EntityTrait,
{
    let include_peleng_locations =
        req.include_peleng_locations.unwrap_or(false);
    let query = if scope.is_some() {
        if group_access_already_filtered {
            query
        } else {
            apply_message_access_filter(
                query,
                &req.selected_groups,
                &req.selected_senders,
                &master_keys,
                scope,
            )?
        }
    } else {
        filter_selected_groups_and_senders_with_access(
            query,
            &req.selected_groups,
            &req.selected_senders,
            &master_keys,
        )
        .context(h!())?
    };
    let query =
        filter_selected_freqs(query, &req.selected_freqs).context(h!())?;
    let query =
        filter_selected_posts(query, &req.selected_posts).context(h!())?;
    let query = filter_selected_units_for_period(
        query,
        &req.selected_units,
        &req.units_exact_match_only,
        dt_since,
        dt_till,
    )
    .context(h!())?;
    let query = filter_selected_locations(
        query,
        &req.selected_locations,
        include_peleng_locations,
    )
    .context(h!())?;
    let query = filter_selected_callsigns(query, &req.selected_callsigns)
        .context(h!())?;
    let query = filter_selected_tags_with_scope(
        query,
        &req.selected_tags,
        &req.denied_tags,
        &req.tag_presence,
        &req.or_bookmarked,
        &req.or_important,
        &req.or_with_coords,
        &req.or_without_coords,
        &req.or_with_extended_form,
        &req.filter_tags_option,
        &req.without_model_tags,
        login_str,
        req.report_tags_only_this_unit.unwrap_or(false),
        scope,
    )
    .context(h!())?;
    let query = filter_selected_networks_for_scope(
        query,
        &req.selected_networks,
        &req.without_network,
        scope,
    )
    .context(h!())?;
    let query = apply_metadata_filters(query, &req.0)?;
    let query = filter_search(query, &req.search).context(h!())?;
    let query =
        filter_selected_device_names(query, &req.selected_device_names)?;
    let query =
        filter_selected_aors_for_scope(query, &req.selected_aors, scope)?;
    if scope.is_some()
        || group_access_already_filtered
        || master_keys.is_empty()
    {
        return Ok(query);
    }
    Ok(query.filter(message_in_groups_exists(master_keys)))
}

#[derive(FromQueryResult)]
struct PostsRes {
    post: String,
    count: i64,
}

pub async fn fetch_posts(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsPost>, AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;

    if let Some((dt_since, dt_till)) =
        stats_aggregated_range(req, env, dt_since, dt_till).c(h!())?
    {
        let result =
            read_post_stats_aggregated(env, master_keys, dt_since, dt_till)
                .await
                .c(h!())?;
        return Ok(result);
    }

    fetch_posts_with_db(req, user, &env.dbx, master_keys, None).await
}

pub(super) async fn fetch_posts_raw_with_db(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
    scope: &AnalyticsMessageIdScope,
) -> Result<Vec<AnalysisStatsPost>, AppError> {
    if scope.is_empty() {
        return Ok(Vec::new());
    }
    fetch_posts_with_db(req, user, db, master_keys, Some(scope)).await
}

async fn fetch_posts_with_db(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Vec<AnalysisStatsPost>, AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let login_value = login_id_from_identity(user)?;
    let instant = std::time::Instant::now();
    let post_res = if scope.is_none() && req_allows_stats_aggregated(&req.0) {
        read_unfiltered_post_stats(db, master_keys, dt_since, dt_till).await?
    } else {
        build_posts_query(
            &req,
            &login_value,
            master_keys,
            dt_since,
            dt_till,
            scope,
        )?
        .into_model::<PostsRes>()
        .all(db)
        .await
        .context(h!())?
    };
    let mut posts = vec![];
    for x in post_res {
        posts.push(AnalysisStatsPost {
            post: x.post,
            count: x.count,
        });
    }
    debug!("posts op took: {:?}", instant.elapsed());
    Ok(posts)
}

async fn read_unfiltered_post_stats(
    db: &DatabaseConnection,
    master_keys: Vec<String>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> Result<Vec<PostsRes>, AppError> {
    let sql = r#"
        with recent_inbox as materialized (
            select id, post_id
            from sigint_inbox_item
            where datetime >= $1
              and datetime < $2
        ),
        recent_bounds as materialized (
            select min(id) as min_id
            from recent_inbox
        )
        select
            coalesce(sp.name, '') as post,
            count(distinct ri.id) as count
        from recent_inbox ri
        inner join signal_message sm on sm.id = ri.id
        inner join signal_message_group smg
            on smg.signal_message_id = ri.id
        inner join sigint_post sp on sp.id = ri.post_id
        cross join recent_bounds rb
        where sm.deleted = false
          -- Keep datetime authoritative while bounding the existing
          -- (signal_message_id, group_master_key) index by recent IDs.
          and smg.signal_message_id >= rb.min_id
          and smg.group_master_key = any($3::text[])
        group by 1
    "#;

    Ok(PostsRes::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        sql,
        vec![dt_since.into(), dt_till.into(), master_keys.into()],
    ))
    .all(db)
    .await
    .context(h!())?)
}

pub async fn count_posts(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<i64, AppError> {
    let read_db = env.replica();
    count_posts_with_db(req, user, &read_db, master_keys, None).await
}

pub(super) async fn count_posts_with_db(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<i64, AppError> {
    if scope.is_some_and(|scope| scope.is_empty()) {
        return Ok(0);
    }
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let login_value = login_id_from_identity(user)?;

    let instant = std::time::Instant::now();
    trace!("get identity master keys op took: {:?}", instant.elapsed());
    let posts_res = build_posts_filtered_query(
        &req,
        &login_value,
        master_keys,
        dt_since,
        dt_till,
        scope,
    )?;
    count_distinct_with_db(
        posts_res,
        Expr::col((sigint_post::Entity, sigint_post::Column::Name)).if_null(""),
        db,
    )
    .await
}

fn build_posts_query(
    req: &&Json<AnalysisStatsReq>,
    login_str: &uuid::Uuid,
    master_keys: Vec<String>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
    Ok(build_posts_filtered_query(
        req,
        login_str,
        master_keys,
        dt_since,
        dt_till,
        scope,
    )?
    .select_only()
    .column_as(
        Expr::col((sigint_post::Entity, sigint_post::Column::Name)).if_null(""),
        "post",
    )
    .column_as(
        Expr::cust(r#"COUNT(DISTINCT "signal_message"."id")"#),
        "count",
    )
    .group_by(Expr::cust("1")))
}

fn build_posts_filtered_query(
    req: &&Json<AnalysisStatsReq>,
    login_str: &uuid::Uuid,
    master_keys: Vec<String>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
    let req = Json(request_without_facet_filter(&req.0, AnalysisFacet::Posts));
    let include_peleng_locations =
        req.include_peleng_locations.unwrap_or(false);
    let post_res = sigint_inbox_item::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SigintPost.def(),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        // .filter(signal_message::Column::DuplicateOf.is_null())
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till));
    let post_res = apply_analytics_message_id_scope(post_res, scope);
    let post_res = apply_message_access_filter(
        post_res,
        &req.selected_groups,
        &req.selected_senders,
        &master_keys,
        scope,
    )
    .context(h!())?;
    let post_res = filter_selected_units_for_period(
        post_res,
        &req.selected_units,
        &req.units_exact_match_only,
        dt_since,
        dt_till,
    )
    .context(h!())?;
    let post_res =
        filter_selected_freqs(post_res, &req.selected_freqs).context(h!())?;
    let post_res =
        filter_selected_posts(post_res, &req.selected_posts).context(h!())?;
    let post_res = filter_selected_locations(
        post_res,
        &req.selected_locations,
        include_peleng_locations,
    )
    .context(h!())?;
    let post_res = filter_selected_callsigns(post_res, &req.selected_callsigns)
        .context(h!())?;
    let post_res = filter_selected_tags_with_scope(
        post_res,
        &req.selected_tags,
        &req.denied_tags,
        &req.tag_presence,
        &req.or_bookmarked,
        &req.or_important,
        &req.or_with_coords,
        &req.or_without_coords,
        &req.or_with_extended_form,
        &req.filter_tags_option,
        &req.without_model_tags,
        login_str,
        req.report_tags_only_this_unit.unwrap_or(false),
        scope,
    )
    .context(h!())?;
    let post_res = filter_selected_networks_for_scope(
        post_res,
        &req.selected_networks,
        &req.without_network,
        scope,
    )
    .context(h!())?;
    let post_res = apply_metadata_filters(post_res, &req.0)?;
    let post_res = filter_search(post_res, &req.search).context(h!())?;
    let post_res =
        filter_selected_device_names(post_res, &req.selected_device_names)?;
    let post_res =
        filter_selected_aors_for_scope(post_res, &req.selected_aors, scope)?;
    Ok(post_res)
}

pub async fn fetch_freqs(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsFreq>, AppError> {
    let login_value = login_id_from_identity(user)?;
    fetch_freqs_for_login(&req.0, &login_value, env, master_keys).await
}

pub async fn fetch_freqs_for_login(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsFreq>, AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let req_json = Json(req.clone());

    if let Some((dt_since, dt_till)) =
        stats_aggregated_range(&req_json, env, dt_since, dt_till).c(h!())?
    {
        let result = read_frequency_stats_aggregated(
            env,
            master_keys,
            dt_since,
            dt_till,
        )
        .await
        .c(h!())?;
        return Ok(result);
    }

    fetch_freqs_for_login_with_db(req, login_str, &env.dbx, master_keys, None)
        .await
}

pub(super) async fn fetch_freqs_raw_with_db(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
    freshness_max_age_ms: u64,
) -> Result<Vec<AnalysisStatsFreq>, AppError> {
    let login_value = login_id_from_identity(user)?;
    let scopes =
        resolve_analytics_frequency_scopes(&req.0, db, freshness_max_age_ms)
            .await?;
    if scopes.current.is_empty() {
        return Ok(Vec::new());
    }
    fetch_freqs_for_login_with_db(
        &req.0,
        &login_value,
        db,
        master_keys,
        Some(&scopes),
    )
    .await
}

async fn fetch_freqs_for_login_with_db(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
    analytics_scopes: Option<&AnalyticsFrequencyScopes>,
) -> Result<Vec<AnalysisStatsFreq>, AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let _instant = std::time::Instant::now();

    #[derive(FromQueryResult)]
    struct FreqsRes {
        freq: String,
        count: i64,
    }
    let freqs_res = build_freqs_query(
        req,
        login_str,
        dt_since,
        dt_till,
        master_keys,
        analytics_scopes.map(|scopes| &scopes.current),
    )?;
    // debug!(
    //     "> freqs_res: {}",
    //     freqs_res.build(DbBackend::Postgres).to_string()
    // );

    let new_freqs =
        get_new_freqs_with_scopes(db, dt_since, dt_till, analytics_scopes)
            .await
            .context(h!())?;
    let freqs = freqs_res
        .into_model::<FreqsRes>()
        .all(db)
        .await
        .context(h!())?
        .into_iter()
        .map(|f| AnalysisStatsFreq {
            is_new: new_freqs.iter().any(|freq| freq == &f.freq),
            freq: f.freq,
            count: f.count,
        })
        .collect::<Vec<AnalysisStatsFreq>>();

    // debug!("freqs op took: {:?}", instant.elapsed());
    Ok(freqs)
}

pub(crate) async fn get_new_freqs(
    db: &DatabaseConnection,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> Result<Vec<String>, AppError> {
    get_new_freqs_with_scopes(db, dt_since, dt_till, None).await
}

async fn get_new_freqs_with_scopes(
    db: &DatabaseConnection,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    analytics_scopes: Option<&AnalyticsFrequencyScopes>,
) -> Result<Vec<String>, AppError> {
    let query = build_new_freqs_query(dt_since, dt_till, analytics_scopes)
        .context(h!())?;

    trace!(
        "> get_new_freqs query: {}",
        query.build(DbBackend::Postgres)
    );

    let new_freqs = query.into_tuple::<String>().all(db).await.context(h!())?;

    Ok(new_freqs)
}

fn build_new_freqs_query(
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    analytics_scopes: Option<&AnalyticsFrequencyScopes>,
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
    const COMPARISON_PERIOD_DAYS: u8 = 10;
    let comparison_period_start = dt_since
        - Duration::try_days(COMPARISON_PERIOD_DAYS.into())
            .context(h!())
            .map_err(Into::<AppError>::into)?;
    if let Some(analytics_scopes) = analytics_scopes {
        return Ok(build_new_freqs_analytics_query(
            dt_since,
            dt_till,
            comparison_period_start,
            analytics_scopes,
        ));
    }

    let date_time_col = sigint_inbox_item::Column::Datetime;
    let mut comparison_query = Query::select();
    comparison_query
        .column(sigint_inbox_item::Column::Freq)
        .distinct()
        .and_where(sigint_inbox_item::Column::Freq.is_not_null())
        .and_where(date_time_col.lt(dt_since))
        .and_where(date_time_col.gt(comparison_period_start))
        .from(sigint_inbox_item::Entity);
    let query = sigint_inbox_item::Entity::find()
        .select_only()
        .column(sigint_inbox_item::Column::Freq)
        .distinct()
        .filter(sigint_inbox_item::Column::Freq.is_not_null())
        .filter(date_time_col.gte(dt_since))
        .filter(date_time_col.lte(dt_till))
        .filter(
            sigint_inbox_item::Column::Freq
                .not_in_subquery(comparison_query.to_owned()),
        );
    Ok(query.order_by_asc(sigint_inbox_item::Column::Freq))
}

fn build_new_freqs_analytics_query(
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    comparison_period_start: NaiveDateTime,
    analytics_scopes: &AnalyticsFrequencyScopes,
) -> Select<sigint_inbox_item::Entity> {
    let date_time_col = sigint_inbox_item::Column::Datetime;
    let current_match = date_time_col
        .gte(dt_since)
        .and(date_time_col.lte(dt_till))
        .and(analytics_scopes.current.condition((
            sigint_inbox_item::Entity,
            sigint_inbox_item::Column::Id,
        )));
    let comparison_match = date_time_col
        .lt(dt_since)
        .and(date_time_col.gt(comparison_period_start))
        .and(analytics_scopes.comparison.condition((
            sigint_inbox_item::Entity,
            sigint_inbox_item::Column::Id,
        )));

    sigint_inbox_item::Entity::find()
        .select_only()
        .column(sigint_inbox_item::Column::Freq)
        .filter(sigint_inbox_item::Column::Freq.is_not_null())
        .filter(current_match.clone().or(comparison_match.clone()))
        .group_by(sigint_inbox_item::Column::Freq)
        .having(Expr::cust_with_exprs(
            "COUNT(*) FILTER (WHERE $1) > 0 \
             AND COUNT(*) FILTER (WHERE $2) = 0",
            [current_match, comparison_match],
        ))
        .order_by_asc(sigint_inbox_item::Column::Freq)
}

pub async fn count_freqs(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<i64, AppError> {
    let read_db = env.replica();
    count_freqs_with_db(req, user, &read_db, master_keys, None).await
}

pub(super) async fn count_freqs_with_db(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<i64, AppError> {
    if scope.is_some_and(|scope| scope.is_empty()) {
        return Ok(0);
    }
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;

    let instant = std::time::Instant::now();
    trace!("get identity master keys op took: {:?}", instant.elapsed());
    let login_value = login_id_from_identity(user)?;
    let freqs_res = build_freqs_filtered_query(
        &req.0,
        &login_value,
        dt_since,
        dt_till,
        master_keys,
        scope,
    )?;
    count_distinct_with_db(
        freqs_res,
        Expr::col(sigint_inbox_item::Column::Freq).if_null(""),
        db,
    )
    .await
}

pub(super) fn build_freqs_query(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
    Ok(build_freqs_filtered_query(
        req,
        login_str,
        dt_since,
        dt_till,
        master_keys,
        scope,
    )?
    .select_only()
    .column_as(
        Expr::col(sigint_inbox_item::Column::Freq).if_null(""),
        "freq",
    )
    .column_as(
        Expr::cust(r#"COUNT(DISTINCT "signal_message"."id")"#),
        "count",
    )
    .group_by(Expr::cust("1")))
}

fn build_freqs_filtered_query(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
    let req = request_without_facet_filter(req, AnalysisFacet::Frequencies);
    let include_peleng_locations =
        req.include_peleng_locations.unwrap_or(false);
    let freqs_res = sigint_inbox_item::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintPost.def(),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        // .filter(signal_message::Column::DuplicateOf.is_null())
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till));
    let freqs_res = apply_analytics_message_id_scope(freqs_res, scope);
    let freqs_res = apply_message_access_filter(
        freqs_res,
        &req.selected_groups,
        &req.selected_senders,
        &master_keys,
        scope,
    )
    .context(h!())?;
    let freqs_res = filter_selected_units_for_period(
        freqs_res,
        &req.selected_units,
        &req.units_exact_match_only,
        dt_since,
        dt_till,
    )
    .context(h!())?;
    let freqs_res = filter_selected_posts(freqs_res, &req.selected_posts)?;
    let freqs_res = filter_selected_locations(
        freqs_res,
        &req.selected_locations,
        include_peleng_locations,
    )
    .context(h!())?;
    let freqs_res =
        filter_selected_callsigns(freqs_res, &req.selected_callsigns)
            .context(h!())?;
    let freqs_res = filter_selected_tags_with_scope(
        freqs_res,
        &req.selected_tags,
        &req.denied_tags,
        &req.tag_presence,
        &req.or_bookmarked,
        &req.or_important,
        &req.or_with_coords,
        &req.or_without_coords,
        &req.or_with_extended_form,
        &req.filter_tags_option,
        &req.without_model_tags,
        login_str,
        req.report_tags_only_this_unit.unwrap_or(false),
        scope,
    )
    .context(h!())?;
    let freqs_res = filter_selected_networks_for_scope(
        freqs_res,
        &req.selected_networks,
        &req.without_network,
        scope,
    )
    .context(h!())?;
    let freqs_res = apply_metadata_filters(freqs_res, &req)?;
    let freqs_res = filter_search(freqs_res, &req.search).context(h!())?;
    let freqs_res =
        filter_selected_device_names(freqs_res, &req.selected_device_names)?;
    let freqs_res =
        filter_selected_aors_for_scope(freqs_res, &req.selected_aors, scope)?;
    Ok(freqs_res)
}

#[derive(FromQueryResult)]
struct CallsignsRes {
    callsign: Option<String>,
    count: i64,
}

pub async fn fetch_callsigns(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsCallsign>, AppError> {
    let login_value = login_id_from_identity(user)?;
    fetch_callsigns_for_login(&req.0, &login_value, env, master_keys).await
}

pub async fn fetch_callsigns_for_login(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsCallsign>, AppError> {
    let req = Json(req.clone());
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;

    if let Some((dt_since, dt_till)) =
        stats_aggregated_range(&req, env, dt_since, dt_till).c(h!())?
    {
        let result =
            read_callsign_stats_aggregated(env, master_keys, dt_since, dt_till)
                .await
                .c(h!())?;
        return Ok(result);
    }

    fetch_callsigns_for_login_with_db(&req.0, login_str, &env.dbx, master_keys)
        .await
}

async fn fetch_callsigns_for_login_with_db(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsCallsign>, AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let instant = std::time::Instant::now();
    let callsigns = load_callsigns_with_counts(
        db,
        build_callsign_inbox_item_ids_query(
            req,
            login_str,
            dt_since,
            dt_till,
            master_keys,
        )?,
    )
    .await
    .c(h!())?;

    debug!("callsigns op took: {:?}", instant.elapsed());
    Ok(callsigns)
}

pub(super) async fn fetch_callsigns_raw_with_db(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
    scope: &AnalyticsMessageIdScope,
) -> Result<Vec<AnalysisStatsCallsign>, AppError> {
    if scope.is_empty() {
        return Ok(Vec::new());
    }
    let login_value = login_id_from_identity(user)?;
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let callsigns_res = build_callsigns_filtered_query(
        &req.0,
        &login_value,
        dt_since,
        dt_till,
        master_keys,
        Some(scope),
    )?;
    let (mut callsigns_res, callsign_alias) =
        join_analytics_callsign_relation(callsigns_res, Some(scope));
    QuerySelect::query(&mut callsigns_res)
        .clear_selects()
        .expr_as(
            Expr::col((callsign_alias.clone(), Alias::new("callsign"))),
            Alias::new("callsign"),
        )
        .expr_as(
            Expr::cust_with_expr(
                "COUNT(DISTINCT $1)",
                Expr::col((signal_message::Entity, signal_message::Column::Id)),
            ),
            Alias::new("count"),
        )
        .group_by_col((callsign_alias, Alias::new("callsign")));

    Ok(callsigns_res
        .into_model::<CallsignsRes>()
        .all(db)
        .await
        .context(h!())?
        .into_iter()
        .filter_map(|row| {
            row.callsign.map(|callsign| AnalysisStatsCallsign {
                callsign,
                count: row.count,
            })
        })
        .collect())
}

pub async fn count_callsigns(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<i64, AppError> {
    let read_db = env.replica();
    count_callsigns_with_db(req, user, &read_db, master_keys).await
}

pub(super) async fn count_callsigns_with_db(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
) -> Result<i64, AppError> {
    let login_value = login_id_from_identity(user)?;
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;

    let instant = std::time::Instant::now();
    trace!("get identity master keys op took: {:?}", instant.elapsed());
    let callsigns = load_callsigns_with_counts(
        db,
        build_callsign_inbox_item_ids_query(
            &req.0,
            &login_value,
            dt_since,
            dt_till,
            master_keys,
        )?,
    )
    .await?;
    Ok(callsigns.len() as i64)
}

pub(super) async fn count_callsigns_analytics_with_db(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<i64, AppError> {
    if scope.is_some_and(|scope| scope.is_empty()) {
        return Ok(0);
    }
    let login_value = login_id_from_identity(user)?;
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let callsigns_res = build_callsigns_filtered_query(
        &req.0,
        &login_value,
        dt_since,
        dt_till,
        master_keys,
        scope,
    )?;
    let (mut callsigns_res, callsign_alias) =
        join_analytics_callsign_relation(callsigns_res, scope);
    QuerySelect::query(&mut callsigns_res)
        .clear_selects()
        .expr_as(
            Expr::cust_with_expr(
                "COUNT(DISTINCT $1)",
                Expr::col((callsign_alias.clone(), Alias::new("callsign"))),
            ),
            Alias::new("count"),
        );
    let result = callsigns_res
        .into_model::<DistinctCountRes>()
        .one(db)
        .await
        .context(h!())?
        .unwrap_or(DistinctCountRes { count: 0 });
    Ok(result.count)
}

fn join_analytics_callsign_relation<E>(
    mut query: Select<E>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> (Select<E>, Alias)
where
    E: EntityTrait,
{
    let callsign_alias = Alias::new("analytics_callsign");
    QuerySelect::query(&mut query).join_as(
        JoinType::InnerJoin,
        (
            Alias::new("echo_clickhouse_derived"),
            Alias::new("message_callsign"),
        ),
        callsign_alias.clone(),
        Expr::col((callsign_alias.clone(), Alias::new("sigint_inbox_item_id")))
            .equals((sigint_inbox_item::Entity, sigint_inbox_item::Column::Id)),
    );
    if let Some(scope) = scope {
        QuerySelect::query(&mut query).cond_where(scope.condition((
            callsign_alias.clone(),
            Alias::new("sigint_inbox_item_id"),
        )));
    }
    (query, callsign_alias)
}

pub async fn fetch_metadata_stats(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<MetadataStatsRsp, AppError> {
    let login_value = login_id_from_identity(user)?;
    fetch_metadata_stats_for_login(&req.0, &login_value, env, master_keys).await
}

pub async fn fetch_metadata_stats_for_login(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<MetadataStatsRsp, AppError> {
    let req = Json(req.clone());
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let messages_q = build_metadata_messages_query(
        &req,
        login_str,
        dt_since,
        dt_till,
        master_keys,
    )
    .context(h!())?;

    let ccs = fetch_metadata_single_value_stats(
        &env.dbx,
        messages_q.clone(),
        sigint_inbox_item_metadata::Column::ColorCode,
    )
    .await
    .context(h!())?;
    let hashes = fetch_metadata_single_value_stats(
        &env.dbx,
        messages_q.clone(),
        sigint_inbox_item_metadata::Column::HashId,
    )
    .await
    .context(h!())?;
    let senders = fetch_metadata_multi_value_stats(
        &env.dbx,
        messages_q.clone(),
        &[
            sigint_inbox_item_metadata::Column::SenderId,
            sigint_inbox_item_metadata::Column::SenderName,
        ],
    )
    .await
    .context(h!())?;
    let receivers = fetch_metadata_multi_value_stats(
        &env.dbx,
        messages_q.clone(),
        &[
            sigint_inbox_item_metadata::Column::CallGroupId,
            sigint_inbox_item_metadata::Column::CallGroupName,
        ],
    )
    .await
    .context(h!())?;

    Ok(MetadataStatsRsp {
        ccs,
        senders,
        receivers,
        hashes,
    })
}

fn build_metadata_messages_query(
    req: &Json<AnalysisStatsReq>,
    login_str: &uuid::Uuid,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
    let messages_q = build_join_for_sigint_inbox_item()
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till));
    apply_sender_filters_for_login(
        messages_q,
        req,
        dt_since,
        dt_till,
        login_str,
        master_keys,
        None,
        false,
    )
}

#[derive(FromQueryResult)]
struct MetadataValueRes {
    value: Option<String>,
    count: i64,
}

async fn fetch_metadata_single_value_stats(
    db: &DatabaseConnection,
    messages_q: Select<sigint_inbox_item::Entity>,
    column: sigint_inbox_item_metadata::Column,
) -> Result<Vec<AnalysisStatsMetadataValue>, AppError> {
    let messages_subquery = messages_q
        .select_only()
        .column(sigint_inbox_item::Column::Id)
        .to_owned()
        .into_query();
    let metadata_res: Vec<MetadataValueRes> =
        sigint_inbox_item_metadata::Entity::find()
            .select_only()
            .column_as(
                Expr::col((sigint_inbox_item_metadata::Entity, column))
                    .if_null(""),
                "value",
            )
            .column_as(
                Expr::cust(
                    r#"COUNT(DISTINCT "sigint_inbox_item_metadata"."sigint_inbox_item_id")"#,
                ),
                "count",
            )
            .filter(
                sigint_inbox_item_metadata::Column::SigintInboxItemId
                    .in_subquery(messages_subquery),
            )
            .filter(
                Expr::col((sigint_inbox_item_metadata::Entity, column))
                    .is_not_null(),
            )
            .filter(
                Expr::col((sigint_inbox_item_metadata::Entity, column))
                    .ne(""),
            )
            .group_by(Expr::cust("1"))
            .order_by_desc(Expr::cust("2"))
            .order_by_asc(Expr::cust("1"))
            .into_model::<MetadataValueRes>()
            .all(db)
            .await
            .context(h!())?;

    Ok(metadata_res
        .into_iter()
        .filter_map(|row| {
            row.value.and_then(|value| {
                let value = value.trim().to_string();
                if value.is_empty() {
                    None
                } else {
                    Some(AnalysisStatsMetadataValue {
                        value,
                        count: row.count,
                    })
                }
            })
        })
        .collect())
}

async fn fetch_metadata_multi_value_stats(
    db: &DatabaseConnection,
    messages_q: Select<sigint_inbox_item::Entity>,
    columns: &[sigint_inbox_item_metadata::Column],
) -> Result<Vec<AnalysisStatsMetadataValue>, AppError> {
    let Some(values_q) = build_metadata_values_union_query(messages_q, columns)
    else {
        return Ok(vec![]);
    };

    let values_alias = Alias::new("metadata_values");
    let value_alias = Alias::new("value");
    let inbox_item_id_alias = Alias::new("sigint_inbox_item_id");
    let count_expr = Expr::cust_with_exprs(
        "COUNT(DISTINCT $1)",
        [
            Expr::col((values_alias.clone(), inbox_item_id_alias.clone()))
                .into_simple_expr(),
        ],
    );
    let mut metadata_q = Query::select();
    metadata_q
        .expr_as(
            Expr::col((values_alias.clone(), value_alias.clone())),
            value_alias.clone(),
        )
        .expr_as(count_expr, Alias::new("count"))
        .from_subquery(values_q, values_alias.clone())
        .and_where(
            Expr::col((values_alias.clone(), value_alias.clone()))
                .is_not_null(),
        )
        .group_by_col((values_alias.clone(), value_alias.clone()))
        .order_by(Alias::new("count"), Order::Desc)
        .order_by(Alias::new("value"), Order::Asc);

    let (sql, values) = metadata_q.build(PostgresQueryBuilder);
    let metadata_res: Vec<MetadataValueRes> =
        MetadataValueRes::find_by_statement(Statement::from_sql_and_values(
            DbBackend::Postgres,
            sql,
            values,
        ))
        .all(db)
        .await
        .context(h!())?;

    Ok(metadata_res
        .into_iter()
        .filter_map(|row| {
            row.value.map(|value| AnalysisStatsMetadataValue {
                value,
                count: row.count,
            })
        })
        .collect())
}

fn build_metadata_values_union_query(
    messages_q: Select<sigint_inbox_item::Entity>,
    columns: &[sigint_inbox_item_metadata::Column],
) -> Option<SelectStatement> {
    let (first_column, rest_columns) = columns.split_first()?;
    let mut values_q =
        build_metadata_value_column_query(messages_q.clone(), *first_column);
    for column in rest_columns {
        values_q.union(
            UnionType::All,
            build_metadata_value_column_query(messages_q.clone(), *column),
        );
    }
    Some(values_q)
}

fn build_metadata_value_column_query(
    messages_q: Select<sigint_inbox_item::Entity>,
    column: sigint_inbox_item_metadata::Column,
) -> SelectStatement {
    let messages_subquery = messages_q
        .select_only()
        .column(sigint_inbox_item::Column::Id)
        .to_owned()
        .into_query();
    let mut value_q = Query::select();
    value_q
        .expr_as(metadata_value_expr(column), Alias::new("value"))
        .column(sigint_inbox_item_metadata::Column::SigintInboxItemId)
        .from(sigint_inbox_item_metadata::Entity)
        .and_where(
            sigint_inbox_item_metadata::Column::SigintInboxItemId
                .in_subquery(messages_subquery),
        )
        .and_where(
            Expr::col((sigint_inbox_item_metadata::Entity, column))
                .is_not_null(),
        );
    value_q
}

fn metadata_value_expr(
    column: sigint_inbox_item_metadata::Column,
) -> SimpleExpr {
    Expr::cust_with_exprs(
        "NULLIF(TRIM($1), '')",
        [Expr::col((sigint_inbox_item_metadata::Entity, column))
            .into_simple_expr()],
    )
}

fn build_callsign_inbox_item_ids_query(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
    Ok(build_callsigns_filtered_query(
        req,
        login_str,
        dt_since,
        dt_till,
        master_keys,
        None,
    )?
    .select_only()
    .column(sigint_inbox_item::Column::Id)
    .distinct())
}

async fn load_callsigns_with_counts(
    db: &DatabaseConnection,
    query: Select<sigint_inbox_item::Entity>,
) -> Result<Vec<AnalysisStatsCallsign>, AppError> {
    let filtered_items = query.build(DbBackend::Postgres);
    let values = filtered_items
        .values
        .map(|values| values.0)
        .unwrap_or_default();
    let callsign_ctes =
        crate::inbox::callsigns::postgres_effective_callsign_ctes(
            &filtered_items.sql,
        );
    let sql = format!(
        r#"
        {callsign_ctes}
        SELECT callsign, COUNT(*)::bigint AS count
        FROM all_callsigns
        GROUP BY callsign
        ORDER BY callsign
        "#,
    );
    let statement =
        Statement::from_sql_and_values(DbBackend::Postgres, sql, values);
    let rows = db.query_all_raw(statement).await.context(h!())?;
    let callsigns = rows
        .iter()
        .map(|row| {
            Ok(AnalysisStatsCallsign {
                callsign: row.try_get_by("callsign")?,
                count: row.try_get_by("count")?,
            })
        })
        .collect::<Result<Vec<_>, DbErr>>()
        .context(h!())?;
    Ok(callsigns)
}

fn build_callsigns_filtered_query(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
    let req = request_without_facet_filter(req, AnalysisFacet::Callsigns);
    let include_peleng_locations =
        req.include_peleng_locations.unwrap_or(false);
    let callsigns_res = sigint_inbox_item::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintPost.def(),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        // .filter(signal_message::Column::DuplicateOf.is_null())
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till));
    let callsigns_res = apply_analytics_message_id_scope(callsigns_res, scope);
    let callsigns_res = apply_message_access_filter(
        callsigns_res,
        &req.selected_groups,
        &req.selected_senders,
        &master_keys,
        scope,
    )?;
    let callsigns_res =
        filter_selected_freqs(callsigns_res, &req.selected_freqs)?;
    let callsigns_res =
        filter_selected_posts(callsigns_res, &req.selected_posts)?;
    let callsigns_res = filter_selected_units_for_period(
        callsigns_res,
        &req.selected_units,
        &req.units_exact_match_only,
        dt_since,
        dt_till,
    )?;
    let callsigns_res = filter_selected_locations(
        callsigns_res,
        &req.selected_locations,
        include_peleng_locations,
    )?;
    let callsigns_res = filter_selected_tags_with_scope(
        callsigns_res,
        &req.selected_tags,
        &req.denied_tags,
        &req.tag_presence,
        &req.or_bookmarked,
        &req.or_important,
        &req.or_with_coords,
        &req.or_without_coords,
        &req.or_with_extended_form,
        &req.filter_tags_option,
        &req.without_model_tags,
        login_str,
        req.report_tags_only_this_unit.unwrap_or(false),
        scope,
    )
    .context(h!())?;
    let callsigns_res = filter_selected_networks_for_scope(
        callsigns_res,
        &req.selected_networks,
        &req.without_network,
        scope,
    )
    .context(h!())?;
    let callsigns_res = apply_metadata_filters(callsigns_res, &req)?;
    let callsigns_res = filter_search(callsigns_res, &req.search)?;
    let callsigns_res = filter_selected_device_names(
        callsigns_res,
        &req.selected_device_names,
    )?;
    let callsigns_res = filter_selected_aors_for_scope(
        callsigns_res,
        &req.selected_aors,
        scope,
    )?;
    Ok(callsigns_res)
}

#[derive(FromQueryResult)]
struct TagsRes {
    tag_id: i64,
    count: i64,
}

pub async fn fetch_tags(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsTag>, AppError> {
    let login_value = login_id_from_identity(user)?;
    fetch_tags_for_login(&req.0, &login_value, env, master_keys).await
}

pub async fn fetch_tags_for_login(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsTag>, AppError> {
    let req = Json(req.clone());
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;

    if let Some((dt_since, dt_till)) =
        stats_aggregated_range(&req, env, dt_since, dt_till)
            .c(h!())?
            .filter(|_| req.without_model_tags != Some(true))
    {
        let result = read_tag_stats_aggregated(
            env,
            login_str,
            master_keys,
            dt_since,
            dt_till,
        )
        .await
        .c(h!())?;
        return Ok(result);
    }

    fetch_tags_for_login_with_db(
        &req.0,
        login_str,
        &env.dbx,
        master_keys,
        None,
        None,
    )
    .await
}

async fn fetch_tags_for_login_with_db(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
    tag_access: Option<&AnalyticsTagAccess>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Vec<AnalysisStatsTag>, AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let instant = std::time::Instant::now();
    let tags_res: Vec<TagsRes> = if let Some(tag_access) = tag_access {
        build_tags_analytics_filtered_query_with_scope(
            req,
            login_str,
            &tag_access.accessible_tag_ids,
            &tag_access.unit_login_ids,
            dt_since,
            dt_till,
            master_keys,
            scope,
        )?
        .select_only()
        .column(sigint_inbox_item_tag::Column::TagId)
        .column_as(Expr::count(Expr::val(1)), "count")
        .group_by(sigint_inbox_item_tag::Column::TagId)
        .into_model::<TagsRes>()
        .all(db)
        .await
        .c(h!())?
    } else {
        let query =
            build_tags_query(req, login_str, dt_since, dt_till, master_keys)?;
        TagsRes::find_by_statement(DbBackend::Postgres.build(&query))
            .all(db)
            .await
            .c(h!())?
    };

    let tags: Vec<_> = tags_res
        .iter()
        .map(|item| AnalysisStatsTag {
            tag_id: item.tag_id,
            count: item.count,
        })
        .collect();

    if instant.elapsed().as_secs() > 4 {
        debug!("tags op took: {:?}; req: {:?}", instant.elapsed(), req);
    } else if instant.elapsed().as_secs() > 1 {
        debug!("tags op took: {:?}", instant.elapsed());
    }

    Ok(tags)
}

pub(super) async fn fetch_tags_raw_with_db(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
    tag_access: &AnalyticsTagAccess,
    scope: &AnalyticsMessageIdScope,
) -> Result<Vec<AnalysisStatsTag>, AppError> {
    if scope.is_empty() {
        return Ok(Vec::new());
    }
    let login_value = login_id_from_identity(user)?;
    fetch_tags_for_login_with_db(
        &req.0,
        &login_value,
        db,
        master_keys,
        Some(tag_access),
        Some(scope),
    )
    .await
}

pub async fn count_tags(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<i64, AppError> {
    let read_db = env.replica();
    count_tags_with_db(req, user, &read_db, master_keys).await
}

pub(super) async fn count_tags_with_db(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
) -> Result<i64, AppError> {
    let login_value = login_id_from_identity(user)?;
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;

    let instant = std::time::Instant::now();
    trace!("get identity master keys op took: {:?}", instant.elapsed());
    let tags_res = build_tags_count_query(
        &req.0,
        &login_value,
        dt_since,
        dt_till,
        master_keys,
    )?;
    let result = DistinctCountRes::find_by_statement(
        DbBackend::Postgres.build(&tags_res),
    )
    .one(db)
    .await
    .context(h!())?
    .unwrap_or(DistinctCountRes { count: 0 });
    Ok(result.count)
}

pub(super) async fn count_tags_analytics_with_db(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
    tag_access: &AnalyticsTagAccess,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<i64, AppError> {
    if scope.is_some_and(|scope| scope.is_empty()) {
        return Ok(0);
    }
    let login_value = login_id_from_identity(user)?;
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let tags_res = build_tags_analytics_count_query_with_scope(
        &req.0,
        &login_value,
        &tag_access.accessible_tag_ids,
        &tag_access.unit_login_ids,
        dt_since,
        dt_till,
        master_keys,
        scope,
    )?;
    let result = tags_res
        .into_model::<DistinctCountRes>()
        .one(db)
        .await
        .context(h!())?
        .unwrap_or(DistinctCountRes { count: 0 });
    Ok(result.count)
}

pub(super) fn build_tags_query(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
) -> Result<WithQuery, AppError> {
    let (ctes, tags_res) =
        build_tags_query_parts(req, login_str, dt_since, dt_till, master_keys)?;
    let tags_res = tags_res
        .select_only()
        .column(sigint_inbox_item_tag::Column::TagId)
        .column_as(Expr::count(Expr::val(1)), "count")
        .group_by(sigint_inbox_item_tag::Column::TagId);
    Ok(build_tags_with_query(ctes, tags_res))
}

fn build_tags_count_query(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
) -> Result<WithQuery, AppError> {
    let (ctes, tags_res) =
        build_tags_query_parts(req, login_str, dt_since, dt_till, master_keys)?;
    let tags_res = build_distinct_count_query(
        tags_res,
        Expr::col(sigint_inbox_item_tag::Column::TagId),
    );
    Ok(build_tags_with_query(ctes, tags_res))
}

fn build_tags_with_query(
    ctes: Vec<CommonTableExpression>,
    tags_res: Select<sigint_inbox_item_tag::Entity>,
) -> WithQuery {
    let mut with_clause = Query::with();
    for cte in ctes {
        with_clause.cte(cte);
    }
    with_clause.query(tags_res.into_query()).to_owned()
}

fn build_tags_query_parts(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
) -> Result<
    (
        Vec<CommonTableExpression>,
        Select<sigint_inbox_item_tag::Entity>,
    ),
    AppError,
> {
    let req = request_without_facet_filter(req, AnalysisFacet::Tags);
    let mut ctes = Vec::new();
    let matching_network_ids_alias = Alias::new("matching_unit_network_ids");
    let matching_inbox_item_ids_alias =
        Alias::new("matching_unit_inbox_item_ids");
    let matching_network_ids = selected_unit_network_ids_query(
        &req.selected_units,
        &req.units_exact_match_only,
    );
    let precomputed_inbox_item_ids_alias = matching_network_ids
        .as_ref()
        .map(|_| matching_inbox_item_ids_alias.clone());
    if let Some(matching_network_ids) = matching_network_ids {
        ctes.push(
            CommonTableExpression::new()
                .query(matching_network_ids)
                .table_name(matching_network_ids_alias.clone())
                .materialized(true)
                .to_owned(),
        );
        let matching_inbox_item_ids = selected_unit_inbox_item_ids_query(
            &req.selected_units,
            &req.units_exact_match_only,
            matching_network_ids_alias,
            dt_since,
            dt_till,
        )?;
        ctes.push(
            CommonTableExpression::new()
                .query(matching_inbox_item_ids)
                .table_name(matching_inbox_item_ids_alias)
                .materialized(true)
                .to_owned(),
        );
    }
    let filtered_inbox_items_alias = Alias::new("filtered_inbox_items");
    let filtered_inbox_items = build_tags_filtered_query_with_owner_condition(
        &req,
        login_str,
        accessible_tag_owner_condition(login_str),
        None,
        dt_since,
        dt_till,
        master_keys,
        None,
        false,
        precomputed_inbox_item_ids_alias,
    )?
    .select_only()
    .column(sigint_inbox_item::Column::Id)
    .into_query();
    let filtered_inbox_items = CommonTableExpression::new()
        .query(filtered_inbox_items)
        .table_name(filtered_inbox_items_alias.clone())
        .materialized(true)
        .to_owned();
    ctes.push(filtered_inbox_items);
    let filtered_inbox_item_ids = Query::select()
        .column((filtered_inbox_items_alias.clone(), Alias::new("id")))
        .from(filtered_inbox_items_alias)
        .to_owned();
    let mut tags_res = sigint_inbox_item_tag::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item_tag::Relation::Tag.def(),
        )
        .filter(
            sigint_inbox_item_tag::Column::Confidence
                .gte(TAG_MINIMUM_CONFIDENCE),
        )
        .filter(accessible_tag_owner_condition(login_str))
        .filter(
            sigint_inbox_item_tag::Column::SigintInboxItemId
                .in_subquery(filtered_inbox_item_ids),
        );
    if req.without_model_tags == Some(true) {
        tags_res =
            tags_res.filter(sigint_inbox_item_tag::Column::Model.is_null());
    }
    Ok((ctes, tags_res))
}

#[cfg(test)]
pub(super) fn build_tags_analytics_filtered_query(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    accessible_tag_ids: &[i64],
    unit_login_ids: &[uuid::Uuid],
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
    build_tags_analytics_filtered_query_with_scope(
        req,
        login_str,
        accessible_tag_ids,
        unit_login_ids,
        dt_since,
        dt_till,
        master_keys,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
fn build_tags_analytics_filtered_query_with_scope(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    accessible_tag_ids: &[i64],
    unit_login_ids: &[uuid::Uuid],
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
    build_tags_filtered_query_with_owner_condition(
        req,
        login_str,
        accessible_tag_ids_condition(accessible_tag_ids),
        Some((accessible_tag_ids, unit_login_ids)),
        dt_since,
        dt_till,
        master_keys,
        scope,
        true,
        None,
    )
}

#[cfg(test)]
pub(super) fn build_tags_analytics_count_query(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    accessible_tag_ids: &[i64],
    unit_login_ids: &[uuid::Uuid],
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
    build_tags_analytics_count_query_with_scope(
        req,
        login_str,
        accessible_tag_ids,
        unit_login_ids,
        dt_since,
        dt_till,
        master_keys,
        None,
    )
}

fn build_tags_analytics_count_query_with_scope(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    accessible_tag_ids: &[i64],
    unit_login_ids: &[uuid::Uuid],
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
    Ok(build_distinct_count_query(
        build_tags_filtered_query_with_owner_condition(
            req,
            login_str,
            accessible_tag_ids_condition(accessible_tag_ids),
            Some((accessible_tag_ids, unit_login_ids)),
            dt_since,
            dt_till,
            master_keys,
            scope,
            true,
            None,
        )?,
        Expr::col(sigint_inbox_item_tag::Column::TagId),
    ))
}

fn build_tags_filtered_query_with_owner_condition(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    owner_condition: Condition,
    analytics_tag_access: Option<(&[i64], &[uuid::Uuid])>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
    scope: Option<&AnalyticsMessageIdScope>,
    join_result_tags: bool,
    matching_inbox_item_ids_alias: Option<Alias>,
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
    let req = request_without_facet_filter(req, AnalysisFacet::Tags);
    let include_peleng_locations =
        req.include_peleng_locations.unwrap_or(false);
    let mut tags_res = sigint_inbox_item::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintPost.def(),
        );
    if join_result_tags {
        tags_res = tags_res
            .join(
                JoinType::InnerJoin,
                sigint_inbox_item_tag::Relation::SigintInboxItem
                    .def()
                    .rev()
                    .on_condition(|_left, right| {
                        Expr::col((
                            right,
                            sigint_inbox_item_tag::Column::Confidence,
                        ))
                        .gte(TAG_MINIMUM_CONFIDENCE)
                        .into_condition()
                    }),
            )
            .join(
                JoinType::InnerJoin,
                sigint_inbox_item_tag::Relation::Tag.def(),
            )
            .filter(owner_condition);
    }
    tags_res = tags_res
        .filter(signal_message::Column::Deleted.eq(false))
        // .filter(signal_message::Column::DuplicateOf.is_null())
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till));
    tags_res = apply_analytics_message_id_scope(tags_res, scope);
    if join_result_tags {
        if let Some(scope) = scope {
            tags_res = tags_res.filter(scope.condition((
                sigint_inbox_item_tag::Entity,
                sigint_inbox_item_tag::Column::SigintInboxItemId,
            )));
        }
    }
    // .filter(sigint_inbox_item::Column::Checked.eq(Some(true)))
    if join_result_tags && req.without_model_tags == Some(true) {
        tags_res =
            tags_res.filter(sigint_inbox_item_tag::Column::Model.is_null());
    }
    let tags_res = apply_message_access_filter(
        tags_res,
        &req.selected_groups,
        &req.selected_senders,
        &master_keys,
        scope,
    )?;
    let tags_res = filter_selected_freqs(tags_res, &req.selected_freqs)?;
    let tags_res = filter_selected_posts(tags_res, &req.selected_posts)?;
    let tags_res = if let Some(matching_inbox_item_ids_alias) =
        matching_inbox_item_ids_alias
    {
        let matching_inbox_item_ids = Query::select()
            .column((
                matching_inbox_item_ids_alias.clone(),
                sigint_inbox_item::Column::Id,
            ))
            .from(matching_inbox_item_ids_alias)
            .to_owned();
        tags_res.filter(
            sigint_inbox_item::Column::Id.in_subquery(matching_inbox_item_ids),
        )
    } else {
        filter_selected_units(
            tags_res,
            &req.selected_units,
            &req.units_exact_match_only,
        )?
    };
    let tags_res = filter_selected_locations(
        tags_res,
        &req.selected_locations,
        include_peleng_locations,
    )?;
    let tags_res =
        filter_selected_callsigns(tags_res, &req.selected_callsigns)?;
    let report_tags_only_this_unit =
        req.report_tags_only_this_unit.unwrap_or(false);
    let tags_res = if let Some((accessible_tag_ids, unit_login_ids)) =
        analytics_tag_access
    {
        filter_selected_tags_analytics(
            tags_res,
            &req.selected_tags,
            &req.denied_tags,
            &req.tag_presence,
            &req.or_bookmarked,
            &req.or_important,
            &req.or_with_coords,
            &req.or_without_coords,
            &req.or_with_extended_form,
            &req.filter_tags_option,
            &req.without_model_tags,
            login_str,
            report_tags_only_this_unit,
            accessible_tag_ids,
            unit_login_ids,
            scope,
        )?
    } else {
        filter_selected_tags_with_scope(
            tags_res,
            &req.selected_tags,
            &req.denied_tags,
            &req.tag_presence,
            &req.or_bookmarked,
            &req.or_important,
            &req.or_with_coords,
            &req.or_without_coords,
            &req.or_with_extended_form,
            &req.filter_tags_option,
            &req.without_model_tags,
            login_str,
            report_tags_only_this_unit,
            scope,
        )?
    };
    let tags_res = if analytics_tag_access.is_some() {
        filter_selected_networks_analytics(
            tags_res,
            &req.selected_networks,
            &req.without_network,
            scope,
        )
    } else {
        filter_selected_networks(
            tags_res,
            &req.selected_networks,
            &req.without_network,
        )
    }
    .context(h!())?;
    let tags_res = apply_metadata_filters(tags_res, &req)?;
    let tags_res = filter_search(tags_res, &req.search)?;
    let tags_res =
        filter_selected_device_names(tags_res, &req.selected_device_names)?;
    let tags_res =
        filter_selected_aors_for_scope(tags_res, &req.selected_aors, scope)?;
    Ok(tags_res)
}

#[derive(FromQueryResult)]
struct UnitsRes {
    unit: Option<String>,
    count: i64,
}

pub async fn fetch_units(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsUnit>, AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;

    if let Some((dt_since, dt_till)) =
        stats_aggregated_range(req, env, dt_since, dt_till).c(h!())?
    {
        let result =
            read_unit_stats_aggregated(env, master_keys, dt_since, dt_till)
                .await
                .c(h!())?;
        return Ok(result);
    }

    fetch_units_with_db(req, user, &env.dbx, master_keys, None).await
}

pub(super) async fn fetch_units_raw_with_db(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
    scope: &AnalyticsMessageIdScope,
) -> Result<Vec<AnalysisStatsUnit>, AppError> {
    if scope.is_empty() {
        return Ok(Vec::new());
    }
    fetch_units_with_db(req, user, db, master_keys, Some(scope)).await
}

async fn fetch_units_with_db(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Vec<AnalysisStatsUnit>, AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let login_value = login_id_from_identity(user)?;
    let instant = std::time::Instant::now();
    let units_res = build_units_query(
        &req,
        &login_value,
        dt_since,
        dt_till,
        master_keys,
        scope,
    )?;
    // println!(
    //     "> units_res: {}",
    //     units_res.build(DbBackend::Postgres).to_string()
    // );
    let units_res: Vec<UnitsRes> = units_res
        .into_model::<UnitsRes>()
        .all(db)
        .await
        .context(h!())?;
    let mut units = vec![];
    for x in units_res {
        let unit = m_unit_to_unidenfitied(x.unit);
        units.push(AnalysisStatsUnit {
            count: x.count,
            unit,
        });
    }

    // let units = vec![];

    debug!("units op took: {:?}", instant.elapsed());
    Ok(units)
}

pub async fn count_units(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<i64, AppError> {
    let read_db = env.replica();
    count_units_with_db(req, user, &read_db, master_keys, None).await
}

pub(super) async fn count_units_with_db(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<i64, AppError> {
    if scope.is_some_and(|scope| scope.is_empty()) {
        return Ok(0);
    }
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let login_value = login_id_from_identity(user)?;

    let instant = std::time::Instant::now();
    trace!("get identity master keys op took: {:?}", instant.elapsed());
    let units_res = build_units_filtered_query(
        &req,
        &login_value,
        dt_since,
        dt_till,
        master_keys,
        scope,
    )?;
    count_distinct_with_db(
        units_res,
        Expr::col(sigint_inbox_item::Column::UnitV2).if_null(""),
        db,
    )
    .await
}

pub async fn count_unit_exact_match_breakdown(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<(i64, i64), AppError> {
    let mut exact_req = req.0.clone();
    exact_req.units_exact_match_only = Some(true);
    let (_, exact_matches_count) =
        fetch_counts(&Json(exact_req), user, env, master_keys.clone())
            .await
            .context(h!())?;

    let mut combined_req = req.0.clone();
    combined_req.units_exact_match_only = Some(false);
    let (_, total_matches_count) =
        fetch_counts(&Json(combined_req), user, env, master_keys)
            .await
            .context(h!())?;

    let non_exact_matches_count =
        std::cmp::max(total_matches_count - exact_matches_count, 0);

    Ok((exact_matches_count, non_exact_matches_count))
}

pub(super) async fn count_unit_exact_match_breakdown_raw_with_db(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &Env,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<(i64, i64), AppError> {
    let login_value = login_id_from_identity(user)?;
    let mut exact_req = req.0.clone();
    exact_req.units_exact_match_only = Some(true);
    let (_, exact_matches_count) = fetch_counts_for_login_with_conn(
        &Json(exact_req),
        &login_value,
        master_keys.clone(),
        env,
        db,
        false,
        scope,
    )
    .await?;

    let mut combined_req = req.0.clone();
    combined_req.units_exact_match_only = Some(false);
    let (_, total_matches_count) = fetch_counts_for_login_with_conn(
        &Json(combined_req),
        &login_value,
        master_keys,
        env,
        db,
        false,
        scope,
    )
    .await?;

    Ok((
        exact_matches_count,
        std::cmp::max(total_matches_count - exact_matches_count, 0),
    ))
}

fn build_units_query(
    req: &&Json<AnalysisStatsReq>,
    login_str: &uuid::Uuid,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
    Ok(build_units_filtered_query(
        req,
        login_str,
        dt_since,
        dt_till,
        master_keys,
        scope,
    )?
    .select_only()
    .column_as(
        Expr::col(sigint_inbox_item::Column::UnitV2).if_null(""),
        "unit",
    )
    .column_as(
        Expr::cust(r#"COUNT(DISTINCT "signal_message"."id")"#),
        "count",
    )
    .group_by(Expr::cust("1")))
}

fn build_units_filtered_query(
    req: &&Json<AnalysisStatsReq>,
    login_str: &uuid::Uuid,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
    let req = Json(request_without_facet_filter(&req.0, AnalysisFacet::Units));
    let include_peleng_locations =
        req.include_peleng_locations.unwrap_or(false);
    let units_res = sigint_inbox_item::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintPost.def(),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        // .filter(signal_message::Column::DuplicateOf.is_null())
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till));
    let units_res = apply_analytics_message_id_scope(units_res, scope);
    let units_res = apply_message_access_filter(
        units_res,
        &req.selected_groups,
        &req.selected_senders,
        &master_keys,
        scope,
    )
    .context(h!())?;
    let units_res =
        filter_selected_freqs(units_res, &req.selected_freqs).context(h!())?;
    let units_res =
        filter_selected_posts(units_res, &req.selected_posts).context(h!())?;
    let units_res = filter_selected_locations(
        units_res,
        &req.selected_locations,
        include_peleng_locations,
    )
    .context(h!())?;
    let units_res =
        filter_selected_callsigns(units_res, &req.selected_callsigns)
            .context(h!())?;
    let units_res = filter_selected_tags_with_scope(
        units_res,
        &req.selected_tags,
        &req.denied_tags,
        &req.tag_presence,
        &req.or_bookmarked,
        &req.or_important,
        &req.or_with_coords,
        &req.or_without_coords,
        &req.or_with_extended_form,
        &req.filter_tags_option,
        &req.without_model_tags,
        login_str,
        req.report_tags_only_this_unit.unwrap_or(false),
        scope,
    )
    .context(h!())?;
    let units_res = filter_selected_networks_for_scope(
        units_res,
        &req.selected_networks,
        &req.without_network,
        scope,
    )
    .context(h!())?;
    let units_res = apply_metadata_filters(units_res, &req.0)?;
    let units_res = filter_search(units_res, &req.search).context(h!())?;
    let units_res =
        filter_selected_device_names(units_res, &req.selected_device_names)?;
    let units_res =
        filter_selected_aors_for_scope(units_res, &req.selected_aors, scope)?;
    Ok(units_res)
}

#[derive(FromQueryResult)]
struct LocationsRes {
    location: Option<String>,
    count: i64,
}

pub async fn fetch_locations(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsLocation>, AppError> {
    let login_value = login_id_from_identity(user)?;
    fetch_locations_for_login(&req.0, &login_value, env, master_keys).await
}

pub async fn fetch_locations_for_login(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsLocation>, AppError> {
    let req = Json(req.clone());
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;

    if let Some((dt_since, dt_till)) =
        stats_aggregated_range(&req, env, dt_since, dt_till).c(h!())?
    {
        let result =
            read_location_stats_aggregated(env, master_keys, dt_since, dt_till)
                .await
                .c(h!())?;
        return Ok(result);
    }

    fetch_locations_for_login_with_db(
        &req.0,
        login_str,
        &env.dbx,
        master_keys,
        None,
    )
    .await
}

pub(super) async fn fetch_locations_raw_with_db(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
    scope: &AnalyticsMessageIdScope,
) -> Result<Vec<AnalysisStatsLocation>, AppError> {
    if scope.is_empty() {
        return Ok(Vec::new());
    }
    let login_value = login_id_from_identity(user)?;
    fetch_locations_for_login_with_db(
        &req.0,
        &login_value,
        db,
        master_keys,
        Some(scope),
    )
    .await
}

async fn fetch_locations_for_login_with_db(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Vec<AnalysisStatsLocation>, AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let instant = std::time::Instant::now();
    let locations_res = build_locations_query_for_login(
        req,
        login_str,
        dt_since,
        dt_till,
        master_keys,
        scope,
    )?;
    // println!(
    //     "> locations_res: {}",
    //     locations_res.build(DbBackend::Postgres).to_string()
    // );
    let locations_res = locations_res
        .into_model::<LocationsRes>()
        .all(db)
        .await
        .context(h!())?
        .into_iter()
        .map(|l| (l.location, l.count))
        .collect_vec();
    let mut locations = vec![];
    for (location, count) in locations_res {
        let location = m_location_to_unidenfitied(location);
        to_location_list(&location)
            .into_iter()
            .for_each(|location| {
                // variable already named `location`; redundant rebind removed
                locations.push(AnalysisStatsLocation { count, location });
            });
    }
    debug!("locations op took: {:?}", instant.elapsed());
    Ok(locations)
}

pub async fn count_locations(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<i64, AppError> {
    let read_db = env.replica();
    count_locations_with_db(req, user, &read_db, master_keys, None).await
}

pub(super) async fn count_locations_with_db(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<i64, AppError> {
    if scope.is_some_and(|scope| scope.is_empty()) {
        return Ok(0);
    }
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;

    let instant = std::time::Instant::now();
    trace!("get identity master keys op took: {:?}", instant.elapsed());
    let locations_res = build_locations_filtered_query(
        &req,
        &user,
        dt_since,
        dt_till,
        master_keys,
        scope,
    )?;
    count_distinct_with_db(
        locations_res,
        Expr::col(sigint_inbox_item::Column::LocationV2).if_null(""),
        db,
    )
    .await
}

fn build_locations_query_for_login(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
    Ok(build_locations_filtered_query_for_login(
        req,
        login_str,
        dt_since,
        dt_till,
        master_keys,
        scope,
    )?
    .select_only()
    .column_as(
        Expr::col(sigint_inbox_item::Column::LocationV2).if_null(""),
        "location",
    )
    .column_as(
        Expr::cust(r#"COUNT(DISTINCT "signal_message"."id")"#),
        "count",
    )
    .group_by(Expr::cust("1")))
}

fn build_locations_filtered_query(
    req: &&Json<AnalysisStatsReq>,
    user: &&Identity,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
    let login_value = login_id_from_identity(user)?;
    build_locations_filtered_query_for_login(
        &req.0,
        &login_value,
        dt_since,
        dt_till,
        master_keys,
        scope,
    )
}

fn build_locations_filtered_query_for_login(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
    let req = request_without_facet_filter(req, AnalysisFacet::Locations);
    let locations_res = sigint_inbox_item::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintPost.def(),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        // .filter(signal_message::Column::DuplicateOf.is_null())
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till));
    let locations_res = apply_analytics_message_id_scope(locations_res, scope);
    let locations_res = apply_message_access_filter(
        locations_res,
        &req.selected_groups,
        &req.selected_senders,
        &master_keys,
        scope,
    )
    .context(h!())?;
    let locations_res = filter_selected_units_for_period(
        locations_res,
        &req.selected_units,
        &req.units_exact_match_only,
        dt_since,
        dt_till,
    )
    .context(h!())?;
    let locations_res =
        filter_selected_freqs(locations_res, &req.selected_freqs)
            .context(h!())?;
    let locations_res =
        filter_selected_posts(locations_res, &req.selected_posts)
            .context(h!())?;
    let locations_res = filter_selected_locations(
        locations_res,
        &req.selected_locations,
        req.include_peleng_locations.unwrap_or(false),
    )
    .context(h!())?;
    let locations_res =
        filter_selected_callsigns(locations_res, &req.selected_callsigns)
            .context(h!())?;
    let locations_res = filter_selected_tags_with_scope(
        locations_res,
        &req.selected_tags,
        &req.denied_tags,
        &req.tag_presence,
        &req.or_bookmarked,
        &req.or_important,
        &req.or_with_coords,
        &req.or_without_coords,
        &req.or_with_extended_form,
        &req.filter_tags_option,
        &req.without_model_tags,
        login_str,
        req.report_tags_only_this_unit.unwrap_or(false),
        scope,
    )
    .context(h!())?;
    let locations_res = filter_selected_networks_for_scope(
        locations_res,
        &req.selected_networks,
        &req.without_network,
        scope,
    )
    .context(h!())?;
    let locations_res = apply_metadata_filters(locations_res, &req)?;
    let locations_res =
        filter_search(locations_res, &req.search).context(h!())?;
    let locations_res = filter_selected_device_names(
        locations_res,
        &req.selected_device_names,
    )?;
    let locations_res = filter_selected_aors_for_scope(
        locations_res,
        &req.selected_aors,
        scope,
    )?;
    Ok(locations_res)
}

pub async fn fetch_aors(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsAor>, AppError> {
    let login_value = login_id_from_identity(user)?;
    fetch_aors_for_login(&req.0, &login_value, env, master_keys).await
}

pub async fn fetch_aors_for_login(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsAor>, AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let req_json = Json(req.clone());

    if let Some((dt_since, dt_till)) =
        stats_aggregated_range(&req_json, env, dt_since, dt_till).c(h!())?
    {
        let result =
            read_aor_stats_aggregated(env, master_keys, dt_since, dt_till)
                .await
                .c(h!())?;
        return Ok(result);
    }

    fetch_aors_for_login_with_db(req, login_str, &env.dbx, master_keys, None)
        .await
}

async fn fetch_aors_for_login_with_db(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Vec<AnalysisStatsAor>, AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let instant = std::time::Instant::now();
    let stmt = if scope.is_some() {
        build_aors_analytics_query_with_scope(
            req,
            login_str,
            dt_since,
            dt_till,
            master_keys,
            scope,
        )?
    } else {
        build_aors_query(req, login_str, dt_since, dt_till, master_keys)?
    };
    let aors_res: Vec<AorsRes> = AorsRes::find_by_statement(stmt)
        .all(db)
        .await
        .context(h!())?;
    let mut aors = vec![];
    for x in aors_res {
        aors.push(AnalysisStatsAor {
            count: x.count,
            aor_id: x.aor_id,
        });
    }
    debug!("aors op took: {:?}", instant.elapsed());
    Ok(aors)
}

pub(super) async fn fetch_aors_raw_with_db(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
    scope: &AnalyticsMessageIdScope,
) -> Result<Vec<AnalysisStatsAor>, AppError> {
    if scope.is_empty() {
        return Ok(Vec::new());
    }
    let login_value = login_id_from_identity(user)?;
    fetch_aors_for_login_with_db(
        &req.0,
        &login_value,
        db,
        master_keys,
        Some(scope),
    )
    .await
}

#[derive(FromQueryResult)]
struct AorsRes {
    aor_id: i64,
    count: i64,
}

pub async fn count_aors(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<i64, AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let read_db = env.replica();

    if let Some((dt_since, dt_till)) =
        stats_aggregated_range(req, env, dt_since, dt_till).c(h!())?
    {
        let aors =
            read_aor_stats_aggregated(env, master_keys, dt_since, dt_till)
                .await
                .c(h!())?;
        return Ok(aors.len() as i64);
    }

    count_aors_with_db(req, user, &read_db, master_keys, dt_since, dt_till)
        .await
}

pub(super) async fn count_aors_raw_with_db(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<i64, AppError> {
    if scope.is_some_and(|scope| scope.is_empty()) {
        return Ok(0);
    }
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let login_value = login_id_from_identity(user)?;
    let stmt = build_aors_analytics_query_with_scope(
        &req.0,
        &login_value,
        dt_since,
        dt_till,
        master_keys,
        scope,
    )?;
    let count = AorsRes::find_by_statement(stmt)
        .all(db)
        .await
        .context(h!())?
        .len();
    Ok(count as i64)
}

async fn count_aors_with_db(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> Result<i64, AppError> {
    let login_value = login_id_from_identity(user)?;
    let stmt =
        build_aors_query(&req.0, &login_value, dt_since, dt_till, master_keys)?;
    let count = AorsRes::find_by_statement(stmt)
        .all(db)
        .await
        .context(h!())?
        .len();
    Ok(count as i64)
}

fn build_aors_query(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
) -> Result<Statement, AppError> {
    let req = request_without_facet_filter(req, AnalysisFacet::Aors);
    let messages_q = build_aor_messages_query(
        &req,
        login_str,
        dt_since,
        dt_till,
        &master_keys,
        None,
    )?
    .select_only()
    .column_as(
        Expr::cust(r#"DISTINCT "signal_message"."id""#),
        "message_id",
    );

    let messages_cte_alias = Alias::new("messages_aor_cte");
    let messages_alias = Alias::new("messages_aor");
    let group_message_alias = Alias::new("group_message_aor");
    let group_aor_alias = Alias::new("group_aor_link");
    let group_value_alias = Alias::new("group_aor_value");
    let network_message_alias = Alias::new("network_message_aor");
    let network_alias = Alias::new("network_aor");
    let network_aor_alias = Alias::new("network_aor_link");
    let network_value_alias = Alias::new("network_aor_value");

    let mut group_message_aors = Query::select()
        .expr_as(
            Expr::col((messages_alias.clone(), Alias::new("message_id"))),
            Alias::new("message_id"),
        )
        .expr_as(
            Expr::col((
                group_value_alias.clone(),
                area_of_responsibility::Column::Id,
            )),
            Alias::new("aor_id"),
        )
        .from_as(messages_cte_alias.clone(), messages_alias.clone())
        .join_as(
            JoinType::InnerJoin,
            signal_message_group::Entity,
            group_message_alias.clone(),
            Condition::all().add(
                Expr::col((
                    group_message_alias.clone(),
                    signal_message_group::Column::SignalMessageId,
                ))
                .equals((messages_alias.clone(), Alias::new("message_id"))),
            ),
        )
        .join_as(
            JoinType::InnerJoin,
            signal_group_aor::Entity,
            group_aor_alias.clone(),
            Condition::all().add(
                Expr::col((
                    group_aor_alias.clone(),
                    signal_group_aor::Column::MasterKey,
                ))
                .equals((
                    group_message_alias.clone(),
                    signal_message_group::Column::GroupMasterKey,
                )),
            ),
        )
        .join_as(
            JoinType::InnerJoin,
            area_of_responsibility::Entity,
            group_value_alias.clone(),
            Expr::col((group_aor_alias, signal_group_aor::Column::AorId))
                .equals((
                    group_value_alias.clone(),
                    area_of_responsibility::Column::Id,
                )),
        )
        .and_where(
            Expr::col((
                group_value_alias.clone(),
                area_of_responsibility::Column::Deleted,
            ))
            .eq(false),
        )
        .and_where(
            Expr::col((
                group_value_alias.clone(),
                area_of_responsibility::Column::IsTopLevel,
            ))
            .eq(true),
        )
        .to_owned();
    if let Some(condition) = selected_aor_overlap_condition(
        group_value_alias.clone(),
        &req.selected_aors,
    ) {
        group_message_aors.cond_where(condition);
    }

    let mut network_message_aors = Query::select()
        .expr_as(
            Expr::col((messages_alias.clone(), Alias::new("message_id"))),
            Alias::new("message_id"),
        )
        .expr_as(
            Expr::col((
                network_value_alias.clone(),
                area_of_responsibility::Column::Id,
            )),
            Alias::new("aor_id"),
        )
        .from_as(messages_cte_alias.clone(), messages_alias.clone())
        .join_as(
            JoinType::InnerJoin,
            sigint_inbox_item_network::Entity,
            network_message_alias.clone(),
            Condition::all().add(
                Expr::col((
                    network_message_alias.clone(),
                    sigint_inbox_item_network::Column::SigintInboxItemId,
                ))
                .equals((messages_alias, Alias::new("message_id"))),
            ),
        )
        .join_as(
            JoinType::InnerJoin,
            sigint_network::Entity,
            network_alias.clone(),
            Condition::all().add(
                Expr::col((network_alias.clone(), sigint_network::Column::Id))
                    .equals((
                        network_message_alias.clone(),
                        sigint_inbox_item_network::Column::SigintNetworkId,
                    )),
            ),
        )
        .join_as(
            JoinType::InnerJoin,
            sigint_network_aor::Entity,
            network_aor_alias.clone(),
            Condition::all().add(
                Expr::col((
                    network_aor_alias.clone(),
                    sigint_network_aor::Column::NetworkId,
                ))
                .equals((network_alias.clone(), sigint_network::Column::Id)),
            ),
        )
        .join_as(
            JoinType::InnerJoin,
            area_of_responsibility::Entity,
            network_value_alias.clone(),
            Expr::col((network_aor_alias, sigint_network_aor::Column::AorId))
                .equals((
                    network_value_alias.clone(),
                    area_of_responsibility::Column::Id,
                )),
        )
        .and_where(
            Expr::col((network_alias, sigint_network::Column::Deleted))
                .eq(false),
        )
        .and_where(
            Expr::col((
                network_value_alias.clone(),
                area_of_responsibility::Column::Deleted,
            ))
            .eq(false),
        )
        .and_where(
            Expr::col((
                network_value_alias.clone(),
                area_of_responsibility::Column::IsTopLevel,
            ))
            .eq(true),
        )
        .to_owned();
    if let Some(condition) = selected_aor_overlap_condition(
        network_value_alias.clone(),
        &req.selected_aors,
    ) {
        network_message_aors.cond_where(condition);
    }

    let sql = format!(
        "WITH {messages_cte} AS ({messages_sql}) \
         SELECT aor_id, COUNT(DISTINCT message_id) AS count \
         FROM ({group_sql} UNION ALL {network_sql}) AS message_aors \
         GROUP BY 1",
        messages_cte = messages_cte_alias.to_string(),
        messages_sql = messages_q.into_query().to_string(PostgresQueryBuilder),
        group_sql = group_message_aors.to_string(PostgresQueryBuilder),
        network_sql = network_message_aors.to_string(PostgresQueryBuilder),
    );

    Ok(Statement::from_string(DbBackend::Postgres, sql))
}

#[cfg(test)]
pub(super) fn build_aors_analytics_query(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
) -> Result<Statement, AppError> {
    build_aors_analytics_query_with_scope(
        req,
        login_str,
        dt_since,
        dt_till,
        master_keys,
        None,
    )
}

fn build_aors_analytics_query_with_scope(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Statement, AppError> {
    let req = request_without_facet_filter(req, AnalysisFacet::Aors);
    let link_alias = Alias::new("analytics_aor_message_link");
    let value_alias = Alias::new("analytics_aor_value");
    let mut message_aors = build_aor_messages_query(
        &req,
        login_str,
        dt_since,
        dt_till,
        &master_keys,
        scope,
    )?
    .select_only()
    .column_as(signal_message::Column::Id, "message_id");
    QuerySelect::query(&mut message_aors)
        .expr_as(
            Expr::col((link_alias.clone(), Alias::new("aor_id"))),
            Alias::new("aor_id"),
        )
        .join_as(
            JoinType::InnerJoin,
            (
                Alias::new("echo_clickhouse_derived"),
                Alias::new("message_aor_link"),
            ),
            link_alias.clone(),
            Expr::col((link_alias.clone(), Alias::new("sigint_inbox_item_id")))
                .equals((signal_message::Entity, signal_message::Column::Id)),
        )
        .join_as(
            JoinType::InnerJoin,
            area_of_responsibility::Entity,
            value_alias.clone(),
            Expr::col((link_alias.clone(), Alias::new("aor_id"))).equals((
                value_alias.clone(),
                area_of_responsibility::Column::Id,
            )),
        )
        .and_where(
            Expr::col((
                value_alias.clone(),
                area_of_responsibility::Column::Deleted,
            ))
            .eq(false),
        )
        .and_where(
            Expr::col((
                value_alias,
                area_of_responsibility::Column::IsTopLevel,
            ))
            .eq(true),
        );
    if let Some(scope) = scope {
        QuerySelect::query(&mut message_aors).cond_where(
            scope.condition((link_alias, Alias::new("sigint_inbox_item_id"))),
        );
    }

    let sql = format!(
        "SELECT aor_id, COUNT(DISTINCT message_id) AS count \
         FROM ({message_aors}) AS message_aors \
         GROUP BY 1",
        message_aors =
            message_aors.into_query().to_string(PostgresQueryBuilder),
    );

    Ok(Statement::from_string(DbBackend::Postgres, sql))
}

fn build_aor_messages_query(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: &[String],
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
    let messages = sigint_inbox_item::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintPost.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SignalMessageGroup.def(),
        );
    let messages = match scope {
        Some(_) => messages,
        None => messages.filter(message_in_groups_exists(master_keys.to_vec())),
    };
    let messages = messages
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till));
    let messages = apply_analytics_message_id_scope(messages, scope);
    let messages = apply_analytics_group_message_id_scope(messages, scope);
    let messages = apply_joined_group_rows_filter(
        messages,
        &req.selected_groups,
        &req.selected_senders,
        master_keys,
    );
    let messages =
        filter_selected_freqs(messages, &req.selected_freqs).context(h!())?;
    let messages =
        filter_selected_posts(messages, &req.selected_posts).context(h!())?;
    let messages = filter_selected_locations(
        messages,
        &req.selected_locations,
        req.include_peleng_locations.unwrap_or(false),
    )
    .context(h!())?;
    let messages = filter_selected_callsigns(messages, &req.selected_callsigns)
        .context(h!())?;
    let messages = filter_selected_tags_with_scope(
        messages,
        &req.selected_tags,
        &req.denied_tags,
        &req.tag_presence,
        &req.or_bookmarked,
        &req.or_important,
        &req.or_with_coords,
        &req.or_without_coords,
        &req.or_with_extended_form,
        &req.filter_tags_option,
        &req.without_model_tags,
        login_str,
        req.report_tags_only_this_unit.unwrap_or(false),
        scope,
    )
    .context(h!())?;
    let messages = filter_search(messages, &req.search).context(h!())?;
    let messages =
        filter_selected_device_names(messages, &req.selected_device_names)?;
    let messages = apply_metadata_filters(messages, req)?;
    filter_selected_aors_for_scope(messages, &req.selected_aors, scope)
}

#[derive(FromQueryResult)]
struct NetworksRes {
    network_id: Option<i64>,
    msg_count: i64,
}

pub async fn fetch_networks(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsNetwork>, AppError> {
    let login_value = login_id_from_identity(user)?;
    fetch_networks_for_login(&req.0, &login_value, &env.dbx, master_keys).await
}

pub async fn fetch_networks_for_login(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsNetwork>, AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;

    let instant = std::time::Instant::now();

    let networks_query = build_networks_query_for_login(
        req,
        login_str,
        dt_since,
        dt_till,
        master_keys,
    )?;

    let stmt = Statement::from_string(
        DbBackend::Postgres,
        networks_query.to_string(PostgresQueryBuilder),
    );

    let networks_res: Vec<NetworksRes> =
        NetworksRes::find_by_statement(stmt).all(db).await.c(h!())?;

    let mut networks = vec![];
    for x in networks_res {
        let Some(network_id) = x.network_id else {
            continue;
        };
        networks.push(AnalysisStatsNetwork {
            network_id,
            count: x.msg_count,
        });
    }
    debug!("networks op took: {:?}", instant.elapsed());
    Ok(networks)
}

pub async fn count_networks(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<i64, AppError> {
    let read_db = env.replica();
    count_networks_with_db(req, user, &read_db, master_keys).await
}

pub(super) async fn count_networks_with_db(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
) -> Result<i64, AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;

    let networks_query =
        build_networks_query(&req.0, user, dt_since, dt_till, master_keys)?;

    // println!(
    //     "> network count res sql: {}",
    //     networks_query.to_string(PostgresQueryBuilder)
    // );

    let stmt = Statement::from_string(
        DbBackend::Postgres,
        networks_query.to_string(PostgresQueryBuilder),
    );

    let networks_res: Vec<NetworksRes> =
        NetworksRes::find_by_statement(stmt).all(db).await.c(h!())?;

    let res = networks_res.len() as i64;

    Ok(res)
}

pub(super) async fn count_networks_analytics_with_db(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
    tag_access: &AnalyticsTagAccess,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<i64, AppError> {
    if scope.is_some_and(|scope| scope.is_empty()) {
        return Ok(0);
    }
    let login_value = login_id_from_identity(user)?;
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let statement = build_networks_analytics_count_query_with_scope(
        &req.0,
        &login_value,
        &tag_access.accessible_tag_ids,
        &tag_access.unit_login_ids,
        dt_since,
        dt_till,
        master_keys,
        scope,
    )?;
    let result = DistinctCountRes::find_by_statement(statement)
        .one(db)
        .await
        .context(h!())?
        .unwrap_or(DistinctCountRes { count: 0 });
    Ok(result.count)
}

pub(super) async fn fetch_networks_analytics_with_db(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
    tag_access: &AnalyticsTagAccess,
    scope: &AnalyticsMessageIdScope,
) -> Result<Vec<AnalysisStatsNetwork>, AppError> {
    if scope.is_empty() {
        return Ok(Vec::new());
    }
    let login_value = login_id_from_identity(user)?;
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let statement = build_networks_analytics_query_with_scope(
        &req.0,
        &login_value,
        &tag_access.accessible_tag_ids,
        &tag_access.unit_login_ids,
        dt_since,
        dt_till,
        master_keys,
        false,
        Some(scope),
    )?;
    Ok(NetworksRes::find_by_statement(statement)
        .all(db)
        .await
        .context(h!())?
        .into_iter()
        .filter_map(|row| {
            row.network_id.map(|network_id| AnalysisStatsNetwork {
                network_id,
                count: row.msg_count,
            })
        })
        .collect())
}

#[cfg(test)]
pub(super) fn build_networks_analytics_count_query(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    accessible_tag_ids: &[i64],
    unit_login_ids: &[uuid::Uuid],
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
) -> Result<Statement, AppError> {
    build_networks_analytics_count_query_with_scope(
        req,
        login_str,
        accessible_tag_ids,
        unit_login_ids,
        dt_since,
        dt_till,
        master_keys,
        None,
    )
}

fn build_networks_analytics_count_query_with_scope(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    accessible_tag_ids: &[i64],
    unit_login_ids: &[uuid::Uuid],
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Statement, AppError> {
    build_networks_analytics_query_with_scope(
        req,
        login_str,
        accessible_tag_ids,
        unit_login_ids,
        dt_since,
        dt_till,
        master_keys,
        true,
        scope,
    )
}

#[cfg(test)]
pub(super) fn build_networks_analytics_query(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    accessible_tag_ids: &[i64],
    unit_login_ids: &[uuid::Uuid],
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
    count_only: bool,
) -> Result<Statement, AppError> {
    build_networks_analytics_query_with_scope(
        req,
        login_str,
        accessible_tag_ids,
        unit_login_ids,
        dt_since,
        dt_till,
        master_keys,
        count_only,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn build_networks_analytics_query_with_scope(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    accessible_tag_ids: &[i64],
    unit_login_ids: &[uuid::Uuid],
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
    count_only: bool,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Statement, AppError> {
    let req = request_without_facet_filter(req, AnalysisFacet::Networks);
    let messages = build_network_analytics_messages_query(
        &req,
        login_str,
        accessible_tag_ids,
        unit_login_ids,
        dt_since,
        dt_till,
        &master_keys,
        scope,
    )?;
    let effective_groups =
        effective_groups_with_access(&req.selected_groups, &master_keys);
    let frequency_matches = build_network_frequency_analytics_arm(
        messages.clone(),
        build_network_analytics_catalog_query(&req),
        &effective_groups,
    );
    let linked_matches = build_network_linked_analytics_arm(
        messages,
        &effective_groups,
        &req.selected_aors,
        scope,
    );
    let (projection, group_by) = if count_only {
        ("COUNT(DISTINCT network_id) AS count", "")
    } else {
        (
            "network_id, COUNT(DISTINCT dedup_key) AS msg_count",
            " GROUP BY network_id",
        )
    };
    let sql = format!(
        "SELECT {projection} \
         FROM ({frequency_sql} UNION ALL {linked_sql}) AS message_networks\
         {group_by}",
        frequency_sql = frequency_matches.to_string(PostgresQueryBuilder),
        linked_sql = linked_matches.to_string(PostgresQueryBuilder),
    );
    Ok(Statement::from_string(DbBackend::Postgres, sql))
}

fn build_network_analytics_messages_query(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    accessible_tag_ids: &[i64],
    unit_login_ids: &[uuid::Uuid],
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: &[String],
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
    let messages = sigint_inbox_item::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintPost.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SignalMessageGroup.def(),
        );
    let messages = match scope {
        Some(_) => messages,
        None => messages.filter(message_in_groups_exists(master_keys.to_vec())),
    };
    let messages = messages
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till));
    let messages = apply_analytics_message_id_scope(messages, scope);
    let messages = apply_analytics_group_message_id_scope(messages, scope);
    let messages = apply_joined_group_rows_filter(
        messages,
        &req.selected_groups,
        &req.selected_senders,
        master_keys,
    );
    let messages =
        filter_selected_freqs(messages, &req.selected_freqs).context(h!())?;
    let messages =
        filter_selected_posts(messages, &req.selected_posts).context(h!())?;
    let messages = filter_selected_units_for_period(
        messages,
        &req.selected_units,
        &req.units_exact_match_only,
        dt_since,
        dt_till,
    )
    .context(h!())?;
    let messages = filter_selected_locations(
        messages,
        &req.selected_locations,
        req.include_peleng_locations.unwrap_or(false),
    )
    .context(h!())?;
    let messages = filter_selected_callsigns(messages, &req.selected_callsigns)
        .context(h!())?;
    let messages =
        filter_selected_aors_for_scope(messages, &req.selected_aors, scope)?;
    let messages = filter_selected_networks_for_scope(
        messages,
        &req.selected_networks,
        &req.without_network,
        scope,
    )
    .context(h!())?;
    let messages = apply_metadata_filters(messages, req)?;
    let messages = filter_search(messages, &req.search).context(h!())?;
    let messages =
        filter_selected_device_names(messages, &req.selected_device_names)?;
    let report_tags_only_this_unit =
        req.report_tags_only_this_unit.unwrap_or(false);
    Ok(filter_selected_tags_analytics(
        messages,
        &req.selected_tags,
        &req.denied_tags,
        &req.tag_presence,
        &req.or_bookmarked,
        &req.or_important,
        &req.or_with_coords,
        &req.or_without_coords,
        &req.or_with_extended_form,
        &req.filter_tags_option,
        &req.without_model_tags,
        login_str,
        report_tags_only_this_unit,
        accessible_tag_ids,
        unit_login_ids,
        scope,
    )
    .context(h!())?)
}

fn project_network_analytics_messages(
    messages: Select<sigint_inbox_item::Entity>,
) -> SelectStatement {
    messages
        .select_only()
        .column_as(signal_message::Column::Id, "dedup_key")
        .column(sigint_inbox_item::Column::Freq)
        .column(sigint_inbox_item::Column::Datetime)
        .column_as(
            Expr::col((
                signal_message_group::Entity,
                signal_message_group::Column::GroupMasterKey,
            )),
            "group_master_key",
        )
        .into_query()
}

fn build_network_analytics_catalog_query(
    req: &AnalysisStatsReq,
) -> Select<sigint_network_freq::Entity> {
    let network_value_alias = Alias::new("analytics_network_aor");
    let networks = sigint_network_freq::Entity::find()
        .select_only()
        .column_as(sigint_network::Column::Id, "network_id")
        .column(sigint_network_freq::Column::Freq)
        .column(sigint_network_freq::Column::ActiveFrom)
        .column(sigint_network_freq::Column::ActiveTo)
        .column_as(
            Expr::col((
                network_value_alias.clone(),
                area_of_responsibility::Column::LeftBound,
            )),
            "n_left",
        )
        .column_as(
            Expr::col((
                network_value_alias.clone(),
                area_of_responsibility::Column::RightBound,
            )),
            "n_right",
        )
        .join(
            JoinType::InnerJoin,
            sigint_network_freq::Relation::SigintNetwork.def(),
        )
        .join(
            JoinType::InnerJoin,
            sigint_network::Relation::SigintNetworkAor.def(),
        )
        .join_as(
            JoinType::InnerJoin,
            sigint_network_aor::Relation::AreaOfResponsibility.def(),
            network_value_alias,
        )
        .filter(sigint_network_freq::Column::Deleted.eq(false))
        .filter(sigint_network::Column::Deleted.eq(false));

    if req
        .selected_aors
        .as_ref()
        .is_some_and(|aors| !aors.is_empty())
    {
        let network_scope_link_alias =
            Alias::new("analytics_network_scope_link");
        let network_scope_value_alias =
            Alias::new("analytics_network_scope_value");
        let mut network_scope_exists = Query::select();
        network_scope_exists
            .expr(Expr::value(1))
            .from_as(
                sigint_network_aor::Entity,
                network_scope_link_alias.clone(),
            )
            .join_as(
                JoinType::InnerJoin,
                area_of_responsibility::Entity,
                network_scope_value_alias.clone(),
                Expr::col((
                    network_scope_link_alias.clone(),
                    sigint_network_aor::Column::AorId,
                ))
                .equals((
                    network_scope_value_alias.clone(),
                    area_of_responsibility::Column::Id,
                )),
            )
            .and_where(
                Expr::col((
                    network_scope_link_alias,
                    sigint_network_aor::Column::NetworkId,
                ))
                .equals((sigint_network::Entity, sigint_network::Column::Id)),
            );
        if let Some(condition) = selected_aor_overlap_condition(
            network_scope_value_alias,
            &req.selected_aors,
        ) {
            network_scope_exists.cond_where(condition);
        }
        networks.filter(Expr::exists(network_scope_exists.to_owned()))
    } else {
        networks
    }
}

fn build_network_frequency_analytics_arm(
    messages: Select<sigint_inbox_item::Entity>,
    networks: Select<sigint_network_freq::Entity>,
    effective_groups: &[String],
) -> SelectStatement {
    let message_alias = Alias::new("analytics_frequency_message");
    let network_alias = Alias::new("analytics_frequency_network");
    let group_alias = Alias::new("analytics_frequency_group");
    let group_aor_alias = Alias::new("analytics_frequency_group_aor");
    let group_value_alias = Alias::new("analytics_frequency_group_value");
    let mut matches = Query::select();
    matches
        .expr_as(
            Expr::col((network_alias.clone(), Alias::new("network_id"))),
            Alias::new("network_id"),
        )
        .expr_as(
            Expr::col((message_alias.clone(), Alias::new("dedup_key"))),
            Alias::new("dedup_key"),
        )
        .from_subquery(
            project_network_analytics_messages(messages),
            message_alias.clone(),
        )
        .join_subquery(
            JoinType::InnerJoin,
            networks.into_query(),
            network_alias.clone(),
            Condition::all()
                .add(
                    Expr::col((message_alias.clone(), Alias::new("freq")))
                        .equals((network_alias.clone(), Alias::new("freq"))),
                )
                .add(
                    Expr::col((network_alias.clone(), Alias::new("freq")))
                        .is_not_null(),
                )
                .add(
                    Expr::col((message_alias.clone(), Alias::new("datetime")))
                        .gte(Expr::col((
                            network_alias.clone(),
                            Alias::new("active_from"),
                        ))),
                )
                .add(
                    Expr::col((message_alias.clone(), Alias::new("datetime")))
                        .lte(Expr::cust(
                            "COALESCE(analytics_frequency_network.active_to, \
                         CURRENT_TIMESTAMP AT TIME ZONE 'UTC')",
                        )),
                ),
        );
    join_network_analytics_groups(
        &mut matches,
        message_alias,
        group_alias,
        group_aor_alias,
        group_value_alias,
        effective_groups,
        Expr::col((network_alias.clone(), Alias::new("n_left"))),
        Expr::col((network_alias, Alias::new("n_right"))),
    );
    matches.to_owned()
}

fn build_network_linked_analytics_arm(
    messages: Select<sigint_inbox_item::Entity>,
    effective_groups: &[String],
    selected_aors: &Option<Vec<i64>>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> SelectStatement {
    let message_alias = Alias::new("analytics_linked_message");
    let network_link_alias = Alias::new("analytics_linked_network_link");
    let network_alias = Alias::new("analytics_linked_network");
    let network_aor_alias = Alias::new("analytics_linked_network_aor");
    let network_value_alias = Alias::new("analytics_linked_network_value");
    let group_alias = Alias::new("analytics_linked_group");
    let group_aor_alias = Alias::new("analytics_linked_group_aor");
    let group_value_alias = Alias::new("analytics_linked_group_value");
    let mut matches = Query::select();
    matches
        .expr_as(
            Expr::col((
                network_link_alias.clone(),
                sigint_inbox_item_network::Column::SigintNetworkId,
            )),
            Alias::new("network_id"),
        )
        .expr_as(
            Expr::col((message_alias.clone(), Alias::new("dedup_key"))),
            Alias::new("dedup_key"),
        )
        .from_subquery(
            project_network_analytics_messages(messages),
            message_alias.clone(),
        );
    let link_condition = Expr::col((
        network_link_alias.clone(),
        Alias::new("sigint_inbox_item_id"),
    ))
    .equals((message_alias.clone(), Alias::new("dedup_key")));
    if scope.is_some() {
        matches.join_as(
            JoinType::InnerJoin,
            (
                Alias::new("echo_clickhouse_derived"),
                Alias::new("message_network_link"),
            ),
            network_link_alias.clone(),
            link_condition,
        );
    } else {
        matches.join_as(
            JoinType::InnerJoin,
            sigint_inbox_item_network::Entity,
            network_link_alias.clone(),
            link_condition,
        );
    }
    matches
        .join_as(
            JoinType::InnerJoin,
            sigint_network::Entity,
            network_alias.clone(),
            Expr::col((network_alias.clone(), sigint_network::Column::Id))
                .equals((
                    network_link_alias.clone(),
                    Alias::new("sigint_network_id"),
                )),
        )
        .join_as(
            JoinType::InnerJoin,
            sigint_network_aor::Entity,
            network_aor_alias.clone(),
            Expr::col((
                network_aor_alias.clone(),
                sigint_network_aor::Column::NetworkId,
            ))
            .equals((network_alias.clone(), sigint_network::Column::Id)),
        )
        .join_as(
            JoinType::InnerJoin,
            area_of_responsibility::Entity,
            network_value_alias.clone(),
            Expr::col((network_aor_alias, sigint_network_aor::Column::AorId))
                .equals((
                    network_value_alias.clone(),
                    area_of_responsibility::Column::Id,
                )),
        );
    join_network_analytics_groups(
        &mut matches,
        message_alias,
        group_alias,
        group_aor_alias,
        group_value_alias,
        effective_groups,
        Expr::col((
            network_value_alias.clone(),
            area_of_responsibility::Column::LeftBound,
        )),
        Expr::col((
            network_value_alias.clone(),
            area_of_responsibility::Column::RightBound,
        )),
    );
    matches.and_where(
        Expr::col((network_alias, sigint_network::Column::Deleted)).eq(false),
    );
    if let Some(scope) = scope {
        matches.cond_where(scope.condition((
            network_link_alias,
            Alias::new("sigint_inbox_item_id"),
        )));
    }
    if let Some(condition) =
        selected_aor_overlap_condition(network_value_alias, selected_aors)
    {
        matches.cond_where(condition);
    }
    matches.to_owned()
}

#[allow(clippy::too_many_arguments)]
fn join_network_analytics_groups(
    matches: &mut SelectStatement,
    message_alias: Alias,
    group_alias: Alias,
    group_aor_alias: Alias,
    group_value_alias: Alias,
    effective_groups: &[String],
    network_left: SimpleExpr,
    network_right: SimpleExpr,
) {
    matches
        .join_as(
            JoinType::InnerJoin,
            signal_group::Entity,
            group_alias.clone(),
            Expr::col((message_alias, Alias::new("group_master_key")))
                .equals((group_alias.clone(), signal_group::Column::MasterKey)),
        )
        .join_as(
            JoinType::InnerJoin,
            signal_group_aor::Entity,
            group_aor_alias.clone(),
            Expr::col((
                group_aor_alias.clone(),
                signal_group_aor::Column::MasterKey,
            ))
            .equals((group_alias.clone(), signal_group::Column::MasterKey)),
        )
        .join_as(
            JoinType::InnerJoin,
            area_of_responsibility::Entity,
            group_value_alias.clone(),
            Expr::col((group_aor_alias, signal_group_aor::Column::AorId))
                .equals((
                    group_value_alias.clone(),
                    area_of_responsibility::Column::Id,
                )),
        )
        .and_where(
            Expr::col((group_alias.clone(), signal_group::Column::Deleted))
                .eq(false),
        )
        .and_where(
            Expr::col((group_alias.clone(), signal_group::Column::IsArchived))
                .eq(false),
        )
        .cond_where(group_value_network_aor_overlap_condition(
            group_value_alias,
            network_left,
            network_right,
        ));
    if effective_groups.is_empty() {
        matches.and_where(Expr::cust("FALSE"));
    } else {
        matches.and_where(
            Expr::col((group_alias, signal_group::Column::MasterKey))
                .is_in(effective_groups.to_vec()),
        );
    }
}

fn group_value_network_aor_overlap_condition(
    group_value_alias: Alias,
    network_left: SimpleExpr,
    network_right: SimpleExpr,
) -> Condition {
    Condition::any()
        .add(
            Condition::all()
                .add(
                    Expr::col((
                        group_value_alias.clone(),
                        area_of_responsibility::Column::LeftBound,
                    ))
                    .gte(network_left.clone()),
                )
                .add(
                    Expr::col((
                        group_value_alias.clone(),
                        area_of_responsibility::Column::LeftBound,
                    ))
                    .lte(network_right.clone()),
                ),
        )
        .add(
            Condition::all()
                .add(
                    Expr::col((
                        group_value_alias.clone(),
                        area_of_responsibility::Column::RightBound,
                    ))
                    .gte(network_left.clone()),
                )
                .add(
                    Expr::col((
                        group_value_alias.clone(),
                        area_of_responsibility::Column::RightBound,
                    ))
                    .lte(network_right.clone()),
                ),
        )
        .add(
            Condition::all()
                .add(
                    Expr::col((
                        group_value_alias.clone(),
                        area_of_responsibility::Column::LeftBound,
                    ))
                    .lte(network_left),
                )
                .add(
                    Expr::col((
                        group_value_alias,
                        area_of_responsibility::Column::RightBound,
                    ))
                    .gte(network_right),
                ),
        )
}

fn build_networks_query(
    req: &AnalysisStatsReq,
    user: &Identity,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
) -> Result<WithQuery, AppError> {
    let login_value = login_id_from_identity(user)?;
    build_networks_query_for_login(
        req,
        &login_value,
        dt_since,
        dt_till,
        master_keys,
    )
}

fn network_stats_group_join_condition(
    message_alias: Alias,
    group_alias: Alias,
    network_left: SimpleExpr,
    network_right: SimpleExpr,
) -> Condition {
    Condition::all()
        .add(
            Expr::col((message_alias, Alias::new("group_master_key")))
                .equals((group_alias.clone(), Alias::new("master_key"))),
        )
        .add(group_network_aor_overlap_condition(
            group_alias,
            network_left,
            network_right,
        ))
}

fn group_network_aor_overlap_condition(
    group_alias: Alias,
    network_left: SimpleExpr,
    network_right: SimpleExpr,
) -> Condition {
    Condition::any()
        .add(
            Condition::all()
                .add(
                    Expr::col((group_alias.clone(), Alias::new("g_left")))
                        .gte(network_left.clone()),
                )
                .add(
                    Expr::col((group_alias.clone(), Alias::new("g_left")))
                        .lte(network_right.clone()),
                ),
        )
        .add(
            Condition::all()
                .add(
                    Expr::col((group_alias.clone(), Alias::new("g_right")))
                        .gte(network_left.clone()),
                )
                .add(
                    Expr::col((group_alias.clone(), Alias::new("g_right")))
                        .lte(network_right.clone()),
                ),
        )
        .add(
            Condition::all()
                .add(
                    Expr::col((group_alias.clone(), Alias::new("g_left")))
                        .lte(network_left),
                )
                .add(
                    Expr::col((group_alias, Alias::new("g_right")))
                        .gte(network_right),
                ),
        )
}

fn build_networks_query_for_login(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
) -> Result<WithQuery, AppError> {
    let req = request_without_facet_filter(req, AnalysisFacet::Networks);
    let include_peleng_locations =
        req.include_peleng_locations.unwrap_or(false);

    // Aliases for CTEs
    let messages_cte_alias = Alias::new("messages_cte");
    let networks_cte_alias = Alias::new("networks_cte");
    let groups_cte_alias = Alias::new("groups_cte");
    let network_value_alias = Alias::new("networks_cte_aor");

    // 1) messages_cte
    let messages_q = sigint_inbox_item::Entity::find()
        .select_only()
        .column_as(Expr::cust(r#"DISTINCT "signal_message"."id""#), "dedup_key")
        .column(sigint_inbox_item::Column::Freq)
        .column(sigint_inbox_item::Column::Datetime)
        .column_as(
            Expr::col((
                signal_message_group::Entity,
                signal_message_group::Column::GroupMasterKey,
            )),
            "group_master_key",
        )
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintPost.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SignalMessageGroup.def(),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(message_in_groups_exists(master_keys.clone()))
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till));
    let messages_q = apply_joined_group_rows_filter(
        messages_q,
        &req.selected_groups,
        &req.selected_senders,
        &master_keys,
    );

    // 2) networks_cte
    let networks_q = sigint_network_freq::Entity::find()
        .select_only()
        .column_as(sigint_network::Column::Id, "network_id")
        .column(sigint_network_freq::Column::Freq)
        .column(sigint_network_freq::Column::ActiveFrom)
        .column(sigint_network_freq::Column::ActiveTo)
        .column_as(
            Expr::col((
                network_value_alias.clone(),
                area_of_responsibility::Column::LeftBound,
            )),
            "n_left",
        )
        .column_as(
            Expr::col((
                network_value_alias.clone(),
                area_of_responsibility::Column::RightBound,
            )),
            "n_right",
        )
        .join(
            JoinType::InnerJoin,
            sigint_network_freq::Relation::SigintNetwork.def(),
        )
        .join(
            JoinType::InnerJoin,
            sigint_network::Relation::SigintNetworkAor.def(),
        )
        .join_as(
            JoinType::InnerJoin,
            sigint_network_aor::Relation::AreaOfResponsibility.def(),
            network_value_alias.clone(),
        )
        .filter(sigint_network_freq::Column::Deleted.eq(false))
        .filter(sigint_network::Column::Deleted.eq(false));
    let networks_q = if req
        .selected_aors
        .as_ref()
        .map(|aors| !aors.is_empty())
        .unwrap_or(false)
    {
        let network_scope_link_alias = Alias::new("network_scope_link");
        let network_scope_value_alias = Alias::new("network_scope_value");
        let mut network_scope_exists = Query::select();
        network_scope_exists
            .expr(Expr::value(1))
            .from_as(
                sigint_network_aor::Entity,
                network_scope_link_alias.clone(),
            )
            .join_as(
                JoinType::InnerJoin,
                area_of_responsibility::Entity,
                network_scope_value_alias.clone(),
                Expr::col((
                    network_scope_link_alias.clone(),
                    sigint_network_aor::Column::AorId,
                ))
                .equals((
                    network_scope_value_alias.clone(),
                    area_of_responsibility::Column::Id,
                )),
            )
            .and_where(
                Expr::col((
                    network_scope_link_alias,
                    sigint_network_aor::Column::NetworkId,
                ))
                .equals((sigint_network::Entity, sigint_network::Column::Id)),
            );
        if let Some(condition) = selected_aor_overlap_condition(
            network_scope_value_alias,
            &req.selected_aors,
        ) {
            network_scope_exists.cond_where(condition);
        }
        networks_q.filter(Expr::exists(network_scope_exists.to_owned()))
    } else {
        networks_q
    };

    // 3) groups_cte
    let groups_q = signal_group::Entity::find()
        .select_only()
        .column(signal_group::Column::MasterKey)
        .column_as(area_of_responsibility::Column::LeftBound, "g_left")
        .column_as(area_of_responsibility::Column::RightBound, "g_right")
        .join(
            JoinType::InnerJoin,
            signal_group::Relation::SignalGroupAor.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_group_aor::Relation::AreaOfResponsibility.def(),
        )
        .filter(signal_group::Column::Deleted.eq(false))
        .filter(signal_group::Column::IsArchived.eq(false));
    let effective_groups =
        effective_groups_with_access(&req.selected_groups, &master_keys);
    let groups_q = if effective_groups.is_empty() {
        groups_q.filter(Expr::cust("FALSE"))
    } else {
        groups_q
            .filter(signal_group::Column::MasterKey.eq_any(effective_groups))
    };
    // add more custom filters to the messages CTE
    let messages_q =
        filter_selected_freqs(messages_q, &req.selected_freqs).context(h!())?;
    let messages_q =
        filter_selected_posts(messages_q, &req.selected_posts).context(h!())?;
    let messages_q = filter_selected_units_for_period(
        messages_q,
        &req.selected_units,
        &req.units_exact_match_only,
        dt_since,
        dt_till,
    )
    .context(h!())?;
    let messages_q = filter_selected_locations(
        messages_q,
        &req.selected_locations,
        include_peleng_locations,
    )
    .context(h!())?;
    let messages_q =
        filter_selected_callsigns(messages_q, &req.selected_callsigns)
            .context(h!())?;
    let messages_q =
        filter_selected_aors(messages_q, &req.selected_aors).context(h!())?;
    let messages_q = filter_selected_networks(
        messages_q,
        &req.selected_networks,
        &req.without_network,
    )
    .context(h!())?;
    let messages_q = apply_metadata_filters(messages_q, &req)?;
    let messages_q = filter_search(messages_q, &req.search).context(h!())?;
    let messages_q =
        filter_selected_device_names(messages_q, &req.selected_device_names)?;
    let messages_q = filter_selected_tags(
        messages_q,
        &req.selected_tags,
        &req.denied_tags,
        &req.tag_presence,
        &req.or_bookmarked,
        &req.or_important,
        &req.or_with_coords,
        &req.or_without_coords,
        &req.or_with_extended_form,
        &req.filter_tags_option,
        &req.without_model_tags,
        login_str,
        req.report_tags_only_this_unit.unwrap_or(false),
    )
    .context(h!())?;

    let messages_cte = CommonTableExpression::new()
        .query(messages_q.into_query().to_owned())
        .table_name(messages_cte_alias.clone())
        .to_owned();

    let networks_cte = CommonTableExpression::new()
        .query(networks_q.into_query().to_owned())
        .table_name(networks_cte_alias.clone())
        .to_owned();

    let groups_cte = CommonTableExpression::new()
        .query(groups_q.into_query().to_owned())
        .table_name(groups_cte_alias.clone())
        .to_owned();

    // Main SELECT
    let m = Alias::new("m");
    let n = Alias::new("n");
    let g = Alias::new("g");

    let mut freq_matches_q = Query::select();
    freq_matches_q
        .distinct()
        .expr_as(
            Expr::col((m.clone(), Alias::new("dedup_key"))),
            Alias::new("dedup_key"),
        )
        .expr_as(
            Expr::col((n.clone(), Alias::new("network_id"))),
            Alias::new("network_id"),
        )
        .from_as(messages_cte_alias.clone(), m.clone())
        .join_as(
            JoinType::InnerJoin,
            networks_cte_alias.clone(),
            n.clone(),
            Condition::all()
                .add(Expr::col((m.clone(), Alias::new("freq"))).equals((n.clone(), Alias::new("freq"))))
                .add(Expr::col((n.clone(), Alias::new("freq"))).is_not_null())
                .add(Expr::col((m.clone(), Alias::new("datetime"))).gte(Expr::col((n.clone(), Alias::new("active_from")))))
                .add(
                    Expr::col((m.clone(), Alias::new("datetime")))
                        .lte(Expr::cust("COALESCE(n.active_to, CURRENT_TIMESTAMP AT TIME ZONE 'UTC')"))
                    ),
        )
        .join_as(
            JoinType::InnerJoin,
            groups_cte_alias.clone(),
            g.clone(),
            network_stats_group_join_condition(
                m.clone(),
                g.clone(),
                Expr::col((n.clone(), Alias::new("n_left"))),
                Expr::col((n.clone(), Alias::new("n_right"))),
            ),
        );

    let linked_m = Alias::new("linked_m");
    let linked_network_link = Alias::new("linked_network_link");
    let linked_network = Alias::new("linked_network");
    let linked_network_aor = Alias::new("linked_network_aor");
    let linked_network_value = Alias::new("linked_network_value");
    let linked_g = Alias::new("linked_g");

    let mut linked_matches_q = Query::select();
    linked_matches_q
        .distinct()
        .expr_as(
            Expr::col((linked_m.clone(), Alias::new("dedup_key"))),
            Alias::new("dedup_key"),
        )
        .expr_as(
            Expr::col((
                linked_network_link.clone(),
                sigint_inbox_item_network::Column::SigintNetworkId,
            )),
            Alias::new("network_id"),
        )
        .from_as(messages_cte_alias.clone(), linked_m.clone())
        .join_as(
            JoinType::InnerJoin,
            sigint_inbox_item_network::Entity,
            linked_network_link.clone(),
            Expr::col((
                linked_network_link.clone(),
                sigint_inbox_item_network::Column::SigintInboxItemId,
            ))
            .equals((linked_m.clone(), Alias::new("dedup_key"))),
        )
        .join_as(
            JoinType::InnerJoin,
            sigint_network::Entity,
            linked_network.clone(),
            Expr::col((linked_network.clone(), sigint_network::Column::Id))
                .equals((
                    linked_network_link.clone(),
                    sigint_inbox_item_network::Column::SigintNetworkId,
                )),
        )
        .join_as(
            JoinType::InnerJoin,
            sigint_network_aor::Entity,
            linked_network_aor.clone(),
            Expr::col((
                linked_network_aor.clone(),
                sigint_network_aor::Column::NetworkId,
            ))
            .equals((linked_network.clone(), sigint_network::Column::Id)),
        )
        .join_as(
            JoinType::InnerJoin,
            area_of_responsibility::Entity,
            linked_network_value.clone(),
            Expr::col((
                linked_network_aor.clone(),
                sigint_network_aor::Column::AorId,
            ))
            .equals((
                linked_network_value.clone(),
                area_of_responsibility::Column::Id,
            )),
        )
        .join_as(
            JoinType::InnerJoin,
            groups_cte_alias.clone(),
            linked_g.clone(),
            network_stats_group_join_condition(
                linked_m.clone(),
                linked_g.clone(),
                Expr::col((
                    linked_network_value.clone(),
                    area_of_responsibility::Column::LeftBound,
                )),
                Expr::col((
                    linked_network_value.clone(),
                    area_of_responsibility::Column::RightBound,
                )),
            ),
        )
        .and_where(
            Expr::col((
                linked_network.clone(),
                sigint_network::Column::Deleted,
            ))
            .eq(false),
        );
    if let Some(condition) =
        selected_aor_overlap_condition(linked_network_value, &req.selected_aors)
    {
        linked_matches_q.cond_where(condition);
    }
    freq_matches_q.union(UnionType::All, linked_matches_q.to_owned());

    let message_network_alias = Alias::new("message_network");
    let mut main_q = Query::select();
    main_q
        .expr_as(
            Expr::col((
                message_network_alias.clone(),
                Alias::new("network_id"),
            )),
            Alias::new("network_id"),
        )
        .expr_as(
            Expr::cust("count(distinct message_network.dedup_key)"),
            Alias::new("msg_count"),
        )
        .from_subquery(freq_matches_q.to_owned(), message_network_alias.clone())
        .group_by_col((message_network_alias, Alias::new("network_id")));

    // Build WITH (using Select)
    let query = Query::with()
        .cte(messages_cte)
        .clone()
        .cte(networks_cte)
        .clone()
        .cte(groups_cte)
        .clone()
        .query(main_q)
        .to_owned();

    Ok(query)
}

pub async fn fetch_counts(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<(i64, i64), AppError> {
    let login_value = login_id_from_identity(user)?;
    fetch_counts_for_login(req, &login_value, env.get_ref(), master_keys).await
}

pub async fn fetch_counts_for_login(
    req: &Json<AnalysisStatsReq>,
    login_str: &uuid::Uuid,
    env: &Env,
    master_keys: Vec<String>,
) -> Result<(i64, i64), AppError> {
    let (replica_conn, replica_label) = env.replica_with_label();
    match fetch_counts_for_login_with_conn(
        req,
        login_str,
        master_keys.clone(),
        env,
        &replica_conn,
        true,
        None,
    )
    .await
    {
        Ok(res) => Ok(res),
        Err(err)
            if replica_label.is_some() && is_replica_conflict_error(&err) =>
        {
            warn!(
                "Replica {:?} hit recovery conflict for login {login_str}, retrying on primary",
                replica_label
            );
            fetch_counts_for_login_with_conn(
                req,
                login_str,
                master_keys,
                env,
                &env.dbx,
                true,
                None,
            )
            .await
        }
        Err(err) => Err(err),
    }
}

async fn fetch_counts_for_login_with_conn(
    req: &Json<AnalysisStatsReq>,
    login_str: &uuid::Uuid,
    master_keys: Vec<String>,
    env: &Env,
    db: &DatabaseConnection,
    allow_stats_aggregated: bool,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<(i64, i64), AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let include_peleng_locations =
        req.include_peleng_locations.unwrap_or(false);
    let read_stats_aggregated = allow_stats_aggregated
        && can_read_stats_aggregated(&env.config, dt_since, dt_till)
        && is_5min_stats_bucket_range_aligned(dt_since, dt_till);

    let instant = std::time::Instant::now();
    let count_overall: i64 = fetch_count_overall(
        db,
        dt_since,
        dt_till,
        master_keys.clone(),
        env,
        read_stats_aggregated,
        scope,
    )
    .await
    .context(h!())?;

    if instant.elapsed().as_secs() > 1 {
        debug!("count overall op took: {:?}", instant.elapsed());
    }
    if read_stats_aggregated
        && should_read_stats_aggregated_for_config(
            &req.0,
            &env.config,
            dt_since,
            dt_till,
        )
    {
        return Ok((count_overall, count_overall));
    }
    let instant = std::time::Instant::now();

    #[derive(FromQueryResult)]
    struct SelectedCountRes {
        count: i64,
    }
    let selected_count_res = sigint_inbox_item::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintPost.def(),
        )
        .select_only()
        .column_as(
            Expr::cust(r#"COUNT(DISTINCT "signal_message"."id")"#),
            "count",
        )
        .filter(signal_message::Column::Deleted.eq(false))
        // .filter(signal_message::Column::DuplicateOf.is_null())
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till));
    let selected_count_res =
        apply_analytics_message_id_scope(selected_count_res, scope);
    // .filter(sigint_inbox_item::Column::Checked.eq(Some(true)));
    let selected_count_res = apply_message_access_filter(
        selected_count_res,
        &req.selected_groups,
        &req.selected_senders,
        &master_keys,
        scope,
    )
    .context(h!())?;
    let selected_count_res =
        filter_selected_freqs(selected_count_res, &req.selected_freqs)
            .context(h!())?;
    let selected_count_res =
        filter_selected_posts(selected_count_res, &req.selected_posts)
            .context(h!())?;
    let selected_count_res = filter_selected_units_for_period(
        selected_count_res,
        &req.selected_units,
        &req.units_exact_match_only,
        dt_since,
        dt_till,
    )
    .context(h!())?;
    let selected_count_res = filter_selected_locations(
        selected_count_res,
        &req.selected_locations,
        include_peleng_locations,
    )
    .context(h!())?;
    let selected_count_res =
        filter_selected_callsigns(selected_count_res, &req.selected_callsigns)
            .context(h!())?;
    let selected_count_res = filter_selected_tags_with_scope(
        selected_count_res,
        &req.selected_tags,
        &req.denied_tags,
        &req.tag_presence,
        &req.or_bookmarked,
        &req.or_important,
        &req.or_with_coords,
        &req.or_without_coords,
        &req.or_with_extended_form,
        &req.filter_tags_option,
        &req.without_model_tags,
        login_str,
        req.report_tags_only_this_unit.unwrap_or(false),
        scope,
    )
    .context(h!())?;
    let selected_count_res = filter_selected_networks_for_scope(
        selected_count_res,
        &req.selected_networks,
        &req.without_network,
        scope,
    )
    .context(h!())?;
    let selected_count_res =
        apply_metadata_filters(selected_count_res, &req.0)?;
    let selected_count_res =
        filter_search(selected_count_res, &req.search).context(h!())?;
    let selected_count_res = filter_selected_device_names(
        selected_count_res,
        &req.selected_device_names,
    )?;
    let selected_count_res = filter_selected_aors_for_scope(
        selected_count_res,
        &req.selected_aors,
        scope,
    )?;
    //println!(
    //    "> selected count res sql (login={}): {}",
    //    login_str,
    //    selected_count_res
    //    .clone()
    //    .build(DbBackend::Postgres)
    //    .to_string();
    //);
    let selected_count_res: SelectedCountRes = selected_count_res
        .into_model::<SelectedCountRes>()
        .one(db)
        .await
        .context(h!())?
        .unwrap_or(SelectedCountRes { count: 0 });
    let count_selected: i64 = selected_count_res.count;

    if instant.elapsed().as_secs() > 1 {
        debug!("count selected op took: {:?}", instant.elapsed());
    }
    Ok((count_overall, count_selected))
}

pub(super) async fn fetch_counts_raw_with_db(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &Env,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<(i64, i64), AppError> {
    if scope.is_some_and(|scope| scope.is_empty()) {
        return Ok((0, 0));
    }
    let login_value = login_id_from_identity(user)?;
    fetch_counts_for_login_with_conn(
        req,
        &login_value,
        master_keys,
        env,
        db,
        false,
        scope,
    )
    .await
}

async fn fetch_count_overall(
    db: &DatabaseConnection,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
    env: &Env,
    read_stats_aggregated: bool,
    scope: Option<&AnalyticsMessageIdScope>,
) -> anyhow::Result<i64> {
    if read_stats_aggregated {
        return read_total_stats_aggregated_for_env(
            env,
            master_keys,
            dt_since,
            dt_till,
        )
        .await
        .context(h!());
    }

    #[derive(FromQueryResult)]
    struct OverallCountRes {
        count: i64,
    }
    let overall_count_res = sigint_inbox_item::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintPost.def(),
        )
        .select_only()
        .column_as(
            Expr::cust(r#"COUNT(DISTINCT "signal_message"."id")"#),
            "count",
        )
        .filter(signal_message::Column::Deleted.eq(false))
        // .filter(signal_message::Column::DuplicateOf.is_null())
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till));
    let overall_count_res =
        apply_analytics_message_id_scope(overall_count_res, scope);
    let overall_count_res = apply_message_access_filter(
        overall_count_res,
        &None,
        &None,
        &master_keys,
        scope,
    )?;
    // .filter(sigint_inbox_item::Column::Checked.eq(Some(true)));
    // println!(
    //     "> overall count res sql: {}",
    //     overall_count_res.build(DbBackend::Postgres).to_string()
    // );
    let overall_count_res: OverallCountRes = overall_count_res
        .into_model::<OverallCountRes>()
        .one(db)
        .await
        .context(h!())?
        .context(h!())?;
    Ok(overall_count_res.count)
}

fn is_replica_conflict_error(err: &AppError) -> bool {
    let mut source: Option<&(dyn StdError + 'static)> = Some(err);
    while let Some(err) = source {
        if let Some(sqlx::Error::Database(db_error)) =
            err.downcast_ref::<sqlx::Error>()
        {
            if matches!(db_error.code(), Some(code) if code == "40001") {
                return true;
            }
        }
        source = err.source();
    }
    false
}

fn build_join_for_sigint_inbox_item() -> Select<Entity> {
    sigint_inbox_item::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintPost.def(),
        )
        .filter(signal_message::Column::Deleted.eq(false))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::functest::tests::{
        cleanup, mk_sigint_inbox_item, mk_signal_group, mk_signal_message,
        mk_signal_message_group,
    };
    use serial_test::serial;
    use std::sync::atomic::{AtomicUsize, Ordering};

    async fn create_post_stats_message(
        db: &DatabaseConnection,
        group_master_keys: &[&str],
        datetime: NaiveDateTime,
        post_id: i64,
        deleted: bool,
    ) {
        let message = mk_signal_message(
            db,
            signal_message::ActiveModel {
                created_at: Set(datetime),
                timestamp: Set(Some(datetime)),
                deleted: Set(deleted),
                datasource_group_id: Set(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let local_datetime =
            datetime.and_utc().with_timezone(&crate::config::get_tz());
        mk_sigint_inbox_item(
            db,
            sigint_inbox_item::ActiveModel {
                id: Set(message.id),
                date: Set(Some(local_datetime.date_naive().to_string())),
                time: Set(Some(
                    local_datetime.time().format("%H:%M:%S").to_string(),
                )),
                post_id: Set(Some(post_id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        for group_master_key in group_master_keys {
            mk_signal_message_group(
                db,
                signal_message_group::ActiveModel {
                    signal_message_id: Set(message.id),
                    group_master_key: Set(Some(
                        (*group_master_key).to_string(),
                    )),
                    datasource_group_id: Set(None),
                    created_at: Set(datetime),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        }
    }

    #[tokio::test]
    #[serial]
    async fn unfiltered_post_stats_keep_datetime_access_and_count_semantics() {
        let env = cleanup().await.unwrap();
        let dt_since = Utc::now().naive_utc() - Duration::days(1);
        let dt_till = dt_since + Duration::days(1);
        for group_master_key in [
            "post-stats-allowed-a",
            "post-stats-allowed-b",
            "post-stats-denied",
        ] {
            mk_signal_group(
                &env.dbx,
                signal_group::ActiveModel {
                    master_key: Set(group_master_key.to_string()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        }
        let post_a = sigint_post::ActiveModel {
            name: Set("post-stats-a".to_string()),
            deleted: Set(false),
            created_at: Set(dt_since),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let post_b = sigint_post::ActiveModel {
            name: Set("post-stats-b".to_string()),
            deleted: Set(false),
            created_at: Set(dt_since),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        create_post_stats_message(
            &env.dbx,
            &["post-stats-allowed-a", "post-stats-allowed-b"],
            dt_since + Duration::hours(1),
            post_a.id,
            false,
        )
        .await;
        create_post_stats_message(
            &env.dbx,
            &["post-stats-allowed-a"],
            dt_since - Duration::hours(1),
            post_a.id,
            false,
        )
        .await;
        create_post_stats_message(
            &env.dbx,
            &["post-stats-allowed-a"],
            dt_since + Duration::hours(2),
            post_a.id,
            false,
        )
        .await;
        create_post_stats_message(
            &env.dbx,
            &["post-stats-allowed-a"],
            dt_since + Duration::hours(3),
            post_b.id,
            false,
        )
        .await;
        create_post_stats_message(
            &env.dbx,
            &["post-stats-denied"],
            dt_since + Duration::hours(4),
            post_b.id,
            false,
        )
        .await;
        create_post_stats_message(
            &env.dbx,
            &["post-stats-allowed-a"],
            dt_since + Duration::hours(5),
            post_b.id,
            true,
        )
        .await;

        let mut posts = read_unfiltered_post_stats(
            &env.dbx,
            vec![
                "post-stats-allowed-a".to_string(),
                "post-stats-allowed-b".to_string(),
            ],
            dt_since,
            dt_till,
        )
        .await
        .unwrap();
        posts.sort_by(|left, right| left.post.cmp(&right.post));

        assert_eq!(
            posts
                .into_iter()
                .map(|post| (post.post, post.count))
                .collect::<Vec<_>>(),
            vec![
                ("post-stats-a".to_string(), 2),
                ("post-stats-b".to_string(), 1),
            ]
        );
    }

    #[tokio::test]
    #[serial]
    async fn callsign_frequency_matches_are_aggregated_in_the_database() {
        let env = cleanup().await.unwrap();
        let mut message_ids = Vec::new();
        for (freq, callsigns) in [
            ("123.45", serde_json::json!(["ALPHA", "BRAVO"])),
            ("123.45", serde_json::json!(["ALPHA"])),
            ("456.78", serde_json::json!(["ALPHA"])),
        ] {
            let inbox_item = mk_sigint_inbox_item(
                &env.dbx,
                sigint_inbox_item::ActiveModel {
                    freq: Set(Some(freq.to_string())),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            let actor_id =
                crate::users::system_login_id(&env.dbx).await.unwrap();
            crate::inbox::callsigns::sync(
                &env.dbx,
                inbox_item.id,
                crate::inbox::callsigns::InboxItemCallsigns {
                    primary: serde_json::from_value(callsigns).unwrap(),
                    alg2: Vec::new(),
                },
                actor_id,
            )
            .await
            .unwrap();
            message_ids.push(inbox_item.id);
        }
        let filtered_messages = sigint_inbox_item::Entity::find()
            .select_only()
            .column_as(sigint_inbox_item::Column::Id, "message_id")
            .column_as(sigint_inbox_item::Column::Freq, "freq")
            .column_as(
                Expr::cust(
                    "(select jsonb_agg(siic.callsign order by siic.ordering, siic.id) from sigint_inbox_item_callsign siic where siic.sigint_inbox_item_id = sigint_inbox_item.id and not siic.deleted)",
                ),
                "callsigns",
            )
            .filter(sigint_inbox_item::Column::Id.is_in(message_ids));
        let statement = callsign_frequency_matches_statement(
            filtered_messages,
            vec!["ALPHA".to_string(), "BRAVO".to_string()],
            2,
        );

        let rows =
            AnalysisCallsignFrequencyMatchRow::find_by_statement(statement)
                .all(&env.dbx)
                .await
                .unwrap();

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].freq, "123.45");
        assert_eq!(
            serde_json::from_value::<Vec<String>>(rows[0].callsigns.clone())
                .unwrap(),
            vec!["ALPHA", "BRAVO"]
        );
        assert_eq!(rows[0].message_count, 2);
    }

    fn populated_analysis_stats_req() -> AnalysisStatsReq {
        serde_json::from_value(serde_json::json!({
            "since_date_inclusive_ms": 1,
            "till_date_noninclusive_ms": 2,
            "selected_groups": ["group"],
            "selected_senders": ["sender"],
            "selected_freqs": ["100"],
            "selected_posts": ["post"],
            "selected_callsigns": ["callsign"],
            "selected_units": ["unit"],
            "selected_locations": ["location"],
            "selected_aors": [1],
            "selected_tags": [2],
            "denied_tags": [3],
            "tag_presence": "WithTags",
            "selected_networks": [4],
            "without_network": true,
            "units_exact_match_only": true,
            "filter_tags_option": "AllTags",
            "without_model_tags": true,
            "report_tags_only_this_unit": true
        }))
        .unwrap()
    }

    #[test]
    fn analytics_message_id_scope_uses_one_remote_aggregate() {
        let dt_since = NaiveDate::from_ymd_opt(2026, 1, 1)
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap();
        let dt_till = NaiveDate::from_ymd_opt(2026, 1, 2)
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap();
        let statement = analytics_message_id_scope_statement(dt_since, dt_till);

        assert!(statement
            .sql
            .contains("SELECT min(id) AS min_id, max(id) AS max_id"));
        assert!(!statement.sql.contains("SELECT id"));
    }

    #[tokio::test]
    async fn analytics_message_id_scope_singleflight_only_coalesces_in_flight()
    {
        let key = AnalyticsMessageIdScopeKey {
            dt_since: NaiveDate::from_ymd_opt(2099, 1, 1)
                .unwrap()
                .and_hms_opt(0, 0, 0)
                .unwrap(),
            dt_till: NaiveDate::from_ymd_opt(2099, 1, 2)
                .unwrap()
                .and_hms_opt(0, 0, 0)
                .unwrap(),
            freshness_max_age_ms: 1,
        };
        let calls = Arc::new(AtomicUsize::new(0));
        let first_calls = calls.clone();
        let second_calls = calls.clone();
        let first = resolve_analytics_message_id_scope_singleflight(
            key,
            move || async move {
                first_calls.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(core::time::Duration::from_millis(20)).await;
                Ok(AnalyticsMessageIdScope::From(7))
            },
        );
        let second = resolve_analytics_message_id_scope_singleflight(
            key,
            move || async move {
                second_calls.fetch_add(1, Ordering::SeqCst);
                Ok(AnalyticsMessageIdScope::From(7))
            },
        );

        let (first, second) = tokio::join!(first, second);
        assert_eq!(first.unwrap(), AnalyticsMessageIdScope::From(7));
        assert_eq!(second.unwrap(), AnalyticsMessageIdScope::From(7));
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        let third_calls = calls.clone();
        let third = resolve_analytics_message_id_scope_singleflight(
            key,
            move || async move {
                third_calls.fetch_add(1, Ordering::SeqCst);
                Ok(AnalyticsMessageIdScope::From(9))
            },
        )
        .await
        .unwrap();
        assert_eq!(third, AnalyticsMessageIdScope::From(9));
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    fn assert_bounded_analytics_access(name: &str, sql: &str) {
        assert!(
            sql.contains(r#""sigint_inbox_item"."id" BETWEEN 10 AND 20"#),
            "{name}: {sql}"
        );
        assert!(
            sql.contains(r#""signal_message"."id" BETWEEN 10 AND 20"#),
            "{name}: {sql}"
        );
        assert!(
            sql.contains(
                r#""analytics_message_access"."signal_message_id" BETWEEN 10 AND 20"#
            ),
            "{name}: {sql}"
        );
        assert!(
            sql.contains(r#"AS "analytics_message_access""#),
            "{name}: {sql}"
        );
        assert!(
            sql.contains(
                r#"JOIN "signal_message_group" AS "analytics_message_access""#
            ),
            "{name}: {sql}"
        );
        assert!(!sql.contains(r#"JOIN (SELECT "signal_message_group""#));
        assert!(
            sql.contains(
                r#""analytics_message_access"."sender" IN ('sender')"#
            ),
            "{name}: {sql}"
        );
        assert!(
            sql.contains(
                r#""analytics_network_filter_link"."sigint_inbox_item_id" BETWEEN 10 AND 20"#
            ),
            "{name}: {sql}"
        );
        assert!(
            sql.contains(
                r#""sigint_inbox_item_tag"."sigint_inbox_item_id" BETWEEN 10 AND 20"#
            ),
            "{name}: {sql}"
        );
    }

    #[test]
    fn analytical_facets_use_one_bounded_flat_message_access_join() {
        let mut req = populated_analysis_stats_req();
        req.selected_units = None;
        req.units_exact_match_only = None;
        req.without_network = Some(false);
        let req_json = Json(req.clone());
        let req_ref = &req_json;
        let login_id = uuid::Uuid::nil();
        let dt_since = NaiveDate::from_ymd_opt(2026, 1, 1)
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap();
        let dt_till = NaiveDate::from_ymd_opt(2026, 1, 2)
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap();
        let scope = AnalyticsMessageIdScope::Inclusive {
            min_id: 10,
            max_id: 20,
        };
        let master_keys = vec!["group".to_string()];

        let queries = [
            (
                "posts",
                build_posts_query(
                    &req_ref,
                    &login_id,
                    master_keys.clone(),
                    dt_since,
                    dt_till,
                    Some(&scope),
                )
                .unwrap()
                .build(DbBackend::Postgres)
                .to_string(),
            ),
            (
                "frequencies",
                build_freqs_query(
                    &req,
                    &login_id,
                    dt_since,
                    dt_till,
                    master_keys.clone(),
                    Some(&scope),
                )
                .unwrap()
                .build(DbBackend::Postgres)
                .to_string(),
            ),
            ("callsigns", {
                let query = build_callsigns_filtered_query(
                    &req,
                    &login_id,
                    dt_since,
                    dt_till,
                    master_keys.clone(),
                    Some(&scope),
                )
                .unwrap();
                join_analytics_callsign_relation(query, Some(&scope))
                    .0
                    .build(DbBackend::Postgres)
                    .to_string()
            }),
            (
                "tags",
                build_tags_analytics_filtered_query_with_scope(
                    &req,
                    &login_id,
                    &[2, 3],
                    &[],
                    dt_since,
                    dt_till,
                    master_keys.clone(),
                    Some(&scope),
                )
                .unwrap()
                .build(DbBackend::Postgres)
                .to_string(),
            ),
            (
                "units",
                build_units_query(
                    &req_ref,
                    &login_id,
                    dt_since,
                    dt_till,
                    master_keys.clone(),
                    Some(&scope),
                )
                .unwrap()
                .build(DbBackend::Postgres)
                .to_string(),
            ),
            (
                "locations",
                build_locations_query_for_login(
                    &req,
                    &login_id,
                    dt_since,
                    dt_till,
                    master_keys,
                    Some(&scope),
                )
                .unwrap()
                .build(DbBackend::Postgres)
                .to_string(),
            ),
        ];

        for (name, sql) in queries {
            assert_bounded_analytics_access(name, &sql);
            if name == "callsigns" {
                assert!(
                    sql.contains(
                        r#""analytics_callsign"."sigint_inbox_item_id" BETWEEN 10 AND 20"#
                    ),
                    "{name}: {sql}"
                );
            }
        }
    }

    #[test]
    fn analytics_aor_facet_uses_bounded_message_ordered_bridge() {
        let req = populated_analysis_stats_req();
        let scope = AnalyticsMessageIdScope::Inclusive {
            min_id: 10,
            max_id: 20,
        };
        let sql = build_aors_analytics_query_with_scope(
            &req,
            &uuid::Uuid::nil(),
            NaiveDate::from_ymd_opt(2026, 1, 1)
                .unwrap()
                .and_hms_opt(0, 0, 0)
                .unwrap(),
            NaiveDate::from_ymd_opt(2026, 1, 2)
                .unwrap()
                .and_hms_opt(0, 0, 0)
                .unwrap(),
            vec!["group".to_string()],
            Some(&scope),
        )
        .unwrap()
        .sql;

        assert!(sql.contains(r#""echo_clickhouse_derived"."message_aor_link""#));
        assert!(
            sql.contains(
                r#""analytics_aor_message_link"."sigint_inbox_item_id" BETWEEN 10 AND 20"#
            ),
            "{sql}"
        );
        assert!(
            sql.contains(r#""sigint_inbox_item"."id" BETWEEN 10 AND 20"#),
            "{sql}"
        );
        assert!(
            sql.contains(r#""signal_message"."id" BETWEEN 10 AND 20"#),
            "{sql}"
        );
        assert!(!sql.contains("UNION ALL"), "{sql}");
    }

    #[test]
    fn facet_requests_remove_the_whole_own_filter_family() {
        let req = populated_analysis_stats_req();

        assert!(request_without_facet_filter(&req, AnalysisFacet::Groups)
            .selected_groups
            .is_none());
        assert!(request_without_facet_filter(&req, AnalysisFacet::Senders)
            .selected_senders
            .is_none());
        assert!(
            request_without_facet_filter(&req, AnalysisFacet::Frequencies)
                .selected_freqs
                .is_none()
        );
        assert!(request_without_facet_filter(&req, AnalysisFacet::Posts)
            .selected_posts
            .is_none());
        assert!(request_without_facet_filter(&req, AnalysisFacet::Callsigns)
            .selected_callsigns
            .is_none());
        let units = request_without_facet_filter(&req, AnalysisFacet::Units);
        assert!(units.selected_units.is_none());
        assert!(units.units_exact_match_only.is_none());
        assert!(request_without_facet_filter(&req, AnalysisFacet::Locations)
            .selected_locations
            .is_none());
        assert!(request_without_facet_filter(&req, AnalysisFacet::Aors)
            .selected_aors
            .is_none());
        let networks =
            request_without_facet_filter(&req, AnalysisFacet::Networks);
        assert!(networks.selected_networks.is_none());
        assert!(networks.without_network.is_none());
        let tags = request_without_facet_filter(&req, AnalysisFacet::Tags);
        assert!(tags.selected_tags.is_none());
        assert!(tags.denied_tags.is_none());
        assert!(tags.tag_presence.is_none());
        assert!(tags.filter_tags_option.is_none());
        assert!(tags.without_model_tags.is_none());
        assert!(tags.report_tags_only_this_unit.is_none());
        assert_eq!(tags.selected_groups, req.selected_groups);
    }

    #[test]
    fn callsign_frequency_search_replaces_callsign_and_frequency_facets() {
        let req = populated_analysis_stats_req();
        let search_req = callsign_frequency_match_search_req(&req);

        assert!(search_req.selected_freqs.is_none());
        assert!(search_req.selected_callsigns.is_none());
        assert_eq!(search_req.selected_groups, req.selected_groups);
    }

    #[test]
    fn analytics_aor_filter_uses_bounded_derived_message_ids() {
        let scope = AnalyticsMessageIdScope::Inclusive {
            min_id: 10,
            max_id: 20,
        };
        let query = filter_selected_aors_for_scope(
            sigint_inbox_item::Entity::find(),
            &Some(vec![5]),
            Some(&scope),
        )
        .unwrap()
        .build(DbBackend::Postgres)
        .to_string();

        assert!(
            query.contains(r#""echo_clickhouse_derived"."message_aor_link""#),
            "{query}"
        );
        assert!(
            query.contains(
                r#""analytics_message_aor_link"."sigint_inbox_item_id" BETWEEN 10 AND 20"#
            ),
            "{query}"
        );
        assert!(query.contains("SELECT DISTINCT"), "{query}");
        assert!(!query.contains("group_aor_filter"), "{query}");
        assert!(!query.contains("inbox_network_aor_filter"), "{query}");
    }

    #[test]
    fn analytics_without_network_filter_bounds_message_links() {
        let scope = AnalyticsMessageIdScope::Inclusive {
            min_id: 10,
            max_id: 20,
        };
        let query = filter_selected_networks_for_scope(
            sigint_inbox_item::Entity::find(),
            &None,
            &Some(true),
            Some(&scope),
        )
        .unwrap()
        .build(DbBackend::Postgres)
        .to_string();

        assert!(
            query.contains(
                r#""network_filter"."sigint_inbox_item_id" BETWEEN 10 AND 20"#
            ),
            "{query}"
        );
    }

    #[test]
    fn distinct_count_query_aggregates_without_grouping() {
        let query = build_distinct_count_query(
            sigint_inbox_item::Entity::find(),
            Expr::col(sigint_inbox_item::Column::Freq),
        )
        .build(DbBackend::Postgres)
        .to_string();

        assert!(query.contains("COUNT(DISTINCT"));
        assert!(query.contains(r#""freq""#));
        assert!(!query.contains("GROUP BY"));
    }

    #[test]
    fn analytics_message_id_scope_bounds_fact_and_message_tables() {
        let scope = AnalyticsMessageIdScope::Inclusive {
            min_id: 10,
            max_id: 20,
        };
        let query = apply_analytics_message_id_scope(
            sigint_inbox_item::Entity::find().join(
                JoinType::InnerJoin,
                sigint_inbox_item::Relation::SignalMessage.def(),
            ),
            Some(&scope),
        )
        .build(DbBackend::Postgres)
        .to_string();

        assert!(query.contains(r#""sigint_inbox_item"."id" BETWEEN 10 AND 20"#));
        assert!(query.contains(r#""signal_message"."id" BETWEEN 10 AND 20"#));
    }

    #[test]
    fn analytics_message_id_scope_bounds_group_access_subquery() {
        let scope = AnalyticsMessageIdScope::Inclusive {
            min_id: 10,
            max_id: 20,
        };
        let query = signal_message::Entity::find()
            .filter(message_in_groups_exists_with_scope(
                vec!["group".to_string()],
                Some(&scope),
            ))
            .build(DbBackend::Postgres)
            .to_string();

        assert!(query.contains(
            r#""signal_message_group"."signal_message_id" BETWEEN 10 AND 20"#
        ));
    }

    #[test]
    fn empty_analytics_message_id_scope_rejects_rows() {
        let query = apply_analytics_message_id_scope(
            sigint_inbox_item::Entity::find(),
            Some(&AnalyticsMessageIdScope::Empty),
        )
        .build(DbBackend::Postgres)
        .to_string();

        assert!(query.contains("FALSE"), "{query}");
    }

    #[test]
    fn analytics_new_freqs_query_bounds_both_periods_by_message_id() {
        let scopes = AnalyticsFrequencyScopes {
            current: AnalyticsMessageIdScope::From(100),
            comparison: AnalyticsMessageIdScope::Inclusive {
                min_id: 10,
                max_id: 99,
            },
        };
        let query = build_new_freqs_query(
            NaiveDate::from_ymd_opt(2026, 1, 11)
                .unwrap()
                .and_hms_opt(0, 0, 0)
                .unwrap(),
            NaiveDate::from_ymd_opt(2026, 1, 12)
                .unwrap()
                .and_hms_opt(0, 0, 0)
                .unwrap(),
            Some(&scopes),
        )
        .unwrap()
        .build(DbBackend::Postgres)
        .to_string();

        assert!(
            query.contains(r#""sigint_inbox_item"."id" >= 100"#),
            "{query}"
        );
        assert!(
            query.contains(r#""sigint_inbox_item"."id" BETWEEN 10 AND 99"#),
            "{query}"
        );
        assert!(query.contains("GROUP BY"), "{query}");
        assert!(query.contains("HAVING COUNT(*) FILTER"), "{query}");
        assert!(!query.contains("NOT IN"), "{query}");
    }
}
