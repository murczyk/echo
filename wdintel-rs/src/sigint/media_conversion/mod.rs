use crate::config::{
    KMZ_CONTENT_TYPE, RER_MESSAGE_ATTACHMENTS_ZIP_MAX_TOTAL_BYTES,
    SIGINT_MEDIA_CONVERSION_STATUS_DONE,
    SIGINT_MEDIA_CONVERSION_STATUS_PENDING,
    SIGINT_MEDIA_KMZ_CONVERSION_EXTENSIONS,
    SIGINT_MEDIA_KMZ_CONVERSION_MAX_SOURCE_BYTES,
    SIGINT_MEDIA_KMZ_PASSTHROUGH_EXTENSIONS,
};
use crate::entities::{
    signal_message_media, signal_message_media_conversion_job,
};
use crate::error::AppError;
use crate::h;
use crate::logging::warn;
use crate::messenger::media::MediaUploadInput;
use crate::types::{Env, ShortContext};
use crate::users::{ensure_rer_role, login_id_from_identity};
use actix_web::http::header;
use actix_web::{get, web, HttpResponse};
use md5::{Digest, Md5};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseTransaction,
    EntityTrait, NotSet, QueryFilter, QuerySelect, Set,
};
use std::collections::HashMap;
use std::io::{BufWriter, Seek, Write};
use std::path::Path;
use tokio::io::AsyncReadExt;
use tokio_util::io::ReaderStream;
use uuid::Uuid;
use zip::write::SimpleFileOptions;

pub mod types;
pub mod worker;

use types::{
    SignalMediaKmzConversionStatusRsp, SignalMediaKmzPreviewLineString,
    SignalMediaKmzPreviewRsp,
};

pub async fn schedule_uploaded_media<C>(
    dbx: &C,
    signal_message_id: i64,
    media: &[signal_message_media::Model],
    uploads: &[MediaUploadInput],
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    anyhow::ensure!(
        media.len() == uploads.len(),
        "stored media count does not match upload count"
    );
    for (media, upload) in media.iter().zip(uploads) {
        if !is_supported_source(media) {
            continue;
        }
        if usize::try_from(media.size_bytes).c(h!())?
            > SIGINT_MEDIA_KMZ_CONVERSION_MAX_SOURCE_BYTES
        {
            continue;
        }
        let source_file_md5 =
            file_md5(&upload.path, media.size_bytes).await.c(h!())?;
        let source_file_name = media
            .file_name
            .clone()
            .or_else(|| upload.name.clone())
            .unwrap_or_else(|| {
                format!("{}.{}", media.id, source_extension(media))
            });
        signal_message_media_conversion_job::ActiveModel {
            id: NotSet,
            signal_message_id: Set(signal_message_id),
            source_media_id: Set(media.id),
            source_file_md5: Set(source_file_md5),
            source_file_name: Set(source_file_name),
            source_content_type: Set(Some(media.content_type.clone())),
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
        .insert(dbx)
        .await
        .c(h!())?;
    }
    Ok(())
}

pub async fn load_statuses<C>(
    dbx: &C,
    media: &[signal_message_media::Model],
) -> anyhow::Result<HashMap<Uuid, String>>
where
    C: ConnectionTrait,
{
    if media.is_empty() {
        return Ok(HashMap::new());
    }
    let mut statuses = signal_message_media_conversion_job::Entity::find()
        .filter(
            signal_message_media_conversion_job::Column::SourceMediaId
                .is_in(media.iter().map(|media| media.id)),
        )
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|job| (job.source_media_id, job.status))
        .collect::<HashMap<_, _>>();
    for media in media {
        if is_eligible_source(media) {
            statuses.entry(media.id).or_insert_with(|| {
                SIGINT_MEDIA_CONVERSION_STATUS_PENDING.to_string()
            });
        }
    }
    Ok(statuses)
}

