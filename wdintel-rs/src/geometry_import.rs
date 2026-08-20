use crate::h;
use crate::kml::types::{Node, Placemark};
use crate::types::ShortContext;
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
    let parent = path.parent().c(h!())?;
    let kml = crate::kml::read_and_fix_kml(false, path, parent)
        .await
        .c(h!())?;
    let mut features = vec![];
    collect_features(&kml.nodes, &mut features).c(h!())?;
    Ok(features)
}

fn collect_features(
    nodes: &[Node],
    features: &mut Vec<ImportedGeometryFeature>,
) -> anyhow::Result<()> {
    for node in nodes {
        match node {
            Node::Folder(folder) => {
                collect_features(&folder.nodes, features).c(h!())?
            }
            Node::Document(document) => {
                collect_features(&document.nodes, features).c(h!())?
            }
            Node::Placemark(placemark) => {
                collect_placemark_features(placemark, features).c(h!())?
            }
            _ => {}
        }
    }
    Ok(())
}

fn collect_placemark_features(
    placemark: &Placemark,
    features: &mut Vec<ImportedGeometryFeature>,
) -> anyhow::Result<()> {
    if let Some(point) = &placemark.point {
        let coordinates = point.coordinates.as_deref().c(h!())?;
        collect_points(coordinates, features).c(h!())?;
    }

    if let Some(line) = &placemark.line_string {
        let coordinates = line
            .coordinates
            .as_ref()
            .and_then(|coordinates| coordinates.body.as_deref())
            .c(h!())?;
        collect_line_string(coordinates, features).c(h!())?;
    }
    if let Some(multi_geometry) = &placemark.multi_geometry {
        for point in &multi_geometry.points {
            let coordinates = point.coordinates.as_deref().c(h!())?;
            collect_points(coordinates, features).c(h!())?;
        }
        for line in &multi_geometry.line_strings {
            let coordinates = line
                .coordinates
                .as_ref()
                .and_then(|coordinates| coordinates.body.as_deref())
                .c(h!())?;
            collect_line_string(coordinates, features).c(h!())?;
        }
    }
    Ok(())
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
}
