use super::super::types::*;
use crate::config::{
    AnalyticsConfig, ANALYTICS_FRESHNESS_MAX_AGE_MS_DEFAULT,
    RER_REPORT_ENRICHMENT_ID_BATCH_SIZE,
};
use crate::entities::{prelude::*, *};
use crate::error::AppError;
use crate::location::peleng::{
    collect_inbox_pelengs, inbox_item_has_active_peleng_exists,
};
use crate::rer_importer::analysis::*;
use crate::rer_importer::analysis::{
    analytics_inbox_request_supported, map_postgres_runtime_timeout,
    with_analytics_read_fallback,
};
use crate::rer_importer::inbox::query::scan_analytics_inbox_candidate_ids;
use crate::rer_importer::report_chunking::{
    compare_inbox_report_message_oldest_first,
    exclude_inbox_report_linked_intel_products, inbox_report_chunk_req,
    inbox_report_period_chunks, oldest_first_inbox_report_req,
    report_chunk_exclusive_till, restrict_inbox_report_to_message_ids,
    ReportPeriodEnd,
};
use crate::sigint::sender::preferred_sender_sql_snippet;
use crate::types::*;
use crate::utils::dt_from_millis;
use anyhow::{bail, Context};
use chrono::prelude::*;
use echo_migration::IntoCondition;
use itertools::Itertools;
use sea_orm::{prelude::Expr, sea_query::SimpleExpr, *};
use std::collections::{BTreeMap, BTreeSet};

use geoconvert::{LatLon, Mgrs};
use std::path::PathBuf;

#[derive(Debug, Clone, FromQueryResult)]
struct Message {
    pub id: i64,
    pub body: String,
    pub datetime: Option<chrono::NaiveDateTime>,
    pub timestamp: Option<chrono::NaiveDateTime>,
    pub sender: Option<String>,
    pub date: Option<String>,
    pub time: Option<String>,
    pub freq: Option<String>,
    pub checked: Option<bool>,
    pub unit: Option<String>,
    pub location: Option<String>,
}

struct CollectedPelengReportMessage {
    message_id: i64,
    coords: Option<(f64, f64)>,
    message: InboxMessage,
    datetime: Option<NaiveDateTime>,
    timestamp: Option<NaiveDateTime>,
}

pub async fn get_inbox_messages_report(
    user_login: &uuid::Uuid,
    env: &Env,
    req: &InboxMessagesReq,
) -> Result<Vec<(i64, Option<(f64, f64)>, InboxMessage)>, AppError> {
    let req = oldest_first_inbox_report_req(req);
    let req = &req;
    let report_settings =
        crate::system_settings::get_report_generation_settings(&env.dbx)
            .await
            .c(h!())?;
    let mut chunks =
        inbox_report_period_chunks(req, report_settings.chunking_hours)
            .context(h!())?;
    if req.load_latest == Some(true)
        || req.newest_first == Some(true)
        || req.before_id_noninclusive.is_some()
    {
        chunks.reverse();
    }
    let mut messages = Vec::new();
    let mut seen = BTreeSet::new();
    for (index, chunk) in chunks.iter().copied().enumerate() {
        info!(
            "Pelengs report chunk {}/{}: {}..{} ({:?})",
            index + 1,
            chunks.len(),
            chunk.since_ms,
            chunk.till_ms,
            chunk.end
        );
        let chunk_req = inbox_report_chunk_req(req, chunk);
        for message in get_inbox_messages_report_chunk(
            user_login, env, &chunk_req, chunk.end,
        )
        .await
        .context(h!())?
        {
            let key = (
                message.message_id,
                message
                    .coords
                    .map(|(lat, lng)| (lat.to_bits(), lng.to_bits())),
            );
            if seen.insert(key) {
                messages.push(message);
            }
        }
    }
    sort_collected_peleng_report_messages(&mut messages, req);
    Ok(messages
        .into_iter()
        .map(|message| (message.message_id, message.coords, message.message))
        .collect())
}

fn pelengs_analytics_scan_filters(
    query: Select<signal_message::Entity>,
) -> Select<signal_message::Entity> {
    exclude_inbox_report_linked_intel_products(query)
        .filter(inbox_item_has_active_peleng_exists())
}

