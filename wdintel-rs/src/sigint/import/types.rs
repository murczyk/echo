use crate::entities::*;
use crate::types::{Deserialize, Serialize};
use std::str::FromStr;

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
    pub sigint_zone: Vec<sigint_zone::Model>,
    pub sigint_callsign: Vec<sigint_callsign::Model>,
    pub sigint_callsign_changelog: Vec<sigint_callsign_changelog::Model>,
}

#[derive(Debug)]

pub enum ImportType {
    FromMothership,
    ToMothership,
}

impl FromStr for ImportType {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "FromMothership" => Ok(ImportType::FromMothership),
            "ToMothership" => Ok(ImportType::ToMothership),
            _s => anyhow::bail!("unexpected import type: '{_s}', expected one of: FromMothership, ToMothership"),
        }
    }
}