pub async fn lock_and_load_converted_storage_keys(
    txn: &DatabaseTransaction,
    media_ids: &[Uuid],
) -> anyhow::Result<Vec<String>> {
    if media_ids.is_empty() {
        return Ok(vec![]);
    }
    Ok(signal_message_media_conversion_job::Entity::find()
        .filter(
            signal_message_media_conversion_job::Column::SourceMediaId
                .is_in(media_ids.iter().copied()),
        )
        .lock_exclusive()
        .all(txn)
        .await
        .c(h!())?
        .into_iter()
        .filter_map(|job| job.converted_storage_key)
        .collect())
}

pub async fn delete_stored_results_best_effort(env: &Env, keys: &[String]) {
    let (Some(s3), Some(s3_config)) = (&env.s3, &env.s3_config) else {
        return;
    };
    for key in keys {
        let remote_key = s3_config.prefixed_key(key);
        if let Err(err) = s3.delete(&remote_key).await {
            warn!(
                "failed to delete converted media object {remote_key}: {err:#?}"
            );
        }
    }
}

#[get("/api/messenger/media/{media_id}/kmz-conversion/status")]
pub async fn status(
    user: actix_identity::Identity,
    env: web::Data<Env>,
    path: web::Path<(Uuid,)>,
) -> Result<web::Json<SignalMediaKmzConversionStatusRsp>, AppError> {
    let (_, job) = authorized_job(&user, env.as_ref(), path.0).await.c(h!())?;
    Ok(web::Json(SignalMediaKmzConversionStatusRsp {
        status: job.status,
        error: job.last_error,
        converted_file_name: job.converted_file_name,
    }))
}

#[get("/api/messenger/media/{media_id}/kmz-conversion/preview")]
pub async fn preview(
    user: actix_identity::Identity,
    env: web::Data<Env>,
    path: web::Path<(Uuid,)>,
) -> Result<web::Json<SignalMediaKmzPreviewRsp>, AppError> {
    let (media, job) =
        authorized_job(&user, env.as_ref(), path.0).await.c(h!())?;
    let (storage_key, file_name) = completed_result(&job).c(h!())?;
    let bytes = fetch_completed_result_bytes(env.as_ref(), &media, storage_key)
        .await
        .c(h!())?;
    let preview =
        crate::palitra::kmz::parse_coordinates_from_file(file_name, &bytes)
            .await
            .c(h!())?;
    Ok(web::Json(SignalMediaKmzPreviewRsp {
        points: preview.points,
        line_strings: preview
            .line_strings
            .into_iter()
            .map(|line| SignalMediaKmzPreviewLineString {
                coords: line.coords,
                color: line.color,
            })
            .collect(),
    }))
}

#[get("/api/messenger/media/{media_id}/kmz-conversion/download")]
pub async fn download(
    user: actix_identity::Identity,
    env: web::Data<Env>,
    path: web::Path<(Uuid,)>,
) -> Result<HttpResponse, AppError> {
    let (media, job) =
        authorized_job(&user, env.as_ref(), path.0).await.c(h!())?;
    let (storage_key, file_name) = completed_result(&job).c(h!())?;
    let bytes = fetch_completed_result_bytes(env.as_ref(), &media, storage_key)
        .await
        .c(h!())?;
    let content_disposition = header::ContentDisposition {
        disposition: header::DispositionType::Attachment,
        parameters: vec![header::DispositionParam::FilenameExt(
            header::ExtendedValue {
                charset: header::Charset::Ext("UTF-8".into()),
                language_tag: None,
                value: file_name.as_bytes().to_vec(),
            },
        )],
    };
    Ok(HttpResponse::Ok()
        .insert_header((header::CONTENT_TYPE, KMZ_CONTENT_TYPE))
        .insert_header(content_disposition)
        .body(bytes))
}

