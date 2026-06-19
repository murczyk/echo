use crate::entities::{prelude::*, *};
use crate::palitra::worker::do_palitra_highlight;
use crate::rer_importer::types::*;

use crate::config::*;
use crate::error::AppError;
use crate::event_stream::fanout_mult;
use crate::event_stream::types::{EventMsg, EventType};
use crate::rer_importer::inbox::bl::*;
use crate::rer_importer::inbox::query::*;
use crate::session::record_page_visit;
use crate::types::*;
use crate::utils::orm::ArrayColumnOps;
use actix_identity::Identity;
use actix_web::web::{Data, Json};
use actix_web::{get, post};
use chrono::*;
use echo_migration::{Expr, PostgresQueryBuilder};
use itertools::Itertools;
use sea_orm::*;
use std::collections::BTreeSet;

pub(crate) mod bl;
pub mod metadata;
pub mod query;

async fn apply_test_inbox_settings(
    env: &Env,
    req: &mut InboxMessagesReq,
) -> Result<Option<i64>, AppError> {
    let settings = crate::system_settings::get_active_system_settings(&env.dbx)
        .await
        .c(h!())?;
    let Some(settings) = settings else {
        return Ok(None);
    };
    if !settings.rer_duty_test_enabled {
        return Ok(None);
    }
    if req.since_id_noninclusive.is_none()
        && req.before_id_noninclusive.is_none()
        && req.since_date_inclusive_ms.is_none()
        && req.till_date_inclusive_ms.is_none()
    {
        let since_ms = settings.rer_duty_test_since_ms.max(0);
        let window_ms =
            Duration::minutes(env.config.rer_duty_test_source_window_minutes())
                .num_milliseconds();
        req.since_date_inclusive_ms = Some(since_ms);
        req.till_date_inclusive_ms = Some(since_ms + window_ms);
    }
    req.nolimit = Some(true);
    Ok(Some(settings.rer_duty_test_limit.max(1)))
}

#[post("/api/rer-importer/get-inbox-map")]
async fn get_inbox_map(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<MapPointsReq>,
) -> Result<Json<MapPointsRsp>, AppError> {
    let user_id = user.id().c(h!())?;
    let page_id = req.page_id.clone();
    let req = req.into_inner();

    let payload = serde_json::to_value(&req).context(h!())?;
    record_page_visit(&user_id, &page_id, &env, Some(payload))
        .await
        .context(h!())?;
    crate::users::has_role(&env.dbx, &user_id, "Rer")
        .await
        .c(h!())?;
    let login = user.id().c(h!())?;

    let mut filter = req.inbox_items_filter.clone();
    filter.nolimit = Some(true); // fetch all points
    if let Some(map_filter) = req.map_filter.clone() {
        let freq_whitelist = map_filter
            .network_units
            .iter()
            .flat_map(|r| r.frequencies.iter())
            .unique()
            .cloned()
            .collect_vec();
        filter.selected_freqs = Some(freq_whitelist);
    }

    let inbox_items = get_inbox_map_items(&login, &env, &filter)
        .await
        .context(h!())?;
    info!("messages found: {}", inbox_items.len());
    let points = crate::location::peleng::collect_inbox_item_pelengs(
        &inbox_items,
        &env.dbx,
    )
    .await
    .context(h!())?;
    info!("points found: {}", points.len());
    let active_range = get_inbox_filter_active_range(&filter).c(h!())?;
    let units = crate::sigint::network::bl::collect_network_units(
        &inbox_items,
        &env.dbx,
        req.map_filter,
        active_range,
    )
    .await
    .context(h!())?;
    let network_units = aggregate_network_units(units);
    info!("units found: {}", points.len());
    let points = collect_map_points(inbox_items, points).context(h!())?;
    Ok(Json(MapPointsRsp {
        network_units,
        points,
    }))
}

fn get_inbox_filter_active_range(
    filter: &InboxMessagesReq,
) -> Result<Option<(NaiveDateTime, NaiveDateTime)>, AppError> {
    let has_date_filter = filter.since_date_inclusive_ms.is_some()
        || filter.till_date_inclusive_ms.is_some();
    if has_date_filter {
        let dt_since = match filter.since_date_inclusive_ms {
            Some(ms) => crate::utils::dt_from_millis(ms)?,
            None => Utc::now().naive_utc() - Duration::days(RER_DUTY_MAX_DAYS),
        };
        let dt_till = match filter.till_date_inclusive_ms {
            Some(ms) => crate::utils::dt_from_millis(ms)?,
            None => Utc::now().naive_utc(),
        };
        return Ok(Some((dt_since, dt_till)));
    }

    if filter.since_id_noninclusive.is_none() {
        let dt_since =
            Utc::now().naive_utc() - Duration::days(RER_DUTY_MAX_DAYS);
        return Ok(Some((dt_since, Utc::now().naive_utc())));
    }

    Ok(None)
}

#[post("/api/rer-importer/messages-by-id")]
async fn messages_by_id(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<MessageIdsReq>,
) -> Result<Json<MessageIdsRsp>, AppError> {
    crate::users::has_any_role(
        &env.dbx,
        &user.id().c(h!())?,
        vec!["Rer", "ApiAgent"],
    )
    .await
    .c(h!())?;
    let login = user.id().c(h!())?;
    let logins = crate::users::get_organism_logins(&env.dbx, user)
        .await
        .context(h!())?;

    let messages =
        messages_by_id_bl(&login, &logins, &env, &req.message_ids).await?;
    Ok(Json(MessageIdsRsp { messages }))
}

