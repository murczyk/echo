use crate::config::{
    INBOX_COUNT_INDEXED_MAX_DAYS, INBOX_MESSAGES_PAGE_LIMIT,
    TAG_MINIMUM_CONFIDENCE,
};
use crate::entities::{prelude::*, *};
use crate::error::AppError;
use crate::rer_importer::analysis::*;
use crate::rer_importer::types::*;
use crate::sigint::sender::preferred_sender_expr;
use crate::types::*;
use crate::utils::*;
use chrono::{Duration, NaiveDateTime, Utc};
use sea_orm::{sea_query::PostgresQueryBuilder, *};
use sea_query::types::IntoColumnRef;
use sea_query::{Alias, Expr, ExprTrait, Query, SelectStatement, SimpleExpr};
use std::collections::BTreeSet;

fn since_id_null_bucket_filter(
    since_id_noninclusive: i64,
    cursor_expr: SimpleExpr,
    id_expr: SimpleExpr,
) -> SimpleExpr {
    cursor_expr.is_null().and(id_expr.gt(since_id_noninclusive))
}

fn inbox_items_cte_id_expr() -> SimpleExpr {
    Expr::col((Alias::new("inbox_items_cte"), Alias::new("id")))
}

fn inbox_items_cte_cursor_expr(req_sort_by: InboxMessagesSortBy) -> SimpleExpr {
    match req_sort_by {
        InboxMessagesSortBy::IMSDatetime => {
            Expr::col((Alias::new("inbox_items_cte"), Alias::new("datetime")))
        }
        InboxMessagesSortBy::IMSTimestamp => {
            Expr::col((Alias::new("inbox_items_cte"), Alias::new("timestamp")))
        }
    }
}

fn message_has_media_exists() -> SimpleExpr {
    let media_query = Query::select()
        .expr(Expr::value(1))
        .from(signal_message_media::Entity)
        .and_where(
            Expr::col((
                signal_message_media::Entity,
                signal_message_media::Column::SignalMessageId,
            ))
            .equals((signal_message::Entity, signal_message::Column::Id)),
        )
        .to_owned();

    Expr::exists(media_query)
}

fn message_is_accessible_exists(
    sigint_groups: Vec<String>,
    scope: Option<&AnalyticsMessageIdScope>,
    force_nested_loop: bool,
) -> SimpleExpr {
    let mut access_query = Query::select();
    access_query
        .expr(Expr::value(1))
        .from(signal_message_group::Entity)
        .and_where(
            Expr::col((
                signal_message_group::Entity,
                signal_message_group::Column::SignalMessageId,
            ))
            .equals((signal_message::Entity, signal_message::Column::Id)),
        )
        .and_where(
            signal_message_group::Column::GroupMasterKey.eq_any(sigint_groups),
        );
    if let Some(scope) = scope {
        access_query.and_where(scope.condition((
            signal_message_group::Entity,
            signal_message_group::Column::SignalMessageId,
        )));
    }
    if force_nested_loop {
        access_query.offset(0);
    }

    Expr::exists(access_query.to_owned())
}

fn message_source_group_is_not_ignored_exists() -> SimpleExpr {
    let query = datasource_group::Entity::find()
        .select_only()
        .expr(Expr::value(1))
        .join(
            JoinType::InnerJoin,
            datasource_group::Relation::SignalGroup.def(),
        )
        .filter(
            Expr::col((datasource_group::Entity, datasource_group::Column::Id))
                .equals((
                    signal_message::Entity,
                    signal_message::Column::DatasourceGroupId,
                )),
        )
        .filter(signal_group::Column::IgnoreOperativny.eq(Some(false)))
        .into_query();
    Expr::exists(query)
}

fn inbox_date_gte_expr(
    req_sort_by: InboxMessagesSortBy,
    rhs: SimpleExpr,
) -> SimpleExpr {
    match req_sort_by {
        InboxMessagesSortBy::IMSDatetime => {
            Expr::col(sigint_inbox_item::Column::Datetime).gte(rhs)
        }
        InboxMessagesSortBy::IMSTimestamp => {
            Expr::col(signal_message::Column::Timestamp).gte(rhs)
        }
    }
}

fn inbox_date_lte_expr(
    req_sort_by: InboxMessagesSortBy,
    rhs: SimpleExpr,
) -> SimpleExpr {
    match req_sort_by {
        InboxMessagesSortBy::IMSDatetime => {
            Expr::col(sigint_inbox_item::Column::Datetime).lte(rhs)
        }
        InboxMessagesSortBy::IMSTimestamp => {
            Expr::col(signal_message::Column::Timestamp).lte(rhs)
        }
    }
}

pub(crate) async fn build_filtered_inbox_query<'a, 'async_trait, C>(
    dbx: &'a C,
    login: &uuid::Uuid,
    env: &Env,
    req: &InboxMessagesReq,
) -> Result<Select<signal_message::Entity>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    build_filtered_inbox_query_with_scope(
        dbx,
        login,
        env,
        req,
        None,
        None,
        InboxQueryPurpose::Messages,
    )
    .await
}

pub(crate) fn inbox_request_is_unbounded(req: &InboxMessagesReq) -> bool {
    req.since_id_noninclusive.is_none()
        && req.before_id_noninclusive.is_none()
        && req.since_date_inclusive_ms.is_none()
        && req.till_date_inclusive_ms.is_none()
}

pub(crate) fn inbox_request_is_unbounded_latest(
    req: &InboxMessagesReq,
) -> bool {
    inbox_request_is_unbounded(req) && req.load_latest == Some(true)
}

pub(crate) async fn latest_inbox_poll_cursor_id<C>(
    dbx: &C,
    req: &InboxMessagesReq,
) -> Result<Option<i64>, AppError>
where
    C: ConnectionTrait,
{
    let cursor_id =
        match req.sort_by.unwrap_or(InboxMessagesSortBy::IMSDatetime) {
            InboxMessagesSortBy::IMSDatetime => SigintInboxItem::find()
                .select_only()
                .column(sigint_inbox_item::Column::Id)
                .filter(sigint_inbox_item::Column::Datetime.is_not_null())
                .order_by_desc(sigint_inbox_item::Column::Datetime)
                .order_by_desc(sigint_inbox_item::Column::Id)
                .into_tuple::<i64>()
                .one(dbx)
                .await
                .c(h!())?,
            InboxMessagesSortBy::IMSTimestamp => SignalMessage::find()
                .select_only()
                .column(signal_message::Column::Id)
                .filter(signal_message::Column::Deleted.eq(false))
                .filter(signal_message::Column::Timestamp.is_not_null())
                .order_by_desc(signal_message::Column::Timestamp)
                .order_by_desc(signal_message::Column::Id)
                .into_tuple::<i64>()
                .one(dbx)
                .await
                .c(h!())?,
        };
    Ok(cursor_id)
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum InboxQueryPurpose {
    Messages,
    Digest,
    IndexedDigest,
    Analytics,
}

fn inbox_query_needs_post_join(req: &InboxMessagesReq) -> bool {
    req.selected_posts
        .as_ref()
        .is_some_and(|posts| !posts.is_empty())
        || req
            .denied_posts
            .as_ref()
            .is_some_and(|posts| !posts.is_empty())
}

fn build_inbox_query_base(
    req: &InboxMessagesReq,
    purpose: InboxQueryPurpose,
) -> Select<signal_message::Entity> {
    if purpose == InboxQueryPurpose::IndexedDigest {
        let signal_message_query = SignalMessage::find()
            .select_only()
            .columns([
                signal_message::Column::Id,
                signal_message::Column::Timestamp,
                signal_message::Column::Deleted,
                signal_message::Column::DatasourceGroupId,
                signal_message::Column::MessageUid,
            ])
            .filter(
                Expr::col((signal_message::Entity, signal_message::Column::Id))
                    .equals((
                        sigint_inbox_item::Entity,
                        sigint_inbox_item::Column::Id,
                    )),
            )
            .filter(signal_message::Column::Deleted.eq(false))
            .offset(0)
            .into_query();
        let mut query = SignalMessage::find();
        QueryTrait::query(&mut query)
            .from_clear()
            .from(sigint_inbox_item::Entity)
            .join_lateral(
                JoinType::InnerJoin,
                signal_message_query,
                Alias::new("signal_message"),
                Expr::value(true),
            );
        if inbox_query_needs_post_join(req) {
            query = query.join(
                JoinType::LeftJoin,
                sigint_inbox_item::Relation::SigintPost.def(),
            );
        }
        return query;
    }

    let mut query = SignalMessage::find().join(
        JoinType::LeftJoin,
        signal_message::Relation::SigintInboxItem.def(),
    );
    if purpose == InboxQueryPurpose::Messages {
        return query
            .join(
                JoinType::LeftJoin,
                signal_message::Relation::DatasourceGroup.def(),
            )
            .join(
                JoinType::LeftJoin,
                datasource_group::Relation::SignalGroup.def(),
            )
            .join(
                JoinType::LeftJoin,
                sigint_inbox_item::Relation::SigintPost.def(),
            )
            .join(
                JoinType::LeftJoin,
                sigint_inbox_item::Relation::DeviceName.def(),
            );
    }
    if inbox_query_needs_post_join(req) {
        query = query.join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintPost.def(),
        );
    }
    query
}

fn inbox_count_uses_indexed_query(req: &InboxMessagesReq) -> bool {
    if req.sort_by.unwrap_or(InboxMessagesSortBy::IMSDatetime)
        != InboxMessagesSortBy::IMSDatetime
    {
        return false;
    }
    let (Some(since), Some(till)) =
        (req.since_date_inclusive_ms, req.till_date_inclusive_ms)
    else {
        return false;
    };
    till >= since
        && till - since
            <= Duration::days(INBOX_COUNT_INDEXED_MAX_DAYS).num_milliseconds()
}

fn inbox_count_has_unit_filter(req: &InboxMessagesReq) -> bool {
    req.selected_units
        .as_ref()
        .is_some_and(|units| !units.is_empty())
        || req
            .denied_units
            .as_ref()
            .is_some_and(|units| !units.is_empty())
}

fn inbox_unit_filter_period(
    req: &InboxMessagesReq,
) -> Result<Option<(NaiveDateTime, NaiveDateTime)>, AppError> {
    if req.sort_by.unwrap_or(InboxMessagesSortBy::IMSDatetime)
        != InboxMessagesSortBy::IMSDatetime
    {
        return Ok(None);
    }
    let (Some(dt_since), Some(dt_till)) =
        (req.since_date_inclusive_ms, req.till_date_inclusive_ms)
    else {
        return Ok(None);
    };
    let dt_till = dt_from_millis(dt_till)?
        .checked_add_signed(Duration::microseconds(1))
        .context(h!())?;
    Ok(Some((dt_from_millis(dt_since)?, dt_till)))
}

fn inbox_period_unit_filters_supported(req: &InboxMessagesReq) -> bool {
    [&req.selected_units, &req.denied_units]
        .into_iter()
        .all(|units| !expand_unit_filter_values(units).includes_undefined)
}

