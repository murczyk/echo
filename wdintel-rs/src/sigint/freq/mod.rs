use crate::entities::*;
use crate::error::AppError;
use crate::location::utils::to_location_list;
use crate::rer_importer::analysis::message_in_groups_exists;
use crate::sigint::sender::message_ids_for_senders;
use crate::types::*;
use crate::users::{ensure_rer_role, has_any_role, login_id_from_identity};
use crate::utils::*;
use actix_web::post;
use actix_web::web::{Data, Json};
use chrono::prelude::*;
use lazy_static::lazy_static;
use regex::Regex;
use sea_orm::{sea_query::PostgresQueryBuilder, *};
use sea_orm::{
    ColumnTrait, Condition, EntityTrait, QueryFilter, QuerySelect, Statement,
};
use sea_query::{Alias, Expr, IntoCondition, Order, Query, SimpleExpr};
use std::collections::{BTreeSet, HashMap, HashSet};

use self::bl::*;
use self::types::*;

pub mod bl;
pub mod types;
pub mod util;

#[post("/api/sigint/freqs/daily")]
pub async fn freq_activity_daily(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<FreqStatsReq>,
) -> Result<Json<FreqDailyActivityCount>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    let req = req.into_inner();
    let freq = req.freq;

    let since = DateTime::from_timestamp_millis(req.since_date_inclusive_ms)
        .context(h!())?
        .naive_utc();
    let mut ts_filter =
        Condition::all().add(signal_message::Column::Timestamp.gte(since));
    if let Some(till) = req.till_date_inclusive_ms {
        let till = DateTime::from_timestamp_millis(till)
            .context(h!())?
            .naive_utc();
        ts_filter = ts_filter.add(signal_message::Column::Timestamp.lte(till));
    }

    #[derive(FromQueryResult, Debug)]
    struct FreqDailyActivity {
        pub msg_date: NaiveDate,
        pub group: String,
        pub value: i64,
    }
    let stats: Vec<FreqDailyActivity> = signal_message::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SignalMessageGroup.def(),
        )
        .join(
            JoinType::LeftJoin,
            signal_message_group::Relation::SignalGroup.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message_group::Relation::DatasourceGroup.def(),
        )
        .join(
            JoinType::InnerJoin,
            datasource_group::Relation::Datasource.def(),
        )
        .join_rev(
            JoinType::InnerJoin,
            sigint_zone_datasource::Entity::belongs_to(datasource::Entity)
                .from(sigint_zone_datasource::Column::DatasourceId)
                .to(datasource::Column::Id)
                .into(),
        )
        .join_rev(
            JoinType::InnerJoin,
            sigint_zone::Entity::belongs_to(sigint_zone_datasource::Entity)
                .from(sigint_zone::Column::Id)
                .to(sigint_zone_datasource::Column::SigintZoneId)
                .into(),
        )
        .join_rev(
            JoinType::InnerJoin,
            login::Entity::belongs_to(sigint_zone::Entity)
                .from(login::Column::SigintZoneId)
                .to(sigint_zone::Column::Id)
                .into(),
        )
        .filter(login::Column::DeletedPermanently.eq(false))
        .filter(Expr::col((sigint_zone_datasource::Entity, sigint_zone_datasource::Column::GroupMasterKey)).equals((signal_message_group::Entity, signal_message_group::Column::GroupMasterKey)))
        .filter(login::Column::Id.eq(login))
        .filter(sigint_inbox_item::Column::Freq.eq(freq))
        .filter(ts_filter)
        .select_only()
        .column_as(Expr::cust("(signal_message.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Kyiv')::date"), "msg_date")
        .column_as(signal_group::Column::Name, "group")
        .column_as(signal_message::Column::Id.count(), "value")
        .group_by(Expr::cust("1, 2"))
        .order_by_desc(Expr::cust("1"))
        .into_model()
        .all(&env.dbx)
        .await
        .context(h!())?;

    let mut data_per_date = BTreeMap::new();
    for rec in stats {
        let date = rec.msg_date.to_string();
        let mut row = data_per_date.remove(&date).unwrap_or(
            FreqDailyGroupActivityCount {
                count_by_group_name: BTreeMap::new(),
            },
        );
        let group_count = row
            .count_by_group_name
            .get(&rec.group)
            .cloned()
            .unwrap_or(0);
        row.count_by_group_name
            .insert(rec.group, group_count + rec.value);
        data_per_date.insert(date, row);
    }
    Ok(Json(FreqDailyActivityCount { data_per_date }))
}

#[post("/api/sigint/freqs/alt-unit")]
pub async fn list_alt_unit_by_freqs(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ListAltUnitByFreqsReq>,
) -> Result<Json<HashMap<String, Vec<FreqAltUnitMessageCount>>>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let dt_since = dt_from_millis(req.since_date_inclusive_ms)?;
    let dt_till = dt_from_millis(req.till_date_noninclusive_ms)?;
    let mut alt_units = signal_message::Entity::find()
        .join_as(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
            Alias::new("sigint_inbox_item"),
        )
        .select_only()
        .column_as(Expr::cust("count(*)"), "count")
        .column_as(sigint_inbox_item::Column::Unit, "unit")
        .column_as(sigint_inbox_item::Column::Freq, "freq")
        .filter(message_in_groups_exists(
            crate::messenger::group::get_identity_sigint_groups_noimport(
                &env.dbx,
                &user,
                &env.config,
            )
            .await
            .c(h!())?,
        ))
        .filter(signal_message::Column::Deleted.eq(false))
        .group_by(sigint_inbox_item::Column::Unit)
        .group_by(sigint_inbox_item::Column::Freq)
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till))
        .filter(sigint_inbox_item::Column::Unit.is_not_null())
        .filter(sigint_inbox_item::Column::Freq.eq_any(req.freqs.clone()));

    if let Some(groups) = &req.filter_group_master_keys {
        alt_units = alt_units.filter(message_in_groups_exists(groups.clone()))
    }

    if let Some(senders) = &req.filter_sender_profile_ids {
        let subquery = message_ids_for_senders(senders);
        alt_units =
            alt_units.filter(signal_message::Column::Id.in_subquery(subquery))
    }

    let res_alt_units = alt_units
        .into_model::<FreqAltUnitMessageCount>()
        .all(&env.dbx)
        .await
        .c(h!())?;

    let mut res = HashMap::new();
    for row in res_alt_units {
        if !res.contains_key(&row.freq) {
            res.insert(row.freq.clone(), Vec::new());
        }
        let mut val = res.get(&row.freq).unwrap().clone();
        val.push(row.clone());
        res.insert(row.freq.clone(), val);
    }

    Ok(Json(res))
}

#[post("/api/sigint/freq/points")]
pub async fn list_points_by_freq(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ListPointsByFreqReq>,
) -> Result<Json<ListPointsByFreqRsp>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let dt_since = dt_from_millis(req.since_date_inclusive_ms)?;
    let dt_till = dt_from_millis(req.till_date_noninclusive_ms)?;
    let points = signal_message::Entity::find()
        .join_as(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
            Alias::new("sigint_inbox_item"),
        )
        .join_as(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SigintPeleng.def(),
            Alias::new("sigint_peleng"),
        )
        .select_only()
        .column_as(signal_message::Column::Id, "id")
        .column_as(sigint_peleng::Column::Lat, "lat")
        .column_as(sigint_peleng::Column::Lng, "lng")
        .column_as(signal_message::Column::Body, "body")
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(message_in_groups_exists(
            crate::messenger::group::get_identity_sigint_groups_noimport(
                &env.dbx,
                &user,
                &env.config,
            )
            .await
            .c(h!())?,
        ))
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till))
        .filter(sigint_inbox_item::Column::Freq.eq(req.freq.clone()));

    Ok(Json(ListPointsByFreqRsp {
        points: points
            .into_model::<FreqPoint>()
            .all(&env.dbx)
            .await
            .c(h!())?,
    }))
}

