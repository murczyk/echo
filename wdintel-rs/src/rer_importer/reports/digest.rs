use super::super::types::*;
use crate::entities::*;
use crate::error::AppError;
// Add this import if h!() uses anyhow::Context
use crate::rer_importer::reports::util;
use crate::rer_importer::reports::util::*;
use crate::types::*;
use actix_identity::Identity;
use anyhow::Context;
use chrono::prelude::*;
use docx_rs::*;
use itertools::Either;
use sea_orm::*;
use std::path::Path;

const DOC_NAME: &str = "Форма №1.2.17/ОСУВ";
const DOC_HEADER: &str =
    "Донесення за результатами ведення радіоелектронної розвідки";

const WIDTH_UNIT: usize = 785;

pub struct Report {
    pub datetime: DateTime<Utc>,
    pub aor_data: Vec<AorRow>,
}

pub struct AorRow {
    pub aor_name: String,
    pub network_data: Vec<NetworkRow>,
}

pub struct NetworkRow {
    pub network_name: String,
    pub network_location: String,
    pub notes: Vec<InterNote>,
}

pub struct InterNote {
    pub time: NaiveTime,
    pub text: String,
    pub interception_or_id: Either<String, String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone, FromQueryResult)]
pub struct NetworkSummary {
    pub id: i64,
    pub name: String,
    pub location: Option<String>,
    pub unit_name: Option<String>,
}

