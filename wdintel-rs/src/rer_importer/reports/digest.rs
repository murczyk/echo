use super::super::types::*;
use crate::entities::*;
use crate::error::AppError;
use crate::rer_importer::report_chunking::{
    build_filtered_inbox_report_chunk_query, inbox_report_chunk_req,
    inbox_report_period_chunks, ReportPeriodChunk, ReportPeriodEnd,
};
use crate::rer_importer::reports::inbox_light::{
    blank_inbox_message, load_message_group_info, parse_optional_json_vec,
};
use crate::rer_importer::reports::util;
use crate::rer_importer::reports::util::*;
use crate::types::*;
use anyhow::Context;
use chrono::prelude::*;
use docx_rs::*;
use sea_orm::prelude::Json;
use sea_orm::*;
use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::path::Path;

const DOC_NAME: &str = "Форма №1.2.17/ОСУВ";
const DOC_HEADER: &str =
    "Донесення за результатами ведення радіоелектронної розвідки";

const WIDTH_UNIT: usize = 785;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SigintBodyNoHeader {
    pub start: Option<i64>,
    pub end: Option<i64>,
    pub body: String,
}

pub struct Report {
    pub aor_data: Vec<AorRow>,
    skip_aor_cell: bool,
}

pub struct AorRow {
    pub aor_name: String,
    pub network_data: Vec<NetworkRow>,
}

pub struct NetworkRow {
    pub network_name: String,
    pub network_location: Option<String>,
    pub notes: Vec<InterNote>,
    pub unit: Option<Vec<String>>,
    pub unit_name: Option<String>,
    pub is_anonymous: bool,
}

pub struct InterNote {
    pub time: Option<NaiveDateTime>,
    pub comment: String,
    pub interception: Option<String>,
    pub interception_form_1217: Option<String>,
    pub interception_id: Option<String>,
    pub details: InterceptionDetails,
}

pub struct InterceptionDetails {
    pub date: Option<String>,
    pub freq: Option<String>,
    pub location: Option<String>,
    pub unit: Option<String>,
    pub time: Option<String>,
    pub who_callsign: Option<String>,
    pub to_callsigns: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone, FromQueryResult)]
pub struct NetworkSummary {
    pub id: i64,
    pub name: String,
    pub location: Option<String>,
    pub freq: String,
    pub unit_id: Option<i64>,
    pub group_aor_id: Option<i64>,
    pub aor_id: Option<i64>,
    pub master_key: Option<String>,
    pub unit: Option<Vec<String>>,
    pub unit_name: Option<String>,
}

#[derive(Debug, FromQueryResult)]
struct DigestMessageRow {
    id: i64,
    message_uid: Option<String>,
    body: Option<String>,
    timestamp: Option<NaiveDateTime>,
    freq: Option<String>,
    coords: Option<String>,
    callsign_tokens: Option<serde_json::Value>,
    location: Option<String>,
    location_v2: Option<String>,
    date: Option<String>,
    time: Option<String>,
    unit: Option<String>,
}

