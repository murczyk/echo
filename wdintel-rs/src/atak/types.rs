use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct Parameter {
    #[serde(rename = "@name")]
    pub name: String,
    #[serde(rename = "@value")]
    pub value: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct Content {
    #[serde(rename = "@ignore")]
    pub ignore: String,
    #[serde(rename = "@zipEntry")]
    pub zip_entry: String,
    #[serde(rename = "Parameter")]
    pub parameters: Vec<Parameter>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct Contents {
    #[serde(rename = "Content")]
    pub contents: Vec<Content>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct Configuration {
    #[serde(rename = "Parameter")]
    pub parameters: Vec<Parameter>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct MissionPackageManifest {
    #[serde(rename = "@version")]
    pub version: String,
    #[serde(rename = "Configuration")]
    pub configuration: Configuration,
    #[serde(rename = "Contents")]
    pub contents: Contents,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
#[serde(rename = "point")]
pub struct Point {
    #[serde(rename = "@lat")]
    pub lat: String,
    #[serde(rename = "@lon")]
    pub lon: String,
    #[serde(rename = "@hae")]
    pub hae: String,
    #[serde(rename = "@ce")]
    pub ce: String,
    #[serde(rename = "@le")]
    pub le: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
#[serde(rename = "status")]
pub struct Status {
    #[serde(rename = "@readiness")]
    pub readiness: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
#[serde(rename = "archive")]
pub struct Archive {}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
#[serde(rename = "remarks")]
pub struct Remarks {
    #[serde(rename = "$value")]
    pub body: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
#[serde(rename = "link")]
pub struct Link {
    #[serde(rename = "@uid")]
    pub uid: String,
    #[serde(rename = "@production_time")]
    pub production_time: String,
    #[serde(rename = "@type")]
    pub type_: String,
    #[serde(rename = "@parent_callsign")]
    pub parent_callsign: String,
    #[serde(rename = "@relation")]
    pub relation: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
#[serde(rename = "color")]
pub struct Color {
    #[serde(rename = "@argb")]
    pub argb: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
#[serde(rename = "precisionlocation")]
pub struct Precisionlocation {
    #[serde(rename = "@altsrc")]
    pub altsrc: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
#[serde(rename = "usericon")]
pub struct Usericon {
    #[serde(rename = "@iconsetpath")]
    pub iconsetpath: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
#[serde(rename = "contact")]
pub struct Contact {
    #[serde(rename = "@callsign")]
    pub callsign: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
#[serde(rename = "detail")]
pub struct Detail {
    pub status: Status,
    pub remarks: Remarks,
    #[serde(rename = "archive")]
    pub archives: Vec<Archive>,
    pub link: Link,
    pub color: Color,
    pub precisionlocation: Precisionlocation,
    pub usericon: Usericon,
    pub contact: Contact,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
#[serde(rename = "event")]
pub struct Event {
    #[serde(rename = "@version")]
    pub version: String,
    #[serde(rename = "@uid")]
    pub uid: String,
    #[serde(rename = "@type")]
    pub type_: String,
    #[serde(rename = "@time")]
    pub time: String,
    #[serde(rename = "@start")]
    pub start: String,
    #[serde(rename = "@stale")]
    pub stale: String,
    #[serde(rename = "@how")]
    pub how: String,
    pub point: Point,
    pub detail: Detail,
}
