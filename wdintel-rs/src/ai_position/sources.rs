use crate::config::AI_POSITION_KNOWLEDGE_WINDOW_DAYS;
use crate::h;
use crate::rer_importer::highlight::CNPositionCoordinateSource;
use crate::types::ShortContext;
use chrono::NaiveDateTime;
use sea_orm::{
    DatabaseBackend, DatabaseConnection, FromQueryResult, Statement, Value,
};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

#[derive(FromQueryResult)]
struct SourceRow {
    owner_id: Uuid,
    mgrs: String,
    message_uuid: Uuid,
    group_name: Option<String>,
    message_at: NaiveDateTime,
}

async fn load_sources(
    dbx: &DatabaseConnection,
    sql: &str,
    values: Vec<Value>,
) -> anyhow::Result<HashMap<Uuid, Vec<CNPositionCoordinateSource>>> {
    let rows = SourceRow::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        sql,
        values,
    ))
    .all(dbx)
    .await
    .c(h!())?;
    let mut sources: HashMap<Uuid, Vec<_>> = HashMap::new();
    for row in rows {
        sources.entry(row.owner_id).or_default().push(
            CNPositionCoordinateSource {
                mgrs: row.mgrs,
                message_uuid: row.message_uuid.to_string(),
                group_name: row.group_name.unwrap_or_default(),
                message_at: row.message_at.and_utc().timestamp_millis(),
            },
        );
    }
    Ok(sources)
}

pub(super) async fn mention_sources(
    dbx: &DatabaseConnection,
    mention_ids: Vec<Uuid>,
    allowed: &HashSet<String>,
) -> anyhow::Result<HashMap<Uuid, Vec<CNPositionCoordinateSource>>> {
    if mention_ids.is_empty() || allowed.is_empty() {
        return Ok(HashMap::new());
    }
    load_sources(
        dbx,
        "select distinct on (m.id, c.mgrs) m.id as owner_id, c.mgrs,
                message.id_uuid as message_uuid, sg.name as group_name, c.message_at
         from ai_position_mention m
         join ai_position_coordinate c on c.mention_id = m.id
         join signal_group sg on sg.master_key = m.group_master_key
             and not sg.deleted and not sg.is_archived
         left join signal_message_media media on media.id = m.media_id
         join signal_message message
             on message.id = coalesce(m.sigint_inbox_item_id, media.signal_message_id)
         where m.id = any($1) and m.group_master_key = any($2)
             and not message.deleted and message.id_uuid is not null
             and exists (
                 select 1 from signal_message_group smg
                 where smg.signal_message_id = message.id
                     and smg.group_master_key = m.group_master_key
             )
         order by m.id, c.mgrs, c.message_at desc, c.id desc",
        vec![
            mention_ids.into(),
            allowed.iter().cloned().collect::<Vec<_>>().into(),
        ],
    )
    .await
    .c(h!())
}

pub(super) async fn knowledge_sources(
    dbx: &DatabaseConnection,
    knowledge_ids: Vec<Uuid>,
    allowed: &HashSet<String>,
) -> anyhow::Result<HashMap<Uuid, Vec<CNPositionCoordinateSource>>> {
    if knowledge_ids.is_empty() || allowed.is_empty() {
        return Ok(HashMap::new());
    }
    load_sources(
        dbx,
        "select distinct on (k.id) k.id as owner_id, c.mgrs,
                message.id_uuid as message_uuid, sg.name as group_name, c.message_at
         from ai_position_knowledge k
         join ai_position_mention m on m.name_key = k.name_key
         join ai_position_coordinate c on c.mention_id = m.id and c.mgrs = k.mgrs
         join signal_group sg on sg.master_key = m.group_master_key
             and not sg.deleted and not sg.is_archived
         left join signal_message_media media on media.id = m.media_id
         join signal_message message
             on message.id = coalesce(m.sigint_inbox_item_id, media.signal_message_id)
         where k.id = any($1) and m.group_master_key = any($2)
             and cardinality(k.source_group_keys) > 0 and k.source_group_keys <@ $2
             and not message.deleted and message.id_uuid is not null
             and c.message_at between k.last_fact_at - make_interval(days => $3)
                 and k.last_fact_at
             and m.message_at between k.last_fact_at - make_interval(days => $3)
                 and k.last_fact_at
             and (k.scope_kind = 'group' and m.group_master_key = k.scope_key
                 or k.scope_kind = 'aor' and not sg.is_secret and exists (
                     select 1 from signal_group_aor sga
                     join area_of_responsibility aor on aor.id = sga.aor_id and not aor.deleted
                     where sga.master_key = m.group_master_key and sga.aor_id::text = k.scope_key
                 ))
             and exists (
                 select 1 from signal_message_group smg
                 where smg.signal_message_id = message.id
                     and smg.group_master_key = m.group_master_key
             )
         order by k.id, c.message_at desc, c.id desc",
        vec![
            knowledge_ids.into(),
            allowed.iter().cloned().collect::<Vec<_>>().into(),
            (AI_POSITION_KNOWLEDGE_WINDOW_DAYS as i32).into(),
        ],
    )
    .await
    .c(h!())
}
