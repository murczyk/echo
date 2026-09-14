use crate::config::MAX_FIX_WHATSAPP_SENDERS_MESSAGE_DAYS;
use crate::entities::{signal_message, signal_message_media};
use crate::error::AppError;
use crate::h;
use crate::messenger::worker;
use crate::storage;
use crate::types::info;
use crate::types::{warn, Mode, ShortContext};
use chrono::{DateTime, Utc};
use indicatif::{HumanBytes, MultiProgress, ProgressBar, ProgressStyle};
use opendal::{ErrorKind, Operator};
use sea_orm::sea_query::Expr;
use sea_orm::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufWriter, Write};
use std::path::{Path, PathBuf};

struct LargeMediaMigration<'a> {
    config: &'a crate::config::Config,
    dbx: &'a DatabaseConnection,
    s3: &'a Operator,
    s3_config: &'a storage::S3Config,
    strongbox_key: &'a str,
}

pub async fn oneoff_migrate_large_media_to_plaintext(
    mode: Mode,
    dry_run: bool,
) -> Result<(), AppError> {
    let app_config = crate::config::read_config(mode)?;
    let dbx = crate::new_pg_pool_from_config(&app_config).await.c(h!())?;
    let media = load_encrypted_media_for_plaintext_migration(&dbx).await?;
    let cleanup_media = load_plaintext_media_for_cleanup(&dbx).await?;
    let total_bytes = media_total_bytes(&media)?;

    print_migration_summary(
        media.len(),
        total_bytes,
        cleanup_media.len(),
        dry_run,
    );
    if dry_run || (media.is_empty() && cleanup_media.is_empty()) {
        return Ok(());
    }

    let config = app_config.s3_config.as_ref().ok_or(AppError::BL {
        msg: "S3 is not configured".to_string(),
    })?;
    let s3_config = storage::S3Config::from(config);
    let s3 = storage::build_s3_operator(&s3_config)?;
    let migration = LargeMediaMigration {
        config: &app_config,
        dbx: &dbx,
        s3: &s3,
        s3_config: &s3_config,
        strongbox_key: &config.strongbox_key,
    };
    let migration_result =
        migrate_large_media(&migration, &media, total_bytes).await;
    let cleanup_result =
        cleanup_migrated_media(&migration, &cleanup_media).await;
    combine_migration_results(migration_result, cleanup_result)
}

fn combine_migration_results(
    migration_result: Result<(), AppError>,
    cleanup_result: Result<(), AppError>,
) -> Result<(), AppError> {
    match (migration_result, cleanup_result) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
        (Err(migration_error), Err(cleanup_error)) => Err(AppError::BL {
            msg: format!(
                "plaintext media migration failed: {migration_error}; cleanup failed: {cleanup_error}"
            ),
        }),
    }
}

async fn load_encrypted_media_for_plaintext_migration(
    dbx: &DatabaseConnection,
) -> Result<Vec<signal_message_media::Model>, AppError> {
    signal_message_media::Entity::find()
        .filter(signal_message_media::Column::IsEncrypted.eq(true))
        .filter(plaintext_migration_condition())
        .order_by_asc(signal_message_media::Column::CreatedAt)
        .all(dbx)
        .await
        .c(h!())
        .map_err(Into::into)
}

async fn load_plaintext_media_for_cleanup(
    dbx: &DatabaseConnection,
) -> Result<Vec<signal_message_media::Model>, AppError> {
    signal_message_media::Entity::find()
        .filter(signal_message_media::Column::IsEncrypted.eq(false))
        .filter(plaintext_migration_condition())
        .order_by_asc(signal_message_media::Column::CreatedAt)
        .all(dbx)
        .await
        .c(h!())
        .map_err(Into::into)
}

fn plaintext_migration_condition() -> Condition {
    let mut condition = Condition::any().add(
        signal_message_media::Column::SizeBytes
            .gt(crate::config::MESSENGER_MEDIA_ENCRYPTION_MAX_FILE_SIZE_BYTES),
    );
    for content_type in
        crate::config::MESSENGER_MEDIA_ENCRYPTION_EXCLUDED_CONTENT_TYPES
    {
        condition = condition.add(Expr::cust_with_values(
            "lower(trim(split_part(content_type, ';', 1))) = $1",
            [*content_type],
        ));
    }
    for extension in
        crate::config::MESSENGER_MEDIA_ENCRYPTION_EXCLUDED_FILE_EXTENSIONS
    {
        condition = condition.add(Expr::cust_with_values(
            r#"
            lower(trim(split_part(content_type, ';', 1))) not like 'audio/%'
            and lower(trim(split_part(content_type, ';', 1))) not like 'image/%'
            and (lower(file_ext) = $1 or lower(file_name) like $2)
            "#,
            [String::from(*extension), format!("%.{extension}")],
        ));
    }
    condition
}

fn media_total_bytes(
    media: &[signal_message_media::Model],
) -> Result<u64, AppError> {
    media
        .iter()
        .try_fold(0_u64, |total, media| -> Result<u64, AppError> {
            let size = u64::try_from(media.size_bytes).c(h!())?;
            total.checked_add(size).ok_or(AppError::BL {
                msg: "plaintext media migration byte total overflowed"
                    .to_string(),
            })
        })
}

