use crate::entities::*;
use crate::error::AppError;
use crate::rer_importer::report_chunking::{
    build_filtered_inbox_report_chunk_query, inbox_report_chunk_req,
    inbox_report_period_chunks, ReportPeriodEnd,
};
use crate::rer_importer::reports::types::TagReportSortBy;
use crate::types::*;
use crate::utils::*;
use docx_rs::AlignmentType;
use docx_rs::LineSpacing;
use docx_rs::Paragraph;
use docx_rs::Run;
use docx_rs::Style;
use docx_rs::StyleType;
use sea_orm::*;
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

pub async fn report_docx_kind_tag(
    user_login: &uuid::Uuid,
    env: &Env,
    req: &super::types::ReportPreviewReq,
    outpath: &PathBuf,
) -> Result<(), AppError> {
    let mut current_req = req.req.clone();
    current_req.report_tags_only_this_unit = req.report_tags_only_this_unit;
    let tag_report_sort_by = req.tag_report_sort_by.unwrap_or_default();
    let login = *user_login;
    let period = tag_report_period(&current_req)?;
    let read_db = env.replica();
    let data = load_tag_report_data(
        &read_db,
        &login,
        env,
        &current_req,
        tag_report_sort_by,
    )
    .await
    .context(h!())?;

    write_tag_report_docx(outpath, &period, data).context(h!())?;
    Ok(())
}

struct TagReportPeriod {
    date_from: String,
    date_to: String,
}

struct TagReportData {
    messages: Vec<TagReportMessage>,
}

struct TagReportSnapshot {
    important_ids: BTreeSet<i64>,
    candidates: Vec<TagReportMessageCandidate>,
    signal_messages: BTreeMap<i64, TagReportSignalMessage>,
    inbox_items: BTreeMap<i64, TagReportInboxItem>,
    datasources: BTreeMap<i64, TagReportDatasource>,
    report_comments: BTreeMap<i64, String>,
    own_comments: BTreeMap<i64, String>,
}

struct TagReportMessage {
    message_id: i64,
    freq: Option<String>,
    datetime: Option<chrono::NaiveDateTime>,
    created_at: Option<chrono::NaiveDateTime>,
    full_text: String,
    report_comment: Option<String>,
    has_own_comment: bool,
    is_important: bool,
}

#[derive(FromQueryResult)]
struct TagReportMessageCandidate {
    id: i64,
    freq: Option<String>,
    datetime: Option<chrono::NaiveDateTime>,
    created_at: Option<chrono::NaiveDateTime>,
}

#[derive(FromQueryResult)]
struct TagReportSignalMessage {
    id: i64,
    body: Option<String>,
    datasource_id: i64,
}

#[derive(FromQueryResult)]
struct TagReportInboxItem {
    id: i64,
    date: Option<String>,
    time: Option<String>,
    freq: Option<String>,
    unit: Option<String>,
    location: Option<String>,
}

#[derive(FromQueryResult)]
struct TagReportDatasource {
    id: i64,
    kind: String,
}

fn tag_report_period(
    req: &crate::rer_importer::types::InboxMessagesReq,
) -> Result<TagReportPeriod, AppError> {
    let Some(since_date_inclusive_ms) = req.since_date_inclusive_ms else {
        return Err("Since date must be specified".into());
    };
    let Some(till_date_inclusive_ms) = req.till_date_inclusive_ms else {
        return Err("Until date must be specified".into());
    };
    let date_from_dt =
        dt_zoned_from_millis(since_date_inclusive_ms).context(h!())?;
    let date_to_dt =
        dt_zoned_from_millis(till_date_inclusive_ms).context(h!())?;
    Ok(TagReportPeriod {
        date_from: date_from_dt.format("%H:%M %d.%m.%Y").to_string(),
        date_to: date_to_dt.format("%H:%M %d.%m.%Y").to_string(),
    })
}

