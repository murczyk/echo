use crate::rer_importer::types::MessageMediaInfo;
use elm_rs::{Elm, ElmDecode, ElmEncode};
use serde::{Deserialize, Serialize};

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessengersTelegramAccountId {
    pub user_id: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct MessengersAccountsListReq {}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessengersAccountsListRsp {
    pub items: Vec<MessengersAccountItem>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessengersAccountItem {
    pub id: String,
    pub messenger_type: String,
    pub external_id: String,
    pub display_name: String,
    pub username: Option<String>,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub phone: Option<String>,
    pub status: Option<String>,
    pub status_error: Option<String>,
    pub status_changed_at: Option<i64>,
    pub is_active: Option<bool>,
    pub is_paused: Option<bool>,
    pub created_at: Option<i64>,
    pub last_sync: Option<i64>,
    pub notes: Option<String>,
    pub internal_notes: Option<String>,
    pub external_url: Option<String>,
    /// `/api/messengers/avatars/{id}` of the current avatar; `null` without one.
    pub avatar_url: Option<String>,
    pub telegram: Option<MessengersTelegramAccountId>,
    pub datasource_group: MessengersDatasourceGroup,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessengersDatasourceGroup {
    pub id: i64,
    pub group_master_key: String,
    pub datasource_id: i64,
    pub name: String,
    pub last_sync_at: i64,
    pub created_at: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessengersTelegramChatId {
    pub chat_id: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessengersChatsListReq {
    pub account_id: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessengersChatsListRsp {
    pub items: Vec<MessengersChatItem>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessengersChatItem {
    pub id: String,
    pub messenger_type: String,
    pub external_id: String,
    pub chat_type: Option<String>,
    pub title: Option<String>,
    pub username: Option<String>,
    pub members_count: Option<i32>,
    pub account_member_status: Option<String>,
    pub last_message_date: Option<i64>,
    /// A dialog with a bot; `null` until the collector has said.
    pub is_bot: Option<bool>,
    /// `/api/messengers/avatars/{id}` of the current avatar; `null` without one.
    pub avatar_url: Option<String>,
    pub telegram: Option<MessengersTelegramChatId>,
    /// The caller's read span of the chat timeline, epoch ms; `null` until
    /// the chat is first read.
    pub oldest_read_at: Option<i64>,
    pub newest_read_at: Option<i64>,
    /// Messages outside the read span; every message when there is none.
    pub unread_count: i64,
    /// Every stored message of the chat.
    pub total_count: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessengersChatReadStateGetReq {
    pub account_id: String,
    pub chat_id: String,
}

/// Marks the messages sent within `[oldest_read_at, newest_read_at]` (epoch
/// ms, bounds included) as read. The stored span only widens.
#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessengersChatReadStateUpdateReq {
    pub account_id: String,
    pub chat_id: String,
    pub oldest_read_at: i64,
    pub newest_read_at: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessengersChatReadState {
    pub oldest_read_at: Option<i64>,
    pub newest_read_at: Option<i64>,
    pub unread_count: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessengersChatsMarkAllReadReq {
    pub account_id: String,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Clone,
    Copy,
)]
pub enum MessengersMessagesDirection {
    Older,
    Newer,
    Oldest,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessengersMessagesListReq {
    pub account_id: String,
    pub chat_id: String,
    pub cursor: Option<String>,
    pub limit: Option<i64>,
    pub direction: Option<MessengersMessagesDirection>,
    pub around_message_id: Option<String>,
    /// Epoch ms: the page around the end of that millisecond, e.g. a chat's
    /// `newest_read_at` to open it at the first unread message.
    pub around_sent_at: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessengersMessagesListRsp {
    pub items: Vec<MessengersMessageItem>,
    pub older_cursor: Option<String>,
    pub newer_cursor: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessengersTelegramMessageId {
    pub message_id: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessengersMessageItem {
    pub id: String,
    pub external_id: String,
    pub sent_at: i64,
    pub text: String,
    pub is_outgoing: Option<bool>,
    pub has_media: Option<bool>,
    pub sender_chat_member_id: Option<String>,
    pub attachments: Vec<MessengersAttachment>,
    pub telegram: Option<MessengersTelegramMessageId>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessengersTelegramMedia {
    pub file_id: String,
    pub media_type: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessengersAttachment {
    pub media: MessageMediaInfo,
    pub external_id: String,
    pub created_at: Option<i64>,
    pub telegram: Option<MessengersTelegramMedia>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessengersAttachmentsListReq {
    pub account_id: String,
    pub chat_id: Option<String>,
    pub cursor: Option<String>,
    pub limit: Option<i64>,
    pub direction: Option<MessengersMessagesDirection>,
    pub telegram_media_types: Option<Vec<String>>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessengersAttachmentsListRsp {
    pub items: Vec<MessengersAttachmentItem>,
    pub older_cursor: Option<String>,
    pub newer_cursor: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessengersAttachmentsCountsReq {
    pub account_id: String,
    pub chat_id: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessengersAttachmentsCountsRsp {
    pub items: Vec<MessengersAttachmentTypeCount>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessengersAttachmentTypeCount {
    pub telegram_media_type: Option<String>,
    pub count: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessengersAttachmentItem {
    pub chat_id: String,
    pub message_id: String,
    pub sent_at: i64,
    pub sender_chat_member_id: Option<String>,
    pub attachment: MessengersAttachment,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessengersChatMembersListReq {
    pub account_id: String,
    pub chat_id: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessengersChatMembersListRsp {
    pub items: Vec<MessengersChatMemberItem>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessengersChatMemberItem {
    pub id: String,
    pub messenger_type: String,
    pub external_id: String,
    pub username: Option<String>,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub phone: Option<String>,
    pub is_bot: Option<bool>,
    pub role: Option<String>,
    pub joined_date: Option<i64>,
    pub deleted: bool,
    /// `/api/messengers/avatars/{id}` of the current avatar; `null` without one.
    pub avatar_url: Option<String>,
    pub telegram: Option<MessengersTelegramAccountId>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessengersAccountUpdateReq {
    pub account_id: String,
    pub internal_notes: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessengersContactsListReq {
    pub account_id: String,
    pub page: Option<i64>,
    pub limit: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessengersContactsListRsp {
    pub items: Vec<MessengersContactItem>,
    pub total: u64,
    pub page: u64,
    pub page_size: u64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessengersContactItem {
    pub id: String,
    pub messenger_type: String,
    pub external_id: String,
    pub username: Option<String>,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub phone: Option<String>,
    pub is_mutual: Option<bool>,
    pub is_close_friend: Option<bool>,
    pub created_at: i64,
    pub updated_at: i64,
    /// `/api/messengers/avatars/{id}` of the current avatar; `null` without one.
    pub avatar_url: Option<String>,
    pub telegram: Option<MessengersTelegramAccountId>,
}
