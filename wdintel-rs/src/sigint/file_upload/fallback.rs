use super::tus::{CompletedUploadWriteResult, TusHandler, TusUploadMetadata};
use crate::error::AppError;
use crate::types::*;
use actix_multipart::Multipart;
use actix_web::http::header::HeaderMap;
use actix_web::HttpResponse;
use futures_util::StreamExt;
use serde::Serialize;
use uuid::Uuid;

#[derive(Serialize)]
struct FallbackUploadResponse {
    upload_url: String,
}

pub async fn upload(
    tus_handler: TusHandler,
    login: &Uuid,
    headers: &HeaderMap,
    mut payload: Multipart,
) -> Result<HttpResponse, AppError> {
    let Some(item) = payload.next().await else {
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
    let chunks = field.map(|chunk| chunk.map_err(multipart_error));
    let result = tus_handler
        .create_completed_upload(login, metadata, chunks)
        .await
        .context(h!())?;
    if payload.next().await.is_some() {
        if let CompletedUploadWriteResult::Stored { file_id, size, .. } =
            &result
        {
            tus_handler
                .remove_completed_upload(login, *file_id, *size)
                .await;
        }
        return Ok(HttpResponse::BadRequest().finish());
    }

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
    AppError::AnyhowError {
        source: anyhow::anyhow!(error.to_string()),
    }
}