fn print_migration_summary(
    count: usize,
    total_bytes: u64,
    cleanup_count: usize,
    dry_run: bool,
) {
    let action = if dry_run {
        "would migrate"
    } else {
        "will migrate"
    };
    println!(
        "> {action} {count} encrypted media files larger than {} or detected as video ({})",
        HumanBytes(
            crate::config::MESSENGER_MEDIA_ENCRYPTION_MAX_FILE_SIZE_BYTES
                as u64
        ),
        HumanBytes(total_bytes),
    );
    println!(
        "> {} {cleanup_count} existing plaintext media files for leftover encrypted objects",
        if dry_run { "would check" } else { "will check" },
    );
    if dry_run {
        println!("> dry run: no B2 objects or database rows were changed");
    }
}

async fn migrate_large_media(
    migration: &LargeMediaMigration<'_>,
    media: &[signal_message_media::Model],
    total_bytes: u64,
) -> Result<(), AppError> {
    let (_multi_progress, media_progress, bytes_progress) =
        migration_progress(media, total_bytes);
    let mut failures = Vec::new();
    for item in media {
        media_progress.set_message(format!("{}: checking", item.id));
        if let Err(error) =
            migrate_large_media_item(migration, item, &media_progress).await
        {
            media_progress.println(format!("failed {}: {error}", item.id));
            failures.push(item.id);
        }
        media_progress.inc(1);
        bytes_progress.inc(u64::try_from(item.size_bytes).c(h!())?);
    }
    finish_migration_progress(&media_progress, &bytes_progress, failures.len());
    migration_failure_result(&failures)
}

fn finish_migration_progress(
    media_progress: &ProgressBar,
    bytes_progress: &ProgressBar,
    failure_count: usize,
) {
    if failure_count == 0 {
        media_progress.finish_with_message("all media migrated");
        bytes_progress.finish_with_message("all bytes migrated");
    } else {
        media_progress.finish_with_message(format!(
            "migration finished with {failure_count} failed media files"
        ));
        bytes_progress.finish_with_message("all media bytes attempted");
    }
}

fn migration_failure_result(failures: &[uuid::Uuid]) -> Result<(), AppError> {
    if failures.is_empty() {
        return Ok(());
    }
    let failed_media = failures
        .iter()
        .map(uuid::Uuid::to_string)
        .collect::<Vec<_>>()
        .join("; ");
    Err(AppError::BL {
        msg: format!(
            "{} media files failed plaintext migration: {failed_media}",
            failures.len()
        ),
    })
}

fn migration_progress(
    media: &[signal_message_media::Model],
    total_bytes: u64,
) -> (MultiProgress, ProgressBar, ProgressBar) {
    let multi = MultiProgress::new();
    let media_progress = multi.add(ProgressBar::new(media.len() as u64));
    media_progress.set_style(
        ProgressStyle::with_template(
            "{spinner:.green} media [{bar:40.cyan/blue}] {pos}/{len} ({eta}) {msg}",
        )
        .expect("valid media migration progress template")
        .progress_chars("=>-"),
    );
    let bytes_progress = multi.add(ProgressBar::new(total_bytes));
    bytes_progress.set_style(
        ProgressStyle::with_template(
            "  bytes [{bar:40.magenta/blue}] {bytes}/{total_bytes} ({bytes_per_sec}, {eta}) {msg}",
        )
        .expect("valid media migration byte progress template")
        .progress_chars("=>-"),
    );
    (multi, media_progress, bytes_progress)
}

async fn migrate_large_media_item(
    migration: &LargeMediaMigration<'_>,
    media: &signal_message_media::Model,
    progress: &ProgressBar,
) -> Result<(), AppError> {
    let expected_size = u64::try_from(media.size_bytes).c(h!())?;
    let encrypted_key = crate::messenger::media::media_object_key(media);
    let plaintext_key = plaintext_media_object_key(media);
    let plaintext_is_ready = object_has_size(
        migration.s3,
        migration.s3_config,
        &plaintext_key,
        expected_size,
    )
    .await?;
    let is_video = crate::messenger::media::is_video_media(media);
    if should_load_plaintext_bytes(plaintext_is_ready) {
        match migrate_media_object(
            migration,
            media,
            progress,
            &encrypted_key,
            &plaintext_key,
            expected_size,
            is_video,
        )
        .await
        {
            Ok(()) => {}
            Err(error) => {
                cleanup_plaintext_if_media_was_deleted(
                    migration,
                    media.id,
                    &plaintext_key,
                )
                .await
                .map_err(|cleanup_error| AppError::BL {
                    msg: format!(
                        "media {} migration failed: {error}; orphan cleanup failed: {cleanup_error}",
                        media.id
                    ),
                })?;
                return Err(error);
            }
        }
    }

    progress.set_message(format!("{}: updating database", media.id));
    write_plaintext_migration_marker(migration, media.id).await?;
    let mark_result =
        mark_media_plaintext(migration.dbx, media.id, &plaintext_key).await?;
    if mark_result == MarkMediaPlaintext::Missing {
        delete_plaintext_orphan(
            migration.s3,
            migration.s3_config,
            &plaintext_key,
        )
        .await?;
        delete_plaintext_migration_marker_best_effort(migration, media.id)
            .await;
        return Err(AppError::BL {
            msg: format!(
                "media {} was deleted while its plaintext object was being migrated",
                media.id
            ),
        });
    }
    Ok(())
}

fn should_load_plaintext_bytes(plaintext_is_ready: bool) -> bool {
    !plaintext_is_ready
}

