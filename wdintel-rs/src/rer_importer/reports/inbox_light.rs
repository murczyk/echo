use crate::entities::*;
use crate::error::AppError;
use crate::rer_importer::types::{InboxMessage, InboxMessagesReq};
use crate::types::*;
use anyhow::Context;
use sea_orm::*;
use serde::de::DeserializeOwned;
use std::collections::HashMap;

#[derive(Debug, Clone, FromQueryResult)]
pub(crate) struct ReportMessageGroupInfo {
    pub signal_message_id: i64,
    pub group_master_key: Option<String>,
    pub datasource_id: Option<i64>,
}

pub(crate) fn blank_inbox_message() -> InboxMessage {
    InboxMessage {
        message_uid: None,
        text: String::new(),
        media: vec![],
        images: vec![],
        image_recognized: vec![],
        date: None,
        time: None,
        freq: None,
        coords: None,
        callsigns: vec![],
        callsigns_alg2: vec![],
        checked: false,
        important: false,
        bookmarked: false,
        timestamp: None,
        group_master_key: None,
        sender: None,
        extended_form: None,
        message_comments: vec![],
        post: None,
        post_id: None,
        unit: None,
        callsign_tokens: None,
        signal_tokens: None,
        point_tokens: None,
        no_headers_body: None,
        keyword_tokens: None,
        text_marked: None,
        datasource_id: None,
        location: None,
        tags: None,
        network_ids: None,
        network_name: None,
        device_name: None,
        inbox_tags: None,
        metadata: vec![],
    }
}

pub(crate) fn parse_optional_json_vec<T>(
    value: Option<serde_json::Value>,
) -> Result<Vec<T>, AppError>
where
    T: DeserializeOwned,
{
    match value {
        Some(value) => Ok(serde_json::from_value(value).context(h!())?),
        None => Ok(vec![]),
    }
}

pub(crate) async fn load_message_group_info(
    dbx: &DatabaseConnection,
    login: &uuid::Uuid,
    req: &InboxMessagesReq,
    message_ids: &[i64],
) -> Result<HashMap<i64, ReportMessageGroupInfo>, AppError> {
    if message_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let sigint_groups =
        crate::messenger::group::get_identity_sigint_groups(dbx, login)
            .await
            .context(h!())?;
    let mut groups = HashMap::new();
    for ids in message_ids.chunks(20000) {
        let mut query = signal_message_group::Entity::find()
            .join(
                JoinType::LeftJoin,
                signal_message_group::Relation::DatasourceGroup.def(),
            )
            .filter(
                signal_message_group::Column::SignalMessageId
                    .is_in(ids.to_vec()),
            )
            .filter(
                signal_message_group::Column::GroupMasterKey
                    .eq_any(sigint_groups.clone()),
            );
        if let Some(selected_groups) = req.selected_groups.as_ref() {
            if !selected_groups.is_empty() {
                query = query.filter(
                    signal_message_group::Column::GroupMasterKey
                        .eq_any(selected_groups.clone()),
                );
            }
        }
        if let Some(selected_senders) = req.selected_senders.as_ref() {
            if !selected_senders.is_empty() {
                query = query.filter(
                    signal_message_group::Column::Sender
                        .eq_any(selected_senders.clone()),
                );
            }
        }

        let rows = query
            .select_only()
            .column(signal_message_group::Column::SignalMessageId)
            .column(signal_message_group::Column::GroupMasterKey)
            .column_as(datasource_group::Column::DatasourceId, "datasource_id")
            .order_by_asc(signal_message_group::Column::SignalMessageId)
            .order_by_asc(signal_message_group::Column::Id)
            .into_model::<ReportMessageGroupInfo>()
            .all(dbx)
            .await
            .context(h!())?;
        for row in rows {
            groups.entry(row.signal_message_id).or_insert(row);
        }
    }
    Ok(groups)
}
