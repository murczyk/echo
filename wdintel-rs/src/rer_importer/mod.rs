use self::types::*;
use crate::delta::bgtask_log;
use crate::entities::signal_profile::Model;
use crate::entities::*;
use crate::error::AppError;
use crate::location::peleng::reset_inbox_pelengs;
use crate::location::utils;
use crate::sigint::sender::preferred_sender_expr;
use crate::types::*;
use crate::utils::orm::ArrayColumnOps;
use actix_web::http::header;
use actix_web::http::StatusCode;
use actix_web::web::{Bytes, Json};
use actix_web::{get, post, HttpRequest, HttpResponse};
use chrono::prelude::*;
use futures_util::TryStreamExt;
use indicatif::ProgressBar;
use itertools::Itertools;
use rand::prelude::IndexedRandom;
use sea_orm::sea_query::{Expr, Func};
use sea_orm::*;
use sqlx::Row;
use std::collections::{BTreeMap, HashSet};
use std::io::{BufWriter, Seek, Write};
use time::{Duration as TimeDuration, OffsetDateTime, PrimitiveDateTime};
use tokio_util::io::ReaderStream;
use zip::write::SimpleFileOptions;

pub mod analysis;
pub mod bgworker;
pub mod body_noheader;
pub mod bookmark;
pub mod callsigns;
pub mod coordinates;
pub mod datetime;
pub mod frequency;
pub mod gdoc;
pub mod highlight;
pub mod import_csv;
pub mod import_kmz;
pub mod important;
pub mod inbox;
pub mod location;
pub mod meow_format;
pub mod multimessage;
pub mod points;
pub mod post;
pub mod reports;
pub mod search;
pub mod signals;
pub mod types;
pub mod unit;
pub mod zp_digital_post_alt_format;
pub mod zp_peleng_vorony_odina_format;

fn media_inline_content_disposition(
    file_name: Option<&str>,
) -> Option<header::ContentDisposition> {
    file_name.map(|file_name| header::ContentDisposition {
        disposition: header::DispositionType::Inline,
        parameters: vec![header::DispositionParam::FilenameExt(
            header::ExtendedValue {
                charset: header::Charset::Ext("UTF-8".into()),
                language_tag: None,
                value: file_name.as_bytes().to_vec(),
            },
        )],
    })
}

fn parse_single_byte_range(
    range_header: &str,
    total: u64,
) -> Option<(u64, u64)> {
    let specs = range_header.trim().strip_prefix("bytes=")?.trim();
    if specs.is_empty() {
        return None;
    }

    let mut first_range = None;
    for spec in specs.split(',') {
        match parse_byte_range_spec(spec.trim(), total)? {
            ParsedByteRangeSpec::Satisfiable(start, end) => {
                first_range.get_or_insert((start, end));
            }
            ParsedByteRangeSpec::Unsatisfiable => {}
        }
    }
    first_range
}

enum ParsedByteRangeSpec {
    Satisfiable(u64, u64),
    Unsatisfiable,
}

fn parse_byte_range_spec(
    spec: &str,
    total: u64,
) -> Option<ParsedByteRangeSpec> {
    if spec.is_empty() {
        return None;
    }

    if let Some(suffix) = spec.strip_prefix('-') {
        let suffix_len: u64 = suffix.trim().parse().ok()?;
        if suffix_len == 0 || total == 0 {
            return Some(ParsedByteRangeSpec::Unsatisfiable);
        }
        let suffix_len = suffix_len.min(total);
        let start = total - suffix_len;
        return Some(ParsedByteRangeSpec::Satisfiable(start, total - 1));
    }

    let (start_str, end_str) = spec.split_once('-')?;
    let start: u64 = start_str.trim().parse().ok()?;
    let end_str = end_str.trim();
    let requested_end = if end_str.is_empty() {
        None
    } else {
        Some(end_str.parse::<u64>().ok()?)
    };
    if requested_end.is_some_and(|end| start > end) {
        return None;
    }
    if start >= total {
        return Some(ParsedByteRangeSpec::Unsatisfiable);
    }
    let end = requested_end.unwrap_or(total - 1).min(total - 1);
    Some(ParsedByteRangeSpec::Satisfiable(start, end))
}

fn apply_media_response_headers(
    builder: &mut actix_web::HttpResponseBuilder,
    content_type: &str,
    file_name: Option<&str>,
) {
    builder.insert_header((header::ACCEPT_RANGES, "bytes"));
    builder.insert_header((header::CONTENT_TYPE, content_type.to_string()));
    builder.insert_header(("X-Accel-Buffering", "no"));
    if let Some(cd) = media_inline_content_disposition(file_name) {
        builder.insert_header(cd);
    }
}

fn media_range_not_satisfiable_response(
    content_type: &str,
    file_name: Option<&str>,
    total: u64,
) -> HttpResponse {
    let mut response = HttpResponse::build(StatusCode::RANGE_NOT_SATISFIABLE);
    apply_media_response_headers(&mut response, content_type, file_name);
    response
        .insert_header((header::CONTENT_RANGE, format!("bytes */{total}")))
        .finish()
}

#[get("/api/messenger/media/{media_id}")]
async fn messenger_media(
    user: actix_identity::Identity,
    req: HttpRequest,
    env: actix_web::web::Data<Env>,
    path: actix_web::web::Path<(Uuid,)>,
) -> Result<HttpResponse, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .c(h!())?;
    let media_id = path.0;
    let media = signal_message_media::Entity::find_by_id(media_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    crate::messenger::media::ensure_media_access(
        &env.dbx,
        &login,
        media.signal_message_id,
    )
    .await?;

    if !media.is_encrypted {
        return serve_plaintext_messenger_media(&req, env.as_ref(), &media)
            .await;
    }
    if crate::messenger::media::is_video_media(&media)
        && crate::messenger::media_cache::should_cache_media(media.size_bytes)
    {
        return serve_cached_messenger_media(&req, env.as_ref(), &media).await;
    }
    serve_small_messenger_media(&req, env.as_ref(), &media).await
}

async fn serve_plaintext_messenger_media(
    req: &HttpRequest,
    env: &Env,
    media: &signal_message_media::Model,
) -> Result<HttpResponse, AppError> {
    let total = u64::try_from(media.size_bytes).c(h!())?;
    if total == 0 {
        if req.headers().contains_key(header::RANGE) {
            return Ok(media_range_not_satisfiable_response(
                &media.content_type,
                media.file_name.as_deref(),
                total,
            ));
        }
        let mut response = HttpResponse::Ok();
        apply_media_response_headers(
            &mut response,
            &media.content_type,
            media.file_name.as_deref(),
        );
        return Ok(response
            .insert_header((header::CONTENT_LENGTH, "0"))
            .finish());
    }
    let requested_range = req.headers().get(header::RANGE);
    let (start, end, status) = if let Some(range_header) = requested_range {
        let range_header = range_header.to_str().unwrap_or("");
        let Some((start, end)) = parse_single_byte_range(range_header, total)
        else {
            return Ok(media_range_not_satisfiable_response(
                &media.content_type,
                media.file_name.as_deref(),
                total,
            ));
        };
        (start, end, StatusCode::PARTIAL_CONTENT)
    } else {
        (0, total - 1, StatusCode::OK)
    };
    let length = end - start + 1;
    let media_id = media.id;
    let stream = crate::messenger::media::stream_plaintext_media_range(
        env,
        media,
        start..end + 1,
    )
    .await?
    .map_err(move |err| {
        error!("failed to stream plaintext media {media_id}: {err:#?}");
        err
    });
    let mut response = HttpResponse::build(status);
    apply_media_response_headers(
        &mut response,
        &media.content_type,
        media.file_name.as_deref(),
    );
    response.insert_header((header::CONTENT_LENGTH, length.to_string()));
    if status == StatusCode::PARTIAL_CONTENT {
        response.insert_header((
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{total}"),
        ));
    }
    Ok(response.streaming(stream))
}

