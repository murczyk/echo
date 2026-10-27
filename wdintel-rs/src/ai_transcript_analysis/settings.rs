use super::{store::*, types::*};
use crate::config::*;
use crate::entities::ai_engine;
use crate::{h, types::ShortContext};
use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, QuerySelect,
};
use uuid::Uuid;

#[derive(Clone, sea_orm::FromQueryResult)]
pub(crate) struct Settings {
    pub prompt: String,
    pub worker_enabled: bool,
    pub worker_ai_engine_id: Option<Uuid>,
    pub revision: Uuid,
}

pub(crate) async fn load<C: ConnectionTrait>(
    db: &C,
) -> anyhow::Result<Settings> {
    rows(db, "select prompt,worker_enabled,worker_ai_engine_id,revision from ai_transcript_analysis_settings where id=1", vec![])
        .await.c(h!())?.pop().ok_or_else(|| anyhow::anyhow!("Немає налаштувань аналізу транскрипцій"))
}

pub(crate) fn effective_prompt(settings: &Settings) -> &str {
    if settings.prompt.is_empty() {
        AI_TRANSCRIPT_ANALYSIS_DEFAULT_PROMPT
    } else {
        &settings.prompt
    }
}

pub(crate) fn worker_item(settings: &Settings) -> AiTranscriptWorkerSettings {
    AiTranscriptWorkerSettings {
        enabled: settings.worker_enabled,
        ai_engine_id: settings.worker_ai_engine_id.map(|id| id.to_string()),
    }
}

pub(crate) async fn engine<C: ConnectionTrait>(
    db: &C,
    id: Uuid,
    lock: bool,
) -> anyhow::Result<ai_engine::Model> {
    let query = ai_engine::Entity::find_by_id(id)
        .filter(ai_engine::Column::Enabled.eq(true));
    let query = if lock { query.lock_shared() } else { query };
    query
        .one(db)
        .await
        .c(h!())?
        .ok_or_else(|| anyhow::anyhow!("ШІ движок вимкнено або видалено"))
}

pub(crate) async fn save_prompt<C: ConnectionTrait>(
    db: &C,
    prompt: &str,
) -> anyhow::Result<()> {
    execute(db, "update ai_transcript_analysis_settings set prompt=$1,revision=gen_random_uuid() where id=1", vec![prompt.into()]).await.c(h!())?;
    execute(
        db,
        "delete from ai_transcript_analysis_test_result where prompt<>$1",
        vec![prompt.into()],
    )
    .await
    .c(h!())?;
    Ok(())
}

pub(crate) async fn set_group<C: ConnectionTrait>(
    db: &C,
    key: &str,
    enabled: Option<bool>,
) -> anyhow::Result<bool> {
    if let Some(enabled) = enabled {
        execute(db, "update signal_group set ai_transcript_analysis_enabled=$2,ai_transcript_analysis_enabled_at=case when $2 then clock_timestamp() at time zone 'utc' else null end where master_key=$1 and coalesce(ai_transcript_analysis_enabled,false) is distinct from $2", vec![key.into(),enabled.into()]).await.c(h!())?;
    }
    #[derive(sea_orm::FromQueryResult)]
    struct Flag {
        enabled: bool,
    }
    Ok(rows::<Flag,_>(db, "select coalesce(ai_transcript_analysis_enabled,false) as enabled from signal_group where master_key=$1", vec![key.into()]).await.c(h!())?.pop().c(h!())?.enabled)
}
