use super::{
    search::{bind, check_text, cite, literal, COLUMNS, JOINS},
    types::*,
};
use crate::{
    attachments::{store::rows, types::AttachmentSection},
    config::*,
    h,
    types::{Env, ShortContext},
};
use sea_orm::{ConnectionTrait, FromQueryResult};
use uuid::Uuid;

pub(crate) async fn read(
    env: &Env,
    req: &DeviceDocumentReadReq,
) -> anyhow::Result<DeviceDocumentReadRsp> {
    let db = env.file_registry_db().c(h!())?.connection();
    let file = Uuid::parse_str(&req.file_id).c(h!())?;
    let device = Uuid::parse_str(&req.device_id).c(h!())?;
    let mut document = rows::<DeviceDocumentItem,_>(db,&format!("select {COLUMNS} from file_revision src {JOINS} where src.device_id=$1 and src.id=$2 and src.revision=$3"),vec![device.into(),file.into(),req.revision.into()]).await.c(h!())?.pop().ok_or(crate::error::AppError::NotFound).c(h!())?;
    let generation = req
        .extraction_revision
        .as_deref()
        .or(document.extraction_revision.as_deref())
        .map(Uuid::parse_str)
        .transpose()
        .c(h!())?;
    let Some(generation) = generation else {
        cite(&mut document);
        return Ok(DeviceDocumentReadRsp {
            document,
            sections: vec![],
            next_after: None,
            warnings: vec![],
            coordinates: vec![],
            positions: vec![],
        });
    };
    #[derive(FromQueryResult)]
    struct Generation {
        complete: bool,
        warnings: serde_json::Value,
        summary: Option<String>,
        summary_state: String,
        position_state: String,
    }
    let published = rows::<Generation,_>(db,"select g.complete,g.warnings,g.summary,g.summary_state,g.position_state from file_document_generation g where g.id=$1 and exists(select 1 from file_document_revision_generation d where d.file_id=$2 and d.revision=$3 and d.generation=g.id)",vec![generation.into(),file.into(),req.revision.into()]).await.c(h!())?.pop().ok_or(crate::error::AppError::NotFound).c(h!())?;
    document.extraction_revision = Some(generation.to_string());
    document.complete = published.complete;
    document.summary = published.summary;
    document.summary_state = published.summary_state;
    document.position_state = published.position_state;
    cite(&mut document);
    let (sections, next_after) =
        read_sections(db, req, generation).await.c(h!())?;
    let (coordinates, positions) =
        section_evidence(db, &sections).await.c(h!())?;
    Ok(DeviceDocumentReadRsp {
        document,
        sections,
        next_after,
        warnings: serde_json::from_value(published.warnings).c(h!())?,
        coordinates,
        positions,
    })
}

async fn read_sections(
    db: &impl ConnectionTrait,
    req: &DeviceDocumentReadReq,
    generation: Uuid,
) -> anyhow::Result<(Vec<AttachmentSection>, Option<i32>)> {
    if req.limit == Some(0) {
        return Ok((vec![], None));
    }
    let mut values = vec![generation.into(), req.after.unwrap_or(-1).into()];
    let mut filter = "generation=$1 and ordinal>$2".to_string();
    if let Some(member) = &req.member {
        check_text(member).c(h!())?;
        filter += &format!(" and member={}", bind(&mut values, member.clone()));
    }
    if let Some(query) = &req.query {
        check_text(query).c(h!())?;
        let parameter = bind(&mut values, format!("%{}%", literal(query)));
        filter+=&format!(" and (text ilike {parameter} escape '\\' or locator ilike {parameter} escape '\\')");
    }
    let limit = req
        .limit
        .unwrap_or(DEVICE_DOCUMENT_READ_LIMIT)
        .clamp(0, DEVICE_DOCUMENT_READ_MAX_LIMIT);
    let bound = bind(&mut values, limit + 1);
    let mut sections=rows::<AttachmentSection,_>(db,&format!("select id::text,ordinal,member,locator,text,markdown,html,summary from file_document_chunk where {filter} order by ordinal limit {bound}"),values).await.c(h!())?;
    let more = sections.len() > limit as usize;
    sections.truncate(limit as usize);
    let next_after = more.then(|| sections.last().map_or(-1, |s| s.ordinal));
    Ok((sections, next_after))
}

async fn section_evidence(
    db: &impl ConnectionTrait,
    sections: &[AttachmentSection],
) -> anyhow::Result<(
    Vec<crate::media_summary::types::MediaSummaryCoordinate>,
    Vec<crate::ai_position::types::AiPositionFound>,
)> {
    if sections.is_empty() {
        return Ok((vec![], vec![]));
    }
    let ids = sections
        .iter()
        .map(|s| Uuid::parse_str(&s.id))
        .collect::<Result<Vec<_>, _>>()
        .c(h!())?;
    #[derive(FromQueryResult)]
    struct Data {
        coordinates: serde_json::Value,
    }
    let coordinate_rows = rows::<Data, _>(
        db,
        "select coordinates from file_document_chunk where id=any($1)",
        vec![ids.clone().into()],
    )
    .await
    .c(h!())?;
    let mut coordinates = vec![];
    for row in coordinate_rows {
        coordinates.extend(
            serde_json::from_value::<
                Vec<crate::media_summary::types::MediaSummaryCoordinate>,
            >(row.coordinates)
            .c(h!())?,
        );
    }
    let position_rows=rows::<super::positions::PositionRow,_>(db,"select name,name_key,kind,spans,coordinates from file_document_position where chunk_id=any($1) order by id",vec![ids.into()]).await.c(h!())?;
    let positions = position_rows
        .into_iter()
        .map(super::positions::PositionRow::decode)
        .collect::<anyhow::Result<_>>()
        .c(h!())?;
    Ok((coordinates, positions))
}
