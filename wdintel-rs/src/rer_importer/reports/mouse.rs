use super::super::types::*;
use crate::entities::*;
use crate::error::AppError;
use crate::types::*;
use crate::utils::*;
use actix_identity::Identity;
use anyhow::Context; // Add this import if h!() uses anyhow::Context
use chrono::prelude::*;
use docx_rs::AlignmentType;
use docx_rs::LineSpacing;
use docx_rs::Paragraph;
use docx_rs::Run;
use docx_rs::Shading;
use docx_rs::Table;
use docx_rs::TableCell;
use docx_rs::TableRow;
use docx_rs::VAlignType;
use docx_rs::VMergeType;
use docx_rs::WidthType;
use geoconvert::{LatLon, Mgrs};
use sea_orm::*;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::path::PathBuf;

pub async fn report_docx_kind_mouse(
    user: Identity,
    env: &Env,
    req: &super::ReportPreviewReq,
    outpath: &PathBuf,
) -> Result<(), AppError> {
    let login = user.id()?;
    let logins = crate::users::get_organism_logins(&env.dbx, user).await?;
    let width_unit = 1870;
    let messages: Vec<(i64, InboxMessage)> =
        crate::rer_importer::inbox::get_inbox_messages(
            &login, &logins, &env, &req.req,
        )
        .await?;
    let Some(since_date_inclusive_ms) = req.req.since_date_inclusive_ms else {
        return Err("Since date must be specified".into());
    };
    let Some(till_date_inclusive_ms) = req.req.till_date_inclusive_ms else {
        return Err("Until date must be specified".into());
    };
    let date_from_dt = dt_zoned_from_millis(since_date_inclusive_ms)?;
    let date_to_dt = dt_zoned_from_millis(till_date_inclusive_ms)?;
    let date_to: String = dt_zoned_from_millis(till_date_inclusive_ms)?
        .format("%H:%M %d.%m.%Y")
        .to_string();

    let file = std::fs::File::create(outpath.clone())?;

    let mut per_tag_msgs: BTreeMap<i64, Vec<InboxMessage>> = BTreeMap::new();
    for (_message_id, message) in messages.iter() {
        let tags = message.tags.clone().unwrap_or(vec![]);
        if tags.is_empty() {
            per_tag_msgs
                .entry(0)
                .or_insert_with(|| vec![])
                .push(message.clone());
        } else {
            for tag_id in tags {
                per_tag_msgs
                    .entry(tag_id)
                    .or_insert_with(|| vec![])
                    .push(message.clone());
            }
        }
    }

    let uniq_freqs: BTreeSet<String> =
        BTreeSet::from_iter(messages.iter().map(|(_message_id, message)| {
            message.freq.clone().unwrap_or("".to_string())
        }));
    let network_count = uniq_freqs.len();
    let mut uniq_freqs_sorted: Vec<String> = uniq_freqs.into_iter().collect();
    uniq_freqs_sorted.sort();
    let mut per_freq_callsigns: BTreeMap<String, BTreeSet<String>> =
        BTreeMap::new();
    let mut per_freq_messages: BTreeMap<String, Vec<(i64, InboxMessage)>> =
        BTreeMap::new();
    let Some(zone_id) =
        crate::sigint::zone::get_user_zone_id(&env.dbx, &login).await?
    else {
        return Err("Zone not found 918273".into());
    };
    let comp_freqs = comp_freq::Entity::find()
        .filter(comp_freq::Column::ZoneId.eq(zone_id))
        .filter(comp_freq::Column::Freq.is_in(uniq_freqs_sorted.clone()))
        .all(&env.dbx)
        .await?;
    let freq_first_seen: BTreeMap<String, NaiveDateTime> = comp_freqs
        .iter()
        .filter_map(|comp_freq| {
            comp_freq
                .first_seen
                .clone()
                .map(|x| (comp_freq.freq.clone(), x))
        })
        .collect();
    let comp_freqs_callsigns = comp_freq_callsign::Entity::find()
        .filter(comp_freq_callsign::Column::ZoneId.eq(zone_id))
        .filter(
            comp_freq_callsign::Column::Freq.is_in(uniq_freqs_sorted.clone()),
        )
        .all(&env.dbx)
        .await?;
    let freq_callsign_first_seen: BTreeMap<(String, String), NaiveDateTime> =
        comp_freqs_callsigns
            .iter()
            .filter_map(|comp_freq_callsign| {
                comp_freq_callsign.first_seen.clone().map(|x| {
                    (
                        (
                            comp_freq_callsign.freq.clone(),
                            comp_freq_callsign.callsign.clone(),
                        ),
                        x,
                    )
                })
            })
            .collect();
    for (message_id, message) in messages.iter() {
        let freq = message.freq.clone().unwrap_or("".to_string());
        for callsign in message.callsigns.iter() {
            per_freq_callsigns
                .entry(freq.clone())
                .or_insert_with(|| BTreeSet::new())
                .insert(callsign.clone());
        }
        per_freq_messages
            .entry(freq.clone())
            .or_insert_with(|| vec![])
            .push((*message_id, message.clone()));
    }
    // fill per_freq_units_counted
    let mut per_freq_units_counted: BTreeMap<String, BTreeMap<String, i64>> =
        BTreeMap::new();
    for (_message_id, message) in messages.iter() {
        let Some(ref unit) = message.unit.as_ref() else {
            continue;
        };
        if unit.trim().is_empty() {
            continue;
        }
        let Some(freq) = message.freq.clone() else {
            continue;
        };
        if freq.is_empty() {
            continue;
        }
        per_freq_units_counted
            .entry(freq)
            .and_modify(|units_counted| {
                units_counted
                    .entry(unit.to_string())
                    .and_modify(|count| *count += 1)
                    .or_insert(1);
            })
            .or_insert_with(|| {
                let mut units_counted = BTreeMap::new();
                units_counted.insert(unit.to_string(), 1);
                units_counted
            });
    }

    let groups = crate::users::get_identity_sigint_groups(&env.dbx, &login)
        .await
        .context(h!())?;

    let importants = sigint_important::Entity::find()
        .filter(sigint_important::Column::UserId.eq(&login))
        .join(
            JoinType::InnerJoin,
            sigint_important::Relation::SignalMessage.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .filter(
            sigint_inbox_item::Column::Datetime.gte(date_from_dt.naive_utc()),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(sigint_inbox_item::Column::Datetime.lte(date_to_dt.naive_utc()))
        .filter(signal_message::Column::GroupMasterKey.is_in(&groups))
        .all(&env.dbx)
        .await?;
    let important_ids: BTreeSet<i64> = importants
        .iter()
        .map(|important| important.signal_message_id)
        .collect();

    let bookmarks = sigint_bookmark::Entity::find()
        .filter(sigint_bookmark::Column::UserId.eq(&login))
        .join(
            JoinType::InnerJoin,
            sigint_bookmark::Relation::SignalMessage.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .filter(
            sigint_inbox_item::Column::Datetime.gte(date_from_dt.naive_utc()),
        )
        .filter(sigint_inbox_item::Column::Datetime.lte(date_to_dt.naive_utc()))
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(signal_message::Column::GroupMasterKey.is_in(&groups))
        .all(&env.dbx)
        .await?;
    let bookmark_ids: BTreeSet<i64> = bookmarks
        .iter()
        .map(|bookmark| bookmark.signal_message_id)
        .collect();

    let mut rows: Vec<TableRow> = vec![];
    rows.push(TableRow::new(vec![
        TableCell::new()
            .width(width_unit * 2, WidthType::Dxa)
            .vertical_align(VAlignType::Center)
            .shading(Shading::new().fill("f2f2f2"))
            .vertical_merge(VMergeType::Restart)
            .add_paragraph(
                Paragraph::new()
                    .add_run(
                        Run::new()
                            .add_text("Назва радіомережі, робоча частота")
                            .bold(),
                    )
                    .line_spacing(LineSpacing::new().before(80).after(80))
                    .align(docx_rs::alignment_type::AlignmentType::Center),
            ),
        TableCell::new()
            .width(width_unit * 1, WidthType::Dxa)
            .vertical_align(VAlignType::Center)
            .shading(Shading::new().fill("f2f2f2"))
            .vertical_merge(VMergeType::Restart)
            .add_paragraph(
                Paragraph::new()
                    .add_run(
                        Run::new().add_text("Час роботи радіомережі").bold(),
                    )
                    .line_spacing(LineSpacing::new().before(80).after(80))
                    .align(docx_rs::alignment_type::AlignmentType::Center),
            ),
        TableCell::new()
            .width(width_unit * 7, WidthType::Dxa)
            .vertical_align(VAlignType::Center)
            .shading(Shading::new().fill("f2f2f2"))
            .grid_span(3)
            .add_paragraph(
                Paragraph::new()
                    .add_run(
                        Run::new()
                            .add_text("Склад кореспондентів радіомережі")
                            .bold(),
                    )
                    .line_spacing(LineSpacing::new().before(80).after(80))
                    .align(docx_rs::alignment_type::AlignmentType::Center),
            ),
        TableCell::new()
            .width(width_unit * 2, WidthType::Dxa)
            .vertical_align(VAlignType::Center)
            .shading(Shading::new().fill("f2f2f2"))
            .vertical_merge(VMergeType::Restart)
            .add_paragraph(
                Paragraph::new()
                    .add_run(Run::new().add_text("Характер радіообміну").bold())
                    .line_spacing(LineSpacing::new().before(80).after(80))
                    .align(docx_rs::alignment_type::AlignmentType::Center),
            ),
    ]));
    rows.push(TableRow::new(vec![
        TableCell::new()
            .vertical_align(VAlignType::Center)
            .shading(Shading::new().fill("f2f2f2"))
            .vertical_merge(VMergeType::Continue)
            .add_paragraph(Paragraph::new()),
        TableCell::new()
            .vertical_align(VAlignType::Center)
            .shading(Shading::new().fill("f2f2f2"))
            .vertical_merge(VMergeType::Continue)
            .add_paragraph(Paragraph::new()),
        TableCell::new()
            .vertical_align(VAlignType::Center)
            .width(width_unit * 6, WidthType::Dxa)
            .shading(Shading::new().fill("f2f2f2"))
            .grid_span(2)
            .add_paragraph(
                Paragraph::new()
                    .add_run(
                        Run::new()
                            .add_text("Позивні кореспондентів радіомережі та їх приналежність")
                            .bold(),
                    )
                    .align(docx_rs::alignment_type::AlignmentType::Center)
                    .line_spacing(LineSpacing::new().before(80).after(80)),
            ),
        TableCell::new()
            .vertical_align(VAlignType::Center)
            .width(width_unit * 1, WidthType::Dxa)
            .shading(Shading::new().fill("f2f2f2"))
            .add_paragraph(
                Paragraph::new()
                    .add_run(
                        Run::new()
                            .add_text("Відмічене вперше")
                            .bold(),
                    )
                    .align(docx_rs::alignment_type::AlignmentType::Center)
                    .line_spacing(LineSpacing::new().before(80).after(80)),
            ),
        TableCell::new()
            .vertical_align(VAlignType::Center)
            .shading(Shading::new().fill("f2f2f2"))
            .vertical_merge(VMergeType::Continue)
            .add_paragraph(Paragraph::new()),
    ]));

    for freq in uniq_freqs_sorted.iter() {
        if freq.trim().is_empty() {
            continue;
        }
        let Some(freq_msgs) = per_freq_messages.get(freq) else {
            continue;
        };
        let Some(earliest_msg) = freq_msgs.iter().min_by_key(|m| m.1.timestamp)
        else {
            continue;
        };
        let Some(earliest_timestamp) = earliest_msg.1.timestamp else {
            continue;
        };
        let Some(latest_msg) = freq_msgs.iter().max_by_key(|m| m.1.timestamp)
        else {
            continue;
        };
        let Some(latest_timestamp) = latest_msg.1.timestamp else {
            continue;
        };
        let time_from =
            dt_zoned_from_millis(earliest_timestamp)?.format("%H:%M:%S");
        let time_to =
            dt_zoned_from_millis(latest_timestamp)?.format("%H:%M:%S");
        let unit_with_max_count = match per_freq_units_counted.get(freq) {
            None => "УКХ НВ".to_string(),
            Some(units_with_count) => units_with_count
                .iter()
                .max_by_key(|(_, count)| *count)
                .map(|(unit, _)| unit.clone())
                .unwrap_or("УКХ НВ".to_string()),
        };
        rows.push(TableRow::new(vec![
            TableCell::new()
                .width(width_unit * 2, WidthType::Dxa)
                .vertical_merge(VMergeType::Restart)
                .add_paragraph(
                    Paragraph::new().add_run(
                        Run::new()
                            .add_text(format!(
                                "Радіомережа №{},",
                                freq.clone().replace(".", ",")
                            ))
                            .bold(),
                    ),
                )
                .add_paragraph(
                    Paragraph::new().add_run(
                        Run::new().add_text(unit_with_max_count.clone()),
                    ),
                )
                .add_paragraph(Paragraph::new().add_run(
                    Run::new().add_text(format!("Робочі частоти: {freq} МГц")),
                )),
            TableCell::new()
                .vertical_merge(VMergeType::Restart)
                .add_paragraph(
                    Paragraph::new()
                        .add_run(
                            Run::new()
                                .add_text(format!("{time_from}-{time_to}")),
                        )
                        .align(docx_rs::alignment_type::AlignmentType::Center),
                ),
            TableCell::new()
                .width(width_unit * 2, WidthType::Dxa)
                .add_paragraph(
                    Paragraph::new().add_run(Run::new().add_text("")),
                ),
            TableCell::new()
                .width(width_unit * 4, WidthType::Dxa)
                .add_paragraph(
                    Paragraph::new()
                        .add_run(Run::new().add_text("НВ".to_string())),
                ),
            TableCell::new()
                .width(width_unit * 1, WidthType::Dxa)
                .add_paragraph(
                    Paragraph::new().add_run(
                        Run::new().add_text(
                            freq_first_seen
                                .get(freq)
                                .map(|x| x.format("%d.%m.%Y").to_string())
                                .unwrap_or("".to_string()),
                        ),
                    ),
                ),
            TableCell::new()
                .add_paragraph(Paragraph::new().add_run(
                    Run::new().add_text("Ведення службового обміну."),
                )),
        ]));

        let empty = BTreeSet::new();
        let freq_callsigns: &BTreeSet<String> =
            per_freq_callsigns.get(freq).unwrap_or(&empty);
        for callsign in freq_callsigns {
            rows.push(TableRow::new(vec![
                TableCell::new()
                    .width(width_unit * 2, WidthType::Dxa)
                    .vertical_merge(VMergeType::Continue)
                    .add_paragraph(Paragraph::new().add_run(Run::new())),
                TableCell::new()
                    .vertical_merge(VMergeType::Continue)
                    .add_paragraph(Paragraph::new().add_run(Run::new())),
                TableCell::new()
                    .width(width_unit * 2, WidthType::Dxa)
                    .add_paragraph(Paragraph::new().add_run(
                        Run::new().add_text(callsign.clone().to_uppercase()),
                    )),
                TableCell::new()
                    .width(width_unit * 4, WidthType::Dxa)
                    .add_paragraph(
                        Paragraph::new()
                            .add_run(Run::new().add_text("НВ".to_string())),
                    ),
                TableCell::new()
                    .width(width_unit * 1, WidthType::Dxa)
                    .add_paragraph(
                        Paragraph::new().add_run(
                            Run::new().add_text(
                                freq_callsign_first_seen
                                    .get(&(
                                        freq.clone(),
                                        callsign.clone().to_lowercase(),
                                    ))
                                    .map(|x| x.format("%d.%m.%Y").to_string())
                                    .unwrap_or("".to_string()),
                            ),
                        ),
                    ),
                TableCell::new().add_paragraph(Paragraph::new().add_run(
                    Run::new().add_text("Ведення службового обміну."),
                )),
            ]));
        }
        rows.push(TableRow::new(vec![TableCell::new()
            .width(width_unit * 12, WidthType::Dxa)
            .grid_span(6)
            .add_paragraph(
                Paragraph::new().add_run(
                    Run::new()
                        .add_text("Особливості функціонування радіомережі:")
                        .bold(),
                ),
            )]));
        rows.push(TableRow::new(vec![TableCell::new()
            .width(width_unit * 12, WidthType::Dxa)
            .grid_span(6)
            .add_paragraph(
                Paragraph::new().add_run(
                    Run::new()
                        .add_text("Аналіз матеріалів радіоперехоплення, що вплинули на оцінку РЕО: ")
                        .bold(),
                ).add_run(Run::new().add_text("не відмічено")),
            )]));
    }
    let table = Table::new(rows).width(width_unit * 12, WidthType::Dxa);

    let mut rows2: Vec<TableRow> = vec![];
    rows2.push(TableRow::new(vec![
        TableCell::new()
            .width(width_unit * 1, WidthType::Dxa)
            .vertical_align(VAlignType::Center)
            .shading(Shading::new().fill("f2f2f2"))
            .add_paragraph(
                Paragraph::new()
                    .add_run(Run::new().add_text("Частота"))
                    .line_spacing(LineSpacing::new().before(80).after(80))
                    .align(docx_rs::alignment_type::AlignmentType::Center),
            ),
        TableCell::new()
            .width(width_unit * 1, WidthType::Dxa)
            .vertical_align(VAlignType::Center)
            .shading(Shading::new().fill("f2f2f2"))
            .add_paragraph(
                Paragraph::new()
                    .add_run(Run::new().add_text("Дата"))
                    .line_spacing(LineSpacing::new().before(80).after(80))
                    .align(docx_rs::alignment_type::AlignmentType::Center),
            ),
        TableCell::new()
            .width(width_unit * 1, WidthType::Dxa)
            .vertical_align(VAlignType::Center)
            .shading(Shading::new().fill("f2f2f2"))
            .add_paragraph(
                Paragraph::new()
                    .add_run(Run::new().add_text("Час перехоплення"))
                    .line_spacing(LineSpacing::new().before(80).after(80))
                    .align(docx_rs::alignment_type::AlignmentType::Center),
            ),
        TableCell::new()
            .width(width_unit * 1, WidthType::Dxa)
            .vertical_align(VAlignType::Center)
            .shading(Shading::new().fill("f2f2f2"))
            .add_paragraph(
                Paragraph::new()
                    .add_run(Run::new().add_text("Хто передає"))
                    .line_spacing(LineSpacing::new().before(80).after(80))
                    .align(docx_rs::alignment_type::AlignmentType::Center),
            ),
        TableCell::new()
            .width(width_unit * 1, WidthType::Dxa)
            .vertical_align(VAlignType::Center)
            .shading(Shading::new().fill("f2f2f2"))
            .add_paragraph(
                Paragraph::new()
                    .add_run(Run::new().add_text("Кому передає"))
                    .line_spacing(LineSpacing::new().before(80).after(80))
                    .align(docx_rs::alignment_type::AlignmentType::Center),
            ),
        TableCell::new()
            .width(width_unit * 6, WidthType::Dxa)
            .vertical_align(VAlignType::Center)
            .shading(Shading::new().fill("f2f2f2"))
            .add_paragraph(
                Paragraph::new()
                    .add_run(Run::new().add_text("Зміст радіообміну"))
                    .line_spacing(LineSpacing::new().before(80).after(80))
                    .align(docx_rs::alignment_type::AlignmentType::Center),
            ),
        TableCell::new()
            .width(width_unit * 1, WidthType::Dxa)
            .vertical_align(VAlignType::Center)
            .shading(Shading::new().fill("f2f2f2"))
            .add_paragraph(
                Paragraph::new()
                    .add_run(Run::new().add_text("Пеленг"))
                    .line_spacing(LineSpacing::new().before(80).after(80))
                    .align(docx_rs::alignment_type::AlignmentType::Center),
            ),
    ]));
    for freq in uniq_freqs_sorted.iter() {
        if freq.trim().is_empty() {
            continue;
        }
        let Some(freq_msgs) = per_freq_messages.get(freq) else {
            continue;
        };
        let mut freq_msgs = freq_msgs.clone();
        freq_msgs.sort_by(|a, b| a.1.timestamp.cmp(&b.1.timestamp));
        let unit_with_max_count = match per_freq_units_counted.get(freq) {
            None => "УКХ НВ".to_string(),
            Some(units_with_count) => units_with_count
                .iter()
                .max_by_key(|(_, count)| *count)
                .map(|(unit, _)| unit.clone())
                .unwrap_or("УКХ НВ".to_string()),
        };
        rows2.push(TableRow::new(vec![TableCell::new()
            .width(width_unit * 12, WidthType::Dxa)
            .vertical_align(VAlignType::Center)
            .grid_span(7)
            .add_paragraph(
                Paragraph::new()
                    .add_run(
                        Run::new()
                            .add_text(format!(
                                "Радіомережа №{}, ",
                                freq.clone().replace(".", ",")
                            ))
                            .bold(),
                    )
                    .add_run(Run::new().add_text(unit_with_max_count))
                    .add_run(
                        Run::new()
                            .add_text(format!(". Робочі частоти: {freq} МГц")),
                    )
                    .align(docx_rs::alignment_type::AlignmentType::Center),
            )]));
        for (message_id, message) in freq_msgs {
            let Some(freq) = message.freq.as_ref() else {
                continue;
            };
            let Some(timestamp) = message.timestamp.as_ref() else {
                continue;
            };
            let mut body_cell =
                TableCell::new().width(width_unit * 6, WidthType::Dxa);
            let Some(msg) = signal_message::Entity::find_by_id(message_id)
                .filter(signal_message::Column::Deleted.eq(false))
                .one(&env.dbx)
                .await?
            else {
                continue;
            };
            let Some(datasource_id) = msg.datasource_id else {
                continue;
            };
            let Some(inbox) = sigint_inbox_item::Entity::find_by_id(message_id)
                .one(&env.dbx)
                .await?
            else {
                continue;
            };
            let Some(datasource) =
                datasource::Entity::find_by_id(datasource_id)
                    .one(&env.dbx)
                    .await?
            else {
                continue;
            };
            let mut need_highlight = false;
            let tags: Vec<i64> = from_m_val_vec(inbox.tags.clone())?;
            if !tags.is_empty() {
                need_highlight = true;
            }
            if important_ids.contains(&message_id) {
                need_highlight = true;
            }
            if bookmark_ids.contains(&message_id) {
                need_highlight = true;
            }
            let m_comment = sigint_comment::Entity::find()
                .filter(sigint_comment::Column::SignalMessageId.eq(message_id))
                .filter(sigint_comment::Column::Login.is_in(logins.clone()))
                .one(&env.dbx)
                .await?;
            let mut full_text =
                message_full_text(&msg, &inbox, &datasource, &m_comment)?;
            if need_highlight {
                full_text = format!("⚠️ {}", full_text);
            }
            for line in full_text.lines() {
                body_cell = body_cell.add_paragraph(
                    Paragraph::new().add_run(Run::new().add_text(line)),
                );
            }
            rows2.push(TableRow::new(vec![
                TableCell::new()
                    .width(width_unit * 1, WidthType::Dxa)
                    .add_paragraph(
                        Paragraph::new()
                            .align(
                                docx_rs::alignment_type::AlignmentType::Center,
                            )
                            .add_run(Run::new().add_text(freq.clone())),
                    ),
                TableCell::new()
                    .width(width_unit * 1, WidthType::Dxa)
                    .add_paragraph(
                        Paragraph::new()
                            .align(
                                docx_rs::alignment_type::AlignmentType::Center,
                            )
                            .add_run(
                                Run::new().add_text(
                                    dt_zoned_from_millis(timestamp.clone())?
                                        .format("%d.%m.%Y")
                                        .to_string(),
                                ),
                            ),
                    ),
                TableCell::new()
                    .width(width_unit * 1, WidthType::Dxa)
                    .add_paragraph(
                        Paragraph::new()
                            .align(
                                docx_rs::alignment_type::AlignmentType::Center,
                            )
                            .add_run(
                                Run::new().add_text(
                                    dt_zoned_from_millis(timestamp.clone())?
                                        .format("%H:%M:%S")
                                        .to_string(),
                                ),
                            ),
                    ),
                TableCell::new()
                    .width(width_unit * 1, WidthType::Dxa)
                    .add_paragraph(
                        Paragraph::new().add_run(
                            Run::new().add_text(
                                message
                                    .callsigns
                                    .get(0)
                                    .unwrap_or(&"".to_string())
                                    .clone()
                                    .to_uppercase(),
                            ),
                        ),
                    ),
                TableCell::new()
                    .width(width_unit * 1, WidthType::Dxa)
                    .add_paragraph(
                        Paragraph::new().add_run(
                            Run::new().add_text(
                                message
                                    .callsigns
                                    .get(1)
                                    .unwrap_or(&"".to_string())
                                    .clone()
                                    .to_uppercase(),
                            ),
                        ),
                    ),
                body_cell,
                TableCell::new()
                    .width(width_unit * 1, WidthType::Dxa)
                    .add_paragraph(
                        Paragraph::new()
                            .align(AlignmentType::Center)
                            .add_run(Run::new().add_text("-".to_string())),
                    ),
            ]));
        }
    }
    let table2 = Table::new(rows2).width(width_unit * 12, WidthType::Dxa);

    let mut rows_amrp: Vec<TableRow> = vec![];
    // table: Дата, Час, Частота, WGS84, XY
    rows_amrp.push(TableRow::new(vec![
        TableCell::new()
            .vertical_align(VAlignType::Center)
            .shading(Shading::new().fill("f2f2f2"))
            .add_paragraph(
                Paragraph::new()
                    .add_run(Run::new().add_text("Дата"))
                    .line_spacing(LineSpacing::new().before(80).after(80))
                    .align(docx_rs::alignment_type::AlignmentType::Center),
            ),
        TableCell::new()
            .vertical_align(VAlignType::Center)
            .shading(Shading::new().fill("f2f2f2"))
            .add_paragraph(
                Paragraph::new()
                    .add_run(Run::new().add_text("Час"))
                    .line_spacing(LineSpacing::new().before(80).after(80))
                    .align(docx_rs::alignment_type::AlignmentType::Center),
            ),
        TableCell::new()
            .vertical_align(VAlignType::Center)
            .shading(Shading::new().fill("f2f2f2"))
            .add_paragraph(
                Paragraph::new()
                    .add_run(Run::new().add_text("Частота"))
                    .line_spacing(LineSpacing::new().before(80).after(80))
                    .align(docx_rs::alignment_type::AlignmentType::Center),
            ),
        TableCell::new()
            .vertical_align(VAlignType::Center)
            .shading(Shading::new().fill("f2f2f2"))
            .add_paragraph(
                Paragraph::new()
                    .add_run(Run::new().add_text("WGS84"))
                    .line_spacing(LineSpacing::new().before(80).after(80))
                    .align(docx_rs::alignment_type::AlignmentType::Center),
            ),
        TableCell::new()
            .vertical_align(VAlignType::Center)
            .shading(Shading::new().fill("f2f2f2"))
            .grid_span(2)
            .add_paragraph(
                Paragraph::new()
                    .add_run(Run::new().add_text("XY"))
                    .line_spacing(LineSpacing::new().before(80).after(80))
                    .align(docx_rs::alignment_type::AlignmentType::Center),
            ),
    ]));
    let mut messages_datetime_sorted = messages.clone();
    messages_datetime_sorted.sort_by(|a, b| {
        let dt_a = format!(
            "{}T{}",
            a.1.date.clone().unwrap_or("".to_string()),
            a.1.time.clone().unwrap_or("".to_string())
        );
        let dt_b = format!(
            "{}T{}",
            b.1.date.clone().unwrap_or("".to_string()),
            b.1.time.clone().unwrap_or("".to_string())
        );
        dt_a.cmp(&dt_b)
    });
    for (_message_id, message) in messages_datetime_sorted.iter() {
        let Some(coords) = message.coords.as_ref() else {
            continue;
        };
        if coords.is_empty() {
            continue;
        }
        let (lat, lon) = milgeo_rs::coordinates::parse_latlng_f64(coords)?;
        let Some(date) = message.date.as_ref() else {
            continue;
        };
        // parse date from format like 2023-12-22
        let date = NaiveDate::parse_from_str(date, "%Y-%m-%d")?;
        let Some(time) = message.time.as_ref() else {
            continue;
        };
        let Some(freq) = message.freq.as_ref() else {
            continue;
        };
        let usk2000 = milgeo_rs::coordinates::usk2000::wgs84_to_usk2000(
            milgeo_rs::coordinates::Wgs84 { lat, lng: lon },
        )?;
        rows_amrp.push(TableRow::new(vec![
            TableCell::new().add_paragraph(
                Paragraph::new()
                    .align(docx_rs::alignment_type::AlignmentType::Center)
                    .add_run(
                        Run::new()
                            .add_text(format!("{}", date.format("%d.%m"))),
                    ),
            ),
            TableCell::new().add_paragraph(
                Paragraph::new()
                    .align(docx_rs::alignment_type::AlignmentType::Center)
                    .add_run(Run::new().add_text(time.clone())),
            ),
            TableCell::new().add_paragraph(
                Paragraph::new()
                    .align(docx_rs::alignment_type::AlignmentType::Center)
                    .add_run(Run::new().add_text(freq.clone())),
            ),
            TableCell::new().add_paragraph(
                Paragraph::new()
                    .align(docx_rs::alignment_type::AlignmentType::Center)
                    .add_run(Run::new().add_text(format!("{}, {}", lat, lon))),
            ),
            TableCell::new().add_paragraph(
                Paragraph::new()
                    .align(docx_rs::alignment_type::AlignmentType::Center)
                    .add_run(
                        Run::new()
                            .add_text(format!("{} {}", usk2000.x, usk2000.y)),
                    ),
            ),
        ]));
    }
    let table_amrp =
        Table::new(rows_amrp).width(width_unit * 12, WidthType::Dxa);

    let mut docx = docx_rs::Docx::new()
        .page_orient(docx_rs::page_orientation_type::PageOrientationType::Landscape)
        .page_size(11906 * 2, 16838)
        .default_size(28)
        .page_margin(
            docx_rs::page_margin::PageMargin::new()
                .left(600)
                .right(300)
                .top(1200)
            )
        .add_paragraph(
            Paragraph::new()
                .add_run(
                    Run::new()
                        .size(32)
                        .add_text("РОЗВІДУВАЛЬНЕ ЗВЕДЕННЯ")
                        .bold(),
                )
                .align(docx_rs::alignment_type::AlignmentType::Center),
        )
        .add_paragraph(
            Paragraph::new()
            .add_run(
                Run::new()
                .add_text("Зведеного підрозділу ТЗР щодо змін у радіоелектронній обстановці")
            )
            .align(docx_rs::alignment_type::AlignmentType::Center)
        )
        .add_paragraph(
            Paragraph::new()
                .add_run(
                    Run::new()
                        .add_text(format!("станом на {date_to} року")))
                .align(docx_rs::alignment_type::AlignmentType::Center)
        )
        .add_paragraph(Paragraph::new())
        .add_paragraph(
            Paragraph::new()
                .add_run(
                    Run::new()
                        .add_text(format!("1. Кількість радіомереж (радіонапрямків), які відмічались: {network_count}")))
        )
        .add_paragraph(Paragraph::new())
        .add_paragraph(
            Paragraph::new()
                .add_run(
                    Run::new()
                        .add_text("2. Опис радіомереж:"))
        )
        .add_paragraph(Paragraph::new())
        .add_table(table)
        .add_paragraph(Paragraph::new())
        .add_paragraph(Paragraph::new().add_run(Run::new().add_text("3. Висновки з оцінки РЕО: ").bold()));

    for freq in uniq_freqs_sorted.iter() {
        if freq.trim().is_empty() {
            continue;
        }
        let Some(freq_msgs) = per_freq_messages.get(freq) else {
            continue;
        };
        let mut freq_msgs = freq_msgs.clone();
        freq_msgs.sort_by(|a, b| a.1.timestamp.cmp(&b.1.timestamp));
        for (message_id, message) in freq_msgs {
            let Some(freq) = message.freq.as_ref() else {
                continue;
            };
            let Some(timestamp) = message.timestamp.as_ref() else {
                continue;
            };
            // let Some(msg) = signal_message::Entity::find_by_id(message_id)
            //     .one(&env.dbx)
            //     .await?
            // else {
            //     continue;
            // };
            let Some(_inbox) =
                sigint_inbox_item::Entity::find_by_id(message_id)
                    .one(&env.dbx)
                    .await?
            else {
                continue;
            };
            let m_comment = sigint_comment::Entity::find()
                .filter(sigint_comment::Column::SignalMessageId.eq(message_id))
                .filter(sigint_comment::Column::Login.is_in(logins.clone()))
                .one(&env.dbx)
                .await?;
            if let Some(extended_form) = m_comment.map(|x| x.comment) {
                let paragraph =
                    Paragraph::new().add_run(Run::new().add_text(format!(
                        "- {date} {time}: {freq} {extended_form}",
                        date = dt_zoned_from_millis(timestamp.clone())?
                            .format("%d.%m.%Y")
                            .to_string(),
                        time = dt_zoned_from_millis(timestamp.clone())?
                            .format("%H:%M:%S")
                            .to_string(),
                        extended_form = extended_form
                    )));
                docx = docx.add_paragraph(paragraph);
            }
        }
    }

    docx.add_paragraph(Paragraph::new())
        .add_paragraph(
            Paragraph::new()
                .add_run(Run::new().add_text("З АМРП встановлено:").bold()),
        )
        .add_paragraph(Paragraph::new().add_run(Run::new().add_text("")))
        .add_table(table_amrp)
        .add_paragraph(Paragraph::new())
        .add_paragraph(
            Paragraph::new().add_run(
                Run::new()
                    .add_text(
                        "Додаток з оригіналами матеріалів радіоперехоплення",
                    )
                    .bold(),
            ),
        )
        .add_paragraph(Paragraph::new())
        .add_table(table2)
        .add_paragraph(Paragraph::new())
        .add_paragraph(
            Paragraph::new().add_run(
                Run::new()
                    .add_text("Статистика функціонування радіомереж")
                    .bold(),
            ),
        )
        .add_paragraph(Paragraph::new())
        .add_paragraph(
            Paragraph::new().add_run(
                Run::new().add_text(
                    uniq_freqs_sorted
                        .iter()
                        .map(|x| x.replace(".", ","))
                        .collect::<Vec<String>>()
                        .join(", "),
                ),
            ),
        )
        .add_paragraph(Paragraph::new())
        .add_paragraph(
            Paragraph::new()
                .add_run(Run::new().add_text("Командир зведеного взводу ТЗР")),
        )
        .add_paragraph(Paragraph::new())
        .build()
        .pack(file)
        .context(h!())?;
    Ok(())
}

pub async fn report_xlsx_kind_pelengs1(
    user: Identity,
    env: &Env,
    req: &super::ReportPreviewReq,
    outpath: &PathBuf,
) -> Result<(), AppError> {
    info!("[report_xlsx_kind_pelengs1] started");
    let mut workbook = rust_xlsxwriter::Workbook::new(); // Use rust_xlsxwriter
    let sheet1 = workbook.add_worksheet().set_name("Пеленги").context(h!())?; // Use rust_xlsxwriter
    let coltitle = xls_title();

    let till: DateTime<Utc> = chrono::Utc
        .timestamp_millis_opt(req.req.till_date_inclusive_ms.unwrap_or(0))
        .single()
        .unwrap();
    let since: DateTime<Utc> = chrono::Utc
        .timestamp_millis_opt(req.req.since_date_inclusive_ms.unwrap_or(0))
        .single()
        .unwrap();

    let tz = crate::config::get_tz();
    let since_tz = since.with_timezone(&tz);
    let till_tz = till.with_timezone(&tz);

    sheet1.merge_range(
        0,
        0,
        0,
        7,
        &format!("Розвідувальне донесення з результатів пеленгації за період {} - {}", since_tz.format("%d.%m.%y %H:%M"), till_tz.format("%d.%m.%y %H:%M")),
        &coltitle,
    ).context(h!())?;

    sheet1
        .write_string_with_format(1, 0, "№", &coltitle)
        .context(h!())?;
    sheet1.set_column_width(0, 4.0).context(h!())?;
    sheet1
        .write_string_with_format(1, 1, "Назва р/м", &coltitle)
        .context(h!())?;
    sheet1.set_column_width(1, 40.0).context(h!())?;
    sheet1
        .write_string_with_format(1, 2, "Частота", &coltitle)
        .context(h!())?;
    sheet1.set_column_width(2, 10.0).context(h!())?;
    sheet1
        .write_string_with_format(1, 3, "Час", &coltitle)
        .context(h!())?;
    sheet1.set_column_width(3, 14.0).context(h!())?;
    sheet1
        .write_string_with_format(1, 4, "Позивний/приналежність", &coltitle)
        .context(h!())?;
    sheet1.set_column_width(4, 30.0).context(h!())?;
    sheet1
        .write_string_with_format(1, 5, "Район", &coltitle)
        .context(h!())?;
    sheet1.set_column_width(5, 30.0).context(h!())?;
    sheet1
        .write_string_with_format(1, 6, "XY", &coltitle)
        .context(h!())?;
    sheet1.set_column_width(6, 18.0).context(h!())?;
    sheet1
        .write_string_with_format(1, 7, "WSG", &coltitle)
        .context(h!())?;
    sheet1.set_column_width(7, 20.0).context(h!())?;
    sheet1
        .write_string_with_format(1, 8, "MGRS", &coltitle)
        .context(h!())?;
    sheet1.set_column_width(8, 18.0).context(h!())?;

    info!("[report_xlsx_kind_pelengs1] {}: querying data", Utc::now());
    let mut i = 1;
    let messages: Vec<(i64, Option<(f64, f64)>, InboxMessage)> =
        crate::rer_importer::reports::report_xlsx_kind_pelengs::get_inbox_messages_report(&user, &env, &req.req).await?;
    info!("[report_xlsx_kind_pelengs1] {}: query done", Utc::now());
    for (_, m_coords, m) in messages.iter() {
        let Some(coords) = m.coords.as_ref() else {
            continue;
        };
        if coords.is_empty() {
            continue;
        }
        let Some((lat, lng)) = m_coords.clone() else {
            continue;
        };
        let Some(date) = m.date.as_ref() else {
            continue;
        };
        // parse date from format like 2023-12-22
        let date = NaiveDate::parse_from_str(date, "%Y-%m-%d")?;
        let Some(time) = m.time.as_ref() else {
            continue;
        };
        let Some(freq) = m.freq.as_ref() else {
            continue;
        };

        i += 1;

        let usk2000 = &milgeo_rs::coordinates::usk2000::wgs84_to_usk2000(
            milgeo_rs::coordinates::Wgs84 { lat, lng },
        )?;

        sheet1.write_number(i, 0, (i - 1) as f64).context(h!())?;
        sheet1
            .write_string(i, 1, &m.unit.clone().unwrap_or("НВ".to_string()))
            .context(h!())?;
        sheet1.write_string(i, 2, freq).context(h!())?;
        sheet1
            .write_string(
                i,
                3,
                &format!("{}, {}", &time, &date.format("%d.%m.%y")),
            )
            .context(h!())?;
        sheet1
            .write_string(i, 4, &m.callsigns.join(", "))
            .context(h!())?;
        sheet1
            .write_string(i, 5, &m.location.clone().unwrap_or("".to_string()))
            .context(h!())?;
        sheet1
            .write_string(i, 6, &format!("{} {}", usk2000.x, usk2000.y))
            .context(h!())?;
        sheet1
            .write_string(i, 7, &format!("{} {}", lat, lng))
            .context(h!())?;
        sheet1
            .write_string(
                i,
                8,
                &Mgrs::from_latlon(&LatLon::create(lat, lng).unwrap(), 5)
                    .to_string(),
            )
            .context(h!())?;
    }

    workbook.save(outpath).context(h!())?;
    info!("[report_xlsx_kind_pelengs1] {}: completed", Utc::now());
    Ok(())
}

fn xls_title() -> rust_xlsxwriter::Format {
    rust_xlsxwriter::Format::new()
        .set_bold()
        .set_border(rust_xlsxwriter::FormatBorder::Thin)
        .set_align(rust_xlsxwriter::FormatAlign::Center)
        .set_font_size(12.0)
}

// report_xlsx_kind_pelengs
pub async fn report_xlsx_kind_pelengs(
    user: Identity,
    env: &Env,
    req: &super::ReportPreviewReq,
    _outpath: &PathBuf, // Marked as unused
) -> Result<(), AppError> {
    let login = user.id()?;
    let logins = crate::users::get_organism_logins(&env.dbx, user).await?;
    let messages: Vec<(i64, InboxMessage)> =
        crate::rer_importer::inbox::get_inbox_messages(
            &login, &logins, &env, &req.req,
        )
        .await?;
    let messages: Vec<(i64, InboxMessage)> = messages
        .iter()
        .filter(|(_, m)| m.coords.is_some())
        .cloned()
        .collect();

    let mut workbook = rust_xlsxwriter::Workbook::new(); // Use rust_xlsxwriter

    let mut messages_datetime_sorted = messages.clone();
    messages_datetime_sorted.sort_by(|a, b| {
        let dt_a = format!(
            "{}T{}",
            a.1.date.clone().unwrap_or("".to_string()),
            a.1.time.clone().unwrap_or("".to_string())
        );
        let dt_b = format!(
            "{}T{}",
            b.1.date.clone().unwrap_or("".to_string()),
            b.1.time.clone().unwrap_or("".to_string())
        );
        dt_a.cmp(&dt_b)
    });

    let coltitle = rust_xlsxwriter::Format::new() // Removed mut
        .set_bold() // Chained methods
        .set_align(rust_xlsxwriter::FormatAlign::Center)
        .set_font_size(12.0);

    let sheet1 = workbook.add_worksheet().set_name("Пеленги").context(h!())?; // Use rust_xlsxwriter
    sheet1
        .write_string_with_format(0, 0, "№", &coltitle)
        .context(h!())?;
    sheet1.set_column_width(0, 4.0).context(h!())?;
    sheet1
        .write_string_with_format(0, 1, "ДАТА", &coltitle)
        .context(h!())?;
    sheet1.set_column_width(1, 8.0).context(h!())?;
    sheet1
        .write_string_with_format(0, 2, "ЧАС", &coltitle)
        .context(h!())?;
    sheet1
        .write_string_with_format(0, 3, "ЧАСТОТА", &coltitle)
        .context(h!())?;
    sheet1.set_column_width(3, 10.0).context(h!())?;
    sheet1
        .write_string_with_format(0, 4, "WGS84", &coltitle)
        .context(h!())?;
    sheet1.set_column_width(4, 20.0).context(h!())?;
    sheet1
        .write_string_with_format(0, 5, "XY", &coltitle)
        .context(h!())?;
    sheet1.set_column_width(5, 16.0).context(h!())?;

    for (i, (_message_id, message)) in
        messages_datetime_sorted.iter().enumerate()
    {
        let Some(coords) = message.coords.as_ref() else {
            continue;
        };
        if coords.is_empty() {
            continue;
        }
        let (lat, lon) = milgeo_rs::coordinates::parse_latlng_f64(coords)?;
        let Some(date) = message.date.as_ref() else {
            continue;
        };
        // parse date from format like 2023-12-22
        let date = NaiveDate::parse_from_str(date, "%Y-%m-%d")?;
        let Some(time) = message.time.as_ref() else {
            continue;
        };
        let Some(freq) = message.freq.as_ref() else {
            continue;
        };
        let usk2000 = milgeo_rs::coordinates::usk2000::wgs84_to_usk2000(
            milgeo_rs::coordinates::Wgs84 { lat, lng: lon },
        )?;

        sheet1
            .write_number(i as u32 + 1, 0, i as f64 + 1.0)
            .context(h!())?;
        sheet1
            .write_string(i as u32 + 1, 1, &format!("{}", date.format("%d.%m")))
            .context(h!())?;
        sheet1
            .write_string(i as u32 + 1, 2, &time.clone())
            .context(h!())?;
        sheet1
            .write_string(i as u32 + 1, 3, &freq.clone())
            .context(h!())?;
        sheet1
            .write_string(i as u32 + 1, 4, &format!("{}, {}", lat, lon))
            .context(h!())?;
        sheet1
            .write_string(
                i as u32 + 1,
                5,
                &format!("{} {}", usk2000.x, usk2000.y),
            )
            .context(h!())?;
    }

    workbook.save(_outpath).context(h!())?; // Save the workbook
    Ok(())
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
