use crate::config::{
    PALITRA_CONVERSION_JOB_STALE_PROCESSING_SEC,
    PALITRA_CONVERSION_JOB_STATUS_DONE, PALITRA_CONVERSION_JOB_STATUS_ERROR,
    PALITRA_CONVERSION_JOB_STATUS_PENDING,
    PALITRA_CONVERSION_JOB_STATUS_PROCESSING,
    PALITRA_CONVERSION_JOB_TIMEOUT_SEC, PALITRA_CONVERSION_STATUS_ERROR,
    PALITRA_CONVERSION_STATUS_READY, PALITRA_CONVERSION_WORKER_SLEEP_SEC,
};
use crate::entities::*;
use crate::error::AppError;
use crate::h;
use crate::types::*;
use anyhow::bail;
use sea_orm::prelude::Expr;
use sea_orm::Statement;
use sea_orm::*;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

enum ConversionJobOutcome {
    Applied,
    Stale,
}

pub async fn palitra_conversion_worker_nofail(env: Arc<Env>) {
    loop {
        let no_jobs = match palitra_conversion_worker_step(env.as_ref()).await {
            Ok(no_jobs) => no_jobs,
            Err(err) => {
                warn!("palitra_conversion_worker failed: {err:#}");
                true
            }
        };
        if no_jobs {
            tokio::time::sleep(Duration::from_secs(
                PALITRA_CONVERSION_WORKER_SLEEP_SEC,
            ))
            .await;
        }
    }
}

async fn palitra_conversion_worker_step(env: &Env) -> Result<bool, AppError> {
    let txn = env.dbx.begin().await.c(h!())?;
    let Some(job) = take_next_job(&txn).await.c(h!())? else {
        txn.commit().await.c(h!())?;
        return Ok(true);
    };
    txn.commit().await.c(h!())?;

    let result = process_conversion_job(env, &job).await;
    match result {
        Ok(ConversionJobOutcome::Applied) => {
            env.palitra_worker_context.flush_cache(job.palitra_id).await;
        }
        Ok(ConversionJobOutcome::Stale) => {}
        Err(err) => {
            let error = format!("{err:#}");
            let update_result =
                mark_conversion_job_error(&env.dbx, &job, error.clone())
                    .await
                    .c(h!())?;
            if update_result.rows_affected > 0 {
                super::update_palitra_conversion_status(
                    &env.dbx,
                    job.palitra_id,
                    PALITRA_CONVERSION_STATUS_ERROR,
                    Some(job.source_format.clone()),
                    None,
                    Some(error),
                )
                .await
                .c(h!())?;
                env.palitra_worker_context.flush_cache(job.palitra_id).await;
            }
        }
    }

    Ok(false)
}

async fn take_next_job(
    txn: &DatabaseTransaction,
) -> anyhow::Result<Option<palitra_conversion_job::Model>> {
    let stmt = Statement::from_string(
        DatabaseBackend::Postgres,
        format!(
            r#"
        with next_job as (
            select id
            from palitra_conversion_job
            where status = '{}'
               or (
                   status = '{}'
                   and (
                       last_attempt_at is null
                       or last_attempt_at <= now() - interval '{} seconds'
                   )
               )
            order by
                case when status = '{}' then 0 else 1 end,
                id
            for update skip locked
            limit 1
        )
        update palitra_conversion_job
        set
            status = '{}',
            last_attempt_at = now(),
            attempt_count = attempt_count + 1,
            last_error = null
        where id in (select id from next_job)
        returning *
        "#,
            PALITRA_CONVERSION_JOB_STATUS_PENDING,
            PALITRA_CONVERSION_JOB_STATUS_PROCESSING,
            PALITRA_CONVERSION_JOB_STALE_PROCESSING_SEC,
            PALITRA_CONVERSION_JOB_STATUS_PENDING,
            PALITRA_CONVERSION_JOB_STATUS_PROCESSING
        ),
    );
    palitra_conversion_job::Model::find_by_statement(stmt)
        .one(txn)
        .await
        .c(h!())
}