pub async fn report_docx_kind_digest(
    user_login: &uuid::Uuid,
    env: &Env,
    req: &super::types::ReportPreviewReq,
    outpath: &Path,
) -> Result<(), AppError> {
    info!("report_docx_kind_digest started");
    let read_db = env.replica();
    let report_since = DateTime::from_timestamp_millis(
        req.req.since_date_inclusive_ms.context(h!())?,
    )
    .context(h!())?;
    let report_till = match &req.req.till_date_inclusive_ms {
        None => Utc::now(),
        Some(epoch_millis) => {
            DateTime::from_timestamp_millis(*epoch_millis).context(h!())?
        }
    };
    let show_date = check_should_show_date(report_since, report_till);
    let login = *user_login;
    let login_ids =
        crate::users::get_organism_login_ids_by_id(&read_db, &login)
            .await
            .context(h!())?;
    let mut request = req.req.clone();
    request.report_tags_only_this_unit = Some(false);
    request.or_with_extended_form = Some(true); // with comments only
    request.till_date_inclusive_ms = Some(report_till.timestamp_millis());
    let report_settings =
        crate::system_settings::get_report_generation_settings(&env.dbx)
            .await
            .c(h!())?;
    let chunks =
        inbox_report_period_chunks(&request, report_settings.chunking_hours)
            .context(h!())?;
    let analytics_req = &request;
    let postgres_req = &request;
    let analytics_chunks = &chunks;
    let postgres_chunks = &chunks;
    let messages = crate::rer_importer::analysis::with_analytics_read_fallback(
        env,
        "digest report interception scan",
        crate::rer_importer::analysis::analytics_inbox_request_supported(
            &request,
        ),
        |db| async move {
            load_digest_messages_chunks(
                &db,
                &login,
                env,
                analytics_req,
                analytics_chunks,
            )
            .await
        },
        |db| async move {
            load_digest_messages_chunks(
                &db,
                &login,
                env,
                postgres_req,
                postgres_chunks,
            )
            .await
        },
    )
    .await
    .context(h!())?;
    let report = collect_report(
        messages,
        login_ids.clone(),
        req.report_tags_only_this_unit.unwrap_or(false),
        &read_db,
    )
    .await
    .context(h!())?;
    info!("report_docx_kind_digest data collected");
    let omit_exo_id = req.digest_omit_exo_id.unwrap_or(false);
    let use_form_1217 = req.digest_form_1_2_17.unwrap_or(false);

    let config = DocxConfig {
        columns_count: 2,
        width_unit: WIDTH_UNIT,
        highlight_color: "FF0000".to_string(),
        split_multiline_cells: false,
        paragraph_spacing: None,
    };

    let form_paragraph = Paragraph::new()
        .add_run(Run::new().add_text(DOC_NAME))
        .align(AlignmentType::Right);

    let title_paragraph = Paragraph::new()
        .add_run(Run::new().add_text(DOC_HEADER).bold())
        .align(AlignmentType::Center);

    let timestamp_txt =
        format!("(станом на {})", convert_utc_to_kyiv_time(report_till));

    let timestamp_paragraph = Paragraph::new()
        .add_run(Run::new().add_text(&timestamp_txt))
        .align(AlignmentType::Center);

    let mut rows_amrp: Vec<TableRow> = vec![];
    rows_amrp.push(TableRow::new(vec![
        mk_cell(
            &config,
            mk_paragraph(
                "Висновки",
                util::ParagraphStyle::BoldAndItalic,
                &config,
            )
            .align(AlignmentType::Center),
        ),
        mk_cell(
            &config,
            mk_paragraph(
                "Радіоперехоплення",
                util::ParagraphStyle::BoldAndItalic,
                &config,
            )
            .align(AlignmentType::Center),
        ),
    ]));
    for aor_row in report.aor_data {
        if aor_row.network_data.is_empty() {
            continue;
        } else {
            let has_elements = aor_row
                .network_data
                .iter()
                .filter(|x| !x.notes.is_empty())
                .count();
            if has_elements < 1 {
                continue;
            }
        }
        if !report.skip_aor_cell {
            rows_amrp.push(TableRow::new(vec![mk_merged_text_cell(
                &aor_row.aor_name,
                false,
                util::ParagraphStyle::BoldAndItalic,
                &config,
            )]));
        }
        for network_row in aor_row.network_data {
            if network_row.notes.is_empty() {
                continue;
            }
            let header = {
                // Join unit list if present
                debug!("units raw: {:?}", &network_row.unit);
                let units_alt = match &network_row.unit {
                    Some(units) if !units.is_empty() => {
                        format!(" {}", units.join(", "))
                    }
                    _ => String::new(),
                };
                let units = network_row.unit_name.unwrap_or(units_alt);

                debug!("units processed: {units}");

                // Add location if present
                let location = match &network_row.network_location {
                    Some(loc) if !loc.is_empty() => format!(" ({loc})"),
                    _ => String::new(),
                };

                debug!("network: {}", network_row.network_name);

                // Build final string
                format!("{}{}{}", network_row.network_name, units, location)
            };
            rows_amrp.push(TableRow::new(vec![mk_merged_text_cell(
                &header,
                false,
                util::ParagraphStyle::BoldAndItalic,
                &config,
            )]));
            for note in network_row.notes {
                let note_txt =
                    build_note_comment(&note, show_date, use_form_1217);
                let Some(inter_cell) = build_interception_cell(
                    &note,
                    omit_exo_id,
                    use_form_1217,
                    &config,
                ) else {
                    continue;
                };
                let comment_cell = mk_text_cell(
                    &note_txt,
                    util::ParagraphStyle::Italic,
                    &config,
                )
                .vertical_align(VAlignType::Top);
                rows_amrp.push(TableRow::new(vec![comment_cell, inter_cell]));
            }
        }
    }

    let thin_border = TableBorder::new(TableBorderPosition::Top)
        .border_type(BorderType::Single)
        .size(12);
    let table_amrp = Table::new(rows_amrp)
        .width(WIDTH_UNIT * 12, WidthType::Dxa)
        .set_border(thin_border)
        .align(TableAlignmentType::Center);

    let docx = Docx::new()
        .page_orient(PageOrientationType::Portrait)
        .default_size(20)
        .page_size(11906, 16838)
        .page_margin(PageMargin::new().left(600).right(300).top(1200))
        .add_paragraph(form_paragraph)
        .add_paragraph(mk_paragraph("", util::ParagraphStyle::Default, &config))
        .add_paragraph(title_paragraph)
        .add_paragraph(timestamp_paragraph)
        .add_paragraph(Paragraph::new())
        .add_table(table_amrp);
    info!("report_docx_kind_digest done, saving to file...");
    let file = std::fs::File::create(outpath).context(h!())?;
    docx.build().pack(file).context(h!())?;

    info!("report_docx_kind_digest completed");
    Ok(())
}

async fn load_digest_messages_chunks(
    dbx: &DatabaseConnection,
    login: &uuid::Uuid,
    env: &Env,
    req: &InboxMessagesReq,
    chunks: &[ReportPeriodChunk],
) -> Result<Vec<(i64, InboxMessage)>, AppError> {
    let mut messages = BTreeMap::new();
    for (index, chunk) in chunks.iter().copied().enumerate() {
        info!(
            "Digest report chunk {}/{}: {}..{} ({:?})",
            index + 1,
            chunks.len(),
            chunk.since_ms,
            chunk.till_ms,
            chunk.end
        );
        let chunk_req = inbox_report_chunk_req(req, chunk);
        for (id, message) in
            load_digest_messages(dbx, login, env, &chunk_req, chunk.end)
                .await
                .context(h!())?
        {
            messages.entry(id).or_insert(message);
        }
    }
    Ok(messages.into_iter().collect())
}

