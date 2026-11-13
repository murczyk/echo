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
    Copy,
    Default,
)]
#[serde(rename_all = "lowercase")]
pub enum MessageTextPreviewLines {
    #[default]
    Twenty,
    Forty,
    Off,
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
    Default,
    schemars::JsonSchema,
)]
pub enum MessageTimeBasis {
    #[default]
    #[serde(rename = "interception")]
    MessageInterception,
    #[serde(rename = "creation")]
    MessageCreation,
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
    Default,
)]
pub enum MessageCardQuickAction {
    #[default]
    #[serde(rename = "createReport")]
    QuickActionCreateReport,
    #[serde(rename = "reply")]
    QuickActionReply,
    #[serde(rename = "important")]
    QuickActionImportant,
    #[serde(rename = "bookmark")]
    QuickActionBookmark,
    #[serde(rename = "copyText")]
    QuickActionCopyText,
    #[serde(rename = "copyLink")]
    QuickActionCopyLink,
    #[serde(rename = "edit")]
    QuickActionEdit,
    #[serde(rename = "delete")]
    QuickActionDelete,
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
    pub tags_layout: DutyTagsLayout,
    #[serde(default)]
    pub message_text_preview_lines: MessageTextPreviewLines,
    #[serde(default)]
    pub disable_auto_scroll: bool,
    #[serde(default)]
    pub analysis_map_in_sidebar: bool,
    #[serde(default)]
    pub duty_audio_transcription_collapsed: bool,
    #[serde(default)]
    pub analysis_audio_transcription_collapsed: bool,
    #[serde(default)]
    pub show_analysis_callsign_add_form: bool,
    #[serde(default)]
    pub show_classic_duty: bool,
    #[serde(default)]
    pub show_classic_analysis: bool,
    #[serde(default = "default_duty_collapse_media_previews")]
    pub duty_collapse_media_previews: bool,
    #[serde(default)]
    pub large_media_previews: bool,
    #[serde(default)]
    pub large_message_card_text: bool,
    #[serde(default)]
    pub message_card_quick_action: MessageCardQuickAction,
    #[serde(default = "default_media_summary_enabled")]
    pub media_summary_enabled: bool,
    #[serde(default)]
    pub message_sort_by: MessageTimeBasis,
    #[serde(default = "default_message_auto_parse_enabled")]
    pub message_auto_parse_enabled: bool,
    #[serde(default)]
    pub ai_position_highlights_enabled: bool,
    #[serde(default)]
    pub minimal_report_window_enabled: bool,
    #[serde(default = "default_remember_report_group")]
    pub duty_remember_report_group: bool,
    #[serde(default = "default_remember_report_group")]
    pub analysis_remember_report_group: bool,
    #[serde(default)]
    pub important_only_my_organism: bool,
}

fn default_remember_report_group() -> bool {
    true
}

fn default_duty_collapse_media_previews() -> bool {
    false
}

pub(super) fn default_message_auto_parse_enabled() -> bool {
    true
}

fn default_media_summary_enabled() -> bool {
    false
}

impl Default for UserDutySettingsDto {
    fn default() -> Self {
        Self {
            tags_layout: DutyTagsLayout::Compact,
            message_text_preview_lines: MessageTextPreviewLines::Twenty,
            disable_auto_scroll: false,
            analysis_map_in_sidebar: false,
            duty_audio_transcription_collapsed: false,
            analysis_audio_transcription_collapsed: false,
            show_analysis_callsign_add_form: false,
            show_classic_duty: false,
            show_classic_analysis: false,
            duty_collapse_media_previews: false,
            large_media_previews: false,
            large_message_card_text: false,
            message_card_quick_action: MessageCardQuickAction::default(),
            media_summary_enabled: false,
            ai_position_highlights_enabled: false,
            message_sort_by: MessageTimeBasis::MessageInterception,
            message_auto_parse_enabled: default_message_auto_parse_enabled(),
            minimal_report_window_enabled: false,
            duty_remember_report_group: default_remember_report_group(),
            analysis_remember_report_group: default_remember_report_group(),
            important_only_my_organism: false,
        }
    }
}
