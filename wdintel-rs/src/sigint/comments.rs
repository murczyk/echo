use crate::entities::*;
use crate::error::AppError;
use crate::h;
use crate::rer_importer::inbox::submit_bl;
use crate::rer_importer::types::InboxSubmitItem;
use crate::types::{error, info, warn};
use crate::types::{Mode, ShortContext};
use chrono::{DateTime, Duration, FixedOffset, NaiveDateTime, Utc};
use sea_orm::sea_query::{Expr, Value};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, Condition, ConnectionTrait, DatabaseBackend,
    DatabaseConnection, DatabaseTransaction, EntityTrait, ExprTrait,
    FromQueryResult, IntoActiveModel, JoinType, NotSet, PaginatorTrait,
    QueryFilter, QueryOrder, QuerySelect, RelationTrait, Set, Statement,
    TransactionTrait,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Debug, FromQueryResult)]
struct CommentExportRow {
    login: uuid::Uuid,
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

const SIGINT_COMMENT_MIGRATION_LOCK_KEY: i64 = 7_421_983_615;

#[derive(Clone, Debug)]
pub struct LinkedMessageComment {
    pub parent_signal_message_id: i64,
    pub signal_message_id: i64,
    pub comment: String,
    pub created_at: NaiveDateTime,
    pub login_id: Option<uuid::Uuid>,
    pub post_id: Option<i64>,
    pub legacy_comment_id: Option<i64>,
}

pub async fn find_linked_message_comments<C>(
    dbx: &C,
    parent_signal_message_ids: &[i64],
) -> Result<Vec<LinkedMessageComment>, AppError>
where
    C: ConnectionTrait,
{
    if parent_signal_message_ids.is_empty() {
        return Ok(vec![]);
    }

    let links = intel_prod::Entity::find()
        .filter(
            intel_prod::Column::ParentSignalMessageId
                .is_in(parent_signal_message_ids.to_vec()),
        )
        .filter(
            intel_prod::Column::RelationKind
                .eq(intel_prod::RELATION_KIND_COMMENT),
        )
        .order_by_asc(intel_prod::Column::CreatedAt)
        .order_by_asc(intel_prod::Column::SignalMessageId)
        .all(dbx)
        .await
        .c(h!())?;
    let child_ids = links
        .iter()
        .map(|link| link.signal_message_id)
        .collect::<Vec<_>>();

    let messages = if child_ids.is_empty() {
        HashMap::new()
    } else {
        signal_message::Entity::find()
            .filter(signal_message::Column::Id.is_in(child_ids.clone()))
            .filter(signal_message::Column::Deleted.eq(false))
            .all(dbx)
            .await
            .c(h!())?
            .into_iter()
            .map(|message| (message.id, message))
            .collect::<HashMap<_, _>>()
    };
    let inbox_items = if child_ids.is_empty() {
        HashMap::new()
    } else {
        sigint_inbox_item::Entity::find()
            .filter(sigint_inbox_item::Column::Id.is_in(child_ids))
            .all(dbx)
            .await
            .c(h!())?
            .into_iter()
            .map(|item| (item.id, item))
            .collect::<HashMap<_, _>>()
    };

    let mut comments = links
        .into_iter()
        .filter_map(|link| {
            let message = messages.get(&link.signal_message_id)?;
            let login_id = message
                .sender
                .as_deref()
                .and_then(|sender| uuid::Uuid::parse_str(sender).ok());
            Some(LinkedMessageComment {
                parent_signal_message_id: link.parent_signal_message_id,
                signal_message_id: message.id,
                comment: message.body.clone().unwrap_or_default(),
                created_at: message.created_at,
                login_id,
                post_id: inbox_items
                    .get(&message.id)
                    .and_then(|item| item.post_id),
                legacy_comment_id: None,
            })
        })
        .collect::<Vec<_>>();
    let legacy_comments = sigint_comment::Entity::find()
        .filter(
            sigint_comment::Column::SignalMessageId
                .is_in(parent_signal_message_ids.to_vec()),
        )
        .all(dbx)
        .await
        .c(h!())?;
    comments.extend(
        legacy_comments
            .into_iter()
            .filter(|comment| comment.migrated_signal_message_id.is_none())
            .map(|comment| LinkedMessageComment {
                parent_signal_message_id: comment.signal_message_id,
                signal_message_id: comment.id,
                comment: comment.comment,
                created_at: comment.created_at,
                login_id: Some(comment.login_id),
                post_id: comment.sigint_post_id,
                legacy_comment_id: Some(comment.id),
            }),
    );
    comments
        .sort_by_key(|comment| (comment.created_at, comment.signal_message_id));
    Ok(comments)
}

pub async fn create_linked_message_comment(
    env: &crate::types::Env,
    txn: &DatabaseTransaction,
    parent_signal_message_id: i64,
    login: &uuid::Uuid,
    logins: &[uuid::Uuid],
    comment: &str,
    created_at: Option<DateTime<Utc>>,
    post_id: Option<i64>,
) -> Result<i64, AppError> {
    let source_created_at = created_at.map(|created_at| created_at.naive_utc());
    let sender =
        crate::sigint::direct_submit::query::ensure_current_user_sender(
            txn, login,
        )
        .await
        .c(h!())?;
    let item = InboxSubmitItem {
        text: Some(comment.to_string()),
        full_body: None,
        timestamp: created_at.unwrap_or_else(Utc::now).to_rfc3339(),
        sender: Some(sender),
        parse_body_coordinates: false,
        ..Default::default()
    };
    let submitted = submit_bl::submit_inbox_item_with_groups_location_mode(
        env,
        txn,
        None,
        &[],
        login,
        &logins.to_vec(),
        item,
        true,
        true,
        crate::rer_importer::inbox::bl::InboxLocationSubmitMode::PreserveTyped,
    )
    .await
    .c(h!())?;

    if let Some(source_created_at) = source_created_at {
        let mut signal_message =
            signal_message::Entity::find_by_id(submitted.signal_message_id)
                .one(txn)
                .await
                .c(h!())?
                .ok_or(AppError::NotFound)?
                .into_active_model();
        signal_message.created_at = Set(source_created_at);
        signal_message.update(txn).await.c(h!())?;
    }

    intel_prod::ActiveModel {
        signal_message_id: Set(submitted.signal_message_id),
        parent_signal_message_id: Set(parent_signal_message_id),
        relation_kind: Set(intel_prod::RELATION_KIND_COMMENT),
        created_at: NotSet,
    }
    .insert(txn)
    .await
    .c(h!())?;

    if let Some(post_id) = post_id {
        let mut inbox_item =
            sigint_inbox_item::Entity::find_by_id(submitted.signal_message_id)
                .one(txn)
                .await
                .c(h!())?
                .ok_or_else(|| AppError::NotFound)?
                .into_active_model();
        inbox_item.post_id = Set(Some(post_id));
        inbox_item.update(txn).await.c(h!())?;
    }

    Ok(submitted.signal_message_id)
}

pub async fn oneoff_migrate_sigint_comments(
    mode: Mode,
    ps: &crate::OneoffMigrateSigintCommentsPs,
) -> Result<(), AppError> {
    if ps.batch_size == 0 {
        return Err(AppError::BL {
            msg: "batch_size must be greater than zero".to_string(),
        });
    }

    let env = crate::server::new_env(mode).await.c(h!())?;
    let batch_size = std::cmp::min(ps.batch_size, i64::MAX as u64);
    if ps.dry_run {
        let pending = sigint_comment::Entity::find()
            .filter(sigint_comment::Column::MigratedSignalMessageId.is_null())
            .count(&env.dbx)
            .await
            .c(h!())?;
        info!(
            "oneoff_migrate_sigint_comments_to_messages dry run: pending={pending}"
        );
        return Ok(());
    }
    let mut migrated = 0_u64;

    loop {
        let txn = env.dbx.begin().await.c(h!())?;
        lock_sigint_comment_migration(&txn).await.c(h!())?;
        let comments = load_pending_comments(&txn, batch_size).await.c(h!())?;
        if comments.is_empty() {
            txn.commit().await.c(h!())?;
            break;
        }

        let batch_count = comments.len() as u64;
        migrate_comment_batch(env.as_ref(), &txn, comments)
            .await
            .c(h!())?;
        migrated += batch_count;
        txn.commit().await.c(h!())?;
    }

    info!(
        "oneoff_migrate_sigint_comments_to_messages completed: processed={migrated} dry_run={}",
        ps.dry_run
    );
    Ok(())
}

async fn lock_sigint_comment_migration(
    txn: &DatabaseTransaction,
) -> Result<(), sea_orm::DbErr> {
    txn.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "select pg_advisory_xact_lock($1)",
        [SIGINT_COMMENT_MIGRATION_LOCK_KEY.into()],
    ))
    .await
    .map(|_| ())
}