async fn load_tag_report_data(
    read_db: &DatabaseConnection,
    login: &uuid::Uuid,
    env: &Env,
    req: &crate::rer_importer::types::InboxMessagesReq,
    tag_report_sort_by: TagReportSortBy,
) -> Result<TagReportData, AppError> {
    let creation_time_sorting = req.sort_by
        == Some(crate::rer_importer::types::InboxMessagesSortBy::IMSCreatedAt);
    let report_settings =
        crate::system_settings::get_report_generation_settings(&env.dbx)
            .await
            .c(h!())?;
    let chunks =
        inbox_report_period_chunks(req, report_settings.chunking_hours)
            .context(h!())?;
    let mut messages_by_id = BTreeMap::new();
    for (index, chunk) in chunks.iter().copied().enumerate() {
        info!(
            "Tag report chunk {}/{}: {}..{} ({:?})",
            index + 1,
            chunks.len(),
            chunk.since_ms,
            chunk.till_ms,
            chunk.end
        );
        let chunk_req = inbox_report_chunk_req(req, chunk);
        let txn = read_db
            .begin_with_config(
                Some(IsolationLevel::RepeatableRead),
                Some(AccessMode::ReadOnly),
            )
            .await
            .context(h!())?;
        let snapshot = load_tag_report_snapshot_txn(
            &txn, login, env, &chunk_req, chunk.end,
        )
        .await
        .context(h!())?;
        txn.commit().await.context(h!())?;
        let chunk_data = collect_tag_report_data(
            &chunk_req,
            tag_report_sort_by,
            creation_time_sorting,
            snapshot,
        )
        .context(h!())?;
        for message in chunk_data.messages {
            messages_by_id.entry(message.message_id).or_insert(message);
        }
        crate::report_history::ensure_report_record_count(messages_by_id.len())
            .context(h!())?;
    }
    let mut messages = messages_by_id.into_values().collect::<Vec<_>>();
    // Chunk aggregation rebuilds this list by message ID, so use the request basis again.
    sort_tag_report_messages(
        &mut messages,
        tag_report_sort_by,
        creation_time_sorting,
    );
    Ok(TagReportData { messages })
}

async fn load_tag_report_snapshot_txn(
    txn: &DatabaseTransaction,
    login: &uuid::Uuid,
    env: &Env,
    req: &crate::rer_importer::types::InboxMessagesReq,
    period_end: ReportPeriodEnd,
) -> Result<TagReportSnapshot, AppError> {
    let login_ids = crate::users::get_organism_login_ids_by_id(txn, login)
        .await
        .c(h!())?;
    let candidates =
        load_tag_report_candidates(txn, login, env, req, period_end)
            .await
            .context(h!())?;
    let message_ids: Vec<i64> =
        candidates.iter().map(|message| message.id).collect();
    let important_ids =
        load_tag_report_important_ids(txn, login, &login_ids, &message_ids)
            .await
            .context(h!())?;
    let signal_messages = load_tag_report_signal_messages(txn, &message_ids)
        .await
        .context(h!())?;
    let inbox_items = load_tag_report_inbox_items(txn, &message_ids)
        .await
        .context(h!())?;
    let datasources =
        load_tag_report_datasources(txn, signal_messages.values())
            .await
            .context(h!())?;
    let own_comments =
        load_tag_report_comments(txn, &message_ids, Some(&login_ids))
            .await
            .context(h!())?;
    let report_comments = if req.report_tags_only_this_unit.is_some() {
        own_comments.clone()
    } else {
        load_tag_report_comments(txn, &message_ids, None)
            .await
            .context(h!())?
    };
    Ok(TagReportSnapshot {
        important_ids,
        candidates,
        signal_messages,
        inbox_items,
        datasources,
        report_comments,
        own_comments,
    })
}

fn collect_tag_report_data(
    req: &crate::rer_importer::types::InboxMessagesReq,
    tag_report_sort_by: TagReportSortBy,
    creation_time_sorting: bool,
    snapshot: TagReportSnapshot,
) -> Result<TagReportData, AppError> {
    let mut candidates = snapshot.candidates;
    sort_tag_report_candidates(
        &mut candidates,
        tag_report_sort_by,
        creation_time_sorting,
    );
    let messages = collect_tag_report_messages(
        req,
        candidates,
        snapshot.signal_messages,
        snapshot.inbox_items,
        snapshot.datasources,
        snapshot.report_comments,
        snapshot.own_comments,
        snapshot.important_ids,
    )
    .context(h!())?;
    Ok(TagReportData { messages })
}