#[post("/api/sigint/freq/groups-per-day")]
pub async fn list_groups_by_freqs_per_day(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ListGroupsByFreqsPerDayReq>,
) -> Result<Json<HashMap<String, HashMap<i64, HashMap<String, i64>>>>, AppError>
{
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let dt_till = dt_from_millis(req.till_date_noninclusive_ms)?;
    let dt_cutoff = dt_till - chrono::Duration::days(10);
    let mut dt_since =
        dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    if dt_cutoff < dt_since {
        dt_since = dt_cutoff;
    }

    let freqs = req.freqs.clone();
    let master_keys =
        crate::messenger::group::get_identity_sigint_groups_noimport(
            &env.dbx,
            &user,
            &env.config,
        )
        .await
        .c(h!())?;

    let aggregated_range = crate::stats::stats_aggregated_time_range(
        &env.config,
        dt_since,
        dt_till,
    )
    .c(h!())?;
    let rows =
        if let Some((aggregated_since, aggregated_till)) = aggregated_range {
            crate::stats::read_frequency_stats_day(
                &env,
                master_keys,
                aggregated_since,
                aggregated_till,
            )
            .await
            .c(h!())?
            .into_iter()
            .filter(|x| freqs.iter().any(|freq| freq == &x.freq))
            .collect()
        } else {
            collect_freq_counts(&env, dt_till, dt_since, freqs, master_keys)
                .await
                .c(h!())?
        };

    let mut res = HashMap::new();
    for row in rows {
        let freq = row.freq.clone();
        let day = row.day;
        let group = row.group.clone();
        let count = row.count;
        if !res.contains_key(&freq) {
            res.insert(freq.clone(), HashMap::new());
        }
        let freq_map = res.get_mut(&freq).unwrap();
        freq_map.entry(day).or_insert_with(HashMap::new);
        let day_map = freq_map.get_mut(&day).unwrap();
        day_map.insert(group.clone(), count);
    }

    Ok(Json(res))
}

async fn collect_freq_counts(
    env: &Data<Env>,
    dt_till: NaiveDateTime,
    dt_since: NaiveDateTime,
    freqs: Vec<String>,
    master_keys: Vec<String>,
) -> Result<Vec<FreqGroupsMessageCountByDay>, AppError> {
    let callsigns = signal_message::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SignalMessageGroup.def(),
        )
        .join_as(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
            Alias::new("sigint_inbox_item"),
        )
        .join_as(
            JoinType::LeftJoin,
            signal_message_group::Relation::SignalGroup.def(),
            Alias::new("signal_group"),
        )
        .select_only()
        .column_as(
            sigint_inbox_item::Column::Freq,
            "freq",
        )
        .column_as(
            Expr::cust(
                "(EXTRACT(EPOCH FROM DATE_TRUNC('day', sigint_inbox_item.datetime AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Kyiv')) * 1000)::BIGINT",
            ),
            "day",
        )
        .column_as(signal_group::Column::Name, "group")
        .column_as(Expr::cust("count(*)"), "count")
        .group_by(Expr::cust(
            "freq, day, signal_group.name",
        ))
        .filter(signal_group::Column::Deleted.eq(false))
        .filter(signal_group::Column::IsArchived.eq(false))
        .filter(message_in_groups_exists(
            master_keys,
        ))
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(sigint_inbox_item::Column::Datetime.lte(dt_till))
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Freq.eq_any(freqs));

    let callsigns = callsigns
        .clone()
        .order_by_desc(Expr::cust("freq, day, \"group\""));

    // println!(
    //     "> sql: {}",
    //     callsigns.clone().build(DbBackend::Postgres).to_string()
    // );

    let rows = callsigns
        .into_model::<FreqGroupsMessageCountByDay>()
        .all(&env.dbx)
        .await
        .c(h!())?;
    Ok(rows)
}

#[post("/api/sigint/freq/callsigns")]
pub async fn list_callsigns_by_freqs(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ListCallsignsByFreqsReq>,
) -> Result<Json<HashMap<String, Vec<String>>>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let dt_since = dt_from_millis(req.since_date_inclusive_ms)?;
    let dt_till = dt_from_millis(req.till_date_noninclusive_ms)?;

    #[derive(FromQueryResult)]
    struct InboxItemFreq {
        id: i64,
        freq: String,
    }

    let inbox_items = signal_message::Entity::find()
        .join_as(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
            Alias::new("sigint_inbox_item"),
        )
        .select_only()
        .distinct()
        .column_as(signal_message::Column::Id, "id")
        .column_as(sigint_inbox_item::Column::Freq, "freq")
        .filter(message_in_groups_exists(
            crate::messenger::group::get_identity_sigint_groups_noimport(
                &env.dbx,
                &user,
                &env.config,
            )
            .await
            .c(h!())?,
        ))
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till))
        .filter(sigint_inbox_item::Column::Freq.eq_any(req.freqs.clone()))
        .filter(inbox_item_callsign_exists())
        .into_model::<InboxItemFreq>()
        .all(&env.dbx)
        .await
        .c(h!())?;
    let inbox_item_ids =
        inbox_items.iter().map(|row| row.id).collect::<Vec<_>>();
    let callsigns =
        crate::inbox::callsigns::load_by_item_ids(&env.dbx, &inbox_item_ids)
            .await?;
    let mut callsigns_by_freq = HashMap::<String, BTreeSet<String>>::new();
    for inbox_item in inbox_items {
        let Some(inbox_item_callsigns) = callsigns.get(&inbox_item.id) else {
            continue;
        };
        callsigns_by_freq
            .entry(inbox_item.freq)
            .or_default()
            .extend(inbox_item_callsigns.effective());
    }

    Ok(Json(
        callsigns_by_freq
            .into_iter()
            .map(|(freq, callsigns)| (freq, callsigns.into_iter().collect()))
            .collect(),
    ))
}

fn inbox_item_callsign_exists() -> SimpleExpr {
    Expr::cust(crate::inbox::callsigns::sql_exists_condition(
        "sigint_inbox_item",
    ))
}

fn select_freq_page(
    rows: Vec<(String, i64, Option<String>)>,
    after_freq_nonincl: Option<&str>,
    limit: usize,
) -> (Vec<(String, i64, Option<String>)>, bool) {
    let mut rows = rows.into_iter();
    if let Some(after_freq_nonincl) = after_freq_nonincl {
        if !rows.by_ref().any(|(freq, _, _)| freq == after_freq_nonincl) {
            return (Vec::new(), false);
        }
    }

    let page = rows.by_ref().take(limit).collect::<Vec<_>>();
    (page, rows.next().is_some())
}

