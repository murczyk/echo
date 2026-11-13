pub use crate::messenger_ingest::refs::MessengerIngestTelegramAccountId;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct MessengerIngestAccountInput {
    pub messenger_type: String,
    pub external_id: String,
    pub display_name: String,
    pub phone: Option<String>,
    pub username: Option<String>,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub status: Option<String>,
    pub status_error: Option<String>,
    pub status_changed_at: Option<i64>,
    pub is_active: Option<bool>,
    pub is_paused: Option<bool>,
    pub notes: Option<String>,
    pub external_url: Option<String>,
    pub created_at: Option<i64>,
    pub last_sync: Option<i64>,
    pub telegram: Option<MessengerIngestTelegramAccountId>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct MessengerIngestAccountItem {
    pub messenger_type: String,
    pub id: String,
    pub external_id: String,
    pub display_name: String,
    pub phone: Option<String>,
    pub username: Option<String>,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub status: Option<String>,
    pub status_error: Option<String>,
    pub status_changed_at: Option<i64>,
    pub is_active: Option<bool>,
    pub is_paused: Option<bool>,
    pub notes: Option<String>,
    pub external_url: Option<String>,
    pub created_at: Option<i64>,
    pub last_sync: Option<i64>,
    pub telegram: Option<MessengerIngestTelegramAccountId>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct MessengerIngestAccountsSyncReq {
    pub created: Vec<MessengerIngestAccountInput>,
    pub updated: BTreeMap<String, MessengerIngestAccountInput>,
    pub deleted: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct MessengerIngestAccountsSyncRsp {
    pub created: BTreeMap<String, MessengerIngestAccountItem>,
    pub updated: BTreeMap<String, MessengerIngestAccountItem>,
    pub deleted: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct MessengerIngestTelegramChatId {
    pub chat_id: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct MessengerIngestChatInput {
    pub external_id: String,
    pub chat_type: Option<String>,
    pub title: Option<String>,
    pub username: Option<String>,
    pub members_count: Option<i32>,
    pub account_member_status: Option<String>,
    pub last_message_date: Option<i64>,
    pub telegram: Option<MessengerIngestTelegramChatId>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct MessengerIngestChatItem {
    pub messenger_type: String,
    pub id: String,
    pub external_id: String,
    pub chat_type: Option<String>,
    pub title: Option<String>,
    pub username: Option<String>,
    pub members_count: Option<i32>,
    pub account_member_status: Option<String>,
    pub last_message_date: Option<i64>,
    pub telegram: Option<MessengerIngestTelegramChatId>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct MessengerIngestChatsSyncReq {
    pub account: crate::messenger_ingest::refs::MessengerIngestAccountRef,
    pub created: Vec<MessengerIngestChatInput>,
    pub updated: BTreeMap<String, MessengerIngestChatInput>,
    pub deleted: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct MessengerIngestChatsSyncRsp {
    pub created: BTreeMap<String, MessengerIngestChatItem>,
    pub updated: BTreeMap<String, MessengerIngestChatItem>,
    pub deleted: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct MessengerIngestTelegramMessageId {
    pub message_id: String,
}

/// A member of a chat as seen by the account, with the member's profile.
/// `external_id` is unique per chat. The account itself is a member of
/// its chats, so outgoing messages can reference it as their sender.
#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct MessengerIngestChatMemberInput {
    pub external_id: String,
    pub username: Option<String>,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub phone: Option<String>,
    pub is_bot: Option<bool>,
    pub role: Option<String>,
    pub joined_date: Option<i64>,
    pub telegram: Option<MessengerIngestTelegramAccountId>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct MessengerIngestChatMemberItem {
    pub messenger_type: String,
    pub id: String,
    pub external_id: String,
    pub username: Option<String>,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub phone: Option<String>,
    pub is_bot: Option<bool>,
    pub role: Option<String>,
    pub joined_date: Option<i64>,
    pub telegram: Option<MessengerIngestTelegramAccountId>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct MessengerIngestChatMembersSyncReq {
    pub account: crate::messenger_ingest::refs::MessengerIngestAccountRef,
    pub chat: crate::messenger_ingest::refs::MessengerIngestChatRef,
    pub created: Vec<MessengerIngestChatMemberInput>,
    pub updated: BTreeMap<String, MessengerIngestChatMemberInput>,
    pub deleted: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct MessengerIngestChatMembersSyncRsp {
    pub created: BTreeMap<String, MessengerIngestChatMemberItem>,
    pub updated: BTreeMap<String, MessengerIngestChatMemberItem>,
    pub deleted: Vec<String>,
}

/// A contact of the account, with the contact's profile as saved by the
/// account. `external_id` is unique per account.
#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct MessengerIngestContactInput {
    pub external_id: String,
    pub username: Option<String>,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub phone: Option<String>,
    pub is_mutual: Option<bool>,
    pub is_close_friend: Option<bool>,
    pub telegram: Option<MessengerIngestTelegramAccountId>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct MessengerIngestContactItem {
    pub messenger_type: String,
    pub id: String,
    pub external_id: String,
    pub username: Option<String>,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub phone: Option<String>,
    pub is_mutual: Option<bool>,
    pub is_close_friend: Option<bool>,
    pub telegram: Option<MessengerIngestTelegramAccountId>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct MessengerIngestContactsSyncReq {
    pub account: crate::messenger_ingest::refs::MessengerIngestAccountRef,
    pub created: Vec<MessengerIngestContactInput>,
    pub updated: BTreeMap<String, MessengerIngestContactInput>,
    pub deleted: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct MessengerIngestContactsSyncRsp {
    pub created: BTreeMap<String, MessengerIngestContactItem>,
    pub updated: BTreeMap<String, MessengerIngestContactItem>,
    pub deleted: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct MessengerIngestMessageInput {
    pub external_id: String,
    pub date: i64,
    pub text: Option<String>,
    pub is_outgoing: Option<bool>,
    pub has_media: Option<bool>,
    pub sender:
        Option<crate::messenger_ingest::refs::MessengerIngestChatMemberRef>,
    pub telegram: Option<MessengerIngestTelegramMessageId>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct MessengerIngestMessagesSubmitReq {
    pub account: crate::messenger_ingest::refs::MessengerIngestAccountRef,
    pub chat: crate::messenger_ingest::refs::MessengerIngestChatRef,
    pub messages: Vec<MessengerIngestMessageInput>,
}

/// `status` is `created` for a newly stored message and `existing` for a
/// message already submitted under the same chat and `external_id`.
#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct MessengerIngestMessageItem {
    pub id: String,
    pub external_id: String,
    pub status: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct MessengerIngestMessagesSubmitRsp {
    pub results: Vec<MessengerIngestMessageItem>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq, Clone)]
pub struct MessengerIngestTelegramMedia {
    pub file_id: String,
    pub media_type: Option<String>,
}

/// One attachment of an already submitted message. `upload_url` is the
/// `Location` of a completed ingest TUS upload; `file_name` and
/// `content_type` (the MIME type) override the TUS `filename` /
/// `filetype` metadata. `created_at` is when the collector recorded the
/// media, in epoch milliseconds.
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq, Clone)]
pub struct MessengerIngestAttachmentInput {
    pub external_id: String,
    pub upload_url: String,
    pub file_name: Option<String>,
    pub content_type: Option<String>,
    pub created_at: Option<i64>,
    pub telegram: Option<MessengerIngestTelegramMedia>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct MessengerIngestAttachmentsSubmitReq {
    pub account: crate::messenger_ingest::refs::MessengerIngestAccountRef,
    pub chat: crate::messenger_ingest::refs::MessengerIngestChatRef,
    pub message_external_id: String,
    pub attachments: Vec<MessengerIngestAttachmentInput>,
}

/// `status` is `created` for a newly stored attachment and `existing` for
/// an attachment already submitted under the same message and
/// `external_id`. `id` is the Echo media uuid.
#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct MessengerIngestAttachmentItem {
    pub id: String,
    pub external_id: String,
    pub status: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct MessengerIngestAttachmentsSubmitRsp {
    pub results: Vec<MessengerIngestAttachmentItem>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct MessengerIngestTelegramAvatar {
    pub photo_id: String,
}

/// One avatar of an owner. `upload_url` is the `Location` of a completed
/// ingest TUS upload; `file_name` and `content_type` override the TUS
/// `filename` / `filetype` metadata. `set_at` is when the avatar was set in
/// the messenger, in epoch milliseconds. `is_current` makes it the owner's
/// current avatar.
#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct MessengerIngestAvatarInput {
    pub external_id: String,
    pub upload_url: String,
    pub file_name: Option<String>,
    pub content_type: Option<String>,
    pub set_at: Option<i64>,
    pub is_current: bool,
    pub telegram: Option<MessengerIngestTelegramAvatar>,
}

/// `status` is `created` for a newly stored avatar and `existing` for an
/// avatar already submitted under the same owner and `external_id`.
/// `id` is the Echo avatar uuid; `is_current` tells whether it is the
/// owner's current avatar after the request.
#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct MessengerIngestAvatarItem {
    pub id: String,
    pub external_id: String,
    pub status: String,
    pub is_current: bool,
}

/// Avatar submit of one account. An absent or `null` `avatar` removes the
/// owner's current avatar and keeps its history. The same holds for the
/// chat, chat member and contact submits below.
#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct MessengerIngestAccountAvatarSubmitReq {
    pub account: crate::messenger_ingest::refs::MessengerIngestAccountRef,
    pub avatar: Option<MessengerIngestAvatarInput>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct MessengerIngestChatAvatarSubmitReq {
    pub account: crate::messenger_ingest::refs::MessengerIngestAccountRef,
    pub chat: crate::messenger_ingest::refs::MessengerIngestChatRef,
    pub avatar: Option<MessengerIngestAvatarInput>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct MessengerIngestChatMemberAvatarSubmitReq {
    pub account: crate::messenger_ingest::refs::MessengerIngestAccountRef,
    pub chat: crate::messenger_ingest::refs::MessengerIngestChatRef,
    pub member: crate::messenger_ingest::refs::MessengerIngestChatMemberRef,
    pub avatar: Option<MessengerIngestAvatarInput>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct MessengerIngestContactAvatarSubmitReq {
    pub account: crate::messenger_ingest::refs::MessengerIngestAccountRef,
    pub contact: crate::messenger_ingest::refs::MessengerIngestContactRef,
    pub avatar: Option<MessengerIngestAvatarInput>,
}

/// The stored avatar; `null` when the request removed the current avatar.
#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct MessengerIngestAvatarSubmitRsp {
    pub avatar: Option<MessengerIngestAvatarItem>,
}