async fn load_digest_messages(
    dbx: &DatabaseConnection,
    login: &uuid::Uuid,
    env: &Env,
    req: &InboxMessagesReq,
    period_end: ReportPeriodEnd,
) -> Result<Vec<(i64, InboxMessage)>, AppError> {
    let rows = build_filtered_inbox_report_chunk_query(
        dbx, login, env, req, period_end,
    )
    .await
    .context(h!())?
    .select_only()
    .column_as(signal_message::Column::Id, "id")
    .column_as(signal_message::Column::MessageUid, "message_uid")
    .column_as(signal_message::Column::Body, "body")
    .column_as(signal_message::Column::Timestamp, "timestamp")
    .column_as(sigint_inbox_item::Column::Freq, "freq")
    .column_as(sigint_inbox_item::Column::Coords, "coords")
    .column_as(sigint_inbox_item::Column::CallsignTokens, "callsign_tokens")
    .column_as(sigint_inbox_item::Column::Location, "location")
    .column_as(sigint_inbox_item::Column::LocationV2, "location_v2")
    .column_as(sigint_inbox_item::Column::Date, "date")
    .column_as(sigint_inbox_item::Column::Time, "time")
    .column_as(sigint_inbox_item::Column::UnitV2, "unit")
    .into_model::<DigestMessageRow>()
    .all(dbx)
    .await
    .context(h!())?;
    let message_ids = rows.iter().map(|row| row.id).collect_vec();
    let mut groups_by_message =
        load_message_group_info(dbx, login, req, &message_ids)
            .await
            .context(h!())?;
    let mut normalized_callsigns =
        crate::inbox::callsigns::load_by_item_ids(dbx, &message_ids).await?;

    rows.into_iter()
        .map(|row| {
            let callsigns =
                normalized_callsigns.remove(&row.id).unwrap_or_default();
            let group_info = groups_by_message.remove(&row.id);
            let mut message = blank_inbox_message();
            message.message_uid = row.message_uid;
            message.text = row.body.unwrap_or_default();
            message.timestamp = row
                .timestamp
                .map(|timestamp| timestamp.and_utc().timestamp_millis());
            message.freq = row.freq;
            message.coords = row.coords;
            message.callsigns = callsigns.primary;
            message.callsigns_alg2 = callsigns.alg2;
            message.callsign_tokens =
                Some(parse_optional_json_vec(row.callsign_tokens)?);
            message.location =
                crate::rer_importer::inbox::format_inbox_message_location(
                    row.location,
                    row.location_v2,
                );
            message.date = row.date;
            message.time = row.time;
            message.unit = row.unit;
            message.group_master_key =
                group_info.and_then(|group| group.group_master_key);
            Ok((row.id, message))
        })
        .collect()
}

fn build_note_comment(
    note: &InterNote,
    show_date: bool,
    use_form_1217: bool,
) -> String {
    if use_form_1217 {
        return note.comment.clone();
    }

    match note.time {
        None => note.comment.clone(),
        Some(dt) => match show_date {
            false => format!("{} {}", dt.time().format("%H:%M"), note.comment),
            true => format!("{} {}", dt.format("%d.%m %H:%M"), note.comment),
        },
    }
}

fn build_interception_cell(
    note: &InterNote,
    omit_exo_id: bool,
    use_form_1217: bool,
    config: &DocxConfig,
) -> Option<TableCell> {
    let mut paragraphs = vec![];
    if !omit_exo_id {
        if let Some(paragraph) = build_exo_id_paragraph(note) {
            paragraphs.push(paragraph);
        }
    }
    if use_form_1217 {
        paragraphs.extend(build_form_1217_paragraphs(&note.details, config));
    }
    let interception = if use_form_1217 {
        note.interception_form_1217.as_ref()
    } else {
        note.interception.as_ref()
    };
    if let Some(interception) = interception {
        for line in interception.split('\n') {
            paragraphs.push(mk_paragraph(
                line,
                util::ParagraphStyle::Italic,
                config,
            ));
        }
    }

    let mut paragraphs = paragraphs.into_iter();
    let first = paragraphs.next()?;
    let mut cell = mk_cell(config, first);
    for paragraph in paragraphs {
        cell = cell.add_paragraph(paragraph);
    }
    Some(cell.vertical_align(VAlignType::Top))
}

fn build_exo_id_paragraph(note: &InterNote) -> Option<Paragraph> {
    note.interception_id.as_ref().map(|text| {
        Paragraph::new().add_run(
            mk_text(&format!("EXO ID {text}"), &util::ParagraphStyle::Italic)
                .color("808080")
                .size(16),
        )
    })
}

fn build_form_1217_paragraphs(
    details: &InterceptionDetails,
    config: &DocxConfig,
) -> Vec<Paragraph> {
    let mut lines = vec![
        ("Дата", details.date.as_deref().unwrap_or("")),
        ("Частота", details.freq.as_deref().unwrap_or("")),
        ("Локація", details.location.as_deref().unwrap_or("")),
        ("Підрозділ", details.unit.as_deref().unwrap_or("")),
        ("Час", details.time.as_deref().unwrap_or("")),
    ];
    if let Some(who_callsign) = details.who_callsign.as_deref() {
        lines.push(("Хто", who_callsign));
    }
    if let Some(to_callsigns) = details.to_callsigns.as_deref() {
        lines.push(("Кому", to_callsigns));
    }
    lines
        .into_iter()
        .map(|(label, value)| {
            mk_paragraph(
                &format!("{label}: {value}"),
                util::ParagraphStyle::Italic,
                config,
            )
        })
        .collect()
}

fn check_should_show_date(since: DateTime<Utc>, till: DateTime<Utc>) -> bool {
    let tz = crate::config::get_tz();
    let since_local =
        since.with_timezone(&tz).naive_local() + chrono::Duration::seconds(1);
    let till_local =
        till.with_timezone(&tz).naive_local() - chrono::Duration::seconds(1);
    since_local.date() != till_local.date()
}