#[get("/api/messenger/media/{media_id}/kmz-conversion/archive.zip")]
pub async fn download_archive(
    user: actix_identity::Identity,
    env: web::Data<Env>,
    path: web::Path<(Uuid,)>,
) -> Result<HttpResponse, AppError> {
    let (media, job) =
        authorized_job(&user, env.as_ref(), path.0).await.c(h!())?;
    let (storage_key, converted_file_name) = completed_result(&job).c(h!())?;
    validate_archive_size(&media, &job).c(h!())?;

    let zip_file = tempfile::tempfile().c(h!())?;
    let mut archive = zip::ZipWriter::new(BufWriter::new(zip_file));
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let source_file_name = safe_archive_file_name(
        Some(&job.source_file_name),
        "original_attachment",
    );
    let source_size = {
        let source = worker::fetch_source_bytes(env.as_ref(), &media)
            .await
            .c(h!())?;
        let source_size = u64::try_from(source.len()).c(h!())?;
        write_archive_entry(&mut archive, &options, &source_file_name, &source)
            .c(h!())?;
        source_size
    };
    let converted_file_name =
        safe_archive_file_name(Some(converted_file_name), "converted.kmz");
    let converted =
        fetch_completed_result_bytes(env.as_ref(), &media, storage_key)
            .await
            .c(h!())?;
    validate_archive_size_values(
        source_size,
        u64::try_from(converted.len()).c(h!())?,
    )
    .c(h!())?;
    write_archive_entry(
        &mut archive,
        &options,
        &converted_file_name,
        &converted,
    )
    .c(h!())?;

    let mut zip_file = archive.finish().c(h!())?.into_inner().c(h!())?;
    let zip_size = zip_file.metadata().c(h!())?.len();
    zip_file.rewind().c(h!())?;
    let archive_name = attachment_archive_name(&source_file_name);
    let content_disposition = header::ContentDisposition {
        disposition: header::DispositionType::Attachment,
        parameters: vec![header::DispositionParam::FilenameExt(
            header::ExtendedValue {
                charset: header::Charset::Ext("UTF-8".into()),
                language_tag: None,
                value: archive_name.as_bytes().to_vec(),
            },
        )],
    };
    Ok(HttpResponse::Ok()
        .insert_header((header::CONTENT_TYPE, "application/zip"))
        .insert_header(content_disposition)
        .insert_header((header::CONTENT_LENGTH, zip_size.to_string()))
        .streaming(ReaderStream::new(tokio::fs::File::from_std(zip_file))))
}

fn validate_archive_size(
    media: &signal_message_media::Model,
    job: &signal_message_media_conversion_job::Model,
) -> anyhow::Result<()> {
    let source_size = u64::try_from(media.size_bytes).c(h!())?;
    let converted_size =
        u64::try_from(job.converted_size_bytes.c(h!())?).c(h!())?;
    validate_archive_size_values(source_size, converted_size).c(h!())
}

fn validate_archive_size_values(
    source_size: u64,
    converted_size: u64,
) -> anyhow::Result<()> {
    let total_size = source_size.checked_add(converted_size).c(h!())?;
    anyhow::ensure!(
        total_size <= RER_MESSAGE_ATTACHMENTS_ZIP_MAX_TOTAL_BYTES,
        "Geodata archive is too large: {total_size} bytes, max is {RER_MESSAGE_ATTACHMENTS_ZIP_MAX_TOTAL_BYTES}"
    );
    Ok(())
}

fn safe_archive_file_name(file_name: Option<&str>, fallback: &str) -> String {
    let file_name = file_name
        .map(crate::palitra::kmz::sanitize_upload_filename)
        .unwrap_or_else(|| fallback.to_string());
    let file_name = file_name
        .chars()
        .map(|character| {
            if character.is_control() || matches!(character, '/' | '\\') {
                '_'
            } else {
                character
            }
        })
        .collect::<String>();
    let file_name = file_name.trim().trim_matches('.');
    if file_name.is_empty() {
        fallback.to_string()
    } else {
        file_name.to_string()
    }
}

fn attachment_archive_name(source_file_name: &str) -> String {
    let stem = Path::new(source_file_name)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .map(str::trim)
        .filter(|stem| !stem.is_empty())
        .unwrap_or("geodata");
    format!("{stem}_files.zip")
}

