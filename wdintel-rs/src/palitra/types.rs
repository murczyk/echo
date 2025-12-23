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

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ViewportBounds {
    pub min_lat: f64,
    pub min_lng: f64,
    pub max_lat: f64,
    pub max_lng: f64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct PalitraPointsReq {
    pub palitra_ids: Vec<i64>,
    pub viewport_bounds: ViewportBounds,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct PalitraPoints {
    pub palitra_id: i64,
    pub points: Vec<PalitraPoint>,
}

impl Coords {
    pub fn from_csv(csv: &str) -> anyhow::Result<Coords> {
        // KML stores coordinates as "lon,lat[,alt]" so parse in that order.
        let mut parts = csv.split(',').map(str::trim);
        let lng = parts
            .next()
            .ok_or_else(|| anyhow::anyhow!("bad coordinates: {csv}"))?
            .parse::<f64>()
            .c(h!())?;
        let lat = parts
            .next()
            .ok_or_else(|| anyhow::anyhow!("bad coordinates: {csv}"))?
            .parse::<f64>()
            .c(h!())?;
        Ok(Coords { lat, lng })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_kml_lon_lat_order() {
        let coords = Coords::from_csv("30.5,50.4,0").expect("parse coords");
        assert_eq!(coords.lat, 50.4);
        assert_eq!(coords.lng, 30.5);
    }

    #[test]
    fn trims_whitespace_in_coordinates() {
        let coords =
            Coords::from_csv("  31.1234 ,  49.9876 ").expect("parse coords");
        assert_eq!(coords.lat, 49.9876);
        assert_eq!(coords.lng, 31.1234);
    }
}