async fn load_pending_comments<C>(
    dbx: &C,
    batch_size: u64,
) -> Result<Vec<sigint_comment::Model>, AppError>
where
    C: ConnectionTrait,
{
    Ok(sigint_comment::Entity::find()
        .filter(sigint_comment::Column::MigratedSignalMessageId.is_null())
        .order_by_asc(sigint_comment::Column::Id)
        .limit(batch_size)
        .all(dbx)
        .await
        .c(h!())?)
}

async fn migrate_comment_batch(
    env: &crate::types::Env,
    txn: &DatabaseTransaction,
    comments: Vec<sigint_comment::Model>,
) -> Result<(), AppError> {
    let mut links = Vec::with_capacity(comments.len());
    let mut migrated_comments = Vec::with_capacity(comments.len());
    let mut senders: HashMap<uuid::Uuid, String> = HashMap::new();

    for comment in comments {
        let sender = if let Some(sender) = senders.get(&comment.login_id) {
            sender.clone()
        } else {
            let sender =
                crate::sigint::direct_submit::query::ensure_current_user_sender(
                    txn,
                    &comment.login_id,
                )
                .await
                .c(h!())?;
            senders.insert(comment.login_id, sender.clone());
            sender
        };
        let author_logins = vec![comment.login_id];
        let timestamp = comment.created_at.and_utc().to_rfc3339();
        let item = InboxSubmitItem {
            text: Some(comment.comment.clone()),
            full_body: None,
            timestamp,
            sender: Some(sender),
            parse_body_coordinates: false,
            ..Default::default()
        };
        let submitted = submit_bl::submit_inbox_item_with_groups_location_mode(
            env,
            txn,
            None,
            &[],
            &comment.login_id,
            &author_logins,
            item,
            true,
            true,
            crate::rer_importer::inbox::bl::InboxLocationSubmitMode::PreserveTyped,
        )
        .await
        .c(h!())?;
        let mut signal_message =
            signal_message::Entity::find_by_id(submitted.signal_message_id)
                .one(txn)
                .await
                .c(h!())?
                .ok_or(AppError::NotFound)
                .c(h!())?
                .into_active_model();
        signal_message.created_at = Set(comment.created_at);
        signal_message.update(txn).await.c(h!())?;
        links.push(intel_prod::ActiveModel {
            signal_message_id: Set(submitted.signal_message_id),
            parent_signal_message_id: Set(comment.signal_message_id),
            relation_kind: Set(intel_prod::RELATION_KIND_COMMENT),
            created_at: NotSet,
        });
        migrated_comments.push((
            comment.id,
            submitted.signal_message_id,
            comment.sigint_post_id,
        ));
    }

    intel_prod::Entity::insert_many(links)
        .exec(txn)
        .await
        .c(h!())?;
    update_migrated_comment_posts(txn, &migrated_comments)
        .await
        .c(h!())?;
    update_migrated_comment_markers(txn, &migrated_comments)
        .await
        .c(h!())?;
    Ok(())
}