async fn collect_report(
    messages: Vec<(i64, InboxMessage)>,
    logins: Vec<uuid::Uuid>,
    comments_only_this_unit: bool,
    dbx: &DatabaseConnection,
) -> anyhow::Result<Report> {
    let (comments, messages) = load_messages_with_comments(
        messages,
        dbx,
        comments_only_this_unit.then_some(logins.as_slice()),
    )
    .await
    .c(h!())?;
    debug!("loaded {} messages with comments {}", messages.len(), h!());

    let freqs = messages
        .iter()
        .flat_map(|(_, m)| m.freq.clone())
        .unique()
        .collect::<Vec<_>>();
    let groups = messages
        .iter()
        .flat_map(|(_, m)| m.group_master_key.clone())
        .unique()
        .collect::<Vec<_>>();

    let networks = collect_networks(dbx, freqs, &groups).await.context(h!())?;
    let sigint_unit_ids = networks
        .values()
        .flat_map(|n| n.unit_id)
        .collect::<Vec<_>>();

    let network_units = sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Id.eq_any(sigint_unit_ids))
        .all(dbx)
        .await
        .context(h!())?
        .into_iter()
        .map(|unit| {
            let unit_name = unit.name.clone();
            let mut unit_data = vec![
                unit.army,
                unit.division,
                unit.battalion,
                unit.company,
                unit.regiment,
            ];
            unit_data.reverse();
            let mut result = vec![];
            let mut started_collecting = false;
            for unit in unit_data {
                if unit.is_empty() {
                    if started_collecting {
                        result.push(unit);
                    }
                    continue;
                }
                started_collecting = true;
                result.push(unit);
            }
            result.reverse();
            (unit.id, (unit_name, result))
        })
        .collect::<HashMap<_, _>>();

    let group_aors = signal_group_aor::Entity::find()
        .filter(signal_group_aor::Column::MasterKey.eq_any(groups.clone()))
        .all(dbx)
        .await
        .context(h!())?
        .into_iter()
        .map(|g| (g.master_key.clone(), g.aor_id))
        .collect::<HashMap<_, _>>();

    let aors = load_aors(dbx).await.context(h!())?;
    let skip_aor_cell = aors.len() == 1;

    let mut networks_dictionary = {
        let mut result = HashMap::new();
        for n in networks.values() {
            result.insert(n.id, n.clone());
        }
        result
    };

    let mut network_comments_map = HashMap::new();
    let mut unmapped_freqs = HashMap::new();
    let mut network_keys = HashSet::new();
    for (id, message) in &messages {
        let is_pure_peleng = message.coords.is_some()
            && message.callsign_tokens.clone().unwrap_or(vec![]).is_empty();
        if is_pure_peleng {
            continue;
        }
        let (Some(master_key), Some(freq)) =
            (&message.group_master_key, &message.freq)
        else {
            continue;
        };
        let m_network_summary = networks
            .get(&(freq.clone(), Some(master_key.clone())))
            .or(networks.get(&(freq.clone(), None)))
            .cloned();
        let mut summary = match m_network_summary {
            None => {
                let Ok(freq_num) = freq.parse::<f64>() else {
                    error!("[{}] bad freq: {freq}", h!());
                    continue;
                };
                let id = -((freq_num * 10000.0).ceil() as i64);
                if let Some(existing_id) = unmapped_freqs
                    .keys()
                    .copied()
                    .find(|f: &i64| (*f - id).abs() < 250)
                {
                    networks_dictionary
                        .get(&existing_id)
                        .cloned()
                        .context(h!())?
                } else {
                    let mut freqs =
                        unmapped_freqs.remove(&id).unwrap_or(vec![]);
                    freqs.push(freq.clone());
                    unmapped_freqs.insert(id, freqs);
                    let new_summary = NetworkSummary {
                        id,
                        group_aor_id: group_aors.get(master_key).cloned(),
                        master_key: Some(master_key.clone()),
                        name: "".to_string(),
                        freq: freq.clone(),
                        unit_id: None,
                        location: None,
                        aor_id: None,
                        unit: None,
                        unit_name: None,
                    };
                    networks_dictionary
                        .insert(new_summary.id, new_summary.clone());
                    new_summary
                }
            }
            Some(s) => s,
        };
        let (unit_name, unit) = summary
            .unit_id
            .and_then(|id| network_units.get(&id).cloned())
            .map(|(x, y)| (Some(x), Some(y)))
            .unwrap_or((None, None));
        summary.unit = unit;
        summary.unit_name = unit_name;
        let mut list =
            network_comments_map.remove(&summary.id).unwrap_or(vec![]);
        for comment in comments.iter().filter(|(cid, _)| id == cid).cloned() {
            list.push(comment);
        }
        network_comments_map.insert(summary.id, list);
        network_keys.insert((summary.name.clone(), summary.id, freq));
    }

    let mut aor_dictionary = HashMap::new();
    let default_aor = crate::sigint::aor::load_default_aor(dbx)
        .await
        .context(h!())?;
    for (id, n) in networks_dictionary.clone() {
        let aor_id = n.aor_id.or(n.group_aor_id).unwrap_or(default_aor.id);
        let mut data = aor_dictionary.remove(&aor_id).unwrap_or(vec![]);
        data.push(id);
        aor_dictionary.insert(aor_id, data);
    }
    let mut aors = aors.values().cloned().collect::<Vec<_>>();
    aors.sort_by_key(|a| (a.right_bound * 1000.0).ceil() as i64);

    let mut aor_data = vec![];
    let messages = messages.into_iter().collect::<HashMap<_, _>>();
    for aor in aors {
        let Some(network_ids) = aor_dictionary.remove(&aor.id) else {
            continue;
        };
        let aor_name = aor.name;
        let mut network_data = vec![];
        for id in network_ids {
            let network = networks_dictionary.get(&id).context(h!())?;
            let unit = network.unit.clone();
            let unit_name = network.unit_name.clone();
            let comments = network_comments_map.remove(&id).unwrap_or(vec![]);
            let is_anonymous = network.name.trim().is_empty();
            let mut network_name = network.name.clone();
            if network_name.trim().is_empty() {
                network_name = format!(
                    "Невизначена радіомережа {}МГц",
                    network.freq.clone()
                );
            }
            let network_location = network
                .location
                .clone()
                .map(|l| l.trim().to_string())
                .map(|l| {
                    if l.starts_with("(") {
                        l.replace("(", "").replace(")", "")
                    } else {
                        l
                    }
                })
                .filter(|l| !l.is_empty());
            let mut notes = vec![];
            for (message_id, comment) in comments {
                let message = messages.get(&message_id).context(h!())?.clone();
                let callsigns_prefix =
                    crate::rer_importer::callsigns::analyze_callsigns_prefix(
                        &message.text,
                        &message,
                    );
                let (who_callsign, to_callsigns) =
                    extract_form_1217_callsigns(&message, &callsigns_prefix);
                // todo if message is missing, from a secret chat or other edge case - don't put it here, put Right(message_id) instead
                let time = message
                    .timestamp
                    .and_then(chrono::DateTime::from_timestamp_millis)
                    .map(|ts| {
                        ts.with_timezone(&crate::config::get_tz()).naive_local()
                    });
                let details = InterceptionDetails {
                    date: extract_message_date(&message),
                    freq: sanitize_optional_text(message.freq.clone()),
                    location: sanitize_optional_text(message.location.clone())
                        .or_else(|| network_location.clone()),
                    unit: extract_message_unit(
                        &message,
                        unit_name.as_ref(),
                        unit.as_ref(),
                    ),
                    time: extract_message_time(&message),
                    who_callsign,
                    to_callsigns,
                };
                notes.push(InterNote {
                    time,
                    comment,
                    interception: Some(message.text.clone()),
                    interception_form_1217: Some(
                        callsigns_prefix.stripped_body,
                    ),
                    interception_id: message.message_uid.clone(),
                    details,
                });
            }
            notes.sort_by(|x, y| match (x.time, y.time) {
                (Some(t1), Some(t2)) => t1.cmp(&t2),
                (t1, t2) => compare_options(&t1, &t2).reverse(),
            });
            network_data.push(NetworkRow {
                network_name,
                network_location,
                notes,
                unit,
                unit_name,
                is_anonymous,
            });
        }
        network_data.sort_by(compare_network_rows);
        aor_data.push(AorRow {
            aor_name,
            network_data,
        });
    }
    Ok(Report {
        aor_data,
        skip_aor_cell,
    })
}

