use crate::{h, types::ShortContext};
use sea_orm::{
    ConnectionTrait, DatabaseBackend, FromQueryResult, Statement, Value,
};
use uuid::Uuid;

pub async fn execute<C: ConnectionTrait>(
    db: &C,
    sql: &str,
    values: Vec<Value>,
) -> anyhow::Result<u64> {
    Ok(db
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            sql,
            values,
        ))
        .await
        .c(h!())?
        .rows_affected())
}

pub async fn rows<T: FromQueryResult, C: ConnectionTrait>(
    db: &C,
    sql: &str,
    values: Vec<Value>,
) -> anyhow::Result<Vec<T>> {
    T::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        sql,
        values,
    ))
    .all(db)
    .await
    .c(h!())
}

pub async fn queue<C: ConnectionTrait>(
    db: &C,
    media_id: Uuid,
    generation: Uuid,
    kind: &str,
) -> anyhow::Result<()> {
    execute(db, "insert into attachment_job(media_id,generation,kind) values($1,$2,$3) on conflict do nothing",
        vec![media_id.into(), generation.into(), kind.into()]).await.c(h!())?;
    Ok(())
}

pub const ITEM_COLUMNS: &str = "media.id::text as media_id, media.signal_message_id as message_id,
 message.id_uuid::text as message_uuid, coalesce(media.file_name,media.id::text) as file_name,
 media.content_type, coalesce(doc.state,'queued') as state,doc.quality,
 coalesce(doc.complete,false) as complete,doc.revision::text as revision,doc.summary,
 coalesce(doc.summary_state,'queued') as summary_state,
 coalesce(doc.position_state,'queued') as position_state,coalesce(doc.chunk_count,0) as chunk_count,
 doc.last_error, null::text as snippet,
 '/rer-analysis-neo?m=' || coalesce(message.id_uuid::text,message.id::text) as citation";

pub const ITEM_FROM: &str = "from signal_message_media media
 join signal_message message on message.id=media.signal_message_id
 left join attachment_document doc on doc.media_id=media.id";

pub async fn delete_artifact(env: &crate::types::Env, key: &str) {
    if !key.starts_with(&artifact_prefix(&env.config)) {
        return;
    }
    if let (Some(storage), Some(config)) = (&env.s3, &env.s3_config) {
        if let Err(error) = storage.delete(&config.prefixed_key(key)).await {
            crate::types::error!(
                "attachment artifact cleanup failed: {error:#}"
            );
        }
    }
}

pub fn artifact_prefix(config: &crate::config::Config) -> String {
    let instance = config
        .ocr
        .as_ref()
        .map(|ocr| ocr.instance_id.as_str())
        .unwrap_or(&config.public_host);
    format!(
        "attachments/{}/",
        &sha256::digest(instance.as_bytes())[..16]
    )
}

pub(crate) fn extractor_config(
    env: &crate::types::Env,
) -> anyhow::Result<crate::ocr::OcrRuntimeConfig> {
    let mut config = crate::ocr::runtime_config(env).c(h!())?;
    if let Ok(endpoint) =
        std::env::var(crate::config::ATTACHMENT_EXTRACTOR_URL_ENV)
    {
        let url = url::Url::parse(&endpoint).c(h!())?;
        anyhow::ensure!(
            matches!(url.scheme(), "http" | "https")
                && url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none(),
            "invalid native extractor URL"
        );
        config.base_url = endpoint.trim_end_matches('/').to_string();
    }
    Ok(config)
}