async fn serve_cached_messenger_media(
    req: &HttpRequest,
    env: &Env,
    media: &signal_message_media::Model,
) -> Result<HttpResponse, AppError> {
    let poll_cache = media_cache_preflight_requested(req);
    let mut file = open_cached_messenger_media(env, media, poll_cache)
        .await?
        .use_etag(false)
        .use_last_modified(false);
    if let Ok(content_type) =
        media.content_type.parse::<actix_web::mime::Mime>()
    {
        file = file.set_content_type(content_type);
    }
    if let Some(content_disposition) =
        media_inline_content_disposition(media.file_name.as_deref())
    {
        file = file.set_content_disposition(content_disposition);
    }
    let mut response = file.into_response(req);
    response.headers_mut().insert(
        header::HeaderName::from_static("x-accel-buffering"),
        header::HeaderValue::from_static("no"),
    );
    Ok(response)
}

async fn open_cached_messenger_media(
    env: &Env,
    media: &signal_message_media::Model,
    poll_cache: bool,
) -> Result<actix_files::NamedFile, AppError> {
    let cache_path =
        cached_messenger_media_path(env, media, poll_cache).await?;
    if crate::messenger::media::is_video_media(media) {
        if let Err(err) =
            crate::messenger::media_thumbnail::try_stage_thumbnail_source_file(
                &env.config,
                media.id,
                &cache_path,
                media.size_bytes,
            )
            .await
        {
            warn!(
                "failed to stage cached thumbnail source for media {}: {err:#?}",
                media.id
            );
        }
    }
    match actix_files::NamedFile::open_async(&cache_path).await {
        Ok(file) => Ok(file),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            let cache_path =
                cached_messenger_media_path(env, media, poll_cache).await?;
            actix_files::NamedFile::open_async(cache_path)
                .await
                .c(h!())
                .map_err(Into::into)
        }
        Err(err) => Err(err.into()),
    }
}

fn media_cache_preflight_requested(req: &HttpRequest) -> bool {
    req.headers()
        .get(crate::config::MESSENGER_MEDIA_CACHE_PREFLIGHT_HEADER)
        .is_some_and(|value| value.as_bytes() == b"1")
}

async fn cached_messenger_media_path(
    env: &Env,
    media: &signal_message_media::Model,
    poll_cache: bool,
) -> Result<std::path::PathBuf, AppError> {
    if poll_cache {
        crate::messenger::media_cache::poll_media_cache(env, media).await
    } else {
        crate::messenger::media_cache::ensure_media_cached(env, media).await
    }
}

async fn serve_small_messenger_media(
    req: &HttpRequest,
    env: &Env,
    media: &signal_message_media::Model,
) -> Result<HttpResponse, AppError> {
    let data = crate::messenger::media::fetch_media_bytes(env, media).await?;
    if crate::messenger::media::is_video_media(media) {
        if let Err(err) =
            crate::messenger::media_thumbnail::try_stage_thumbnail_source_bytes(
                &env.config,
                media.id,
                &data,
            )
            .await
        {
            warn!(
                "failed to stage decrypted thumbnail source for media {}: {err:#?}",
                media.id
            );
        }
    }
    let bytes = Bytes::from(data);
    let total = bytes.len() as u64;
    let content_type = media.content_type.as_str();
    let file_name = media.file_name.as_deref();

    if let Some(range_header) = req.headers().get(header::RANGE) {
        let range_header = range_header.to_str().unwrap_or("");
        if let Some((start, end)) = parse_single_byte_range(range_header, total)
        {
            let slice = bytes.slice(start as usize..=end as usize);
            let length = end - start + 1;
            let mut resp = HttpResponse::PartialContent();
            apply_media_response_headers(&mut resp, content_type, file_name);
            return Ok(resp
                .insert_header((
                    header::CONTENT_RANGE,
                    format!("bytes {start}-{end}/{total}"),
                ))
                .insert_header((header::CONTENT_LENGTH, length.to_string()))
                .body(slice));
        }
        return Ok(media_range_not_satisfiable_response(
            content_type,
            file_name,
            total,
        ));
    }

    let mut resp = HttpResponse::Ok();
    apply_media_response_headers(&mut resp, content_type, file_name);
    Ok(resp
        .insert_header((header::CONTENT_LENGTH, total.to_string()))
        .body(bytes))
}