fn compare_options<T>(a: &Option<T>, b: &Option<T>) -> Ordering {
    if a.is_some() && b.is_none() {
        return Ordering::Greater;
    }
    if a.is_none() && b.is_some() {
        return Ordering::Less;
    }
    Ordering::Equal
}

fn compare_units(u1: &Vec<String>, u2: &Vec<String>) -> Ordering {
    let mut unit_names_1 = u1.iter();
    let mut unit_names_2 = u2.iter();
    loop {
        let unit_name_1 = unit_names_1.next();
        let unit_name_2 = unit_names_2.next();
        match (unit_name_1, unit_name_2) {
            (Some(s1), Some(s2)) => {
                if s1.eq_ignore_ascii_case(s2) {
                    continue;
                }
                s1.cmp(s2)
            }
            (a, b) => return compare_options(&a, &b),
        };
    }
}

fn compare_network_rows(n1: &NetworkRow, n2: &NetworkRow) -> Ordering {
    match n1.is_anonymous.cmp(&n2.is_anonymous) {
        Ordering::Equal => match (&n1.unit, &n2.unit) {
            (Some(u1), Some(u2)) => compare_units(u1, u2),
            (a, b) => compare_options(a, b).reverse(),
        },
        ordering => ordering,
    }
    .then_with(|| n1.network_name.cmp(&n2.network_name))
}

async fn collect_networks(
    dbx: &DatabaseConnection,
    freqs: Vec<String>,
    groups: &Vec<String>,
) -> anyhow::Result<HashMap<(String, Option<String>), NetworkSummary>> {
    let all_networks = sigint_network::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_network::Relation::SigintNetworkFreq.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_network::Relation::SigintNetworkAor.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_network::Relation::SigintNetworkUnit.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_network_unit::Relation::SigintUnit.def(),
        )
        .filter(sigint_network_freq::Column::Freq.eq_any(freqs.clone()))
        .filter(sigint_network::Column::Deleted.eq(false))
        .filter(sigint_network::Column::Name.is_not_null())
        .select_only()
        .column(sigint_network::Column::Id)
        .column(sigint_network::Column::Name)
        .column(sigint_network::Column::Location)
        .column(sigint_network_freq::Column::Freq)
        .column(sigint_network_aor::Column::AorId)
        .column_as(sigint_unit::Column::Name, "unit_name")
        .into_model::<NetworkSummary>()
        .all(dbx)
        .await
        .context(h!())?
        .into_iter()
        .map(|s| ((s.freq.clone(), None), s))
        .collect::<HashMap<_, _>>();

    let mut networks = sigint_network::Entity::find()
        .join(
            JoinType::LeftJoin,
            sigint_network::Relation::SigintNetworkFreq.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_network::Relation::SigintNetworkAor.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_network_aor::Relation::AreaOfResponsibility.def(),
        )
        .join(
            JoinType::LeftJoin,
            area_of_responsibility::Relation::SignalGroupAor.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_network::Relation::SigintNetworkUnit.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_network_unit::Relation::SigintUnit.def(),
        )
        .filter(sigint_network_freq::Column::Freq.eq_any(freqs))
        .filter(
            signal_group_aor::Column::Id
                .is_null()
                .or(signal_group_aor::Column::MasterKey.eq_any(groups.clone())),
        )
        .filter(sigint_network::Column::Deleted.eq(false))
        .filter(
            area_of_responsibility::Column::Id
                .is_null()
                .or(area_of_responsibility::Column::Deleted.eq(false)),
        )
        .filter(sigint_network::Column::Name.is_not_null())
        .filter(sigint_network_freq::Column::Freq.is_not_null())
        .select_only()
        .column(sigint_network::Column::Id)
        .column(sigint_network::Column::Name)
        .column(sigint_network::Column::Location)
        .column(sigint_network_freq::Column::Freq)
        .column(signal_group_aor::Column::MasterKey)
        .column(signal_group_aor::Column::AorId)
        .column_as(sigint_unit::Column::Name, "unit_name")
        .into_model::<NetworkSummary>()
        .all(dbx)
        .await
        .context(h!())?
        .into_iter()
        .map(|s| ((s.freq.clone(), s.master_key.clone()), s))
        .collect::<HashMap<_, _>>();

    for (k, v) in all_networks {
        networks.insert(k, v);
    }
    Ok(networks)
}