/// Lists frequencies which were active (active in 14-day period, can include non-actives if checked), their assigned units if any.
///
/// This API is slow. DO NOT USE FOR POPULAR PAGES TO GET FREQ INFO. Only intended for admin pages.
#[post("/api/sigint/freqs")]
pub async fn list_freqs(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ListFreqsReq>,
) -> Result<Json<ListFreqsRsp>, AppError> {
    has_any_role(
        &env.dbx,
        &login_id_from_identity(&user)?,
        vec!["Rer", "Api"],
    )
    .await?;
    let login = login_id_from_identity(&user)?;
    const LIMIT: usize = 30;
    /// Period designating how many days are considered that freq is inactive
    const PERIOD_DAYS: i64 = 14;
    let dt_since = dt_from_millis(req.since_date_inclusive_ms)?;
    let dt_till = dt_from_millis(req.till_date_noninclusive_ms)?;

    #[derive(FromQueryResult)]
    struct FreqRes {
        freq: Option<String>,
        message_count: i64,
        location_v2: Option<String>,
    }

    enum FreqPeriodSource {
        Rows(Vec<(String, i64, Option<String>)>),
        Sql(String),
    }

    let dedup_key_alias = Alias::new("dedup_key");
    let freqs_period = match &req.filter_callsigns {
        Some(filter_callsigns) if filter_callsigns.is_empty() => {
            FreqPeriodSource::Rows(Vec::new())
        }
        Some(filter_callsigns) => {
            if let Err(ref e) = validate_callsigns(filter_callsigns) {
                println!("> error validating collsings for filter: {e}");
                return Err(AppError::BL { msg: e.to_string() });
            }

            #[derive(FromQueryResult)]
            struct InboxItemFreq {
                id: i64,
                freq: Option<String>,
                location_v2: Option<String>,
            }

            let mut dedup_subquery = signal_message::Entity::find()
                .join_as(
                    JoinType::InnerJoin,
                    signal_message::Relation::SigintInboxItem.def(),
                    Alias::new("sigint_inbox_item"),
                )
                .select_only()
                .column_as(signal_message::Column::Id, "id")
                .columns([
                    sigint_inbox_item::Column::Freq,
                    sigint_inbox_item::Column::LocationV2,
                    sigint_inbox_item::Column::Datetime,
                ])
                .column_as(
                    Expr::col((
                        signal_message::Entity,
                        signal_message::Column::Id,
                    )),
                    "dedup_key",
                )
                .distinct_on([dedup_key_alias.clone()]);

            dedup_subquery = filters_list_freq_search(
                dedup_subquery,
                &env,
                &user,
                dt_since,
                dt_till,
                &req.filter_freq,
                &req.filter_unit,
                &req.filter_group_master_keys,
                &req.filter_sender_profile_ids,
                &req.filter_further_investigation,
            )
            .await
            .c(h!())?;

            dedup_subquery = dedup_subquery.filter(Expr::cust(
                crate::inbox::callsigns::sql_filter_condition(filter_callsigns),
            ));
            dedup_subquery =
                dedup_subquery.filter(inbox_item_callsign_exists());

            if req.filter_unknown_network.unwrap_or(false) {
                dedup_subquery = dedup_subquery.filter(
                    unknown_network_freq_filter("sigint_inbox_item.freq"),
                );
            }

            dedup_subquery = dedup_subquery
                .order_by(Expr::cust("dedup_key"), Order::Asc)
                // emulate NULLS FIRST: order nulls before non-nulls
                .order_by(sigint_inbox_item::Column::Datetime, Order::Asc);

            let inbox_items = dedup_subquery
                .into_model::<InboxItemFreq>()
                .all(&env.dbx)
                .await
                .c(h!())?;
            let inbox_item_ids =
                inbox_items.iter().map(|row| row.id).collect::<Vec<_>>();
            let callsigns = crate::inbox::callsigns::load_by_item_ids(
                &env.dbx,
                &inbox_item_ids,
            )
            .await?;
            let selected_callsigns =
                filter_callsigns.iter().cloned().collect::<HashSet<_>>();
            let mut aggregated =
                HashMap::<String, (HashSet<String>, BTreeSet<String>)>::new();
            for inbox_item in inbox_items {
                let Some(freq) = inbox_item.freq else {
                    continue;
                };
                let Some(inbox_item_callsigns) = callsigns.get(&inbox_item.id)
                else {
                    continue;
                };
                let matched_callsigns = inbox_item_callsigns
                    .effective()
                    .into_iter()
                    .filter(|callsign| selected_callsigns.contains(callsign))
                    .collect::<Vec<_>>();
                if matched_callsigns.is_empty() {
                    continue;
                }
                let entry = aggregated.entry(freq).or_default();
                entry.0.extend(matched_callsigns);
                if let Some(location_v2) = inbox_item.location_v2 {
                    entry.1.insert(location_v2);
                }
            }
            let mut rows = aggregated
                .into_iter()
                .map(|(freq, (callsigns, locations))| {
                    let location_v2 = if locations.is_empty() {
                        None
                    } else {
                        Some(locations.into_iter().collect::<String>())
                    };
                    (freq, callsigns.len() as i64, location_v2)
                })
                .collect::<Vec<_>>();
            rows.sort_by_key(|row| std::cmp::Reverse(row.1));
            FreqPeriodSource::Rows(rows)
        }
        None => {
            let mut dedup_freq_per = signal_message::Entity::find()
                .join_as(
                    JoinType::InnerJoin,
                    signal_message::Relation::SigintInboxItem.def(),
                    Alias::new("sigint_inbox_item"),
                )
                .select_only()
                .column_as(sigint_inbox_item::Column::Freq, "freq")
                .column_as(sigint_inbox_item::Column::LocationV2, "location_v2")
                .column_as(sigint_inbox_item::Column::Datetime, "datetime")
                .column_as(
                    Expr::col((
                        signal_message::Entity,
                        signal_message::Column::Id,
                    )),
                    "dedup_key",
                )
                .distinct_on([dedup_key_alias.clone()]);

            dedup_freq_per = filters_list_freq_search(
                dedup_freq_per,
                &env,
                &user,
                dt_since,
                dt_till,
                &req.filter_freq,
                &req.filter_unit,
                &req.filter_group_master_keys,
                &req.filter_sender_profile_ids,
                &req.filter_further_investigation,
            )
            .await
            .c(h!())?;

            dedup_freq_per = dedup_freq_per
                .order_by(Expr::cust("dedup_key"), Order::Asc)
                // emulate NULLS FIRST: order nulls before non-nulls
                .order_by(sigint_inbox_item::Column::Datetime, Order::Asc);

            let uniq_alias = Alias::new("uniq");
            let mut main_query = Query::select()
                .expr_as(Expr::cust("count(1)"), "message_count")
                .column((uniq_alias.clone(), "freq"))
                .expr_as(
                    Expr::cust("string_agg(distinct uniq.location_v2, '')"),
                    "location_v2",
                )
                .from_subquery(
                    dedup_freq_per.to_owned().into_query(),
                    uniq_alias.clone(),
                )
                .add_group_by([Expr::cust("freq")])
                .to_owned();

            if req.filter_unknown_network.unwrap_or(false) {
                main_query.and_where(unknown_network_freq_filter("uniq.freq"));
            }

            if let Some(sort_by) = &req.sort_by {
                for sort in sort_by {
                    let (col, order) = match sort {
                        ListFreqsSortBy::FreqAsc => ("freq", Order::Asc),
                        ListFreqsSortBy::FreqDesc => ("freq", Order::Desc),
                        ListFreqsSortBy::MessageCountAsc => {
                            ("message_count", Order::Asc)
                        }
                        ListFreqsSortBy::MessageCountDesc => {
                            ("message_count", Order::Desc)
                        }
                    };

                    let expr = Expr::cust(col);
                    main_query.order_by_expr(expr, order);
                }
            } else {
                let expr = Expr::cust("freq");
                main_query.order_by_expr(expr, Order::Asc);
            }
            FreqPeriodSource::Sql(main_query.to_string(PostgresQueryBuilder))
        }
    };

    // let freqs_period_count: u64 =
    //     freqs_period.clone().count(&env.dbx).await.c(h!())?;
    // println!("> freqs in period count: {}", freqs_period_count);
    // freqs_period = freqs_period.limit(LIMIT);
    // debug!("> freqs sql: {freqs_period}");

    let freqs_period = match freqs_period {
        FreqPeriodSource::Rows(rows) => rows,
        FreqPeriodSource::Sql(sql) => env
            .dbx
            .query_all_raw(Statement::from_string(
                DatabaseBackend::Postgres,
                sql,
            ))
            .await
            .c(h!())?
            .iter()
            .flat_map(|row| {
                let freq_res = FreqRes::from_query_result(row, "").unwrap();
                freq_res.freq.clone().map(|freq| {
                    (freq, freq_res.message_count, freq_res.location_v2.clone())
                })
            })
            .collect(),
    };
    // println!("> freqs in period count: {}", freqs_period.len());

    let (freqs_period, show_load_more) = select_freq_page(
        freqs_period,
        req.after_freq_nonincl.as_deref(),
        LIMIT,
    );
    if freqs_period.is_empty() {
        return Ok(Json(ListFreqsRsp {
            show_load_more: false,
            freqs: Vec::new(),
        }));
    }
    let page_freqs = freqs_period
        .iter()
        .map(|(freq, _, _)| freq.clone())
        .collect::<Vec<_>>();

    #[derive(FromQueryResult)]
    struct BeforeRes {
        freq: Option<String>,
    }

    let before_since = dt_since - chrono::Duration::days(PERIOD_DAYS);
    let before_till = dt_since;
    let before_res = signal_message::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .select_only()
        .column_as(Expr::col(sigint_inbox_item::Column::Freq), "freq")
        .filter(message_in_groups_exists(
            crate::messenger::group::get_identity_sigint_groups(
                &env.dbx, &login,
            )
            .await
            .c(h!())?,
        ))
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(sigint_inbox_item::Column::Datetime.gte(before_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(before_till))
        .filter(sigint_inbox_item::Column::Freq.is_in(page_freqs))
        .group_by(sea_query::expr::SimpleExpr::Custom("freq".into()))
        .order_by_asc(sigint_inbox_item::Column::Freq);
    // let before_count: u64 = before_res.clone().count(&env.dbx).await.c(h!())?;
    // println!("> before count: {}", before_count);
    // before_res = before_res.limit(LIMIT);
    // println!(
    //     "> before sql: {}",
    //     before_res.build(DbBackend::Postgres).to_string()
    // );
    let before_res: BTreeSet<String> = before_res
        .into_model::<BeforeRes>()
        .all(&env.dbx)
        .await
        .c(h!())?
        .iter()
        .flat_map(|x| x.freq.clone())
        .collect();
    // println!("> before count: {}", before_res.len());

    let mut freqs = vec![];
    for (freq, message_count, location_v2) in freqs_period {
        let networks = sigint_network::Entity::find()
            .join(
                JoinType::InnerJoin,
                sigint_network::Relation::SigintNetworkFreq.def(),
            )
            .filter(sigint_network_freq::Column::Freq.eq(freq.clone()))
            .filter(sigint_network::Column::Deleted.eq(false))
            .filter(sigint_network_freq::Column::ActiveTo.is_null())
            .filter(sigint_network_freq::Column::Deleted.eq(false))
            .order_by_asc(sigint_network::Column::CreatedAt)
            .all(&env.dbx)
            .await
            .c(h!())?;
        let created_at = networks
            .first()
            .map(|x| x.created_at.and_utc().timestamp_millis());

        let last_updated_network = networks.iter().max_by_key(|n| n.updated_at);

        let is_new = !before_res.contains(&freq);
        let network_ids = networks.iter().map(|x| x.id).collect();
        let last_updated_by = last_updated_network
            .and_then(|x| x.updated_by_login_id)
            .map(|login_id| login_id.to_string());
        let last_updated_at = last_updated_network
            .map(|x| x.updated_at)
            .map(|t| t.and_utc().timestamp_millis());
        let mut locations = BTreeSet::new();
        if let Some(location_v2) = location_v2 {
            locations.extend(to_location_list(&location_v2));
        }
        freqs.push(Freq {
            freq,
            locations,
            message_count,
            network_ids,
            created_at,
            is_new,
            last_updated_at,
            last_updated_by,
        });
    }

    Ok(Json(ListFreqsRsp {
        show_load_more,
        freqs,
    }))
}

fn unknown_network_freq_filter(freq_expr: &str) -> SimpleExpr {
    Expr::cust(format!(
        "NOT EXISTS (SELECT 1 FROM sigint_network_freq snf \
         JOIN sigint_network sn ON sn.id = snf.network_id \
         WHERE snf.freq = {freq_expr} \
         AND snf.active_to IS NULL \
         AND snf.deleted = false \
         AND sn.deleted = false)"
    ))
}

/// This API is slow. DO NOT USE FOR POPULAR PAGES TO GET FREQ INFO. Only intended for admin pages.
#[post("/api/sigint/freqs-v2")]
pub async fn list_freqs_v2(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ListFreqsReq>,
) -> Result<Json<ListFreqsV2Rsp>, AppError> {
    has_any_role(
        &env.dbx,
        &login_id_from_identity(&user)?,
        vec!["Rer", "Api"],
    )
    .await?;
    let login = login_id_from_identity(&user)?;
    const LIMIT: usize = 30;
    /// Period designating how many days are considered that freq is inactive
    const PERIOD_DAYS: i64 = 14;
    let dt_since = dt_from_millis(req.since_date_inclusive_ms)?;
    let dt_till = dt_from_millis(req.till_date_noninclusive_ms)?;

    #[derive(FromQueryResult)]
    struct FreqRes {
        post_id: Option<i64>,
        freq: Option<String>,
        message_count: i64,
        location_v2: Option<String>,
    }

    enum FreqPeriodSource {
        Rows(Vec<(String, i64, Option<String>, Option<i64>)>),
        Sql(String),
    }

    let freqs_period = match &req.filter_callsigns {
        Some(filter_callsigns) if filter_callsigns.is_empty() => {
            FreqPeriodSource::Rows(Vec::new())
        }
        Some(filter_callsigns) => {
            if let Err(ref e) = validate_callsigns(filter_callsigns) {
                println!("> error validating collsings for filter: {e}");
                return Err(AppError::BL { msg: e.to_string() });
            }

            #[derive(FromQueryResult)]
            struct InboxItemFreq {
                id: i64,
                post_id: Option<i64>,
                freq: Option<String>,
                location_v2: Option<String>,
            }

            let mut subquery = signal_message::Entity::find()
                .join_as(
                    JoinType::InnerJoin,
                    signal_message::Relation::SigintInboxItem.def(),
                    Alias::new("sigint_inbox_item"),
                )
                .select_only()
                .distinct()
                .column_as(signal_message::Column::Id, "id")
                .column(sigint_inbox_item::Column::PostId)
                .column(sigint_inbox_item::Column::Freq)
                .column(sigint_inbox_item::Column::LocationV2);

            subquery = filters_list_freq_search(
                subquery,
                &env,
                &user,
                dt_since,
                dt_till,
                &req.filter_freq,
                &req.filter_unit,
                &req.filter_group_master_keys,
                &req.filter_sender_profile_ids,
                &req.filter_further_investigation,
            )
            .await
            .c(h!())?;

            subquery = subquery.filter(Expr::cust(
                crate::inbox::callsigns::sql_filter_condition(filter_callsigns),
            ));
            subquery = subquery.filter(inbox_item_callsign_exists());

            let inbox_items = subquery
                .into_model::<InboxItemFreq>()
                .all(&env.dbx)
                .await
                .c(h!())?;
            let inbox_item_ids =
                inbox_items.iter().map(|row| row.id).collect::<Vec<_>>();
            let callsigns = crate::inbox::callsigns::load_by_item_ids(
                &env.dbx,
                &inbox_item_ids,
            )
            .await?;
            let selected_callsigns =
                filter_callsigns.iter().cloned().collect::<HashSet<_>>();
            let mut aggregated = HashMap::<
                (String, Option<i64>),
                (HashSet<String>, BTreeSet<String>),
            >::new();
            for inbox_item in inbox_items {
                let Some(freq) = inbox_item.freq else {
                    continue;
                };
                let Some(inbox_item_callsigns) = callsigns.get(&inbox_item.id)
                else {
                    continue;
                };
                let matched_callsigns = inbox_item_callsigns
                    .effective()
                    .into_iter()
                    .filter(|callsign| selected_callsigns.contains(callsign))
                    .collect::<Vec<_>>();
                if matched_callsigns.is_empty() {
                    continue;
                }
                let entry =
                    aggregated.entry((freq, inbox_item.post_id)).or_default();
                entry.0.extend(matched_callsigns);
                if let Some(location_v2) = inbox_item.location_v2 {
                    entry.1.insert(location_v2);
                }
            }
            let mut rows = aggregated
                .into_iter()
                .map(|((freq, post_id), (callsigns, locations))| {
                    let location_v2 = if locations.is_empty() {
                        None
                    } else {
                        Some(locations.into_iter().collect::<String>())
                    };
                    (freq, callsigns.len() as i64, location_v2, post_id)
                })
                .collect::<Vec<_>>();
            rows.sort_by_key(|row| std::cmp::Reverse(row.1));
            FreqPeriodSource::Rows(rows)
        }
        None => {
            let mut freqs_per = signal_message::Entity::find()
                .join_as(
                    JoinType::InnerJoin,
                    signal_message::Relation::SigintInboxItem.def(),
                    Alias::new("sigint_inbox_item"),
                )
                .select_only()
                .column(sigint_inbox_item::Column::PostId)
                .column_as(signal_message::Column::Id.count(), "message_count")
                .column_as(
                    SimpleExpr::Custom("sigint_inbox_item.freq".into()),
                    "freq",
                )
                .column_as(
                    SimpleExpr::Custom(
                        "string_agg(sigint_inbox_item.location_v2, '')".into(),
                    ),
                    "location_v2",
                );

            freqs_per = filters_list_freq_search(
                freqs_per,
                &env,
                &user,
                dt_since,
                dt_till,
                &req.filter_freq,
                &req.filter_unit,
                &req.filter_group_master_keys,
                &req.filter_sender_profile_ids,
                &req.filter_further_investigation,
            )
            .await
            .c(h!())?;

            freqs_per = freqs_per.group_by(sigint_inbox_item::Column::Freq);

            freqs_per = if let Some(sort_by) = &req.sort_by {
                sort_by.iter().fold(freqs_per, |freqs_per, sort_by| {
                    match sort_by {
                        ListFreqsSortBy::FreqAsc => freqs_per
                            .order_by_asc(sigint_inbox_item::Column::Freq),
                        ListFreqsSortBy::FreqDesc => freqs_per
                            .order_by_desc(sigint_inbox_item::Column::Freq),
                        ListFreqsSortBy::MessageCountAsc => freqs_per
                            .order_by_asc(signal_message::Column::Id.count()),
                        ListFreqsSortBy::MessageCountDesc => freqs_per
                            .order_by_desc(signal_message::Column::Id.count()),
                    }
                })
            } else {
                freqs_per.order_by_asc(sigint_inbox_item::Column::Freq)
            };
            FreqPeriodSource::Sql(
                freqs_per.build(DbBackend::Postgres).to_string(),
            )
        }
    };

    // let freqs_period_count: u64 =
    //     freqs_period.clone().count(&env.dbx).await.c(h!())?;
    // println!("> freqs in period count: {}", freqs_period_count);
    // freqs_period = freqs_period.limit(LIMIT);
    let freqs_period = match freqs_period {
        FreqPeriodSource::Rows(rows) => rows,
        FreqPeriodSource::Sql(sql) => {
            trace!("> freqs sql: {sql}");
            env.dbx
                .query_all_raw(Statement::from_string(
                    DatabaseBackend::Postgres,
                    sql,
                ))
                .await
                .c(h!())?
                .iter()
                .flat_map(|row| {
                    let freq_res = FreqRes::from_query_result(row, "").unwrap();
                    freq_res.freq.clone().map(|freq| {
                        (
                            freq,
                            freq_res.message_count,
                            freq_res.location_v2.clone(),
                            freq_res.post_id,
                        )
                    })
                })
                .collect()
        }
    };
    // println!("> freqs in period count: {}", freqs_period.len());

    #[derive(FromQueryResult)]
    struct BeforeRes {
        freq: Option<String>,
    }

    let before_since = dt_since - chrono::Duration::days(PERIOD_DAYS);
    let before_till = dt_since;
    let before_res = signal_message::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .select_only()
        .column_as(Expr::col(sigint_inbox_item::Column::Freq), "freq")
        .filter(message_in_groups_exists(
            crate::messenger::group::get_identity_sigint_groups(
                &env.dbx, &login,
            )
            .await
            .c(h!())?,
        ))
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(sigint_inbox_item::Column::Datetime.gte(before_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(before_till))
        .group_by(sea_query::expr::SimpleExpr::Custom("freq".into()))
        .order_by_asc(sigint_inbox_item::Column::Freq);
    // let before_count: u64 = before_res.clone().count(&env.dbx).await.c(h!())?;
    // println!("> before count: {}", before_count);
    // before_res = before_res.limit(LIMIT);
    // println!(
    //     "> before sql: {}",
    //     before_res.build(DbBackend::Postgres).to_string()
    // );
    let before_res: BTreeSet<String> = before_res
        .into_model::<BeforeRes>()
        .all(&env.dbx)
        .await
        .c(h!())?
        .iter()
        .flat_map(|x| x.freq.clone())
        .collect();
    // println!("> before count: {}", before_res.len());

    let mut show_load_more = false;

    let mut freqs = vec![];
    let mut need_skip = false;
    if let Some(_after_freq_nonincl) = &req.after_freq_nonincl {
        need_skip = true;
    }
    let mut last_freq = String::from("");
    for (freq, message_count, location_v2, post_id) in freqs_period {
        if show_load_more && last_freq != freq {
            break;
        }
        if need_skip {
            if req.after_freq_nonincl == Some(freq) {
                need_skip = false;
            }
            continue;
        }

        let networks = sigint_network::Entity::find()
            .join(
                JoinType::InnerJoin,
                sigint_network::Relation::SigintNetworkFreq.def(),
            )
            .filter(sigint_network_freq::Column::Freq.eq(freq.clone()))
            .filter(sigint_network::Column::Deleted.eq(false))
            .filter(sigint_network_freq::Column::ActiveTo.is_null())
            .filter(sigint_network_freq::Column::Deleted.eq(false))
            .order_by_asc(sigint_network::Column::CreatedAt)
            .all(&env.dbx)
            .await
            .c(h!())?;
        let created_at = networks
            .first()
            .map(|x| x.created_at.and_utc().timestamp_millis());

        let last_updated_network = networks.iter().max_by_key(|n| n.updated_at);

        let is_new = !before_res.contains(&freq);
        let network_ids = networks.iter().map(|x| x.id).collect();
        let last_updated_by = last_updated_network
            .and_then(|x| x.updated_by_login_id)
            .map(|login_id| login_id.to_string());
        let last_updated_at = last_updated_network
            .map(|x| x.updated_at)
            .map(|t| t.and_utc().timestamp_millis());
        let mut locations = BTreeSet::new();
        if let Some(location_v2) = location_v2 {
            locations.extend(to_location_list(&location_v2));
        }
        let freq_clone = freq.clone();
        freqs.push(FreqV2 {
            freq,
            post_id,
            locations,
            message_count,
            network_ids,
            created_at,
            is_new,
            last_updated_at,
            last_updated_by,
        });

        if freqs.len() >= LIMIT {
            show_load_more = true;
            last_freq = freq_clone; // we want to collect remaining rows for this freq but different posts and only then skip
        }
    }

    Ok(Json(ListFreqsV2Rsp {
        show_load_more,
        freqs,
    }))
}

pub async fn filters_list_freq_search<Q>(
    q: Q,
    env: &actix_web::web::Data<Env>,
    user: &actix_identity::Identity,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    filter_freq: &Option<String>,
    filter_unit: &Option<String>,
    filter_group_master_keys: &Option<Vec<String>>,
    filter_sender_profile_ids: &Option<Vec<String>>,
    filter_further_investigation: &Option<bool>,
) -> Result<Q, AppError>
where
    Q: QueryFilter + QuerySelect + Clone,
{
    let mut q = q.clone();

    q = q.filter(message_in_groups_exists(
        crate::messenger::group::get_identity_sigint_groups_noimport(
            &env.dbx,
            user,
            &env.config,
        )
        .await
        .c(h!())?,
    ));

    q = q.filter(signal_message::Column::Deleted.eq(false));
    q = q.filter(sigint_inbox_item::Column::Datetime.gte(dt_since));
    q = q.filter(sigint_inbox_item::Column::Datetime.lt(dt_till));

    if let Some(filter_group_master_keys) = filter_group_master_keys {
        q = q
            .filter(message_in_groups_exists(filter_group_master_keys.clone()));
    };

    if let Some(filter_sender_profile_ids) = filter_sender_profile_ids {
        let subquery = message_ids_for_senders(filter_sender_profile_ids);
        q = q.filter(signal_message::Column::Id.in_subquery(subquery));
    };

    if let Some(filter_freq) = filter_freq {
        q = q.filter(Expr::cust_with_values(
            "sigint_inbox_item.freq ilike $1",
            vec![format!("{filter_freq}%").as_str()],
        ));
    };

    let filter_unit = filter_unit
        .as_deref()
        .map(str::trim)
        .filter(|unit| !unit.is_empty());
    let needs_unit_join =
        filter_unit.is_some() || filter_further_investigation.unwrap_or(false);

    if needs_unit_join {
        q = q
            .join_as(
                JoinType::InnerJoin,
                sigint_inbox_item::Relation::SigintInboxItemNetwork.def(),
                Alias::new("sigint_inbox_item_network"),
            )
            .join_as(
                JoinType::InnerJoin,
                sigint_inbox_item_network::Relation::SigintNetwork
                    .def()
                    .on_condition(|_left, right| {
                        Expr::col((right, sigint_network::Column::Deleted))
                            .eq(false)
                            .into_condition()
                    }),
                Alias::new("sigint_network"),
            )
            .join_as(
                JoinType::LeftJoin,
                sigint_network::Relation::SigintNetworkUnit.def(),
                Alias::new("sigint_network_unit"),
            )
            .join_as(
                JoinType::LeftJoin,
                sigint_network_unit::Relation::SigintUnit
                    .def()
                    .on_condition(|_left, right| {
                        Expr::col((right, sigint_unit::Column::Deleted))
                            .eq(false)
                            .into_condition()
                    }),
                Alias::new("sigint_unit"),
            )
    }

    if let Some(filter_unit) = filter_unit {
        q = q.filter(sigint_network::Column::Deleted.eq(false)).filter(
            Expr::cust_with_values(
                "lower(sigint_unit.name collate \"ru-x-icu\") ilike $1",
                vec![format!("%{}%", filter_unit.to_lowercase())],
            ),
        )
    };

    if filter_further_investigation.unwrap_or(false) {
        q = q.filter(sigint_network_unit::Column::Id.is_null())
    };

    Ok(q)
}

#[post("/api/sigint/latest-frequencies")]
pub async fn latest_frequencies(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<Vec<String>>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    let groups =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login)
            .await
            .c(h!())?;
    let now = Utc::now();
    let since = crate::stats::round_up_to_5min(
        (now - chrono::Duration::days(7)).naive_utc(),
    )
    .c(h!())?;
    let till = crate::stats::round_up_to_5min(now.naive_utc()).c(h!())?;
    let frequencies = crate::stats::read_latest_frequencies_aggregated(
        &env, groups, since, till,
    )
    .await
    .c(h!())?;
    Ok(Json(frequencies))
}

#[cfg(test)]
async fn read_latest_frequencies(
    db: &DatabaseConnection,
    groups: Vec<String>,
    week_ago: DateTime<Utc>,
    now: DateTime<Utc>,
) -> Result<Vec<String>, AppError> {
    #[derive(FromQueryResult)]
    struct FreqRes {
        freq: String,
    }

    let sql = r#"
        with recent_inbox as materialized (
            select id, freq
            from sigint_inbox_item
            where datetime >= $1
              and datetime <= $2
        ),
        recent_bounds as materialized (
            select min(id) as min_id
            from recent_inbox
        )
        select ri.freq
        from recent_inbox ri
        inner join signal_message sm on sm.id = ri.id
        inner join signal_message_group smg
            on smg.signal_message_id = ri.id
        cross join recent_bounds rb
        where ri.freq is not null
          and sm.deleted = false
          -- Keep datetime authoritative while bounding the existing
          -- (signal_message_id, group_master_key) index by recent IDs.
          and smg.signal_message_id >= rb.min_id
          and smg.group_master_key = any($3::text[])
        group by ri.freq
        order by ri.freq
    "#;
    let frequencies =
        FreqRes::find_by_statement(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            sql,
            vec![week_ago.into(), now.into(), groups.into()],
        ))
        .all(db)
        .await
        .c(h!())?;

    Ok(frequencies
        .into_iter()
        .map(|frequency| frequency.freq)
        .collect())
}

