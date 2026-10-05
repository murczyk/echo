use super::{
    store::*,
    worker::{Job, Package, Section},
};
use crate::{
    entities::{
        ai_engine, attachment_chunk, attachment_document, signal_message_media,
    },
    h,
    types::{Env, ShortContext},
};
use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, QueryOrder,
    TransactionTrait,
};
use uuid::Uuid;

pub async fn renew<C: ConnectionTrait>(
    db: &C,
    job: &Job,
) -> anyhow::Result<()> {
    #[derive(FromQueryResult)]
    struct Current {
        media_id: Uuid,
    }
    use sea_orm::FromQueryResult;
    let current = rows::<Current,_>(db,"select media_id from attachment_document where media_id=$1 and generation=$2 for share",vec![job.media_id.into(),job.generation.into()]).await.c(h!())?.pop();
    anyhow::ensure!(
        current.is_some_and(|current| current.media_id == job.media_id),
        "attachment source changed"
    );
    let count=execute(db,"update attachment_job set lease_until=(now() at time zone 'utc')+interval '15 minutes' where id=$1 and lease=$2 and lease_until>now() at time zone 'utc' and exists(select 1 from attachment_document where media_id=$3 and generation=$4)",vec![job.id.into(),job.lease.into(),job.media_id.into(),job.generation.into()]).await.c(h!())?;
    anyhow::ensure!(count == 1, "attachment job lease lost");
    Ok(())
}

async fn engine(
    env: &Env,
    id: Option<Uuid>,
) -> anyhow::Result<Option<ai_engine::Model>> {
    let Some(id) = id else {
        return Ok(None);
    };
    ai_engine::Entity::find_by_id(id)
        .filter(ai_engine::Column::Enabled.eq(true))
        .one(&env.dbx)
        .await
        .c(h!())
}