async fn load_aors(
    dbx: &DatabaseConnection,
) -> anyhow::Result<HashMap<i64, area_of_responsibility::Model>> {
    let areas = area_of_responsibility::Entity::find()
        .all(dbx)
        .await
        .context(h!())?
        .into_iter()
        .map(|a| (a.id, a))
        .collect::<HashMap<_, _>>();
    Ok(areas)
}

async fn load_messages_with_comments(
    messages: Vec<(i64, InboxMessage)>,
    dbx: &DatabaseConnection,
    allowed_comment_logins: Option<&[uuid::Uuid]>,
) -> anyhow::Result<(Vec<(i64, String)>, Vec<(i64, InboxMessage)>)> {
    let message_ids = messages
        .iter()
        .map(|(id, _)| *id)
        .collect_vec()
        .chunks(20000)
        .map(|slice| slice.to_vec())
        .collect_vec();

    let mut comments = vec![];
    let mut messages_with_comment = HashSet::new();
    let mut new_bodies = HashMap::new();
    let mut message_public_ids = HashMap::<i64, String>::new(); // todo fetch from db
    for ids in message_ids {
        let comments_data = crate::sigint::comments::find_report_comments(
            dbx,
            &ids,
            allowed_comment_logins,
        )
        .await
        .context(h!())?;
        let comment_message_ids = comments_data
            .iter()
            .map(|comment| comment.parent_signal_message_id)
            .collect::<Vec<_>>();
        let bodies = sigint_inbox_item::Entity::find()
            .select_only()
            .column(sigint_inbox_item::Column::Id)
            .column(sigint_inbox_item::Column::BodyNoheader)
            .filter(sigint_inbox_item::Column::Id.eq_any(comment_message_ids))
            .into_tuple::<(i64, Option<Json>)>()
            .all(dbx)
            .await
            .context(h!())?
            .into_iter()
            .collect::<HashMap<_, _>>();
        for comment in comments_data {
            let message_id = comment.parent_signal_message_id;
            comments.push((message_id, comment.comment));
            messages_with_comment.insert(message_id);
            if let Some(Some(body)) = bodies.get(&message_id) {
                let body: SigintBodyNoHeader =
                    serde_json::from_value(body.clone()).context(h!())?;
                new_bodies.insert(message_id, body.body);
            } else {
                warn!("no inbox item for message {message_id}");
            }
        }
    }
    let mut messages = messages
        .into_iter()
        .map(|(id, m)| {
            let mut message = m.to_owned();
            if let Some(new_text) = new_bodies.remove(&id) {
                message.text = new_text;
            }
            if let Some(public_id) = message_public_ids.remove(&id) {
                message.text =
                    format!("Перехоплення #{public_id}\n{}", message.text);
            }
            (id, message)
        })
        .filter(|(id, _)| messages_with_comment.contains(id))
        .collect::<Vec<_>>();
    messages.sort_by_key(|(_, v)| v.freq.clone().unwrap_or("0.0".to_string()));
    Ok((comments, messages))
}

pub fn convert_utc_to_kyiv_time(utc_timestamp: DateTime<Utc>) -> String {
    let local_time = utc_timestamp.with_timezone(&crate::config::get_tz());
    let month_num = local_time.month();
    let ukrainian_month = match month_num {
        1 => "січня",
        2 => "лютого",
        3 => "березня",
        4 => "квітня",
        5 => "травня",
        6 => "червня",
        7 => "липня",
        8 => "серпня",
        9 => "вересня",
        10 => "жовтня",
        11 => "листопада",
        12 => "грудня",
        _ => "невідомий місяць", // Should not happen for valid month numbers
    };
    format!(
        "{:02}:{:02}, {} {} {} року",
        local_time.hour(),
        local_time.minute(),
        local_time.day(),
        ukrainian_month,
        local_time.year()
    )
}

