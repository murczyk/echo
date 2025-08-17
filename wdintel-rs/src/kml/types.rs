use elm_rs::{Elm, ElmDecode, ElmEncode};
use serde::{Deserialize, Serialize};

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Tessellate {
    #[serde(rename = "$value")]
    pub body: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Coordinates {
    #[serde(rename = "$value")]
    pub body: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct LineString {
    pub tessellate: Option<Tessellate>,
    pub coordinates: Option<Coordinates>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Point {
    #[serde(rename = "drawOrder")]
    pub draw_order: Option<String>,
    pub coordinates: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct LinearRing {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coordinates: Option<Coordinates>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct OuterBoundaryIs {
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "LinearRing")]
    pub linear_ring: Option<LinearRing>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Polygon {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tessellate: Option<Tessellate>,
    #[serde(rename = "outerBoundaryIs")]
    pub outer_boundary_is: Option<OuterBoundaryIs>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Value {
    #[serde(rename = "$value")]
    pub body: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Data {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ExtendedData {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Data>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MultiGeometry {
    #[serde(rename = "LineString", default)]
    pub line_strings: Vec<LineString>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Placemark {
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "Snippet", default)]
    pub snippet: Option<Snippet>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "snippet", default)]
    pub snippet_lower: Option<String>,
    pub visibility: Option<Visibility>,
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "styleUrl")]
    pub style_url: Option<StyleUrl>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "Style")]
    pub style: Option<Style>,
    #[serde(rename = "Point")]
    pub point: Option<Point>,
    #[serde(rename = "LineString")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_string: Option<LineString>,
    #[serde(rename = "MultiGeometry")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub multi_geometry: Option<MultiGeometry>,
    #[serde(rename = "Polygon")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub polygon: Option<Polygon>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "ExtendedData")]
    pub extended_data: Option<ExtendedData>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Scale {
    #[serde(rename = "$value")]
    pub body: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Href {
    #[serde(rename = "$value")]
    pub body: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Icon {
    pub href: Option<Href>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct LabelStyle {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scale: Option<Scale>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct IconStyle {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scale: Option<Scale>,
    #[serde(rename = "Icon")]
    pub icon: Option<Icon>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Text {
    #[serde(rename = "$value")]
    pub body: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct BalloonStyle {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<Text>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Color {
    #[serde(rename = "$value")]
    pub body: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Width {
    #[serde(rename = "$value")]
    pub body: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct LineStyle {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<Color>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<Width>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct PolyStyle {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<Color>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Style {
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "@id")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "IconStyle")]
    pub icon_style: Option<IconStyle>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "LabelStyle")]
    pub label_style: Option<LabelStyle>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "BalloonStyle")]
    pub balloon_style: Option<BalloonStyle>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "LineStyle")]
    pub line_style: Option<LineStyle>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "PolyStyle")]
    pub poly_style: Option<PolyStyle>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CascadingStyle {
    #[serde(rename = "Style")]
    pub style: Option<Style>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct StyleUrl {
    #[serde(rename = "$value")]
    pub body: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename = "key")]
pub struct Key {
    #[serde(rename = "$value")]
    pub body: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Pair {
    pub key: Key,
    #[serde(rename = "styleUrl")]
    pub style_url: StyleUrl,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct StyleMap {
    #[serde(rename = "@id")]
    pub id: Option<String>,
    #[serde(rename = "Pair")]
    pub pairs: Vec<Pair>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Name {
    #[serde(rename = "$value")]
    pub body: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Open {
    #[serde(rename = "$value")]
    pub body: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Visibility {
    #[serde(rename = "$value")]
    pub body: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Snippet {
    #[serde(rename = "@maxLines")]
    pub max_lines: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Camera {
    pub longitude: Option<String>,
    pub latitude: Option<String>,
    // todo
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct LookAt {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub longitude: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latitude: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub altitude: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heading: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tilt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "gx:altitudeMode")]
    pub gx_altitude_mode: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct DisplayName {
    #[serde(rename = "$value")]
    pub body: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SimpleField {
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "@name")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "@type")]
    pub type_: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "displayName")]
    pub display_name: Option<DisplayName>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Schema {
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "@name")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "@id")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    #[serde(rename = "SimpleField")]
    pub simple_fields: Vec<SimpleField>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Folder {
    pub name: Option<Name>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "LookAt")]
    pub look_at: Option<LookAt>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open: Option<Open>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    #[serde(rename = "Style", default)]
    pub styles: Vec<Style>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    #[serde(rename = "StyleMap", default)]
    pub style_maps: Vec<StyleMap>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visibility: Option<Visibility>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "Snippet", default)]
    pub snippet: Option<Snippet>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "snippet", default)]
    pub snippet_lower: Option<String>,
    #[serde(rename = "$value", default)]
    pub nodes: Vec<Node>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "Link", default)]
    pub link: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "Camera", default)]
    pub camera: Option<Camera>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "gx:balloonVisibility", default)]
    pub gx_balloon_visibility: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    #[serde(rename = "Schema", default)]
    pub schema: Vec<Schema>,
}

impl Folder {
    pub fn name_s(&self) -> String {
        self.name
            .clone()
            .map(|x| x.body)
            .unwrap_or("<unknown>".to_string())
    }
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Document {
    pub name: Option<Name>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "LookAt")]
    pub look_at: Option<LookAt>,
    pub open: Option<Open>,
    #[serde(rename = "Style", default)]
    pub styles: Vec<Style>,
    #[serde(rename = "CascadingStyle", default)]
    pub cascading_styles: Vec<CascadingStyle>,
    #[serde(rename = "StyleMap", default)]
    pub style_maps: Vec<StyleMap>,
    pub visibility: Option<Visibility>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "Snippet", default)]
    pub snippet: Option<Snippet>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "snippet", default)]
    pub snippet_lower: Option<String>,
    #[serde(rename = "$value", default)]
    pub nodes: Vec<Node>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "Link", default)]
    pub link: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "Camera", default)]
    pub camera: Option<Camera>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "gx:balloonVisibility", default)]
    pub gx_balloon_visibility: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    #[serde(rename = "Schema", default)]
    pub schema: Vec<Schema>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Link {
    pub href: Option<Href>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NetworkLink {
    pub name: Option<Name>,
    pub visibility: Option<Visibility>,
    #[serde(rename = "Link", default)]
    pub link: Option<Link>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Author {
    pub name: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub enum Node {
    Folder(Folder),
    Document(Document),
    Placemark(Placemark),
    NetworkLink(NetworkLink),
    Style(Style),
    StyleMap(StyleMap),
    #[serde(rename = "author")]
    Author(Author),
    #[serde(rename = "CascadingStyle")]
    CascadingStyle(CascadingStyle),
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename = "kml")]
pub struct Kml {
    #[serde(rename = "$value", default)]
    pub nodes: Vec<Node>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Operatyvka {
    pub folders: Vec<Folder>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_style_id() {
        let input = r###"<Style id="sh_Логістика, БК50">
			<IconStyle>
				<scale>1.4</scale>
				<Icon>
					<href>C:/Users/Zip/Pictures/NATO/Логістика, БК/Логістика, БК.png</href>
				</Icon>
			</IconStyle>
		</Style>"###;
        let style: Style = quick_xml::de::from_str(input).unwrap();
        assert_eq!(style.id, Some("sh_Логістика, БК50".to_string()));
    }
}