#[post("/api/sigint/freq/unit-stats")]
pub async fn freq_unit_stats(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<FreqUnitStatsRsp>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;

    #[derive(FromQueryResult)]
    struct Row {
        unit_id: i64,
        count: i64,
    }
    let units = sigint_network::Entity::find()
        // .join_as(
        //     JoinType::InnerJoin,
        //     sigint_inbox_item::Relation::SigintNetwork.def(),
        //     Alias::new("sigint_network"),
        // )
        .join_as(
            JoinType::InnerJoin,
            sigint_network::Relation::SigintNetworkFreq.def(),
            Alias::new("sigint_network_freq"),
        )
        .join_as(
            JoinType::InnerJoin,
            sigint_network::Relation::SigintNetworkUnit.def(),
            Alias::new("sigint_network_unit"),
        )
        .join_as(
            JoinType::InnerJoin,
            sigint_network_unit::Relation::SigintUnit.def(),
            Alias::new("sigint_unit"),
        )
        .select_only()
        .column_as(sigint_network_freq::Column::Freq.count(), "count")
        .column_as(sigint_unit::Column::Id, "unit_id")
        .filter(sigint_network::Column::Deleted.eq(false))
        .filter(sigint_network_freq::Column::ActiveTo.is_null())
        .filter(sigint_network_freq::Column::Deleted.eq(false))
        .filter(sigint_unit::Column::Active.eq(true))
        .filter(sigint_unit::Column::Deleted.eq(false))
        // .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        // .filter(sigint_inbox_item::Column::Datetime.lt(dt_till))
        .order_by_asc(sigint_unit::Column::Army)
        .order_by_asc(sigint_unit::Column::Division)
        .order_by_asc(sigint_unit::Column::Regiment)
        .order_by_asc(sigint_unit::Column::Battalion)
        .order_by_asc(sigint_unit::Column::Company)
        .group_by(sigint_unit::Column::Id)
        .group_by(sigint_unit::Column::Army)
        .group_by(sigint_unit::Column::Division)
        .group_by(sigint_unit::Column::Regiment)
        .group_by(sigint_unit::Column::Battalion)
        .group_by(sigint_unit::Column::Company);
    // println!("> sql: {}", units.build(DbBackend::Postgres).to_string());
    let units = units.into_model::<Row>().all(&env.dbx).await.c(h!())?;
    let mut res = vec![];
    for unit in units {
        res.push(FreqUnitStatRow {
            unit_id: unit.unit_id,
            count: unit.count,
        });
    }
    Ok(Json(FreqUnitStatsRsp { units: res }))
}

