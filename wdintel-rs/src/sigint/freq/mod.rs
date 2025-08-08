use crate::entities::*;
use crate::error::AppError;
use crate::location::utils::to_location_list;
use crate::types::*;
use crate::utils::*;
use actix_web::post;
use actix_web::web::Json;
use chrono::prelude::*;
use lazy_static::lazy_static;
use log::*;
use regex::Regex;
use sea_orm::{sea_query::PostgresQueryBuilder, *};
use sea_orm::{
    ColumnTrait, Condition, EntityTrait, QueryFilter, QuerySelect, Statement,
};
use sea_query::{
    extension::postgres::PgExpr, Alias, CommonTableExpression, Expr, Query,
    SimpleExpr,
};

use std::collections::{BTreeSet, HashMap};

use self::types::*;

pub mod types;
pub mod util;

#[post("/api/sigint/freqs/daily")]
pub async fn freq_activity_daily(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<FreqStatsReq>,
) -> Result<Json<FreqDailyActivityCount>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    let login = user.id()?;
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
            JoinType::LeftJoin,
            signal_message::Relation::SignalGroup.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::Datasource.def(),
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
        .filter(Expr::cust("sigint_zone_datasource.group_master_key=signal_message.group_master_key"))
        .filter(login::Column::Login.eq(login))
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
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
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
        .filter(
            signal_message::Column::GroupMasterKey.is_in(
                crate::users::get_identity_sigint_groups_noimport(
                    &env.dbx,
                    &user,
                    &env.config,
                )
                .await?,
            ),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .group_by(sigint_inbox_item::Column::Unit)
        .group_by(sigint_inbox_item::Column::Freq)
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till))
        .filter(sigint_inbox_item::Column::Unit.is_not_null())
        .filter(sigint_inbox_item::Column::Freq.is_in(req.freqs.clone()));

    if let Some(groups) = &req.filter_group_master_keys {
        alt_units = alt_units.filter(
            signal_message::Column::GroupMasterKey.is_in(groups.clone()),
        )
    }

    if let Some(senders) = &req.filter_sender_profile_ids {
        alt_units = alt_units
            .filter(signal_message::Column::Sender.is_in(senders.clone()))
    }

    let res_alt_units = alt_units
        .into_model::<FreqAltUnitMessageCount>()
        .all(&env.dbx)
        .await?;

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
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
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
        .filter(
            signal_message::Column::GroupMasterKey.is_in(
                crate::users::get_identity_sigint_groups_noimport(
                    &env.dbx,
                    &user,
                    &env.config,
                )
                .await?,
            ),
        )
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till))
        .filter(sigint_inbox_item::Column::Freq.eq(req.freq.clone()));

    Ok(Json(ListPointsByFreqRsp {
        points: points.into_model::<FreqPoint>().all(&env.dbx).await?,
    }))
}

#[post("/api/sigint/freq/groups-per-day")]
pub async fn list_groups_by_freqs_per_day(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ListGroupsByFreqsPerDayReq>,
) -> Result<Json<HashMap<String, HashMap<i64, HashMap<String, i64>>>>, AppError>
{
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    let dt_till = dt_from_millis(req.till_date_noninclusive_ms)?;

    let callsigns = signal_message::Entity::find()
        .join_as(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
            Alias::new("sigint_inbox_item"),
        )
        .join_as(
            JoinType::LeftJoin,
            signal_message::Relation::SignalGroup.def(),
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
        .filter(
            signal_message::Column::GroupMasterKey.is_in(
                crate::users::get_identity_sigint_groups_noimport(
                    &env.dbx,
                    &user,
                    &env.config,
                )
                    .await?,
            ),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(sigint_inbox_item::Column::Datetime.lte(dt_till))
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_from_millis(req.since_date_inclusive_ms).context(h!())?))
        .filter(Expr::cust_with_values("sigint_inbox_item.datetime >= $1 - INTERVAL '10 days'", vec![dt_till]))
        .filter(sigint_inbox_item::Column::Freq.is_in(req.freqs.clone()));

    let callsigns = callsigns
        .clone()
        .order_by_desc(Expr::cust("freq, day, \"group\""));

    // println!(
    //     "> sql: {}",
    //     callsigns.clone().build(DbBackend::Postgres).to_string()
    // );
    #[derive(FromQueryResult)]
    pub struct FreqGroupsMessageCountByDay {
        pub freq: String,
        pub count: i64,
        pub group: String,
        pub day: i64,
    }

    let mut res = HashMap::new();
    for row in callsigns
        .into_model::<FreqGroupsMessageCountByDay>()
        .all(&env.dbx)
        .await?
    {
        let freq = row.freq.clone();
        let day = row.day;
        let group = row.group.clone();
        let count = row.count;
        if !res.contains_key(&freq) {
            res.insert(freq.clone(), HashMap::new());
        }
        let freq_map = res.get_mut(&freq).unwrap();
        if !freq_map.contains_key(&day) {
            freq_map.insert(day, HashMap::new());
        }
        let day_map = freq_map.get_mut(&day).unwrap();
        day_map.insert(group.clone(), count);
    }

    Ok(Json(res))
}

