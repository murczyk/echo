use crate::palitra::types::Coords;
use crate::types::{Deserialize, Serialize};
use elm_rs::{Elm, ElmDecode, ElmEncode};

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SignalMediaKmzConversionStatusRsp {
    pub status: String,
    pub error: Option<String>,
    pub converted_file_name: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SignalMediaKmzPreviewLineString {
    pub coords: Vec<Coords>,
    pub color: String,
    pub opacity: f64,
    pub label: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SignalMediaKmzPreviewPoint {
    pub coords: Coords,
    pub label: Option<String>,
    pub color: String,
    pub opacity: f64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SignalMediaKmzPreviewPolygon {
    /// The first ring is the exterior; remaining rings are holes.
    pub rings: Vec<Vec<Coords>>,
    pub stroke_color: String,
    pub stroke_opacity: f64,
    pub fill_color: String,
    pub fill_opacity: f64,
    pub label: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SignalMediaKmzPreviewRsp {
    pub points: Vec<SignalMediaKmzPreviewPoint>,
    pub line_strings: Vec<SignalMediaKmzPreviewLineString>,
    pub polygons: Vec<SignalMediaKmzPreviewPolygon>,
}
