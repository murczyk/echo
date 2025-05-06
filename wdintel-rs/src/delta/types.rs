use elm_rs::{Elm, ElmDecode, ElmEncode};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct CookieJson {
    pub domain: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "expirationDate")]
    pub expiration_date: Option<f64>,
    #[serde(rename = "hostOnly")]
    pub host_only: bool,
    #[serde(rename = "httpOnly")]
    pub http_only: bool,
    pub name: String,
    pub path: String,
    #[serde(rename = "sameSite")]
    pub same_site: String,
    pub secure: bool,
    pub session: bool,
    #[serde(rename = "storeId")]
    pub store_id: String,
    pub value: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct Properties {
    pub sidc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub comments: Vec<String>,
    // like "2023-06-06T13:20:12"
    pub observation_datetime: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct Geometry {
    #[serde(rename = "type")]
    pub type_: String,
    // (f64_lng, f64_lat) for point, Vec<(f64_lng, f64_lat)> for LineString
    pub coordinates: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct Feature {
    #[serde(rename = "type")]
    pub type_: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub properties: Option<Properties>,
    pub geometry: Geometry,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct GeoJson {
    #[serde(rename = "type")]
    pub type_: String,
    pub features: Vec<Feature>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct OverlayRsp {
    pub id: String,
    pub name: String,
    pub editable: bool,
    #[serde(rename = "objectIsDisplayedOn")]
    pub object_is_displayed_on: bool,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct VelocitySpeedRsp {}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct VelocityAbsoluteBearingAngleRsp {}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct ExtensionAnyRsp {
    #[serde(rename = "type")]
    pub type_: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "velocityAbsoluteBearingAngle")]
    pub velocity_absolute_bearing_angle:
        Option<VelocityAbsoluteBearingAngleRsp>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "velocitySpeed")]
    pub velocity_speed: Option<VelocitySpeedRsp>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct ExtensionRsp {
    pub any: Vec<ExtensionAnyRsp>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct AbsolutePointLatitudeCoordinateRsp {
    #[serde(rename = "latitudeCoordinateCoordinate")]
    pub latitude_coordinate_coordinate: f64,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct AbsolutePointLongitudeCoordinateRsp {
    #[serde(rename = "longitudeCoordinateCoordinate")]
    pub longitude_coordinate_coordinate: f64,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct AbsolutePointVerticalDistanceRsp {
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "verticalDistanceDimension")]
    pub vertical_distance_dimension: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct LocationGeometryRsp {
    #[serde(rename = "type")]
    pub type_: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extension: Option<Vec<ExtensionRsp>>,
    #[serde(rename = "absolutePointLatitudeCoordinate")]
    pub absolute_point_latitude_coordinate: AbsolutePointLatitudeCoordinateRsp,
    #[serde(rename = "absolutePointLongitudeCoordinate")]
    pub absolute_point_longitude_coordinate:
        AbsolutePointLongitudeCoordinateRsp,
    #[serde(rename = "absolutePointVerticalDistance")]
    pub absolute_point_vertical_distance: AbsolutePointVerticalDistanceRsp,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct LocationRsp {
    #[serde(rename = "locationGeometry")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location_geometry: Option<LocationGeometryRsp>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct SourceInfoRsp {
    #[serde(rename = "sourceType")]
    pub source_type: String,
    pub source: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct LocationReportRsp {
    #[serde(rename = "reportTimeStamp")]
    pub report_time_stamp: i64,
    pub location: LocationRsp,
    #[serde(rename = "sourceInfo")]
    pub source_info: SourceInfoRsp,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct AttachmentMetadataRsp {
    pub originname: String,
    pub owner: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct AttachmentRsp {
    pub id: String,
    pub collection: String,
    pub name: String,
    pub owner: String,
    #[serde(rename = "contentType")]
    pub content_type: String,
    pub size: i64,
    #[serde(rename = "lastModified")]
    pub last_modified: i64,
    pub metadata: AttachmentMetadataRsp,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct ObjectDetailInformationRsp {
    pub name: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub value: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct TRsp {
    pub value: String,
    #[serde(rename = "type")]
    pub type_: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct YRsp {
    pub value: String,
    #[serde(rename = "type")]
    pub type_: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct WRsp {
    pub value: String,
    #[serde(rename = "type")]
    pub type_: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct AmplifierFieldsRsp {
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "T")]
    pub t: Option<TRsp>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "Y")]
    pub y: Option<YRsp>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "W")]
    pub w: Option<WRsp>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct App6dRsp {
    pub sidc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "amplifierFields")]
    pub amplifier_fields: Option<AmplifierFieldsRsp>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct Milstd2525cRsp {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sidc: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "amplifierFields")]
    pub amplifier_fields: Option<AmplifierFieldsRsp>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct SymbolRsp {
    pub app6d: App6dRsp,
    pub milstd2525c: Option<Milstd2525cRsp>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct ObjectRsp {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(rename = "creatingDateTime")]
    pub creating_date_time: i64,
    #[serde(rename = "reportingDateTime")]
    pub reporting_date_time: i64,
    #[serde(rename = "observationDateTime")]
    pub observation_date_time: i64,
    #[serde(rename = "validityEndDateTime")]
    pub validity_end_date_time: i64,
    pub status: String,
    #[serde(rename = "reporterName")]
    pub reporter_name: String,
    #[serde(rename = "reporterPosition")]
    pub reporter_position: String,
    #[serde(rename = "reporterType")]
    pub reporter_type: String,
    #[serde(rename = "reporterOrganisation")]
    pub reporter_organisation: String,
    #[serde(rename = "creatorName")]
    pub creator_name: String,
    #[serde(rename = "creatorPosition")]
    pub creator_position: String,
    #[serde(rename = "creatorOrganisation")]
    pub creator_organisation: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comments: Option<Vec<String>>,
    pub overlays: Vec<OverlayRsp>,
    #[serde(rename = "locationReports")]
    pub location_reports: Vec<LocationReportRsp>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<AttachmentRsp>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "objectDetailInformation")]
    pub object_detail_information: Option<Vec<ObjectDetailInformationRsp>>,
    pub symbol: SymbolRsp,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct VelocityType {}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct ObjectContractGeometry {
    #[serde(rename = "type")]
    pub type_: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "absolutePointLatitudeCoordinate")]
    pub absolute_point_latitude_coordinate:
        Option<AbsolutePointLatitudeCoordinateRsp>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "absolutePointLongitudeCoordinate")]
    pub absolute_point_longitude_coordinate:
        Option<AbsolutePointLongitudeCoordinateRsp>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "absolutePointVerticalDistance")]
    pub absolute_point_vertical_distance:
        Option<AbsolutePointVerticalDistanceRsp>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "velocityType")]
    pub velocity_type: Option<VelocityType>,
    /// potentially use custom type, reuse for now to save time
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "linePoint")]
    pub line_point: Option<Vec<LocationGeometryRsp>>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct ObjectContractSource {
    pub id: String,
    pub name: String,
}

