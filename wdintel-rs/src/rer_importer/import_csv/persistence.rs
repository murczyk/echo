use super::*;
use crate::config::{
    RER_CSV_IMPORT_IDENTITY_LOCK_NAMESPACE,
    RER_CSV_IMPORT_PROCESSING_LOCK_NAMESPACE,
};

#[derive(Debug, Clone, Copy)]
pub(super) enum RerCsvPersistence {
    Inserted(i64),
    Duplicate(i64),
    Reused(i64),
}

impl RerCsvPersistence {
    pub(super) fn message_id(self) -> i64 {
        match self {
            Self::Inserted(id) | Self::Duplicate(id) | Self::Reused(id) => id,
        }
    }
}

#[derive(FromQueryResult)]
struct ExistingCsvMessage {
    id: i64,
    tracked: bool,
    completed: bool,
    has_inbox: bool,
}

async fn begin_csv_transaction(
    dbx: &DatabaseConnection,
) -> anyhow::Result<DatabaseTransaction> {
    dbx.begin_with_config(Some(IsolationLevel::ReadCommitted), None)
        .await
        .c(h!())
}

async fn lock_csv_identity(
    txn: &DatabaseTransaction,
    group_id: &str,
    body: &str,
) -> anyhow::Result<()> {
    txn.execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "select pg_advisory_xact_lock(hashtextextended(jsonb_build_array($1::text, $2::text, md5($3::text))::text, 0))",
        [RER_CSV_IMPORT_IDENTITY_LOCK_NAMESPACE.into(), group_id.into(), body.into()],
    ))
    .await
    .c(h!())?;
    Ok(())
}

async fn find_existing_csv_message(
    txn: &DatabaseTransaction,
    group_id: &str,
    body: &str,
) -> anyhow::Result<Option<ExistingCsvMessage>> {
    ExistingCsvMessage::find_by_statement(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"
select m.id, p.message_id is not null as tracked,
       p.completed_at is not null as completed,
       exists(select 1 from sigint_inbox_item i
              where i.id = m.id or i.id = any(p.inbox_item_ids)) as has_inbox
from signal_message m
left join rer_csv_import_message p on p.message_id = m.id
where md5(m.body) = md5($1::text) and m.body = $1
  and (m.deleted = false or exists(
      select 1 from signal_message child
      join sigint_inbox_item i on i.id = child.id
      where child.id = any(p.inbox_item_ids) and child.id <> m.id
        and child.deleted = false))
  and exists(select 1 from signal_message_group g
             where g.signal_message_id = m.id and g.group_master_key = $2)
order by completed desc, has_inbox desc, tracked, m.id
limit 1
        "#,
        [body.into(), group_id.into()],
    ))
    .one(txn)
    .await
    .c(h!())
}

async fn track_csv_message(
    context: &RerCsvImportContext<'_>,
    txn: &DatabaseTransaction,
    message_id: i64,
) -> anyhow::Result<()> {
    txn.execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "insert into rer_csv_import_message (message_id, reference_time, import_as_new) values ($1, $2, $3) on conflict (message_id) do nothing",
        [message_id.into(), context.lnow.naive_utc().into(), context.import_as_new.into()],
    ))
    .await
    .c(h!())?;
    Ok(())
}

pub(super) async fn persist_rer_csv_message(
    context: &RerCsvImportContext<'_>,
    body: String,
    timestamp: NaiveDateTime,
) -> anyhow::Result<RerCsvPersistence> {
    let txn = begin_csv_transaction(context.dbx).await.context(h!())?;
    let outcome = if context.reconcile_target_group {
        lock_csv_identity(&txn, &context.group_id, &body)
            .await
            .context(h!())?;
        match find_existing_csv_message(&txn, &context.group_id, &body)
            .await
            .context(h!())?
        {
            Some(message)
                if message.completed
                    || (!message.tracked && message.has_inbox) =>
            {
                RerCsvPersistence::Duplicate(message.id)
            }
            Some(message) => {
                track_csv_message(context, &txn, message.id)
                    .await
                    .context(h!())?;
                RerCsvPersistence::Reused(message.id)
            }
            None => {
                let id = insert_rer_csv_message(context, body, timestamp, &txn)
                    .await
                    .context(h!())?;
                track_csv_message(context, &txn, id).await.context(h!())?;
                RerCsvPersistence::Inserted(id)
            }
        }
    } else {
        RerCsvPersistence::Inserted(
            insert_rer_csv_message(context, body, timestamp, &txn)
                .await
                .context(h!())?,
        )
    };
    txn.commit().await.c(h!())?;
    Ok(outcome)
}

