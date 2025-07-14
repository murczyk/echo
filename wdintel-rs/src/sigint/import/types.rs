use crate::entities::*;
use crate::types::{Deserialize, Serialize};
use std::str::FromStr;

#[derive(Serialize, Deserialize, Clone)]
pub struct EtalonData {
    pub sigint_signal: Vec<sigint_signal::Model>,
    pub sigint_signal_changelog: Vec<sigint_signal_changelog::Model>,
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
