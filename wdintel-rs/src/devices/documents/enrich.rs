use super::queue::{self, Job};
use crate::{
    attachments::store::{execute, rows},
    entities::ai_engine,
    h,
    types::{Env, ShortContext},
};
use sea_orm::{EntityTrait, FromQueryResult, TransactionTrait};
use uuid::Uuid;

async fn engine(
    env: &Env,
    id: Option<&str>,
) -> anyhow::Result<Option<ai_engine::Model>> {
    let Some(id) = id else { return Ok(None) };
    Ok(ai_engine::Entity::find_by_id(Uuid::parse_str(id).c(h!())?)
        .one(&env.dbx)
        .await
        .c(h!())?
        .filter(|engine| engine.enabled && engine.callsign_enabled))
}

#[derive(FromQueryResult)]
struct Chunk {
    id: Uuid,
    text: String,
}

pub(super) async fn summarize(
    env: &Env,
    job: &Job,
    id: Option<&str>,
) -> anyhow::Result<bool> {
    let Some(engine) = engine(env, id).await.c(h!())? else {
        return Ok(false);
    };
    let db = env.file_registry_db().c(h!())?.connection();
    if let Some(chunk)=rows::<Chunk,_>(db,"select id,text from file_document_chunk where generation=$1 and summary is null order by ordinal limit 1",vec![job.generation.into()]).await.c(h!())?.pop() {
        let (summary,_)=crate::media_summary::worker::summarize_attachment_text(&env.ai_engine_client,&engine,&chunk.text).await.c(h!())?;
        let tx=db.begin().await.c(h!())?; queue::renew(&tx,job).await.c(h!())?;
        execute(&tx,"update file_document_chunk set summary=$2 where id=$1",vec![chunk.id.into(),summary.into()]).await.c(h!())?;
        tx.commit().await.c(h!())?;
        return Ok(false);
    }
    #[derive(FromQueryResult)]
    struct Summary {
        summary: String,
    }
    let mut summaries=rows::<Summary,_>(db,"select member || ' — ' || locator || ': ' || summary as summary from file_document_chunk where generation=$1 order by ordinal",vec![job.generation.into()]).await.c(h!())?.into_iter().map(|s|s.summary).collect::<Vec<_>>();
    while summaries.len() > 1 {
        let previous = summaries.len();
        let mut batches = vec![];
        let mut batch = String::new();
        for summary in summaries {
            if !batch.is_empty()
                && batch.chars().count() + summary.chars().count()
                    > crate::config::ATTACHMENT_CHUNK_CHARS
            {
                batches.push(std::mem::take(&mut batch));
            }
            batch.push_str(&summary);
            batch.push('\n');
        }
        if !batch.is_empty() {
            batches.push(batch);
        }
        summaries = vec![];
        for batch in batches {
            queue::renew(db, job).await.c(h!())?;
            let (summary, _) =
                crate::media_summary::worker::summarize_attachment_text(
                    &env.ai_engine_client,
                    &engine,
                    &batch,
                )
                .await
                .c(h!())?;
            summaries.push(summary);
        }
        anyhow::ensure!(
            summaries.len() < previous,
            "summary reduction exceeded chunk budget"
        );
    }
    let tx = db.begin().await.c(h!())?;
    queue::renew(&tx, job).await.c(h!())?;
    execute(&tx,"update file_document_generation set summary=$2,summary_state='completed' where id=$1",vec![job.generation.into(),summaries.pop().unwrap_or_default().into()]).await.c(h!())?;
    tx.commit().await.c(h!())?;
    Ok(true)
}

pub(super) async fn positions(
    env: &Env,
    job: &Job,
    id: Option<&str>,
) -> anyhow::Result<bool> {
    let Some(engine) = engine(env, id).await.c(h!())? else {
        return Ok(false);
    };
    let db = env.file_registry_db().c(h!())?.connection();
    let chunk=rows::<Chunk,_>(db,"select id,text from file_document_chunk where generation=$1 and not positions_done order by ordinal limit 1",vec![job.generation.into()]).await.c(h!())?.pop();
    let Some(chunk) = chunk else {
        let tx = db.begin().await.c(h!())?;
        queue::renew(&tx, job).await.c(h!())?;
        execute(&tx,"update file_document_generation set position_state='completed' where id=$1",vec![job.generation.into()]).await.c(h!())?;
        tx.commit().await.c(h!())?;
        return Ok(true);
    };
    let settings = crate::ai_position::settings(&env.dbx).await.c(h!())?;
    let extraction = crate::ai_position::extract::extract(
        &env.ai_engine_client,
        &engine,
        crate::ai_position::effective_prompt(
            settings
                .as_ref()
                .map(|s| s.prompt.as_str())
                .unwrap_or_default(),
        ),
        &chunk.text,
        &[],
    )
    .await
    .c(h!())?;
    let tx = db.begin().await.c(h!())?;
    queue::renew(&tx, job).await.c(h!())?;
    for position in extraction.positions {
        execute(&tx,"insert into file_document_position(id,chunk_id,name,name_key,kind,spans,coordinates) values($1,$2,$3,$4,$5,$6,$7) on conflict(chunk_id,name_key,kind) do update set spans=excluded.spans,coordinates=excluded.coordinates",
            vec![Uuid::now_v7().into(),chunk.id.into(),position.name.into(),position.name_key.into(),position.kind.into(),serde_json::to_value(position.spans).c(h!())?.into(),serde_json::to_value(position.coordinates).c(h!())?.into()]).await.c(h!())?;
    }
    execute(
        &tx,
        "update file_document_chunk set positions_done=true where id=$1",
        vec![chunk.id.into()],
    )
    .await
    .c(h!())?;
    tx.commit().await.c(h!())?;
    Ok(false)
}
