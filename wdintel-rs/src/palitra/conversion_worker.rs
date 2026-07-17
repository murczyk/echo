use crate::config::{
    PALITRA_CONVERSION_JOB_STALE_PROCESSING_SEC,
    PALITRA_CONVERSION_JOB_STATUS_DONE, PALITRA_CONVERSION_JOB_STATUS_ERROR,
    PALITRA_CONVERSION_JOB_STATUS_PENDING,
    PALITRA_CONVERSION_JOB_STATUS_PROCESSING,
    PALITRA_CONVERSION_JOB_TIMEOUT_SEC, PALITRA_CONVERSION_STATUS_ERROR,
    PALITRA_CONVERSION_STATUS_PROCESSING, PALITRA_CONVERSION_STATUS_READY,
    PALITRA_CONVERSION_WORKER_SLEEP_SEC,
};
use crate::entities::*;
use crate::error::AppError;
use crate::h;
use crate::types::*;
use anyhow::bail;
use chrono::Utc;
use sea_orm::prelude::Expr;
use sea_orm::Statement;
use sea_orm::*;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ConversionJobAttempt {
    id: i64,
    palitra_id: i64,
    attempt_count: i32,
}

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
        if reconcile_stale_processing_palitras(env).await.c(h!())? {
            return Ok(false);
        }
        return Ok(true);
    };
    txn.commit().await.c(h!())?;

    let result = process_conversion_job(env, &job).await;
    match result {
        Ok(ConversionJobOutcome::Applied) => {
            if let Some(source_file_sha256) =
                conversion_job_source_file_sha256(&job)
            {
                super::goi_changelog::append_for_palitra_goi_source_file_sha256(
                    &env.dbx,
                    job.palitra_id,
                    &source_file_sha256,
                    super::goi_changelog::ok_entry(
                        "Converted GOI source",
                        "Файл ГОІ успішно сконвертовано.",
                    ),
                )
                .await
                .c(h!())?;
                clear_goi_source_failed_conversion(
                    &env.dbx,
                    job.palitra_id,
                    &source_file_sha256,
                )
                .await
                .c(h!())?;
            }
            env.palitra_worker_context.flush_cache(job.palitra_id).await;
        }
        Ok(ConversionJobOutcome::Stale) => {}
        Err(err) => {
            let error = format!("{err:#}");
            let source_file_sha256 = conversion_job_source_file_sha256(&job);
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
                    Some(error.clone()),
                )
                .await
                .c(h!())?;
                if let Some(source_file_sha256) = source_file_sha256 {
                    mark_goi_source_conversion_failed(
                        &env.dbx,
                        job.palitra_id,
                        &source_file_sha256,
                    )
                    .await
                    .c(h!())?;
                    super::goi_changelog::append_for_palitra_goi_source_file_sha256(
                        &env.dbx,
                        job.palitra_id,
                        &source_file_sha256,
                        super::goi_changelog::error_entry(
                            format!("GOI source conversion failed: {error}"),
                            "Конвертація файлу ГОІ не вдалася. Поточна геометрія Echo залишилась без змін.",
                        ),
                    )
                    .await
                    .c(h!())?;
                }
                env.palitra_worker_context.flush_cache(job.palitra_id).await;
            }
        }
    }

    Ok(false)
}

async fn reconcile_stale_processing_palitras(
    env: &Env,
) -> anyhow::Result<bool> {
    let stale_before = stale_processing_cutoff(Utc::now().fixed_offset());
    let palitras = palitra::Entity::find()
        .filter(palitra::Column::Deleted.eq(false))
        .filter(
            palitra::Column::ConversionStatus
                .eq(PALITRA_CONVERSION_STATUS_PROCESSING),
        )
        .filter(palitra::Column::ConversionLastAttemptAt.lte(stale_before))
        .all(&env.dbx)
        .await
        .c(h!())?;
    let mut changed = false;
    for palitra in palitras {
        if live_conversion_job_exists(&env.dbx, palitra.id)
            .await
            .c(h!())?
        {
            continue;
        }
        if !should_reconcile_processing_without_live_job(
            palitra.deleted,
            &palitra.conversion_status,
            palitra.conversion_last_attempt_at,
            stale_before,
            false,
        ) {
            continue;
        }
        let error = format!(
            "palitra conversion stayed processing for at least {} seconds without a live conversion job",
            PALITRA_CONVERSION_JOB_STALE_PROCESSING_SEC
        );
        super::update_palitra_conversion_status(
            &env.dbx,
            palitra.id,
            PALITRA_CONVERSION_STATUS_ERROR,
            palitra.source_format.clone(),
            None,
            Some(error.clone()),
        )
        .await
        .c(h!())?;
        super::goi_changelog::append_for_palitra_goi_sources(
            &env.dbx,
            palitra.id,
            super::goi_changelog::error_entry(
                error,
                "Конвертація палітри зависла без активної задачі та була позначена як помилка.",
            ),
        )
        .await
        .c(h!())?;
        env.palitra_worker_context.flush_cache(palitra.id).await;
        changed = true;
    }
    Ok(changed)
}