fn write_archive_entry<W: Write + Seek>(
    archive: &mut zip::ZipWriter<W>,
    options: &SimpleFileOptions,
    file_name: &str,
    bytes: &[u8],
) -> anyhow::Result<()> {
    archive.start_file(file_name, *options).c(h!())?;
    archive.write_all(bytes).c(h!())?;
    Ok(())
}

async fn authorized_job(
    user: &actix_identity::Identity,
    env: &Env,
    media_id: Uuid,
) -> Result<
    (
        signal_message_media::Model,
        signal_message_media_conversion_job::Model,
    ),
    AppError,
> {
    ensure_rer_role(&env.dbx, user).await.c(h!())?;
    let login = login_id_from_identity(user).c(h!())?;
    let media = signal_message_media::Entity::find_by_id(media_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
        .c(h!())?;
    crate::messenger::media::ensure_media_access(
        &env.dbx,
        &login,
        media.signal_message_id,
    )
    .await
    .c(h!())?;
    let job = signal_message_media_conversion_job::Entity::find()
        .filter(
            signal_message_media_conversion_job::Column::SourceMediaId
                .eq(media.id),
        )
        .one(&env.dbx)
        .await
        .c(h!())?;
    let job = match job {
        Some(job) => job,
        None if is_eligible_source(&media) => {
            schedule_stored_media(env, &media).await.c(h!())?
        }
        None => return Err(AppError::NotFound),
    };
    if job.signal_message_id != media.signal_message_id {
        return Err(AppError::NotFound);
    }
    Ok((media, job))
}

fn completed_result(
    job: &signal_message_media_conversion_job::Model,
) -> anyhow::Result<(Option<&str>, &str)> {
    if job.status != SIGINT_MEDIA_CONVERSION_STATUS_DONE {
        anyhow::bail!(
            "{}",
            job.last_error
                .as_deref()
                .unwrap_or("KMZ conversion is not complete")
        );
    }
    Ok((
        job.converted_storage_key.as_deref(),
        job.converted_file_name.as_deref().c(h!())?,
    ))
}

fn is_supported_source(media: &signal_message_media::Model) -> bool {
    SIGINT_MEDIA_KMZ_CONVERSION_EXTENSIONS
        .iter()
        .any(|extension| {
            source_extension(media).eq_ignore_ascii_case(extension)
        })
}

fn is_eligible_source(media: &signal_message_media::Model) -> bool {
    is_supported_source(media)
        && usize::try_from(media.size_bytes).is_ok_and(|size_bytes| {
            size_bytes <= SIGINT_MEDIA_KMZ_CONVERSION_MAX_SOURCE_BYTES
        })
}

pub(crate) fn source_is_ready_kmz(media: &signal_message_media::Model) -> bool {
    SIGINT_MEDIA_KMZ_PASSTHROUGH_EXTENSIONS
        .iter()
        .any(|extension| {
            source_extension(media).eq_ignore_ascii_case(extension)
        })
}

pub(crate) async fn fetch_completed_result_bytes(
    env: &Env,
    media: &signal_message_media::Model,
    storage_key: Option<&str>,
) -> anyhow::Result<Vec<u8>> {
    if source_is_ready_kmz(media) {
        worker::fetch_source_bytes(env, media).await.c(h!())
    } else {
        crate::messenger::media::fetch_media_bytes_by_key(
            env,
            storage_key.c(h!())?,
        )
        .await
        .c(h!())
    }
}

async fn schedule_stored_media(
    env: &Env,
    media: &signal_message_media::Model,
) -> anyhow::Result<signal_message_media_conversion_job::Model> {
    let source = worker::fetch_source_bytes(env, media).await.c(h!())?;
    let source_file_name = media
        .file_name
        .clone()
        .unwrap_or_else(|| format!("{}.{}", media.id, source_extension(media)));
    signal_message_media_conversion_job::Entity::insert(
        signal_message_media_conversion_job::ActiveModel {
            id: NotSet,
            signal_message_id: Set(media.signal_message_id),
            source_media_id: Set(media.id),
            source_file_md5: Set(format!("{:x}", Md5::digest(&source))),
            source_file_name: Set(source_file_name),
            source_content_type: Set(Some(media.content_type.clone())),
            status: Set(SIGINT_MEDIA_CONVERSION_STATUS_PENDING.to_string()),
            conversion_receipt: Set(None),
            converted_storage_key: Set(None),
            converted_file_name: Set(None),
            converted_size_bytes: Set(None),
            created_at: NotSet,
            last_attempt_at: Set(None),
            attempt_count: Set(0),
            last_error: Set(None),
        },
    )
    .on_conflict_do_nothing()
    .exec_without_returning(&env.dbx)
    .await
    .c(h!())?;
    signal_message_media_conversion_job::Entity::find()
        .filter(
            signal_message_media_conversion_job::Column::SourceMediaId
                .eq(media.id),
        )
        .one(&env.dbx)
        .await
        .c(h!())?
        .c(h!())
}

fn source_extension(media: &signal_message_media::Model) -> &str {
    media.file_ext.as_deref().unwrap_or_default()
}

async fn file_md5(path: &str, expected_size: i64) -> anyhow::Result<String> {
    let mut file = tokio::fs::File::options()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .await
        .c(h!())?;
    anyhow::ensure!(file.metadata().await.c(h!())?.is_file());
    let mut md5 = Md5::new();
    let mut read_bytes = 0i64;
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).await.c(h!())?;
        if read == 0 {
            break;
        }
        read_bytes = read_bytes
            .checked_add(i64::try_from(read).c(h!())?)
            .c(h!())?;
        md5.update(&buffer[..read]);
    }
    anyhow::ensure!(
        read_bytes == expected_size,
        "attachment changed while calculating MD5: expected {expected_size} bytes, read {read_bytes}"
    );
    Ok(format!("{:x}", md5.finalize()))
}

