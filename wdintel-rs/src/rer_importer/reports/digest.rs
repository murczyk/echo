use std::cmp::Reverse;
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
    pub order: i64,
    pub network_name: String,
    pub network_location: Option<String>,
    pub notes: Vec<InterNote>,
}

pub struct InterNote {
    pub order: u32,
    pub time: Option<NaiveTime>,
    pub comment: String,
    pub interception_or_id: Either<String, String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone, FromQueryResult)]
pub struct NetworkSummary {
    pub id: i64,
    pub name: String,
    pub location: Option<String>,
    pub freq: String,
    pub unit_name: Option<String>,
    pub group_aor_id: Option<i64>,
    pub aor_id: Option<i64>,
    pub master_key: Option<String>,
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
    let report = collect_report(messages.clone(), logins.clone(), env)
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
            let header = match network_row.network_location {
                None => network_row.network_name,
                Some(network_location) => {
                    format!("{} ({network_location})", network_row.network_name,)
                }
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
                    Some(time) => {
                        format!("{} {}", time.format("%H:%M"), note.comment)
                    }
                };
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
    let (comments, messages) =
        load_messages_with_comments(messages, env).await?;
    debug!("loaded {} messages with comments {}", messages.len(), h!());
    let report_ts = messages
        .iter()
        .flat_map(|(_, m)| m.timestamp)
        .max()
        .and_then(chrono::DateTime::from_timestamp_millis)
        .unwrap_or(Utc::now());

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
        .filter(sigint_network_freq::Column::Freq.is_in(freqs.clone()))
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
        .all(&env.dbx)
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
        .filter(sigint_network_freq::Column::Freq.is_in(freqs))
        .filter(
            signal_group_aor::Column::Id
                .is_null()
                .or(signal_group_aor::Column::MasterKey.is_in(groups.clone())),
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
        .all(&env.dbx)
        .await
        .context(h!())?
        .into_iter()
        .map(|s| ((s.freq.clone(), s.master_key.clone()), s))
        .collect::<HashMap<_, _>>();

    for (k, v) in all_networks {
        networks.insert(k, v);
    }

    let group_aors = signal_group_aor::Entity::find()
        .filter(signal_group_aor::Column::MasterKey.is_in(groups.clone()))
        .all(&env.dbx)
        .await
        .context(h!())?
        .into_iter()
        .map(|g| (g.master_key.clone(), g.aor_id))
        .collect::<HashMap<_, _>>();

    let mut aors =
        load_aors(&group_aors, &networks, env).await.context(h!())?;

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
                        group_aor_id: group_aors.get(master_key).cloned(),
                        master_key: Some(master_key.clone()),
                        name: "".to_string(),
                        freq: freq.clone(),
                        unit_name: None,
                        location: None,
                        aor_id: None,
                    };
                    networks_dictionary
                        .insert(new_summary.id, new_summary.clone());
                    new_summary
                }
            }
            Some(s) => s,
        };
        let mut list =
            network_comments_map.remove(&summary.id).unwrap_or(vec![]);
        for comment in comments.iter().filter(|(cid, _)| id == cid).cloned() {
            list.push(comment);
        }
        network_comments_map.insert(summary.id, list);
        network_keys.insert((summary.name.clone(), summary.id, freq));
    }

    let mut aor_dictionary = HashMap::new();
    let default_aor = crate::sigint::aor::load_default_aor(&env.dbx)
        .await
        .context(h!())?;
    for (id, n) in networks_dictionary.clone() {
        let aor_id = n.aor_id.or(n.group_aor_id).unwrap_or(default_aor.id);
        let mut data = aor_dictionary.remove(&aor_id).unwrap_or(vec![]);
        data.push(id);
        aor_dictionary.insert(aor_id, data);
    }
    aors.insert(default_aor.id, default_aor.name);

    let mut aor_data = vec![];
    let messages = messages.into_iter().collect::<HashMap<_, _>>();
    for (aor_id, network_ids) in aor_dictionary {
        let aor_name = aors.get(&aor_id).cloned().context(h!())?;
        let mut network_data = vec![];
        let mut network_order = 1;
        for id in network_ids {
            let mut order = network_order;
            network_order += 1;
            let network = networks_dictionary.get(&id).context(h!())?;
            let comments = network_comments_map.remove(&id).unwrap_or(vec![]);
            let mut network_name = network.name.clone();
            if network_name.trim().is_empty() {
                network_name = format!(
                    "Невизначена радіомережа {}МГц",
                    network.freq.clone()
                );
                order += 1000000; // all undefined networks go to the end of list
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
                let interception_or_id = Either::Left(message.text);
                let time = message
                    .timestamp
                    .and_then(chrono::DateTime::from_timestamp_millis)
                    .map(|ts| {
                        ts.with_timezone(&crate::config::get_tz())
                            .naive_local()
                            .time()
                    });
                let order = time.map(|t| t.num_seconds_from_midnight()).unwrap_or(0);
                notes.push(InterNote {
                    order,
                    time,
                    comment,
                    interception_or_id,
                });
            }
            notes.sort_by_key(|n| Reverse(n.order));
            network_data.push(NetworkRow {
                network_name,
                network_location,
                notes,
                order,
            });
        }
        network_data.sort_by_key(|n| n.order);
        aor_data.push(AorRow {
            aor_name,
            network_data,
        });
    }
    Ok(Report {
        datetime: report_ts,
        aor_data,
    })
}

async fn load_aors(
    group_aors: &HashMap<String, i64>,
    networks: &HashMap<(String, Option<String>), NetworkSummary>,
    env: &Env,
) -> anyhow::Result<HashMap<i64, String>> {
    let mut aor_ids = HashSet::new();
    for n in networks.values() {
        if let Some(id) = &n.aor_id {
            aor_ids.insert(*id);
        }
        if let Some(id) = &n.group_aor_id {
            aor_ids.insert(*id);
        }
    }
    for id in group_aors.values() {
        aor_ids.insert(*id);
    }
    let aor_ids = aor_ids.into_iter().collect_vec();
    let areas = area_of_responsibility::Entity::find()
        .filter(area_of_responsibility::Column::Id.is_in(aor_ids))
        .all(&env.dbx)
        .await
        .context(h!())?
        .into_iter()
        .map(|a| (a.id, a.name))
        .collect::<HashMap<_, _>>();
    Ok(areas)
}

async fn load_messages_with_comments(
    messages: Vec<(i64, InboxMessage)>,
    env: &Env,
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
    for ids in message_ids {
        sigint_comment::Entity::find()
            .filter(sigint_comment::Column::SignalMessageId.is_in(ids))
            .all(&env.dbx)
            .await
            .context(h!())?
            .into_iter()
            .for_each(|c| {
                comments.push((c.signal_message_id, c.comment));
                messages_with_comment.insert(c.signal_message_id);
            });
    }
    let mut messages = messages
        .into_iter()
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
