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

impl PalitraAccess {
    pub fn is_empty(&self) -> bool {
        match self {
            PalitraAccess::ByLogins { logins } => logins.is_empty(),
            PalitraAccess::ByOrganisms { organism_ids } => {
                organism_ids.is_empty()
            }
            PalitraAccess::ByAor { aor_ids } => aor_ids.is_empty(),
        }
    }
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Palitra {
    pub id: i64,
    pub name: String,
    pub folder: Option<String>,
    pub is_archived: bool,
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
    pub center: Option<Coords>,
    pub perimeter_linear_ring: Option<Vec<Coords>>,
    pub line_strings: Option<Vec<Vec<Coords>>>,
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
pub struct PalitraGeometryDetails {
    pub id: i64,
    pub color_hex: String,
    pub source_file_name: Option<String>,
    pub last_uploaded_at_ts: Option<i64>,
    pub geometry: Option<Geometry>,
    pub points: Vec<PalitraPoint>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct PalitraReadV2 {
    pub palitra: Palitra,
    pub geometries: Vec<PalitraGeometryDetails>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UpdatePalitraV2Req {
    pub geometry_id: i64,
    pub name: String,
    pub color_hex: String,
    pub access: PalitraAccess,
    pub source_file_name: Option<String>,
    pub last_uploaded_at_ts: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct PalitraPoint {
    pub coords: Coords,
    pub label: Option<String>,
    pub color: Option<String>,
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
pub struct PalitraSearchPointsReq {
    pub palitra_ids: Vec<i64>,
    pub point_labels: Vec<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct PalitraPointLabelSuggestReq {
    pub palitra_ids: Vec<i64>,
    pub prefix: String,
    pub limit: Option<u64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct PalitraPointLabelSuggestRsp {
    pub palitra_id: i64,
    pub label: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct PalitraPoints {
    pub palitra_id: i64,
    pub points: Vec<PalitraPoint>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct KmzColorInfo {
    pub color_hex: String,
    pub count: i32,
    pub suggested_suffix: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct AnalyzeKmzResponse {
    pub top_colors: Vec<KmzColorInfo>,
    pub filename: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct PalitraFolderAssignReq {
    pub palitra_ids: Vec<i64>,
    pub folder: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct PalitraFolderRenameReq {
    pub from_folder: String,
    pub to_folder: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct PalitraFolderReq {
    pub folder: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct PalitraDownloadReq {
    pub palitra_ids: Vec<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct PalitraBulkActionRsp {
    pub palitra_ids: Vec<i64>,
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

    pub fn list_from_kml_coordinates(
        coordinates: &str,
    ) -> anyhow::Result<Vec<Coords>> {
        let mut result = Vec::new();
        let mut first_error: Option<anyhow::Error> = None;
        for token in coordinates.split_whitespace() {
            let token = token.trim();
            if token.is_empty() {
                continue;
            }
            match Coords::from_csv(token) {
                Ok(coords) => result.push(coords),
                Err(e) => {
                    if first_error.is_none() {
                        first_error = Some(e);
                    }
                }
            }
        }
        if result.is_empty() {
            return Err(first_error.unwrap_or_else(|| {
                anyhow::anyhow!("bad coordinates: {coordinates}")
            }));
        }
        Ok(result)
    }
}

/// Converts KML color format (AABBGGRR) to hex color (#RRGGBB)
/// KML color format: alpha, blue, green, red (each 2 hex digits)
/// Returns hex color without alpha channel
pub fn kml_color_to_hex(kml_color: &str) -> anyhow::Result<String> {
    let color = kml_color.trim().trim_start_matches('#');

    // KML colors should be 8 characters: AABBGGRR
    if color.len() != 8 {
        anyhow::bail!("Invalid KML color format: {}", color);
    }

    // Parse each 2-character hex pair manually
    let parse_hex_pair =
        |s: &str| -> anyhow::Result<u8> { u8::from_str_radix(s, 16).c(h!()) };

    let _alpha = parse_hex_pair(&color[0..2])?;
    let blue = parse_hex_pair(&color[2..4])?;
    let green = parse_hex_pair(&color[4..6])?;
    let red = parse_hex_pair(&color[6..8])?;

    // KML format: AABBGGRR -> Convert to #RRGGBB
    Ok(format!("#{:02x}{:02x}{:02x}", red, green, blue))
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

    #[test]
    fn parses_multiple_kml_coordinates() {
        let coords =
            Coords::list_from_kml_coordinates("30.5,50.4,0 31.1,49.9,0")
                .expect("parse coords list");
        assert_eq!(coords.len(), 2);
        assert_eq!(coords[0].lat, 50.4);
        assert_eq!(coords[0].lng, 30.5);
        assert_eq!(coords[1].lat, 49.9);
        assert_eq!(coords[1].lng, 31.1);
    }

    #[test]
    fn converts_kml_abgr_color_with_optional_hash() {
        assert_eq!(kml_color_to_hex("ff00ffff").unwrap(), "#ffff00");
        assert_eq!(kml_color_to_hex("#FF00FFFF").unwrap(), "#ffff00");
    }
}
