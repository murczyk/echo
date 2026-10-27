use crate::config::{
    MESSENGER_INGEST_UPLOAD_PATH_BASE, MESSENGER_INGEST_UPLOAD_STORAGE_DIR,
    SIGINT_FILE_UPLOAD_CLEANUP_INTERVAL_SECS,
};
use crate::error::AppError;
use crate::h;
use crate::messenger_ingest::access::IngestScope;
use crate::sigint::file_upload::tus::TusHandler;
use crate::types::Env;
use crate::types::ShortContext;
use actix_web::http::header::HeaderMap;
use actix_web::http::Method;
use actix_web::{web, HttpResponse};
use std::path::PathBuf;

/// The TUS handler of the ingest API. Uploads live in their own
/// `file_upload_tus` tree under `storage_dir/messenger_ingest`, so an
/// operator upload URL never resolves as an ingest upload and vice versa.
/// Uploads are owned by the login, as in the operator flow.
pub(crate) fn upload_handler(storage_dir: &str) -> TusHandler {
    let root = if storage_dir.trim().is_empty() {
        std::env::temp_dir()
    } else {
        PathBuf::from(storage_dir)
    };
    TusHandler::new(
        root.join(MESSENGER_INGEST_UPLOAD_STORAGE_DIR)
            .display()
            .to_string(),
        MESSENGER_INGEST_UPLOAD_PATH_BASE,
    )
}

pub(crate) fn ensure_uploads_enabled(env: &Env) -> Result<(), AppError> {
    if env.config.s3_config.is_none() {
        return Err(AppError::BL {
            msg: "s3 config is required for attachment upload".to_string(),
        });
    }
    Ok(())
}

pub(crate) async fn handle_upload(
    env: &Env,
    scope: &IngestScope,
    method: &Method,
    headers: &HeaderMap,
    request_file: Option<String>,
    payload: web::Payload,
) -> Result<HttpResponse, AppError> {
    ensure_uploads_enabled(env).c(h!())?;
    // Only an upload resource accepts `X-HTTP-Method-Override: PATCH`,
    // same as the operator TUS endpoint.
    let method = if request_file.is_some() {
        crate::tus::effective_resource_method(method, headers, &[Method::PATCH])
    } else {
        method.clone()
    };
    upload_handler(&env.config.storage_dir)
        .handle_request(
            &scope.login_id,
            &method,
            headers,
            request_file,
            payload,
        )
        .await
}

pub async fn run_cleanup_nofail(
    storage_dir: String,
    cancellation: tokio_util::sync::CancellationToken,
) {
    let handler = upload_handler(&storage_dir);
    loop {
        if let Err(error) = handler.cleanup_expired().await {
            log::error!("failed to clean messenger ingest uploads: {error:?}");
        }
        tokio::select! {
            _ = cancellation.cancelled() => return,
            _ = tokio::time::sleep(std::time::Duration::from_secs(
                SIGINT_FILE_UPLOAD_CLEANUP_INTERVAL_SECS,
            )) => {}
        }
    }
}
