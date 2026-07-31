use crate::config::{INBOX_COUNT_INDEXED_MAX_DAYS, TAG_MINIMUM_CONFIDENCE};
use crate::entities::{prelude::*, *};
use crate::error::AppError;
use crate::rer_importer::analysis::*;
use crate::rer_importer::types::*;
use crate::sigint::sender::preferred_sender_expr;
use crate::types::*;
use crate::utils::orm::ArrayColumnOps;
use crate::utils::*;
use chrono::{Duration, NaiveDateTime, Utc};
use sea_orm::{sea_query::PostgresQueryBuilder, *};
use sea_query::types::IntoColumnRef;
use sea_query::{Alias, Expr, ExprTrait, Query, SelectStatement, SimpleExpr};

fn since_id_null_bucket_filter(
    since_id_noninclusive: i64,
    cursor_expr: SimpleExpr,
    id_expr: SimpleExpr,
) -> SimpleExpr {
    cursor_expr.is_null().and(id_expr.gt(since_id_noninclusive))
}

fn inbox_items_cte_id_expr() -> SimpleExpr {
    Expr::col((Alias::new("inbox_items_cte"), Alias::new("id"))).into()
}

fn inbox_items_cte_cursor_expr(req_sort_by: InboxMessagesSortBy) -> SimpleExpr {
    match req_sort_by {
        InboxMessagesSortBy::IMSDatetime => {
            Expr::col((Alias::new("inbox_items_cte"), Alias::new("datetime")))
                .into()
        }
        InboxMessagesSortBy::IMSTimestamp => {
            Expr::col((Alias::new("inbox_items_cte"), Alias::new("timestamp")))
                .into()
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
        .all(|units| {
            units.as_ref().is_none_or(|units| {
                units
                    .iter()
                    .all(|unit| !unit.is_empty() && unit != "Не визначено")
            })
        })
}

async fn build_filtered_inbox_query_with_scope<'a, 'async_trait, C>(
    dbx: &'a C,
    login: &uuid::Uuid,
    env: &Env,
    req: &InboxMessagesReq,
    scope: Option<&AnalyticsMessageIdScope>,
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

    q = q.filter(signal_message::Column::Deleted.eq(false)).filter(
        message_is_accessible_exists(
            sigint_groups.clone(),
            scope,
            purpose == InboxQueryPurpose::IndexedDigest,
        ),
    );
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
    let q = filter_denied_senders_with_scope(q, &req.denied_senders, scope)?;
    let q = filter_selected_freqs(q, &req.selected_freqs)?;
    let q = filter_denied_freqs(q, &req.denied_freqs)?;
    let q = filter_selected_posts(q, &req.selected_posts)?;
    let q = filter_denied_posts(q, &req.denied_posts)?;
    let q = filter_selected_callsigns(q, &req.selected_callsigns)?;
    let q = filter_search(q, &req.search)?;
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
        &env.dbx, login, env, req, None, purpose,
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
        &env.dbx, login, env, req, None, purpose,
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
    let Some(scope) = resolve_analytics_inbox_message_id_scope(
        req,
        &env.dbx,
        db,
        freshness_max_age_ms,
    )
    .await?
    else {
        return Ok(None);
    };
    let q = build_filtered_inbox_query_with_scope(
        &env.dbx,
        login,
        env,
        req,
        Some(&scope),
        InboxQueryPurpose::Digest,
    )
    .await
    .context(h!())?
    .select_only()
    .column_as(Expr::cust("COUNT(*)"), "count")
    .column_as(
        Expr::cust(r#"MIN("signal_message"."timestamp")"#),
        "first_element_ts",
    );

    Ok(Some(render_inbox_digest_query(q)))
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
                        since_date.max(cursor_date)
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
                    till_date.min(cursor_date)
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
                        since_date.max(cursor_date)
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
                    till_date.min(cursor_date)
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
    if till_date.is_some_and(|till_date| till_date <= closed_range_cutoff) {
        Ok(Some(AnalyticsMessageIdScope::Inclusive { min_id, max_id }))
    } else {
        Ok(Some(AnalyticsMessageIdScope::From(min_id)))
    }
}

pub(crate) async fn build_inbox_query(
    login: &uuid::Uuid,
    env: &Env,
    req: &InboxMessagesReq,
) -> Result<String, AppError> {
    build_inbox_query_with_conn(&env.dbx, login, env, req).await
}

pub(crate) async fn build_inbox_query_with_conn<'a, 'async_trait, C>(
    dbx: &'a C,
    login: &uuid::Uuid,
    env: &Env,
    req: &InboxMessagesReq,
) -> Result<String, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let q = build_filtered_inbox_query(dbx, login, env, req)
        .await
        .context(h!())?;
    let q = add_inbox_message_columns(q);
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
    if req.nolimit != Some(true) {
        query.limit(20);
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
            Expr::col((Alias::new("inbox_items_cte"), Alias::new("timestamp")))
                .into(),
            Expr::col((Alias::new("inbox_items_cte"), Alias::new("id"))).into(),
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
        assert!(
            sql.contains(r#""unit_v2" = ANY(ARRAY ['100 pbr'])"#),
            "{sql}"
        );
        assert!(
            sql.contains(r#""unit_v2" <> ALL(ARRAY ['200 pbr'])"#),
            "{sql}"
        );
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
