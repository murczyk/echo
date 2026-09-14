use crate::entities::{prelude::*, *};
use crate::palitra::worker::do_palitra_highlight;
use crate::rer_importer::types::*;
use crate::users::{
    ensure_rer_role, has_any_role, has_role, login_id_from_identity,
};

use crate::config::*;
use crate::error::AppError;
use crate::event_stream::fanout_mult;
use crate::event_stream::types::{EventMsg, EventType};
use crate::rer_importer::analysis::{
    analytics_inbox_candidates_supported, analytics_inbox_request_supported,
    map_postgres_runtime_timeout, with_analytics_read_fallback,
};
use crate::rer_importer::inbox::bl::*;
use crate::rer_importer::inbox::query::*;
use crate::session::record_page_visit;
use crate::sigint::sender::preferred_message_author_expr;
use crate::types::*;
use crate::utils::dt_from_millis;
use actix_identity::Identity;
use actix_web::web::{Data, Json};
use actix_web::{get, post};
use chrono::*;
use echo_migration::{Expr, Order, PostgresQueryBuilder};
use itertools::Itertools;
use once_cell::sync::Lazy;
use sea_orm::*;
use sea_query::Query;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::future::Future;
use std::time::Instant;
use tokio::sync::Mutex;

pub(crate) mod bl;
mod diagnostics;
pub mod metadata;
pub mod query;
pub(crate) mod submit_bl;
pub(crate) mod verification;

use diagnostics::InboxReadDiagnostics;
use submit_bl::*;

type InboxDigest = (i64, Option<NaiveDateTime>);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RerAnalysisInboxRoute {
    Default,
    AnalyticsHybrid,
}

struct HybridInboxCandidateIds {
    ids: Vec<i64>,
    analytics_count: usize,
    postgres_tail_count: usize,
    postgres_tail_ms: u128,
}

enum AnalyticsInboxCandidateIds {
    Available(Vec<i64>),
    EmptyScope,
    Unavailable,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum AnalyticsEmptyScopePolicy {
    PostgresFallback,
    FreshTail,
}

struct InboxCountSingleflightEntry {
    gate: Arc<Mutex<()>>,
    cached: Option<(Instant, InboxDigest)>,
    last_used: Instant,
}

static INBOX_COUNT_SINGLEFLIGHT: Lazy<
    Mutex<HashMap<String, InboxCountSingleflightEntry>>,
> = Lazy::new(|| Mutex::new(HashMap::new()));

#[post("/api/rer-importer/get-inbox-map")]
async fn get_inbox_map(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<MapPointsReq>,
) -> Result<Json<MapPointsRsp>, AppError> {
    get_inbox_map_inner(user, env, req)
        .await
        .map_err(|error| map_postgres_runtime_timeout(error, "inbox map"))
}

async fn get_inbox_map_inner(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<MapPointsReq>,
) -> Result<Json<MapPointsRsp>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let user_id = login_id_from_identity(&user).c(h!())?;
    let page_id = req.page_id.clone();
    let req = req.into_inner();
    if req.show_settlements == Some(true) {
        has_role(&env.dbx, &user_id, ROLE_ADMIN).await.c(h!())?;
    }

    let payload = serde_json::to_value(&req).context(h!())?;
    record_page_visit(&user_id, &page_id, &env, Some(payload))
        .await
        .context(h!())?;
    let login = user_id;

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
    let settlements = if req.show_settlements == Some(true) {
        get_inbox_map_settlements(&login, &env, &filter)
            .await
            .context(h!())?
    } else {
        vec![]
    };
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
        settlements,
    }))
}

#[post("/api/rer-importer/map-settlement-messages")]
async fn map_settlement_messages(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<MapSettlementMessagesReq>,
) -> Result<Json<MessageIdsRsp>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    crate::users::ensure_admin(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user).c(h!())?;
    let logins = crate::users::get_organism_login_ids(&env.dbx, user)
        .await
        .context(h!())?;
    let req = req.into_inner();
    let mut filter = req.inbox_items_filter;
    filter.nolimit = Some(true);
    let filtered_ids = build_inbox_settlement_ids_query(&login, &env, &filter)
        .await
        .c(h!())?;
    let message_ids = get_inbox_map_settlement_message_ids(
        &env.dbx,
        &filtered_ids,
        req.settlement_id,
        req.before_id_noninclusive,
        INBOX_MAP_SETTLEMENT_MESSAGES_PAGE_SIZE,
    )
    .await
    .c(h!())?;
    let mut messages =
        messages_by_id_bl(&login, &logins, &env, &message_ids, &filter)
            .await
            .context(h!())?;
    let message_order = message_ids
        .iter()
        .enumerate()
        .map(|(position, message_id)| (*message_id, position))
        .collect::<HashMap<_, _>>();
    messages.sort_by_key(|(message_id, _)| {
        message_order.get(message_id).copied().unwrap_or(usize::MAX)
    });
    Ok(Json(MessageIdsRsp { messages }))
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

#[derive(FromQueryResult)]
struct InboxItemContextRow {
    id: i64,
    datetime: Option<NaiveDateTime>,
}

#[derive(FromQueryResult)]
struct InboxItemContextGroupRow {
    group_master_key: Option<String>,
}

#[post("/api/rer-importer/inbox-item-context")]
async fn inbox_item_context(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<InboxItemContextReq>,
) -> Result<Json<InboxItemContextRsp>, AppError> {
    let login = login_id_from_identity(&user).context(h!())?;
    has_any_role(&env.dbx, &login, vec!["Rer", "ApiAgent"])
        .await
        .c(h!())?;
    let Some(message_uid) =
        normalized_optional_string(Some(req.message_uid.as_str()))
    else {
        return Ok(Json(InboxItemContextRsp::default()));
    };

    let res = inbox_item_context_bl(&env, &login, &message_uid)
        .await
        .context(h!())?;
    Ok(Json(res))
}

async fn inbox_item_context_bl(
    env: &Env,
    login: &uuid::Uuid,
    message_identifier: &str,
) -> Result<InboxItemContextRsp, AppError> {
    let mut rows = load_inbox_item_context_rows(&env.dbx, message_identifier)
        .await
        .context(h!())?;
    if rows.is_empty() {
        return Ok(InboxItemContextRsp::default());
    }

    let candidate_ids = rows.iter().map(|row| row.id).collect::<Vec<_>>();
    let organism_logins =
        crate::users::get_organism_login_ids_by_id(&env.dbx, login)
            .await
            .c(h!())?;
    let access_req = InboxMessagesReq {
        skip_group_stats: Some(true),
        ..Default::default()
    };
    let mut accessible_messages = messages_by_id_bl(
        login,
        &organism_logins,
        env,
        &candidate_ids,
        &access_req,
    )
    .await
    .context(h!())?
    .into_iter()
    .collect::<HashMap<_, _>>();
    rows.retain(|row| accessible_messages.contains_key(&row.id));
    if rows.is_empty() {
        return Ok(InboxItemContextRsp::default());
    }
    rows.sort_by_key(|row| row.id);

    let allowed_groups =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, login)
            .await
            .c(h!())?;

    let sigint_inbox_item_ids =
        rows.iter().map(|row| row.id).collect::<Vec<_>>();
    let message = rows.first().and_then(|row| {
        accessible_messages
            .remove(&row.id)
            .map(|message| (row.id, message))
    });
    let group_master_keys = if allowed_groups.is_empty() {
        vec![]
    } else {
        load_inbox_item_context_group_keys(
            &env.dbx,
            &allowed_groups,
            &sigint_inbox_item_ids,
        )
        .await
        .context(h!())?
    };

    Ok(build_inbox_item_context_rsp(
        rows,
        message,
        group_master_keys,
        sigint_inbox_item_ids,
    ))
}

async fn load_inbox_item_context_rows(
    dbx: &DatabaseConnection,
    message_identifier: &str,
) -> Result<Vec<InboxItemContextRow>, AppError> {
    let mut query = SignalMessage::find()
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .select_only()
        .column_as(sigint_inbox_item::Column::Id, "id")
        .column_as(sigint_inbox_item::Column::Datetime, "datetime")
        .filter(signal_message::Column::Deleted.eq(false));

    if let Ok(id_uuid) = uuid::Uuid::parse_str(message_identifier) {
        query = query.filter(
            Condition::any()
                .add(signal_message::Column::IdUuid.eq(id_uuid))
                .add(signal_message::Column::MessageUid.eq(message_identifier)),
        );
    } else if let Ok(id) = message_identifier.parse::<i64>() {
        query = query.filter(signal_message::Column::Id.eq(id));
    } else {
        query = query
            .filter(signal_message::Column::MessageUid.eq(message_identifier));
    }

    Ok(query
        .into_model::<InboxItemContextRow>()
        .all(dbx)
        .await
        .c(h!())?)
}

async fn inbox_window_bl(
    env: &Env,
    login: &uuid::Uuid,
    logins: &Vec<uuid::Uuid>,
    is_admin: bool,
    message_ref: &str,
    inbox_req: InboxMessagesReq,
) -> Result<Option<InboxWindowRsp>, AppError> {
    let rows = load_inbox_item_context_rows(&env.dbx, message_ref)
        .await
        .context(h!())?;
    if rows.is_empty() {
        return Ok(None);
    }

    let inbox_req = inbox_window_base_req(inbox_req);
    let target_req = inbox_window_target_req(&inbox_req);
    let candidate_ids = rows.iter().map(|row| row.id).collect::<Vec<_>>();
    let target_query = build_inbox_query_for_candidate_ids(
        &env.dbx,
        login,
        env,
        &target_req,
        &candidate_ids,
        false,
    )
    .await
    .context(h!())?;
    let mut target_messages = fetch_inbox_messages_with_query(
        &env.dbx,
        login,
        logins,
        env,
        &target_req,
        &target_query,
    )
    .await
    .context(h!())?
    .into_iter()
    .filter(|(_, message)| {
        inbox_window_target_matches_context_filters(message, &target_req)
    })
    .collect::<HashMap<_, _>>();
    let Some(target_message_id) = rows
        .iter()
        .map(|row| row.id)
        .filter(|id| target_messages.contains_key(id))
        .min()
    else {
        return Ok(None);
    };
    let target_message = target_messages.remove(&target_message_id).c(h!())?;

    let before_req = inbox_window_page_req(&inbox_req, target_message_id, true);
    let after_req = inbox_window_page_req(&inbox_req, target_message_id, false);
    let (before_messages, after_messages, messages_before, messages_after) =
        tokio::try_join!(
            get_inbox_messages(login, logins, env, &before_req),
            get_inbox_messages(login, logins, env, &after_req),
            count_inbox_window_messages(env, login, &before_req),
            count_inbox_window_messages(env, login, &after_req),
        )
        .context(h!())?;
    let has_more_before = messages_before > before_messages.len() as i64;
    let has_more_after = messages_after > after_messages.len() as i64;
    let inbox_items = merge_inbox_window_messages(
        before_messages,
        (target_message_id, target_message),
        after_messages,
    );
    let callsigns = load_inbox_callsigns(&inbox_items, env).await.c(h!())?;
    let signal_profiles = load_inbox_signal_profiles(&inbox_items, &env.dbx)
        .await
        .c(h!())?;
    let signal_groups =
        load_inbox_signal_groups(&inbox_items, env, is_admin, true)
            .await
            .c(h!())?;

    Ok(Some(InboxWindowRsp {
        target_message_id,
        inbox: InboxMessagesRsp {
            inbox_items,
            poll_cursor_id: None,
            callsigns,
            signal_profiles,
            signal_groups,
            freq_pelengs_summary: None,
            page_limit: Some(INBOX_MESSAGES_PAGE_LIMIT as i64),
        },
        has_more_before,
        has_more_after,
        messages_before,
        messages_after,
    }))
}

async fn count_inbox_window_messages(
    env: &Env,
    login: &uuid::Uuid,
    req: &InboxMessagesReq,
) -> Result<i64, AppError> {
    let query = build_inbox_digest_query(login, env, req)
        .await
        .context(h!())?;
    let (count, _) = query_inbox_digest(env.dbx.clone(), query)
        .await
        .context(h!())?;
    Ok(count)
}

fn inbox_window_base_req(mut inbox_req: InboxMessagesReq) -> InboxMessagesReq {
    inbox_req.since_id_noninclusive = None;
    inbox_req.before_id_noninclusive = None;
    inbox_req.around_message_ref = None;
    inbox_req.since_date_inclusive_ms = None;
    inbox_req.till_date_inclusive_ms = None;
    inbox_req.nolimit = None;
    inbox_req.load_latest = None;
    inbox_req.calculate_freq_pelengs_summary = None;
    inbox_req.skip_group_stats = Some(true);
    inbox_req.page_id = Some("rer-analysis".to_string());
    inbox_req
}

fn inbox_window_target_req(inbox_req: &InboxMessagesReq) -> InboxMessagesReq {
    InboxMessagesReq {
        load_latest: Some(true),
        ..inbox_req.clone()
    }
}

fn inbox_window_target_matches_context_filters(
    message: &InboxMessage,
    req: &InboxMessagesReq,
) -> bool {
    inbox_window_target_matches_group(message, &req.selected_groups)
        && inbox_window_target_matches_frequency(message, &req.selected_freqs)
        && inbox_window_target_matches_network(
            message,
            &req.selected_networks,
            req.without_network.unwrap_or(false),
        )
}

fn inbox_window_target_matches_group(
    message: &InboxMessage,
    selected_groups: &Option<Vec<String>>,
) -> bool {
    selected_groups
        .as_ref()
        .filter(|groups| !groups.is_empty())
        .is_none_or(|groups| {
            message
                .group_master_key
                .as_ref()
                .is_some_and(|group| groups.contains(group))
        })
}

fn inbox_window_target_matches_frequency(
    message: &InboxMessage,
    selected_freqs: &Option<Vec<String>>,
) -> bool {
    selected_freqs
        .as_ref()
        .filter(|freqs| !freqs.is_empty())
        .is_none_or(|freqs| {
            freqs
                .iter()
                .any(|freq| message.freq.as_deref().unwrap_or_default() == freq)
        })
}

fn inbox_window_target_matches_network(
    message: &InboxMessage,
    selected_networks: &Option<Vec<i64>>,
    without_network: bool,
) -> bool {
    let selected_networks = selected_networks
        .as_ref()
        .filter(|networks| !networks.is_empty());
    if without_network {
        return selected_networks.is_none()
            && message.network_ids.as_ref().is_none_or(Vec::is_empty);
    }
    selected_networks.is_none_or(|selected_networks| {
        message.network_ids.as_ref().is_some_and(|network_ids| {
            network_ids
                .iter()
                .any(|network_id| selected_networks.contains(network_id))
        })
    })
}

fn inbox_window_page_req(
    inbox_req: &InboxMessagesReq,
    target_message_id: i64,
    before: bool,
) -> InboxMessagesReq {
    InboxMessagesReq {
        before_id_noninclusive: before.then_some(target_message_id),
        since_id_noninclusive: (!before).then_some(target_message_id),
        newest_first: Some(before),
        ..inbox_req.clone()
    }
}

fn merge_inbox_window_messages(
    mut before_messages: Vec<(i64, InboxMessage)>,
    target_message: (i64, InboxMessage),
    after_messages: Vec<(i64, InboxMessage)>,
) -> Vec<(i64, InboxMessage)> {
    before_messages.reverse();
    let mut seen = BTreeSet::new();
    before_messages
        .into_iter()
        .chain(std::iter::once(target_message))
        .chain(after_messages)
        .filter(|(id, _)| seen.insert(*id))
        .collect()
}

async fn load_inbox_item_context_group_keys(
    dbx: &DatabaseConnection,
    allowed_groups: &[String],
    sigint_inbox_item_ids: &[i64],
) -> Result<Vec<String>, AppError> {
    let original_group_order = Expr::cust(
        r#"case
            when "signal_message"."datasource_group_id" = "signal_message_group"."datasource_group_id"
              or "signal_message_group"."group_master_key" = (
                select "datasource_group"."group_master_key"
                from "datasource_group"
                where "datasource_group"."id" = "signal_message"."datasource_group_id"
              )
            then 0
            else 1
        end"#,
    );
    let rows = signal_message_group::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message_group::Relation::SignalMessage.def(),
        )
        .select_only()
        .column(signal_message_group::Column::GroupMasterKey)
        .filter(
            signal_message_group::Column::SignalMessageId
                .eq_any(sigint_inbox_item_ids.to_vec()),
        )
        .filter(
            signal_message_group::Column::GroupMasterKey
                .eq_any(allowed_groups.to_vec()),
        )
        .order_by(original_group_order, Order::Asc)
        .order_by_asc(signal_message_group::Column::SignalMessageId)
        .order_by_asc(signal_message_group::Column::Id)
        .into_model::<InboxItemContextGroupRow>()
        .all(dbx)
        .await
        .c(h!())?;

    let mut seen: BTreeSet<String> = BTreeSet::new();
    Ok(rows
        .into_iter()
        .filter_map(|row| row.group_master_key)
        .filter(|key| seen.insert(key.clone()))
        .collect())
}

fn build_inbox_item_context_rsp(
    rows: Vec<InboxItemContextRow>,
    message: Option<(i64, InboxMessage)>,
    group_master_keys: Vec<String>,
    sigint_inbox_item_ids: Vec<i64>,
) -> InboxItemContextRsp {
    let datetimes = rows
        .iter()
        .filter_map(|row| row.datetime.as_ref().copied())
        .collect::<Vec<_>>();
    let earliest = datetimes.iter().min();
    let latest = datetimes.iter().max();
    InboxItemContextRsp {
        message,
        group_master_keys,
        sigint_inbox_item_ids,
        since_ts: earliest.map(|ts| {
            (*ts - Duration::minutes(15)).and_utc().timestamp_millis()
        }),
        till_ts: latest.map(|ts| {
            (*ts + Duration::minutes(15)).and_utc().timestamp_millis()
        }),
    }
}

#[post("/api/rer-importer/messages-by-id")]
async fn messages_by_id(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<MessageIdsReq>,
) -> Result<Json<MessageIdsRsp>, AppError> {
    has_any_role(
        &env.dbx,
        &login_id_from_identity(&user)?,
        vec!["Rer", "ApiAgent"],
    )
    .await
    .c(h!())?;
    let login = login_id_from_identity(&user)?;
    let logins = crate::users::get_organism_login_ids(&env.dbx, user)
        .await
        .context(h!())?;

    let default_req = InboxMessagesReq {
        highlight_points: Some(true),
        ..Default::default()
    };
    let inbox_req = req.inbox_req.as_ref().unwrap_or(&default_req);
    let messages =
        messages_by_id_bl(&login, &logins, &env, &req.message_ids, inbox_req)
            .await?;
    Ok(Json(MessageIdsRsp { messages }))
}

#[post("/api/rer-importer/messages-by-id-with-metadata")]
async fn messages_by_id_with_metadata(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<MessageIdsReq>,
) -> Result<Json<InboxMessagesRsp>, AppError> {
    let login = login_id_from_identity(&user)?;
    has_any_role(&env.dbx, &login, vec!["Rer", "ApiAgent"])
        .await
        .c(h!())?;
    let is_admin = has_role(&env.dbx, &login, "Admin").await.is_ok();
    let logins = crate::users::get_organism_login_ids(&env.dbx, user)
        .await
        .context(h!())?;
    let req = req.into_inner();
    let default_req = InboxMessagesReq {
        highlight_points: Some(true),
        ..Default::default()
    };
    let inbox_req = req.inbox_req.as_ref().unwrap_or(&default_req);
    let messages =
        messages_by_id_bl(&login, &logins, &env, &req.message_ids, inbox_req)
            .await
            .context(h!())?;
    let callsigns = load_inbox_callsigns(&messages, &env).await.c(h!())?;
    let signal_profiles = load_inbox_signal_profiles(&messages, &env.dbx)
        .await
        .c(h!())?;
    let signal_groups = load_inbox_signal_groups(
        &messages,
        &env,
        is_admin,
        inbox_req.skip_group_stats.unwrap_or(false),
    )
    .await
    .c(h!())?;

    Ok(Json(InboxMessagesRsp {
        inbox_items: messages,
        poll_cursor_id: None,
        callsigns,
        signal_profiles,
        signal_groups,
        freq_pelengs_summary: None,
        page_limit: None,
    }))
}

#[post("/api/rer-importer/messages-by-uuid")]
async fn messages_by_uuid(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<MessageUuidsReq>,
) -> Result<Json<MessageIdsRsp>, AppError> {
    let req = req.into_inner();
    let login = login_id_from_identity(&user).c(h!())?;
    has_any_role(&env.dbx, &login, vec!["Rer", "ApiAgent"])
        .await
        .c(h!())?;
    let message_ids = signal_message::Entity::find()
        .select_only()
        .column(signal_message::Column::Id)
        .filter(signal_message::Column::IdUuid.eq_any(req.message_uuids))
        .into_tuple::<i64>()
        .all(&env.dbx)
        .await
        .c(h!())?;
    let logins = crate::users::get_organism_login_ids(&env.dbx, user)
        .await
        .context(h!())?;
    let default_req = InboxMessagesReq {
        highlight_points: Some(true),
        ..Default::default()
    };
    let inbox_req = req.inbox_req.as_ref().unwrap_or(&default_req);
    let messages =
        messages_by_id_bl(&login, &logins, &env, &message_ids, inbox_req)
            .await
            .c(h!())?;
    Ok(Json(MessageIdsRsp { messages }))
}

