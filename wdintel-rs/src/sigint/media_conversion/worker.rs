use super::{converted_file_name, delete_stored_results_best_effort};
use crate::config::{
    SIGINT_MEDIA_CONVERSION_ADVISORY_LOCK_KEY,
    SIGINT_MEDIA_CONVERSION_HEARTBEAT_SEC,
    SIGINT_MEDIA_CONVERSION_JOB_TIMEOUT_SEC,
    SIGINT_MEDIA_CONVERSION_STALE_PROCESSING_SEC,
    SIGINT_MEDIA_CONVERSION_STATUS_DONE, SIGINT_MEDIA_CONVERSION_STATUS_ERROR,
    SIGINT_MEDIA_CONVERSION_STATUS_PENDING,
    SIGINT_MEDIA_CONVERSION_STATUS_PROCESSING,
    SIGINT_MEDIA_CONVERSION_WORKER_SLEEP_SEC,
    SIGINT_MEDIA_KMZ_CONVERSION_MAX_SOURCE_BYTES,
};
use crate::entities::{
    signal_message_media, signal_message_media_conversion_job,
};
use crate::h;
use crate::logging::warn;
use crate::types::{Env, ShortContext};
use chrono::Utc;
use futures_util::TryStreamExt;
use md5::{Digest, Md5};
use sea_orm::prelude::Expr;
use sea_orm::{
    ColumnTrait, ConnectionTrait, DatabaseBackend, DatabaseConnection,
    DatabaseTransaction, EntityTrait, FromQueryResult, QueryFilter,
    QuerySelect, Statement, TransactionTrait,
};
use sqlx::pool::PoolConnection;
use sqlx::Postgres;
use std::sync::Arc;
use std::time::Duration;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ConversionAttempt {
    id: i64,
    attempt_count: i32,
}

enum ConversionOutcome {
    Applied,
    Stale,
}

pub async fn run_nofail(env: Arc<Env>) {
    loop {
        let no_jobs = match worker_step(env.as_ref()).await {
            Ok(no_jobs) => no_jobs,
            Err(err) => {
                warn!("signal media conversion worker failed: {err:#}");
                true
            }
        };
        if no_jobs {
            tokio::time::sleep(Duration::from_secs(
                SIGINT_MEDIA_CONVERSION_WORKER_SLEEP_SEC,
            ))
            .await;
        }
    }
}

async fn worker_step(env: &Env) -> anyhow::Result<bool> {
    if !work_may_be_available(&env.dbx).await.c(h!())? {
        return Ok(true);
    }
    let Some(_lease) = acquire_worker_lease(&env.dbx).await.c(h!())? else {
        return Ok(true);
    };
    let txn = env.dbx.begin().await.c(h!())?;
    let Some(job) =
        take_next_job(&txn, SIGINT_MEDIA_CONVERSION_STALE_PROCESSING_SEC)
            .await
            .c(h!())?
    else {
        txn.commit().await.c(h!())?;
        return Ok(true);
    };
    txn.commit().await.c(h!())?;

    let result = process_job_with_heartbeat(env, &job).await;
    match result {
        Ok(ConversionOutcome::Applied | ConversionOutcome::Stale) => {}
        Err(err) => {
            let error = format!("{err:#}");
            mark_error(&env.dbx, &job, error).await.c(h!())?;
        }
    }
    Ok(false)
}

async fn work_may_be_available<C>(dbx: &C) -> anyhow::Result<bool>
where
    C: ConnectionTrait,
{
    let stale_before = Utc::now().fixed_offset()
        - chrono::Duration::seconds(
            i64::try_from(SIGINT_MEDIA_CONVERSION_STALE_PROCESSING_SEC)
                .c(h!())?,
        );
    let row = dbx
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
            select
                not exists (
                    select 1
                    from signal_message_media_conversion_job
                    where status = $1 and last_attempt_at > $2
                )
                and exists (
                    select 1
                    from signal_message_media_conversion_job
                    where status = $3
                       or (
                           status = $1
                           and (last_attempt_at is null or last_attempt_at <= $2)
                       )
                ) as available
            "#,
            [
                SIGINT_MEDIA_CONVERSION_STATUS_PROCESSING.into(),
                stale_before.into(),
                SIGINT_MEDIA_CONVERSION_STATUS_PENDING.into(),
            ],
        ))
        .await
        .c(h!())?
        .c(h!())?;
    row.try_get("", "available").c(h!())
}

