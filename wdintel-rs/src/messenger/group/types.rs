use crate::sigint::aor::types::AreaOfResponsibility;
use crate::sigint::types::InterseptionKind;
use crate::types::*;
use elm_rs::{Elm, ElmDecode, ElmEncode};
use serde::ser::SerializeStruct;

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
    pub is_archived: bool,
    /// Ідентифікатор джерела даних, з якого походить група (може бути None)
    pub datasource_id: Option<i64>,
    /// Час створення групи (в мілісекундах від epoch)
    pub created_at: i64,
    pub group_stats: SignalGroupStats,
    pub group_admin_data: Option<GroupAdminData>,
    pub areas_of_responsibility: Option<Vec<AreaOfResponsibility>>,
}

#[derive(Debug, Deserialize, Elm, ElmEncode, ElmDecode, PartialEq, Clone)]
pub struct SignalGroupEntry {
    pub master_key: String,
    pub name: String,
    pub ignore_operativny: bool,
    pub interseption_kind: InterseptionKind,
    pub disable_network_assignment: bool,
    pub group_stats: SignalGroupStats,
    pub admin_data: Option<GroupAdminData>,
    pub areas_of_responsibility: Option<Vec<AreaOfResponsibility>>,
}

impl Serialize for OrphanSignalGroupEntry {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut state =
            serializer.serialize_struct("OrphanSignalGroupEntry", 13)?;
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
        state.end()
    }
}

impl Serialize for SignalGroupEntry {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut state = serializer.serialize_struct("SignalGroupEntry", 10)?;
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
    fn signal_group_entry_serializes_legacy_aliases() {
        let signal_group = SignalGroupEntry {
            master_key: "group.1".to_string(),
            name: "Group 1".to_string(),
            ignore_operativny: false,
            interseption_kind: InterseptionKind::InterseptionRer,
            disable_network_assignment: true,
            group_stats: SignalGroupStats::default(),
            admin_data: None,
            areas_of_responsibility: None,
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
            master_key: "group.1".to_string(),
            name: "Group 1".to_string(),
            ignore_operativny: false,
            interseption_kind: InterseptionKind::InterseptionOther,
            disable_network_assignment: false,
            is_archived: false,
            datasource_id: Some(1),
            created_at: 0,
            group_stats: SignalGroupStats::default(),
            group_admin_data: None,
            areas_of_responsibility: None,
        };

        let json = serde_json::to_value(signal_group).unwrap();

        assert_eq!(json["interseption_kind"], json!("other"));
        assert_eq!(json["is_rer"], json!(false));
        assert_eq!(json["disable_network_assignment"], json!(false));
        assert_eq!(json["fills_etalonka"], json!(true));
    }
}
