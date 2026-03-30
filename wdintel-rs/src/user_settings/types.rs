use elm_rs::{Elm, ElmDecode, ElmEncode};
use serde::{Deserialize, Serialize};

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
    Copy,
)]
#[serde(rename_all = "lowercase")]
pub enum DutyMessageCardLayout {
    Dividers,
    Fluid,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
    Copy,
)]
#[serde(rename_all = "lowercase")]
pub enum DutyTagsLayout {
    Full,
    Compact,
    Hidden,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct UserDutySettingsDto {
    pub message_card_layout: DutyMessageCardLayout,
    pub tags_layout: DutyTagsLayout,
}

impl Default for UserDutySettingsDto {
    fn default() -> Self {
        Self {
            message_card_layout: DutyMessageCardLayout::Fluid,
            tags_layout: DutyTagsLayout::Compact,
        }
    }
}
