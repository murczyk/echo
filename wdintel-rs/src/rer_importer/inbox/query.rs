use crate::entities::{prelude::*, *};
use crate::rer_importer::types::*;

use crate::error::AppError;
use crate::rer_importer::analysis::*;
use crate::types::*;
use crate::utils::*;
use chrono::NaiveDateTime;
use log::*;
use sea_orm::*;
use sea_query::types::IntoColumnRef;
use sea_query::{Expr, SimpleExpr};

pub(crate) async fn build_inbox_query(
    login: &str,
    _logins: &Vec<String>,
    env: &Env,
    req: &InboxMessagesReq,
) -> Result<Select<signal_message::Entity>, AppError> {
    let sigint_groups =
        crate::users::get_identity_sigint_groups(&env.dbx, login).await?;
    let mut q = SignalMessage::find()
        .join(
            JoinType::LeftJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .join(
            JoinType::LeftJoin,
            signal_message::Relation::SignalGroup.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintPost.def(),
        );

    q = add_inbox_message_columns(q);
    q = q
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(signal_message::Column::GroupMasterKey.is_in(sigint_groups));

    if req.ignore_imported_coords.unwrap_or(false) {
        q = q.filter(signal_group::Column::IgnoreOperativny.eq(Some(false)));
    }
    // if req.report_tags_only_this_unit.unwrap_or(false) {
    //     q = q.filter(sigint_inbox_item::Column::UserId.is_in(logins))
    // }
    //

    q = get_order_by(env, req, q.clone()).await?;
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
        login,
        true,
    )?;
    let q = filter_selected_aors(q, &req.selected_aors).context(h!())?;
    let include_peleng_locations =
        req.include_peleng_locations.unwrap_or(false);
    let mut q = filter_selected_locations(
        q,
        &req.selected_locations,
        include_peleng_locations,
    )?;

    if req.nolimit != Some(true) {
        q = q.limit(20);
    }

    trace!("inbox items query sql: {}", q.build(DbBackend::Postgres));
    Ok(q)
}

pub async fn get_order_by<Q>(
    env: &Env,
    req: &InboxMessagesReq,
    q: Q,
) -> Result<Q, AppError>
where
    Q: QueryFilter + QueryOrder,
{
    let mut q = q;
    let mut since_id_noninclusive: Option<i64> = req.since_id_noninclusive;
    if req.since_id_noninclusive.is_none()
        && req.since_date_inclusive_ms.is_none()
        && req.load_latest.is_none()
    {
        since_id_noninclusive =
            crate::kv::get_kv(&env.dbx, "rer_importer_id_cursor").await?
    };

    let mut m_order_asc: Option<bool> = None;
    let req_sort_by = req.sort_by.unwrap_or(InboxMessagesSortBy::IMSDatetime);
    '_if: {
        if let Some(since_id_noninclusive) = since_id_noninclusive {
            let Some(message) =
                SignalMessage::find_by_id(since_id_noninclusive)
                    .filter(signal_message::Column::Deleted.eq(false))
                    .one(&env.dbx)
                    .await?
            else {
                q = q.filter(
                    signal_message::Column::Id.gt(since_id_noninclusive),
                );
                break '_if;
            };
            match req.sort_by.unwrap_or(InboxMessagesSortBy::IMSDatetime) {
                InboxMessagesSortBy::IMSDatetime => {
                    let Some(inbox) =
                        SigintInboxItem::find_by_id(since_id_noninclusive)
                            .one(&env.dbx)
                            .await?
                    else {
                        q = q.filter(
                            signal_message::Column::Id
                                .gt(since_id_noninclusive),
                        );
                        break '_if;
                    };
                    let Some(datetime) = inbox.datetime else {
                        q = q.filter(
                            signal_message::Column::Id
                                .gt(since_id_noninclusive),
                        );
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
                        .gt(SimpleExpr::Tuple(vec![
                            datetime,
                            since_id_noninclusive.into(),
                        ])),
                    );
                }
                InboxMessagesSortBy::IMSTimestamp => {
                    let Some(timestamp) = message.timestamp else {
                        q = q.filter(
                            signal_message::Column::Id
                                .gt(since_id_noninclusive),
                        );
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
                        .gt(SimpleExpr::Tuple(vec![
                            timestamp,
                            since_id_noninclusive.into(),
                        ])),
                    );
                }
            }
        }
        if let Some(before_id_noninclusive) = req.before_id_noninclusive {
            let Some(message) =
                SignalMessage::find_by_id(before_id_noninclusive)
                    .filter(signal_message::Column::Deleted.eq(false))
                    .one(&env.dbx)
                    .await?
            else {
                q = q.filter(
                    signal_message::Column::Id.lt(before_id_noninclusive),
                );
                break '_if;
            };
            match req_sort_by {
                InboxMessagesSortBy::IMSDatetime => {
                    let Some(inbox) =
                        SigintInboxItem::find_by_id(before_id_noninclusive)
                            .one(&env.dbx)
                            .await?
                    else {
                        q = q.filter(
                            signal_message::Column::Id
                                .lt(before_id_noninclusive),
                        );
                        break '_if;
                    };
                    let Some(datetime) = inbox.datetime else {
                        q = q.filter(
                            signal_message::Column::Id
                                .lt(before_id_noninclusive),
                        );
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
                        q = q.filter(
                            signal_message::Column::Id
                                .lt(before_id_noninclusive),
                        );
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
            let ts = dt_from_millis(since_date_inclusive_ms)?;
            let ts = to_ts_expr(ts);
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
        .column_as(signal_message::Column::GroupMasterKey, "group_master_key")
        .column_as(signal_message::Column::Sender, "sender")
        .column_as(signal_message::Column::DatasourceId, "datasource_id")
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
        .column_as(sigint_inbox_item::Column::Tags, "tags")
}
