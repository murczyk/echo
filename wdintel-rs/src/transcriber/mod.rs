pub mod backfill;
pub mod media_queue;
pub mod types;
pub mod worker;

use crate::entities::{
    echo_gpu_transcription_queue, signal_message, signal_message_media,
};
use crate::error::AppError;
use crate::h;
use crate::transcriber::types::*;
use crate::types::{Env, ShortContext, Uuid};
use actix_identity::Identity;
use actix_web::{post, web::Json};
use anyhow::Context;
use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, QuerySelect,
    RelationTrait, TransactionTrait,
};
use std::collections::HashMap;
use tokio::process::Command;

#[async_trait::async_trait]
trait BgworkerRestarter {
    async fn request_restart(&self) -> std::io::Result<()>;
}

struct SystemdBgworkerRestarter;

#[async_trait::async_trait]
impl BgworkerRestarter for SystemdBgworkerRestarter {
    async fn request_restart(&self) -> std::io::Result<()> {
        let output = Command::new("systemctl")
            .args([
                "--no-block",
                "restart",
                crate::config::ECHO_AUDIO_TRANSCRIPTION_BGWORKER_SERVICE,
            ])
            .output()
            .await?;
        if output.status.success() {
            return Ok(());
        }
        let details = String::from_utf8_lossy(&output.stderr);
        Err(std::io::Error::other(format!(
            "systemctl restart failed with status {}: {}",
            output.status,
            details.trim()
        )))
    }
}

async fn mutation_restart_result(
    reload_error: Option<anyhow::Error>,
    restarter: &dyn BgworkerRestarter,
) -> (RestartStatus, Option<String>) {
    let mut errors = Vec::new();
    if let Some(error) = reload_error {
        errors.push(format!("failed to reload GPU instances: {error:#}"));
    }
    if let Err(error) = restarter.request_restart().await {
        errors.push(format!("failed to request bgworker restart: {error}"));
    }
    if errors.is_empty() {
        (RestartStatus::Requested, None)
    } else {
        let error = errors.join("; ");
        log::error!("GPU instance configuration was saved, but {error}");
        (RestartStatus::Failed, Some(error))
    }
}

async fn apply_instance_mutation(env: &Env) -> (RestartStatus, Option<String>) {
    let reload_error = env
        .echo_gpu_client
        .reload_instances()
        .await
        .map(|_| ())
        .err();
    mutation_restart_result(reload_error, &SystemdBgworkerRestarter).await
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

pub async fn completed_transcriptions<C>(
    dbx: &C,
    source_ids: &[Uuid],
) -> Result<HashMap<Uuid, String>, AppError>
where
    C: ConnectionTrait,
{
    if source_ids.is_empty() {
        return Ok(HashMap::new());
    }
    Ok(echo_gpu_transcription_queue::Entity::find()
        .filter(
            echo_gpu_transcription_queue::Column::SourceId
                .is_in(source_ids.iter().copied()),
        )
        .filter(
            echo_gpu_transcription_queue::Column::State
                .eq(echo_gpu_client::QueueState::Completed.as_str()),
        )
        .filter(
            echo_gpu_transcription_queue::Column::TranscribedValue
                .is_not_null(),
        )
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .filter_map(|transcription| {
            transcription
                .transcribed_value
                .map(|text| (transcription.source_id, text))
        })
        .collect())
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
    let (restart_status, restart_error) = apply_instance_mutation(&env).await;
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
    let (restart_status, restart_error) = apply_instance_mutation(&env).await;
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
    let (restart_status, restart_error) = apply_instance_mutation(&env).await;
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
    let login = crate::users::login_id_from_identity(&user)?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .c(h!())?;
    crate::system_settings::ensure_audio_transcription_enabled(&env.dbx)
        .await
        .c(h!())?;
    crate::messenger::media::ensure_media_access(&env.dbx, &login, path.0)
        .await?;

    let media = signal_message_media::Entity::find()
        .join(
            sea_orm::JoinType::InnerJoin,
            signal_message_media::Relation::SignalMessage.def(),
        )
        .filter(signal_message_media::Column::SignalMessageId.eq(path.0))
        .filter(signal_message::Column::Deleted.eq(false))
        .all(&env.dbx)
        .await
        .c(h!())?;
    let transcriptions_by_media = completed_transcriptions(
        &env.dbx,
        &media.iter().map(|media| media.id).collect::<Vec<_>>(),
    )
    .await
    .c(h!())?;
    let transcriptions = media
        .into_iter()
        .filter_map(|media| {
            transcriptions_by_media.get(&media.id).map(|text| {
                MessageTranscriptionRsp {
                    media_id: media.id,
                    text: text.clone(),
                }
            })
        })
        .collect();
    Ok(Json(transcriptions))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm::{ActiveModelTrait, ActiveValue::Set};

    struct FailedRestarter;

    #[async_trait::async_trait]
    impl BgworkerRestarter for FailedRestarter {
        async fn request_restart(&self) -> std::io::Result<()> {
            Err(std::io::Error::other("systemd unavailable"))
        }
    }

    struct SuccessfulRestarter;

    #[async_trait::async_trait]
    impl BgworkerRestarter for SuccessfulRestarter {
        async fn request_restart(&self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn restart_failure_is_reported_as_partial_success() {
        let (status, error) =
            mutation_restart_result(None, &FailedRestarter).await;
        assert!(matches!(status, RestartStatus::Failed));
        assert_eq!(
            error.as_deref(),
            Some("failed to request bgworker restart: systemd unavailable")
        );
    }

    #[tokio::test]
    async fn reload_failure_is_reported_after_the_mutation() {
        let (status, error) = mutation_restart_result(
            Some(anyhow::anyhow!("database unavailable")),
            &SuccessfulRestarter,
        )
        .await;
        assert!(matches!(status, RestartStatus::Failed));
        assert_eq!(
            error.as_deref(),
            Some("failed to reload GPU instances: database unavailable")
        );
    }

    #[tokio::test]
    async fn completed_transcriptions_omit_pending_and_empty_results() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let completed_id = Uuid::now_v7();
        let pending_id = Uuid::now_v7();
        let empty_id = Uuid::now_v7();
        for (source_id, state, transcribed_value) in [
            (
                completed_id,
                echo_gpu_client::QueueState::Completed,
                Some("recognized speech"),
            ),
            (pending_id, echo_gpu_client::QueueState::Queued, None),
            (empty_id, echo_gpu_client::QueueState::Completed, None),
        ] {
            echo_gpu_transcription_queue::ActiveModel {
                source_id: Set(source_id),
                state: Set(state.as_str().to_string()),
                transcribed_value: Set(transcribed_value.map(str::to_string)),
                ..Default::default()
            }
            .insert(&env.dbx)
            .await
            .unwrap();
        }

        let transcriptions = completed_transcriptions(
            &env.dbx,
            &[completed_id, pending_id, empty_id],
        )
        .await
        .unwrap();

        assert_eq!(transcriptions.len(), 1);
        assert_eq!(
            transcriptions.get(&completed_id).map(String::as_str),
            Some("recognized speech")
        );
    }
}
