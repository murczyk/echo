//! Encrypted S3 storage of document revisions, shared with uploads.

use super::validate::DOCX_CONTENT_TYPE;
use crate::error::AppError;
use crate::h;
use crate::types::{Env, ShortContext};

pub(super) async fn put(
    env: &Env,
    bytes: actix_web::web::Bytes,
    file_name: &str,
) -> Result<String, AppError> {
    Ok(crate::messenger::media::store_asset(
        env,
        bytes,
        Some(file_name),
        Some(DOCX_CONTENT_TYPE),
    )
    .await
    .c(h!())?)
}

pub(super) async fn fetch(env: &Env, key: &str) -> Result<Vec<u8>, AppError> {
    Ok(crate::messenger::media::fetch_media_bytes_by_key(env, key)
        .await
        .c(h!())?)
}

pub(super) async fn delete(env: &Env, key: &str) {
    crate::sigint::unit::attachment::delete_stored_asset_best_effort(env, key)
        .await;
}