fn sort_collected_peleng_report_messages(
    messages: &mut [CollectedPelengReportMessage],
    req: &InboxMessagesReq,
) {
    messages.sort_by(|left, right| {
        compare_inbox_report_message_oldest_first(
            req,
            left.datetime,
            left.timestamp,
            left.message_id,
            right.datetime,
            right.timestamp,
            right.message_id,
        )
    });
}

async fn get_inbox_messages_report_chunk(
    user_login: &uuid::Uuid,
    env: &Env,
    req: &InboxMessagesReq,
    period_end: ReportPeriodEnd,
) -> Result<Vec<CollectedPelengReportMessage>, AppError> {
    let analytics_supported = analytics_inbox_request_supported(req);
    let login = *user_login;
    let req = req.clone();
    let env_analytics = env.clone();
    let candidate_ids = with_analytics_read_fallback(
        env,
        "pelengs report message scan",
        analytics_supported,
        {
            let req = req.clone();
            let env_analytics = env_analytics.clone();
            move |analytics_db| async move {
                scan_peleng_report_message_ids(
                    analytics_db,
                    login,
                    env_analytics,
                    req,
                    period_end,
                )
                .await
            }
        },
        |_postgres_db| async move { Ok(None) },
    )
    .await
    .context(h!())?;
    match candidate_ids {
        Some(ids) => {
            log::info!("Pelengs report using analytics ({} ids)", ids.len());
            Ok(hydrate_peleng_report_messages(
                &login, env, &req, period_end, &ids,
            )
            .await
            .context(h!())?)
        }
        None => {
            log::debug!(
                "Pelengs report analytics scan unavailable; using PostgreSQL scan"
            );
            get_inbox_messages_report_chunk_postgres(
                &login, env, &req, period_end, None,
            )
            .await
            .map_err(|error| {
                map_postgres_runtime_timeout(
                    error,
                    "pelengs report message scan",
                )
            })
        }
    }
}

async fn scan_peleng_report_message_ids(
    analytics_db: DatabaseConnection,
    login: uuid::Uuid,
    env: Env,
    req: InboxMessagesReq,
    period_end: ReportPeriodEnd,
) -> Result<Option<Vec<i64>>, AppError> {
    let freshness_max_age_ms = env
        .config
        .analytics
        .as_ref()
        .map(AnalyticsConfig::freshness_max_age_ms)
        .unwrap_or(ANALYTICS_FRESHNESS_MAX_AGE_MS_DEFAULT);
    let exclusive_till =
        report_chunk_exclusive_till(&req, period_end).context(h!())?;
    Ok(scan_analytics_inbox_candidate_ids(
        &login,
        &env,
        &req,
        &analytics_db,
        freshness_max_age_ms,
        exclusive_till,
        None,
        pelengs_analytics_scan_filters,
    )
    .await
    .context(h!())?)
}

async fn hydrate_peleng_report_messages(
    user_login: &uuid::Uuid,
    env: &Env,
    req: &InboxMessagesReq,
    period_end: ReportPeriodEnd,
    candidate_ids: &[i64],
) -> Result<Vec<CollectedPelengReportMessage>, AppError> {
    let mut messages = Vec::new();
    for candidate_ids in
        candidate_ids.chunks(RER_REPORT_ENRICHMENT_ID_BATCH_SIZE)
    {
        messages.extend(
            get_inbox_messages_report_chunk_postgres(
                user_login,
                env,
                req,
                period_end,
                Some(candidate_ids),
            )
            .await
            .context(h!())?,
        );
    }
    Ok(messages)
}

