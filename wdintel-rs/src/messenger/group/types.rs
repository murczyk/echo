use crate::sigint::aor::types::AreaOfResponsibility;
use crate::sigint::types::InterseptionKind;
use crate::types::*;
use elm_rs::{Elm, ElmDecode, ElmEncode};
use serde::ser::SerializeStruct;

#[derive(Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct GroupCreationInfo {
    pub created_at: i64,
    pub created_by: Option<String>,
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
#[serde(rename_all = "snake_case")]
pub enum SignalGroupColor {
    Red,
    Pink,
    Purple,
    DeepPurple,
    Indigo,
    Blue,
    LightBlue,
    Cyan,
    Teal,
    Green,
    LightGreen,
    Lime,
    Amber,
    Orange,
    DeepOrange,
    BlueGrey,
}

impl SignalGroupColor {
    pub const ALL: [Self; 16] = [
        Self::Red,
        Self::Pink,
        Self::Purple,
        Self::DeepPurple,
        Self::Indigo,
        Self::Blue,
        Self::LightBlue,
        Self::Cyan,
        Self::Teal,
        Self::Green,
        Self::LightGreen,
        Self::Lime,
        Self::Amber,
        Self::Orange,
        Self::DeepOrange,
        Self::BlueGrey,
    ];

    pub const fn as_db_value(self) -> &'static str {
        match self {
            Self::Red => "red",
            Self::Pink => "pink",
            Self::Purple => "purple",
            Self::DeepPurple => "deep_purple",
            Self::Indigo => "indigo",
            Self::Blue => "blue",
            Self::LightBlue => "light_blue",
            Self::Cyan => "cyan",
            Self::Teal => "teal",
            Self::Green => "green",
            Self::LightGreen => "light_green",
            Self::Lime => "lime",
            Self::Amber => "amber",
            Self::Orange => "orange",
            Self::DeepOrange => "deep_orange",
            Self::BlueGrey => "blue_grey",
        }
    }

    pub fn from_db_value(value: &str) -> anyhow::Result<Self> {
        Self::ALL
            .into_iter()
            .find(|color| color.as_db_value() == value)
            .ok_or_else(|| {
                anyhow::anyhow!("unknown signal group color: {value}")
            })
    }

    pub fn from_optional_db_value(value: Option<&str>) -> anyhow::Result<Self> {
        match value {
            Some(value) => Self::from_db_value(value),
            None => Ok(Self::BlueGrey),
        }
    }
}

/// Запис групи, яка не прив'язана до жодного напрямку
#[derive(Elm, ElmEncode, ElmDecode, Debug, Deserialize, PartialEq, Clone)]
pub struct OrphanSignalGroupEntry {
    /// Унікальний ідентифікатор групи
    pub master_key: String,
    /// Назва групи
    pub name: String,
    /// Прапорець, що вказує чи ігнорувати повідомлення в Оперативному
    pub ignore_operativny: bool,
    pub interseption_kind: InterseptionKind,
    pub disable_network_assignment: bool,
    pub is_aviation_group: bool,
    pub ai_transcript_analysis_enabled: bool,
    pub fetch_new_messages: bool,
    pub is_sigint_unit_mandatory: bool,
    pub is_device_mandatory: bool,
    pub is_archived: bool,
    /// Ідентифікатор джерела даних, з якого походить група (може бути None)
    pub datasource_id: Option<i64>,
    /// Час створення групи (в мілісекундах від epoch)
    pub created_at: i64,
    pub group_stats: SignalGroupStats,
    pub group_admin_data: Option<GroupAdminData>,
    pub areas_of_responsibility: Option<Vec<AreaOfResponsibility>>,
    pub color_key: SignalGroupColor,
}

#[derive(Debug, Deserialize, Elm, ElmEncode, ElmDecode, PartialEq, Clone)]
pub struct SignalGroupEntry {
    pub master_key: String,
    pub name: String,
    pub ignore_operativny: bool,
    pub interseption_kind: InterseptionKind,
    pub disable_network_assignment: bool,
    pub is_aviation_group: bool,
    pub ai_transcript_analysis_enabled: bool,
    pub fetch_new_messages: bool,
    pub is_sigint_unit_mandatory: bool,
    pub is_device_mandatory: bool,
    pub group_stats: SignalGroupStats,
    pub admin_data: Option<GroupAdminData>,
    pub areas_of_responsibility: Option<Vec<AreaOfResponsibility>>,
    pub color_key: SignalGroupColor,
}

impl Serialize for OrphanSignalGroupEntry {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut state =
            serializer.serialize_struct("OrphanSignalGroupEntry", 19)?;
        state.serialize_field("master_key", &self.master_key)?;
        state.serialize_field("name", &self.name)?;
        state.serialize_field("ignore_operativny", &self.ignore_operativny)?;
        state.serialize_field("interseption_kind", &self.interseption_kind)?;
        state.serialize_field(
            "is_rer",
            &is_rer_interseption_kind(self.interseption_kind),
        )?;
        state.serialize_field(
            "disable_network_assignment",
            &self.disable_network_assignment,
        )?;
        state.serialize_field("is_aviation_group", &self.is_aviation_group)?;
        state.serialize_field(
            "ai_transcript_analysis_enabled",
            &self.ai_transcript_analysis_enabled,
        )?;
        state
            .serialize_field("fetch_new_messages", &self.fetch_new_messages)?;
        state.serialize_field(
            "fills_etalonka",
            &(!self.disable_network_assignment),
        )?;
        state.serialize_field("is_archived", &self.is_archived)?;
        state.serialize_field("datasource_id", &self.datasource_id)?;
        state.serialize_field("created_at", &self.created_at)?;
        state.serialize_field("group_stats", &self.group_stats)?;
        state.serialize_field("group_admin_data", &self.group_admin_data)?;
        state.serialize_field(
            "areas_of_responsibility",
            &self.areas_of_responsibility,
        )?;
        state.serialize_field("color_key", &self.color_key)?;
        state.serialize_field(
            "is_sigint_unit_mandatory",
            &self.is_sigint_unit_mandatory,
        )?;
        state.serialize_field(
            "is_device_mandatory",
            &self.is_device_mandatory,
        )?;
        state.end()
    }
}

