use crate::entities::*;
use crate::types::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt::Debug;

#[derive(Serialize, Deserialize, Clone)]
pub struct EtalonData {
    pub sigint_signal: Vec<sigint_signal::Model>,
    pub sigint_signal_changelog: Vec<sigint_signal_changelog::Model>,
    pub sigint_unit: Vec<sigint_unit::Model>,
    pub sigint_network: Vec<sigint_network::Model>,
    pub sigint_network_changelog: Vec<sigint_network_changelog::Model>,
    pub sigint_network_description: Vec<sigint_network_description::Model>,
    pub sigint_network_freq: Vec<sigint_network_freq::Model>,
    pub sigint_network_freq_changelog:
        Vec<sigint_network_freq_changelog::Model>,
    pub sigint_network_unit: Vec<sigint_network_unit::Model>,
    pub sigint_network_unit_changelog:
        Vec<sigint_network_unit_changelog::Model>,
    pub sigint_callsign: Vec<sigint_callsign::Model>,
    pub sigint_callsign_changelog: Vec<sigint_callsign_changelog::Model>,
    pub modulation: Vec<modulation::Model>,
    pub source: Vec<source::Model>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ImportResult<ID: Id> {
    pub ids_map: BTreeMap<ID, ID>,
    pub num_created: usize,
    pub num_updated: usize,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct EtalonImportResult {
    pub sigint_signal: ImportResult<i64>,
    pub sigint_signal_changelog: ImportResult<i64>,
    pub sigint_unit: ImportResult<i64>,
    pub sigint_network: ImportResult<i64>,
    pub sigint_network_changelog: ImportResult<i64>,
    pub sigint_network_description: ImportResult<i64>,
    pub sigint_network_freq: ImportResult<i64>,
    pub sigint_network_freq_changelog: ImportResult<i64>,
    pub sigint_network_unit: ImportResult<i64>,
    pub sigint_network_unit_changelog: ImportResult<i64>,
    pub sigint_callsign: ImportResult<i64>,
    pub sigint_callsign_changelog: ImportResult<i64>,
    pub modulation: ImportResult<i32>,
    pub source: ImportResult<i64>,
}

pub trait Id: Sized + Ord + Copy + Debug {}
impl Id for i32 {}
impl Id for i64 {}
