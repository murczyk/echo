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
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct DeploymentMaintenance {
    pub id: String,
    pub remaining_ms: i64,
}

impl EventMsg {
    pub fn new(event_type: EventType) -> Self {
        EventMsg {
            id: Uuid::now_v7().to_string(),
            event_type,
            created_at: Utc::now().timestamp_millis(),
            origin: None,
        }
    }

    pub fn with_origin(mut self, origin: Option<String>) -> Self {
        self.origin = origin;
        self
    }
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct LongPollReq {
    pub session_id: String,
    pub last_event_id: Option<String>,
    #[serde(default)]
    pub deployment_maintenance_protocol: Option<u8>,
    #[serde(default)]
    pub known_deployment_maintenance_id: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct LongPollRsp {
    pub events: Vec<EventMsg>,
    pub last_event_id: Option<String>,
    #[serde(default)]
    pub deployment_maintenance: Option<DeploymentMaintenance>,
}