async fn cleanup_migrated_media(
    migration: &LargeMediaMigration<'_>,
    media: &[signal_message_media::Model],
) -> Result<(), AppError> {
    if media.is_empty() {
        return Ok(());
    }
    let progress = ProgressBar::new(media.len() as u64);
    progress.set_style(
        ProgressStyle::with_template(
            "{spinner:.green} cleanup [{bar:40.yellow/blue}] {pos}/{len} ({eta}) {msg}",
        )
        .expect("valid media migration cleanup progress template")
        .progress_chars("=>-"),
    );
    let mut failures = Vec::new();
    for item in media {
        progress.set_message(format!("{}: verifying plaintext", item.id));
        if let Err(error) = cleanup_migrated_media_item(migration, item).await {
            warn!(
                "failed to clean migrated media {} after plaintext verification: {error:#?}",
                item.id
            );
            failures.push(item.id);
        }
        progress.inc(1);
    }
    if failures.is_empty() {
        progress.finish_with_message("plaintext media cleanup checked");
        Ok(())
    } else {
        progress.finish_with_message(format!(
            "plaintext media cleanup finished with {} failures",
            failures.len()
        ));
        cleanup_failure_result(&failures)
    }
}

fn cleanup_failure_result(failures: &[uuid::Uuid]) -> Result<(), AppError> {
    let failed_media = failures
        .iter()
        .map(uuid::Uuid::to_string)
        .collect::<Vec<_>>()
        .join("; ");
    Err(AppError::BL {
        msg: format!(
            "{} plaintext media files failed cleanup: {failed_media}",
            failures.len()
        ),
    })
}

fn plaintext_media_object_key(media: &signal_message_media::Model) -> String {
    if media.is_encrypted {
        format!(
            "{}.plaintext",
            crate::messenger::media::media_object_key(media)
        )
    } else {
        crate::messenger::media::media_object_key(media)
    }
}

fn encrypted_media_object_key(media: &signal_message_media::Model) -> String {
    if media.is_encrypted {
        crate::messenger::media::media_object_key(media)
    } else {
        crate::messenger::media::media_object_key(media)
            .strip_suffix(".plaintext")
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| storage::nested_object_key(&media.id))
    }
}

async fn cleanup_migrated_media_item(
    migration: &LargeMediaMigration<'_>,
    media: &signal_message_media::Model,
) -> Result<(), AppError> {
    let expected_size = u64::try_from(media.size_bytes).c(h!())?;
    let plaintext_key = plaintext_media_object_key(media);
    let Some(plaintext) =
        object_state(migration.s3, migration.s3_config, &plaintext_key).await?
    else {
        return restore_media_encryption_after_invalid_plaintext(
            migration, media,
        )
        .await;
    };
    if plaintext.size != expected_size {
        return restore_media_encryption_after_invalid_plaintext(
            migration, media,
        )
        .await;
    }
    let encrypted_key = encrypted_media_object_key(media);
    if !object_exists(migration.s3, migration.s3_config, &encrypted_key).await?
    {
        delete_plaintext_migration_marker_best_effort(migration, media.id)
            .await;
        remove_local_cache_best_effort(migration.config, media.id).await;
        return Ok(());
    }
    if signal_message_media::Entity::find()
        .filter(signal_message_media::Column::StorageKey.eq(&encrypted_key))
        .count(migration.dbx)
        .await
        .c(h!())?
        > 0
    {
        remove_local_cache_best_effort(migration.config, media.id).await;
        return Ok(());
    }
    if !ensure_plaintext_cleanup_grace(migration, media.id).await? {
        info!(
            "keeping encrypted migration fallback for media {} until the plaintext grace period elapses",
            media.id
        );
        return Ok(());
    }
    remove_local_cache_best_effort(migration.config, media.id).await;
    if delete_encrypted_object_best_effort(
        migration.s3,
        migration.s3_config,
        &encrypted_key,
    )
    .await
    {
        delete_plaintext_migration_marker_best_effort(migration, media.id)
            .await;
    }
    Ok(())
}

async fn migrate_media_object(
    migration: &LargeMediaMigration<'_>,
    media: &signal_message_media::Model,
    progress: &ProgressBar,
    encrypted_key: &str,
    plaintext_key: &str,
    expected_size: u64,
    is_video: bool,
) -> Result<(), AppError> {
    progress.set_message(format!("{}: downloading and decrypting", media.id));
    let plaintext =
        storage::download_and_decrypt_messenger_media_from_s3_with_operator_timeout_and_size_limit(
            &Some(migration.s3.clone()),
            &Some(migration.s3_config.clone()),
            migration.strongbox_key,
            encrypted_key,
            std::time::Duration::from_secs(
                crate::config::MESSENGER_MEDIA_CACHE_DOWNLOAD_TIMEOUT_SECS,
            ),
            crate::config::MESSENGER_MEDIA_MIGRATION_WHOLE_OBJECT_DECRYPT_MAX_SIZE_BYTES,
        )
        .await?;
    let actual_size = plaintext.len() as u64;
    if actual_size != expected_size {
        return Err(AppError::BL {
            msg: format!(
                "decrypted media {} has size {}, expected {}",
                media.id, actual_size, expected_size
            ),
        });
    }

    if is_video {
        progress.set_message(format!("{}: generating thumbnail", media.id));
        if let Err(error) =
            crate::messenger::media_thumbnail::generate_thumbnail_from_bytes(
                migration.config,
                media.id,
                &plaintext,
            )
            .await
        {
            warn!(
                "failed to generate thumbnail while migrating media {}; continuing plaintext migration: {error:#?}",
                media.id
            );
        }
    }
    progress.set_message(format!("{}: uploading plaintext", media.id));
    storage::upload_plaintext_to_s3_with_operator(
        &Some(migration.s3.clone()),
        migration.s3_config,
        plaintext_key,
        plaintext,
    )
    .await?;
    if !object_has_size(
        migration.s3,
        migration.s3_config,
        plaintext_key,
        expected_size,
    )
    .await?
    {
        return Err(AppError::BL {
            msg: format!(
                "uploaded plaintext media {} failed exact-size verification",
                media.id
            ),
        });
    }
    Ok(())
}

