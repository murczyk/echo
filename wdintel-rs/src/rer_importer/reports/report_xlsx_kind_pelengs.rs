use super::super::types::*;
use crate::entities::{prelude::*, *};
use crate::error::AppError;
use crate::location::peleng::collect_inbox_pelengs;
use crate::rer_importer::analysis::*;
use crate::types::*;
use actix_identity::Identity;
use anyhow::bail;
use chrono::prelude::*;
use itertools::Itertools;
use sea_orm::*;
use sea_query::SimpleExpr;
use std::collections::BTreeMap;

use geoconvert::{LatLon, Mgrs};
use std::path::PathBuf;

#[derive(Debug, Clone, FromQueryResult)]
struct Message {
    pub id: i64,
    pub body: String,
    pub timestamp: Option<chrono::NaiveDateTime>,
    pub sender: String,
    pub date: Option<String>,
    pub time: Option<String>,
    pub freq: Option<String>,
    pub callsigns: Option<serde_json::Value>,
    pub checked: Option<bool>,
    pub unit: Option<String>,
    pub location: Option<String>,
}

pub async fn get_inbox_messages_report(
    user: &Identity,
    env: &Env,
    req: &InboxMessagesReq,
) -> Result<Vec<(i64, Option<(f64, f64)>, InboxMessage)>, AppError> {
    let login = user.id().c(h!())?;
    let include_peleng_locations =
        req.include_peleng_locations.unwrap_or(false);

    let mut q = SignalMessage::find()
        .inner_join(sigint_inbox_item::Entity)
        .inner_join(datasource_group::Entity)
        .select_only()
        .column(signal_message::Column::Id)
        .column(signal_message::Column::Body)
        .column(signal_message::Column::Timestamp)
        .column(signal_message::Column::Sender)
        .column(sigint_inbox_item::Column::Date)
        .column(sigint_inbox_item::Column::Time)
        .column(sigint_inbox_item::Column::Freq)
        .column(sigint_inbox_item::Column::Callsigns)
        .column(sigint_inbox_item::Column::Checked)
        .column_as(sigint_inbox_item::Column::LocationV2, "location")
        .column_as(
            SimpleExpr::Custom(r#"
                COALESCE(
                    array_to_string(
                        NULLIF(
                            array_agg(
                                CASE sigint_network_freq.kind
                                  WHEN 'VHF' THEN 'УКХ'
                                  ELSE sigint_network_freq.kind::text END || ' р/м ' || sigint_network.name || ' ' || sigint_unit.name || ' (' || UPPER(sigint_network.location) || ')'
                            )
                            FILTER
                            (WHERE sigint_unit.name IS NOT NULL),
                        '{}'),
                        ', '
                    ),
                    sigint_inbox_item.unit_v2
                )
            "#.to_string()),
            "unit",
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(Condition::any()
        .add(sigint_network::Column::Deleted.eq(false))
        .add(sigint_network::Column::Id.is_null()))
        .filter(Condition::any()
        .add(sigint_network_freq::Column::Deleted.eq(false))
        .add(sigint_network_freq::Column::Id.is_null()))
        .filter(Condition::any()
        .add(sigint_unit::Column::Deleted.eq(false))
        .add(sigint_unit::Column::Id.is_null()))
        .filter(sigint_inbox_item::Column::Lng.is_not_null())
        .filter(sigint_inbox_item::Column::Lat.is_not_null())
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintNetworkFreq.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_network_freq::Relation::SigintNetwork.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_network::Relation::SigintNetworkUnit.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_network_unit::Relation::SigintUnit.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintPost.def(),
        )
        .group_by(signal_message::Column::Id)
        .group_by(sigint_inbox_item::Column::Id)
        .filter(datasource_group::Column::GroupMasterKey.is_in(
            crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login).await.c(h!())?,
        ));

    q = crate::rer_importer::inbox::query::get_order_by(env, req, q.clone())
        .await
        .c(h!())?;
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
    let q = filter_selected_posts(q, &req.selected_posts)?;
    let q = filter_denied_freqs(q, &req.denied_freqs)?;
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
        &user.id().c(h!())?,
    )?;
    let q = filter_selected_locations(
        q,
        &req.selected_locations,
        include_peleng_locations,
    )?;
    let q = filter_selected_aors(q, &req.selected_aors).context(h!())?;
    let q =
        filter_selected_networks(q, &req.selected_networks).context(h!())?;

    trace!(
        "[get_inbox_messages_report] query: {}",
        &q.build(DbBackend::Postgres)
    );
    info!("[get_inbox_messages_report] {}", Utc::now());

    let messages: Vec<Message> =
        q.into_model::<Message>().all(&env.dbx).await.c(h!())?;

    let messages = deduplicate(&messages).context(h!())?;

    let mut item_ids = vec![];
    let mut sigint_pelengs = vec![];
    let mut items_map = BTreeMap::new();
    for item in messages {
        item_ids.push(item.id);
        items_map.insert(item.id, item);
        if item_ids.len() > 1000 {
            let pelengs = collect_inbox_pelengs(item_ids, &env.dbx)
                .await
                .context(h!())?;
            sigint_pelengs.push(pelengs);
            item_ids = vec![];
        }
    }
    sigint_pelengs.push(
        collect_inbox_pelengs(item_ids, &env.dbx)
            .await
            .context(h!())?,
    );

    let mut pelengs_map = BTreeMap::<i64, Vec<sigint_peleng::Model>>::new();
    for peleng in sigint_pelengs.into_iter().flat_map(|s| s.into_iter()) {
        pelengs_map
            .entry(peleng.source_inbox_item_id)
            .or_default()
            .push(peleng);
    }
    info!(
        "[get_inbox_messages_report] {}: query completed",
        Utc::now()
    );

    let mut res: Vec<(i64, Option<(f64, f64)>, InboxMessage)> = vec![];
    for (id, m) in items_map {
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
            res.push((
                m.id,
                coords_tuple,
                InboxMessage {
                    message_uid: None,
                    location,
                    coords,
                    text: m.body.clone(),
                    images: vec![],
                    image_recognized: vec![],
                    date: m.date.clone(),
                    time: m.time.clone(),
                    freq: m.freq.clone(),
                    callsigns: serde_json::from_value(
                        m.callsigns.clone().unwrap_or_default(),
                    )
                    .unwrap_or_else(|_| vec![]),
                    checked: m.checked.unwrap_or(false),
                    timestamp: m
                        .timestamp
                        .map(|x| x.and_utc().timestamp_millis()),
                    group_master_key: None,
                    sender: Some(m.sender.clone()),
                    duplicate_ids: None,
                    extended_form: None,
                    unit: m.unit.clone(),
                    callsign_tokens: None,
                    keyword_tokens: None,
                    signal_tokens: None,
                    text_marked: None,
                    post: None,
                    post_id: None,
                    no_headers_body: None,
                    datasource_id: None,
                    tags: None,
                    callsigns_alg2: vec![],
                    network_ids: None,
                },
            ));
        }
    }

    info!("[get_inbox_messages_report] {}: query done", Utc::now());
    Ok(res)
}