async fn load_tag_report_candidates(
    txn: &DatabaseTransaction,
    login: &uuid::Uuid,
    env: &Env,
    req: &crate::rer_importer::types::InboxMessagesReq,
    period_end: ReportPeriodEnd,
) -> Result<Vec<TagReportMessageCandidate>, AppError> {
    let messages = build_filtered_inbox_report_chunk_query(
        txn, login, env, req, period_end,
    )
    .await
    .context(h!())?
    .select_only()
    .column_as(signal_message::Column::Id, "id")
    .column_as(sigint_inbox_item::Column::Freq, "freq")
    .column_as(sigint_inbox_item::Column::Datetime, "datetime")
    .column_as(signal_message::Column::CreatedAt, "created_at")
    .into_model::<TagReportMessageCandidate>()
    .all(txn)
    .await
    .context(h!())?;
    Ok(messages)
}

fn sort_tag_report_messages(
    messages: &mut [TagReportMessage],
    tag_report_sort_by: TagReportSortBy,
    creation_time_sorting: bool,
) {
    messages.sort_by(|left, right| match tag_report_sort_by {
        TagReportSortBy::ByTime => {
            tag_report_message_time_order(left, right, creation_time_sorting)
        }
        TagReportSortBy::ByFreqThenTime => left
            .freq
            .as_deref()
            .unwrap_or("")
            .cmp(right.freq.as_deref().unwrap_or(""))
            .then_with(|| {
                tag_report_message_time_order(
                    left,
                    right,
                    creation_time_sorting,
                )
            }),
    });
}

fn tag_report_message_time_order(
    left: &TagReportMessage,
    right: &TagReportMessage,
    creation_time_sorting: bool,
) -> std::cmp::Ordering {
    tag_report_time_order(
        if creation_time_sorting {
            left.created_at
        } else {
            left.datetime
        },
        left.message_id,
        if creation_time_sorting {
            right.created_at
        } else {
            right.datetime
        },
        right.message_id,
    )
}

fn sort_tag_report_candidates(
    messages: &mut [TagReportMessageCandidate],
    tag_report_sort_by: TagReportSortBy,
    creation_time_sorting: bool,
) {
    messages.sort_by(|left, right| match tag_report_sort_by {
        TagReportSortBy::ByTime => {
            tag_report_candidate_time_order(left, right, creation_time_sorting)
        }
        TagReportSortBy::ByFreqThenTime => left
            .freq
            .as_deref()
            .unwrap_or("")
            .cmp(right.freq.as_deref().unwrap_or(""))
            .then_with(|| {
                tag_report_candidate_time_order(
                    left,
                    right,
                    creation_time_sorting,
                )
            }),
    });
}

fn tag_report_candidate_time_order(
    left: &TagReportMessageCandidate,
    right: &TagReportMessageCandidate,
    creation_time_sorting: bool,
) -> std::cmp::Ordering {
    tag_report_time_order(
        if creation_time_sorting {
            left.created_at
        } else {
            left.datetime
        },
        left.id,
        if creation_time_sorting {
            right.created_at
        } else {
            right.datetime
        },
        right.id,
    )
}

fn tag_report_time_order(
    left_time: Option<chrono::NaiveDateTime>,
    left_id: i64,
    right_time: Option<chrono::NaiveDateTime>,
    right_id: i64,
) -> std::cmp::Ordering {
    (left_time, left_id).cmp(&(right_time, right_id))
}