async fn restore_media_encryption_after_invalid_plaintext(
    migration: &LargeMediaMigration<'_>,
    media: &signal_message_media::Model,
) -> Result<(), AppError> {
    let current_media = signal_message_media::Entity::find_by_id(media.id)
        .one(migration.dbx)
        .await
        .c(h!())?;
    let encrypted_key = current_media
        .as_ref()
        .map(encrypted_media_object_key)
        .unwrap_or_else(|| encrypted_media_object_key(media));
    if !object_exists(migration.s3, migration.s3_config, &encrypted_key).await?
    {
        if current_media.is_none() {
            delete_plaintext_migration_marker_best_effort(migration, media.id)
                .await;
            return Ok(());
        }
        return Err(AppError::BL {
            msg: format!(
                "plaintext media {} has no valid plaintext or encrypted object",
                media.id
            ),
        });
    }

    let updated = signal_message_media::Entity::update_many()
        .col_expr(signal_message_media::Column::IsEncrypted, Expr::value(true))
        .col_expr(
            signal_message_media::Column::StorageKey,
            Expr::value(encrypted_key.clone()),
        )
        .filter(signal_message_media::Column::Id.eq(media.id))
        .filter(signal_message_media::Column::IsEncrypted.eq(false))
        .exec(migration.dbx)
        .await
        .c(h!())?;
    if updated.rows_affected == 1 {
        delete_plaintext_migration_marker_best_effort(migration, media.id)
            .await;
        warn!(
            "restored encrypted storage for media {} because its plaintext object is missing or has the wrong size",
            media.id
        );
        return Ok(());
    }

    match signal_message_media::Entity::find_by_id(media.id)
        .one(migration.dbx)
        .await
        .c(h!())?
    {
        None => {
            delete_plaintext_migration_marker_best_effort(migration, media.id)
                .await;
            Ok(())
        }
        Some(media) if media.is_encrypted => {
            delete_plaintext_migration_marker_best_effort(migration, media.id)
                .await;
            Ok(())
        }
        Some(_) => Err(AppError::BL {
            msg: format!(
                "expected to restore encrypted storage for media {}, updated {} rows",
                media.id,
                updated.rows_affected,
            ),
        }),
    }
}

async fn object_has_size(
    s3: &Operator,
    s3_config: &storage::S3Config,
    object_key: &str,
    expected_size: u64,
) -> Result<bool, AppError> {
    Ok(object_state(s3, s3_config, object_key)
        .await?
        .is_some_and(|object| object.size == expected_size))
}

struct ObjectState {
    size: u64,
    last_modified: Option<DateTime<Utc>>,
}

async fn object_state(
    s3: &Operator,
    s3_config: &storage::S3Config,
    object_key: &str,
) -> Result<Option<ObjectState>, AppError> {
    let remote_key = s3_config.prefixed_key(object_key);
    match s3.stat(&remote_key).await {
        Ok(metadata) => Ok(Some(ObjectState {
            size: metadata.content_length(),
            last_modified: metadata.last_modified(),
        })),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(anyhow::Error::from(error).context(h!()).into()),
    }
}

fn migration_marker_grace_elapsed(
    object: &ObjectState,
    now: DateTime<Utc>,
) -> bool {
    object.last_modified.is_some_and(|last_modified| {
        now.signed_duration_since(last_modified).num_seconds()
            >= crate::config::MESSENGER_MEDIA_PLAINTEXT_MIGRATION_ENCRYPTED_OBJECT_GRACE_SECS
    })
}

async fn ensure_plaintext_cleanup_grace(
    migration: &LargeMediaMigration<'_>,
    media_id: uuid::Uuid,
) -> Result<bool, AppError> {
    let marker_key =
        storage::plaintext_media_migration_marker_object_key(&media_id);
    let Some(marker) =
        object_state(migration.s3, migration.s3_config, &marker_key).await?
    else {
        write_plaintext_migration_marker(migration, media_id).await?;
        return Ok(false);
    };
    Ok(migration_marker_grace_elapsed(&marker, Utc::now()))
}

async fn write_plaintext_migration_marker(
    migration: &LargeMediaMigration<'_>,
    media_id: uuid::Uuid,
) -> Result<(), AppError> {
    let marker_key =
        storage::plaintext_media_migration_marker_object_key(&media_id);
    let remote_key = migration.s3_config.prefixed_key(&marker_key);
    migration
        .s3
        .write(
            &remote_key,
            crate::config::MESSENGER_MEDIA_PLAINTEXT_MIGRATION_MARKER_CONTENT,
        )
        .await
        .c(h!())?;
    Ok(())
}

