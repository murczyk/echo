use crate::entities::*;
use crate::error::AppError;
use crate::h;
use crate::types::{Mode, ShortContext};
use chrono::{Duration, NaiveDateTime};
use log::{error, info};
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, Condition, ConnectionTrait,
    DatabaseConnection, EntityTrait, FromQueryResult, JoinType, NotSet,
    QueryFilter, QueryOrder, QuerySelect, RelationTrait, Set,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, FromQueryResult)]
struct CommentExportRow {
    login: String,
    comment: String,
    body: Option<String>,
    message_created_at: NaiveDateTime,
    message_timestamp: Option<NaiveDateTime>,
    inbox_datetime: Option<NaiveDateTime>,
}

#[derive(Debug, Serialize, Deserialize)]
struct CommentCsvRow {
    body: String,
    comment: String,
    message_ts: String,
    source_login: String,
}

pub async fn oneoff_export_sigint_comments(
    mode: Mode,
    ps: &crate::OneoffExportSigintCommentsPs,
) -> Result<(), AppError> {
    info!(
        "starting oneoff_export_sigint_comments organism={} from={} to={} output={}",
        ps.organism_name, ps.from, ps.to, ps.output
    );
    let from_dt = parse_naive_datetime(&ps.from)?;
    let to_dt = parse_naive_datetime(&ps.to)?;
    let dbx = crate::new_pg_pool_from_mode(mode).await.c(h!())?;

    let organism = organism::Entity::find()
        .filter(organism::Column::DeletedPermanently.eq(false))
        .filter(organism::Column::Name.eq(ps.organism_name.clone()))
        .one(&dbx)
        .await
        .c(h!())?
        .c(h!())?;

    let logins = load_organism_logins(&dbx, organism.id).await?;
    if logins.is_empty() {
        info!(
            "no active logins found for organism {}, nothing to export",
            ps.organism_name
        );
        return Ok(());
    }

    let time_condition = message_time_condition(from_dt, to_dt);
    let rows: Vec<CommentExportRow> = sigint_comment::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_comment::Relation::SignalMessage.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .filter(sigint_comment::Column::Login.is_in(logins.clone()))
        .filter(time_condition)
        .select_only()
        .column(sigint_comment::Column::Login)
        .column(sigint_comment::Column::Comment)
        .column_as(
            Expr::col((signal_message::Entity, signal_message::Column::Body)),
            "body",
        )
        .column_as(
            Expr::col((
                signal_message::Entity,
                signal_message::Column::CreatedAt,
            )),
            "message_created_at",
        )
        .column_as(
            Expr::col((
                signal_message::Entity,
                signal_message::Column::Timestamp,
            )),
            "message_timestamp",
        )
        .column_as(
            Expr::col((
                sigint_inbox_item::Entity,
                sigint_inbox_item::Column::Datetime,
            )),
            "inbox_datetime",
        )
        .order_by_asc(sigint_comment::Column::CreatedAt)
        .into_model::<CommentExportRow>()
        .all(&dbx)
        .await
        .c(h!())?;

    let mut writer = csv::Writer::from_path(&ps.output).c(h!())?;
    let mut exported = 0_usize;
    let mut skipped = 0_usize;
    for row in rows {
        let Some(body) = row.body.clone() else {
            error!(
                "skipping comment from login {} because message body is missing",
                row.login
            );
            skipped += 1;
            continue;
        };
        let message_ts = resolve_message_ts(
            row.inbox_datetime,
            row.message_timestamp,
            row.message_created_at,
        );
        let csv_row = CommentCsvRow {
            body: body.clone(),
            comment: row.comment.clone(),
            message_ts: message_ts.format("%Y-%m-%dT%H:%M:%S").to_string(),
            source_login: row.login.clone(),
        };
        writer.serialize(&csv_row).c(h!())?;
        exported += 1;
        info!(
            "exported comment from {} at {} body={}",
            row.login,
            message_ts,
            format_body_sample(&body)
        );
    }
    writer.flush().c(h!())?;
    info!(
        "export completed: exported {} comments (skipped {}) to {}",
        exported, skipped, ps.output
    );
    Ok(())
}