// org.c4isr.delta.contracts.model.ObjectContract
#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct ObjectContract {
    #[serde(rename = "type")]
    pub type_: Option<String>,
    pub id: String,
    pub name: Option<String>,
    #[serde(rename = "typeId")]
    pub type_id: Option<String>,
    #[serde(rename = "typeName")]
    pub type_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "parentTypeName")]
    pub parent_type_name: Option<String>,
    #[serde(rename = "layerId")]
    pub layer_id: String,
    #[serde(rename = "reportingDateTime")]
    pub reporting_date_time: i64,
    pub geometry: ObjectContractGeometry,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<ObjectContractSource>,
    pub symbol: SymbolRsp,
    #[serde(rename = "attachmentsCount")]
    pub attachments_count: Option<i64>,
    #[serde(rename = "layerList")]
    pub layer_list: Option<Vec<String>>,
    pub action: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Overlay {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    #[serde(rename = "semanticType")]
    pub semantic_type: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub admin: bool,
    pub writable: bool,
    pub ffi: bool,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct DownloadedLayer {
    pub folder_id: String,
    pub overlay_name: String,
    pub objs: Vec<ObjectContract>,
    pub obj_detail: BTreeMap<String, ObjectRsp>,
    pub obj_attachments: BTreeMap<String, Vec<String>>,
}

// example:
//
// "sidc","quantity","name","observation_datetime","reliability_credibility","staff_comments","platform_type","direction","speed","coordinates","comment 1"
// "10061500002001000000","","AR-2","2023-10-11T00:00:00","B3","","ELINT","","","POINT (37.083 47.5489)","11/10/2023 00:00 11.10.23 Пеленг AR-2 (Радіорозвідка)"

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct DeltaCsvRow {
    pub sidc: String,
    pub quantity: String,
    pub name: String,
    pub observation_datetime: String,
    pub reliability_credibility: String,
    pub staff_comments: String,
    pub platform_type: String,
    pub direction: String,
    pub speed: String,
    pub coordinates: String,
    #[serde(rename = "comment 1")]
    pub comment_1: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_object_rsp_01() {
        let input_s =
            std::fs::read_to_string("data/parse_object_rsp_01.json").unwrap();
        let _result: ObjectRsp = serde_json::from_str(&input_s).unwrap();
    }

    #[test]
    fn parse_object_rsp_02() {
        let input_s =
            std::fs::read_to_string("data/parse_object_rsp_02.json").unwrap();
        let _result: ObjectContract = serde_json::from_str(&input_s).unwrap();
    }

    #[test]
    fn parse_object_rsp_03() {
        let input_s =
            std::fs::read_to_string("data/parse_object_rsp_03.json").unwrap();
        let _result: ObjectRsp = serde_json::from_str(&input_s).unwrap();
    }

    #[test]
    fn parse_object_rsp_04() {
        let input_s = std::fs::read_to_string("data/object04.json").unwrap();
        let _result: Vec<ObjectContract> =
            serde_json::from_str(&input_s).unwrap();
    }

    #[test]
    fn parse_object_rsp_05() {
        let input_s =
            std::fs::read_to_string("data/parse_object_rsp_05.json").unwrap();
        let _result: ObjectRsp = serde_json::from_str(&input_s).unwrap();
    }

    #[test]
    fn parse_failing_object_contracts_one() {
        let input_s =
            std::fs::read_to_string("data/failing_object_1.json").unwrap();
        let _result: ObjectContract = serde_json::from_str(&input_s).unwrap();
    }

    #[test]
    fn parse_failing_object_contracts() {
        let input_s =
            std::fs::read_to_string("data/failing_object_contracts.json")
                .unwrap();
        let _result: Vec<ObjectContract> =
            serde_json::from_str(&input_s).unwrap();
    }

    #[test]
    fn parse_failing_object_contracts_02() {
        let input_s = std::fs::read_to_string(
            "data/parse_failing_object_contracts_02.json",
        )
        .unwrap();
        let _result: ObjectContract = serde_json::from_str(&input_s).unwrap();
    }

    #[test]
    fn parse_api_monitor_objects_01() {
        let input_s =
            std::fs::read_to_string("data/parse_api_monitor_objects_01.json")
                .unwrap();
        let _result: Vec<ObjectContract> =
            serde_json::from_str(&input_s).unwrap();
    }

    #[test]
    fn parse_api_monitor_objects_02() {
        let input_s =
            std::fs::read_to_string("data/parse_api_monitor_objects_02.json")
                .unwrap();
        let _result: Vec<ObjectContract> =
            serde_json::from_str(&input_s).unwrap();
    }

    #[test]
    fn parse_api_monitor_objects_03() {
        let input_s =
            std::fs::read_to_string("data/parse_api_monitor_objects_03.json")
                .unwrap();
        let _result: Vec<ObjectContract> =
            serde_json::from_str(&input_s).unwrap();
    }
}
