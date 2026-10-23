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
    let changed = db.query_all_raw(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        r#"select r.id from message_reply_source s join message_reply r on r.id = s.message_reply_id
            where s.datasource_id = $1 and s.original_inbox_message_id = $2
                and r.engaged_message_id is distinct from nullif($3, r.reply_signal_message_id)
            order by r.id for update of r"#,
        vec![datasource.into(), inbox.into(), original.into()])).await.c(h!())?;
    if changed.is_empty() {
        return Ok(());
    }
    original_tombstones(db, datasource, inbox, original)
        .await
        .c(h!())?;
    let redirected = IdRow::find_by_statement(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        r#"with candidates as (
            select distinct r.id, r.reply_signal_message_id, r.created_at, r.reply_deleted from message_reply_source s
            join message_reply r on r.id = s.message_reply_id
            where s.datasource_id = $1 and s.original_inbox_message_id = $2
                and r.engaged_message_id is distinct from nullif($3, r.reply_signal_message_id)
                and r.reply_signal_message_id is not null
        ), replacements as (
            insert into message_reply (engaged_message_id, reply_signal_message_id, created_at, original_deleted, reply_deleted, deleted)
                select nullif($3, c.reply_signal_message_id), c.reply_signal_message_id, min(c.created_at), sm.deleted, bool_or(c.reply_deleted), sm.deleted or bool_or(c.reply_deleted)
                from candidates c, signal_message sm where sm.id = $3 group by c.reply_signal_message_id, sm.deleted
                on conflict (reply_signal_message_id) do update set engaged_message_id = excluded.engaged_message_id,
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

async fn original_tombstones(
    db: &DatabaseTransaction,
    datasource: i64,
    inbox: i64,
    original: i64,
) -> anyhow::Result<()> {
    let redirected = IdRow::find_by_statement(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        r#"with candidates as (
            select r.id as previous, nextval(pg_get_serial_sequence('message_reply', 'id')) as replacement,
                r.created_at, r.reply_deleted
            from message_reply r where r.reply_signal_message_id is null
                and r.engaged_message_id is distinct from $3
                and exists(select 1 from message_reply_source s where s.message_reply_id = r.id
                    and s.datasource_id = $1 and s.original_inbox_message_id = $2)
        ), replacements as (
            insert into message_reply (id, engaged_message_id, created_at, original_deleted, reply_deleted, deleted)
                select c.replacement, $3, c.created_at, sm.deleted, c.reply_deleted, sm.deleted or c.reply_deleted
                from candidates c, signal_message sm where sm.id = $3 returning id
        ) update message_reply_source s set message_reply_id = c.replacement
            from candidates c join replacements replacement on replacement.id = c.replacement
            where s.datasource_id = $1 and s.original_inbox_message_id = $2 and s.message_reply_id = c.previous
            returning c.previous as id"#,
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
    db.query_one_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "select id from message_reply where id = $1 for update",
        vec![relation.into()],
    ))
    .await
    .c(h!())?;
    let redirected = IdRow::find_by_statement(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        r#"with replacement as (
            insert into message_reply (engaged_message_id, reply_signal_message_id, created_at, original_deleted, reply_deleted, deleted)
                select nullif(r.engaged_message_id, $2), $2, r.created_at, r.original_deleted, sm.deleted, r.original_deleted or sm.deleted
                from message_reply r, signal_message sm where r.id = $1 and sm.id = $2
                    and r.reply_signal_message_id is distinct from $2
                on conflict (reply_signal_message_id) do update set engaged_message_id = excluded.engaged_message_id,
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