#[post("/api/sigint/freq/callsigns")]
pub async fn list_callsigns_by_freqs(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ListCallsignsByFreqsReq>,
) -> Result<Json<HashMap<String, Vec<String>>>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    let dt_since = dt_from_millis(req.since_date_inclusive_ms)?;
    let dt_till = dt_from_millis(req.till_date_noninclusive_ms)?;

    let callsigns = signal_message::Entity::find()
        .join_as(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
            Alias::new("sigint_inbox_item"),
        )
        .select_only()
        .column_as(
            Expr::cust(
                "jsonb_array_elements_text(sigint_inbox_item.callsigns)",
            ),
            "callsign",
        )
        .column_as(sigint_inbox_item::Column::Freq, "freq")
        .group_by(Expr::cust(
            "jsonb_array_elements_text(sigint_inbox_item.callsigns)",
        ))
        .group_by(sigint_inbox_item::Column::Freq)
        .filter(
            signal_message::Column::GroupMasterKey.is_in(
                crate::users::get_identity_sigint_groups_noimport(
                    &env.dbx,
                    &user,
                    &env.config,
                )
                .await?,
            ),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till))
        .filter(sigint_inbox_item::Column::Freq.is_in(req.freqs.clone()));

    // println!(
    //     "> sql: {}",
    //     callsigns.clone().build(DbBackend::Postgres).to_string()
    // );
    let res_callsigns = callsigns
        .into_model::<FreqCallsignsMessage>()
        .all(&env.dbx)
        .await?;

    let mut res = HashMap::new();
    for row in res_callsigns {
        if !res.contains_key(&row.freq) {
            res.insert(row.freq.clone(), Vec::new());
        }
        let val = res.get_mut(&row.freq).context(h!())?;
        if !(val.contains(&row.callsign)) {
            val.push(row.callsign);
        }
    }

    Ok(Json(res))
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
    crate::users::has_any_role(&env.dbx, &user.id()?, vec!["Rer", "Api"])
        .await?;
    let login = user.id()?;
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

    let freqs_period = match &req.filter_callsigns {
        Some(filter_callsigns) => {
            if let Err(ref e) = validate_callsigns(filter_callsigns) {
                println!("> error validating collsings for filter: {}", e);
                return Err(AppError::BL { msg: e.to_string() });
            }

            let callsings_postgres_array = format!(
                "ARRAY[{}]",
                filter_callsigns
                    .iter()
                    .map(|s| format!("'{}'", s.replace('\'', "''")))
                    .collect::<Vec<_>>()
                    .join(",")
            );

            let mut subquery = signal_message::Entity::find()
                .join_as(
                    JoinType::InnerJoin,
                    signal_message::Relation::SigintInboxItem.def(),
                    Alias::new("sigint_inbox_item"),
                )
                .select_only()
                // .column_as(signal_message::Column::Id.count(), "message_count")
                .column_as(
                    SimpleExpr::Custom("sigint_inbox_item.freq".to_string()),
                    "freq",
                )
                .column_as(
                    SimpleExpr::Custom(
                        "string_agg(sigint_inbox_item.location_v2, '')"
                            .to_string(),
                    ),
                    "location_v2",
                )
                .column_as(
                    SimpleExpr::Custom(
                        "jsonb_array_elements_text(sigint_inbox_item.callsigns)"
                            .to_string(),
                    ),
                    "callsign",
                );

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
            .await?;

            subquery = subquery.filter(Expr::cust(format!(
                "\"sigint_inbox_item\".\"callsigns\" ?| {}",
                callsings_postgres_array
            )));

            subquery = subquery.group_by(sigint_inbox_item::Column::Freq);
            subquery = subquery.group_by(Expr::cust("callsign".to_string()));

            let cte_alias = Alias::new("unique_callsigns");

            let unique_callsigns_cte = CommonTableExpression::new()
                .query(subquery.into_query().to_owned())
                .table_name(cte_alias.clone())
                .to_owned();

            let main_query = Query::select()
                .expr_as(
                    Expr::cust("unique_callsigns.freq".to_string()),
                    Alias::new("freq"),
                )
                .expr_as(
                    Expr::cust(
                        "string_agg(unique_callsigns.location_v2, '')"
                            .to_string(),
                    ),
                    Alias::new("location_v2"),
                )
                .expr_as(
                    Expr::cust("count(*)".to_string()),
                    Alias::new("message_count"),
                )
                .from(Alias::new("unique_callsigns"))
                .and_where(Expr::cust(format!(
                    "unique_callsigns.callsign = ANY({})",
                    callsings_postgres_array
                )))
                .add_group_by(vec![Expr::cust("freq")])
                .order_by_expr(Expr::cust("message_count"), Order::Desc)
                .to_owned();

            let combined_query = Query::with()
                .cte(unique_callsigns_cte)
                .clone()
                .query(main_query);

            &combined_query.to_string(PostgresQueryBuilder)
        }
        None => {
            let mut freqs_per = signal_message::Entity::find()
                .join_as(
                    JoinType::InnerJoin,
                    signal_message::Relation::SigintInboxItem.def(),
                    Alias::new("sigint_inbox_item"),
                )
                .select_only()
                .column_as(signal_message::Column::Id.count(), "message_count")
                .column_as(
                    SimpleExpr::Custom("sigint_inbox_item.freq".to_string()),
                    "freq",
                )
                .column_as(
                    SimpleExpr::Custom(
                        "string_agg(sigint_inbox_item.location_v2, '')"
                            .to_string(),
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
            .await?;

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
            &freqs_per.build(DbBackend::Postgres).to_string()
        }
    };

    // let freqs_period_count: u64 =
    //     freqs_period.clone().count(&env.dbx).await?;
    // println!("> freqs in period count: {}", freqs_period_count);
    // freqs_period = freqs_period.limit(LIMIT);
    trace!("> freqs sql: {}", freqs_period);

    let freqs_period: Vec<(String, i64, Option<String>)> = env
        .dbx
        .query_all(Statement::from_string(
            DatabaseBackend::Postgres,
            freqs_period.to_string(),
        ))
        .await?
        .iter()
        .flat_map(|row| {
            let freq_res = FreqRes::from_query_result(row, "").unwrap();
            freq_res.freq.clone().map(|f| {
                (f, freq_res.message_count, freq_res.location_v2.clone())
            })
        })
        .collect();
    // println!("> freqs in period count: {}", freqs_period.len());

    #[derive(FromQueryResult)]
    struct BeforeRes {
        freq: Option<String>,
    }

    let before_since = dt_since - chrono::Duration::days(PERIOD_DAYS);
    let before_till = dt_since.clone();
    let before_res = signal_message::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .select_only()
        .column_as(Expr::col(sigint_inbox_item::Column::Freq), "freq")
        .filter(signal_message::Column::GroupMasterKey.is_in(
            crate::users::get_identity_sigint_groups(&env.dbx, &login).await?,
        ))
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(sigint_inbox_item::Column::Datetime.gte(before_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(before_till))
        .group_by(sea_query::expr::SimpleExpr::Custom("freq".to_string()))
        .order_by_asc(sigint_inbox_item::Column::Freq);
    // let before_count: u64 = before_res.clone().count(&env.dbx).await?;
    // println!("> before count: {}", before_count);
    // before_res = before_res.limit(LIMIT);
    // println!(
    //     "> before sql: {}",
    //     before_res.build(DbBackend::Postgres).to_string()
    // );
    let before_res: BTreeSet<String> = before_res
        .into_model::<BeforeRes>()
        .all(&env.dbx)
        .await?
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
    for (freq, message_count, location_v2) in freqs_period {
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
            .order_by_asc(sigint_network::Column::CreatedAt)
            .all(&env.dbx)
            .await?;
        let created_at = networks
            .first()
            .map(|x| x.created_at.and_utc().timestamp_millis());

        let last_updated_network = networks.iter().max_by_key(|n| n.updated_at);

        let is_new = !before_res.contains(&freq);
        let network_ids = networks.iter().map(|x| x.id).collect();
        let last_updated_by =
            last_updated_network.map(|x| x.updated_by.clone()).flatten();
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

        if freqs.len() >= LIMIT {
            show_load_more = true;
            break;
        }
    }

    Ok(Json(ListFreqsRsp {
        show_load_more,
        freqs,
    }))
}
/// This API is slow. DO NOT USE FOR POPULAR PAGES TO GET FREQ INFO. Only intended for admin pages.
#[post("/api/sigint/freqs-v2")]
pub async fn list_freqs_v2(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ListFreqsReq>,
) -> Result<Json<ListFreqsV2Rsp>, AppError> {
    crate::users::has_any_role(&env.dbx, &user.id()?, vec!["Rer", "Api"])
        .await?;
    let login = user.id()?;
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

    let freqs_period = match &req.filter_callsigns {
        Some(filter_callsigns) => {
            if let Err(ref e) = validate_callsigns(filter_callsigns) {
                println!("> error validating collsings for filter: {}", e);
                return Err(AppError::BL { msg: e.to_string() });
            }

            let callsings_postgres_array = format!(
                "ARRAY[{}]",
                filter_callsigns
                    .iter()
                    .map(|s| format!("'{}'", s.replace('\'', "''")))
                    .collect::<Vec<_>>()
                    .join(",")
            );

            let mut subquery = signal_message::Entity::find()
                .join_as(
                    JoinType::InnerJoin,
                    signal_message::Relation::SigintInboxItem.def(),
                    Alias::new("sigint_inbox_item"),
                )
                .select_only()
                // .column_as(signal_message::Column::Id.count(), "message_count")
                .column(sigint_inbox_item::Column::PostId)
                .column_as(
                    SimpleExpr::Custom("sigint_inbox_item.freq".to_string()),
                    "freq",
                )
                .column_as(
                    SimpleExpr::Custom(
                        "string_agg(sigint_inbox_item.location_v2, '')"
                            .to_string(),
                    ),
                    "location_v2",
                )
                .column_as(
                    SimpleExpr::Custom(
                        "jsonb_array_elements_text(sigint_inbox_item.callsigns)"
                            .to_string(),
                    ),
                    "callsign",
                );

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
            .await?;

            subquery = subquery.filter(Expr::cust(format!(
                "\"sigint_inbox_item\".\"callsigns\" ?| {}",
                callsings_postgres_array
            )));

            subquery = subquery.group_by(sigint_inbox_item::Column::Freq);
            subquery = subquery.group_by(Expr::cust("callsign".to_string()));

            let cte_alias = Alias::new("unique_callsigns");

            let unique_callsigns_cte = CommonTableExpression::new()
                .query(subquery.into_query().to_owned())
                .table_name(cte_alias.clone())
                .to_owned();

            let main_query = Query::select()
                .expr_as(
                    Expr::cust("unique_callsigns.freq".to_string()),
                    Alias::new("freq"),
                )
                .expr_as(
                    Expr::cust(
                        "string_agg(unique_callsigns.location_v2, '')"
                            .to_string(),
                    ),
                    Alias::new("location_v2"),
                )
                .expr_as(
                    Expr::cust("count(*)".to_string()),
                    Alias::new("message_count"),
                )
                .from(Alias::new("unique_callsigns"))
                .and_where(Expr::cust(format!(
                    "unique_callsigns.callsign = ANY({})",
                    callsings_postgres_array
                )))
                .add_group_by(vec![Expr::cust("freq"), Expr::cust("post_id")])
                .order_by_expr(Expr::cust("message_count"), Order::Desc)
                .to_owned();

            let combined_query = Query::with()
                .cte(unique_callsigns_cte)
                .clone()
                .query(main_query);

            &combined_query.to_string(PostgresQueryBuilder)
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
                    SimpleExpr::Custom("sigint_inbox_item.freq".to_string()),
                    "freq",
                )
                .column_as(
                    SimpleExpr::Custom(
                        "string_agg(sigint_inbox_item.location_v2, '')"
                            .to_string(),
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
            .await?;

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
            &freqs_per.build(DbBackend::Postgres).to_string()
        }
    };

    // let freqs_period_count: u64 =
    //     freqs_period.clone().count(&env.dbx).await?;
    // println!("> freqs in period count: {}", freqs_period_count);
    // freqs_period = freqs_period.limit(LIMIT);
    trace!("> freqs sql: {}", freqs_period);

    let freqs_period: Vec<(String, i64, Option<String>, Option<i64>)> = env
        .dbx
        .query_all(Statement::from_string(
            DatabaseBackend::Postgres,
            freqs_period.to_string(),
        ))
        .await?
        .iter()
        .flat_map(|row| {
            let freq_res = FreqRes::from_query_result(row, "").unwrap();
            freq_res.freq.clone().map(|f| {
                (
                    f,
                    freq_res.message_count,
                    freq_res.location_v2.clone(),
                    freq_res.post_id,
                )
            })
        })
        .collect();
    // println!("> freqs in period count: {}", freqs_period.len());

    #[derive(FromQueryResult)]
    struct BeforeRes {
        freq: Option<String>,
    }

    let before_since = dt_since - chrono::Duration::days(PERIOD_DAYS);
    let before_till = dt_since.clone();
    let before_res = signal_message::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .select_only()
        .column_as(Expr::col(sigint_inbox_item::Column::Freq), "freq")
        .filter(signal_message::Column::GroupMasterKey.is_in(
            crate::users::get_identity_sigint_groups(&env.dbx, &login).await?,
        ))
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(sigint_inbox_item::Column::Datetime.gte(before_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(before_till))
        .group_by(sea_query::expr::SimpleExpr::Custom("freq".to_string()))
        .order_by_asc(sigint_inbox_item::Column::Freq);
    // let before_count: u64 = before_res.clone().count(&env.dbx).await?;
    // println!("> before count: {}", before_count);
    // before_res = before_res.limit(LIMIT);
    // println!(
    //     "> before sql: {}",
    //     before_res.build(DbBackend::Postgres).to_string()
    // );
    let before_res: BTreeSet<String> = before_res
        .into_model::<BeforeRes>()
        .all(&env.dbx)
        .await?
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
        if show_load_more {
            if !last_freq.eq(&freq) {
                break;
            }
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
            .order_by_asc(sigint_network::Column::CreatedAt)
            .all(&env.dbx)
            .await?;
        let created_at = networks
            .first()
            .map(|x| x.created_at.and_utc().timestamp_millis());

        let last_updated_network = networks.iter().max_by_key(|n| n.updated_at);

        let is_new = !before_res.contains(&freq);
        let network_ids = networks.iter().map(|x| x.id).collect();
        let last_updated_by =
            last_updated_network.map(|x| x.updated_by.clone()).flatten();
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

    q = q.filter(
        signal_message::Column::GroupMasterKey.is_in(
            crate::users::get_identity_sigint_groups_noimport(
                &env.dbx,
                &user,
                &env.config,
            )
            .await?,
        ),
    );

    q = q.filter(signal_message::Column::Deleted.eq(false));
    q = q.filter(sigint_inbox_item::Column::Datetime.gte(dt_since));
    q = q.filter(sigint_inbox_item::Column::Datetime.lt(dt_till));

    if let Some(filter_group_master_keys) = filter_group_master_keys {
        q = q.filter(
            signal_message::Column::GroupMasterKey
                .is_in(filter_group_master_keys.clone()),
        );
    };

    if let Some(filter_sender_profile_ids) = filter_sender_profile_ids {
        q = q.filter(
            signal_message::Column::Sender
                .is_in(filter_sender_profile_ids.clone()),
        );
    };

    if let Some(filter_freq) = filter_freq {
        q = q.filter(Expr::cust_with_values(
            "sigint_inbox_item.freq ilike $1",
            vec![format!("{}%", filter_freq).as_str()],
        ));
    };

    let needs_unit_join = filter_unit.as_ref().map_or(false, |s| !s.is_empty())
        || filter_further_investigation.unwrap_or(false);

    if needs_unit_join {
        q = q
            .join_as(
                JoinType::InnerJoin,
                sigint_inbox_item::Relation::SigintNetworkFreq.def(),
                Alias::new("sigint_network_freq"),
            )
            .join_as(
                JoinType::InnerJoin,
                sigint_network_freq::Relation::SigintNetwork.def(),
                Alias::new("sigint_network"),
            )
            .join_as(
                JoinType::LeftJoin,
                sigint_network::Relation::SigintNetworkUnit.def(),
                Alias::new("sigint_network_unit"),
            )
            .join_as(
                JoinType::LeftJoin,
                sigint_network_unit::Relation::SigintUnit.def(),
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
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    let login = user.id()?;

    #[derive(FromQueryResult)]
    struct FreqRes {
        freq: Option<String>,
    }
    let now = Utc::now();
    let week_ago = now - chrono::Duration::days(7);
    let freqs_period = signal_message::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .select_only()
        .column_as(Expr::col(sigint_inbox_item::Column::Freq), "freq")
        .filter(signal_message::Column::GroupMasterKey.is_in(
            crate::users::get_identity_sigint_groups(&env.dbx, &login).await?,
        ))
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(sigint_inbox_item::Column::Datetime.gte(week_ago))
        .group_by(sea_query::expr::SimpleExpr::Custom("freq".to_string()))
        .order_by_asc(sigint_inbox_item::Column::Freq)
        .into_model::<FreqRes>()
        .all(&env.dbx)
        .await?
        .iter()
        .flat_map(|x| x.freq.clone())
        .collect();

    Ok(Json(freqs_period))
}

#[post("/api/sigint/freq/unit-stats")]
pub async fn freq_unit_stats(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<FreqUnitStatsRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;

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
    let units = units.into_model::<Row>().all(&env.dbx).await?;
    let mut res = vec![];
    for unit in units {
        res.push(FreqUnitStatRow {
            unit_id: unit.unit_id,
            count: unit.count,
        });
    }
    Ok(Json(FreqUnitStatsRsp { units: res }))
}

#[post("/api/sigint/freq/callsigns-filter")]
pub async fn callsigns_for_filter(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<CallsignsForFreqReq>,
) -> Result<Json<CallsignsForFreqRsp>, AppError> {
    println!("getting filters for callsigns-filter call: {:?}", req.freq);

    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    let dt_since = dt_from_millis(req.since_date_inclusive_ms)?;
    let dt_till = dt_from_millis(req.till_date_noninclusive_ms)?;
    let login = user.id()?;
    let master_keys =
        crate::users::get_identity_sigint_groups(&env.dbx, &login).await?;

    let instant = std::time::Instant::now();

    #[derive(FromQueryResult)]
    struct CallsignsRes {
        callsign: Option<String>,
    }

    let mut callsigns_res = sigint_inbox_item::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .select_only()
        .column_as(
            Expr::cust("jsonb_array_elements_text(callsigns)"),
            "callsign",
        )
        .distinct()
        .filter(signal_message::Column::GroupMasterKey.is_in(master_keys))
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till));
    if let Some(freq) = &req.freq {
        callsigns_res = callsigns_res.filter(
            Expr::col(sigint_inbox_item::Column::Freq)
                .ilike(format!("{}%", freq)),
        );
    };

    if let Some(unit) = &req.unit {
        callsigns_res = callsigns_res.filter(
            Expr::col(sigint_inbox_item::Column::UnitV2)
                .ilike(format!("%{}%", unit)),
        );
    };

    callsigns_res = callsigns_res.order_by(Expr::cust("callsign"), Order::Asc);

    let callsigns_res: Vec<CallsignsRes> = callsigns_res
        .into_model::<CallsignsRes>()
        .all(&env.dbx)
        .await?;

    let mut callsigns = vec![];
    for x in callsigns_res {
        let Some(callsign) = x.callsign else { continue };
        callsigns.push(FreqCallsign { callsign });
    }

    debug!("callsigns op took: {:?}", instant.elapsed());

    Ok(Json(CallsignsForFreqRsp { callsigns }))
}

fn validate_callsigns(callsigns: &Vec<String>) -> Result<(), String> {
    lazy_static! {
        static ref RE: Regex =
            Regex::new(r"^[a-zA-Zа-яА-Я0-9 _-]{1,20}$").unwrap();
    };

    for callsign in callsigns {
        if !RE.is_match(callsign) {
            return Err(format!(
                "Не коректний позивний: '{}'. Має містити лише кирилічні/латинські літери, цифри, '-', '_' або пробіл, та бути не довше 20 символів.",
                callsign
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
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    let login = user.id()?;

    let master_keys =
        crate::users::get_identity_sigint_groups(&env.dbx, &login).await?;
    let dt_since = dt_from_millis(req.since_date_inclusive_ms)?;

    let freq_exists = signal_message::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(signal_message::Column::GroupMasterKey.is_in(master_keys))
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
    crate::users::has_any_role(&env.dbx, &user.id()?, vec!["Rer", "Api"])
        .await?;
    let login = user.id()?;

    let master_keys =
        crate::users::get_identity_sigint_groups(&env.dbx, &login).await?;
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
        .filter(signal_message::Column::GroupMasterKey.is_in(master_keys))
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

#[cfg(test)]
mod tests {
    use super::*;

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
            "Expected all callsigns to be valid, got error: {:?}",
            result
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
