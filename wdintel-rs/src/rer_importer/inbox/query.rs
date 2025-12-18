use crate::config::{RER_DUTY_MAX_DAYS, TAG_MINIMUM_CONFIDENCE};
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
use sea_query::{Expr, Query, SelectStatement, SimpleExpr};

pub(crate) async fn build_inbox_query(
    login: &str,
    logins: &Vec<String>,
    env: &Env,
    req: &InboxMessagesReq,
) -> Result<String, AppError> {
    let sigint_groups =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, login)
            .await
            .c(h!())?;

    let mut q = SignalMessage::find()
        .join(
            JoinType::LeftJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
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
        );

    let access_subquery = Query::select()
        .column(signal_message_group::Column::SignalMessageId)
        .from(signal_message_group::Entity)
        .and_where(
            signal_message_group::Column::GroupMasterKey
                .eq_any(sigint_groups.clone()),
        )
        .to_owned();

    q = add_inbox_message_columns(q)
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(signal_message::Column::Id.in_subquery(access_subquery));

    if req.ignore_imported_coords.unwrap_or(false) {
        q = q.filter(signal_group::Column::IgnoreOperativny.eq(Some(false)));
    }

    let mut only_tags_by_logins = None;
    if req.report_tags_only_this_unit == Some(true) {
        only_tags_by_logins = Some(logins.clone());
    }

    if req.only_show_unprocessed == Some(true) {
        q = q.filter(sigint_inbox_item::Column::Reviewed.ne(Some(true)));
    }
    if req.checked_only == Some(true) {
        q = q.filter(sigint_inbox_item::Column::Checked.eq(Some(true)));
    }
    let q = filter_selected_groups(q, &req.selected_groups)?;
    let q = filter_selected_senders(q, &req.selected_senders)?;
    let q = filter_denied_senders(q, &req.denied_senders)?;
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
    let q = filter_selected_tags(
        q,
        &req.selected_tags,
        &req.or_bookmarked,
        &req.or_important,
        &req.or_with_coords,
        &req.or_with_extended_form,
        &req.filter_tags_option,
        &req.without_model_tags,
        login,
        only_tags_by_logins,
        req.report_tags_only_this_unit.unwrap_or(false),
    )?;
    let q = filter_selected_aors(q, &req.selected_aors).context(h!())?;
    let q =
        filter_selected_networks(q, &req.selected_networks).context(h!())?;
    let include_peleng_locations =
        req.include_peleng_locations.unwrap_or(false);
    let mut q = filter_selected_locations(
        q,
        &req.selected_locations,
        include_peleng_locations,
    )?;

    if req.since_id_noninclusive.is_none()
        && req.since_date_inclusive_ms.is_none()
    {
        // TODO FIXME filter by 1 days
        q =
            q.filter(signal_message::Column::Timestamp.gte(
                Utc::now().naive_utc() - Duration::days(RER_DUTY_MAX_DAYS),
            ));
    }

    q = get_pagination_filters(env, req, q).await.c(h!())?;
    let q = get_bl_ordering_select(req, q).await.c(h!())?;

    let query_tags = sigint_inbox_item_tag::Entity::find()
        .select_only()
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
                    Expr::col((
                        sigint_inbox_item_tag::Entity,
                        sigint_inbox_item_tag::Column::Login,
                    ))
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
        .apply_if(
            req.without_model_tags.and_then(|flag| {
                if flag {
                    Some(flag)
                } else {
                    None
                }
            }),
            |q, _| q.filter(sigint_inbox_item_tag::Column::Model.is_null()),
        )
        .group_by(sigint_inbox_item_tag::Column::SigintInboxItemId)
        .into_query();

    let mut query = q.into_query();
    if req.nolimit != Some(true) {
        query.limit(20);
    }

    let q_tags = "q_tags";
    let sql = query
        .join_lateral(JoinType::LeftJoin, query_tags, q_tags, Expr::value(true))
        .column((q_tags, "tags"))
        .column((q_tags, "inbox_tags"))
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
    let mut q = q;
    let since_id_noninclusive: Option<i64> = req.since_id_noninclusive;

    // these are simple filters that double-check we don't accidentally show wrong data after we apply complex (more fragile) filter later in this method
    let req_sort_by = req.sort_by.unwrap_or(InboxMessagesSortBy::IMSDatetime);
    match req_sort_by {
        InboxMessagesSortBy::IMSDatetime => {
            if let Some(since_date_inclusive_ms) = req.since_date_inclusive_ms {
                let datetime = dt_from_millis(since_date_inclusive_ms)?;
                q = q.filter(sigint_inbox_item::Column::Datetime.gte(datetime));
            }
            if let Some(till_date_inclusive_ms) = req.till_date_inclusive_ms {
                let datetime = dt_from_millis(till_date_inclusive_ms)?;
                q = q.filter(sigint_inbox_item::Column::Datetime.lte(datetime));
            }
        }
        InboxMessagesSortBy::IMSTimestamp => {
            if let Some(since_date_inclusive_ms) = req.since_date_inclusive_ms {
                let datetime = dt_from_millis(since_date_inclusive_ms)?;
                q = q.filter(signal_message::Column::Timestamp.gte(datetime));
            }
            if let Some(till_date_inclusive_ms) = req.till_date_inclusive_ms {
                let datetime = dt_from_millis(till_date_inclusive_ms)?;
                q = q.filter(signal_message::Column::Timestamp.lte(datetime));
            }
        }
    };

    // here are more complex and nuanced filters
    '_if: {
        if let Some(since_id_noninclusive) = since_id_noninclusive {
            let Some(message) =
                SignalMessage::find_by_id(since_id_noninclusive)
                    // we want to query even if it got deleted
                    // .filter(signal_message::Column::Deleted.eq(false))
                    .one(&env.dbx)
                    .await
                    .c(h!())?
            else {
                break '_if;
            };
            match req.sort_by.unwrap_or(InboxMessagesSortBy::IMSDatetime) {
                InboxMessagesSortBy::IMSDatetime => {
                    let Some(inbox) =
                        SigintInboxItem::find_by_id(since_id_noninclusive)
                            .one(&env.dbx)
                            .await
                            .c(h!())?
                    else {
                        break '_if;
                    };
                    let Some(datetime) = inbox.datetime else {
                        break '_if;
                    };

                    let ts = to_ts_expr(datetime);
                    q = q.filter(
                        Expr::tuple([
                            sigint_inbox_item::Column::Datetime
                                .into_column_ref()
                                .into(),
                            Expr::cust("sigint_inbox_item.id"),
                            // signal_message::Column::Id.into_column_ref().into(),
                        ])
                        .gt(SimpleExpr::Tuple(vec![
                            ts,
                            since_id_noninclusive.into(),
                        ])),
                    );
                }
                InboxMessagesSortBy::IMSTimestamp => {
                    let Some(timestamp) = message.timestamp else {
                        break '_if;
                    };
                    let ts = to_ts_expr(timestamp);
                    q = q.filter(
                        Expr::tuple([
                            signal_message::Column::Timestamp
                                .into_column_ref()
                                .into(),
                            Expr::cust("signal_message.id"),
                            // signal_message::Column::Id.into_column_ref().into(),
                        ])
                        .gt(SimpleExpr::Tuple(vec![
                            ts,
                            since_id_noninclusive.into(),
                        ])),
                    );
                }
            }
        }
        if let Some(before_id_noninclusive) = req.before_id_noninclusive {
            let Some(message) =
                SignalMessage::find_by_id(before_id_noninclusive)
                    // we want to query even if it got deleted
                    // .filter(signal_message::Column::Deleted.eq(false))
                    .one(&env.dbx)
                    .await
                    .c(h!())?
            else {
                break '_if;
            };
            match req_sort_by {
                InboxMessagesSortBy::IMSDatetime => {
                    let Some(inbox) =
                        SigintInboxItem::find_by_id(before_id_noninclusive)
                            .one(&env.dbx)
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
            let exp = match req.sort_by {
                Some(InboxMessagesSortBy::IMSTimestamp) => {
                    Expr::col(signal_message::Column::Timestamp).gte(ts)
                }
                _ => Expr::col(sigint_inbox_item::Column::Datetime).gte(ts),
            };
            q = q.filter(exp);
        }
    }
    if let Some(till_date_inclusive_ms) = req.till_date_inclusive_ms {
        if req.before_id_noninclusive.is_none() {
            q = q.filter(
                sigint_inbox_item::Column::Datetime
                    .lte(dt_from_millis(till_date_inclusive_ms)?),
            );
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
    let mut q = q;
    if let Some(since_id_noninclusive) = req.since_id_noninclusive {
        let req_sort_by =
            req.sort_by.unwrap_or(InboxMessagesSortBy::IMSDatetime);
        match req_sort_by {
            InboxMessagesSortBy::IMSDatetime => {
                if let Some(inbox) =
                    SigintInboxItem::find_by_id(since_id_noninclusive)
                        .one(&env.dbx)
                        .await
                        .c(h!())?
                {
                    if let Some(datetime) = inbox.datetime {
                        let datetime_expr = to_ts_expr(datetime);
                        q.and_where(
                            Expr::tuple([
                                sigint_inbox_item::Column::Datetime
                                    .into_column_ref()
                                    .into(),
                                Expr::cust("id"),
                            ])
                            .gt(
                                SimpleExpr::Tuple(vec![
                                    datetime_expr,
                                    since_id_noninclusive.into(),
                                ]),
                            ),
                        );
                    }
                }
            }
            InboxMessagesSortBy::IMSTimestamp => {
                if let Some(message) =
                    SignalMessage::find_by_id(since_id_noninclusive)
                        .filter(signal_message::Column::Deleted.eq(false))
                        .one(&env.dbx)
                        .await
                        .c(h!())?
                {
                    if let Some(timestamp) = message.timestamp {
                        let timestamp_expr = to_ts_expr(timestamp);
                        q.and_where(
                            Expr::tuple([
                                signal_message::Column::Timestamp
                                    .into_column_ref()
                                    .into(),
                                Expr::cust("id"),
                            ])
                            .gt(
                                SimpleExpr::Tuple(vec![
                                    timestamp_expr,
                                    since_id_noninclusive.into(),
                                ]),
                            ),
                        );
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
    if let Some(true) = req.load_latest {
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
    if let Some(true) = req.load_latest {
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
        .column_as(signal_message::Column::Timestamp, "timestamp")
        .column_as(preferred_sender_expr(None), "sender")
        .column_as(sigint_inbox_item::Column::Freq, "freq")
        .column_as(sigint_inbox_item::Column::Coords, "coords")
        .column_as(sigint_inbox_item::Column::Callsigns, "callsigns")
        .column_as(sigint_inbox_item::Column::CallsignsAlg2, "callsigns_alg2")
        .column_as(sigint_inbox_item::Column::CallsignTokens, "callsign_tokens")
        .column_as(sigint_inbox_item::Column::SignalTokens, "signal_tokens")
        .column_as(sigint_inbox_item::Column::KeywordTokens, "keyword_tokens")
        .column_as(sigint_inbox_item::Column::LocationV2, "location_v2")
        .column_as(sigint_inbox_item::Column::Date, "date")
        .column_as(sigint_inbox_item::Column::Time, "time")
        .column_as(sigint_inbox_item::Column::Checked, "checked")
        .column_as(sigint_inbox_item::Column::UnitV2, "unit_v2")
        .column_as(sigint_inbox_item::Column::PostId, "post_id")
        .column_as(sigint_inbox_item::Column::Datetime, "datetime")
        .column_as(sigint_post::Column::Name, "post_name")
}