async fn update_migrated_comment_posts(
    txn: &DatabaseTransaction,
    migrated_comments: &[(i64, i64, Option<i64>)],
) -> Result<(), AppError> {
    let posts = migrated_comments
        .iter()
        .filter_map(|(_, signal_message_id, post_id)| {
            post_id.map(|post_id| (*signal_message_id, post_id))
        })
        .collect::<Vec<_>>();
    if posts.is_empty() {
        return Ok(());
    }

    let mut values = Vec::<Value>::with_capacity(posts.len() * 2);
    let cases = posts
        .iter()
        .enumerate()
        .map(|(index, (signal_message_id, post_id))| {
            let id_placeholder = index * 2 + 1;
            let post_placeholder = id_placeholder + 1;
            values.push((*signal_message_id).into());
            values.push((*post_id).into());
            format!("WHEN ${id_placeholder} THEN ${post_placeholder}")
        })
        .collect::<Vec<_>>();
    let ids = (0..posts.len())
        .map(|index| format!("${}", index * 2 + 1))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "UPDATE sigint_inbox_item SET post_id = CASE id {} ELSE post_id END WHERE id IN ({ids})",
        cases.join(" ")
    );
    txn.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        sql,
        values,
    ))
    .await
    .c(h!())?;
    Ok(())
}

