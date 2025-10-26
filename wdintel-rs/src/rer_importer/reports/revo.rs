use super::super::types::*;
use super::types::*;
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
use sea_orm::*;
use std::path::Path;

const WIDTH_UNIT: usize = 1870;
const DTM_FORMAT: &str = "%Y.%m.%d %H:%M:%S";
const FUNCTIONALITY_DESC_DEFAULT: &str = "Склад кореспондентів - звичайний, інтенсивність роботи - звичайна, час роботи - звичайний, район роботи - старий/без змін.";

pub struct Report {
    pub summary: ReportSummary,
    pub hostile_networks: Vec<NetworkRow>,
    pub undefined_networks: Vec<NetworkRow>,
}

pub struct ReportSummary {
    pub identified_qty: u64,
    pub unidentified_qty: u64,
}

pub struct NetworkRow {
    pub name: String,
    pub location: Option<String>,
    pub freqs: Vec<String>,
    pub activity: NetworkActivity,
    pub correspondents: Vec<NetworkCorrespondent>,
    pub communication_kind: Option<String>,
    pub functionality_details: String,
    pub identified_details: Vec<String>,
}

pub struct NetworkActivity {
    pub since: NaiveDateTime,
    pub till: NaiveDateTime,
    pub seances_qty: u64,
}

pub struct NetworkCorrespondent {
    pub callsign: String,
    pub position: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone, FromQueryResult)]
pub struct NetworkSummary {
    pub id: i64,
    pub name: String,
    pub location: Option<String>,
    pub freq: String,
    pub unit_name: Option<String>,
    pub master_key: Option<String>,
}

#[derive(
    Debug, Serialize, Deserialize, PartialEq, Eq, Clone, FromQueryResult, Hash,
)]
pub struct CallsignSummary {
    pub network_id: i64,
    pub unit_id: i64,
    pub unit_name: String,
    pub position: String,
    pub callsign: String,
}

pub async fn report_docx_kind_revo(
    user: Identity,
    env: &Env,
    req: &super::types::ReportPreviewReq,
    outpath: &Path,
) -> Result<(), AppError> {
    info!("report_docx_kind_revo started");
    let read_db = env.replica();
    let login = user.id().c(h!())?;
    let logins = crate::users::get_organism_logins(&read_db, user)
        .await
        .context(h!())?;
    let messages: Vec<(i64, InboxMessage)> =
        crate::rer_importer::inbox::get_inbox_messages_with_conn(
            &read_db, &login, &logins, env, &req.req,
        )
        .await
        .context(h!())?;

    let range_khz = match req.report_type {
        Some(ReportType::Reo(ReoReportSettings {
            adjacent_freqs_distance,
        })) => adjacent_freqs_distance * 1000.0,
        _ => 0.0,
    };

    let mut report = collect_report(
        messages.clone(),
        logins.clone(),
        env,
        &read_db,
        range_khz,
    )
    .await
    .context(h!())?;
    info!("report_docx_kind_revo data collected");
    report
        .hostile_networks
        .sort_by_key(|x| -(x.activity.seances_qty as i64));
    report
        .undefined_networks
        .sort_by_key(|x| -(x.activity.seances_qty as i64));

    let network_summary_total =
        report.summary.identified_qty + report.summary.unidentified_qty;
    let network_summary =
        format!("Відмічено радіомереж (радіонапрямків): {} (визначені - {}, не визначено - {})",
                network_summary_total,
                report.summary.identified_qty,
                report.summary.unidentified_qty
        );

    let config = DocxConfig {
        columns_count: 6,
        width_unit: WIDTH_UNIT,
        highlight_color: "FF0000".to_string(),
        split_multiline_cells: true,
        paragraph_spacing: Some(80),
    };

    let mut rows_amrp: Vec<TableRow> = vec![];
    rows_amrp.push(TableRow::new(vec![
        mk_header_cell("Назва радіомережі", &config),
        mk_header_cell("Час роботи радіомережі", &config),
        mk_header_cell(
            "Склад кореспондентів радіомережі та приналежність",
            &config,
        ),
        mk_header_cell("Характер радіообміну", &config),
        mk_header_cell("Особливості функціонування радіомереж", &config),
        mk_header_cell("Що було виявлено", &config),
    ]));
    rows_amrp.push(TableRow::new(vec![mk_merged_text_cell(
        "Російська Федерація",
        true,
        util::ParagraphStyle::Default,
        &config,
    )]));
    for e in report.hostile_networks {
        rows_amrp.push(render_network_row(e, &config));
    }
    rows_amrp.push(TableRow::new(vec![mk_merged_text_cell(
        "Невизначені",
        false,
        util::ParagraphStyle::Default,
        &config,
    )]));
    for e in report.undefined_networks {
        rows_amrp.push(render_network_row(e, &config));
    }
    let thin_border = TableBorder::new(TableBorderPosition::Top)
        .border_type(BorderType::Single)
        .size(12);
    let table_amrp = Table::new(rows_amrp)
        .width(WIDTH_UNIT * 12, WidthType::Dxa)
        .set_border(thin_border);

    let docx = Docx::new()
        .page_orient(PageOrientationType::Landscape)
        .page_size(11906 * 2, 16838)
        .default_size(28)
        .page_margin(PageMargin::new().left(600).right(300).top(1200))
        .add_paragraph(
            Paragraph::new()
                .add_run(Run::new().size(32).add_text(network_summary))
                .align(AlignmentType::Center),
        )
        .add_paragraph(Paragraph::new())
        .add_table(table_amrp);
    info!("report_docx_kind_revo done, saving to file...");
    let file = std::fs::File::create(outpath)?;
    docx.build().pack(file).context(h!())?;

    info!("report_docx_kind_revo completed");
    Ok(())
}

