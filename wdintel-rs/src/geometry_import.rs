use crate::h;
use crate::types::ShortContext;
use quick_xml::events::{BytesEnd, BytesStart, Event};
use quick_xml::name::ResolveResult;
use quick_xml::NsReader as XmlReader;
use std::path::Path;
use tempfile::tempdir;
use tokio::fs;
use tokio::task;
use walkdir::WalkDir;

#[derive(Clone, Debug, PartialEq)]
pub struct ImportedCoordinate {
    pub lat: f64,
    pub lon: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ImportedGeometryFeature {
    Point(ImportedCoordinate),
    LineString(Vec<ImportedCoordinate>),
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ParsedPointLineFeatures {
    pub features: Vec<ImportedGeometryFeature>,
    pub empty_point_count: usize,
    pub empty_line_string_count: usize,
}

pub async fn parse_point_line_features(
    file_name: &str,
    data: &[u8],
) -> anyhow::Result<ParsedPointLineFeatures> {
    let safe_file_name = sanitize_upload_filename(file_name);
    let temp_dir = tempdir().c(h!())?;
    let path = temp_dir.path().join(&safe_file_name);
    fs::write(&path, data).await.c(h!())?;
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match extension.as_str() {
        "kml" => parse_kml_file(&path).await.c(h!()),
        "kmz" => parse_kmz_file(&path).await.c(h!()),
        _ => anyhow::bail!("Unsupported coordinates extension: {extension}"),
    }
}

pub fn sanitize_upload_filename(file_name: &str) -> String {
    Path::new(file_name)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("battle-line.kml")
        .to_string()
}

async fn parse_kmz_file(
    path: &Path,
) -> anyhow::Result<ParsedPointLineFeatures> {
    let temp_dir = tempdir().c(h!())?;
    let extract_to = temp_dir.path().to_path_buf();
    let archive_path = path.to_path_buf();
    task::spawn_blocking(move || extract_archive(&archive_path, &extract_to))
        .await
        .c(h!())?
        .c(h!())?;

    let mut kml_paths = WalkDir::new(temp_dir.path())
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.into_path())
        .filter(|path| {
            path.extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("kml"))
        })
        .collect::<Vec<_>>();
    kml_paths.sort();

    let mut parsed = ParsedPointLineFeatures::default();
    for kml_path in kml_paths {
        let kml = parse_kml_file(&kml_path).await.c(h!())?;
        parsed.features.extend(kml.features);
        parsed.empty_point_count += kml.empty_point_count;
        parsed.empty_line_string_count += kml.empty_line_string_count;
    }
    Ok(parsed)
}

fn extract_archive(path: &Path, extract_to: &Path) -> anyhow::Result<()> {
    crate::utils::zip::unzip_to_limited(
        path,
        extract_to,
        crate::config::BATTLE_LINE_KMZ_MAX_ENTRIES,
        crate::config::BATTLE_LINE_KMZ_MAX_EXTRACTED_BYTES,
    )
    .c(h!())
}

async fn parse_kml_file(
    path: &Path,
) -> anyhow::Result<ParsedPointLineFeatures> {
    let bytes = fs::read(path).await.c(h!())?;
    let input = std::str::from_utf8(&bytes)
        .map_err(|error| crate::error::AppError::BL {
            msg: format!("Invalid KML encoding: {error}"),
        })
        .c(h!())?;
    parse_kml_geometry(input)
        .map_err(|error| crate::error::AppError::BL {
            msg: format!("Invalid KML geometry: {error}"),
        })
        .c(h!())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SupportedGeometryKind {
    Point,
    LineString,
}

impl SupportedGeometryKind {
    fn from_element_name(name: &[u8]) -> Option<Self> {
        match name {
            b"Point" => Some(Self::Point),
            b"LineString" => Some(Self::LineString),
            _ => None,
        }
    }

    fn element_name(self) -> &'static [u8] {
        match self {
            Self::Point => b"Point",
            Self::LineString => b"LineString",
        }
    }
}