async fn object_exists(
    s3: &Operator,
    s3_config: &storage::S3Config,
    object_key: &str,
) -> Result<bool, AppError> {
    let remote_key = s3_config.prefixed_key(object_key);
    match s3.stat(&remote_key).await {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(anyhow::Error::from(error).context(h!()).into()),
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum MarkMediaPlaintext {
    Updated,
    AlreadyPlaintext,
    Missing,
}

async fn mark_media_plaintext(
    dbx: &DatabaseConnection,
    media_id: uuid::Uuid,
    plaintext_key: &str,
) -> Result<MarkMediaPlaintext, AppError> {
    let updated = signal_message_media::Entity::update_many()
        .col_expr(
            signal_message_media::Column::IsEncrypted,
            Expr::value(false),
        )
        .col_expr(
            signal_message_media::Column::StorageKey,
            Expr::value(plaintext_key),
        )
        .filter(signal_message_media::Column::Id.eq(media_id))
        .filter(signal_message_media::Column::IsEncrypted.eq(true))
        .exec(dbx)
        .await
        .c(h!())?;
    if updated.rows_affected == 1 {
        return Ok(MarkMediaPlaintext::Updated);
    }
    match signal_message_media::Entity::find_by_id(media_id)
        .one(dbx)
        .await
        .c(h!())?
    {
        None => Ok(MarkMediaPlaintext::Missing),
        Some(media) if !media.is_encrypted => {
            Ok(MarkMediaPlaintext::AlreadyPlaintext)
        }
        Some(_) => Err(AppError::BL {
            msg: format!(
                "expected to mark one media row plaintext for {media_id}, updated {}",
                updated.rows_affected
            ),
        }),
    }
}

async fn cleanup_plaintext_if_media_was_deleted(
    migration: &LargeMediaMigration<'_>,
    media_id: uuid::Uuid,
    plaintext_key: &str,
) -> Result<(), AppError> {
    if signal_message_media::Entity::find_by_id(media_id)
        .one(migration.dbx)
        .await
        .c(h!())?
        .is_some()
    {
        return Ok(());
    }
    delete_plaintext_orphan(migration.s3, migration.s3_config, plaintext_key)
        .await
}

async fn delete_plaintext_orphan(
    s3: &Operator,
    s3_config: &storage::S3Config,
    plaintext_key: &str,
) -> Result<(), AppError> {
    let remote_key = s3_config.prefixed_key(plaintext_key);
    s3.delete(&remote_key).await.c(h!())?;
    Ok(())
}

async fn delete_encrypted_object_best_effort(
    s3: &Operator,
    s3_config: &storage::S3Config,
    encrypted_key: &str,
) -> bool {
    let remote_key = s3_config.prefixed_key(encrypted_key);
    match s3.delete(&remote_key).await {
        Ok(()) => true,
        Err(error) => {
            warn!(
                "plaintext media migration completed, but failed to delete encrypted object {remote_key}: {error:#?}"
            );
            false
        }
    }
}

async fn delete_plaintext_migration_marker_best_effort(
    migration: &LargeMediaMigration<'_>,
    media_id: uuid::Uuid,
) {
    let marker_key =
        storage::plaintext_media_migration_marker_object_key(&media_id);
    let remote_key = migration.s3_config.prefixed_key(&marker_key);
    if let Err(error) = migration.s3.delete(&remote_key).await {
        warn!(
            "failed to delete plaintext migration marker {remote_key}: {error:#?}"
        );
    }
}

async fn remove_local_cache_best_effort(
    config: &crate::config::Config,
    media_id: uuid::Uuid,
) {
    crate::messenger::media_cache::remove_cached_media_file_best_effort(
        config, media_id,
    )
    .await;
}

#[derive(Clone)]
struct MediaStorageAudit<'a> {
    dbx: &'a DatabaseConnection,
    s3: &'a Operator,
    s3_config: &'a storage::S3Config,
    strongbox_key: &'a str,
}

#[derive(Debug, Serialize)]
struct MediaStorageAuditRecord {
    record_type: &'static str,
    media_id: uuid::Uuid,
    signal_message_id: i64,
    storage_key: String,
    created_at: chrono::NaiveDateTime,
    status: &'static str,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct MediaStorageRepairEntry {
    media_id: uuid::Uuid,
    source_path: PathBuf,
}

#[derive(Debug, Serialize)]
struct MediaStorageRepairRecord {
    record_type: &'static str,
    media_id: uuid::Uuid,
    old_storage_key: String,
    new_storage_key: Option<String>,
    status: &'static str,
    error: Option<String>,
}

pub async fn oneoff_audit_media_storage(
    mode: Mode,
    ps: &crate::OneoffAuditMediaStoragePs,
) -> Result<(), AppError> {
    if ps.concurrency == 0 {
        return Err(AppError::BL {
            msg: "--concurrency must be at least 1".to_string(),
        });
    }
    let since_ts = parse_media_storage_timestamp(&ps.since_ts)?;
    let till_ts = ps
        .till_ts
        .as_deref()
        .map(parse_media_storage_timestamp)
        .transpose()?;
    if till_ts.is_some_and(|till_ts| till_ts <= since_ts) {
        return Err(AppError::BL {
            msg: "--till-ts must be later than --since-ts".to_string(),
        });
    }
    let app_config = crate::config::read_config(mode).c(h!())?;
    let dbx = crate::new_pg_pool_from_config(&app_config).await.c(h!())?;
    let config = app_config.s3_config.as_ref().ok_or(AppError::BL {
        msg: "S3 is not configured".to_string(),
    })?;
    let s3_config = storage::S3Config::from(config);
    let s3 = storage::build_s3_operator(&s3_config).c(h!())?;
    let audit = MediaStorageAudit {
        dbx: &dbx,
        s3: &s3,
        s3_config: &s3_config,
        strongbox_key: &config.strongbox_key,
    };
    let media = load_media_storage_audit_rows(
        &dbx,
        since_ts,
        till_ts,
        ps.after_media_id,
        ps.limit,
    )
    .await
    .c(h!())?;
    let records =
        audit_media_storage_rows(&audit, &media, ps.concurrency).await;
    let repair_entries = ps
        .repair_manifest
        .as_deref()
        .map(read_media_storage_repair_manifest)
        .transpose()
        .c(h!())?
        .unwrap_or_default();
    let repair_records =
        repair_media_storage_rows(&audit, &media, &repair_entries, ps.apply)
            .await;
    write_media_storage_report(&ps.output, &records, &repair_records)
        .c(h!())?;
    print_media_storage_summary(
        &ps.output,
        &records,
        &repair_records,
        media.last(),
    );
    let failed_repairs = repair_records
        .iter()
        .filter(|record| record.status == "failed")
        .count();
    if failed_repairs > 0 {
        return Err(AppError::BL {
            msg: format!(
                "{failed_repairs} media storage repairs failed; see {}",
                ps.output.display()
            ),
        });
    }
    Ok(())
}

fn parse_media_storage_timestamp(
    value: &str,
) -> Result<chrono::NaiveDateTime, AppError> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|value| value.naive_utc())
        .map_err(|error| AppError::BL {
            msg: format!("invalid RFC3339 timestamp '{value}': {error}"),
        })
}

