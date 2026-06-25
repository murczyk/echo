use crate::entities::*;
use crate::error::AppError;
use crate::types::*;
use crate::utils::orm::ArrayColumnOps;
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
    user_login: &str,
    env: &Env,
    req: &super::types::ReportPreviewReq,
    outpath: &PathBuf,
) -> Result<(), AppError> {
    let mut current_req = req.req.clone();
    current_req.report_tags_only_this_unit = req.report_tags_only_this_unit;
    let login = user_login.to_string();
    let period = tag_report_period(&current_req)?;
    let read_db = env.replica();
    let data =
        load_tag_report_data(&read_db, &login, env, &current_req, &period)
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
    date: Option<String>,
    time: Option<String>,
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
    login: &str,
    env: &Env,
    req: &crate::rer_importer::types::InboxMessagesReq,
    period: &TagReportPeriod,
) -> Result<TagReportData, AppError> {
    let txn = read_db
        .begin_with_config(
            Some(IsolationLevel::RepeatableRead),
            Some(AccessMode::ReadOnly),
        )
        .await
        .context(h!())?;
    let snapshot = load_tag_report_snapshot_txn(&txn, login, env, req, period)
        .await
        .context(h!())?;
    txn.commit().await.context(h!())?;
    Ok(collect_tag_report_data(req, snapshot))
}

async fn load_tag_report_snapshot_txn(
    txn: &DatabaseTransaction,
    login: &str,
    env: &Env,
    req: &crate::rer_importer::types::InboxMessagesReq,
    period: &TagReportPeriod,
) -> Result<TagReportSnapshot, AppError> {
    let logins = crate::users::get_organism_logins_by_login(txn, login)
        .await
        .c(h!())?;
    let candidates = load_tag_report_candidates(txn, login, env, req).await?;
    let message_ids: Vec<i64> =
        candidates.iter().map(|message| message.id).collect();
    let important_ids = load_tag_report_important_ids(
        txn,
        login,
        &logins,
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
        load_tag_report_comments(txn, &message_ids, Some(&logins)).await?;
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
    snapshot: TagReportSnapshot,
) -> TagReportData {
    let mut candidates = snapshot.candidates;
    sort_tag_report_candidates(&mut candidates);
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
    login: &str,
    env: &Env,
    req: &crate::rer_importer::types::InboxMessagesReq,
) -> Result<Vec<TagReportMessageCandidate>, AppError> {
    let query = crate::rer_importer::inbox::query::build_inbox_query_with_conn(
        txn, login, env, req,
    )
    .await
    .context(h!())?;
    let messages = TagReportMessageCandidate::find_by_statement(
        Statement::from_string(DatabaseBackend::Postgres, query),
    )
    .all(txn)
    .await
    .context(h!())?;
    Ok(messages)
}

fn sort_tag_report_candidates(messages: &mut [TagReportMessageCandidate]) {
    messages.sort_by(|a, b| {
        let a_freq = a.freq.clone().unwrap_or("".to_string());
        let b_freq = b.freq.clone().unwrap_or("".to_string());
        let a_datetime_str = format!(
            "{}T{}",
            a.date.clone().unwrap_or("2023-01-01".to_string()),
            a.time.clone().unwrap_or("00:00:00".to_string())
        );
        let b_datetime_str = format!(
            "{}T{}",
            b.date.clone().unwrap_or("2023-01-01".to_string()),
            b.time.clone().unwrap_or("00:00:00".to_string())
        );
        (a_freq, a_datetime_str).cmp(&(b_freq, b_datetime_str))
    });
}

async fn load_tag_report_important_ids(
    txn: &DatabaseTransaction,
    login: &str,
    logins: &[String],
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
        .filter(sigint_important::Column::UserId.eq_any(logins.to_vec()))
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
            datasource::Column::Id.eq_any(datasource_ids.into_iter().collect()),
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
    logins: Option<&[String]>,
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
            q.filter(sigint_comment::Column::Login.eq_any(logins.to_vec()))
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