struct PendingGeometry {
    kind: SupportedGeometryKind,
    element_depth: usize,
    coordinates: Option<String>,
    coordinates_depth: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum ElementNamespace {
    Unbound,
    Bound(Vec<u8>),
}

#[derive(Debug)]
struct KmlElementFrame {
    qualified_name: Vec<u8>,
    local_name: Vec<u8>,
    namespace: ElementNamespace,
}

#[derive(Default)]
struct KmlGeometryParser {
    parsed: ParsedPointLineFeatures,
    element_stack: Vec<KmlElementFrame>,
    kml_namespace: Option<ElementNamespace>,
    pending_geometry: Option<PendingGeometry>,
}

impl KmlGeometryParser {
    fn handle_start(
        &mut self,
        namespace: ResolveResult<'_>,
        element: BytesStart<'_>,
    ) -> anyhow::Result<()> {
        let namespace = own_namespace(namespace).c(h!())?;
        let local_name = element.local_name().as_ref().to_vec();
        let is_kml = self.is_kml_element(&namespace, &local_name).c(h!())?;
        if is_kml
            && local_name == b"coordinates"
            && self.coordinates_are_direct_geometry_child()
        {
            let pending = self.pending_geometry.as_mut().c(h!())?;
            if pending.coordinates.is_some() {
                anyhow::bail!(
                    "KML geometry contains multiple coordinate elements"
                );
            }
            pending.coordinates = Some(String::new());
            pending.coordinates_depth = Some(self.element_stack.len() + 1);
        }
        let kind = is_kml
            .then(|| SupportedGeometryKind::from_element_name(&local_name))
            .flatten()
            .filter(|_| {
                geometry_has_supported_parent(
                    &self.element_stack,
                    self.kml_namespace.as_ref().expect("set"),
                )
            });
        self.element_stack.push(KmlElementFrame {
            qualified_name: element.name().as_ref().to_vec(),
            local_name,
            namespace,
        });
        if let Some(kind) = kind {
            if self.pending_geometry.is_some() {
                anyhow::bail!("KML contains nested supported geometries");
            }
            self.pending_geometry = Some(PendingGeometry {
                kind,
                element_depth: self.element_stack.len(),
                coordinates: None,
                coordinates_depth: None,
            });
        }
        Ok(())
    }

    fn handle_empty(
        &mut self,
        namespace: ResolveResult<'_>,
        element: BytesStart<'_>,
    ) -> anyhow::Result<()> {
        let namespace = own_namespace(namespace).c(h!())?;
        let local_name = element.local_name();
        let local_name = local_name.as_ref();
        let is_kml = self.is_kml_element(&namespace, local_name).c(h!())?;
        if !is_kml {
            return Ok(());
        }
        if local_name == b"coordinates"
            && self.coordinates_are_direct_geometry_child()
        {
            let pending = self.pending_geometry.as_mut().c(h!())?;
            if pending.coordinates.replace(String::new()).is_some() {
                anyhow::bail!(
                    "KML geometry contains multiple coordinate elements"
                );
            }
        } else if let Some(kind) =
            SupportedGeometryKind::from_element_name(local_name).filter(|_| {
                geometry_has_supported_parent(
                    &self.element_stack,
                    self.kml_namespace.as_ref().expect("set"),
                )
            })
        {
            record_empty_geometry(kind, &mut self.parsed);
        }
        Ok(())
    }

    fn handle_end(
        &mut self,
        namespace: ResolveResult<'_>,
        element: BytesEnd<'_>,
    ) -> anyhow::Result<()> {
        let namespace = own_namespace(namespace).c(h!())?;
        let frame = self.element_stack.last().c(h!())?;
        if frame.qualified_name.as_slice() != element.name().as_ref()
            || frame.namespace != namespace
        {
            anyhow::bail!("KML element nesting is inconsistent");
        }
        if self.pending_geometry.as_ref().is_some_and(|pending| {
            pending.coordinates_depth == Some(self.element_stack.len())
                && frame.local_name == b"coordinates"
        }) {
            self.pending_geometry.as_mut().c(h!())?.coordinates_depth = None;
        }
        if self.pending_geometry.as_ref().is_some_and(|pending| {
            pending.element_depth == self.element_stack.len()
                && frame.local_name == pending.kind.element_name()
        }) {
            self.finish_geometry().c(h!())?;
        }
        self.element_stack.pop().c(h!())?;
        Ok(())
    }

    fn append_text(&mut self, text: &str) {
        let Some(pending) = self.pending_geometry.as_mut() else {
            return;
        };
        if pending.coordinates_depth == Some(self.element_stack.len()) {
            pending
                .coordinates
                .as_mut()
                .expect("set with depth")
                .push_str(text);
        }
    }

