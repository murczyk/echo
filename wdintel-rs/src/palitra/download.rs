use crate::error::AppError;
use crate::h;
use crate::kml::types as kml_types;
use crate::palitra::bl;
use crate::palitra::types::{Palitra, PalitraPoint, PalitraReadV2};
use crate::types::{Env, ShortContext};
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
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .context(h!())?;
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
    let points = collect_delta_split_points(&palitra_read);
    if points.is_empty() {
        return Ok(());
    }
    let total_chunks = points
        .len()
        .div_ceil(crate::config::PALITRA_DELTA_DOWNLOAD_MAX_POINTS_PER_FILE);

    for (chunk_index, chunk) in points
        .chunks(crate::config::PALITRA_DELTA_DOWNLOAD_MAX_POINTS_PER_FILE)
        .enumerate()
    {
        write_delta_split_chunk(
            zip,
            options,
            used_file_names,
            total_bytes,
            &palitra_read.palitra,
            chunk_index,
            total_chunks,
            chunk,
        )?;
    }
    Ok(())
}

fn collect_delta_split_points(
    palitra_read: &PalitraReadV2,
) -> Vec<PalitraPoint> {
    palitra_read
        .geometries
        .iter()
        .flat_map(|geometry| geometry.points.iter().cloned())
        .collect_vec()
}

fn write_delta_split_chunk(
    zip: &mut zip::ZipWriter<BufWriter<std::fs::File>>,
    options: &ZipFileOptions,
    used_file_names: &mut HashSet<String>,
    total_bytes: &mut u64,
    palitra: &Palitra,
    chunk_index: usize,
    total_chunks: usize,
    points: &[PalitraPoint],
) -> Result<(), AppError> {
    let kmz_name =
        build_delta_split_kmz_name(palitra, chunk_index, total_chunks);
    let kmz_bytes = build_delta_split_kmz_bytes(&kmz_name, points).c(h!())?;
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

fn force_kmz_extension(file_name: &str) -> String {
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
    points: &[PalitraPoint],
) -> Result<Vec<u8>, AppError> {
    let kml = build_delta_split_kml(name, points);
    let rendered_kml = crate::kml::views::render_kml(&kml)?;
    let cursor = Cursor::new(Vec::new());
    let mut zip = zip::ZipWriter::new(cursor);
    let options = delta_split_zip_options();
    zip.start_file("doc.kml", options).c(h!())?;
    zip.write_all(rendered_kml.as_bytes()).c(h!())?;
    Ok(zip.finish().c(h!())?.into_inner())
}

fn build_delta_split_kml(
    name: &str,
    points: &[PalitraPoint],
) -> kml_types::Kml {
    let color_style_ids = build_delta_split_style_ids(points);
    let styles = color_style_ids
        .iter()
        .map(|(color_hex, style_id)| {
            build_delta_split_style(style_id, color_hex)
        })
        .collect_vec();
    let nodes = points
        .iter()
        .map(|point| build_delta_split_placemark(point, &color_style_ids))
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
    points: &[PalitraPoint],
) -> BTreeMap<String, String> {
    points
        .iter()
        .map(|point| normalize_color_hex_or_fallback(point.color.clone()))
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
        line_style: None,
        poly_style: None,
    }
}

fn build_delta_split_placemark(
    point: &PalitraPoint,
    color_style_ids: &BTreeMap<String, String>,
) -> kml_types::Node {
    let color_hex = normalize_color_hex_or_fallback(point.color.clone());
    let style_url =
        color_style_ids
            .get(&color_hex)
            .map(|style_id| kml_types::StyleUrl {
                body: format!("#{style_id}"),
            });
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
            geometry: None,
            access_aor_id: vec![],
            access_organism_ids: vec![],
            access_logins: vec![],
        }
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
}