/// Повертає список позивних що були присутні в радіообміні відповідно до умов фільтрації (період дат, частота, підрозділ, позивний)
/// для подальшого формування фільтру
///
/// # API URL
/// - POST: /api/sigint/freq/callsigns-filter
///
/// # Параметри
///
/// * `user`: [`actix_identity::Identity`] - Ідентифікатор користувача, що виконує запит. Використовується для перевірки дозволів.
/// * `env`: [`actix_web::web::Data<Env>`] - де [`Env`] Середовище програми, що містить конфігурацію та підключення до бази даних.
/// * `req`: [`Json<CallsignsForFreqReq>`] - де [`CallsignsForFreqReq`] Тіло запиту, що містить параметри для фільтрації позивних
///
/// # Повертає
///
///  Функція повертає [`Json<CallsignsForFreqRsp>`], де [`CallsignsForFreqRsp`] - це масив позивних.
///
#[post("/api/sigint/freq/callsigns-filter")]
pub async fn callsigns_for_filter(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<CallsignsForFreqReq>,
) -> Result<Json<CallsignsForFreqRsp>, AppError> {
    println!("getting filters for callsigns-filter call: {:?}", req.freq);
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;

    let req = req.into_inner();
    let instant = std::time::Instant::now();

    let callsigns_res = bl_callsigns_for_filter(&env.dbx, &login, &req)
        .await
        .c(h!())?;

    debug!("callsigns op took: {:?}", instant.elapsed());

    Ok(Json(CallsignsForFreqRsp {
        callsigns: callsigns_res,
    }))
}

