use super::{store::rows, types::AttachmentCoordinateStatus};
use crate::{
    entities::signal_message_media, h,
    media_summary::types::MediaSummaryCoordinate, types::ShortContext,
};
use sea_orm::{ConnectionTrait, FromQueryResult};
use std::collections::HashMap;
use uuid::Uuid;

pub async fn load_statuses<C: ConnectionTrait>(
    db: &C,
    media: &[signal_message_media::Model],
) -> anyhow::Result<HashMap<Uuid, AttachmentCoordinateStatus>> {
    #[derive(FromQueryResult)]
    struct Status {
        media_id: Uuid,
        revision: String,
        has_coordinates: bool,
    }
    if media.is_empty() {
        return Ok(HashMap::new());
    }
    let ids: Vec<_> = media.iter().map(|media| media.id).collect();
    let statuses = rows::<Status, _>(db,
        "select doc.media_id, doc.revision::text as revision,
         exists(select 1 from attachment_chunk chunk where chunk.media_id=doc.media_id
           and chunk.revision=doc.revision and chunk.coordinates<>'[]'::jsonb) as has_coordinates
         from attachment_document doc where doc.media_id=any($1) and doc.revision is not null",
        vec![ids.into()]).await.c(h!())?;
    Ok(statuses
        .into_iter()
        .map(|status| {
            (
                status.media_id,
                AttachmentCoordinateStatus {
                    revision: status.revision,
                    has_coordinates: status.has_coordinates,
                },
            )
        })
        .collect())
}

pub async fn read<C: ConnectionTrait>(
    db: &C,
    media_id: Uuid,
) -> anyhow::Result<Option<Vec<MediaSummaryCoordinate>>> {
    #[derive(FromQueryResult)]
    struct Coordinates {
        coordinates: serde_json::Value,
    }
    let current = rows::<Coordinates, _>(db,
        "select coalesce((select jsonb_agg(point order by chunk.ordinal, point_index)
          from attachment_chunk chunk cross join lateral
          jsonb_array_elements(chunk.coordinates) with ordinality as points(point, point_index)
          where chunk.media_id=doc.media_id and chunk.revision=doc.revision), '[]'::jsonb) as coordinates
         from attachment_document doc where doc.media_id=$1 and doc.revision is not null",
        vec![media_id.into()]).await.c(h!())?.pop();
    current
        .map(|current| {
            crate::media_summary::decode_coordinates(current.coordinates)
        })
        .transpose()
        .c(h!())
}
