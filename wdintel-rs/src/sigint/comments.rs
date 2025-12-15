use crate::entities::*;
use crate::error::AppError;
use crate::h;
use crate::types::{Mode, ShortContext};
use chrono::{Duration, NaiveDateTime};
use log::{error, info, warn};
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, Condition, ConnectionTrait,
    DatabaseConnection, EntityTrait, FromQueryResult, JoinType, NotSet,
    QueryFilter, QueryOrder, QuerySelect, RelationTrait, Set,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

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
    source_organism: String,
}

pub async fn oneoff_export_sigint_comments(
    mode: Mode,
    ps: &crate::OneoffExportSigintCommentsPs,
) -> Result<(), AppError> {
    info!(
        "starting oneoff_export_sigint_comments organisms={:?} from={} to={} output={}",
        ps.organisms, ps.from, ps.to, ps.output
    );
    let from_dt = parse_naive_datetime(&ps.from)?;
    let to_dt = parse_naive_datetime(&ps.to)?;
    let dbx = crate::new_pg_pool_from_mode(mode).await.c(h!())?;

    let mut q = organism::Entity::find()
        .filter(organism::Column::DeletedPermanently.eq(false));

    if !ps.organisms.is_empty() {
        q = q.filter(organism::Column::Name.is_in(ps.organisms.clone()));
    }

    let organisms: HashMap<i64, String> = q
        .all(&dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|organism| (organism.id, organism.name))
        .collect();

    let logins =
        load_organism_logins(&dbx, organisms.keys().copied().collect()).await?;
    if logins.is_empty() {
        info!(
            "no active logins found for organisms {:?}, nothing to export",
            &ps.organisms
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
        .filter(
            sigint_comment::Column::Login.is_in(logins.keys().cloned().clone()),
        )
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
        let login_organism_name =
            logins.get(&row.login).and_then(|k| organisms.get(k));

        let Some(source_organism) = login_organism_name else {
            error!(
                "skipping comment from login {} because organism is missing",
                row.login
            );
            skipped += 1;
            continue;
        };

        let csv_row = CommentCsvRow {
            body: body.clone(),
            comment: row.comment.clone(),
            message_ts: message_ts.format("%Y-%m-%dT%H:%M:%S").to_string(),
            source_organism: source_organism.clone(),
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
    info!("starting oneoff_import_sigint_comments input={}", ps.input,);
    let dbx = crate::new_pg_pool_from_mode(mode).await.c(h!())?;

    let login_to_organism_id: HashMap<String, i64> = login::Entity::find()
        .filter(login::Column::Deleted.eq(false))
        .filter(login::Column::DeletedPermanently.eq(false))
        .filter(login::Column::OrganismId.is_not_null())
        .select_only()
        .column(login::Column::Login)
        .column(login::Column::OrganismId)
        .into_tuple::<(String, i64)>()
        .all(&dbx)
        .await
        .c(h!())?
        .into_iter()
        .collect();

    let organisms: HashMap<i64, String> = organism::Entity::find()
        .filter(organism::Column::DeletedPermanently.eq(false))
        .select_only()
        .column(organism::Column::Id)
        .column(organism::Column::Name)
        .into_tuple::<(i64, String)>()
        .all(&dbx)
        .await
        .c(h!())?
        .into_iter()
        .collect();

    let mut logins_to_map: HashSet<(String, String)> = HashSet::new();
    let mut organism_login_mapping: HashMap<String, HashMap<String, String>>;
    if let Some(path) = &ps.organism_login_mapping {
        let file = std::fs::File::open(path).c(h!())?;
        let reader = std::io::BufReader::new(file);
        organism_login_mapping = serde_json::from_reader(reader).c(h!())?;

        let len = organism_login_mapping.len();
        info!("organism_login_mapping loaded, {len} entrires");

        for (source_organism, logins) in &organism_login_mapping {
            for (source_login, target_login) in logins {
                let Some(target_organism_id) =
                    login_to_organism_id.get(target_login)
                else {
                    return Err(AppError::BL {
                        msg: format!(
                            "target login not found or deleted: {target_login}"
                        ),
                    });
                };
                let Some(target_organism) = organisms.get(target_organism_id)
                else {
                    return Err(AppError::BL {
                        msg: format!("target login organism not found or deleted: {target_organism_id}"),
                    });
                };

                info!("loaded mapping '{source_organism}/{source_login}' to '{target_organism}/{target_login}'");
            }
        }
    } else {
        organism_login_mapping = HashMap::new();
    }

    let mut reader = csv::ReaderBuilder::new()
        .trim(csv::Trim::All)
        .from_path(&ps.input)
        .c(h!())?;

    let mut inserted = 0_usize;
    let mut skipped_existing = 0_usize;
    let mut not_found = 0_usize;
    let mut failed = 0_usize;
    let mut excluded: usize = 0_usize;
    let mut not_mapped = 0_usize;

    let excluded_organisms: HashSet<String> =
        ps.excluded_organisms.iter().cloned().collect();
    let excluded_logins: HashSet<String> =
        ps.excluded_logins.iter().cloned().collect();

    let dry_run = if ps.dry_run { " (dry-run)" } else { "" };
    for (idx, record) in reader.deserialize::<CommentCsvRow>().enumerate() {
        let row: CommentCsvRow = match record {
            Ok(row) => row,
            Err(err) => {
                failed += 1;
                error!(
                    "row {}{dry_run}: failed to read csv record: {err}",
                    idx + 1
                );
                continue;
            }
        };
        let source_organism = row.source_organism.clone();
        if excluded_organisms.contains(&row.source_organism) {
            excluded += 1;
            continue;
        }
        let source_login = row.source_login.clone();
        if excluded_logins.contains(&row.source_login) {
            excluded += 1;
            continue;
        }
        let login: String;
        let organism_mapping = organism_login_mapping
            .entry(source_organism.clone())
            .or_default();

        if let Some(target_login) = organism_mapping.get(&row.source_login) {
            login = target_login.clone();
        } else {
            if let Some(target_organism_id) =
                login_to_organism_id.get(&row.source_login)
            {
                let target_login = source_login.clone();
                login = target_login.clone();
                let target_organism = &organisms[target_organism_id];

                info!("detected mapping{dry_run} '{source_organism}/{source_login}' to '{target_organism}/{target_login}'");
                organism_mapping.insert(source_login.clone(), target_login);
            } else {
                not_mapped += 1;
                if logins_to_map.insert((source_organism, source_login)) {
                    let source_organism = &row.source_organism;
                    let source_login = &row.source_login;
                    error!("missing mapping{dry_run} for '{source_organism}/{source_login}', target login doesn't exist or has no organism");
                }
                continue;
            }
        }

        let message_ts = match parse_naive_datetime(&row.message_ts) {
            Ok(ts) => ts,
            Err(err) => {
                failed += 1;
                error!(
                    "row {}{dry_run}: invalid message_ts '{}': {err}",
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
                "row {}{dry_run}: message not found within +/-15m for ts {} body={}",
                idx + 1,
                row.message_ts,
                format_body_sample(&row.body)
            );
            continue;
        };

        if let Some(existing) = sigint_comment::Entity::find()
            .filter(sigint_comment::Column::SignalMessageId.eq(message.id))
            .filter(sigint_comment::Column::Login.eq(login.clone()))
            .one(&dbx)
            .await
            .c(h!())?
        {
            skipped_existing += 1;
            if existing.comment.trim() == row.comment.trim() {
                info!(
                    "row {}{dry_run}: skipping message {} because same comment already exists",
                    idx + 1,
                    message.id
                );
            } else {
                info!(
                    "row {}{dry_run}: skipping message {} because another comment already exists for login {}",
                    idx + 1,
                    message.id,
                    login
                );
            }
            continue;
        }

        if ps.dry_run {
            inserted += 1;
            info!(
                "row {}{dry_run}: will import comment for message {} at {}",
                idx + 1,
                message.id,
                resolved_ts
            );
        } else {
            let active = sigint_comment::ActiveModel {
                id: NotSet,
                login: Set(login),
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
    }


    info!(
        "import completed{dry_run}: inserted {inserted}, skipped {skipped_existing}, excluded {excluded}, not_found {not_found}, not_mapped {not_mapped}, failed {failed}",
    );

    if !logins_to_map.is_empty() {
        let count = logins_to_map.len();
        for (org, login) in logins_to_map {
            let login_mapping = organism_login_mapping.entry(org).or_default();
            login_mapping.insert(login, "<TARGET LOGIN>".to_owned());
        }
        let json =
            serde_json::to_string_pretty(&organism_login_mapping).c(h!())?;

        warn!("{count} not mapped logins found");
        println!("missing mappings:\n{json}");
        println!("fill it and provide it with --organism_login_mapping <path to mapping.json>");
        println!("or exclude using --excluded-organisms <organism 1> <organism2> --excluded-logins <login 1> <login2> flags");
    }

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
    organism_ids: Vec<i64>,
) -> Result<HashMap<String, i64>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let logins = login::Entity::find()
        .filter(login::Column::OrganismId.is_in(organism_ids))
        .filter(login::Column::Deleted.eq(false))
        .filter(login::Column::DeletedPermanently.eq(false))
        .filter(login::Column::OrganismId.is_not_null())
        .select_only()
        .column(login::Column::Login)
        .column(login::Column::OrganismId)
        .into_tuple::<(String, i64)>()
        .all(txn)
        .await
        .c(h!())?;

    Ok(logins.into_iter().collect())
}

async fn find_best_message(
    dbx: &DatabaseConnection,
    body: &str,
    message_ts: NaiveDateTime,
) -> Result<Option<(signal_message::Model, NaiveDateTime)>, AppError> {
    let from_ts = message_ts - Duration::minutes(15);
    let to_ts = message_ts + Duration::minutes(15);
    let candidates = signal_message::Entity::find()
        .filter(signal_message::Column::Body.eq(body))
        .filter(message_time_condition(from_ts, to_ts))
        .filter(sigint_inbox_item::Column::Id.is_not_null())
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
