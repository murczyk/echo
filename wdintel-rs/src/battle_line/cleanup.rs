use crate::config::{
    BATTLE_LINE_CLEANUP_MIN_LINE_LENGTH_RATIO, BATTLE_LINE_EARTH_RADIUS_METERS,
};
use crate::error::AppError;
use crate::geometry_import::{
    parse_point_line_features, ImportedCoordinate, ImportedGeometryFeature,
};
use crate::h;
use crate::kml::types::{
    Coordinates, Folder, Kml, LineString, MultiGeometry, Name, Node, Placemark,
    Tessellate,
};
use crate::types::ShortContext;
use std::collections::HashSet;
use std::io::{Cursor, Write};

#[derive(Debug)]
pub struct BattleLineCleanup {
    pub features: Vec<ImportedGeometryFeature>,
    pub minimum_line_length_m: f64,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, PartialOrd, Ord)]
struct CoordinateKey {
    lat: u64,
    lon: u64,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct SegmentKey(CoordinateKey, CoordinateKey);

pub fn clean_features(
    features: Vec<ImportedGeometryFeature>,
) -> anyhow::Result<BattleLineCleanup> {
    validate_features(&features).c(h!())?;
    let maximum_line_length_m = features
        .iter()
        .filter_map(|feature| match feature {
            ImportedGeometryFeature::Point(_) => None,
            ImportedGeometryFeature::LineString(coordinates) => {
                Some(unique_line_length_m(coordinates))
            }
        })
        .fold(0.0_f64, f64::max);
    if maximum_line_length_m == 0.0 {
        anyhow::bail!(
            "The uploaded file contains no non-empty LineString geometry"
        );
    }
    let minimum_line_length_m =
        maximum_line_length_m * BATTLE_LINE_CLEANUP_MIN_LINE_LENGTH_RATIO;
    let lines = features
        .into_iter()
        .filter_map(|feature| match feature {
            ImportedGeometryFeature::Point(_) => None,
            ImportedGeometryFeature::LineString(coordinates)
                if line_length_m(&coordinates) >= minimum_line_length_m =>
            {
                Some(coordinates)
            }
            ImportedGeometryFeature::LineString(_) => None,
        })
        .collect();
    let features = remove_duplicate_segments(lines);
    if features.is_empty() {
        anyhow::bail!("Battle Line cleanup removed all geometry");
    }
    Ok(BattleLineCleanup {
        features,
        minimum_line_length_m,
    })
}

pub async fn oneoff_clean_kmz(
    ps: &crate::OneoffCleanBattleLineKmzPs,
) -> Result<(), AppError> {
    let input = tokio::fs::read(&ps.input).await.c(h!())?;
    let input_name = ps
        .input
        .file_name()
        .and_then(|name| name.to_str())
        .c(h!())?;
    let parsed = parse_point_line_features(input_name, &input)
        .await
        .c(h!())?;
    let input_feature_count = parsed.features.len();
    let cleanup = clean_features(parsed.features).c(h!())?;
    let output = features_to_kmz(&cleanup.features).c(h!())?;
    tokio::fs::write(&ps.output, output).await.c(h!())?;
    println!(
        "Cleaned {} features to {} line strings with a {:.1} m minimum length: {}",
        input_feature_count,
        cleanup.features.len(),
        cleanup.minimum_line_length_m,
        ps.output.display()
    );
    Ok(())
}

fn validate_features(
    features: &[ImportedGeometryFeature],
) -> anyhow::Result<()> {
    for coordinate in features.iter().flat_map(|feature| match feature {
        ImportedGeometryFeature::Point(coordinate) => {
            std::slice::from_ref(coordinate).iter()
        }
        ImportedGeometryFeature::LineString(coordinates) => coordinates.iter(),
    }) {
        if !coordinate.lat.is_finite()
            || !coordinate.lon.is_finite()
            || !(-90.0..=90.0).contains(&coordinate.lat)
            || !(-180.0..=180.0).contains(&coordinate.lon)
        {
            anyhow::bail!(
                "Invalid WGS84 coordinate: {}, {}",
                coordinate.lat,
                coordinate.lon
            );
        }
    }
    Ok(())
}

fn line_length_m(coordinates: &[ImportedCoordinate]) -> f64 {
    coordinates
        .windows(2)
        .map(|pair| coordinate_distance_m(&pair[0], &pair[1]))
        .sum()
}

fn unique_line_length_m(coordinates: &[ImportedCoordinate]) -> f64 {
    let mut seen = HashSet::new();
    coordinates
        .windows(2)
        .filter(|pair| pair[0] != pair[1])
        .filter(|pair| seen.insert(segment_key(&pair[0], &pair[1])))
        .map(|pair| coordinate_distance_m(&pair[0], &pair[1]))
        .sum()
}

fn coordinate_distance_m(
    left: &ImportedCoordinate,
    right: &ImportedCoordinate,
) -> f64 {
    let left_lat = left.lat.to_radians();
    let right_lat = right.lat.to_radians();
    let latitude_delta = (right.lat - left.lat).to_radians();
    let longitude_delta = (right.lon - left.lon).to_radians();
    let haversine = (latitude_delta / 2.0).sin().powi(2)
        + left_lat.cos()
            * right_lat.cos()
            * (longitude_delta / 2.0).sin().powi(2);
    BATTLE_LINE_EARTH_RADIUS_METERS * 2.0 * haversine.sqrt().min(1.0).asin()
}

fn remove_duplicate_segments(
    lines: Vec<Vec<ImportedCoordinate>>,
) -> Vec<ImportedGeometryFeature> {
    let mut seen = HashSet::new();
    let mut features = vec![];
    for coordinates in lines {
        append_unique_line_parts(&coordinates, &mut seen, &mut features);
    }
    features
}

fn append_unique_line_parts(
    coordinates: &[ImportedCoordinate],
    seen: &mut HashSet<SegmentKey>,
    features: &mut Vec<ImportedGeometryFeature>,
) {
    let mut current = vec![];
    for pair in coordinates.windows(2) {
        if pair[0] == pair[1] {
            continue;
        }
        if seen.insert(segment_key(&pair[0], &pair[1])) {
            if current.last() != Some(&pair[0]) {
                append_line_part(&mut current, features);
                current.push(pair[0].clone());
            }
            current.push(pair[1].clone());
        } else {
            append_line_part(&mut current, features);
        }
    }
    append_line_part(&mut current, features);
}

fn append_line_part(
    coordinates: &mut Vec<ImportedCoordinate>,
    features: &mut Vec<ImportedGeometryFeature>,
) {
    if coordinates.len() >= 2 {
        features.push(ImportedGeometryFeature::LineString(std::mem::take(
            coordinates,
        )));
    } else {
        coordinates.clear();
    }
}

fn segment_key(
    left: &ImportedCoordinate,
    right: &ImportedCoordinate,
) -> SegmentKey {
    let left = coordinate_key(left);
    let right = coordinate_key(right);
    if left <= right {
        SegmentKey(left, right)
    } else {
        SegmentKey(right, left)
    }
}

fn coordinate_key(coordinate: &ImportedCoordinate) -> CoordinateKey {
    CoordinateKey {
        lat: normalized_bits(coordinate.lat),
        lon: normalized_bits(coordinate.lon),
    }
}

fn normalized_bits(value: f64) -> u64 {
    if value == 0.0 {
        0.0_f64.to_bits()
    } else {
        value.to_bits()
    }
}

fn features_to_kmz(
    features: &[ImportedGeometryFeature],
) -> anyhow::Result<Vec<u8>> {
    let kml = cleaned_kml(features);
    let rendered = crate::kml::views::render_kml(&kml).c(h!())?;
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644);
    zip.start_file("doc.kml", options).c(h!())?;
    zip.write_all(rendered.as_bytes()).c(h!())?;
    Ok(zip.finish().c(h!())?.into_inner())
}

