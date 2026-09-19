use super::{
    converted_file_name, delete_stored_results_best_effort, source_is_ready_kmz,
};
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
use bytes::Bytes;
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

struct PreparedKmz {
    body: Bytes,
    receipt: Option<String>,
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
    let file_name = converted_file_name(&job.source_file_name);
    let prepared = prepare_kmz(env, &media, job, source).await.c(h!())?;
    validate_prepared_kmz(&file_name, &prepared.body)
        .await
        .c(h!())?;
    let size_bytes = i64::try_from(prepared.body.len()).c(h!())?;
    let storage_key = if source_is_ready_kmz(&media) {
        None
    } else {
        Some(
            crate::messenger::media::store_asset(
                env,
                prepared.body,
                Some(&file_name),
                Some(crate::config::KMZ_CONTENT_TYPE),
            )
            .await
            .c(h!())?,
        )
    };
    let applied = finish_job(
        &env.dbx,
        attempt,
        prepared.receipt,
        storage_key.clone(),
        file_name,
        size_bytes,
    )
    .await;
    if !applied.as_ref().is_ok_and(|applied| *applied) {
        if let Some(storage_key) = storage_key {
            delete_stored_results_best_effort(env, &[storage_key]).await;
        }
    }
    if !applied.c(h!())? {
        return Ok(ConversionOutcome::Stale);
    }
    Ok(ConversionOutcome::Applied)
}

async fn prepare_kmz(
    env: &Env,
    media: &signal_message_media::Model,
    job: &signal_message_media_conversion_job::Model,
    source: Vec<u8>,
) -> anyhow::Result<PreparedKmz> {
    if source_is_ready_kmz(media) {
        return Ok(PreparedKmz {
            body: Bytes::from(source),
            receipt: None,
        });
    }
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
    Ok(PreparedKmz {
        body: converted.body,
        receipt: Some(converted.receipt),
    })
}

async fn validate_prepared_kmz(
    file_name: &str,
    body: &[u8],
) -> anyhow::Result<()> {
    anyhow::ensure!(!body.is_empty(), "KMZ preview file is empty");
    crate::palitra::kmz::parse_coordinates_from_file(file_name, body)
        .await
        .c(h!())?;
    Ok(())
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

pub(super) async fn fetch_source_bytes(
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
    receipt: Option<String>,
    storage_key: Option<String>,
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
    use std::io::{Cursor, Write};
    use uuid::Uuid;

    fn kmz_without_kml() -> Vec<u8> {
        let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
        archive
            .start_file(
                "route.geojson",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        archive
            .write_all(br#"{"type":"FeatureCollection","features":[]}"#)
            .unwrap();
        archive.finish().unwrap().into_inner()
    }

    fn media_with_extension(extension: &str) -> signal_message_media::Model {
        signal_message_media::Model {
            id: Uuid::nil(),
            signal_message_id: 1,
            signal_message_uuid: None,
            content_type: "application/octet-stream".to_string(),
            file_ext: Some(extension.to_string()),
            file_name: Some(format!("route.{extension}")),
            size_bytes: 1,
            created_at: Utc::now().naive_utc(),
            is_encrypted: true,
            storage_key: Some("test/route".to_string()),
        }
    }

    #[tokio::test]
    async fn kmz_is_passthrough_and_geojson_requires_conversion() {
        assert!(source_is_ready_kmz(&media_with_extension("kmz")));
        assert!(source_is_ready_kmz(&media_with_extension("KMZ")));
        assert!(!source_is_ready_kmz(&media_with_extension("geojson")));

        let valid = tokio::fs::read("data/test.kmz").await.unwrap();
        validate_prepared_kmz("route_converted.kmz", &valid)
            .await
            .unwrap();
        let error =
            validate_prepared_kmz("route_converted.kmz", &kmz_without_kml())
                .await
                .unwrap_err();
        assert!(format!("{error:#}")
            .contains("KMZ archive contains no KML documents"));
    }

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

    async fn wait_until_blocked_by(env: &Env, blocker_pid: i32) {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let waiting: bool = env
                    .dbx
                    .query_one_raw(Statement::from_sql_and_values(
                        DatabaseBackend::Postgres,
                        "select exists (select 1 from pg_stat_activity where datname = current_database() and $1 = any(pg_blocking_pids(pid))) as waiting",
                        [blocker_pid.into()],
                    ))
                    .await
                    .unwrap()
                    .unwrap()
                    .try_get("", "waiting")
                    .unwrap();
                if waiting {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("job completion did not wait for the cleanup lock");
    }

    #[serial]
    #[tokio::test]
    async fn cleanup_lock_prevents_concurrent_job_completion() {
        let env = cleanup().await.unwrap();
        let message = mk_signal_message(
            &env.dbx,
            crate::entities::signal_message::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        insert_job(&env, message.id, message.id_uuid, "route.gpx").await;
        let claim_txn = env.dbx.begin().await.unwrap();
        let job = take_next_job(
            &claim_txn,
            SIGINT_MEDIA_CONVERSION_STALE_PROCESSING_SEC,
        )
        .await
        .unwrap()
        .unwrap();
        claim_txn.commit().await.unwrap();

        let cleanup_txn = env.dbx.begin().await.unwrap();
        let keys = crate::sigint::media_conversion::lock_and_load_converted_storage_keys(
            &cleanup_txn,
            &[job.source_media_id],
        )
        .await
        .unwrap();
        assert!(keys.is_empty());
        let blocker_pid: i32 = cleanup_txn
            .query_one_raw(Statement::from_string(
                DatabaseBackend::Postgres,
                "select pg_backend_pid() as pid",
            ))
            .await
            .unwrap()
            .unwrap()
            .try_get("", "pid")
            .unwrap();
        let attempt = ConversionAttempt {
            id: job.id,
            attempt_count: job.attempt_count,
        };
        let completion_dbx = env.dbx.clone();
        let completion = tokio::spawn(async move {
            finish_job(
                &completion_dbx,
                attempt,
                Some("receipt".to_string()),
                Some("test/route.kmz".to_string()),
                "route_converted.kmz".to_string(),
                1,
            )
            .await
        });
        wait_until_blocked_by(&env, blocker_pid).await;

        signal_message_media::Entity::delete_by_id(job.source_media_id)
            .exec(&cleanup_txn)
            .await
            .unwrap();
        cleanup_txn.commit().await.unwrap();

        let applied = tokio::time::timeout(Duration::from_secs(5), completion)
            .await
            .expect("job completion remained blocked after cleanup committed")
            .unwrap()
            .unwrap();
        assert!(!applied);
        assert!(signal_message_media_conversion_job::Entity::find_by_id(
            job.id
        )
        .one(&env.dbx)
        .await
        .unwrap()
        .is_none());
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
            Some("stale".to_string()),
            Some("test/stale.kmz".to_string()),
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
            Some("receipt".to_string()),
            Some("test/first.kmz".to_string()),
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
