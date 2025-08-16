use crate::rer_importer::types::GroupAdminData;
use crate::rer_importer::types::SignalGroupStats;
use crate::sigint::area_of_responsibility::types::AreaOfResponsibility;
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
