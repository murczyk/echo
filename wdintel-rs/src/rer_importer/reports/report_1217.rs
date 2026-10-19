use super::digest::SigintBodyNoHeader;
use super::types::ReportPreviewReq;
use crate::config::{
    get_tz, REPORT_1217_BATCH_SIZE, REPORT_1217_COLUMN_WIDTHS,
    REPORT_1217_FONT, REPORT_1217_FONT_SIZE, REPORT_1217_FORM,
    REPORT_1217_PAGE_MARGINS, REPORT_1217_PAGE_SIZE, REPORT_1217_TITLE,
};
use crate::entities::{sigint_inbox_item, sigint_network, signal_message};
use crate::error::AppError;
use crate::rer_importer::report_chunking::{
    build_filtered_inbox_report_chunk_query, inbox_report_chunk_req,
    inbox_report_period_chunks,
};
use crate::rer_importer::types::InboxMessagesReq;
use crate::types::*;
use anyhow::Context;
use chrono::{DateTime, NaiveDateTime};
use docx_rs::*;
use sea_orm::*;
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, FromQueryResult)]
struct Report1217Message {
    id: i64,
    timestamp: Option<NaiveDateTime>,
    body_noheader: Option<serde_json::Value>,
}

#[derive(Clone)]
struct Report1217Interception {
    id: i64,
    timestamp: Option<NaiveDateTime>,
    comment: String,
    body: String,
}

struct Report1217Network {
    name: String,
    interceptions: Vec<Report1217Interception>,
}

pub async fn report_docx_kind_report_1217(
    user_login: &uuid::Uuid,
    env: &Env,
    req: &ReportPreviewReq,
    outpath: &Path,
) -> Result<(), AppError> {
    let mut request = req.req.clone();
    request.nolimit = Some(true);
    request.report_tags_only_this_unit = Some(false);
    let analytics_request = &request;
    let postgres_request = &request;
    let messages = crate::rer_importer::analysis::with_analytics_read_fallback(
        env,
        "report 1.2.17 interception scan",
        crate::rer_importer::analysis::analytics_inbox_request_supported(
            &request,
        ),
        |db| async move {
            Ok(
                load_report_messages(&db, user_login, env, analytics_request)
                    .await
                    .c(h!())?,
            )
        },
        |db| async move {
            Ok(load_report_messages(&db, user_login, env, postgres_request)
                .await
                .c(h!())?)
        },
    )
    .await
    .c(h!())?;
    let networks = collect_networks(&env.dbx, user_login, messages)
        .await
        .c(h!())?;
    let record_count = networks
        .iter()
        .map(|network| network.interceptions.len())
        .sum();
    crate::report_history::ensure_report_record_count(record_count).c(h!())?;
    let docx = build_docx(&networks, &request).c(h!())?;
    let file = std::fs::File::create(outpath).c(h!())?;
    docx.build().pack(file).c(h!())?;
    Ok(())
}

async fn load_report_messages(
    dbx: &DatabaseConnection,
    login: &uuid::Uuid,
    env: &Env,
    req: &InboxMessagesReq,
) -> anyhow::Result<Vec<Report1217Message>> {
    let settings =
        crate::system_settings::get_report_generation_settings(&env.dbx)
            .await
            .c(h!())?;
    let chunks =
        inbox_report_period_chunks(req, settings.chunking_hours).c(h!())?;
    let mut messages = BTreeMap::new();
    for (index, chunk) in chunks.iter().copied().enumerate() {
        info!("Report 1.2.17 chunk {}/{}", index + 1, chunks.len());
        let request = inbox_report_chunk_req(req, chunk);
        let rows = build_filtered_inbox_report_chunk_query(
            dbx, login, env, &request, chunk.end,
        )
        .await
        .c(h!())?
        .select_only()
        .column_as(signal_message::Column::Id, "id")
        .column_as(signal_message::Column::Timestamp, "timestamp")
        .column_as(sigint_inbox_item::Column::BodyNoheader, "body_noheader")
        .into_model::<Report1217Message>()
        .all(dbx)
        .await
        .c(h!())?;
        for message in rows {
            messages.entry(message.id).or_insert(message);
        }
    }
    Ok(messages.into_values().collect())
}