async fn take_next_job(
    txn: &DatabaseTransaction,
    stale_after_seconds: u64,
) -> anyhow::Result<Option<signal_message_media_conversion_job::Model>> {
    let stale_before = Utc::now().fixed_offset()
        - chrono::Duration::seconds(
            i64::try_from(stale_after_seconds).c(h!())?,
        );
    let has_active_job = signal_message_media_conversion_job::Entity::find()
        .filter(
            signal_message_media_conversion_job::Column::Status
                .eq(SIGINT_MEDIA_CONVERSION_STATUS_PROCESSING),
        )
        .filter(
            signal_message_media_conversion_job::Column::LastAttemptAt
                .gt(stale_before),
        )
        .select_only()
        .column(signal_message_media_conversion_job::Column::Id)
        .into_tuple::<i64>()
        .one(txn)
        .await
        .c(h!())?
        .is_some();
    if has_active_job {
        return Ok(None);
    }

    let statement = Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
        with next_job as (
            select id
            from signal_message_media_conversion_job
            where status = $1
               or (
                   status = $2
                   and (last_attempt_at is null or last_attempt_at <= $3)
               )
            order by
                case when status = $1 then 0 else 1 end,
                id
            for update skip locked
            limit 1
        )
        update signal_message_media_conversion_job
        set
            status = $2,
            last_attempt_at = now(),
            attempt_count = attempt_count + 1,
            last_error = null
        where id in (select id from next_job)
        returning *
        "#,
        [
            SIGINT_MEDIA_CONVERSION_STATUS_PENDING.into(),
            SIGINT_MEDIA_CONVERSION_STATUS_PROCESSING.into(),
            stale_before.into(),
        ],
    );
    signal_message_media_conversion_job::Model::find_by_statement(statement)
        .one(txn)
        .await
        .c(h!())
}

async fn acquire_worker_lease(
    dbx: &DatabaseConnection,
) -> anyhow::Result<Option<PoolConnection<Postgres>>> {
    let mut connection =
        dbx.get_postgres_connection_pool().acquire().await.c(h!())?;
    connection.close_on_drop();
    let acquired =
        sqlx::query_scalar::<_, bool>("select pg_try_advisory_lock($1)")
            .bind(SIGINT_MEDIA_CONVERSION_ADVISORY_LOCK_KEY)
            .fetch_one(&mut *connection)
            .await
            .c(h!())?;
    if acquired {
        Ok(Some(connection))
    } else {
        Ok(None)
    }
}

async fn process_job(
    env: &Env,
    job: &signal_message_media_conversion_job::Model,
) -> anyhow::Result<ConversionOutcome> {
    let attempt = ConversionAttempt {
        id: job.id,
        attempt_count: job.attempt_count,
    };
    let Some(media) =
        signal_message_media::Entity::find_by_id(job.source_media_id)
            .one(&env.dbx)
            .await
            .c(h!())?
    else {
        return Ok(ConversionOutcome::Stale);
    };
    anyhow::ensure!(
        media.signal_message_id == job.signal_message_id,
        "conversion source belongs to a different message"
    );
    let source = fetch_source_bytes(env, &media).await.c(h!())?;
    anyhow::ensure!(
        format!("{:x}", Md5::digest(&source)) == job.source_file_md5,
        "conversion source MD5 does not match the queued file"
    );
    let converted = tokio::time::timeout(
        Duration::from_secs(SIGINT_MEDIA_CONVERSION_JOB_TIMEOUT_SEC),
        crate::alpine::convert_bytes_to_kmz(
            env,
            source,
            Some(job.source_file_name.clone()),
            job.source_content_type.clone(),
        ),
    )
    .await
    .map_err(|_| {
        anyhow::anyhow!(
            "signal media conversion timed out after {} seconds",
            SIGINT_MEDIA_CONVERSION_JOB_TIMEOUT_SEC
        )
    })
    .c(h!())?
    .c(h!())?;
    anyhow::ensure!(
        !converted.body.is_empty(),
        "converter returned an empty KMZ"
    );
    let file_name = converted_file_name(&job.source_file_name);
    let size_bytes = i64::try_from(converted.body.len()).c(h!())?;
    let storage_key = crate::messenger::media::store_asset(
        env,
        converted.body,
        Some(&file_name),
        Some(crate::config::KMZ_CONTENT_TYPE),
    )
    .await
    .c(h!())?;
    let applied = finish_job(
        &env.dbx,
        attempt,
        converted.receipt,
        storage_key.clone(),
        file_name,
        size_bytes,
    )
    .await;
    if !applied.as_ref().is_ok_and(|applied| *applied) {
        delete_stored_results_best_effort(env, &[storage_key]).await;
    }
    if !applied.c(h!())? {
        return Ok(ConversionOutcome::Stale);
    }
    Ok(ConversionOutcome::Applied)
}