async fn messages_by_id_bl(
    login: &str,
    logins: &Vec<String>,
    env: &Env,
    message_ids: &[i64],
) -> Result<Vec<(i64, InboxMessage)>, AppError> {
    let sigint_groups =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, login)
            .await
            .c(h!())?;
    let mut messages = SignalMessage::find()
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::DatasourceGroup.def(),
        )
        .join(
            JoinType::LeftJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .join(
            JoinType::LeftJoin,
            datasource_group::Relation::SignalGroup.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintPost.def(),
        );

    messages = add_inbox_message_columns(messages);

    messages = messages
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(datasource_group::Column::GroupMasterKey.eq_any(sigint_groups))
        .filter(signal_message::Column::Id.eq_any(message_ids.to_vec()));

    let query_tags = sigint_inbox_item_tag::Entity::find()
        .select_only()
        .join(JoinType::LeftJoin, sigint_inbox_item_tag::Relation::Login.def())
        .expr_as(
            Expr::cust_with_exprs(
                "array_agg($1) filter (where $2 >= $3)",
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
        .group_by(sigint_inbox_item_tag::Column::SigintInboxItemId)
        .into_query();
    let query_metadata = build_inbox_metadata_lateral_query();

    let q_tags = "q_tags";
    let q_metadata = "q_metadata";

    let (sql, values) = messages
        .into_query()
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
        .build(PostgresQueryBuilder);

    let messages = InboxMessageDesc::find_by_statement(
        Statement::from_sql_and_values(DatabaseBackend::Postgres, sql, values),
    )
    .all(&env.dbx)
    .await
    .context(h!())?;
    let req = InboxMessagesReq {
        highlight_points: Some(true),
        ..Default::default()
    };
    let messages =
        aggregate_to_inbox_messages(login, messages, logins, &&req, &env)
            .await
            .context(h!())?;
    Ok(messages)
}

#[post("/api/rer-importer/get-inbox")]
async fn inbox_messages(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<InboxMessagesReq>,
) -> Result<Json<InboxMessagesRsp>, AppError> {
    let user_id = user.id().c(h!())?;
    let page_id = req.page_id.clone();
    let mut req = req.into_inner();
    let skip_group_stats = req.skip_group_stats.unwrap_or(false);

    let payload = serde_json::to_value(&req).context(h!())?;
    record_page_visit(&user_id, &page_id, &env, Some(payload))
        .await
        .context(h!())?;
    crate::users::has_any_role(&env.dbx, &user_id, vec!["Rer", "ApiAgent"])
        .await
        .c(h!())?;
    let is_admin =
        crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Admin")
            .await
            .is_ok();
    let login = user.id().c(h!())?;
    let logins = crate::users::get_organism_logins(&env.dbx, user)
        .await
        .context(h!())?;
    let test_limit = apply_test_inbox_settings(&env, &mut req).await?;
    let inbox_items = if let Some(limit) = test_limit {
        get_inbox_messages_limited(&login, &logins, &env, &req, limit)
            .await
            .context(h!())?
    } else {
        get_inbox_messages(&login, &logins, &env, &req)
            .await
            .context(h!())?
    };
    let txn = env.dbx.begin().await.context(h!())?;
    let callsigns: Vec<CallsignInfoRes> =
        load_inbox_callsigns(&inbox_items, &env).await.c(h!())?;
    let signal_profiles = load_inbox_signal_profiles(&inbox_items, &env.dbx)
        .await
        .c(h!())?;
    let signal_groups = load_inbox_signal_groups(
        &inbox_items,
        &env.dbx,
        is_admin,
        skip_group_stats,
    )
    .await
    .c(h!())?;

    let freq_pelengs_summary = match req.calculate_freq_pelengs_summary {
        Some(true) => load_inbox_freq_pelengs_summary(&inbox_items, &env.dbx)
            .await
            .map(Some)
            .context(h!())?,
        _ => None,
    };
    txn.commit().await.context(h!())?;
    let page_limit = test_limit.or_else(|| {
        if req.nolimit == Some(true) {
            None
        } else {
            Some(20)
        }
    });

    Ok(Json(InboxMessagesRsp {
        inbox_items,
        callsigns,
        signal_profiles,
        signal_groups,
        freq_pelengs_summary,
        page_limit,
    }))
}

#[post("/api/rer-importer/get-inbox-group-stats")]
async fn inbox_group_stats(
    user: Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<InboxByGroupDigestRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
    let login = user.id().c(h!())?;
    let master_keys =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login)
            .await
            .c(h!())?;
    let group_names = signal_group::Entity::find()
        .filter(signal_group::Column::MasterKey.eq_any(master_keys.clone()))
        .all(&env.dbx)
        .await
        .c(h!())?
        .into_iter()
        .filter_map(|x| x.name.map(|name| (x.master_key, name)))
        .collect::<HashMap<_, _>>();
    let batches = crate::stats::collect_signal_group_batches(
        master_keys.clone(),
        &env.dbx,
    )
    .await
    .c(h!())?;
    let batch_ids = batches.iter().map(|b| b.id).collect::<Vec<i64>>();
    let stats = crate::stats::get_last_hour_stats(&env.dbx, batch_ids)
        .await
        .c(h!())?;
    let mut result = vec![];
    for (ts, group_stats) in stats {
        let mut stats = BTreeMap::new();
        for key in master_keys.clone() {
            let mut count = 0;
            for batch_id in
                crate::stats::collect_signal_group_batch_ids_by_master_key(
                    &key, &batches,
                )
            {
                count += group_stats.get(&batch_id).unwrap_or(&0).to_owned();
            }
            let group_name = group_names.get(&key).cloned();
            stats.insert(key, InboxGroupStats { group_name, count });
        }
        let timestamp = print_ts(ts);
        result.push(InboxGroupStatsByMinute { timestamp, stats });
        for i in 1..5 {
            // legacy, FIXME remove it and update frontend code correspondingly
            result.push(InboxGroupStatsByMinute {
                timestamp: print_ts(ts + Duration::minutes(i)),
                stats: BTreeMap::new(),
            });
        }
    }
    Ok(Json(InboxByGroupDigestRsp {
        stats_per_minute: result,
    }))
}

fn print_ts(ts: NaiveDateTime) -> String {
    ts.and_utc()
        .with_timezone(&get_tz())
        .clone()
        .format("%H:%M")
        .to_string()
}

#[post("/api/rer-importer/get-inbox-count")]
async fn inbox_messages_count(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<InboxMessagesReq>,
) -> Result<Json<InboxMessagesDigestRsp>, AppError> {
    let user_id = user.id().c(h!())?;
    let page_id = req.page_id.clone();
    let mut req = req.into_inner();

    let payload = serde_json::to_value(&req).context(h!())?;
    record_page_visit(&user_id, &page_id, &env, Some(payload))
        .await
        .context(h!())?;
    crate::users::has_any_role(&env.dbx, &user_id, vec!["Rer", "ApiAgent"])
        .await
        .c(h!())?;
    let login = user_id;

    let test_limit = apply_test_inbox_settings(&env, &mut req).await?;
    if test_limit.is_none()
        && req.since_id_noninclusive.is_none()
        && req.since_date_inclusive_ms.is_none()
    {
        req.since_date_inclusive_ms = Some(0);
    }
    let q = build_inbox_digest_query(&login, &env, &req)
        .await
        .context(h!())?;

    let query_res: Option<QueryResult> = env
        .dbx
        .query_one(Statement::from_string(DatabaseBackend::Postgres, q))
        .await
        .c(h!())?;
    let query_res = query_res.unwrap();
    let mut quantity: i64 = query_res.try_get("", "count")?;
    if let Some(limit) = test_limit {
        quantity = quantity.min(limit);
    }
    let first_element_ts: Option<NaiveDateTime> =
        query_res.try_get("", "first_element_ts")?;
    let first_element_ts =
        first_element_ts.map(|x| x.and_utc().timestamp_millis());
    Ok(Json(InboxMessagesDigestRsp {
        quantity,
        first_element_ts,
    }))
}

#[post("/api/rer-importer/delete-message")]
async fn delete_message(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<InboxDeleteReq>,
) -> Result<Json<()>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
    let txn = env.dbx.begin().await.context(h!())?;
    let result = match signal_message::Entity::find_by_id(req.id)
        .filter(signal_message::Column::Deleted.eq(false))
        .one(&txn)
        .await
        .context(h!())?
    {
        None => Err(AppError::NotFound),
        Some(signal_message) => {
            let mut signal_message = signal_message.into_active_model();
            signal_message.deleted = Set(true);
            signal_message.update(&txn).await.context(h!())?;
            Ok(Json(()))
        }
    };
    txn.commit().await.c(h!())?;
    result
}

#[post("/api/rer-importer/inbox/submit")]
async fn inbox_submit(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<InboxSubmitReq>,
) -> Result<Json<()>, AppError> {
    match do_submit_inbox(user, &env, req).await {
        Ok(_) => Ok(Json(())),
        Err(e) => {
            error!("failed to submit inbox: {:?}", e);
            Err(e)
        }
    }
}

