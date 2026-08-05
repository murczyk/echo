use super::types::ReportAggregation;
use crate::entities::*;
use crate::error::AppError;
use crate::h;
use crate::rer_importer::inbox::query::build_filtered_inbox_query;
use crate::rer_importer::types::InboxMessagesReq;
use crate::sigint::sender::preferred_sender_expr;
use crate::types::info;
use crate::types::{Env, ShortContext};
use crate::utils::dt_zoned_from_millis;
use anyhow::Context;
use chrono::{NaiveDate, Utc};
use itertools::Itertools;
use rust_xlsxwriter::{Color, Format, FormatAlign, FormatBorder, Workbook};
use sea_orm::sea_query::Expr;
use sea_orm::*;
use std::cmp::max;
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

const FMT_DATE: &str = "%d.%m.%Y";

#[derive(Clone, Debug, Default)]
struct SenderStats {
    overall: u64,
    per_day: BTreeMap<String, u64>,
    freq_breakdown: BTreeMap<(Option<String>, Option<String>), u64>,
}

#[derive(Clone, Debug)]
struct MessageStatRecord {
    quantity: u64,
    date: NaiveDate,
    sender: Option<String>,
    post: Option<String>,
    freq: Option<String>,
}

#[derive(Debug, FromQueryResult)]
struct MessageStatRow {
    quantity: i64,
    ts_dt: String,
    sender: Option<String>,
    post: Option<String>,
    freq: Option<String>,
}

pub async fn report_xlsx_kind_senders(
    aggregation_kind: ReportAggregation,
    advanced_freqs: bool,
    user_login: &uuid::Uuid,
    env: &Env,
    req: &InboxMessagesReq,
    outpath: &PathBuf,
) -> Result<(), AppError> {
    info!("[report_xlsx_kind_senders] {}: started", Utc::now());
    let login = *user_login;
    let mut req = req.to_owned();
    req.return_duplicates = Some(false);
    let Some(since_date_inclusive_ms) = req.since_date_inclusive_ms else {
        return Err("Since date must be specified".into());
    };
    let Some(till_date_inclusive_ms) = req.till_date_inclusive_ms else {
        return Err("Until date must be specified".into());
    };
    let analytics_req = &req;
    let postgres_req = &req;
    let messages =
        crate::rer_importer::analysis::with_analytics_read_fallback(
            env,
            "senders report message aggregation",
            crate::rer_importer::analysis::analytics_inbox_request_supported(
                &req,
            ),
            |db| async move {
                load_message_stats(&db, &login, env, analytics_req).await
            },
            |db| async move {
                load_message_stats(&db, &login, env, postgres_req).await
            },
        )
        .await
        .context(h!())?;

    let read_db = env.replica();
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
        let freq_key = (msg.freq.clone(), msg.post.clone());
        stats
            .freq_breakdown
            .entry(freq_key)
            .and_modify(|count| *count += msg.quantity)
            .or_insert(msg.quantity);
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
        advanced_freqs,
    )?;

    Ok(())
}