fn apply_flat_analytics_group_filters(
    mut query: Select<signal_message::Entity>,
    req: &InboxMessagesReq,
    allowed_groups: &[String],
    scope: &AnalyticsMessageIdScope,
) -> Select<signal_message::Entity> {
    let allowed = allowed_groups.iter().collect::<BTreeSet<_>>();
    let selected_groups = req
        .selected_groups
        .as_ref()
        .map(|groups| {
            groups
                .iter()
                .filter(|group| allowed.contains(group))
                .cloned()
                .collect::<Vec<_>>()
        })
        .filter(|groups| !groups.is_empty())
        .unwrap_or_else(|| allowed_groups.to_vec());
    let access_alias = Alias::new("analytics_access_group");
    let mut access_condition = analytics_message_group_join_condition(
        access_alias.clone(),
        &selected_groups,
        scope,
    );
    if let Some(selected_senders) = req
        .selected_senders
        .as_ref()
        .filter(|senders| !senders.is_empty())
    {
        access_condition = access_condition.add(
            Expr::col((
                access_alias.clone(),
                signal_message_group::Column::Sender,
            ))
            .is_in(selected_senders.clone()),
        );
    }
    QueryTrait::query(&mut query).join_as(
        JoinType::InnerJoin,
        signal_message_group::Entity,
        access_alias,
        access_condition,
    );

    let denied_groups = req
        .denied_groups
        .as_ref()
        .map(|groups| {
            groups
                .iter()
                .filter(|group| allowed.contains(group))
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if !denied_groups.is_empty() {
        query = left_join_denied_analytics_message_groups(
            query,
            "analytics_denied_group",
            signal_message_group::Column::GroupMasterKey,
            denied_groups,
            scope,
        );
    }
    if let Some(denied_senders) = req
        .denied_senders
        .as_ref()
        .filter(|senders| !senders.is_empty())
    {
        query = left_join_denied_analytics_message_groups(
            query,
            "analytics_denied_sender",
            signal_message_group::Column::Sender,
            denied_senders.clone(),
            scope,
        );
    }
    query
}

fn apply_flat_analytics_imported_coords_filter(
    query: Select<signal_message::Entity>,
) -> Select<signal_message::Entity> {
    query
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::DatasourceGroup.def(),
        )
        .join(
            JoinType::InnerJoin,
            datasource_group::Relation::SignalGroup.def(),
        )
        .filter(signal_group::Column::IgnoreOperativny.eq(Some(false)))
}

fn analytics_message_group_join_condition(
    alias: Alias,
    groups: &[String],
    scope: &AnalyticsMessageIdScope,
) -> Condition {
    let group_condition = if groups.is_empty() {
        Expr::value(false)
    } else {
        Expr::col((alias.clone(), signal_message_group::Column::GroupMasterKey))
            .is_in(groups.to_vec())
    };
    Condition::all()
        .add(
            Expr::col((
                alias.clone(),
                signal_message_group::Column::SignalMessageId,
            ))
            .equals((signal_message::Entity, signal_message::Column::Id)),
        )
        .add(group_condition)
        .add(
            scope.condition((
                alias,
                signal_message_group::Column::SignalMessageId,
            )),
        )
}

fn left_join_denied_analytics_message_groups(
    mut query: Select<signal_message::Entity>,
    alias: &str,
    column: signal_message_group::Column,
    values: Vec<String>,
    scope: &AnalyticsMessageIdScope,
) -> Select<signal_message::Entity> {
    let alias = Alias::new(alias);
    let condition = Condition::all()
        .add(
            Expr::col((
                alias.clone(),
                signal_message_group::Column::SignalMessageId,
            ))
            .equals((signal_message::Entity, signal_message::Column::Id)),
        )
        .add(Expr::col((alias.clone(), column)).is_in(values))
        .add(scope.condition((
            alias.clone(),
            signal_message_group::Column::SignalMessageId,
        )));
    QueryTrait::query(&mut query).join_as(
        JoinType::LeftJoin,
        signal_message_group::Entity,
        alias.clone(),
        condition,
    );
    query.filter(
        Expr::col((alias, signal_message_group::Column::SignalMessageId))
            .is_null(),
    )
}

async fn build_filtered_inbox_query_with_scope<'a, 'async_trait, C>(
    dbx: &'a C,
    login: &uuid::Uuid,
    env: &Env,
    req: &InboxMessagesReq,
    scope: Option<&AnalyticsMessageIdScope>,
    internal_lower_bound: Option<NaiveDateTime>,
    purpose: InboxQueryPurpose,
) -> Result<Select<signal_message::Entity>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut q = build_inbox_query_base(req, purpose);
    if inbox_request_is_unbounded(req) && req.load_latest != Some(true) {
        error!(
            "rejecting unbounded inbox query without load_latest; page_id={:?}",
            req.page_id
        );
        return Ok(q.filter(Expr::cust("FALSE")));
    }

    let sigint_groups =
        crate::messenger::group::get_identity_sigint_groups(dbx, login)
            .await
            .c(h!())?;

    q = q.filter(signal_message::Column::Deleted.eq(false));
    if purpose == InboxQueryPurpose::Analytics {
        q = apply_flat_analytics_group_filters(
            q,
            req,
            &sigint_groups,
            scope.context(h!())?,
        );
    } else {
        q = q.filter(message_is_accessible_exists(
            sigint_groups.clone(),
            scope,
            purpose == InboxQueryPurpose::IndexedDigest,
        ));
    }
    if let Some(scope) = scope {
        q = q
            .filter(scope.condition((
                signal_message::Entity,
                signal_message::Column::Id,
            )))
            .filter(scope.condition((
                sigint_inbox_item::Entity,
                sigint_inbox_item::Column::Id,
            )));
    }

    if req.ignore_imported_coords.unwrap_or(false) {
        q = match purpose {
            InboxQueryPurpose::Messages => {
                q.filter(signal_group::Column::IgnoreOperativny.eq(Some(false)))
            }
            InboxQueryPurpose::Analytics => {
                apply_flat_analytics_imported_coords_filter(q)
            }
            InboxQueryPurpose::Digest | InboxQueryPurpose::IndexedDigest => {
                q.filter(message_source_group_is_not_ignored_exists())
            }
        };
    }

    if req.only_show_unprocessed == Some(true) {
        q = q.filter(sigint_inbox_item::Column::Reviewed.ne(Some(true)));
    }
    if req.checked_only == Some(true) {
        q = q.filter(sigint_inbox_item::Column::Checked.eq(Some(true)));
    }
    let q = if purpose == InboxQueryPurpose::Analytics {
        q
    } else {
        let q = filter_selected_groups_and_senders_with_access_and_scope(
            q,
            &req.selected_groups,
            &req.selected_senders,
            &sigint_groups,
            scope,
        )?;
        let q = filter_denied_groups_with_access_and_scope(
            q,
            &req.denied_groups,
            &sigint_groups,
            scope,
        )?;
        filter_denied_senders_with_scope(q, &req.denied_senders, scope)?
    };
    let q = filter_selected_freqs(q, &req.selected_freqs)?;
    let q = filter_denied_freqs(q, &req.denied_freqs)?;
    let q = filter_selected_posts(q, &req.selected_posts)?;
    let q = filter_denied_posts(q, &req.denied_posts)?;
    let q = filter_selected_callsigns(q, &req.selected_callsigns)?;
    let q = filter_search(q, &req.search)?;
    let q = filter_selected_device_names(q, &req.selected_device_names)?;
    let q = filter_selected_units(
        q,
        &req.selected_units,
        &req.units_exact_match_only,
    )?;
    let q =
        filter_denied_units(q, &req.denied_units, &req.units_exact_match_only)?;
    let q = filter_selected_tags(
        q,
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
        login,
        req.report_tags_only_this_unit.unwrap_or(false),
    )?;
    let q = filter_selected_aors(q, &req.selected_aors).context(h!())?;
    let q = filter_selected_networks(
        q,
        &req.selected_networks,
        &req.without_network,
    )
    .context(h!())?;
    let include_peleng_locations =
        req.include_peleng_locations.unwrap_or(false);
    let mut q = filter_selected_locations(
        q,
        &req.selected_locations,
        include_peleng_locations,
    )?;
    q = filter_selected_metadata_for_inbox_messages(q, req)?;
    if req.only_with_media == Some(true) {
        q = q.filter(message_has_media_exists());
    }
    if let Some(internal_lower_bound) = internal_lower_bound {
        q = q.filter(inbox_date_gte_expr(
            req.sort_by.unwrap_or(InboxMessagesSortBy::IMSDatetime),
            to_ts_expr(internal_lower_bound),
        ));
    }

    q = get_pagination_filters_with_conn(dbx, env, req, q)
        .await
        .c(h!())?;
    Ok(q)
}

