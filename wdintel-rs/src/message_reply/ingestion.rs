use super::query::IdRow;
use crate::types::*;
use sea_orm::{
    ConnectionTrait, DatabaseBackend, DatabaseTransaction, FromQueryResult,
    Statement,
};

#[derive(FromQueryResult)]
struct SourceRow {
    original_inbox_message_id: Option<i64>,
    original_outbox_message_id: Option<i64>,
    deleted: bool,
}

pub async fn stage_source<C: ConnectionTrait>(
    db: &C,
    datasource_id: i64,
    message: &echo_im::types::MessageF1,
) -> anyhow::Result<bool> {
    let mut original_inbox = None;
    let mut original_outbox = None;
    if let Some(reply) = &message.reply_to {
        let prefix = if reply.is_outbox_message {
            "instance:id:"
        } else {
            "inbox-id:"
        };
        let id = reply
            .receipt
            .strip_prefix(prefix)
            .c(h!())?
            .parse::<i64>()
            .c(h!())?;
        anyhow::ensure!(id > 0, "Invalid Echo IM reply receipt");
        if reply.is_outbox_message {
            original_outbox = Some(id);
        } else {
            original_inbox = Some(id);
        }
    }
    let result = db.execute_raw(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        r#"insert into message_reply_source (datasource_id, inbox_message_id, original_inbox_message_id, original_outbox_message_id, deleted)
            values ($1, $2, $3, $4, $5)
            on conflict (datasource_id, inbox_message_id) do update set
                original_inbox_message_id = coalesce(message_reply_source.original_inbox_message_id, excluded.original_inbox_message_id),
                original_outbox_message_id = coalesce(message_reply_source.original_outbox_message_id, excluded.original_outbox_message_id),
                deleted = excluded.deleted
            where (message_reply_source.original_inbox_message_id is null and excluded.original_inbox_message_id is not null)
                or (message_reply_source.original_outbox_message_id is null and excluded.original_outbox_message_id is not null)
                or message_reply_source.deleted is distinct from excluded.deleted"#,
        vec![datasource_id.into(), (message.internal_id as i64).into(), original_inbox.into(), original_outbox.into(), message.deleted.into()])).await.c(h!())?;
    Ok(result.rows_affected() > 0)
}

pub async fn record_source(
    db: &DatabaseTransaction,
    datasource_id: i64,
    inbox_message_id: i64,
    signal_message_id: i64,
) -> anyhow::Result<()> {
    super::lock_threads(db).await.c(h!())?;
    let source = SourceRow::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"select s.original_inbox_message_id, s.original_outbox_message_id, s.deleted or coalesce(e.deleted, false) as deleted
            from message_reply_source s left join echo_inbox_message e on e.id = s.inbox_message_id
            where s.datasource_id = $2 and s.inbox_message_id = $1
        union all
        select reply_to_inbox_message_id::bigint, reply_to_outbox_message_id::bigint, deleted
            from echo_inbox_message where id = $1 limit 1"#,
        vec![inbox_message_id.into(), datasource_id.into()],
    )).one(db).await.c(h!())?;
    let Some(source) = source else {
        return Ok(());
    };
    let mut lock_ids = vec![inbox_message_id];
    lock_ids.extend(source.original_inbox_message_id);
    lock_ids.sort_unstable();
    lock_ids.dedup();
    for id in lock_ids {
        db.query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "select pg_advisory_xact_lock(hashtextextended($1, 0))",
            vec![format!("message-reply:{datasource_id}:{id}").into()],
        ))
        .await
        .c(h!())?;
    }
    db.execute_raw(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        r#"insert into message_reply_source (datasource_id, inbox_message_id, signal_message_id, original_inbox_message_id, original_outbox_message_id, deleted)
            values ($1, $2, $3, $4, $5, $6)
            on conflict (datasource_id, inbox_message_id) do update set signal_message_id = excluded.signal_message_id,
                original_inbox_message_id = coalesce(message_reply_source.original_inbox_message_id, excluded.original_inbox_message_id),
                original_outbox_message_id = coalesce(message_reply_source.original_outbox_message_id, excluded.original_outbox_message_id),
                deleted = excluded.deleted"#,
        vec![datasource_id.into(), inbox_message_id.into(), signal_message_id.into(), source.original_inbox_message_id.into(), source.original_outbox_message_id.into(), source.deleted.into()]))
        .await.c(h!())?;
    if source.original_inbox_message_id.is_some()
        || source.original_outbox_message_id.is_some()
    {
        record_reply(
            db,
            datasource_id,
            inbox_message_id,
            signal_message_id,
            &source,
        )
        .await
        .c(h!())?;
    }
    super::relink::original(
        db,
        datasource_id,
        inbox_message_id,
        signal_message_id,
    )
    .await
    .c(h!())?;
    Ok(())
}

