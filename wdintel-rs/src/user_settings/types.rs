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
)]
#[serde(rename_all = "camelCase")]
pub struct UserDutySettingsDto {
    pub tags_layout: DutyTagsLayout,
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
    #[serde(default = "default_media_summary_enabled")]
    pub media_summary_enabled: bool,
}

fn default_duty_collapse_media_previews() -> bool {
    false
}

fn default_media_summary_enabled() -> bool {
    true
}

impl Default for UserDutySettingsDto {
    fn default() -> Self {
        Self {
            tags_layout: DutyTagsLayout::Compact,
            disable_auto_scroll: false,
            analysis_map_in_sidebar: false,
            duty_audio_transcription_collapsed: false,
            analysis_audio_transcription_collapsed: false,
            show_analysis_callsign_add_form: false,
            show_classic_duty: false,
            show_classic_analysis: false,
            duty_collapse_media_previews: false,
            media_summary_enabled: true,
        }
    }
}