pub async fn summarize(
    env: &Env,
    job: &Job,
    engine_id: Option<Uuid>,
) -> anyhow::Result<bool> {
    let Some(engine) = engine(env, engine_id).await.c(h!())? else {
        return Ok(false);
    };
    let document = attachment_document::Entity::find_by_id(job.media_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .c(h!())?;
    let Some(revision) = document.revision else {
        return Ok(false);
    };
    let chunk = attachment_chunk::Entity::find()
        .filter(attachment_chunk::Column::MediaId.eq(job.media_id))
        .filter(attachment_chunk::Column::Revision.eq(revision))
        .filter(attachment_chunk::Column::Summary.is_null())
        .order_by_asc(attachment_chunk::Column::Ordinal)
        .one(&env.dbx)
        .await
        .c(h!())?;
    if let Some(chunk) = chunk {
        let (summary, _) =
            crate::media_summary::worker::summarize_attachment_text(
                &engine,
                &chunk.text,
            )
            .await
            .c(h!())?;
        let tx = env.dbx.begin().await.c(h!())?;
        renew(&tx, job).await.c(h!())?;
        execute(
            &tx,
            "update attachment_chunk set summary=$2 where id=$1",
            vec![chunk.id.into(), summary.into()],
        )
        .await
        .c(h!())?;
        tx.commit().await.c(h!())?;
        return Ok(false);
    }
    let chunks = attachment_chunk::Entity::find()
        .filter(attachment_chunk::Column::MediaId.eq(job.media_id))
        .filter(attachment_chunk::Column::Revision.eq(revision))
        .order_by_asc(attachment_chunk::Column::Ordinal)
        .all(&env.dbx)
        .await
        .c(h!())?;
    if chunks.is_empty() {
        let tx = env.dbx.begin().await.c(h!())?;
        renew(&tx, job).await.c(h!())?;
        execute(&tx,"update attachment_document set summary_state='completed' where media_id=$1 and generation=$2",vec![job.media_id.into(),job.generation.into()]).await.c(h!())?;
        tx.commit().await.c(h!())?;
        return Ok(true);
    }
    let mut summaries: Vec<String> = chunks
        .iter()
        .filter_map(|c| {
            c.summary
                .as_ref()
                .map(|s| format!("{} — {}: {s}", c.member, c.locator))
        })
        .collect();
    while summaries.len() > 1 {
        let mut next = Vec::new();
        let mut batch = String::new();
        for summary in summaries {
            if !batch.is_empty()
                && batch.chars().count() + summary.chars().count()
                    > crate::config::ATTACHMENT_CHUNK_CHARS
            {
                renew(&env.dbx, job).await.c(h!())?;
                next.push(
                    crate::media_summary::worker::summarize_attachment_text(
                        &engine, &batch,
                    )
                    .await
                    .c(h!())?
                    .0,
                );
                batch.clear();
            }
            batch.push_str(&summary);
            batch.push('\n');
        }
        if !batch.is_empty() {
            renew(&env.dbx, job).await.c(h!())?;
            next.push(
                crate::media_summary::worker::summarize_attachment_text(
                    &engine, &batch,
                )
                .await
                .c(h!())?
                .0,
            );
        }
        summaries = next;
    }
    let summary = summaries.pop().unwrap_or_default();
    let coordinates: Vec<_> = chunks
        .iter()
        .flat_map(|c| c.coordinates.as_array().cloned().unwrap_or_default())
        .take(crate::config::MEDIA_SUMMARY_COORDINATES_MAX_COUNT)
        .collect();
    let tx = env.dbx.begin().await.c(h!())?;
    renew(&tx, job).await.c(h!())?;
    execute(&tx,"update attachment_document set summary=$3,summary_state='completed',updated_at=now() at time zone 'utc' where media_id=$1 and generation=$2",vec![job.media_id.into(),job.generation.into(),summary.clone().into()]).await.c(h!())?;
    execute(&tx,"insert into media_summary(media_id,source_kind,source_digest,source_char_count,state,ai_engine_id,ai_engine_name,model_name,summary,coordinates,completed_at)
      values($1,'attachment_text',$2,$3,'completed',$4,$5,$6,$7,$8,now() at time zone 'utc')
      on conflict(media_id) do update set source_kind=excluded.source_kind,source_digest=excluded.source_digest,source_char_count=excluded.source_char_count,
      state=excluded.state,ai_engine_id=excluded.ai_engine_id,ai_engine_name=excluded.ai_engine_name,model_name=excluded.model_name,
      summary=excluded.summary,coordinates=excluded.coordinates,completed_at=excluded.completed_at,source_text=null,lease_expires_at=null",
      vec![job.media_id.into(),sha256::digest(revision.as_bytes()).into(),(chunks.iter().map(|c|c.text.chars().count()).sum::<usize>() as i32).into(),engine.id.into(),engine.name.into(),engine.model_name.into(),summary.into(),serde_json::json!(coordinates).into()]).await.c(h!())?;
    tx.commit().await.c(h!())?;
    Ok(true)
}

pub async fn positions(
    env: &Env,
    job: &Job,
    engine_id: Option<Uuid>,
) -> anyhow::Result<bool> {
    let Some(engine) = engine(env, engine_id).await.c(h!())? else {
        return Ok(false);
    };
    let chunk = attachment_chunk::Entity::find()
        .filter(attachment_chunk::Column::MediaId.eq(job.media_id))
        .filter(attachment_chunk::Column::PositionsDone.eq(false))
        .order_by_asc(attachment_chunk::Column::Ordinal)
        .one(&env.dbx)
        .await
        .c(h!())?;
    if let Some(chunk) = chunk {
        crate::ai_position::worker::extract_attachment_chunk(
            env, job, chunk.id, engine,
        )
        .await
        .c(h!())?;
        return Ok(false);
    }
    let tx = env.dbx.begin().await.c(h!())?;
    renew(&tx, job).await.c(h!())?;
    execute(&tx,"delete from ai_position_mention where media_id=$1 and attachment_chunk_id is null",vec![job.media_id.into()]).await.c(h!())?;
    execute(&tx,"update attachment_document set position_state='completed',updated_at=now() at time zone 'utc' where media_id=$1 and generation=$2",vec![job.media_id.into(),job.generation.into()]).await.c(h!())?;
    tx.commit().await.c(h!())?;
    Ok(true)
}

pub async fn coordinates(
    text: &str,
    locator: &str,
) -> anyhow::Result<serde_json::Value> {
    let parsed =
        milgeo_rs::coordinates::parser_v2::collect_coords(text).c(h!())?;
    let mut seen = std::collections::HashSet::new();
    let coords=parsed.mgrs_coords.into_iter().chain(parsed.decimal_coords).chain(parsed.usk2000_coords)
        .filter(|c|seen.insert(c.mgrs.clone())).map(|c|serde_json::json!({"title":locator,"description":c.capture,"plannedMeans":null,"coordinateSystem":"mgrs","value":c.mgrs})).collect::<Vec<_>>();
    Ok(serde_json::json!(coords))
}

pub async fn extract_map(
    env: &Env,
    job: &Job,
    media: &signal_message_media::Model,
    name: &str,
) -> anyhow::Result<bool> {
    use crate::entities::signal_message_media_conversion_job;
    use md5::{Digest, Md5};
    let conversion = signal_message_media_conversion_job::Entity::find()
        .filter(
            signal_message_media_conversion_job::Column::SourceMediaId
                .eq(media.id),
        )
        .one(&env.dbx)
        .await
        .c(h!())?;
    let Some(conversion) = conversion else {
        let bytes = super::worker::source_bytes(env, media).await.c(h!())?;
        execute(&env.dbx,"insert into signal_message_media_conversion_job(signal_message_id,source_media_id,source_file_md5,source_file_name,source_content_type,status) values($1,$2,$3,$4,$5,'pending') on conflict(source_media_id) do nothing",vec![media.signal_message_id.into(),media.id.into(),format!("{:x}",Md5::digest(&bytes)).into(),name.into(),media.content_type.clone().into()]).await.c(h!())?;
        return Ok(false);
    };
    anyhow::ensure!(
        conversion.status
            != crate::config::SIGINT_MEDIA_CONVERSION_STATUS_ERROR,
        "map conversion failed; retry map conversion first"
    );
    if conversion.status != crate::config::SIGINT_MEDIA_CONVERSION_STATUS_DONE {
        return Ok(false);
    }
    let bytes = crate::sigint::media_conversion::fetch_completed_result_bytes(
        env,
        media,
        conversion.converted_storage_key.as_deref(),
    )
    .await
    .c(h!())?;
    let parsed = crate::palitra::kmz::parse_coordinates_from_file(
        "converted.kmz",
        &bytes,
    )
    .await
    .c(h!())?;
    let mut package = Package {
        complete: true,
        ..Default::default()
    };
    for (index, point) in parsed.points.iter().enumerate() {
        let text = serde_json::to_string(point).c(h!())?;
        package.sections.push(Section {
            member: name.into(),
            locator: format!("point {}", index + 1),
            text: text.clone(),
            markdown: text.clone(),
            html: format!(
                "<p>{}</p>",
                text.replace('&', "&amp;").replace('<', "&lt;")
            ),
        });
    }
    super::worker::publish(env, job, package, bytes)
        .await
        .c(h!())?;
    Ok(true)
}

pub async fn requeue_positions(
    db: &sea_orm::DatabaseConnection,
    id: Uuid,
) -> anyhow::Result<bool> {
    use sea_orm::QuerySelect;
    let tx = db.begin().await.c(h!())?;
    let Some(document) = attachment_document::Entity::find_by_id(id)
        .lock_exclusive()
        .one(&tx)
        .await
        .c(h!())?
    else {
        return Ok(false);
    };
    if document.revision.is_none() {
        return Ok(false);
    }
    execute(&tx,"update attachment_document set position_state='queued' where media_id=$1",vec![id.into()]).await.c(h!())?;
    execute(
        &tx,
        "update attachment_chunk set positions_done=false where media_id=$1",
        vec![id.into()],
    )
    .await
    .c(h!())?;
    queue(&tx, id, document.generation, "positions")
        .await
        .c(h!())?;
    execute(&tx,"update attachment_job set state='queued',attempts=0,lease=null,lease_until=null,next_attempt_at=now() at time zone 'utc',last_error=null where media_id=$1 and generation=$2 and kind='positions'",vec![id.into(),document.generation.into()]).await.c(h!())?;
    tx.commit().await.c(h!())?;
    Ok(true)
}
