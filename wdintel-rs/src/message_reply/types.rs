use elm_rs::{Elm, ElmDecode, ElmEncode};
use serde::{Deserialize, Serialize};

#[derive(
    Debug, Clone, Copy, Serialize, Deserialize, Elm, ElmEncode, ElmDecode,
)]
pub enum MessageReplyScreen {
    Duty,
    Analysis,
}

#[derive(Debug, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct MessageRepliesReq {
    pub signal_message_ids: Vec<i64>,
    pub screen: MessageReplyScreen,
}

#[derive(Debug, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct MessageReply {
    pub id: i64,
    pub thread_id: i64,
    pub original_signal_message_id: Option<i64>,
    pub reply_signal_message_id: Option<i64>,
    pub created_at: i64,
    pub deleted: bool,
    pub original_deleted: bool,
    pub reply_deleted: bool,
}

#[derive(Debug, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct CitedMessage {
    pub id: i64,
    pub timestamp: Option<i64>,
    pub created_at: i64,
    pub preview: String,
    pub href: String,
}

#[derive(Debug, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct MessageRepliesRsp {
    pub replies: Vec<MessageReply>,
    pub reply_messages: Vec<CitedMessage>,
}