async fn load_message_stats(
    dbx: &DatabaseConnection,
    login: &uuid::Uuid,
    env: &Env,
    req: &InboxMessagesReq,
) -> Result<Vec<MessageStatRecord>, AppError> {
    let kyiv_date_expr = Expr::cust(
        r#"("sigint_inbox_item"."datetime" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Kyiv')::date"#,
    );
    let rows = build_filtered_inbox_query(dbx, login, env, req)
        .await
        .c(h!())?
        .select_only()
        .column_as(Expr::cust("count(*)"), "quantity")
        .column_as(sigint_post::Column::Name, "post")
        .column_as(preferred_sender_expr(None), "sender")
        .column_as(sigint_inbox_item::Column::Freq, "freq")
        .column_as(
            Expr::cust(r#"to_char(("sigint_inbox_item"."datetime" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Kyiv')::date, 'DD.MM.YYYY')"#),
            "ts_dt",
        )
        .group_by(sigint_post::Column::Name)
        .group_by(preferred_sender_expr(None))
        .group_by(sigint_inbox_item::Column::Freq)
        .group_by(kyiv_date_expr)
        .into_model::<MessageStatRow>()
        .all(dbx)
        .await
        .context(h!())?;

    rows.into_iter()
        .map(|row| {
            Ok(MessageStatRecord {
                quantity: row.quantity as u64,
                date: NaiveDate::parse_from_str(&row.ts_dt, FMT_DATE)
                    .context(h!())?,
                sender: row.sender,
                post: row.post,
                freq: row.freq,
            })
        })
        .collect()
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
    advanced_freqs: bool,
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

    let text_multiline = Format::new().set_text_wrap();

    let tz = crate::config::get_tz();
    let since_tz = since.with_timezone(&tz);
    let till_tz = till.with_timezone(&tz);
    let last_col = match aggregation_kind {
        ReportAggregation::ByProfile => {
            dates_with_data.len() as u16 + if advanced_freqs { 5 } else { 2 }
        }
        ReportAggregation::ByPost => {
            dates_with_data.len() as u16 + if advanced_freqs { 4 } else { 2 }
        }
    };

    sheet1
        .merge_range(
            0,
            0,
            0,
            last_col,
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

    if advanced_freqs {
        sheet1
            .write_string_with_format(1, row_counter, "Частоти", &coltitle)
            .context(h!())?;
        sheet1.set_column_width(row_counter, 35.0).context(h!())?;
        row_counter += 1;

        if aggregation_kind == ReportAggregation::ByProfile {
            sheet1
                .write_string_with_format(1, row_counter, "Пост", &coltitle)
                .context(h!())?;
            sheet1.set_column_width(row_counter, 35.0).context(h!())?;
            row_counter += 1;
        }

        sheet1
            .write_string_with_format(1, row_counter, "Кількість", &coltitle)
            .context(h!())?;
        sheet1.set_column_width(row_counter, 20.0).context(h!())?;
        row_counter += 1;
    }

    for date in &dates_with_data {
        sheet1
            .write_string_with_format(1, row_counter, date, &coltitle)
            .context(h!())?;
        sheet1.set_column_width(row_counter, 30.0).context(h!())?;
        row_counter += 1;
    }
    let mut row_counter = 1;
    let mut date_row_counter;
    for (sender, stats) in sender_stats {
        row_counter += 1;
        date_row_counter = row_counter;
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

        if advanced_freqs {
            let mut freq_entries = stats.freq_breakdown.iter().collect_vec();
            freq_entries.sort_by(|a, b| b.1.cmp(a.1));
            let freq_lines = freq_entries
                .iter()
                .map(|((freq, _), _)| {
                    freq.clone().unwrap_or_else(|| "невідомо".to_string())
                })
                .collect_vec();
            let post_lines = freq_entries
                .iter()
                .map(|((_, post), _)| {
                    post.clone().unwrap_or_else(|| "".to_string())
                })
                .collect_vec();
            let count_lines = freq_entries
                .iter()
                .map(|(_, count)| count.to_string())
                .collect_vec();

            let mut freq_row_counter = row_counter;
            for freq_line in freq_lines {
                sheet1
                    .write_string_with_format(
                        freq_row_counter,
                        col_counter,
                        &freq_line,
                        &text_multiline,
                    )
                    .context(h!())?;
                freq_row_counter += 1;
            }
            col_counter += 1;

            let mut post_row_counter = row_counter;
            if aggregation_kind == ReportAggregation::ByProfile {
                for post_line in post_lines {
                    sheet1
                        .write_string_with_format(
                            post_row_counter,
                            col_counter,
                            &post_line,
                            &text_multiline,
                        )
                        .context(h!())?;
                    post_row_counter += 1;
                }
                col_counter += 1;
            }

            let mut count_line_row_counter = row_counter;
            for count_line in count_lines {
                sheet1
                    .write_string_with_format(
                        count_line_row_counter,
                        col_counter,
                        &count_line,
                        &text_multiline,
                    )
                    .context(h!())?;
                count_line_row_counter += 1;
            }

            row_counter = max(
                max(freq_row_counter, post_row_counter),
                count_line_row_counter,
            );

            col_counter += 1;
        }

        for date in &dates_with_data {
            let value = stats.per_day.get(date).cloned().unwrap_or(0);
            sheet1
                .write_number(date_row_counter, col_counter, value as f64)
                .context(h!())?;
            col_counter += 1;
        }
    }
    info!("[report_xlsx_kind_senders] {}: completed", Utc::now());
    workbook.save(outpath).context(h!())?; // Save the workbook
    Ok(())
}
