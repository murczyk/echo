use super::query::IdRow;
use crate::types::*;
use sea_orm::{
    ConnectionTrait, DatabaseBackend, DatabaseTransaction, FromQueryResult,
    Statement,
};

async fn delete_redirected(
    db: &DatabaseTransaction,
    rows: Vec<IdRow>,
) -> anyhow::Result<()> {
    let ids: Vec<_> = rows.into_iter().map(|row| row.id).collect();
    if !ids.is_empty() {
        db.execute_raw(Statement::from_sql_and_values(DatabaseBackend::Postgres,
            "delete from message_reply r where id = any($1) and not exists (select 1 from message_reply_source s where s.message_reply_id = r.id)",
            vec![ids.into()])).await.c(h!())?;
    }
    Ok(())
}

pub(super) async fn original(
    db: &DatabaseTransaction,
    datasource: i64,
    inbox: i64,
    original: i64,
) -> anyhow::Result<()> {
    db.execute_raw(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        r#"update message_reply r set original_signal_message_id = $3,
                original_deleted = sm.deleted, deleted = sm.deleted or r.reply_deleted
            from message_reply_source s, signal_message sm
            where sm.id = $3 and s.datasource_id = $1 and s.original_inbox_message_id = $2
                and s.message_reply_id = r.id and r.original_signal_message_id is distinct from $3
                and r.reply_signal_message_id is null"#,
        vec![datasource.into(), inbox.into(), original.into()])).await.c(h!())?;
    let redirected = IdRow::find_by_statement(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        r#"with candidates as (
            select distinct r.id, r.reply_signal_message_id, r.created_at, r.reply_deleted from message_reply_source s
            join message_reply r on r.id = s.message_reply_id
            where s.datasource_id = $1 and s.original_inbox_message_id = $2
                and r.original_signal_message_id is distinct from $3 and r.reply_signal_message_id is not null
                and r.reply_signal_message_id <> $3
        ), replacements as (
            insert into message_reply (original_signal_message_id, reply_signal_message_id, created_at, original_deleted, reply_deleted, deleted)
                select $3, c.reply_signal_message_id, min(c.created_at), sm.deleted, bool_or(c.reply_deleted), sm.deleted or bool_or(c.reply_deleted)
                from candidates c, signal_message sm where sm.id = $3 group by c.reply_signal_message_id, sm.deleted
                on conflict (original_signal_message_id, reply_signal_message_id) do update set
                    original_deleted = excluded.original_deleted,
                    reply_deleted = message_reply.reply_deleted or excluded.reply_deleted,
                    deleted = excluded.original_deleted or message_reply.reply_deleted or excluded.reply_deleted,
                    created_at = least(message_reply.created_at, excluded.created_at)
                returning id, reply_signal_message_id
        ) update message_reply_source s set message_reply_id = replacement.id
            from candidates c join replacements replacement on replacement.reply_signal_message_id = c.reply_signal_message_id
            where s.datasource_id = $1 and s.original_inbox_message_id = $2 and s.message_reply_id = c.id
            returning c.id"#,
        vec![datasource.into(), inbox.into(), original.into()])).all(db).await.c(h!())?;
    delete_redirected(db, redirected).await.c(h!())?;
    Ok(())
}

pub(super) async fn reply(
    db: &DatabaseTransaction,
    relation: i64,
    reply: i64,
    datasource: i64,
    inbox: i64,
) -> anyhow::Result<()> {
    let redirected = IdRow::find_by_statement(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        r#"with replacement as (
            insert into message_reply (original_signal_message_id, reply_signal_message_id, created_at, original_deleted, reply_deleted, deleted)
                select r.original_signal_message_id, $2, r.created_at, r.original_deleted, sm.deleted, r.original_deleted or sm.deleted
                from message_reply r, signal_message sm where r.id = $1 and sm.id = $2
                    and r.original_signal_message_id is distinct from $2 and r.reply_signal_message_id is distinct from $2
                on conflict (original_signal_message_id, reply_signal_message_id) do update set
                    original_deleted = message_reply.original_deleted or excluded.original_deleted,
                    reply_deleted = excluded.reply_deleted,
                    deleted = message_reply.original_deleted or excluded.original_deleted or excluded.reply_deleted,
                    created_at = least(message_reply.created_at, excluded.created_at)
                returning id
        ) update message_reply_source s set message_reply_id = replacement.id from replacement
            where s.datasource_id = $3 and s.inbox_message_id = $4 and s.message_reply_id = $1
            returning $1::bigint as id"#,
        vec![relation.into(), reply.into(), datasource.into(), inbox.into()])).all(db).await.c(h!())?;
    delete_redirected(db, redirected).await.c(h!())?;
    Ok(())
}