fn validate_callsigns(callsigns: &Vec<String>) -> Result<(), String> {
    lazy_static! {
        static ref RE: Regex =
            Regex::new(r"^[a-zA-Zа-яА-Я0-9 _-]{1,20}$").unwrap();
    };

    for callsign in callsigns {
        if !RE.is_match(callsign) {
            return Err(format!(
                "Не коректний позивний: '{callsign}'. Має містити лише кирилічні/латинські літери, цифри, '-', '_' або пробіл, та бути не довше 20 символів."
            ));
        }
    }

    Ok(())
}

/// Перевіряє, чи була присутня частота в базі даних за період починаючи з `since_date_inclusive_ms`
///
/// # API URL
/// - POST: /api/sigint/freq/freq-exists
///
/// # Параметри
///
/// * `user`: [`actix_identity::Identity`] - Ідентифікатор користувача, що виконує запит. Використовується для перевірки дозволів.
/// * `env`: [`actix_web::web::Data<Env>`] - де [`Env`] Середовище програми, що містить конфігурацію та підключення до бази даних.
/// * `req`: [`Json<FreqExistsReq>`] - де [`FreqExistsReq`] Тіло запиту, що містить параметри для пошуку частоти.
///
/// # Повертає
///
/// У випадку успішного виконання, функція повертає HttpResponse з кодом 200 OK.
/// Якщо частота не знайдена, повертається помилка 404 Not Found.
///
#[post("/api/sigint/freq/freq-exists")]
pub async fn freq_exists(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<FreqExistsReq>,
) -> Result<Json<()>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;

    let master_keys =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login)
            .await
            .c(h!())?;
    let dt_since = dt_from_millis(req.since_date_inclusive_ms)?;

    let freq_exists = signal_message::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(message_in_groups_exists(master_keys))
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Freq.eq(req.freq.clone()))
        .limit(1)
        .one(&env.dbx)
        .await
        .context(h!())?
        .is_some();

    if !freq_exists {
        return Err(AppError::NotFound);
    }

    Ok(Json(()))
}

