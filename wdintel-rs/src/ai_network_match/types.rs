use crate::types::{Deserialize, Serialize};
use elm_rs::{Elm, ElmDecode, ElmEncode};

/// AI certainty for each candidate network of one message. Present only when
/// the feature is enabled and the stored candidates match the current links.
#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct InboxNetworkMatch {
    /// The network the card shows first while the others stay folded.
    pub confident_network_id: Option<i64>,
    /// The confident network first, then networks holding the message's
    /// callsigns, then by certainty, highest first.
    pub candidates: Vec<NetworkMatchCandidate>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NetworkMatchCandidate {
    pub network_id: i64,
    /// 0–100.
    pub certainty: i32,
    pub reason: String,
    /// The message's callsigns that this network lists, as the message spells
    /// them. Read when the card loads, so network callsign edits apply at once.
    pub matched_callsigns: Vec<String>,
}

/// One candidate's score as stored in `ai_network_match_result.certainties`.
#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub(crate) struct StoredCertainty {
    pub network_id: i64,
    pub certainty: i32,
    pub reason: String,
}