async fn process_job_with_heartbeat(
    env: &Env,
    job: &signal_message_media_conversion_job::Model,
) -> anyhow::Result<ConversionOutcome> {
    let attempt = ConversionAttempt {
        id: job.id,
        attempt_count: job.attempt_count,
    };
    let process = process_job(env, job);
    tokio::pin!(process);
    let mut heartbeat = tokio::time::interval(Duration::from_secs(
        SIGINT_MEDIA_CONVERSION_HEARTBEAT_SEC,
    ));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            outcome = &mut process => return outcome,
            _ = heartbeat.tick() => {
                if !refresh_attempt(&env.dbx, attempt).await.c(h!())? {
                    return Ok(ConversionOutcome::Stale);
                }
            }
        }
    }
}

async fn refresh_attempt<C>(
    dbx: &C,
    attempt: ConversionAttempt,
) -> anyhow::Result<bool>
where
    C: ConnectionTrait,
{
    let result = signal_message_media_conversion_job::Entity::update_many()
        .col_expr(
            signal_message_media_conversion_job::Column::LastAttemptAt,
            Expr::value(Utc::now().fixed_offset()),
        )
        .filter(signal_message_media_conversion_job::Column::Id.eq(attempt.id))
        .filter(
            signal_message_media_conversion_job::Column::Status
                .eq(SIGINT_MEDIA_CONVERSION_STATUS_PROCESSING),
        )
        .filter(
            signal_message_media_conversion_job::Column::AttemptCount
                .eq(attempt.attempt_count),
        )
        .exec(dbx)
        .await
        .c(h!())?;
    Ok(result.rows_affected == 1)
}

async fn fetch_source_bytes(
    env: &Env,
    media: &signal_message_media::Model,
) -> anyhow::Result<Vec<u8>> {
    let size_bytes = usize::try_from(media.size_bytes).c(h!())?;
    anyhow::ensure!(
        size_bytes <= SIGINT_MEDIA_KMZ_CONVERSION_MAX_SOURCE_BYTES,
        "file is too large for KMZ conversion"
    );
    if media.is_encrypted {
        return crate::messenger::media::fetch_media_bytes(env, media)
            .await
            .c(h!());
    }
    let mut stream = crate::messenger::media::stream_plaintext_media_range(
        env,
        media,
        0..u64::try_from(size_bytes).c(h!())?,
    )
    .await
    .c(h!())?;
    let mut bytes = Vec::with_capacity(size_bytes);
    while let Some(chunk) = stream.try_next().await.c(h!())? {
        bytes.extend_from_slice(&chunk);
    }
    anyhow::ensure!(bytes.len() == size_bytes, "stored file size changed");
    Ok(bytes)
}

async fn finish_job<C>(
    dbx: &C,
    attempt: ConversionAttempt,
    receipt: String,
    storage_key: String,
    file_name: String,
    size_bytes: i64,
) -> anyhow::Result<bool>
where
    C: ConnectionTrait,
{
    let result = signal_message_media_conversion_job::Entity::update_many()
        .col_expr(
            signal_message_media_conversion_job::Column::Status,
            Expr::value(SIGINT_MEDIA_CONVERSION_STATUS_DONE),
        )
        .col_expr(
            signal_message_media_conversion_job::Column::ConversionReceipt,
            Expr::value(receipt),
        )
        .col_expr(
            signal_message_media_conversion_job::Column::ConvertedStorageKey,
            Expr::value(storage_key),
        )
        .col_expr(
            signal_message_media_conversion_job::Column::ConvertedFileName,
            Expr::value(file_name),
        )
        .col_expr(
            signal_message_media_conversion_job::Column::ConvertedSizeBytes,
            Expr::value(size_bytes),
        )
        .col_expr(
            signal_message_media_conversion_job::Column::LastError,
            Expr::value(Option::<String>::None),
        )
        .filter(signal_message_media_conversion_job::Column::Id.eq(attempt.id))
        .filter(
            signal_message_media_conversion_job::Column::Status
                .eq(SIGINT_MEDIA_CONVERSION_STATUS_PROCESSING),
        )
        .filter(
            signal_message_media_conversion_job::Column::AttemptCount
                .eq(attempt.attempt_count),
        )
        .exec(dbx)
        .await
        .c(h!())?;
    Ok(result.rows_affected == 1)
}