#[post("/api/rer-importer/inbox/chumak-submit")]
async fn chumak_inbox_submit(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ChumakSubmitMessageReq>,
) -> Result<Json<()>, AppError> {
    match do_submit_chumak_inbox(user, &env, req).await {
        Ok(_) => Ok(Json(())),
        Err(e) => {
            error!("failed to submit inbox: {:?}", e);
            Err(e)
        }
    }
}

async fn do_submit_chumak_inbox(
    user: Identity,
    env: &Data<Env>,
    req: Json<ChumakSubmitMessageReq>,
) -> Result<(), AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_any_role(
        &env.dbx,
        &login,
        vec!["Rer", "Api", "ApiAgent"],
    )
    .await
    .c(h!())?;
    let req = req.into_inner();
    validate_chumak_submit_req(&req)?;

    let logins = crate::users::get_organism_logins(&env.dbx, user)
        .await
        .context(h!())?;
    let timestamp = parse_chumak_timestamp(&req.timestamp)?;
    let txn = env.dbx.begin().await.c(h!())?;

    let datasource = ensure_chumak_datasource(&txn, &login).await.c(h!())?;
    let groups =
        ensure_chumak_groups(&txn, &datasource, &login, &req.group_names)
            .await
            .c(h!())?;
    let post = normalized_optional_string(req.post.as_deref());
    let post_id = crate::sigint::post::get_or_create_post_id(&txn, &post)
        .await
        .c(h!())?;
    let signal_message = insert_chumak_signal_message(
        &txn,
        &env.config,
        &req,
        timestamp,
        &groups,
    )
    .await
    .c(h!())?;
    let message =
        map_chumak_inbox_message(&req, timestamp, &groups, post, post_id)?;
    let inbox_id = submit_upsert_inbox_item(
        env.settlements.clone(),
        &txn,
        signal_message.id,
        &message,
        &login,
        &logins,
    )
    .await
    .c(h!())?;
    save_chumak_metadata(inbox_id, &req, &txn).await.c(h!())?;

    txn.commit().await.c(h!())?;
    fanout_inbox_changed(env, vec![inbox_id]).await;
    Ok(())
}

fn validate_chumak_submit_req(
    req: &ChumakSubmitMessageReq,
) -> Result<(), AppError> {
    if req.group_names.iter().all(|group| group.trim().is_empty()) {
        return Err(AppError::BL {
            msg: "Chumak submit requires at least one group name".to_string(),
        });
    }
    let Some(network) = req.network.as_ref() else {
        return Ok(());
    };
    if !network.signal_name.eq_ignore_ascii_case("dmr") {
        return Err(AppError::BL {
            msg: format!(
                "Unsupported Chumak network signal name: {}",
                network.signal_name
            ),
        });
    }
    if req.dmr.iter().any(|metadata| metadata.cc != network.cc) {
        return Err(AppError::BL {
            msg: "Chumak network color code does not match DMR metadata"
                .to_string(),
        });
    }
    Ok(())
}

fn parse_chumak_timestamp(timestamp: &str) -> Result<NaiveDateTime, AppError> {
    if let Ok(dt) = DateTime::parse_from_rfc3339(timestamp) {
        return Ok(dt.naive_utc());
    }

    let local_datetime =
        NaiveDateTime::parse_from_str(timestamp, "%Y-%m-%dT%H:%M:%S")
            .or_else(|_| {
                NaiveDateTime::parse_from_str(timestamp, "%Y-%m-%d %H:%M:%S")
            })
            .or_else(|_| {
                NaiveDateTime::parse_from_str(timestamp, "%Y-%m-%dT%H:%M:%S%.f")
            })
            .or_else(|_| {
                NaiveDateTime::parse_from_str(timestamp, "%Y-%m-%d %H:%M:%S%.f")
            })
            .map_err(|e| AppError::BL {
                msg: format!("Invalid Chumak timestamp {timestamp}: {e}"),
            })?;
    let zoned = local_datetime
        .and_local_timezone(crate::config::get_tz())
        .single()
        .ok_or_else(|| AppError::BL {
            msg: format!("Ambiguous Chumak timestamp: {timestamp}"),
        })?;
    Ok(zoned.to_utc().naive_utc())
}

async fn ensure_chumak_datasource(
    txn: &DatabaseTransaction,
    login: &str,
) -> Result<datasource::Model, AppError> {
    let now = Utc::now().naive_utc();
    let default_aor_id =
        crate::sigint::aor::load_default_aor(txn).await.c(h!())?.id;
    let datasource = datasource::Entity::find()
        .filter(datasource::Column::ApiLogin.eq(login))
        .one(txn)
        .await
        .c(h!())?;
    if let Some(datasource) = datasource {
        let is_deleted = datasource.deleted;
        let has_default_aor = datasource.default_aor_id.is_some();
        let mut datasource = datasource.into_active_model();
        datasource.kind = Set("echo_operator".to_string());
        if is_deleted {
            datasource.deleted = Set(false);
            datasource.enabled = Set(Some(false));
            datasource.updated_by = Set(Some(login.to_string()));
        }
        if !has_default_aor {
            datasource.default_aor_id = Set(Some(default_aor_id));
        }
        datasource.last_sync_at = Set(Some(now));
        return Ok(datasource.update(txn).await.c(h!())?);
    }

    Ok(datasource::ActiveModel {
        kind: Set("echo_operator".to_string()),
        display_name: Set(format!("EХО Оператор {login}")),
        enabled: Set(Some(true)),
        api_login: Set(Some(login.to_string())),
        updated_by: Set(Some(login.to_string())),
        last_sync_at: Set(Some(now)),
        deleted: Set(false),
        default_aor_id: Set(Some(default_aor_id)),
        ..Default::default()
    }
    .insert(txn)
    .await
    .c(h!())?)
}

async fn ensure_chumak_groups(
    txn: &DatabaseTransaction,
    datasource: &datasource::Model,
    login: &str,
    group_names: &[String],
) -> Result<Vec<(String, i64)>, AppError> {
    let mut groups = vec![];
    for group_name in group_names {
        let group_name = group_name.trim();
        if group_name.is_empty() {
            continue;
        }
        let group_master_key = chumak_group_master_key(login, group_name);
        let (group_master_key, datasource_group_id) =
            ensure_chumak_datasource_group(
                txn,
                datasource.id,
                &group_master_key,
                group_name,
            )
            .await
            .c(h!())?;
        ensure_chumak_group_aor(
            txn,
            datasource.default_aor_id,
            &group_master_key,
        )
        .await
        .c(h!())?;
        groups.push((group_master_key, datasource_group_id));
    }
    Ok(groups)
}

fn chumak_group_master_key(login: &str, group_name: &str) -> String {
    let digest = sha256::digest(format!("{login}:{group_name}"));
    format!("echo.{}", &digest[..32])
}

