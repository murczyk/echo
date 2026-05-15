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
use std::collections::{BTreeMap, BTreeSet};

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
    if result.is_ok() {
        fanout_inbox_changed(&env, vec![req.id]).await;
    }
    result
}

#[post("/api/rer-importer/inbox/submit")]
async fn inbox_submit(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<InboxSubmitReq>,
) -> Result<Json<InboxSubmitRsp>, AppError> {
    match submit_legacy_inbox(user, &env, req.into_inner()).await {
        Ok(rsp) => Ok(Json(rsp)),
        Err(e) => {
            error!("failed to submit legacy inbox: {:?}", e);
            Err(e)
        }
    }
}

#[post("/api/1.1/submit")]
async fn inbox_submit_v11(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<InboxSubmitItem>,
) -> Result<Json<GenericInboxSubmitRsp>, AppError> {
    match submit_generic_inbox(user, &env, req.into_inner()).await {
        Ok(rsp) => Ok(Json(rsp)),
        Err(e) => {
            error!("failed to submit generic inbox: {:?}", e);
            Err(e)
        }
    }
}

#[derive(Debug)]
struct SubmittedInboxItem {
    message_uid: String,
    inbox_id: i64,
    warnings: Vec<InboxSubmitWarning>,
}

async fn submit_generic_inbox_item(
    env: &Data<Env>,
    txn: &DatabaseTransaction,
    datasource: &datasource::Model,
    login: &str,
    logins: &Vec<String>,
    item: InboxSubmitItem,
) -> Result<SubmittedInboxItem, AppError> {
    validate_generic_submit_item(&item)?;
    let groups = ensure_submit_groups(
        txn,
        datasource,
        login,
        item.group_names.as_deref().unwrap_or(&[]),
    )
    .await
    .c(h!())?;
    let tag_ids = resolve_submit_tag_ids(txn, item.tags.as_deref()).await?;
    let operator_tags = submit_operator_tags(item.tags.as_deref())?;
    let (mut message, timestamp) = generic_submit_item_to_inbox_message(&item)?;
    let post = normalized_optional_string(message.post.as_deref());
    let post_id = match message.post_id {
        Some(post_id) => Some(post_id),
        None => crate::sigint::post::get_or_create_post_id(txn, &post)
            .await
            .c(h!())?,
    };
    message.group_master_key = groups.first().map(|(key, _)| key.clone());
    message.post = post;
    message.post_id = post_id;
    prepare_submit_body_for_coordinate_extraction(&mut message)?;

    let signal_message = upsert_submit_signal_message(
        txn,
        &env.config,
        datasource.id,
        item.message_uid.as_deref(),
        &message,
        Some(timestamp),
        operator_tags,
        &groups,
    )
    .await
    .c(h!())?;
    let message_uid = signal_message.message_uid.clone().c(h!())?;
    let inbox_id = submit_upsert_inbox_item(
        env.settlements.clone(),
        txn,
        signal_message.id,
        &message,
        login,
        logins,
    )
    .await
    .c(h!())?;
    add_submit_tags(txn, inbox_id, login, tag_ids)
        .await
        .c(h!())?;
    let InboxSubmitItem { network, dmr, .. } = item;
    let warnings =
        save_submit_dmr_metadata(inbox_id, network.as_ref(), dmr, txn)
            .await
            .c(h!())?;

    Ok(SubmittedInboxItem {
        message_uid,
        inbox_id,
        warnings,
    })
}

fn validate_generic_submit_item(
    item: &InboxSubmitItem,
) -> Result<(), AppError> {
    if item.text.trim().is_empty() {
        return Err(AppError::BL {
            msg: "Inbox submit requires message text".to_string(),
        });
    }
    if item
        .group_names
        .as_ref()
        .is_none_or(|groups| groups.iter().all(|group| group.trim().is_empty()))
    {
        return Err(AppError::BL {
            msg: "Inbox submit requires at least one group name".to_string(),
        });
    }
    validate_submit_network(item.network.as_ref())?;
    validate_submit_dmr_signal_names(&item.dmr)?;
    validate_submit_dmr_timestamps(&item.dmr)?;
    Ok(())
}

fn generic_submit_item_to_inbox_message(
    item: &InboxSubmitItem,
) -> Result<(InboxMessage, NaiveDateTime), AppError> {
    let timestamp =
        parse_submit_rfc3339_timestamp("timestamp", &item.timestamp)?;
    let (date, time) = format_submit_date_time_fields(timestamp);
    let message = InboxMessage {
        message_uid: None,
        text: item.text.clone(),
        media: vec![],
        images: vec![],
        image_recognized: vec![],
        date: Some(date),
        time: Some(time),
        freq: item.freq.clone(),
        coords: format_submit_coordinates(&item.coords),
        callsigns: submit_item_callsigns(item),
        callsigns_alg2: vec![],
        checked: true,
        important: false,
        bookmarked: false,
        timestamp: Some(timestamp.and_utc().timestamp_millis()),
        group_master_key: None,
        sender: item.sender.clone(),
        extended_form: item.full_body.clone(),
        post: item.post.clone(),
        post_id: None,
        unit: item.unit.clone(),
        callsign_tokens: None,
        signal_tokens: None,
        point_tokens: None,
        no_headers_body: None,
        keyword_tokens: None,
        text_marked: None,
        datasource_id: None,
        location: format_submit_locations(&item.locations),
        tags: None,
        network_ids: None,
        inbox_tags: None,
        metadata: vec![],
    };
    Ok((message, timestamp))
}

async fn resolve_submit_tag_ids(
    txn: &DatabaseTransaction,
    tag_labels: Option<&[String]>,
) -> Result<Option<Vec<i64>>, AppError> {
    let Some(tag_labels) = tag_labels else {
        return Ok(None);
    };

    let tag_labels = tag_labels
        .iter()
        .map(|tag_label| tag_label.trim())
        .filter(|tag_label| !tag_label.is_empty())
        .unique()
        .map(ToOwned::to_owned)
        .collect_vec();
    if tag_labels.is_empty() {
        return Ok(Some(vec![]));
    }

    let tags = tag::Entity::find()
        .filter(tag::Column::Enabled.eq(true))
        .filter(tag::Column::Label.eq_any(tag_labels.clone()))
        .order_by_asc(tag::Column::Id)
        .all(txn)
        .await
        .c(h!())?;
    let mut tag_ids_by_label = BTreeMap::new();
    for tag in tags {
        tag_ids_by_label.entry(tag.label).or_insert(tag.id);
    }

    let mut tag_ids = vec![];
    for tag_label in tag_labels {
        if let Some(tag_id) = tag_ids_by_label.get(&tag_label) {
            tag_ids.push(*tag_id);
        }
    }
    Ok(Some(tag_ids))
}