async fn load_tag_report_important_ids(
    txn: &DatabaseTransaction,
    login: &uuid::Uuid,
    logins: &[uuid::Uuid],
    message_ids: &[i64],
) -> Result<BTreeSet<i64>, AppError> {
    if message_ids.is_empty() {
        return Ok(BTreeSet::new());
    }
    let sigint_groups =
        crate::messenger::group::get_identity_sigint_groups(txn, login)
            .await
            .context(h!())?;
    let importants = sigint_important::Entity::find()
        .filter(sigint_important::Column::LoginId.eq_any(logins.to_vec()))
        .filter(
            sigint_important::Column::SignalMessageId
                .eq_any(message_ids.to_vec()),
        )
        .join(
            JoinType::InnerJoin,
            sigint_important::Relation::SignalMessage.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::DatasourceGroup.def(),
        )
        .filter(datasource_group::Column::GroupMasterKey.eq_any(sigint_groups))
        .filter(signal_message::Column::Deleted.eq(false))
        .all(txn)
        .await
        .context(h!())?;
    Ok(importants
        .into_iter()
        .map(|important| important.signal_message_id)
        .collect())
}

async fn load_tag_report_signal_messages(
    txn: &DatabaseTransaction,
    message_ids: &[i64],
) -> Result<BTreeMap<i64, TagReportSignalMessage>, AppError> {
    if message_ids.is_empty() {
        return Ok(BTreeMap::new());
    }
    let messages = signal_message::Entity::find()
        .filter(signal_message::Column::Id.eq_any(message_ids.to_vec()))
        .filter(signal_message::Column::Deleted.eq(false))
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::DatasourceGroup.def(),
        )
        .select_only()
        .column(signal_message::Column::Id)
        .column(signal_message::Column::Body)
        .column_as(datasource_group::Column::DatasourceId, "datasource_id")
        .into_model::<TagReportSignalMessage>()
        .all(txn)
        .await
        .context(h!())?;
    Ok(messages
        .into_iter()
        .map(|message| (message.id, message))
        .collect())
}

async fn load_tag_report_inbox_items(
    txn: &DatabaseTransaction,
    message_ids: &[i64],
) -> Result<BTreeMap<i64, TagReportInboxItem>, AppError> {
    if message_ids.is_empty() {
        return Ok(BTreeMap::new());
    }
    Ok(sigint_inbox_item::Entity::find()
        .filter(sigint_inbox_item::Column::Id.eq_any(message_ids.to_vec()))
        .select_only()
        .column(sigint_inbox_item::Column::Id)
        .column(sigint_inbox_item::Column::Date)
        .column(sigint_inbox_item::Column::Time)
        .column(sigint_inbox_item::Column::Freq)
        .column(sigint_inbox_item::Column::Unit)
        .column(sigint_inbox_item::Column::Location)
        .into_model::<TagReportInboxItem>()
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .map(|inbox| (inbox.id, inbox))
        .collect())
}

async fn load_tag_report_datasources<'a>(
    txn: &DatabaseTransaction,
    messages: impl Iterator<Item = &'a TagReportSignalMessage>,
) -> Result<BTreeMap<i64, TagReportDatasource>, AppError> {
    let datasource_ids: BTreeSet<i64> =
        messages.map(|message| message.datasource_id).collect();
    if datasource_ids.is_empty() {
        return Ok(BTreeMap::new());
    }
    Ok(datasource::Entity::find()
        .filter(
            datasource::Column::Id
                .eq_any(datasource_ids.into_iter().collect::<Vec<_>>()),
        )
        .select_only()
        .column(datasource::Column::Id)
        .column(datasource::Column::Kind)
        .into_model::<TagReportDatasource>()
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .map(|datasource| (datasource.id, datasource))
        .collect())
}

async fn load_tag_report_comments(
    txn: &DatabaseTransaction,
    message_ids: &[i64],
    logins: Option<&[uuid::Uuid]>,
) -> Result<BTreeMap<i64, String>, AppError> {
    if message_ids.is_empty() {
        return Ok(BTreeMap::new());
    }
    let comments =
        crate::sigint::comments::find_report_comments(txn, message_ids, logins)
            .await
            .context(h!())?;
    let mut comments_by_message = BTreeMap::new();
    for comment in comments {
        comments_by_message
            .entry(comment.source_message_id)
            .or_insert(comment.comment);
    }
    Ok(comments_by_message)
}

