use super::{
    access,
    search::{bind, literal},
    types::AiAgentFileCitation,
};
use crate::{
    ai_position::types::{AiPositionFound, AiPositionLookupReq},
    attachments::store::rows,
    h,
    types::{Env, ShortContext},
};
use elm_rs::{Elm, ElmDecode, ElmEncode};
use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, FromQueryResult, QueryFilter,
    QuerySelect, QueryTrait, TransactionTrait,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(FromQueryResult)]
pub(super) struct PositionRow {
    pub name: String,
    pub name_key: String,
    pub kind: String,
    pub spans: serde_json::Value,
    pub coordinates: serde_json::Value,
}

impl PositionRow {
    pub(super) fn decode(self) -> anyhow::Result<AiPositionFound> {
        Ok(AiPositionFound {
            name: self.name,
            name_key: self.name_key,
            kind: self.kind,
            spans: serde_json::from_value(self.spans).c(h!())?,
            coordinates: serde_json::from_value(self.coordinates).c(h!())?,
        })
    }
}

#[derive(
    Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode, PartialEq,
)]
#[serde(rename_all = "camelCase")]
pub struct DevicePositionEvidence {
    pub position: AiPositionFound,
    pub source: AiAgentFileCitation,
    pub citation: String,
    pub file_name: String,
    pub locator: String,
    pub context: String,
    pub aor_ids: Vec<i64>,
    pub observation_at: Option<String>,
}

pub(crate) async fn lookup(
    env: &Env,
    login_id: Uuid,
    req: &AiPositionLookupReq,
) -> anyhow::Result<Vec<DevicePositionEvidence>> {
    if env.file_registry_db().is_err() {
        return Ok(vec![]);
    }
    let login = match access::reader(env, login_id).await {
        Ok(login) => login,
        Err(
            crate::error::AppError::Forbidden(_)
            | crate::error::AppError::Unauthenticated,
        ) => return Ok(vec![]),
        Err(error) => return Err(error.into()),
    };
    let devices = access::visible_ids(env, &login, false).await.c(h!())?;
    if devices.is_empty() {
        return Ok(vec![]);
    }
    let mut values = vec![devices.clone().into()];
    let mut filters = vec!["d.device_id=any($1)".to_string()];
    if let Some(name) = req.name.as_deref().filter(|n| !n.trim().is_empty()) {
        super::search::check_text(name).c(h!())?;
        filters.push(format!(
            "p.name_key ilike {} escape '\\'",
            bind(
                &mut values,
                format!(
                    "%{}%",
                    literal(&crate::ai_position::normalize::position_key(name))
                )
            )
        ));
    }
    if let Some(kind) = &req.kind {
        filters.push(format!("p.kind={}", bind(&mut values, kind.clone())));
    }
    if let Some(coordinates) =
        req.coordinates.as_deref().filter(|s| !s.trim().is_empty())
    {
        let near = vec![crate::ai_position::types::AiPositionColumnFilter {
            id: "near".into(),
            value: format!(
                "{coordinates}|{}",
                req.radius_meters
                    .unwrap_or(crate::config::AI_POSITION_NEAR_DEFAULT_METERS)
            ),
        }];
        let near = crate::ai_position::list::resolve_near_filters(near)
            .await
            .c(h!())?;
        let predicate = crate::ai_position::list::near_condition(
            "(coordinate->>'lat')::double precision",
            "(coordinate->>'lng')::double precision",
            &near[0].value,
            &mut values,
        )
        .c(h!())?;
        filters.push(format!("exists(select 1 from jsonb_array_elements(p.coordinates) coordinate where {predicate})"));
    }
    let bound = bind(
        &mut values,
        req.limit
            .unwrap_or(crate::config::AI_POSITION_LOOKUP_MAX_ITEMS)
            .clamp(1, crate::config::AI_POSITION_LOOKUP_MAX_ITEMS),
    );
    #[derive(FromQueryResult)]
    struct Evidence {
        device_id: Uuid,
        file_id: Uuid,
        revision: i64,
        generation: Uuid,
        ordinal: i32,
        file_name: String,
        locator: String,
        context: String,
        name: String,
        name_key: String,
        kind: String,
        spans: serde_json::Value,
        coordinates: serde_json::Value,
    }
    let tx = env
        .file_registry_db()
        .c(h!())?
        .connection()
        .begin()
        .await
        .c(h!())?;
    tx.execute_unprepared(&format!(
        "set local statement_timeout='{}ms'",
        crate::config::DEVICE_DOCUMENT_QUERY_TIMEOUT_MS
    ))
    .await
    .c(h!())?;
    let evidence=rows::<Evidence,_>(&tx,&format!("select d.device_id,d.file_id,d.revision,c.generation,c.ordinal,r.name as file_name,c.locator,substring(c.text from greatest(1,coalesce((p.spans->0->>'begin')::integer,0)-400) for 2000) as context,p.name,p.name_key,p.kind,p.spans,p.coordinates from file_document_position p join file_document_chunk c on c.id=p.chunk_id join file_document d on d.published_generation=c.generation join file_entry r on r.id=d.file_id and r.revision=d.revision where {} order by p.id,d.file_id limit {bound}",filters.join(" and ")),values).await.c(h!())?;
    tx.commit().await.c(h!())?;
    let aors=crate::entities::device_aor::Entity::find().filter(crate::entities::device_aor::Column::DeviceId.is_in(devices)).filter(crate::entities::device_aor::Column::AorId.in_subquery(crate::entities::area_of_responsibility::Entity::find().select_only().column(crate::entities::area_of_responsibility::Column::Id).filter(crate::entities::area_of_responsibility::Column::Deleted.eq(false)).into_query())).all(&env.dbx).await.c(h!())?;
    evidence
        .into_iter()
        .map(|e| {
            let source = AiAgentFileCitation {
                device_id: e.device_id.to_string(),
                file_id: e.file_id.to_string(),
                revision: e.revision,
                extraction_revision: Some(e.generation.to_string()),
                section: Some(e.ordinal),
            };
            Ok(DevicePositionEvidence {
                citation: source.href(),
                source,
                file_name: e.file_name,
                locator: e.locator,
                context: e.context,
                aor_ids: aors
                    .iter()
                    .filter(|a| a.device_id == e.device_id)
                    .map(|a| a.aor_id)
                    .collect(),
                observation_at: None,
                position: PositionRow {
                    name: e.name,
                    name_key: e.name_key,
                    kind: e.kind,
                    spans: e.spans,
                    coordinates: e.coordinates,
                }
                .decode()
                .c(h!())?,
            })
        })
        .collect()
}