async fn load_media_storage_audit_rows(
    dbx: &DatabaseConnection,
    since_ts: chrono::NaiveDateTime,
    till_ts: Option<chrono::NaiveDateTime>,
    after_media_id: Option<uuid::Uuid>,
    limit: u64,
) -> Result<Vec<signal_message_media::Model>, AppError> {
    let mut query = signal_message_media::Entity::find()
        .filter(signal_message_media::Column::CreatedAt.gte(since_ts));
    if let Some(till_ts) = till_ts {
        query =
            query.filter(signal_message_media::Column::CreatedAt.lt(till_ts));
    }
    if let Some(after_media_id) = after_media_id {
        query =
            query.filter(signal_message_media::Column::Id.gt(after_media_id));
    }
    query
        .order_by_asc(signal_message_media::Column::Id)
        .limit(limit)
        .all(dbx)
        .await
        .c(h!())
        .map_err(Into::into)
}

async fn audit_media_storage_rows(
    audit: &MediaStorageAudit<'_>,
    media: &[signal_message_media::Model],
    concurrency: usize,
) -> Vec<MediaStorageAuditRecord> {
    use futures_util::StreamExt;

    let mut records: Vec<MediaStorageAuditRecord> =
        futures_util::stream::iter(media.iter().cloned().map(
            |media| async move { audit_media_storage_row(audit, media).await },
        ))
        .buffer_unordered(concurrency)
        .collect()
        .await;
    records.sort_unstable_by_key(|record: &MediaStorageAuditRecord| {
        record.media_id
    });
    records
}

async fn audit_media_storage_row(
    audit: &MediaStorageAudit<'_>,
    media: signal_message_media::Model,
) -> MediaStorageAuditRecord {
    let object_key = crate::messenger::media::media_object_key(&media);
    let remote_key = audit.s3_config.prefixed_key(&object_key);
    let result =
        probe_media_storage_object(audit.s3, &remote_key, &media).await;
    match result {
        Ok(status) => MediaStorageAuditRecord {
            record_type: "audit",
            media_id: media.id,
            signal_message_id: media.signal_message_id,
            storage_key: object_key,
            created_at: media.created_at,
            status,
            error: None,
        },
        Err((status, error)) => MediaStorageAuditRecord {
            record_type: "audit",
            media_id: media.id,
            signal_message_id: media.signal_message_id,
            storage_key: object_key,
            created_at: media.created_at,
            status,
            error: Some(error),
        },
    }
}

async fn probe_media_storage_object(
    s3: &Operator,
    remote_key: &str,
    media: &signal_message_media::Model,
) -> Result<&'static str, (&'static str, String)> {
    let metadata = match s3.stat(remote_key).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Err(("missing", error.to_string()));
        }
        Err(error) => return Err(("unreadable", error.to_string())),
    };
    let stored_size = metadata.content_length();
    let expected_size = u64::try_from(media.size_bytes)
        .map_err(|error| ("stat_mismatch", error.to_string()))?;
    if (!media.is_encrypted && stored_size != expected_size)
        || (expected_size > 0 && stored_size == 0)
    {
        return Err((
            "stat_mismatch",
            format!(
                "expected plaintext size {expected_size}, stored {stored_size}"
            ),
        ));
    }
    if stored_size == 0 {
        return Ok("available");
    }
    let probe = s3
        .read_with(remote_key)
        .range(0..crate::config::MESSENGER_MEDIA_UPLOAD_VERIFICATION_PROBE_SIZE_BYTES)
        .await
        .map_err(|error| {
            let status = if error.kind() == ErrorKind::NotFound {
                "missing"
            } else {
                "unreadable"
            };
            (status, error.to_string())
        })?;
    if probe.len()
        != usize::try_from(
            crate::config::MESSENGER_MEDIA_UPLOAD_VERIFICATION_PROBE_SIZE_BYTES,
        )
        .expect("media upload verification probe size fits usize")
    {
        return Err((
            "unreadable",
            format!("read probe returned {} bytes", probe.len()),
        ));
    }
    Ok("available")
}

fn read_media_storage_repair_manifest(
    path: &Path,
) -> Result<Vec<MediaStorageRepairEntry>, AppError> {
    let file = std::fs::File::open(path).c(h!())?;
    std::io::BufReader::new(file)
        .lines()
        .enumerate()
        .filter_map(|(index, line)| match line {
            Ok(line) if line.trim().is_empty() => None,
            line => Some((index, line)),
        })
        .map(|(index, line)| {
            let line = line.c(h!())?;
            serde_json::from_str(&line).map_err(|error| AppError::BL {
                msg: format!(
                    "invalid repair manifest {} line {}: {error}",
                    path.display(),
                    index + 1
                ),
            })
        })
        .collect()
}

