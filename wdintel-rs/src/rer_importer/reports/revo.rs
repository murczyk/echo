use super::super::types::*;
use crate::entities::*;
use crate::error::AppError;
use crate::types::*;
use crate::utils::*;
use actix_identity::Identity;
use anyhow::Context;
// Add this import if h!() uses anyhow::Context
use calamine::ExcelDateTimeType::TimeDelta;
use chrono::prelude::*;
use chrono::Duration;
use docx_rs::Paragraph;
use docx_rs::Run;
use docx_rs::Shading;
use docx_rs::Table;
use docx_rs::TableCell;
use docx_rs::TableRow;
use docx_rs::VAlignType;
use docx_rs::VMergeType;
use docx_rs::WidthType;
use docx_rs::{
    AlignmentType, BorderType, TableBorder, TableBorderPosition, TableBorders,
};
use docx_rs::{
    LineSpacing, ParagraphBorder, ParagraphBorderPosition, ParagraphProperty,
};
use futures_util::task::noop_waker;
use geoconvert::{LatLon, Mgrs};
use sea_orm::*;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::path::PathBuf;

const WIDTH_UNIT: usize = 1870;
const DTM_FORMAT: &'static str = "%Y.%m.%d %H:%M:%S";

pub struct Report {
    pub summary: NetworkSummary,
    pub hostile_networks: Vec<NetworkRow>,
    pub undefined_networks: Vec<NetworkRow>,
}

pub struct NetworkSummary {
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
    pub name: String,
    pub unit_name: Option<String>,
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
    rows_amrp.push(TableRow::new(vec![mk_merged_text_cell(
        "Російська Федерація",
        true,
    )]));
    for e in report.hostile_networks {
        rows_amrp.push(render_network_row(e));
    }
    rows_amrp.push(TableRow::new(vec![mk_merged_text_cell(
        "Невизначені",
        false,
    )]));
    for e in report.undefined_networks {
        rows_amrp.push(render_network_row(e));
    }
    let thin_border = TableBorder::new(TableBorderPosition::Top)
        .border_type(BorderType::Single)
        .size(12);
    let table_amrp = Table::new(rows_amrp)
        .width(WIDTH_UNIT * 12, WidthType::Dxa)
        .set_border(thin_border);

    let mut docx = docx_rs::Docx::new()
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
        let callsign = c.name;
        match c.unit_name {
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
    let mut bordered_property = ParagraphProperty::new();
    bordered_property
        .set_border(ParagraphBorder::new(ParagraphBorderPosition::Bottom));
    let mut cell = TableCell::new()
        .width(WIDTH_UNIT * 2, WidthType::Dxa)
        .vertical_align(VAlignType::Center);
    let mut remaining_count: i32 = lines.len() as i32;
    let mut is_first_line = true;
    for text in lines {
        remaining_count -= 1;
        let mut paragraph = Paragraph::new().add_run(Run::new().add_text(text));
        if remaining_count > 0 {
            let border = ParagraphBorder::new(ParagraphBorderPosition::Bottom);
            paragraph.property = paragraph.property.set_border(border);
        }
        if is_first_line {
            paragraph = paragraph.line_spacing(LineSpacing::new().before(0));
            is_first_line = false;
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

fn mk_merged_text_cell(text: &str, is_red: bool) -> TableCell {
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
    logins: Vec<String>,
    env: &Env,
) -> anyhow::Result<Report> {
    let now = Utc::now().naive_utc();
    let c1 = NetworkCorrespondent {
        name: "Вьішка".to_string(),
        unit_name: None,
    };
    let c2 = NetworkCorrespondent {
        name: "Граница".to_string(),
        unit_name: None,
    };
    let c3 = NetworkCorrespondent {
        name: "Рошан".to_string(),
        unit_name: Some("ОЧ 1 ср 30 зсб 57".to_string()),
    };
    let report = Report {
        summary: NetworkSummary {
            identified_qty: 2,
            unidentified_qty: 3,
        },
        hostile_networks: vec![NetworkRow{
            name: "УКХ 1".to_string(),
            freq: "324.78".to_string(),
            activity: NetworkActivity {
                since: now - Duration::hours(56),
                till: now,
                seances_qty: 10,
            },
            correspondents: vec![c1, c2, c3],
            communication_kind: None,
            functionality_details: "Склад кореспондентів - звичайний, інтенсивність роботи - звичайна, час роботи - звичайний, район роботи - старий/без змін.".to_string(),
            identified_details: None,
        }],
        undefined_networks: vec![],
    };
    Ok(report)
}

fn message_full_text(
    message: &signal_message::Model,
    inbox: &sigint_inbox_item::Model,
    datasource: &datasource::Model,
    m_comment: &Option<sigint_comment::Model>,
) -> Result<String, AppError> {
    if datasource.kind == "signal" || datasource.kind == "whatsapp" {
        let extended_form = m_comment.clone().map(|x| x.comment);
        return Ok(format!(
            "{}\n\n{}",
            message.body.clone().unwrap_or("".to_string()),
            extended_form.clone().unwrap_or("".to_string())
        ));
    } else if datasource.kind == "api" {
        let datetime_part = match (inbox.date.clone(), inbox.time.clone()) {
            (Some(date), Some(time)) => format!("{} ", date + " " + &time),
            (Some(date), None) => format!("{} ", date),
            (None, Some(time)) => format!("{} ", time),
            (None, None) => "".to_string(),
        };
        let freq_part = match inbox.freq.clone() {
            Some(freq) => format!("{} ", freq),
            None => "".to_string(),
        };
        let unit_part = match inbox.freq {
            Some(_) => {
                format!("{} ", inbox.unit.clone().unwrap_or("НВ".to_string()))
            }
            None => "".to_string(),
        };
        let location_part = match inbox.freq {
            Some(_) => {
                format!("{} ", inbox.location.clone().unwrap_or("".to_string()))
            }
            None => "".to_string(),
        };
        let extended_form = m_comment.clone().map(|x| x.comment);
        let comment_part = match extended_form {
            Some(comment) => format!("\n\nКоментар: {}", comment),
            None => "".to_string(),
        };
        return Ok(format!(
            "{datetime_part}{freq_part}\n{unit_part}{location_part}\n{}{comment_part}",
            message.body.clone().unwrap_or("".to_string()),
        ));
    } else {
        return Err(
            format!("Unknown datasource kind: {:?}", datasource.kind).into()
        );
    }
}
