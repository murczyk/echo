use crate::error::AppError;
use crate::h;
use crate::kml::types as kml_types;
use crate::palitra::bl;
use crate::palitra::types::{Coords, Palitra, PalitraPoint, PalitraReadV2};
use crate::types::{Env, ShortContext};
use crate::users::ensure_rer_role;
use crate::users::login_id_from_identity;
use actix_web::post;
use actix_web::web::{Data, Json};
use actix_web::HttpResponse;
use anyhow::Context;
use chrono::Utc;
use itertools::Itertools;
use serde::Deserialize;
use std::collections::{BTreeMap, HashSet};
use std::io::{BufWriter, Cursor, Seek, Write};
use tokio_util::io::ReaderStream;
use zip::write::FileOptions;

use super::{
    ensure_unique_zip_entry_name, normalize_color_hex_or_fallback,
    palitra_goi_remote_file_name,
};

type ZipFileOptions = FileOptions<'static, zip::write::ExtendedFileOptions>;

#[derive(Clone)]
enum DeltaSplitFeature {
    Point(PalitraPoint),
    LineString {
        coords: Vec<Coords>,
        color: Option<String>,
    },
}

impl DeltaSplitFeature {
    fn point_count(&self) -> usize {
        match self {
            DeltaSplitFeature::Point(_) => 1,
            DeltaSplitFeature::LineString { coords, .. } => coords.len(),
        }
    }

    fn color(&self) -> Option<String> {
        match self {
            DeltaSplitFeature::Point(point) => point.color.clone(),
            DeltaSplitFeature::LineString { color, .. } => color.clone(),
        }
    }
}

#[derive(Deserialize)]
struct PalitraDeltaSplitDownloadReq {
    palitra_ids: Vec<i64>,
}

#[post("/api/palitra/download-delta-split")]
pub async fn download_palitras_delta_split(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<PalitraDeltaSplitDownloadReq>,
) -> Result<HttpResponse, AppError> {
    ensure_rer_role(&env.dbx, &user).await.context(h!())?;
    let login = login_id_from_identity(&user)?;
    let palitra_ids = req
        .into_inner()
        .palitra_ids
        .into_iter()
        .unique()
        .collect_vec();
    if palitra_ids.len() > crate::config::PALITRA_DOWNLOAD_MAX_FILES {
        return Err(AppError::BL {
            msg: format!(
                "Too many palitras requested: {}, max is {}",
                palitra_ids.len(),
                crate::config::PALITRA_DOWNLOAD_MAX_FILES
            ),
        });
    }

    let palitras =
        bl::collect_downloadable_palitra_details(login, palitra_ids, &env.dbx)
            .await
            .c(h!())?;
    let zip_file = build_delta_split_archive(palitras).c(h!())?;
    let zip_size = zip_file.metadata().c(h!())?.len();
    let stream = ReaderStream::new(tokio::fs::File::from_std(zip_file));
    let archive_name =
        format!("palitras_delta_{}.zip", Utc::now().format("%Y%m%dT%H%M%SZ"));

    Ok(HttpResponse::Ok()
        .content_type("application/zip")
        .insert_header((
            "Content-Disposition",
            format!("attachment; filename=\"{archive_name}\""),
        ))
        .insert_header(("Content-Length", zip_size.to_string()))
        .streaming(stream))
}

fn build_delta_split_archive(
    palitras: Vec<PalitraReadV2>,
) -> Result<std::fs::File, AppError> {
    let zip_file = tempfile::tempfile().c(h!())?;
    let mut zip = zip::ZipWriter::new(BufWriter::new(zip_file));
    let options = delta_split_zip_options();
    write_delta_split_palitras(&mut zip, &options, palitras)?;
    let mut zip_file = zip.finish().c(h!())?.into_inner().c(h!())?;
    zip_file.rewind().c(h!())?;
    Ok(zip_file)
}

fn delta_split_zip_options() -> ZipFileOptions {
    FileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644)
}

fn write_delta_split_palitras(
    zip: &mut zip::ZipWriter<BufWriter<std::fs::File>>,
    options: &ZipFileOptions,
    palitras: Vec<PalitraReadV2>,
) -> Result<(), AppError> {
    let mut used_file_names = HashSet::new();
    let mut total_bytes = 0u64;

    for palitra_read in palitras {
        write_delta_split_palitra(
            zip,
            options,
            &mut used_file_names,
            &mut total_bytes,
            palitra_read,
        )?;
    }
    Ok(())
}