async fn ensure_chumak_datasource_group(
    txn: &DatabaseTransaction,
    datasource_id: i64,
    group_master_key: &str,
    group_name: &str,
) -> Result<(String, i64), AppError> {
    let existing = datasource_group::Entity::find()
        .filter(datasource_group::Column::DatasourceId.eq(datasource_id))
        .filter(
            Condition::any()
                .add(
                    datasource_group::Column::GroupMasterKey
                        .eq(group_master_key),
                )
                .add(datasource_group::Column::Name.eq(group_name)),
        )
        .order_by_asc(datasource_group::Column::Id)
        .one(txn)
        .await
        .c(h!())?;
    if let Some(existing) = existing {
        let id = existing.id;
        let existing_group_master_key = existing.group_master_key.clone();
        crate::messenger::group::ensure_signal_group(
            txn,
            existing_group_master_key.clone(),
            Some(group_name.to_string()),
            datasource_id,
        )
        .await
        .c(h!())?;
        if existing.deleted || existing.name != group_name {
            let mut existing = existing.into_active_model();
            existing.deleted = Set(false);
            existing.name = Set(group_name.to_string());
            existing.last_sync_at = Set(Utc::now().naive_utc());
            existing.update(txn).await.c(h!())?;
        }
        return Ok((existing_group_master_key, id));
    }

    crate::messenger::group::ensure_signal_group(
        txn,
        group_master_key.to_string(),
        Some(group_name.to_string()),
        datasource_id,
    )
    .await
    .c(h!())?;
    let datasource_group = datasource_group::ActiveModel {
        group_master_key: Set(group_master_key.to_string()),
        datasource_id: Set(datasource_id),
        name: Set(group_name.to_string()),
        deleted: Set(false),
        last_sync_at: Set(Utc::now().naive_utc()),
        ..Default::default()
    }
    .insert(txn)
    .await
    .c(h!())?;
    Ok((datasource_group.group_master_key, datasource_group.id))
}

async fn ensure_chumak_group_aor(
    txn: &DatabaseTransaction,
    aor_id: Option<i64>,
    group_master_key: &str,
) -> Result<(), AppError> {
    let Some(aor_id) = aor_id else {
        return Ok(());
    };
    let existing_aors = signal_group_aor::Entity::find()
        .filter(signal_group_aor::Column::MasterKey.eq(group_master_key))
        .count(txn)
        .await
        .c(h!())?;
    if existing_aors > 0 {
        return Ok(());
    }
    signal_group_aor::ActiveModel {
        id: NotSet,
        master_key: Set(group_master_key.to_string()),
        aor_id: Set(aor_id),
        created_at: NotSet,
    }
    .insert(txn)
    .await
    .c(h!())?;
    Ok(())
}

async fn insert_chumak_signal_message(
    txn: &DatabaseTransaction,
    config: &Config,
    req: &ChumakSubmitMessageReq,
    timestamp: NaiveDateTime,
    groups: &[(String, i64)],
) -> Result<signal_message::Model, AppError> {
    let (_group_master_key, datasource_group_id) =
        groups.first().cloned().c(h!())?;
    let signal_message = signal_message::ActiveModel {
        id: NotSet,
        body: Set(Some(req.message.clone())),
        datasource_group_id: Set(Some(datasource_group_id)),
        created_at: NotSet,
        timestamp: Set(Some(timestamp)),
        sender: Set(req.sender.clone()),
        format: NotSet,
        deleted: Set(false),
        external_id: NotSet,
        message_uid: NotSet,
    }
    .insert(txn)
    .await
    .c(h!())?;

    for (group_master_key, datasource_group_id) in groups {
        signal_message_group::ActiveModel {
            id: NotSet,
            signal_message_id: Set(signal_message.id),
            group_master_key: Set(Some(group_master_key.clone())),
            sender: Set(req.sender.clone()),
            message_uid: Set(signal_message.message_uid.clone()),
            datasource_group_id: Set(Some(*datasource_group_id)),
            created_at: Set(signal_message.created_at),
        }
        .insert(txn)
        .await
        .c(h!())?;
    }

    Ok(crate::messenger::id::update_message_with_uid(
        txn,
        config,
        signal_message,
    )
    .await
    .c(h!())?)
}

fn map_chumak_inbox_message(
    req: &ChumakSubmitMessageReq,
    timestamp: NaiveDateTime,
    groups: &[(String, i64)],
    post: Option<String>,
    post_id: Option<i64>,
) -> Result<InboxMessage, AppError> {
    let no_headers_source = if req.no_headers_body.trim().is_empty() {
        req.message.as_str()
    } else {
        req.no_headers_body.as_str()
    };
    let no_headers_body =
        crate::rer_importer::body_noheader::extract_text(no_headers_source)?;
    let extended_form = chumak_extended_form(req);
    let callsigns = chumak_callsigns(req);

    Ok(InboxMessage {
        message_uid: None,
        text: req.message.clone(),
        media: vec![],
        images: vec![],
        image_recognized: vec![],
        date: Some(timestamp.format("%d.%m.%Y").to_string()),
        time: Some(timestamp.format("%H:%M:%S").to_string()),
        freq: req
            .freq
            .as_ref()
            .map(|freq| crate::rer_importer::frequency::etalon(freq)),
        coords: req.coordinates.clone(),
        callsigns,
        callsigns_alg2: vec![],
        checked: true,
        important: false,
        bookmarked: false,
        timestamp: Some(timestamp.and_utc().timestamp_millis()),
        group_master_key: groups.first().map(|(key, _)| key.clone()),
        sender: req.sender.clone(),
        extended_form,
        post,
        post_id,
        unit: req.unit.clone(),
        callsign_tokens: None,
        signal_tokens: None,
        point_tokens: None,
        no_headers_body: Some(no_headers_body),
        keyword_tokens: None,
        text_marked: None,
        datasource_id: None,
        location: chumak_location(req),
        tags: None,
        network_ids: None,
        inbox_tags: None,
        metadata: vec![],
    })
}