fn safe_zip_entry_name(
    file_name: Option<&str>,
    file_ext: Option<&str>,
    index: usize,
    used_names: &mut HashSet<String>,
) -> String {
    let name = file_name
        .map(|name| {
            name.chars()
                .map(|character| {
                    if character.is_control() || matches!(character, '/' | '\\')
                    {
                        '_'
                    } else {
                        character
                    }
                })
                .collect::<String>()
        })
        .map(|name| name.trim().trim_matches('.').to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| {
            let extension = file_ext
                .map(str::trim)
                .map(|extension| {
                    extension
                        .chars()
                        .filter(|character| character.is_ascii_alphanumeric())
                        .collect::<String>()
                })
                .filter(|extension| !extension.is_empty())
                .map(|extension| format!(".{extension}"))
                .unwrap_or_default();
            format!("attachment_{}{extension}", index + 1)
        });
    if used_names.insert(name.clone()) {
        return name;
    }
    let path = std::path::Path::new(&name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("attachment");
    let extension = path.extension().and_then(|value| value.to_str());
    for suffix in 1.. {
        let candidate = match extension {
            Some(extension) => format!("{stem}_{suffix}.{extension}"),
            None => format!("{stem}_{suffix}"),
        };
        if used_names.insert(candidate.clone()) {
            return candidate;
        }
    }
    unreachable!()
}

fn write_zip_entry<W: Write + Seek>(
    archive: &mut zip::ZipWriter<W>,
    options: &SimpleFileOptions,
    name: String,
    data: &[u8],
) -> Result<(), AppError> {
    archive.start_file(name, *options).c(h!())?;
    archive.write_all(data).c(h!())?;
    Ok(())
}

async fn write_plaintext_zip_entry<W: Write + Seek>(
    archive: &mut zip::ZipWriter<W>,
    options: &SimpleFileOptions,
    name: String,
    env: &Env,
    media: &signal_message_media::Model,
    expected_size: u64,
    total_bytes: &mut u64,
) -> Result<(), AppError> {
    archive.start_file(name, *options).c(h!())?;
    let mut streamed_size = 0u64;
    if expected_size > 0 {
        let mut stream = crate::messenger::media::stream_plaintext_media_range(
            env,
            media,
            0..expected_size,
        )
        .await?;
        while let Some(chunk) = stream.try_next().await.c(h!())? {
            let chunk_size = u64::try_from(chunk.len()).c(h!())?;
            streamed_size =
                checked_attachment_size_total(streamed_size, chunk_size)?;
            *total_bytes =
                checked_attachment_size_total(*total_bytes, chunk_size)?;
            archive.write_all(&chunk).c(h!())?;
        }
    }
    if streamed_size != expected_size {
        return Err(AppError::BL {
            msg: format!(
                "Plaintext attachment {} ended at {} bytes, expected {}",
                media.id, streamed_size, expected_size
            ),
        });
    }
    Ok(())
}

fn attachment_size_limit_error(total_bytes: u64) -> AppError {
    AppError::BL {
        msg: format!(
            "Message attachments are too large: {} bytes, max is {}",
            total_bytes,
            crate::config::RER_MESSAGE_ATTACHMENTS_ZIP_MAX_TOTAL_BYTES
        ),
    }
}

fn checked_attachment_size_total(
    total_bytes: u64,
    additional_bytes: u64,
) -> Result<u64, AppError> {
    let total_bytes = total_bytes
        .checked_add(additional_bytes)
        .ok_or_else(|| attachment_size_limit_error(u64::MAX))?;
    if total_bytes > crate::config::RER_MESSAGE_ATTACHMENTS_ZIP_MAX_TOTAL_BYTES
    {
        return Err(attachment_size_limit_error(total_bytes));
    }
    Ok(total_bytes)
}

fn validate_attachment_metadata_sizes(
    media: &[signal_message_media::Model],
) -> Result<u64, AppError> {
    let mut total_bytes = 0;
    for media in media {
        let size_bytes =
            u64::try_from(media.size_bytes).map_err(|_| AppError::BL {
                msg: format!(
                    "Invalid attachment size: {} bytes",
                    media.size_bytes
                ),
            })?;
        total_bytes = checked_attachment_size_total(total_bytes, size_bytes)?;
    }
    Ok(total_bytes)
}

fn message_attachments_archive_name_from_parts(
    message_uuid: Option<&str>,
    timestamp: chrono::NaiveDateTime,
) -> String {
    let message_uuid = message_uuid
        .unwrap_or("unknown")
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric()
                || matches!(character, '-' | '_')
            {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    let timestamp = timestamp.format("%Y%m%d_%H%M%S");
    format!("attachments_{message_uuid}_{timestamp}.zip")
}

async fn find_active_attachment_archive_message(
    dbx: &DatabaseConnection,
    message_id: i64,
) -> Result<signal_message::Model, AppError> {
    signal_message::Entity::find()
        .filter(signal_message::Column::Id.eq(message_id))
        .filter(signal_message::Column::Deleted.eq(false))
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
}

#[get("/api/rer-importer/messages/{message_id}/attachments.zip")]
async fn rer_message_attachments_zip(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    path: actix_web::web::Path<(i64,)>,
) -> Result<HttpResponse, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .c(h!())?;
    let message_id = path.0;
    let message =
        find_active_attachment_archive_message(&env.dbx, message_id).await?;
    // Uses the same group-membership gate as individual media downloads; this
    // endpoint must not grant access merely because a message URL is known.
    crate::messenger::media::ensure_media_access(&env.dbx, &login, message_id)
        .await?;
    let media = signal_message_media::Entity::find()
        .filter(signal_message_media::Column::SignalMessageId.eq(message_id))
        .order_by_asc(signal_message_media::Column::CreatedAt)
        .all(&env.dbx)
        .await
        .c(h!())?;
    if media.len() > crate::config::RER_MESSAGE_ATTACHMENTS_ZIP_MAX_FILES {
        return Err(AppError::BL {
            msg: format!(
                "Too many message attachments: {}, max is {}",
                media.len(),
                crate::config::RER_MESSAGE_ATTACHMENTS_ZIP_MAX_FILES
            ),
        });
    }
    validate_attachment_metadata_sizes(&media)?;
    let archive_timestamp = Utc::now().naive_utc();

    let zip_file = tempfile::tempfile().c(h!())?;
    let mut archive = zip::ZipWriter::new(BufWriter::new(zip_file));
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let mut used_names = HashSet::new();
    let mut total_bytes = 0u64;
    for (index, media) in media.iter().enumerate() {
        let name = safe_zip_entry_name(
            media.file_name.as_deref(),
            media.file_ext.as_deref(),
            index,
            &mut used_names,
        );
        let expected_size = u64::try_from(media.size_bytes).c(h!())?;
        if media.is_encrypted {
            let data =
                crate::messenger::media::fetch_media_bytes(env.as_ref(), media)
                    .await?;
            total_bytes = checked_attachment_size_total(
                total_bytes,
                u64::try_from(data.len()).c(h!())?,
            )?;
            write_zip_entry(&mut archive, &options, name, &data)?;
        } else {
            write_plaintext_zip_entry(
                &mut archive,
                &options,
                name,
                env.as_ref(),
                media,
                expected_size,
                &mut total_bytes,
            )
            .await?;
        }
    }
    let mut zip_file = archive.finish().c(h!())?.into_inner().c(h!())?;
    let zip_size = zip_file.metadata().c(h!())?.len();
    zip_file.rewind().c(h!())?;
    let stream = ReaderStream::new(tokio::fs::File::from_std(zip_file));
    let archive_name = message_attachments_archive_name_from_parts(
        message.message_uid.as_deref(),
        archive_timestamp,
    );
    Ok(HttpResponse::Ok()
        .insert_header((header::CONTENT_TYPE, "application/zip"))
        .insert_header((
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{archive_name}\""),
        ))
        .insert_header((header::CONTENT_LENGTH, zip_size.to_string()))
        .streaming(stream))
}

#[post("/api/rer-importer/callsigns")]
async fn rer_importer_callsigns(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<RerImporterCallsignsReq>,
) -> Result<Json<Vec<CallsignWithFrequencies>>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
    let sixty_days_ago_offset =
        OffsetDateTime::now_utc() - TimeDuration::days(60);
    let sixty_days_ago_primitive = PrimitiveDateTime::new(
        sixty_days_ago_offset.date(),
        sixty_days_ago_offset.time(),
    );
    let res1_rows = sqlx::query(
        r#"
select
  jsonb_array_elements_text(sii.callsigns) as callsign,
  array_agg(distinct coalesce(sii.freq, '')) as freqs
from sigint_inbox_item sii
inner join signal_message sm on sm.id = sii.id
inner join datasource d on d.id=sm.datasource_id
inner join sigint_zone_datasource szd on szd.datasource_id = d.id
inner join sigint_zone sz on sz.id=szd.sigint_zone_id
inner join login l on l.sigint_zone_id = sz.id
where sm.created_at >= $1 and sii.checked and l.login=$2
 group by 1"#,
    )
    .bind(sixty_days_ago_primitive)
    .bind(user.id().c(h!())?)
    .fetch_all(env.dbx.get_postgres_connection_pool())
    .await
    .c(h!())?;

    let mut res = vec![];
    for row in res1_rows.iter() {
        let callsign: Option<String> = row.try_get("callsign").ok();
        let freqs: Option<Vec<String>> = row.try_get("freqs").ok();
        if req.filter.is_none() || (callsign == req.filter.clone()) {
            if let Some(callsign) = callsign.clone() {
                if let Some(freqs) = freqs.clone() {
                    res.push(CallsignWithFrequencies {
                        callsign,
                        frequencies: freqs
                            .iter()
                            .filter(|x| !x.is_empty())
                            .cloned()
                            .collect(),
                    })
                }
            }
        }
    }

    Ok(Json(res))
}

