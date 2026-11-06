use crate::config::{
    API_INTEGRATION_IGGY_GROUP_REFRESH_ACTIVE_SLEEP_MS,
    API_INTEGRATION_IGGY_GROUP_REFRESH_BATCH_SIZE,
    API_INTEGRATION_IGGY_GROUP_REFRESH_IDLE_SLEEP_SECS,
    API_INTEGRATION_IGGY_GROUP_REFRESH_RETRY_SECS,
};
use crate::types::*;
use crate::utils::worker_watch;
use sea_orm::*;
use std::sync::Arc;
use tokio::time::{sleep, Duration};

#[derive(Debug, FromQueryResult)]
struct RefreshJob {
    id: i64,
    api_integration_id: i64,
    destination_id: i64,
    group_master_key: Option<String>,
    after_message_id: i64,
    through_message_id: i64,
    through_membership_id: i64,
}

#[derive(FromQueryResult)]
struct RefreshMessage {
    signal_message_id: i64,
}

pub(crate) async fn run_nofail(env: Arc<Env>) {
    loop {
        let active = {
            let _guard = worker_watch::loop_guard("iggy_group_refresh_worker");
            process_next_batch(
                &env.dbx,
                API_INTEGRATION_IGGY_GROUP_REFRESH_BATCH_SIZE,
            )
            .await
            .unwrap_or_else(|error| {
                error!("Iggy group refresh worker failed: {error:#}");
                false
            })
        };
        let delay = if active {
            Duration::from_millis(
                API_INTEGRATION_IGGY_GROUP_REFRESH_ACTIVE_SLEEP_MS,
            )
        } else {
            Duration::from_secs(
                API_INTEGRATION_IGGY_GROUP_REFRESH_IDLE_SLEEP_SECS,
            )
        };
        sleep(delay).await;
    }
}

pub(super) async fn process_next_batch(
    dbx: &DatabaseConnection,
    batch_size: u64,
) -> anyhow::Result<bool> {
    let transaction = dbx.begin().await.c(h!())?;
    let Some(job) = RefreshJob::find_by_statement(Statement::from_string(
        DbBackend::Postgres,
        r#"
select id, api_integration_id, destination_id, group_master_key,
    after_message_id, through_message_id, through_membership_id
from api_integration_iggy_group_refresh
where next_attempt_at <= now() at time zone 'utc'
order by next_attempt_at, id
limit 1 for update skip locked
        "#,
    ))
    .one(&transaction)
    .await
    .c(h!())?
    else {
        transaction.commit().await.c(h!())?;
        return Ok(false);
    };
    let batch = transaction.begin().await.c(h!())?;
    match process_job_batch(&batch, &job, batch_size).await {
        Ok(()) => batch.commit().await.c(h!())?,
        Err(error) => {
            batch.rollback().await.c(h!())?;
            retry_job(&transaction, job.id, &error).await.c(h!())?;
            error!("Iggy group refresh job {} failed: {error:#}", job.id);
        }
    }
    transaction.commit().await.c(h!())?;
    Ok(true)
}

async fn process_job_batch(
    dbx: &DatabaseTransaction,
    job: &RefreshJob,
    batch_size: u64,
) -> anyhow::Result<()> {
    let message_ids = load_message_ids(dbx, job, batch_size).await.c(h!())?;
    let Some(last_message_id) = message_ids.last().copied() else {
        return delete_job(dbx, job.id).await.c(h!());
    };
    enqueue_visibility_events(dbx, job, message_ids)
        .await
        .c(h!())?;
    save_progress(dbx, job.id, last_message_id).await.c(h!())
}

fn message_ids_statement(job: &RefreshJob, batch_size: u64) -> Statement {
    match &job.group_master_key {
        Some(group_master_key) => Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"
select distinct signal_message_id from signal_message_group
where group_master_key = $1
    and signal_message_id > $2 and signal_message_id <= $3
order by signal_message_id limit $4
            "#,
            [
                group_master_key.as_str().into(),
                job.after_message_id.into(),
                job.through_message_id.into(),
                batch_size.into(),
            ],
        ),
        None => Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"
select distinct signal_message_id from signal_message_group
where group_master_key is not null
    and signal_message_id > $1 and signal_message_id <= $2
order by signal_message_id limit $3
            "#,
            [
                job.after_message_id.into(),
                job.through_message_id.into(),
                batch_size.into(),
            ],
        ),
    }
}

async fn load_message_ids(
    dbx: &DatabaseTransaction,
    job: &RefreshJob,
    batch_size: u64,
) -> anyhow::Result<Vec<i64>> {
    let messages = RefreshMessage::find_by_statement(message_ids_statement(
        job, batch_size,
    ))
    .all(dbx)
    .await
    .c(h!())?;
    Ok(messages
        .into_iter()
        .map(|message| message.signal_message_id)
        .collect())
}

async fn enqueue_visibility_events(
    dbx: &DatabaseTransaction,
    job: &RefreshJob,
    message_ids: Vec<i64>,
) -> anyhow::Result<()> {
    dbx.execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"
insert into api_integration_iggy_event (
    api_integration_id, destination_id, sigint_inbox_item_id, payload
)
select $1, $2, item.id,
    jsonb_build_object('event_type', 'sigint_inbox_item_visibility_changed')
from sigint_inbox_item item
where item.id = any($3::bigint[])
    and exists (
        select 1 from signal_message_group membership
        where membership.signal_message_id = item.id
            and membership.id <= $4
            and (membership.group_master_key = $5::text
                or ($5::text is null
                    and membership.group_master_key is not null))
    )
        "#,
        [
            job.api_integration_id.into(),
            job.destination_id.into(),
            message_ids.into(),
            job.through_membership_id.into(),
            job.group_master_key.clone().into(),
        ],
    ))
    .await
    .c(h!())?;
    Ok(())
}

async fn delete_job(
    dbx: &DatabaseTransaction,
    job_id: i64,
) -> anyhow::Result<()> {
    dbx.execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "delete from api_integration_iggy_group_refresh where id = $1",
        [job_id.into()],
    ))
    .await
    .c(h!())?;
    Ok(())
}

async fn save_progress(
    dbx: &DatabaseTransaction,
    job_id: i64,
    after_message_id: i64,
) -> anyhow::Result<()> {
    dbx.execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"
update api_integration_iggy_group_refresh
set after_message_id = $2,
    next_attempt_at = clock_timestamp() at time zone 'utc',
    attempts = 0, last_error = null
where id = $1
        "#,
        [job_id.into(), after_message_id.into()],
    ))
    .await
    .c(h!())?;
    Ok(())
}

async fn retry_job(
    dbx: &DatabaseTransaction,
    job_id: i64,
    error: &anyhow::Error,
) -> anyhow::Result<()> {
    dbx.execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"
update api_integration_iggy_group_refresh
set attempts = attempts + 1, last_error = $2,
    next_attempt_at = (clock_timestamp() at time zone 'utc') + $3::bigint * interval '1 second'
where id = $1
        "#,
        [
            job_id.into(),
            format!("{error:#}").into(),
            API_INTEGRATION_IGGY_GROUP_REFRESH_RETRY_SECS.into(),
        ],
    ))
    .await
    .c(h!())?;
    Ok(())
}