pub(super) fn converted_file_name(source_file_name: &str) -> String {
    let safe_name =
        crate::palitra::kmz::sanitize_upload_filename(source_file_name);
    let stem = Path::new(&safe_name)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .map(str::trim)
        .filter(|stem| !stem.is_empty())
        .unwrap_or("file");
    format!("{stem}_converted.kmz")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::functest::tests::{cleanup, mk_signal_message};
    use sea_orm::{ActiveModelTrait, ActiveValue::Set};
    use serial_test::serial;

    fn media_with_extension(extension: &str) -> signal_message_media::Model {
        signal_message_media::Model {
            id: Uuid::nil(),
            signal_message_id: 1,
            signal_message_uuid: None,
            content_type: "application/octet-stream".to_string(),
            file_ext: Some(extension.to_string()),
            file_name: Some(format!("route.{extension}")),
            size_bytes: 1,
            created_at: chrono::Utc::now().naive_utc(),
            is_encrypted: true,
            storage_key: Some("test/route".to_string()),
        }
    }

    #[test]
    fn recognizes_kmz_and_geojson_sources_case_insensitively() {
        for extension in ["kmz", "KMZ", "geojson", "GEOJSON"] {
            assert!(is_eligible_source(&media_with_extension(extension)));
        }
        assert!(!is_eligible_source(&media_with_extension("txt")));
    }

    #[serial]
    #[tokio::test]
    async fn schedules_only_eligible_uploads_with_source_identity() {
        let env = cleanup().await.unwrap();
        let message = mk_signal_message(
            &env.dbx,
            crate::entities::signal_message::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let directory = tempfile::tempdir().unwrap();
        let supported_bytes = b"supported geodata";
        let supported_path = directory.path().join("route.gpx");
        tokio::fs::write(&supported_path, supported_bytes)
            .await
            .unwrap();
        let ignored_path = directory.path().join("notes.txt");
        tokio::fs::write(&ignored_path, b"not geodata")
            .await
            .unwrap();

        let supported_media = signal_message_media::ActiveModel {
            id: Set(Uuid::now_v7()),
            signal_message_id: Set(message.id),
            signal_message_uuid: Set(message.id_uuid),
            content_type: Set("application/gpx+xml".to_string()),
            file_ext: Set(Some("gpx".to_string())),
            file_name: Set(Some("route.gpx".to_string())),
            size_bytes: Set(i64::try_from(supported_bytes.len()).unwrap()),
            created_at: Set(chrono::Utc::now().naive_utc()),
            is_encrypted: Set(true),
            storage_key: Set(Some("test/route.gpx".to_string())),
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let ignored_media = signal_message_media::ActiveModel {
            id: Set(Uuid::now_v7()),
            signal_message_id: Set(message.id),
            signal_message_uuid: Set(message.id_uuid),
            content_type: Set("text/plain".to_string()),
            file_ext: Set(Some("txt".to_string())),
            file_name: Set(Some("notes.txt".to_string())),
            size_bytes: Set(11),
            created_at: Set(chrono::Utc::now().naive_utc()),
            is_encrypted: Set(true),
            storage_key: Set(Some("test/notes.txt".to_string())),
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let oversized_size =
            i64::try_from(SIGINT_MEDIA_KMZ_CONVERSION_MAX_SOURCE_BYTES)
                .unwrap()
                + 1;
        let oversized_media = signal_message_media::ActiveModel {
            id: Set(Uuid::now_v7()),
            signal_message_id: Set(message.id),
            signal_message_uuid: Set(message.id_uuid),
            content_type: Set("application/gpx+xml".to_string()),
            file_ext: Set(Some("gpx".to_string())),
            file_name: Set(Some("oversized.gpx".to_string())),
            size_bytes: Set(oversized_size),
            created_at: Set(chrono::Utc::now().naive_utc()),
            is_encrypted: Set(true),
            storage_key: Set(Some("test/oversized.gpx".to_string())),
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let ignored_media_id = ignored_media.id;
        let oversized_media_id = oversized_media.id;
        let media =
            vec![supported_media.clone(), ignored_media, oversized_media];
        let uploads = vec![
            MediaUploadInput {
                path: supported_path.to_string_lossy().into_owned(),
                name: Some("route.gpx".to_string()),
                content_type: Some("application/gpx+xml".to_string()),
            },
            MediaUploadInput {
                path: ignored_path.to_string_lossy().into_owned(),
                name: Some("notes.txt".to_string()),
                content_type: Some("text/plain".to_string()),
            },
            MediaUploadInput {
                path: directory
                    .path()
                    .join("missing-oversized.gpx")
                    .to_string_lossy()
                    .into_owned(),
                name: Some("oversized.gpx".to_string()),
                content_type: Some("application/gpx+xml".to_string()),
            },
        ];

        let statuses = load_statuses(&env.dbx, &media).await.unwrap();
        assert_eq!(
            statuses.get(&supported_media.id).map(String::as_str),
            Some(SIGINT_MEDIA_CONVERSION_STATUS_PENDING)
        );
        assert!(!statuses.contains_key(&ignored_media_id));
        assert!(!statuses.contains_key(&oversized_media_id));

        schedule_uploaded_media(&env.dbx, message.id, &media, &uploads)
            .await
            .unwrap();

        let jobs = signal_message_media_conversion_job::Entity::find()
            .all(&env.dbx)
            .await
            .unwrap();
        assert_eq!(jobs.len(), 1);
        let job = &jobs[0];
        assert_eq!(job.signal_message_id, message.id);
        assert_eq!(job.source_media_id, supported_media.id);
        assert_eq!(job.source_file_name, "route.gpx");
        assert_eq!(
            job.source_file_md5,
            format!("{:x}", Md5::digest(supported_bytes))
        );
        assert_eq!(job.status, SIGINT_MEDIA_CONVERSION_STATUS_PENDING);
    }
}
