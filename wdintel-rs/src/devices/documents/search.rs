use super::types::*;
use crate::{
    attachments::store::rows,
    config::*,
    h,
    types::{Env, ShortContext},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sea_orm::{ConnectionTrait, TransactionTrait, Value};
use uuid::Uuid;

pub(super) const COLUMNS: &str = "src.device_id::text as device_id,src.id::text as file_id,src.revision,
 src.name as file_name,src.absolute_path as path,src.extension as format,
 (extract(epoch from src.file_metadata_modified_at)*1000)::bigint as modified_at,
 (entry.revision=src.revision) as current,content.file_id is not null as has_content,
 coalesce(doc.state,case when content.file_id is null then 'content_unavailable' else 'queued' end) as state,gen.id::text as extraction_revision,
 coalesce(gen.complete,false) as complete,gen.summary,
 coalesce(gen.summary_state,'pending') as summary_state,
 coalesce(gen.position_state,'pending') as position_state,null::text as snippet,''::text as citation";

pub(super) const JOINS: &str = "join file_entry entry on entry.id=src.id
 left join file_content content on content.file_id=src.id and content.revision=src.revision
 left join file_document doc on doc.file_id=src.id and doc.revision=src.revision
 left join file_document_generation gen on gen.id=doc.published_generation";

pub(super) fn bind(values: &mut Vec<Value>, value: impl Into<Value>) -> String {
    values.push(value.into());
    format!("${}", values.len())
}

pub(super) fn literal(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

pub(super) fn check_text(value: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        value.chars().count() <= DEVICE_DOCUMENT_QUERY_MAX_CHARS,
        "search text too long"
    );
    Ok(())
}

pub(super) fn cite(item: &mut DeviceDocumentItem) {
    item.citation = AiAgentFileCitation {
        device_id: item.device_id.clone(),
        file_id: item.file_id.clone(),
        revision: item.revision,
        extraction_revision: item.extraction_revision.clone(),
        section: None,
    }
    .href();
}

pub(crate) async fn search(
    env: &Env,
    req: &DeviceDocumentSearchReq,
    mut allowed: Vec<Uuid>,
) -> anyhow::Result<DeviceDocumentSearchRsp> {
    if let Some(ids) = &req.device_ids {
        anyhow::ensure!(ids.len() <= 128, "too many devices");
        let ids = ids
            .iter()
            .map(|id| Uuid::parse_str(id))
            .collect::<Result<Vec<_>, _>>()
            .c(h!())?;
        allowed.retain(|id| ids.contains(id));
    }
    if allowed.is_empty() {
        return Ok(DeviceDocumentSearchRsp {
            documents: vec![],
            next_cursor: None,
        });
    }
    let mut values = vec![Value::from(allowed)];
    let mut filters = vec!["src.device_id=any($1)".to_string()];
    let history = req.history.unwrap_or(false);
    if !history {
        filters.push("src.kind='file'".into());
        filters.push("src.parent_id is not null".into());
    }
    let table = if history {
        "file_revision"
    } else {
        "file_entry"
    };
    let mut matches = search_matches(req, &mut values).c(h!())?;
    metadata_filters(req, &mut values, &mut filters).c(h!())?;
    let limit = req
        .limit
        .unwrap_or(DEVICE_DOCUMENT_SEARCH_LIMIT)
        .clamp(1, DEVICE_DOCUMENT_SEARCH_MAX_LIMIT);
    let bound = bind(&mut values, limit + 1);
    let db = env.file_registry_db().c(h!())?.connection();
    let tx = db.begin().await.c(h!())?;
    tx.execute_unprepared(&format!(
        "set local statement_timeout='{DEVICE_DOCUMENT_QUERY_TIMEOUT_MS}ms'"
    ))
    .await
    .c(h!())?;
    if matches.is_empty() {
        matches.push(("", "true".into()));
    }
    let candidates = matches.into_iter().map(|(joins, predicate)| {
        let select = format!("select src.id,src.revision from {table} src {joins} where {} and ({predicate})", filters.join(" and "));
        if predicate == "true" {
            format!("({select} order by src.id desc,src.revision desc limit {bound})")
        } else {
            filtered_candidates(&select, &bound)
        }
    }).collect::<Vec<_>>().join(" union ");
    let sql=format!("with candidates as ({candidates}) select {COLUMNS} from candidates matched join {table} src on src.id=matched.id and src.revision=matched.revision {JOINS} order by src.id desc,src.revision desc limit {bound}");
    let mut documents = rows::<DeviceDocumentItem, _>(&tx, &sql, values)
        .await
        .c(h!())?;
    let more = documents.len() > limit as usize;
    documents.truncate(limit as usize);
    for document in &mut documents {
        cite(document);
    }
    add_snippets(&tx, &mut documents, req.query.as_deref())
        .await
        .c(h!())?;
    tx.commit().await.c(h!())?;
    let next_cursor = if more {
        let last = documents.last().c(h!())?;
        Some(
            URL_SAFE_NO_PAD.encode(
                serde_json::to_vec(&(last.file_id.clone(), last.revision))
                    .c(h!())?,
            ),
        )
    } else {
        None
    };
    Ok(DeviceDocumentSearchRsp {
        documents,
        next_cursor,
    })
}

fn filtered_candidates(select: &str, bound: &str) -> String {
    let cap = DEVICE_DOCUMENT_SEARCH_CANDIDATE_LIMIT;
    format!("(with matched as materialized ({select} limit {cap}), selected as (
      select id,revision from matched where (select count(*) from matched)<{cap}
      union all
      ({select} and (select count(*) from matched)>={cap}
       order by src.id desc,src.revision desc limit {bound})
    ) select id,revision from selected order by id desc,revision desc limit {bound})")
}

