use std::collections::BTreeSet;
use std::path::PathBuf;

use crate::entities::*;
use crate::error::AppError;
use crate::types::*;
use crate::utils::*;
use actix_identity::Identity;
use docx_rs::AlignmentType;
use docx_rs::LineSpacing;
use docx_rs::Paragraph;
use docx_rs::Run;
use docx_rs::Style;
use docx_rs::StyleType;
use sea_orm::*;

pub async fn report_docx_kind_tag(
    user: Identity,
    env: &Env,
    req: &super::ReportPreviewReq,
    outpath: &PathBuf,
) -> Result<(), AppError> {
    let txn = env.dbx.begin().await.context(h!())?;

    let login = user.id()?;
    let logins = crate::users::get_organism_logins(&txn, user).await?;
    let mut messages = crate::rer_importer::inbox::get_inbox_messages(
        &login, &logins, env, &req.req,
    )
    .await
    .context(h!())?;

    // sort messages by (freq, datetime)
    messages.sort_by(|a, b| {
        let a_freq = a.1.freq.clone().unwrap_or("".to_string());
        let b_freq = b.1.freq.clone().unwrap_or("".to_string());
        let a_datetime_str = format!(
            "{}T{}",
            a.1.date.clone().unwrap_or("2023-01-01".to_string()),
            a.1.time.clone().unwrap_or("00:00:00".to_string())
        );
        let b_datetime_str = format!(
            "{}T{}",
            b.1.date.clone().unwrap_or("2023-01-01".to_string()),
            b.1.time.clone().unwrap_or("00:00:00".to_string())
        );
        // compare tuples
        (a_freq, a_datetime_str).cmp(&(b_freq, b_datetime_str))
    });

    let Some(since_date_inclusive_ms) = req.req.since_date_inclusive_ms else {
        return Err("Since date must be specified".into());
    };
    let Some(till_date_inclusive_ms) = req.req.till_date_inclusive_ms else {
        return Err("Until date must be specified".into());
    };
    let date_from_dt =
        dt_zoned_from_millis(since_date_inclusive_ms).context(h!())?;
    let date_from: String = date_from_dt.format("%H:%M %d.%m.%Y").to_string();
    let date_to_dt =
        dt_zoned_from_millis(till_date_inclusive_ms).context(h!())?;
    let date_to: String = date_to_dt.format("%H:%M %d.%m.%Y").to_string();

    let importants = sigint_important::Entity::find()
        .filter(sigint_important::Column::UserId.is_in(&logins))
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
        .filter(
            datasource_group::Column::GroupMasterKey.is_in(
                crate::users::get_identity_sigint_groups(&txn, &login)
                    .await
                    .context(h!())?,
            ),
        )
        .filter(
            sigint_inbox_item::Column::Datetime.gte(date_from_dt.naive_utc()),
        )
        .filter(sigint_inbox_item::Column::Datetime.lte(date_to_dt.naive_utc()))
        .filter(signal_message::Column::Deleted.eq(false))
        .all(&txn)
        .await
        .context(h!())?;
    let important_ids: BTreeSet<i64> = importants
        .iter()
        .map(|important| important.signal_message_id)
        .collect();

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
                        .add_text(format!("за період з {date_from} по {date_to}")))
                .align(docx_rs::alignment_type::AlignmentType::Center)
        )
        .add_paragraph(Paragraph::new())
        .add_paragraph(
            Paragraph::new()
                .add_run(Run::new().add_text("В ході ведення радіоелектронної розвідки виявлені наступні перехоплення, що можуть становити інтерес:"))
        )
        .add_paragraph(Paragraph::new());

    let datasource_map: BTreeMap<i64, datasource::Model> =
        datasource::Entity::find()
            .all(&txn)
            .await
            .context(h!())?
            .into_iter()
            .map(|datasource| (datasource.id, datasource))
            .collect();

    let mut rows: Vec<Paragraph> = vec![];
    for (message_id, message) in messages.iter() {
        if req.req.report_tags_only_this_unit == Some(true)
            && message.extended_form.is_none()
        {
            continue;
        }
        let message_id = *message_id;
        let mut ps = vec![];
        let Some((msg, group)) = signal_message::Entity::find_by_id(message_id)
            .find_with_related(datasource_group::Entity)
            .filter(signal_message::Column::Deleted.eq(false))
            .all(&txn)
            .await
            .context(h!())?
            .into_iter()
            .next()
            .and_then(|(m, groups)| groups.into_iter().next().map(|g| (m, g)))
        else {
            continue;
        };
        let Some(inbox) = sigint_inbox_item::Entity::find_by_id(message_id)
            .one(&txn)
            .await
            .context(h!())?
        else {
            continue;
        };
        let Some(datasource) = datasource_map.get(&group.datasource_id) else {
            continue;
        };
        let m_comment = sigint_comment::Entity::find()
            .filter(sigint_comment::Column::SignalMessageId.eq(message_id))
            .apply_if(req.req.report_tags_only_this_unit, |q, _| {
                q.filter(sigint_comment::Column::Login.is_in(logins.clone()))
            })
            .one(&txn)
            .await
            .context(h!())?;
        if let Some(extended_form) = m_comment.map(|c| c.comment) {
            let extended_form = if important_ids.contains(&message_id) {
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
            &message_full_text_nocomments(&msg, &inbox, datasource)
                .context(h!())?,
        );
        let m_comment = sigint_comment::Entity::find()
            .filter(sigint_comment::Column::SignalMessageId.eq(message_id))
            .filter(sigint_comment::Column::Login.is_in(logins.clone()))
            .one(&txn)
            .await
            .context(h!())?;
        let full_text =
            if m_comment.is_none() && important_ids.contains(&message_id) {
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

    txn.commit().await.context(h!())?;

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
    if datasource.kind == "signal" || datasource.kind == "whatsapp" {
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