async fn mark_error<C>(
    dbx: &C,
    job: &signal_message_media_conversion_job::Model,
    error: String,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    signal_message_media_conversion_job::Entity::update_many()
        .col_expr(
            signal_message_media_conversion_job::Column::Status,
            Expr::value(SIGINT_MEDIA_CONVERSION_STATUS_ERROR),
        )
        .col_expr(
            signal_message_media_conversion_job::Column::LastError,
            Expr::value(error),
        )
        .filter(signal_message_media_conversion_job::Column::Id.eq(job.id))
        .filter(
            signal_message_media_conversion_job::Column::Status
                .eq(SIGINT_MEDIA_CONVERSION_STATUS_PROCESSING),
        )
        .filter(
            signal_message_media_conversion_job::Column::AttemptCount
                .eq(job.attempt_count),
        )
        .exec(dbx)
        .await
        .c(h!())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::functest::tests::{cleanup, mk_signal_message};
    use sea_orm::{ActiveModelTrait, ActiveValue::Set, NotSet};
    use serial_test::serial;
    use uuid::Uuid;

    async fn insert_job(
        env: &Env,
        signal_message_id: i64,
        signal_message_uuid: Option<Uuid>,
        file_name: &str,
    ) -> signal_message_media_conversion_job::Model {
        let media = signal_message_media::ActiveModel {
            id: Set(Uuid::now_v7()),
            signal_message_id: Set(signal_message_id),
            signal_message_uuid: Set(signal_message_uuid),
            content_type: Set("application/gpx+xml".to_string()),
            file_ext: Set(Some("gpx".to_string())),
            file_name: Set(Some(file_name.to_string())),
            size_bytes: Set(1),
            created_at: Set(Utc::now().naive_utc()),
            is_encrypted: Set(true),
            storage_key: Set(Some(format!("test/{file_name}"))),
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        signal_message_media_conversion_job::ActiveModel {
            id: NotSet,
            signal_message_id: Set(signal_message_id),
            source_media_id: Set(media.id),
            source_file_md5: Set("c4ca4238a0b923820dcc509a6f75849b".to_string()),
            source_file_name: Set(file_name.to_string()),
            source_content_type: Set(Some("application/gpx+xml".to_string())),
            status: Set(SIGINT_MEDIA_CONVERSION_STATUS_PENDING.to_string()),
            conversion_receipt: Set(None),
            converted_storage_key: Set(None),
            converted_file_name: Set(None),
            converted_size_bytes: Set(None),
            created_at: NotSet,
            last_attempt_at: Set(None),
            attempt_count: Set(0),
            last_error: Set(None),
        }
        .insert(&env.dbx)
        .await
        .unwrap()
    }

    #[serial]
    #[tokio::test]
    async fn worker_lease_and_attempt_guard_keep_claims_sequential() {
        let env = cleanup().await.unwrap();
        let message = mk_signal_message(
            &env.dbx,
            crate::entities::signal_message::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let first =
            insert_job(&env, message.id, message.id_uuid, "first.gpx").await;
        let second =
            insert_job(&env, message.id, message.id_uuid, "second.gpx").await;

        assert!(work_may_be_available(&env.dbx).await.unwrap());
        let lease = acquire_worker_lease(&env.dbx).await.unwrap().unwrap();
        assert!(acquire_worker_lease(&env.dbx).await.unwrap().is_none());
        let txn = env.dbx.begin().await.unwrap();
        let claimed =
            take_next_job(&txn, SIGINT_MEDIA_CONVERSION_STALE_PROCESSING_SEC)
                .await
                .unwrap()
                .unwrap();
        txn.commit().await.unwrap();
        assert_eq!(claimed.id, first.id);
        assert_eq!(claimed.attempt_count, 1);
        assert!(!work_may_be_available(&env.dbx).await.unwrap());

        let stale_attempt = ConversionAttempt {
            id: claimed.id,
            attempt_count: claimed.attempt_count + 1,
        };
        assert!(!finish_job(
            &env.dbx,
            stale_attempt,
            "stale".to_string(),
            "test/stale.kmz".to_string(),
            "stale.kmz".to_string(),
            1,
        )
        .await
        .unwrap());
        assert!(finish_job(
            &env.dbx,
            ConversionAttempt {
                id: claimed.id,
                attempt_count: claimed.attempt_count,
            },
            "receipt".to_string(),
            "test/first.kmz".to_string(),
            "first_converted.kmz".to_string(),
            1,
        )
        .await
        .unwrap());
        assert!(work_may_be_available(&env.dbx).await.unwrap());

        drop(lease);
        let _next_lease =
            acquire_worker_lease(&env.dbx).await.unwrap().unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let next =
            take_next_job(&txn, SIGINT_MEDIA_CONVERSION_STALE_PROCESSING_SEC)
                .await
                .unwrap()
                .unwrap();
        txn.commit().await.unwrap();
        assert_eq!(next.id, second.id);
    }
}