fn write_delta_split_palitra(
    zip: &mut zip::ZipWriter<BufWriter<std::fs::File>>,
    options: &ZipFileOptions,
    used_file_names: &mut HashSet<String>,
    total_bytes: &mut u64,
    palitra_read: PalitraReadV2,
) -> Result<(), AppError> {
    let chunks = collect_delta_split_chunks(&palitra_read);
    if chunks.is_empty() {
        return Ok(());
    }
    let total_chunks = chunks.len();

    for (chunk_index, chunk) in chunks.iter().enumerate() {
        write_delta_split_chunk(
            zip,
            options,
            used_file_names,
            total_bytes,
            &palitra_read.palitra,
            chunk_index,
            total_chunks,
            chunk.as_slice(),
        )?;
    }
    Ok(())
}

fn collect_delta_split_chunks(
    palitra_read: &PalitraReadV2,
) -> Vec<Vec<DeltaSplitFeature>> {
    chunk_delta_split_features(collect_delta_split_features(palitra_read))
}

fn collect_delta_split_features(
    palitra_read: &PalitraReadV2,
) -> Vec<DeltaSplitFeature> {
    let mut features = Vec::new();
    for geometry in &palitra_read.geometries {
        features.extend(
            geometry
                .points
                .iter()
                .cloned()
                .map(DeltaSplitFeature::Point),
        );

        let Some(geometry_data) = &geometry.geometry else {
            continue;
        };
        let Some(line_strings) = &geometry_data.line_strings else {
            continue;
        };
        for line_string in line_strings {
            features.extend(split_delta_line_string(
                line_string,
                Some(geometry.color_hex.clone()),
            ));
        }
    }
    features
}

fn split_delta_line_string(
    coords: &[Coords],
    color: Option<String>,
) -> Vec<DeltaSplitFeature> {
    let coords = coords
        .iter()
        .filter(|coord| coord.lat.is_finite() && coord.lng.is_finite())
        .cloned()
        .collect_vec();
    if coords.len() < 2 {
        return vec![];
    }

    let max_points = crate::config::PALITRA_DELTA_DOWNLOAD_MAX_POINTS_PER_FILE;
    let mut result = Vec::new();
    let mut start = 0usize;
    while start < coords.len() {
        let end = (start + max_points).min(coords.len());
        let segment = if end - start == 1 && start > 0 {
            coords[start - 1..end].to_vec()
        } else {
            coords[start..end].to_vec()
        };
        if segment.len() >= 2 {
            result.push(DeltaSplitFeature::LineString {
                coords: segment,
                color: color.clone(),
            });
        }
        start = end;
    }
    result
}

fn chunk_delta_split_features(
    features: Vec<DeltaSplitFeature>,
) -> Vec<Vec<DeltaSplitFeature>> {
    let max_points = crate::config::PALITRA_DELTA_DOWNLOAD_MAX_POINTS_PER_FILE;
    let mut chunks = Vec::new();
    let mut chunk = Vec::new();
    let mut chunk_points = 0usize;

    for feature in features {
        let feature_points = feature.point_count();
        if !chunk.is_empty() && chunk_points + feature_points > max_points {
            chunks.push(chunk);
            chunk = Vec::new();
            chunk_points = 0;
        }

        chunk_points += feature_points;
        chunk.push(feature);
    }

    if !chunk.is_empty() {
        chunks.push(chunk);
    }
    chunks
}

fn write_delta_split_chunk(
    zip: &mut zip::ZipWriter<BufWriter<std::fs::File>>,
    options: &ZipFileOptions,
    used_file_names: &mut HashSet<String>,
    total_bytes: &mut u64,
    palitra: &Palitra,
    chunk_index: usize,
    total_chunks: usize,
    features: &[DeltaSplitFeature],
) -> Result<(), AppError> {
    let kmz_name =
        build_delta_split_kmz_name(palitra, chunk_index, total_chunks);
    let kmz_bytes = build_delta_split_kmz_bytes(&kmz_name, features).c(h!())?;
    add_delta_split_bytes(palitra, kmz_bytes.len() as u64, total_bytes)?;
    let file_name = ensure_unique_zip_entry_name(used_file_names, kmz_name);
    zip.start_file(file_name, options.clone()).c(h!())?;
    zip.write_all(&kmz_bytes).c(h!())?;
    Ok(())
}