fn submit_operator_tags(
    tag_labels: Option<&[String]>,
) -> Result<Option<serde_json::Value>, AppError> {
    let Some(tag_labels) = tag_labels else {
        return Ok(None);
    };
    Ok(serde_json::to_value(tag_labels).map(Some).context(h!())?)
}

fn submit_item_callsigns(item: &InboxSubmitItem) -> Vec<String> {
    item.from_callsign
        .iter()
        .chain(item.to.iter())
        .filter_map(|callsign| normalized_optional_string(Some(callsign)))
        .collect()
}

async fn add_submit_tags(
    txn: &DatabaseTransaction,
    inbox_id: i64,
    login: &str,
    tag_ids: Option<Vec<i64>>,
) -> Result<(), AppError> {
    let Some(tag_ids) = tag_ids else {
        return Ok(());
    };

    for tag_id in tag_ids.into_iter().collect::<BTreeSet<_>>() {
        let existing = sigint_inbox_item_tag::Entity::find()
            .filter(
                sigint_inbox_item_tag::Column::SigintInboxItemId.eq(inbox_id),
            )
            .filter(sigint_inbox_item_tag::Column::TagId.eq(tag_id))
            .filter(
                sigint_inbox_item_tag::Column::Login
                    .eq(Some(login.to_string())),
            )
            .filter(sigint_inbox_item_tag::Column::Model.is_null())
            .one(txn)
            .await
            .c(h!())?;
        if existing.is_some() {
            continue;
        }

        sigint_inbox_item_tag::ActiveModel {
            sigint_inbox_item_id: Set(inbox_id),
            tag_id: Set(tag_id),
            confidence: Set(1.0),
            login: Set(Some(login.to_string())),
            model: Set(None),
            ..Default::default()
        }
        .insert(txn)
        .await
        .c(h!())?;
    }
    Ok(())
}

fn format_submit_coordinates(coords: &[SubmitCoordinates]) -> Option<String> {
    coords
        .first()
        .map(|coords| format!("{}, {}", coords.lat, coords.lon))
}

fn format_submit_locations(locations: &[String]) -> Option<String> {
    let locations = locations
        .iter()
        .map(|location| location.trim())
        .filter(|location| !location.is_empty())
        .collect_vec();
    if locations.is_empty() {
        None
    } else {
        Some(locations.join(", "))
    }
}

fn format_submit_date_time_fields(dt_utc: NaiveDateTime) -> (String, String) {
    let dt_kyiv = DateTime::<Utc>::from_naive_utc_and_offset(dt_utc, Utc)
        .with_timezone(&chrono_tz::Europe::Kyiv);
    let date = dt_kyiv.format("%Y-%m-%d").to_string();
    let time = dt_kyiv.format("%H:%M:%S").to_string();
    (date, time)
}

fn parse_submit_rfc3339_timestamp(
    field: &str,
    value: &str,
) -> Result<NaiveDateTime, AppError> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|dt| dt.with_timezone(&Utc).naive_utc())
        .map_err(|_| AppError::BL {
            msg: format!("{field} must be an RFC 3339 timestamp"),
        })
}

fn validate_submit_dmr_timestamps(
    dmr: &[SubmitDmrMetadata],
) -> Result<(), AppError> {
    for (index, metadata) in dmr.iter().enumerate() {
        parse_submit_rfc3339_timestamp(
            &format!("dmr[{index}].timestamp"),
            &metadata.timestamp,
        )?;
    }
    Ok(())
}

