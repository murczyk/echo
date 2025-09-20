use crate::sigint::aor::types::AreaOfResponsibility;
use crate::types::*;
use elm_rs::{Elm, ElmDecode, ElmEncode};

/// Запис групи, яка не прив'язана до жодного напрямку
#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct OrphanSignalGroupEntry {
    /// Унікальний ідентифікатор групи
    pub master_key: String,
    /// Назва групи
    pub name: String,
    /// Прапорець, що вказує чи ігнорувати повідомлення в Оперативному
    pub ignore_operativny: bool,
    /// Ідентифікатор джерела даних, з якого походить група (може бути None)
    pub datasource_id: Option<i64>,
    /// Час створення групи (в мілісекундах від epoch)
    pub created_at: i64,
    pub group_stats: SignalGroupStats,
    pub group_admin_data: Option<GroupAdminData>,
    pub areas_of_responsibility: Option<Vec<AreaOfResponsibility>>,
}

#[derive(
    Debug, Serialize, Deserialize, Elm, ElmEncode, ElmDecode, PartialEq, Clone,
)]
pub struct SignalGroupEntry {
    pub master_key: String,
    pub name: String,
    pub ignore_operativny: bool,
    pub group_stats: SignalGroupStats,
    pub admin_data: Option<GroupAdminData>,
    pub areas_of_responsibility: Option<Vec<AreaOfResponsibility>>,
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