fn add_delta_split_bytes(
    palitra: &Palitra,
    file_bytes: u64,
    total_bytes: &mut u64,
) -> Result<(), AppError> {
    if file_bytes > crate::config::PALITRA_DOWNLOAD_MAX_FILE_BYTES {
        return Err(AppError::BL {
            msg: format!(
                "Palitra split file is too large to download in one request: palitra_id={}, bytes={}, max={}",
                palitra.id,
                file_bytes,
                crate::config::PALITRA_DOWNLOAD_MAX_FILE_BYTES
            ),
        });
    }

    *total_bytes = total_bytes.saturating_add(file_bytes);
    if *total_bytes > crate::config::PALITRA_DOWNLOAD_MAX_TOTAL_BYTES {
        return Err(AppError::BL {
            msg: format!(
                "Requested palitra download is too large: bytes={}, max={}",
                *total_bytes,
                crate::config::PALITRA_DOWNLOAD_MAX_TOTAL_BYTES
            ),
        });
    }
    Ok(())
}

fn build_delta_split_kmz_name(
    palitra: &Palitra,
    chunk_index: usize,
    total_chunks: usize,
) -> String {
    let base_name = force_kmz_extension(&palitra_goi_remote_file_name(
        palitra.id,
        Some(&palitra.name),
        palitra.source_file_name.as_deref(),
    ));
    if total_chunks <= 1 {
        return base_name;
    }

    let path = std::path::Path::new(&base_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("palitra");
    format!(
        "{stem}_part_{:03}_of_{:03}.kmz",
        chunk_index + 1,
        total_chunks
    )
}

pub(super) fn force_kmz_extension(file_name: &str) -> String {
    let path = std::path::Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("palitra");
    format!("{stem}.kmz")
}

fn build_delta_split_kmz_bytes(
    name: &str,
    features: &[DeltaSplitFeature],
) -> Result<Vec<u8>, AppError> {
    let kml = build_delta_split_kml(name, features);
    let rendered_kml = crate::kml::views::render_kml(&kml)?;
    let cursor = Cursor::new(Vec::new());
    let mut zip = zip::ZipWriter::new(cursor);
    let options = delta_split_zip_options();
    zip.start_file("doc.kml", options).c(h!())?;
    zip.write_all(rendered_kml.as_bytes()).c(h!())?;
    Ok(zip.finish().c(h!())?.into_inner())
}

pub(super) fn build_geometry_palitra_kmz_bytes(
    palitra_read: &PalitraReadV2,
) -> Result<Vec<u8>, AppError> {
    let features = collect_delta_split_features(palitra_read);
    if features.is_empty() {
        return Err(AppError::BL {
            msg: format!(
                "Palitra has no source file or geometry to download: palitra_id={}",
                palitra_read.palitra.id
            ),
        });
    }
    let name = build_delta_split_kmz_name(&palitra_read.palitra, 0, 1);
    build_delta_split_kmz_bytes(&name, &features)
}

fn build_delta_split_kml(
    name: &str,
    features: &[DeltaSplitFeature],
) -> kml_types::Kml {
    let color_style_ids = build_delta_split_style_ids(features);
    let styles = color_style_ids
        .iter()
        .map(|(color_hex, style_id)| {
            build_delta_split_style(style_id, color_hex)
        })
        .collect_vec();
    let nodes = features
        .iter()
        .map(|feature| build_delta_split_placemark(feature, &color_style_ids))
        .collect_vec();

    kml_types::Kml {
        nodes: vec![kml_types::Node::Document(kml_types::Document {
            name: Some(kml_types::Name {
                body: name.to_string(),
            }),
            description: None,
            look_at: None,
            open: None,
            styles,
            cascading_styles: vec![],
            style_maps: vec![],
            visibility: None,
            snippet: None,
            snippet_lower: None,
            nodes,
            link: None,
            camera: None,
            gx_balloon_visibility: None,
            schema: vec![],
        })],
    }
}

fn build_delta_split_style_ids(
    features: &[DeltaSplitFeature],
) -> BTreeMap<String, String> {
    features
        .iter()
        .map(|feature| normalize_color_hex_or_fallback(feature.color()))
        .unique()
        .enumerate()
        .map(|(index, color_hex)| {
            let style_id = format!("palitra-point-{}", index + 1);
            (color_hex, style_id)
        })
        .collect()
}

fn build_delta_split_style(
    style_id: &str,
    color_hex: &str,
) -> kml_types::Style {
    kml_types::Style {
        id: Some(style_id.to_string()),
        icon_style: Some(kml_types::IconStyle {
            color: Some(kml_types::Color {
                body: hex_color_to_kml_color(color_hex),
            }),
            scale: Some(kml_types::Scale {
                body: "1.0".to_string(),
            }),
            icon: None,
        }),
        label_style: None,
        balloon_style: None,
        line_style: Some(kml_types::LineStyle {
            color: Some(kml_types::Color {
                body: hex_color_to_kml_color(color_hex),
            }),
            width: Some(kml_types::Width {
                body: "2".to_string(),
            }),
        }),
        poly_style: None,
    }
}

fn build_delta_split_placemark(
    feature: &DeltaSplitFeature,
    color_style_ids: &BTreeMap<String, String>,
) -> kml_types::Node {
    let color_hex = normalize_color_hex_or_fallback(feature.color());
    let style_url =
        color_style_ids
            .get(&color_hex)
            .map(|style_id| kml_types::StyleUrl {
                body: format!("#{style_id}"),
            });
    match feature {
        DeltaSplitFeature::Point(point) => {
            kml_types::Node::Placemark(kml_types::Placemark {
                name: point
                    .label
                    .as_deref()
                    .map(str::trim)
                    .filter(|label| !label.is_empty())
                    .map(str::to_string),
                visibility: None,
                description: None,
                style_url,
                style: None,
                point: Some(kml_types::Point {
                    draw_order: None,
                    coordinates: Some(format!(
                        "{},{},0",
                        point.coords.lng, point.coords.lat
                    )),
                }),
                line_string: None,
                multi_geometry: None,
                polygon: None,
                extended_data: None,
                snippet: None,
                snippet_lower: None,
            })
        }
        DeltaSplitFeature::LineString { coords, .. } => {
            kml_types::Node::Placemark(kml_types::Placemark {
                name: None,
                visibility: None,
                description: None,
                style_url,
                style: None,
                point: None,
                line_string: Some(kml_types::LineString {
                    tessellate: Some(kml_types::Tessellate {
                        body: Some("1".to_string()),
                    }),
                    coordinates: Some(kml_types::Coordinates {
                        body: Some(format_delta_line_coordinates(coords)),
                    }),
                }),
                multi_geometry: None,
                polygon: None,
                extended_data: None,
                snippet: None,
                snippet_lower: None,
            })
        }
    }
}

fn format_delta_line_coordinates(coords: &[Coords]) -> String {
    coords
        .iter()
        .map(|coord| format!("{},{},0", coord.lng, coord.lat))
        .join("\n")
}

fn hex_color_to_kml_color(color_hex: &str) -> String {
    let normalized =
        normalize_color_hex_or_fallback(Some(color_hex.to_string()));
    let hex = normalized_hex_color_body(&normalized);
    format!("ff{}{}{}", &hex[4..6], &hex[2..4], &hex[0..2])
}

fn normalized_hex_color_body(color_hex: &str) -> &str {
    let hex = color_hex.trim_start_matches('#');
    if hex.len() == 6 && hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return hex;
    }
    crate::config::PALITRA_POINT_FALLBACK_COLOR_HEX.trim_start_matches('#')
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::palitra::types::{Geometry, PalitraGeometryDetails};
    use std::io::Read;

    fn test_palitra(name: &str) -> Palitra {
        Palitra {
            id: 42,
            name: name.to_string(),
            folder: None,
            is_archived: false,
            color_hex: "#aabbcc".to_string(),
            author: None,
            source_file_name: None,
            last_uploaded_at_ts: None,
            conversion_status: crate::config::PALITRA_CONVERSION_STATUS_READY
                .to_string(),
            source_format: None,
            conversion_error: None,
            missing_in_goi: false,
            imported_from_goi: false,
            goi_owned: false,
            goi_source_refresh_retry_available: false,
            latest_changelog_warning: false,
            changelog: vec![],
            geometry: None,
            access_aor_id: vec![],
            access_organism_ids: vec![],
            access_logins: vec![],
        }
    }

    fn test_palitra_read(line_strings: Vec<Vec<Coords>>) -> PalitraReadV2 {
        PalitraReadV2 {
            palitra: test_palitra("demo"),
            geometries: vec![PalitraGeometryDetails {
                id: 7,
                color_hex: "#112233".to_string(),
                source_file_name: None,
                last_uploaded_at_ts: None,
                geometry: Some(Geometry {
                    center: None,
                    perimeter_linear_ring: None,
                    line_strings: Some(line_strings),
                }),
                points: vec![],
            }],
        }
    }

    fn test_coords(lat: f64, lng: f64) -> Coords {
        Coords { lat, lng }
    }

    #[test]
    fn forces_delta_split_entries_to_kmz_extension() {
        assert_eq!(
            build_delta_split_kmz_name(&test_palitra("demo.kml"), 0, 1),
            "demo.kmz"
        );
        assert_eq!(
            build_delta_split_kmz_name(&test_palitra("demo.kml"), 1, 3),
            "demo_part_002_of_003.kmz"
        );
    }

    #[test]
    fn falls_back_for_invalid_kml_colors() {
        assert_eq!(hex_color_to_kml_color("#aabbcc"), "ffccbbaa");
        assert_eq!(hex_color_to_kml_color("not-a-color"), "ff060606");
        assert_eq!(hex_color_to_kml_color("#abc"), "ff060606");
    }

    #[test]
    fn preserves_line_strings_in_delta_split_download() {
        let chunks = collect_delta_split_chunks(&test_palitra_read(vec![
            vec![test_coords(50.45, 30.52), test_coords(50.46, 30.53)],
        ]));

        assert_eq!(chunks.len(), 1);
        let kml = build_delta_split_kml("demo.kmz", &chunks[0]);
        let kml_types::Node::Document(document) = &kml.nodes[0] else {
            panic!("expected document node");
        };
        let kml_types::Node::Placemark(placemark) = &document.nodes[0] else {
            panic!("expected placemark node");
        };
        let line_string = placemark
            .line_string
            .as_ref()
            .expect("expected line string");
        assert_eq!(
            line_string
                .coordinates
                .as_ref()
                .and_then(|coordinates| coordinates.body.as_deref()),
            Some("30.52,50.45,0\n30.53,50.46,0")
        );
    }

    #[test]
    fn builds_unsplit_kmz_from_stored_geometry() {
        let mut palitra_read = test_palitra_read(vec![]);
        palitra_read.geometries[0].points.push(PalitraPoint {
            coords: test_coords(50.45, 30.52),
            label: Some("Alpha".to_string()),
            color: Some("#112233".to_string()),
        });

        let bytes = build_geometry_palitra_kmz_bytes(&palitra_read).unwrap();
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut rendered_kml = String::new();
        archive
            .by_name("doc.kml")
            .unwrap()
            .read_to_string(&mut rendered_kml)
            .unwrap();

        assert!(rendered_kml.contains("Alpha"));
        assert!(rendered_kml.contains("30.52,50.45,0"));
    }

    #[test]
    fn splits_long_line_strings_without_oversized_chunks() {
        let coords = (0
            ..=crate::config::PALITRA_DELTA_DOWNLOAD_MAX_POINTS_PER_FILE)
            .map(|index| test_coords(index as f64, index as f64))
            .collect_vec();

        let chunks =
            collect_delta_split_chunks(&test_palitra_read(vec![coords]));

        assert_eq!(chunks.len(), 2);
        assert!(chunks.iter().all(|chunk| {
            chunk
                .iter()
                .map(DeltaSplitFeature::point_count)
                .sum::<usize>()
                <= crate::config::PALITRA_DELTA_DOWNLOAD_MAX_POINTS_PER_FILE
        }));
    }
}