/// Повертає список частот, активних за період починаючи з `since_date_inclusive_ms` по `till_date_noninclusive_ms`.
///
/// # API URL
/// - POST: /api/sigint/freqs-for-period
///
/// # Параметри
///
/// * `user`: [`actix_identity::Identity`] - Ідентифікатор користувача, що виконує запит. Використовується для перевірки дозволів.
/// * `env`: [`actix_web::web::Data<Env>`] - де [`Env`] Середовище програми, що містить конфігурацію та підключення до бази даних.
/// * `req`: [`Json<ListFreqsForPeriodReq>`] - де [`ListFreqsForPeriodReq`] Тіло запиту, що містить параметри для фільтрації частот.
///
/// # Повертає
///
///  Функція повертає [`Json<ListFreqsForPeriodRsp>`], де [`ListFreqsForPeriodRsp`] - це масив частот.
///
#[post("/api/sigint/freqs-for-period")]
pub async fn list_freqs_for_period(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ListFreqsForPeriodReq>,
) -> Result<Json<ListFreqsForPeriodRsp>, AppError> {
    has_any_role(
        &env.dbx,
        &login_id_from_identity(&user)?,
        vec!["Rer", "Api"],
    )
    .await?;
    let login = login_id_from_identity(&user)?;

    let master_keys =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login)
            .await
            .c(h!())?;
    let dt_since = dt_from_millis(req.since_date_inclusive_ms)?;

    let mut q = signal_message::Entity::find()
        .join_as(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
            Alias::new("sigint_inbox_item"),
        )
        .select_only()
        .column(sigint_inbox_item::Column::Freq)
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(message_in_groups_exists(master_keys))
        .filter(sigint_inbox_item::Column::Freq.is_not_null())
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .group_by(Expr::cust("1"))
        .order_by(Expr::cust("1"), Order::Asc);

    if let Some(dt_till) = req.till_date_noninclusive_ms {
        let dt_till = dt_from_millis(dt_till)?;
        q = q.filter(sigint_inbox_item::Column::Datetime.lt(dt_till));
    }

    let freqs: Vec<String> = q
        .into_tuple::<(String,)>()
        .all(&env.dbx)
        .await
        .context(h!())?
        .into_iter()
        .map(|(freq,)| freq)
        .collect();

    Ok(Json(ListFreqsForPeriodRsp { freqs }))
}