pub async fn report_docx_kind_digest(
    user: Identity,
    env: &Env,
    req: &super::ReportPreviewReq,
    outpath: &Path,
) -> Result<(), AppError> {
    info!("report_docx_kind_digest started");
    let login = user.id()?;
    let logins = crate::users::get_organism_logins(&env.dbx, user)
        .await
        .context(h!())?;
    let messages: Vec<(i64, InboxMessage)> =
        crate::rer_importer::inbox::get_inbox_messages(
            &login, &logins, env, &req.req,
        )
        .await
        .context(h!())?;
    let mut report = collect_report(messages.clone(), logins.clone(), env)
        .await
        .context(h!())?;
    info!("report_docx_kind_digest data collected");

    let config = DocxConfig {
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
        format!("(станом на {})", convert_utc_to_kyiv_time(report.datetime));

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
        rows_amrp.push(TableRow::new(vec![mk_merged_text_cell(
            &aor_row.aor_name,
            false,
            util::ParagraphStyle::BoldAndItalic,
            &config,
        )]));
        for network_row in aor_row.network_data {
            if network_row.notes.is_empty() {
                continue;
            }
            let header = format!(
                "{} ({})",
                network_row.network_name, network_row.network_location
            );
            rows_amrp.push(TableRow::new(vec![mk_merged_text_cell(
                &header,
                false,
                util::ParagraphStyle::BoldAndItalic,
                &config,
            )]));
            for note in network_row.notes {
                let note_txt = format!(
                    "{} {}",
                    note.time.format("%H:%M").to_string(),
                    note.text
                );
                let inter_cell = match note.interception_or_id {
                    Either::Left(interception) => {
                        let lines = interception
                            .split('\n')
                            .collect::<Vec<&str>>()
                            .into_iter()
                            .map(|s| s.to_string())
                            .collect();
                        mk_multiline_text_cell(
                            lines,
                            util::ParagraphStyle::Italic,
                            &config,
                        )
                        .vertical_align(VAlignType::Top)
                    }
                    Either::Right(interception_id) => {
                        let host = env.config.public_host.clone();
                        let link = format!("{host}/rer-analysis?interception_id={interception_id}");
                        mk_text_cell(
                            &format!("Перехоплення #{interception_id}"),
                            util::ParagraphStyle::Default,
                            &config,
                        )
                        .add_paragraph(mk_paragraph(
                            &link,
                            util::ParagraphStyle::Default,
                            &config,
                        ))
                    }
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
        .page_margin(PageMargin::new().left(1500).right(450).top(1200))
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

async fn collect_report(
    messages: Vec<(i64, InboxMessage)>,
    _logins: Vec<String>,
    env: &Env,
) -> anyhow::Result<Report> {
    let all_networks = sigint_network::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_network::Relation::SigintNetworkUnit.def(),
        )
        .join(
            JoinType::InnerJoin,
            sigint_network_unit::Relation::SigintUnit.def(),
        )
        .filter(sigint_network::Column::Deleted.eq(false))
        .filter(sigint_network::Column::Name.is_not_null())
        .select_only()
        .column(sigint_network::Column::Id)
        .column(sigint_network::Column::Name)
        .column(sigint_network::Column::Location)
        .column_as(sigint_unit::Column::Name, "unit_name")
        .into_model::<NetworkSummary>()
        .all(&env.dbx)
        .await
        .context(h!())?
        .into_iter()
        .collect::<Vec<_>>();

    let message_ids = messages
        .iter()
        .map(|(id, _)| *id)
        .collect_vec()
        .chunks(20000)
        .map(|slice| slice.to_vec())
        .collect_vec();

    let mut comments = BTreeMap::new();
    for ids in message_ids {
        sigint_comment::Entity::find()
            .filter(sigint_comment::Column::SignalMessageId.is_in(ids))
            .all(&env.dbx)
            .await
            .context(h!())?
            .into_iter()
            .for_each(|c| {
                comments.insert(c.signal_message_id, c.comment);
            });
    }

    for (k, v) in all_networks {
        networks.insert(k, v);
    }

    let mut networks_dictionary = {
        let mut result = HashMap::new();
        for n in networks.values() {
            result.insert(n.id, n.clone());
        }
        result
    };

    let mut network_ids = HashSet::new();
    for n in networks.values() {
        network_ids.insert(n.id);
    }

    let mut callsigns_set = HashSet::new();
    for (_id, message) in messages.clone() {
        for c in message.callsigns {
            callsigns_set.insert(c.clone());
        }
        for c in message.callsigns_alg2 {
            callsigns_set.insert(c.clone());
        }
    }
    let callsigns = callsigns_set.into_iter().collect_vec();

    let unit_callsigns = sigint_unit::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_unit::Relation::SigintCallsign.def(),
        )
        .join(
            JoinType::InnerJoin,
            sigint_unit::Relation::SigintNetworkUnit.def(),
        )
        .filter(sigint_callsign::Column::Callsign.is_in(callsigns))
        .filter(
            sigint_network_unit::Column::NetworkId.is_in(network_ids.clone()),
        )
        .filter(sigint_unit::Column::Deleted.eq(false))
        .filter(sigint_callsign::Column::Deleted.eq(false))
        .select_only()
        .column_as(sigint_network_unit::Column::NetworkId, "network_id")
        .column_as(sigint_unit::Column::Id, "unit_id")
        .column_as(sigint_unit::Column::Name, "unit_name")
        .column_as(sigint_callsign::Column::Position, "position")
        .column_as(sigint_callsign::Column::Callsign, "callsign")
        .column(sigint_unit::Column::Id)
        .into_model::<CallsignSummary>()
        .all(&env.dbx)
        .await
        .context(h!())?
        .into_iter()
        .map(|c| ((c.network_id, c.callsign.clone()), c))
        .collect::<HashMap<_, _>>();

    let mut network_comments_map = HashMap::new();
    let mut linked_callsigns_map = HashMap::new();
    let mut unlinked_callsigns_map = HashMap::new();
    let mut seances_map = HashMap::new();
    let mut unmapped_freqs = HashMap::new();
    let mut messages = messages;
    messages.sort_by_key(|(_, v)| v.freq.clone().unwrap_or("0.0".to_string()));
    for (_id, message) in messages {
        let is_pure_peleng = message.coords.is_some()
            && message.callsign_tokens.unwrap_or(vec![]).is_empty();
        if is_pure_peleng {
            continue;
        }
        let (Some(master_key), Some(freq)) =
            (message.group_master_key, message.freq)
        else {
            continue;
        };
        let m_network_summary = networks
            .get(&(freq.clone(), Some(master_key)))
            .or(networks.get(&(freq.clone(), None)))
            .cloned();
        let summary = match m_network_summary {
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
                        name: "".to_string(),
                        freq: freq.clone(),
                        unit_name: None,
                        master_key: None,
                        location: None,
                    };
                    networks_dictionary
                        .insert(new_summary.id, new_summary.clone());
                    network_ids.insert(new_summary.id);
                    new_summary
                }
            }
            Some(s) => s,
        };
        let network_key = (summary.name.clone(), summary.id, freq);

        if let Some(ts) = message.timestamp {
            let mut data = seances_map.remove(&network_key).unwrap_or(vec![]);
            let utc_datetime = DateTime::from_timestamp_millis(ts)
                .context(h!())?
                .with_timezone(&crate::config::get_tz())
                .naive_local();
            data.push(utc_datetime);
            seances_map.insert(network_key.clone(), data);
        }

        let mut data = unlinked_callsigns_map
            .remove(&network_key)
            .unwrap_or(HashSet::new());
        for c in message.callsigns {
            data.insert(c.clone());
        }
        for c in message.callsigns_alg2 {
            data.insert(c.clone());
        }
        let mut linked_callsigns = vec![];
        for c in data.clone() {
            if let Some(callsign) = unit_callsigns.get(&(summary.id, c.clone()))
            {
                data.remove(&c);
                linked_callsigns.push(callsign.clone());
            }
        }
        linked_callsigns_map.insert(network_key.clone(), linked_callsigns);
        unlinked_callsigns_map.insert(network_key, data);
        if let Some(comment) = comments.remove(&_id) {
            let mut list =
                network_comments_map.remove(&summary.id).unwrap_or(vec![]);
            list.push(comment);
            network_comments_map.insert(summary.id, list);
        }
    }

    let mut skipped_callsigns = HashSet::<String>::new();
    for id in network_ids {
        let comments = network_comments_map.remove(&id).unwrap_or(vec![]);
        let keys = seances_map
            .keys()
            .filter(|&(_, id_val, _)| id == *id_val)
            .cloned()
            .collect_vec();
        let seances = seances_map
            .iter()
            .filter(|(k, _)| keys.contains(k))
            .flat_map(|(_, v)| v.iter())
            .cloned()
            .collect_vec();
        let mut linked_callsigns = linked_callsigns_map
            .iter()
            .filter(|(k, _)| keys.contains(k))
            .flat_map(|(_, v)| v.iter())
            .cloned()
            .unique()
            .collect_vec();
        linked_callsigns.sort_by_key(|a| a.callsign.clone());
        let mut unlinked_callsigns = unlinked_callsigns_map
            .iter()
            .filter(|(k, _)| keys.contains(k))
            .flat_map(|(_, v)| v.iter())
            .cloned()
            .unique()
            .collect_vec();
        unlinked_callsigns.sort();
        let mut freqs = keys
            .into_iter()
            .map(|(_name, _id, freq)| freq)
            .collect_vec();
        if seances.is_empty() {
            continue;
        }

        let network = networks_dictionary.get(&id).context(h!())?;
        let mut network_name = network.name.clone();
        if network_name.trim().is_empty() {
            network_name = "Радіомережа".to_string();
        }
        let unmapped_network: bool = id < 0;
        if unmapped_network {
            freqs = unmapped_freqs.remove(&id).context(h!())?;
            freqs.sort_unstable();
        }
        let location = network
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
    }
    let total_undefined_seances_count: u64 = 0;

    debug!(
        "skipped unmapped callsigns: {}",
        skipped_callsigns.into_iter().sorted_unstable().join(", ")
    );
    bail!("not implemented yet")
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