async fn update_migrated_comment_markers(
    txn: &DatabaseTransaction,
    migrated_comments: &[(i64, i64, Option<i64>)],
) -> Result<(), AppError> {
    if migrated_comments.is_empty() {
        return Ok(());
    }

    let mut values = Vec::<Value>::with_capacity(migrated_comments.len() * 2);
    let cases = migrated_comments
        .iter()
        .enumerate()
        .map(|(index, (comment_id, signal_message_id, _))| {
            let comment_placeholder = index * 2 + 1;
            let message_placeholder = comment_placeholder + 1;
            values.push((*comment_id).into());
            values.push((*signal_message_id).into());
            format!("WHEN ${comment_placeholder} THEN ${message_placeholder}")
        })
        .collect::<Vec<_>>();
    let ids = (0..migrated_comments.len())
        .map(|index| format!("${}", index * 2 + 1))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "UPDATE sigint_comment SET migrated_signal_message_id = CASE id {} ELSE migrated_signal_message_id END WHERE id IN ({ids})",
        cases.join(" ")
    );
    txn.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        sql,
        values,
    ))
    .await
    .c(h!())?;
    Ok(())
}

pub async fn load_blacklist<C>(dbx: &C) -> Result<Vec<String>, AppError>
where
    C: ConnectionTrait,
{
    Ok(sigint_comment_blacklist::Entity::find()
        .select_only()
        .column(sigint_comment_blacklist::Column::Text)
        .into_tuple::<String>()
        .all(dbx)
        .await
        .c(h!())?)
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
            sigint_comment::Column::LoginId
                .is_in(logins.keys().cloned().clone()),
        )
        .filter(time_condition)
        .select_only()
        .column_as(sigint_comment::Column::LoginId, "login")
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
            source_login: row.login.to_string(),
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

const COMMENTED_MESSAGES_EXPORT_KIND_VALUES: &[&str] = &[
    "echo-comments",
    "goi-associations",
    "mapped-goi-association",
];

#[derive(Debug, FromQueryResult)]
struct EchoCommentedMessageExportRow {
    source_login: String,
    source_organism: Option<String>,
    comment: String,
    body: Option<String>,
    message_created_at: NaiveDateTime,
    message_timestamp: Option<NaiveDateTime>,
    inbox_datetime: Option<NaiveDateTime>,
}

#[derive(Debug)]
struct SignalMessageExportSource {
    id: i64,
    body: String,
    message_ts: NaiveDateTime,
}

pub async fn oneoff_export_commented_messages(
    mode: Mode,
    ps: &crate::OneoffExportCommentedMessagesPs,
) -> Result<(), AppError> {
    let Some(kind) = ps.kind else {
        print_commented_messages_kind_values();
        return Ok(());
    };
    let since_ts = parse_naive_datetime(&ps.since_ts)?;
    let till_ts = parse_naive_datetime(&ps.till_ts)?;
    if since_ts >= till_ts {
        return Err(AppError::BL {
            msg: format!(
                "since_ts must be older than till_ts: since_ts={since_ts}, till_ts={till_ts}"
            ),
        });
    }

    info!(
        "starting oneoff_export_commented_messages kind={:?} since_ts={} till_ts={} output={}",
        kind, ps.since_ts, ps.till_ts, ps.output
    );
    let dbx = crate::new_pg_pool_from_mode(mode).await.c(h!())?;
    let rows = match kind {
        crate::OneoffExportCommentedMessagesKind::EchoComments => {
            load_echo_commented_message_rows(&dbx, since_ts, till_ts).await?
        }
        crate::OneoffExportCommentedMessagesKind::GoiAssociations => {
            load_goi_association_comment_rows(&dbx, since_ts, till_ts).await?
        }
        crate::OneoffExportCommentedMessagesKind::MappedGoiAssociation => {
            load_mapped_goi_association_comment_rows(&dbx, since_ts, till_ts)
                .await?
        }
    };
    write_comment_csv_rows(&ps.output, rows)?;
    Ok(())
}