#[get("/api/rer-importer/grafana/messages")]
async fn list_messages(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: actix_web::web::Query<MessagesReq>,
) -> Result<Json<Vec<MessageRsp>>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;

    let groups = crate::messenger::group::get_identity_sigint_groups_noimport(
        &env.dbx,
        &user,
        &env.config,
    )
    .await
    .c(h!())?;

    let result = signal_message::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::DatasourceGroup.def(),
        )
        .join(
            JoinType::LeftJoin,
            datasource_group::Relation::SignalGroup.def(),
        )
        .columns([
            signal_message::Column::Id,
            signal_message::Column::Body,
            signal_message::Column::Timestamp,
        ])
        .columns([
            sigint_inbox_item::Column::Lat,
            sigint_inbox_item::Column::Lng,
            sigint_inbox_item::Column::Freq,
        ])
        .expr_as(
            Func::cust(crate::utils::orm::Concat)
                .arg(Expr::col(sigint_inbox_item::Column::Lat))
                .arg(Expr::val(", "))
                .arg(Expr::col(sigint_inbox_item::Column::Lng)),
            "coordinates",
        )
        .to_owned()
        .join(
            JoinType::InnerJoin,
            signal_group::Relation::SigintZoneDatasource.def(),
        )
        .filter(datasource_group::Column::GroupMasterKey.eq_any(groups))
        .filter(sigint_inbox_item::Column::Lat.is_not_null())
        .filter(sigint_inbox_item::Column::Lng.is_not_null())
        .filter(sigint_inbox_item::Column::Lat.ne(0.0))
        .filter(sigint_inbox_item::Column::Lng.ne(0.0))
        .filter(signal_message::Column::Deleted.eq(false))
        .apply_if(req.freq.as_ref(), |q, freq| {
            q.filter(sigint_inbox_item::Column::Freq.eq(freq))
        })
        .apply_if(req.from, |q, from| {
            q.filter(
                signal_message::Column::Timestamp
                    .gte::<chrono::NaiveDateTime>(from),
            )
        })
        .apply_if(req.to, |q, to| {
            q.filter(
                signal_message::Column::Timestamp
                    .lte::<chrono::NaiveDateTime>(to),
            )
        })
        .into_model::<MessageRsp>()
        .all(&env.dbx)
        .await
        .c(h!())?;
    Ok(Json(result))
}

#[get("/api/sigint/callsigns-alchemy.json")]
async fn callsigns_alchemy(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<CallsignsAlchemyRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
    let callsigns = network_callsign::Entity::find()
        .all(&env.dbx)
        .await
        .c(h!())?;
    let mut callsigns_s = vec![];
    for callsign in callsigns.iter() {
        if !callsigns_s.contains(&callsign.callsign) {
            callsigns_s.push(callsign.callsign.clone());
        }
    }
    let mut per_freq: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for callsign in callsigns.iter() {
        per_freq
            .entry(callsign.freq.clone())
            .and_modify(|x| {
                if !x.contains(&callsign.callsign) {
                    x.push(callsign.callsign.clone())
                }
            })
            .or_insert(vec![callsign.callsign.clone()]);
    }
    let mut freqs_per_callsign: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for callsign in callsigns.iter() {
        freqs_per_callsign
            .entry(callsign.callsign.clone())
            .and_modify(|x| {
                if !x.contains(&callsign.freq) {
                    x.push(callsign.freq.clone())
                }
            })
            .or_insert(vec![callsign.freq.clone()]);
    }
    let mut nodes = vec![];
    let mut edges = vec![];
    let rng = &mut rand::rng();
    for callsign in callsigns_s.iter() {
        let cluster: String = freqs_per_callsign
            .get(callsign)
            .expect("impossible! seed=81737")
            .choose(rng)
            .expect("impossible! seed=71928")
            .clone();
        nodes.push(CallsignsAlchemyNode {
            id: format!("node-{callsign}"),
            cluster,
            title: callsign.to_string(),
            relatedness: "1.0".to_string(),
        });
    }
    for (freq, callsigns) in per_freq.iter() {
        // for callsign in callsigns.iter() {
        //     nodes.push(CallsignsAlchemyNode {
        //         id: format!("node-{}-{}", freq, callsign),
        //         cluster: freq.clone(),
        //         title: format!("{} ({})", callsign, freq),
        //         relatedness: "1.0".to_string(),
        //     });
        // }
        edges.extend(fill_edges(freq, callsigns.clone())?);
    }
    Ok(Json(CallsignsAlchemyRsp { nodes, edges }))
}

fn fill_edges(
    _freq: &str,
    callsigns: Vec<String>,
) -> Result<Vec<CallsignAlchemyEdge>, AppError> {
    let mut res = vec![];
    if !callsigns.is_empty() {
        let (c1, cs) = callsigns.split_at(1);
        let c1 = &c1[0];
        for c in cs.iter() {
            res.push(CallsignAlchemyEdge {
                source: format!("node-{c1}"),
                target: format!("node-{c}"),
                relatedness: "1.0".to_string(),
            });
        }
        res.extend(fill_edges(_freq, cs.to_vec())?);
    }
    Ok(res)
}

#[post("/api/rer-importer/unread-counters")]
pub async fn unread_counters(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<UnreadCountersReq>,
) -> Result<Json<UnreadCountersRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
    let newer_msg_count = match req.only_show_unprocessed {
        Some(true) => sqlx::query(
            r#"
SELECT count(*) as cnt
FROM signal_message sm
INNER JOIN sigint_inbox_item sii ON sm.id=sii.id
WHERE sm.id > $1
  AND not sii.reviewed
"#,
        )
        .bind(req.last_id)
        .fetch_one(env.dbx.get_postgres_connection_pool())
        .await
        .ok()
        .and_then(|row| row.try_get::<i64, _>("cnt").ok())
        .unwrap_or(0),
        _ => sqlx::query(
            r#"
SELECT count(*) as cnt
FROM signal_message sm
WHERE sm.id > $1
"#,
        )
        .bind(req.last_id)
        .fetch_one(env.dbx.get_postgres_connection_pool())
        .await
        .ok()
        .and_then(|row| row.try_get::<i64, _>("cnt").ok())
        .unwrap_or(0),
    };

    Ok(Json(UnreadCountersRsp { newer_msg_count }))
}

