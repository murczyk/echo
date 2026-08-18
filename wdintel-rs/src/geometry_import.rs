use crate::h;
use crate::kml::types::{Node, Placemark};
use crate::types::ShortContext;
use std::fs::File;
use std::io;
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
    archive
        .extract(extract_to)
        .map_err(|error| {
            io::Error::other(format!("Extraction error: {error:?}"))
        })
        .c(h!())?;
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
    collect_features(&kml.nodes, &mut features);
    Ok(features)
}

fn collect_features(
    nodes: &[Node],
    features: &mut Vec<ImportedGeometryFeature>,
) {
    for node in nodes {
        match node {
            Node::Folder(folder) => collect_features(&folder.nodes, features),
            Node::Document(document) => {
                collect_features(&document.nodes, features)
            }
            Node::Placemark(placemark) => {
                collect_placemark_features(placemark, features)
            }
            _ => {}
        }
    }
}

fn collect_placemark_features(
    placemark: &Placemark,
    features: &mut Vec<ImportedGeometryFeature>,
) {
    if let Some(coordinates) = placemark
        .point
        .as_ref()
        .and_then(|point| point.coordinates.as_deref())
    {
        if let Ok(points) = parse_kml_coordinates_strict(coordinates) {
            features
                .extend(points.into_iter().map(ImportedGeometryFeature::Point));
        }
    }

    let direct_line = placemark
        .line_string
        .as_ref()
        .and_then(|line| line.coordinates.as_ref())
        .and_then(|coordinates| coordinates.body.as_deref());
    collect_line_string(direct_line, features);
    if let Some(multi_geometry) = &placemark.multi_geometry {
        for line in &multi_geometry.line_strings {
            let coordinates = line
                .coordinates
                .as_ref()
                .and_then(|coordinates| coordinates.body.as_deref());
            collect_line_string(coordinates, features);
        }
    }
}

fn collect_line_string(
    coordinates: Option<&str>,
    features: &mut Vec<ImportedGeometryFeature>,
) {
    let Some(coordinates) = coordinates else {
        return;
    };
    if let Ok(coordinates) = parse_kml_coordinates_strict(coordinates) {
        if coordinates.len() >= 2 {
            features.push(ImportedGeometryFeature::LineString(coordinates));
        }
    }
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

    #[test]
    fn parses_kml_coordinate_order() {
        let coordinate = parse_kml_coordinate("31.2,49.7,0").unwrap();
        assert_eq!(coordinate.lon, 31.2);
        assert_eq!(coordinate.lat, 49.7);
    }

    #[tokio::test]
    async fn imports_only_point_and_line_placemarks_in_source_order() {
        let kml = br#"<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  <Placemark><Point><coordinates>31,49,0</coordinates></Point></Placemark>
  <Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>30,48 31,48 30,48</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
  <Placemark><LineString><coordinates>32,50,0 33,51,0</coordinates></LineString></Placemark>
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
            ]
        );
    }
}