    fn finish_geometry(&mut self) -> anyhow::Result<()> {
        let pending = self.pending_geometry.take().c(h!())?;
        let Some(coordinates) = pending.coordinates else {
            record_empty_geometry(pending.kind, &mut self.parsed);
            return Ok(());
        };
        if coordinates.trim().is_empty() {
            record_empty_geometry(pending.kind, &mut self.parsed);
            return Ok(());
        }
        match pending.kind {
            SupportedGeometryKind::Point => {
                collect_points(&coordinates, &mut self.parsed.features)
                    .c(h!())?;
            }
            SupportedGeometryKind::LineString => {
                collect_line_string(&coordinates, &mut self.parsed.features)
                    .c(h!())?;
            }
        }
        Ok(())
    }

    fn coordinates_are_direct_geometry_child(&self) -> bool {
        let Some(pending) = self.pending_geometry.as_ref() else {
            return false;
        };
        pending.element_depth == self.element_stack.len()
            && self.element_stack.last().is_some_and(|frame| {
                frame.namespace == *self.kml_namespace.as_ref().expect("set")
                    && frame.local_name == pending.kind.element_name()
            })
    }

    fn is_kml_element(
        &mut self,
        namespace: &ElementNamespace,
        local_name: &[u8],
    ) -> anyhow::Result<bool> {
        if self.kml_namespace.is_none() {
            if local_name != b"kml" {
                anyhow::bail!("KML document must have a kml root element");
            }
            if !is_supported_kml_namespace(namespace) {
                anyhow::bail!("Unsupported KML namespace");
            }
            self.kml_namespace = Some(namespace.clone());
        }
        Ok(self.kml_namespace.as_ref() == Some(namespace))
    }