async fn repair_media_storage_rows(
    audit: &MediaStorageAudit<'_>,
    media: &[signal_message_media::Model],
    entries: &[MediaStorageRepairEntry],
    apply: bool,
) -> Vec<MediaStorageRepairRecord> {
    let media = media
        .iter()
        .map(|media| (media.id, media))
        .collect::<HashMap<_, _>>();
    let mut records = Vec::with_capacity(entries.len());
    for entry in entries {
        let Some(media) = media.get(&entry.media_id) else {
            records.push(MediaStorageRepairRecord {
                record_type: "repair",
                media_id: entry.media_id,
                old_storage_key: String::new(),
                new_storage_key: None,
                status: "failed",
                error: Some(
                    "media is outside the selected audit page".to_string(),
                ),
            });
            continue;
        };
        records
            .push(repair_media_storage_row(audit, media, entry, apply).await);
    }
    records
}

async fn repair_media_storage_row(
    audit: &MediaStorageAudit<'_>,
    media: &signal_message_media::Model,
    entry: &MediaStorageRepairEntry,
    apply: bool,
) -> MediaStorageRepairRecord {
    let old_storage_key = crate::messenger::media::media_object_key(media);
    if !entry.source_path.is_file() {
        return MediaStorageRepairRecord {
            record_type: "repair",
            media_id: media.id,
            old_storage_key,
            new_storage_key: None,
            status: "unrecoverable",
            error: Some(format!(
                "source file does not exist: {}",
                entry.source_path.display()
            )),
        };
    }
    let result =
        repair_media_storage_row_inner(audit, media, entry, apply).await;
    match result {
        Ok(new_storage_key) => MediaStorageRepairRecord {
            record_type: "repair",
            media_id: media.id,
            old_storage_key,
            new_storage_key,
            status: if apply { "recovered" } else { "repair_ready" },
            error: None,
        },
        Err(error) => MediaStorageRepairRecord {
            record_type: "repair",
            media_id: media.id,
            old_storage_key,
            new_storage_key: None,
            status: "failed",
            error: Some(error.to_string()),
        },
    }
}

async fn repair_media_storage_row_inner(
    audit: &MediaStorageAudit<'_>,
    media: &signal_message_media::Model,
    entry: &MediaStorageRepairEntry,
    apply: bool,
) -> Result<Option<String>, AppError> {
    let source = actix_web::web::Bytes::from(
        tokio::fs::read(&entry.source_path).await.c(h!())?,
    );
    let expected_size = usize::try_from(media.size_bytes).c(h!())?;
    if source.len() != expected_size {
        return Err(AppError::BL {
            msg: format!(
                "source {} has {} bytes, expected {expected_size}",
                entry.source_path.display(),
                source.len()
            ),
        });
    }
    if !apply {
        return Ok(None);
    }
    let old_storage_key = crate::messenger::media::media_object_key(media);
    let new_storage_key =
        format!("{old_storage_key}.recovered-{}", uuid::Uuid::now_v7());
    let upload_result = if media.is_encrypted {
        storage::upload_encrypted_to_s3_with_operator(
            &Some(audit.s3.clone()),
            audit.s3_config,
            audit.strongbox_key,
            &new_storage_key,
            source.clone(),
        )
        .await
    } else {
        storage::upload_plaintext_to_s3_with_operator(
            &Some(audit.s3.clone()),
            audit.s3_config,
            &new_storage_key,
            source.to_vec(),
        )
        .await
    };
    if let Err(error) = upload_result {
        delete_recovery_object_best_effort(audit, &new_storage_key).await;
        return Err(error);
    }
    let validation =
        validate_recovered_media(audit, media, &new_storage_key, &source).await;
    if let Err(error) = validation {
        delete_recovery_object_best_effort(audit, &new_storage_key).await;
        return Err(error);
    }
    let update = signal_message_media::Entity::update_many()
        .col_expr(
            signal_message_media::Column::StorageKey,
            Expr::value(new_storage_key.clone()),
        )
        .filter(signal_message_media::Column::Id.eq(media.id))
        .filter(
            signal_message_media::Column::IsEncrypted.eq(media.is_encrypted),
        )
        .filter(
            signal_message_media::Column::StorageKey
                .eq(media.storage_key.clone()),
        )
        .exec(audit.dbx)
        .await;
    let updated = match update {
        Ok(updated) => updated,
        Err(error) => {
            delete_recovery_object_best_effort(audit, &new_storage_key).await;
            return Err(anyhow::Error::from(error).context(h!()).into());
        }
    };
    if updated.rows_affected != 1 {
        delete_recovery_object_best_effort(audit, &new_storage_key).await;
        return Err(AppError::BL {
            msg: format!(
                "media {} changed during recovery; replacement was not attached",
                media.id
            ),
        });
    }
    Ok(Some(new_storage_key))
}

async fn validate_recovered_media(
    audit: &MediaStorageAudit<'_>,
    media: &signal_message_media::Model,
    storage_key: &str,
    source: &[u8],
) -> Result<(), AppError> {
    let downloaded = if media.is_encrypted {
        storage::download_and_decrypt_from_s3_with_operator(
            &Some(audit.s3.clone()),
            &Some(audit.s3_config.clone()),
            audit.strongbox_key,
            storage_key,
        )
        .await
        .c(h!())?
    } else {
        let remote_key = audit.s3_config.prefixed_key(storage_key);
        audit.s3.read(&remote_key).await.c(h!())?.to_vec()
    };
    if downloaded != source {
        return Err(AppError::BL {
            msg: format!(
                "recovered object for media {} differs from its source",
                media.id
            ),
        });
    }
    Ok(())
}