#[post("/api/rer-importer/signal-group")]
pub async fn signal_group_info(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<SignalGroupReq>,
) -> Result<Json<SignalGroupRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
    let m_signal_group = signal_group::Entity::find()
        .filter(signal_group::Column::Deleted.eq(false))
        .filter(signal_group::Column::MasterKey.eq(&req.master_key))
        .one(&env.dbx)
        .await
        .c(h!())?;
    match m_signal_group {
        None => Ok(Json(SignalGroupRsp { name: None })),
        Some(signal_group) => Ok(Json(SignalGroupRsp {
            name: signal_group.name,
        })),
    }
}

#[post("/api/rer-importer/signal-group-batch")]
pub async fn signal_group_info_batch(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<BatchSignalGroupReq>,
) -> Result<Json<SignalGroupsRsp>, AppError> {
    crate::users::has_any_role(
        &env.dbx,
        &user.id().c(h!())?,
        vec!["Rer", "Api"],
    )
    .await?;
    let is_admin =
        crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Admin")
            .await
            .is_ok();
    let keys: Vec<String> =
        req.groups.iter().map(|b| b.master_key.clone()).collect();
    let data = crate::messenger::group::collect_groups(
        keys,
        &env.dbx,
        is_admin,
        crate::messenger::group::CollectGroupsOpts {
            skip_group_stats: req.skip_group_stats.unwrap_or(false),
        },
    )
    .await
    .c(h!())?;
    Ok(Json(SignalGroupsRsp { data }))
}

#[post("/api/rer-importer/groups")]
pub async fn signal_groups(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<SignalGroupsRsp>, AppError> {
    crate::users::has_any_role(
        &env.dbx,
        &user.id().c(h!())?,
        vec!["Rer", "Api"],
    )
    .await
    .c(h!())?;
    let is_admin =
        crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Admin")
            .await
            .is_ok();
    let keys = signal_group::Entity::find()
        .filter(signal_group::Column::Deleted.eq(false))
        .filter(signal_group::Column::IsArchived.eq(false))
        .select_only()
        .column(signal_group::Column::MasterKey)
        .into_tuple::<String>()
        .all(&env.dbx)
        .await
        .c(h!())?;
    let data = crate::messenger::group::collect_groups(
        keys,
        &env.dbx,
        is_admin,
        crate::messenger::group::CollectGroupsOpts {
            skip_group_stats: false,
        },
    )
    .await
    .c(h!())?;
    Ok(Json(SignalGroupsRsp { data }))
}

#[post("/api/rer-importer/signal-profile")]
pub async fn signal_profile_info(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<SignalProfileReq>,
) -> Result<Json<Option<SignalProfileRsp>>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
    // signal_profile::Column::Uuid
    //     .eq(&req.uuid)
    //     .or(signal_profile::Column::GivenName.eq(&req.uuid)),
    let m_signal_profile = signal_profile::Entity::find()
        .filter(signal_profile::Column::Uuid.eq(&req.uuid))
        .one(&env.dbx)
        .await
        .c(h!())?;
    match m_signal_profile {
        None => Ok(Json(None)),
        Some(signal_profile) => Ok(Json(Some(SignalProfileRsp {
            given_name: signal_profile.given_name,
            family_name: signal_profile.family_name,
        }))),
    }
}

#[post("/api/rer-importer/signal-profile-batch")]
pub async fn signal_profile_info_batch(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<BatchSignalProfileReq>,
) -> Result<Json<SignalProfilesRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
    let txn = env.dbx.begin().await.c(h!())?;
    // signal_profile::Column::Uuid
    //     .eq(&req.uuid)
    //     .or(signal_profile::Column::GivenName.eq(&req.uuid)),
    let ids: Vec<String> =
        req.profiles.iter().map(|p| p.uuid.clone()).collect();
    let data = collect_profiles_data(&txn, ids).await.c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(Json(SignalProfilesRsp { data }))
}

#[post("/api/rer-importer/signal-profile/save")]
pub async fn signal_profile_save(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<SignalProfileSaveReq>,
) -> Result<Json<()>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
    signal_profile::Entity::insert(signal_profile::ActiveModel {
        uuid: Set(req.uuid.clone()),
        given_name: Set(req.given_name.clone()),
        family_name: Set(req.family_name.clone()),
        created_at: NotSet,
    })
    .on_conflict(
        sea_query::OnConflict::column(signal_profile::Column::Uuid)
            .update_columns([
                signal_profile::Column::GivenName,
                signal_profile::Column::FamilyName,
            ])
            .to_owned(),
    )
    .exec(&env.dbx)
    .await
    .c(h!())?;
    Ok(Json(()))
}

pub async fn oneoff_round_freq(mode: Mode) -> Result<(), AppError> {
    println!("> starting oneoff_round_freq");
    let dbx = crate::new_pg_pool_from_mode(mode).await.c(h!())?;

    let group = crate::config::read_config(mode)?.signal_import_group_name;

    let q = Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"UPDATE sigint_inbox_item AS sii
                SET freq = res
                FROM (
                    SELECT
                        sii.id, TO_CHAR(FLOOR(CAST(sii.freq AS NUMERIC)) + ROUND(MOD(CAST(sii.freq AS NUMERIC) * 1000, 1000) / 5) * 0.005, '999.9999') AS res
                    FROM sigint_inbox_item AS sii
                        INNER JOIN signal_message AS sm ON sm.id = sii.id
                        INNER JOIN datasource_group dg ON sm.datasource_group_id = dg.id
                        INNER JOIN signal_group AS sg ON sg.master_key = dg.group_master_key
                    WHERE
                        sii.lat IS NOT NULL
                        AND sii.lng IS NOT NULL
                        AND sg.name = $1
                        AND sg.deleted = false
                        AND sii.freq <> TO_CHAR(FLOOR(CAST(sii.freq AS NUMERIC)) + ROUND(MOD(CAST(sii.freq AS NUMERIC) * 1000, 1000) / 5) * 0.005, '999.9999')
                ) AS updated
                WHERE
                  sii.id = updated.id
            "#,
        [group.clone().into()],
    );

    // println!("Query: {}", q);

    let res = dbx.execute(q).await.c(h!())?;

    println!("> rounded {} freqs", res.rows_affected());

    Ok(())
}

pub async fn oneoff_nominalize_freq(mode: Mode) -> Result<(), AppError> {
    println!("> starting oneoff_nominalize_freq");
    let dbx = crate::new_pg_pool_from_mode(mode).await.c(h!())?;
    let inbox_items = sigint_inbox_item::Entity::find()
        .order_by_asc(sigint_inbox_item::Column::Id);
    // println!(
    //     "> inbox items query: {}",
    //     inbox_items.build(DbBackend::Postgres).to_string()
    // );
    let count: u64 = inbox_items.clone().count(&dbx).await.c(h!())?;
    println!("> overall: {count}");
    let mut inbox_items = inbox_items.stream(&dbx).await.c(h!())?;
    let pb = ProgressBar::new(count);
    while let Some(item) = inbox_items.try_next().await.c(h!())? {
        pb.inc(1);

        if let Some(freq) = item.freq.as_ref() {
            let freq2 = self::frequency::etalon(freq);
            if &freq2 != freq {
                let mut item: sigint_inbox_item::ActiveModel = item.into();
                item.freq = Set(Some(freq2));
                item.update(&dbx).await.c(h!())?;
            }
        }
    }
    Ok(())
}

