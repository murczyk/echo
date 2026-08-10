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

    write_tag_report_docx(outpath, &period, &data)?;
    Ok(())
}

struct TagReportPeriod {
    date_from: String,
    date_to: String,
    date_from_dt: chrono::NaiveDateTime,
    date_to_dt: chrono::NaiveDateTime,
}

struct TagReportData {
    important_ids: BTreeSet<i64>,
    messages: Vec<TagReportMessage>,
}

struct TagReportSnapshot {
    important_ids: BTreeSet<i64>,
    candidates: Vec<TagReportMessageCandidate>,
    signal_messages:
        BTreeMap<i64, (signal_message::Model, datasource_group::Model)>,
    inbox_items: BTreeMap<i64, sigint_inbox_item::Model>,
    datasources: BTreeMap<i64, datasource::Model>,
    report_comments: BTreeMap<i64, String>,
    own_comments: BTreeMap<i64, String>,
}

struct TagReportMessage {
    message_id: i64,
    signal_message: signal_message::Model,
    inbox: sigint_inbox_item::Model,
    datasource: datasource::Model,
    report_comment: Option<String>,
    own_comment: Option<String>,
}

#[derive(FromQueryResult)]
struct TagReportMessageCandidate {
    id: i64,
    freq: Option<String>,
    datetime: Option<chrono::NaiveDateTime>,
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
        date_from_dt: date_from_dt.naive_utc(),
        date_to_dt: date_to_dt.naive_utc(),
    })
}

async fn load_tag_report_data(
    read_db: &DatabaseConnection,
    login: &uuid::Uuid,
    env: &Env,
    req: &crate::rer_importer::types::InboxMessagesReq,
    tag_report_sort_by: TagReportSortBy,
) -> Result<TagReportData, AppError> {
    let report_settings =
        crate::system_settings::get_report_generation_settings(&env.dbx)
            .await
            .c(h!())?;
    let chunks =
        inbox_report_period_chunks(req, report_settings.chunking_hours)?;
    let mut important_ids = BTreeSet::new();
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
        let chunk_period = tag_report_period(&chunk_req)?;
        let txn = read_db
            .begin_with_config(
                Some(IsolationLevel::RepeatableRead),
                Some(AccessMode::ReadOnly),
            )
            .await
            .context(h!())?;
        let snapshot = load_tag_report_snapshot_txn(
            &txn,
            login,
            env,
            &chunk_req,
            &chunk_period,
            chunk.end,
        )
        .await
        .context(h!())?;
        txn.commit().await.context(h!())?;
        let chunk_data =
            collect_tag_report_data(&chunk_req, tag_report_sort_by, snapshot);
        important_ids.extend(chunk_data.important_ids);
        for message in chunk_data.messages {
            messages_by_id.entry(message.message_id).or_insert(message);
        }
    }
    let mut messages = messages_by_id.into_values().collect::<Vec<_>>();
    sort_tag_report_messages(&mut messages, tag_report_sort_by);
    Ok(TagReportData {
        important_ids,
        messages,
    })
}

