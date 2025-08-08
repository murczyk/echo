use super::super::types::*;
use crate::entities::*;
use crate::error::AppError;
use crate::types::*;
use actix_identity::Identity;
use anyhow::Context;
// Add this import if h!() uses anyhow::Context
use chrono::prelude::*;
use docx_rs::Table;
use docx_rs::TableCell;
use docx_rs::TableRow;
use docx_rs::VAlignType;
use docx_rs::VMergeType;
use docx_rs::WidthType;
use docx_rs::{
    AlignmentType, BorderType, LineSpacing, ParagraphBorder,
    ParagraphBorderPosition, Run, TableBorder, TableBorderPosition,
};
use docx_rs::{Paragraph, ParagraphBorders};
use sea_orm::*;
use std::path::PathBuf;

const WIDTH_UNIT: usize = 1870;
const DTM_FORMAT: &'static str = "%Y.%m.%d %H:%M:%S";
const FUNCTIONALITY_DESC_DEFAULT: &'static str = "Склад кореспондентів - звичайний, інтенсивність роботи - звичайна, час роботи - звичайний, район роботи - старий/без змін.";

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
    pub freq: String,
    pub activity: NetworkActivity,
    pub correspondents: Vec<NetworkCorrespondent>,
    pub communication_kind: Option<String>,
    pub functionality_details: String,
    pub identified_details: Option<String>,
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
    pub freq: String,
    pub unit_name: String,
    pub master_key: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone, FromQueryResult)]
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
    req: &super::ReportPreviewReq,
    outpath: &PathBuf,
) -> Result<(), AppError> {
    let login = user.id()?;
    let logins = crate::users::get_organism_logins(&env.dbx, user).await?;
    let messages: Vec<(i64, InboxMessage)> =
        crate::rer_importer::inbox::get_inbox_messages(
            &login, &logins, &env, &req.req,
        )
        .await?;
    let report = collect_report(messages.clone(), logins.clone(), env)
        .await
        .context(h!())?;

    let network_summary_total =
        report.summary.identified_qty + report.summary.unidentified_qty;
    let network_summary =
        format!("Відмічено радіомереж (радіонапрямків): {} (визначені - {}, не визначено - {})",
                network_summary_total,
                report.summary.identified_qty,
                report.summary.unidentified_qty
        );

    let mut rows_amrp: Vec<TableRow> = vec![];
    rows_amrp.push(TableRow::new(vec![
        mk_header_cell("Назва радіомережі"),
        mk_header_cell("Час роботи радіомережі"),
        mk_header_cell("Склад кореспондентів радіомережі та приналежність"),
        mk_header_cell("Характер радіообміну"),
        mk_header_cell("Особливості функціонування радіомереж"),
        mk_header_cell("Що було виявлено"),
    ]));
    // rows_amrp.push(TableRow::new(vec![mk_merged_text_cell(
    //     "Російська Федерація",
    //     true,
    // )]));
    for e in report.hostile_networks {
        rows_amrp.push(render_network_row(e));
    }
    // rows_amrp.push(TableRow::new(vec![mk_merged_text_cell(
    //     "Невизначені",
    //     false,
    // )]));
    for e in report.undefined_networks {
        rows_amrp.push(render_network_row(e));
    }
    let thin_border = TableBorder::new(TableBorderPosition::Top)
        .border_type(BorderType::Single)
        .size(12);
    let table_amrp = Table::new(rows_amrp)
        .width(WIDTH_UNIT * 12, WidthType::Dxa)
        .set_border(thin_border);

    let docx = docx_rs::Docx::new()
        .page_orient(
            docx_rs::page_orientation_type::PageOrientationType::Landscape,
        )
        .page_size(11906 * 2, 16838)
        .default_size(28)
        .page_margin(
            docx_rs::page_margin::PageMargin::new()
                .left(600)
                .right(300)
                .top(1200),
        )
        .add_paragraph(
            Paragraph::new()
                .add_run(Run::new().size(32).add_text(network_summary).bold())
                .align(AlignmentType::Center),
        )
        .add_paragraph(Paragraph::new())
        .add_table(table_amrp);
    let file = std::fs::File::create(outpath.clone())?;
    docx.build().pack(file).context(h!())?;

    Ok(())
}