fn search_matches(
    req: &DeviceDocumentSearchReq,
    values: &mut Vec<Value>,
) -> anyhow::Result<Vec<(&'static str, String)>> {
    let scope = req.scope.as_deref().unwrap_or("all");
    anyhow::ensure!(
        matches!(scope, "all" | "name" | "content" | "summary"),
        "invalid search scope"
    );
    let mut matches = vec![];
    if let Some(query) = req.query.as_deref().filter(|q| !q.trim().is_empty()) {
        check_text(query).c(h!())?;
        let term = if scope == "name" {
            String::new()
        } else {
            bind(values, query.to_string())
        };
        let pattern = bind(values, format!("%{}%", literal(query)));
        if matches!(scope, "all" | "name") {
            matches.push(("", format!("src.name ilike {pattern} escape '\\'")));
        }
        if scope != "name" {
            let text = match scope {
                "summary" => format!("c.summary ilike {pattern} escape '\\'"),
                "content" => format!("c.text_tsv @@ websearch_to_tsquery('russian',{term}) or c.text ilike {pattern} escape '\\'"),
                _ => format!("c.search_tsv @@ websearch_to_tsquery('russian',{term}) or c.member ilike {pattern} escape '\\' or c.text ilike {pattern} escape '\\' or c.summary ilike {pattern} escape '\\'"),
            };
            let joins="join file_document doc on doc.file_id=src.id and doc.revision=src.revision";
            matches.push((joins,format!("doc.published_generation in (select c.generation from file_document_chunk c where {text})")));
            if scope != "content" {
                matches.push((joins,format!("doc.published_generation in (select id from file_document_generation where search_tsv @@ websearch_to_tsquery('russian',{term}) or summary ilike {pattern} escape '\\')")));
            }
        }
    }
    Ok(matches)
}

fn metadata_filters(
    req: &DeviceDocumentSearchReq,
    values: &mut Vec<Value>,
    filters: &mut Vec<String>,
) -> anyhow::Result<()> {
    if let Some(prefix) = &req.path_prefix {
        check_text(prefix).c(h!())?;
        let parameter = bind(values, format!("{}%", literal(prefix)));
        filters.push(format!("src.absolute_path like {parameter} escape '\\'"));
    }
    if let Some(format) = &req.format {
        check_text(format).c(h!())?;
        filters.push(format!(
            "src.extension={}",
            bind(values, format.to_lowercase())
        ));
    }
    for (date, op) in [(req.from, ">="), (req.to, "<=")] {
        if let Some(date) = date {
            filters.push(format!("src.file_metadata_modified_at {op} to_timestamp({}::double precision/1000)",bind(values,date)));
        }
    }
    if let Some(cursor) = &req.cursor {
        anyhow::ensure!(cursor.len() < 512, "invalid cursor");
        let (id, revision): (Uuid, i64) =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(cursor).c(h!())?)
                .c(h!())?;
        let id = bind(values, id);
        let revision = bind(values, revision);
        filters.push(format!("(src.id,src.revision)<({id},{revision})"));
    }
    Ok(())
}

async fn add_snippets(
    db: &impl ConnectionTrait,
    documents: &mut [DeviceDocumentItem],
    query: Option<&str>,
) -> anyhow::Result<()> {
    #[derive(sea_orm::FromQueryResult)]
    struct Snippet {
        generation: Uuid,
        snippet: String,
    }
    let ids = documents
        .iter()
        .filter_map(|d| d.extraction_revision.as_deref())
        .map(Uuid::parse_str)
        .collect::<Result<Vec<_>, _>>()
        .c(h!())?;
    if ids.is_empty() {
        return Ok(());
    }
    let snippets = rows::<Snippet,_>(db,"select chosen.generation,c.locator || ': ' || left(c.text,600) as snippet from unnest($1::uuid[]) chosen(generation) cross join lateral (select locator,text from file_document_chunk where generation=chosen.generation order by (search_tsv @@ websearch_to_tsquery('russian',$2)) desc,ordinal limit 1) c",vec![ids.into(),query.unwrap_or("").into()]).await.c(h!())?;
    for document in documents {
        document.snippet = snippets
            .iter()
            .find(|s| {
                Some(s.generation.to_string()) == document.extraction_revision
            })
            .map(|s| s.snippet.clone());
    }
    Ok(())
}
