use crate::rer_importer::types::SenderFrequencyBreakdown;
use crate::types::ShortContext;
use crate::types::{debug, warn};
use crate::users::login_id_from_identity;
use actix_identity::Identity;
use actix_web::web::Json;
use chrono::{Duration, Utc};
use echo_migration::{Expr, JoinType};
use sea_orm::sea_query::{Order, SelectStatement, SimpleExpr, UnionType};
use sea_orm::FromQueryResult;
use sea_orm::*;
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::error::Error as StdError;

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
pub(super) struct AnalyticsTagAccess {
    pub(super) accessible_tag_ids: Vec<i64>,
    pub(super) unit_login_ids: Vec<uuid::Uuid>,
}

pub(super) async fn resolve_analytics_tag_access(
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
    #[derive(FromQueryResult)]
    struct MessageIdBounds {
        min_id: Option<i64>,
        max_id: Option<i64>,
    }

    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let bounds = sigint_inbox_item::Entity::find()
        .select_only()
        .column_as(sigint_inbox_item::Column::Id.min(), "min_id")
        .column_as(sigint_inbox_item::Column::Id.max(), "max_id")
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till))
        .into_model::<MessageIdBounds>()
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

    if should_read_stats_aggregated(&req_json, env, dt_since, dt_till)
        .c(h!())?
    {
        let result = read_group_stats_aggregated(
            &env.dbx,
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

fn apply_message_aor_scope<E>(
    query: Select<E>,
    selected_aors: &Option<Vec<i64>>,
) -> Select<E>
where
    E: EntityTrait,
{
    match selected_aors_filter_condition(selected_aors) {
        Some(condition) => query.filter(condition),
        None => query,
    }
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

fn build_groups_query(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
    let include_peleng_locations =
        req.include_peleng_locations.unwrap_or(false);
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
    let groups_res = apply_analytics_message_id_scope(groups_res, scope);
    let groups_res = apply_analytics_group_message_id_scope(groups_res, scope);
    let groups_res = apply_joined_group_rows_filter(
        groups_res,
        &None,
        &req.selected_senders,
        &accessible_groups,
    );
    let groups_res =
        filter_selected_freqs(groups_res, &req.selected_freqs).context(h!())?;
    let groups_res =
        filter_selected_posts(groups_res, &req.selected_posts).context(h!())?;
    let groups_res = filter_selected_units(
        groups_res,
        &req.selected_units,
        &req.units_exact_match_only,
    )
    .context(h!())?;
    let groups_res = filter_selected_locations(
        groups_res,
        &req.selected_locations,
        include_peleng_locations,
    )
    .context(h!())?;
    let groups_res =
        filter_selected_callsigns(groups_res, &req.selected_callsigns)
            .context(h!())?;
    let groups_res = filter_selected_networks(
        groups_res,
        &req.selected_networks,
        &req.without_network,
    )
    .context(h!())?;
    let groups_res = apply_metadata_filters(groups_res, req)?;
    let groups_res = filter_search(groups_res, &req.search).context(h!())?;
    let groups_res =
        filter_selected_aors(groups_res, &req.selected_aors).context(h!())?;
    let groups_res =
        match selected_aor_group_facet_condition(&req.selected_aors) {
            Some(condition) => groups_res.filter(condition),
            None => groups_res,
        };
    let groups_res = filter_selected_tags(
        groups_res,
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
    Ok(groups_res)
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

    if should_read_stats_aggregated(&req, env, dt_since, dt_till).c(h!())? {
        let result =
            read_sender_stats_aggregated(env, master_keys, dt_since, dt_till)
                .await
                .c(h!())?;
        return Ok(result);
    }

    fetch_senders_for_login_with_db(&req, login_str, env, &env.dbx, master_keys)
        .await
}

pub(super) async fn fetch_senders_raw_with_db(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &Env,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsSender>, AppError> {
    let login_value = login_id_from_identity(user)?;
    fetch_senders_for_login_with_db(req, &login_value, env, db, master_keys)
        .await
}

async fn fetch_senders_for_login_with_db(
    req: &Json<AnalysisStatsReq>,
    login_str: &uuid::Uuid,
    env: &Env,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
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
    let sender_stats_groups = sender_stats_groups(req, &master_keys);
    let per_day_expr = Expr::cust_with_exprs(
        "to_char(($1 AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Kyiv')::date, 'DD.MM.YYYY')",
        [Expr::col(sigint_inbox_item::Column::Datetime).into_simple_expr()],
    );
    let breakdown_query = build_join_for_sender_stats(
        &sender_stats_groups,
        &req.selected_aors,
        None,
    )
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
    let breakdown_query = apply_sender_dimension_filters(breakdown_query, req);
    let breakdown_query = apply_sender_filters_for_login(
        breakdown_query,
        req,
        login_str,
        master_keys,
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
        ))
        .into(),
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
    let include_peleng_locations =
        req.include_peleng_locations.unwrap_or(false);
    let sender_stats_groups = sender_stats_groups(req, &master_keys);
    let senders_res = build_join_for_sender_stats(
        &sender_stats_groups,
        &req.selected_aors,
        scope,
    )
    // .filter(signal_message::Column::DuplicateOf.is_null())
    .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
    .filter(sigint_inbox_item::Column::Datetime.lt(dt_till));
    let senders_res = apply_sender_dimension_filters(senders_res, req);
    let senders_res = filter_selected_groups_and_senders_with_access(
        senders_res,
        &req.selected_groups,
        &req.selected_senders,
        &master_keys,
    )
    .context(h!())?;
    let senders_res = filter_selected_freqs(senders_res, &req.selected_freqs)
        .context(h!())?;
    let senders_res = filter_selected_posts(senders_res, &req.selected_posts)
        .context(h!())?;
    let senders_res = filter_selected_units(
        senders_res,
        &req.selected_units,
        &req.units_exact_match_only,
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
    let senders_res = filter_selected_tags(
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
    )
    .context(h!())?;
    let senders_res = filter_selected_networks(
        senders_res,
        &req.selected_networks,
        &req.without_network,
    )
    .context(h!())?;
    let senders_res = apply_metadata_filters(senders_res, &req.0)?;
    let senders_res = filter_search(senders_res, &req.search).context(h!())?;
    Ok(senders_res)
}

fn sender_stats_groups(
    req: &Json<AnalysisStatsReq>,
    master_keys: &[String],
) -> Vec<String> {
    effective_groups_with_access(&req.selected_groups, master_keys)
}

fn build_join_for_sender_stats(
    sender_stats_groups: &[String],
    selected_aors: &Option<Vec<i64>>,
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
        let query = query.filter(
            signal_message_group::Column::GroupMasterKey
                .eq_any(sender_stats_groups),
        );
        apply_message_aor_scope(query, selected_aors)
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
    login_str: &uuid::Uuid,
    master_keys: Vec<String>,
) -> Result<Select<E>, AppError>
where
    E: EntityTrait,
{
    let include_peleng_locations =
        req.include_peleng_locations.unwrap_or(false);
    let query = filter_selected_groups_and_senders_with_access(
        query,
        &req.selected_groups,
        &req.selected_senders,
        &master_keys,
    )
    .context(h!())?;
    let query =
        filter_selected_freqs(query, &req.selected_freqs).context(h!())?;
    let query =
        filter_selected_posts(query, &req.selected_posts).context(h!())?;
    let query = filter_selected_units(
        query,
        &req.selected_units,
        &req.units_exact_match_only,
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
    let query = filter_selected_tags(
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
    )
    .context(h!())?;
    let query = filter_selected_networks(
        query,
        &req.selected_networks,
        &req.without_network,
    )
    .context(h!())?;
    let query = apply_metadata_filters(query, &req.0)?;
    let query = filter_search(query, &req.search).context(h!())?;
    let query =
        filter_selected_aors(query, &req.selected_aors).context(h!())?;
    if !master_keys.is_empty() {
        return Ok(query.filter(message_in_groups_exists(master_keys)));
    }
    Ok(query)
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

    if should_read_stats_aggregated(req, env, dt_since, dt_till).c(h!())? {
        let result =
            read_post_stats_aggregated(env, master_keys, dt_since, dt_till)
                .await
                .c(h!())?;
        return Ok(result);
    }

    fetch_posts_with_db(req, user, &env.dbx, master_keys).await
}

pub(super) async fn fetch_posts_raw_with_db(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsPost>, AppError> {
    fetch_posts_with_db(req, user, db, master_keys).await
}

async fn fetch_posts_with_db(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsPost>, AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let instant = std::time::Instant::now();
    let post_res =
        build_posts_query(&req, &user, master_keys, dt_since, dt_till, None)?;
    let post_res: Vec<PostsRes> = post_res
        .into_model::<PostsRes>()
        .all(db)
        .await
        .context(h!())?;
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
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;

    let instant = std::time::Instant::now();
    trace!("get identity master keys op took: {:?}", instant.elapsed());
    let posts_res = build_posts_filtered_query(
        &req,
        &user,
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
    user: &&Identity,
    master_keys: Vec<String>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
    Ok(build_posts_filtered_query(
        req,
        user,
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
    user: &&Identity,
    master_keys: Vec<String>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
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
        .filter(message_in_groups_exists_with_scope(
            master_keys.clone(),
            scope,
        ))
        .filter(signal_message::Column::Deleted.eq(false))
        // .filter(signal_message::Column::DuplicateOf.is_null())
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till));
    let post_res = apply_analytics_message_id_scope(post_res, scope);
    let post_res = filter_selected_groups_and_senders_with_access(
        post_res,
        &req.selected_groups,
        &req.selected_senders,
        &master_keys,
    )
    .context(h!())?;
    let post_res = filter_selected_units(
        post_res,
        &req.selected_units,
        &req.units_exact_match_only,
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
    let post_res = filter_selected_tags(
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
        &login_id_from_identity(user)?,
        req.report_tags_only_this_unit.unwrap_or(false),
    )
    .context(h!())?;
    let post_res = filter_selected_networks(
        post_res,
        &req.selected_networks,
        &req.without_network,
    )
    .context(h!())?;
    let post_res = apply_metadata_filters(post_res, &req.0)?;
    let post_res = filter_search(post_res, &req.search).context(h!())?;
    let post_res =
        filter_selected_aors(post_res, &req.selected_aors).context(h!())?;
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

    if should_read_stats_aggregated(&req_json, env, dt_since, dt_till)
        .c(h!())?
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

    fetch_freqs_for_login_with_db(req, login_str, &env.dbx, master_keys).await
}

pub(super) async fn fetch_freqs_raw_with_db(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsFreq>, AppError> {
    let login_value = login_id_from_identity(user)?;
    fetch_freqs_for_login_with_db(&req.0, &login_value, db, master_keys).await
}

async fn fetch_freqs_for_login_with_db(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
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
        None,
    )?;
    // debug!(
    //     "> freqs_res: {}",
    //     freqs_res.build(DbBackend::Postgres).to_string()
    // );

    let new_freqs = get_new_freqs(db, dt_since, dt_till).await.context(h!())?;
    let freqs = freqs_res
        .into_model::<FreqsRes>()
        .all(db)
        .await
        .context(h!())?
        .into_iter()
        .map(|f| AnalysisStatsFreq {
            is_new: new_freqs.contains(&f.freq),
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
    const COMPARISON_PERIOD_DAYS: u8 = 10;
    let comparison_period_start = dt_since
        - Duration::try_days(COMPARISON_PERIOD_DAYS.into())
            .context(h!())
            .map_err(Into::<AppError>::into)?;

    let date_time_col = sigint_inbox_item::Column::Datetime;
    let query = sigint_inbox_item::Entity::find()
        .select_only()
        .column(sigint_inbox_item::Column::Freq)
        .distinct()
        .filter(sigint_inbox_item::Column::Freq.is_not_null())
        .filter(date_time_col.gte(dt_since))
        .filter(date_time_col.lte(dt_till))
        .filter(
            sigint_inbox_item::Column::Freq.not_in_subquery(
                Query::select()
                    .column(sigint_inbox_item::Column::Freq)
                    .distinct()
                    .and_where(sigint_inbox_item::Column::Freq.is_not_null())
                    .and_where(date_time_col.lt(dt_since))
                    .and_where(date_time_col.gt(comparison_period_start))
                    .from(sigint_inbox_item::Entity)
                    .to_owned(),
            ),
        )
        .order_by_asc(sigint_inbox_item::Column::Freq);

    trace!(
        "> get_new_freqs query: {}",
        query.build(DbBackend::Postgres)
    );

    let new_freqs = query.into_tuple::<String>().all(db).await.context(h!())?;

    Ok(new_freqs)
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

fn build_freqs_query(
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
        .filter(message_in_groups_exists_with_scope(
            master_keys.clone(),
            scope,
        ))
        .filter(signal_message::Column::Deleted.eq(false))
        // .filter(signal_message::Column::DuplicateOf.is_null())
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till));
    let freqs_res = apply_analytics_message_id_scope(freqs_res, scope);
    let freqs_res = filter_selected_groups_and_senders_with_access(
        freqs_res,
        &req.selected_groups,
        &req.selected_senders,
        &master_keys,
    )
    .context(h!())?;
    let freqs_res = filter_selected_units(
        freqs_res,
        &req.selected_units,
        &req.units_exact_match_only,
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
    let freqs_res = filter_selected_tags(
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
    )
    .context(h!())?;
    let freqs_res = filter_selected_networks(
        freqs_res,
        &req.selected_networks,
        &req.without_network,
    )
    .context(h!())?;
    let freqs_res = apply_metadata_filters(freqs_res, req)?;
    let freqs_res = filter_search(freqs_res, &req.search).context(h!())?;
    let freqs_res =
        filter_selected_aors(freqs_res, &req.selected_aors).context(h!())?;
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

    if should_read_stats_aggregated(&req, env, dt_since, dt_till).c(h!())? {
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
    let callsigns_res =
        build_callsigns_query(req, login_str, dt_since, dt_till, master_keys)?;
    // println!(
    //     "> callsigns_res: {}",
    //     callsigns_res.build(DbBackend::Postgres).to_string()
    // );
    let callsigns_res: Vec<CallsignsRes> = callsigns_res
        .into_model::<CallsignsRes>()
        .all(db)
        .await
        .c(h!())?;
    let mut callsigns = vec![];
    for x in callsigns_res {
        let Some(callsign) = x.callsign else { continue };
        callsigns.push(AnalysisStatsCallsign {
            callsign,
            count: x.count,
        });
    }

    debug!("callsigns op took: {:?}", instant.elapsed());
    Ok(callsigns)
}

pub(super) async fn fetch_callsigns_raw_with_db(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsCallsign>, AppError> {
    let login_value = login_id_from_identity(user)?;
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let mut callsigns_res = build_callsigns_filtered_query(
        &req.0,
        &login_value,
        dt_since,
        dt_till,
        master_keys,
        None,
    )?;
    let callsign_alias = Alias::new("analytics_callsign");
    QuerySelect::query(&mut callsigns_res)
        .join_as(
            JoinType::InnerJoin,
            (
                Alias::new("echo_clickhouse_derived"),
                Alias::new("message_callsign"),
            ),
            callsign_alias.clone(),
            Expr::col((
                callsign_alias.clone(),
                Alias::new("sigint_inbox_item_id"),
            ))
            .equals((sigint_inbox_item::Entity, sigint_inbox_item::Column::Id)),
        )
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
    let groups_res = build_callsigns_query(
        &req.0,
        &login_value,
        dt_since,
        dt_till,
        master_keys,
    )?;
    let count = groups_res.count(db).await.context(h!())?;
    Ok(count as i64)
}

pub(super) async fn count_callsigns_analytics_with_db(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<i64, AppError> {
    let login_value = login_id_from_identity(user)?;
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let mut callsigns_res = build_callsigns_filtered_query(
        &req.0,
        &login_value,
        dt_since,
        dt_till,
        master_keys,
        scope,
    )?;
    let callsign_alias = Alias::new("analytics_callsign");
    QuerySelect::query(&mut callsigns_res)
        .join_as(
            JoinType::InnerJoin,
            (
                Alias::new("echo_clickhouse_derived"),
                Alias::new("message_callsign"),
            ),
            callsign_alias.clone(),
            Expr::col((
                callsign_alias.clone(),
                Alias::new("sigint_inbox_item_id"),
            ))
            .equals((sigint_inbox_item::Entity, sigint_inbox_item::Column::Id)),
        )
        .clear_selects()
        .expr_as(
            Expr::cust_with_expr(
                "COUNT(DISTINCT $1)",
                Expr::col((callsign_alias.clone(), Alias::new("callsign"))),
            ),
            Alias::new("count"),
        );
    if let Some(scope) = scope {
        QuerySelect::query(&mut callsigns_res).cond_where(
            scope.condition((
                callsign_alias,
                Alias::new("sigint_inbox_item_id"),
            )),
        );
    }
    let result = callsigns_res
        .into_model::<DistinctCountRes>()
        .one(db)
        .await
        .context(h!())?
        .unwrap_or(DistinctCountRes { count: 0 });
    Ok(result.count)
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
    apply_sender_filters_for_login(messages_q, req, login_str, master_keys)
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

fn build_callsigns_query(
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
    .column_as(
        Expr::cust("jsonb_array_elements_text(callsigns)"),
        "callsign",
    )
    .column_as(
        Expr::cust(r#"COUNT(DISTINCT "signal_message"."id")"#),
        "count",
    )
    .group_by(SimpleExpr::Custom("callsign".to_string())))
}

fn build_callsigns_filtered_query(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
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
        .filter(message_in_groups_exists_with_scope(
            master_keys.clone(),
            scope,
        ))
        .filter(signal_message::Column::Deleted.eq(false))
        // .filter(signal_message::Column::DuplicateOf.is_null())
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till));
    let callsigns_res = apply_analytics_message_id_scope(callsigns_res, scope);
    let callsigns_res = filter_selected_groups_and_senders_with_access(
        callsigns_res,
        &req.selected_groups,
        &req.selected_senders,
        &master_keys,
    )?;
    let callsigns_res =
        filter_selected_freqs(callsigns_res, &req.selected_freqs)?;
    let callsigns_res =
        filter_selected_posts(callsigns_res, &req.selected_posts)?;
    let callsigns_res = filter_selected_units(
        callsigns_res,
        &req.selected_units,
        &req.units_exact_match_only,
    )?;
    let callsigns_res = filter_selected_locations(
        callsigns_res,
        &req.selected_locations,
        include_peleng_locations,
    )?;
    let callsigns_res = filter_selected_tags(
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
    )
    .context(h!())?;
    let callsigns_res = filter_selected_networks(
        callsigns_res,
        &req.selected_networks,
        &req.without_network,
    )
    .context(h!())?;
    let callsigns_res = apply_metadata_filters(callsigns_res, req)?;
    let callsigns_res = filter_search(callsigns_res, &req.search)?;
    let callsigns_res = filter_selected_aors(callsigns_res, &req.selected_aors)
        .context(h!())?;
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

    if req.without_model_tags != Some(true)
        && should_read_stats_aggregated(&req, env, dt_since, dt_till).c(h!())?
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

    fetch_tags_for_login_with_db(&req.0, login_str, &env.dbx, master_keys, None)
        .await
}

async fn fetch_tags_for_login_with_db(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
    tag_access: Option<&AnalyticsTagAccess>,
) -> Result<Vec<AnalysisStatsTag>, AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let instant = std::time::Instant::now();
    let tags_res = if let Some(tag_access) = tag_access {
        build_tags_analytics_filtered_query(
            req,
            login_str,
            &tag_access.accessible_tag_ids,
            &tag_access.unit_login_ids,
            dt_since,
            dt_till,
            master_keys,
        )?
        .select_only()
        .column(sigint_inbox_item_tag::Column::TagId)
        .column_as(Expr::count(Expr::val(1)), "count")
        .group_by(sigint_inbox_item_tag::Column::TagId)
    } else {
        build_tags_query(req, login_str, dt_since, dt_till, master_keys)?
    };

    let tags_res: Vec<TagsRes> =
        tags_res.into_model::<TagsRes>().all(db).await.c(h!())?;

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
) -> Result<Vec<AnalysisStatsTag>, AppError> {
    let login_value = login_id_from_identity(user)?;
    fetch_tags_for_login_with_db(
        &req.0,
        &login_value,
        db,
        master_keys,
        Some(tag_access),
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
    let tags_res = build_tags_filtered_query(
        &req.0,
        &login_value,
        dt_since,
        dt_till,
        master_keys,
    )?;
    count_distinct_with_db(
        tags_res,
        Expr::col(sigint_inbox_item_tag::Column::TagId).into(),
        db,
    )
    .await
}

pub(super) async fn count_tags_analytics_with_db(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
    tag_access: &AnalyticsTagAccess,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<i64, AppError> {
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

fn build_tags_query(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
    Ok(build_tags_filtered_query(
        req,
        login_str,
        dt_since,
        dt_till,
        master_keys,
    )?
    .select_only()
    .column(sigint_inbox_item_tag::Column::TagId)
    .column_as(Expr::count(Expr::val(1)), "count")
    .group_by(sigint_inbox_item_tag::Column::TagId))
}

fn build_tags_filtered_query(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
    build_tags_filtered_query_with_owner_condition(
        req,
        login_str,
        accessible_tag_owner_condition(login_str),
        None,
        dt_since,
        dt_till,
        master_keys,
        None,
    )
}

pub(super) fn build_tags_analytics_filtered_query(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    accessible_tag_ids: &[i64],
    unit_login_ids: &[uuid::Uuid],
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
    build_tags_filtered_query_with_owner_condition(
        req,
        login_str,
        accessible_tag_ids_condition(accessible_tag_ids),
        Some((accessible_tag_ids, unit_login_ids)),
        dt_since,
        dt_till,
        master_keys,
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
        )?,
        Expr::col(sigint_inbox_item_tag::Column::TagId).into(),
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
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
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
        )
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
        .filter(owner_condition)
        .filter(message_in_groups_exists_with_scope(
            master_keys.clone(),
            scope,
        ))
        .filter(signal_message::Column::Deleted.eq(false))
        // .filter(signal_message::Column::DuplicateOf.is_null())
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till));
    tags_res = apply_analytics_message_id_scope(tags_res, scope);
    if let Some(scope) = scope {
        tags_res = tags_res.filter(scope.condition((
            sigint_inbox_item_tag::Entity,
            sigint_inbox_item_tag::Column::SigintInboxItemId,
        )));
    }
    // .filter(sigint_inbox_item::Column::Checked.eq(Some(true)))
    if req.without_model_tags == Some(true) {
        tags_res =
            tags_res.filter(sigint_inbox_item_tag::Column::Model.is_null());
    }
    let tags_res = filter_selected_groups_and_senders_with_access(
        tags_res,
        &req.selected_groups,
        &req.selected_senders,
        &master_keys,
    )?;
    let tags_res = filter_selected_freqs(tags_res, &req.selected_freqs)?;
    let tags_res = filter_selected_posts(tags_res, &req.selected_posts)?;
    let tags_res = filter_selected_units(
        tags_res,
        &req.selected_units,
        &req.units_exact_match_only,
    )?;
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
        )?
    } else {
        filter_selected_tags(
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
        )?
    };
    let tags_res = filter_selected_networks(
        tags_res,
        &req.selected_networks,
        &req.without_network,
    )
    .context(h!())?;
    let tags_res = apply_metadata_filters(tags_res, req)?;
    let tags_res = filter_search(tags_res, &req.search)?;
    let tags_res =
        filter_selected_aors(tags_res, &req.selected_aors).context(h!())?;
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

    if should_read_stats_aggregated(req, env, dt_since, dt_till).c(h!())? {
        let result =
            read_unit_stats_aggregated(env, master_keys, dt_since, dt_till)
                .await
                .c(h!())?;
        return Ok(result);
    }

    fetch_units_with_db(req, user, &env.dbx, master_keys).await
}

pub(super) async fn fetch_units_raw_with_db(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsUnit>, AppError> {
    fetch_units_with_db(req, user, db, master_keys).await
}

async fn fetch_units_with_db(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsUnit>, AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let instant = std::time::Instant::now();
    let units_res =
        build_units_query(&req, &user, dt_since, dt_till, master_keys, None)?;
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
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;

    let instant = std::time::Instant::now();
    trace!("get identity master keys op took: {:?}", instant.elapsed());
    let units_res = build_units_filtered_query(
        &req,
        &user,
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
        (total_matches_count - exact_matches_count).max(0);

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
        (total_matches_count - exact_matches_count).max(0),
    ))
}

fn build_units_query(
    req: &&Json<AnalysisStatsReq>,
    user: &&Identity,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
    Ok(build_units_filtered_query(
        req,
        user,
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
    user: &&Identity,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
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
        .filter(message_in_groups_exists_with_scope(
            master_keys.clone(),
            scope,
        ))
        .filter(signal_message::Column::Deleted.eq(false))
        // .filter(signal_message::Column::DuplicateOf.is_null())
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till));
    let units_res = apply_analytics_message_id_scope(units_res, scope);
    let units_res = filter_selected_groups_and_senders_with_access(
        units_res,
        &req.selected_groups,
        &req.selected_senders,
        &master_keys,
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
    let units_res = filter_selected_tags(
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
        &login_id_from_identity(user)?,
        req.report_tags_only_this_unit.unwrap_or(false),
    )
    .context(h!())?;
    let units_res = filter_selected_networks(
        units_res,
        &req.selected_networks,
        &req.without_network,
    )
    .context(h!())?;
    let units_res = apply_metadata_filters(units_res, &req.0)?;
    let units_res = filter_search(units_res, &req.search).context(h!())?;
    let units_res =
        filter_selected_aors(units_res, &req.selected_aors).context(h!())?;
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

    if should_read_stats_aggregated(&req, env, dt_since, dt_till).c(h!())? {
        let result =
            read_location_stats_aggregated(env, master_keys, dt_since, dt_till)
                .await
                .c(h!())?;
        return Ok(result);
    }

    fetch_locations_for_login_with_db(&req.0, login_str, &env.dbx, master_keys)
        .await
}

pub(super) async fn fetch_locations_raw_with_db(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsLocation>, AppError> {
    let login_value = login_id_from_identity(user)?;
    fetch_locations_for_login_with_db(&req.0, &login_value, db, master_keys)
        .await
}

async fn fetch_locations_for_login_with_db(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
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
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
    Ok(build_locations_filtered_query_for_login(
        req,
        login_str,
        dt_since,
        dt_till,
        master_keys,
        None,
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
    let locations_res = sigint_inbox_item::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintPost.def(),
        )
        .filter(message_in_groups_exists_with_scope(
            master_keys.clone(),
            scope,
        ))
        .filter(signal_message::Column::Deleted.eq(false))
        // .filter(signal_message::Column::DuplicateOf.is_null())
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till));
    let locations_res = apply_analytics_message_id_scope(locations_res, scope);
    let locations_res = filter_selected_groups_and_senders_with_access(
        locations_res,
        &req.selected_groups,
        &req.selected_senders,
        &master_keys,
    )
    .context(h!())?;
    let locations_res = filter_selected_units(
        locations_res,
        &req.selected_units,
        &req.units_exact_match_only,
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
    let locations_res = filter_selected_tags(
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
    )
    .context(h!())?;
    let locations_res = filter_selected_networks(
        locations_res,
        &req.selected_networks,
        &req.without_network,
    )
    .context(h!())?;
    let locations_res = apply_metadata_filters(locations_res, req)?;
    let locations_res =
        filter_search(locations_res, &req.search).context(h!())?;
    let locations_res = filter_selected_aors(locations_res, &req.selected_aors)
        .context(h!())
        .context(h!())?;
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

    if should_read_stats_aggregated(&req_json, env, dt_since, dt_till)
        .c(h!())?
    {
        let result =
            read_aor_stats_aggregated(env, master_keys, dt_since, dt_till)
                .await
                .c(h!())?;
        return Ok(result);
    }

    fetch_aors_for_login_with_db(req, login_str, &env.dbx, master_keys, false)
        .await
}

async fn fetch_aors_for_login_with_db(
    req: &AnalysisStatsReq,
    login_str: &uuid::Uuid,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
    analytics: bool,
) -> Result<Vec<AnalysisStatsAor>, AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let instant = std::time::Instant::now();
    let stmt = if analytics {
        build_aors_analytics_query(
            req,
            login_str,
            dt_since,
            dt_till,
            master_keys,
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
) -> Result<Vec<AnalysisStatsAor>, AppError> {
    let login_value = login_id_from_identity(user)?;
    fetch_aors_for_login_with_db(&req.0, &login_value, db, master_keys, true)
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

    if should_read_stats_aggregated(req, env, dt_since, dt_till).c(h!())? {
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
    let messages_q = build_aor_messages_query(
        req,
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
    let group_message_aors = build_aor_group_analytics_arm(
        build_aor_messages_query(
            req,
            login_str,
            dt_since,
            dt_till,
            &master_keys,
            scope,
        )?,
        &req.selected_aors,
        scope,
    );
    let network_message_aors = build_aor_network_analytics_arm(
        build_aor_messages_query(
            req,
            login_str,
            dt_since,
            dt_till,
            &master_keys,
            scope,
        )?,
        &req.selected_aors,
        scope,
    );

    let sql = format!(
        "SELECT aor_id, COUNT(DISTINCT message_id) AS count \
         FROM ({group_sql} UNION ALL {network_sql}) AS message_aors \
         GROUP BY 1",
        group_sql = group_message_aors.to_string(PostgresQueryBuilder),
        network_sql = network_message_aors.to_string(PostgresQueryBuilder),
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
        )
        .filter(message_in_groups_exists_with_scope(
            master_keys.to_vec(),
            scope,
        ))
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
    let messages = filter_selected_tags(
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
    )
    .context(h!())?;
    let messages = filter_search(messages, &req.search).context(h!())?;
    let messages = apply_metadata_filters(messages, req)?;
    Ok(filter_selected_aors(messages, &req.selected_aors).context(h!())?)
}

fn build_aor_group_analytics_arm(
    messages: Select<sigint_inbox_item::Entity>,
    selected_aors: &Option<Vec<i64>>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> SelectStatement {
    let group_message_alias = Alias::new("group_message_aor");
    let group_aor_alias = Alias::new("group_aor_link");
    let group_value_alias = Alias::new("group_aor_value");
    let mut messages = messages
        .select_only()
        .column_as(signal_message::Column::Id, "message_id");
    QuerySelect::query(&mut messages)
        .expr_as(
            Expr::col((
                group_value_alias.clone(),
                area_of_responsibility::Column::Id,
            )),
            Alias::new("aor_id"),
        )
        .join_as(
            JoinType::InnerJoin,
            signal_message_group::Entity,
            group_message_alias.clone(),
            Condition::all().add(
                Expr::col((
                    group_message_alias.clone(),
                    signal_message_group::Column::SignalMessageId,
                ))
                .equals((signal_message::Entity, signal_message::Column::Id)),
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
        );
    if let Some(scope) = scope {
        QuerySelect::query(&mut messages).cond_where(scope.condition((
            group_message_alias,
            signal_message_group::Column::SignalMessageId,
        )));
    }
    if let Some(condition) =
        selected_aor_overlap_condition(group_value_alias, selected_aors)
    {
        QuerySelect::query(&mut messages).cond_where(condition);
    }
    messages.into_query()
}

fn build_aor_network_analytics_arm(
    messages: Select<sigint_inbox_item::Entity>,
    selected_aors: &Option<Vec<i64>>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> SelectStatement {
    let network_message_alias = Alias::new("network_message_aor");
    let network_alias = Alias::new("network_aor");
    let network_aor_alias = Alias::new("network_aor_link");
    let network_value_alias = Alias::new("network_aor_value");
    let mut messages = messages
        .select_only()
        .column_as(signal_message::Column::Id, "message_id");
    QuerySelect::query(&mut messages)
        .expr_as(
            Expr::col((
                network_value_alias.clone(),
                area_of_responsibility::Column::Id,
            )),
            Alias::new("aor_id"),
        )
        .join_as(
            JoinType::InnerJoin,
            sigint_inbox_item_network::Entity,
            network_message_alias.clone(),
            Condition::all().add(
                Expr::col((
                    network_message_alias.clone(),
                    sigint_inbox_item_network::Column::SigintInboxItemId,
                ))
                .equals((signal_message::Entity, signal_message::Column::Id)),
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
        );
    if let Some(scope) = scope {
        QuerySelect::query(&mut messages).cond_where(scope.condition((
            network_message_alias,
            sigint_inbox_item_network::Column::SigintInboxItemId,
        )));
    }
    if let Some(condition) =
        selected_aor_overlap_condition(network_value_alias, selected_aors)
    {
        QuerySelect::query(&mut messages).cond_where(condition);
    }
    messages.into_query()
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
) -> Result<Vec<AnalysisStatsNetwork>, AppError> {
    let login_value = login_id_from_identity(user)?;
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let statement = build_networks_analytics_query(
        &req.0,
        &login_value,
        &tag_access.accessible_tag_ids,
        &tag_access.unit_login_ids,
        dt_since,
        dt_till,
        master_keys,
        false,
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
fn build_networks_analytics_query_with_scope(
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
    let messages = build_network_analytics_messages_query(
        req,
        login_str,
        accessible_tag_ids,
        unit_login_ids,
        dt_since,
        dt_till,
        &master_keys,
        scope,
    )?;
    let groups =
        build_network_analytics_groups_query(req, master_keys.as_slice());
    let frequency_matches = build_network_frequency_analytics_arm(
        messages.clone(),
        build_network_analytics_catalog_query(req),
        groups.clone(),
    );
    let linked_matches = build_network_linked_analytics_arm(
        messages,
        groups,
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
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(message_in_groups_exists_with_scope(
            master_keys.to_vec(),
            scope,
        ))
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
    let messages = filter_selected_units(
        messages,
        &req.selected_units,
        &req.units_exact_match_only,
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
        filter_selected_aors(messages, &req.selected_aors).context(h!())?;
    let messages = filter_selected_networks(
        messages,
        &req.selected_networks,
        &req.without_network,
    )
    .context(h!())?;
    let messages = apply_metadata_filters(messages, req)?;
    let messages = filter_search(messages, &req.search).context(h!())?;
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

fn build_network_analytics_groups_query(
    req: &AnalysisStatsReq,
    master_keys: &[String],
) -> Select<signal_group::Entity> {
    let groups = signal_group::Entity::find()
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
        effective_groups_with_access(&req.selected_groups, master_keys);
    if effective_groups.is_empty() {
        groups.filter(Expr::cust("FALSE"))
    } else {
        groups.filter(signal_group::Column::MasterKey.eq_any(effective_groups))
    }
}

fn build_network_frequency_analytics_arm(
    messages: Select<sigint_inbox_item::Entity>,
    networks: Select<sigint_network_freq::Entity>,
    groups: Select<signal_group::Entity>,
) -> SelectStatement {
    let message_alias = Alias::new("analytics_frequency_message");
    let network_alias = Alias::new("analytics_frequency_network");
    let group_alias = Alias::new("analytics_frequency_group");
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
        )
        .join_subquery(
            JoinType::InnerJoin,
            groups.into_query(),
            group_alias.clone(),
            network_stats_group_join_condition(
                message_alias,
                group_alias,
                Expr::col((network_alias.clone(), Alias::new("n_left"))).into(),
                Expr::col((network_alias, Alias::new("n_right"))).into(),
            ),
        );
    matches.to_owned()
}

fn build_network_linked_analytics_arm(
    messages: Select<sigint_inbox_item::Entity>,
    groups: Select<signal_group::Entity>,
    selected_aors: &Option<Vec<i64>>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> SelectStatement {
    let message_alias = Alias::new("analytics_linked_message");
    let network_link_alias = Alias::new("analytics_linked_network_link");
    let network_alias = Alias::new("analytics_linked_network");
    let network_aor_alias = Alias::new("analytics_linked_network_aor");
    let network_value_alias = Alias::new("analytics_linked_network_value");
    let group_alias = Alias::new("analytics_linked_group");
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
        )
        .join_as(
            JoinType::InnerJoin,
            sigint_inbox_item_network::Entity,
            network_link_alias.clone(),
            Expr::col((
                network_link_alias.clone(),
                sigint_inbox_item_network::Column::SigintInboxItemId,
            ))
            .equals((message_alias.clone(), Alias::new("dedup_key"))),
        )
        .join_as(
            JoinType::InnerJoin,
            sigint_network::Entity,
            network_alias.clone(),
            Expr::col((network_alias.clone(), sigint_network::Column::Id))
                .equals((
                    network_link_alias.clone(),
                    sigint_inbox_item_network::Column::SigintNetworkId,
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
        )
        .join_subquery(
            JoinType::InnerJoin,
            groups.into_query(),
            group_alias.clone(),
            network_stats_group_join_condition(
                message_alias,
                group_alias,
                Expr::col((
                    network_value_alias.clone(),
                    area_of_responsibility::Column::LeftBound,
                ))
                .into(),
                Expr::col((
                    network_value_alias.clone(),
                    area_of_responsibility::Column::RightBound,
                ))
                .into(),
            ),
        )
        .and_where(
            Expr::col((network_alias, sigint_network::Column::Deleted))
                .eq(false),
        );
    if let Some(scope) = scope {
        matches.cond_where(scope.condition((
            network_link_alias,
            sigint_inbox_item_network::Column::SigintInboxItemId,
        )));
    }
    if let Some(condition) =
        selected_aor_overlap_condition(network_value_alias, selected_aors)
    {
        matches.cond_where(condition);
    }
    matches.to_owned()
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
    let messages_q = filter_selected_units(
        messages_q,
        &req.selected_units,
        &req.units_exact_match_only,
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
    let messages_q = apply_metadata_filters(messages_q, req)?;
    let messages_q = filter_search(messages_q, &req.search).context(h!())?;
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
                Expr::col((n.clone(), Alias::new("n_left"))).into(),
                Expr::col((n.clone(), Alias::new("n_right"))).into(),
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
                ))
                .into(),
                Expr::col((
                    linked_network_value.clone(),
                    area_of_responsibility::Column::RightBound,
                ))
                .into(),
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
        .filter(message_in_groups_exists_with_scope(
            master_keys.clone(),
            scope,
        ))
        // .filter(signal_message::Column::DuplicateOf.is_null())
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till));
    let selected_count_res =
        apply_analytics_message_id_scope(selected_count_res, scope);
    // .filter(sigint_inbox_item::Column::Checked.eq(Some(true)));
    let selected_count_res = filter_selected_groups_and_senders_with_access(
        selected_count_res,
        &req.selected_groups,
        &req.selected_senders,
        &master_keys,
    )
    .context(h!())?;
    let selected_count_res =
        filter_selected_freqs(selected_count_res, &req.selected_freqs)
            .context(h!())?;
    let selected_count_res =
        filter_selected_posts(selected_count_res, &req.selected_posts)
            .context(h!())?;
    let selected_count_res = filter_selected_units(
        selected_count_res,
        &req.selected_units,
        &req.units_exact_match_only,
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
    let selected_count_res = filter_selected_tags(
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
    )
    .context(h!())?;
    let selected_count_res = filter_selected_networks(
        selected_count_res,
        &req.selected_networks,
        &req.without_network,
    )
    .context(h!())?;
    let selected_count_res =
        apply_metadata_filters(selected_count_res, &req.0)?;
    let selected_count_res =
        filter_search(selected_count_res, &req.search).context(h!())?;
    let selected_count_res =
        filter_selected_aors(selected_count_res, &req.selected_aors)
            .context(h!())
            .context(h!())?;
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
    read_stats_aggregated: bool,
    scope: Option<&AnalyticsMessageIdScope>,
) -> anyhow::Result<i64> {
    if read_stats_aggregated {
        return read_total_stats_aggregated(db, master_keys, dt_since, dt_till)
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
        .filter(message_in_groups_exists_with_scope(
            master_keys.clone(),
            scope,
        ))
        // .filter(signal_message::Column::DuplicateOf.is_null())
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till));
    let overall_count_res =
        apply_analytics_message_id_scope(overall_count_res, scope);
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

    #[test]
    fn distinct_count_query_aggregates_without_grouping() {
        let query = build_distinct_count_query(
            sigint_inbox_item::Entity::find(),
            Expr::col(sigint_inbox_item::Column::Freq).into(),
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

        assert!(query.contains("WHERE FALSE"));
    }
}
