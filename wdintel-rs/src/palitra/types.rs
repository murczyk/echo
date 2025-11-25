use crate::h;
use crate::types::{Deserialize, Serialize, ShortContext};
use elm_rs::{Elm, ElmDecode, ElmEncode};

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Coords {
    pub lat: f64,
    pub lng: f64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CreatePalitraReq {
    pub name: String,
    pub color_hex: String,
    pub access: PalitraAccess,
    pub source_file_name: Option<String>,
    pub last_uploaded_at_ts: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub enum PalitraAccess {
    Global,
    ByLogins { logins: Vec<String> },
    ByOrganisms { organism_ids: Vec<i64> },
    ByAor { aor_ids: Vec<i64> },
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Palitra {
    pub id: i64,
    pub name: String,
    pub color_hex: String,
    pub author: Option<String>,
    pub source_file_name: Option<String>,
    pub last_uploaded_at_ts: Option<i64>,
    pub geometry: Option<Geometry>,
    pub access_aor_id: Vec<i64>,
    pub access_organism_ids: Vec<i64>,
    pub access_logins: Vec<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Geometry {
    pub center: Coords,
    pub perimeter_linear_ring: Vec<Coords>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct PalitraDetails {
    pub palitra: Palitra,
    pub points: Vec<PalitraPoint>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct PalitraPoint {
    pub coords: Coords,
    pub label: Option<String>,
}

impl Coords {
    pub fn from_csv(csv: &str) -> anyhow::Result<Coords> {
        let parts: Vec<&str> = csv.split(',').collect();
        if parts.len() < 2 {
            anyhow::bail!("bad coordinates: {csv}");
        }
        let lat = parts[0].trim().parse::<f64>().c(h!())?;
        let lng = parts[1].trim().parse::<f64>().c(h!())?;
        Ok(Coords { lat, lng })
    }
}