async fn load_tag_report_snapshot_txn(
    txn: &DatabaseTransaction,
    login: &uuid::Uuid,
    env: &Env,
    req: &crate::rer_importer::types::InboxMessagesReq,
    period: &TagReportPeriod,
    period_end: ReportPeriodEnd,
) -> Result<TagReportSnapshot, AppError> {
    let login_ids = crate::users::get_organism_login_ids_by_id(txn, login)
        .await
        .c(h!())?;
    let candidates =
        load_tag_report_candidates(txn, login, env, req, period_end).await?;
    let message_ids: Vec<i64> =
        candidates.iter().map(|message| message.id).collect();
    let important_ids = load_tag_report_important_ids(
        txn,
        login,
        &login_ids,
        &message_ids,
        period,
    )
    .await?;
    let signal_messages =
        load_tag_report_signal_messages(txn, &message_ids).await?;
    let inbox_items = load_tag_report_inbox_items(txn, &message_ids).await?;
    let datasources =
        load_tag_report_datasources(txn, signal_messages.values()).await?;
    let own_comments =
        load_tag_report_comments(txn, &message_ids, Some(&login_ids)).await?;
    let report_comments = if req.report_tags_only_this_unit.is_some() {
        own_comments.clone()
    } else {
        load_tag_report_comments(txn, &message_ids, None).await?
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
    snapshot: TagReportSnapshot,
) -> TagReportData {
    let mut candidates = snapshot.candidates;
    sort_tag_report_candidates(&mut candidates, tag_report_sort_by);
    let messages = collect_tag_report_messages(
        req,
        candidates,
        snapshot.signal_messages,
        snapshot.inbox_items,
        snapshot.datasources,
        snapshot.report_comments,
        snapshot.own_comments,
    );
    TagReportData {
        important_ids: snapshot.important_ids,
        messages,
    }
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
    .into_model::<TagReportMessageCandidate>()
    .all(txn)
    .await
    .context(h!())?;
    Ok(messages)
}

fn sort_tag_report_messages(
    messages: &mut [TagReportMessage],
    tag_report_sort_by: TagReportSortBy,
) {
    messages.sort_by(|left, right| match tag_report_sort_by {
        TagReportSortBy::ByTime => tag_report_message_time_order(left, right),
        TagReportSortBy::ByFreqThenTime => left
            .inbox
            .freq
            .as_deref()
            .unwrap_or("")
            .cmp(right.inbox.freq.as_deref().unwrap_or(""))
            .then_with(|| tag_report_message_time_order(left, right)),
    });
}

fn tag_report_message_time_order(
    left: &TagReportMessage,
    right: &TagReportMessage,
) -> std::cmp::Ordering {
    (left.inbox.datetime, left.message_id)
        .cmp(&(right.inbox.datetime, right.message_id))
}

fn sort_tag_report_candidates(
    messages: &mut [TagReportMessageCandidate],
    tag_report_sort_by: TagReportSortBy,
) {
    messages.sort_by(|left, right| match tag_report_sort_by {
        TagReportSortBy::ByTime => tag_report_time_order(left, right),
        TagReportSortBy::ByFreqThenTime => left
            .freq
            .as_deref()
            .unwrap_or("")
            .cmp(right.freq.as_deref().unwrap_or(""))
            .then_with(|| tag_report_time_order(left, right)),
    });
}

fn tag_report_time_order(
    left: &TagReportMessageCandidate,
    right: &TagReportMessageCandidate,
) -> std::cmp::Ordering {
    (left.datetime, left.id).cmp(&(right.datetime, right.id))
}

async fn load_tag_report_important_ids(
    txn: &DatabaseTransaction,
    login: &uuid::Uuid,
    logins: &[uuid::Uuid],
    message_ids: &[i64],
    period: &TagReportPeriod,
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
        .filter(sigint_inbox_item::Column::Datetime.gte(period.date_from_dt))
        .filter(sigint_inbox_item::Column::Datetime.lte(period.date_to_dt))
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
) -> Result<
    BTreeMap<i64, (signal_message::Model, datasource_group::Model)>,
    AppError,
> {
    if message_ids.is_empty() {
        return Ok(BTreeMap::new());
    }
    let messages = signal_message::Entity::find()
        .filter(signal_message::Column::Id.eq_any(message_ids.to_vec()))
        .filter(signal_message::Column::Deleted.eq(false))
        .find_with_related(datasource_group::Entity)
        .all(txn)
        .await
        .context(h!())?;
    Ok(messages
        .into_iter()
        .filter_map(|(message, groups)| {
            groups
                .into_iter()
                .next()
                .map(|group| (message.id, (message, group)))
        })
        .collect())
}

async fn load_tag_report_inbox_items(
    txn: &DatabaseTransaction,
    message_ids: &[i64],
) -> Result<BTreeMap<i64, sigint_inbox_item::Model>, AppError> {
    if message_ids.is_empty() {
        return Ok(BTreeMap::new());
    }
    Ok(sigint_inbox_item::Entity::find()
        .filter(sigint_inbox_item::Column::Id.eq_any(message_ids.to_vec()))
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .map(|inbox| (inbox.id, inbox))
        .collect())
}

async fn load_tag_report_datasources<'a>(
    txn: &DatabaseTransaction,
    messages: impl Iterator<
        Item = &'a (signal_message::Model, datasource_group::Model),
    >,
) -> Result<BTreeMap<i64, datasource::Model>, AppError> {
    let datasource_ids: BTreeSet<i64> =
        messages.map(|(_, group)| group.datasource_id).collect();
    if datasource_ids.is_empty() {
        return Ok(BTreeMap::new());
    }
    Ok(datasource::Entity::find()
        .filter(
            datasource::Column::Id
                .eq_any(datasource_ids.into_iter().collect::<Vec<_>>()),
        )
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
    let comments = sigint_comment::Entity::find()
        .filter(
            sigint_comment::Column::SignalMessageId
                .eq_any(message_ids.to_vec()),
        )
        .apply_if(logins, |q, logins| {
            q.filter(sigint_comment::Column::LoginId.eq_any(logins.to_vec()))
        })
        .order_by_asc(sigint_comment::Column::Id)
        .all(txn)
        .await
        .context(h!())?;
    let mut comments_by_message = BTreeMap::new();
    for comment in comments {
        comments_by_message
            .entry(comment.signal_message_id)
            .or_insert(comment.comment);
    }
    Ok(comments_by_message)
}

fn collect_tag_report_messages(
    req: &crate::rer_importer::types::InboxMessagesReq,
    candidates: Vec<TagReportMessageCandidate>,
    signal_messages: BTreeMap<
        i64,
        (signal_message::Model, datasource_group::Model),
    >,
    inbox_items: BTreeMap<i64, sigint_inbox_item::Model>,
    datasources: BTreeMap<i64, datasource::Model>,
    report_comments: BTreeMap<i64, String>,
    own_comments: BTreeMap<i64, String>,
) -> Vec<TagReportMessage> {
    let mut messages = vec![];
    for candidate in candidates {
        if req.report_tags_only_this_unit == Some(true)
            && !own_comments.contains_key(&candidate.id)
        {
            continue;
        }
        let Some((signal_message, datasource_group)) =
            signal_messages.get(&candidate.id)
        else {
            continue;
        };
        let Some(inbox) = inbox_items.get(&candidate.id) else {
            continue;
        };
        let Some(datasource) = datasources.get(&datasource_group.datasource_id)
        else {
            continue;
        };
        messages.push(TagReportMessage {
            message_id: candidate.id,
            signal_message: signal_message.clone(),
            inbox: inbox.clone(),
            datasource: datasource.clone(),
            report_comment: report_comments.get(&candidate.id).cloned(),
            own_comment: own_comments.get(&candidate.id).cloned(),
        });
    }
    messages
}

fn write_tag_report_docx(
    outpath: &PathBuf,
    period: &TagReportPeriod,
    data: &TagReportData,
) -> Result<(), AppError> {
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

    let mut rows: Vec<Paragraph> = vec![];
    for message in &data.messages {
        let mut ps = vec![];
        if let Some(extended_form) = message.report_comment.clone() {
            let extended_form =
                if data.important_ids.contains(&message.message_id) {
                    format!("⚠️ {extended_form}")
                } else {
                    extended_form.clone()
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
            ps.push(p)
        }
        let full_text = remove_non_recognized(
            &message_full_text_nocomments(
                &message.signal_message,
                &message.inbox,
                &message.datasource,
            )
            .context(h!())?,
        );
        let full_text = if message.own_comment.is_none()
            && data.important_ids.contains(&message.message_id)
        {
            format!("⚠️ {full_text}")
        } else {
            full_text
        };
        for line in full_text.lines() {
            let run = Run::new().add_text(line).color("3faf46");
            ps.push(
                Paragraph::new()
                    .add_run(run)
                    .line_spacing(LineSpacing::new().before(0).after(0)),
            );
        }
        ps.push(Paragraph::new());
        for p in ps {
            rows.push(p);
        }
    }
    for row in rows {
        doc = doc.add_paragraph(row);
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
    message: &signal_message::Model,
    inbox: &sigint_inbox_item::Model,
    datasource: &datasource::Model,
) -> Result<String, AppError> {
    if datasource.kind == "signal"
        || datasource.kind == "whatsapp"
        || datasource.kind == "echo_operator"
    {
        Ok(message.body.clone().unwrap_or("".to_string()).to_string())
    } else if datasource.kind == "api" {
        let datetime_part = match (inbox.date.clone(), inbox.time.clone()) {
            (Some(date), Some(time)) => format!("{} ", date + " " + &time),
            (Some(date), None) => format!("{date} "),
            (None, Some(time)) => format!("{time} "),
            (None, None) => "".to_string(),
        };
        let freq_part = match inbox.freq.clone() {
            Some(freq) => format!("{freq} "),
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
        Ok(format!(
            "{datetime_part}{freq_part}\n{unit_part}{location_part}\n{}",
            message.body.clone().unwrap_or("".to_string()),
        ))
    } else {
        Err(format!("Unknown datasource kind: {:?}", datasource.kind).into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    ) -> TagReportMessageCandidate {
        TagReportMessageCandidate {
            id,
            freq: Some(freq.to_string()),
            datetime: Some(datetime),
        }
    }

    #[test]
    fn tag_report_sort_by_time_ignores_frequency() {
        let mut messages = vec![
            candidate(1, "200.000", dt(10, 0)),
            candidate(2, "100.000", dt(9, 0)),
            candidate(3, "300.000", dt(9, 30)),
        ];

        sort_tag_report_candidates(&mut messages, TagReportSortBy::ByTime);

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
            candidate(1, "200.000", dt(9, 0)),
            candidate(2, "100.000", dt(10, 0)),
            candidate(3, "100.000", dt(9, 30)),
        ];

        sort_tag_report_candidates(
            &mut messages,
            TagReportSortBy::ByFreqThenTime,
        );

        assert_eq!(
            messages
                .into_iter()
                .map(|message| message.id)
                .collect::<Vec<_>>(),
            vec![3, 2, 1]
        );
    }
}
