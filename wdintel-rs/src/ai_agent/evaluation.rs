use crate::h;
use crate::types::ShortContext;
use sea_orm::{EntityTrait, JoinType, QuerySelect, QueryTrait, RelationTrait};
use serde::Deserialize;
use std::io::Read;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SearchInput {
    search: Option<String>,
    selected_callsigns: Option<Vec<String>>,
}

/// Compiles fixture searches with the same filters as the inbox API, without
/// loading credentials or connecting to an application database.
pub fn search_query() -> anyhow::Result<()> {
    use crate::entities::sigint_inbox_item;
    use crate::rer_importer::analysis::{
        filter_search, filter_selected_callsigns,
    };

    let mut input = String::new();
    std::io::stdin()
        .take(65_537)
        .read_to_string(&mut input)
        .c(h!())?;
    anyhow::ensure!(
        input.len() <= 65_536,
        "evaluation query input is too large"
    );
    let input: SearchInput = serde_json::from_str(&input).c(h!())?;
    let query = sigint_inbox_item::Entity::find()
        .select_only()
        .column(sigint_inbox_item::Column::Id)
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        );
    let query = filter_search(query, &input.search).c(h!())?;
    let query =
        filter_selected_callsigns(query, &input.selected_callsigns).c(h!())?;
    serde_json::to_writer(
        std::io::stdout(),
        &serde_json::json!({
            "sql": query.build(sea_orm::DbBackend::Postgres).to_string(),
            "skills": super::route_registry::skills_json(),
        }),
    )
    .c(h!())?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase", deny_unknown_fields)]
enum MapInput {
    Prepare {
        records: Vec<super::maps::types::AiAgentMapRecordInput>,
    },
    Export {
        document: super::maps::types::AiAgentMapDocument,
    },
}

pub fn maps() -> anyhow::Result<()> {
    use crate::config::AI_AGENT_EVENT_PAYLOAD_MAX_BYTES;
    use base64::Engine;
    let mut input = String::new();
    std::io::stdin()
        .take(AI_AGENT_EVENT_PAYLOAD_MAX_BYTES as u64 + 1)
        .read_to_string(&mut input)
        .c(h!())?;
    anyhow::ensure!(
        input.len() <= AI_AGENT_EVENT_PAYLOAD_MAX_BYTES,
        "Map evaluation input is too large"
    );
    let input: MapInput = serde_json::from_str(&input).c(h!())?;
    let result = match input {
        MapInput::Prepare { records } => {
            anyhow::ensure!(
                !records.is_empty()
                    && records.len()
                        <= crate::config::AI_AGENT_MAP_BATCH_MAX_RECORDS,
                "Invalid map batch"
            );
            let records = records
                .into_iter()
                .map(super::maps::prepare::prepare_record)
                .collect::<anyhow::Result<Vec<_>>>()
                .c(h!())?;
            serde_json::json!({ "records": records })
        }
        MapInput::Export { document } => {
            let document =
                super::maps::prepare::canonicalize(document).c(h!())?;
            let csv =
                String::from_utf8(super::maps::export::csv(&document).c(h!())?)
                    .c(h!())?;
            let kmz = if document.valid_count > 0 {
                Some(
                    base64::engine::general_purpose::STANDARD.encode(
                        super::maps::export::kmz(
                            &document,
                            std::path::Path::new(
                                "wdintel-web/static/img/google_earth_icons",
                            ),
                            &Default::default(),
                        )
                        .c(h!())?,
                    ),
                )
            } else {
                None
            };
            serde_json::json!({ "document": document, "csv": csv, "kmz": kmz })
        }
    };
    serde_json::to_writer(std::io::stdout(), &result).c(h!())?;
    Ok(())
}
