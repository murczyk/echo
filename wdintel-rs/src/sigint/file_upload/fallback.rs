use super::tus::{CompletedUploadWriteResult, TusHandler, TusUploadMetadata};
use crate::error::AppError;
use crate::types::*;
use actix_multipart::Multipart;
use actix_web::http::header::HeaderMap;
use actix_web::HttpResponse;
use serde::Serialize;
use uuid::Uuid;

#[derive(Serialize)]
struct FallbackUploadResponse {
    upload_url: String,
}

pub async fn upload(
    mut tus_handler: TusHandler,
    login: &Uuid,
    headers: &HeaderMap,
    mut payload: Multipart,
) -> Result<HttpResponse, AppError> {
    if let Some(length) = headers.get(actix_web::http::header::CONTENT_LENGTH) {
        let length = length
            .to_str()
            .ok()
            .filter(|value| {
                !value.is_empty()
                    && value.bytes().all(|byte| byte.is_ascii_digit())
            })
            .and_then(|value| value.parse::<u64>().ok())
            .ok_or_else(|| AppError::BL {
                msg: "invalid upload Content-Length".to_string(),
            })
            .context(h!())?;
        tus_handler.config.max_size = Some(
            length.min(
                tus_handler
                    .config
                    .max_size
                    .unwrap_or(crate::config::SIGINT_FILE_UPLOAD_MAX_BYTES),
            ),
        );
    }
    let Some(item) = crate::utils::multipart::next(&mut payload).await? else {
        return Ok(HttpResponse::BadRequest().finish());
    };
    let field = item.map_err(multipart_error).context(h!())?;
    if field
        .content_disposition()
        .and_then(|disposition| disposition.get_name())
        != Some("file")
    {
        return Ok(HttpResponse::BadRequest().finish());
    }
    let metadata = upload_metadata(&field);
    let chunks = Box::pin(futures_util::stream::unfold(
        Some((field, payload)),
        |state| async move {
            let (mut field, mut payload) = state?;
            match crate::utils::multipart::next(&mut field).await {
                Ok(Some(chunk)) => Some((
                    chunk.map_err(multipart_error),
                    Some((field, payload)),
                )),
                Err(error) => Some((Err(error), None)),
                Ok(None) => {
                    drop(field);
                    match crate::utils::multipart::next(&mut payload).await {
                        Ok(None) => None,
                        Ok(Some(_)) => Some((
                            Err(AppError::BL {
                                msg: "Expected exactly one uploaded file"
                                    .to_string(),
                            }),
                            None,
                        )),
                        Err(error) => Some((Err(error), None)),
                    }
                }
            }
        },
    ));
    let result = tus_handler
        .create_completed_upload(login, metadata, chunks)
        .await
        .context(h!())?;

    match result {
        CompletedUploadWriteResult::Empty => {
            Ok(HttpResponse::BadRequest().finish())
        }
        CompletedUploadWriteResult::TooLarge => {
            Ok(HttpResponse::PayloadTooLarge().finish())
        }
        CompletedUploadWriteResult::Stored {
            file_id,
            size,
            upload_url,
        } => {
            let user_agent = headers
                .get(actix_web::http::header::USER_AGENT)
                .and_then(|value| value.to_str().ok())
                .unwrap_or("unknown");
            log::warn!(
                target: "tus_upload",
                "event=fallback_upload_completed file_id={file_id} size={size} user_agent={user_agent:?}"
            );
            Ok(HttpResponse::Created()
                .json(FallbackUploadResponse { upload_url }))
        }
    }
}

fn upload_metadata(field: &actix_multipart::Field) -> TusUploadMetadata {
    let filename = field
        .content_disposition()
        .and_then(|disposition| disposition.get_filename())
        .map(str::to_string);
    let filetype = field.content_type().map(ToString::to_string);
    TusUploadMetadata {
        filename,
        filetype,
        ..TusUploadMetadata::default()
    }
}

fn multipart_error(error: actix_multipart::MultipartError) -> AppError {
    AppError::BL {
        msg: format!("invalid attachment multipart: {error}"),
    }
}