pub async fn oneoff_import_sigint_comments(
    mode: Mode,
    ps: &crate::OneoffImportSigintCommentsPs,
) -> Result<(), AppError> {
    info!(
        "starting oneoff_import_sigint_comments input={} target_login={}",
        ps.input, ps.target_login
    );
    let dbx = crate::new_pg_pool_from_mode(mode).await.c(h!())?;
    let Some(_) = login::Entity::find_by_id(ps.target_login.clone())
        .filter(login::Column::Deleted.eq(false))
        .filter(login::Column::DeletedPermanently.eq(false))
        .one(&dbx)
        .await
        .c(h!())?
    else {
        return Err(AppError::BL {
            msg: format!(
                "target login not found or deleted: {}",
                ps.target_login
            ),
        });
    };

    let mut reader = csv::ReaderBuilder::new()
        .trim(csv::Trim::All)
        .from_path(&ps.input)
        .c(h!())?;

    let mut inserted = 0_usize;
    let mut skipped_existing = 0_usize;
    let mut not_found = 0_usize;
    let mut failed = 0_usize;

    for (idx, record) in reader.deserialize::<CommentCsvRow>().enumerate() {
        let row: CommentCsvRow = match record {
            Ok(row) => row,
            Err(err) => {
                failed += 1;
                error!("row {}: failed to read csv record: {err}", idx + 1);
                continue;
            }
        };
        let message_ts = match parse_naive_datetime(&row.message_ts) {
            Ok(ts) => ts,
            Err(err) => {
                failed += 1;
                error!(
                    "row {}: invalid message_ts '{}': {err}",
                    idx + 1,
                    row.message_ts
                );
                continue;
            }
        };

        let Some((message, resolved_ts)) =
            find_best_message(&dbx, &row.body, message_ts).await?
        else {
            not_found += 1;
            error!(
                "row {}: message not found within +/-15m for ts {} body={}",
                idx + 1,
                row.message_ts,
                format_body_sample(&row.body)
            );
            continue;
        };

        if let Some(existing) = sigint_comment::Entity::find()
            .filter(sigint_comment::Column::SignalMessageId.eq(message.id))
            .filter(sigint_comment::Column::Login.eq(ps.target_login.clone()))
            .one(&dbx)
            .await
            .c(h!())?
        {
            skipped_existing += 1;
            if existing.comment.trim() == row.comment.trim() {
                info!(
                    "row {}: skipping message {} because same comment already exists",
                    idx + 1,
                    message.id
                );
            } else {
                info!(
                    "row {}: skipping message {} because another comment already exists for login {}",
                    idx + 1,
                    message.id,
                    ps.target_login
                );
            }
            continue;
        }

        let active = sigint_comment::ActiveModel {
            id: NotSet,
            login: Set(ps.target_login.clone()),
            signal_message_id: Set(message.id),
            comment: Set(row.comment.clone()),
            created_at: NotSet,
        };

        match active.insert(&dbx).await {
            Ok(_) => {
                inserted += 1;
                info!(
                    "row {}: imported comment for message {} at {}",
                    idx + 1,
                    message.id,
                    resolved_ts
                );
            }
            Err(err) => {
                failed += 1;
                error!(
                    "row {}: failed to insert comment for message {}: {err}",
                    idx + 1,
                    message.id
                );
            }
        }
    }

    info!(
        "import completed: inserted {inserted}, skipped {skipped_existing}, not_found {not_found}, failed {failed}",
    );
    Ok(())
}

fn parse_naive_datetime(inp: &str) -> Result<NaiveDateTime, AppError> {
    Ok(NaiveDateTime::parse_from_str(inp, "%Y-%m-%dT%H:%M:%S%.f")
        .or_else(|_| NaiveDateTime::parse_from_str(inp, "%Y-%m-%d %H:%M:%S%.f"))
        .or_else(|_| NaiveDateTime::parse_from_str(inp, "%Y-%m-%dT%H:%M:%S"))
        .c(h!())?)
}

fn resolve_message_ts(
    inbox_datetime: Option<NaiveDateTime>,
    message_timestamp: Option<NaiveDateTime>,
    message_created_at: NaiveDateTime,
) -> NaiveDateTime {
    inbox_datetime
        .or(message_timestamp)
        .unwrap_or(message_created_at)
}

fn message_time_condition(
    from_dt: NaiveDateTime,
    to_dt: NaiveDateTime,
) -> Condition {
    Condition::any()
        .add(
            sigint_inbox_item::Column::Datetime
                .between(from_dt, to_dt)
                .and(sigint_inbox_item::Column::Datetime.is_not_null()),
        )
        .add(
            sigint_inbox_item::Column::Datetime
                .is_null()
                .and(signal_message::Column::Timestamp.between(from_dt, to_dt)),
        )
        .add(
            sigint_inbox_item::Column::Datetime
                .is_null()
                .and(signal_message::Column::Timestamp.is_null())
                .and(signal_message::Column::CreatedAt.between(from_dt, to_dt)),
        )
}

async fn load_organism_logins<'a, 'async_trait, C>(
    txn: &'a C,
    organism_id: i64,
) -> Result<Vec<String>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let logins = login::Entity::find()
        .filter(login::Column::OrganismId.eq(organism_id))
        .filter(login::Column::Deleted.eq(false))
        .filter(login::Column::DeletedPermanently.eq(false))
        .select_only()
        .column(login::Column::Login)
        .into_tuple::<String>()
        .all(txn)
        .await
        .c(h!())?;
    Ok(logins)
}

async fn find_best_message(
    dbx: &DatabaseConnection,
    body: &str,
    message_ts: NaiveDateTime,
) -> Result<Option<(signal_message::Model, NaiveDateTime)>, AppError> {
    let from_ts = message_ts - Duration::minutes(15);
    let to_ts = message_ts + Duration::minutes(15);
    let candidates = signal_message::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .filter(signal_message::Column::Body.eq(body))
        .filter(message_time_condition(from_ts, to_ts))
        .find_also_related(sigint_inbox_item::Entity)
        .all(dbx)
        .await
        .c(h!())?;

    let mut best: Option<(signal_message::Model, NaiveDateTime, i64)> = None;
    for (message, inbox_opt) in candidates {
        let resolved_ts = resolve_message_ts(
            inbox_opt.and_then(|i| i.datetime),
            message.timestamp,
            message.created_at,
        );
        let diff = (resolved_ts - message_ts).num_seconds().abs();
        match &best {
            None => best = Some((message, resolved_ts, diff)),
            Some((_, _, best_diff)) if diff < *best_diff => {
                best = Some((message, resolved_ts, diff))
            }
            _ => {}
        }
    }

    if let Some((message, resolved_ts, _)) = best {
        Ok(Some((message, resolved_ts)))
    } else {
        Ok(None)
    }
}

fn format_body_sample(body: &str) -> String {
    let single_line = body.replace('\n', " ");
    let trimmed = single_line.trim();
    let mut sample = trimmed.chars().take(60).collect::<String>();
    if trimmed.len() > 60 {
        sample.push_str("...");
    }
    sample
}