fn render_network_row(row: NetworkRow, config: &DocxConfig) -> TableRow {
    let mut network_cell =
        mk_text_cell(&row.name, util::ParagraphStyle::Bold, config);
    if let Some(location) = row.location {
        network_cell = network_cell.add_paragraph(
            mk_paragraph(
                &format!("({location})"),
                util::ParagraphStyle::Default,
                config,
            )
            .bold(),
        );
    }
    network_cell = network_cell.add_paragraph(mk_paragraph(
        "",
        util::ParagraphStyle::Default,
        config,
    ));
    for freq in row.freqs {
        network_cell = network_cell.add_paragraph(mk_paragraph(
            &format!("\n{freq} МГц"),
            util::ParagraphStyle::Default,
            config,
        ));
    }
    let activity_cell = mk_text_cell(
        &row.activity.since.format(DTM_FORMAT).to_string(),
        util::ParagraphStyle::Default,
        config,
    )
    .add_paragraph(mk_paragraph(
        &format!("- {}", row.activity.till.format(DTM_FORMAT),),
        util::ParagraphStyle::Default,
        config,
    ))
    .add_paragraph(mk_paragraph(
        &format!("Сеанси: {}", row.activity.seances_qty),
        util::ParagraphStyle::Default,
        config,
    ));

    let mut correspondents = vec![];
    let mut other_correspondents = vec![];
    for c in row.correspondents {
        let callsign = c.callsign.to_uppercase();
        match c.position {
            Some(unit_name) => {
                correspondents.push(format!("{callsign} - {unit_name}"));
            }
            None => other_correspondents.push(callsign),
        }
    }
    correspondents.push(other_correspondents.join(", "));
    let correspondents_cell = mk_multiline_text_cell(
        correspondents,
        util::ParagraphStyle::Default,
        config,
    );

    let functionality_details_cell = mk_text_cell(
        &row.functionality_details,
        util::ParagraphStyle::Default,
        config,
    );
    let identified_details_cell =
        mk_bullet_list_cell(row.identified_details, config);

    let communication_kind_cell = mk_text_cell(
        &row.communication_kind.unwrap_or("".to_string()),
        util::ParagraphStyle::Default,
        config,
    );
    TableRow::new(vec![
        network_cell,
        activity_cell,
        correspondents_cell,
        communication_kind_cell,
        functionality_details_cell,
        identified_details_cell,
    ])
}

