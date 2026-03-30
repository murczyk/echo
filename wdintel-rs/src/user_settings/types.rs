use crate::error::AppError;
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

impl DutyMessageCardLayout {
    pub fn as_db(self) -> &'static str {
        match self {
            Self::Dividers => "dividers",
            Self::Fluid => "fluid",
        }
    }

    pub fn from_db(s: &str) -> Result<Self, AppError> {
        match s {
            "" | "fluid" => Ok(Self::Fluid),
            "dividers" => Ok(Self::Dividers),
            _ => Err(AppError::BL {
                msg: "invalid message_card_layout in database".to_string(),
            }),
        }
    }
}

impl DutyTagsLayout {
    pub fn as_db(self) -> &'static str {
        match self {
            Self::Full => "full",
            Self::Compact => "compact",
            Self::Hidden => "hidden",
        }
    }

    pub fn from_db(s: &str) -> Result<Self, AppError> {
        match s {
            "" | "compact" => Ok(Self::Compact),
            "full" => Ok(Self::Full),
            "hidden" => Ok(Self::Hidden),
            _ => Err(AppError::BL {
                msg: "invalid tags_layout in database".to_string(),
            }),
        }
    }
}