pub(crate) async fn messages_by_id_bl(
    login: &uuid::Uuid,
    logins: &Vec<uuid::Uuid>,
    env: &Env,
    message_ids: &[i64],
    req: &InboxMessagesReq,
) -> Result<Vec<(i64, InboxMessage)>, AppError> {
    let sigint_groups =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, login)
            .await
            .c(h!())?;
    let owner_sender_ids = logins
        .iter()
        .chain(std::iter::once(login))
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let parent_group_access_query = Query::select()
        .expr(Expr::value(1))
        .from(signal_message_group::Entity)
        .and_where(
            Expr::col((
                signal_message_group::Entity,
                signal_message_group::Column::SignalMessageId,
            ))
            .equals((
                intel_product::Entity,
                intel_product::Column::SourceMessageId,
            )),
        )
        .and_where(
            signal_message_group::Column::GroupMasterKey
                .is_in(sigint_groups.clone()),
        )
        .to_owned();
    let parent_datasource_group_access_query = Query::select()
        .expr(Expr::value(1))
        .from(signal_message::Entity)
        .inner_join(
            datasource_group::Entity,
            Expr::col((
                signal_message::Entity,
                signal_message::Column::DatasourceGroupId,
            ))
            .equals((datasource_group::Entity, datasource_group::Column::Id)),
        )
        .and_where(
            Expr::col((signal_message::Entity, signal_message::Column::Id))
                .equals((
                    intel_product::Entity,
                    intel_product::Column::SourceMessageId,
                )),
        )
        .and_where(
            datasource_group::Column::GroupMasterKey
                .is_in(sigint_groups.clone()),
        )
        .to_owned();
    let parent_owner_access_query = Query::select()
        .expr(Expr::value(1))
        .from(signal_message::Entity)
        .and_where(
            Expr::col((signal_message::Entity, signal_message::Column::Id))
                .equals((
                    intel_product::Entity,
                    intel_product::Column::SourceMessageId,
                )),
        )
        .and_where(signal_message::Column::DatasourceGroupId.is_null())
        .and_where(
            preferred_message_author_expr(None).is_in(owner_sender_ids.clone()),
        )
        .and_where(
            Expr::exists(
                Query::select()
                    .expr(Expr::value(1))
                    .from(signal_message_group::Entity)
                    .and_where(
                        Expr::col((
                            signal_message_group::Entity,
                            signal_message_group::Column::SignalMessageId,
                        ))
                        .equals((
                            signal_message::Entity,
                            signal_message::Column::Id,
                        )),
                    )
                    .to_owned(),
            )
            .not(),
        )
        .to_owned();
    let parent_access_query = Query::select()
        .expr(Expr::value(1))
        .from(intel_product::Entity)
        .and_where(intel_product::relation_kind_is_in([
            intel_product::RELATION_KIND_REPORT,
            intel_product::RELATION_KIND_COMMENT,
        ]))
        .and_where(
            Expr::col((
                intel_product::Entity,
                intel_product::Column::IntelMessageId,
            ))
            .equals((signal_message::Entity, signal_message::Column::Id)),
        )
        .and_where(
            Condition::any()
                .add(Expr::exists(parent_group_access_query))
                .add(Expr::exists(parent_datasource_group_access_query))
                .add(Expr::exists(parent_owner_access_query))
                .into(),
        )
        .to_owned();
    let owner_access_query = Query::select()
        .expr(Expr::value(1))
        .from(signal_message_group::Entity)
        .and_where(
            Expr::col((
                signal_message_group::Entity,
                signal_message_group::Column::SignalMessageId,
            ))
            .equals((signal_message::Entity, signal_message::Column::Id)),
        )
        .to_owned();
    let owner_access = Condition::all()
        .add(datasource_group::Column::GroupMasterKey.is_null())
        .add(Expr::exists(owner_access_query).not())
        .add(preferred_message_author_expr(None).is_in(owner_sender_ids));
    let signal_message_group_access_query =
        signal_message_group::Entity::find()
            .filter(
                Expr::col((
                    signal_message_group::Entity,
                    signal_message_group::Column::SignalMessageId,
                ))
                .equals((signal_message::Entity, signal_message::Column::Id)),
            )
            .filter(
                signal_message_group::Column::GroupMasterKey
                    .eq_any(sigint_groups.clone()),
            )
            .select_only()
            .column(signal_message_group::Column::Id)
            .into_query();
    let mut messages = SignalMessage::find()
        .join(
            JoinType::LeftJoin,
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
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::DeviceName.def(),
        );

    messages = add_inbox_message_columns(messages);

    messages = messages
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(
            Condition::any()
                .add(
                    datasource_group::Column::GroupMasterKey
                        .eq_any(sigint_groups),
                )
                .add(Expr::exists(signal_message_group_access_query))
                .add(Expr::exists(parent_access_query))
                .add(owner_access),
        )
        .filter(signal_message::Column::Id.eq_any(message_ids.to_vec()));
    let owner_organism_id =
        crate::tags::query::current_user_organism_id(&env.dbx, login)
            .await
            .c(h!())?;

    let query_tags = sigint_inbox_item_tag::Entity::find()
        .select_only()
        .join(JoinType::InnerJoin, sigint_inbox_item_tag::Relation::Tag.def())
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
    let messages =
        aggregate_to_inbox_messages(login, messages, logins, &req, &env)
            .await
            .context(h!())?;
    Ok(messages)
}

#[derive(Serialize)]
struct InboxMessagesApiRsp {
    #[serde(flatten)]
    inbox: InboxMessagesRsp,
    #[serde(skip_serializing_if = "Option::is_none")]
    around_message_messages_before: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    around_message_messages_after: Option<i64>,
}

impl InboxMessagesApiRsp {
    fn regular(inbox: InboxMessagesRsp) -> Self {
        Self {
            inbox,
            around_message_messages_before: None,
            around_message_messages_after: None,
        }
    }
}

