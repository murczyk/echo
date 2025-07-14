use crate::entities::*;
use crate::types::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone)]
pub struct EtalonData {
    pub sigint_signal: Vec<sigint_signal::Model>,
    pub sigint_signal_changelog: Vec<sigint_signal_changelog::Model>,
}