impl Serialize for SignalGroupEntry {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut state = serializer.serialize_struct("SignalGroupEntry", 16)?;
        state.serialize_field("master_key", &self.master_key)?;
        state.serialize_field("name", &self.name)?;
        state.serialize_field("ignore_operativny", &self.ignore_operativny)?;
        state.serialize_field("interseption_kind", &self.interseption_kind)?;
        state.serialize_field(
            "is_rer",
            &is_rer_interseption_kind(self.interseption_kind),
        )?;
        state.serialize_field(
            "disable_network_assignment",
            &self.disable_network_assignment,
        )?;
        state.serialize_field("is_aviation_group", &self.is_aviation_group)?;
        state.serialize_field(
            "ai_transcript_analysis_enabled",
            &self.ai_transcript_analysis_enabled,
        )?;
        state
            .serialize_field("fetch_new_messages", &self.fetch_new_messages)?;
        state.serialize_field(
            "fills_etalonka",
            &(!self.disable_network_assignment),
        )?;
        state.serialize_field("group_stats", &self.group_stats)?;
        state.serialize_field("admin_data", &self.admin_data)?;
        state.serialize_field(
            "areas_of_responsibility",
            &self.areas_of_responsibility,
        )?;
        state.serialize_field("color_key", &self.color_key)?;
        state.serialize_field(
            "is_sigint_unit_mandatory",
            &self.is_sigint_unit_mandatory,
        )?;
        state.serialize_field(
            "is_device_mandatory",
            &self.is_device_mandatory,
        )?;
        state.end()
    }
}

fn is_rer_interseption_kind(interseption_kind: InterseptionKind) -> bool {
    matches!(interseption_kind, InterseptionKind::InterseptionRer)
}

#[derive(
    Debug, Serialize, Deserialize, Elm, ElmEncode, ElmDecode, PartialEq, Clone,
)]
pub struct SignalGroupEntryF2 {
    pub master_key: String,
    pub name: String,
    pub kind: String,
    pub group_stats: SignalGroupStats,
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
    Default,
)]
pub struct SignalGroupStats {
    pub activity_last_day: i64,
    pub activity_last_week: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SignalGroupStatsTimelineReq {
    pub master_keys: Vec<String>,
    pub period_hours: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SignalGroupStatsTimelinePoint {
    pub timestamp: i64,
    pub count: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SignalGroupStatsTimelineEntry {
    pub master_key: String,
    pub points: Vec<SignalGroupStatsTimelinePoint>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SignalGroupStatsTimelineRsp {
    pub data: Vec<SignalGroupStatsTimelineEntry>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SignalGroupArchiveReq {
    pub master_key: String,
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
    Default,
)]
pub struct GroupAdminData {
    pub short_note: Option<String>,
    pub long_note: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn signal_group_color_serializes_as_snake_case() {
        assert_eq!(
            serde_json::to_value(SignalGroupColor::DeepPurple).unwrap(),
            json!("deep_purple")
        );
    }

    #[test]
    fn signal_group_color_rejects_unknown_json() {
        assert!(serde_json::from_value::<SignalGroupColor>(json!("unknown"))
            .is_err());
    }

    #[test]
    fn signal_group_entry_serializes_legacy_aliases() {
        let signal_group = SignalGroupEntry {
            is_sigint_unit_mandatory: false,
            is_device_mandatory: false,
            master_key: "group.1".to_string(),
            name: "Group 1".to_string(),
            ignore_operativny: false,
            interseption_kind: InterseptionKind::InterseptionRer,
            disable_network_assignment: true,
            is_aviation_group: false,
            ai_transcript_analysis_enabled: false,
            fetch_new_messages: true,
            group_stats: SignalGroupStats::default(),
            admin_data: None,
            areas_of_responsibility: None,
            color_key: SignalGroupColor::Blue,
        };

        let json = serde_json::to_value(signal_group).unwrap();

        assert_eq!(json["interseption_kind"], json!("rer"));
        assert_eq!(json["is_rer"], json!(true));
        assert_eq!(json["disable_network_assignment"], json!(true));
        assert_eq!(json["fills_etalonka"], json!(false));
    }

    #[test]
    fn orphan_signal_group_entry_serializes_legacy_aliases() {
        let signal_group = OrphanSignalGroupEntry {
            is_sigint_unit_mandatory: false,
            is_device_mandatory: false,
            master_key: "group.1".to_string(),
            name: "Group 1".to_string(),
            ignore_operativny: false,
            interseption_kind: InterseptionKind::InterseptionOther,
            disable_network_assignment: false,
            is_aviation_group: false,
            ai_transcript_analysis_enabled: false,
            fetch_new_messages: true,
            is_archived: false,
            datasource_id: Some(1),
            created_at: 0,
            group_stats: SignalGroupStats::default(),
            group_admin_data: None,
            areas_of_responsibility: None,
            color_key: SignalGroupColor::Blue,
        };

        let json = serde_json::to_value(signal_group).unwrap();

        assert_eq!(json["interseption_kind"], json!("other"));
        assert_eq!(json["is_rer"], json!(false));
        assert_eq!(json["disable_network_assignment"], json!(false));
        assert_eq!(json["fills_etalonka"], json!(true));
    }
}
