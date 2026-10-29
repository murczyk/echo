use super::{
    authorize_source, unavailable, DeviceAudioHttpError, DeviceAudioRuntime,
    DEVICE_AUDIO_COMPLETED_TTL, DEVICE_AUDIO_MAX_BYTES,
    DEVICE_AUDIO_PENDING_TTL,
};
use crate::devices::types::parse_uuid;
use crate::h;
use crate::sigint::file_upload::tus::{TusConfig, TusHandler, TusUpload};
use crate::types::{Env, ShortContext, Uuid};
use actix_identity::Identity;
use actix_web::{web, HttpRequest, HttpResponse};

#[derive(serde::Deserialize)]
struct UploadPath {
    #[serde(
        deserialize_with = "crate::devices::types::deserialize_canonical_uuid"
    )]
    device_id: String,
    #[serde(default)]
    upload_ref: Option<String>,
}

pub(crate) fn routes() -> impl actix_web::dev::HttpServiceFactory {
    (
        web::resource("/api/device/audio/{device_id}/uploads")
            .route(web::post().to(handle))
            .route(web::method(actix_web::http::Method::OPTIONS).to(handle)),
        web::resource("/api/device/audio/{device_id}/uploads/{upload_ref}")
            .route(web::head().to(handle))
            .route(web::patch().to(handle))
            .route(web::post().to(handle))
            .route(web::delete().to(handle))
            .route(web::method(actix_web::http::Method::OPTIONS).to(handle)),
    )
}

async fn handle(
    env: web::Data<Env>,
    user: Identity,
    request: HttpRequest,
    path: web::Path<UploadPath>,
    payload: web::Payload,
) -> Result<HttpResponse, DeviceAudioHttpError> {
    let actor_id = crate::users::login_id_from_identity(&user).c(h!())?;
    let device_id = parse_uuid(&path.device_id);
    authorize_source(&env.device_audio, actor_id, device_id)
        .await
        .c(h!())?;
    let method = if path.upload_ref.is_some() {
        crate::tus::effective_resource_method(
            request.method(),
            request.headers(),
            &[actix_web::http::Method::PATCH],
        )
    } else {
        request.method().clone()
    };
    Ok(handler(&env.device_audio, device_id)
        .c(h!())?
        .handle_request(
            &actor_id,
            &method,
            request.headers(),
            path.into_inner().upload_ref,
            payload,
        )
        .await
        .c(h!())?)
}

pub(super) fn handler(
    runtime: &DeviceAudioRuntime,
    device_id: Uuid,
) -> anyhow::Result<TusHandler> {
    runtime.file_database().c(h!())?;
    if runtime.storage_dir.as_os_str().is_empty() {
        return Err(unavailable("storage_dir is missing").into());
    }
    let storage_dir = runtime
        .storage_dir
        .join("device-audio-tus")
        .join(device_id.to_string());
    Ok(TusHandler::with_config(
        storage_dir.display().to_string(),
        &format!("/api/device/audio/{device_id}/uploads"),
        TusConfig {
            max_size: Some(DEVICE_AUDIO_MAX_BYTES),
            pending_expires_in: DEVICE_AUDIO_PENDING_TTL,
            completed_expires_in: DEVICE_AUDIO_COMPLETED_TTL,
        },
    )
    .with_finalization_database(runtime.file_database().c(h!())?.clone()))
}

pub(super) async fn open_completed(
    runtime: &DeviceAudioRuntime,
    actor_id: Uuid,
    device_id: Uuid,
    upload_url: &str,
) -> anyhow::Result<(
    TusUpload,
    crate::sigint::file_upload::lifecycle::UploadLock,
)> {
    let (upload, guard) =
        lock_completed(runtime, actor_id, device_id, upload_url, None)
            .await
            .c(h!())?;
    validate_locked_source(&upload).await.c(h!())?;
    Ok((upload, guard))
}