async fn get_inbox_messages_report_chunk_postgres(
    user_login: &uuid::Uuid,
    env: &Env,
    req: &InboxMessagesReq,
    period_end: ReportPeriodEnd,
    candidate_ids: Option<&[i64]>,
) -> Result<Vec<CollectedPelengReportMessage>, AppError> {
    if candidate_ids.is_some_and(<[i64]>::is_empty) {
        return Ok(Vec::new());
    }
    let login = *user_login;
    let include_peleng_locations =
        req.include_peleng_locations.unwrap_or(false);
    let read_db = env.replica();

    let sigint_groups =
        crate::messenger::group::get_identity_sigint_groups(&read_db, &login)
            .await
            .c(h!())?;
    let mut q = SignalMessage::find()
        .join(JoinType::InnerJoin, signal_message::Relation::SigintInboxItem.def())
        .join(JoinType::InnerJoin, signal_message::Relation::DatasourceGroup.def())
        .select_only()
        .column(signal_message::Column::Id)
        .column(signal_message::Column::Body)
        .column(sigint_inbox_item::Column::Datetime)
        .column(signal_message::Column::Timestamp)
        .expr(Expr::cust(format!(
            "{} AS sender",
            preferred_sender_sql_snippet(None)
        )))
        .column(sigint_inbox_item::Column::Date)
        .column(sigint_inbox_item::Column::Time)
        .column(sigint_inbox_item::Column::Freq)
        .column(sigint_inbox_item::Column::Checked)
        .column_as(sigint_inbox_item::Column::LocationV2, "location")
        .column_as(
            Expr::col((
                signal_message::Entity,
                signal_message::Column::Id,
            ))
            .if_null(Expr::col((
                signal_message::Entity,
                signal_message::Column::Id,
            ))),
            "dedup_key",
        )
        .column_as(
            SimpleExpr::Custom(r#"
                COALESCE(
                    array_to_string(
                        NULLIF(
                            array_agg(
                                CASE sigint_network_freq.modulation
                                  WHEN 'NFM' THEN 'УКХ'
                                  ELSE sigint_network_freq.modulation END || ' р/м ' || sigint_network.name || ' ' || sigint_unit.name || ' (' || UPPER(sigint_network.location) || ')'
                            )
                            FILTER
                            (WHERE sigint_unit.name IS NOT NULL),
                        '{}'),
                        ', '
                    ),
                    sigint_inbox_item.unit_v2
                )
            "#.into()),
            "unit",
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(
            Expr::exists(
                intel_product::Entity::find()
                    .filter(
                        Expr::col((
                            intel_product::Entity,
                            intel_product::Column::IntelMessageId,
                        ))
                        .equals((
                            signal_message::Entity,
                            signal_message::Column::Id,
                        )),
                    )
                    .filter(intel_product::relation_kind_is_in([
                        intel_product::RELATION_KIND_REPORT,
                        intel_product::RELATION_KIND_COMMENT,
                    ]))
                    .select_only()
                    .column(intel_product::Column::IntelMessageId)
                    .into_query(),
            )
            .not(),
        )
        // Allow missing network/freq/unit links for report rows.
        .filter(inbox_item_has_active_peleng_exists())
        .join(
            JoinType::LeftJoin,
            crate::sigint::freq::util::inbox_item_network_freq_relation()
                .on_condition(|_left, right| {
                    Expr::col((right, sigint_network_freq::Column::Deleted))
                        .eq(false)
                        .into_condition()
                }),
        )
        .join(
            JoinType::LeftJoin,
            sigint_network_freq::Relation::SigintNetwork.def()
                .on_condition(|_left, right| {
                    Expr::col((right, sigint_network::Column::Deleted))
                        .eq(false)
                        .into_condition()
                }),
        )
        .join(
            JoinType::LeftJoin,
            sigint_network::Relation::SigintNetworkUnit.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_network_unit::Relation::SigintUnit.def()
                .on_condition(|_left, right| {
                    Expr::col((right, sigint_unit::Column::Deleted))
                        .eq(false)
                        .into_condition()
                }),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintPost.def()
                .on_condition(|_left, right| {
                    Expr::col((right, sigint_post::Column::Deleted))
                        .eq(false)
                        .into_condition()
                }),
        )
        .group_by(signal_message::Column::Id)
        .group_by(sigint_inbox_item::Column::Id)
        .group_by(sigint_network_freq::Column::Id)
        .group_by(sigint_network::Column::Id)
        .group_by(sigint_network_unit::Column::Id)
        .group_by(sigint_post::Column::Id)
        .group_by(datasource_group::Column::Id)
        .filter(
            datasource_group::Column::GroupMasterKey
                .eq_any(sigint_groups.clone()),
        );

    let mut pagination_req = req.clone();
    if period_end == ReportPeriodEnd::NonInclusive {
        pagination_req.till_date_inclusive_ms = None;
    }
    q = crate::rer_importer::inbox::query::get_pagination_filters(
        env,
        &pagination_req,
        q.clone(),
    )
    .await
    .c(h!())?;
    if period_end == ReportPeriodEnd::NonInclusive {
        let till = req
            .till_date_inclusive_ms
            .ok_or_else(|| AppError::BL {
                msg: "Until date must be specified".to_string(),
            })
            .context(h!())?;
        let till = dt_from_millis(till).context(h!())?;
        q = match req.sort_by.unwrap_or(InboxMessagesSortBy::IMSDatetime) {
            InboxMessagesSortBy::IMSDatetime => {
                q.filter(sigint_inbox_item::Column::Datetime.lt(till))
            }
            InboxMessagesSortBy::IMSTimestamp
            | InboxMessagesSortBy::IMSCreatedAt => {
                q.filter(signal_message::Column::Timestamp.lt(till))
            }
        };
    }
    q = crate::rer_importer::inbox::query::get_bl_ordering_select(
        req,
        q.clone(),
    )
    .await
    .c(h!())?;

    if req.only_show_unprocessed == Some(true) {
        q = q.filter(sigint_inbox_item::Column::Reviewed.ne(Some(true)));
    }
    if req.checked_only == Some(true) {
        q = q.filter(sigint_inbox_item::Column::Checked.eq(Some(true)));
    }
    let q = filter_selected_groups_and_senders_with_access(
        q,
        &req.selected_groups,
        &req.selected_senders,
        &sigint_groups,
    )?;
    let q = filter_denied_senders(q, &req.denied_senders)?;
    let q = filter_selected_freqs(q, &req.selected_freqs)?;
    let q = filter_selected_posts(q, &req.selected_posts)?;
    let q = filter_denied_freqs(q, &req.denied_freqs)?;
    let q = filter_selected_callsigns(q, &req.selected_callsigns)?;
    let q = filter_search(q, &req.search)?;
    let q = filter_selected_units_or_ids(
        q,
        &req.selected_units,
        &req.selected_unit_ids,
        &req.units_exact_match_only,
    )?;
    let q = filter_denied_unit_ids(q, &req.denied_unit_ids);
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
        &login,
        req.report_tags_only_this_unit.unwrap_or(false),
    )?;
    let q = filter_selected_locations(
        q,
        &req.selected_locations,
        include_peleng_locations,
    )?;
    let q = filter_selected_aors(q, &req.selected_aors).context(h!())?;
    let q = filter_selected_networks(
        q,
        &req.selected_networks,
        &req.without_network,
    )
    .context(h!())?;
    let q = filter_selected_metadata_for_inbox_messages(q, req)?;
    let q = match candidate_ids {
        Some(ids) => restrict_inbox_report_to_message_ids(q, ids),
        None => q,
    };

    info!(
        "[get_inbox_messages_report] query: {}",
        &q.build(DbBackend::Postgres)
    );
    info!("[get_inbox_messages_report] {}", Utc::now());

    let messages: Vec<Message> =
        q.into_model::<Message>().all(&read_db).await.c(h!())?;

    let messages = deduplicate_by_id(&messages);

    let mut item_ids = vec![];
    let mut sigint_pelengs = vec![];
    let mut items_map = BTreeMap::new();
    for item in messages {
        item_ids.push(item.id);
        items_map.insert(item.id, item);
        if item_ids.len() > 1000 {
            collect_inbox_pelengs(item_ids, &read_db)
                .await
                .context(h!())?
                .into_iter()
                .for_each(|p| sigint_pelengs.push(p));
            item_ids = vec![];
        }
    }
    collect_inbox_pelengs(item_ids, &read_db)
        .await
        .context(h!())?
        .into_iter()
        .for_each(|p| sigint_pelengs.push(p));

    let mut pelengs_map = BTreeMap::<i64, Vec<sigint_peleng::Model>>::new();
    for peleng in sigint_pelengs {
        pelengs_map
            .entry(peleng.source_inbox_item_id)
            .or_default()
            .push(peleng);
    }
    info!(
        "[get_inbox_messages_report] {}: query completed",
        Utc::now()
    );
    let callsign_item_ids = items_map.keys().copied().collect_vec();
    let mut normalized_callsigns =
        crate::inbox::callsigns::load_by_item_ids(&read_db, &callsign_item_ids)
            .await?;

    let mut res = vec![];
    for (id, m) in items_map {
        let callsigns =
            normalized_callsigns.remove(&id).unwrap_or_default().primary;
        let locations_w_coords = match pelengs_map.get(&id) {
            None => vec![(m.location.clone(), None, None)],
            Some(pelengs) => {
                let mut result = vec![];
                for p in pelengs {
                    let location = build_location(p).context(h!())?;
                    let coordinates = Some(format!("{}, {}", p.lat, p.lng));
                    result.push((location, coordinates, Some((p.lat, p.lng))));
                }
                result
            }
        };
        for (location, coords, coords_tuple) in locations_w_coords {
            res.push(CollectedPelengReportMessage {
                message_id: m.id,
                coords: coords_tuple,
                datetime: m.datetime,
                timestamp: m.timestamp,
                message: InboxMessage {
                    parent_messages: vec![],
                    intelligence_reports: vec![],
                    message_uuid: None,
                    message_uid: None,
                    location,
                    coords,
                    coords_with_locality: vec![],
                    text: m.body.clone(),
                    media: vec![],
                    images: vec![],
                    image_recognized: vec![],
                    date: m.date.clone(),
                    time: m.time.clone(),
                    freq: m.freq.clone(),
                    callsigns: callsigns.clone(),
                    checked: m.checked.unwrap_or(false),
                    important: false,
                    bookmarked: false,
                    timestamp: m
                        .timestamp
                        .map(|x| x.and_utc().timestamp_millis()),
                    created_at: None,
                    has_date_in_header: false,
                    group_master_key: None,
                    sender: m.sender.clone(),
                    extended_form: None,
                    message_comments: vec![],
                    unit: m.unit.clone(),
                    callsign_tokens: None,
                    point_tokens: None,
                    keyword_tokens: None,
                    signal_tokens: None,
                    text_marked: None,
                    post: None,
                    post_id: None,
                    unit_ids: vec![],
                    no_headers_body: None,
                    datasource_id: None,
                    tags: None,
                    callsigns_alg2: vec![],
                    network_ids: None,
                    network_name: None,
                    device_name: None,
                    inbox_tags: None,
                    metadata: vec![],
                },
            });
        }
    }

    info!("[get_inbox_messages_report] {}: query done", Utc::now());
    Ok(res)
}

fn deduplicate_by_id(messages: &[Message]) -> Vec<Message> {
    let mut seen: BTreeSet<i64> = BTreeSet::new();
    let mut res = vec![];
    for msg in messages {
        if seen.insert(msg.id) {
            res.push(msg.clone());
        }
    }
    res
}

fn xls_title() -> rust_xlsxwriter::Format {
    rust_xlsxwriter::Format::new()
        .set_bold()
        .set_border(rust_xlsxwriter::FormatBorder::Thin)
        .set_align(rust_xlsxwriter::FormatAlign::Center)
        .set_font_size(12.0)
}

/// XLSX report for "пеленги" with sender column ("Відправник")
pub async fn report_xlsx_kind_pelengs1(
    user_login: &uuid::Uuid,
    env: &Env,
    req: &super::types::ReportPreviewReq,
    outpath: &PathBuf,
) -> Result<(), AppError> {
    info!("[report_xlsx_kind_pelengs1] started");

    let mut workbook = rust_xlsxwriter::Workbook::new();
    let sheet1 = workbook.add_worksheet().set_name("Пеленги").context(h!())?;
    let coltitle = xls_title();
    let mut current_req = req.req.clone();
    current_req.report_tags_only_this_unit = req.report_tags_only_this_unit;
    let till: DateTime<Utc> = chrono::Utc
        .timestamp_millis_opt(current_req.till_date_inclusive_ms.unwrap_or(0))
        .single()
        .unwrap();
    let since: DateTime<Utc> = chrono::Utc
        .timestamp_millis_opt(current_req.since_date_inclusive_ms.unwrap_or(0))
        .single()
        .unwrap();

    let tz = crate::config::get_tz();
    let since_tz = since.with_timezone(&tz);
    let till_tz = till.with_timezone(&tz);

    sheet1
        .merge_range(
            0,
            0,
            0,
            9,
            &format!(
                "Розвідувальне донесення з результатів пеленгації за період {} - {}",
                since_tz.format("%d.%m.%y %H:%M"),
                till_tz.format("%d.%m.%y %H:%M")
            ),
            &coltitle,
        )
        .context(h!())?;

    // Header row (row index 1)
    sheet1
        .write_string_with_format(1, 0, "№", &coltitle)
        .context(h!())?;
    sheet1.set_column_width(0, 4.0).context(h!())?;
    sheet1
        .write_string_with_format(1, 1, "Назва р/м", &coltitle)
        .context(h!())?;
    sheet1.set_column_width(1, 40.0).context(h!())?;
    sheet1
        .write_string_with_format(1, 2, "Частота", &coltitle)
        .context(h!())?;
    sheet1.set_column_width(2, 10.0).context(h!())?;
    sheet1
        .write_string_with_format(1, 3, "Час", &coltitle)
        .context(h!())?;
    sheet1.set_column_width(3, 14.0).context(h!())?;
    sheet1
        .write_string_with_format(1, 4, "Позивний/приналежність", &coltitle)
        .context(h!())?;
    sheet1.set_column_width(4, 30.0).context(h!())?;
    sheet1
        .write_string_with_format(1, 5, "Район", &coltitle)
        .context(h!())?;
    sheet1.set_column_width(5, 30.0).context(h!())?;
    sheet1
        .write_string_with_format(1, 6, "XY", &coltitle)
        .context(h!())?;
    sheet1.set_column_width(6, 18.0).context(h!())?;
    sheet1
        .write_string_with_format(1, 7, "WSG", &coltitle)
        .context(h!())?;
    sheet1.set_column_width(7, 20.0).context(h!())?;
    sheet1
        .write_string_with_format(1, 8, "MGRS", &coltitle)
        .context(h!())?;
    sheet1.set_column_width(8, 18.0).context(h!())?;
    sheet1
        .write_string_with_format(1, 9, "Відправник", &coltitle)
        .context(h!())?;
    sheet1.set_column_width(9, 24.0).context(h!())?;

    info!("[report_xlsx_kind_pelengs1] {}: querying data", Utc::now());
    let messages: Vec<(i64, Option<(f64, f64)>, InboxMessage)> =
        crate::rer_importer::reports::report_xlsx_kind_pelengs::get_inbox_messages_report(
            user_login,
            env,
            &current_req,
        )
        .await.c(h!())?;
    info!(
        "[report_xlsx_kind_pelengs1] {}: query done, found messages: {}",
        Utc::now(),
        messages.len()
    );
    let record_count = messages
        .iter()
        .filter(|(_, coords, message)| {
            coords.is_some()
                && message
                    .coords
                    .as_ref()
                    .is_some_and(|coords| !coords.is_empty())
                && message.date.is_some()
                && message.time.is_some()
                && message.freq.is_some()
        })
        .count();
    crate::report_history::ensure_report_record_count(record_count)
        .context(h!())?;

    // Build sender display names map (uuid -> profile entry)
    let sender_uuids = messages
        .iter()
        .filter_map(|(_, _, m)| m.sender.clone())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let profiles_db = env.replica();
    let sender_names: BTreeMap<String, Option<SignalProfileEntry>> =
        crate::rer_importer::collect_profiles_data(&profiles_db, sender_uuids)
            .await
            .context(h!())?;

    let mut i: u32 = 1;
    for (_, m_coords, m) in messages.iter() {
        let Some(coords) = m.coords.as_ref() else {
            continue;
        };
        if coords.is_empty() {
            continue;
        }
        info!("[test] found coords: {coords}:?");
        let Some((lat, lng)) = *m_coords else {
            continue;
        };
        let Some(date) = m.date.as_ref() else {
            continue;
        };
        let date = NaiveDate::parse_from_str(date, "%Y-%m-%d").context(h!())?;
        let Some(time) = m.time.as_ref() else {
            continue;
        };
        let Some(freq) = m.freq.as_ref() else {
            continue;
        };
        info!("[test] processing coords...");

        i += 1;

        let usk2000 = &milgeo_rs::coordinates::usk2000::wgs84_to_usk2000(
            milgeo_rs::coordinates::Wgs84 { lat, lng },
        )?;

        sheet1.write_number(i, 0, (i - 1) as f64).context(h!())?;
        sheet1
            .write_string(i, 1, m.unit.clone().unwrap_or("НВ".to_string()))
            .context(h!())?;
        sheet1.write_string(i, 2, freq).context(h!())?;
        sheet1
            .write_string(
                i,
                3,
                format!("{}, {}", time, date.format("%d.%m.%y")),
            )
            .context(h!())?;
        // Resolve human-readable sender name (written as the last column)
        let sender_name =
            match m.sender.as_ref().and_then(|id| sender_names.get(id)) {
                Some(Some(profile)) => {
                    let gn = profile.given_name.clone().unwrap_or_default();
                    let fnm = profile.family_name.clone().unwrap_or_default();
                    let full = format!(
                        "{}{}{}",
                        gn,
                        if gn.is_empty() || fnm.is_empty() {
                            ""
                        } else {
                            " "
                        },
                        fnm
                    );
                    if full.trim().is_empty() {
                        "(невідомо)".to_string()
                    } else {
                        full
                    }
                }
                _ => "(невідомо)".to_string(),
            };
        sheet1
            .write_string(i, 4, m.callsigns.join(", "))
            .context(h!())?;
        sheet1
            .write_string(i, 5, m.location.clone().unwrap_or("".to_string()))
            .context(h!())?;
        sheet1
            .write_string(i, 6, format!("{} {}", usk2000.x, usk2000.y))
            .context(h!())?;
        sheet1
            .write_string(i, 7, format!("{lat} {lng}"))
            .context(h!())?;
        sheet1
            .write_string(
                i,
                8,
                Mgrs::from_latlon(&LatLon::create(lat, lng).unwrap(), 5)
                    .to_string(),
            )
            .context(h!())?;
        sheet1.write_string(i, 9, sender_name).context(h!())?;
    }

    workbook.save(outpath).context(h!())?;
    info!("[report_xlsx_kind_pelengs1] {}: completed", Utc::now());
    Ok(())
}

fn build_location(
    peleng: &sigint_peleng::Model,
) -> anyhow::Result<Option<String>> {
    match (
        peleng.distance_m,
        peleng.locality_direction.clone(),
        peleng.settlement.clone(),
    ) {
        (Some(distance_m), Some(direction_eng), Some(settlement)) => {
            if distance_m < 100.0 {
                return Ok(Some(settlement));
            }
            let distance = distance_m / 1000.0;
            let settlement_country_suffix = match peleng.country_code.clone() {
                None => "",
                Some(txt) => match &*txt {
                    "ru" => " рф",
                    "by" => " рб",
                    _ => "",
                },
            };
            let direction = translate_direction(direction_eng).context(h!())?;
            let result = format!(
                "{:.1}км {} {}{}",
                distance,
                direction,
                settlement.to_uppercase(),
                settlement_country_suffix
            );
            Ok(Some(result))
        }
        _ => Ok(None),
    }
}

fn translate_direction(dir: String) -> anyhow::Result<String> {
    match &*dir {
        "S" => Ok(String::from("Пд")),
        "N" => Ok(String::from("Пн")),
        "W" => Ok(String::from("Зх")),
        "E" => Ok(String::from("Сх")),
        _s => match _s.chars().collect_vec()[..] {
            [a, b] => {
                let prefix = translate_direction(String::from(a))?;
                let suffix = translate_direction(String::from(b))?;
                Ok(format!("{prefix}-{suffix}"))
            }
            _ => bail!("failed to parse: {dir}"),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::functest::tests::*;
    use crate::rer_importer::reports::inbox_light::blank_inbox_message;
    use sea_orm::ActiveValue::Set;
    use serial_test::serial;

    #[test]
    fn deduplicate_by_id_keeps_same_body_from_different_messages() {
        let messages = vec![
            Message {
                id: 1,
                body: "same body".to_string(),
                datetime: None,
                timestamp: None,
                sender: None,
                date: None,
                time: None,
                freq: None,
                checked: None,
                unit: None,
                location: None,
            },
            Message {
                id: 2,
                body: "same body".to_string(),
                datetime: None,
                timestamp: None,
                sender: None,
                date: None,
                time: None,
                freq: None,
                checked: None,
                unit: None,
                location: None,
            },
        ];

        let actual = deduplicate_by_id(&messages);

        assert_eq!(actual.len(), 2);
        assert_eq!(actual[0].id, 1);
        assert_eq!(actual[1].id, 2);
    }

    #[test]
    fn pelengs_analytics_scan_filters_use_mirrored_exists_and_not_in() {
        use sea_orm::{DbBackend, QueryTrait};

        let sql = pelengs_analytics_scan_filters(SignalMessage::find())
            .build(DbBackend::Postgres)
            .to_string();
        assert!(sql.contains("EXISTS"), "{sql}");
        assert!(sql.contains("sigint_peleng"), "{sql}");
        assert!(
            sql.contains("intel_product") && sql.contains("NOT IN"),
            "{sql}"
        );
        assert!(!sql.contains("matching_unit_network_ids"), "{sql}");
        assert!(!sql.contains("ANY($1::text[])"), "{sql}");
        assert!(!sql.contains("array_agg"), "{sql}");
    }

    #[test]
    fn pelengs_id_restriction_avoids_full_inbox_unit_cte() {
        use sea_orm::{DbBackend, EntityTrait, QueryTrait};

        let sql = restrict_inbox_report_to_message_ids(
            SignalMessage::find(),
            &[7, 8],
        )
        .build(DbBackend::Postgres)
        .to_string();
        assert!(
            sql.contains(r#""signal_message"."id""#)
                && (sql.contains(" IN (") || sql.contains(" = ANY(")),
            "{sql}"
        );
        assert!(!sql.contains("matching_unit_network_ids"), "{sql}");
    }

    #[test]
    fn peleng_report_resorts_oldest_first_after_collecting_chunks() {
        let datetime = |hour| {
            NaiveDate::from_ymd_opt(2026, 8, 14)
                .unwrap()
                .and_hms_opt(hour, 0, 0)
                .unwrap()
        };
        let mut messages = [11, 10, 13, 12]
            .into_iter()
            .map(|hour| CollectedPelengReportMessage {
                message_id: i64::from(hour),
                coords: None,
                message: blank_inbox_message(),
                datetime: Some(datetime(hour)),
                timestamp: Some(datetime(23 - hour)),
            })
            .collect::<Vec<_>>();

        sort_collected_peleng_report_messages(
            &mut messages,
            &InboxMessagesReq::default(),
        );
        assert_eq!(
            messages
                .iter()
                .map(|message| message.message_id)
                .collect::<Vec<_>>(),
            vec![10, 11, 12, 13],
        );

        sort_collected_peleng_report_messages(
            &mut messages,
            &InboxMessagesReq {
                sort_by: Some(InboxMessagesSortBy::IMSTimestamp),
                load_latest: Some(true),
                newest_first: Some(true),
                ..Default::default()
            },
        );
        assert_eq!(
            messages
                .iter()
                .map(|message| message.message_id)
                .collect::<Vec<_>>(),
            vec![13, 12, 11, 10],
        );
    }

    #[tokio::test]
    #[serial]
    async fn get_inbox_messages_report_includes_peleng_without_inbox_latlng() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let datasource_group =
            find_test_datasource_group(&env.dbx).await.unwrap();
        let dt = NaiveDate::from_ymd_opt(2026, 3, 9)
            .unwrap()
            .and_hms_opt(10, 15, 0)
            .unwrap();

        let signal_message = mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                body: Set(Some("peleng-only-message".to_string())),
                created_at: Set(dt),
                timestamp: Set(Some(dt)),
                message_uid: Set(Some("peleng-only-message".to_string())),
                datasource_group_id: Set(Some(datasource_group.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_signal_message_group(
            &env.dbx,
            signal_message_group::ActiveModel {
                signal_message_id: Set(signal_message.id),
                group_master_key: Set(Some(
                    datasource_group.group_master_key.clone(),
                )),
                datasource_group_id: Set(Some(datasource_group.id)),
                sender: Set(Some("sender-1".to_string())),
                message_uid: Set(Some("peleng-only-message".to_string())),
                created_at: Set(dt),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_inbox_item(
            &env.dbx,
            sigint_inbox_item::ActiveModel {
                id: Set(signal_message.id),
                date: Set(Some(dt.date().to_string())),
                time: Set(Some(dt.time().format("%H:%M:%S").to_string())),
                freq: Set(Some("138.500".to_string())),
                lat: Set(None),
                lng: Set(None),
                coords: Set(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_peleng(
            &env.dbx,
            sigint_peleng::ActiveModel {
                source_inbox_item_id: Set(signal_message.id),
                lat: Set(48.1),
                lng: Set(37.2),
                created_at: Set(dt),
                deleted: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let messages = get_inbox_messages_report(
            &login.id,
            &env,
            &InboxMessagesReq {
                since_date_inclusive_ms: Some(
                    (dt - chrono::Duration::days(1))
                        .and_utc()
                        .timestamp_millis(),
                ),
                till_date_inclusive_ms: Some(
                    (dt + chrono::Duration::days(1))
                        .and_utc()
                        .timestamp_millis(),
                ),
                nolimit: Some(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].0, signal_message.id);
        assert_eq!(messages[0].1, Some((48.1, 37.2)));
    }
}