fn render_network_row(row: NetworkRow) -> TableRow {
    let network_cell = mk_bold_text_cell(&row.name)
        .add_paragraph(mk_paragraph(""))
        .add_paragraph(mk_paragraph(&format!("\n{} МГц", row.freq)));
    let activity = format!(
        "{}\n- {}",
        row.activity.since.format(DTM_FORMAT).to_string(),
        row.activity.till.format(DTM_FORMAT).to_string(),
    );
    let activity_cell = mk_text_cell(&activity)
        .add_paragraph(mk_paragraph(""))
        .add_paragraph(mk_paragraph(&format!(
            "Сеанси: {}",
            row.activity.seances_qty
        )));

    let mut correspondents = vec![];
    let mut other_correspondents = vec![];
    for c in row.correspondents {
        let callsign = c.callsign;
        match c.position {
            Some(unit_name) => {
                correspondents.push(format!("{callsign} - {unit_name}"));
            }
            None => other_correspondents.push(callsign),
        }
    }
    correspondents.push(other_correspondents.join(", "));
    let correspondents_cell = mk_multiline_text_cell(correspondents);

    let functionality_details_cell = mk_text_cell(&row.functionality_details);

    let identified_details = row.identified_details.unwrap_or("".to_string());
    let identified_details_cell = mk_text_cell(&identified_details);

    let communication_kind_cell =
        mk_text_cell(&row.communication_kind.unwrap_or("".to_string()));
    TableRow::new(vec![
        network_cell,
        activity_cell,
        correspondents_cell,
        communication_kind_cell,
        functionality_details_cell,
        identified_details_cell,
    ])
}

fn mk_header_cell(text: &str) -> TableCell {
    TableCell::new()
        .width(WIDTH_UNIT * 2, WidthType::Dxa)
        .vertical_align(VAlignType::Center)
        // .vertical_merge(VMergeType::Restart)
        .add_paragraph(
            Paragraph::new()
                .add_run(Run::new().add_text(text).bold())
                .line_spacing(LineSpacing::new().before(80).after(80))
                .align(AlignmentType::Center),
        )
}

fn mk_text_cell(text: &str) -> TableCell {
    TableCell::new()
        .width(WIDTH_UNIT * 2, WidthType::Dxa)
        .vertical_align(VAlignType::Center)
        .add_paragraph(
            Paragraph::new()
                .add_run(Run::new().add_text(text))
                .line_spacing(LineSpacing::new().before(80).after(80)),
        )
}

fn mk_multiline_text_cell(lines: Vec<String>) -> TableCell {
    let mut cell = TableCell::new()
        .width(WIDTH_UNIT * 2, WidthType::Dxa)
        .vertical_align(VAlignType::Center);
    let mut remaining_count: i32 = lines.len() as i32;
    for text in lines {
        remaining_count -= 1;
        let mut paragraph = Paragraph::new().add_run(Run::new().add_text(text));
        if remaining_count > 0 {
            let mut border = ParagraphBorders::with_empty();
            border = border
                .set(ParagraphBorder::new(ParagraphBorderPosition::Bottom));
            paragraph.property = paragraph.property.set_borders(border);
        }
        cell = cell.add_paragraph(paragraph);
    }
    cell
}

fn mk_bold_text_cell(text: &str) -> TableCell {
    TableCell::new()
        .width(WIDTH_UNIT * 2, WidthType::Dxa)
        .vertical_align(VAlignType::Center)
        .add_paragraph(mk_paragraph(text).bold())
}

fn mk_paragraph(text: &str) -> Paragraph {
    Paragraph::new()
        .add_run(Run::new().add_text(text))
        .line_spacing(LineSpacing::new().before(80).after(80))
}

