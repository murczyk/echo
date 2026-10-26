mod eval;
mod inference;
mod input;
mod message;
mod queue;
pub(crate) mod settings;
mod store;
pub mod types;
pub mod worker;

use crate::error::AppError;
use crate::types::Env;
use crate::users::ensure_admin;
use crate::{h, types::ShortContext};
use actix_identity::Identity;
use actix_web::{
    post,
    web::{Data, Json},
};
use sea_orm::TransactionTrait;
use store::*;
use types::*;
use uuid::Uuid;

fn text(value: String) -> anyhow::Result<String> {
    let value = value.trim().to_string();
    anyhow::ensure!(!value.is_empty(), "Введіть текст");
    anyhow::ensure!(
        value.chars().count()
            <= crate::config::AI_TRANSCRIPT_ANALYSIS_MAX_CHARS,
        "Текст задовгий"
    );
    Ok(value)
}

#[post("/api/admin/ai-transcript-analysis/queue")]
pub async fn list_queue(
    env: Data<Env>,
    user: Identity,
    req: Json<AiTranscriptQueueReq>,
) -> Result<Json<AiTranscriptQueueRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    Ok(Json(queue::list(&env.dbx, req.into_inner()).await.c(h!())?))
}

#[post("/api/admin/ai-transcript-analysis/page")]
pub async fn page(
    env: Data<Env>,
    user: Identity,
) -> Result<Json<AiTranscriptPage>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let settings = settings::load(&env.dbx).await.c(h!())?;
    Ok(Json(AiTranscriptPage {
        prompt: settings::effective_prompt(&settings).to_string(),
        prompt_overridden: !settings.prompt.is_empty(),
        worker: settings::worker_item(&settings),
        engines: eval::engines(&env.dbx).await.c(h!())?,
        messages: eval::messages(&env.dbx).await.c(h!())?,
    }))
}

#[post("/api/admin/ai-transcript-analysis/prompt/reset")]
pub async fn reset(
    env: Data<Env>,
    user: Identity,
) -> Result<Json<AiTranscriptPrompt>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let transaction = env.dbx.begin().await.c(h!())?;
    settings::save_prompt(&transaction, "").await.c(h!())?;
    transaction.commit().await.c(h!())?;
    Ok(Json(AiTranscriptPrompt {
        prompt: crate::config::AI_TRANSCRIPT_ANALYSIS_DEFAULT_PROMPT
            .to_string(),
        prompt_overridden: false,
    }))
}

#[post("/api/admin/ai-transcript-analysis/messages/save")]
pub async fn save_message(
    env: Data<Env>,
    user: Identity,
    req: Json<AiTranscriptMessageReq>,
) -> Result<Json<AiTranscriptTestMessage>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let message = text(req.message.clone()).c(h!())?;
    let transaction = env.dbx.begin().await.c(h!())?;
    let id = match &req.id {
        Some(id) => {
            let id = Uuid::parse_str(id).c(h!())?;
            let changed = execute(&transaction, "update ai_transcript_analysis_test_message set message=$2,version=gen_random_uuid() where id=$1", vec![id.into(),message.into()]).await.c(h!())?;
            if changed != 1 {
                return Err(AppError::NotFound);
            }
            execute(&transaction, "delete from ai_transcript_analysis_test_result where test_message_id=$1", vec![id.into()]).await.c(h!())?;
            id
        }
        None => {
            let id = Uuid::now_v7();
            execute(&transaction, "insert into ai_transcript_analysis_test_message(id,message) values($1,$2)", vec![id.into(),message.into()]).await.c(h!())?;
            id
        }
    };
    let message = eval::messages(&transaction)
        .await
        .c(h!())?
        .into_iter()
        .find(|message| message.id == id.to_string())
        .c(h!())?;
    transaction.commit().await.c(h!())?;
    Ok(Json(message))
}

#[post("/api/admin/ai-transcript-analysis/messages/delete")]
pub async fn delete_message(
    env: Data<Env>,
    user: Identity,
    req: Json<AiTranscriptMessageIdReq>,
) -> Result<Json<()>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let id = Uuid::parse_str(&req.id).c(h!())?;
    execute(
        &env.dbx,
        "delete from ai_transcript_analysis_test_message where id=$1",
        vec![id.into()],
    )
    .await
    .c(h!())?;
    Ok(Json(()))
}

#[post("/api/admin/ai-transcript-analysis/test")]
pub async fn test(
    env: Data<Env>,
    user: Identity,
    req: Json<AiTranscriptRunReq>,
) -> Result<Json<AiTranscriptRunRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    Ok(Json(eval::run(&env, req.into_inner()).await.c(h!())?))
}

#[post("/api/admin/ai-transcript-analysis/save")]
pub async fn save(
    env: Data<Env>,
    user: Identity,
    req: Json<AiTranscriptSaveReq>,
) -> Result<Json<AiTranscriptRunRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    Ok(Json(eval::save(&env.dbx, req.into_inner()).await.c(h!())?))
}

#[post("/api/admin/ai-transcript-analysis/recalculate")]
pub async fn recalculate(
    env: Data<Env>,
    user: Identity,
    req: Json<AiTranscriptRunReq>,
) -> Result<Json<AiTranscriptRunRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let req = req.into_inner();
    let prompt = req.prompt.clone();
    let result = eval::run(&env, req).await.c(h!())?;
    Ok(Json(
        eval::save(
            &env.dbx,
            AiTranscriptSaveReq {
                prompt,
                results: result.results,
                message_versions: result.message_versions,
                engine_versions: result.engine_versions,
            },
        )
        .await
        .c(h!())?,
    ))
}

#[post("/api/admin/ai-transcript-analysis/worker/save")]
pub async fn save_worker(
    env: Data<Env>,
    user: Identity,
    req: Json<AiTranscriptWorkerSettings>,
) -> Result<Json<AiTranscriptWorkerSettings>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let engine_id = req
        .ai_engine_id
        .as_deref()
        .map(Uuid::parse_str)
        .transpose()
        .c(h!())?;
    if req.enabled && engine_id.is_none() {
        return Err(AppError::BL {
            msg: "Оберіть ШІ движок для воркера".into(),
        });
    }
    let transaction = env.dbx.begin().await.c(h!())?;
    if let (true, Some(id)) = (req.enabled, engine_id) {
        settings::engine(&transaction, id, true).await.c(h!())?;
    }
    execute(&transaction, "update ai_transcript_analysis_settings set worker_enabled=$1,worker_ai_engine_id=$2,revision=gen_random_uuid() where id=1", vec![req.enabled.into(),engine_id.into()]).await.c(h!())?;
    transaction.commit().await.c(h!())?;
    Ok(req)
}