fn normalized_optional_string(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn chumak_callsigns(req: &ChumakSubmitMessageReq) -> Vec<String> {
    req.callsign_from
        .clone()
        .into_iter()
        .chain(req.callsign_to.clone())
        .chain(req.callsigns_other.clone())
        .map(|callsign| callsign.trim().to_lowercase())
        .filter(|callsign| !callsign.is_empty())
        .unique()
        .collect()
}

fn chumak_location(req: &ChumakSubmitMessageReq) -> Option<String> {
    let locations = req
        .locations
        .iter()
        .map(|location| location.trim())
        .filter(|location| !location.is_empty())
        .unique()
        .collect::<Vec<_>>();
    if locations.is_empty() {
        None
    } else {
        Some(locations.join(", "))
    }
}

fn chumak_extended_form(req: &ChumakSubmitMessageReq) -> Option<String> {
    let mut lines = vec![];
    if !req.tags.is_empty() {
        lines.push(format!("Теги: {}", req.tags.join(", ")));
    }
    if let Some(signals) = req.signals.as_ref().filter(|s| !s.trim().is_empty())
    {
        lines.push(format!("Сигнали: {}", signals.trim()));
    }
    if let Some(network_name) =
        req.network_name.as_ref().filter(|s| !s.trim().is_empty())
    {
        lines.push(format!("Мережа: {}", network_name.trim()));
    }
    if lines.is_empty() {
        None
    } else {
        Some(lines.join("\n"))
    }
}

async fn save_chumak_metadata(
    inbox_id: i64,
    req: &ChumakSubmitMessageReq,
    txn: &DatabaseTransaction,
) -> Result<(), AppError> {
    let mut entries = req
        .dmr
        .iter()
        .map(|metadata| chumak_metadata_model(inbox_id, metadata))
        .collect::<Vec<_>>();

    if let Some(network) = req.network.as_ref() {
        let cc = network.cc.to_string();
        let already_saved =
            req.dmr.iter().any(|metadata| metadata.cc.to_string() == cc);
        if !already_saved {
            entries.push(sigint_inbox_item_metadata::ActiveModel {
                id: NotSet,
                sigint_inbox_item_id: Set(inbox_id),
                color_code: Set(Some(cc)),
                created_at: NotSet,
                ..Default::default()
            });
        }
    }

    let mut existing_metadata_keys =
        load_chumak_metadata_keys(inbox_id, txn).await.c(h!())?;
    entries.retain(|entry| {
        existing_metadata_keys.insert(chumak_metadata_key_from_active(entry))
    });
    if entries.is_empty() {
        return Ok(());
    }
    sigint_inbox_item_metadata::Entity::insert_many(entries)
        .exec(txn)
        .await
        .c(h!())?;
    Ok(())
}

type ChumakMetadataKey = (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

async fn load_chumak_metadata_keys(
    inbox_id: i64,
    txn: &DatabaseTransaction,
) -> Result<BTreeSet<ChumakMetadataKey>, AppError> {
    Ok(sigint_inbox_item_metadata::Entity::find()
        .filter(
            sigint_inbox_item_metadata::Column::SigintInboxItemId.eq(inbox_id),
        )
        .all(txn)
        .await
        .c(h!())?
        .into_iter()
        .map(chumak_metadata_key_from_model)
        .collect())
}

fn chumak_metadata_key_from_model(
    metadata: sigint_inbox_item_metadata::Model,
) -> ChumakMetadataKey {
    (
        metadata.color_code,
        metadata.call_group_id,
        metadata.call_group_name,
        metadata.sender_id,
        metadata.sender_name,
        metadata.hash_id,
    )
}

fn chumak_metadata_key_from_active(
    metadata: &sigint_inbox_item_metadata::ActiveModel,
) -> ChumakMetadataKey {
    (
        active_optional_string(&metadata.color_code),
        active_optional_string(&metadata.call_group_id),
        active_optional_string(&metadata.call_group_name),
        active_optional_string(&metadata.sender_id),
        active_optional_string(&metadata.sender_name),
        active_optional_string(&metadata.hash_id),
    )
}

fn active_optional_string(
    value: &ActiveValue<Option<String>>,
) -> Option<String> {
    match value {
        Set(value) | Unchanged(value) => value.clone(),
        NotSet => None,
    }
}

fn chumak_metadata_model(
    inbox_id: i64,
    metadata: &ChumakMetadata,
) -> sigint_inbox_item_metadata::ActiveModel {
    sigint_inbox_item_metadata::ActiveModel {
        id: NotSet,
        sigint_inbox_item_id: Set(inbox_id),
        color_code: Set(Some(metadata.cc.to_string())),
        call_group_id: Set(metadata.abonent_id.map(|id| id.to_string())),
        sender_id: Set(Some(metadata.sender_id.to_string())),
        created_at: NotSet,
        ..Default::default()
    }
}

async fn ensure_comment_save_access(
    env: &Env,
    login: &str,
    sigint_groups: &[String],
    message_id: i64,
) -> Result<(), AppError> {
    let message = SignalMessage::find_by_id(message_id)
        .join(
            JoinType::LeftJoin,
            signal_message::Relation::SignalMessageGroup.def(),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(
            signal_message_group::Column::GroupMasterKey
                .eq_any(sigint_groups.to_vec()),
        )
        .one(&env.dbx)
        .await
        .c(h!())?;

    if message.is_some() {
        return Ok(());
    }

    let message_row = SignalMessage::find_by_id(message_id)
        .one(&env.dbx)
        .await
        .c(h!())?;
    let message_groups: Vec<Option<String>> =
        signal_message_group::Entity::find()
            .filter(
                signal_message_group::Column::SignalMessageId.eq(message_id),
            )
            .all(&env.dbx)
            .await
            .c(h!())?
            .into_iter()
            .map(|row| row.group_master_key)
            .collect();
    let (message_exists, message_deleted, datasource_group_id) =
        match message_row {
            Some(row) => (true, Some(row.deleted), row.datasource_group_id),
            None => (false, None, None),
        };

    warn!(
        target: "not_found_details",
        "comment-save not found login={login} message_id={message_id} message_exists={message_exists} message_deleted={:?} datasource_group_id={:?} message_groups={:?} user_groups={:?}",
        message_deleted,
        datasource_group_id,
        message_groups,
        sigint_groups,
    );

    Err(AppError::NotFound)
}

#[post("/api/rer-importer/comment-save")]
async fn comment_save(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<InboxCommentSaveReq>,
) -> Result<Json<()>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .c(h!())?;
    let sigint_groups =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login)
            .await
            .c(h!())?;

    ensure_comment_save_access(&env, &login, &sigint_groups, req.message_id)
        .await?;

    let txn = env.dbx.begin().await.c(h!())?;
    let message_ids =
        find_all_duplicates(&txn, req.message_id).await.c(h!())?;
    let comment = req.comment.as_ref().map(|c| c.trim()).unwrap_or("");
    for id in &message_ids {
        if comment.is_empty() {
            sigint_comment::Entity::delete_many()
                .filter(sigint_comment::Column::SignalMessageId.eq(*id))
                .filter(sigint_comment::Column::Login.eq(login.clone()))
                .exec(&txn)
                .await
                .c(h!())?;
        } else {
            let m_comment = sigint_comment::Entity::find()
                .filter(sigint_comment::Column::SignalMessageId.eq(*id))
                .filter(sigint_comment::Column::Login.eq(login.clone()))
                .one(&txn)
                .await
                .c(h!())?;
            match m_comment {
                None => {
                    sigint_comment::ActiveModel {
                        id: NotSet,
                        signal_message_id: Set(*id),
                        login: Set(login.clone()),
                        comment: Set(comment.to_string()),
                        created_at: NotSet,
                    }
                    .insert(&txn)
                    .await
                    .c(h!())?;
                }
                Some(comment_model) => {
                    sigint_comment::ActiveModel {
                        id: Set(comment_model.id),
                        signal_message_id: Set(*id),
                        login: Set(login.clone()),
                        comment: Set(comment.to_string()),
                        created_at: NotSet,
                    }
                    .update(&txn)
                    .await
                    .c(h!())?;
                }
            }
        }
    }
    txn.commit().await.c(h!())?;
    let events: Vec<EventMsg> = message_ids
        .into_iter()
        .collect::<BTreeSet<i64>>()
        .into_iter()
        .map(EventType::ETInboxChanged)
        .map(EventMsg::new)
        .collect();
    if let Err(e) = fanout_mult(&mut env.redis.clone(), events).await {
        warn!("failed to send to redis: {:#?}", e);
    }
    Ok(Json(()))
}

async fn do_submit_inbox(
    user: Identity,
    env: &Data<Env>,
    req: Json<InboxSubmitReq>,
) -> Result<(), AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .c(h!())?;
    let logins = crate::users::get_organism_logins(&env.dbx, user)
        .await
        .context(h!())?;
    let txn = env.dbx.begin().await.c(h!())?;
    let mut changed_inbox_ids = vec![];

    for (id, message) in req.messages.iter() {
        let mut message = message.clone();
        let callsigns: Vec<String> = crate::utils::uniq_via_btreeset(
            &message
                .callsigns
                .iter()
                .map(|x| x.to_lowercase())
                .collect::<Vec<String>>(),
        );
        fill_callsigns(&env.rq, &txn, &callsigns).await.c(h!())?;
        message.callsigns = callsigns.clone();
        message.callsign_tokens = Some(
            crate::rer_importer::callsigns::highlight_callsigns(
                &env.rq,
                &message.text,
                &callsigns,
            )
            .await
            .c(h!())?,
        );
        message.keyword_tokens = None;

        let all_ids = find_all_duplicates(&txn, *id).await.c(h!())?;
        for id in &all_ids {
            let inbox_id = submit_upsert_inbox_item(
                env.settlements.clone(),
                &txn,
                *id,
                &message,
                &login,
                &logins,
            )
            .await
            .c(h!())?;
            changed_inbox_ids.push(inbox_id);
        }
        do_palitra_highlight(
            all_ids,
            &env.rq,
            &txn,
            &env.palitra_worker_context,
        )
        .await
        .c(h!())?;
    }
    txn.commit().await.c(h!())?;
    fanout_inbox_changed(env, changed_inbox_ids).await;
    Ok(())
}

