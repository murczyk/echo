pub mod media_queue;
pub mod types;
pub mod worker;

use crate::entities::signal_message_media;
use crate::error::AppError;
use crate::h;
use crate::transcriber::types::*;
use crate::types::{Env, ShortContext};
use actix_identity::Identity;
use actix_web::{post, web::Json};
use anyhow::Context;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, TransactionTrait};
use tokio::process::Command;

trait BgworkerRestarter {
    fn request_restart(&self) -> std::io::Result<()>;
}

struct SystemdBgworkerRestarter;

impl BgworkerRestarter for SystemdBgworkerRestarter {
    fn request_restart(&self) -> std::io::Result<()> {
        let mut child = Command::new("sudo")
            .args(["systemctl", "restart", "wdintel-rs-bgworker.service"])
            .kill_on_drop(false)
            .spawn()?;
        tokio::spawn(async move {
            match child.wait().await {
                Ok(status) if status.success() => {
                    log::info!("wdintel-rs-bgworker restart completed")
                }
                Ok(status) => log::error!(
                    "wdintel-rs-bgworker restart failed with status {status}"
                ),
                Err(error) => log::error!(
                    "failed to await wdintel-rs-bgworker restart: {error}"
                ),
            }
        });
        Ok(())
    }
}

fn restart_result(
    restarter: &dyn BgworkerRestarter,
) -> (RestartStatus, Option<String>) {
    match restarter.request_restart() {
        Ok(()) => (RestartStatus::Requested, None),
        Err(error) => (RestartStatus::Failed, Some(error.to_string())),
    }
}

async fn ensure_admin_enabled(
    env: &Env,
    user: &Identity,
) -> Result<(), AppError> {
    crate::users::ensure_admin(&env.dbx, user).await.c(h!())?;
    crate::system_settings::ensure_audio_transcription_enabled(&env.dbx)
        .await
        .c(h!())?;
    Ok(())
}

#[post("/api/admin/transcriber/instances/list")]
pub async fn list_instances(
    user: Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<Vec<InstanceRsp>>, AppError> {
    ensure_admin_enabled(env.as_ref(), &user).await?;
    let instances = env
        .echo_gpu_client
        .list_instances()
        .await
        .context(h!())?
        .into_iter()
        .map(Into::into)
        .collect();
    Ok(Json(instances))
}

#[post("/api/admin/transcriber/instances/create")]
pub async fn create_instance(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<CreateInstanceReq>,
) -> Result<Json<InstanceMutationRsp>, AppError> {
    ensure_admin_enabled(env.as_ref(), &user).await?;
    let txn = env.dbx.begin().await.c(h!())?;
    let instance = echo_gpu_client::create_instance(
        &txn,
        echo_gpu_client::CreateInstance {
            name: req.name.clone(),
            host: req.host.clone(),
            rs_port: req.rs_port,
            py_port: req.py_port,
            train: false,
            ordering: req.ordering,
        },
    )
    .await
    .context(h!())?;
    txn.commit().await.c(h!())?;
    env.echo_gpu_client.reload_instances().await.context(h!())?;
    let (restart_status, restart_error) =
        restart_result(&SystemdBgworkerRestarter);
    Ok(Json(InstanceMutationRsp {
        instance: Some(instance.into()),
        deleted: false,
        restart_status,
        restart_error,
    }))
}

#[post("/api/admin/transcriber/instances/update")]
pub async fn update_instance(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<UpdateInstanceReq>,
) -> Result<Json<InstanceMutationRsp>, AppError> {
    ensure_admin_enabled(env.as_ref(), &user).await?;
    let txn = env.dbx.begin().await.c(h!())?;
    let instance = echo_gpu_client::update_instance(
        &txn,
        req.id,
        echo_gpu_client::UpdateInstance {
            name: req.name.clone(),
            host: req.host.clone(),
            is_active: req.is_active,
            rs_port: req.rs_port,
            py_port: req.py_port,
            train: None,
            ordering: req.ordering,
        },
    )
    .await
    .context(h!())?;
    txn.commit().await.c(h!())?;
    env.echo_gpu_client.reload_instances().await.context(h!())?;
    let (restart_status, restart_error) =
        restart_result(&SystemdBgworkerRestarter);
    Ok(Json(InstanceMutationRsp {
        instance: Some(instance.into()),
        deleted: false,
        restart_status,
        restart_error,
    }))
}

#[post("/api/admin/transcriber/instances/delete")]
pub async fn delete_instance(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<InstanceIdReq>,
) -> Result<Json<InstanceMutationRsp>, AppError> {
    ensure_admin_enabled(env.as_ref(), &user).await?;
    let txn = env.dbx.begin().await.c(h!())?;
    let deleted = echo_gpu_client::delete_instance(&txn, req.id)
        .await
        .context(h!())?;
    if !deleted {
        return Err(AppError::NotFound);
    }
    txn.commit().await.c(h!())?;
    env.echo_gpu_client.reload_instances().await.context(h!())?;
    let (restart_status, restart_error) =
        restart_result(&SystemdBgworkerRestarter);
    Ok(Json(InstanceMutationRsp {
        instance: None,
        deleted,
        restart_status,
        restart_error,
    }))
}

#[post("/api/admin/transcriber/instances/check")]
pub async fn check_instance(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<InstanceIdReq>,
) -> Result<Json<InstanceHealthRsp>, AppError> {
    ensure_admin_enabled(env.as_ref(), &user).await?;
    Ok(Json(
        env.echo_gpu_client
            .check_instance(req.id)
            .await
            .context(h!())?
            .into(),
    ))
}

#[post("/api/admin/transcriber/status")]
pub async fn queue_status(
    user: Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<QueueStatusRsp>, AppError> {
    ensure_admin_enabled(env.as_ref(), &user).await?;
    Ok(Json(
        echo_gpu_client::queue_status(&env.dbx)
            .await
            .context(h!())?
            .into(),
    ))
}

#[post("/api/transcriber/messages/{message_id}")]
pub async fn message_transcriptions(
    user: Identity,
    env: actix_web::web::Data<Env>,
    path: actix_web::web::Path<(i64,)>,
) -> Result<Json<Vec<MessageTranscriptionRsp>>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .c(h!())?;
    crate::system_settings::ensure_audio_transcription_enabled(&env.dbx)
        .await
        .c(h!())?;
    crate::messenger::media::ensure_media_access(&env.dbx, &login, path.0)
        .await?;

    let media = signal_message_media::Entity::find()
        .filter(signal_message_media::Column::SignalMessageId.eq(path.0))
        .all(&env.dbx)
        .await
        .c(h!())?;
    let mut transcriptions = Vec::new();
    for media in media {
        let Some(item) = echo_gpu_client::lookup(&env.dbx, media.id)
            .await
            .context(h!())?
        else {
            continue;
        };
        if item.state().context(h!())? != echo_gpu_client::QueueState::Completed
        {
            continue;
        }
        if let Some(text) = item.0.transcribed_value {
            transcriptions.push(MessageTranscriptionRsp {
                media_id: media.id,
                text,
            });
        }
    }
    Ok(Json(transcriptions))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FailedRestarter;

    impl BgworkerRestarter for FailedRestarter {
        fn request_restart(&self) -> std::io::Result<()> {
            Err(std::io::Error::other("systemd unavailable"))
        }
    }

    #[test]
    fn restart_failure_is_reported_as_partial_success() {
        let (status, error) = restart_result(&FailedRestarter);
        assert!(matches!(status, RestartStatus::Failed));
        assert_eq!(error.as_deref(), Some("systemd unavailable"));
    }
}