async fn delete_recovery_object_best_effort(
    audit: &MediaStorageAudit<'_>,
    storage_key: &str,
) {
    let remote_key = audit.s3_config.prefixed_key(storage_key);
    if let Err(error) = audit.s3.delete(&remote_key).await {
        warn!("failed to delete rejected recovery object {remote_key}: {error:#?}");
    }
}

fn write_media_storage_report(
    path: &Path,
    audit_records: &[MediaStorageAuditRecord],
    repair_records: &[MediaStorageRepairRecord],
) -> Result<(), AppError> {
    let file = std::fs::File::create(path).c(h!())?;
    let mut writer = BufWriter::new(file);
    for record in audit_records {
        serde_json::to_writer(&mut writer, record).c(h!())?;
        writer.write_all(b"\n").c(h!())?;
    }
    for record in repair_records {
        serde_json::to_writer(&mut writer, record).c(h!())?;
        writer.write_all(b"\n").c(h!())?;
    }
    writer.flush().c(h!())?;
    Ok(())
}

fn print_media_storage_summary(
    output: &Path,
    audit_records: &[MediaStorageAuditRecord],
    repair_records: &[MediaStorageRepairRecord],
    last_media: Option<&signal_message_media::Model>,
) {
    let unavailable = audit_records
        .iter()
        .filter(|record| record.status != "available")
        .count();
    println!(
        "> audited {} media objects, {unavailable} unavailable; report: {}",
        audit_records.len(),
        output.display()
    );
    if let Some(last_media) = last_media {
        println!("> resume after media id: {}", last_media.id);
    }
    if !repair_records.is_empty() {
        let recovered = repair_records
            .iter()
            .filter(|record| record.status == "recovered")
            .count();
        println!(
            "> processed {} repair entries, {recovered} recovered",
            repair_records.len()
        );
    }
}

pub async fn oneoff_fix_whatsapp_senders(mode: Mode) -> Result<(), AppError> {
    let config = crate::config::read_config(mode)?;
    let dbx = crate::new_pg_pool_from_config(&config).await.c(h!())?;
    let cutoff_ts = Utc::now().naive_utc()
        - chrono::Duration::days(MAX_FIX_WHATSAPP_SENDERS_MESSAGE_DAYS);
    let mut max_ts = Utc::now().naive_utc();
    let mut fuel = 1000;
    info!("oneoff_fix_whatsapp_senders started");
    loop {
        info!("fixed whatsapp logins in messages after {max_ts}");
        fuel -= 1;
        if fuel < 0 {
            return Err(AppError::AnyhowError {
                source: anyhow::anyhow!("endless loop detected, halting..."),
            });
        }
        let messages = signal_message::Entity::find()
            .filter(signal_message::Column::Sender.is_not_null())
            .filter(signal_message::Column::Sender.like("%:%"))
            .filter(signal_message::Column::CreatedAt.gte(cutoff_ts))
            .filter(signal_message::Column::CreatedAt.lte(max_ts))
            .order_by_desc(signal_message::Column::CreatedAt)
            .limit(1000)
            .all(&dbx)
            .await
            .c(h!())?;
        if messages.is_empty() {
            break;
        }
        for m in messages {
            max_ts = m.created_at;
            let Some(sender) = m.sender.clone() else {
                continue;
            };
            let mut m_am = m.into_active_model();
            m_am.sender =
                Set(Some(worker::clear_messenger_login_string(&sender)));
            m_am.update(&dbx).await.c(h!())?;
        }
    }
    info!("oneoff_fix_whatsapp_senders completed");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use opendal::services::Memory;

    fn memory_config() -> storage::S3Config {
        storage::S3Config {
            bucket: "test".to_string(),
            region: String::new(),
            endpoint: String::new(),
            access_key_id: String::new(),
            secret_access_key: String::new(),
            prefix: "media".to_string(),
        }
    }

    #[tokio::test]
    async fn object_size_verification_handles_resume_states() {
        let s3 = Operator::new(Memory::default()).unwrap().finish();
        let config = memory_config();
        s3.write("media/existing", "12345").await.unwrap();

        assert!(object_has_size(&s3, &config, "existing", 5).await.unwrap());
        assert!(!object_has_size(&s3, &config, "existing", 4).await.unwrap());
        assert!(!object_has_size(&s3, &config, "missing", 5).await.unwrap());
        assert!(object_exists(&s3, &config, "existing").await.unwrap());
        assert!(!object_exists(&s3, &config, "missing").await.unwrap());
    }

    #[test]
    fn valid_plaintext_resume_skips_optional_thumbnail_decryption() {
        assert!(should_load_plaintext_bytes(false));
        assert!(!should_load_plaintext_bytes(true));
    }

    #[test]
    fn plaintext_cleanup_requires_a_known_old_enough_marker() {
        let now = Utc::now();
        let grace =
            crate::config::MESSENGER_MEDIA_PLAINTEXT_MIGRATION_ENCRYPTED_OBJECT_GRACE_SECS;
        let old = ObjectState {
            size: 5,
            last_modified: Some(now - chrono::Duration::seconds(grace)),
        };
        let fresh = ObjectState {
            size: 5,
            last_modified: Some(now - chrono::Duration::seconds(grace - 1)),
        };
        let unknown = ObjectState {
            size: 5,
            last_modified: None,
        };

        assert!(migration_marker_grace_elapsed(&old, now));
        assert!(!migration_marker_grace_elapsed(&fresh, now));
        assert!(!migration_marker_grace_elapsed(&unknown, now));
    }
}