fn print_commented_messages_kind_values() {
    println!("possible values for --kind:");
    for value in COMMENTED_MESSAGES_EXPORT_KIND_VALUES {
        println!("  {value}");
    }
}

async fn load_echo_commented_message_rows(
    dbx: &DatabaseConnection,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
) -> Result<Vec<CommentCsvRow>, AppError> {
    let system_login_id = crate::users::system_login_id(dbx).await.c(h!())?;
    let rows: Vec<EchoCommentedMessageExportRow> =
        sigint_comment::Entity::find()
            .join(
                JoinType::InnerJoin,
                sigint_comment::Relation::SignalMessage.def(),
            )
            .join(
                JoinType::InnerJoin,
                signal_message::Relation::SigintInboxItem.def(),
            )
            .join(JoinType::InnerJoin, sigint_comment::Relation::Login.def())
            .join(JoinType::LeftJoin, login::Relation::Organism.def())
            .filter(sigint_comment::Column::LoginId.ne(system_login_id))
            .filter(sigint_comment::Column::Comment.ne(""))
            .filter(sigint_comment::Column::CreatedAt.gte(since_ts))
            .filter(sigint_comment::Column::CreatedAt.lt(till_ts))
            .select_only()
            .column(sigint_comment::Column::Comment)
            .column_as(
                Expr::col((login::Entity, login::Column::Login)),
                "source_login",
            )
            .column_as(
                Expr::col((organism::Entity, organism::Column::Name)),
                "source_organism",
            )
            .column_as(
                Expr::col((
                    signal_message::Entity,
                    signal_message::Column::Body,
                )),
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
            .order_by_asc(sigint_comment::Column::Id)
            .into_model::<EchoCommentedMessageExportRow>()
            .all(dbx)
            .await
            .c(h!())?;

    let mut csv_rows = Vec::new();
    let mut skipped = 0_usize;
    for row in rows {
        let Some(comment) = non_empty_text(Some(row.comment.as_str())) else {
            skipped += 1;
            continue;
        };
        let Some(body) = non_empty_text(row.body.as_deref()) else {
            skipped += 1;
            continue;
        };
        let message_ts = resolve_message_ts(
            row.inbox_datetime,
            row.message_timestamp,
            row.message_created_at,
        );
        csv_rows.push(CommentCsvRow {
            body,
            comment,
            message_ts: format_export_ts(message_ts),
            source_login: row.source_login,
            source_organism: row.source_organism.unwrap_or_default(),
        });
    }
    info!(
        "prepared {} echo comment rows (skipped {})",
        csv_rows.len(),
        skipped
    );
    Ok(csv_rows)
}

async fn load_goi_association_comment_rows(
    dbx: &DatabaseConnection,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
) -> Result<Vec<CommentCsvRow>, AppError> {
    let associations = load_goi_associations_with_notes(dbx, since_ts, till_ts)
        .await
        .c(h!())?;
    let message_uids = association_message_uids(&associations);
    let messages = load_signal_messages_by_uid(dbx, message_uids)
        .await
        .c(h!())?;
    let mut csv_rows = Vec::new();
    let mut skipped = 0_usize;
    for (association, organism) in associations {
        let Some(comment) = goi_association_row_text(
            &association.row,
            association.note.as_deref(),
        ) else {
            skipped += 1;
            continue;
        };
        let Some((body, message_ts)) =
            goi_association_export_message(&association, &messages)
        else {
            skipped += 1;
            continue;
        };
        csv_rows.push(CommentCsvRow {
            body,
            comment,
            message_ts: format_export_ts(message_ts),
            source_login: association.author.unwrap_or_default(),
            source_organism: organism
                .map(|organism| organism.name)
                .unwrap_or_default(),
        });
    }
    info!(
        "prepared {} goi association comment rows (skipped {})",
        csv_rows.len(),
        skipped
    );
    Ok(csv_rows)
}

fn association_message_uids(
    associations: &[(goi_association::Model, Option<organism::Model>)],
) -> Vec<String> {
    associations
        .iter()
        .filter_map(|(association, _)| association.message_uid.clone())
        .filter(|message_uid| !message_uid.trim().is_empty())
        .collect()
}

fn goi_association_export_message(
    association: &goi_association::Model,
    messages: &HashMap<String, SignalMessageExportSource>,
) -> Option<(String, NaiveDateTime)> {
    if let Some(message_uid) = association
        .message_uid
        .as_deref()
        .and_then(|message_uid| non_empty_text(Some(message_uid)))
    {
        return messages.get(&message_uid).and_then(|message| {
            non_empty_text(Some(&message.body))
                .map(|body| (body, message.message_ts))
        });
    }
    goi_association_original_message_for_export(&association.row)
        .map(|body| (body, goi_association_message_ts(association)))
}

fn goi_association_original_message_for_export(
    row: &serde_json::Value,
) -> Option<String> {
    crate::organism::goi::message_uid::association_original_message(row)
        .and_then(|body| goi_association_row_text(row, Some(body)))
}

fn goi_association_row_text(
    row: &serde_json::Value,
    value: Option<&str>,
) -> Option<String> {
    let value = value?;
    if goi_echo_worker::row::association_excel_text_is_unescaped(row) {
        return non_empty_text(Some(value));
    }
    let value = goi_echo_worker::row::unescape_excel_text(value);
    non_empty_text(Some(&value))
}

async fn load_mapped_goi_association_comment_rows(
    dbx: &DatabaseConnection,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
) -> Result<Vec<CommentCsvRow>, AppError> {
    let associations = load_goi_associations_with_notes(dbx, since_ts, till_ts)
        .await
        .c(h!())?;
    let message_uids = association_message_uids(&associations);
    let messages = load_signal_messages_by_uid(dbx, message_uids)
        .await
        .c(h!())?;

    let mut csv_rows = Vec::new();
    let mut skipped = 0_usize;
    for (association, organism) in associations {
        let Some(comment) = goi_association_row_text(
            &association.row,
            association.note.as_deref(),
        ) else {
            skipped += 1;
            continue;
        };
        let Some(message_uid) = association
            .message_uid
            .as_deref()
            .and_then(|message_uid| non_empty_text(Some(message_uid)))
        else {
            skipped += 1;
            continue;
        };
        let Some(message) = messages.get(&message_uid) else {
            skipped += 1;
            continue;
        };
        let Some(body) = non_empty_text(Some(&message.body)) else {
            skipped += 1;
            continue;
        };
        csv_rows.push(CommentCsvRow {
            body,
            comment,
            message_ts: format_export_ts(message.message_ts),
            source_login: association.author.unwrap_or_default(),
            source_organism: organism
                .map(|organism| organism.name)
                .unwrap_or_default(),
        });
    }
    info!(
        "prepared {} mapped goi association comment rows (skipped {})",
        csv_rows.len(),
        skipped
    );
    Ok(csv_rows)
}

async fn load_goi_associations_with_notes(
    dbx: &DatabaseConnection,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
) -> Result<Vec<(goi_association::Model, Option<organism::Model>)>, AppError> {
    let since_ts = fixed_offset_utc(since_ts);
    let till_ts = fixed_offset_utc(till_ts);
    Ok(goi_association::Entity::find()
        .filter(goi_association::Column::Deleted.eq(false))
        .filter(goi_association::Column::SourceCreatedAt.gte(since_ts))
        .filter(goi_association::Column::SourceCreatedAt.lt(till_ts))
        .filter(goi_association::Column::Note.is_not_null())
        .filter(goi_association::Column::Note.ne(""))
        .find_also_related(organism::Entity)
        .order_by_asc(goi_association::Column::SourceCreatedAt)
        .order_by_asc(goi_association::Column::Id)
        .all(dbx)
        .await
        .c(h!())?)
}

async fn load_signal_messages_by_uid(
    dbx: &DatabaseConnection,
    mut message_uids: Vec<String>,
) -> Result<HashMap<String, SignalMessageExportSource>, AppError> {
    message_uids.sort();
    message_uids.dedup();
    let mut messages: HashMap<String, SignalMessageExportSource> =
        HashMap::new();
    for chunk in message_uids.chunks(1_000) {
        let rows = signal_message::Entity::find()
            .filter(signal_message::Column::MessageUid.is_in(chunk.to_vec()))
            .filter(signal_message::Column::MessageUid.is_not_null())
            .filter(signal_message::Column::MessageUid.ne(""))
            .filter(sigint_inbox_item::Column::Id.is_not_null())
            .find_also_related(sigint_inbox_item::Entity)
            .all(dbx)
            .await
            .c(h!())?;
        for (message, inbox_item) in rows {
            let Some(message_uid) = message
                .message_uid
                .as_deref()
                .and_then(|message_uid| non_empty_text(Some(message_uid)))
            else {
                continue;
            };
            let Some(body) = non_empty_text(message.body.as_deref()) else {
                continue;
            };
            let message_ts = resolve_message_ts(
                inbox_item.and_then(|inbox_item| inbox_item.datetime),
                message.timestamp,
                message.created_at,
            );
            let source = SignalMessageExportSource {
                id: message.id,
                body,
                message_ts,
            };
            let should_replace =
                messages.get(&message_uid).is_none_or(|current| {
                    (source.message_ts, source.id)
                        > (current.message_ts, current.id)
                });
            if should_replace {
                messages.insert(message_uid, source);
            }
        }
    }
    Ok(messages)
}

fn write_comment_csv_rows(
    output: &str,
    rows: Vec<CommentCsvRow>,
) -> Result<(), AppError> {
    let mut writer = csv::Writer::from_path(output).c(h!())?;
    let mut exported = 0_usize;
    for row in rows {
        writer.serialize(&row).c(h!())?;
        exported += 1;
    }
    writer.flush().c(h!())?;
    info!("export completed: exported {exported} comments to {output}");
    Ok(())
}

fn non_empty_text(value: Option<&str>) -> Option<String> {
    let value = value?;
    (!value.trim().is_empty()).then(|| value.to_string())
}

fn format_export_ts(ts: NaiveDateTime) -> String {
    ts.format("%Y-%m-%dT%H:%M:%S").to_string()
}

fn goi_association_message_ts(
    association: &goi_association::Model,
) -> NaiveDateTime {
    association
        .source_date
        .as_ref()
        .unwrap_or(&association.source_created_at)
        .with_timezone(&Utc)
        .naive_utc()
}

fn fixed_offset_utc(ts: NaiveDateTime) -> DateTime<FixedOffset> {
    DateTime::<Utc>::from_naive_utc_and_offset(ts, Utc).fixed_offset()
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
                        msg: format!(
                            "target login organism not found or deleted: {target_organism_id}"
                        ),
                    });
                };

                info!(
                    "loaded mapping '{source_organism}/{source_login}' to '{target_organism}/{target_login}'"
                );
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
        let login_name: String;
        let organism_mapping = organism_login_mapping
            .entry(source_organism.clone())
            .or_default();

        if let Some(target_login) = organism_mapping.get(&row.source_login) {
            login_name = target_login.clone();
        } else if let Some(target_organism_id) =
            login_to_organism_id.get(&row.source_login)
        {
            let target_login = source_login.clone();
            login_name = target_login.clone();
            let target_organism = &organisms[target_organism_id];

            info!(
                "detected mapping{dry_run} '{source_organism}/{source_login}' to '{target_organism}/{target_login}'"
            );
            organism_mapping.insert(source_login.clone(), target_login);
        } else {
            not_mapped += 1;
            if logins_to_map.insert((source_organism, source_login)) {
                let source_organism = &row.source_organism;
                let source_login = &row.source_login;
                error!(
                    "missing mapping{dry_run} for '{source_organism}/{source_login}', target login doesn't exist or has no organism"
                );
            }
            continue;
        }

        let login = crate::users::login_id_by_name(&dbx, &login_name).await?;
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
            .filter(sigint_comment::Column::LoginId.eq(login))
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
                login_id: Set(login),
                signal_message_id: Set(message.id),
                comment: Set(row.comment.clone()),
                created_at: NotSet,
                sigint_post_id: NotSet,
                migrated_signal_message_id: NotSet,
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
        println!(
            "fill it and provide it with --organism_login_mapping <path to mapping.json>"
        );
        println!(
            "or exclude using --excluded-organisms <organism 1> <organism2> --excluded-logins <login 1> <login2> flags"
        );
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
) -> Result<HashMap<uuid::Uuid, i64>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let logins = login::Entity::find()
        .filter(login::Column::OrganismId.is_in(organism_ids))
        .filter(login::Column::Deleted.eq(false))
        .filter(login::Column::DeletedPermanently.eq(false))
        .filter(login::Column::OrganismId.is_not_null())
        .select_only()
        .column(login::Column::Id)
        .column(login::Column::OrganismId)
        .into_tuple::<(uuid::Uuid, i64)>()
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
    let exact_candidates =
        load_import_message_candidates(dbx, Some(body), from_ts, to_ts)
            .await
            .c(h!())?;
    if let Some(message) = select_best_message(exact_candidates, message_ts) {
        return Ok(Some(message));
    }

    let candidates = load_import_message_candidates(dbx, None, from_ts, to_ts)
        .await
        .c(h!())?;
    let candidates = candidates
        .into_iter()
        .filter(|(message, _)| {
            message.body.as_deref().is_some_and(|candidate_body| {
                crate::organism::goi::message_uid::message_bodies_equal(
                    body,
                    candidate_body,
                )
            })
        })
        .collect();
    Ok(select_best_message(candidates, message_ts))
}