async fn process_conversion_job(
    env: &Env,
    job: &palitra_conversion_job::Model,
) -> anyhow::Result<ConversionJobOutcome> {
    if !is_current_processing_job(&env.dbx, job).await.c(h!())? {
        return Ok(ConversionJobOutcome::Stale);
    }
    if !live_palitra_exists(&env.dbx, job.palitra_id)
        .await
        .c(h!())?
    {
        delete_current_processing_job(&env.dbx, job).await.c(h!())?;
        return Ok(ConversionJobOutcome::Stale);
    }
    let file_data = job.file_data.clone().c(h!())?;
    let converted = tokio::time::timeout(
        Duration::from_secs(PALITRA_CONVERSION_JOB_TIMEOUT_SEC),
        crate::alpine::convert_bytes_to_kmz(
            env,
            file_data,
            Some(job.source_file_name.clone()),
            job.content_type.clone(),
        ),
    )
    .await
    .map_err(|_| {
        anyhow::anyhow!(
            "palitra conversion timed out after {} seconds",
            PALITRA_CONVERSION_JOB_TIMEOUT_SEC
        )
    })
    .c(h!())?
    .c(h!())?;
    let converted_name = converted
        .name
        .unwrap_or_else(|| converted_kmz_file_name(&job.source_file_name));
    let converted_body = converted.body.to_vec();
    let upload = super::kmz::load_coordinates_from_file(
        converted_name.clone(),
        converted_body.clone(),
        env,
    )
    .await
    .c(h!())?;
    let txn = env.dbx.begin().await.c(h!())?;
    if !lock_current_processing_job(&txn, job).await.c(h!())? {
        txn.commit().await.c(h!())?;
        return Ok(ConversionJobOutcome::Stale);
    }
    let Some(palitra) = lock_live_palitra_for_conversion(&txn, job.palitra_id)
        .await
        .c(h!())?
    else {
        delete_current_processing_job(&txn, job).await.c(h!())?;
        txn.commit().await.c(h!())?;
        return Ok(ConversionJobOutcome::Stale);
    };
    let fallback_color_hex =
        super::read_latest_palitra_geometry_including_deleted(&txn, palitra.id)
            .await
            .c(h!())?
            .map(|palitra_geometry| palitra_geometry.hex);
    super::apply_loaded_palitra_file_to_existing_palitra(
        env,
        &txn,
        &palitra,
        &converted_name,
        upload,
        fallback_color_hex.as_deref(),
    )
    .await
    .c(h!())?;
    super::update_palitra_conversion_status(
        &txn,
        palitra.id,
        PALITRA_CONVERSION_STATUS_READY,
        Some(job.source_format.clone()),
        Some(converted.receipt.clone()),
        None,
    )
    .await
    .c(h!())?;
    if !palitra.imported_from_goi || job.should_schedule_goi_upload {
        super::schedule_palitra_goi_upload(&txn, palitra.id, converted_body)
            .await
            .c(h!())?;
    }
    let update_result = mark_conversion_job_done(&txn, job, converted.receipt)
        .await
        .c(h!())?;
    if update_result.rows_affected != 1 {
        bail!("current palitra conversion job disappeared before completion");
    }
    txn.commit().await.c(h!())?;
    Ok(ConversionJobOutcome::Applied)
}

async fn live_palitra_exists<'a, C>(
    dbx: &'a C,
    palitra_id: i64,
) -> anyhow::Result<bool>
where
    C: ConnectionTrait + 'a,
{
    Ok(palitra::Entity::find_by_id(palitra_id)
        .filter(palitra::Column::Deleted.eq(false))
        .one(dbx)
        .await
        .c(h!())?
        .is_some())
}

