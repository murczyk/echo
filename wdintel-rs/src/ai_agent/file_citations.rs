use crate::{
    devices::documents::{access, types::AiAgentFileCitation},
    entities::ai_agent_request_event,
    h,
    types::{Env, ShortContext},
};
use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::Value;
use std::collections::HashMap;
use uuid::Uuid;

pub(super) fn parse(value: &Value) -> Option<Vec<AiAgentFileCitation>> {
    let sources: Vec<AiAgentFileCitation> =
        serde_json::from_value(value.get("citations")?.clone()).ok()?;
    (sources.len() <= 100
        && sources.iter().all(|s| {
            Uuid::parse_str(&s.device_id).is_ok()
                && Uuid::parse_str(&s.file_id).is_ok()
                && s.revision > 0
                && s.revision <= 9_007_199_254_740_991
                && s.extraction_revision
                    .as_ref()
                    .is_none_or(|r| Uuid::parse_str(r).is_ok())
                && s.section
                    .is_none_or(|n| n >= 0 && s.extraction_revision.is_some())
        }))
    .then_some(sources)
}

pub(super) async fn load(
    db: &impl ConnectionTrait,
    ids: &[Uuid],
) -> anyhow::Result<HashMap<Uuid, Vec<AiAgentFileCitation>>> {
    let mut result: HashMap<Uuid, Vec<AiAgentFileCitation>> = HashMap::new();
    if ids.is_empty() {
        return Ok(result);
    }
    let events = ai_agent_request_event::Entity::find()
        .select_only()
        .column(ai_agent_request_event::Column::RequestId)
        .column(ai_agent_request_event::Column::Payload)
        .filter(
            ai_agent_request_event::Column::RequestId
                .is_in(ids.iter().copied()),
        )
        .filter(ai_agent_request_event::Column::EventType.eq("file_citations"))
        .order_by_asc(ai_agent_request_event::Column::Sequence)
        .into_tuple::<(Uuid, Value)>()
        .all(db)
        .await
        .c(h!())?;
    for (id, payload) in events {
        for source in parse(&payload).unwrap_or_default() {
            let sources = result.entry(id).or_default();
            if !sources.contains(&source) {
                sources.push(source);
            }
        }
    }
    Ok(result)
}

pub(crate) async fn readable(
    env: &Env,
    human: Uuid,
    sources: &[AiAgentFileCitation],
) -> anyhow::Result<bool> {
    if sources.is_empty() {
        return Ok(true);
    }
    if env.file_registry_db().is_err() {
        return Ok(false);
    }
    let login = match access::reader(env, human).await {
        Ok(login) => login,
        Err(
            crate::error::AppError::Forbidden(_)
            | crate::error::AppError::Unauthenticated,
        ) => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    let allowed = access::visible_ids(env, &login, true).await.c(h!())?;
    if !sources.iter().all(|s| {
        Uuid::parse_str(&s.device_id).is_ok_and(|id| allowed.contains(&id))
    }) {
        return Ok(false);
    }
    #[derive(sea_orm::FromQueryResult)]
    struct Readable {
        readable: bool,
    }
    let result=crate::attachments::store::rows::<Readable,_>(env.file_registry_db().c(h!())?.connection(),r#"
      select not exists(
        select 1 from jsonb_to_recordset($1) as citation("deviceId" uuid,"fileId" uuid,revision bigint,"extractionRevision" uuid,section integer)
        where not exists(select 1 from file_revision r where r.origin_archive_id is null and r.device_id=citation."deviceId" and r.id=citation."fileId" and r.revision=citation.revision
          and (citation."extractionRevision" is null or exists(
            select 1 from file_document_revision_generation binding where binding.file_id=r.id and binding.revision=r.revision and binding.generation=citation."extractionRevision"
              and (citation.section is null or exists(select 1 from file_document_chunk c where c.generation=binding.generation and c.ordinal=citation.section))
          ))
        )
      ) as readable"#,vec![serde_json::to_value(sources).c(h!())?.into()]).await.c(h!())?;
    Ok(result.first().is_some_and(|row| row.readable))
}