async fn ensure_submit_groups(
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
        let group_master_key = submit_group_master_key(login, group_name);
        let (group_master_key, datasource_group_id) =
            ensure_submit_datasource_group(
                txn,
                datasource.id,
                &group_master_key,
                group_name,
            )
            .await
            .c(h!())?;
        ensure_submit_group_aor(
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

fn submit_group_master_key(login: &str, group_name: &str) -> String {
    let digest = sha256::digest(format!("{login}:{group_name}"));
    format!("echo.{}", &digest[..32])
}

async fn ensure_submit_datasource_group(
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

async fn ensure_submit_group_aor(
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

async fn upsert_submit_signal_message(
    txn: &DatabaseTransaction,
    config: &Config,
    datasource_id: i64,
    message_uid: Option<&str>,
    message: &InboxMessage,
    timestamp: Option<NaiveDateTime>,
    operator_tags: Option<serde_json::Value>,
    groups: &[(String, i64)],
) -> Result<signal_message::Model, AppError> {
    let (_group_master_key, datasource_group_id) =
        groups.first().cloned().c(h!())?;
    let signal_message = match normalized_optional_string(message_uid) {
        Some(message_uid) => {
            let signal_message = SignalMessage::find()
                .join(
                    JoinType::InnerJoin,
                    signal_message::Relation::DatasourceGroup.def(),
                )
                .filter(signal_message::Column::MessageUid.eq(message_uid))
                .filter(
                    datasource_group::Column::DatasourceId.eq(datasource_id),
                )
                .one(txn)
                .await
                .c(h!())?
                .ok_or(AppError::NotFound)?;
            let mut signal_message = signal_message.into_active_model();
            signal_message.body = Set(Some(message.text.clone()));
            signal_message.datasource_group_id = Set(Some(datasource_group_id));
            signal_message.timestamp = Set(timestamp);
            signal_message.sender = Set(message.sender.clone());
            signal_message.operator_tags = Set(operator_tags);
            signal_message.deleted = Set(false);
            signal_message.update(txn).await.c(h!())?
        }
        None => signal_message::ActiveModel {
            id: NotSet,
            body: Set(Some(message.text.clone())),
            datasource_group_id: Set(Some(datasource_group_id)),
            created_at: NotSet,
            timestamp: Set(timestamp),
            sender: Set(message.sender.clone()),
            format: NotSet,
            deleted: Set(false),
            external_id: Set(None),
            message_uid: NotSet,
            operator_tags: Set(operator_tags),
        }
        .insert(txn)
        .await
        .c(h!())?,
    };

    let signal_message =
        ensure_signal_message_model_uid(txn, config, signal_message)
            .await
            .c(h!())?;
    ensure_submit_signal_message_groups(txn, &signal_message, groups).await?;
    Ok(signal_message)
}

async fn ensure_submit_signal_message_groups(
    txn: &DatabaseTransaction,
    signal_message: &signal_message::Model,
    groups: &[(String, i64)],
) -> Result<(), AppError> {
    for (group_master_key, datasource_group_id) in groups {
        let existing = signal_message_group::Entity::find()
            .filter(
                signal_message_group::Column::SignalMessageId
                    .eq(signal_message.id),
            )
            .filter(
                signal_message_group::Column::GroupMasterKey
                    .eq(group_master_key.clone()),
            )
            .one(txn)
            .await
            .c(h!())?;
        if let Some(existing) = existing {
            let mut existing = existing.into_active_model();
            existing.sender = Set(signal_message.sender.clone());
            existing.message_uid = Set(signal_message.message_uid.clone());
            existing.datasource_group_id = Set(Some(*datasource_group_id));
            existing.update(txn).await.c(h!())?;
            continue;
        }

        signal_message_group::ActiveModel {
            id: NotSet,
            signal_message_id: Set(signal_message.id),
            group_master_key: Set(Some(group_master_key.clone())),
            sender: Set(signal_message.sender.clone()),
            message_uid: Set(signal_message.message_uid.clone()),
            datasource_group_id: Set(Some(*datasource_group_id)),
            created_at: Set(signal_message.created_at),
        }
        .insert(txn)
        .await
        .c(h!())?;
    }
    Ok(())
}

fn normalized_optional_string(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn prepare_submit_body_for_coordinate_extraction(
    message: &mut InboxMessage,
) -> Result<(), AppError> {
    message.coords = normalized_optional_string(message.coords.as_deref());
    if message.coords.is_some() {
        message.no_headers_body = None;
        return Ok(());
    }
    if message.no_headers_body.is_none() {
        message.no_headers_body = Some(
            crate::rer_importer::body_noheader::extract_text(&message.text)
                .c(h!())?,
        );
    }
    Ok(())
}

async fn save_submit_dmr_metadata(
    inbox_id: i64,
    network: Option<&SubmitNetwork>,
    dmr: Vec<SubmitDmrMetadata>,
    txn: &DatabaseTransaction,
) -> Result<Vec<InboxSubmitWarning>, AppError> {
    let (dmr, warnings) = normalize_submit_dmr_metadata(network, dmr)?;
    let mut entries = dmr
        .iter()
        .map(|metadata| submit_dmr_metadata_model(inbox_id, metadata))
        .collect::<Vec<_>>();

    if entries.is_empty() {
        if let Some(cc) = network.as_ref().and_then(|network| network.cc) {
            entries.push(sigint_inbox_item_metadata::ActiveModel {
                id: NotSet,
                sigint_inbox_item_id: Set(inbox_id),
                color_code: Set(Some(cc.to_string())),
                created_at: NotSet,
                ..Default::default()
            });
        }
    }

    delete_previous_submit_dmr_metadata(inbox_id, txn)
        .await
        .c(h!())?;
    let mut existing_metadata_keys =
        load_submit_metadata_keys(inbox_id, txn).await.c(h!())?;
    entries.retain(|entry| {
        existing_metadata_keys.insert(submit_metadata_key_from_active(entry))
    });
    if entries.is_empty() {
        return Ok(warnings);
    }
    sigint_inbox_item_metadata::Entity::insert_many(entries)
        .exec(txn)
        .await
        .c(h!())?;
    Ok(warnings)
}

async fn delete_previous_submit_dmr_metadata(
    inbox_id: i64,
    txn: &DatabaseTransaction,
) -> Result<(), AppError> {
    sigint_inbox_item_metadata::Entity::delete_many()
        .filter(
            sigint_inbox_item_metadata::Column::SigintInboxItemId.eq(inbox_id),
        )
        .filter(submit_dmr_metadata_without_source_spans())
        .exec(txn)
        .await
        .c(h!())?;
    Ok(())
}

fn submit_dmr_metadata_without_source_spans() -> Condition {
    use sigint_inbox_item_metadata::Column;

    Condition::all()
        .add(Column::ColorCodeStartIndex.is_null())
        .add(Column::ColorCodeEndIndex.is_null())
        .add(Column::CallGroupIdStartIndex.is_null())
        .add(Column::CallGroupIdEndIndex.is_null())
        .add(Column::CallGroupNameStartIndex.is_null())
        .add(Column::CallGroupNameEndIndex.is_null())
        .add(Column::SenderIdStartIndex.is_null())
        .add(Column::SenderIdEndIndex.is_null())
        .add(Column::SenderNameStartIndex.is_null())
        .add(Column::SenderNameEndIndex.is_null())
        .add(Column::HashIdStartIndex.is_null())
        .add(Column::HashIdEndIndex.is_null())
}

type SubmitMetadataKey = (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

async fn load_submit_metadata_keys(
    inbox_id: i64,
    txn: &DatabaseTransaction,
) -> Result<BTreeSet<SubmitMetadataKey>, AppError> {
    Ok(sigint_inbox_item_metadata::Entity::find()
        .filter(
            sigint_inbox_item_metadata::Column::SigintInboxItemId.eq(inbox_id),
        )
        .all(txn)
        .await
        .c(h!())?
        .into_iter()
        .map(submit_metadata_key_from_model)
        .collect())
}

fn submit_metadata_key_from_model(
    metadata: sigint_inbox_item_metadata::Model,
) -> SubmitMetadataKey {
    (
        metadata.color_code,
        metadata.call_group_id,
        metadata.call_group_name,
        metadata.sender_id,
        metadata.sender_name,
        metadata.hash_id,
    )
}

fn submit_metadata_key_from_active(
    metadata: &sigint_inbox_item_metadata::ActiveModel,
) -> SubmitMetadataKey {
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

fn normalize_submit_dmr_metadata(
    network: Option<&SubmitNetwork>,
    dmr: Vec<SubmitDmrMetadata>,
) -> Result<(Vec<SubmitDmrMetadata>, Vec<InboxSubmitWarning>), AppError> {
    validate_submit_network(network)?;
    validate_submit_dmr_signal_names(&dmr)?;
    let dmr = dmr
        .into_iter()
        .map(normalize_submit_dmr_metadata_values)
        .collect::<Vec<_>>();
    let primary_cc = dmr
        .first()
        .and_then(|metadata| metadata.cc)
        .or_else(|| network.and_then(|network| network.cc));
    let Some(primary_cc) = primary_cc else {
        return Ok((reduce_submit_dmr_metadata(dmr), vec![]));
    };

    let mut warnings = vec![];
    if dmr.first().is_some_and(|metadata| metadata.cc.is_none()) {
        warnings.push(InboxSubmitWarning {
            code: "dmr_primary_cc_missing".to_string(),
            message: format!(
                "Primary DMR metadata color code is missing; using {primary_cc}"
            ),
        });
    }
    if let Some(network_cc) = network.and_then(|network| network.cc) {
        if network_cc != primary_cc {
            warnings.push(InboxSubmitWarning {
                code: "dmr_network_cc_conflict".to_string(),
                message: format!(
                    "DMR network color code {network_cc} differs from primary color code {primary_cc}; using {primary_cc}"
                ),
            });
        }
    }

    let dmr = dmr
        .into_iter()
        .enumerate()
        .map(|(index, mut metadata)| {
            match metadata.cc {
                Some(cc) if cc != primary_cc => {
                    warnings.push(InboxSubmitWarning {
                        code: "dmr_metadata_cc_conflict".to_string(),
                        message: format!(
                            "DMR metadata record {index} color code {cc} differs from primary color code {primary_cc}; using {primary_cc}"
                        ),
                    });
                    metadata.cc = Some(primary_cc);
                }
                None => {
                    warnings.push(InboxSubmitWarning {
                        code: "dmr_metadata_cc_missing".to_string(),
                        message: format!(
                            "DMR metadata record {index} color code is missing; using {primary_cc}"
                        ),
                    });
                    metadata.cc = Some(primary_cc);
                }
                _ => {}
            }
            metadata
        })
        .collect();

    Ok((reduce_submit_dmr_metadata(dmr), warnings))
}

fn validate_submit_network(
    network: Option<&SubmitNetwork>,
) -> Result<(), AppError> {
    if let Some(network) = network {
        validate_submit_signal_name(&network.signal_name)?;
    }
    Ok(())
}

fn validate_submit_dmr_signal_names(
    dmr: &[SubmitDmrMetadata],
) -> Result<(), AppError> {
    for metadata in dmr {
        validate_submit_signal_name(&metadata.signal_name)?;
    }
    Ok(())
}

fn validate_submit_signal_name(signal_name: &str) -> Result<(), AppError> {
    if signal_name.trim().eq_ignore_ascii_case("dmr") {
        return Ok(());
    }
    Err(AppError::BL {
        msg: format!("Unsupported DMR metadata signal name: {signal_name}"),
    })
}

fn normalize_submit_dmr_metadata_values(
    mut metadata: SubmitDmrMetadata,
) -> SubmitDmrMetadata {
    metadata.freq = crate::rer_importer::frequency::etalon(&metadata.freq);
    metadata.sender_name = normalize_submit_metadata_text(metadata.sender_name);
    metadata.call_group_name =
        normalize_submit_metadata_text(metadata.call_group_name);
    metadata.hash_id = normalize_submit_metadata_text(metadata.hash_id)
        .map(|hash_id| hash_id.to_lowercase());
    metadata
}

fn normalize_submit_metadata_text(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value =
            crate::rer_importer::inbox::metadata::normalize_metadata_digits(
                &value,
            );
        crate::rer_importer::inbox::metadata::normalize_metadata_value(&value)
    })
}

fn reduce_submit_dmr_metadata(
    mut items: Vec<SubmitDmrMetadata>,
) -> Vec<SubmitDmrMetadata> {
    loop {
        if items.len() <= 1 {
            return items;
        }

        let mut removed = false;
        'outer: for idx in 0..items.len() {
            for other_idx in 0..items.len() {
                if idx == other_idx {
                    continue;
                }
                if submit_dmr_metadata_matches(&items[idx], &items[other_idx]) {
                    items.remove(idx);
                    removed = true;
                    break 'outer;
                }
            }
        }

        if !removed {
            return items;
        }
    }
}

fn submit_dmr_metadata_matches(
    left: &SubmitDmrMetadata,
    right: &SubmitDmrMetadata,
) -> bool {
    submit_dmr_metadata_has_some_value(left)
        && matches_optional_value(left.cc.as_ref(), right.cc.as_ref())
        && matches_optional_value(
            left.call_group_id.as_ref(),
            right.call_group_id.as_ref(),
        )
        && matches_optional_value(
            left.call_group_name.as_ref(),
            right.call_group_name.as_ref(),
        )
        && matches_optional_value(
            left.sender_id.as_ref(),
            right.sender_id.as_ref(),
        )
        && matches_optional_value(
            left.sender_name.as_ref(),
            right.sender_name.as_ref(),
        )
        && matches_optional_value(left.hash_id.as_ref(), right.hash_id.as_ref())
}

fn submit_dmr_metadata_has_some_value(metadata: &SubmitDmrMetadata) -> bool {
    metadata.cc.is_some()
        || metadata.sender_id.is_some()
        || metadata
            .sender_name
            .as_ref()
            .is_some_and(|value| !value.is_empty())
        || metadata.call_group_id.is_some()
        || metadata
            .call_group_name
            .as_ref()
            .is_some_and(|value| !value.is_empty())
        || metadata
            .hash_id
            .as_ref()
            .is_some_and(|value| !value.is_empty())
}

fn matches_optional_value<T: PartialEq>(
    left: Option<&T>,
    right: Option<&T>,
) -> bool {
    match left {
        Some(left) => right.is_some_and(|right| left == right),
        None => true,
    }
}

fn submit_dmr_metadata_model(
    inbox_id: i64,
    metadata: &SubmitDmrMetadata,
) -> sigint_inbox_item_metadata::ActiveModel {
    sigint_inbox_item_metadata::ActiveModel {
        id: NotSet,
        sigint_inbox_item_id: Set(inbox_id),
        color_code: Set(metadata.cc.map(|cc| cc.to_string())),
        call_group_id: Set(metadata.call_group_id.map(|id| id.to_string())),
        call_group_name: Set(metadata.call_group_name.clone()),
        sender_id: Set(metadata.sender_id.map(|id| id.to_string())),
        sender_name: Set(metadata.sender_name.clone()),
        hash_id: Set(metadata.hash_id.clone()),
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
                        sigint_post_id: NotSet,
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
                        sigint_post_id: NotSet,
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

async fn submit_legacy_inbox(
    user: Identity,
    env: &Data<Env>,
    req: InboxSubmitReq,
) -> Result<InboxSubmitRsp, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .c(h!())?;
    let logins = crate::users::get_organism_logins(&env.dbx, user)
        .await
        .context(h!())?;
    submit_legacy_inbox_messages(env, &login, &logins, req).await
}

async fn submit_generic_inbox(
    user: Identity,
    env: &Data<Env>,
    item: InboxSubmitItem,
) -> Result<GenericInboxSubmitRsp, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_any_role(
        &env.dbx,
        &login,
        vec!["Rer", "Api", "ApiAgent"],
    )
    .await
    .c(h!())?;
    let logins = crate::users::get_organism_logins(&env.dbx, user)
        .await
        .context(h!())?;
    let submitted =
        submit_generic_inbox_message(env, &login, &logins, item).await?;
    Ok(GenericInboxSubmitRsp {
        message_uid: submitted.message_uid,
        warnings: submitted.warnings,
    })
}

async fn submit_generic_inbox_message(
    env: &Data<Env>,
    login: &str,
    logins: &Vec<String>,
    item: InboxSubmitItem,
) -> Result<SubmittedInboxItem, AppError> {
    let txn = env.dbx.begin().await.c(h!())?;
    let datasource = datasource::Entity::find()
        .filter(datasource::Column::ApiLogin.eq(login))
        .filter(datasource::Column::Enabled.eq(true))
        .filter(datasource::Column::Deleted.eq(false))
        .one(&txn)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    let submitted =
        submit_generic_inbox_item(env, &txn, &datasource, login, logins, item)
            .await
            .c(h!())?;
    let inbox_id = submitted.inbox_id;

    txn.commit().await.c(h!())?;
    fanout_inbox_changed(env, vec![inbox_id]).await;
    Ok(submitted)
}

async fn submit_legacy_inbox_messages(
    env: &Data<Env>,
    login: &str,
    logins: &Vec<String>,
    req: InboxSubmitReq,
) -> Result<InboxSubmitRsp, AppError> {
    let txn = env.dbx.begin().await.c(h!())?;
    let mut changed_inbox_ids = vec![];
    let mut submitted_messages = vec![];

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
                login,
                logins,
            )
            .await
            .c(h!())?;
            changed_inbox_ids.push(inbox_id);
            let message_id = ensure_signal_message_uid(&txn, &env.config, *id)
                .await
                .c(h!())?;
            submitted_messages.push(InboxSubmitMessageRsp { message_id });
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
    Ok(InboxSubmitRsp {
        messages: submitted_messages,
        warnings: vec![],
    })
}

async fn ensure_signal_message_uid(
    txn: &DatabaseTransaction,
    config: &Config,
    signal_message_id: i64,
) -> Result<String, AppError> {
    let signal_message = SignalMessage::find_by_id(signal_message_id)
        .one(txn)
        .await
        .c(h!())?
        .c(h!())?;
    let signal_message =
        ensure_signal_message_model_uid(txn, config, signal_message).await?;
    Ok(signal_message.message_uid.c(h!())?)
}

async fn ensure_signal_message_model_uid(
    txn: &DatabaseTransaction,
    config: &Config,
    signal_message: signal_message::Model,
) -> Result<signal_message::Model, AppError> {
    if signal_message
        .message_uid
        .as_ref()
        .is_some_and(|message_uid| !message_uid.is_empty())
    {
        return Ok(signal_message);
    }

    Ok(crate::messenger::id::update_message_with_uid(
        txn,
        config,
        signal_message,
    )
    .await
    .c(h!())?)
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
        datasource, datasource_group, login, organism, sigint_comment,
        sigint_inbox_item, sigint_inbox_item_metadata,
        sigint_inbox_item_point_token, sigint_inbox_item_tag,
        sigint_zone_datasource, signal_group, signal_message,
        signal_message_group, signal_message_media, tag,
    };
    use crate::functest::tests::*;
    use chrono::{DateTime, SecondsFormat, Utc};
    use sea_orm::ActiveValue::Set;
    use serde_json::json;
    use serial_test::serial;
    use std::sync::Arc;
    use uuid::Uuid;

    fn submit_dmr_metadata(cc: Option<i32>) -> SubmitDmrMetadata {
        SubmitDmrMetadata {
            timestamp: "2026-06-25T12:34:56Z".to_string(),
            cc,
            freq: "145.0260".to_string(),
            signal_name: "dmr".to_string(),
            sender_id: Some(110),
            sender_name: Some("ЯРУС".to_string()),
            call_group_id: Some(50),
            call_group_name: Some("СВЕТЛЫЙ".to_string()),
            hash_id: Some("2324d327".to_string()),
        }
    }

    fn submit_timestamp(dt: NaiveDateTime) -> String {
        DateTime::<Utc>::from_naive_utc_and_offset(dt, Utc)
            .to_rfc3339_opts(SecondsFormat::Secs, true)
    }

    fn warning_codes(warnings: &[InboxSubmitWarning]) -> Vec<&str> {
        warnings
            .iter()
            .map(|warning| warning.code.as_str())
            .collect()
    }

    fn generic_submit_req() -> InboxSubmitItem {
        let now = Utc::now().naive_utc();
        InboxSubmitItem {
            message_uid: None,
            text: "generic datasource gate".to_string(),
            timestamp: submit_timestamp(now),
            sender: Some("generic submit".to_string()),
            post: Some("SC1".to_string()),
            group_names: Some(vec!["SC1".to_string()]),
            network: None,
            dmr: vec![],
            ..Default::default()
        }
    }

    #[test]
    fn submit_dmr_metadata_model_stringifies_numeric_ids_for_storage() {
        let metadata = submit_dmr_metadata(Some(5));

        let metadata = submit_dmr_metadata_model(42, &metadata);

        assert_eq!(
            active_optional_string(&metadata.color_code).as_deref(),
            Some("5")
        );
        assert_eq!(
            active_optional_string(&metadata.sender_id).as_deref(),
            Some("110")
        );
        assert_eq!(
            active_optional_string(&metadata.sender_name).as_deref(),
            Some("ЯРУС")
        );
        assert_eq!(
            active_optional_string(&metadata.call_group_id).as_deref(),
            Some("50")
        );
        assert_eq!(
            active_optional_string(&metadata.call_group_name).as_deref(),
            Some("СВЕТЛЫЙ")
        );
        assert_eq!(
            active_optional_string(&metadata.hash_id).as_deref(),
            Some("2324d327")
        );
    }

    #[test]
    fn normalize_submit_dmr_metadata_uses_primary_cc_for_conflicts() {
        let mut conflicting_metadata = submit_dmr_metadata(Some(7));
        conflicting_metadata.sender_id = Some(111);
        let (dmr, warnings) = normalize_submit_dmr_metadata(
            None,
            vec![submit_dmr_metadata(Some(5)), conflicting_metadata],
        )
        .unwrap();

        assert_eq!(dmr[0].cc, Some(5));
        assert_eq!(dmr[1].cc, Some(5));
        assert_eq!(warning_codes(&warnings), vec!["dmr_metadata_cc_conflict"]);
    }

    #[test]
    fn normalize_submit_dmr_metadata_warns_on_network_cc_conflict() {
        let network = SubmitNetwork {
            signal_name: "dmr".to_string(),
            cc: Some(7),
            name: Some(
                "УКХ р/м управління 3 мсб 291 мсп 42 мсд 58 А".to_string(),
            ),
        };

        let (dmr, warnings) = normalize_submit_dmr_metadata(
            Some(&network),
            vec![submit_dmr_metadata(Some(5))],
        )
        .unwrap();

        assert_eq!(dmr[0].cc, Some(5));
        assert_eq!(warning_codes(&warnings), vec!["dmr_network_cc_conflict"]);
    }

    #[test]
    fn normalize_submit_dmr_metadata_normalizes_blank_values_and_freq() {
        let mut metadata = submit_dmr_metadata(Some(5));
        metadata.freq = "145.02678".to_string();
        metadata.sender_name = Some(" НВ ".to_string());
        metadata.call_group_name = Some(" hb ".to_string());
        metadata.hash_id = Some("2324D327".to_string());

        let (dmr, warnings) =
            normalize_submit_dmr_metadata(None, vec![metadata]).unwrap();

        assert!(warnings.is_empty());
        assert_eq!(dmr[0].freq, "145.0267");
        assert_eq!(dmr[0].sender_name, None);
        assert_eq!(dmr[0].call_group_name, None);
        assert_eq!(dmr[0].hash_id.as_deref(), Some("2324d327"));
    }

    #[test]
    fn normalize_submit_dmr_metadata_drops_duplicate_subset_rows() {
        let subset = SubmitDmrMetadata {
            sender_id: None,
            sender_name: None,
            call_group_name: None,
            hash_id: None,
            ..submit_dmr_metadata(Some(5))
        };
        let rich = submit_dmr_metadata(Some(5));

        let (dmr, warnings) =
            normalize_submit_dmr_metadata(None, vec![subset, rich]).unwrap();

        assert!(warnings.is_empty());
        assert_eq!(dmr.len(), 1);
        assert_eq!(dmr[0].sender_id, Some(110));
        assert_eq!(dmr[0].call_group_id, Some(50));
    }

    #[test]
    fn normalize_submit_dmr_metadata_rejects_unsupported_signal_names() {
        let mut metadata = submit_dmr_metadata(Some(5));
        metadata.signal_name = "tetra".to_string();

        assert!(normalize_submit_dmr_metadata(None, vec![metadata]).is_err());
    }

    #[test]
    fn validate_generic_submit_item_requires_group_names() {
        let item = InboxSubmitItem {
            text: "рос абонент ЯРУС викликав СВЕТЛЫЙ".to_string(),
            group_names: Some(vec![" ".to_string()]),
            ..Default::default()
        };

        assert!(validate_generic_submit_item(&item).is_err());
    }

    #[test]
    fn validate_generic_submit_item_rejects_missing_message_text() {
        let item = InboxSubmitItem {
            text: " ".to_string(),
            group_names: Some(vec!["SC1".to_string()]),
            ..Default::default()
        };

        assert!(validate_generic_submit_item(&item).is_err());
    }

    #[test]
    fn generic_submit_item_to_inbox_message_uses_array_fields() {
        let item = InboxSubmitItem {
            text: "рос абонент ЯРУС викликав СВЕТЛЫЙ".to_string(),
            timestamp: "2026-06-25T12:34:56Z".to_string(),
            coords: vec![
                SubmitCoordinates {
                    lat: 49.12345,
                    lon: 37.12345,
                },
                SubmitCoordinates {
                    lat: 50.0,
                    lon: 38.0,
                },
            ],
            locations: vec![
                "ЛИМАН ПЕРШИЙ".to_string(),
                " ".to_string(),
                "КОПАНІ".to_string(),
            ],
            from_callsign: Some("ЯРУС".to_string()),
            to: vec!["СВЕТЛЫЙ".to_string(), " ".to_string()],
            ..Default::default()
        };

        let (message, timestamp) =
            generic_submit_item_to_inbox_message(&item).unwrap();

        assert_eq!(
            timestamp,
            NaiveDate::from_ymd_opt(2026, 6, 25)
                .unwrap()
                .and_hms_opt(12, 34, 56)
                .unwrap()
        );
        assert_eq!(message.coords.as_deref(), Some("49.12345, 37.12345"));
        assert_eq!(message.location.as_deref(), Some("ЛИМАН ПЕРШИЙ, КОПАНІ"));
        assert_eq!(
            message.callsigns,
            vec!["ЯРУС".to_string(), "СВЕТЛЫЙ".to_string()]
        );
    }

    #[test]
    fn prepare_submit_body_for_coordinate_extraction_skips_body_when_coords_present(
    ) {
        let mut message = InboxMessage::from(InboxInsertPayload {
            text: "Отримано з поста \"SC1\"\nТекст повідомлення".to_string(),
            coords: Some(" 49.12345, 37.12345 ".to_string()),
            no_headers_body: Some(
                crate::rer_importer::body_noheader::extract_text(
                    "47.11111, 37.22222",
                )
                .unwrap(),
            ),
            ..Default::default()
        });

        prepare_submit_body_for_coordinate_extraction(&mut message).unwrap();

        assert_eq!(message.coords.as_deref(), Some("49.12345, 37.12345"));
        assert_eq!(message.no_headers_body, None);
    }

    #[test]
    fn prepare_submit_body_for_coordinate_extraction_derives_body_without_coords(
    ) {
        let mut message = InboxMessage::from(InboxInsertPayload {
            text: "Отримано з поста \"SC1\"\nТекст повідомлення".to_string(),
            coords: Some(" ".to_string()),
            ..Default::default()
        });

        prepare_submit_body_for_coordinate_extraction(&mut message).unwrap();

        assert_eq!(message.coords, None);
        assert_eq!(
            message
                .no_headers_body
                .as_ref()
                .map(|body| body.body.as_str()),
            Some("Текст повідомлення")
        );
    }

    #[serial]
    #[tokio::test]
    async fn test_legacy_regular_submit_returns_message_id_and_updates_inbox() {
        let env = cleanup().await.unwrap();
        let env_data = Data::from(env.clone());
        let login = find_test_login(&env.dbx).await.unwrap();
        let datasource_group =
            find_test_datasource_group(&env.dbx).await.unwrap();
        let now = Utc::now().naive_utc();
        let message = mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                body: Set(Some("legacy draft".to_string())),
                created_at: Set(now),
                timestamp: Set(Some(now)),
                sender: Set(Some("legacy sender".to_string())),
                message_uid: Set(None),
                datasource_group_id: Set(Some(datasource_group.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let inbox_message = InboxMessage::from(InboxInsertPayload {
            text: "legacy regular submit".to_string(),
            freq: Some("123.45".to_string()),
            callsigns: vec!["Alpha".to_string()],
            checked: true,
            timestamp: Some(now.and_utc().timestamp_millis()),
            group_master_key: Some(datasource_group.group_master_key.clone()),
            sender: Some("legacy sender".to_string()),
            post: Some("SC1".to_string()),
            ..Default::default()
        });
        let logins = vec![login.login.clone()];

        let rsp = submit_legacy_inbox_messages(
            &env_data,
            &login.login,
            &logins,
            InboxSubmitReq {
                messages: vec![(message.id, inbox_message)],
            },
        )
        .await
        .unwrap();

        assert_eq!(rsp.messages.len(), 1);
        assert!(rsp.warnings.is_empty());
        let message_id = rsp.messages[0].message_id.clone();
        assert!(!message_id.is_empty());

        let message = signal_message::Entity::find_by_id(message.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(message.message_uid.as_deref(), Some(message_id.as_str()));
        let inbox_item = sigint_inbox_item::Entity::find_by_id(message.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(inbox_item.freq.as_deref(), Some("123.4500"));
    }

    #[serial]
    #[tokio::test]
    async fn test_generic_external_submit_creates_message_groups_inbox_metadata_and_warnings(
    ) {
        let env = cleanup().await.unwrap();
        let env_data = Data::from(env.clone());
        let login = find_test_login(&env.dbx).await.unwrap();
        let datasource = find_test_datasource(&env.dbx).await.unwrap();
        let logins = vec![login.login.clone()];
        let now = Utc::now().naive_utc();
        let tag_label = format!("submit-tag-{}", Uuid::new_v4());
        let tag = mk_tag(
            &env.dbx,
            tag::ActiveModel {
                label: Set(tag_label.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let mut primary = submit_dmr_metadata(Some(5));
        primary.freq = "145.02678".to_string();
        let mut next = submit_dmr_metadata(Some(7));
        next.sender_id = Some(111);
        next.sender_name = Some("ФАКЕЛ".to_string());
        next.call_group_id = Some(51);
        next.call_group_name = Some("ВОСТОК".to_string());
        next.hash_id = Some("ABCDEF01".to_string());
        let operator_tags =
            vec![tag_label.clone(), "missing-submit-tag".to_string()];
        let item = InboxSubmitItem {
            message_uid: None,
            text: "рос абонент ЯРУС викликав СВЕТЛЫЙ".to_string(),
            freq: Some("145.02678".to_string()),
            coords: vec![SubmitCoordinates {
                lat: 49.12345,
                lon: 37.12345,
            }],
            from_callsign: Some("ЯРУС".to_string()),
            to: vec!["СВЕТЛЫЙ".to_string()],
            timestamp: submit_timestamp(now),
            sender: Some("generic submit".to_string()),
            full_body: Some("Сигнали: dmr".to_string()),
            post: Some("SC1".to_string()),
            tags: Some(operator_tags.clone()),
            locations: vec!["ЛИМАН ПЕРШИЙ".to_string(), "КОПАНІ".to_string()],
            group_names: Some(vec![
                "SC1".to_string(),
                "Чумак DMR Резерв".to_string(),
            ]),
            network: Some(SubmitNetwork {
                signal_name: "dmr".to_string(),
                cc: Some(9),
                name: Some(
                    "УКХ р/м управління 3 мсб 291 мсп 42 мсд 58 А".to_string(),
                ),
            }),
            dmr: vec![primary, next],
            ..Default::default()
        };
        let txn = env.dbx.begin().await.unwrap();

        let submitted = submit_generic_inbox_item(
            &env_data,
            &txn,
            &datasource,
            &login.login,
            &logins,
            item,
        )
        .await
        .unwrap();

        txn.commit().await.unwrap();
        assert_eq!(
            warning_codes(&submitted.warnings),
            vec!["dmr_network_cc_conflict", "dmr_metadata_cc_conflict"]
        );
        let message = signal_message::Entity::find()
            .filter(
                signal_message::Column::MessageUid
                    .eq(submitted.message_uid.clone()),
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            message.body.as_deref(),
            Some("рос абонент ЯРУС викликав СВЕТЛЫЙ")
        );
        assert_eq!(message.operator_tags, Some(json!(operator_tags)));
        let groups = signal_message_group::Entity::find()
            .filter(
                signal_message_group::Column::SignalMessageId.eq(message.id),
            )
            .all(&env.dbx)
            .await
            .unwrap();
        assert_eq!(groups.len(), 2);
        assert!(groups.iter().all(|group| {
            group.message_uid.as_deref() == Some(submitted.message_uid.as_str())
        }));
        let inbox_item =
            sigint_inbox_item::Entity::find_by_id(submitted.inbox_id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(inbox_item.freq.as_deref(), Some("145.0267"));
        assert_eq!(inbox_item.coords.as_deref(), Some("49.12345, 37.12345"));
        assert_eq!(inbox_item.lat, Some(49.12345));
        assert_eq!(inbox_item.lng, Some(37.12345));
        assert_eq!(inbox_item.checked, Some(true));
        let comment = sigint_comment::Entity::find()
            .filter(sigint_comment::Column::SignalMessageId.eq(message.id))
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(comment.comment, "Сигнали: dmr");
        let metadata = sigint_inbox_item_metadata::Entity::find()
            .filter(
                sigint_inbox_item_metadata::Column::SigintInboxItemId
                    .eq(submitted.inbox_id),
            )
            .all(&env.dbx)
            .await
            .unwrap();
        assert_eq!(metadata.len(), 2);
        assert!(metadata
            .iter()
            .all(|metadata| metadata.color_code.as_deref() == Some("5")));
        let mut sender_ids = metadata
            .iter()
            .filter_map(|metadata| metadata.sender_id.clone())
            .collect::<Vec<_>>();
        sender_ids.sort();
        assert_eq!(sender_ids, vec!["110".to_string(), "111".to_string()]);
        let inbox_tags = sigint_inbox_item_tag::Entity::find()
            .filter(
                sigint_inbox_item_tag::Column::SigintInboxItemId
                    .eq(submitted.inbox_id),
            )
            .filter(sigint_inbox_item_tag::Column::Login.eq(Some(login.login)))
            .all(&env.dbx)
            .await
            .unwrap();
        assert_eq!(inbox_tags.len(), 1);
        assert_eq!(inbox_tags[0].tag_id, tag.id);
    }

    #[serial]
    #[tokio::test]
    async fn test_save_submit_dmr_metadata_replaces_previous_submit_rows() {
        let env = cleanup().await.unwrap();
        let inbox_item = mk_sigint_inbox_item(&env.dbx, Default::default())
            .await
            .unwrap();
        mk_sigint_inbox_item_metadata(
            &env.dbx,
            sigint_inbox_item_metadata::ActiveModel {
                sigint_inbox_item_id: Set(inbox_item.id),
                color_code: Set(Some("7".to_string())),
                sender_id: Set(Some("99".to_string())),
                hash_id: Set(Some("oldhash".to_string())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_inbox_item_metadata(
            &env.dbx,
            sigint_inbox_item_metadata::ActiveModel {
                sigint_inbox_item_id: Set(inbox_item.id),
                color_code: Set(Some("5".to_string())),
                color_code_start_index: Set(Some(10)),
                color_code_end_index: Set(Some(10)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let mut metadata = submit_dmr_metadata(Some(9));
        metadata.sender_id = Some(111);
        metadata.hash_id = Some("ABCDEF01".to_string());
        let txn = env.dbx.begin().await.unwrap();

        save_submit_dmr_metadata(inbox_item.id, None, vec![metadata], &txn)
            .await
            .unwrap();

        txn.commit().await.unwrap();
        let metadata = sigint_inbox_item_metadata::Entity::find()
            .filter(
                sigint_inbox_item_metadata::Column::SigintInboxItemId
                    .eq(inbox_item.id),
            )
            .all(&env.dbx)
            .await
            .unwrap();
        assert_eq!(metadata.len(), 2);
        assert!(metadata.iter().any(|metadata| {
            metadata.color_code.as_deref() == Some("5")
                && metadata.color_code_start_index == Some(10)
        }));
        assert!(metadata.iter().any(|metadata| {
            metadata.color_code.as_deref() == Some("9")
                && metadata.sender_id.as_deref() == Some("111")
                && metadata.hash_id.as_deref() == Some("abcdef01")
        }));
        assert!(!metadata.iter().any(|metadata| {
            metadata.color_code.as_deref() == Some("7")
                || metadata.sender_id.as_deref() == Some("99")
                || metadata.hash_id.as_deref() == Some("oldhash")
        }));
    }

    #[serial]
    #[tokio::test]
    async fn test_generic_submit_rejects_disabled_or_deleted_datasource() {
        let env = cleanup().await.unwrap();
        let env_data = Data::from(env.clone());
        let login = find_test_login(&env.dbx).await.unwrap();
        let datasource = find_test_datasource(&env.dbx).await.unwrap();
        let mut datasource = datasource.into_active_model();
        datasource.api_login = Set(Some(login.login.clone()));
        datasource.enabled = Set(Some(false));
        datasource.deleted = Set(false);
        let datasource = datasource.update(&env.dbx).await.unwrap();
        let logins = vec![login.login.clone()];

        let err = submit_generic_inbox_message(
            &env_data,
            &login.login,
            &logins,
            generic_submit_req(),
        )
        .await
        .unwrap_err();

        assert!(matches!(err, AppError::NotFound));

        let mut datasource = datasource.into_active_model();
        datasource.enabled = Set(Some(true));
        datasource.deleted = Set(true);
        datasource.update(&env.dbx).await.unwrap();

        let err = submit_generic_inbox_message(
            &env_data,
            &login.login,
            &logins,
            generic_submit_req(),
        )
        .await
        .unwrap_err();

        assert!(matches!(err, AppError::NotFound));
    }

    #[serial]
    #[tokio::test]
    async fn test_generic_submit_rejects_message_uid_from_other_datasource() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let datasource = find_test_datasource(&env.dbx).await.unwrap();
        let now = Utc::now().naive_utc();
        let txn = env.dbx.begin().await.unwrap();
        let other_datasource = mk_datasource(
            &txn,
            datasource::ActiveModel {
                display_name: Set("Other API datasource".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let other_group = mk_signal_group(
            &txn,
            signal_group::ActiveModel {
                datasource_id: Set(Some(other_datasource.id)),
                deleted: Set(false),
                created_at: Set(now),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let other_datasource_group = mk_datasource_group(
            &txn,
            datasource_group::ActiveModel {
                group_master_key: Set(other_group.master_key.clone()),
                datasource_id: Set(other_datasource.id),
                created_at: Set(now),
                last_sync_at: Set(now),
                deleted: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let uid =
            format!("foreign-submit-{}", now.and_utc().timestamp_millis());
        let foreign_message = mk_signal_message(
            &txn,
            signal_message::ActiveModel {
                body: Set(Some("foreign body".to_string())),
                message_uid: Set(Some(uid.clone())),
                datasource_group_id: Set(Some(other_datasource_group.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let groups = ensure_submit_groups(
            &txn,
            &datasource,
            &login.login,
            &["owned group".to_string()],
        )
        .await
        .unwrap();
        let message = InboxMessage::from(InboxInsertPayload {
            text: "attempted overwrite".to_string(),
            sender: Some("submitter".to_string()),
            ..Default::default()
        });

        let err = upsert_submit_signal_message(
            &txn,
            &env.config,
            datasource.id,
            Some(&uid),
            &message,
            Some(now),
            None,
            &groups,
        )
        .await
        .unwrap_err();

        assert!(matches!(err, AppError::NotFound));
        let foreign_message =
            signal_message::Entity::find_by_id(foreign_message.id)
                .one(&txn)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(foreign_message.body.as_deref(), Some("foreign body"));
    }

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
