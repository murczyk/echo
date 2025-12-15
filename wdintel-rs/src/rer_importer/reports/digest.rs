use super::super::types::*;
use crate::entities::*;
use crate::error::AppError;
use crate::rer_importer::reports::util;
use crate::rer_importer::reports::util::*;
use crate::types::*;
use crate::utils::orm::ArrayColumnOps;
use actix_identity::Identity;
use anyhow::Context;
use chrono::prelude::*;
use docx_rs::*;
use sea_orm::prelude::Json;
use sea_orm::*;
use std::cmp::Ordering;
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
}

pub struct InterNote {
    pub time: Option<NaiveDateTime>,
    pub comment: String,
    pub interception: Option<String>,
    pub interception_id: Option<String>,
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

pub async fn report_docx_kind_digest(
    user: Identity,
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
    let login = user.id().c(h!())?;
    let logins = crate::users::get_organism_logins(&read_db, user)
        .await
        .context(h!())?;
    let mut request = req.req.clone();
    request.or_with_extended_form = Some(true); // with comments only
    let messages: Vec<(i64, InboxMessage)> =
        crate::rer_importer::inbox::get_inbox_messages_with_conn(
            &read_db, &login, &logins, env, &request,
        )
        .await
        .context(h!())?;
    let report = collect_report(messages, logins.clone(), &read_db)
        .await
        .context(h!())?;
    info!("report_docx_kind_digest data collected");

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
                let note_txt = match note.time {
                    None => note.comment,
                    Some(dt) => match show_date {
                        false => format!(
                            "{} {}",
                            dt.time().format("%H:%M"),
                            note.comment
                        ),
                        true => format!(
                            "{} {}",
                            dt.format("%d.%m %H:%M"),
                            note.comment
                        ),
                    },
                };
                let m_inter_lines = note.interception.map(|interception| {
                    interception
                        .split('\n')
                        .collect::<Vec<&str>>()
                        .into_iter()
                        .map(|s| s.to_string())
                        .collect_vec()
                });
                let m_id_paragraph = note.interception_id.map(|text| {
                    Paragraph::new().add_run(
                        mk_text(
                            &format!("EXO ID {text}"),
                            &util::ParagraphStyle::Italic,
                        )
                        .color("808080")
                        .size(16),
                    )
                });
                let inter_cell = match (m_inter_lines, m_id_paragraph) {
                    (None, None) => {
                        continue;
                    }
                    (Some(lines), None) => mk_multiline_text_cell(
                        lines,
                        util::ParagraphStyle::Italic,
                        &config,
                    )
                    .vertical_align(VAlignType::Top),
                    (Some(lines), Some(inter_id)) => {
                        let mut cell = mk_cell(&config, inter_id);
                        for l in lines {
                            cell = cell.add_paragraph(mk_paragraph(
                                &l,
                                util::ParagraphStyle::Italic,
                                &config,
                            ));
                        }
                        cell
                    }
                    (None, Some(inter_id)) => mk_cell(&config, inter_id),
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
    let file = std::fs::File::create(outpath)?;
    docx.build().pack(file).context(h!())?;

    info!("report_docx_kind_digest completed");
    Ok(())
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
    _logins: Vec<String>,
    dbx: &DatabaseConnection,
) -> anyhow::Result<Report> {
    let (comments, messages) =
        load_messages_with_comments(messages, dbx).await.c(h!())?;
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
                // todo if message is missing, from a secret chat or other edge case - don't put it here, put Right(message_id) instead
                let time = message
                    .timestamp
                    .and_then(chrono::DateTime::from_timestamp_millis)
                    .map(|ts| {
                        ts.with_timezone(&crate::config::get_tz()).naive_local()
                    });
                notes.push(InterNote {
                    time,
                    comment,
                    interception: Some(message.text),
                    interception_id: message.message_uid,
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
            });
        }
        network_data.sort_by(|n1, n2| match (&n1.unit, &n2.unit) {
            (Some(u1), Some(u2)) => compare_units(u1, u2),
            (a, b) => compare_options(a, b).reverse(),
        });
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
        let comments_data = sigint_comment::Entity::find()
            .join(
                JoinType::InnerJoin,
                sigint_comment::Relation::SignalMessage.def(),
            )
            .join(
                JoinType::LeftJoin,
                signal_message::Relation::SigintInboxItem.def(),
            )
            .filter(sigint_comment::Column::SignalMessageId.eq_any(ids))
            .select_only()
            .column(sigint_comment::Column::SignalMessageId)
            .column(sigint_comment::Column::Comment)
            .column(sigint_inbox_item::Column::BodyNoheader)
            .into_tuple::<(i64, String, Option<Json>)>()
            .all(dbx)
            .await
            .context(h!())?;
        for (message_id, comment, body) in comments_data {
            comments.push((message_id, comment));
            messages_with_comment.insert(message_id);
            if let Some(body) = body {
                let body: SigintBodyNoHeader =
                    serde_json::from_value(body).context(h!())?;
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