async fn lock_live_palitra_for_conversion(
    txn: &DatabaseTransaction,
    palitra_id: i64,
) -> anyhow::Result<Option<palitra::Model>> {
    palitra::Entity::find_by_id(palitra_id)
        .filter(palitra::Column::Deleted.eq(false))
        .lock_exclusive()
        .one(txn)
        .await
        .c(h!())
}

async fn is_current_processing_job<'a, C>(
    dbx: &'a C,
    job: &palitra_conversion_job::Model,
) -> anyhow::Result<bool>
where
    C: ConnectionTrait + 'a,
{
    let exists = palitra_conversion_job::Entity::find()
        .filter(current_processing_job_condition(job))
        .one(dbx)
        .await
        .c(h!())?
        .is_some();
    Ok(exists)
}

async fn delete_current_processing_job<'a, C>(
    dbx: &'a C,
    job: &palitra_conversion_job::Model,
) -> anyhow::Result<DeleteResult>
where
    C: ConnectionTrait + 'a,
{
    palitra_conversion_job::Entity::delete_many()
        .filter(current_processing_job_condition(job))
        .exec(dbx)
        .await
        .c(h!())
}

async fn lock_current_processing_job(
    txn: &DatabaseTransaction,
    job: &palitra_conversion_job::Model,
) -> anyhow::Result<bool> {
    let exists = palitra_conversion_job::Entity::find()
        .filter(current_processing_job_condition(job))
        .lock_exclusive()
        .one(txn)
        .await
        .c(h!())?
        .is_some();
    Ok(exists)
}

async fn mark_conversion_job_done<'a, C>(
    dbx: &'a C,
    job: &palitra_conversion_job::Model,
    receipt: String,
) -> anyhow::Result<UpdateResult>
where
    C: ConnectionTrait + 'a,
{
    palitra_conversion_job::Entity::update_many()
        .filter(current_processing_job_condition(job))
        .col_expr(
            palitra_conversion_job::Column::Status,
            Expr::value(PALITRA_CONVERSION_JOB_STATUS_DONE),
        )
        .col_expr(
            palitra_conversion_job::Column::FileData,
            Expr::value(Option::<Vec<u8>>::None),
        )
        .col_expr(
            palitra_conversion_job::Column::ConversionReceipt,
            Expr::value(Some(receipt)),
        )
        .col_expr(
            palitra_conversion_job::Column::LastError,
            Expr::value(Option::<String>::None),
        )
        .exec(dbx)
        .await
        .c(h!())
}

async fn mark_conversion_job_error<'a, C>(
    dbx: &'a C,
    job: &palitra_conversion_job::Model,
    error: String,
) -> anyhow::Result<UpdateResult>
where
    C: ConnectionTrait + 'a,
{
    palitra_conversion_job::Entity::update_many()
        .filter(current_processing_job_condition(job))
        .col_expr(
            palitra_conversion_job::Column::Status,
            Expr::value(PALITRA_CONVERSION_JOB_STATUS_ERROR),
        )
        .col_expr(
            palitra_conversion_job::Column::LastError,
            Expr::value(Some(error)),
        )
        .exec(dbx)
        .await
        .c(h!())
}

fn current_processing_job_condition(
    job: &palitra_conversion_job::Model,
) -> Condition {
    Condition::all()
        .add(palitra_conversion_job::Column::Id.eq(job.id))
        .add(palitra_conversion_job::Column::PalitraId.eq(job.palitra_id))
        .add(
            palitra_conversion_job::Column::Status
                .eq(PALITRA_CONVERSION_JOB_STATUS_PROCESSING),
        )
        .add(palitra_conversion_job::Column::AttemptCount.eq(job.attempt_count))
}

fn converted_kmz_file_name(source_file_name: &str) -> String {
    let path = Path::new(source_file_name);
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .map(str::trim)
        .filter(|stem| !stem.is_empty())
        .unwrap_or("palitra");
    format!("{stem}.kmz")
}