fn deduplicate(messages: &Vec<Message>) -> Result<Vec<Message>, AppError> {
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut res = vec![];
    for msg in messages {
        if seen.insert(msg.body.clone()) {
            res.push(msg.clone());
        }
    }
    Ok(res)
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
    user: actix_identity::Identity,
    env: &Env,
    req: &super::ReportPreviewReq,
    outpath: &PathBuf,
) -> Result<(), AppError> {
    info!("[report_xlsx_kind_pelengs1] started");

    let mut workbook = rust_xlsxwriter::Workbook::new();
    let sheet1 = workbook.add_worksheet().set_name("Пеленги").context(h!())?;
    let coltitle = xls_title();

    let till: DateTime<Utc> = chrono::Utc
        .timestamp_millis_opt(req.req.till_date_inclusive_ms.unwrap_or(0))
        .single()
        .unwrap();
    let since: DateTime<Utc> = chrono::Utc
        .timestamp_millis_opt(req.req.since_date_inclusive_ms.unwrap_or(0))
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
            &user,
            env,
            &req.req,
        )
        .await.c(h!())?;
    info!("[report_xlsx_kind_pelengs1] {}: query done", Utc::now());

    // Build sender display names map (uuid -> profile entry)
    let sender_uuids = messages
        .iter()
        .filter_map(|(_, _, m)| m.sender.clone())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let sender_names: BTreeMap<String, Option<SignalProfileEntry>> =
        crate::rer_importer::collect_profiles_data(&env.dbx, sender_uuids)
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
                format!("{}, {}", &time, &date.format("%d.%m.%y")),
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
            _ => bail!("failed to parse: {}", dir),
        },
    }
}
