use super::store::*;
use crate::{
    entities::{signal_message_audio_ref, signal_message_media},
    file_registry::entities::device_audio,
    h,
    transcriber::media_queue::{media_eligibility, MediaEligibility},
    types::ShortContext,
};
use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, FromQueryResult, QueryFilter,
    QueryOrder, QuerySelect,
};
use std::collections::HashSet;
use uuid::Uuid;
type Binding = (Uuid, Option<String>, Option<Uuid>);

#[derive(FromQueryResult)]
struct Source {
    id: Uuid,
    source_key: String,
    state: Option<String>,
    reprocess_count: Option<i32>,
    transcribed_value: Option<String>,
}
#[derive(Debug, PartialEq)]
pub(crate) struct Snapshot {
    signature: Vec<(
        Uuid,
        Option<Uuid>,
        Option<String>,
        Option<i32>,
        Option<String>,
    )>,
    pub(crate) transcript: String,
    pub(crate) ready: bool,
}

pub(crate) async fn load<C: ConnectionTrait, F: ConnectionTrait>(
    db: &C,
    files: Option<&F>,
    message: i64,
    lock: bool,
) -> anyhow::Result<Snapshot> {
    let bindings = bindings(db, files, message, lock).await.c(h!())?;
    let sources = sources(db, &bindings, lock).await.c(h!())?;
    Ok(assemble(bindings, sources))
}

async fn bindings<C: ConnectionTrait, F: ConnectionTrait>(
    db: &C,
    files: Option<&F>,
    message: i64,
    lock: bool,
) -> anyhow::Result<Vec<Binding>> {
    let media = signal_message_media::Entity::find()
        .filter(signal_message_media::Column::SignalMessageId.eq(message));
    let media = if lock { media.lock_shared() } else { media };
    let media = media
        .order_by_asc(signal_message_media::Column::Id)
        .all(db)
        .await
        .c(h!())?;
    let references = signal_message_audio_ref::Entity::find()
        .filter(signal_message_audio_ref::Column::SignalMessageId.eq(message));
    let references = if lock {
        references.lock_shared()
    } else {
        references
    };
    let references = references
        .order_by_asc(signal_message_audio_ref::Column::Id)
        .all(db)
        .await
        .c(h!())?;
    let oversized = oversized_references(files, &references).await.c(h!())?;
    let mut bindings: Vec<_> = media
        .iter()
        .filter(|media| media_eligibility(media) == MediaEligibility::Eligible)
        .map(|media| {
            (
                media.id,
                Some(crate::transcriber::media_queue::source_key(media)),
                None,
            )
        })
        .collect();
    bindings.extend(
        references
            .into_iter()
            .filter(|reference| !oversized.contains(&reference.audio_id))
            .map(|reference| {
                (reference.id, None, Some(reference.transcription_source_id))
            }),
    );
    bindings.sort_by_key(|binding| binding.0);
    Ok(bindings)
}

async fn oversized_references<F: ConnectionTrait>(
    files: Option<&F>,
    references: &[signal_message_audio_ref::Model],
) -> anyhow::Result<HashSet<Uuid>> {
    if references.is_empty() {
        return Ok(HashSet::new());
    }
    Ok(device_audio::Entity::find()
        .select_only()
        .column(device_audio::Column::Id)
        .filter(
            device_audio::Column::Id
                .is_in(references.iter().map(|reference| reference.audio_id)),
        )
        .filter(
            device_audio::Column::SourceSizeBytes
                .gt(crate::config::ECHO_AUDIO_TRANSCRIPTION_MAX_BYTES),
        )
        .into_tuple::<Uuid>()
        .all(files.c(h!())?)
        .await
        .c(h!())?
        .into_iter()
        .collect())
}

async fn sources<C: ConnectionTrait>(
    db: &C,
    bindings: &[Binding],
    lock: bool,
) -> anyhow::Result<Vec<Source>> {
    let keys: Vec<String> = bindings
        .iter()
        .filter_map(|binding| binding.1.clone())
        .collect();
    let ids: Vec<Uuid> =
        bindings.iter().filter_map(|binding| binding.2).collect();
    if lock {
        db.query_all_raw(sql("select queue.source_id from echo_gpu_transcription_queue queue join transcription_source source on source.id=queue.source_id where source.source_key=any($1) or source.id=any($2) order by queue.source_id for share of queue", vec![keys.clone().into(),ids.clone().into()])).await.c(h!())?;
    }
    let sources = rows::<Source,_>(db, "select source.id,source.source_key,queue.state,queue.reprocess_count,queue.transcribed_value from transcription_source source left join echo_gpu_transcription_queue queue on queue.source_id=source.id where source.source_key=any($1) or source.id=any($2)", vec![keys.into(),ids.into()]).await.c(h!())?;
    Ok(sources)
}

fn assemble(bindings: Vec<Binding>, sources: Vec<Source>) -> Snapshot {
    let mut signature = Vec::new();
    let mut texts = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut ready = true;
    for (id, key, source_id) in bindings {
        let source = sources.iter().find(|source| {
            Some(source.id) == source_id
                || key.as_deref() == Some(source.source_key.as_str())
        });
        signature.push((
            id,
            source.map(|source| source.id),
            source.and_then(|source| source.state.clone()),
            source.and_then(|source| source.reprocess_count),
            source.and_then(|source| source.transcribed_value.clone()),
        ));
        if let Some(source) = source {
            match source.state.as_deref() {
                Some("completed") => {
                    if seen.insert(source.id) {
                        if let Some(text) = source
                            .transcribed_value
                            .as_deref()
                            .filter(|text| !text.trim().is_empty())
                        {
                            texts.push(text.to_string());
                        }
                    }
                }
                Some("terminal") => (),
                _ => ready = false,
            }
        } else {
            ready = false;
        }
    }
    Snapshot {
        signature,
        transcript: texts.join("\n\n"),
        ready,
    }
}