async fn fanout_inbox_changed(env: &Data<Env>, inbox_ids: Vec<i64>) {
    let events: Vec<EventMsg> = inbox_ids
        .into_iter()
        .collect::<BTreeSet<i64>>()
        .into_iter()
        .map(EventType::ETInboxChanged)
        .map(EventMsg::new)
        .collect();
    if events.is_empty() {
        return;
    }
    if let Err(e) = fanout_mult(&mut env.redis.clone(), events).await {
        warn!("failed to send to redis: {:#?}", e);
    }
}

/// DEPRECATED Get the cursor position. Cursor is used as "since_id_noninclusive" default when loading inbox. So, equal to zero on empty inbox, or last seen/submitted message otherwise.
#[get("/api/rer-importer/inbox/cursor")]
async fn inbox_cursor(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<Option<i64>>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
    // no op
    let since_id_noninclusive = None;
    Ok(Json(since_id_noninclusive))
}

/// DEPRECATED. Get the cursor position. Cursor is used as "since_id_noninclusive" default when loading inbox. So, equal to zero on empty inbox, or last seen/submitted message otherwise.
#[post("/api/rer-importer/inbox/cursor-update")]
async fn update_inbox_cursor(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    _req: Json<UpdateCursorReq>,
) -> Result<Json<()>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;

    // no op
    Ok(Json(()))
}

pub async fn get_inbox_messages(
    login: &str,
    logins: &Vec<String>,
    env: &Env,
    req: &InboxMessagesReq,
) -> Result<Vec<(i64, InboxMessage)>, AppError> {
    get_inbox_messages_with_conn(&env.dbx, login, logins, env, req).await
}

pub async fn get_inbox_messages_created_between(
    login: &str,
    logins: &Vec<String>,
    env: &Env,
    req: &InboxMessagesReq,
    created_after: NaiveDateTime,
    created_till: NaiveDateTime,
) -> Result<Vec<(i64, InboxMessage)>, AppError> {
    let mut req = req.clone();
    req.since_id_noninclusive = Some(0);
    let q = build_inbox_query(login, env, &req).await.c(h!())?;
    let statement = Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        format!(
            "SELECT * FROM ({q}) q \
             WHERE created_at > $1 AND created_at <= $2 \
             ORDER BY created_at ASC, id ASC"
        ),
        [created_after.into(), created_till.into()],
    );
    fetch_inbox_messages_with_statement(
        &env.dbx, login, logins, env, &req, statement,
    )
    .await
}

pub async fn get_inbox_messages_with_conn(
    dbx: &DatabaseConnection,
    login: &str,
    logins: &Vec<String>,
    env: &Env,
    req: &InboxMessagesReq,
) -> Result<Vec<(i64, InboxMessage)>, AppError> {
    let q = build_inbox_query(login, env, req).await.c(h!())?;
    let res = fetch_inbox_messages_with_query(dbx, login, logins, env, req, &q)
        .await
        .context(h!())?;
    Ok(res)
}

async fn get_inbox_messages_limited(
    login: &str,
    logins: &Vec<String>,
    env: &Env,
    req: &InboxMessagesReq,
    limit: i64,
) -> Result<Vec<(i64, InboxMessage)>, AppError> {
    let q = build_inbox_query(login, env, req).await.c(h!())?;
    let q = format!("{q} LIMIT {limit}");
    let res =
        fetch_inbox_messages_with_query(&env.dbx, login, logins, env, req, &q)
            .await
            .context(h!())?;
    Ok(res)
}

async fn fetch_inbox_messages_with_query(
    dbx: &DatabaseConnection,
    login: &str,
    logins: &Vec<String>,
    env: &Env,
    req: &InboxMessagesReq,
    q: &str,
) -> Result<Vec<(i64, InboxMessage)>, AppError> {
    fetch_inbox_messages_with_statement(
        dbx,
        login,
        logins,
        env,
        req,
        Statement::from_string(DatabaseBackend::Postgres, q),
    )
    .await
}

async fn fetch_inbox_messages_with_statement(
    dbx: &DatabaseConnection,
    login: &str,
    logins: &Vec<String>,
    env: &Env,
    req: &InboxMessagesReq,
    statement: Statement,
) -> Result<Vec<(i64, InboxMessage)>, AppError> {
    let results = dbx.query_all(statement).await.context(h!())?;

    let messages: Vec<InboxMessageDesc> = results
        .iter()
        .map(|qr| InboxMessageDesc::from_query_result(qr, ""))
        .collect::<Result<Vec<_>, DbErr>>()
        .context(h!())?;

    let res = aggregate_to_inbox_messages(login, messages, logins, &req, &env)
        .await
        .context(h!())?;
    Ok(res)
}

/// Find our dups and dups of our duplicate_of origin. Don't do anything fancy beyond this.
pub async fn find_all_duplicates<'a, 'async_trait, C>(
    txn: &'a C,
    id: i64,
) -> Result<Vec<i64>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let exists = SignalMessage::find_by_id(id)
        .filter(signal_message::Column::Deleted.eq(false))
        .one(txn)
        .await
        .c(h!())?
        .is_some();
    if exists {
        Ok(vec![id])
    } else {
        Ok(vec![])
    }
}

