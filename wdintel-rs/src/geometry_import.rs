use crate::h;
use crate::types::ShortContext;
use quick_xml::events::Event;
use quick_xml::Reader as XmlReader;
use std::fs::File;
use std::io::{self, Read, Seek};
use std::path::Path;
use tempfile::tempdir;
use tokio::fs;
use tokio::task;
use walkdir::WalkDir;
use zip::ZipArchive;

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

pub async fn parse_point_line_features(
    file_name: &str,
    data: &[u8],
) -> anyhow::Result<Vec<ImportedGeometryFeature>> {
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
) -> anyhow::Result<Vec<ImportedGeometryFeature>> {
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

    let mut features = vec![];
    for kml_path in kml_paths {
        features.extend(parse_kml_file(&kml_path).await.c(h!())?);
    }
    Ok(features)
}

fn extract_archive(path: &Path, extract_to: &Path) -> anyhow::Result<()> {
    let archive_file = File::open(path).c(h!())?;
    let mut archive = ZipArchive::new(archive_file)
        .map_err(|error| io::Error::other(format!("Zip error: {error:?}")))
        .c(h!())?;
    validate_archive_limits(
        &mut archive,
        crate::config::BATTLE_LINE_KMZ_MAX_ENTRIES,
        crate::config::BATTLE_LINE_KMZ_MAX_EXTRACTED_BYTES,
    )
    .c(h!())?;
    archive
        .extract(extract_to)
        .map_err(|error| {
            io::Error::other(format!("Extraction error: {error:?}"))
        })
        .c(h!())?;
    Ok(())
}

fn validate_archive_limits<R>(
    archive: &mut ZipArchive<R>,
    maximum_entries: usize,
    maximum_extracted_bytes: u64,
) -> anyhow::Result<()>
where
    R: Read + Seek,
{
    if archive.len() > maximum_entries {
        anyhow::bail!(
            "KMZ contains {} entries; the limit is {maximum_entries}",
            archive.len()
        );
    }
    let mut extracted_bytes = 0_u64;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| {
                io::Error::other(format!("Zip entry error: {error:?}"))
            })
            .c(h!())?;
        extracted_bytes = extracted_bytes.checked_add(entry.size()).c(h!())?;
        if extracted_bytes > maximum_extracted_bytes {
            anyhow::bail!(
                "KMZ expands to more than the {maximum_extracted_bytes} byte limit"
            );
        }
    }
    Ok(())
}

async fn parse_kml_file(
    path: &Path,
) -> anyhow::Result<Vec<ImportedGeometryFeature>> {
    let input = fs::read_to_string(path).await.c(h!())?;
    parse_kml_geometry(&input).c(h!())
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
}

struct PendingGeometry {
    kind: SupportedGeometryKind,
    element_depth: usize,
    coordinates: Option<String>,
}

fn parse_kml_geometry(
    input: &str,
) -> anyhow::Result<Vec<ImportedGeometryFeature>> {
    let mut reader = XmlReader::from_str(input);
    reader.config_mut().trim_text(false);
    let mut features = vec![];
    let mut element_stack: Vec<Vec<u8>> = vec![];
    let mut placemark_depth = 0_usize;
    let mut pending_geometry: Option<PendingGeometry> = None;
    loop {
        match reader.read_event().c(h!())? {
            Event::Start(element) => {
                let local_name = element.local_name();
                let name = local_name.as_ref();
                if name == b"coordinates" && pending_geometry.is_some() {
                    if let Some(pending_geometry) = pending_geometry.as_mut() {
                        if pending_geometry.coordinates.is_some() {
                            anyhow::bail!(
                                "KML geometry contains multiple coordinate elements"
                            );
                        }
                        pending_geometry.coordinates = Some(
                            reader
                                .read_text(element.to_end().name())
                                .c(h!())?
                                .into_owned(),
                        );
                    }
                    continue;
                }
                element_stack.push(name.to_vec());
                if name == b"Placemark" {
                    placemark_depth += 1;
                } else if placemark_depth > 0 {
                    if let Some(kind) =
                        SupportedGeometryKind::from_element_name(name)
                    {
                        if pending_geometry.is_some() {
                            anyhow::bail!(
                                "KML contains nested supported geometries"
                            );
                        }
                        pending_geometry = Some(PendingGeometry {
                            kind,
                            element_depth: element_stack.len(),
                            coordinates: None,
                        });
                    }
                }
            }
            Event::Empty(element) => {
                let local_name = element.local_name();
                let name = local_name.as_ref();
                if name == b"coordinates" && pending_geometry.is_some() {
                    pending_geometry.as_mut().c(h!())?.coordinates =
                        Some(String::new());
                } else if placemark_depth > 0
                    && SupportedGeometryKind::from_element_name(name).is_some()
                {
                    continue;
                }
            }
            Event::End(element) => {
                let local_name = element.local_name();
                let name = local_name.as_ref();
                if let Some(pending) = pending_geometry.as_ref() {
                    if pending.element_depth == element_stack.len()
                        && SupportedGeometryKind::from_element_name(name)
                            == Some(pending.kind)
                    {
                        let pending = pending_geometry.take().c(h!())?;
                        let Some(coordinates) = pending.coordinates else {
                            element_stack.pop();
                            continue;
                        };
                        if coordinates.trim().is_empty() {
                            element_stack.pop();
                            continue;
                        }
                        match pending.kind {
                            SupportedGeometryKind::Point => {
                                collect_points(&coordinates, &mut features)
                                    .c(h!())?;
                            }
                            SupportedGeometryKind::LineString => {
                                collect_line_string(
                                    &coordinates,
                                    &mut features,
                                )
                                .c(h!())?;
                            }
                        }
                    }
                }
                if name == b"Placemark" {
                    placemark_depth = placemark_depth.checked_sub(1).c(h!())?;
                }
                let started_name = element_stack.pop().c(h!())?;
                if started_name.as_slice() != name {
                    anyhow::bail!("KML element nesting is inconsistent");
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if pending_geometry.is_some()
        || !element_stack.is_empty()
        || placemark_depth != 0
    {
        anyhow::bail!("KML document ended inside a geometry or placemark");
    }
    Ok(features)
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
    use std::io::{Cursor, Write};
    use zip::write::SimpleFileOptions;

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
        let features = parse_point_line_features("battle-line.kml", kml)
            .await
            .unwrap();
        assert_eq!(
            features,
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
    }

    #[tokio::test]
    async fn ignores_empty_legacy_style_values() {
        let kml = br#"<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  <Style id="legacy"><IconStyle><scale/></IconStyle></Style>
  <Placemark><visibility/><ExtendedData><Point/></ExtendedData><Point><coordinates>31,49,0</coordinates></Point></Placemark>
</Document></kml>"#;

        assert_eq!(
            parse_point_line_features("legacy.kml", kml).await.unwrap(),
            vec![ImportedGeometryFeature::Point(ImportedCoordinate {
                lat: 49.0,
                lon: 31.0,
            })]
        );
    }

    #[tokio::test]
    async fn ignores_empty_geometry_placeholders() {
        let kml = br#"<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark>
  <Point/><LineString></LineString>
  <Point><coordinates>31,49,0</coordinates></Point>
</Placemark></Document></kml>"#;

        assert_eq!(
            parse_point_line_features("legacy.kml", kml).await.unwrap(),
            vec![ImportedGeometryFeature::Point(ImportedCoordinate {
                lat: 49.0,
                lon: 31.0,
            })]
        );
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

        let features = parse_point_line_features("battle-line.kml", kml)
            .await
            .unwrap();

        assert_eq!(
            features,
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
    }
}