fn collect_tag_report_messages(
    req: &crate::rer_importer::types::InboxMessagesReq,
    candidates: Vec<TagReportMessageCandidate>,
    mut signal_messages: BTreeMap<i64, TagReportSignalMessage>,
    mut inbox_items: BTreeMap<i64, TagReportInboxItem>,
    datasources: BTreeMap<i64, TagReportDatasource>,
    mut report_comments: BTreeMap<i64, String>,
    own_comments: BTreeMap<i64, String>,
    important_ids: BTreeSet<i64>,
) -> Result<Vec<TagReportMessage>, AppError> {
    let mut messages = vec![];
    for candidate in candidates {
        if req.report_tags_only_this_unit == Some(true)
            && !own_comments.contains_key(&candidate.id)
        {
            continue;
        }
        let Some(signal_message) = signal_messages.remove(&candidate.id) else {
            continue;
        };
        let Some(inbox) = inbox_items.remove(&candidate.id) else {
            continue;
        };
        let Some(datasource) = datasources.get(&signal_message.datasource_id)
        else {
            continue;
        };
        let full_text = message_full_text_nocomments(
            signal_message.body,
            &inbox,
            &datasource.kind,
        )
        .context(h!())?;
        messages.push(TagReportMessage {
            message_id: candidate.id,
            freq: candidate.freq,
            datetime: candidate.datetime,
            created_at: candidate.created_at,
            full_text: remove_non_recognized(&full_text),
            report_comment: report_comments.remove(&candidate.id),
            has_own_comment: own_comments.contains_key(&candidate.id),
            is_important: important_ids.contains(&candidate.id),
        });
    }
    Ok(messages)
}

fn write_tag_report_docx(
    outpath: &PathBuf,
    period: &TagReportPeriod,
    data: TagReportData,
) -> Result<(), AppError> {
    crate::report_history::ensure_report_record_count(data.messages.len())
        .context(h!())?;
    let file = std::fs::File::create(outpath).context(h!())?;

    let style_invisible = Style::new("Invisible", StyleType::Paragraph)
        .name("Invisible")
        .align(AlignmentType::Center)
        .size(0);
    let style_1 = Style::new("Heading1", StyleType::Paragraph)
        .name("Heading 1")
        .align(AlignmentType::Center)
        .size(28)
        .bold();
    let mut doc = docx_rs::Docx::new()
        .default_size(28)
        .add_style(style_invisible)
        .add_style(style_1)
        .page_margin(
            docx_rs::page_margin::PageMargin::new()
                .left(1200)
                .right(500))
        .add_paragraph(
            Paragraph::new()
                .add_run(
                    Run::new()
                        .size(42)
                        .add_text("Розвідувальне донесення")
                        .bold(),
                )
                .align(docx_rs::alignment_type::AlignmentType::Center),
        )
        .add_paragraph(
            Paragraph::new()
                .add_run(
                    Run::new()
                        .add_text("за результатами виконання розвідувальних завдань з радіоелектронної розвідки,"))
                .align(docx_rs::alignment_type::AlignmentType::Center)
        )
        .add_paragraph(
            Paragraph::new()
                .add_run(
                    Run::new()
                        .add_text(format!("за період з {} по {}", period.date_from, period.date_to)))
                .align(docx_rs::alignment_type::AlignmentType::Center)
        )
        .add_paragraph(Paragraph::new())
        .add_paragraph(
            Paragraph::new()
                .add_run(Run::new().add_text("В ході ведення радіоелектронної розвідки виявлені наступні перехоплення, що можуть становити інтерес:"))
        )
        .add_paragraph(Paragraph::new());

    for message in data.messages {
        if let Some(extended_form) = message.report_comment {
            let extended_form = if message.is_important {
                format!("⚠️ {extended_form}")
            } else {
                extended_form
            };
            let mut p = Paragraph::new()
                .line_spacing(LineSpacing::new().before(0).after(0));
            for line in extended_form.lines() {
                let run = Run::new().add_text(line).bold();
                // let run = if important_ids.contains(message_id) {
                //     run.color("ff0000")
                // } else {
                //     run
                // };
                p = p.add_run(run);
            }
            doc = doc.add_paragraph(p);
        }
        let full_text = if !message.has_own_comment && message.is_important {
            format!("⚠️ {}", message.full_text)
        } else {
            message.full_text
        };
        for line in full_text.lines() {
            let run = Run::new().add_text(line).color("3faf46");
            doc = doc.add_paragraph(
                Paragraph::new()
                    .add_run(run)
                    .line_spacing(LineSpacing::new().before(0).after(0)),
            );
        }
        doc = doc.add_paragraph(Paragraph::new());
    }
    doc.build().pack(file).context(h!())?;
    Ok(())
}