    fn finish(self) -> anyhow::Result<ParsedPointLineFeatures> {
        if self.kml_namespace.is_none() {
            anyhow::bail!("KML document has no root element");
        }
        if self.pending_geometry.is_some() || !self.element_stack.is_empty() {
            anyhow::bail!("KML document ended inside a geometry or placemark");
        }
        Ok(self.parsed)
    }
}

fn parse_kml_geometry(input: &str) -> anyhow::Result<ParsedPointLineFeatures> {
    let mut reader = XmlReader::from_str(input);
    reader.config_mut().trim_text(false);
    let mut parser = KmlGeometryParser::default();
    loop {
        match reader.read_resolved_event().c(h!())? {
            (namespace, Event::Start(element)) => {
                parser.handle_start(namespace, element).c(h!())?;
            }
            (namespace, Event::Empty(element)) => {
                parser.handle_empty(namespace, element).c(h!())?;
            }
            (namespace, Event::End(element)) => {
                parser.handle_end(namespace, element).c(h!())?;
            }
            (_, Event::Text(text)) => {
                let text = text.xml_content().c(h!())?;
                let text = quick_xml::escape::unescape(&text).c(h!())?;
                parser.append_text(&text);
            }
            (_, Event::CData(text)) => {
                parser.append_text(&text.xml_content().c(h!())?);
            }
            (_, Event::Eof) => break,
            _ => {}
        }
    }
    parser.finish().c(h!())
}

fn own_namespace(
    namespace: ResolveResult<'_>,
) -> anyhow::Result<ElementNamespace> {
    match namespace {
        ResolveResult::Unbound => Ok(ElementNamespace::Unbound),
        ResolveResult::Bound(namespace) => {
            Ok(ElementNamespace::Bound(namespace.as_ref().to_vec()))
        }
        ResolveResult::Unknown(prefix) => anyhow::bail!(
            "Unknown XML namespace prefix: {}",
            String::from_utf8_lossy(&prefix)
        ),
    }
}

fn is_supported_kml_namespace(namespace: &ElementNamespace) -> bool {
    const KML_NAMESPACES: [&[u8]; 4] = [
        b"http://www.opengis.net/kml/2.2",
        b"http://earth.google.com/kml/2.0",
        b"http://earth.google.com/kml/2.1",
        b"http://earth.google.com/kml/2.2",
    ];
    match namespace {
        ElementNamespace::Unbound => true,
        ElementNamespace::Bound(namespace) => {
            KML_NAMESPACES.contains(&namespace.as_slice())
        }
    }
}

fn geometry_has_supported_parent(
    element_stack: &[KmlElementFrame],
    kml_namespace: &ElementNamespace,
) -> bool {
    for frame in element_stack.iter().rev() {
        if &frame.namespace != kml_namespace {
            return false;
        }
        if frame.local_name == b"MultiGeometry" {
            continue;
        }
        return frame.local_name == b"Placemark";
    }
    false
}

fn record_empty_geometry(
    kind: SupportedGeometryKind,
    parsed: &mut ParsedPointLineFeatures,
) {
    match kind {
        SupportedGeometryKind::Point => parsed.empty_point_count += 1,
        SupportedGeometryKind::LineString => {
            parsed.empty_line_string_count += 1
        }
    }
}

fn collect_points(
    coordinates: &str,
    features: &mut Vec<ImportedGeometryFeature>,
) -> anyhow::Result<()> {
    let coordinates = parse_kml_coordinates_strict(coordinates).c(h!())?;
    if coordinates.len() != 1 {
        anyhow::bail!("KML Point must contain exactly one coordinate");
    }
    features.push(ImportedGeometryFeature::Point(
        coordinates.into_iter().next().c(h!())?,
    ));
    Ok(())
}

fn collect_line_string(
    coordinates: &str,
    features: &mut Vec<ImportedGeometryFeature>,
) -> anyhow::Result<()> {
    let coordinates = parse_kml_coordinates_strict(coordinates).c(h!())?;
    if coordinates.len() < 2 {
        anyhow::bail!("KML LineString must contain at least two coordinates");
    }
    features.push(ImportedGeometryFeature::LineString(coordinates));
    Ok(())
}

fn parse_kml_coordinates_strict(
    value: &str,
) -> anyhow::Result<Vec<ImportedCoordinate>> {
    let coordinates = value
        .split_whitespace()
        .map(parse_kml_coordinate)
        .collect::<anyhow::Result<Vec<_>>>()
        .c(h!())?;
    if coordinates.is_empty() {
        anyhow::bail!("empty KML coordinate list");
    }
    Ok(coordinates)
}

pub fn parse_kml_coordinate(value: &str) -> anyhow::Result<ImportedCoordinate> {
    let mut parts = value.split(',').map(str::trim);
    let lon = parts.next().c(h!())?.parse::<f64>().c(h!())?;
    let lat = parts.next().c(h!())?.parse::<f64>().c(h!())?;
    Ok(ImportedCoordinate { lat, lon })
}

pub fn parse_kml_coordinates_lenient(
    value: &str,
) -> anyhow::Result<Vec<ImportedCoordinate>> {
    let mut coordinates = vec![];
    let mut first_error = None;
    for token in value.split_whitespace().map(str::trim) {
        if token.is_empty() {
            continue;
        }
        match parse_kml_coordinate(token) {
            Ok(coordinate) => coordinates.push(coordinate),
            Err(error) if first_error.is_none() => first_error = Some(error),
            Err(_) => {}
        }
    }
    if coordinates.is_empty() {
        return Err(first_error
            .unwrap_or_else(|| anyhow::anyhow!("bad coordinates: {value}")));
    }
    Ok(coordinates)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::zip::validate_archive_limits;
    use std::io::{Cursor, Write};
    use zip::write::SimpleFileOptions;
    use zip::ZipArchive;

    #[test]
    fn parses_kml_coordinate_order() {
        let coordinate = parse_kml_coordinate("31.2,49.7,0").unwrap();
        assert_eq!(coordinate.lon, 31.2);
        assert_eq!(coordinate.lat, 49.7);
    }

    #[test]
    fn rejects_kmz_archives_over_entry_and_expanded_size_limits() {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for name in ["one.kml", "two.kml"] {
            writer
                .start_file(name, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(b"1234").unwrap();
        }
        let mut archive = ZipArchive::new(writer.finish().unwrap()).unwrap();

        assert!(validate_archive_limits(&mut archive, 1, 8).is_err());
        assert!(validate_archive_limits(&mut archive, 2, 7).is_err());
        validate_archive_limits(&mut archive, 2, 8).unwrap();
    }

    #[tokio::test]
    async fn imports_only_point_and_line_placemarks_in_source_order() {
        let kml = br#"<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  <Placemark><Point><coordinates>31,49,0</coordinates></Point></Placemark>
  <Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>30,48 31,48 30,48</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
  <Placemark><LineString><coordinates>32,50,0 33,51,0</coordinates></LineString></Placemark>
  <Placemark><MultiGeometry>
    <Point><coordinates>34,52,0</coordinates></Point>
    <LineString><coordinates>35,53,0 36,54,0</coordinates></LineString>
  </MultiGeometry></Placemark>
</Document></kml>"#;
        let parsed = parse_point_line_features("battle-line.kml", kml)
            .await
            .unwrap();
        assert_eq!(
            parsed.features,
            vec![
                ImportedGeometryFeature::Point(ImportedCoordinate {
                    lat: 49.0,
                    lon: 31.0,
                }),
                ImportedGeometryFeature::LineString(vec![
                    ImportedCoordinate {
                        lat: 50.0,
                        lon: 32.0,
                    },
                    ImportedCoordinate {
                        lat: 51.0,
                        lon: 33.0,
                    },
                ]),
                ImportedGeometryFeature::Point(ImportedCoordinate {
                    lat: 52.0,
                    lon: 34.0,
                }),
                ImportedGeometryFeature::LineString(vec![
                    ImportedCoordinate {
                        lat: 53.0,
                        lon: 35.0,
                    },
                    ImportedCoordinate {
                        lat: 54.0,
                        lon: 36.0,
                    },
                ]),
            ]
        );
        assert_eq!(parsed.empty_point_count, 0);
        assert_eq!(parsed.empty_line_string_count, 0);
    }

    #[tokio::test]
    async fn ignores_geometry_names_outside_kml_paths_and_namespace() {
        let kml = br#"<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:ext="https://example.com/extension"><Document>
  <Style id="legacy"><IconStyle><scale/></IconStyle></Style>
  <Placemark>
    <ExtendedData><Point><coordinates>20,40,0</coordinates></Point></ExtendedData>
    <ext:Point><ext:coordinates>21,41,0</ext:coordinates></ext:Point>
    <Point><coordinates>31,49,0</coordinates></Point>
  </Placemark>
</Document></kml>"#;

        let parsed =
            parse_point_line_features("legacy.kml", kml).await.unwrap();
        assert_eq!(
            parsed.features,
            vec![ImportedGeometryFeature::Point(ImportedCoordinate {
                lat: 49.0,
                lon: 31.0,
            })]
        );
        assert_eq!(parsed.empty_point_count, 0);
    }

    #[tokio::test]
    async fn ignores_empty_geometry_placeholders() {
        let kml = br#"<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark>
  <Point/><LineString></LineString>
  <Point><coordinates>31,49,0</coordinates></Point>
</Placemark></Document></kml>"#;

        let parsed =
            parse_point_line_features("legacy.kml", kml).await.unwrap();
        assert_eq!(
            parsed.features,
            vec![ImportedGeometryFeature::Point(ImportedCoordinate {
                lat: 49.0,
                lon: 31.0,
            })]
        );
        assert_eq!(parsed.empty_point_count, 1);
        assert_eq!(parsed.empty_line_string_count, 1);
    }

    #[tokio::test]
    async fn rejects_a_malformed_supported_geometry_instead_of_ignoring_it() {
        let kml = br#"<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  <Placemark><Point><coordinates>invalid</coordinates></Point></Placemark>
  <Placemark><LineString><coordinates>32,50,0 33,51,0</coordinates></LineString></Placemark>
</Document></kml>"#;

        assert!(parse_point_line_features("battle-line.kml", kml)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn rejects_a_point_with_multiple_coordinates() {
        let kml = br#"<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  <Placemark><Point><coordinates>31,49 36,50</coordinates></Point></Placemark>
</Document></kml>"#;

        assert!(parse_point_line_features("battle-line.kml", kml)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn imports_exporter_placeholders_with_empty_names_and_points() {
        let kml = br#"<kml><Document><name/><open/><visibility>1</visibility>
<Folder><name>-</name><Placemark><name/><visibility/><description/>
  <Point/>
  <MultiGeometry>
    <LineString><tessellate>1</tessellate><coordinates>31,49 32,50</coordinates></LineString>
  </MultiGeometry>
</Placemark></Folder></Document></kml>"#;

        let parsed = parse_point_line_features("battle-line.kml", kml)
            .await
            .unwrap();

        assert_eq!(
            parsed.features,
            vec![ImportedGeometryFeature::LineString(vec![
                ImportedCoordinate {
                    lat: 49.0,
                    lon: 31.0,
                },
                ImportedCoordinate {
                    lat: 50.0,
                    lon: 32.0,
                },
            ])]
        );
        assert_eq!(parsed.empty_point_count, 1);
    }
}