#[derive(FromQueryResult)]
struct InboxPostRecalcRow {
    id: i64,
    post_id: Option<i64>,
    body: Option<String>,
}

pub async fn oneoff_reprocess_inbox_posts(
    mode: Mode,
    ps: &crate::OneoffReprocessInboxPostsPs,
) -> Result<(), AppError> {
    println!(
        "> oneoff_reprocess_inbox_posts start_day={} dry_run={}",
        ps.start_day, ps.dry_run
    );
    let dbx = crate::new_pg_pool_from_mode(mode).await.c(h!())?;
    let start_utc = parse_start_day_to_utc(&ps.start_day).c(h!())?;

    let q = build_inbox_posts_recalc_query(start_utc);
    let page_size = 1000_u64;
    let paginator = q.paginate(&dbx, page_size);
    let total_pages = paginator.num_pages().await.c(h!())?;

    let mut total = 0_u64;
    let mut updated = 0_u64;
    let mut unchanged = 0_u64;
    let mut skipped_no_body = 0_u64;

    for page in 0..total_pages {
        let rows = paginator.fetch_page(page).await.c(h!())?;
        for row in rows {
            total += 1;
            let Some(body) = row.body else {
                skipped_no_body += 1;
                continue;
            };

            let post = crate::rer_importer::post::extract_post(&body)?;
            let new_post_id =
                crate::sigint::post::get_or_create_post_id(&dbx, &post)
                    .await
                    .c(h!())?;

            if row.post_id == new_post_id {
                unchanged += 1;
                continue;
            }

            updated += 1;
            if ps.dry_run {
                continue;
            }

            let inbox_item = sigint_inbox_item::ActiveModel {
                id: Set(row.id),
                post_id: Set(new_post_id),
                ..Default::default()
            };
            let inbox_item = inbox_item.update(&dbx).await.c(h!())?;
            crate::sigint::network::etalon_calc::calculate_sigint_inbox_item_networks(
                vec![inbox_item],
                &dbx,
            )
            .await
            .c(h!())?;
        }
    }

    println!(
        "> done oneoff_reprocess_inbox_posts: total={total} updated={updated} unchanged={unchanged} skipped_no_body={skipped_no_body}"
    );
    Ok(())
}

fn build_inbox_posts_recalc_query(
    start_utc: NaiveDateTime,
) -> Selector<SelectModel<InboxPostRecalcRow>> {
    sigint_inbox_item::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .filter(sigint_inbox_item::Column::Datetime.gte(start_utc))
        .filter(signal_message::Column::Deleted.eq(false))
        .select_only()
        .column(sigint_inbox_item::Column::Id)
        .column(sigint_inbox_item::Column::PostId)
        .column_as(signal_message::Column::Body, "body")
        .order_by_asc(sigint_inbox_item::Column::Id)
        .into_model::<InboxPostRecalcRow>()
}

fn parse_start_day_to_utc(start_day: &str) -> Result<NaiveDateTime, AppError> {
    let local_date =
        NaiveDate::parse_from_str(start_day, "%Y-%m-%d").c(h!())?;
    let local_midnight =
        local_date.and_hms_opt(0, 0, 0).ok_or(AppError::BL {
            msg: format!("invalid local midnight for date {start_day}"),
        })?;
    let zoned = local_midnight
        .and_local_timezone(crate::config::get_tz())
        .single()
        .ok_or(AppError::BL {
            msg: format!("ambiguous local datetime: {local_midnight}"),
        })?;
    Ok(zoned.to_utc().naive_utc())
}

pub async fn oneoff_reprocess_unit_names(
    mode: Mode,
    ps: &crate::OneoffReprocessUnitNamesPs,
) -> Result<(), AppError> {
    println!("> oneoff_reprocess_unit_names {ps:?}");
    let dbx = crate::new_pg_pool_from_mode(mode).await.c(h!())?;
    let config = crate::config::read_config(mode)?;
    let settlements = Arc::new(RwLock::new(
        crate::location::load_settlements_data_config(
            config.settlement_paths().c(h!())?,
            mode,
        )
        .unwrap(),
    ));
    crate::location::aor_config::init_aor_location_config(
        &dbx,
        settlements.clone(),
    )
    .await
    .c(h!())?;

    let since_ts =
        parse_oneoff_reprocess_unit_names_since_ts(ps.since_ts.as_deref())?
            .unwrap_or_else(|| {
                (Utc::now() - chrono::Duration::days(10)).naive_utc()
            });

    let mut q = sigint_inbox_item::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .filter(sigint_inbox_item::Column::Datetime.gte(since_ts))
        .filter(signal_message::Column::Deleted.eq(false))
        .order_by_asc(sigint_inbox_item::Column::Id);
    if let Some(master_key) = ps.only_group_master_key.as_deref() {
        q = q
            .join(
                JoinType::InnerJoin,
                signal_message::Relation::DatasourceGroup.def(),
            )
            .join(
                JoinType::InnerJoin,
                datasource_group::Relation::SignalGroup.def(),
            )
            .filter(signal_group::Column::MasterKey.eq(master_key));
    }
    // let count = q.clone().count(&dbx).await
    let mut inbox_items = q.stream(&dbx).await.c(h!())?;
    // let pb = ProgressBar::new(count);
    while let Some(item) = inbox_items.try_next().await.c(h!())? {
        // pb.inc(1);
        let id = item.id;
        let inbox_message = signal_message::Entity::find_by_id(id)
            .filter(signal_message::Column::Deleted.eq(false))
            .one(&dbx)
            .await
            .c(h!())?
            .ok_or("error 17263")?;
        let m_aor_id = resolve_message_aor_id(&dbx, id).await.c(h!())?;

        let unit_old = item.unit.clone();
        if let Some(body) = inbox_message.body {
            let callsigns: Vec<String> = match item.callsigns.as_ref() {
                Some(v) => serde_json::from_value(v.clone()).c(h!())?,
                None => vec![],
            };
            let callsigns = callsigns
                .into_iter()
                .map(|x| x.to_uppercase())
                .collect_vec();
            let result = crate::unit::parser::extract_unit_with_aor(
                settlements.clone(),
                &body,
                callsigns,
                m_aor_id,
            )?;
            let unit_new = result.unit.clone();
            if unit_new.is_none() && unit_old.is_some() {
                continue;
            }
            println!("{unit_old:?} -> {unit_new:?}");
            let mut item: sigint_inbox_item::ActiveModel = item.into();
            let location_v2 =
                match (result.locality.clone(), result.locality_v2.clone()) {
                    (_, Some(locations)) => {
                        Some(utils::format_settlements_list(locations))
                    }
                    (Some(location), None) => {
                        let locations =
                            crate::location::parse_location_with_aor(
                                settlements.clone(),
                                location,
                                m_aor_id,
                            )
                            .c(h!())?;
                        Some(utils::format_settlements_list(locations))
                    }
                    _ => None,
                };
            item.unit = Set(unit_new);
            item.unit_v2 = Set(None);
            item.location = Set(result.locality);
            item.location_v2 = Set(location_v2);
            item.parsed_unit_v2 = Set(false);
            item.update(&dbx).await.c(h!())?;
            reset_inbox_pelengs(id, &dbx).await.c(h!())?;
        }
    }
    Ok(())
}