fn sanitize_optional_text(value: Option<String>) -> Option<String> {
    value
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

fn extract_message_date(message: &InboxMessage) -> Option<String> {
    sanitize_optional_text(message.date.clone())
        .map(|date| normalize_message_date(&date))
        .or_else(|| {
            message.timestamp.and_then(|timestamp| {
                chrono::DateTime::from_timestamp_millis(timestamp).map(|dt| {
                    dt.with_timezone(&crate::config::get_tz())
                        .format("%d.%m.%Y")
                        .to_string()
                })
            })
        })
}

fn normalize_message_date(raw: &str) -> String {
    for format in ["%Y-%m-%d", "%d.%m.%Y", "%d.%m.%y"] {
        if let Ok(date) = NaiveDate::parse_from_str(raw, format) {
            return date.format("%d.%m.%Y").to_string();
        }
    }
    raw.to_string()
}

fn extract_message_time(message: &InboxMessage) -> Option<String> {
    sanitize_optional_text(message.time.clone())
        .map(|time| normalize_message_time(&time))
        .or_else(|| {
            message.timestamp.and_then(|timestamp| {
                chrono::DateTime::from_timestamp_millis(timestamp).map(|dt| {
                    dt.with_timezone(&crate::config::get_tz())
                        .format("%H:%M")
                        .to_string()
                })
            })
        })
}

fn normalize_message_time(raw: &str) -> String {
    for format in ["%H:%M:%S", "%H:%M"] {
        if let Ok(time) = NaiveTime::parse_from_str(raw, format) {
            return time.format("%H:%M").to_string();
        }
    }
    raw.to_string()
}

fn extract_message_unit(
    message: &InboxMessage,
    unit_name: Option<&String>,
    unit_parts: Option<&Vec<String>>,
) -> Option<String> {
    sanitize_optional_text(message.unit.clone())
        .or_else(|| {
            unit_name
                .cloned()
                .and_then(|value| sanitize_optional_text(Some(value)))
        })
        .or_else(|| {
            unit_parts
                .map(|parts| parts.join(", "))
                .and_then(|value| sanitize_optional_text(Some(value)))
        })
}

fn extract_who_callsign(message: &InboxMessage) -> Option<String> {
    message
        .callsigns
        .iter()
        .find_map(|callsign| sanitize_optional_text(Some(callsign.clone())))
}

fn extract_to_callsigns(message: &InboxMessage) -> Option<String> {
    let callsigns = message
        .callsigns
        .iter()
        .skip(1)
        .filter_map(|callsign| sanitize_optional_text(Some(callsign.clone())))
        .collect::<Vec<_>>();
    if callsigns.is_empty() {
        None
    } else {
        Some(callsigns.join(", "))
    }
}

fn extract_form_1217_callsigns(
    message: &InboxMessage,
    callsigns_prefix: &crate::rer_importer::callsigns::CallsignsPrefixInfo,
) -> (Option<String>, Option<String>) {
    if callsigns_prefix.had_placeholder && callsigns_prefix.callsigns.is_empty()
    {
        return (None, None);
    }
    if !callsigns_prefix.callsigns.is_empty() {
        if callsigns_prefix.had_placeholder {
            return (None, Some(callsigns_prefix.callsigns.join(", ")));
        }

        let mut callsigns = callsigns_prefix.callsigns.iter();
        let who_callsign = callsigns.next().cloned();
        let to_callsigns = callsigns.cloned().collect::<Vec<_>>();
        return (
            who_callsign,
            if to_callsigns.is_empty() {
                None
            } else {
                Some(to_callsigns.join(", "))
            },
        );
    }

    (extract_who_callsign(message), extract_to_callsigns(message))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::{
        datasource_group, login, organism, sigint_comment, sigint_inbox_item,
        signal_message,
    };
    use crate::functest::tests::*;
    use chrono::Utc;
    use sea_orm::ActiveValue::Set;
    use serde_json::json;
    use serial_test::serial;

    #[test]
    fn build_note_comment_omits_time_for_form_1217() {
        let note = InterNote {
            time: Some(
                NaiveDate::from_ymd_opt(2026, 3, 21)
                    .unwrap()
                    .and_hms_opt(14, 30, 0)
                    .unwrap(),
            ),
            comment: "Test comment".to_string(),
            interception: None,
            interception_form_1217: None,
            interception_id: None,
            details: InterceptionDetails {
                date: None,
                freq: None,
                location: None,
                unit: None,
                time: None,
                who_callsign: None,
                to_callsigns: None,
            },
        };

        assert_eq!(
            build_note_comment(&note, false, true),
            "Test comment".to_string()
        );
    }

    #[test]
    fn build_note_comment_keeps_time_when_form_1217_disabled() {
        let note = InterNote {
            time: Some(
                NaiveDate::from_ymd_opt(2026, 3, 21)
                    .unwrap()
                    .and_hms_opt(14, 30, 0)
                    .unwrap(),
            ),
            comment: "Test comment".to_string(),
            interception: None,
            interception_form_1217: None,
            interception_id: None,
            details: InterceptionDetails {
                date: None,
                freq: None,
                location: None,
                unit: None,
                time: None,
                who_callsign: None,
                to_callsigns: None,
            },
        };

        assert_eq!(
            build_note_comment(&note, false, false),
            "14:30 Test comment".to_string()
        );
    }

    #[test]
    fn compare_network_rows_keeps_anonymous_networks_last() {
        let mut network_data = [
            NetworkRow {
                network_name: "Невизначена радіомережа 123.4МГц".to_string(),
                network_location: None,
                notes: vec![],
                unit: None,
                unit_name: None,
                is_anonymous: true,
            },
            NetworkRow {
                network_name: "Мережа Б".to_string(),
                network_location: None,
                notes: vec![],
                unit: None,
                unit_name: None,
                is_anonymous: false,
            },
            NetworkRow {
                network_name: "Мережа А".to_string(),
                network_location: None,
                notes: vec![],
                unit: Some(vec!["2 бат".to_string()]),
                unit_name: None,
                is_anonymous: false,
            },
        ];

        network_data.sort_by(compare_network_rows);

        assert_eq!(network_data[0].network_name, "Мережа А");
        assert_eq!(network_data[1].network_name, "Мережа Б");
        assert_eq!(
            network_data[2].network_name,
            "Невизначена радіомережа 123.4МГц"
        );
    }

    #[test]
    fn extract_form_1217_callsigns_treats_placeholder_as_recipient_only() {
        let message = InboxMessage {
            parent_messages: vec![],
            intelligence_reports: vec![],
            message_uid: None,
            text: String::new(),
            media: vec![],
            images: vec![],
            image_recognized: vec![],
            date: None,
            time: None,
            freq: None,
            coords: None,
            coords_with_locality: vec![],
            callsigns: vec!["гном".to_string()],
            callsigns_alg2: vec![],
            checked: false,
            important: false,
            bookmarked: false,
            timestamp: None,
            group_master_key: None,
            sender: None,
            extended_form: None,
            message_comments: vec![],
            post: None,
            post_id: None,
            unit: None,
            unit_ids: vec![],
            callsign_tokens: None,
            signal_tokens: None,
            point_tokens: None,
            no_headers_body: None,
            keyword_tokens: None,
            text_marked: None,
            datasource_id: None,
            location: None,
            tags: None,
            network_ids: None,
            network_name: None,
            device_name: None,
            inbox_tags: None,
            metadata: vec![],
        };
        let callsigns_prefix =
            crate::rer_importer::callsigns::CallsignsPrefixInfo {
                stripped_body: "— test".to_string(),
                callsigns: vec!["гном".to_string()],
                had_placeholder: true,
            };

        assert_eq!(
            extract_form_1217_callsigns(&message, &callsigns_prefix),
            (None, Some("гном".to_string()))
        );
    }

    #[test]
    fn extract_form_1217_callsigns_keeps_unknown_placeholder_unknown() {
        let message = InboxMessage {
            parent_messages: vec![],
            intelligence_reports: vec![],
            message_uid: None,
            text: String::new(),
            media: vec![],
            images: vec![],
            image_recognized: vec![],
            date: None,
            time: None,
            freq: None,
            coords: None,
            coords_with_locality: vec![],
            callsigns: vec!["гном".to_string()],
            callsigns_alg2: vec![],
            checked: false,
            important: false,
            bookmarked: false,
            timestamp: None,
            group_master_key: None,
            sender: None,
            extended_form: None,
            message_comments: vec![],
            post: None,
            post_id: None,
            unit: None,
            unit_ids: vec![],
            callsign_tokens: None,
            signal_tokens: None,
            point_tokens: None,
            no_headers_body: None,
            keyword_tokens: None,
            text_marked: None,
            datasource_id: None,
            location: None,
            tags: None,
            network_ids: None,
            network_name: None,
            device_name: None,
            inbox_tags: None,
            metadata: vec![],
        };
        let callsigns_prefix =
            crate::rer_importer::callsigns::CallsignsPrefixInfo {
                stripped_body: "— test".to_string(),
                callsigns: vec![],
                had_placeholder: true,
            };

        assert_eq!(
            extract_form_1217_callsigns(&message, &callsigns_prefix),
            (None, None)
        );
    }

    fn test_inbox_message(id: i64, text: &str) -> (i64, InboxMessage) {
        (
            id,
            InboxMessage {
                parent_messages: vec![],
                intelligence_reports: vec![],
                message_uid: Some(format!("uid-{id}")),
                text: text.to_string(),
                media: vec![],
                images: vec![],
                image_recognized: vec![],
                date: None,
                time: None,
                freq: None,
                coords: None,
                coords_with_locality: vec![],
                callsigns: vec![],
                callsigns_alg2: vec![],
                checked: false,
                important: false,
                bookmarked: false,
                timestamp: None,
                group_master_key: None,
                sender: None,
                extended_form: None,
                message_comments: vec![],
                post: None,
                post_id: None,
                unit: None,
                unit_ids: vec![],
                callsign_tokens: None,
                signal_tokens: None,
                point_tokens: None,
                no_headers_body: None,
                keyword_tokens: None,
                text_marked: None,
                datasource_id: None,
                location: None,
                tags: None,
                network_ids: None,
                network_name: None,
                device_name: None,
                inbox_tags: None,
                metadata: vec![],
            },
        )
    }

    async fn seed_digest_message(
        dbx: &DatabaseConnection,
        datasource_group: &datasource_group::Model,
        body: &str,
        body_noheader: &str,
    ) -> signal_message::Model {
        let now = Utc::now().naive_utc();
        let message = mk_signal_message(
            dbx,
            signal_message::ActiveModel {
                body: Set(Some(body.to_string())),
                created_at: Set(now),
                timestamp: Set(Some(now)),
                datasource_group_id: Set(Some(datasource_group.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_inbox_item(
            dbx,
            sigint_inbox_item::ActiveModel {
                id: Set(message.id),
                body_noheader: Set(Some(json!(SigintBodyNoHeader {
                    start: None,
                    end: None,
                    body: body_noheader.to_string(),
                }))),
                reviewed: Set(Some(true)),
                parsed_unit_v2: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        message
    }

    #[serial]
    #[tokio::test]
    async fn load_messages_with_comments_filters_by_allowed_logins() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let datasource_group =
            find_test_datasource_group(&env.dbx).await.unwrap();
        let sigint_zone = find_test_sigint_zone(&env.dbx).await.unwrap();
        let other_organism = mk_organism(
            &env.dbx,
            organism::ActiveModel {
                name: Set("OtherOrgDigest".to_string()),
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
                login: Set("OtherDigestTester".to_string()),
                organism_id: Set(Some(other_organism.id)),
                sigint_zone_id: Set(Some(sigint_zone.id)),
                created_at: Set(Utc::now().naive_utc()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let own_message = seed_digest_message(
            &env.dbx,
            &datasource_group,
            "raw own body",
            "body without header",
        )
        .await;
        let other_message = seed_digest_message(
            &env.dbx,
            &datasource_group,
            "raw other body",
            "other body without header",
        )
        .await;
        let now = Utc::now().naive_utc();
        sigint_comment::ActiveModel {
            login_id: Set(login.id),
            signal_message_id: Set(own_message.id),
            comment: Set("own comment".to_string()),
            created_at: Set(now),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        sigint_comment::ActiveModel {
            login_id: Set(other_login.id),
            signal_message_id: Set(other_message.id),
            comment: Set("other comment".to_string()),
            created_at: Set(now),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        let (comments, messages) = load_messages_with_comments(
            vec![
                test_inbox_message(own_message.id, "raw own body"),
                test_inbox_message(other_message.id, "raw other body"),
            ],
            &env.dbx,
            Some(std::slice::from_ref(&login.id)),
        )
        .await
        .unwrap();

        assert_eq!(comments, vec![(own_message.id, "own comment".to_string())]);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].0, own_message.id);
        assert_eq!(messages[0].1.text, "body without header");
    }
}
