use crate::entities::*;
use crate::types::*;
use sea_orm::*;

pub struct UnitData {
    pub data: HashMap<Tab, Vec<UnitRow>>,
    pub models: HashMap<i32, sigint_unit::Model>,
}

pub struct NetworkData {
    pub data: HashMap<Tab, Vec<UnitRow>>,
    pub models: HashMap<i32, (sigint_unit::Model, Vec<sigint_network_unit::Model>)>,
}

#[derive(Clone)]
pub struct UnitRow {
    pub recording: UnitRec,
    pub target: Option<UnitRec>,
    pub target_candidates: Vec<UnitRec>,
}

#[derive(Clone, Debug)]
pub struct UnitRec {
    pub id: i64,
    pub full_name: String,
}

impl UnitRec {
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
