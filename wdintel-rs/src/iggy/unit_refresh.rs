use crate::config::{
    API_INTEGRATION_IGGY_UNIT_REFRESH_ACTIVE_SLEEP_MS,
    API_INTEGRATION_IGGY_UNIT_REFRESH_BATCH_SIZE,
    API_INTEGRATION_IGGY_UNIT_REFRESH_IDLE_SLEEP_SECS,
    API_INTEGRATION_IGGY_UNIT_REFRESH_RETRY_SECS,
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
    sigint_unit_id: i64,
    stage: i16,
    catalog_cursor: i64,
    after_id: i64,
    after_network_id: i64,
}

#[derive(FromQueryResult)]
struct RefreshItem {
    cursor: i64,
    item_id: i64,
}

#[derive(FromQueryResult)]
struct CatalogCallsign {
    id: i64,
    match_key: String,
}

#[derive(FromQueryResult)]
struct NetworkCallsign {
    id: i64,
    network_id: i64,
}

pub(crate) async fn enqueue<C>(dbx: &C, unit_id: i64) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    dbx.execute_unprepared(
        "select 1 from api_integration order by id for share",
    )
    .await
    .c(h!())?;
    dbx.execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"
insert into api_integration_iggy_unit_refresh (
    api_integration_id, destination_id, sigint_unit_id
)
select integration.id, destination.id, $1
from api_integration integration
left join lateral (
    select id from api_integration_iggy_destination
    where api_integration_id = integration.id
    order by id desc limit 1
) destination on true
where integration.sync_enabled and integration.has_iggy_connection
        "#,
        [unit_id.into()],
    ))
    .await
    .c(h!())?;
    Ok(())
}

pub(crate) async fn run_nofail(env: Arc<Env>) {
    loop {
        let active = {
            let _guard = worker_watch::loop_guard("iggy_unit_refresh_worker");
            process_next_batch(
                &env.dbx,
                API_INTEGRATION_IGGY_UNIT_REFRESH_BATCH_SIZE,
            )
            .await
            .unwrap_or_else(|error| {
                error!("Iggy unit refresh worker failed: {error:#}");
                false
            })
        };
        let delay = if active {
            Duration::from_millis(
                API_INTEGRATION_IGGY_UNIT_REFRESH_ACTIVE_SLEEP_MS,
            )
        } else {
            Duration::from_secs(
                API_INTEGRATION_IGGY_UNIT_REFRESH_IDLE_SLEEP_SECS,
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
    let Some(mut job) = RefreshJob::find_by_statement(Statement::from_string(
        DbBackend::Postgres,
        r#"
select id, api_integration_id, destination_id, sigint_unit_id, stage,
    catalog_cursor, after_id, after_network_id
from api_integration_iggy_unit_refresh
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
    match process_job_batch(&batch, &mut job, batch_size).await {
        Ok(()) => batch.commit().await.c(h!())?,
        Err(error) => {
            batch.rollback().await.c(h!())?;
            retry_job(&transaction, job.id, &error).await.c(h!())?;
            error!("Iggy unit refresh job {} failed: {error:#}", job.id);
        }
    }
    transaction.commit().await.c(h!())?;
    Ok(true)
}

async fn process_job_batch(
    dbx: &DatabaseTransaction,
    job: &mut RefreshJob,
    batch_size: u64,
) -> anyhow::Result<()> {
    if job.stage == 0 {
        process_unit_links(dbx, job, batch_size).await.c(h!())?;
    } else if let Some(callsign) =
        load_catalog_callsign(dbx, job).await.c(h!())?
    {
        job.catalog_cursor = callsign.id;
        let processed = if job.stage == 1 {
            process_callsign_items(dbx, job, &callsign.match_key, batch_size)
                .await
                .c(h!())?
        } else {
            process_network_callsigns(dbx, job, &callsign.match_key, batch_size)
                .await
                .c(h!())?
        };
        if !processed {
            job.catalog_cursor += 1;
            job.after_id = 0;
            job.after_network_id = 0;
        }
    } else if job.stage == 1 {
        job.stage = 2;
        job.catalog_cursor = 0;
        job.after_id = 0;
    } else {
        dbx.execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "delete from api_integration_iggy_unit_refresh where id = $1",
            [job.id.into()],
        ))
        .await
        .c(h!())?;
        return Ok(());
    }
    save_progress(dbx, job).await.c(h!())
}

async fn process_unit_links(
    dbx: &DatabaseTransaction,
    job: &mut RefreshJob,
    batch_size: u64,
) -> anyhow::Result<()> {
    let items = RefreshItem::find_by_statement(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"
select id as cursor, item_id from sigint_inbox_item_unit
where unit_id = $1 and id > $2
order by id limit $3
        "#,
        [
            job.sigint_unit_id.into(),
            job.after_id.into(),
            batch_size.into(),
        ],
    ))
    .all(dbx)
    .await
    .c(h!())?;
    if let Some(last) = items.last() {
        job.after_id = last.cursor;
        enqueue_item_updates(dbx, job, items).await.c(h!())?;
    } else {
        job.stage = 1;
        job.after_id = 0;
    }
    Ok(())
}

async fn load_catalog_callsign(
    dbx: &DatabaseTransaction,
    job: &RefreshJob,
) -> anyhow::Result<Option<CatalogCallsign>> {
    CatalogCallsign::find_by_statement(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"
select id, api_integration_iggy_callsign_key(callsign) as match_key
from sigint_callsign
where unit_id = $1 and id >= $2 and not deleted
order by id limit 1
        "#,
        [job.sigint_unit_id.into(), job.catalog_cursor.into()],
    ))
    .one(dbx)
    .await
    .c(h!())
}

async fn process_callsign_items(
    dbx: &DatabaseTransaction,
    job: &mut RefreshJob,
    match_key: &str,
    batch_size: u64,
) -> anyhow::Result<bool> {
    let items = RefreshItem::find_by_statement(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"
select distinct sigint_inbox_item_id as cursor, sigint_inbox_item_id as item_id
from sigint_inbox_item_callsign
where api_integration_iggy_callsign_key(callsign) = $1
    and sigint_inbox_item_id > $2 and not deleted
order by sigint_inbox_item_id limit $3
        "#,
        [match_key.into(), job.after_id.into(), batch_size.into()],
    ))
    .all(dbx)
    .await
    .c(h!())?;
    let Some(last) = items.last() else {
        return Ok(false);
    };
    job.after_id = last.cursor;
    enqueue_item_updates(dbx, job, items).await.c(h!())?;
    Ok(true)
}