fn parse_oneoff_reprocess_unit_names_since_ts(
    value: Option<&str>,
) -> Result<Option<NaiveDateTime>, AppError> {
    let Some(value) = value else {
        return Ok(None);
    };
    if let Ok(ts) = DateTime::parse_from_rfc3339(value) {
        return Ok(Some(ts.naive_utc()));
    }
    Ok(Some(
        NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S").c(h!())?,
    ))
}

async fn resolve_message_aor_id(
    dbx: &DatabaseConnection,
    message_id: i64,
) -> Result<Option<i64>, AppError> {
    let m_group_master_key = signal_message_group::Entity::find()
        .filter(signal_message_group::Column::SignalMessageId.eq(message_id))
        .filter(signal_message_group::Column::GroupMasterKey.is_not_null())
        .order_by_asc(signal_message_group::Column::Id)
        .select_only()
        .column(signal_message_group::Column::GroupMasterKey)
        .into_tuple::<String>()
        .one(dbx)
        .await
        .c(h!())?;
    let Some(group_master_key) = m_group_master_key else {
        return Ok(None);
    };
    let m_aor_id = signal_group_aor::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_group_aor::Relation::AreaOfResponsibility.def(),
        )
        .filter(signal_group_aor::Column::MasterKey.eq(group_master_key))
        .filter(area_of_responsibility::Column::Deleted.eq(false))
        .order_by_asc(signal_group_aor::Column::Id)
        .select_only()
        .column(signal_group_aor::Column::AorId)
        .into_tuple::<i64>()
        .one(dbx)
        .await
        .c(h!())?;
    Ok(m_aor_id)
}

#[post("/api/rer-importer/latest-senders")]
pub async fn latest_senders(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<SignalProfilesRsp>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
    let now = Utc::now();
    #[derive(FromQueryResult)]
    struct Res {
        sender: Option<String>,
    }
    let txn = env.dbx.begin().await.c(h!())?;
    let master_keys =
        crate::messenger::group::get_identity_sigint_groups(&txn, &login)
            .await
            .c(h!())?;
    let sender_expr = preferred_sender_expr(None);
    let sender_uuids: Vec<String> = signal_message::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::DatasourceGroup.def(),
        )
        .select_only()
        .column_as(sender_expr.clone(), "sender")
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(datasource_group::Column::GroupMasterKey.eq_any(master_keys))
        .filter(
            signal_message::Column::CreatedAt
                .gt(now - chrono::Duration::days(2)),
        )
        .group_by(sender_expr)
        .into_model::<Res>()
        .all(&txn)
        .await
        .c(h!())?
        .iter()
        .filter_map(|x| x.sender.clone())
        .collect();
    let data = collect_profiles_data(&txn, sender_uuids).await.c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(Json(SignalProfilesRsp { data }))
}

#[post("/api/rer-importer/senders")]
pub async fn senders(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<SignalProfilesRsp>, AppError> {
    crate::users::has_any_role(
        &env.dbx,
        &user.id().c(h!())?,
        vec!["Rer", "Api"],
    )
    .await
    .c(h!())?;

    let sender_uuids = signal_message_group::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message_group::Relation::SignalMessage.def(),
        )
        .select_only()
        .column(signal_message_group::Column::Sender)
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(signal_message_group::Column::Sender.is_not_null())
        .filter(signal_message_group::Column::Sender.ne(""))
        .group_by(signal_message_group::Column::Sender)
        .order_by_asc(signal_message_group::Column::Sender)
        .into_tuple::<String>()
        .all(&env.dbx)
        .await
        .c(h!())?;
    let data = collect_profiles_data(&env.dbx, sender_uuids)
        .await
        .c(h!())?;
    Ok(Json(SignalProfilesRsp { data }))
}

pub async fn collect_profiles_data<'a, 'async_trait, C>(
    txn: &'a C,
    sender_uuids: Vec<String>,
) -> Result<BTreeMap<String, Option<SignalProfileEntry>>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let profiles: BTreeMap<String, Model> = signal_profile::Entity::find()
        .filter(signal_profile::Column::Uuid.eq_any(sender_uuids.clone()))
        .all(txn)
        .await
        .c(h!())?
        .iter()
        .map(|p| (p.uuid.clone(), p.clone()))
        .collect();
    let mut data = BTreeMap::new();
    for id in sender_uuids {
        let m_profile = profiles.get(&id).map(|p| SignalProfileEntry {
            family_name: p.family_name.clone(),
            given_name: p.given_name.clone(),
        });
        data.insert(id, m_profile);
    }
    Ok(data)
}

#[cfg(test)]
mod messenger_media_tests {
    use super::{
        checked_attachment_size_total, find_active_attachment_archive_message,
        media_cache_preflight_requested, media_range_not_satisfiable_response,
        message_attachments_archive_name_from_parts,
        parse_oneoff_reprocess_unit_names_since_ts, parse_single_byte_range,
        safe_zip_entry_name, validate_attachment_metadata_sizes,
        write_zip_entry,
    };
    use crate::entities::signal_message;
    use crate::entities::signal_message_media;
    use crate::error::AppError;
    use crate::functest::tests::{cleanup, mk_signal_message};
    use actix_web::http::{header, StatusCode};
    use actix_web::test::TestRequest;
    use chrono::{NaiveDate, NaiveDateTime};
    use sea_orm::{ActiveModelTrait, IntoActiveModel, Set};
    use serial_test::serial;
    use std::collections::HashSet;
    use std::io::{Cursor, Read};
    use std::iter;
    use zip::write::SimpleFileOptions;

    #[test]
    fn parse_byte_range_from_start() {
        assert_eq!(parse_single_byte_range("bytes=0-99", 1000), Some((0, 99)));
    }

    #[test]
    fn parse_byte_range_open_end() {
        assert_eq!(
            parse_single_byte_range("bytes=500-", 1000),
            Some((500, 999))
        );
    }

    #[test]
    fn parse_byte_range_suffix() {
        assert_eq!(
            parse_single_byte_range("bytes=-100", 1000),
            Some((900, 999))
        );
    }

    #[test]
    fn parse_byte_range_rejects_out_of_bounds() {
        assert_eq!(parse_single_byte_range("bytes=1000-1100", 1000), None);
    }

    #[test]
    fn parse_byte_range_uses_first_satisfiable_range() {
        assert_eq!(
            parse_single_byte_range("bytes=0-9,20-29", 1000),
            Some((0, 9))
        );
    }