pub(super) async fn process_rer_csv_message(
    context: &RerCsvImportContext<'_>,
    redis: &mut redis::aio::ConnectionManager,
    message_id: i64,
) -> anyhow::Result<bool> {
    let lock = begin_csv_transaction(context.dbx).await.context(h!())?;
    lock.execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "select pg_advisory_xact_lock(hashtextextended(jsonb_build_array($1::text, $2::bigint)::text, 0))",
        [RER_CSV_IMPORT_PROCESSING_LOCK_NAMESPACE.into(), message_id.into()],
    ))
    .await
    .c(h!())?;
    let state = rer_csv_import_message::Entity::find_by_id(message_id)
        .one(&lock)
        .await
        .c(h!())?
        .context(h!())?;
    if state.completed_at.is_some() {
        lock.commit().await.c(h!())?;
        return Ok(false);
    }
    let inbox_item_ids = match state.inbox_item_ids {
        Some(ids) => ids,
        None => construct_csv_inbox(
            context,
            message_id,
            state.reference_time,
            state.import_as_new,
        )
        .await
        .context(h!())?,
    };
    crate::inbox::fanout_inbox_changes(redis, inbox_item_ids)
        .await
        .context(h!())?;
    let mut state = rer_csv_import_message::Entity::find_by_id(message_id)
        .one(&lock)
        .await
        .c(h!())?
        .context(h!())?
        .into_active_model();
    state.completed_at = Set(Some(Utc::now().fixed_offset()));
    state.update(&lock).await.c(h!())?;
    lock.commit().await.c(h!())?;
    Ok(true)
}

async fn construct_csv_inbox(
    context: &RerCsvImportContext<'_>,
    message_id: i64,
    reference_time: NaiveDateTime,
    import_as_new: bool,
) -> anyhow::Result<Vec<i64>> {
    let txn = begin_csv_transaction(context.dbx).await.context(h!())?;
    let message = signal_message::Entity::find_by_id(message_id)
        .filter(signal_message::Column::Deleted.eq(false))
        .one(&txn)
        .await
        .c(h!())?
        .context(h!())?;
    let datetime_override = if import_as_new {
        None
    } else {
        Some(crate::inbox::InboxDatetimeOverride::Historical {
            datetime: message.timestamp.context(h!())?,
            reference_time: Utc
                .from_utc_datetime(&reference_time)
                .with_timezone(&crate::config::get_tz()),
        })
    };
    let ids =
        crate::rer_importer::bgworker::process_message_to_inbox_with_override(
            context.settlements.clone(),
            &txn,
            context.rq,
            context.config,
            message_id,
            datetime_override,
        )
        .await
        .context(h!())?;
    let processed_ids = if ids.is_empty() {
        vec![message_id]
    } else {
        ids.clone()
    };
    for id in processed_ids {
        reconcile_rer_csv_message_target_group_in_transaction(
            context, id, &txn,
        )
        .await
        .context(h!())?;
        crate::sigint::worker::incoming_message_after_insert(&txn, id)
            .await
            .c(h!())?;
    }
    txn.execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "update rer_csv_import_message set inbox_item_ids = $2 where message_id = $1",
        [message_id.into(), ids.clone().into()],
    ))
    .await
    .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(ids)
}