fn _mk_merged_text_cell(text: &str, is_red: bool) -> TableCell {
    let mut text = Run::new().add_text(text).bold();
    if is_red {
        text = text.color("FF0000");
    }
    TableCell::new()
        .width(WIDTH_UNIT * 2, WidthType::Dxa)
        .vertical_align(VAlignType::Center)
        .vertical_merge(VMergeType::Restart)
        .add_paragraph(
            Paragraph::new()
                .add_run(text)
                .line_spacing(LineSpacing::new().before(80).after(80))
                .align(AlignmentType::Center),
        )
        .grid_span(6)
}

async fn collect_report(
    messages: Vec<(i64, InboxMessage)>,
    _logins: Vec<String>,
    env: &Env,
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
        .column(sigint_network_freq::Column::Freq)
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
        .column(sigint_network_freq::Column::Freq)
        .column(signal_group_aor::Column::MasterKey)
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

    let networks_dictionary = {
        let mut result = HashMap::new();
        for (_, n) in &networks {
            result.insert(n.id, n.clone());
        }
        result
    };

    let mut network_ids = HashSet::new();
    for (_, n) in &networks {
        network_ids.insert(n.id.clone());
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
        .filter(sigint_network_unit::Column::NetworkId.is_in(network_ids))
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

    let mut linked_callsigns_map = HashMap::new();
    let mut unlinked_callsigns_map = HashMap::new();
    let mut seanses_map = HashMap::new();
    for (_id, message) in messages {
        let (Some(master_key), Some(freq)) =
            (message.group_master_key, message.freq)
        else {
            continue;
        };
        let Some(summary) = networks
            .get(&(freq.clone(), Some(master_key)))
            .or(networks.get(&(freq.clone(), None)))
            .cloned()
        else {
            continue;
        };
        let network_key = (summary.name.clone(), summary.id, freq);

        if let Some(ts) = message.timestamp {
            let mut data = seanses_map.remove(&network_key).unwrap_or(vec![]);
            let utc_datetime = DateTime::from_timestamp_millis(ts)
                .context(h!())?
                .with_timezone(&crate::config::get_tz())
                .naive_local();
            data.push(utc_datetime);
            seanses_map.insert(network_key.clone(), data);
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
    }

    let mut identified_qty = 0;
    let unidentified_qty = 0;
    let mut hostile_networks = vec![];
    for (network_key, seances) in seanses_map {
        let mut linked_callsigns = linked_callsigns_map
            .get(&network_key)
            .unwrap_or(&vec![])
            .clone();
        linked_callsigns.sort_by_key(|a| a.callsign.clone());
        let mut unlinked_callsigns = unlinked_callsigns_map
            .get(&network_key)
            .unwrap_or(&HashSet::new())
            .clone()
            .into_iter()
            .collect_vec();
        unlinked_callsigns.sort();
        let (_name, _id, freq) = network_key.clone();
        identified_qty += 1;
        if seances.is_empty() {
            continue;
        }
        let since = seances.iter().min().context(h!())?.clone();
        let till = seances.iter().max().context(h!())?.clone();
        let seances_qty = seances.len() as u64;
        let mut correspondents = vec![];
        for c in linked_callsigns {
            correspondents.push(NetworkCorrespondent {
                callsign: c.callsign,
                position: Some(format!("{} {}", c.position, c.unit_name)),
            })
        }
        for c in unlinked_callsigns {
            correspondents.push(NetworkCorrespondent {
                callsign: c,
                position: None, // fixme
            })
        }
        let activity = NetworkActivity {
            since,
            till,
            seances_qty,
        };
        let (_, id, _) = network_key;
        let network = networks_dictionary.get(&id).context(h!())?;
        let row = NetworkRow {
            name: format!("{} {}", network.name, network.unit_name),
            freq,
            activity,
            correspondents,
            communication_kind: None,
            functionality_details: FUNCTIONALITY_DESC_DEFAULT.to_string(),
            identified_details: None,
        };
        hostile_networks.push(row);
    }
    let report = Report {
        summary: ReportSummary {
            identified_qty,
            unidentified_qty,
        },
        hostile_networks,
        undefined_networks: vec![],
    };
    Ok(report)
}
