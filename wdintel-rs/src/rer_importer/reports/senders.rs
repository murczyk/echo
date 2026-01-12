use super::types::ReportAggregation;
use crate::entities::*;
use crate::error::AppError;
use crate::h;
use crate::rer_importer::inbox::query::build_inbox_query;
use crate::rer_importer::types::InboxMessagesReq;
use crate::types::{Env, ShortContext};
use crate::utils::dt_zoned_from_millis;
use crate::utils::orm::ArrayColumnOps;
use anyhow::Context;
use chrono::{NaiveDate, Utc};
use itertools::Itertools;
use log::info;
use rust_xlsxwriter::{Color, Format, FormatAlign, FormatBorder, Workbook};
use sea_orm::*;
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

const FMT_DATE: &str = "%d.%m.%Y";

#[derive(Clone, Debug, Default)]
struct SenderStats {
    overall: u64,
    per_day: BTreeMap<String, u64>,
}

#[derive(Clone, Debug)]
struct MessageStatRecord {
    quantity: u64,
    date: NaiveDate,
    sender: Option<String>,
    post: Option<String>,
}

pub async fn report_xlsx_kind_senders(
    aggregation_kind: ReportAggregation,
    user: actix_identity::Identity,
    env: &Env,
    req: &InboxMessagesReq,
    outpath: &PathBuf,
) -> Result<(), AppError> {
    info!("[report_xlsx_kind_senders] {}: started", Utc::now());
    let read_db = env.replica();
    let login = user.id().c(h!())?;
    let mut req = req.to_owned();
    req.return_duplicates = Some(false);
    let Some(since_date_inclusive_ms) = req.since_date_inclusive_ms else {
        return Err("Since date must be specified".into());
    };
    let Some(till_date_inclusive_ms) = req.till_date_inclusive_ms else {
        return Err("Until date must be specified".into());
    };
    let q = build_inbox_query(&login, env, &req).await.c(h!())?;

    let q = format!(
        r#"SELECT count(*) as quantity, "post_name" as post, "sender" as sender, to_char(("datetime" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Kyiv')::date, 'DD.MM.YYYY') as ts_dt from ({q}) q group by "post_name", "sender", ("datetime" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Kyiv')::date"#
    );
    let query_res: Vec<QueryResult> = read_db
        .query_all(Statement::from_string(DatabaseBackend::Postgres, q))
        .await
        .context(h!())?;
    let mut messages = vec![];
    for query_res in query_res {
        let date: String = query_res.try_get("", "ts_dt")?;
        let quantity: u64 = query_res.try_get::<i64>("", "quantity")? as u64;
        let sender: Option<String> = query_res.try_get("", "sender")?;
        let post: Option<String> = query_res.try_get("", "post")?;
        let date = NaiveDate::parse_from_str(&date, FMT_DATE).context(h!())?;
        messages.push(MessageStatRecord {
            quantity,
            date,
            sender,
            post,
        });
    }

    let senders = map_senders(&aggregation_kind, &read_db, &messages)
        .await
        .c(h!())?;

    let mut sender_stats: BTreeMap<String, SenderStats> = BTreeMap::new();
    let mut dates_with_data = BTreeMap::new();
    for msg in messages {
        let sender_name = extract_sender(&msg, &aggregation_kind)
            .and_then(|s| senders.get(&s).cloned())
            .unwrap_or_else(|| "невідомий відправник".to_string());
        let mut stats =
            sender_stats.get(&sender_name).cloned().unwrap_or_default();
        stats.overall += msg.quantity;
        let date = msg.date;
        let date_txt = date.clone().format(FMT_DATE).to_string();
        let date_counter = stats.per_day.get(&date_txt).cloned().unwrap_or(0);
        dates_with_data.insert(date_txt.clone(), date);
        stats.per_day.insert(date_txt, date_counter + msg.quantity);
        sender_stats.insert(sender_name, stats);
    }

    let dates_with_data = dates_with_data
        .into_iter()
        .sorted_by_key(|(_, date)| *date)
        .map(|(date_txt, _)| date_txt)
        .collect_vec();

    write_report_to_file(
        outpath,
        since_date_inclusive_ms,
        till_date_inclusive_ms,
        sender_stats,
        dates_with_data,
        aggregation_kind,
    )?;

    Ok(())
}

