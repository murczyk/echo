use crate::entities::*;
use crate::error::AppError;
use crate::rer_importer::analysis::*;
use crate::rer_importer::report_chunking::{
    inbox_report_chunk_req, inbox_report_period_chunks, ReportPeriodEnd,
};
use crate::sigint::network::display_network_type;
use crate::types::*;
use crate::utils::*;
use chrono::{NaiveDateTime, TimeZone};
use docx_rs::*;
use itertools::Itertools;
use sea_orm::*;
use sea_query::{Expr, IntoCondition};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::fmt::Debug;
use std::path::PathBuf;

fn split_into_lines(mut cell: TableCell, text: &str) -> TableCell {
    for text_line in text.lines() {
        cell = cell.add_paragraph(
            Paragraph::new().add_run(Run::new().add_text(text_line)),
        )
    }
    cell
}

pub async fn report_docx_kind_naushnom(
    user_login: &uuid::Uuid,
    env: &Env,
    req: &super::types::ReportPreviewReq,
    outpath: &PathBuf,
) -> Result<(), AppError> {
    let width_unit = 100;
    let mut inbox_req = req.req.clone();
    inbox_req.report_tags_only_this_unit = req.report_tags_only_this_unit;
    let network_map =
        get_inbox_messages_report_network(user_login, env, &inbox_req)
            .await
            .c(h!())?;
    let record_count = network_map
        .values()
        .flat_map(|(_, _, network_units)| network_units.values())
        .fold(0_usize, |count, messages| {
            count.saturating_add(messages.len())
        });
    crate::report_history::ensure_report_record_count(record_count)?;

    let style_invisible = Style::new("Invisible", StyleType::Paragraph)
        .name("Invisible")
        .align(AlignmentType::Center)
        .size(0);

    let head = "Heading";
    let style_heading = Style::new(head, StyleType::Paragraph)
        .name("Heading 2")
        .align(AlignmentType::Left)
        .size(24)
        .bold();

    let mut doc = docx_rs::Docx::new()
        .default_size(22)
        .add_style(style_invisible)
        .add_style(style_heading);

    for (m_location, kind, network_units_map) in network_map.values() {
        let all_units = network_units_map.keys().join("; ");
        let mut title = format!("{kind} р/м {all_units}");
        if let Some(location) = m_location {
            title += &format!(" (р-н {})", location.to_uppercase().trim());
        }
        let freqs = network_units_map
            .values()
            .flat_map(|v| v.iter().map(|r| r.freq.clone()))
            .collect::<HashSet<String>>();
        let freq_title = if freqs.len() > 1 {
            "Частоти:"
        } else {
            "Частота:"
        };

        let mut trs = vec![TableRow::new(vec![
            TableCell::new()
                .width(width_unit * 20, WidthType::Dxa)
                .add_paragraph(
                    Paragraph::new()
                        .add_run(Run::new().add_text("Зміст перехоплення"))
                        .align(docx_rs::alignment_type::AlignmentType::Center),
                )
                .vertical_align(VAlignType::Center)
                .set_borders(TableCellBorders::new()),
            TableCell::new()
                .width(width_unit * 17, WidthType::Dxa)
                .add_paragraph(
                    Paragraph::new()
                        .add_run(Run::new().add_text("Час та дата"))
                        .align(docx_rs::alignment_type::AlignmentType::Center),
                )
                .vertical_align(VAlignType::Center)
                .set_borders(TableCellBorders::new()),
            TableCell::new()
                .width(width_unit * 11, WidthType::Dxa)
                .add_paragraph(
                    Paragraph::new()
                        .add_run(Run::new().add_text("Частота"))
                        .align(docx_rs::alignment_type::AlignmentType::Center),
                )
                .vertical_align(VAlignType::Center)
                .set_borders(TableCellBorders::new()),
            TableCell::new()
                .width(width_unit * 50, WidthType::Dxa)
                .add_paragraph(
                    Paragraph::new()
                        .add_run(Run::new().add_text("Перехоплення"))
                        .align(docx_rs::alignment_type::AlignmentType::Center),
                )
                .vertical_align(VAlignType::Center)
                .set_borders(TableCellBorders::new()),
        ])];

        let tz = crate::config::get_tz();
        for message_reports in network_units_map.values() {
            for msg in message_reports {
                let formatted_dt = msg
                    .datetime
                    .map(|dt| {
                        tz.from_utc_datetime(&dt)
                            .format("%d.%m, %H:%M:%S")
                            .to_string()
                    })
                    .unwrap_or("".to_string());
                trs.push(TableRow::new(vec![
                    split_into_lines(
                        TableCell::new().width(width_unit * 20, WidthType::Dxa),
                        &msg.comment,
                    )
                    .set_borders(TableCellBorders::new()),
                    TableCell::new()
                        .width(width_unit * 17, WidthType::Dxa)
                        .add_paragraph(
                            Paragraph::new()
                                .add_run(Run::new().add_text(formatted_dt)),
                        )
                        .set_borders(TableCellBorders::new()),
                    TableCell::new()
                        .width(width_unit * 11, WidthType::Dxa)
                        .add_paragraph(Paragraph::new().add_run(
                            Run::new().add_text(msg.freq.clone().to_string()),
                        ))
                        .set_borders(TableCellBorders::new()),
                    split_into_lines(
                        TableCell::new().width(width_unit * 50, WidthType::Dxa),
                        msg.body.as_ref().unwrap_or(&String::from("")),
                    )
                    .set_borders(TableCellBorders::new()),
                ]));
            }
        }
        let stats_table = Table::new(trs);
        doc = doc
            .add_paragraph(
                Paragraph::new()
                    .add_run(Run::new().size(30).add_text(title).bold())
                    .align(docx_rs::alignment_type::AlignmentType::Left),
            )
            .add_paragraph(Paragraph::new())
            .add_paragraph(
                Paragraph::new()
                    .add_run(
                        Run::new()
                            .add_text(freq_title.to_string())
                            .underline("single"),
                    )
                    .add_run(
                        Run::new()
                            .add_text(format!(" {}", freqs.iter().join(", ")))
                            .bold(),
                    )
                    .align(docx_rs::alignment_type::AlignmentType::Left),
            )
            .add_paragraph(
                Paragraph::new()
                    .add_run(
                        Run::new()
                            .add_text("Безповоротні втрати: 0")
                            .underline("single"),
                    )
                    .align(docx_rs::alignment_type::AlignmentType::Left),
            )
            .add_paragraph(
                Paragraph::new()
                    .add_run(
                        Run::new()
                            .add_text("Санітарні втрати: 0")
                            .underline("single"),
                    )
                    .align(docx_rs::alignment_type::AlignmentType::Left),
            )
            .add_paragraph(
                Paragraph::new()
                    .add_run(
                        Run::new()
                            .add_text("Суттєві перехоплення:")
                            .underline("single"),
                    )
                    .align(docx_rs::alignment_type::AlignmentType::Left),
            )
            .add_table(stats_table)
            .add_paragraph(Paragraph::new())
            .add_paragraph(Paragraph::new());
    }

    let file = std::fs::File::create(outpath)?;
    doc.build().pack(file).context(h!())?;

    Ok(())
}

