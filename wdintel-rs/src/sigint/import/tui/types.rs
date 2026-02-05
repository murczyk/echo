use crate::entities::*;
use crate::types::*;
use sea_orm::*;

pub struct UnitData {
    pub data: HashMap<Tab, Vec<DataRow>>,
    pub models: HashMap<i64, sigint_unit::Model>,
    pub perfect_matches: Vec<Vec<i64>>,
}

pub struct NetworkData {
    pub data: HashMap<Tab, Vec<DataRow>>,
    pub models: HashMap<i64, sigint_network::Model>,
    pub model_to_unit_id: HashMap<i64, i64>,
    pub perfect_matches: Vec<Vec<i64>>,
}

#[derive(Clone)]
pub struct DataRow {
    pub recording: DataRec,
    pub target: Option<DataRec>,
    pub target_candidates: Vec<DataRec>,
}

#[derive(Clone, Debug)]
pub struct DataRec {
    pub id: i64,
    pub full_name: String,
}

#[derive(Clone, Debug)]
pub struct DataRecDetailed {
    pub id: i64,
    pub full_name: String,
    pub details: HashMap<String, String>,
}

impl DataRec {
    pub fn render(&self) -> String {
        format!(" [{}] {}", self.id, self.full_name)
    }
}

#[derive(
    EnumIter, Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Debug, Hash,
)]
pub enum Tab {
    New,
    Matched,
    Ignore,
}

pub enum Action {
    ScrollUp,
    ScrollDown,
    ScrollLeft,
    ScrollRight,
    PageUp,
    PageDown,
}

impl Tab {
    pub fn next_tab(tab: Tab, is_fwd: bool) -> Tab {
        let tabs: Vec<_> = Tab::iter().collect();
        let idx = tabs.iter().position(|&t| t == tab).unwrap_or(0);
        let tabs_quantity = tabs.len();
        let new_idx = if is_fwd {
            idx + 1
        } else {
            idx + tabs_quantity - 1
        };
        tabs[new_idx % tabs_quantity]
    }
}