async fn map_senders(
    aggregation_kind: &ReportAggregation,
    dbx: &DatabaseConnection,
    messages: &Vec<MessageStatRecord>,
) -> Result<BTreeMap<String, String>, AppError> {
    let mut senders = BTreeSet::new();
    for msg in messages {
        if let Some(sender) = extract_sender(msg, aggregation_kind) {
            senders.insert(sender.clone());
        };
    }
    let sender_ids = senders.into_iter().map(|x| x.to_string()).collect_vec();
    let senders = match aggregation_kind {
        ReportAggregation::ByProfile => signal_profile::Entity::find()
            .filter(signal_profile::Column::Uuid.eq_any(sender_ids))
            .all(dbx)
            .await
            .c(h!())?
            .into_iter()
            .filter_map(|g| {
                let name_vec = vec![g.given_name, g.family_name]
                    .into_iter()
                    .flatten()
                    .filter(|x| !x.trim().is_empty())
                    .collect_vec();
                if name_vec.is_empty() {
                    None
                } else {
                    Some((g.uuid, name_vec.join(" ")))
                }
            })
            .collect::<BTreeMap<_, _>>(),
        ReportAggregation::ByPost => {
            let mut map = BTreeMap::new();
            for s in sender_ids {
                map.insert(s.clone(), s.trim().to_uppercase().to_string());
            }
            map
        }
    };
    Ok(senders)
}

fn extract_sender(
    msg: &MessageStatRecord,
    report_aggregation: &ReportAggregation,
) -> Option<String> {
    match report_aggregation {
        ReportAggregation::ByProfile => msg.sender.clone(),
        ReportAggregation::ByPost => msg.post.clone(),
    }
}

fn write_report_to_file(
    outpath: &PathBuf,
    since_date_inclusive_ms: i64,
    till_date_inclusive_ms: i64,
    sender_stats: BTreeMap<String, SenderStats>,
    dates_with_data: Vec<String>,
    aggregation_kind: ReportAggregation,
) -> Result<(), AppError> {
    let since = dt_zoned_from_millis(since_date_inclusive_ms)?;
    let till = dt_zoned_from_millis(till_date_inclusive_ms)?;

    let mut workbook = Workbook::new(); // Use rust_xlsxwriter
    let sheet1 = workbook
        .add_worksheet()
        .set_name("Перехоплення")
        .context(h!())?; // Use rust_xlsxwriter

    // Define formats using rust_xlsxwriter
    let coltitle = Format::new()
        .set_bold()
        .set_border(FormatBorder::Thin)
        .set_align(FormatAlign::Center)
        .set_font_size(12.0)
        .set_background_color(Color::RGB(0x5b9bd5)); // Example color

    let tz = crate::config::get_tz();
    let since_tz = since.with_timezone(&tz);
    let till_tz = till.with_timezone(&tz);

    sheet1
        .merge_range(
            0,
            0,
            0,
            2 + dates_with_data.len() as u16,
            &format!(
                "Доповідь по відправниках перехоплень за період {} - {}",
                since_tz.format("%d.%m.%y %H:%M"),
                till_tz.format("%d.%m.%y %H:%M")
            ),
            &coltitle,
        )
        .context(h!())?;

    let sender_column = match aggregation_kind {
        ReportAggregation::ByProfile => "Профіль",
        ReportAggregation::ByPost => "Назва посту",
    };

    let mut row_counter = 0;

    sheet1
        .write_string_with_format(1, row_counter, "№", &coltitle)
        .context(h!())?;
    sheet1.set_column_width(row_counter, 4.0).context(h!())?;
    row_counter += 1;

    sheet1
        .write_string_with_format(1, row_counter, sender_column, &coltitle)
        .context(h!())?;
    sheet1.set_column_width(row_counter, 40.0).context(h!())?;
    row_counter += 1;

    sheet1
        .write_string_with_format(
            1,
            row_counter,
            "Усього відправлено",
            &coltitle,
        )
        .context(h!())?;
    sheet1.set_column_width(row_counter, 40.0).context(h!())?;
    row_counter += 1;

    for date in &dates_with_data {
        sheet1
            .write_string_with_format(1, row_counter, date, &coltitle)
            .context(h!())?;
        sheet1.set_column_width(row_counter, 30.0).context(h!())?;
        row_counter += 1;
    }
    let mut row_counter = 1;
    for (sender, stats) in sender_stats {
        row_counter += 1;
        let mut col_counter = 0;
        sheet1
            .write_number(row_counter, col_counter, (row_counter - 1) as f64)
            .context(h!())?;
        col_counter += 1;

        sheet1
            .write_string(row_counter, col_counter, &sender)
            .context(h!())?;
        col_counter += 1;

        sheet1
            .write_number(row_counter, col_counter, stats.overall as f64)
            .context(h!())?;
        col_counter += 1;

        for date in &dates_with_data {
            let value = stats.per_day.get(date).cloned().unwrap_or(0);
            sheet1
                .write_number(row_counter, col_counter, value as f64)
                .context(h!())?;
            col_counter += 1;
        }
    }
    info!("[report_xlsx_kind_senders] {}: completed", Utc::now());
    workbook.save(outpath).context(h!())?; // Save the workbook
    Ok(())
}