#[derive(FromQueryResult, Deserialize, Debug, Clone, PartialEq, Hash)]
pub struct NetworkMessagesReport {
    comment: String,
    body: Option<String>,
    datetime: Option<NaiveDateTime>,
    freq: String,
}

pub async fn get_inbox_messages_report_network(
    user_login: &uuid::Uuid,
    env: &Env,
    req: &crate::rer_importer::types::InboxMessagesReq,
) -> Result<
    HashMap<
        i64,
        (
            Option<String>,
            String,
            HashMap<String, Vec<NetworkMessagesReport>>,
        ),
    >,
    AppError,
> {
    let report_settings =
        crate::system_settings::get_report_generation_settings(&env.dbx)
            .await
            .c(h!())?;
    let chunks =
        inbox_report_period_chunks(req, report_settings.chunking_hours)
            .context(h!())?;
    let mut networks = HashMap::new();
    for (index, chunk) in chunks.iter().copied().enumerate() {
        info!(
            "Naushnom report chunk {}/{}: {}..{} ({:?})",
            index + 1,
            chunks.len(),
            chunk.since_ms,
            chunk.till_ms,
            chunk.end
        );
        let chunk_req = inbox_report_chunk_req(req, chunk);
        let chunk_networks = get_inbox_messages_report_network_chunk(
            user_login, env, &chunk_req, chunk.end,
        )
        .await
        .context(h!())?;
        merge_network_report_chunks(&mut networks, chunk_networks);
    }
    for (_, _, unit_messages) in networks.values_mut() {
        for messages in unit_messages.values_mut() {
            messages.sort_by_key(|message| std::cmp::Reverse(message.datetime));
        }
    }
    Ok(networks)
}