async fn collect_report(
    messages: Vec<(i64, InboxMessage)>,
    _logins: Vec<String>,
    env: &Env,
    dbx: &DatabaseConnection,
    range_khz: f64,
) -> anyhow::Result<Report> {
    let groups = messages
        .iter()
        .flat_map(|(_, m)| m.group_master_key.clone())
        .unique()
        .collect::<Vec<_>>();
    let freqs = messages
        .iter()
        .flat_map(|(_, m)| m.freq.clone())
        .unique()
        .collect::<Vec<_>>();

    let all_networks = sigint_network::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_network::Relation::SigintNetworkFreq.def(),
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
        .filter(sigint_network_freq::Column::Freq.is_in(freqs))
        .filter(
            signal_group_aor::Column::Id
                .is_null()
                .or(signal_group_aor::Column::MasterKey.is_in(groups)),
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
        .column_as(sigint_unit::Column::Name, "unit_name")
        .into_model::<NetworkSummary>()
        .all(dbx)
        .await
        .context(h!())?
        .into_iter()
        .map(|s| ((s.freq.clone(), s.master_key.clone()), s))
        .collect::<HashMap<_, _>>();

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
            .all(dbx)
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
        .all(dbx)
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
                    .find(|f: &i64| ((*f - id).abs() as f64) <= range_khz)
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

    let mut identified_qty = 0;
    let mut unidentified_qty = 0;
    let mut all_hostile_networks = vec![];
    let mut all_undefined_networks = vec![];
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
        let since = *seances.iter().min().context(h!())?;
        let till = *seances.iter().max().context(h!())?;
        let seances_qty = seances.len() as u64;
        let mut correspondents = vec![];

        let network = networks_dictionary.get(&id).context(h!())?;
        let mut network_name = network.name.clone();
        if network_name.trim().is_empty() {
            network_name = "Радіомережа".to_string();
        }
        let (name, is_defined) = match network.unit_name.clone() {
            None => (format!("{network_name} невизначеного підрозділу"), false),
            Some(unit_name) => (format!("{network_name} {unit_name}"), true),
        };

        let unmapped_network: bool = id < 0;
        if unmapped_network {
            freqs = unmapped_freqs.remove(&id).context(h!())?;
            freqs.sort_unstable();
        }
        for c in linked_callsigns {
            correspondents.push(NetworkCorrespondent {
                callsign: c.callsign,
                position: Some(format!("{} {}", c.position, c.unit_name)),
            })
        }
        for c in unlinked_callsigns {
            if !env.callsigns_whitelist.contains(&c)
                && !crate::rer_importer::callsigns::is_numeric_callsign(&c)
            {
                skipped_callsigns.insert(c);
                continue;
            }
            correspondents.push(NetworkCorrespondent {
                callsign: c,
                position: None,
            })
        }
        let activity = NetworkActivity {
            since,
            till,
            seances_qty,
        };
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
        let row = NetworkRow {
            name,
            freqs,
            activity,
            correspondents,
            location,
            communication_kind: None,
            functionality_details: FUNCTIONALITY_DESC_DEFAULT.to_string(),
            identified_details: comments,
        };
        if is_defined {
            identified_qty += 1;
            all_hostile_networks.push(row);
        } else {
            all_undefined_networks.push(row);
        }
    }
    all_undefined_networks.sort_by_key(|n| n.activity.seances_qty);
    all_undefined_networks.reverse();
    let total_undefined_seances_count: u64 = all_undefined_networks
        .iter()
        .map(|n| n.activity.seances_qty)
        .sum();
    let mut cutoff = (total_undefined_seances_count as f64 * 0.9).ceil() as i64;
    let mut undefined_networks = vec![];
    for n in all_undefined_networks {
        unidentified_qty += 1;
        cutoff -= n.activity.seances_qty as i64;
        undefined_networks.push(n);
        if cutoff < 0 {
            break;
        }
    }
    let report = Report {
        summary: ReportSummary {
            identified_qty,
            unidentified_qty,
        },
        undefined_networks,
        hostile_networks: all_hostile_networks,
    };

    debug!(
        "skipped unmapped callsigns: {}",
        skipped_callsigns.into_iter().sorted_unstable().join(", ")
    );

    Ok(report)
}
