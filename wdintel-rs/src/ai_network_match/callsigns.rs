//! The message's callsigns that a candidate network lists. A network holding
//! them is the message's main network (see README.md).

use super::sql;
use crate::config::RER_CALLSIGN_MATCH_KEY_SQL;
use crate::h;
use crate::types::ShortContext;
use sea_orm::{ConnectionTrait, FromQueryResult};
use std::collections::HashMap;

/// Keyed by message id and network id; callsigns as the message spells them,
/// sorted and unique.
pub(super) type CallsignMatches = HashMap<(i64, i64), Vec<String>>;

#[derive(FromQueryResult)]
struct MatchRow {
    item_id: i64,
    network_id: i64,
    callsign: String,
}

/// Compares the callsign match keys used by callsign search, against the
/// whole network list, so input caps never hide a match.
pub(super) async fn matched_callsigns<C: ConnectionTrait>(
    dbx: &C,
    item_ids: &[i64],
    network_ids: &[i64],
) -> anyhow::Result<CallsignMatches> {
    if item_ids.is_empty() || network_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let message_key =
        RER_CALLSIGN_MATCH_KEY_SQL.replace("$1", "message.callsign");
    let network_key =
        RER_CALLSIGN_MATCH_KEY_SQL.replace("$1", "network.sigint_callsign");
    let rows = MatchRow::find_by_statement(sql(
        &format!(
            "select distinct message.sigint_inbox_item_id as item_id, network.sigint_network_id as network_id, message.callsign from sigint_inbox_item_callsign message join sigint_network_callsign network on {network_key} = {message_key} where message.sigint_inbox_item_id = any($1) and network.sigint_network_id = any($2) and not message.deleted and not network.deleted order by 1, 2, 3"
        ),
        vec![item_ids.to_vec().into(), network_ids.to_vec().into()],
    ))
    .all(dbx)
    .await
    .c(h!())?;
    let mut matches = CallsignMatches::new();
    for row in rows {
        matches
            .entry((row.item_id, row.network_id))
            .or_default()
            .push(row.callsign);
    }
    Ok(matches)
}
