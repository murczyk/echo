use super::types::AiAgentMessageCitation;
use crate::entities::ai_agent_request_event;
use crate::h;
use crate::types::ShortContext;
use sea_orm::{
    ColumnTrait, ConnectionTrait, DatabaseTransaction, EntityTrait,
    QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

pub(super) fn parse(payload: &Value) -> Option<Vec<AiAgentMessageCitation>> {
    let citations: Vec<AiAgentMessageCitation> =
        serde_json::from_value(payload.get("citations")?.clone()).ok()?;
    citations
        .iter()
        .all(|citation| {
            citation.message_id > 0
                && citation.message_id <= 9_007_199_254_740_991
                && !citation.message_identifier.trim().is_empty()
                && citation.message_identifier.len() <= 512
        })
        .then_some(citations)
}

pub(super) async fn load(
    dbx: &impl ConnectionTrait,
    request_ids: &[Uuid],
) -> anyhow::Result<HashMap<Uuid, Vec<AiAgentMessageCitation>>> {
    let mut result: HashMap<Uuid, Vec<AiAgentMessageCitation>> = HashMap::new();
    if request_ids.is_empty() {
        return Ok(result);
    }
    let events = ai_agent_request_event::Entity::find()
        .select_only()
        .column(ai_agent_request_event::Column::RequestId)
        .column(ai_agent_request_event::Column::Payload)
        .filter(
            ai_agent_request_event::Column::RequestId
                .is_in(request_ids.iter().copied()),
        )
        .filter(
            ai_agent_request_event::Column::EventType.eq("message_citations"),
        )
        .order_by_asc(ai_agent_request_event::Column::Sequence)
        .into_tuple::<(Uuid, Value)>()
        .all(dbx)
        .await
        .c(h!())?;
    let mut seen: HashMap<Uuid, HashSet<String>> = HashMap::new();
    for (request_id, payload) in events {
        for citation in parse(&payload).unwrap_or_default() {
            if !seen
                .entry(request_id)
                .or_default()
                .insert(citation.message_identifier.clone())
            {
                continue;
            }
            result.entry(request_id).or_default().push(citation);
        }
    }
    Ok(result)
}

pub(super) async fn persist_referenced(
    txn: &DatabaseTransaction,
    request_id: Uuid,
    response: &str,
) -> anyhow::Result<()> {
    let citations = referenced(
        load(txn, &[request_id])
            .await
            .c(h!())?
            .remove(&request_id)
            .unwrap_or_default(),
        response,
    );
    super::events::replace_message_citations(txn, request_id, &citations)
        .await
        .c(h!())?;
    Ok(())
}

fn citation_href_in_content(content: &str, identifier: &str) -> bool {
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("m", identifier)
        .finish();
    let needle = format!("/rer-analysis-neo?{query}");
    let mut rest = content;
    while let Some(index) = rest.find(&needle) {
        let after = index + needle.len();
        let boundary = match rest[after..].chars().next() {
            None => true,
            Some(ch) => matches!(
                ch,
                '&' | ')'
                    | '#'
                    | '>'
                    | '"'
                    | '\''
                    | '`'
                    | ']'
                    | ' '
                    | '\n'
                    | '\t'
                    | '\r'
            ),
        };
        if boundary {
            return true;
        }
        rest = &rest[after..];
    }
    false
}

pub(super) fn referenced(
    citations: Vec<AiAgentMessageCitation>,
    content: &str,
) -> Vec<AiAgentMessageCitation> {
    citations
        .into_iter()
        .filter(|citation| {
            citation_href_in_content(content, &citation.message_identifier)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn referenced_does_not_match_an_identifier_prefix() {
        let citations = vec![
            AiAgentMessageCitation {
                message_id: 7,
                message_identifier: "7".to_string(),
            },
            AiAgentMessageCitation {
                message_id: 77,
                message_identifier: "77".to_string(),
            },
        ];
        let kept =
            referenced(citations, "Evidence [джерело](/rer-analysis-neo?m=77)");
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].message_id, 77);
    }
}