pub(super) async fn lock_completed(
    runtime: &DeviceAudioRuntime,
    actor_id: Uuid,
    device_id: Uuid,
    upload_url: &str,
    deadline: Option<std::time::Instant>,
) -> anyhow::Result<(
    TusUpload,
    crate::sigint::file_upload::lifecycle::UploadLock,
)> {
    let handler = handler(runtime, device_id).c(h!())?;
    let handler = match deadline {
        Some(deadline) => handler.with_source_lock_deadline(deadline),
        None => handler,
    };
    let upload = resolve_completed(&handler, actor_id, device_id, upload_url)
        .await
        .c(h!())?;
    let guard = match deadline {
        Some(deadline) => {
            crate::sigint::file_upload::lock_uploaded_source_until(
                &upload.file_path,
                deadline,
            )
            .await
            .c(h!())?
        }
        None => {
            crate::sigint::file_upload::lock_uploaded_source(&upload.file_path)
                .await
                .c(h!())?
        }
    }
    .ok_or(crate::error::AppError::NotFound)
    .c(h!())?;
    Ok((upload, guard))
}

pub(super) async fn validate_locked_source(
    upload: &TusUpload,
) -> anyhow::Result<()> {
    let metadata = match tokio::fs::symlink_metadata(&upload.file_path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(crate::error::AppError::NotFound.into());
        }
        Err(error) => return Err(error).c(h!()),
    };
    if !metadata.is_file() || chrono::Utc::now() >= upload.expires {
        return Err(crate::error::AppError::NotFound.into());
    }
    if metadata.len() != upload.upload_length
        || metadata.len() == 0
        || metadata.len() > DEVICE_AUDIO_MAX_BYTES
    {
        return Err(super::DeviceAudioMediaError::InvalidAudio {
            reason: "source length does not match the completed upload"
                .to_string(),
        }
        .into());
    }
    Ok(())
}

async fn resolve_completed(
    handler: &TusHandler,
    actor_id: Uuid,
    device_id: Uuid,
    upload_url: &str,
) -> anyhow::Result<TusUpload> {
    let prefix = format!("/api/device/audio/{device_id}/uploads/");
    let request_file = upload_url
        .strip_prefix(&prefix)
        .ok_or(crate::error::AppError::NotFound)
        .c(h!())?;
    if let Some(source) = handler
        .open_completed_url(&actor_id, upload_url)
        .await
        .c(h!())?
    {
        return Ok(source);
    }
    let head = head_upload(handler, actor_id, request_file).await.c(h!())?;
    match head.status() {
        actix_web::http::StatusCode::LOCKED => {
            Err(unavailable("upload is busy").into())
        }
        actix_web::http::StatusCode::NO_CONTENT => {
            let offset = header_length(&head, "upload-offset").c(h!())?;
            let length = header_length(&head, "upload-length").c(h!())?;
            if offset < length {
                return Err(crate::error::AppError::ConflictJson {
                    body: serde_json::json!({
                        "message": "Завантаження аудіо ще не завершене",
                        "details": { "code": "device_audio_upload_incomplete" }
                    }),
                }
                .into());
            }
            handler
                .open_completed_url(&actor_id, upload_url)
                .await
                .c(h!())?
                .ok_or(crate::error::AppError::NotFound)
                .c(h!())
        }
        actix_web::http::StatusCode::NOT_FOUND => {
            Err(crate::error::AppError::NotFound.into())
        }
        _ => Err(anyhow::anyhow!(
            "TUS source HEAD failed with {}",
            head.status()
        )),
    }
}

async fn head_upload(
    handler: &TusHandler,
    actor_id: Uuid,
    request_file: &str,
) -> anyhow::Result<HttpResponse> {
    use actix_web::FromRequest;
    let (request, mut empty) = actix_web::test::TestRequest::default()
        .insert_header(("tus-resumable", "1.0.0"))
        .to_http_parts();
    let payload = web::Payload::from_request(&request, &mut empty)
        .await
        .map_err(|error| anyhow::anyhow!("{error}"))
        .c(h!())?;
    handler
        .handle_request(
            &actor_id,
            &actix_web::http::Method::HEAD,
            request.headers(),
            Some(request_file.to_string()),
            payload,
        )
        .await
        .c(h!())
}

fn header_length(response: &HttpResponse, name: &str) -> anyhow::Result<u64> {
    response
        .headers()
        .get(name)
        .ok_or_else(|| anyhow::anyhow!("TUS HEAD omitted {name}"))
        .c(h!())?
        .to_str()
        .c(h!())?
        .parse::<u64>()
        .c(h!())
}