#[post("/api/rer-importer/get-freq-pelengs-summary")]
async fn get_freq_pelengs_summary(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<InboxMessagesReq>,
) -> Result<Json<FreqPelengsActivityRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
    let login = user.id().c(h!())?;

    let q = build_inbox_query(&login, &env, &req.into_inner())
        .await
        .context(h!())?;

    let q = format!(
        r#"SELECT "freq" as freq, COUNT(*) AS count
            FROM ({q}) q
            INNER JOIN sigint_peleng sp ON sp.source_inbox_item_id = q."id"
            WHERE sp.deleted = false
            AND "freq" IS NOT NULL
            GROUP BY "freq"
            "#
    );

    let query_res = env
        .dbx
        .query_all(Statement::from_string(DatabaseBackend::Postgres, q))
        .await
        .context(h!())?;

    let mut result = vec![];
    for row in query_res {
        let freq = row.try_get("", "freq")?;
        let pelengs_count = row.try_get("", "count")?;
        result.push(FreqPelengsEntry {
            freq,
            pelengs_count,
        });
    }

    Ok(Json(FreqPelengsActivityRsp {
        freq_pelengs_summary: result,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::{
        datasource_group, login, organism, sigint_inbox_item,
        sigint_inbox_item_point_token, sigint_inbox_item_tag,
        sigint_zone_datasource, signal_group, signal_message,
        signal_message_group, signal_message_media, tag,
    };
    use crate::functest::tests::*;
    use chrono::Utc;
    use sea_orm::ActiveValue::Set;
    use serde_json::json;
    use serial_test::serial;
    use std::sync::Arc;
    use uuid::Uuid;

    async fn seed_message_with_tags(
        env: &Arc<Env>,
        datasource_group: &datasource_group::Model,
        tag: &tag::Model,
        tag_logins: &[login::Model],
    ) -> Result<signal_message::Model, AppError> {
        let now = Utc::now().naive_utc();
        let uid = format!("uid-{}", now.and_utc().timestamp_millis());

        let message = mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                body: Set(Some("test message".to_string())),
                created_at: Set(now),
                timestamp: Set(Some(now)),
                sender: Set(Some("sender".to_string())),
                message_uid: Set(Some(uid.clone())),
                datasource_group_id: Set(Some(datasource_group.id)),
                ..Default::default()
            },
        )
        .await
        .context(h!())?;

        signal_message_group::ActiveModel {
            signal_message_id: Set(message.id),
            group_master_key: Set(Some(
                datasource_group.group_master_key.clone(),
            )),
            sender: Set(Some("sender".to_string())),
            message_uid: Set(Some(uid)),
            datasource_group_id: Set(Some(datasource_group.id)),
            created_at: Set(now),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .context(h!())?;

        mk_sigint_inbox_item(
            &env.dbx,
            sigint_inbox_item::ActiveModel {
                id: Set(message.id),
                freq: Set(Some("123.45".to_string())),
                callsigns: Set(Some(json!(["Alpha"]))),
                tags: Set(Some(json!([tag.id]))),
                date: Set(Some(now.date().to_string())),
                time: Set(Some(now.time().format("%H:%M:%S").to_string())),
                reviewed: Set(Some(true)),
                parsed_unit_v2: Set(false),
                ..Default::default()
            },
        )
        .await
        .context(h!())?;

        for login_model in tag_logins {
            sigint_inbox_item_tag::ActiveModel {
                sigint_inbox_item_id: Set(message.id),
                tag_id: Set(tag.id),
                confidence: Set(1.0),
                login: Set(Some(login_model.login.clone())),
                model: Set(None),
                ..Default::default()
            }
            .insert(&env.dbx)
            .await
            .context(h!())?;
        }

        Ok(message)
    }

    async fn seed_message_with_media(
        env: &Arc<Env>,
        datasource_group: &datasource_group::Model,
        content_type: Option<&str>,
        label: &str,
    ) -> Result<signal_message::Model, AppError> {
        let now = Utc::now().naive_utc();
        let uid = format!("uid-{label}-{}", now.and_utc().timestamp_millis());

        let message = mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                body: Set(Some(format!("test message {label}"))),
                created_at: Set(now),
                timestamp: Set(Some(now)),
                sender: Set(Some("sender".to_string())),
                message_uid: Set(Some(uid.clone())),
                datasource_group_id: Set(Some(datasource_group.id)),
                ..Default::default()
            },
        )
        .await
        .context(h!())?;

        signal_message_group::ActiveModel {
            signal_message_id: Set(message.id),
            group_master_key: Set(Some(
                datasource_group.group_master_key.clone(),
            )),
            sender: Set(Some("sender".to_string())),
            message_uid: Set(Some(uid)),
            datasource_group_id: Set(Some(datasource_group.id)),
            created_at: Set(now),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .context(h!())?;

        mk_sigint_inbox_item(
            &env.dbx,
            sigint_inbox_item::ActiveModel {
                id: Set(message.id),
                freq: Set(Some("123.45".to_string())),
                date: Set(Some(now.date().to_string())),
                time: Set(Some(now.time().format("%H:%M:%S").to_string())),
                reviewed: Set(Some(true)),
                parsed_unit_v2: Set(false),
                ..Default::default()
            },
        )
        .await
        .context(h!())?;

        if let Some(content_type) = content_type {
            signal_message_media::ActiveModel {
                id: Set(Uuid::new_v4()),
                signal_message_id: Set(message.id),
                content_type: Set(content_type.to_string()),
                file_ext: Set(None),
                file_name: Set(None),
                size_bytes: Set(1),
                created_at: Set(now),
            }
            .insert(&env.dbx)
            .await
            .context(h!())?;
        }

        Ok(message)
    }

    #[serial]
    #[tokio::test]
    async fn test_get_inbox_messages_filters_only_with_media() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let datasource_group =
            find_test_datasource_group(&env.dbx).await.unwrap();

        let image_message = seed_message_with_media(
            &env,
            &datasource_group,
            Some("image/png"),
            "image",
        )
        .await
        .unwrap();
        let audio_message = seed_message_with_media(
            &env,
            &datasource_group,
            Some("audio/ogg"),
            "audio",
        )
        .await
        .unwrap();
        let video_message = seed_message_with_media(
            &env,
            &datasource_group,
            Some("video/mp4"),
            "video",
        )
        .await
        .unwrap();
        let no_media_message =
            seed_message_with_media(&env, &datasource_group, None, "plain")
                .await
                .unwrap();
        let pdf_message = seed_message_with_media(
            &env,
            &datasource_group,
            Some("application/pdf"),
            "pdf",
        )
        .await
        .unwrap();

        let logins = vec![login.login.clone()];
        let base_req = InboxMessagesReq {
            nolimit: Some(true),
            ..Default::default()
        };

        let all_messages =
            get_inbox_messages(&login.login, &logins, &env, &base_req)
                .await
                .unwrap();
        assert_eq!(all_messages.len(), 5);

        let false_req = InboxMessagesReq {
            only_with_media: Some(false),
            ..base_req.clone()
        };
        let false_messages =
            get_inbox_messages(&login.login, &logins, &env, &false_req)
                .await
                .unwrap();
        assert_eq!(false_messages.len(), 5);

        let media_req = InboxMessagesReq {
            only_with_media: Some(true),
            ..base_req
        };
        let media_messages =
            get_inbox_messages(&login.login, &logins, &env, &media_req)
                .await
                .unwrap();
        let media_ids =
            media_messages.iter().map(|(id, _)| *id).collect::<Vec<_>>();

        assert_eq!(media_messages.len(), 4);
        assert!(media_ids.contains(&image_message.id));
        assert!(media_ids.contains(&audio_message.id));
        assert!(media_ids.contains(&video_message.id));
        assert!(media_ids.contains(&pdf_message.id));
        assert!(!media_ids.contains(&no_media_message.id));
    }

    #[serial]
    #[tokio::test]
    async fn test_messages_by_id_includes_organism_on_tags() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let tag = find_test_bpla_tag(&env.dbx).await.unwrap();
        let datasource_group =
            find_test_datasource_group(&env.dbx).await.unwrap();

        let message = seed_message_with_tags(
            &env,
            &datasource_group,
            &tag,
            std::slice::from_ref(&login),
        )
        .await
        .unwrap();
        let logins =
            crate::users::get_organism_logins_by_login(&env.dbx, &login.login)
                .await
                .unwrap();

        let messages =
            messages_by_id_bl(&login.login, &logins, &env, &[message.id])
                .await
                .unwrap();

        assert_eq!(messages.len(), 1);
        let inbox_tags = messages[0]
            .1
            .inbox_tags
            .as_ref()
            .expect("inbox tags must be present");
        let tag_entry = inbox_tags
            .iter()
            .find(|t| t.login == Some(login.login.clone()))
            .expect("tag by login must be present");
        assert_eq!(tag_entry.organism_id, login.organism_id);
    }

    #[serial]
    #[tokio::test]
    async fn test_messages_by_id_excludes_archived_palitra_point_tokens() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let tag = find_test_bpla_tag(&env.dbx).await.unwrap();
        let datasource_group =
            find_test_datasource_group(&env.dbx).await.unwrap();
        let palitra = find_test_palitra(&env.dbx).await.unwrap();
        let message = seed_message_with_tags(
            &env,
            &datasource_group,
            &tag,
            std::slice::from_ref(&login),
        )
        .await
        .unwrap();

        sigint_inbox_item_point_token::ActiveModel {
            sigint_inbox_item_id: Set(message.id),
            palitra_id: Set(palitra.id),
            point_tokens: Set(json!([{
                "begin": 0,
                "end": 4,
                "etalon": "test",
                "text": "test"
            }])),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        let logins =
            crate::users::get_organism_logins_by_login(&env.dbx, &login.login)
                .await
                .unwrap();
        let messages =
            messages_by_id_bl(&login.login, &logins, &env, &[message.id])
                .await
                .unwrap();
        assert_eq!(messages[0].1.point_tokens.as_ref().unwrap().len(), 1);

        let mut palitra = palitra.into_active_model();
        palitra.is_archived = Set(true);
        palitra.update(&env.dbx).await.unwrap();

        let messages =
            messages_by_id_bl(&login.login, &logins, &env, &[message.id])
                .await
                .unwrap();
        assert!(messages[0]
            .1
            .point_tokens
            .as_deref()
            .unwrap_or(&[])
            .is_empty());
        assert!(!messages[0].1.text_marked.as_ref().unwrap().iter().any(
            |node| matches!(
                node,
                crate::rer_importer::highlight::ContentNode::CNPointC(_)
            )
        ));
    }

    #[serial]
    #[tokio::test]
    async fn test_get_inbox_messages_keeps_tag_organisms() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let tag = find_test_bpla_tag(&env.dbx).await.unwrap();
        let datasource_group =
            find_test_datasource_group(&env.dbx).await.unwrap();
        let sigint_zone = find_test_sigint_zone(&env.dbx).await.unwrap();

        let other_org = mk_organism(
            &env.dbx,
            organism::ActiveModel {
                name: Set("OtherOrg".to_string()),
                created_at: Set(Utc::now().naive_utc()),
                roles: Set(json!(["Rer"])),
                enabled: Set(true),
                parent_id: Set(None),
                deleted_permanently: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let other_login = mk_login(
            &env.dbx,
            login::ActiveModel {
                login: Set("OtherTester".to_string()),
                organism_id: Set(Some(other_org.id)),
                sigint_zone_id: Set(Some(sigint_zone.id)),
                created_at: Set(Utc::now().naive_utc()),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let _message = seed_message_with_tags(
            &env,
            &datasource_group,
            &tag,
            &[login.clone(), other_login.clone()],
        )
        .await
        .unwrap();

        let req = InboxMessagesReq {
            nolimit: Some(true),
            ..Default::default()
        };
        let logins = vec![login.login.clone()];
        let messages = get_inbox_messages(&login.login, &logins, &env, &req)
            .await
            .unwrap();

        assert_eq!(messages.len(), 1);
        let inbox_tags = messages[0]
            .1
            .inbox_tags
            .as_ref()
            .expect("inbox tags must be present");

        assert!(
            inbox_tags
                .iter()
                .any(|t| t.login == Some(login.login.clone())
                    && t.organism_id == login.organism_id),
            "expected tag from primary login with organism id"
        );
        assert!(
            inbox_tags
                .iter()
                .any(|t| t.login == Some(other_login.login.clone())
                    && t.organism_id == Some(other_org.id)),
            "expected tag from other login with its organism id"
        );
    }

    #[serial]
    #[tokio::test]
    async fn test_get_inbox_messages_matches_sender_in_selected_group() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let datasource_group =
            find_test_datasource_group(&env.dbx).await.unwrap();
        let now = Utc::now().naive_utc();

        let other_group = mk_signal_group(
            &env.dbx,
            signal_group::ActiveModel {
                datasource_id: Set(Some(datasource_group.datasource_id)),
                deleted: Set(false),
                created_at: Set(now),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let other_datasource_group = mk_datasource_group(
            &env.dbx,
            datasource_group::ActiveModel {
                group_master_key: Set(other_group.master_key.clone()),
                datasource_id: Set(datasource_group.datasource_id),
                created_at: Set(now),
                last_sync_at: Set(now),
                deleted: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_zone_datasource(
            &env.dbx,
            sigint_zone_datasource::ActiveModel {
                sigint_zone_id: Set(login.sigint_zone_id.unwrap()),
                datasource_id: Set(datasource_group.datasource_id),
                group_master_key: Set(other_group.master_key.clone()),
                created_at: Set(now),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let uid =
            format!("uid-cross-group-{}", now.and_utc().timestamp_millis());
        let message = mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                body: Set(Some("cross-group sender test".to_string())),
                created_at: Set(now),
                timestamp: Set(Some(now)),
                sender: Set(Some("sender-c".to_string())),
                message_uid: Set(Some(uid.clone())),
                datasource_group_id: Set(Some(datasource_group.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        signal_message_group::ActiveModel {
            signal_message_id: Set(message.id),
            group_master_key: Set(Some(
                datasource_group.group_master_key.clone(),
            )),
            sender: Set(Some("sender-c".to_string())),
            message_uid: Set(Some(format!("{uid}-x"))),
            datasource_group_id: Set(Some(datasource_group.id)),
            created_at: Set(now),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        signal_message_group::ActiveModel {
            signal_message_id: Set(message.id),
            group_master_key: Set(Some(other_group.master_key.clone())),
            sender: Set(Some("sender-a".to_string())),
            message_uid: Set(Some(format!("{uid}-y"))),
            datasource_group_id: Set(Some(other_datasource_group.id)),
            created_at: Set(now),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        mk_sigint_inbox_item(
            &env.dbx,
            sigint_inbox_item::ActiveModel {
                id: Set(message.id),
                freq: Set(Some("123.45".to_string())),
                date: Set(Some(now.date().to_string())),
                time: Set(Some(now.time().format("%H:%M:%S").to_string())),
                reviewed: Set(Some(true)),
                parsed_unit_v2: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let logins = vec![login.login.clone()];
        let wrong_sender_req = InboxMessagesReq {
            nolimit: Some(true),
            selected_groups: Some(vec![datasource_group
                .group_master_key
                .clone()]),
            selected_senders: Some(vec!["sender-a".to_string()]),
            ..Default::default()
        };
        let wrong_sender_messages =
            get_inbox_messages(&login.login, &logins, &env, &wrong_sender_req)
                .await
                .unwrap();
        assert!(
            wrong_sender_messages.is_empty(),
            "message matched sender from another group row"
        );

        let matching_sender_req = InboxMessagesReq {
            nolimit: Some(true),
            selected_groups: Some(vec![datasource_group
                .group_master_key
                .clone()]),
            selected_senders: Some(vec!["sender-c".to_string()]),
            ..Default::default()
        };
        let matching_sender_messages = get_inbox_messages(
            &login.login,
            &logins,
            &env,
            &matching_sender_req,
        )
        .await
        .unwrap();
        assert_eq!(matching_sender_messages.len(), 1);
        assert_eq!(
            matching_sender_messages[0].1.sender.as_deref(),
            Some("sender-c")
        );
    }
}