async fn collect_networks(
    dbx: &DatabaseConnection,
    login: &uuid::Uuid,
    messages: Vec<Report1217Message>,
) -> anyhow::Result<Vec<Report1217Network>> {
    let logins = crate::users::get_organism_login_ids_by_id(dbx, login)
        .await
        .c(h!())?;
    let mut interceptions_by_network: BTreeMap<
        i64,
        Vec<Report1217Interception>,
    > = BTreeMap::new();
    for batch in messages.chunks(REPORT_1217_BATCH_SIZE) {
        collect_batch(dbx, &logins, batch, &mut interceptions_by_network)
            .await
            .c(h!())?;
    }
    let mut networks = vec![];
    let network_ids =
        interceptions_by_network.keys().copied().collect::<Vec<_>>();
    for ids in network_ids.chunks(REPORT_1217_BATCH_SIZE) {
        let names = sigint_network::Entity::find()
            .select_only()
            .columns([sigint_network::Column::Id, sigint_network::Column::Name])
            .filter(sigint_network::Column::Id.is_in(ids.to_vec()))
            .into_tuple::<(i64, String)>()
            .all(dbx)
            .await
            .c(h!())?;
        for (id, name) in names {
            let mut interceptions =
                interceptions_by_network.remove(&id).unwrap_or_default();
            interceptions.sort_by_key(|item| (item.timestamp, item.id));
            networks.push(Report1217Network {
                name,
                interceptions,
            });
        }
    }
    networks.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(networks)
}

async fn collect_batch(
    dbx: &DatabaseConnection,
    logins: &[uuid::Uuid],
    messages: &[Report1217Message],
    interceptions_by_network: &mut BTreeMap<i64, Vec<Report1217Interception>>,
) -> anyhow::Result<()> {
    let ids = messages
        .iter()
        .map(|message| message.id)
        .collect::<Vec<_>>();
    let networks =
        crate::rer_importer::inbox::load_message_networks_by_ids(dbx, &ids)
            .await
            .c(h!())?;
    let comments = load_comments(dbx, logins, &ids).await.c(h!())?;
    for message in messages {
        let Some(network_ids) =
            networks.get(&message.id).filter(|ids| !ids.is_empty())
        else {
            continue;
        };
        let body = message
            .body_noheader
            .clone()
            .map(serde_json::from_value::<SigintBodyNoHeader>)
            .transpose()
            .c(h!())?
            .map(|body| body.body)
            .unwrap_or_default();
        let interception = Report1217Interception {
            id: message.id,
            timestamp: message.timestamp,
            comment: comments
                .get(&message.id)
                .cloned()
                .unwrap_or_default()
                .join("\n"),
            body,
        };
        for network_id in network_ids {
            interceptions_by_network
                .entry(*network_id)
                .or_default()
                .push(interception.clone());
        }
    }
    Ok(())
}

async fn load_comments(
    dbx: &DatabaseConnection,
    logins: &[uuid::Uuid],
    ids: &[i64],
) -> anyhow::Result<BTreeMap<i64, Vec<String>>> {
    let rows =
        crate::sigint::comments::find_report_comments(dbx, ids, Some(logins))
            .await
            .c(h!())?;
    let mut comments: BTreeMap<i64, Vec<String>> = BTreeMap::new();
    for comment in rows {
        comments
            .entry(comment.source_message_id)
            .or_default()
            .push(comment.comment);
    }
    Ok(comments)
}