    #[test]
    fn parse_byte_range_skips_unsatisfiable_ranges() {
        assert_eq!(
            parse_single_byte_range("bytes=1000-1100,20-29", 1000),
            Some((20, 29))
        );
    }

    #[test]
    fn parse_byte_range_rejects_malformed_multi_range() {
        assert_eq!(parse_single_byte_range("bytes=0-9,broken", 1000), None);
    }

    #[test]
    fn parse_byte_range_rejects_fully_unsatisfiable_multi_range() {
        assert_eq!(
            parse_single_byte_range("bytes=1000-1100,2000-", 1000),
            None
        );
    }

    #[test]
    fn unsatisfiable_range_response_includes_representation_size() {
        let response = media_range_not_satisfiable_response(
            "video/mp4",
            Some("video.mp4"),
            1000,
        );

        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(
            response.headers().get(header::CONTENT_RANGE).unwrap(),
            "bytes */1000"
        );
        assert_eq!(response.headers().get("x-accel-buffering").unwrap(), "no");
    }

    #[test]
    fn media_cache_preflight_requires_explicit_header_value() {
        let regular_request = TestRequest::default().to_http_request();
        let preflight_request = TestRequest::default()
            .insert_header((
                crate::config::MESSENGER_MEDIA_CACHE_PREFLIGHT_HEADER,
                "1",
            ))
            .to_http_request();
        let invalid_request = TestRequest::default()
            .insert_header((
                crate::config::MESSENGER_MEDIA_CACHE_PREFLIGHT_HEADER,
                "true",
            ))
            .to_http_request();

        assert!(!media_cache_preflight_requested(&regular_request));
        assert!(media_cache_preflight_requested(&preflight_request));
        assert!(!media_cache_preflight_requested(&invalid_request));
    }

    #[test]
    fn parse_unit_names_since_ts_accepts_utc_rfc3339() {
        assert_eq!(
            parse_oneoff_reprocess_unit_names_since_ts(Some(
                "2026-07-16T05:45:00Z"
            ))
            .unwrap(),
            Some(
                NaiveDate::from_ymd_opt(2026, 7, 16)
                    .unwrap()
                    .and_hms_opt(5, 45, 0)
                    .unwrap()
            )
        );
    }

    #[test]
    fn parse_unit_names_since_ts_accepts_naive_utc() {
        assert_eq!(
            parse_oneoff_reprocess_unit_names_since_ts(Some(
                "2026-07-16T05:45:00"
            ))
            .unwrap(),
            Some(
                NaiveDate::from_ymd_opt(2026, 7, 16)
                    .unwrap()
                    .and_hms_opt(5, 45, 0)
                    .unwrap()
            )
        );
    }

    #[test]
    fn zip_entry_names_preserve_safe_names_and_deduplicate() {
        let mut used_names = HashSet::new();
        assert_eq!(
            safe_zip_entry_name(
                Some("../report.txt"),
                Some("txt"),
                0,
                &mut used_names,
            ),
            "_report.txt"
        );
        assert_eq!(
            safe_zip_entry_name(
                Some("../report.txt"),
                Some("txt"),
                1,
                &mut used_names,
            ),
            "_report_1.txt"
        );
        assert_eq!(
            safe_zip_entry_name(None, Some("pdf"), 2, &mut used_names),
            "attachment_3.pdf"
        );
    }

    #[test]
    fn zip_entries_include_all_and_empty_archives_are_valid() {
        let options = SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
        write_zip_entry(&mut archive, &options, "first.txt".into(), b"one")
            .unwrap();
        write_zip_entry(&mut archive, &options, "second.txt".into(), b"two")
            .unwrap();
        let bytes = archive.finish().unwrap().into_inner();
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        assert_eq!(archive.len(), 2);
        let mut first = String::new();
        archive
            .by_name("first.txt")
            .unwrap()
            .read_to_string(&mut first)
            .unwrap();
        assert_eq!(first, "one");
        let empty = zip::ZipWriter::new(Cursor::new(Vec::new()))
            .finish()
            .unwrap();
        assert_eq!(
            zip::ZipArchive::new(Cursor::new(empty.into_inner()))
                .unwrap()
                .len(),
            0
        );
    }

    #[test]
    fn archive_name_uses_message_uuid_and_timestamp() {
        let timestamp = NaiveDateTime::parse_from_str(
            "2026-07-20 14:05:06",
            "%Y-%m-%d %H:%M:%S",
        )
        .unwrap();
        assert_eq!(
            message_attachments_archive_name_from_parts(
                Some("550e8400-e29b-41d4-a716-446655440000"),
                timestamp,
            ),
            "attachments_550e8400-e29b-41d4-a716-446655440000_20260720_140506.zip"
        );
    }

    #[test]
    fn attachment_size_validation_accepts_below_and_exact_limit() {
        let limit = crate::config::RER_MESSAGE_ATTACHMENTS_ZIP_MAX_TOTAL_BYTES;
        assert_eq!(checked_attachment_size_total(limit - 1, 1).unwrap(), limit);
        assert_eq!(checked_attachment_size_total(0, limit).unwrap(), limit);
    }

    #[test]
    fn attachment_size_validation_rejects_above_limit() {
        let limit = crate::config::RER_MESSAGE_ATTACHMENTS_ZIP_MAX_TOTAL_BYTES;
        assert!(checked_attachment_size_total(limit, 1).is_err());
    }

    #[test]
    fn attachment_size_validation_rejects_negative_metadata() {
        let media = iter::once(signal_message_media::Model {
            id: uuid::Uuid::nil(),
            signal_message_id: 1,
            content_type: "text/plain".to_string(),
            file_ext: Some("txt".to_string()),
            file_name: Some("negative.txt".to_string()),
            size_bytes: -1,
            is_encrypted: false,
            created_at: chrono::Utc::now().naive_utc(),
        })
        .collect::<Vec<_>>();
        let error = validate_attachment_metadata_sizes(&media).unwrap_err();
        assert!(error.to_string().contains("Invalid attachment size"));
    }

    #[test]
    fn attachment_size_validation_rejects_integer_overflow() {
        assert!(checked_attachment_size_total(u64::MAX, 1).is_err());
    }

    #[tokio::test]
    #[serial]
    async fn archive_message_lookup_excludes_soft_deleted_messages() {
        let env = cleanup().await.unwrap();
        let active_message = mk_signal_message(
            &env.dbx,
            <signal_message::ActiveModel as Default>::default(),
        )
        .await
        .unwrap();
        let deleted_message = mk_signal_message(
            &env.dbx,
            <signal_message::ActiveModel as Default>::default(),
        )
        .await
        .unwrap();
        let deleted_message_id = deleted_message.id;
        let mut deleted_message_active = deleted_message.into_active_model();
        deleted_message_active.deleted = Set(true);
        deleted_message_active.update(&env.dbx).await.unwrap();

        assert!(find_active_attachment_archive_message(
            &env.dbx,
            active_message.id
        )
        .await
        .is_ok());
        assert!(matches!(
            find_active_attachment_archive_message(
                &env.dbx,
                deleted_message_id
            )
            .await,
            Err(AppError::NotFound)
        ));
    }
}
