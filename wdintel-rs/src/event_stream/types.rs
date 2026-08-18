use crate::types::*;
use chrono::prelude::*;
use elm_rs::{Elm, ElmDecode, ElmEncode};

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub enum EventType {
    ETGeneric,
    ETNetworkChanged,
    ETCallsignChanged,
    ETSignalChanged,
    ETUnitChanged,
    ETInboxChanged(i64),
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct EventMsg {
    pub id: String,
    pub event_type: EventType,
    pub created_at: i64,
    #[serde(default)]
    pub origin: Option<String>,
    #[serde(default)]
    pub intelligence_report: bool,
}

impl EventMsg {
    pub fn new(event_type: EventType) -> Self {
        EventMsg {
            id: Uuid::now_v7().to_string(),
            event_type,
            created_at: Utc::now().timestamp_millis(),
            origin: None,
            intelligence_report: false,
        }
    }

    pub fn with_origin(mut self, origin: Option<String>) -> Self {
        self.origin = origin;
        self
    }

    pub fn with_intelligence_report(mut self) -> Self {
        self.intelligence_report = true;
        self
    }
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct LongPollReq {
    pub session_id: String,
    pub last_event_id: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct LongPollRsp {
    pub events: Vec<EventMsg>,
    pub last_event_id: Option<String>,
}