async fn load_import_message_candidates(
    dbx: &DatabaseConnection,
    body: Option<&str>,
    from_ts: NaiveDateTime,
    to_ts: NaiveDateTime,
) -> Result<
    Vec<(signal_message::Model, Option<sigint_inbox_item::Model>)>,
    AppError,
> {
    let mut query = signal_message::Entity::find()
        .filter(message_time_condition(from_ts, to_ts))
        .filter(sigint_inbox_item::Column::Id.is_not_null());
    if let Some(body) = body {
        query = query.filter(signal_message::Column::Body.eq(body));
    }
    Ok(query
        .find_also_related(sigint_inbox_item::Entity)
        .all(dbx)
        .await
        .c(h!())?)
}

fn select_best_message(
    candidates: Vec<(signal_message::Model, Option<sigint_inbox_item::Model>)>,
    message_ts: NaiveDateTime,
) -> Option<(signal_message::Model, NaiveDateTime)> {
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

    best.map(|(message, resolved_ts, _)| (message, resolved_ts))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn goi_association_original_message_for_export_unescapes_excel_body() {
        let mut cells = vec![
            serde_json::Value::Null;
            crate::config::ORGANISM_GOI_ORIGINAL_MESSAGE_CELL_INDEX
        ];
        cells.push(serde_json::json!({
            "kind": "string",
            "value": "first_x000d_\nsecond_x000A_third",
        }));
        let row = serde_json::json!({ "cells": cells });

        assert_eq!(
            goi_association_original_message_for_export(&row),
            Some("first\nsecond\nthird".to_string())
        );
    }

    #[test]
    fn goi_association_original_message_preserves_normalized_excel_token() {
        let mut cells = vec![
            serde_json::Value::Null;
            crate::config::ORGANISM_GOI_ORIGINAL_MESSAGE_CELL_INDEX
        ];
        cells.push(serde_json::json!({
            "kind": "string",
            "value": "literal _x0041_ token",
        }));
        let row = serde_json::json!({
            "cells": cells,
            "excel_text_unescaped": true,
        });

        assert_eq!(
            goi_association_original_message_for_export(&row),
            Some("literal _x0041_ token".to_string())
        );
    }
}