#[post("/api/rer-importer/get-inbox")]
async fn inbox_messages(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<InboxMessagesReq>,
) -> Result<Json<InboxMessagesApiRsp>, AppError> {
    let user_id = login_id_from_identity(&user)?;
    has_any_role(&env.dbx, &user_id, vec!["Rer", "ApiAgent"])
        .await
        .c(h!())?;
    let is_admin = has_role(&env.dbx, &user_id, "Admin").await.is_ok();
    let page_id = req.page_id.clone();
    let req = req.into_inner();
    if has_role(&env.dbx, &user_id, AI_AGENT_ROLE_API)
        .await
        .is_ok()
    {
        validate_agent_inbox_request(&req)?;
    }
    let skip_group_stats = req.skip_group_stats.unwrap_or(false);

    let payload = serde_json::to_value(&req).context(h!())?;
    record_page_visit(&user_id, &page_id, &env, Some(payload))
        .await
        .context(h!())?;
    let login = user_id;
    let logins = crate::users::get_organism_login_ids(&env.dbx, user)
        .await
        .context(h!())?;
    if let Some(message_ref) = around_message_ref(&req) {
        let window =
            inbox_window_bl(&env, &login, &logins, is_admin, &message_ref, req)
                .await
                .context(h!())?;
        let response = match window {
            Some(window) => InboxMessagesApiRsp {
                inbox: window.inbox,
                around_message_messages_before: Some(window.messages_before),
                around_message_messages_after: Some(window.messages_after),
            },
            None => {
                InboxMessagesApiRsp::regular(empty_inbox_messages_rsp(Some(20)))
            }
        };
        return Ok(Json(response));
    }
    if inbox_request_is_unbounded(&req) && req.load_latest != Some(true) {
        error!(
            "rejecting unbounded get-inbox request without load_latest; page_id={page_id:?}"
        );
        let page_limit = (req.nolimit != Some(true)).then_some(20);
        return Ok(Json(InboxMessagesApiRsp::regular(
            empty_inbox_messages_rsp(page_limit),
        )));
    }
    let poll_cursor_id = if inbox_request_is_unbounded_latest(&req) {
        latest_inbox_poll_cursor_id(&env.dbx, &req).await?
    } else {
        None
    };
    let inbox_items = get_inbox_messages_with_analytics_candidates(
        &login, &logins, &env, &req,
    )
    .await
    .map_err(|error| map_postgres_runtime_timeout(error, "inbox messages"))
    .context(h!())?;
    let txn = env.dbx.begin().await.context(h!())?;
    let callsigns: Vec<CallsignInfoRes> =
        load_inbox_callsigns(&inbox_items, &env).await.c(h!())?;
    let signal_profiles = load_inbox_signal_profiles(&inbox_items, &env.dbx)
        .await
        .c(h!())?;
    let signal_groups = load_inbox_signal_groups(
        &inbox_items,
        &env,
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
    let page_limit = if req.nolimit == Some(true) {
        None
    } else {
        Some(20)
    };

    Ok(Json(InboxMessagesApiRsp::regular(InboxMessagesRsp {
        inbox_items,
        poll_cursor_id,
        callsigns,
        signal_profiles,
        signal_groups,
        freq_pelengs_summary,
        page_limit,
    })))
}

fn around_message_ref(req: &InboxMessagesReq) -> Option<String> {
    normalized_optional_string(req.around_message_ref.as_deref())
}

fn empty_inbox_messages_rsp(page_limit: Option<i64>) -> InboxMessagesRsp {
    InboxMessagesRsp {
        inbox_items: vec![],
        poll_cursor_id: None,
        callsigns: vec![],
        signal_profiles: BTreeMap::new(),
        signal_groups: vec![],
        freq_pelengs_summary: None,
        page_limit,
    }
}

async fn rer_duty_neo_adaptive_lower_bound(
    login: &uuid::Uuid,
    env: &Env,
    req: &InboxMessagesReq,
) -> Option<NaiveDateTime> {
    if !rer_duty_neo_adaptive_cutoff_is_eligible(req) {
        return None;
    }
    let now = Utc::now().naive_utc();
    if inbox_request_has_unit_filters(req) {
        return Some(log_rer_duty_neo_fallback_cutoff(now, "unit_filter"));
    }
    let accessible_groups =
        match crate::messenger::group::get_identity_sigint_groups(
            &env.dbx, login,
        )
        .await
        {
            Ok(groups) => groups,
            Err(_error) => {
                warn!(
                    target: "rer_duty_neo_adaptive_cutoff",
                    "rer_duty_neo_adaptive_cutoff_access_failed page_id=rer-duty-neo access_failed=true"
                );
                return Some(log_rer_duty_neo_fallback_cutoff(
                    now,
                    "access_failure",
                ));
            }
        };
    let effective_groups =
        effective_inbox_groups(&req.selected_groups, &accessible_groups);
    let (stats_since, stats_till) = match rer_duty_neo_stats_window(now) {
        Ok(window) => window,
        Err(_error) => {
            warn!(
                target: "rer_duty_neo_adaptive_cutoff",
                "rer_duty_neo_adaptive_cutoff_stats_window_failed page_id=rer-duty-neo stats_window_failed=true"
            );
            return Some(log_rer_duty_neo_fallback_cutoff(
                now,
                "stats_window_failure",
            ));
        }
    };
    let traffic = crate::stats::read_total_stats_aggregated_for_env(
        env,
        effective_groups.clone(),
        stats_since,
        stats_till,
    )
    .await;
    rer_duty_neo_adaptive_cutoff_from_stats(
        traffic,
        now,
        effective_groups.len(),
    )
}

fn rer_duty_neo_stats_window(
    now: NaiveDateTime,
) -> anyhow::Result<(NaiveDateTime, NaiveDateTime)> {
    let till = crate::stats::round_to_5min(now)?;
    Ok((
        till - Duration::hours(
            RER_DUTY_NEO_ADAPTIVE_CUTOFF_TRAFFIC_LOOKBACK_HOURS,
        ),
        till,
    ))
}

fn rer_duty_neo_adaptive_cutoff_is_eligible(req: &InboxMessagesReq) -> bool {
    req.page_id.as_deref() == Some(RER_DUTY_NEO_PAGE_ID)
        && inbox_request_is_unbounded(req)
        && req.load_latest == Some(true)
}

fn inbox_request_has_unit_filters(req: &InboxMessagesReq) -> bool {
    req.selected_units
        .as_ref()
        .is_some_and(|units| !units.is_empty())
        || req
            .denied_units
            .as_ref()
            .is_some_and(|units| !units.is_empty())
}

fn effective_inbox_groups(
    selected_groups: &Option<Vec<String>>,
    accessible_groups: &[String],
) -> Vec<String> {
    let selected_groups = selected_groups
        .as_ref()
        .filter(|groups| !groups.is_empty())
        .map(|groups| groups.iter().collect::<BTreeSet<_>>());
    let effective_groups = selected_groups.map(|selected_groups| {
        accessible_groups
            .iter()
            .filter(|group| selected_groups.contains(group))
            .cloned()
            .collect::<Vec<_>>()
    });
    effective_groups
        .filter(|groups| !groups.is_empty())
        .unwrap_or_else(|| accessible_groups.to_vec())
}

fn rer_duty_neo_adaptive_cutoff_from_stats(
    traffic: anyhow::Result<i64>,
    now: NaiveDateTime,
    effective_group_count: usize,
) -> Option<NaiveDateTime> {
    let traffic = match traffic {
        Ok(traffic) => traffic,
        Err(_error) => {
            warn!(
                target: "rer_duty_neo_adaptive_cutoff",
                "rer_duty_neo_adaptive_cutoff_stats_failed page_id=rer-duty-neo stats_failed=true"
            );
            return Some(log_rer_duty_neo_fallback_cutoff(
                now,
                "stats_failure",
            ));
        }
    };
    if traffic <= RER_DUTY_NEO_ADAPTIVE_CUTOFF_TRAFFIC_THRESHOLD {
        return None;
    }
    let cutoff = now - Duration::days(RER_DUTY_NEO_ADAPTIVE_CUTOFF_DAYS);
    warn!(
        target: "rer_duty_neo_adaptive_cutoff",
        "rer_duty_neo_adaptive_cutoff_applied page_id=rer-duty-neo three_day_count={} cutoff_timestamp={} effective_group_count={}",
        traffic,
        cutoff,
        effective_group_count
    );
    Some(cutoff)
}

fn log_rer_duty_neo_fallback_cutoff(
    now: NaiveDateTime,
    reason: &str,
) -> NaiveDateTime {
    let cutoff = now - Duration::days(RER_DUTY_NEO_ADAPTIVE_CUTOFF_DAYS);
    warn!(
        target: "rer_duty_neo_adaptive_cutoff",
        "rer_duty_neo_adaptive_cutoff_applied page_id=rer-duty-neo reason={} cutoff_timestamp={}",
        reason,
        cutoff,
    );
    cutoff
}

fn validate_agent_inbox_request(
    req: &InboxMessagesReq,
) -> Result<(), AppError> {
    let (Some(since_ms), Some(till_ms)) =
        (req.since_date_inclusive_ms, req.till_date_inclusive_ms)
    else {
        return Err(AppError::BL {
            msg: "AI agent inbox requests require both date boundaries"
                .to_string(),
        });
    };
    if since_ms > till_ms {
        return Err(AppError::BL {
            msg: "AI agent inbox date boundaries are reversed".to_string(),
        });
    }
    let since_date = DateTime::from_timestamp_millis(since_ms)
        .context(h!())?
        .with_timezone(&Kyiv)
        .date_naive();
    let till_date = DateTime::from_timestamp_millis(till_ms)
        .context(h!())?
        .with_timezone(&Kyiv)
        .date_naive();
    if (till_date - since_date).num_days() >= AI_AGENT_INBOX_MAX_DAYS {
        return Err(AppError::BL {
            msg: format!(
                "AI agent inbox period cannot exceed {AI_AGENT_INBOX_MAX_DAYS} days"
            ),
        });
    }
    if req.nolimit.is_some() || req.load_latest.is_some() {
        return Err(AppError::BL {
            msg: "AI agent inbox requests must use standard pagination"
                .to_string(),
        });
    }
    Ok(())
}

#[post("/api/rer-importer/get-inbox-group-stats")]
async fn inbox_group_stats(
    user: Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<InboxByGroupDigestRsp>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
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
    let stats = crate::stats::get_last_hour_stats(&env, batch_ids)
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

async fn query_inbox_digest(
    db: DatabaseConnection,
    query: String,
) -> Result<InboxDigest, AppError> {
    let query_res = db
        .query_one_raw(Statement::from_string(DatabaseBackend::Postgres, query))
        .await
        .c(h!())?
        .context(h!())?;
    let first_element_ts =
        query_res.try_get("", "first_element_ts").or_else(|_| {
            query_res
                .try_get::<Option<DateTime<Utc>>>("", "first_element_ts")
                .map(|timestamp| {
                    timestamp.map(|timestamp| timestamp.naive_utc())
                })
        })?;
    Ok((query_res.try_get("", "count")?, first_element_ts))
}

async fn query_inbox_digest_singleflight<F, Fut>(
    key: String,
    query: F,
) -> Result<InboxDigest, AppError>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<InboxDigest, AppError>>,
{
    let now = Instant::now();
    let gate = {
        let mut entries = INBOX_COUNT_SINGLEFLIGHT.lock().await;
        entries.retain(|_, entry| {
            let age = now.duration_since(entry.last_used);
            entry.cached.as_ref().is_some_and(|(completed_at, _)| {
                now.duration_since(*completed_at).as_millis()
                    <= u128::from(INBOX_COUNT_SINGLEFLIGHT_SUCCESS_TTL_MS)
            }) || age.as_secs() <= INBOX_COUNT_SINGLEFLIGHT_STALE_SECS
                || entry.gate.try_lock().is_err()
        });
        let has_capacity =
            if entries.len() >= INBOX_COUNT_SINGLEFLIGHT_MAX_ENTRIES {
                if let Some(oldest_key) = entries
                    .iter()
                    .filter(|(_, entry)| entry.cached.is_some())
                    .min_by_key(|(_, entry)| entry.last_used)
                    .map(|(key, _)| key.clone())
                {
                    entries.remove(&oldest_key);
                    true
                } else {
                    false
                }
            } else {
                true
            };
        has_capacity.then(|| {
            let entry = entries.entry(key.clone()).or_insert_with(|| {
                InboxCountSingleflightEntry {
                    gate: Arc::new(Mutex::new(())),
                    cached: None,
                    last_used: now,
                }
            });
            entry.last_used = now;
            entry.gate.clone()
        })
    };
    let Some(gate) = gate else {
        return query().await;
    };

    let _permit = gate.lock().await;
    let now = Instant::now();
    let (attached, cached) = {
        let mut entries = INBOX_COUNT_SINGLEFLIGHT.lock().await;
        if let Some(entry) = entries
            .get_mut(&key)
            .filter(|entry| Arc::ptr_eq(&entry.gate, &gate))
        {
            entry.last_used = now;
            let cached =
                entry.cached.as_ref().and_then(|(completed_at, result)| {
                    (now.duration_since(*completed_at).as_millis()
                        <= u128::from(INBOX_COUNT_SINGLEFLIGHT_SUCCESS_TTL_MS))
                    .then_some(*result)
                });
            (true, cached)
        } else {
            (false, None)
        }
    };
    if let Some(cached) = cached {
        return Ok(cached);
    }
    if !attached {
        return query().await;
    }

    let result = query().await;
    let mut entries = INBOX_COUNT_SINGLEFLIGHT.lock().await;
    let remove = if let Some(entry) = entries
        .get_mut(&key)
        .filter(|entry| Arc::ptr_eq(&entry.gate, &gate))
    {
        entry.last_used = Instant::now();
        match &result {
            Ok(result) => {
                entry.cached = Some((Instant::now(), *result));
                false
            }
            Err(_) => true,
        }
    } else {
        false
    };
    if remove {
        entries.remove(&key);
    }
    result
}

fn inbox_request_is_for_rer_duty(req: &InboxMessagesReq) -> bool {
    matches!(
        req.page_id.as_deref(),
        Some(RER_DUTY_PAGE_ID | RER_DUTY_NEO_PAGE_ID)
    )
}

fn duty_inbox_request_uses_source_postgres_for_cursor_created_at(
    req: &InboxMessagesReq,
    cursor_created_at: &HashMap<i64, NaiveDateTime>,
    now: NaiveDateTime,
) -> bool {
    if !inbox_request_is_for_rer_duty(req) {
        return false;
    }
    if inbox_request_is_unbounded_latest(req) {
        return true;
    }
    let cutoff = now - Duration::hours(RER_DUTY_POSTGRES_FRESH_CURSOR_HOURS);
    if [req.since_date_inclusive_ms, req.till_date_inclusive_ms]
        .into_iter()
        .flatten()
        .any(|millis| {
            dt_from_millis(millis).map_or(true, |datetime| datetime >= cutoff)
        })
    {
        return true;
    }
    [req.since_id_noninclusive, req.before_id_noninclusive]
        .into_iter()
        .flatten()
        .any(|id| {
            cursor_created_at
                .get(&id)
                .is_none_or(|created_at| *created_at >= cutoff)
        })
}

async fn duty_inbox_request_uses_source_postgres(
    source_db: &DatabaseConnection,
    req: &InboxMessagesReq,
) -> bool {
    if !inbox_request_is_for_rer_duty(req) {
        return false;
    }
    let cursor_ids = [req.since_id_noninclusive, req.before_id_noninclusive]
        .into_iter()
        .flatten()
        .unique()
        .collect::<Vec<_>>();
    let cursor_created_at = if cursor_ids.is_empty() {
        HashMap::new()
    } else {
        match SignalMessage::find()
            .select_only()
            .columns([
                signal_message::Column::Id,
                signal_message::Column::CreatedAt,
            ])
            .filter(signal_message::Column::Id.is_in(cursor_ids))
            .into_tuple::<(i64, NaiveDateTime)>()
            .all(source_db)
            .await
        {
            Ok(cursor_created_at) => cursor_created_at.into_iter().collect(),
            Err(error) => {
                warn!(
                    "failed to resolve Duty inbox cursor freshness; using source PostgreSQL: {error:?}"
                );
                return true;
            }
        }
    };
    duty_inbox_request_uses_source_postgres_for_cursor_created_at(
        req,
        &cursor_created_at,
        Utc::now().naive_utc(),
    )
}

async fn query_inbox_digest_with_analytics(
    login: uuid::Uuid,
    env: actix_web::web::Data<Env>,
    req: InboxMessagesReq,
    duty_uses_source_postgres: bool,
    postgres_query: String,
) -> Result<InboxDigest, AppError> {
    if duty_uses_source_postgres {
        return query_inbox_digest(env.dbx.clone(), postgres_query).await;
    }
    if rer_duty_fresh_tail_request_supported(&req) {
        return Ok(query_rer_duty_inbox_digest_with_fresh_tail(
            login,
            env,
            req,
            postgres_query,
        )
        .await
        .context(h!())?);
    }
    let analytics_lag_fallback_q = postgres_query.clone();
    let analytics_env = env.clone();
    let analytics_req = req.clone();
    let freshness_max_age_ms = env
        .config
        .analytics
        .as_ref()
        .map(AnalyticsConfig::freshness_max_age_ms)
        .unwrap_or(ANALYTICS_FRESHNESS_MAX_AGE_MS_DEFAULT);
    Ok(with_analytics_read_fallback(
        env.get_ref(),
        "inbox messages count",
        analytics_inbox_request_supported(&req),
        |db| async move {
            let query = build_analytics_inbox_digest_query(
                &login,
                &analytics_env,
                &analytics_req,
                &db,
                freshness_max_age_ms,
            )
            .await?;
            match query {
                Some(query) => query_inbox_digest(db, query).await,
                None => {
                    debug!(
                        "inbox messages count cursor is newer than analytics; using PostgreSQL"
                    );
                    query_inbox_digest(
                        analytics_env.replica(),
                        analytics_lag_fallback_q,
                    )
                    .await
                }
            }
        },
        |db| query_inbox_digest(db, postgres_query),
    )
    .await
    .context(h!())?)
}

async fn query_rer_duty_inbox_digest_with_fresh_tail(
    login: uuid::Uuid,
    env: actix_web::web::Data<Env>,
    req: InboxMessagesReq,
    postgres_query: String,
) -> Result<InboxDigest, AppError> {
    let freshness_max_age_ms = analytics_freshness_max_age_ms(&env);
    let fresh_tail_lower_bound = analytics_fresh_tail_lower_bound(
        Utc::now().naive_utc(),
        freshness_max_age_ms,
        RER_DUTY_ANALYTICS_FRESH_TAIL_MINUTES,
    );
    let postgres_tail_query = build_postgres_fresh_tail_inbox_digest_query(
        &login,
        &env,
        &req,
        fresh_tail_lower_bound,
    )
    .await
    .context(h!())?;
    let analytics_env = env.clone();
    let analytics_req = req.clone();
    let postgres_tail_db = env.dbx.clone();
    let postgres_fallback_db = env.dbx.clone();
    Ok(with_analytics_read_fallback(
        env.get_ref(),
        "rer duty inbox messages count",
        true,
        |db| async move {
            let postgres_tail = query_inbox_digest(
                postgres_tail_db,
                postgres_tail_query,
            )
            .await
            .context(h!())?;
            let Some(query) =
                build_historical_analytics_inbox_digest_query(
                    &login,
                    &analytics_env,
                    &analytics_req,
                    &db,
                    freshness_max_age_ms,
                    fresh_tail_lower_bound,
                )
                .await
                .context(h!())?
            else {
                debug!(
                    "rer duty inbox messages count cursor is newer than analytics; using PostgreSQL fresh tail"
                );
                return Ok(postgres_tail);
            };
            let historical =
                query_inbox_digest(db, query).await.context(h!())?;
            merge_inbox_digests(historical, postgres_tail)
        },
        |_db| query_inbox_digest(postgres_fallback_db, postgres_query),
    )
    .await
    .context(h!())?)
}

fn merge_inbox_digests(
    historical: InboxDigest,
    fresh_tail: InboxDigest,
) -> Result<InboxDigest, AppError> {
    let count = historical.0.checked_add(fresh_tail.0).context(h!())?;
    let first_element_ts = match (historical.1, fresh_tail.1) {
        (Some(historical), Some(fresh_tail)) => {
            Some(std::cmp::min(historical, fresh_tail))
        }
        (Some(first_element_ts), None) | (None, Some(first_element_ts)) => {
            Some(first_element_ts)
        }
        (None, None) => None,
    };
    Ok((count, first_element_ts))
}

#[post("/api/rer-importer/get-inbox-count")]
async fn inbox_messages_count(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<InboxMessagesReq>,
) -> Result<Json<InboxMessagesDigestRsp>, AppError> {
    has_any_role(
        &env.dbx,
        &login_id_from_identity(&user)?,
        vec!["Rer", "ApiAgent"],
    )
    .await
    .c(h!())?;
    let user_id = login_id_from_identity(&user)?;
    let page_id = req.page_id.clone();
    let req = req.into_inner();

    let payload = serde_json::to_value(&req).context(h!())?;
    record_page_visit(&user_id, &page_id, &env, Some(payload))
        .await
        .context(h!())?;
    let login = user_id;

    if inbox_request_is_unbounded(&req) {
        warn!(
            "rejecting unbounded get-inbox-count request; page_id={page_id:?}"
        );
        return Ok(Json(InboxMessagesDigestRsp {
            quantity: 0,
            first_element_ts: None,
        }));
    }
    let duty_uses_source_postgres = env.analytics.is_none()
        && duty_inbox_request_uses_source_postgres(&env.dbx, &req).await;
    let q = if duty_uses_source_postgres {
        build_correlated_inbox_digest_query(&login, &env, &req)
            .await
            .context(h!())?
    } else {
        build_inbox_digest_query(&login, &env, &req)
            .await
            .context(h!())?
    };
    let singleflight_key = format!("{:p}\n{q}", env.get_ref());
    let query_env = env.clone();
    let query_req = req.clone();
    let (quantity, first_element_ts) =
        query_inbox_digest_singleflight(singleflight_key, move || {
            query_inbox_digest_with_analytics(
                login,
                query_env,
                query_req,
                duty_uses_source_postgres,
                q,
            )
        })
        .await
        .context(h!())?;
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
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let txn = env.dbx.begin().await.context(h!())?;
    let intelligence_report_parent_ids = intel_product::Entity::find()
        .filter(intel_product::Column::IntelMessageId.eq(req.id))
        .filter(intel_product::relation_kind_eq(
            intel_product::RELATION_KIND_REPORT,
        ))
        .select_only()
        .column(intel_product::Column::SourceMessageId)
        .into_tuple::<i64>()
        .all(&txn)
        .await
        .c(h!())?;
    let is_intelligence_report = !intelligence_report_parent_ids.is_empty();
    soft_delete_message(&txn, req.id).await.context(h!())?;
    txn.commit().await.c(h!())?;
    if is_intelligence_report {
        let mut redis = env.redis.clone();
        let mut changed_message_ids = intelligence_report_parent_ids;
        if !changed_message_ids.contains(&req.id) {
            changed_message_ids.push(req.id);
        }
        if let Err(error) = crate::inbox::fanout_intelligence_report_changes(
            &mut redis,
            changed_message_ids,
        )
        .await
        {
            error!("failed to fan out intelligence report deletion: {error:?}");
        }
    } else {
        fanout_inbox_changed(&env, vec![req.id]).await;
    }
    Ok(Json(()))
}

async fn soft_delete_message<C>(
    txn: &C,
    message_id: i64,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    let signal_message = signal_message::Entity::find_by_id(message_id)
        .filter(signal_message::Column::Deleted.eq(false))
        .one(txn)
        .await
        .context(h!())?
        .ok_or(AppError::NotFound)
        .context(h!())?;
    prepare_message_network_activity_change(
        txn,
        message_id,
        &format!("deleted inbox message {message_id}"),
    )
    .await
    .context(h!())?;

    let mut signal_message = signal_message.into_active_model();
    signal_message.deleted = Set(true);
    signal_message.update(txn).await.context(h!())?;
    Ok(())
}

pub(crate) async fn invalidate_message_network_frequency_last_seen<C>(
    txn: &C,
    message_id: i64,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    invalidate_messages_network_frequency_last_seen(txn, &[message_id]).await
}

pub(crate) async fn prepare_message_network_activity_change<C>(
    txn: &C,
    message_id: i64,
    reason: &str,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    prepare_messages_network_activity_change(txn, &[message_id], reason).await
}

pub(crate) async fn prepare_messages_network_activity_change<C>(
    txn: &C,
    message_ids: &[i64],
    reason: &str,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    crate::stats::enqueue_group_stats_recalculation_for_messages(
        txn,
        message_ids,
        reason,
    )
    .await
    .c(h!())?;
    invalidate_messages_network_frequency_last_seen(txn, message_ids).await
}

pub(crate) async fn invalidate_messages_network_frequency_last_seen<C>(
    txn: &C,
    message_ids: &[i64],
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    if message_ids.is_empty() {
        return Ok(());
    }
    let affected = txn
        .query_all_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
            update sigint_network_freq as network_freq
            set last_seen_dt = null
            from sigint_inbox_item as inbox_item
            join signal_message
              on signal_message.id = inbox_item.id
            join sigint_inbox_item_network as network_link
              on network_link.sigint_inbox_item_id = inbox_item.id
            where signal_message.id = any($1::bigint[])
              and network_freq.network_id = network_link.sigint_network_id
              and network_freq.freq = inbox_item.freq
              and network_freq.deleted = false
              and network_freq.last_seen_dt = coalesce(
                  inbox_item.datetime,
                  signal_message.timestamp,
                  signal_message.created_at
              )
            returning network_freq.id
        "#,
            [message_ids.to_vec().into()],
        ))
        .await
        .c(h!())?;
    let network_freq_ids = affected
        .iter()
        .map(|row| row.try_get("", "id").c(h!()))
        .collect::<anyhow::Result<Vec<i64>>>()
        .c(h!())?;
    crate::sigint::network::recalculation::enqueue_last_seen_for_freq_ids(
        txn,
        network_freq_ids,
    )
    .await
    .c(h!())?;
    Ok(())
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

fn validate_generic_submit_item(
    item: &InboxSubmitItem,
) -> Result<(), AppError> {
    if item
        .group_names
        .as_ref()
        .is_none_or(|groups| groups.iter().all(|group| group.trim().is_empty()))
    {
        return Err(AppError::BL {
            msg: "Inbox submit requires at least one group name".to_string(),
        });
    }
    if normalized_optional_string(item.full_body.as_deref()).is_none()
        && normalized_optional_string(item.text.as_deref()).is_none()
    {
        return Err(AppError::Form(BTreeMap::from([(
            "text".to_string(),
            "Inbox submit requires message text".to_string(),
        )])));
    }
    validate_submit_item_content(item)
}

fn validate_submit_item_content(
    item: &InboxSubmitItem,
) -> Result<(), AppError> {
    validate_submit_network(item.network.as_ref())?;
    validate_submit_dmr_signal_names(&item.dmr)?;
    validate_submit_dmr_timestamps(&item.dmr)?;
    Ok(())
}

fn generic_submit_item_to_inbox_message(
    item: &InboxSubmitItem,
    allow_empty_content: bool,
) -> Result<(InboxMessage, NaiveDateTime), AppError> {
    let timestamp =
        parse_submit_rfc3339_timestamp("timestamp", &item.timestamp)?;
    let (date, time) = format_submit_date_time_fields(timestamp);
    let full_body = normalized_optional_string(item.full_body.as_deref())
        .or_else(|| normalized_optional_string(item.text.as_deref()))
        .or_else(|| allow_empty_content.then(String::new))
        .c(h!())?;
    let no_headers_body =
        normalized_optional_string(item.text.as_deref()).map(|body| {
            crate::rer_importer::body_noheader::NoHeadersBody {
                end: body.len(),
                body,
                start: 0,
            }
        });
    let message = InboxMessage {
        parent_messages: vec![],
        intelligence_reports: vec![],
        message_uuid: None,
        message_uid: None,
        text: full_body,
        media: vec![],
        images: vec![],
        image_recognized: vec![],
        date: Some(date),
        time: Some(time),
        freq: item.freq.clone(),
        coords: format_geo_coordinates(&item.coords),
        coords_with_locality: vec![],
        callsigns: submit_item_callsigns(item),
        callsigns_alg2: vec![],
        checked: true,
        important: false,
        bookmarked: false,
        timestamp: Some(timestamp.and_utc().timestamp_millis()),
        group_master_key: None,
        sender: item.sender.clone(),
        extended_form: item.comment.clone(),
        message_comments: vec![],
        post: item.post.clone(),
        post_id: None,
        unit: item.unit.clone(),
        unit_ids: vec![],
        callsign_tokens: None,
        signal_tokens: None,
        point_tokens: None,
        no_headers_body,
        keyword_tokens: None,
        text_marked: None,
        datasource_id: None,
        location: format_submit_locations(&item.locations),
        tags: None,
        network_ids: None,
        network_name: None,
        device_name: None,
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
    let dmr_callsigns = item
        .dmr
        .iter()
        .flat_map(|metadata| {
            metadata::metadata_text_callsigns(
                metadata.sender_name.as_deref(),
                metadata.call_group_name.as_deref(),
            )
        })
        .collect::<Vec<_>>();

    metadata::dedupe_text_callsigns_case_insensitive(
        item.from_callsign
            .iter()
            .chain(item.to.iter())
            .filter_map(|callsign| normalized_optional_string(Some(callsign)))
            .chain(dmr_callsigns),
    )
}

async fn add_submit_tags(
    txn: &DatabaseTransaction,
    inbox_id: i64,
    inbox_item_uuid: Option<uuid::Uuid>,
    login: &uuid::Uuid,
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
            .filter(sigint_inbox_item_tag::Column::LoginId.eq(Some(*login)))
            .filter(sigint_inbox_item_tag::Column::Model.is_null())
            .one(txn)
            .await
            .c(h!())?;
        if existing.is_some() {
            continue;
        }

        sigint_inbox_item_tag::ActiveModel {
            sigint_inbox_item_id: Set(inbox_id),
            sigint_inbox_item_uuid: Set(inbox_item_uuid),
            tag_id: Set(tag_id),
            confidence: Set(1.0),
            login_id: Set(Some(*login)),
            model: Set(None),
            ..Default::default()
        }
        .insert(txn)
        .await
        .c(h!())?;
    }
    Ok(())
}

async fn replace_submit_tags(
    txn: &DatabaseTransaction,
    inbox_id: i64,
    inbox_item_uuid: Option<uuid::Uuid>,
    login: &uuid::Uuid,
    tag_ids: Option<Vec<i64>>,
) -> Result<(), AppError> {
    let Some(tag_ids) = tag_ids else {
        return Ok(());
    };
    sigint_inbox_item_tag::Entity::delete_many()
        .filter(sigint_inbox_item_tag::Column::SigintInboxItemId.eq(inbox_id))
        .filter(sigint_inbox_item_tag::Column::LoginId.eq(Some(*login)))
        .filter(sigint_inbox_item_tag::Column::Model.is_null())
        .exec(txn)
        .await
        .c(h!())?;
    add_submit_tags(txn, inbox_id, inbox_item_uuid, login, Some(tag_ids)).await
}

fn format_geo_coordinates(coords: &[GeoCoordinates]) -> Option<String> {
    (!coords.is_empty()).then(|| {
        coords
            .iter()
            .map(|coords| format!("{}, {}", coords.lat, coords.lon))
            .join("\n")
    })
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
    login: &uuid::Uuid,
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

fn submit_group_master_key(login: &uuid::Uuid, group_name: &str) -> String {
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
    crate::battle_line::lock_updates(txn).await.c(h!())?;
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
    crate::battle_line::requeue_settlement_links_for_group(
        txn,
        group_master_key,
    )
    .await
    .c(h!())?;
    Ok(())
}

async fn upsert_submit_signal_message(
    txn: &DatabaseTransaction,
    config: &Config,
    datasource_id: Option<i64>,
    login_id: &Uuid,
    message_uid: Option<&str>,
    message: &InboxMessage,
    timestamp: Option<NaiveDateTime>,
    operator_tags: Option<serde_json::Value>,
    groups: &[(String, i64)],
    signal_message_uuid: Option<Uuid>,
) -> Result<signal_message::Model, AppError> {
    upsert_submit_signal_message_inner(
        txn,
        config,
        datasource_id,
        login_id,
        message_uid,
        message,
        timestamp,
        operator_tags,
        groups,
        false,
        signal_message_uuid,
    )
    .await
}

async fn update_submit_signal_message(
    txn: &DatabaseTransaction,
    config: &Config,
    signal_message_id: i64,
    login_id: &Uuid,
    message: &InboxMessage,
    timestamp: Option<NaiveDateTime>,
    operator_tags: Option<serde_json::Value>,
    groups: &[(String, i64)],
) -> Result<signal_message::Model, AppError> {
    let datasource_group_id = groups.first().map(|(_, id)| *id);
    let signal_message = SignalMessage::find_by_id(signal_message_id)
        .filter(signal_message::Column::Deleted.eq(false))
        .one(txn)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    prepare_message_network_activity_change(
        txn,
        signal_message.id,
        &format!("updated submitted inbox message {}", signal_message.id),
    )
    .await
    .c(h!())?;
    let assign_author =
        signal_message.login_id.is_none() && signal_message.sender.is_none();
    let mut signal_message = signal_message.into_active_model();
    signal_message.body = Set(Some(message.text.clone()));
    signal_message.datasource_group_id = Set(datasource_group_id);
    signal_message.timestamp = Set(timestamp);
    if assign_author {
        signal_message.login_id = Set(Some(*login_id));
    }
    if operator_tags.is_some() {
        signal_message.operator_tags = Set(operator_tags);
    }
    let signal_message = signal_message.update(txn).await.c(h!())?;
    let signal_message =
        ensure_signal_message_model_uid(txn, config, signal_message)
            .await
            .c(h!())?;
    ensure_submit_signal_message_groups(txn, &signal_message, groups).await?;
    Ok(signal_message)
}

async fn upsert_submit_signal_message_inner(
    txn: &DatabaseTransaction,
    config: &Config,
    datasource_id: Option<i64>,
    login_id: &Uuid,
    message_uid: Option<&str>,
    message: &InboxMessage,
    timestamp: Option<NaiveDateTime>,
    operator_tags: Option<serde_json::Value>,
    groups: &[(String, i64)],
    create_missing_uid: bool,
    signal_message_uuid: Option<Uuid>,
) -> Result<signal_message::Model, AppError> {
    let datasource_group_id = groups.first().map(|(_, id)| *id);
    let group_master_keys = groups
        .iter()
        .map(|(group_master_key, _)| group_master_key.clone())
        .collect::<Vec<_>>();
    let signal_message = match normalized_optional_string(message_uid) {
        Some(message_uid) => {
            let signal_message = SignalMessage::find()
                .join(
                    JoinType::InnerJoin,
                    signal_message::Relation::DatasourceGroup.def(),
                )
                .join(
                    JoinType::InnerJoin,
                    signal_message::Relation::SignalMessageGroup.def(),
                )
                .filter(signal_message::Column::MessageUid.eq(&message_uid))
                .filter(signal_message::Column::Deleted.eq(false))
                .filter(
                    datasource_group::Column::DatasourceId.eq(datasource_id),
                )
                .filter(
                    signal_message_group::Column::GroupMasterKey
                        .is_in(group_master_keys),
                )
                .one(txn)
                .await
                .c(h!())?;
            match signal_message {
                Some(signal_message) => {
                    prepare_message_network_activity_change(
                        txn,
                        signal_message.id,
                        &format!(
                            "updated submitted inbox message {}",
                            signal_message.id
                        ),
                    )
                    .await
                    .c(h!())?;
                    let assign_author = signal_message.login_id.is_none()
                        && signal_message.sender.is_none();
                    let mut signal_message = signal_message.into_active_model();
                    signal_message.body = Set(Some(message.text.clone()));
                    signal_message.datasource_group_id =
                        Set(datasource_group_id);
                    signal_message.timestamp = Set(timestamp);
                    if assign_author {
                        signal_message.login_id = Set(Some(*login_id));
                    }
                    signal_message.operator_tags = Set(operator_tags);
                    signal_message.deleted = Set(false);
                    signal_message.update(txn).await.c(h!())?
                }
                None if create_missing_uid => signal_message::ActiveModel {
                    id: NotSet,
                    id_uuid: Set(Some(signal_message_uuid.unwrap_or_else(|| {
                        crate::sigint::message_id::signal_message_uuid_for_insert(
                            timestamp,
                        )
                    }))),
                    body: Set(Some(message.text.clone())),
                    datasource_group_id: Set(datasource_group_id),
                    created_at: NotSet,
                    timestamp: Set(timestamp),
                    sender: Set(None),
                    login_id: Set(Some(*login_id)),
                    format: NotSet,
                    deleted: Set(false),
                    external_id: Set(None),
                    echo_inbox_message_id: Set(None),
                    message_uid: Set(Some(message_uid)),
                    operator_tags: Set(operator_tags),
                    attachments_hash: Set(None),
                }
                .insert(txn)
                .await
                .c(h!())?,
                None => return Err(AppError::NotFound),
            }
        }
        None => signal_message::ActiveModel {
            id: NotSet,
            id_uuid: Set(Some(signal_message_uuid.unwrap_or_else(|| {
                crate::sigint::message_id::signal_message_uuid_for_insert(
                    timestamp,
                )
            }))),
            body: Set(Some(message.text.clone())),
            datasource_group_id: Set(datasource_group_id),
            created_at: NotSet,
            timestamp: Set(timestamp),
            sender: Set(None),
            login_id: Set(Some(*login_id)),
            format: NotSet,
            deleted: Set(false),
            external_id: Set(None),
            echo_inbox_message_id: Set(None),
            message_uid: NotSet,
            operator_tags: Set(operator_tags),
            attachments_hash: Set(None),
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
    let mut inserted_group = false;
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
            existing.login_id = Set(signal_message.login_id);
            existing.message_uid = Set(signal_message.message_uid.clone());
            existing.datasource_group_id = Set(Some(*datasource_group_id));
            existing.update(txn).await.c(h!())?;
            continue;
        }

        signal_message_group::ActiveModel {
            id: NotSet,
            signal_message_id: Set(signal_message.id),
            signal_message_uuid: Set(signal_message.id_uuid),
            group_master_key: Set(Some(group_master_key.clone())),
            sender: Set(signal_message.sender.clone()),
            login_id: Set(signal_message.login_id),
            message_uid: Set(signal_message.message_uid.clone()),
            datasource_group_id: Set(Some(*datasource_group_id)),
            created_at: Set(signal_message.created_at),
        }
        .insert(txn)
        .await
        .c(h!())?;
        inserted_group = true;
    }
    if inserted_group {
        crate::battle_line::settlement_queue::requeue_item_settlements(
            txn,
            signal_message.id,
        )
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
    inbox_item_uuid: Option<uuid::Uuid>,
    network: Option<&SubmitNetwork>,
    dmr: Vec<SubmitDmrMetadata>,
    txn: &DatabaseTransaction,
) -> Result<Vec<InboxSubmitWarning>, AppError> {
    let (dmr, warnings) = normalize_submit_dmr_metadata(network, dmr)?;
    let mut entries = dmr
        .iter()
        .map(|metadata| {
            submit_dmr_metadata_model(inbox_id, inbox_item_uuid, metadata)
        })
        .collect::<Vec<_>>();

    if entries.is_empty() {
        if let Some(cc) = network.as_ref().and_then(|network| network.cc) {
            entries.push(sigint_inbox_item_metadata::ActiveModel {
                id: NotSet,
                sigint_inbox_item_id: Set(inbox_id),
                sigint_inbox_item_uuid: Set(inbox_item_uuid),
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
    if let Some(signal_name) =
        network.and_then(|network| network.signal_name.as_deref())
    {
        validate_submit_signal_name(signal_name)?;
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
    inbox_item_uuid: Option<uuid::Uuid>,
    metadata: &SubmitDmrMetadata,
) -> sigint_inbox_item_metadata::ActiveModel {
    sigint_inbox_item_metadata::ActiveModel {
        id: NotSet,
        sigint_inbox_item_id: Set(inbox_id),
        sigint_inbox_item_uuid: Set(inbox_item_uuid),
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
    login: &uuid::Uuid,
    sigint_groups: &[String],
    message_id: i64,
) -> Result<(), AppError> {
    let parent_group_access_query = Query::select()
        .expr(Expr::value(1))
        .from(signal_message_group::Entity)
        .and_where(
            Expr::col((
                signal_message_group::Entity,
                signal_message_group::Column::SignalMessageId,
            ))
            .equals((
                intel_product::Entity,
                intel_product::Column::SourceMessageId,
            )),
        )
        .and_where(
            signal_message_group::Column::GroupMasterKey
                .is_in(sigint_groups.to_vec()),
        )
        .to_owned();
    let parent_datasource_group_access_query = Query::select()
        .expr(Expr::value(1))
        .from(signal_message::Entity)
        .inner_join(
            datasource_group::Entity,
            Expr::col((
                signal_message::Entity,
                signal_message::Column::DatasourceGroupId,
            ))
            .equals((datasource_group::Entity, datasource_group::Column::Id)),
        )
        .and_where(
            Expr::col((signal_message::Entity, signal_message::Column::Id))
                .equals((
                    intel_product::Entity,
                    intel_product::Column::SourceMessageId,
                )),
        )
        .and_where(
            datasource_group::Column::GroupMasterKey
                .is_in(sigint_groups.to_vec()),
        )
        .to_owned();
    let parent_access_query = Query::select()
        .expr(Expr::value(1))
        .from(intel_product::Entity)
        .and_where(intel_product::relation_kind_eq(
            intel_product::RELATION_KIND_REPORT,
        ))
        .and_where(
            Expr::col((
                intel_product::Entity,
                intel_product::Column::IntelMessageId,
            ))
            .equals((signal_message::Entity, signal_message::Column::Id)),
        )
        .and_where(
            Condition::any()
                .add(Expr::exists(parent_group_access_query))
                .add(Expr::exists(parent_datasource_group_access_query))
                .into(),
        )
        .to_owned();
    let owner_access_query = Query::select()
        .expr(Expr::value(1))
        .from(signal_message_group::Entity)
        .and_where(
            Expr::col((
                signal_message_group::Entity,
                signal_message_group::Column::SignalMessageId,
            ))
            .equals((signal_message::Entity, signal_message::Column::Id)),
        )
        .to_owned();
    let organism_logins =
        crate::users::get_organism_login_ids_by_id(&env.dbx, login)
            .await
            .c(h!())?;
    let owner_sender_ids = organism_logins
        .iter()
        .chain(std::iter::once(login))
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let owner_access = Condition::all()
        .add(datasource_group::Column::GroupMasterKey.is_null())
        .add(Expr::exists(owner_access_query).not())
        .add(preferred_message_author_expr(None).is_in(owner_sender_ids));
    let message = SignalMessage::find_by_id(message_id)
        .join(
            JoinType::LeftJoin,
            signal_message::Relation::SignalMessageGroup.def(),
        )
        .join(
            JoinType::LeftJoin,
            signal_message::Relation::DatasourceGroup.def(),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(
            Condition::any()
                .add(
                    signal_message_group::Column::GroupMasterKey
                        .eq_any(sigint_groups.to_vec()),
                )
                .add(
                    datasource_group::Column::GroupMasterKey
                        .eq_any(sigint_groups.to_vec()),
                )
                .add(Expr::exists(parent_access_query))
                .add(owner_access),
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
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    let sigint_groups =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login)
            .await
            .c(h!())?;

    ensure_comment_save_access(&env, &login, &sigint_groups, req.message_id)
        .await?;

    let logins = crate::users::get_organism_login_ids_by_id(&env.dbx, &login)
        .await
        .c(h!())?;
    let txn = env.dbx.begin().await.c(h!())?;
    let message_ids =
        find_all_duplicates(&txn, req.message_id).await.c(h!())?;
    let comment = req.comment.as_ref().map(|c| c.trim()).unwrap_or("");
    for id in &message_ids {
        if comment.is_empty() {
            delete_editable_linked_message_comments(&txn, *id, &login, &logins)
                .await
                .c(h!())?;
        } else {
            upsert_editable_linked_message_comment(
                &txn, &env, *id, &login, &logins, comment,
            )
            .await
            .c(h!())?;
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
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    let logins = crate::users::get_organism_login_ids(&env.dbx, user)
        .await
        .context(h!())?;
    submit_legacy_inbox_messages(env, &login, &logins, req).await
}

async fn submit_legacy_inbox_messages(
    env: &Data<Env>,
    login: &uuid::Uuid,
    logins: &Vec<uuid::Uuid>,
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
                InboxLocationSubmitMode::PreserveTyped,
                true,
                false,
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
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
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
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;

    // no op
    Ok(Json(()))
}

pub async fn get_inbox_messages(
    login: &uuid::Uuid,
    logins: &Vec<uuid::Uuid>,
    env: &Env,
    req: &InboxMessagesReq,
) -> Result<Vec<(i64, InboxMessage)>, AppError> {
    get_inbox_messages_with_internal_lower_bound(login, logins, env, req, None)
        .await
}

async fn get_inbox_messages_with_analytics_candidates(
    login: &uuid::Uuid,
    logins: &Vec<uuid::Uuid>,
    env: &Env,
    req: &InboxMessagesReq,
) -> Result<Vec<(i64, InboxMessage)>, AppError> {
    let mut diagnostics = InboxReadDiagnostics::new(req.page_id.as_deref());
    let result = get_inbox_messages_with_analytics_candidates_inner(
        login,
        logins,
        env,
        req,
        &mut diagnostics,
    )
    .await;
    diagnostics.finish(&result);
    result
}

async fn get_inbox_messages_with_analytics_candidates_inner(
    login: &uuid::Uuid,
    logins: &Vec<uuid::Uuid>,
    env: &Env,
    req: &InboxMessagesReq,
    diagnostics: &mut InboxReadDiagnostics,
) -> Result<Vec<(i64, InboxMessage)>, AppError> {
    diagnostics.reason = if env.analytics.is_none() {
        "unconfigured"
    } else if !analytics_inbox_candidates_supported(req) {
        "query_policy"
    } else {
        "none"
    };
    let now = Utc::now().naive_utc();
    let freshness_max_age_ms = analytics_freshness_max_age_ms(env);
    match rer_analysis_inbox_route(req, now, freshness_max_age_ms) {
        RerAnalysisInboxRoute::AnalyticsHybrid => {
            if analytics_inbox_candidates_supported(req) {
                if let Some(messages) = try_load_rer_analysis_inbox_hybrid(
                    login,
                    logins,
                    env,
                    req,
                    diagnostics,
                )
                .await
                .context(h!())?
                {
                    return Ok(messages);
                }
            }
            diagnostics.start_postgres();
            return get_inbox_messages_with_internal_lower_bound(
                login, logins, env, req, None,
            )
            .await;
        }
        RerAnalysisInboxRoute::Default => {}
    }

    if rer_duty_fresh_tail_candidates_supported(req) {
        if let Some(messages) =
            try_load_rer_duty_inbox_hybrid(login, logins, env, req, diagnostics)
                .await
                .context(h!())?
        {
            return Ok(messages);
        }
    } else {
        if let AnalyticsInboxCandidateIds::Available(candidate_ids) =
            load_analytics_inbox_candidate_ids(login, env, req)
                .await
                .context(h!())?
        {
            if let Some(messages) = hydrate_analytics_inbox_candidates(
                login,
                logins,
                env,
                req,
                &candidate_ids,
                diagnostics,
            )
            .await
            .context(h!())?
            {
                diagnostics.route = "analytics_candidates";
                diagnostics.reason = "none";
                return Ok(messages);
            }
        } else {
            diagnostics.fallback("candidates_unavailable");
        }
    }
    diagnostics.start_postgres();
    let internal_lower_bound =
        rer_duty_neo_adaptive_lower_bound(login, env, req).await;
    get_inbox_messages_with_internal_lower_bound(
        login,
        logins,
        env,
        req,
        internal_lower_bound,
    )
    .await
}

fn rer_duty_fresh_tail_request_supported(req: &InboxMessagesReq) -> bool {
    analytics_inbox_request_supported(req)
}

fn rer_duty_fresh_tail_candidates_supported(req: &InboxMessagesReq) -> bool {
    rer_duty_fresh_tail_request_supported(req)
        && analytics_inbox_candidates_supported(req)
}

fn rer_analysis_inbox_route(
    req: &InboxMessagesReq,
    now: NaiveDateTime,
    freshness_max_age_ms: u64,
) -> RerAnalysisInboxRoute {
    if req.page_id.as_deref() != Some("rer-analysis") {
        return RerAnalysisInboxRoute::Default;
    }
    let (Some(since_ms), Some(till_ms)) =
        (req.since_date_inclusive_ms, req.till_date_inclusive_ms)
    else {
        return RerAnalysisInboxRoute::Default;
    };
    let (Ok(since), Ok(till)) = (
        crate::utils::dt_from_millis(since_ms),
        crate::utils::dt_from_millis(till_ms),
    ) else {
        return RerAnalysisInboxRoute::Default;
    };
    let fresh_tail_lower_bound = analytics_fresh_tail_lower_bound(
        now,
        freshness_max_age_ms,
        RER_ANALYSIS_ANALYTICS_FRESH_TAIL_MINUTES,
    );
    if since > now || till < since || till < fresh_tail_lower_bound {
        return RerAnalysisInboxRoute::Default;
    }
    RerAnalysisInboxRoute::AnalyticsHybrid
}

async fn try_load_rer_analysis_inbox_hybrid(
    login: &uuid::Uuid,
    logins: &Vec<uuid::Uuid>,
    env: &Env,
    req: &InboxMessagesReq,
    diagnostics: &mut InboxReadDiagnostics,
) -> Result<Option<Vec<(i64, InboxMessage)>>, AppError> {
    let started = Instant::now();
    let candidates = match load_hybrid_inbox_candidate_ids(
        login,
        env,
        req,
        RER_ANALYSIS_ANALYTICS_FRESH_TAIL_MINUTES,
        AnalyticsEmptyScopePolicy::PostgresFallback,
    )
    .await
    {
        Ok(Some(candidates)) => candidates,
        Ok(None) => {
            diagnostics.fallback("candidates_unavailable");
            warn!(
                target: "rer_analysis_inbox_route",
                "rer_analysis_inbox_route route=postgres_fallback analytics_candidates_available=false elapsed_ms={}",
                started.elapsed().as_millis(),
            );
            return Ok(None);
        }
        Err(error) => {
            diagnostics.stage = "postgres_tail";
            diagnostics.fallback("postgres_tail_error");
            warn!(
                target: "rer_analysis_inbox_route",
                "rer_analysis_inbox_route route=postgres_fallback postgres_tail_failed=true elapsed_ms={} error={error:?}",
                started.elapsed().as_millis(),
            );
            return Ok(None);
        }
    };
    let merged_candidate_count = candidates.ids.len();
    diagnostics.candidate_count = Some(merged_candidate_count);
    let Some(messages) = hydrate_hybrid_inbox_candidates(
        login,
        logins,
        env,
        req,
        &candidates.ids,
        diagnostics,
    )
    .await
    .context(h!())?
    else {
        warn!(
            target: "rer_analysis_inbox_route",
            "rer_analysis_inbox_route route=postgres_fallback candidate_revalidation_complete=false merged_candidate_count={} elapsed_ms={}",
            merged_candidate_count,
            started.elapsed().as_millis(),
        );
        return Ok(None);
    };
    info!(
        target: "rer_analysis_inbox_route",
        "rer_analysis_inbox_route route=analytics_hybrid analytics_candidate_count={} postgres_tail_candidate_count={} merged_candidate_count={} result_count={} postgres_tail_ms={} elapsed_ms={}",
        candidates.analytics_count,
        candidates.postgres_tail_count,
        merged_candidate_count,
        messages.len(),
        candidates.postgres_tail_ms,
        started.elapsed().as_millis(),
    );
    diagnostics.route = "analytics_hybrid";
    diagnostics.reason = "none";
    Ok(Some(messages))
}

async fn try_load_rer_duty_inbox_hybrid(
    login: &uuid::Uuid,
    logins: &Vec<uuid::Uuid>,
    env: &Env,
    req: &InboxMessagesReq,
    diagnostics: &mut InboxReadDiagnostics,
) -> Result<Option<Vec<(i64, InboxMessage)>>, AppError> {
    let started = Instant::now();
    let candidates = match load_hybrid_inbox_candidate_ids(
        login,
        env,
        req,
        RER_DUTY_ANALYTICS_FRESH_TAIL_MINUTES,
        AnalyticsEmptyScopePolicy::FreshTail,
    )
    .await
    {
        Ok(Some(candidates)) => candidates,
        Ok(None) => {
            diagnostics.fallback("candidates_unavailable");
            warn!(
                target: "rer_duty_inbox_route",
                "rer_duty_inbox_route route=postgres_fallback analytics_candidates_available=false elapsed_ms={}",
                started.elapsed().as_millis(),
            );
            return Ok(None);
        }
        Err(error) => {
            diagnostics.stage = "postgres_tail";
            diagnostics.fallback("postgres_tail_error");
            warn!(
                target: "rer_duty_inbox_route",
                "rer_duty_inbox_route route=postgres_fallback postgres_tail_failed=true elapsed_ms={} error={error:?}",
                started.elapsed().as_millis(),
            );
            return Ok(None);
        }
    };
    let merged_candidate_count = candidates.ids.len();
    diagnostics.candidate_count = Some(merged_candidate_count);
    let Some(messages) = hydrate_hybrid_inbox_candidates(
        login,
        logins,
        env,
        req,
        &candidates.ids,
        diagnostics,
    )
    .await
    .context(h!())?
    else {
        warn!(
            target: "rer_duty_inbox_route",
            "rer_duty_inbox_route route=postgres_fallback candidate_revalidation_complete=false merged_candidate_count={} elapsed_ms={}",
            merged_candidate_count,
            started.elapsed().as_millis(),
        );
        return Ok(None);
    };
    info!(
        target: "rer_duty_inbox_route",
        "rer_duty_inbox_route route=analytics_hybrid analytics_candidate_count={} postgres_tail_candidate_count={} merged_candidate_count={} result_count={} postgres_tail_ms={} elapsed_ms={}",
        candidates.analytics_count,
        candidates.postgres_tail_count,
        merged_candidate_count,
        messages.len(),
        candidates.postgres_tail_ms,
        started.elapsed().as_millis(),
    );
    diagnostics.route = "analytics_hybrid";
    diagnostics.reason = "none";
    Ok(Some(messages))
}

async fn load_hybrid_inbox_candidate_ids(
    login: &uuid::Uuid,
    env: &Env,
    req: &InboxMessagesReq,
    minimum_tail_minutes: i64,
    empty_scope_policy: AnalyticsEmptyScopePolicy,
) -> Result<Option<HybridInboxCandidateIds>, AppError> {
    let created_at_lower_bound = analytics_fresh_tail_lower_bound(
        Utc::now().naive_utc(),
        analytics_freshness_max_age_ms(env),
        minimum_tail_minutes,
    );
    let analytics_ids =
        match load_analytics_inbox_candidate_ids(login, env, req)
            .await
            .context(h!())?
        {
            AnalyticsInboxCandidateIds::Available(ids) => ids,
            AnalyticsInboxCandidateIds::EmptyScope
                if empty_scope_policy
                    == AnalyticsEmptyScopePolicy::FreshTail =>
            {
                Vec::new()
            }
            AnalyticsInboxCandidateIds::EmptyScope
            | AnalyticsInboxCandidateIds::Unavailable => return Ok(None),
        };
    let tail_started = Instant::now();
    let fresh_tail_ids = load_postgres_fresh_tail_candidate_ids(
        login,
        env,
        req,
        created_at_lower_bound,
    )
    .await
    .context(h!())?;
    let postgres_tail_ms = tail_started.elapsed().as_millis();
    let analytics_count = analytics_ids.len();
    let postgres_tail_count = fresh_tail_ids.len();
    Ok(Some(HybridInboxCandidateIds {
        ids: merge_inbox_candidate_ids(analytics_ids, fresh_tail_ids),
        analytics_count,
        postgres_tail_count,
        postgres_tail_ms,
    }))
}

async fn load_postgres_fresh_tail_candidate_ids(
    login: &uuid::Uuid,
    env: &Env,
    req: &InboxMessagesReq,
    created_at_lower_bound: NaiveDateTime,
) -> Result<Vec<i64>, AppError> {
    let ids = load_postgres_fresh_tail_inbox_candidates(
        &env.dbx,
        login,
        env,
        req,
        created_at_lower_bound,
    )
    .await
    .context(h!())?;
    Ok(ids)
}

fn analytics_fresh_tail_lower_bound(
    now: NaiveDateTime,
    freshness_max_age_ms: u64,
    minimum_tail_minutes: i64,
) -> NaiveDateTime {
    let minimum_ms = u64::try_from(
        Duration::minutes(minimum_tail_minutes).num_milliseconds(),
    )
    .unwrap_or_default();
    let overlap_ms = std::cmp::min(
        std::cmp::max(freshness_max_age_ms.saturating_mul(2), minimum_ms),
        i64::MAX as u64,
    ) as i64;
    now.checked_sub_signed(Duration::milliseconds(overlap_ms))
        .unwrap_or(NaiveDateTime::MIN)
}

fn merge_inbox_candidate_ids(
    analytics_ids: Vec<i64>,
    fresh_tail_ids: Vec<i64>,
) -> Vec<i64> {
    let mut seen = BTreeSet::new();
    analytics_ids
        .into_iter()
        .chain(fresh_tail_ids)
        .filter(|id| seen.insert(*id))
        .collect()
}

async fn load_analytics_inbox_candidate_ids(
    login: &uuid::Uuid,
    env: &Env,
    req: &InboxMessagesReq,
) -> Result<AnalyticsInboxCandidateIds, AppError> {
    let freshness_max_age_ms = analytics_freshness_max_age_ms(env);
    let analytics_env = env.clone();
    let analytics_req = req.clone();
    let login_value = *login;
    Ok(with_analytics_read_fallback(
        env,
        "inbox message candidates",
        analytics_inbox_candidates_supported(req),
        |db| async move {
            let candidates = load_analytics_inbox_candidates(
                &login_value,
                &analytics_env,
                &analytics_req,
                &db,
                freshness_max_age_ms,
            )
            .await
            .context(h!())?;
            match candidates {
                Some(ids) => Ok(AnalyticsInboxCandidateIds::Available(ids)),
                None => Ok(AnalyticsInboxCandidateIds::EmptyScope),
            }
        },
        |_db| async { Ok(AnalyticsInboxCandidateIds::Unavailable) },
    )
    .await
    .context(h!())?)
}

fn analytics_freshness_max_age_ms(env: &Env) -> u64 {
    env.config
        .analytics
        .as_ref()
        .map(AnalyticsConfig::freshness_max_age_ms)
        .unwrap_or(ANALYTICS_FRESHNESS_MAX_AGE_MS_DEFAULT)
}

async fn hydrate_analytics_inbox_candidates(
    login: &uuid::Uuid,
    logins: &Vec<uuid::Uuid>,
    env: &Env,
    req: &InboxMessagesReq,
    candidate_ids: &[i64],
    diagnostics: &mut InboxReadDiagnostics,
) -> Result<Option<Vec<(i64, InboxMessage)>>, AppError> {
    diagnostics.stage = "hydration";
    diagnostics.candidate_count = Some(candidate_ids.len());
    diagnostics.hydrated_count = Some(0);
    let query = build_inbox_query_for_candidate_ids(
        &env.dbx,
        login,
        env,
        req,
        candidate_ids,
        true,
    )
    .await
    .context(h!())?;
    let mut messages = fetch_inbox_messages_with_query(
        &env.dbx, login, logins, env, req, &query,
    )
    .await
    .context(h!())?;
    diagnostics.hydrated_count = Some(messages.len());
    diagnostics.stage = "ordering";
    diagnostics.ordered_count = Some(candidate_ids.len());
    if restore_analytics_candidate_order(&mut messages, candidate_ids) {
        return Ok(Some(messages));
    }
    warn!(
        target: "analytics_inbox_revalidation",
        "analytics_inbox_candidate_revalidation_failed candidate_count={} hydrated_count={}; retrying via PostgreSQL",
        candidate_ids.len(),
        messages.len()
    );
    diagnostics.fallback("candidate_revalidation_incomplete");
    Ok(None)
}

async fn hydrate_hybrid_inbox_candidates(
    login: &uuid::Uuid,
    logins: &Vec<uuid::Uuid>,
    env: &Env,
    req: &InboxMessagesReq,
    candidate_ids: &[i64],
    diagnostics: &mut InboxReadDiagnostics,
) -> Result<Option<Vec<(i64, InboxMessage)>>, AppError> {
    match hydrate_hybrid_inbox_candidates_inner(
        login,
        logins,
        env,
        req,
        candidate_ids,
        diagnostics,
    )
    .await
    {
        Ok(messages) => Ok(messages),
        Err(error) => {
            diagnostics.fallback("revalidation_error");
            warn!(target: "analytics_route", "operation=inbox_hydration route=postgres reason=revalidation_error error={error:?}");
            Ok(None)
        }
    }
}

async fn hydrate_hybrid_inbox_candidates_inner(
    login: &uuid::Uuid,
    logins: &Vec<uuid::Uuid>,
    env: &Env,
    req: &InboxMessagesReq,
    candidate_ids: &[i64],
    diagnostics: &mut InboxReadDiagnostics,
) -> Result<Option<Vec<(i64, InboxMessage)>>, AppError> {
    diagnostics.stage = "hydration";
    diagnostics.candidate_count = Some(candidate_ids.len());
    diagnostics.hydrated_count = Some(0);
    if candidate_ids.is_empty() {
        return Ok(Some(Vec::new()));
    }
    let mut messages = Vec::with_capacity(candidate_ids.len());
    for ids in candidate_ids.chunks(ANALYTICS_INBOX_CANDIDATE_PAGE_SIZE) {
        let query = build_inbox_query_for_candidate_ids(
            &env.dbx, login, env, req, ids, false,
        )
        .await
        .context(h!())?;
        messages.extend(
            fetch_inbox_messages_with_query(
                &env.dbx, login, logins, env, req, &query,
            )
            .await
            .context(h!())?,
        );
        diagnostics.hydrated_count = Some(messages.len());
    }
    if !analytics_candidate_revalidation_is_complete(&messages, candidate_ids) {
        diagnostics.fallback("candidate_revalidation_incomplete");
        warn!(target: "analytics_inbox_revalidation", "hybrid candidate revalidation incomplete candidate_count={} hydrated_count={}", candidate_ids.len(), messages.len());
        return Ok(None);
    }
    diagnostics.stage = "ordering";
    let ordered_ids = order_inbox_candidate_ids(&env.dbx, req, candidate_ids)
        .await
        .context(h!())?;
    diagnostics.ordered_count = Some(ordered_ids.len());
    if !restore_analytics_candidate_order(&mut messages, &ordered_ids) {
        diagnostics.fallback("candidate_ordering_incomplete");
        warn!(target: "analytics_inbox_revalidation", "hybrid candidate ordering incomplete candidate_count={} hydrated_count={} ordered_count={}", candidate_ids.len(), messages.len(), ordered_ids.len());
        return Ok(None);
    }
    retain_hybrid_inbox_page(&mut messages, req);
    Ok(Some(messages))
}

fn retain_hybrid_inbox_page<T>(rows: &mut Vec<T>, req: &InboxMessagesReq) {
    if req.nolimit == Some(true) || rows.len() <= INBOX_MESSAGES_PAGE_LIMIT {
        return;
    }
    if inbox_results_reverse_query_order(req) {
        rows.drain(..rows.len() - INBOX_MESSAGES_PAGE_LIMIT);
    } else {
        rows.truncate(INBOX_MESSAGES_PAGE_LIMIT);
    }
}

fn analytics_candidate_revalidation_is_complete<T>(
    rows: &[(i64, T)],
    candidate_ids: &[i64],
) -> bool {
    let row_ids = rows.iter().map(|(id, _)| *id).collect::<BTreeSet<_>>();
    rows.len() == candidate_ids.len()
        && row_ids.len() == candidate_ids.len()
        && candidate_ids.iter().all(|id| row_ids.contains(id))
}

fn restore_analytics_candidate_order<T>(
    rows: &mut Vec<(i64, T)>,
    candidate_ids: &[i64],
) -> bool {
    if rows.len() != candidate_ids.len() {
        return false;
    }
    let positions = candidate_ids
        .iter()
        .enumerate()
        .map(|(position, id)| (*id, position))
        .collect::<HashMap<_, _>>();
    if positions.len() != candidate_ids.len()
        || rows.iter().any(|(id, _)| !positions.contains_key(id))
    {
        return false;
    }
    rows.sort_by_key(|(id, _)| positions[id]);
    true
}

async fn get_inbox_messages_with_internal_lower_bound(
    login: &uuid::Uuid,
    logins: &Vec<uuid::Uuid>,
    env: &Env,
    req: &InboxMessagesReq,
    internal_lower_bound: Option<NaiveDateTime>,
) -> Result<Vec<(i64, InboxMessage)>, AppError> {
    let q = build_inbox_query_with_internal_lower_bound(
        &env.dbx,
        login,
        env,
        req,
        internal_lower_bound,
    )
    .await
    .c(h!())?;
    fetch_inbox_messages_with_query(&env.dbx, login, logins, env, req, &q).await
}

pub async fn get_inbox_messages_created_between(
    login: &uuid::Uuid,
    logins: &Vec<uuid::Uuid>,
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
    login: &uuid::Uuid,
    logins: &Vec<uuid::Uuid>,
    env: &Env,
    req: &InboxMessagesReq,
) -> Result<Vec<(i64, InboxMessage)>, AppError> {
    let q = build_inbox_query(login, env, req).await.c(h!())?;
    let res = fetch_inbox_messages_with_query(dbx, login, logins, env, req, &q)
        .await
        .context(h!())?;
    Ok(res)
}

pub async fn load_message_networks_by_ids(
    dbx: &DatabaseConnection,
    message_ids: &[i64],
) -> Result<HashMap<i64, Vec<i64>>, AppError> {
    bl::load_messages_networks_by_ids(message_ids, dbx).await
}

pub(crate) fn format_inbox_message_location(
    location: Option<String>,
    location_v2: Option<String>,
) -> Option<String> {
    bl::format_inbox_message_location(location, location_v2)
}

async fn fetch_inbox_messages_with_query(
    dbx: &DatabaseConnection,
    login: &uuid::Uuid,
    logins: &Vec<uuid::Uuid>,
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
    login: &uuid::Uuid,
    logins: &Vec<uuid::Uuid>,
    env: &Env,
    req: &InboxMessagesReq,
    statement: Statement,
) -> Result<Vec<(i64, InboxMessage)>, AppError> {
    let results = dbx.query_all_raw(statement).await.context(h!())?;

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
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;

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
        .query_all_raw(Statement::from_string(DatabaseBackend::Postgres, q))
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
    use crate::entities::sea_orm_active_enums::SigintInboxItemUnitKind;
    use crate::entities::{
        datasource, datasource_group, echo_gpu_transcription_queue, login,
        organism, organism_group, sigint_comment, sigint_inbox_item,
        sigint_inbox_item_metadata, sigint_inbox_item_network,
        sigint_inbox_item_point_token, sigint_inbox_item_settlement,
        sigint_inbox_item_tag, sigint_inbox_item_unit, sigint_network_unit,
        sigint_peleng, sigint_zone_datasource, signal_group, signal_message,
        signal_message_group, signal_message_media, system_settings, tag,
    };
    use crate::functest::tests::*;
    use chrono::{DateTime, SecondsFormat, Utc};
    use sea_orm::ActiveValue::Set;
    use serde_json::json;
    use serial_test::serial;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use uuid::Uuid;

    fn rer_duty_neo_latest_req() -> InboxMessagesReq {
        InboxMessagesReq {
            page_id: Some("rer-duty-neo".to_string()),
            load_latest: Some(true),
            ..Default::default()
        }
    }

    fn rer_analysis_req(
        since: NaiveDateTime,
        till: NaiveDateTime,
    ) -> InboxMessagesReq {
        InboxMessagesReq {
            page_id: Some("rer-analysis".to_string()),
            since_date_inclusive_ms: Some(since.and_utc().timestamp_millis()),
            till_date_inclusive_ms: Some(till.and_utc().timestamp_millis()),
            newest_first: Some(true),
            ..Default::default()
        }
    }

    #[test]
    fn adaptive_cutoff_requires_traffic_above_threshold() {
        let now = NaiveDate::from_ymd_opt(2026, 8, 9)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap();

        assert_eq!(
            rer_duty_neo_adaptive_cutoff_from_stats(
                Ok(RER_DUTY_NEO_ADAPTIVE_CUTOFF_TRAFFIC_THRESHOLD),
                now,
                2,
            ),
            None
        );
        assert_eq!(
            rer_duty_neo_adaptive_cutoff_from_stats(
                Ok(RER_DUTY_NEO_ADAPTIVE_CUTOFF_TRAFFIC_THRESHOLD + 1),
                now,
                2,
            ),
            Some(now - Duration::days(RER_DUTY_NEO_ADAPTIVE_CUTOFF_DAYS))
        );
        assert_eq!(
            rer_duty_neo_adaptive_cutoff_from_stats(
                Err(anyhow::anyhow!("redis unavailable")),
                now,
                2,
            ),
            Some(now - Duration::days(RER_DUTY_NEO_ADAPTIVE_CUTOFF_DAYS))
        );
    }

    #[test]
    fn adaptive_cutoff_uses_complete_five_minute_stats_buckets() {
        let now = NaiveDate::from_ymd_opt(2026, 8, 9)
            .unwrap()
            .and_hms_milli_opt(12, 7, 41, 123)
            .unwrap();
        let till = NaiveDate::from_ymd_opt(2026, 8, 9)
            .unwrap()
            .and_hms_opt(12, 5, 0)
            .unwrap();

        assert_eq!(
            rer_duty_neo_stats_window(now).unwrap(),
            (
                till - Duration::hours(
                    RER_DUTY_NEO_ADAPTIVE_CUTOFF_TRAFFIC_LOOKBACK_HOURS,
                ),
                till,
            )
        );
    }

    #[test]
    fn adaptive_cutoff_uses_effective_accessible_groups() {
        let accessible = vec!["group-a".to_string(), "group-b".to_string()];

        assert_eq!(
            effective_inbox_groups(
                &Some(vec!["group-b".to_string(), "hidden".to_string()]),
                &accessible,
            ),
            vec!["group-b".to_string()]
        );
        assert_eq!(
            effective_inbox_groups(
                &Some(vec!["hidden".to_string()]),
                &accessible
            ),
            accessible
        );
        assert_eq!(
            effective_inbox_groups(&Some(vec![]), &accessible),
            accessible
        );
    }

    #[test]
    fn adaptive_cutoff_only_applies_to_initial_rer_duty_neo_load() {
        let req = rer_duty_neo_latest_req();
        assert!(rer_duty_neo_adaptive_cutoff_is_eligible(&req));

        assert!(!rer_duty_neo_adaptive_cutoff_is_eligible(
            &InboxMessagesReq {
                page_id: Some("rer-analysis".to_string()),
                ..req.clone()
            }
        ));
        assert!(!rer_duty_neo_adaptive_cutoff_is_eligible(
            &InboxMessagesReq {
                since_date_inclusive_ms: Some(1),
                ..req.clone()
            }
        ));
        assert!(!rer_duty_neo_adaptive_cutoff_is_eligible(
            &InboxMessagesReq {
                since_id_noninclusive: Some(1),
                ..req
            }
        ));
    }

    #[test]
    fn initial_unit_filter_fallback_is_detected_without_statistics() {
        let mut req = rer_duty_neo_latest_req();
        assert!(!inbox_request_has_unit_filters(&req));

        req.selected_units = Some(vec!["unit".to_string()]);
        assert!(inbox_request_has_unit_filters(&req));

        req.selected_units = Some(Vec::new());
        req.denied_units = Some(vec!["unit".to_string()]);
        assert!(inbox_request_has_unit_filters(&req));
    }

    #[test]
    fn analytics_fresh_tail_is_at_least_five_minutes_and_twice_freshness() {
        let now = NaiveDate::from_ymd_opt(2026, 8, 9)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap();

        assert_eq!(
            analytics_fresh_tail_lower_bound(now, 90_000, 5),
            now - Duration::minutes(5)
        );
        assert_eq!(
            analytics_fresh_tail_lower_bound(now, 240_000, 5),
            now - Duration::minutes(8)
        );
    }

    #[test]
    fn recent_duty_cursors_use_source_postgres() {
        let now = NaiveDate::from_ymd_opt(2026, 8, 16)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap();
        let req = InboxMessagesReq {
            page_id: Some(RER_DUTY_PAGE_ID.to_string()),
            since_id_noninclusive: Some(42),
            since_date_inclusive_ms: Some(
                (now - Duration::days(3)).and_utc().timestamp_millis(),
            ),
            sort_by: Some(InboxMessagesSortBy::IMSTimestamp),
            ..Default::default()
        };
        for age in [1, 20, 59, 60] {
            assert!(
                duty_inbox_request_uses_source_postgres_for_cursor_created_at(
                    &req,
                    &HashMap::from([(42, now - Duration::minutes(age))]),
                    now,
                )
            );
        }
        assert!(
            duty_inbox_request_uses_source_postgres_for_cursor_created_at(
                &InboxMessagesReq {
                    page_id: Some(RER_DUTY_NEO_PAGE_ID.to_string()),
                    ..req.clone()
                },
                &HashMap::from([(42, now - Duration::minutes(20))]),
                now,
            )
        );
        assert!(
            duty_inbox_request_uses_source_postgres_for_cursor_created_at(
                &req,
                &HashMap::new(),
                now,
            )
        );
    }

    #[test]
    fn historical_duty_cursors_remain_analytics_eligible() {
        let now = NaiveDate::from_ymd_opt(2026, 8, 16)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap();
        let req = InboxMessagesReq {
            page_id: Some(RER_DUTY_PAGE_ID.to_string()),
            since_id_noninclusive: Some(42),
            sort_by: Some(InboxMessagesSortBy::IMSTimestamp),
            ..Default::default()
        };
        assert!(
            !duty_inbox_request_uses_source_postgres_for_cursor_created_at(
                &req,
                &HashMap::from([(42, now - Duration::minutes(61))]),
                now,
            )
        );
        assert!(rer_duty_fresh_tail_request_supported(&req));
        assert!(rer_duty_fresh_tail_candidates_supported(&req));
        assert!(rer_duty_fresh_tail_request_supported(&InboxMessagesReq {
            page_id: Some(RER_DUTY_NEO_PAGE_ID.to_string()),
            ..req.clone()
        }));

        assert!(rer_duty_fresh_tail_request_supported(&InboxMessagesReq {
            page_id: Some("rer-analysis".to_string()),
            ..req.clone()
        }));
        assert!(rer_duty_fresh_tail_request_supported(&InboxMessagesReq {
            before_id_noninclusive: Some(43),
            ..req.clone()
        }));
        let historical_context = InboxMessagesReq {
            since_id_noninclusive: None,
            before_id_noninclusive: Some(42),
            ..req.clone()
        };
        assert!(
            !duty_inbox_request_uses_source_postgres_for_cursor_created_at(
                &historical_context,
                &HashMap::from([(42, now - Duration::minutes(61))]),
                now,
            )
        );
        assert!(analytics_inbox_candidates_supported(&historical_context));
        assert!(rer_duty_fresh_tail_candidates_supported(
            &InboxMessagesReq {
                nolimit: Some(true),
                ..req
            }
        ));
    }

    #[test]
    fn latest_and_recent_date_duty_requests_use_source_postgres() {
        let now = NaiveDate::from_ymd_opt(2026, 8, 16)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap();
        let mut latest = rer_duty_neo_latest_req();
        latest.selected_units = Some(vec!["unit".to_string()]);
        assert!(
            duty_inbox_request_uses_source_postgres_for_cursor_created_at(
                &latest,
                &HashMap::new(),
                now,
            )
        );

        let recent_count = InboxMessagesReq {
            page_id: Some(RER_DUTY_PAGE_ID.to_string()),
            since_date_inclusive_ms: Some(
                (now - Duration::minutes(20)).and_utc().timestamp_millis(),
            ),
            nolimit: Some(true),
            ..Default::default()
        };
        assert!(
            duty_inbox_request_uses_source_postgres_for_cursor_created_at(
                &recent_count,
                &HashMap::new(),
                now,
            )
        );
        assert!(
            !duty_inbox_request_uses_source_postgres_for_cursor_created_at(
                &InboxMessagesReq {
                    since_date_inclusive_ms: Some(
                        (now - Duration::hours(2)).and_utc().timestamp_millis(),
                    ),
                    ..recent_count
                },
                &HashMap::new(),
                now,
            )
        );
    }

    #[test]
    fn rer_analysis_recent_and_hybrid_routes_cover_the_fresh_tail() {
        let now = NaiveDate::from_ymd_opt(2026, 8, 12)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap();
        let recent = rer_analysis_req(
            now - Duration::hours(24),
            now - Duration::minutes(1),
        );
        assert_eq!(
            rer_analysis_inbox_route(&recent, now, 90_000),
            RerAnalysisInboxRoute::AnalyticsHybrid
        );

        let exact_threshold = rer_analysis_req(now - Duration::hours(25), now);
        assert_eq!(
            rer_analysis_inbox_route(&exact_threshold, now, 90_000),
            RerAnalysisInboxRoute::AnalyticsHybrid
        );

        let historical = rer_analysis_req(
            now - Duration::hours(26),
            now - Duration::minutes(6),
        );
        assert_eq!(
            rer_analysis_inbox_route(&historical, now, 90_000),
            RerAnalysisInboxRoute::Default
        );

        let mut other_page = recent;
        other_page.page_id = Some("rer-duty-neo".to_string());
        assert_eq!(
            rer_analysis_inbox_route(&other_page, now, 90_000),
            RerAnalysisInboxRoute::Default
        );
    }

    #[test]
    fn rer_analysis_fresh_tail_scales_with_analytics_freshness() {
        let now = NaiveDate::from_ymd_opt(2026, 8, 12)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap();
        let within_eight_minutes = rer_analysis_req(
            now - Duration::hours(24),
            now - Duration::minutes(7),
        );
        assert_eq!(
            rer_analysis_inbox_route(&within_eight_minutes, now, 240_000),
            RerAnalysisInboxRoute::AnalyticsHybrid
        );

        let outside_eight_minutes = rer_analysis_req(
            now - Duration::hours(24),
            now - Duration::minutes(9),
        );
        assert_eq!(
            rer_analysis_inbox_route(&outside_eight_minutes, now, 240_000),
            RerAnalysisInboxRoute::Default
        );
    }

    #[test]
    fn hybrid_candidates_include_fresh_postgres_ids_and_revalidate() {
        let ids = merge_inbox_candidate_ids(vec![5, 4, 3], vec![6, 5, 4]);
        assert_eq!(ids, vec![5, 4, 3, 6]);
        assert!(analytics_candidate_revalidation_is_complete(
            &[(3, "three"), (4, "four"), (5, "five"), (6, "six")],
            &ids,
        ));
        assert!(!analytics_candidate_revalidation_is_complete(
            &[(3, "three"), (4, "four"), (5, "five")],
            &ids,
        ));
    }

    #[test]
    fn hybrid_page_limit_preserves_response_ordering() {
        let rows = (1..=INBOX_MESSAGES_PAGE_LIMIT + 3).collect::<Vec<_>>();

        let mut latest_rows = rows.clone();
        retain_hybrid_inbox_page(
            &mut latest_rows,
            &InboxMessagesReq {
                load_latest: Some(true),
                ..Default::default()
            },
        );
        assert_eq!(
            latest_rows,
            (4..=INBOX_MESSAGES_PAGE_LIMIT + 3).collect::<Vec<_>>()
        );

        let mut newest_first_rows = rows.clone();
        retain_hybrid_inbox_page(
            &mut newest_first_rows,
            &InboxMessagesReq {
                newest_first: Some(true),
                ..Default::default()
            },
        );
        assert_eq!(
            newest_first_rows,
            (1..=INBOX_MESSAGES_PAGE_LIMIT).collect::<Vec<_>>()
        );

        let mut ascending_before_cursor_rows = rows;
        retain_hybrid_inbox_page(
            &mut ascending_before_cursor_rows,
            &InboxMessagesReq {
                before_id_noninclusive: Some(100),
                newest_first: Some(false),
                ..Default::default()
            },
        );
        assert_eq!(
            ascending_before_cursor_rows,
            (4..=INBOX_MESSAGES_PAGE_LIMIT + 3).collect::<Vec<_>>()
        );
    }

    #[test]
    fn analytics_candidate_revalidation_restores_order_and_detects_loss() {
        let mut rows = vec![(2, "two"), (3, "three"), (1, "one")];
        assert!(restore_analytics_candidate_order(&mut rows, &[3, 1, 2]));
        assert_eq!(rows, vec![(3, "three"), (1, "one"), (2, "two")]);

        let mut missing = vec![(3, "three"), (1, "one")];
        assert!(!restore_analytics_candidate_order(&mut missing, &[3, 1, 2]));
    }

    #[tokio::test]
    async fn inbox_count_singleflight_coalesces_and_caches_successes() {
        let key = format!("singleflight-test-{}", Uuid::new_v4());
        let calls = Arc::new(AtomicUsize::new(0));
        let first_calls = calls.clone();
        let second_calls = calls.clone();
        let first = query_inbox_digest_singleflight(key.clone(), move || {
            let calls = first_calls.clone();
            async move {
                calls.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                Ok((7, None))
            }
        });
        let second = query_inbox_digest_singleflight(key.clone(), move || {
            let calls = second_calls.clone();
            async move {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok((8, None))
            }
        });

        let (first, second) = tokio::join!(first, second);
        assert_eq!(first.unwrap(), (7, None));
        assert_eq!(second.unwrap(), (7, None));
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        let cached =
            query_inbox_digest_singleflight(key, || async { Ok((9, None)) })
                .await
                .unwrap();
        assert_eq!(cached, (7, None));
    }

    #[serial]
    #[tokio::test]
    async fn inbox_digest_accepts_timestamp_with_time_zone() {
        let env = cleanup().await.unwrap();
        let digest = query_inbox_digest(
            env.dbx.clone(),
            "SELECT 1::bigint AS count, \
             TIMESTAMPTZ '2026-08-25 09:56:19+00' AS first_element_ts"
                .to_string(),
        )
        .await
        .unwrap();

        assert_eq!(
            digest,
            (
                1,
                Some(
                    NaiveDate::from_ymd_opt(2026, 8, 25)
                        .unwrap()
                        .and_hms_opt(9, 56, 19)
                        .unwrap()
                )
            )
        );
    }

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

    fn messages_by_id_default_req() -> InboxMessagesReq {
        InboxMessagesReq {
            highlight_points: Some(true),
            ..Default::default()
        }
    }

    #[serial]
    #[tokio::test]
    async fn inbox_item_context_includes_owner_message_without_group_row() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let now = Utc::now().naive_utc();
        let legacy_message_uid = Uuid::new_v4().to_string();
        let message = mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                body: Set(Some("owner direct link".to_string())),
                created_at: Set(now),
                timestamp: Set(Some(now)),
                sender: Set(Some(login.id.to_string())),
                message_uid: Set(Some(legacy_message_uid.clone())),
                datasource_group_id: Set(None),
                deleted: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_inbox_item(
            &env.dbx,
            sigint_inbox_item::ActiveModel {
                id: Set(message.id),
                datetime: Set(Some(now)),
                reviewed: Set(Some(true)),
                parsed_unit_v2: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let context =
            inbox_item_context_bl(&env, &login.id, &legacy_message_uid)
                .await
                .unwrap();

        assert_eq!(context.sigint_inbox_item_ids, vec![message.id]);
        assert_eq!(
            context.message.as_ref().map(|(id, _)| *id),
            Some(message.id)
        );
        assert_eq!(
            context
                .message
                .as_ref()
                .map(|(_, message)| message.text.as_str()),
            Some("owner direct link")
        );
        assert!(context.group_master_keys.is_empty());
        assert_eq!(
            context.since_ts,
            Some((now - Duration::minutes(15)).and_utc().timestamp_millis())
        );
        assert_eq!(
            context.till_ts,
            Some((now + Duration::minutes(15)).and_utc().timestamp_millis())
        );
    }

    #[test]
    fn inbox_window_preserves_filters_for_target_query() {
        let inbox_req = inbox_window_base_req(InboxMessagesReq {
            around_message_ref: Some("target".to_string()),
            selected_groups: Some(vec!["group-1".to_string()]),
            selected_freqs: Some(vec!["123.45".to_string()]),
            selected_networks: Some(vec![7]),
            selected_senders: Some(vec!["sender-1".to_string()]),
            selected_tags: Some(vec![1]),
            only_with_media: Some(true),
            without_network: Some(false),
            ..Default::default()
        });

        assert_eq!(
            inbox_req.selected_groups,
            Some(vec!["group-1".to_string()])
        );
        assert_eq!(inbox_req.selected_freqs, Some(vec!["123.45".to_string()]));
        assert_eq!(inbox_req.selected_networks, Some(vec![7]));
        assert_eq!(
            inbox_req.selected_senders,
            Some(vec!["sender-1".to_string()])
        );
        assert_eq!(inbox_req.selected_tags, Some(vec![1]));
        assert_eq!(inbox_req.only_with_media, Some(true));
        assert!(inbox_req.around_message_ref.is_none());

        let target_req = inbox_window_target_req(&inbox_req);
        assert_eq!(target_req.selected_groups, inbox_req.selected_groups);
        assert_eq!(target_req.selected_freqs, inbox_req.selected_freqs);
        assert_eq!(target_req.selected_networks, inbox_req.selected_networks);
        assert_eq!(target_req.selected_senders, inbox_req.selected_senders);
        assert_eq!(target_req.selected_tags, inbox_req.selected_tags);
        assert_eq!(target_req.only_with_media, inbox_req.only_with_media);
        assert_eq!(target_req.load_latest, Some(true));
    }

    #[test]
    fn around_message_ref_enables_bidirectional_mode() {
        let mut req = InboxMessagesReq {
            page_id: Some(RER_DUTY_NEO_PAGE_ID.to_string()),
            ..Default::default()
        };

        assert!(around_message_ref(&req).is_none());

        req.around_message_ref = Some("target".to_string());
        assert_eq!(around_message_ref(&req).as_deref(), Some("target"));
    }

    #[serial]
    #[tokio::test]
    async fn issue_2726_inbox_window_returns_twenty_messages_on_each_side() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let datasource_group =
            find_test_datasource_group(&env.dbx).await.unwrap();
        let now = Utc::now().naive_utc();
        let mut target = None;

        for offset in 0..43 {
            let timestamp = now + Duration::seconds(offset);
            let message = mk_signal_message(
                &env.dbx,
                signal_message::ActiveModel {
                    body: Set(Some(format!("window-{offset}"))),
                    created_at: Set(timestamp),
                    timestamp: Set(Some(timestamp)),
                    sender: Set(Some(login.id.to_string())),
                    message_uid: Set(Some(format!(
                        "window-{}-{offset}",
                        Uuid::new_v4()
                    ))),
                    datasource_group_id: Set(Some(datasource_group.id)),
                    deleted: Set(false),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            mk_signal_message_group(
                &env.dbx,
                signal_message_group::ActiveModel {
                    signal_message_id: Set(message.id),
                    group_master_key: Set(Some(
                        datasource_group.group_master_key.clone(),
                    )),
                    sender: Set(message.sender.clone()),
                    message_uid: Set(message.message_uid.clone()),
                    datasource_group_id: Set(Some(datasource_group.id)),
                    created_at: Set(timestamp),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            mk_sigint_inbox_item(
                &env.dbx,
                sigint_inbox_item::ActiveModel {
                    id: Set(message.id),
                    datetime: Set(Some(timestamp)),
                    checked: Set(Some(true)),
                    reviewed: Set(Some(true)),
                    parsed_unit_v2: Set(false),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            if offset == 21 {
                target = Some((message.id, message.id_uuid.unwrap()));
            }
        }

        let (target_message_id, target_message_uuid) = target.unwrap();
        let logins =
            crate::users::get_organism_login_ids_by_id(&env.dbx, &login.id)
                .await
                .unwrap();
        let window = inbox_window_bl(
            &env,
            &login.id,
            &logins,
            false,
            &target_message_uuid.to_string(),
            InboxMessagesReq::default(),
        )
        .await
        .unwrap()
        .unwrap();

        assert_eq!(window.target_message_id, target_message_id);
        assert_eq!(window.inbox.inbox_items.len(), 41);
        assert_eq!(window.inbox.inbox_items[20].0, target_message_id);
        assert_eq!(window.inbox.inbox_items[20].1.text, "window-21");
        assert_eq!(window.messages_before, 21);
        assert_eq!(window.messages_after, 21);
        assert!(window.has_more_before);
        assert!(window.has_more_after);
        assert!(window
            .inbox
            .inbox_items
            .windows(2)
            .all(|messages| messages[0].0 < messages[1].0));

        let filtered_window = inbox_window_bl(
            &env,
            &login.id,
            &logins,
            false,
            &target_message_uuid.to_string(),
            InboxMessagesReq {
                selected_groups: Some(vec!["other-group".to_string()]),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        assert!(filtered_window.is_none());

        let sender_filtered_window = inbox_window_bl(
            &env,
            &login.id,
            &logins,
            false,
            &target_message_uuid.to_string(),
            InboxMessagesReq {
                selected_senders: Some(vec!["other-sender".to_string()]),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        assert!(sender_filtered_window.is_none());
    }

    fn generic_submit_req() -> InboxSubmitItem {
        let now = Utc::now().naive_utc();
        InboxSubmitItem {
            text: Some("generic datasource gate".to_string()),
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
    fn agent_inbox_requires_ordered_bounded_dates() {
        let valid = InboxMessagesReq {
            since_date_inclusive_ms: Some(
                "2026-10-01T21:00:00Z"
                    .parse::<DateTime<Utc>>()
                    .unwrap()
                    .timestamp_millis(),
            ),
            till_date_inclusive_ms: Some(
                "2026-11-01T21:59:59.999Z"
                    .parse::<DateTime<Utc>>()
                    .unwrap()
                    .timestamp_millis(),
            ),
            newest_first: Some(true),
            before_id_noninclusive: Some(42),
            ..Default::default()
        };
        validate_agent_inbox_request(&valid).unwrap();

        let mut invalid = valid.clone();
        invalid.since_date_inclusive_ms = None;
        assert!(validate_agent_inbox_request(&invalid).is_err());

        let mut invalid = valid.clone();
        invalid.since_date_inclusive_ms =
            invalid.till_date_inclusive_ms.map(|value| value + 1);
        assert!(validate_agent_inbox_request(&invalid).is_err());

        let mut invalid = valid;
        invalid.till_date_inclusive_ms = Some(
            "2026-11-02T21:59:59.999Z"
                .parse::<DateTime<Utc>>()
                .unwrap()
                .timestamp_millis(),
        );
        assert!(validate_agent_inbox_request(&invalid).is_err());
    }

    #[test]
    fn agent_inbox_forbids_limit_bypasses() {
        let valid = InboxMessagesReq {
            since_date_inclusive_ms: Some(1_700_000_000_000),
            till_date_inclusive_ms: Some(1_700_086_400_000),
            ..Default::default()
        };

        let mut invalid = valid.clone();
        invalid.nolimit = Some(false);
        assert!(validate_agent_inbox_request(&invalid).is_err());

        let mut invalid = valid;
        invalid.load_latest = Some(false);
        assert!(validate_agent_inbox_request(&invalid).is_err());
    }

    #[test]
    fn submit_dmr_metadata_model_stringifies_numeric_ids_for_storage() {
        let metadata = submit_dmr_metadata(Some(5));

        let metadata = submit_dmr_metadata_model(42, None, &metadata);

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
            signal_name: Some("dmr".to_string()),
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
            full_body: Some("Повне повідомлення".to_string()),
            text: Some("рос абонент ЯРУС викликав СВЕТЛЫЙ".to_string()),
            comment: Some("Коментар".to_string()),
            group_names: Some(vec![" ".to_string()]),
            ..Default::default()
        };

        assert!(validate_generic_submit_item(&item).is_err());
    }

    #[test]
    fn validate_generic_submit_item_rejects_missing_message_text() {
        let item = InboxSubmitItem {
            text: Some(" ".to_string()),
            group_names: Some(vec!["SC1".to_string()]),
            ..Default::default()
        };

        let err = validate_generic_submit_item(&item).unwrap_err();
        let AppError::Form(errors) = err else {
            panic!("expected form error");
        };
        assert_eq!(
            errors.get("text").map(String::as_str),
            Some("Inbox submit requires message text")
        );
    }

    #[test]
    fn generic_submit_item_to_inbox_message_uses_array_fields() {
        let item = InboxSubmitItem {
            full_body: Some("Повне повідомлення".to_string()),
            text: Some("рос абонент ЯРУС викликав СВЕТЛЫЙ".to_string()),
            comment: Some("Коментар".to_string()),
            timestamp: "2026-06-25T12:34:56Z".to_string(),
            coords: vec![
                GeoCoordinates {
                    lat: 49.12345,
                    lon: 37.12345,
                },
                GeoCoordinates {
                    lat: 50.0,
                    lon: 38.0,
                },
            ],
            locations: vec![
                "ЛИМАН ПЕРШИЙ".to_string(),
                " ".to_string(),
                "КОПАНІ".to_string(),
            ],
            from_callsign: Some(" ЯРУС ".to_string()),
            to: vec!["СВЕТЛЫЙ".to_string(), " ".to_string()],
            dmr: vec![SubmitDmrMetadata {
                timestamp: "2026-06-25T12:34:56Z".to_string(),
                cc: Some(5),
                freq: "145.02678".to_string(),
                signal_name: "dmr".to_string(),
                sender_name: Some("ярус".to_string()),
                call_group_name: Some(" ВОСТОК ".to_string()),
                ..submit_dmr_metadata(None)
            }],
            ..Default::default()
        };

        let (message, timestamp) =
            generic_submit_item_to_inbox_message(&item, false).unwrap();

        assert_eq!(
            timestamp,
            NaiveDate::from_ymd_opt(2026, 6, 25)
                .unwrap()
                .and_hms_opt(12, 34, 56)
                .unwrap()
        );
        assert_eq!(
            message.coords.as_deref(),
            Some("49.12345, 37.12345\n50, 38")
        );
        assert_eq!(message.text, "Повне повідомлення");
        assert_eq!(message.extended_form.as_deref(), Some("Коментар"));
        assert_eq!(
            message
                .no_headers_body
                .as_ref()
                .map(|body| body.body.as_str()),
            Some("рос абонент ЯРУС викликав СВЕТЛЫЙ")
        );
        assert_eq!(message.location.as_deref(), Some("ЛИМАН ПЕРШИЙ, КОПАНІ"));
        assert_eq!(
            message.callsigns,
            vec![
                "ЯРУС".to_string(),
                "СВЕТЛЫЙ".to_string(),
                "ВОСТОК".to_string()
            ]
        );
    }

    #[test]
    fn prepare_submit_body_for_coordinate_extraction_preserves_explicit_body() {
        let mut message = InboxMessage::from(InboxInsertPayload {
            text: "Отримано з поста \"SC1\"\nТекст повідомлення".to_string(),
            coords: Some(" 49.12345, 37.12345 ".to_string()),
            no_headers_body: Some(
                crate::rer_importer::body_noheader::NoHeadersBody {
                    body: "47.11111, 37.22222".to_string(),
                    start: 0,
                    end: 18,
                },
            ),
            ..Default::default()
        });

        prepare_submit_body_for_coordinate_extraction(&mut message).unwrap();

        assert_eq!(message.coords.as_deref(), Some("49.12345, 37.12345"));
        assert_eq!(
            message
                .no_headers_body
                .as_ref()
                .map(|body| body.body.as_str()),
            Some("47.11111, 37.22222")
        );
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
        let logins = vec![login.id];

        let rsp = submit_legacy_inbox_messages(
            &env_data,
            &login.id,
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
    async fn test_legacy_submit_preserves_typed_location_v2() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let now = Utc::now().naive_utc();
        let message = mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                body: Set(Some("legacy typed location".to_string())),
                created_at: Set(now),
                timestamp: Set(Some(now)),
                sender: Set(Some("legacy typed sender".to_string())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let inbox_message = InboxMessage::from(InboxInsertPayload {
            text: "legacy typed location".to_string(),
            location: Some("Робоботине".to_string()),
            ..Default::default()
        });
        let logins = vec![login.id];
        let txn = env.dbx.begin().await.unwrap();

        submit_upsert_inbox_item(
            env.settlements.clone(),
            &txn,
            message.id,
            &inbox_message,
            &login.id,
            &logins,
            InboxLocationSubmitMode::PreserveTyped,
            true,
            false,
        )
        .await
        .unwrap();
        txn.commit().await.unwrap();

        let inbox_item = sigint_inbox_item::Entity::find_by_id(message.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(inbox_item.location.as_deref(), Some("Робоботине"));
        assert_eq!(inbox_item.location_v2.as_deref(), Some("|Робоботине|"));
    }

    #[serial]
    #[tokio::test]
    async fn test_submit_upsert_synchronizes_datetime_on_create_and_edit() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let message = mk_signal_message(&env.dbx, Default::default())
            .await
            .unwrap();
        let logins = vec![login.id];

        for (date, time, expected) in [
            (
                "2026-01-15",
                "12:34",
                NaiveDate::from_ymd_opt(2026, 1, 15)
                    .unwrap()
                    .and_hms_opt(10, 34, 0)
                    .unwrap(),
            ),
            (
                "2026-01-15",
                "12:34:56",
                NaiveDate::from_ymd_opt(2026, 1, 15)
                    .unwrap()
                    .and_hms_opt(10, 34, 56)
                    .unwrap(),
            ),
            (
                "2026-07-15",
                "12:34:56",
                NaiveDate::from_ymd_opt(2026, 7, 15)
                    .unwrap()
                    .and_hms_opt(9, 34, 56)
                    .unwrap(),
            ),
            (
                "2024-03-31",
                "03:30:00",
                NaiveDate::from_ymd_opt(2024, 3, 31)
                    .unwrap()
                    .and_hms_opt(1, 30, 0)
                    .unwrap(),
            ),
            (
                "2024-10-27",
                "03:30:00",
                NaiveDate::from_ymd_opt(2024, 10, 27)
                    .unwrap()
                    .and_hms_opt(1, 30, 0)
                    .unwrap(),
            ),
        ] {
            let txn = env.dbx.begin().await.unwrap();
            submit_upsert_inbox_item(
                env.settlements.clone(),
                &txn,
                message.id,
                &InboxMessage::from(InboxInsertPayload {
                    text: "datetime submit".to_string(),
                    date: Some(date.to_string()),
                    time: Some(time.to_string()),
                    ..Default::default()
                }),
                &login.id,
                &logins,
                InboxLocationSubmitMode::PreserveTyped,
                true,
                false,
            )
            .await
            .unwrap();
            txn.commit().await.unwrap();

            let inbox_item = sigint_inbox_item::Entity::find_by_id(message.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(inbox_item.datetime, Some(expected));
        }
    }

    // Regression for ECHO-3207: edits invalidate pre-update network activity.
    #[serial]
    #[tokio::test]
    async fn test_submit_upsert_invalidates_old_frequency_last_seen() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let timestamp = Utc::now().naive_utc() - Duration::hours(1);
        let old_freq = "146.4500";
        let new_freq = "147.4500";
        let message = mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                timestamp: Set(Some(timestamp)),
                created_at: Set(timestamp),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let inbox_item = mk_sigint_inbox_item(
            &env.dbx,
            sigint_inbox_item::ActiveModel {
                id: Set(message.id),
                freq: Set(Some(old_freq.to_string())),
                datetime: Set(Some(timestamp)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let network = mk_sigint_network(&env.dbx, Default::default())
            .await
            .unwrap();
        let network_freq = mk_sigint_network_freq(
            &env.dbx,
            sigint_network_freq::ActiveModel {
                network_id: Set(network.id),
                freq: Set(old_freq.to_string()),
                active_from: Set(timestamp - Duration::days(1)),
                last_seen_dt: Set(Some(timestamp)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_inbox_item_network(
            &env.dbx,
            sigint_inbox_item_network::ActiveModel {
                sigint_inbox_item_id: Set(inbox_item.id),
                sigint_network_id: Set(network.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let logins = vec![login.id];
        let txn = env.dbx.begin().await.unwrap();

        submit_upsert_inbox_item(
            env.settlements.clone(),
            &txn,
            message.id,
            &InboxMessage::from(InboxInsertPayload {
                text: "frequency edit".to_string(),
                freq: Some(new_freq.to_string()),
                ..Default::default()
            }),
            &login.id,
            &logins,
            InboxLocationSubmitMode::PreserveTyped,
            true,
            false,
        )
        .await
        .unwrap();
        txn.commit().await.unwrap();

        let inbox_item = sigint_inbox_item::Entity::find_by_id(message.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        let network_freq =
            sigint_network_freq::Entity::find_by_id(network_freq.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(inbox_item.freq.as_deref(), Some(new_freq));
        assert_eq!(network_freq.last_seen_dt, None);
    }

    // Regression for ECHO-3207: clear the old fallback before changing it.
    #[serial]
    #[tokio::test]
    async fn test_submit_update_invalidates_timestamp_fallback_before_edit() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let old_timestamp = Utc::now().naive_utc() - Duration::hours(2);
        let new_timestamp = old_timestamp + Duration::hours(1);
        let freq = "146.4500";
        let message = mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                timestamp: Set(Some(old_timestamp)),
                created_at: Set(old_timestamp),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let inbox_item = mk_sigint_inbox_item(
            &env.dbx,
            sigint_inbox_item::ActiveModel {
                id: Set(message.id),
                freq: Set(Some(freq.to_string())),
                datetime: Set(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let network = mk_sigint_network(&env.dbx, Default::default())
            .await
            .unwrap();
        let network_freq = mk_sigint_network_freq(
            &env.dbx,
            sigint_network_freq::ActiveModel {
                network_id: Set(network.id),
                freq: Set(freq.to_string()),
                active_from: Set(old_timestamp - Duration::days(1)),
                last_seen_dt: Set(Some(old_timestamp)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_inbox_item_network(
            &env.dbx,
            sigint_inbox_item_network::ActiveModel {
                sigint_inbox_item_id: Set(inbox_item.id),
                sigint_network_id: Set(network.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let txn = env.dbx.begin().await.unwrap();

        update_submit_signal_message(
            &txn,
            &env.config,
            message.id,
            &login.id,
            &InboxMessage::from(InboxInsertPayload {
                text: "timestamp edit".to_string(),
                ..Default::default()
            }),
            Some(new_timestamp),
            None,
            &[],
        )
        .await
        .unwrap();
        txn.commit().await.unwrap();

        let network_freq =
            sigint_network_freq::Entity::find_by_id(network_freq.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(network_freq.last_seen_dt, None);
    }

    #[serial]
    #[tokio::test]
    async fn test_submit_parse_location_v2_keeps_parser_behavior() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let now = Utc::now().naive_utc();
        let message = mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                body: Set(Some("generic parsed location".to_string())),
                created_at: Set(now),
                timestamp: Set(Some(now)),
                sender: Set(Some("generic parsed sender".to_string())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let inbox_message = InboxMessage::from(InboxInsertPayload {
            text: "generic parsed location".to_string(),
            location: Some("Робоботине".to_string()),
            ..Default::default()
        });
        let logins = vec![login.id];
        let txn = env.dbx.begin().await.unwrap();

        submit_upsert_inbox_item(
            env.settlements.clone(),
            &txn,
            message.id,
            &inbox_message,
            &login.id,
            &logins,
            InboxLocationSubmitMode::Parse,
            true,
            false,
        )
        .await
        .unwrap();
        txn.commit().await.unwrap();

        let inbox_item = sigint_inbox_item::Entity::find_by_id(message.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(inbox_item.location.as_deref(), Some("Робоботине"));
        assert_eq!(inbox_item.location_v2.as_deref(), Some("|РОБОТИНЕ|"));
    }

    #[serial]
    #[tokio::test]
    async fn test_submit_upsert_extended_form_updates_same_organism_comment() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let peer_login = mk_login(
            &env.dbx,
            login::ActiveModel {
                id: NotSet,
                login: Set("LegacySubmitPeer".to_string()),
                organism_id: Set(login.organism_id),
                sigint_zone_id: Set(login.sigint_zone_id),
                created_at: Set(Utc::now().naive_utc()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let datasource_group =
            find_test_datasource_group(&env.dbx).await.unwrap();
        let now = Utc::now().naive_utc();
        let message = mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                body: Set(Some("legacy submit peer comment".to_string())),
                created_at: Set(now),
                timestamp: Set(Some(now)),
                sender: Set(Some("legacy peer sender".to_string())),
                message_uid: Set(None),
                datasource_group_id: Set(Some(datasource_group.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_comment(
            &env.dbx,
            sigint_comment::ActiveModel {
                login_id: Set(peer_login.id),
                signal_message_id: Set(message.id),
                comment: Set("peer comment must stay".to_string()),
                created_at: Set(Utc::now().naive_utc()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let inbox_message = InboxMessage::from(InboxInsertPayload {
            text: "legacy submit current comment".to_string(),
            extended_form: Some("current user comment".to_string()),
            group_master_key: Some(datasource_group.group_master_key.clone()),
            sender: Some("legacy peer sender".to_string()),
            ..Default::default()
        });
        let logins = vec![login.id, peer_login.id];
        let txn = env.dbx.begin().await.unwrap();

        submit_upsert_inbox_item(
            env.settlements.clone(),
            &txn,
            message.id,
            &inbox_message,
            &login.id,
            &logins,
            InboxLocationSubmitMode::PreserveTyped,
            true,
            false,
        )
        .await
        .unwrap();
        txn.commit().await.unwrap();

        let peer_comment = sigint_comment::Entity::find()
            .filter(sigint_comment::Column::SignalMessageId.eq(message.id))
            .filter(sigint_comment::Column::LoginId.eq(peer_login.id))
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(peer_comment.comment, "current user comment");

        let current_comment_count = sigint_comment::Entity::find()
            .filter(sigint_comment::Column::SignalMessageId.eq(message.id))
            .filter(sigint_comment::Column::LoginId.eq(login.id))
            .count(&env.dbx)
            .await
            .unwrap();
        assert_eq!(current_comment_count, 0);
    }

    #[serial]
    #[tokio::test]
    async fn test_upsert_editable_comment_merges_same_organism_duplicates() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let peer_login = mk_login(
            &env.dbx,
            login::ActiveModel {
                id: NotSet,
                login: Set(format!("CommentMergePeer{}", Uuid::new_v4())),
                organism_id: Set(login.organism_id),
                sigint_zone_id: Set(login.sigint_zone_id),
                created_at: Set(Utc::now().naive_utc()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let now = Utc::now().naive_utc();
        let message = mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                body: Set(Some("merge same organism comments".to_string())),
                created_at: Set(now),
                timestamp: Set(Some(now)),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        mk_sigint_comment(
            &env.dbx,
            sigint_comment::ActiveModel {
                login_id: Set(peer_login.id),
                signal_message_id: Set(message.id),
                comment: Set("peer old".to_string()),
                created_at: Set(now - Duration::minutes(2)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_comment(
            &env.dbx,
            sigint_comment::ActiveModel {
                login_id: Set(login.id),
                signal_message_id: Set(message.id),
                comment: Set("current old".to_string()),
                created_at: Set(now - Duration::minutes(1)),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let logins = vec![login.id, peer_login.id];
        upsert_editable_sigint_comment(
            &env.dbx,
            message.id,
            message.id_uuid,
            &login.id,
            &logins,
            "merged comment",
        )
        .await
        .unwrap();

        let comments = sigint_comment::Entity::find()
            .filter(sigint_comment::Column::SignalMessageId.eq(message.id))
            .all(&env.dbx)
            .await
            .unwrap();
        assert_eq!(comments.len(), 1);
        assert_eq!(comments[0].login_id, login.id);
        assert_eq!(comments[0].comment, "merged comment");
    }

    #[serial]
    #[tokio::test]
    async fn test_delete_editable_comments_removes_same_organism_duplicates_only(
    ) {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let peer_login = mk_login(
            &env.dbx,
            login::ActiveModel {
                id: NotSet,
                login: Set(format!("CommentDeletePeer{}", Uuid::new_v4())),
                organism_id: Set(login.organism_id),
                sigint_zone_id: Set(login.sigint_zone_id),
                created_at: Set(Utc::now().naive_utc()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let other_organism = mk_organism(
            &env.dbx,
            organism::ActiveModel {
                name: Set(format!("CommentDeleteOtherOrg{}", Uuid::new_v4())),
                enabled: Set(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let other_login = mk_login(
            &env.dbx,
            login::ActiveModel {
                id: NotSet,
                login: Set(format!("CommentDeleteOther{}", Uuid::new_v4())),
                organism_id: Set(Some(other_organism.id)),
                sigint_zone_id: Set(login.sigint_zone_id),
                created_at: Set(Utc::now().naive_utc()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let now = Utc::now().naive_utc();
        let message = mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                body: Set(Some("delete same organism comments".to_string())),
                created_at: Set(now),
                timestamp: Set(Some(now)),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        for (login_value, comment) in [
            (login.id, "current comment"),
            (peer_login.id, "peer comment"),
            (other_login.id, "other comment"),
        ] {
            mk_sigint_comment(
                &env.dbx,
                sigint_comment::ActiveModel {
                    login_id: Set(login_value),
                    signal_message_id: Set(message.id),
                    comment: Set(comment.to_string()),
                    created_at: Set(now),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        }

        let logins = vec![login.id, peer_login.id];
        delete_editable_sigint_comments(
            &env.dbx, message.id, &login.id, &logins,
        )
        .await
        .unwrap();

        let comments = sigint_comment::Entity::find()
            .filter(sigint_comment::Column::SignalMessageId.eq(message.id))
            .all(&env.dbx)
            .await
            .unwrap();
        assert_eq!(comments.len(), 1);
        assert_eq!(comments[0].login_id, other_login.id);
        assert_eq!(comments[0].comment, "other comment");
    }

    #[serial]
    #[tokio::test]
    async fn test_generic_external_submit_creates_message_groups_inbox_metadata_and_warnings(
    ) {
        let env = cleanup().await.unwrap();
        let env_data = Data::from(env.clone());
        let login = find_test_login(&env.dbx).await.unwrap();
        let datasource = find_test_datasource(&env.dbx).await.unwrap();
        let logins = vec![login.id];
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
            full_body: Some("рос абонент ЯРУС викликав СВЕТЛЫЙ".to_string()),
            text: Some("рос абонент ЯРУС викликав СВЕТЛЫЙ".to_string()),
            comment: Some("Сигнали: dmr".to_string()),
            freq: Some("145.02678".to_string()),
            coords: vec![
                GeoCoordinates {
                    lat: 49.12345,
                    lon: 37.12345,
                },
                GeoCoordinates {
                    lat: 49.22345,
                    lon: 37.22345,
                },
            ],
            from_callsign: Some("ЯРУС".to_string()),
            to: vec!["СВЕТЛЫЙ".to_string()],
            timestamp: submit_timestamp(now),
            sender: Some("generic submit".to_string()),
            post: Some("SC1".to_string()),
            tags: Some(operator_tags.clone()),
            locations: vec!["ЛИМАН ПЕРШИЙ".to_string(), "КОПАНІ".to_string()],
            group_names: Some(vec![
                "SC1".to_string(),
                "Чумак DMR Резерв".to_string(),
            ]),
            network: Some(SubmitNetwork {
                signal_name: Some("dmr".to_string()),
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
            &login.id,
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
        let message =
            signal_message::Entity::find_by_id(submitted.signal_message_id)
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
        assert!(groups
            .iter()
            .all(|group| { group.message_uid == message.message_uid }));
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
        let pelengs = sigint_peleng::Entity::find()
            .filter(
                sigint_peleng::Column::SourceInboxItemId.eq(submitted.inbox_id),
            )
            .order_by_asc(sigint_peleng::Column::Id)
            .all(&env.dbx)
            .await
            .unwrap();
        assert_eq!(pelengs.len(), 2);
        assert_eq!((pelengs[0].lat, pelengs[0].lng), (49.12345, 37.12345));
        assert_eq!((pelengs[1].lat, pelengs[1].lng), (49.22345, 37.22345));
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
            .filter(sigint_inbox_item_tag::Column::LoginId.eq(Some(login.id)))
            .all(&env.dbx)
            .await
            .unwrap();
        assert_eq!(inbox_tags.len(), 1);
        assert_eq!(inbox_tags[0].tag_id, tag.id);
    }

    #[serial]
    #[tokio::test]
    async fn adding_submit_group_requeues_existing_settlement_links() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let datasource = find_test_datasource(&env.dbx).await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let initial_groups = ensure_submit_groups(
            &txn,
            &datasource,
            &login.id,
            &["initial group".to_string()],
        )
        .await
        .unwrap();
        let message =
            mk_signal_message(&txn, Default::default()).await.unwrap();
        mk_sigint_inbox_item(
            &txn,
            sigint_inbox_item::ActiveModel {
                id: Set(message.id),
                parsed_unit_v2: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        ensure_submit_signal_message_groups(&txn, &message, &initial_groups)
            .await
            .unwrap();
        sigint_inbox_item_settlement::ActiveModel {
            item_id: Set(message.id),
            settlement_text: Set("retained location".to_string()),
            is_undefined: Set(Some(true)),
            ..Default::default()
        }
        .insert(&txn)
        .await
        .unwrap();
        let expanded_groups = ensure_submit_groups(
            &txn,
            &datasource,
            &login.id,
            &["initial group".to_string(), "added group".to_string()],
        )
        .await
        .unwrap();

        ensure_submit_signal_message_groups(&txn, &message, &expanded_groups)
            .await
            .unwrap();

        let link = sigint_inbox_item_settlement::Entity::find()
            .filter(sigint_inbox_item_settlement::Column::ItemId.eq(message.id))
            .one(&txn)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(link.settlement_id, None);
        assert_eq!(link.is_undefined, None);
        txn.rollback().await.unwrap();
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

        save_submit_dmr_metadata(
            inbox_item.id,
            inbox_item.id_uuid,
            None,
            vec![metadata],
            &txn,
        )
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
        datasource.api_login_id = Set(Some(login.id));
        datasource.enabled = Set(Some(false));
        datasource.deleted = Set(false);
        let datasource = datasource.update(&env.dbx).await.unwrap();
        let logins = vec![login.id];

        let err = submit_generic_inbox_message(
            &env_data,
            &login.id,
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
            &login.id,
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
            &login.id,
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
            Some(datasource.id),
            &login.id,
            Some(&uid),
            &message,
            Some(now),
            None,
            &groups,
            None,
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

        let inbox_item = mk_sigint_inbox_item(
            &env.dbx,
            sigint_inbox_item::ActiveModel {
                id: Set(message.id),
                freq: Set(Some("123.45".to_string())),
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

        if let Some(actor) = tag_logins.first() {
            crate::inbox::callsigns::sync(
                &env.dbx,
                inbox_item.id,
                inbox_item.id_uuid,
                crate::inbox::callsigns::InboxItemCallsigns {
                    primary: vec!["Alpha".to_string()],
                    alg2: Vec::new(),
                },
                actor.id,
            )
            .await
            .context(h!())?;
        }

        for login_model in tag_logins {
            sigint_inbox_item_tag::ActiveModel {
                sigint_inbox_item_id: Set(message.id),
                tag_id: Set(tag.id),
                confidence: Set(1.0),
                login_id: Set(Some(login_model.id)),
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
                signal_message_uuid: Set(message.id_uuid),
                content_type: Set(content_type.to_string()),
                file_ext: Set(None),
                file_name: Set(None),
                size_bytes: Set(1),
                is_encrypted: Set(true),
                storage_key: NotSet,
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
    async fn hybrid_inbox_revalidates_backdated_arrivals_and_lagged_deletions()
    {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let group = find_test_datasource_group(&env.dbx).await.unwrap();
        let first = seed_message_with_media(
            &env,
            &group,
            Some("image/png"),
            "hybrid-first",
        )
        .await
        .unwrap();
        let second =
            seed_message_with_media(&env, &group, None, "hybrid-second")
                .await
                .unwrap();
        let historical =
            seed_message_with_media(&env, &group, None, "hybrid-historical")
                .await
                .unwrap();
        let now = Utc::now().naive_utc();
        let event_time = now - Duration::days(30);
        let ids = vec![first.id, second.id, historical.id];
        sigint_inbox_item::Entity::update_many()
            .col_expr(
                sigint_inbox_item::Column::Datetime,
                Expr::value(event_time),
            )
            .filter(sigint_inbox_item::Column::Id.is_in(ids.clone()))
            .exec(&env.dbx)
            .await
            .unwrap();
        signal_message::Entity::update_many()
            .col_expr(
                signal_message::Column::CreatedAt,
                Expr::value(now - Duration::hours(1)),
            )
            .filter(signal_message::Column::Id.eq(historical.id))
            .exec(&env.dbx)
            .await
            .unwrap();
        let req = InboxMessagesReq {
            since_date_inclusive_ms: Some(
                (event_time - Duration::seconds(1))
                    .and_utc()
                    .timestamp_millis(),
            ),
            till_date_inclusive_ms: Some(
                (event_time + Duration::seconds(1))
                    .and_utc()
                    .timestamp_millis(),
            ),
            nolimit: Some(true),
            ..Default::default()
        };
        let tail_query = build_postgres_fresh_tail_inbox_digest_query(
            &login.id,
            &env,
            &req,
            now - Duration::minutes(5),
        )
        .await
        .unwrap();
        let tail_digest = query_inbox_digest(env.dbx.clone(), tail_query)
            .await
            .unwrap();
        assert_eq!(tail_digest, (2, first.timestamp));
        let tail = load_postgres_fresh_tail_inbox_candidates(
            &env.dbx,
            &login.id,
            &env,
            &req,
            now - Duration::minutes(5),
        )
        .await
        .unwrap();
        assert_eq!(tail, vec![first.id, second.id]);
        let candidates =
            merge_inbox_candidate_ids(vec![historical.id, first.id], tail);
        let rows = hydrate_hybrid_inbox_candidates(
            &login.id,
            &vec![login.id],
            &env,
            &req,
            &candidates,
            &mut InboxReadDiagnostics::new(None),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(rows.iter().map(|(id, _)| *id).collect::<Vec<_>>(), ids);
        signal_message::Entity::update_many()
            .col_expr(signal_message::Column::Deleted, Expr::value(true))
            .filter(signal_message::Column::Id.eq(first.id))
            .exec(&env.dbx)
            .await
            .unwrap();
        assert!(hydrate_hybrid_inbox_candidates(
            &login.id,
            &vec![login.id],
            &env,
            &req,
            &candidates,
            &mut InboxReadDiagnostics::new(None),
        )
        .await
        .unwrap()
        .is_none());
    }

    #[serial]
    #[tokio::test]
    async fn hybrid_inbox_preserves_messages_without_inbox_rows() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let group = find_test_datasource_group(&env.dbx).await.unwrap();
        let first = seed_message_with_media(&env, &group, None, "with-inbox")
            .await
            .unwrap();
        let second =
            seed_message_with_media(&env, &group, None, "without-inbox")
                .await
                .unwrap();
        sigint_inbox_item::Entity::delete_by_id(second.id)
            .exec(&env.dbx)
            .await
            .unwrap();
        signal_message::Entity::update_many()
            .col_expr(
                signal_message::Column::Timestamp,
                Expr::value(first.timestamp),
            )
            .filter(signal_message::Column::Id.eq(second.id))
            .exec(&env.dbx)
            .await
            .unwrap();
        let candidates = vec![second.id, first.id];
        for sort_by in [
            InboxMessagesSortBy::IMSDatetime,
            InboxMessagesSortBy::IMSTimestamp,
        ] {
            for load_latest in [false, true] {
                if sort_by == InboxMessagesSortBy::IMSDatetime && !load_latest {
                    continue;
                }
                let req = InboxMessagesReq {
                    sort_by: Some(sort_by),
                    load_latest: Some(load_latest),
                    since_date_inclusive_ms: (sort_by
                        == InboxMessagesSortBy::IMSTimestamp)
                        .then_some(
                            first
                                .timestamp
                                .unwrap()
                                .and_utc()
                                .timestamp_millis()
                                - 1000,
                        ),
                    nolimit: Some(true),
                    ..Default::default()
                };
                let primary =
                    get_inbox_messages(&login.id, &vec![login.id], &env, &req)
                        .await
                        .unwrap();
                assert_eq!(primary.len(), 2);
                let hybrid = hydrate_hybrid_inbox_candidates(
                    &login.id,
                    &vec![login.id],
                    &env,
                    &req,
                    &candidates,
                    &mut InboxReadDiagnostics::new(None),
                )
                .await
                .unwrap()
                .expect("authorized messages without inbox rows must survive ordering");
                assert_eq!(
                    serde_json::to_value(hybrid).unwrap(),
                    serde_json::to_value(primary).unwrap()
                );
            }
        }
        signal_message::Entity::update_many()
            .col_expr(signal_message::Column::Deleted, Expr::value(true))
            .filter(signal_message::Column::Id.eq(second.id))
            .exec(&env.dbx)
            .await
            .unwrap();
        assert!(hydrate_hybrid_inbox_candidates(
            &login.id,
            &vec![login.id],
            &env,
            &InboxMessagesReq {
                load_latest: Some(true),
                ..Default::default()
            },
            &candidates,
            &mut InboxReadDiagnostics::new(None),
        )
        .await
        .unwrap()
        .is_none());
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

        let logins = vec![login.id];
        let base_req = InboxMessagesReq {
            nolimit: Some(true),
            load_latest: Some(true),
            ..Default::default()
        };

        let all_messages =
            get_inbox_messages(&login.id, &logins, &env, &base_req)
                .await
                .unwrap();
        assert_eq!(all_messages.len(), 5);

        let false_req = InboxMessagesReq {
            only_with_media: Some(false),
            ..base_req.clone()
        };
        let false_messages =
            get_inbox_messages(&login.id, &logins, &env, &false_req)
                .await
                .unwrap();
        assert_eq!(false_messages.len(), 5);

        let media_req = InboxMessagesReq {
            only_with_media: Some(true),
            ..base_req
        };
        let media_messages =
            get_inbox_messages(&login.id, &logins, &env, &media_req)
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
    async fn inbox_media_includes_only_completed_audio_transcriptions() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let settings = system_settings::ActiveModel {
            enable_audio_transcription: Set(true),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let datasource_group =
            find_test_datasource_group(&env.dbx).await.unwrap();
        let audio_message = seed_message_with_media(
            &env,
            &datasource_group,
            Some("audio/ogg"),
            "transcribed-audio",
        )
        .await
        .unwrap();
        let image_message = seed_message_with_media(
            &env,
            &datasource_group,
            Some("image/png"),
            "transcribed-image",
        )
        .await
        .unwrap();
        let media = signal_message_media::Entity::find()
            .filter(
                signal_message_media::Column::SignalMessageId
                    .is_in([audio_message.id, image_message.id]),
            )
            .all(&env.dbx)
            .await
            .unwrap();
        for media in &media {
            echo_gpu_transcription_queue::ActiveModel {
                source_id: Set(media.id),
                state: Set(echo_gpu_client::QueueState::Completed
                    .as_str()
                    .to_string()),
                transcribed_value: Set(Some(format!(
                    "transcription for {}",
                    media.content_type
                ))),
                ..Default::default()
            }
            .insert(&env.dbx)
            .await
            .unwrap();
        }

        let logins = vec![login.id];
        let messages = messages_by_id_bl(
            &login.id,
            &logins,
            &env,
            &[audio_message.id, image_message.id],
            &messages_by_id_default_req(),
        )
        .await
        .unwrap();
        let audio = messages
            .iter()
            .find(|(id, _)| *id == audio_message.id)
            .unwrap();
        let image = messages
            .iter()
            .find(|(id, _)| *id == image_message.id)
            .unwrap();

        assert_eq!(
            audio.1.media[0].transcription.as_deref(),
            Some("transcription for audio/ogg")
        );
        assert_eq!(image.1.media[0].transcription, None);

        let mut settings: system_settings::ActiveModel = settings.into();
        settings.enable_audio_transcription = Set(false);
        settings.update(&env.dbx).await.unwrap();
        let messages = messages_by_id_bl(
            &login.id,
            &logins,
            &env,
            &[audio_message.id],
            &messages_by_id_default_req(),
        )
        .await
        .unwrap();
        assert_eq!(messages[0].1.media[0].transcription, None);
    }

    #[serial]
    #[tokio::test]
    async fn test_inbox_reads_respect_reduced_organism_groups() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let datasource = find_test_datasource(&env.dbx).await.unwrap();
        let datasource_group =
            find_test_datasource_group(&env.dbx).await.unwrap();
        let aor = find_test_aor(&env.dbx).await.unwrap();
        let sigint_zone = find_test_sigint_zone(&env.dbx).await.unwrap();
        let now = Utc::now().naive_utc();

        let other_group = mk_signal_group(
            &env.dbx,
            signal_group::ActiveModel {
                master_key: Set(format!(
                    "map-hidden-group-{}",
                    now.and_utc().timestamp_millis()
                )),
                datasource_id: Set(Some(datasource.id)),
                deleted: Set(false),
                name: Set(Some("Map Hidden Group".to_string())),
                created_at: Set(now),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let other_datasource_group = mk_datasource_group(
            &env.dbx,
            datasource_group::ActiveModel {
                datasource_id: Set(datasource.id),
                group_master_key: Set(other_group.master_key.clone()),
                name: Set("Map Hidden Group".to_string()),
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
                sigint_zone_id: Set(sigint_zone.id),
                datasource_id: Set(datasource.id),
                group_master_key: Set(other_group.master_key.clone()),
                created_at: Set(now),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_signal_group_aor(
            &env.dbx,
            signal_group_aor::ActiveModel {
                master_key: Set(other_group.master_key.clone()),
                aor_id: Set(aor.id),
                created_at: Set(now),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let visible_message =
            seed_message_with_media(&env, &datasource_group, None, "visible")
                .await
                .unwrap();
        let no_peleng_message = seed_message_with_media(
            &env,
            &datasource_group,
            None,
            "without-peleng",
        )
        .await
        .unwrap();
        let hidden_message = seed_message_with_media(
            &env,
            &other_datasource_group,
            None,
            "hidden",
        )
        .await
        .unwrap();
        for (message_id, lat, lng) in [
            (visible_message.id, 50.0, 30.0),
            (hidden_message.id, 51.0, 31.0),
        ] {
            sigint_peleng::ActiveModel {
                source_inbox_item_id: Set(message_id),
                lat: Set(lat),
                lng: Set(lng),
                created_at: Set(now),
                deleted: Set(false),
                ..Default::default()
            }
            .insert(&env.dbx)
            .await
            .unwrap();
        }

        let req = InboxMessagesReq {
            nolimit: Some(true),
            load_latest: Some(true),
            ..Default::default()
        };
        let initial_items =
            get_inbox_map_items(&login.id, &env, &req).await.unwrap();
        assert!(initial_items
            .iter()
            .any(|item| item.id == visible_message.id));
        assert!(initial_items
            .iter()
            .any(|item| item.id == hidden_message.id));
        assert!(!initial_items
            .iter()
            .any(|item| item.id == no_peleng_message.id));

        organism_group::ActiveModel {
            organism_id: Set(login.organism_id.unwrap()),
            signal_group_master_key: Set(datasource_group
                .group_master_key
                .clone()),
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        let reduced_items =
            get_inbox_map_items(&login.id, &env, &req).await.unwrap();
        assert!(reduced_items
            .iter()
            .any(|item| item.id == visible_message.id));
        assert!(!reduced_items
            .iter()
            .any(|item| item.id == hidden_message.id));

        let pelengs = crate::location::peleng::collect_inbox_item_pelengs(
            &reduced_items,
            &env.dbx,
        )
        .await
        .unwrap();
        let map_points = collect_map_points(reduced_items, pelengs).unwrap();
        assert!(map_points
            .iter()
            .any(|point| point.message_id == visible_message.id));
        assert!(!map_points
            .iter()
            .any(|point| point.message_id == hidden_message.id));

        let logins = vec![login.id];
        let loaded_messages =
            get_inbox_messages(&login.id, &logins, &env, &req)
                .await
                .unwrap();
        assert!(loaded_messages
            .iter()
            .any(|(id, _)| *id == visible_message.id));
        assert!(!loaded_messages
            .iter()
            .any(|(id, _)| *id == hidden_message.id));

        let hidden_messages = messages_by_id_bl(
            &login.id,
            &logins,
            &env,
            &[hidden_message.id],
            &messages_by_id_default_req(),
        )
        .await
        .unwrap();
        assert!(hidden_messages.is_empty());

        signal_message_group::ActiveModel {
            signal_message_id: Set(hidden_message.id),
            group_master_key: Set(Some(
                datasource_group.group_master_key.clone(),
            )),
            datasource_group_id: Set(Some(datasource_group.id)),
            created_at: Set(now),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        let secondary_group_messages = messages_by_id_bl(
            &login.id,
            &logins,
            &env,
            &[hidden_message.id],
            &messages_by_id_default_req(),
        )
        .await
        .unwrap();
        assert_eq!(secondary_group_messages.len(), 1);
        assert_eq!(secondary_group_messages[0].0, hidden_message.id);
    }

    #[serial]
    #[tokio::test]
    async fn test_messages_by_id_deduplicates_flat_tags() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let tag = find_test_bpla_tag(&env.dbx).await.unwrap();
        let datasource_group =
            find_test_datasource_group(&env.dbx).await.unwrap();
        let peer_login = mk_login(
            &env.dbx,
            login::ActiveModel {
                id: NotSet,
                login: Set("DuplicateTagPeer".to_string()),
                organism_id: Set(login.organism_id),
                sigint_zone_id: Set(login.sigint_zone_id),
                created_at: Set(Utc::now().naive_utc()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        // ECHO-3073: keep attribution details without duplicate flat tag IDs.
        let message = seed_message_with_tags(
            &env,
            &datasource_group,
            &tag,
            &[login.clone(), peer_login],
        )
        .await
        .unwrap();
        let logins =
            crate::users::get_organism_login_ids_by_id(&env.dbx, &login.id)
                .await
                .unwrap();

        let messages = messages_by_id_bl(
            &login.id,
            &logins,
            &env,
            &[message.id],
            &messages_by_id_default_req(),
        )
        .await
        .unwrap();

        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].1.tags, Some(vec![tag.id]));
        let inbox_tags = messages[0]
            .1
            .inbox_tags
            .as_ref()
            .expect("inbox tags must be present");
        assert_eq!(inbox_tags.len(), 2);
        assert!(inbox_tags.iter().all(|entry| entry.tag_id == tag.id));
        assert!(inbox_tags
            .iter()
            .all(|entry| entry.organism_id == login.organism_id));
    }

    #[serial]
    #[tokio::test]
    async fn test_messages_by_id_deduplicates_flat_tags_after_filtering() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let tag = find_test_bpla_tag(&env.dbx).await.unwrap();
        let datasource_group =
            find_test_datasource_group(&env.dbx).await.unwrap();
        let shared_tag = mk_tag(
            &env.dbx,
            tag::ActiveModel {
                label: Set(format!("shared-tag-{}", Uuid::new_v4())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let model_only_tag = mk_tag(
            &env.dbx,
            tag::ActiveModel {
                label: Set(format!("model-only-tag-{}", Uuid::new_v4())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let low_confidence_tag = mk_tag(
            &env.dbx,
            tag::ActiveModel {
                label: Set(format!("low-confidence-tag-{}", Uuid::new_v4())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let threshold_tag = mk_tag(
            &env.dbx,
            tag::ActiveModel {
                label: Set(format!("threshold-tag-{}", Uuid::new_v4())),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let message = seed_message_with_tags(
            &env,
            &datasource_group,
            &tag,
            std::slice::from_ref(&login),
        )
        .await
        .unwrap();
        for (tag_id, confidence, tag_model) in [
            (shared_tag.id, 1.0, None),
            (shared_tag.id, 1.0, Some("test-model")),
            (model_only_tag.id, 1.0, Some("test-model")),
            (low_confidence_tag.id, 0.6, None),
            (threshold_tag.id, TAG_MINIMUM_CONFIDENCE, None),
        ] {
            sigint_inbox_item_tag::ActiveModel {
                sigint_inbox_item_id: Set(message.id),
                tag_id: Set(tag_id),
                confidence: Set(confidence),
                login_id: Set(Some(login.id)),
                model: Set(tag_model.map(str::to_string)),
                ..Default::default()
            }
            .insert(&env.dbx)
            .await
            .unwrap();
        }
        let logins =
            crate::users::get_organism_login_ids_by_id(&env.dbx, &login.id)
                .await
                .unwrap();

        let messages = messages_by_id_bl(
            &login.id,
            &logins,
            &env,
            &[message.id],
            &messages_by_id_default_req(),
        )
        .await
        .unwrap();

        assert_eq!(messages.len(), 1);
        let flat_tags = messages[0]
            .1
            .tags
            .as_ref()
            .expect("flat tags must be present");
        assert_eq!(flat_tags.iter().unique().count(), flat_tags.len());
        assert_eq!(
            flat_tags.iter().copied().collect::<BTreeSet<_>>(),
            BTreeSet::from([
                tag.id,
                shared_tag.id,
                model_only_tag.id,
                threshold_tag.id,
            ])
        );
        let inbox_tags = messages[0]
            .1
            .inbox_tags
            .as_ref()
            .expect("inbox tags must be present");
        assert_eq!(
            inbox_tags
                .iter()
                .filter(|entry| entry.tag_id == shared_tag.id)
                .count(),
            2
        );
        assert!(!inbox_tags
            .iter()
            .any(|entry| entry.tag_id == low_confidence_tag.id));

        // ECHO-3073: retain manual attribution records while hiding model rows.
        let without_model_tags = messages_by_id_bl(
            &login.id,
            &logins,
            &env,
            &[message.id],
            &InboxMessagesReq {
                without_model_tags: Some(true),
                ..messages_by_id_default_req()
            },
        )
        .await
        .unwrap();
        let filtered = &without_model_tags[0].1;
        let filtered_tags = filtered.tags.as_ref().unwrap();
        assert_eq!(filtered_tags.iter().unique().count(), filtered_tags.len());
        assert_eq!(
            filtered_tags.iter().copied().collect::<BTreeSet<_>>(),
            BTreeSet::from([tag.id, shared_tag.id, threshold_tag.id])
        );
        let filtered_inbox_tags = filtered.inbox_tags.as_ref().unwrap();
        assert_eq!(filtered_inbox_tags.len(), 3);
        assert!(filtered_inbox_tags
            .iter()
            .all(|entry| entry.model.is_none()));
    }

    #[serial]
    #[tokio::test]
    async fn test_messages_by_id_includes_distinct_unit_ids() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let datasource_group =
            find_test_datasource_group(&env.dbx).await.unwrap();
        let message =
            seed_message_with_media(&env, &datasource_group, None, "units")
                .await
                .unwrap();
        let first_unit =
            mk_sigint_unit(&env.dbx, Default::default()).await.unwrap();
        let second_unit =
            mk_sigint_unit(&env.dbx, Default::default()).await.unwrap();
        let network = mk_sigint_network(&env.dbx, Default::default())
            .await
            .unwrap();
        mk_sigint_network_unit(
            &env.dbx,
            sigint_network_unit::ActiveModel {
                network_id: Set(network.id),
                unit_id: Set(first_unit.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_inbox_item_network(
            &env.dbx,
            sigint_inbox_item_network::ActiveModel {
                sigint_inbox_item_id: Set(message.id),
                sigint_network_id: Set(network.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        for (unit_id, kind) in [
            (first_unit.id, SigintInboxItemUnitKind::Parsed),
            (second_unit.id, SigintInboxItemUnitKind::Parsed),
            (first_unit.id, SigintInboxItemUnitKind::Network),
        ] {
            sigint_inbox_item_unit::ActiveModel {
                item_id: Set(message.id),
                unit_id: Set(unit_id),
                kind: Set(kind),
                ..Default::default()
            }
            .insert(&env.dbx)
            .await
            .unwrap();
        }

        let logins = vec![login.id];
        let messages = messages_by_id_bl(
            &login.id,
            &logins,
            &env,
            &[message.id],
            &messages_by_id_default_req(),
        )
        .await
        .unwrap();
        let mut expected_unit_ids = vec![first_unit.id, second_unit.id];
        expected_unit_ids.sort_unstable();

        assert_eq!(messages[0].1.unit_ids, expected_unit_ids);
    }

    #[serial]
    #[tokio::test]
    async fn deleting_message_invalidates_network_frequency_last_seen() {
        let env = cleanup().await.unwrap();
        let timestamp = Utc::now().naive_utc() - Duration::hours(1);
        let message = mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                timestamp: Set(Some(timestamp)),
                created_at: Set(timestamp),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let freq = "146.4500";
        let inbox_item = mk_sigint_inbox_item(
            &env.dbx,
            sigint_inbox_item::ActiveModel {
                id: Set(message.id),
                freq: Set(Some(freq.to_string())),
                datetime: Set(Some(timestamp)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let network = mk_sigint_network(&env.dbx, Default::default())
            .await
            .unwrap();
        let network_freq = mk_sigint_network_freq(
            &env.dbx,
            sigint_network_freq::ActiveModel {
                network_id: Set(network.id),
                freq: Set(freq.to_string()),
                active_from: Set(timestamp - Duration::days(1)),
                last_seen_dt: Set(Some(timestamp)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_inbox_item_network(
            &env.dbx,
            sigint_inbox_item_network::ActiveModel {
                sigint_inbox_item_id: Set(inbox_item.id),
                sigint_network_id: Set(network.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let txn = env.dbx.begin().await.unwrap();
        soft_delete_message(&txn, message.id).await.unwrap();
        txn.commit().await.unwrap();

        let message = signal_message::Entity::find_by_id(message.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        let network_freq =
            sigint_network_freq::Entity::find_by_id(network_freq.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        assert!(message.deleted);
        assert_eq!(network_freq.last_seen_dt, None);
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
            crate::users::get_organism_login_ids_by_id(&env.dbx, &login.id)
                .await
                .unwrap();
        let messages = messages_by_id_bl(
            &login.id,
            &logins,
            &env,
            &[message.id],
            &messages_by_id_default_req(),
        )
        .await
        .unwrap();
        assert_eq!(messages[0].1.point_tokens.as_ref().unwrap().len(), 1);
        assert_eq!(
            messages[0].1.point_tokens.as_ref().unwrap()[0].palitra_ids,
            vec![palitra.id]
        );
        assert!(messages[0].1.text_marked.as_ref().unwrap().iter().any(
            |node| matches!(
                node,
                crate::rer_importer::highlight::ContentNode::CNPointC(point)
                    if point.palitra_ids == vec![palitra.id]
            )
        ));

        let mut palitra = palitra.into_active_model();
        palitra.is_archived = Set(true);
        palitra.update(&env.dbx).await.unwrap();

        let messages = messages_by_id_bl(
            &login.id,
            &logins,
            &env,
            &[message.id],
            &messages_by_id_default_req(),
        )
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
                id: NotSet,
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
            load_latest: Some(true),
            ..Default::default()
        };
        let logins = vec![login.id];
        let messages = get_inbox_messages(&login.id, &logins, &env, &req)
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
                .any(|t| t.login.as_deref() == Some(login.login.as_str())
                    && t.organism_id == login.organism_id),
            "expected tag from primary login with organism id"
        );
        assert!(
            inbox_tags.iter().any(|t| t.login.as_deref()
                == Some(other_login.login.as_str())
                && t.organism_id == Some(other_org.id)),
            "expected tag from other login with its organism id"
        );
    }

    #[serial]
    #[tokio::test]
    async fn test_get_inbox_messages_uses_current_organism_extended_form() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let peer_login = mk_login(
            &env.dbx,
            login::ActiveModel {
                id: NotSet,
                login: Set("PeerTester".to_string()),
                organism_id: Set(login.organism_id),
                sigint_zone_id: Set(login.sigint_zone_id),
                created_at: Set(Utc::now().naive_utc()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let datasource_group =
            find_test_datasource_group(&env.dbx).await.unwrap();

        let current_message = mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                body: Set(Some("current login comment".to_string())),
                created_at: Set(Utc::now().naive_utc()),
                timestamp: Set(Some(Utc::now().naive_utc())),
                sender: Set(Some("sender-current".to_string())),
                message_uid: Set(Some("uid-current".to_string())),
                datasource_group_id: Set(Some(datasource_group.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_signal_message_group(
            &env.dbx,
            signal_message_group::ActiveModel {
                signal_message_id: Set(current_message.id),
                group_master_key: Set(Some(
                    datasource_group.group_master_key.clone(),
                )),
                sender: Set(Some("sender-current".to_string())),
                message_uid: Set(current_message.message_uid.clone()),
                datasource_group_id: Set(Some(datasource_group.id)),
                created_at: Set(Utc::now().naive_utc()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_inbox_item(
            &env.dbx,
            sigint_inbox_item::ActiveModel {
                id: Set(current_message.id),
                freq: Set(Some("100.100".to_string())),
                date: Set(Some(Utc::now().date_naive().to_string())),
                time: Set(Some(
                    Utc::now().time().format("%H:%M:%S").to_string(),
                )),
                reviewed: Set(Some(true)),
                parsed_unit_v2: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_comment(
            &env.dbx,
            sigint_comment::ActiveModel {
                login_id: Set(login.id),
                signal_message_id: Set(current_message.id),
                comment: Set("my editable comment".to_string()),
                created_at: Set(Utc::now().naive_utc()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_comment(
            &env.dbx,
            sigint_comment::ActiveModel {
                login_id: Set(peer_login.id),
                signal_message_id: Set(current_message.id),
                comment: Set("peer comment".to_string()),
                created_at: Set(Utc::now().naive_utc()),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let peer_only_message = mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                body: Set(Some("peer only comment".to_string())),
                created_at: Set(Utc::now().naive_utc()),
                timestamp: Set(Some(Utc::now().naive_utc())),
                sender: Set(Some("sender-peer-only".to_string())),
                message_uid: Set(Some("uid-peer-only".to_string())),
                datasource_group_id: Set(Some(datasource_group.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_signal_message_group(
            &env.dbx,
            signal_message_group::ActiveModel {
                signal_message_id: Set(peer_only_message.id),
                group_master_key: Set(Some(
                    datasource_group.group_master_key.clone(),
                )),
                sender: Set(Some("sender-peer-only".to_string())),
                message_uid: Set(peer_only_message.message_uid.clone()),
                datasource_group_id: Set(Some(datasource_group.id)),
                created_at: Set(Utc::now().naive_utc()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_inbox_item(
            &env.dbx,
            sigint_inbox_item::ActiveModel {
                id: Set(peer_only_message.id),
                freq: Set(Some("100.200".to_string())),
                date: Set(Some(Utc::now().date_naive().to_string())),
                time: Set(Some(
                    Utc::now().time().format("%H:%M:%S").to_string(),
                )),
                reviewed: Set(Some(true)),
                parsed_unit_v2: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_comment(
            &env.dbx,
            sigint_comment::ActiveModel {
                login_id: Set(peer_login.id),
                signal_message_id: Set(peer_only_message.id),
                comment: Set("peer only editable comment".to_string()),
                created_at: Set(Utc::now().naive_utc()),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let logins = vec![login.id, peer_login.id];
        let req = InboxMessagesReq {
            nolimit: Some(true),
            load_latest: Some(true),
            ..Default::default()
        };
        let messages = get_inbox_messages(&login.id, &logins, &env, &req)
            .await
            .unwrap();

        let current_entry = messages
            .iter()
            .find(|(id, _)| *id == current_message.id)
            .expect("current message must be returned");
        assert_eq!(
            current_entry.1.extended_form.as_deref(),
            Some("my editable comment")
        );
        assert!(current_entry.1.message_comments.is_empty());

        let peer_only_entry = messages
            .iter()
            .find(|(id, _)| *id == peer_only_message.id)
            .expect("peer only message must be returned");
        assert_eq!(
            peer_only_entry.1.extended_form.as_deref(),
            Some("peer only editable comment")
        );
        assert!(peer_only_entry.1.message_comments.is_empty());
    }

    #[serial]
    #[tokio::test]
    async fn test_find_sigint_comment_by_signal_message_id_and_logins_uses_organism_logins(
    ) {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let peer_login = mk_login(
            &env.dbx,
            login::ActiveModel {
                id: NotSet,
                login: Set("PeerTester".to_string()),
                organism_id: Set(login.organism_id),
                sigint_zone_id: Set(login.sigint_zone_id),
                created_at: Set(Utc::now().naive_utc()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let datasource_group =
            find_test_datasource_group(&env.dbx).await.unwrap();
        let message = mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                body: Set(Some("kmz peer comment".to_string())),
                created_at: Set(Utc::now().naive_utc()),
                timestamp: Set(Some(Utc::now().naive_utc())),
                sender: Set(Some("sender-kmz".to_string())),
                message_uid: Set(Some("uid-kmz".to_string())),
                datasource_group_id: Set(Some(datasource_group.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_inbox_item(
            &env.dbx,
            sigint_inbox_item::ActiveModel {
                id: Set(message.id),
                freq: Set(Some("100.300".to_string())),
                date: Set(Some(Utc::now().date_naive().to_string())),
                time: Set(Some(
                    Utc::now().time().format("%H:%M:%S").to_string(),
                )),
                reviewed: Set(Some(true)),
                parsed_unit_v2: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_comment(
            &env.dbx,
            sigint_comment::ActiveModel {
                login_id: Set(peer_login.id),
                signal_message_id: Set(message.id),
                comment: Set("peer visible comment".to_string()),
                created_at: Set(Utc::now().naive_utc()),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let organism_logins =
            crate::users::get_organism_login_ids_by_id(&env.dbx, &login.id)
                .await
                .unwrap();
        let comment = find_sigint_comment_by_signal_message_id_and_logins(
            &env,
            message.id,
            &organism_logins,
        )
        .await
        .unwrap()
        .expect("organism login lookup must return peer comment");

        assert_eq!(comment.login_id, peer_login.id);
        assert_eq!(comment.comment, "peer visible comment");
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

        let logins = vec![login.id];
        let wrong_sender_req = InboxMessagesReq {
            nolimit: Some(true),
            load_latest: Some(true),
            selected_groups: Some(vec![datasource_group
                .group_master_key
                .clone()]),
            selected_senders: Some(vec!["sender-a".to_string()]),
            ..Default::default()
        };
        let wrong_sender_messages =
            get_inbox_messages(&login.id, &logins, &env, &wrong_sender_req)
                .await
                .unwrap();
        assert!(
            wrong_sender_messages.is_empty(),
            "message matched sender from another group row"
        );

        let matching_sender_req = InboxMessagesReq {
            nolimit: Some(true),
            load_latest: Some(true),
            selected_groups: Some(vec![datasource_group
                .group_master_key
                .clone()]),
            selected_senders: Some(vec!["sender-c".to_string()]),
            ..Default::default()
        };
        let matching_sender_messages =
            get_inbox_messages(&login.id, &logins, &env, &matching_sender_req)
                .await
                .unwrap();
        assert_eq!(matching_sender_messages.len(), 1);
        assert_eq!(
            matching_sender_messages[0].1.sender.as_deref(),
            Some("sender-c")
        );
    }
}