fn cleaned_kml(features: &[ImportedGeometryFeature]) -> Kml {
    let line_strings = features
        .iter()
        .filter_map(|feature| match feature {
            ImportedGeometryFeature::LineString(coordinates) => {
                Some(LineString {
                    tessellate: Some(Tessellate {
                        body: Some("1".to_string()),
                    }),
                    coordinates: Some(Coordinates {
                        body: Some(
                            coordinates
                                .iter()
                                .map(|coordinate| {
                                    format!(
                                        "{},{}",
                                        coordinate.lon, coordinate.lat
                                    )
                                })
                                .collect::<Vec<_>>()
                                .join(" "),
                        ),
                    }),
                })
            }
            ImportedGeometryFeature::Point(_) => None,
        })
        .collect();
    Kml {
        nodes: vec![Node::Folder(Folder {
            name: Some(Name {
                body: "Battle Line".to_string(),
            }),
            look_at: None,
            description: None,
            open: None,
            styles: vec![],
            style_maps: vec![],
            visibility: None,
            snippet: None,
            snippet_lower: None,
            link: None,
            camera: None,
            gx_balloon_visibility: None,
            schema: vec![],
            nodes: vec![Node::Placemark(Placemark {
                name: Some("Battle Line".to_string()),
                visibility: None,
                description: None,
                style_url: None,
                style: None,
                point: None,
                line_string: None,
                multi_geometry: Some(MultiGeometry {
                    points: vec![],
                    line_strings,
                }),
                polygon: None,
                extended_data: None,
                snippet: None,
                snippet_lower: None,
            })],
        })],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(longitude: f64) -> ImportedGeometryFeature {
        ImportedGeometryFeature::LineString(vec![
            ImportedCoordinate {
                lat: 49.0,
                lon: 30.0,
            },
            ImportedCoordinate {
                lat: 49.0,
                lon: 30.0 + longitude,
            },
        ])
    }

    #[test]
    fn removes_relative_noise_across_chunk_size_variation() {
        let cleanup = clean_features(vec![
            line(13.0),
            line(0.7),
            line(0.36),
            line(0.1),
            ImportedGeometryFeature::Point(ImportedCoordinate {
                lat: 49.0,
                lon: 30.0,
            }),
        ])
        .unwrap();

        assert_eq!(cleanup.features, vec![line(13.0), line(0.7), line(0.36)]);
    }

    #[test]
    fn removes_reversed_duplicate_segments_and_keeps_unique_remainder() {
        let first = ImportedGeometryFeature::LineString(vec![
            ImportedCoordinate {
                lat: 49.0,
                lon: 30.0,
            },
            ImportedCoordinate {
                lat: 49.0,
                lon: 31.0,
            },
        ]);
        let second = ImportedGeometryFeature::LineString(vec![
            ImportedCoordinate {
                lat: 49.0,
                lon: 31.0,
            },
            ImportedCoordinate {
                lat: 49.0,
                lon: 30.0,
            },
            ImportedCoordinate {
                lat: 49.0,
                lon: 29.0,
            },
        ]);

        let cleanup = clean_features(vec![first.clone(), second]).unwrap();

        assert_eq!(cleanup.features, vec![first, line(-1.0)]);
    }

    #[test]
    fn repeated_traversals_do_not_inflate_length_cutoff() {
        let repeated = ImportedGeometryFeature::LineString(
            (0..=100)
                .map(|index| ImportedCoordinate {
                    lat: 49.0,
                    lon: if index % 2 == 0 { 30.0 } else { 31.0 },
                })
                .collect(),
        );
        let independent = ImportedGeometryFeature::LineString(vec![
            ImportedCoordinate {
                lat: 49.0,
                lon: 40.0,
            },
            ImportedCoordinate {
                lat: 49.0,
                lon: 41.0,
            },
        ]);

        let cleanup =
            clean_features(vec![repeated, independent.clone()]).unwrap();

        assert_eq!(cleanup.features, vec![line(1.0), independent]);
    }
}