fn build_period_unit_filtered_inbox_digest(
    req: &InboxMessagesReq,
    query: Select<signal_message::Entity>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> Result<String, AppError> {
    let query = filter_selected_units_for_period(
        query,
        &req.selected_units,
        &req.units_exact_match_only,
        dt_since,
        dt_till,
    )?;
    let query = filter_denied_units_for_period(
        query,
        &req.denied_units,
        &req.units_exact_match_only,
        dt_since,
        dt_till,
    )?
    .select_only()
    .column_as(Expr::cust("COUNT(*)"), "count")
    .column_as(
        Expr::cust(r#"MIN("signal_message"."timestamp")"#),
        "first_element_ts",
    );
    Ok(render_inbox_digest_query(query))
}

fn render_inbox_digest_query(query: Select<signal_message::Entity>) -> String {
    query.into_query().to_string(PostgresQueryBuilder)
}

async fn build_unit_filtered_inbox_digest_query(
    login: &uuid::Uuid,
    env: &Env,
    req: &InboxMessagesReq,
) -> Result<String, AppError> {
    let purpose = if inbox_count_uses_indexed_query(req) {
        InboxQueryPurpose::IndexedDigest
    } else {
        InboxQueryPurpose::Digest
    };
    if inbox_period_unit_filters_supported(req) {
        if let Some((dt_since, dt_till)) = inbox_unit_filter_period(req)? {
            let mut candidate_req = req.clone();
            candidate_req.selected_units = None;
            candidate_req.denied_units = None;
            let candidates = build_filtered_inbox_query_with_scope(
                &env.dbx,
                login,
                env,
                &candidate_req,
                None,
                None,
                purpose,
            )
            .await
            .context(h!())?;
            return build_period_unit_filtered_inbox_digest(
                req, candidates, dt_since, dt_till,
            );
        }
    }
    let query = build_filtered_inbox_query_with_scope(
        &env.dbx, login, env, req, None, None, purpose,
    )
    .await
    .context(h!())?
    .select_only()
    .column_as(Expr::cust("COUNT(*)"), "count")
    .column_as(
        Expr::cust(r#"MIN("signal_message"."timestamp")"#),
        "first_element_ts",
    );
    Ok(render_inbox_digest_query(query))
}

pub(crate) async fn build_inbox_digest_query(
    login: &uuid::Uuid,
    env: &Env,
    req: &InboxMessagesReq,
) -> Result<String, AppError> {
    if inbox_count_has_unit_filter(req) {
        return build_unit_filtered_inbox_digest_query(login, env, req).await;
    }
    let purpose = if inbox_count_uses_indexed_query(req) {
        InboxQueryPurpose::IndexedDigest
    } else {
        InboxQueryPurpose::Digest
    };
    let q = build_filtered_inbox_query_with_scope(
        &env.dbx, login, env, req, None, None, purpose,
    )
    .await
    .context(h!())?
    .select_only()
    .column_as(Expr::cust("COUNT(*)"), "count")
    .column_as(
        Expr::cust(r#"MIN("signal_message"."timestamp")"#),
        "first_element_ts",
    );

    Ok(render_inbox_digest_query(q))
}

pub(crate) async fn build_analytics_inbox_digest_query(
    login: &uuid::Uuid,
    env: &Env,
    req: &InboxMessagesReq,
    db: &DatabaseConnection,
    freshness_max_age_ms: u64,
) -> Result<Option<String>, AppError> {
    let Some((q, _)) = build_analytics_filtered_inbox_query(
        login,
        env,
        req,
        db,
        freshness_max_age_ms,
    )
    .await?
    else {
        return Ok(None);
    };
    let q = q
        .select_only()
        .column_as(
            Expr::cust(r#"COUNT(DISTINCT "signal_message"."id")"#),
            "count",
        )
        .column_as(
            Expr::cust(r#"MIN("signal_message"."timestamp")"#),
            "first_element_ts",
        );

    Ok(Some(render_inbox_digest_query(q)))
}

pub(crate) async fn build_analytics_inbox_candidates_query(
    login: &uuid::Uuid,
    env: &Env,
    req: &InboxMessagesReq,
    db: &DatabaseConnection,
    freshness_max_age_ms: u64,
) -> Result<Option<String>, AppError> {
    let Some((query, _)) = build_analytics_filtered_inbox_query(
        login,
        env,
        req,
        db,
        freshness_max_age_ms,
    )
    .await?
    else {
        return Ok(None);
    };
    Ok(Some(render_inbox_digest_query(
        finish_inbox_candidates_query(query, req),
    )))
}

fn finish_inbox_candidates_query(
    query: Select<signal_message::Entity>,
    req: &InboxMessagesReq,
) -> Select<signal_message::Entity> {
    let ordering = analytics_inbox_ordering_expr(req);
    let descending = analytics_inbox_order_is_descending(req);
    let mut query = query
        .select_only()
        .column_as(
            Expr::col((signal_message::Entity, signal_message::Column::Id)),
            "id",
        )
        .column_as(ordering.clone(), "ordering_value")
        .group_by(Expr::col((
            signal_message::Entity,
            signal_message::Column::Id,
        )))
        .group_by(ordering);
    query = if descending {
        query
            .order_by_desc(Expr::col(Alias::new("ordering_value")))
            .order_by_desc(Expr::col((
                signal_message::Entity,
                signal_message::Column::Id,
            )))
    } else {
        query
            .order_by_asc(Expr::col(Alias::new("ordering_value")))
            .order_by_asc(Expr::col((
                signal_message::Entity,
                signal_message::Column::Id,
            )))
    };
    query.limit(INBOX_MESSAGES_PAGE_LIMIT as u64)
}

fn analytics_inbox_ordering_expr(req: &InboxMessagesReq) -> SimpleExpr {
    if inbox_request_is_unbounded_latest(req) {
        return Expr::col((
            signal_message::Entity,
            signal_message::Column::CreatedAt,
        ));
    }
    match req.sort_by.unwrap_or(InboxMessagesSortBy::IMSDatetime) {
        InboxMessagesSortBy::IMSDatetime => Expr::col((
            sigint_inbox_item::Entity,
            sigint_inbox_item::Column::Datetime,
        )),
        InboxMessagesSortBy::IMSTimestamp => Expr::col((
            signal_message::Entity,
            signal_message::Column::Timestamp,
        )),
    }
}

fn analytics_inbox_order_is_descending(req: &InboxMessagesReq) -> bool {
    req.load_latest == Some(true)
        || req.newest_first == Some(true)
        || req.before_id_noninclusive.is_some()
}

#[derive(Debug, Default)]
struct ResolvedAnalyticsUnitFilter {
    ordinary_names: Vec<String>,
    includes_undefined: bool,
    linked_network_ids: Vec<i64>,
    present: bool,
}

#[derive(Debug, Default)]
struct ResolvedAnalyticsUnitFilters {
    selected: ResolvedAnalyticsUnitFilter,
    denied: ResolvedAnalyticsUnitFilter,
    all_unit_network_ids: Vec<i64>,
}

#[derive(Debug, Default)]
struct ResolvedAnalyticsAorFilter {
    group_keys: Vec<String>,
    network_ids: Vec<i64>,
    present: bool,
}

impl ResolvedAnalyticsUnitFilters {
    fn has_filters(&self) -> bool {
        self.selected.present || self.denied.present
    }
}

async fn build_analytics_filtered_inbox_query(
    login: &uuid::Uuid,
    env: &Env,
    req: &InboxMessagesReq,
    analytics_db: &DatabaseConnection,
    freshness_max_age_ms: u64,
) -> Result<Option<(Select<signal_message::Entity>, bool)>, AppError> {
    let Some(scope) = resolve_analytics_inbox_message_id_scope(
        req,
        &env.dbx,
        analytics_db,
        freshness_max_age_ms,
    )
    .await?
    else {
        return Ok(None);
    };
    let resolved_units = resolve_analytics_unit_filters(&env.dbx, req).await?;
    let resolved_aors = resolve_analytics_aor_filter(&env.dbx, req).await?;
    let mut analytics_req = req.clone();
    analytics_req.selected_units = None;
    analytics_req.denied_units = None;
    analytics_req.selected_aors = None;
    let query = build_filtered_inbox_query_with_scope(
        &env.dbx,
        login,
        env,
        &analytics_req,
        Some(&scope),
        None,
        InboxQueryPurpose::Analytics,
    )
    .await
    .context(h!())?;
    let has_unit_filters = resolved_units.has_filters();
    let query = apply_resolved_analytics_unit_filters(
        query,
        &resolved_units,
        &scope,
        req.units_exact_match_only.unwrap_or(false),
    );
    let query =
        apply_resolved_analytics_aor_filter(query, &resolved_aors, &scope);
    Ok(Some((query, has_unit_filters)))
}

async fn resolve_analytics_aor_filter(
    source_db: &DatabaseConnection,
    req: &InboxMessagesReq,
) -> Result<ResolvedAnalyticsAorFilter, AppError> {
    let Some(selected_ids) =
        req.selected_aors.as_ref().filter(|aors| !aors.is_empty())
    else {
        return Ok(ResolvedAnalyticsAorFilter::default());
    };
    let selected_ids = selected_ids.iter().copied().collect::<BTreeSet<_>>();
    let aors = AreaOfResponsibility::find()
        .all(source_db)
        .await
        .context(h!())?;
    let selected_bounds = aors
        .iter()
        .filter(|aor| selected_ids.contains(&aor.id))
        .map(|aor| (aor.left_bound, aor.right_bound))
        .collect::<Vec<_>>();
    let linked_aor_ids = aors
        .iter()
        .filter(|aor| {
            selected_bounds.iter().any(|selected| {
                analytics_aor_bounds_overlap(
                    (aor.left_bound, aor.right_bound),
                    *selected,
                )
            })
        })
        .map(|aor| aor.id)
        .collect::<Vec<_>>();
    if linked_aor_ids.is_empty() {
        return Ok(ResolvedAnalyticsAorFilter {
            present: true,
            ..Default::default()
        });
    }
    let group_keys = SignalGroupAor::find()
        .select_only()
        .column(signal_group_aor::Column::MasterKey)
        .filter(signal_group_aor::Column::AorId.is_in(linked_aor_ids.clone()))
        .distinct()
        .into_tuple::<String>()
        .all(source_db)
        .await
        .context(h!())?;
    let network_ids = SigintNetworkAor::find()
        .join(
            JoinType::InnerJoin,
            sigint_network_aor::Relation::SigintNetwork.def(),
        )
        .select_only()
        .column(sigint_network_aor::Column::NetworkId)
        .filter(sigint_network_aor::Column::AorId.is_in(linked_aor_ids))
        .filter(sigint_network::Column::Deleted.eq(false))
        .distinct()
        .into_tuple::<i64>()
        .all(source_db)
        .await
        .context(h!())?;
    Ok(ResolvedAnalyticsAorFilter {
        group_keys,
        network_ids,
        present: true,
    })
}

fn analytics_aor_bounds_overlap(lhs: (f64, f64), rhs: (f64, f64)) -> bool {
    lhs.0 <= rhs.1 && lhs.1 >= rhs.0
}

async fn resolve_analytics_unit_filters(
    source_db: &DatabaseConnection,
    req: &InboxMessagesReq,
) -> Result<ResolvedAnalyticsUnitFilters, AppError> {
    let mut selected = split_analytics_unit_filter(&req.selected_units);
    let mut denied = split_analytics_unit_filter(&req.denied_units);
    selected.linked_network_ids = resolve_unit_network_ids(
        source_db,
        &selected.ordinary_names,
        req.units_exact_match_only,
    )
    .await?;
    denied.linked_network_ids = resolve_unit_network_ids(
        source_db,
        &denied.ordinary_names,
        req.units_exact_match_only,
    )
    .await?;
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

fn split_analytics_unit_filter(
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

fn apply_resolved_analytics_unit_filters(
    mut query: Select<signal_message::Entity>,
    resolved: &ResolvedAnalyticsUnitFilters,
    scope: &AnalyticsMessageIdScope,
    exact_match_only: bool,
) -> Select<signal_message::Entity> {
    let selected_link = join_analytics_unit_link_if_needed(
        &mut query,
        "analytics_selected_unit",
        &resolved.selected.linked_network_ids,
        scope,
    );
    let denied_link = join_analytics_unit_link_if_needed(
        &mut query,
        "analytics_denied_unit",
        &resolved.denied.linked_network_ids,
        scope,
    );
    let any_link = if resolved.selected.includes_undefined
        || resolved.denied.includes_undefined
    {
        join_analytics_unit_link_if_needed(
            &mut query,
            "analytics_any_unit",
            &resolved.all_unit_network_ids,
            scope,
        )
    } else {
        None
    };

    if resolved.selected.present {
        query = query.filter(analytics_unit_filter_match(
            &resolved.selected,
            selected_link.as_ref(),
            any_link.as_ref(),
            exact_match_only,
        ));
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

fn apply_resolved_analytics_aor_filter(
    mut query: Select<signal_message::Entity>,
    resolved: &ResolvedAnalyticsAorFilter,
    scope: &AnalyticsMessageIdScope,
) -> Select<signal_message::Entity> {
    if !resolved.present {
        return query;
    }
    let mut matches = Condition::any();
    if !resolved.group_keys.is_empty() {
        let alias = Alias::new("analytics_selected_aor_group");
        QueryTrait::query(&mut query).join_as(
            JoinType::LeftJoin,
            signal_message_group::Entity,
            alias.clone(),
            Condition::all()
                .add(
                    Expr::col((
                        alias.clone(),
                        signal_message_group::Column::SignalMessageId,
                    ))
                    .equals((
                        signal_message::Entity,
                        signal_message::Column::Id,
                    )),
                )
                .add(
                    Expr::col((
                        alias.clone(),
                        signal_message_group::Column::GroupMasterKey,
                    ))
                    .is_in(resolved.group_keys.clone()),
                )
                .add(scope.condition((
                    alias.clone(),
                    signal_message_group::Column::SignalMessageId,
                ))),
        );
        matches = matches.add(
            Expr::col((alias, signal_message_group::Column::SignalMessageId))
                .is_not_null(),
        );
    }
    if !resolved.network_ids.is_empty() {
        let alias = Alias::new("analytics_selected_aor_network");
        QueryTrait::query(&mut query).join_as(
            JoinType::LeftJoin,
            sigint_inbox_item_network::Entity,
            alias.clone(),
            Condition::all()
                .add(
                    Expr::col((
                        alias.clone(),
                        sigint_inbox_item_network::Column::SigintInboxItemId,
                    ))
                    .equals((
                        sigint_inbox_item::Entity,
                        sigint_inbox_item::Column::Id,
                    )),
                )
                .add(
                    Expr::col((
                        alias.clone(),
                        sigint_inbox_item_network::Column::SigintNetworkId,
                    ))
                    .is_in(resolved.network_ids.clone()),
                )
                .add(scope.condition((
                    alias.clone(),
                    sigint_inbox_item_network::Column::SigintInboxItemId,
                ))),
        );
        matches = matches.add(
            Expr::col((
                alias,
                sigint_inbox_item_network::Column::SigintInboxItemId,
            ))
            .is_not_null(),
        );
    }
    if resolved.group_keys.is_empty() && resolved.network_ids.is_empty() {
        return query.filter(Expr::value(false));
    }
    query.filter(matches)
}

fn analytics_unit_filter_match(
    unit_filter: &ResolvedAnalyticsUnitFilter,
    linked_frequency_alias: Option<&Alias>,
    any_frequency_alias: Option<&Alias>,
    exact_match_only: bool,
) -> SimpleExpr {
    let linked_match = linked_frequency_alias.map(|alias| {
        Expr::col((alias.clone(), sigint_network_freq::Column::Id))
            .is_not_null()
    });
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
            any_frequency_alias
                .map(|alias| {
                    Expr::col((alias.clone(), sigint_network_freq::Column::Id))
                        .is_null()
                })
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

fn join_analytics_unit_link_if_needed(
    query: &mut Select<signal_message::Entity>,
    prefix: &str,
    network_ids: &[i64],
    scope: &AnalyticsMessageIdScope,
) -> Option<Alias> {
    if network_ids.is_empty() {
        return None;
    }
    let link_alias = Alias::new(format!("{prefix}_link"));
    let network_alias = Alias::new(format!("{prefix}_network"));
    let frequency_alias = Alias::new(format!("{prefix}_frequency"));
    let message_datetime = Expr::col(sigint_inbox_item::Column::Datetime);
    QueryTrait::query(query)
        .join_as(
            JoinType::LeftJoin,
            (
                Alias::new("echo_clickhouse_derived"),
                Alias::new("message_network_link"),
            ),
            link_alias.clone(),
            analytics_unit_link_join_condition(
                link_alias.clone(),
                network_ids,
                scope,
            ),
        )
        .join_as(
            JoinType::LeftJoin,
            sigint_network::Entity,
            network_alias.clone(),
            analytics_unit_network_join_condition(
                network_alias.clone(),
                link_alias,
                message_datetime.clone(),
            ),
        )
        .join_as(
            JoinType::LeftJoin,
            sigint_network_freq::Entity,
            frequency_alias.clone(),
            analytics_unit_frequency_join_condition(
                frequency_alias.clone(),
                network_alias,
                message_datetime,
            ),
        );
    Some(frequency_alias)
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

async fn resolve_analytics_inbox_message_id_scope(
    req: &InboxMessagesReq,
    source_db: &DatabaseConnection,
    analytics_db: &DatabaseConnection,
    freshness_max_age_ms: u64,
) -> Result<Option<AnalyticsMessageIdScope>, AppError> {
    #[derive(FromQueryResult)]
    struct MessageIdBounds {
        min_id: Option<i64>,
        max_id: Option<i64>,
    }

    let mut since_date = req
        .since_date_inclusive_ms
        .map(dt_from_millis)
        .transpose()
        .context(h!())?;
    let mut till_date = req
        .till_date_inclusive_ms
        .map(dt_from_millis)
        .transpose()
        .context(h!())?;

    match req.sort_by.unwrap_or(InboxMessagesSortBy::IMSDatetime) {
        InboxMessagesSortBy::IMSDatetime => {
            if let Some(cursor_id) = req.since_id_noninclusive {
                let cursor_date =
                    sigint_inbox_item::Entity::find_by_id(cursor_id)
                        .select_only()
                        .column(sigint_inbox_item::Column::Datetime)
                        .into_tuple::<Option<NaiveDateTime>>()
                        .one(source_db)
                        .await
                        .context(h!())?
                        .flatten()
                        .context(h!())?;
                since_date =
                    Some(since_date.map_or(cursor_date, |since_date| {
                        std::cmp::max(since_date, cursor_date)
                    }));
            }
            if let Some(cursor_id) = req.before_id_noninclusive {
                let cursor_date =
                    sigint_inbox_item::Entity::find_by_id(cursor_id)
                        .select_only()
                        .column(sigint_inbox_item::Column::Datetime)
                        .into_tuple::<Option<NaiveDateTime>>()
                        .one(source_db)
                        .await
                        .context(h!())?
                        .flatten()
                        .context(h!())?;
                till_date = Some(till_date.map_or(cursor_date, |till_date| {
                    std::cmp::min(till_date, cursor_date)
                }));
            }
        }
        InboxMessagesSortBy::IMSTimestamp => {
            if let Some(cursor_id) = req.since_id_noninclusive {
                let cursor_date = signal_message::Entity::find_by_id(cursor_id)
                    .select_only()
                    .column(signal_message::Column::Timestamp)
                    .into_tuple::<Option<NaiveDateTime>>()
                    .one(source_db)
                    .await
                    .context(h!())?
                    .flatten()
                    .context(h!())?;
                since_date =
                    Some(since_date.map_or(cursor_date, |since_date| {
                        std::cmp::max(since_date, cursor_date)
                    }));
            }
            if let Some(cursor_id) = req.before_id_noninclusive {
                let cursor_date = signal_message::Entity::find_by_id(cursor_id)
                    .select_only()
                    .column(signal_message::Column::Timestamp)
                    .into_tuple::<Option<NaiveDateTime>>()
                    .one(source_db)
                    .await
                    .context(h!())?
                    .flatten()
                    .context(h!())?;
                till_date = Some(till_date.map_or(cursor_date, |till_date| {
                    std::cmp::min(till_date, cursor_date)
                }));
            }
        }
    }

    let bounds =
        match req.sort_by.unwrap_or(InboxMessagesSortBy::IMSDatetime) {
            InboxMessagesSortBy::IMSDatetime => {
                let query = sigint_inbox_item::Entity::find()
                    .select_only()
                    .column_as(sigint_inbox_item::Column::Id.min(), "min_id")
                    .column_as(sigint_inbox_item::Column::Id.max(), "max_id")
                    .apply_if(since_date, |query, since_date| {
                        query.filter(
                            sigint_inbox_item::Column::Datetime.gte(since_date),
                        )
                    })
                    .apply_if(till_date, |query, till_date| {
                        query.filter(
                            sigint_inbox_item::Column::Datetime.lte(till_date),
                        )
                    });
                query
                    .into_model::<MessageIdBounds>()
                    .one(analytics_db)
                    .await
                    .context(h!())?
            }
            InboxMessagesSortBy::IMSTimestamp => {
                let query = signal_message::Entity::find()
                    .select_only()
                    .column_as(signal_message::Column::Id.min(), "min_id")
                    .column_as(signal_message::Column::Id.max(), "max_id")
                    .apply_if(since_date, |query, since_date| {
                        query.filter(
                            signal_message::Column::Timestamp.gte(since_date),
                        )
                    })
                    .apply_if(till_date, |query, till_date| {
                        query.filter(
                            signal_message::Column::Timestamp.lte(till_date),
                        )
                    });
                query
                    .into_model::<MessageIdBounds>()
                    .one(analytics_db)
                    .await
                    .context(h!())?
            }
        }
        .unwrap_or(MessageIdBounds {
            min_id: None,
            max_id: None,
        });
    let (Some(min_id), Some(max_id)) = (bounds.min_id, bounds.max_id) else {
        return Ok(None);
    };
    if min_id <= 0 || max_id <= 0 {
        return Ok(None);
    }

    let freshness_max_age_ms =
        i64::try_from(freshness_max_age_ms).context(h!())?;
    let closed_range_cutoff =
        Utc::now().naive_utc() - Duration::milliseconds(freshness_max_age_ms);
    if analytics_inbox_scope_is_closed(req, till_date, closed_range_cutoff) {
        Ok(Some(AnalyticsMessageIdScope::Inclusive { min_id, max_id }))
    } else {
        Ok(Some(AnalyticsMessageIdScope::From(min_id)))
    }
}

fn analytics_inbox_scope_is_closed(
    req: &InboxMessagesReq,
    till_date: Option<NaiveDateTime>,
    closed_range_cutoff: NaiveDateTime,
) -> bool {
    inbox_request_is_unbounded_latest(req)
        || till_date.is_some_and(|till_date| till_date <= closed_range_cutoff)
}

pub(crate) async fn build_inbox_query(
    login: &uuid::Uuid,
    env: &Env,
    req: &InboxMessagesReq,
) -> Result<String, AppError> {
    build_inbox_query_with_internal_lower_bound(&env.dbx, login, env, req, None)
        .await
}

pub(crate) async fn build_inbox_query_with_internal_lower_bound<
    'a,
    'async_trait,
    C,
>(
    dbx: &'a C,
    login: &uuid::Uuid,
    env: &Env,
    req: &InboxMessagesReq,
    internal_lower_bound: Option<NaiveDateTime>,
) -> Result<String, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let q = build_filtered_inbox_query_with_scope(
        dbx,
        login,
        env,
        req,
        None,
        internal_lower_bound,
        InboxQueryPurpose::Messages,
    )
    .await
    .context(h!())?;
    finish_inbox_query(dbx, login, req, q, true).await
}

pub(crate) async fn build_postgres_fresh_tail_inbox_candidates_query(
    dbx: &DatabaseConnection,
    login: &uuid::Uuid,
    env: &Env,
    req: &InboxMessagesReq,
    created_at_lower_bound: NaiveDateTime,
) -> Result<String, AppError> {
    let query = build_filtered_inbox_query_with_scope(
        dbx,
        login,
        env,
        req,
        None,
        None,
        InboxQueryPurpose::Messages,
    )
    .await
    .context(h!())?
    .filter(signal_message::Column::CreatedAt.gte(created_at_lower_bound));
    Ok(render_inbox_digest_query(finish_inbox_candidates_query(
        query, req,
    )))
}

pub(crate) async fn build_inbox_query_for_candidate_ids(
    dbx: &DatabaseConnection,
    login: &uuid::Uuid,
    env: &Env,
    req: &InboxMessagesReq,
    candidate_ids: &[i64],
    apply_page_limit: bool,
) -> Result<String, AppError> {
    let query = build_filtered_inbox_query_with_scope(
        dbx,
        login,
        env,
        req,
        None,
        None,
        InboxQueryPurpose::Messages,
    )
    .await
    .context(h!())?
    .filter(signal_message::Column::Id.eq_any(candidate_ids.to_vec()));
    finish_inbox_query(dbx, login, req, query, apply_page_limit).await
}

async fn finish_inbox_query<'a, 'async_trait, C>(
    dbx: &'a C,
    login: &uuid::Uuid,
    req: &InboxMessagesReq,
    query: Select<signal_message::Entity>,
    apply_page_limit: bool,
) -> Result<String, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let q = add_inbox_message_columns(query);
    let q = get_bl_ordering_select(req, q).await.c(h!())?;
    let owner_organism_id =
        crate::tags::query::current_user_organism_id(dbx, login)
            .await
            .c(h!())?;

    let query_tags = sigint_inbox_item_tag::Entity::find()
        .select_only()
        .join(JoinType::InnerJoin, sigint_inbox_item_tag::Relation::Tag.def())
        .join(JoinType::LeftJoin, sigint_inbox_item_tag::Relation::Login.def())
        .expr_as(
            Expr::cust_with_exprs(
                "array_agg(distinct $1) filter (where $2 >= $3)",
                [
                    Expr::col((
                        sigint_inbox_item_tag::Entity,
                        sigint_inbox_item_tag::Column::TagId,
                    ))
                    .into_simple_expr(),
                    Expr::col((
                        sigint_inbox_item_tag::Entity,
                        sigint_inbox_item_tag::Column::Confidence,
                    ))
                    .into_simple_expr(),
                    Expr::val(TAG_MINIMUM_CONFIDENCE).into_simple_expr(),
                ],
            ),
            "tags",
        )
        .expr_as(
            Expr::cust_with_exprs(
                "jsonb_agg(jsonb_build_object('id', $1, 'sigint_inbox_item_id', $2, 'tag_id', $3, 'confidence', $4, 'login', $5, 'model', $6, 'organism_id', $7))",
                [
                    Expr::col((
                        sigint_inbox_item_tag::Entity,
                        sigint_inbox_item_tag::Column::Id,
                    ))
                    .into_simple_expr(),
                    Expr::col((
                        sigint_inbox_item_tag::Entity,
                        sigint_inbox_item_tag::Column::SigintInboxItemId,
                    ))
                    .into_simple_expr(),
                    Expr::col((
                        sigint_inbox_item_tag::Entity,
                        sigint_inbox_item_tag::Column::TagId,
                    ))
                    .into_simple_expr(),
                    Expr::col((
                        sigint_inbox_item_tag::Entity,
                        sigint_inbox_item_tag::Column::Confidence,
                    ))
                    .into_simple_expr(),
                    Expr::col((login::Entity, login::Column::Login))
                        .into_simple_expr(),
                    Expr::col((
                        sigint_inbox_item_tag::Entity,
                        sigint_inbox_item_tag::Column::Model,
                    ))
                    .into_simple_expr(),
                    Expr::col((login::Entity, login::Column::OrganismId))
                        .into_simple_expr(),
                ],
            ),
            "inbox_tags",
        )
        .filter(
            Expr::col((
                sigint_inbox_item_tag::Entity,
                sigint_inbox_item_tag::Column::SigintInboxItemId,
            ))
            .equals((signal_message::Entity, signal_message::Column::Id)),
        )
        .filter(crate::tags::query::accessible_tag_condition(
            owner_organism_id,
        ))
        .apply_if(
            req.without_model_tags.filter(|&flag| flag),
            |q, _| q.filter(sigint_inbox_item_tag::Column::Model.is_null()),
        )
        .group_by(sigint_inbox_item_tag::Column::SigintInboxItemId)
        .into_query();
    let query_metadata = build_inbox_metadata_lateral_query();

    let mut query = q.into_query();
    if apply_page_limit && req.nolimit != Some(true) {
        query.limit(INBOX_MESSAGES_PAGE_LIMIT as u64);
    }

    let q_tags = "q_tags";
    let q_metadata = "q_metadata";
    let sql = query
        .join_lateral(JoinType::LeftJoin, query_tags, q_tags, Expr::value(true))
        .join_lateral(
            JoinType::LeftJoin,
            query_metadata,
            q_metadata,
            Expr::value(true),
        )
        .column((q_tags, "tags"))
        .column((q_tags, "inbox_tags"))
        .column((q_metadata, "metadata"))
        .to_string(PostgresQueryBuilder);

    // println!("> Inbox items query: {sql}");
    Ok(sql)
}

/// Build pagination filters.
pub async fn get_pagination_filters<Q>(
    env: &Env,
    req: &InboxMessagesReq,
    q: Q,
) -> Result<Q, AppError>
where
    Q: QueryFilter,
{
    get_pagination_filters_with_conn(&env.dbx, env, req, q).await
}

pub async fn get_pagination_filters_with_conn<'a, 'async_trait, C, Q>(
    dbx: &'a C,
    _env: &Env,
    req: &InboxMessagesReq,
    q: Q,
) -> Result<Q, AppError>
where
    C: ConnectionTrait + 'async_trait,
    Q: QueryFilter,
{
    let mut q = q;
    let since_id_noninclusive: Option<i64> = req.since_id_noninclusive;

    // these are simple filters that double-check we don't accidentally show wrong data after we apply complex (more fragile) filter later in this method
    let req_sort_by = req.sort_by.unwrap_or(InboxMessagesSortBy::IMSDatetime);
    if let Some(since_date_inclusive_ms) = req.since_date_inclusive_ms {
        let datetime = dt_from_millis(since_date_inclusive_ms)?;
        q = q.filter(inbox_date_gte_expr(req_sort_by, datetime.into()));
    }
    if let Some(till_date_inclusive_ms) = req.till_date_inclusive_ms {
        let datetime = dt_from_millis(till_date_inclusive_ms)?;
        q = q.filter(inbox_date_lte_expr(req_sort_by, datetime.into()));
    }

    // here are more complex and nuanced filters
    '_if: {
        if let Some(since_id_noninclusive) = since_id_noninclusive {
            let Some(message) =
                SignalMessage::find_by_id(since_id_noninclusive)
                    // we want to query even if it got deleted
                    // .filter(signal_message::Column::Deleted.eq(false))
                    .one(dbx)
                    .await
                    .c(h!())?
            else {
                break '_if;
            };
            match req.sort_by.unwrap_or(InboxMessagesSortBy::IMSDatetime) {
                InboxMessagesSortBy::IMSDatetime => {
                    let Some(inbox) =
                        SigintInboxItem::find_by_id(since_id_noninclusive)
                            .one(dbx)
                            .await
                            .c(h!())?
                    else {
                        break '_if;
                    };
                    q = if let Some(datetime) = inbox.datetime {
                        let ts = to_ts_expr(datetime);
                        q.filter(
                            Expr::tuple([
                                sigint_inbox_item::Column::Datetime
                                    .into_column_ref()
                                    .into(),
                                Expr::cust("sigint_inbox_item.id"),
                                // signal_message::Column::Id.into_column_ref().into(),
                            ])
                            .gt(
                                SimpleExpr::Tuple(vec![
                                    ts,
                                    since_id_noninclusive.into(),
                                ]),
                            ),
                        )
                    } else {
                        q.filter(since_id_null_bucket_filter(
                            since_id_noninclusive,
                            sigint_inbox_item::Column::Datetime
                                .into_simple_expr(),
                            Expr::cust("sigint_inbox_item.id"),
                        ))
                    };
                }
                InboxMessagesSortBy::IMSTimestamp => {
                    q = if let Some(timestamp) = message.timestamp {
                        let ts = to_ts_expr(timestamp);
                        q.filter(
                            Expr::tuple([
                                signal_message::Column::Timestamp
                                    .into_column_ref()
                                    .into(),
                                Expr::cust("signal_message.id"),
                                // signal_message::Column::Id.into_column_ref().into(),
                            ])
                            .gt(
                                SimpleExpr::Tuple(vec![
                                    ts,
                                    since_id_noninclusive.into(),
                                ]),
                            ),
                        )
                    } else {
                        q.filter(since_id_null_bucket_filter(
                            since_id_noninclusive,
                            signal_message::Column::Timestamp
                                .into_simple_expr(),
                            Expr::cust("signal_message.id"),
                        ))
                    };
                }
            }
        }
        if let Some(before_id_noninclusive) = req.before_id_noninclusive {
            let Some(message) =
                SignalMessage::find_by_id(before_id_noninclusive)
                    // we want to query even if it got deleted
                    // .filter(signal_message::Column::Deleted.eq(false))
                    .one(dbx)
                    .await
                    .c(h!())?
            else {
                break '_if;
            };
            match req_sort_by {
                InboxMessagesSortBy::IMSDatetime => {
                    let Some(inbox) =
                        SigintInboxItem::find_by_id(before_id_noninclusive)
                            .one(dbx)
                            .await
                            .c(h!())?
                    else {
                        break '_if;
                    };
                    let Some(datetime) = inbox.datetime else {
                        break '_if;
                    };
                    let datetime = to_ts_expr(datetime);
                    q = q.filter(
                        Expr::tuple([
                            sigint_inbox_item::Column::Datetime
                                .into_column_ref()
                                .into(),
                            Expr::cust("sigint_inbox_item.id"),
                            // signal_message::Column::Id.into_column_ref().into(),
                        ])
                        .lt(SimpleExpr::Tuple(vec![
                            datetime,
                            before_id_noninclusive.into(),
                        ])),
                    );
                }
                InboxMessagesSortBy::IMSTimestamp => {
                    let Some(timestamp) = message.timestamp else {
                        break '_if;
                    };
                    let timestamp = to_ts_expr(timestamp);
                    q = q.filter(
                        Expr::tuple([
                            signal_message::Column::Timestamp
                                .into_column_ref()
                                .into(),
                            Expr::cust("signal_message.id"),
                            // signal_message::Column::Id.into_column_ref().into(),
                        ])
                        .lt(SimpleExpr::Tuple(vec![
                            timestamp,
                            before_id_noninclusive.into(),
                        ])),
                    );
                }
            }
        }
    }
    if let Some(since_date_inclusive_ms) = req.since_date_inclusive_ms {
        if req.since_id_noninclusive.is_none() {
            let ts = to_ts_expr(dt_from_millis(since_date_inclusive_ms)?);
            let req_sort_by =
                req.sort_by.unwrap_or(InboxMessagesSortBy::IMSDatetime);
            let exp = inbox_date_gte_expr(req_sort_by, ts);
            q = q.filter(exp);
        }
    }
    if let Some(till_date_inclusive_ms) = req.till_date_inclusive_ms {
        if req.before_id_noninclusive.is_none() {
            let ts = to_ts_expr(dt_from_millis(till_date_inclusive_ms)?);
            let req_sort_by =
                req.sort_by.unwrap_or(InboxMessagesSortBy::IMSDatetime);
            q = q.filter(inbox_date_lte_expr(req_sort_by, ts));
        }
    }

    Ok(q)
}

/// Build real lower bound for main query. (without deduplication time window extension)
pub async fn get_pagination_filter_real_lower_bound_stmt(
    env: &Env,
    req: &InboxMessagesReq,
    q: SelectStatement,
) -> Result<SelectStatement, AppError> {
    get_pagination_filter_real_lower_bound_stmt_with_conn(&env.dbx, env, req, q)
        .await
}

pub async fn get_pagination_filter_real_lower_bound_stmt_with_conn<
    'a,
    'async_trait,
    C,
>(
    dbx: &'a C,
    _env: &Env,
    req: &InboxMessagesReq,
    q: SelectStatement,
) -> Result<SelectStatement, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut q = q;
    if let Some(since_id_noninclusive) = req.since_id_noninclusive {
        let req_sort_by =
            req.sort_by.unwrap_or(InboxMessagesSortBy::IMSDatetime);
        match req_sort_by {
            InboxMessagesSortBy::IMSDatetime => {
                if let Some(inbox) =
                    SigintInboxItem::find_by_id(since_id_noninclusive)
                        .one(dbx)
                        .await
                        .c(h!())?
                {
                    if let Some(datetime) = inbox.datetime {
                        let datetime_expr = to_ts_expr(datetime);
                        q.and_where(
                            Expr::tuple([
                                sigint_inbox_item::Column::Datetime
                                    .into_simple_expr(),
                                inbox_items_cte_id_expr(),
                            ])
                            .gt(
                                SimpleExpr::Tuple(vec![
                                    datetime_expr,
                                    since_id_noninclusive.into(),
                                ]),
                            ),
                        );
                    } else {
                        q.and_where(since_id_null_bucket_filter(
                            since_id_noninclusive,
                            inbox_items_cte_cursor_expr(
                                InboxMessagesSortBy::IMSDatetime,
                            ),
                            inbox_items_cte_id_expr(),
                        ));
                    }
                }
            }
            InboxMessagesSortBy::IMSTimestamp => {
                if let Some(message) =
                    SignalMessage::find_by_id(since_id_noninclusive)
                        .filter(signal_message::Column::Deleted.eq(false))
                        .one(dbx)
                        .await
                        .c(h!())?
                {
                    if let Some(timestamp) = message.timestamp {
                        let timestamp_expr = to_ts_expr(timestamp);
                        q.and_where(
                            Expr::tuple([
                                signal_message::Column::Timestamp
                                    .into_simple_expr(),
                                inbox_items_cte_id_expr(),
                            ])
                            .gt(
                                SimpleExpr::Tuple(vec![
                                    timestamp_expr,
                                    since_id_noninclusive.into(),
                                ]),
                            ),
                        );
                    } else {
                        q.and_where(since_id_null_bucket_filter(
                            since_id_noninclusive,
                            inbox_items_cte_cursor_expr(
                                InboxMessagesSortBy::IMSTimestamp,
                            ),
                            inbox_items_cte_id_expr(),
                        ));
                    }
                }
            }
        }
    }
    if let Some(since_date_inclusive_ms) = req.since_date_inclusive_ms {
        if req.since_id_noninclusive.is_none() {
            let ts = dt_from_millis(since_date_inclusive_ms)?;
            let exp = match req.sort_by {
                Some(InboxMessagesSortBy::IMSTimestamp) => {
                    Expr::col(signal_message::Column::Timestamp)
                        .gte(to_ts_expr(ts))
                }
                _ => Expr::col(sigint_inbox_item::Column::Datetime)
                    .gte(to_ts_expr(ts)),
            };
            q.and_where(exp);
        }
    }
    Ok(q)
}

/// Build business logic ordering for Select<Entity> which inherits QueryFilter + QueryOrder
pub async fn get_bl_ordering_select<Q>(
    req: &InboxMessagesReq,
    q: Q,
) -> Result<Q, AppError>
where
    Q: QueryFilter + QueryOrder,
{
    let mut q = q;

    let req_sort_by = req.sort_by.unwrap_or(InboxMessagesSortBy::IMSDatetime);
    let mut m_order_asc: Option<bool> = None;
    if inbox_request_is_unbounded_latest(req) {
        m_order_asc = Some(false);
        q = q
            .order_by_desc(signal_message::Column::CreatedAt)
            .order_by_desc(signal_message::Column::Id);
    } else if let Some(true) = req.load_latest {
        m_order_asc = Some(false);
        match req_sort_by {
            InboxMessagesSortBy::IMSDatetime => {
                q = q
                    .order_by_desc(sigint_inbox_item::Column::Datetime)
                    .order_by_desc(signal_message::Column::Id);
            }
            InboxMessagesSortBy::IMSTimestamp => {
                q = q
                    .order_by_desc(signal_message::Column::Timestamp)
                    .order_by_desc(signal_message::Column::Id);
            }
        }
    }

    if m_order_asc.is_none() {
        if req.newest_first == Some(true)
            || req.before_id_noninclusive.is_some()
        {
            match req_sort_by {
                InboxMessagesSortBy::IMSDatetime => {
                    q = q
                        .order_by_desc(sigint_inbox_item::Column::Datetime)
                        .order_by_desc(signal_message::Column::Id);
                }
                InboxMessagesSortBy::IMSTimestamp => {
                    q = q
                        .order_by_desc(signal_message::Column::Timestamp)
                        .order_by_desc(signal_message::Column::Id);
                }
            }
            // m_order_asc = Some(false);
        } else {
            match req_sort_by {
                InboxMessagesSortBy::IMSDatetime => {
                    q = q
                        .order_by_asc(sigint_inbox_item::Column::Datetime)
                        .order_by_asc(signal_message::Column::Id);
                }
                InboxMessagesSortBy::IMSTimestamp => {
                    q = q
                        .order_by_asc(signal_message::Column::Timestamp)
                        .order_by_asc(signal_message::Column::Id);
                }
            }
            // m_order_asc = Some(true);
        }
    }

    Ok(q)
}

/// Build business logic ordering for SelectStatement
pub async fn get_bl_ordering_stmt(
    req: &InboxMessagesReq,
    q: SelectStatement,
) -> Result<SelectStatement, AppError> {
    let mut q = q;

    let req_sort_by = req.sort_by.unwrap_or(InboxMessagesSortBy::IMSDatetime);
    let mut m_order_asc: Option<bool> = None;
    if inbox_request_is_unbounded_latest(req) {
        m_order_asc = Some(false);
        q.order_by(signal_message::Column::CreatedAt, Order::Desc)
            .order_by(signal_message::Column::Id, Order::Desc);
    } else if let Some(true) = req.load_latest {
        m_order_asc = Some(false);
        match req_sort_by {
            InboxMessagesSortBy::IMSDatetime => {
                q.order_by(sigint_inbox_item::Column::Datetime, Order::Desc)
                    .order_by(signal_message::Column::Id, Order::Desc);
            }
            InboxMessagesSortBy::IMSTimestamp => {
                q.order_by(signal_message::Column::Timestamp, Order::Desc)
                    .order_by(signal_message::Column::Id, Order::Desc);
            }
        }
    }

    if m_order_asc.is_none() {
        if req.newest_first == Some(true)
            || req.before_id_noninclusive.is_some()
        {
            match req_sort_by {
                InboxMessagesSortBy::IMSDatetime => {
                    q.order_by(
                        sigint_inbox_item::Column::Datetime,
                        Order::Desc,
                    )
                    .order_by(signal_message::Column::Id, Order::Desc);
                }
                InboxMessagesSortBy::IMSTimestamp => {
                    q.order_by(signal_message::Column::Timestamp, Order::Desc)
                        .order_by(signal_message::Column::Id, Order::Desc);
                }
            }
            // m_order_asc = Some(false);
        } else {
            match req_sort_by {
                InboxMessagesSortBy::IMSDatetime => {
                    q.order_by(sigint_inbox_item::Column::Datetime, Order::Asc)
                        .order_by(signal_message::Column::Id, Order::Asc);
                }
                InboxMessagesSortBy::IMSTimestamp => {
                    q.order_by(signal_message::Column::Timestamp, Order::Asc)
                        .order_by(signal_message::Column::Id, Order::Asc);
                }
            }
            // m_order_asc = Some(true);
        }
    }
    Ok(q)
}

fn to_ts_expr(ts: NaiveDateTime) -> SimpleExpr {
    let ts = ts.format("%Y-%m-%d %H:%M:%S%.9f");
    let txt = format!("'{ts}'::timestamp at time zone 'UTC'");
    Expr::cust(txt)
}

pub fn add_inbox_message_columns<E>(select: Select<E>) -> Select<E>
where
    E: EntityTrait,
{
    select
        .select_only()
        .column_as(signal_message::Column::Id, "id")
        .column_as(signal_message::Column::Body, "body")
        .column_as(signal_message::Column::MessageUid, "message_uid")
        .column_as(signal_message::Column::CreatedAt, "created_at")
        .column_as(signal_message::Column::Timestamp, "timestamp")
        .column_as(preferred_sender_expr(None), "sender")
        .column_as(sigint_inbox_item::Column::Freq, "freq")
        .column_as(sigint_inbox_item::Column::Coords, "coords")
        .column_as(sigint_inbox_item::Column::CallsignTokens, "callsign_tokens")
        .column_as(sigint_inbox_item::Column::SignalTokens, "signal_tokens")
        .column_as(sigint_inbox_item::Column::KeywordTokens, "keyword_tokens")
        .column_as(sigint_inbox_item::Column::Location, "location")
        .column_as(sigint_inbox_item::Column::LocationV2, "location_v2")
        .column_as(sigint_inbox_item::Column::Date, "date")
        .column_as(sigint_inbox_item::Column::Time, "time")
        .column_as(sigint_inbox_item::Column::Checked, "checked")
        .column_as(sigint_inbox_item::Column::UnitV2, "unit_v2")
        .column_as(sigint_inbox_item::Column::Network, "network")
        .column_as(device_name::Column::Name, "device_name")
        .column_as(sigint_inbox_item::Column::PostId, "post_id")
        .column_as(sigint_inbox_item::Column::Datetime, "datetime")
        .column_as(sigint_post::Column::Name, "post_name")
}

pub fn build_inbox_metadata_lateral_query() -> SelectStatement {
    sigint_inbox_item_metadata::Entity::find()
        .select_only()
        .expr_as(
            Expr::cust_with_exprs(
                "jsonb_agg(jsonb_build_object('color_code', $1, 'color_code_start_index', $2, 'color_code_end_index', $3, 'call_group_id', $4, 'call_group_id_start_index', $5, 'call_group_id_end_index', $6, 'call_group_name', $7, 'call_group_name_start_index', $8, 'call_group_name_end_index', $9, 'sender_id', $10, 'sender_id_start_index', $11, 'sender_id_end_index', $12, 'sender_name', $13, 'sender_name_start_index', $14, 'sender_name_end_index', $15, 'hash_id', $16, 'hash_id_start_index', $17, 'hash_id_end_index', $18) ORDER BY $19)",
                [
                    Expr::col((
                        sigint_inbox_item_metadata::Entity,
                        sigint_inbox_item_metadata::Column::ColorCode,
                    ))
                    .into_simple_expr(),
                    Expr::col((
                        sigint_inbox_item_metadata::Entity,
                        sigint_inbox_item_metadata::Column::ColorCodeStartIndex,
                    ))
                    .into_simple_expr(),
                    Expr::col((
                        sigint_inbox_item_metadata::Entity,
                        sigint_inbox_item_metadata::Column::ColorCodeEndIndex,
                    ))
                    .into_simple_expr(),
                    Expr::col((
                        sigint_inbox_item_metadata::Entity,
                        sigint_inbox_item_metadata::Column::CallGroupId,
                    ))
                    .into_simple_expr(),
                    Expr::col((
                        sigint_inbox_item_metadata::Entity,
                        sigint_inbox_item_metadata::Column::CallGroupIdStartIndex,
                    ))
                    .into_simple_expr(),
                    Expr::col((
                        sigint_inbox_item_metadata::Entity,
                        sigint_inbox_item_metadata::Column::CallGroupIdEndIndex,
                    ))
                    .into_simple_expr(),
                    Expr::col((
                        sigint_inbox_item_metadata::Entity,
                        sigint_inbox_item_metadata::Column::CallGroupName,
                    ))
                    .into_simple_expr(),
                    Expr::col((
                        sigint_inbox_item_metadata::Entity,
                        sigint_inbox_item_metadata::Column::CallGroupNameStartIndex,
                    ))
                    .into_simple_expr(),
                    Expr::col((
                        sigint_inbox_item_metadata::Entity,
                        sigint_inbox_item_metadata::Column::CallGroupNameEndIndex,
                    ))
                    .into_simple_expr(),
                    Expr::col((
                        sigint_inbox_item_metadata::Entity,
                        sigint_inbox_item_metadata::Column::SenderId,
                    ))
                    .into_simple_expr(),
                    Expr::col((
                        sigint_inbox_item_metadata::Entity,
                        sigint_inbox_item_metadata::Column::SenderIdStartIndex,
                    ))
                    .into_simple_expr(),
                    Expr::col((
                        sigint_inbox_item_metadata::Entity,
                        sigint_inbox_item_metadata::Column::SenderIdEndIndex,
                    ))
                    .into_simple_expr(),
                    Expr::col((
                        sigint_inbox_item_metadata::Entity,
                        sigint_inbox_item_metadata::Column::SenderName,
                    ))
                    .into_simple_expr(),
                    Expr::col((
                        sigint_inbox_item_metadata::Entity,
                        sigint_inbox_item_metadata::Column::SenderNameStartIndex,
                    ))
                    .into_simple_expr(),
                    Expr::col((
                        sigint_inbox_item_metadata::Entity,
                        sigint_inbox_item_metadata::Column::SenderNameEndIndex,
                    ))
                    .into_simple_expr(),
                    Expr::col((
                        sigint_inbox_item_metadata::Entity,
                        sigint_inbox_item_metadata::Column::HashId,
                    ))
                    .into_simple_expr(),
                    Expr::col((
                        sigint_inbox_item_metadata::Entity,
                        sigint_inbox_item_metadata::Column::HashIdStartIndex,
                    ))
                    .into_simple_expr(),
                    Expr::col((
                        sigint_inbox_item_metadata::Entity,
                        sigint_inbox_item_metadata::Column::HashIdEndIndex,
                    ))
                    .into_simple_expr(),
                    Expr::col((
                        sigint_inbox_item_metadata::Entity,
                        sigint_inbox_item_metadata::Column::Id,
                    ))
                    .into_simple_expr(),
                ],
            ),
            "metadata",
        )
        .filter(
            Expr::col((
                sigint_inbox_item_metadata::Entity,
                sigint_inbox_item_metadata::Column::SigintInboxItemId,
            ))
            .equals((signal_message::Entity, signal_message::Column::Id)),
        )
        .group_by(sigint_inbox_item_metadata::Column::SigintInboxItemId)
        .into_query()
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm::sea_query::PostgresQueryBuilder;

    const TEST_CURSOR_ID: i64 = 4_101_055;

    #[test]
    fn null_bucket_filter_renders_expected_sql() {
        let expr = since_id_null_bucket_filter(
            TEST_CURSOR_ID,
            Expr::col((Alias::new("inbox_items_cte"), Alias::new("timestamp"))),
            Expr::col((Alias::new("inbox_items_cte"), Alias::new("id"))),
        );

        let sql = Query::select().expr(expr).to_string(PostgresQueryBuilder);
        let expected = format!(
            r#"SELECT "inbox_items_cte"."timestamp" IS NULL AND "inbox_items_cte"."id" > {TEST_CURSOR_ID}"#
        );

        assert_eq!(sql, expected);
    }

    #[test]
    fn timestamp_sort_upper_date_bound_uses_signal_timestamp() {
        let dt = chrono::NaiveDate::from_ymd_opt(2026, 6, 27)
            .unwrap()
            .and_hms_opt(9, 30, 0)
            .unwrap();
        let expr = inbox_date_lte_expr(
            InboxMessagesSortBy::IMSTimestamp,
            to_ts_expr(dt),
        );

        let sql = Query::select().expr(expr).to_string(PostgresQueryBuilder);

        assert!(sql.contains(r#"SELECT "timestamp" <= "#), "{sql}");
        assert!(!sql.contains(r#""datetime" <= "#), "{sql}");
    }

    #[test]
    fn message_access_filter_uses_correlated_exists() {
        let expr = message_is_accessible_exists(
            vec!["test-group".to_string()],
            None,
            false,
        );

        let sql = Query::select().expr(expr).to_string(PostgresQueryBuilder);

        assert!(sql.contains("EXISTS"), "{sql}");
        assert!(
            sql.contains(
                r#""signal_message_group"."signal_message_id" = "signal_message"."id""#
            ),
            "{sql}"
        );
        assert!(!sql.contains(" IN (SELECT"), "{sql}");
    }

    #[test]
    fn analytics_message_access_filter_applies_id_scope() {
        let scope = AnalyticsMessageIdScope::Inclusive {
            min_id: 12_000,
            max_id: 13_000,
        };
        let expr = message_is_accessible_exists(
            vec!["test-group".to_string()],
            Some(&scope),
            false,
        );

        let sql = Query::select().expr(expr).to_string(PostgresQueryBuilder);

        assert!(
            sql.contains(
                r#""signal_message_group"."signal_message_id" BETWEEN 12000 AND 13000"#
            ),
            "{sql}"
        );
    }

    #[test]
    fn indexed_message_access_filter_cannot_be_decorrelated() {
        let expr = message_is_accessible_exists(
            vec!["test-group".to_string()],
            None,
            true,
        );

        let sql = Query::select().expr(expr).to_string(PostgresQueryBuilder);

        assert!(sql.contains("OFFSET 0"), "{sql}");
    }

    #[test]
    fn digest_base_omits_message_hydration_joins() {
        let sql = build_inbox_query_base(
            &InboxMessagesReq::default(),
            InboxQueryPurpose::Digest,
        )
        .build(DatabaseBackend::Postgres)
        .to_string();

        assert!(sql.contains(r#"JOIN "sigint_inbox_item""#), "{sql}");
        assert!(!sql.contains(r#"JOIN "datasource_group""#), "{sql}");
        assert!(!sql.contains(r#"JOIN "signal_group""#), "{sql}");
        assert!(!sql.contains(r#"JOIN "sigint_post""#), "{sql}");
        assert!(!sql.contains(r#"JOIN "device_name""#), "{sql}");
    }

    #[test]
    fn digest_query_inlines_postgres_values() {
        let since = chrono::NaiveDate::from_ymd_opt(2026, 7, 30)
            .unwrap()
            .and_hms_opt(16, 0, 0)
            .unwrap();
        let till = since + Duration::hours(1);
        let query = build_inbox_query_base(
            &InboxMessagesReq::default(),
            InboxQueryPurpose::Digest,
        )
        .filter(sigint_inbox_item::Column::Datetime.gte(since))
        .filter(sigint_inbox_item::Column::Datetime.lte(till))
        .select_only()
        .column_as(Expr::cust("COUNT(*)"), "count")
        .column_as(
            Expr::cust(r#"MIN("signal_message"."timestamp")"#),
            "first_element_ts",
        );

        let sql = render_inbox_digest_query(query);

        assert!(sql.contains("2026-07-30 16:00:00"), "{sql}");
        assert!(sql.contains("2026-07-30 17:00:00"), "{sql}");
        assert!(!sql.contains('$'), "digest SQL must inline values: {sql}");
    }

    #[test]
    fn indexed_digest_base_uses_lateral_message_lookup() {
        let sql = build_inbox_query_base(
            &InboxMessagesReq::default(),
            InboxQueryPurpose::IndexedDigest,
        )
        .build(DatabaseBackend::Postgres)
        .to_string();

        assert!(
            sql.contains(r#"FROM "sigint_inbox_item" INNER JOIN LATERAL"#),
            "{sql}"
        );
        assert!(
            sql.contains(r#"OFFSET 0) AS "signal_message" ON TRUE"#),
            "{sql}"
        );
        assert!(!sql.contains(r#"JOIN "datasource_group""#), "{sql}");
        assert!(!sql.contains(r#"JOIN "device_name""#), "{sql}");
    }

    #[test]
    fn short_datetime_digest_uses_indexed_query() {
        let since = 1_785_182_400_000;
        let short = InboxMessagesReq {
            since_date_inclusive_ms: Some(since),
            till_date_inclusive_ms: Some(
                since
                    + Duration::days(INBOX_COUNT_INDEXED_MAX_DAYS)
                        .num_milliseconds(),
            ),
            ..Default::default()
        };
        assert!(inbox_count_uses_indexed_query(&short));

        let long = InboxMessagesReq {
            till_date_inclusive_ms: Some(
                since
                    + Duration::days(INBOX_COUNT_INDEXED_MAX_DAYS + 1)
                        .num_milliseconds(),
            ),
            ..short.clone()
        };
        assert!(!inbox_count_uses_indexed_query(&long));

        let timestamp_sorted = InboxMessagesReq {
            sort_by: Some(InboxMessagesSortBy::IMSTimestamp),
            ..short
        };
        assert!(!inbox_count_uses_indexed_query(&timestamp_sorted));
    }

    #[test]
    fn unit_filtered_digest_uses_flat_joined_query() {
        let req = InboxMessagesReq {
            selected_units: Some(vec!["100 pbr".to_string()]),
            denied_units: Some(vec!["200 pbr".to_string()]),
            ..Default::default()
        };
        let query = build_inbox_query_base(&req, InboxQueryPurpose::Digest);
        let query = filter_selected_units(
            query,
            &req.selected_units,
            &req.units_exact_match_only,
        )
        .unwrap();
        let query = filter_denied_units(
            query,
            &req.denied_units,
            &req.units_exact_match_only,
        )
        .unwrap()
        .select_only()
        .column_as(Expr::cust("COUNT(*)"), "count")
        .column_as(
            Expr::cust(r#"MIN("signal_message"."timestamp")"#),
            "first_element_ts",
        );
        let sql = render_inbox_digest_query(query);

        assert!(sql.contains(r#"LEFT JOIN "sigint_inbox_item""#), "{sql}");
        assert!(!sql.contains("inbox_count_candidates"), "{sql}");
        assert!(!sql.contains("LATERAL"), "{sql}");
        assert!(sql.contains(r#""unit_v2" = ANY(ARRAY"#), "{sql}");
        assert!(sql.contains(r#""unit_v2" <> ALL(ARRAY"#), "{sql}");
        for alias in ["100 PBR", "100 pbr", "200 PBR", "200 pbr"] {
            assert!(sql.contains(&format!("'{alias}'")), "{sql}");
        }
        assert!(!sql.contains("lower("), "{sql}");
    }

    #[test]
    fn analytics_unit_digest_uses_flat_scoped_joins() {
        let resolved = ResolvedAnalyticsUnitFilters {
            selected: ResolvedAnalyticsUnitFilter {
                ordinary_names: vec!["selected unit".to_string()],
                linked_network_ids: vec![11, 12],
                present: true,
                ..Default::default()
            },
            denied: ResolvedAnalyticsUnitFilter {
                ordinary_names: vec!["denied unit".to_string()],
                linked_network_ids: vec![21],
                present: true,
                ..Default::default()
            },
            ..Default::default()
        };
        let scope = AnalyticsMessageIdScope::Inclusive {
            min_id: 12_000,
            max_id: 13_000,
        };
        let query = apply_resolved_analytics_unit_filters(
            build_inbox_query_base(
                &InboxMessagesReq::default(),
                InboxQueryPurpose::Digest,
            ),
            &resolved,
            &scope,
            false,
        )
        .select_only()
        .column_as(
            Expr::cust(r#"COUNT(DISTINCT "signal_message"."id")"#),
            "count",
        );
        let sql = render_inbox_digest_query(query);

        assert_eq!(
            sql.matches(
                r#"LEFT JOIN "echo_clickhouse_derived"."message_network_link""#
            )
            .count(),
            2,
            "{sql}"
        );
        assert_eq!(sql.matches(r#"LEFT JOIN "sigint_network""#).count(), 2);
        assert_eq!(
            sql.matches(r#"LEFT JOIN "sigint_network_freq""#).count(),
            2
        );
        assert_eq!(sql.matches("BETWEEN 12000 AND 13000").count(), 2);
        assert!(sql.contains("COUNT(DISTINCT"), "{sql}");
        assert!(sql.contains("selected unit"), "{sql}");
        assert!(sql.contains("denied unit"), "{sql}");
        assert!(!sql.contains(r#"JOIN "sigint_unit""#), "{sql}");
        assert!(!sql.contains(r#"JOIN "sigint_network_unit""#), "{sql}");
        assert!(!sql.contains("EXISTS"), "{sql}");
    }

    #[test]
    fn analytics_unit_digest_preserves_undefined_and_active_window_filters() {
        let resolved = ResolvedAnalyticsUnitFilters {
            selected: ResolvedAnalyticsUnitFilter {
                includes_undefined: true,
                present: true,
                ..Default::default()
            },
            denied: ResolvedAnalyticsUnitFilter {
                ordinary_names: vec!["denied unit".to_string()],
                linked_network_ids: vec![21],
                present: true,
                ..Default::default()
            },
            all_unit_network_ids: vec![11, 21],
        };
        let query = apply_resolved_analytics_unit_filters(
            build_inbox_query_base(
                &InboxMessagesReq::default(),
                InboxQueryPurpose::Digest,
            ),
            &resolved,
            &AnalyticsMessageIdScope::From(10_000),
            true,
        );
        let sql = render_inbox_digest_query(query);

        assert!(sql.contains("analytics_any_unit_frequency"), "{sql}");
        assert!(sql.contains(r#""unit_v2" IS NULL"#), "{sql}");
        assert!(sql.contains(r#""unit_v2" = ''"#), "{sql}");
        assert!(sql.contains(r#""deleted" = FALSE"#), "{sql}");
        assert!(sql.contains(r#""active_from" <= "datetime""#), "{sql}");
        assert!(sql.contains(r#""active_to" >= "datetime""#), "{sql}");
        assert!(
            !sql.contains(r#""unit_v2" IN ('denied unit')"#),
            "exact-only filtering must ignore header units: {sql}"
        );
    }

    #[test]
    fn analytics_unit_filter_splits_ordinary_and_undefined_values() {
        let unit_filter = split_analytics_unit_filter(&Some(vec![
            "58 А".to_string(),
            "58 а".to_string(),
            "Не визначено".to_string(),
            "".to_string(),
            "58 А".to_string(),
        ]));

        assert!(unit_filter.present);
        assert!(unit_filter.includes_undefined);
        for alias in ["58 А", "58 а", "58 ЗА", "58 за", "58 ЗВА", "58 зва"]
        {
            assert!(unit_filter.ordinary_names.contains(&alias.to_string()));
        }
        assert_eq!(unit_filter.ordinary_names.len(), 6);
    }

    #[test]
    fn analytics_selected_and_denied_headers_share_unit_aliases() {
        let resolved = ResolvedAnalyticsUnitFilters {
            selected: split_analytics_unit_filter(&Some(vec![
                "58 А".to_string()
            ])),
            denied: split_analytics_unit_filter(&Some(vec![
                "136 ОМСБР".to_string()
            ])),
            ..Default::default()
        };
        let sql =
            render_inbox_digest_query(apply_resolved_analytics_unit_filters(
                build_inbox_query_base(
                    &InboxMessagesReq::default(),
                    InboxQueryPurpose::Analytics,
                ),
                &resolved,
                &AnalyticsMessageIdScope::From(1),
                false,
            ));

        for alias in ["58 А", "58 а", "58 ЗА", "58 за", "58 ЗВА", "58 зва"]
        {
            assert!(sql.contains(&format!("'{alias}'")), "{sql}");
        }
        assert!(sql.contains("'136 ОМСБР'"), "{sql}");
        assert!(sql.contains("'136 омсбр'"), "{sql}");
        assert!(!sql.contains("lower("), "{sql}");
    }

    #[test]
    fn analytics_group_filters_use_flat_scoped_joins() {
        let req = InboxMessagesReq {
            selected_groups: Some(vec![
                "allowed-selected".to_string(),
                "inaccessible".to_string(),
            ]),
            selected_senders: Some(vec!["selected-sender".to_string()]),
            denied_groups: Some(vec!["allowed-denied".to_string()]),
            denied_senders: Some(vec!["denied-sender".to_string()]),
            ..Default::default()
        };
        let query = apply_flat_analytics_group_filters(
            build_inbox_query_base(&req, InboxQueryPurpose::Analytics),
            &req,
            &["allowed-selected".to_string(), "allowed-denied".to_string()],
            &AnalyticsMessageIdScope::Inclusive {
                min_id: 12_000,
                max_id: 13_000,
            },
        );
        let sql = render_inbox_digest_query(query);

        assert!(
            sql.contains(
                r#"INNER JOIN "signal_message_group" AS "analytics_access_group""#
            ),
            "{sql}"
        );
        assert!(sql.contains(r#"AS "analytics_denied_group""#), "{sql}");
        assert!(sql.contains(r#"AS "analytics_denied_sender""#), "{sql}");
        assert_eq!(sql.matches("BETWEEN 12000 AND 13000").count(), 3);
        assert!(sql.contains("selected-sender"), "{sql}");
        assert!(sql.contains("denied-sender"), "{sql}");
        assert!(!sql.contains("inaccessible"), "{sql}");
        assert!(!sql.contains("EXISTS"), "{sql}");
    }

    #[test]
    fn analytics_aor_filter_uses_resolved_flat_scoped_joins() {
        let resolved = ResolvedAnalyticsAorFilter {
            group_keys: vec!["group-a".to_string()],
            network_ids: vec![11, 12],
            present: true,
        };
        let query = apply_resolved_analytics_aor_filter(
            build_inbox_query_base(
                &InboxMessagesReq::default(),
                InboxQueryPurpose::Analytics,
            ),
            &resolved,
            &AnalyticsMessageIdScope::Inclusive {
                min_id: 12_000,
                max_id: 13_000,
            },
        );
        let sql = render_inbox_digest_query(query);

        assert!(
            sql.contains(
                r#"LEFT JOIN "signal_message_group" AS "analytics_selected_aor_group""#
            ),
            "{sql}"
        );
        assert!(
            sql.contains(
                r#"LEFT JOIN "sigint_inbox_item_network" AS "analytics_selected_aor_network""#
            ),
            "{sql}"
        );
        assert_eq!(sql.matches("BETWEEN 12000 AND 13000").count(), 2);
        assert!(sql.contains("group-a"), "{sql}");
        assert!(sql.contains("IN (11, 12)"), "{sql}");
        assert!(!sql.contains("area_of_responsibility"), "{sql}");
        assert!(!sql.contains("EXISTS"), "{sql}");
    }

    #[test]
    fn analytics_aor_overlap_is_inclusive() {
        assert!(analytics_aor_bounds_overlap((1.0, 2.0), (2.0, 3.0)));
        assert!(analytics_aor_bounds_overlap((1.0, 4.0), (2.0, 3.0)));
        assert!(analytics_aor_bounds_overlap((2.0, 3.0), (1.0, 4.0)));
        assert!(!analytics_aor_bounds_overlap((1.0, 2.0), (3.0, 4.0)));
    }

    #[test]
    fn analytics_candidates_group_order_and_limit_remain_remote() {
        let resolved = ResolvedAnalyticsUnitFilters {
            selected: ResolvedAnalyticsUnitFilter {
                ordinary_names: vec!["selected unit".to_string()],
                linked_network_ids: vec![11],
                present: true,
                ..Default::default()
            },
            ..Default::default()
        };
        let req = InboxMessagesReq {
            load_latest: Some(true),
            ..Default::default()
        };
        let query = apply_flat_analytics_group_filters(
            build_inbox_query_base(&req, InboxQueryPurpose::Analytics),
            &req,
            &["allowed-group".to_string()],
            &AnalyticsMessageIdScope::Inclusive {
                min_id: 12_000,
                max_id: 13_000,
            },
        );
        let query = apply_resolved_analytics_unit_filters(
            query,
            &resolved,
            &AnalyticsMessageIdScope::Inclusive {
                min_id: 12_000,
                max_id: 13_000,
            },
            false,
        );
        let sql = render_inbox_digest_query(finish_inbox_candidates_query(
            query, &req,
        ));

        assert!(sql.contains(r#"AS "ordering_value""#), "{sql}");
        assert!(
            sql.contains(
                r#""signal_message"."created_at" AS "ordering_value""#
            ),
            "{sql}"
        );
        assert!(sql.contains("GROUP BY"), "{sql}");
        assert!(
            sql.contains(
                r#"ORDER BY "ordering_value" DESC, "signal_message"."id" DESC"#
            ),
            "{sql}"
        );
        assert!(
            sql.contains(
                r#"GROUP BY "signal_message"."id", "signal_message"."created_at""#
            ),
            "{sql}"
        );
        assert!(sql.ends_with("LIMIT 20"), "{sql}");
        assert!(
            sql.contains(
                r#"INNER JOIN "signal_message_group" AS "analytics_access_group""#
            ),
            "{sql}"
        );
        assert!(!sql.contains("EXISTS"), "{sql}");
        assert_eq!(
            sql.matches(
                r#"LEFT JOIN "echo_clickhouse_derived"."message_network_link""#
            )
            .count(),
            1,
            "{sql}"
        );
    }

    #[test]
    fn analytics_candidates_use_requested_timestamp_order() {
        let req = InboxMessagesReq {
            sort_by: Some(InboxMessagesSortBy::IMSTimestamp),
            ..Default::default()
        };
        let sql = render_inbox_digest_query(finish_inbox_candidates_query(
            build_inbox_query_base(&req, InboxQueryPurpose::Digest),
            &req,
        ));

        assert!(
            sql.contains(r#""signal_message"."timestamp" AS "ordering_value""#),
            "{sql}"
        );
        assert!(
            sql.contains(
                r#"ORDER BY "ordering_value" ASC, "signal_message"."id" ASC"#
            ),
            "{sql}"
        );
    }

    #[test]
    fn analytics_candidates_qualify_datetime_ordering() {
        let req = InboxMessagesReq::default();
        let sql = render_inbox_digest_query(finish_inbox_candidates_query(
            build_inbox_query_base(&req, InboxQueryPurpose::Digest),
            &req,
        ));

        assert!(
            sql.contains(
                r#""sigint_inbox_item"."datetime" AS "ordering_value""#
            ),
            "{sql}"
        );
        assert!(
            sql.contains(
                r#"GROUP BY "signal_message"."id", "sigint_inbox_item"."datetime""#
            ),
            "{sql}"
        );
    }

    #[test]
    fn initial_latest_analytics_candidates_use_a_closed_mirror_scope() {
        let cutoff = chrono::NaiveDate::from_ymd_opt(2026, 8, 9)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap();
        let initial = InboxMessagesReq {
            load_latest: Some(true),
            ..Default::default()
        };
        assert!(analytics_inbox_scope_is_closed(&initial, None, cutoff));

        let bounded = InboxMessagesReq {
            since_id_noninclusive: Some(1),
            ..Default::default()
        };
        assert!(!analytics_inbox_scope_is_closed(&bounded, None, cutoff));
        assert!(analytics_inbox_scope_is_closed(
            &bounded,
            Some(cutoff - Duration::seconds(1)),
            cutoff,
        ));
    }

    #[test]
    fn bounded_unit_digest_precomputes_matching_inbox_ids() {
        let dt_since = chrono::NaiveDate::from_ymd_opt(2026, 7, 28)
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap();
        let req = InboxMessagesReq {
            selected_units: Some(vec!["100 pbr".to_string()]),
            ..Default::default()
        };
        let query = build_inbox_query_base(&req, InboxQueryPurpose::Digest);
        let sql = build_period_unit_filtered_inbox_digest(
            &req,
            query,
            dt_since,
            dt_since + Duration::days(1),
        )
        .unwrap();

        assert!(!sql.contains("inbox_count_candidates"), "{sql}");
        assert_eq!(sql.matches("MATERIALIZED").count(), 2, "{sql}");
        assert!(sql.contains("matching_unit_network_ids"), "{sql}");
        assert!(sql.contains("matching_unit_inbox_item_ids"), "{sql}");
        assert!(
            !sql.contains('$'),
            "digest SQL must inline PostgreSQL values: {sql}"
        );
    }

    #[test]
    fn digest_base_joins_posts_only_for_post_filters() {
        let req = InboxMessagesReq {
            selected_posts: Some(vec!["post".to_string()]),
            ..Default::default()
        };
        let sql = build_inbox_query_base(&req, InboxQueryPurpose::Digest)
            .build(DatabaseBackend::Postgres)
            .to_string();

        assert!(sql.contains(r#"JOIN "sigint_post""#), "{sql}");
        assert!(!sql.contains(r#"JOIN "device_name""#), "{sql}");
    }

    #[test]
    fn digest_ignore_filter_uses_correlated_exists() {
        let sql = Query::select()
            .expr(message_source_group_is_not_ignored_exists())
            .to_string(PostgresQueryBuilder);

        assert!(sql.contains("EXISTS"), "{sql}");
        assert!(
            sql.contains(
                r#""datasource_group"."id" = "signal_message"."datasource_group_id""#
            ),
            "{sql}"
        );
        assert!(sql.contains(r#"INNER JOIN "signal_group""#), "{sql}");
    }

    #[test]
    fn analytics_ignore_filter_uses_flat_joins() {
        let sql = render_inbox_digest_query(
            apply_flat_analytics_imported_coords_filter(
                build_inbox_query_base(
                    &InboxMessagesReq::default(),
                    InboxQueryPurpose::Analytics,
                ),
            ),
        );

        assert!(sql.contains(r#"INNER JOIN "datasource_group""#), "{sql}");
        assert!(sql.contains(r#"INNER JOIN "signal_group""#), "{sql}");
        assert!(sql.contains(r#""ignore_operativny" = FALSE"#), "{sql}");
        assert!(!sql.contains("EXISTS"), "{sql}");
    }

    #[test]
    fn only_explicit_latest_request_allows_no_bounds() {
        let unbounded = InboxMessagesReq::default();
        assert!(inbox_request_is_unbounded(&unbounded));
        assert!(!inbox_request_is_unbounded_latest(&unbounded));

        let latest = InboxMessagesReq {
            load_latest: Some(true),
            ..Default::default()
        };
        assert!(inbox_request_is_unbounded_latest(&latest));

        let bounded = InboxMessagesReq {
            since_id_noninclusive: Some(TEST_CURSOR_ID),
            ..latest
        };
        assert!(!inbox_request_is_unbounded(&bounded));
        assert!(!inbox_request_is_unbounded_latest(&bounded));
    }

    #[tokio::test]
    async fn unbounded_latest_orders_by_created_at_index_columns() {
        let req = InboxMessagesReq {
            load_latest: Some(true),
            ..Default::default()
        };
        let query = get_bl_ordering_select(&req, SignalMessage::find())
            .await
            .unwrap()
            .build(DatabaseBackend::Postgres)
            .to_string();

        assert!(
            query.contains(
                r#"ORDER BY "signal_message"."created_at" DESC, "signal_message"."id" DESC"#
            ),
            "{query}"
        );
    }
}