async fn enqueue_item_updates(
    dbx: &DatabaseTransaction,
    job: &RefreshJob,
    items: Vec<RefreshItem>,
) -> anyhow::Result<()> {
    let item_ids = items
        .into_iter()
        .map(|item| item.item_id)
        .collect::<BTreeSet<_>>();
    dbx.execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"
insert into api_integration_iggy_event (
    api_integration_id, destination_id, sigint_inbox_item_id, payload
)
select $1, $2, item_id,
    jsonb_build_object('event_type', 'sigint_inbox_item_updated')
from unnest($3::bigint[]) as item_id
        "#,
        [
            job.api_integration_id.into(),
            job.destination_id.into(),
            item_ids.into_iter().collect::<Vec<_>>().into(),
        ],
    ))
    .await
    .c(h!())?;
    Ok(())
}

async fn process_network_callsigns(
    dbx: &DatabaseTransaction,
    job: &mut RefreshJob,
    match_key: &str,
    batch_size: u64,
) -> anyhow::Result<bool> {
    let callsigns =
        NetworkCallsign::find_by_statement(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"
select id, sigint_network_id as network_id from sigint_network_callsign
where api_integration_iggy_callsign_key(sigint_callsign) = $1 and not deleted
    and (sigint_network_id, id) > ($2, $3)
order by sigint_network_id, id limit $4
        "#,
            [
                match_key.into(),
                job.after_network_id.into(),
                job.after_id.into(),
                batch_size.into(),
            ],
        ))
        .all(dbx)
        .await
        .c(h!())?;
    let Some(last) = callsigns.last() else {
        return Ok(false);
    };
    job.after_network_id = last.network_id;
    job.after_id = last.id;
    let callsign_ids = callsigns
        .into_iter()
        .map(|callsign| callsign.id)
        .collect::<Vec<_>>();
    dbx.execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"
insert into api_integration_iggy_event (
    api_integration_id, destination_id, sigint_inbox_item_id, payload
)
select $1, $2, null, jsonb_build_object(
    'event_type', action.event_type,
    'sigint_network_id', network_callsign.sigint_network_id,
    'sigint_network_callsign_id', network_callsign.id,
    'sigint_callsign_id', network_callsign.sigint_callsign_id,
    'callsign', network_callsign.sigint_callsign,
    'sigint_callsign_ids', api_integration_iggy_callsign_ids(network_callsign.sigint_callsign)
)
from sigint_network_callsign network_callsign
cross join (values ('sigint_network_callsign_unlinked'),
    ('sigint_network_callsign_linked')) as action(event_type)
where network_callsign.id = any($3::bigint[]) and not network_callsign.deleted
    and exists (select 1 from sigint_inbox_item_network
        where sigint_network_id = network_callsign.sigint_network_id)
order by action.event_type desc, network_callsign.sigint_network_id, network_callsign.id
        "#,
        [job.api_integration_id.into(), job.destination_id.into(), callsign_ids.into()],
    ))
    .await
    .c(h!())?;
    Ok(true)
}

async fn save_progress(
    dbx: &DatabaseTransaction,
    job: &RefreshJob,
) -> anyhow::Result<()> {
    dbx.execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"
update api_integration_iggy_unit_refresh
set stage = $2, catalog_cursor = $3, after_id = $4, after_network_id = $5,
    next_attempt_at = clock_timestamp() at time zone 'utc', attempts = 0, last_error = null
where id = $1
        "#,
        [job.id.into(), job.stage.into(), job.catalog_cursor.into(),
            job.after_id.into(), job.after_network_id.into()],
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
update api_integration_iggy_unit_refresh
set attempts = attempts + 1, last_error = $2,
    next_attempt_at = (clock_timestamp() at time zone 'utc') + $3::bigint * interval '1 second'
where id = $1
        "#,
        [job_id.into(), format!("{error:#}").into(),
            API_INTEGRATION_IGGY_UNIT_REFRESH_RETRY_SECS.into()],
    ))
    .await
    .c(h!())?;
    Ok(())
}