fn build_docx(
    networks: &[Report1217Network],
    req: &InboxMessagesReq,
) -> anyhow::Result<Docx> {
    let period = report_period(req).c(h!())?;
    let (left, right, top, bottom) = REPORT_1217_PAGE_MARGINS;
    Ok(Docx::new()
        .page_size(REPORT_1217_PAGE_SIZE.0, REPORT_1217_PAGE_SIZE.1)
        .page_margin(
            PageMargin::new()
                .left(left)
                .right(right)
                .top(top)
                .bottom(bottom),
        )
        .default_size(REPORT_1217_FONT_SIZE)
        .default_fonts(
            RunFonts::new()
                .ascii(REPORT_1217_FONT)
                .hi_ansi(REPORT_1217_FONT),
        )
        .add_paragraph(
            Paragraph::new()
                .align(AlignmentType::Right)
                .add_run(Run::new().add_text(REPORT_1217_FORM)),
        )
        .add_paragraph(Paragraph::new())
        .add_paragraph(
            Paragraph::new()
                .align(AlignmentType::Center)
                .add_run(Run::new().add_text(REPORT_1217_TITLE).bold()),
        )
        .add_paragraph(
            Paragraph::new()
                .align(AlignmentType::Center)
                .add_run(Run::new().add_text(period)),
        )
        .add_paragraph(Paragraph::new())
        .add_table(networks_table(networks)))
}

fn report_period(req: &InboxMessagesReq) -> anyhow::Result<String> {
    let since = DateTime::from_timestamp_millis(
        req.since_date_inclusive_ms.context(h!())?,
    )
    .context(h!())?;
    let till = DateTime::from_timestamp_millis(
        req.till_date_inclusive_ms.context(h!())?,
    )
    .context(h!())?;
    Ok(format!(
        "(станом з {} по {})",
        format_timestamp(since.naive_utc()),
        format_timestamp(till.naive_utc())
    ))
}

fn networks_table(networks: &[Report1217Network]) -> Table {
    let width = REPORT_1217_COLUMN_WIDTHS.iter().sum();
    let mut rows = vec![TableRow::new(vec![
        text_cell("Висновки", REPORT_1217_COLUMN_WIDTHS[0], true),
        text_cell("Радіоперехоплення", REPORT_1217_COLUMN_WIDTHS[1], true),
    ])];
    for network in networks {
        rows.push(TableRow::new(vec![
            text_cell(&network.name, width, true).grid_span(2)
        ]));
        rows.extend(network.interceptions.iter().map(interception_row));
    }
    Table::new(rows)
        .set_grid(REPORT_1217_COLUMN_WIDTHS.to_vec())
        .width(width, WidthType::Dxa)
}

fn interception_row(interception: &Report1217Interception) -> TableRow {
    let timestamp = interception
        .timestamp
        .map(format_timestamp)
        .unwrap_or_default();
    let body = text_cell(&timestamp, REPORT_1217_COLUMN_WIDTHS[1], false);
    let body = interception.body.split('\n').fold(body, |cell, line| {
        cell.add_paragraph(
            Paragraph::new().add_run(Run::new().add_text(line).italic()),
        )
    });
    TableRow::new(vec![
        text_cell(&interception.comment, REPORT_1217_COLUMN_WIDTHS[0], false),
        body,
    ])
}

fn text_cell(text: &str, width: usize, heading: bool) -> TableCell {
    text.split('\n').fold(
        TableCell::new()
            .width(width, WidthType::Dxa)
            .vertical_align(VAlignType::Top),
        |cell, line| {
            let run = Run::new().add_text(line).italic();
            let paragraph = if heading {
                Paragraph::new()
                    .align(AlignmentType::Center)
                    .add_run(run.bold())
            } else {
                Paragraph::new().add_run(run)
            };
            cell.add_paragraph(paragraph)
        },
    )
}

fn format_timestamp(timestamp: NaiveDateTime) -> String {
    timestamp
        .and_utc()
        .with_timezone(&get_tz())
        .format("%d.%m.%Y %H:%M")
        .to_string()
}

#[cfg(test)]
mod tests;
