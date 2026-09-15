mod repository;

use actix_identity::Identity;
use actix_web::dev::HttpServiceFactory;
use actix_web::http::{header, Method};
use actix_web::{web, HttpRequest, HttpResponse};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::protocol::{self, ContentError};
use crate::config::DEVICE_FILE_CONTENT_REUSE_MAX_BODY_BYTES;
use crate::devices::access;
use crate::h;
use crate::types::{Env, ShortContextErr};

pub(crate) const CAPABILITY_PATH: &str = "/api/device/file-content-reuse";
pub(crate) const REUSE_PATH: &str =
    "/api/device/files/{device_id}/{file_id}/revisions/{revision}/content-reuse";
const CAPABILITY_HEADER: &str = "Echo-Content-Reuse";

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ReuseRequest {
    pub source_upload_id: Uuid,
    pub expected_size: u64,
    pub expected_sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub(super) struct ReuseReceipt {
    pub status: &'static str,
    pub device_id: Uuid,
    pub file_id: Uuid,
    pub revision: i64,
    pub source_upload_id: Uuid,
    pub source_revision: i64,
    pub size: u64,
    pub sha256: String,
}

pub(super) fn routes() -> impl HttpServiceFactory {
    (
        web::resource(CAPABILITY_PATH).route(web::route().to(capability)),
        web::resource(REUSE_PATH).route(web::route().to(reuse)),
    )
}

async fn capability(
    env: web::Data<Env>,
    identity: Option<Identity>,
    request: HttpRequest,
) -> HttpResponse {
    protocol::render(capability_inner(&env, identity, &request).await, false)
}

async fn capability_inner(
    env: &Env,
    identity: Option<Identity>,
    request: &HttpRequest,
) -> Result<HttpResponse, ContentError> {
    let login_id = super::request_login_id(identity)?;
    let login = access::resolve_login_by_id(&env.dbx, &login_id)
        .await
        .map_err(|error| ContentError::from_app(error.c(h!())))?;
    access::require_file_sync(&login.roles)
        .map_err(|error| ContentError::from_app(error.c(h!())))?;
    if request.method() != Method::OPTIONS {
        return Err(ContentError::method_not_allowed());
    }
    let runtime = super::runtime(env)?;
    repository::require_schema(runtime.file_registry_db.connection()).await?;
    Ok(HttpResponse::NoContent()
        .insert_header((CAPABILITY_HEADER, "1"))
        .insert_header((header::CACHE_CONTROL, "no-store"))
        .finish())
}

async fn reuse(
    env: web::Data<Env>,
    identity: Option<Identity>,
    request: HttpRequest,
    path: web::Path<(String, String, String)>,
    payload: web::Payload,
) -> HttpResponse {
    protocol::render(
        reuse_inner(&env, identity, request, path, payload).await,
        false,
    )
}

async fn reuse_inner(
    env: &Env,
    identity: Option<Identity>,
    request: HttpRequest,
    path: web::Path<(String, String, String)>,
    payload: web::Payload,
) -> Result<HttpResponse, ContentError> {
    let login_id = super::request_login_id(identity)?;
    super::require_tus_version(&request)?;
    let (device_id, file_id, revision) = super::parse_collection_path(path)?;
    access::authorize_file_sync_snapshot(&env.dbx, &login_id, device_id)
        .await
        .map_err(|error| ContentError::from_app(error.c(h!())))?;
    if request.method() != Method::POST {
        return Err(ContentError::method_not_allowed());
    }
    let runtime = super::runtime(env)?;
    let body = parse_request(&request, payload).await?;
    let receipt = repository::reuse(
        runtime.file_registry_db.connection(),
        device_id,
        file_id,
        revision,
        &body,
    )
    .await?;
    Ok(HttpResponse::Ok().json(receipt))
}

async fn parse_request(
    request: &HttpRequest,
    mut payload: web::Payload,
) -> Result<ReuseRequest, ContentError> {
    if request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        != Some("application/json")
    {
        return Err(ContentError::unsupported_media_type());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = payload.next().await {
        let chunk = chunk
            .map_err(|_| ContentError::bad_request("invalid_reuse_request"))?;
        if bytes.len().saturating_add(chunk.len())
            > DEVICE_FILE_CONTENT_REUSE_MAX_BODY_BYTES
        {
            return Err(ContentError::payload_too_large(Some(
                "reuse_request_too_large",
            )));
        }
        bytes.extend_from_slice(&chunk);
    }
    let body: ReuseRequest = serde_json::from_slice(&bytes)
        .map_err(|_| ContentError::bad_request("invalid_reuse_request"))?;
    if body.source_upload_id.is_nil()
        || body.expected_size > i64::MAX as u64
        || body.expected_sha256.len() != 64
        || !body
            .expected_sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(ContentError::bad_request("invalid_reuse_request"));
    }
    if body.expected_size == 0
        && body.expected_sha256 != format!("{:x}", Sha256::digest([]))
    {
        return Err(ContentError::unprocessable("sha256_mismatch"));
    }
    Ok(body)
}