async fn record_reply(
    db: &DatabaseTransaction,
    datasource_id: i64,
    inbox_message_id: i64,
    signal_message_id: i64,
    source: &SourceRow,
) -> anyhow::Result<()> {
    let original =
        resolve_original(db, datasource_id, source.original_inbox_message_id)
            .await
            .c(h!())?;
    let existing = IdRow::find_by_statement(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        r#"select message_reply_id as id from message_reply_source where datasource_id = $1 and message_reply_id is not null
            and (inbox_message_id = $2 or (original_inbox_message_id is not distinct from $3
                and original_outbox_message_id is not distinct from $4 and signal_message_id = $5))
            order by (inbox_message_id = $2) desc, inbox_message_id limit 1"#,
        vec![datasource_id.into(), inbox_message_id.into(), source.original_inbox_message_id.into(), source.original_outbox_message_id.into(), signal_message_id.into()])).one(db).await.c(h!())?;
    if let Some(existing) = existing {
        db.execute_raw(Statement::from_sql_and_values(DatabaseBackend::Postgres,
            "update message_reply_source set message_reply_id = $3 where datasource_id = $1 and inbox_message_id = $2",
            vec![datasource_id.into(), inbox_message_id.into(), existing.id.into()])).await.c(h!())?;
        super::relink::reply(
            db,
            existing.id,
            signal_message_id,
            datasource_id,
            inbox_message_id,
        )
        .await
        .c(h!())?;
        if let (Some(receipt), Some(original)) =
            (source.original_inbox_message_id, original)
        {
            super::relink::original(db, datasource_id, receipt, original)
                .await
                .c(h!())?;
        }
        return Ok(());
    }
    let original_id = original.filter(|id| *id != signal_message_id);
    #[derive(FromQueryResult)]
    struct DeletedRow {
        deleted: bool,
    }
    let deleted = DeletedRow::find_by_statement(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        r#"select exists(select 1 from echo_inbox_message where id = $1 and deleted)
            or exists(select 1 from signal_message where id = $2 and deleted)
            or exists(select 1 from message_reply_source where datasource_id = $3 and inbox_message_id = $1 and deleted) as deleted"#,
        vec![source.original_inbox_message_id.into(), original_id.into(), datasource_id.into()])).one(db).await.c(h!())?.c(h!())?;
    let id = super::insert(
        db,
        original_id,
        signal_message_id,
        deleted.deleted,
        source.deleted,
    )
    .await
    .c(h!())?;
    if original_id.is_none() {
        inherit_unresolved_thread(
            db,
            id,
            datasource_id,
            source,
            signal_message_id,
        )
        .await
        .c(h!())?;
    }
    db.execute_raw(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "update message_reply_source set message_reply_id = $3 where datasource_id = $1 and inbox_message_id = $2",
        vec![datasource_id.into(), inbox_message_id.into(), id.into()])).await.c(h!())?;
    Ok(())
}

async fn inherit_unresolved_thread(
    db: &DatabaseTransaction,
    relation: i64,
    datasource: i64,
    source: &SourceRow,
    reply: i64,
) -> anyhow::Result<()> {
    let (column, receipt) = match source.original_inbox_message_id {
        Some(receipt) => ("original_inbox_message_id", receipt),
        None => (
            "original_outbox_message_id",
            source.original_outbox_message_id.c(h!())?,
        ),
    };
    db.execute_raw(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        format!(r#"update message_reply r set original_signal_message_id = parent.original_signal_message_id,
                original_deleted = parent.original_deleted, thread_id = parent.thread_id,
                deleted = parent.original_deleted or r.reply_deleted
            from (
                select related.original_signal_message_id, related.original_deleted, related.thread_id
                    from message_reply_source s join message_reply related on related.id = s.message_reply_id
                where s.datasource_id = $2 and s.{column} = $3 and related.id <> $1
                    and related.original_signal_message_id is distinct from $4
                order by related.created_at, related.id limit 1
            ) parent where r.id = $1"#),
        vec![relation.into(), datasource.into(), receipt.into(), reply.into()])).await.c(h!())?;
    Ok(())
}

async fn resolve_original(
    db: &DatabaseTransaction,
    datasource: i64,
    inbox: Option<i64>,
) -> anyhow::Result<Option<i64>> {
    let Some(inbox) = inbox else { return Ok(None) };
    Ok(IdRow::find_by_statement(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        r#"select id from (
        select signal_message_id as id, 0 as priority from message_reply_source
            where datasource_id = $1 and inbox_message_id = $2 and signal_message_id is not null
        union all
        select sm.id, 1 as priority from signal_message sm join datasource_group dg on dg.id = sm.datasource_group_id
            where dg.datasource_id = $1 and sm.echo_inbox_message_id = $2 and not sm.deleted
        ) candidates order by priority, id limit 1"#,
        vec![datasource.into(), inbox.into()])).one(db).await.c(h!())?.map(|row| row.id))
}