/// Removes lines `НВ (НВ)` and `Не встановлено (НВ)` from the text.
fn remove_non_recognized(inp: &str) -> String {
    inp.lines()
        .filter(|x| {
            !(x.trim() == "НВ (НВ)"
                || x.trim() == "Не встановлено (НВ)"
                || x.trim() == "НВ"
                || x.trim() == "1:НВ"
                || x.trim() == "2:НВ")
        })
        .collect::<Vec<&str>>()
        .join("\n")
}

fn message_full_text_nocomments(
    body: Option<String>,
    inbox: &TagReportInboxItem,
    datasource_kind: &str,
) -> Result<String, AppError> {
    if datasource_kind == "signal"
        || datasource_kind == "whatsapp"
        || datasource_kind == "echo_operator"
    {
        Ok(body.unwrap_or_default())
    } else if datasource_kind == "api" {
        let datetime_part = match (inbox.date.as_deref(), inbox.time.as_deref())
        {
            (Some(date), Some(time)) => format!("{date} {time} "),
            (Some(date), None) => format!("{date} "),
            (None, Some(time)) => format!("{time} "),
            (None, None) => "".to_string(),
        };
        let freq_part = match inbox.freq.as_deref() {
            Some(freq) => format!("{freq} "),
            None => "".to_string(),
        };
        let unit_part = if inbox.freq.is_some() {
            format!("{} ", inbox.unit.as_deref().unwrap_or("НВ"))
        } else {
            "".to_string()
        };
        let location_part = if inbox.freq.is_some() {
            format!("{} ", inbox.location.as_deref().unwrap_or(""))
        } else {
            "".to_string()
        };
        Ok(format!(
            "{datetime_part}{freq_part}\n{unit_part}{location_part}\n{}",
            body.unwrap_or_default()
        ))
    } else {
        Err(format!("Unknown datasource kind: {datasource_kind:?}").into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::functest::tests::*;
    use crate::rer_importer::types::{InboxMessagesReq, InboxMessagesSortBy};
    use sea_orm::prelude::Expr;
    use sea_orm::ActiveValue::Set;
    use serial_test::serial;

    fn dt(hour: u32, minute: u32) -> chrono::NaiveDateTime {
        chrono::NaiveDate::from_ymd_opt(2026, 6, 30)
            .unwrap()
            .and_hms_opt(hour, minute, 0)
            .unwrap()
    }

    fn candidate(
        id: i64,
        freq: &str,
        datetime: chrono::NaiveDateTime,
        created_at: chrono::NaiveDateTime,
    ) -> TagReportMessageCandidate {
        TagReportMessageCandidate {
            id,
            freq: Some(freq.to_string()),
            datetime: Some(datetime),
            created_at: Some(created_at),
        }
    }

    #[test]
    fn tag_report_sort_by_time_ignores_frequency() {
        let mut messages = vec![
            candidate(1, "200.000", dt(10, 0), dt(10, 0)),
            candidate(2, "100.000", dt(9, 0), dt(9, 0)),
            candidate(3, "300.000", dt(9, 30), dt(9, 30)),
        ];

        sort_tag_report_candidates(
            &mut messages,
            TagReportSortBy::ByTime,
            false,
        );

        assert_eq!(
            messages
                .into_iter()
                .map(|message| message.id)
                .collect::<Vec<_>>(),
            vec![2, 3, 1]
        );
    }

    #[test]
    fn tag_report_sort_by_freq_then_time_keeps_frequency_primary() {
        let mut messages = vec![
            candidate(1, "200.000", dt(9, 0), dt(9, 0)),
            candidate(2, "100.000", dt(10, 0), dt(10, 0)),
            candidate(3, "100.000", dt(9, 30), dt(9, 30)),
        ];

        sort_tag_report_candidates(
            &mut messages,
            TagReportSortBy::ByFreqThenTime,
            false,
        );

        assert_eq!(
            messages
                .into_iter()
                .map(|message| message.id)
                .collect::<Vec<_>>(),
            vec![3, 2, 1]
        );
    }

    // https://github.com/echoua/echo/issues/3455
    #[test]
    fn tag_report_creation_sorting_uses_creation_time_within_each_sort_mode() {
        let mut by_time = vec![
            candidate(1, "200.000", dt(10, 0), dt(9, 0)),
            candidate(2, "100.000", dt(9, 0), dt(10, 0)),
        ];
        sort_tag_report_candidates(&mut by_time, TagReportSortBy::ByTime, true);
        assert_eq!(
            by_time
                .into_iter()
                .map(|message| message.id)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );

        let mut by_freq_then_time = vec![
            candidate(1, "100.000", dt(10, 0), dt(9, 0)),
            candidate(2, "100.000", dt(9, 0), dt(10, 0)),
        ];
        sort_tag_report_candidates(
            &mut by_freq_then_time,
            TagReportSortBy::ByFreqThenTime,
            true,
        );
        assert_eq!(
            by_freq_then_time
                .into_iter()
                .map(|message| message.id)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
    }

    #[tokio::test]
    #[serial]
    async fn tag_report_keeps_importance_across_timestamp_chunks() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let datasource_group =
            find_test_datasource_group(&env.dbx).await.unwrap();
        set_report_chunking_hours(&env.dbx, 1).await;
        let created_at = dt(10, 30);
        let interception_datetime = dt(3, 30);

        let signal_message = mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                body: Set(Some("important-across-chunks".to_string())),
                created_at: Set(created_at),
                timestamp: Set(Some(created_at)),
                message_uid: Set(Some("important-across-chunks".to_string())),
                datasource_group_id: Set(Some(datasource_group.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_signal_message_group(
            &env.dbx,
            signal_message_group::ActiveModel {
                signal_message_id: Set(signal_message.id),
                group_master_key: Set(Some(
                    datasource_group.group_master_key.clone(),
                )),
                datasource_group_id: Set(Some(datasource_group.id)),
                sender: Set(Some("sender-1".to_string())),
                message_uid: Set(Some("important-across-chunks".to_string())),
                created_at: Set(created_at),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_inbox_item(
            &env.dbx,
            sigint_inbox_item::ActiveModel {
                id: Set(signal_message.id),
                date: Set(Some(interception_datetime.date().to_string())),
                time: Set(Some(
                    interception_datetime.time().format("%H:%M:%S").to_string(),
                )),
                datetime: Set(Some(interception_datetime)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_important(
            &env.dbx,
            sigint_important::ActiveModel {
                login_id: Set(Some(login.id)),
                signal_message_id: Set(signal_message.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let req = InboxMessagesReq {
            since_date_inclusive_ms: Some(
                dt(7, 0).and_utc().timestamp_millis(),
            ),
            till_date_inclusive_ms: Some(
                dt(12, 0).and_utc().timestamp_millis(),
            ),
            nolimit: Some(true),
            sort_by: Some(InboxMessagesSortBy::IMSCreatedAt),
            ..Default::default()
        };
        let data = load_tag_report_data(
            &env.dbx,
            &login.id,
            &env,
            &req,
            TagReportSortBy::ByTime,
        )
        .await
        .unwrap();

        assert!(data.messages.iter().any(|message| {
            message.message_id == signal_message.id && message.is_important
        }));
    }

    async fn set_report_chunking_hours(db: &DatabaseConnection, hours: i32) {
        let result = system_settings::Entity::update_many()
            .col_expr(
                system_settings::Column::ReportChunkingHours,
                Expr::value(hours),
            )
            .filter(system_settings::Column::Deleted.eq(false))
            .exec(db)
            .await
            .unwrap();
        if result.rows_affected == 0 {
            system_settings::ActiveModel {
                report_chunking_hours: Set(hours),
                limit_big_reports: Set(false),
                ..Default::default()
            }
            .insert(db)
            .await
            .unwrap();
        }
    }
}