async fn get_inbox_messages_report_network_chunk(
    user_login: &uuid::Uuid,
    env: &Env,
    req: &crate::rer_importer::types::InboxMessagesReq,
    period_end: ReportPeriodEnd,
) -> Result<
    HashMap<
        i64,
        (
            Option<String>,
            String,
            HashMap<String, Vec<NetworkMessagesReport>>,
        ),
    >,
    AppError,
> {
    let read_db = env.replica();
    let login = *user_login;
    let include_peleng_locations =
        req.include_peleng_locations.unwrap_or(false);

    let sigint_groups =
        crate::messenger::group::get_identity_sigint_groups(&read_db, &login)
            .await
            .c(h!())?;
    let mut q = signal_message::Entity::find()
        .select_only()
        .column_as(signal_message::Column::Body, "body")
        .column_as(sigint_unit::Column::Name, "unit_name")
        .column_as(sigint_inbox_item::Column::Datetime, "datetime")
        .column_as(sigint_network_freq::Column::Freq, "freq")
        .column_as(sigint_network::Column::Id, "network_id")
        .column_as(signal_message::Column::Id, "message_id")
        .column(sigint_network_freq::Column::Modulation)
        .column(sigint_network::Column::Location)
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::DatasourceGroup.def(),
        )
        .join(
            JoinType::InnerJoin,
            crate::sigint::freq::util::inbox_item_network_freq_relation()
                .on_condition(|_left, right| {
                    Expr::col((right, sigint_network_freq::Column::Deleted))
                        .eq(false)
                        .into_condition()
                }),
        )
        .join(
            JoinType::InnerJoin,
            sigint_network_freq::Relation::SigintNetwork
                .def()
                .on_condition(|_left, right| {
                    Expr::col((right, sigint_network::Column::Deleted))
                        .eq(false)
                        .into_condition()
                }),
        )
        .join(
            JoinType::LeftJoin,
            sigint_network::Relation::SigintNetworkUnit.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_network_unit::Relation::SigintUnit
                .def()
                .on_condition(|_left, right| {
                    Expr::col((right, sigint_unit::Column::Deleted))
                        .eq(false)
                        .into_condition()
                }),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintPost.def().on_condition(
                |_left, right| {
                    Expr::col((right, sigint_post::Column::Deleted))
                        .eq(false)
                        .into_condition()
                },
            ),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(
            datasource_group::Column::GroupMasterKey
                .eq_any(sigint_groups.clone()),
        );

    if req.only_show_unprocessed == Some(true) {
        q = q.filter(sigint_inbox_item::Column::Reviewed.ne(Some(true)));
    }
    if req.checked_only == Some(true) {
        q = q.filter(sigint_inbox_item::Column::Checked.eq(Some(true)));
    }
    let q = filter_selected_groups_and_senders_with_access(
        q,
        &req.selected_groups,
        &req.selected_senders,
        &sigint_groups,
    )
    .context(h!())?;
    let q = filter_denied_senders(q, &req.denied_senders)?;
    let q = filter_selected_freqs(q, &req.selected_freqs)?;
    let q = filter_selected_posts(q, &req.selected_posts)?;
    let q = filter_denied_freqs(q, &req.denied_freqs)?;
    let q = filter_selected_callsigns(q, &req.selected_callsigns)?;
    let q = filter_search(q, &req.search)?;
    let q = filter_selected_units(
        q,
        &req.selected_units,
        &req.units_exact_match_only,
    )?;
    let q = filter_selected_networks(
        q,
        &req.selected_networks,
        &req.without_network,
    )
    .context(h!())?;
    let q = filter_selected_metadata_for_inbox_messages(q, req)?;
    let mut q = filter_selected_tags(
        q,
        &req.selected_tags,
        &req.denied_tags,
        &req.tag_presence,
        &req.or_bookmarked,
        &req.or_important,
        &req.or_with_coords,
        &req.or_without_coords,
        &Some(false),
        &req.filter_tags_option,
        &req.without_model_tags,
        &login,
        req.report_tags_only_this_unit.unwrap_or(false),
    )?;
    if let Some(since_date_inclusive_ms) = req.since_date_inclusive_ms {
        q = q.filter(
            sigint_inbox_item::Column::Datetime
                .gte(dt_from_millis(since_date_inclusive_ms).context(h!())?),
        );
    }
    if let Some(till_date_inclusive_ms) = req.till_date_inclusive_ms {
        q = match period_end {
            ReportPeriodEnd::Inclusive => q
                .filter(sigint_inbox_item::Column::Datetime.lte(
                    dt_from_millis(till_date_inclusive_ms).context(h!())?,
                )),
            ReportPeriodEnd::NonInclusive => q.filter(
                sigint_inbox_item::Column::Datetime
                    .lt(dt_from_millis(till_date_inclusive_ms).context(h!())?),
            ),
        };
    }
    let q = filter_selected_locations(
        q,
        &req.selected_locations,
        include_peleng_locations,
    )
    .context(h!())?;
    let q = filter_selected_aors(q, &req.selected_aors).context(h!())?;
    let q = q.order_by_desc(sigint_inbox_item::Column::Datetime);

    #[derive(FromQueryResult)]
    struct Row {
        message_id: i64,
        body: Option<String>,
        datetime: Option<NaiveDateTime>,
        freq: String,
        unit_name: String,
        network_id: i64,
        modulation: Option<String>,
        location: Option<String>,
    }
    let rows = q.into_model::<Row>().all(&read_db).await.context(h!())?;
    let comments = crate::sigint::comments::find_report_comments(
        &read_db,
        &rows.iter().map(|row| row.message_id).collect::<Vec<_>>(),
        None,
    )
    .await
    .context(h!())?;
    let mut comments_by_message = HashMap::<i64, Vec<String>>::new();
    for comment in comments {
        if !comment.comment.trim().is_empty() {
            comments_by_message
                .entry(comment.source_message_id)
                .or_default()
                .push(comment.comment);
        }
    }

    let mut res_map = HashMap::new();
    for row in rows {
        let Some(comments_for_message) =
            comments_by_message.get(&row.message_id)
        else {
            continue;
        };
        let network_id = row.network_id;
        let unit_name = row.unit_name;
        let kind =
            display_network_type(row.modulation.as_deref()).unwrap_or_default();
        let location = row.location;
        let network_map = res_map.entry(network_id).or_insert((
            location,
            kind,
            HashMap::new(),
        ));
        let message_reports =
            network_map.2.entry(unit_name).or_insert(Vec::new());
        message_reports.extend(comments_for_message.iter().map(|comment| {
            NetworkMessagesReport {
                comment: comment.clone(),
                body: row.body.clone(),
                datetime: row.datetime,
                freq: row.freq.clone(),
            }
        }));
    }

    Ok(res_map)
}

fn merge_network_report_chunks(
    networks: &mut HashMap<
        i64,
        (
            Option<String>,
            String,
            HashMap<String, Vec<NetworkMessagesReport>>,
        ),
    >,
    chunk_networks: HashMap<
        i64,
        (
            Option<String>,
            String,
            HashMap<String, Vec<NetworkMessagesReport>>,
        ),
    >,
) {
    for (network_id, (location, kind, unit_messages)) in chunk_networks {
        let network = networks.entry(network_id).or_insert_with(|| {
            (location.clone(), kind.clone(), HashMap::new())
        });
        for (unit, messages) in unit_messages {
            network.2.entry(unit).or_default().extend(messages);
        }
    }
}