fn stale_processing_cutoff(
    now: chrono::DateTime<chrono::FixedOffset>,
) -> chrono::DateTime<chrono::FixedOffset> {
    now - chrono::Duration::seconds(
        PALITRA_CONVERSION_JOB_STALE_PROCESSING_SEC as i64,
    )
}

fn should_reconcile_processing_without_live_job(
    deleted: bool,
    conversion_status: &str,
    conversion_last_attempt_at: Option<chrono::DateTime<chrono::FixedOffset>>,
    stale_before: chrono::DateTime<chrono::FixedOffset>,
    live_job_exists: bool,
) -> bool {
    !deleted
        && conversion_status == PALITRA_CONVERSION_STATUS_PROCESSING
        && conversion_last_attempt_at
            .is_some_and(|last_attempt_at| last_attempt_at <= stale_before)
        && !live_job_exists
}

async fn live_conversion_job_exists<'a, C>(
    dbx: &'a C,
    palitra_id: i64,
) -> anyhow::Result<bool>
where
    C: ConnectionTrait + 'a,
{
    Ok(palitra_conversion_job::Entity::find()
        .filter(palitra_conversion_job::Column::PalitraId.eq(palitra_id))
        .filter(palitra_conversion_job::Column::Status.is_in([
            PALITRA_CONVERSION_JOB_STATUS_PENDING,
            PALITRA_CONVERSION_JOB_STATUS_PROCESSING,
        ]))
        .one(dbx)
        .await
        .c(h!())?
        .is_some())
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
    if should_schedule_goi_upload_after_conversion(
        palitra.imported_from_goi,
        job.should_schedule_goi_upload,
    ) {
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

fn should_schedule_goi_upload_after_conversion(
    palitra_imported_from_goi: bool,
    job_should_schedule_goi_upload: bool,
) -> bool {
    !palitra_imported_from_goi || job_should_schedule_goi_upload
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

async fn mark_goi_source_conversion_failed<'a, C>(
    dbx: &'a C,
    palitra_id: i64,
    source_file_sha256: &str,
) -> anyhow::Result<UpdateResult>
where
    C: ConnectionTrait + 'a,
{
    goi_palitra_sync::Entity::update_many()
        .filter(goi_palitra_sync::Column::PalitraId.eq(palitra_id))
        .filter(
            goi_palitra_sync::Column::GoiSourceFileSha256
                .eq(source_file_sha256),
        )
        .col_expr(
            goi_palitra_sync::Column::GoiSourceFailedFileSha256,
            Expr::col(goi_palitra_sync::Column::GoiSourceFileSha256).into(),
        )
        .exec(dbx)
        .await
        .c(h!())
}

async fn clear_goi_source_failed_conversion<'a, C>(
    dbx: &'a C,
    palitra_id: i64,
    source_file_sha256: &str,
) -> anyhow::Result<UpdateResult>
where
    C: ConnectionTrait + 'a,
{
    goi_palitra_sync::Entity::update_many()
        .filter(goi_palitra_sync::Column::PalitraId.eq(palitra_id))
        .filter(
            goi_palitra_sync::Column::GoiSourceFileSha256
                .eq(source_file_sha256),
        )
        .col_expr(
            goi_palitra_sync::Column::GoiSourceFailedFileSha256,
            Expr::value(Option::<String>::None),
        )
        .exec(dbx)
        .await
        .c(h!())
}

fn conversion_job_source_file_sha256(
    job: &palitra_conversion_job::Model,
) -> Option<String> {
    job.file_data.as_ref().map(sha256::digest)
}

fn current_processing_job_condition(
    job: &palitra_conversion_job::Model,
) -> Condition {
    let attempt = conversion_job_attempt(job);
    Condition::all()
        .add(palitra_conversion_job::Column::Id.eq(attempt.id))
        .add(palitra_conversion_job::Column::PalitraId.eq(attempt.palitra_id))
        .add(
            palitra_conversion_job::Column::Status
                .eq(PALITRA_CONVERSION_JOB_STATUS_PROCESSING),
        )
        .add(
            palitra_conversion_job::Column::AttemptCount
                .eq(attempt.attempt_count),
        )
}

fn conversion_job_attempt(
    job: &palitra_conversion_job::Model,
) -> ConversionJobAttempt {
    ConversionJobAttempt {
        id: job.id,
        palitra_id: job.palitra_id,
        attempt_count: job.attempt_count,
    }
}

#[cfg(test)]
fn is_current_processing_attempt(
    expected: ConversionJobAttempt,
    current: &palitra_conversion_job::Model,
) -> bool {
    current.id == expected.id
        && current.palitra_id == expected.palitra_id
        && current.status == PALITRA_CONVERSION_JOB_STATUS_PROCESSING
        && current.attempt_count == expected.attempt_count
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::functest::tests::{cleanup, find_test_palitra, mk_palitra};
    use serial_test::serial;

    fn conversion_job(
        status: &str,
        attempt_count: i32,
    ) -> palitra_conversion_job::Model {
        let now = Utc::now().fixed_offset();
        palitra_conversion_job::Model {
            id: 7,
            palitra_id: 42,
            source_file_name: "source.gpx".to_string(),
            source_format: "gpx".to_string(),
            content_type: None,
            file_data: Some(vec![1, 2, 3]),
            status: status.to_string(),
            conversion_receipt: None,
            created_at: now,
            last_attempt_at: Some(now),
            attempt_count,
            last_error: None,
            should_schedule_goi_upload: false,
        }
    }

    #[test]
    fn stale_completion_from_replaced_attempt_is_not_current() {
        let attempt_1 =
            conversion_job(PALITRA_CONVERSION_JOB_STATUS_PROCESSING, 1);
        let attempt_1_identity = conversion_job_attempt(&attempt_1);
        let attempt_2 =
            conversion_job(PALITRA_CONVERSION_JOB_STATUS_PROCESSING, 2);

        assert!(is_current_processing_attempt(
            attempt_1_identity,
            &attempt_1
        ));
        assert!(!is_current_processing_attempt(
            attempt_1_identity,
            &attempt_2
        ));
    }

    #[test]
    fn current_attempt_requires_processing_status() {
        let attempt =
            conversion_job(PALITRA_CONVERSION_JOB_STATUS_PROCESSING, 1);
        let identity = conversion_job_attempt(&attempt);
        let done = conversion_job(PALITRA_CONVERSION_JOB_STATUS_DONE, 1);

        assert!(!is_current_processing_attempt(identity, &done));
    }

    #[test]
    fn goi_origin_source_conversion_does_not_schedule_upload_by_default() {
        assert!(!should_schedule_goi_upload_after_conversion(true, false));
        assert!(should_schedule_goi_upload_after_conversion(false, false));
        assert!(should_schedule_goi_upload_after_conversion(true, true));
    }

    #[test]
    fn stale_processing_reconciliation_requires_no_live_job_and_stale_attempt()
    {
        let now = Utc::now().fixed_offset();
        let stale_before = stale_processing_cutoff(now);
        let stale_attempt = stale_before - chrono::Duration::seconds(1);
        let fresh_attempt = stale_before + chrono::Duration::seconds(1);

        assert!(should_reconcile_processing_without_live_job(
            false,
            PALITRA_CONVERSION_STATUS_PROCESSING,
            Some(stale_attempt),
            stale_before,
            false,
        ));
        assert!(!should_reconcile_processing_without_live_job(
            false,
            PALITRA_CONVERSION_STATUS_PROCESSING,
            Some(fresh_attempt),
            stale_before,
            false,
        ));
        assert!(!should_reconcile_processing_without_live_job(
            false,
            PALITRA_CONVERSION_STATUS_PROCESSING,
            Some(stale_attempt),
            stale_before,
            true,
        ));
    }

    #[serial]
    #[tokio::test]
    async fn stale_processing_reconciliation_marks_only_stale_rows_without_live_jobs(
    ) {
        let env = cleanup().await.unwrap();
        let now = Utc::now().fixed_offset();
        let stale_attempt_at = now
            - chrono::Duration::seconds(
                PALITRA_CONVERSION_JOB_STALE_PROCESSING_SEC as i64 + 1,
            );
        let stale_palitra = find_test_palitra(&env.dbx).await.unwrap();
        let mut stale_palitra = stale_palitra.into_active_model();
        stale_palitra.conversion_status =
            Set(PALITRA_CONVERSION_STATUS_PROCESSING.to_string());
        stale_palitra.conversion_last_attempt_at = Set(Some(stale_attempt_at));
        let stale_palitra = stale_palitra.update(&env.dbx).await.unwrap();
        let fresh_palitra = mk_palitra(
            &env.dbx,
            palitra::ActiveModel {
                name: Set("Fresh Processing Palitra".to_string()),
                author: Set(Some("Tester".to_string())),
                deleted: Set(false),
                created_at: Set(Utc::now().naive_utc()),
                conversion_status: Set(
                    PALITRA_CONVERSION_STATUS_PROCESSING.to_string()
                ),
                conversion_last_attempt_at: Set(Some(now)),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        assert!(reconcile_stale_processing_palitras(env.as_ref())
            .await
            .unwrap());

        let stale_palitra = palitra::Entity::find_by_id(stale_palitra.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        let fresh_palitra = palitra::Entity::find_by_id(fresh_palitra.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(
            stale_palitra.conversion_status,
            PALITRA_CONVERSION_STATUS_ERROR
        );
        assert!(stale_palitra.conversion_error.as_deref().is_some_and(
            |error| error.contains("without a live conversion job")
        ));
        assert_eq!(
            fresh_palitra.conversion_status,
            PALITRA_CONVERSION_STATUS_PROCESSING
        );
    }

    #[serial]
    #[tokio::test]
    async fn replacement_conversion_makes_previous_processing_attempt_stale() {
        let env = cleanup().await.unwrap();
        let palitra = find_test_palitra(&env.dbx).await.unwrap();
        crate::palitra::schedule_palitra_conversion_with_goi_upload(
            &env.dbx,
            palitra.id,
            "first.gpx".to_string(),
            "gpx".to_string(),
            None,
            vec![1, 2, 3],
            true,
        )
        .await
        .unwrap();
        let mut attempt_1 = palitra_conversion_job::Entity::find()
            .filter(palitra_conversion_job::Column::PalitraId.eq(palitra.id))
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap()
            .into_active_model();
        attempt_1.status =
            Set(PALITRA_CONVERSION_JOB_STATUS_PROCESSING.to_string());
        attempt_1.attempt_count = Set(1);
        let attempt_1 = attempt_1.update(&env.dbx).await.unwrap();

        assert!(is_current_processing_job(&env.dbx, &attempt_1)
            .await
            .unwrap());

        let txn = env.dbx.begin().await.unwrap();
        crate::palitra::schedule_palitra_replacement_conversion_with_goi_upload(
            &txn,
            palitra.id,
            "replacement.gpx".to_string(),
            "gpx".to_string(),
            None,
            vec![4, 5, 6],
            true,
        )
        .await
        .unwrap();
        txn.commit().await.unwrap();

        assert!(!is_current_processing_job(&env.dbx, &attempt_1)
            .await
            .unwrap());

        let mut replacement = palitra_conversion_job::Entity::find()
            .filter(palitra_conversion_job::Column::PalitraId.eq(palitra.id))
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap()
            .into_active_model();
        replacement.status =
            Set(PALITRA_CONVERSION_JOB_STATUS_PROCESSING.to_string());
        replacement.attempt_count = Set(2);
        let replacement = replacement.update(&env.dbx).await.unwrap();

        assert!(is_current_processing_job(&env.dbx, &replacement)
            .await
            .unwrap());
        assert!(!is_current_processing_job(&env.dbx, &attempt_1)
            .await
            .unwrap());

        let update_result =
            mark_conversion_job_done(&env.dbx, &attempt_1, "receipt".into())
                .await
                .unwrap();
        let stored_replacement =
            palitra_conversion_job::Entity::find_by_id(replacement.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();

        assert_eq!(update_result.rows_affected, 0);
        assert_eq!(
            stored_replacement.status,
            PALITRA_CONVERSION_JOB_STATUS_PROCESSING
        );
        assert_eq!(stored_replacement.conversion_receipt, None);
        assert_eq!(stored_replacement.source_file_name, "replacement.gpx");
    }
}