#[post("/api/sigint/freq/search")]
pub async fn freq_search(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<FreqSearchReq>,
) -> Result<Json<FreqSearchRsp>, AppError> {
    has_any_role(&env.dbx, &login_id_from_identity(&user)?, vec!["Rer"])
        .await
        .c(h!())?;

    let search_phrase = req.search.trim().to_lowercase();

    let mut query = sigint_network_freq::Entity::find()
        .select_only()
        .column_as(sigint_network_freq::Column::Freq, "name")
        .column_as(sigint_network_freq::Column::Id.min(), "id")
        .filter(sigint_network_freq::Column::Deleted.eq(false));

    if !search_phrase.is_empty() {
        query = query.filter(sea_query::extension::postgres::PgExpr::ilike(
            Expr::col(sigint_network_freq::Column::Freq),
            format!("%{}%", search_phrase),
        ));
    }

    let freqs: Vec<FreqSearchResult> = query
        .group_by(sigint_network_freq::Column::Freq)
        .order_by_asc(sigint_network_freq::Column::Freq)
        .limit(50)
        .into_model()
        .all(&env.dbx)
        .await
        .c(h!())?;

    Ok(Json(FreqSearchRsp { freqs }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::functest::tests::{
        cleanup, mk_sigint_inbox_item, mk_signal_group, mk_signal_message,
        mk_signal_message_group,
    };
    use chrono::Duration;
    use serial_test::serial;

    async fn create_frequency_message(
        db: &DatabaseConnection,
        group_master_key: &str,
        datetime: NaiveDateTime,
        freq: Option<&str>,
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
                freq: Set(freq.map(str::to_string)),
                date: Set(Some(local_datetime.date_naive().to_string())),
                time: Set(Some(
                    local_datetime.time().format("%H:%M:%S").to_string(),
                )),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_signal_message_group(
            db,
            signal_message_group::ActiveModel {
                signal_message_id: Set(message.id),
                group_master_key: Set(Some(group_master_key.to_string())),
                datasource_group_id: Set(None),
                created_at: Set(datetime),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    #[serial]
    async fn latest_frequencies_keep_datetime_and_access_semantics() {
        let env = cleanup().await.unwrap();
        let cutoff = Utc::now().naive_utc() - Duration::days(1);
        for group_master_key in
            ["latest-frequencies-allowed", "latest-frequencies-denied"]
        {
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

        create_frequency_message(
            &env.dbx,
            "latest-frequencies-allowed",
            cutoff + Duration::hours(1),
            Some("100.1"),
            false,
        )
        .await;
        create_frequency_message(
            &env.dbx,
            "latest-frequencies-allowed",
            cutoff - Duration::hours(1),
            Some("old-higher-id"),
            false,
        )
        .await;
        create_frequency_message(
            &env.dbx,
            "latest-frequencies-allowed",
            cutoff + Duration::hours(2),
            Some("100.1"),
            false,
        )
        .await;
        create_frequency_message(
            &env.dbx,
            "latest-frequencies-denied",
            cutoff + Duration::hours(3),
            Some("denied"),
            false,
        )
        .await;
        create_frequency_message(
            &env.dbx,
            "latest-frequencies-allowed",
            cutoff + Duration::hours(4),
            Some("deleted"),
            true,
        )
        .await;
        create_frequency_message(
            &env.dbx,
            "latest-frequencies-allowed",
            cutoff + Duration::hours(5),
            None,
            false,
        )
        .await;
        create_frequency_message(
            &env.dbx,
            "latest-frequencies-allowed",
            cutoff + Duration::days(30),
            Some("future"),
            false,
        )
        .await;

        let frequencies = read_latest_frequencies(
            &env.dbx,
            vec!["latest-frequencies-allowed".to_string()],
            cutoff.and_utc(),
            (cutoff + Duration::days(1)).and_utc(),
        )
        .await
        .unwrap();

        assert_eq!(frequencies, vec!["100.1".to_string()]);
    }

    #[test]
    fn validate_callsigns_all_valid() {
        let callsigns = vec![
            String::from("Alpha-1"),
            String::from("Bravo_123"),
            String::from("Тайга"),
            String::from("ВоинBravo"),
            String::from("Z_123"),
        ];

        let result = validate_callsigns(&callsigns);
        assert!(
            result.is_ok(),
            "Expected all callsigns to be valid, got error: {result:?}"
        );
    }

    #[test]
    fn validate_callsigns_special_characters() {
        let callsigns = vec![String::from("Ошибка!@#")];

        let result = validate_callsigns(&callsigns);
        assert!(
            result.is_err(),
            "Expected validation to fail for special characters."
        );
        assert_eq!(
            result.unwrap_err(),
            "Не коректний позивний: 'Ошибка!@#'. Має містити лише кирилічні/латинські літери, цифри, '-', '_' або пробіл, та бути не довше 20 символів."
        );
    }

    #[test]
    fn validate_callsigns_too_long() {
        let callsigns =
            vec![String::from("ОченьДлинныйПозывнойФейлитВалидацию123")];

        let result = validate_callsigns(&callsigns);
        assert!(
            result.is_err(),
            "Expected validation to fail for a too-long callsign."
        );
        assert_eq!(
            result.unwrap_err(),
            "Не коректний позивний: 'ОченьДлинныйПозывнойФейлитВалидацию123'. Має містити лише кирилічні/латинські літери, цифри, '-', '_' або пробіл, та бути не довше 20 символів."
        );
    }

    #[test]
    fn validate_callsigns_empty_callsign() {
        let callsigns = vec![String::from("")];

        let result = validate_callsigns(&callsigns);
        assert!(
            result.is_err(),
            "Expected validation to fail for an empty callsign."
        );
        assert_eq!(
            result.unwrap_err(),
            "Не коректний позивний: ''. Має містити лише кирилічні/латинські літери, цифри, '-', '_' або пробіл, та бути не довше 20 символів."
        );
    }

    #[test]
    fn validate_callsigns_mixed_valid_and_invalid() {
        let callsigns = vec![
            String::from("Борода-1"), // Valid
            String::from("Инвалид@"), // Invalid
            String::from("Ахмат"),    // Valid
        ];

        let result = validate_callsigns(&callsigns);
        assert!(
            result.is_err(),
            "Expected validation to fail for mixed callsigns."
        );
        assert_eq!(
            result.unwrap_err(),
            "Не коректний позивний: 'Инвалид@'. Має містити лише кирилічні/латинські літери, цифри, '-', '_' або пробіл, та бути не довше 20 символів."
        );
    }
}
