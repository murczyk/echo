use crate::entities::*;
use crate::error::AppError;
use crate::rer_importer::analysis::*;
use crate::sigint::network::display_network_type;
use crate::types::*;
use crate::utils::orm::ArrayColumnOps;
use crate::utils::*;
use actix_identity::Identity;
use chrono::{NaiveDateTime, TimeZone};
use docx_rs::*;
use itertools::Itertools;
use sea_orm::*;
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
    user: Identity,
    env: &Env,
    req: &super::types::ReportPreviewReq,
    outpath: &PathBuf,
) -> Result<(), AppError> {
    let file = std::fs::File::create(outpath)?;
    let width_unit = 100;

    let network_map = get_inbox_messages_report_network(user, env, &req.req)
        .await
        .c(h!())?;

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
    user: Identity,
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
    let read_db = env.replica();
    let login = user.id().c(h!())?;
    let include_peleng_locations =
        req.include_peleng_locations.unwrap_or(false);

    let mut q = signal_message::Entity::find()
        .select_only()
        .column_as(signal_message::Column::Body, "body")
        .column_as(sigint_unit::Column::Name, "unit_name")
        .column_as(sigint_inbox_item::Column::Datetime, "datetime")
        .column_as(sigint_network_freq::Column::Freq, "freq")
        .column_as(sigint_comment::Column::Comment, "comment")
        .column_as(sigint_network::Column::Id, "network_id")
        .column(sigint_network_freq::Column::Kind)
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
            signal_message::Relation::SigintComment.def(),
        )
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SigintNetworkFreq.def(),
        )
        .join(
            JoinType::InnerJoin,
            sigint_network_freq::Relation::SigintNetwork.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_network::Relation::SigintNetworkUnit.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_network_unit::Relation::SigintUnit.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintPost.def(),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(
            datasource_group::Column::GroupMasterKey.eq_any(
                crate::messenger::group::get_identity_sigint_groups(
                    &read_db, &login,
                )
                .await
                .c(h!())?,
            ),
        )
        .filter(sigint_comment::Column::Comment.eq("").not());

    if req.only_show_unprocessed == Some(true) {
        q = q.filter(sigint_inbox_item::Column::Reviewed.ne(Some(true)));
    }
    if req.checked_only == Some(true) {
        q = q.filter(sigint_inbox_item::Column::Checked.eq(Some(true)));
    }
    let q = filter_selected_groups(q, &req.selected_groups)?;
    let q = filter_selected_senders(q, &req.selected_senders)?;
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
    let q =
        filter_selected_networks(q, &req.selected_networks).context(h!())?;
    let mut q = filter_selected_tags(
        q,
        &req.selected_tags,
        &req.or_bookmarked,
        &req.or_important,
        &req.or_with_coords,
        &Some(false),
        &req.filter_tags_option,
        &login,
        None,
    )?;
    if let Some(since_date_inclusive_ms) = req.since_date_inclusive_ms {
        q = q.filter(
            sigint_inbox_item::Column::Datetime
                .gte(dt_from_millis(since_date_inclusive_ms)?),
        );
    }
    if let Some(till_date_inclusive_ms) = req.till_date_inclusive_ms {
        q = q.filter(
            sigint_inbox_item::Column::Datetime
                .lte(dt_from_millis(till_date_inclusive_ms)?),
        );
    }
    let q = filter_selected_locations(
        q,
        &req.selected_locations,
        include_peleng_locations,
    )?;
    let q = filter_selected_aors(q, &req.selected_aors).context(h!())?;
    let q = q.order_by_desc(sigint_inbox_item::Column::Datetime);

    #[derive(FromQueryResult)]
    struct Row {
        comment: String,
        body: Option<String>,
        datetime: Option<NaiveDateTime>,
        freq: String,
        unit_name: String,
        network_id: i64,
        kind: Option<String>,
        location: Option<String>,
    }
    let rows = q.into_model::<Row>().all(&read_db).await.context(h!())?;

    let mut res_map = HashMap::new();
    for row in rows {
        let network_id = row.network_id;
        let unit_name = row.unit_name;
        let kind =
            display_network_type(row.kind.as_deref()).unwrap_or_default();
        let location = row.location;
        let message_report = NetworkMessagesReport {
            comment: row.comment.clone(),
            body: row.body.clone(),
            datetime: row.datetime,
            freq: row.freq.clone(),
        };
        let network_map = res_map.entry(network_id).or_insert((
            location,
            kind,
            HashMap::new(),
        ));
        let message_reports =
            network_map.2.entry(unit_name).or_insert(Vec::new());
        message_reports.push(message_report);
    }

    Ok(res_map)
}
