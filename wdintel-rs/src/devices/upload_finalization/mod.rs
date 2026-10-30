pub(crate) mod admission;
pub(crate) mod cleanup;
pub(crate) mod fault;
pub(crate) mod ingress;
pub(crate) mod metrics;
pub(crate) mod query;
pub(crate) mod recovery;
pub(crate) mod resources;
pub(crate) mod types;
pub(crate) mod worker;

#[cfg(test)]
mod acceptance_tests;
#[cfg(test)]
mod metrics_tests;
#[cfg(all(test, debug_assertions))]
pub(crate) mod security_fault;
#[cfg(test)]
mod tests;

use actix_identity::Identity;
use actix_web::{web, HttpResponse, ResponseError};
use sea_orm::{AccessMode, IsolationLevel, TransactionTrait};
use uuid::Uuid;

use crate::devices::{
    access,
    devices::query::{
        authorize_file_registry_access, FileRegistryDeviceAccess,
    },
};
use crate::error::AppError;
use crate::{
    h,
    types::{warn, DeviceUploadFinalizationSettings, Env, ShortContext},
};
use types::{FinalizationJobSnapshot, FinalizationKind};

pub(crate) fn config(config: &mut web::ServiceConfig) {
    config.route(
        "/api/device/upload-finalization-jobs/{job_id}",
        web::get().to(get_job),
    );
}

async fn get_job(
    env: web::Data<Env>,
    identity: Option<Identity>,
    job_id: web::Path<String>,
) -> HttpResponse {
    let result = async {
        let identity = identity.ok_or(AppError::Unauthenticated).c(h!())?;
        let actor_id = current_actor(&env, &identity).await.c(h!())?;
        let job_id = Uuid::parse_str(&job_id)
            .ok()
            .filter(|id| id.hyphenated().to_string() == *job_id)
            .ok_or_else(|| AppError::BL {
                msg: "job_id must be a canonical lowercase hyphenated UUID"
                    .into(),
            })
            .c(h!())?;
        Ok(get_snapshot(&env, job_id, actor_id).await.c(h!())?)
    }
    .await;
    status_response(result)
}

pub(crate) fn configured_settings(
    config: &crate::config::Config,
    has_database: bool,
) -> DeviceUploadFinalizationSettings {
    let mut settings = config
        .device_upload_finalization
        .clone()
        .unwrap_or_default();
    if !settings.is_valid() {
        warn!("device upload finalization configuration is invalid; new async admission disabled");
        return DeviceUploadFinalizationSettings::default();
    }
    let storage_ready = config.s3_config.as_ref().is_some_and(|s3| {
        crate::storage::is_s3_encryption_ready(
            &crate::storage::S3Config::with_prefix(s3, String::new()),
            &s3.strongbox_key,
        ) && crate::storage::key_from_b64(&s3.strongbox_key).is_ok()
    });
    if !settings.enabled {
        warn!("device upload async admission is disabled; existing finalizations remain recoverable");
    } else if !has_database || config.storage_dir.is_empty() || !storage_ready {
        warn!("device upload async admission prerequisites are unavailable");
        settings.enabled = false;
    }
    settings
}

pub(crate) async fn current_actor(
    env: &Env,
    identity: &Identity,
) -> Result<Uuid, AppError> {
    let login = access::resolve_current_login(&env.dbx, identity)
        .await
        .map_err(status_error)?;
    Ok(login.id)
}

pub(crate) async fn get_snapshot(
    env: &Env,
    job_id: Uuid,
    actor_id: Uuid,
) -> Result<FinalizationJobSnapshot, AppError> {
    let database = env.file_registry_db.as_ref().ok_or_else(unavailable)?;
    let (job, now) = query::read_job(database.connection(), job_id)
        .await
        .map_err(|_| unavailable())?
        .ok_or(AppError::NotFound)?;
    if job.created_by_login_id != actor_id {
        return Err(AppError::NotFound);
    }
    authorize(env, actor_id, job.device_id, job.kind, false)
        .await
        .map_err(status_error)?;
    job.snapshot(now).map_err(|_| unavailable())
}

pub(crate) async fn authorize_write(
    env: &Env,
    actor_id: Uuid,
    device_id: Uuid,
    kind: FinalizationKind,
) -> Result<(), AppError> {
    authorize(env, actor_id, device_id, kind, true).await
}

pub(crate) async fn authorize_read(
    env: &Env,
    actor_id: Uuid,
    device_id: Uuid,
    kind: FinalizationKind,
) -> Result<(), AppError> {
    authorize(env, actor_id, device_id, kind, false)
        .await
        .map_err(status_error)
}

async fn authorize(
    env: &Env,
    actor_id: Uuid,
    device_id: Uuid,
    kind: FinalizationKind,
    write: bool,
) -> Result<(), AppError> {
    let transaction = env
        .dbx
        .begin_with_config(
            Some(IsolationLevel::RepeatableRead),
            Some(AccessMode::ReadOnly),
        )
        .await
        .c(h!())?;
    let login = access::resolve_login_by_id(&transaction, &actor_id)
        .await
        .c(h!())?;
    if write && kind == FinalizationKind::FinalizationAudioKind {
        access::require_audio_source(&login.roles).c(h!())?;
    }
    authorize_file_registry_access(
        &transaction,
        &login,
        device_id,
        if write {
            FileRegistryDeviceAccess::FileSync
        } else {
            FileRegistryDeviceAccess::Read
        },
    )
    .await
    .c(h!())?;
    transaction.commit().await.c(h!())?;
    Ok(())
}

pub(crate) fn status_response(
    result: Result<FinalizationJobSnapshot, AppError>,
) -> HttpResponse {
    let mut response = match result {
        Ok(snapshot) => {
            let mut response = HttpResponse::Ok();
            if let Some(seconds) = snapshot.retry_after_seconds {
                response.insert_header((
                    actix_web::http::header::RETRY_AFTER,
                    seconds.to_string(),
                ));
            }
            response.json(snapshot)
        }
        Err(error) => error.error_response(),
    };
    response.headers_mut().insert(
        actix_web::http::header::CACHE_CONTROL,
        actix_web::http::header::HeaderValue::from_static("private, no-store"),
    );
    response
}

fn status_error(error: AppError) -> AppError {
    match error {
        AppError::Unauthenticated => AppError::Unauthenticated,
        AppError::NotFound
        | AppError::Forbidden(_)
        | AppError::ForbiddenWithHeader { .. } => AppError::NotFound,
        _ => unavailable(),
    }
}

fn unavailable() -> AppError {
    AppError::ServiceUnavailable {
        msg: "Upload finalization is temporarily unavailable".into(),
        retry_after_secs: 1,
    }
}
