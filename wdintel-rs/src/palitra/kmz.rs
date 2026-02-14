use crate::config::PALITRA_STORAGE_DIR_NAME;
use crate::h;
use crate::kml::types::*;
use crate::palitra::types::*;
use crate::types::{Env, ShortContext};
use chrono::Utc;
use log::{error, info};
use std::collections::HashMap;
use std::fs::File;
use std::io::{self};
use std::path::Path;
use tempfile::tempdir;
use tokio::fs;
use tokio::task;
use walkdir::WalkDir;
use zip::ZipArchive;

pub async fn load_coordinates_from_file(
    file_name: String,
    data: Vec<u8>,
    env: &Env,
) -> anyhow::Result<Vec<PalitraPoint>> {
    let storage_dir = std::env::temp_dir()
        .join(PALITRA_STORAGE_DIR_NAME)
        .join(format!("{}", Utc::now().naive_utc().date()));
    tokio::fs::create_dir_all(storage_dir.as_path())
        .await
        .c(h!())?;
    let safe_file_name = sanitize_upload_filename(&file_name);
    // store original palitra file in s3. update in config in order to disable
    if env
        .config
        .store_palitra_in_s3
        .unwrap_or(crate::config::DEFAULT_STORE_PALITRA_IN_S3)
    {
        let file_s3_id = crate::messenger::media::store_asset(
            env,
            &data,
            Some(&safe_file_name),
            Some(crate::config::KMZ_CONTENT_TYPE),
        )
        .await
        .c(h!())?;
        info!("uploaded {safe_file_name} to b2, available at {file_s3_id}");
    }

    let tmp_dir = tempdir()?;
    let path = tmp_dir.path().join(&safe_file_name);
    fs::write(path.as_path(), data).await.c(h!())?;
    let extension = path
        .extension()
        .c(h!())?
        .to_string_lossy()
        .to_string()
        .to_ascii_lowercase();
    match extension.as_str() {
        "kmz" => load_coordinates_from_kmz(path.as_path()).await,
        "kml" => load_coordinates_from_kml(path.as_path()).await,
        _ => anyhow::bail!("Unsupported coordinates extension: {extension}"),
    }
}

pub fn sanitize_upload_filename(filename: &str) -> String {
    Path::new(filename)
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.to_string())
        .unwrap_or_else(|| "file.kmz".to_string())
}

pub async fn load_coordinates_from_kmz(
    kmz_path: &Path,
) -> anyhow::Result<Vec<PalitraPoint>> {
    let tmp_dir = tempdir()?;
    let extract_to = tmp_dir.path().to_path_buf();
    let walkdir = WalkDir::new(extract_to.as_path()).into_iter();
    let file_path = kmz_path.to_path_buf();
    task::spawn_blocking(move || {
        let zip_file = File::open(file_path)?;
        let mut archive = ZipArchive::new(zip_file)
            .map_err(|e| io::Error::other(format!("Zip error: {e:?}")))?;
        archive.extract(extract_to.as_path()).map_err(|e| {
            io::Error::other(format!("Extraction error: {e:?}"))
        })?;

        anyhow::Ok(())
    })
    .await
    .c(h!())?
    .c(h!())?;

    let mut result = vec![];

    for entry in walkdir.filter_map(|e| e.ok()) {
        if entry.file_type().is_file() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) == Some("kml") {
                let coordinates = match load_coordinates_from_kml(path).await {
                    Ok(c) => c,
                    Err(e) => {
                        error!("failed to read all coordinates from kmz {kmz_path:?}, bad file at {path:?}: {e:?}");
                        continue;
                    }
                };
                for c in coordinates {
                    result.push(c);
                }
            }
        }
    }
    Ok(result)
}

pub async fn load_coordinates_from_kml(
    path: &Path,
) -> anyhow::Result<Vec<PalitraPoint>> {
    let parent = path.parent().c(h!())?;
    let doc = crate::kml::read_and_fix_kml(false, path, parent)
        .await
        .c(h!())?;
    let mut values: Vec<PalitraPoint> = Vec::new();
    let mut queue = doc.nodes;
    loop {
        let Some(node) = queue.pop() else {
            break;
        };
        match node {
            Node::Folder(n) => {
                for n in n.nodes {
                    queue.push(n);
                }
            }
            Node::Document(n) => {
                for n in n.nodes {
                    queue.push(n);
                }
            }
            Node::Placemark(p) => {
                let label = p.name.or(p.description);
                let point = p.point.and_then(|p| p.coordinates);
                m_add_coordinates(&mut values, label.clone(), point);

                let polygon_point = p
                    .polygon
                    .and_then(|p| p.outer_boundary_is)
                    .and_then(|o| o.linear_ring)
                    .and_then(|l| l.coordinates)
                    .and_then(|l| l.body);
                m_add_coordinates(&mut values, label.clone(), polygon_point);

                let mut line_strings =
                    p.multi_geometry.map(|p| p.line_strings).unwrap_or(vec![]);
                if let Some(line_string) = p.line_string {
                    line_strings.push(line_string);
                }

                for line_string in line_strings {
                    let coordinates =
                        line_string.coordinates.and_then(|c| c.body);
                    m_add_coordinates(&mut values, label.clone(), coordinates);
                }
            }
            _ => continue,
        }
    }
    Ok(values)
}

fn m_add_coordinates(
    values: &mut Vec<PalitraPoint>,
    label: Option<String>,
    coordinates: Option<String>,
) {
    if let Some(c) = coordinates {
        match Coords::from_csv(&c) {
            Ok(coords) => {
                let point = PalitraPoint { coords, label };
                values.push(point);
            }
            Err(e) => {
                error!("Failed to parse coordinates {c}: {e:?}");
            }
        }
    }
}

#[derive(Default)]
struct ColorAggregate {
    count: i32,
    parent_folder_counts: HashMap<String, i32>,
}

#[derive(Default)]
struct StyleIndexes {
    styles: HashMap<String, Style>,
    style_map_refs: HashMap<String, String>,
}

/// Extracts colors from KML placemarks and counts items per color.
/// Also suggests suffix by taking the dominant parent folder for each color.
pub async fn extract_top_colors_from_kmz(
    kmz_path: &Path,
) -> anyhow::Result<Vec<KmzColorInfo>> {
    let tmp_dir = tempdir()?;
    let extract_to = tmp_dir.path().to_path_buf();
    let walkdir = WalkDir::new(extract_to.as_path()).into_iter();
    let file_path = kmz_path.to_path_buf();

    task::spawn_blocking(move || {
        let zip_file = File::open(file_path)?;
        let mut archive = ZipArchive::new(zip_file)
            .map_err(|e| io::Error::other(format!("Zip error: {e:?}")))?;
        archive.extract(extract_to.as_path()).map_err(|e| {
            io::Error::other(format!("Extraction error: {e:?}"))
        })?;
        anyhow::Ok(())
    })
    .await
    .c(h!())?
    .c(h!())?;

    let mut color_counts: HashMap<String, ColorAggregate> = HashMap::new();

    for entry in walkdir.filter_map(|e| e.ok()) {
        if entry.file_type().is_file() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) == Some("kml") {
                match extract_color_aggregates_from_kml(path).await {
                    Ok(kml_color_counts) => {
                        merge_color_aggregates(
                            &mut color_counts,
                            kml_color_counts,
                        );
                    }
                    Err(e) => {
                        error!("Failed to extract colors from {path:?}: {e:?}");
                        continue;
                    }
                }
            }
        }
    }

    Ok(extract_top_colors_from_aggregates(color_counts))
}

/// Extracts top configured colors from a single KML file.
pub async fn extract_top_colors_from_kml(
    kml_path: &Path,
) -> anyhow::Result<Vec<KmzColorInfo>> {
    let color_counts = extract_color_aggregates_from_kml(kml_path).await?;
    Ok(extract_top_colors_from_aggregates(color_counts))
}

async fn extract_color_aggregates_from_kml(
    path: &Path,
) -> anyhow::Result<HashMap<String, ColorAggregate>> {
    let parent = path.parent().c(h!())?;
    let doc = crate::kml::read_and_fix_kml(false, path, parent)
        .await
        .c(h!())?;

    let mut style_indexes = StyleIndexes::default();
    collect_style_indexes_from_nodes(&doc.nodes, &mut style_indexes);

    let mut color_counts = HashMap::new();
    collect_color_data_from_nodes(
        &doc.nodes,
        None,
        &style_indexes,
        &mut color_counts,
    );
    Ok(color_counts)
}

fn collect_style_indexes_from_nodes(
    nodes: &[Node],
    style_indexes: &mut StyleIndexes,
) {
    for node in nodes {
        match node {
            Node::Folder(folder) => {
                collect_styles_from_slice(&folder.styles, style_indexes);
                collect_style_maps_from_slice(
                    &folder.style_maps,
                    style_indexes,
                );
                collect_style_indexes_from_nodes(&folder.nodes, style_indexes);
            }
            Node::Document(document) => {
                collect_styles_from_slice(&document.styles, style_indexes);
                for cascading_style in &document.cascading_styles {
                    if let Some(style) = &cascading_style.style {
                        collect_style(style, style_indexes);
                    }
                }
                collect_style_maps_from_slice(
                    &document.style_maps,
                    style_indexes,
                );
                collect_style_indexes_from_nodes(
                    &document.nodes,
                    style_indexes,
                );
            }
            Node::Style(style) => {
                collect_style(style, style_indexes);
            }
            Node::StyleMap(style_map) => {
                collect_style_map(style_map, style_indexes);
            }
            Node::CascadingStyle(cascading_style) => {
                if let Some(style) = &cascading_style.style {
                    collect_style(style, style_indexes);
                }
            }
            _ => {}
        }
    }
}

fn collect_styles_from_slice(
    styles: &[Style],
    style_indexes: &mut StyleIndexes,
) {
    for style in styles {
        collect_style(style, style_indexes);
    }
}

fn collect_style(style: &Style, style_indexes: &mut StyleIndexes) {
    if let Some(style_id) = &style.id {
        style_indexes.styles.insert(style_id.clone(), style.clone());
    }
}

fn collect_style_maps_from_slice(
    style_maps: &[StyleMap],
    style_indexes: &mut StyleIndexes,
) {
    for style_map in style_maps {
        collect_style_map(style_map, style_indexes);
    }
}

fn collect_style_map(style_map: &StyleMap, style_indexes: &mut StyleIndexes) {
    let Some(style_map_id) = &style_map.id else {
        return;
    };

    let m_style_ref = style_map
        .pairs
        .iter()
        .find(|pair| pair.key.body == "normal")
        .or_else(|| style_map.pairs.first())
        .map(|pair| normalize_style_ref(&pair.style_url.body))
        .filter(|style_ref| !style_ref.is_empty());

    if let Some(style_ref) = m_style_ref {
        style_indexes
            .style_map_refs
            .insert(style_map_id.clone(), style_ref);
    }
}

fn normalize_style_ref(style_ref: &str) -> String {
    style_ref.trim().trim_start_matches('#').to_string()
}

fn collect_color_data_from_nodes(
    nodes: &[Node],
    parent_folder_name: Option<String>,
    style_indexes: &StyleIndexes,
    color_counts: &mut HashMap<String, ColorAggregate>,
) {
    for node in nodes {
        match node {
            Node::Folder(folder) => {
                let next_parent_folder_name = folder
                    .name
                    .as_ref()
                    .map(|name| name.body.trim().to_string())
                    .filter(|name| !name.is_empty())
                    .or_else(|| parent_folder_name.clone());

                collect_color_data_from_nodes(
                    &folder.nodes,
                    next_parent_folder_name,
                    style_indexes,
                    color_counts,
                );
            }
            Node::Document(document) => {
                collect_color_data_from_nodes(
                    &document.nodes,
                    parent_folder_name.clone(),
                    style_indexes,
                    color_counts,
                );
            }
            Node::Placemark(placemark) => {
                collect_color_from_placemark(
                    placemark,
                    parent_folder_name.as_ref(),
                    style_indexes,
                    color_counts,
                );
            }
            _ => {}
        }
    }
}

fn collect_color_from_placemark(
    placemark: &Placemark,
    parent_folder_name: Option<&String>,
    style_indexes: &StyleIndexes,
    color_counts: &mut HashMap<String, ColorAggregate>,
) {
    if !placemark_has_supported_geometry(placemark) {
        return;
    }

    let m_color_hex = extract_color_from_placemark(placemark, style_indexes);
    let Some(color_hex) = m_color_hex else {
        return;
    };

    let color_aggregate = color_counts.entry(color_hex).or_default();
    color_aggregate.count += 1;

    if let Some(parent_folder_name) = parent_folder_name {
        *color_aggregate
            .parent_folder_counts
            .entry(parent_folder_name.clone())
            .or_insert(0) += 1;
    }
}

fn placemark_has_supported_geometry(placemark: &Placemark) -> bool {
    let has_point_coordinates = placemark
        .point
        .as_ref()
        .and_then(|point| point.coordinates.as_ref())
        .is_some();
    if has_point_coordinates {
        return true;
    }

    let has_polygon_coordinates = placemark
        .polygon
        .as_ref()
        .and_then(|polygon| polygon.outer_boundary_is.as_ref())
        .and_then(|outer_boundary| outer_boundary.linear_ring.as_ref())
        .and_then(|linear_ring| linear_ring.coordinates.as_ref())
        .and_then(|coordinates| coordinates.body.as_ref())
        .is_some();
    if has_polygon_coordinates {
        return true;
    }

    let has_line_coordinates = placemark
        .line_string
        .as_ref()
        .and_then(|line_string| line_string.coordinates.as_ref())
        .and_then(|coordinates| coordinates.body.as_ref())
        .is_some();
    if has_line_coordinates {
        return true;
    }

    placemark
        .multi_geometry
        .as_ref()
        .map(|multi_geometry| {
            multi_geometry.line_strings.iter().any(|line_string| {
                line_string
                    .coordinates
                    .as_ref()
                    .and_then(|coordinates| coordinates.body.as_ref())
                    .is_some()
            })
        })
        .unwrap_or(false)
}

fn extract_color_from_placemark(
    placemark: &Placemark,
    style_indexes: &StyleIndexes,
) -> Option<String> {
    if let Some(inline_style) = &placemark.style {
        if let Some(color_hex) =
            extract_preferred_color_from_style(inline_style)
        {
            return Some(color_hex);
        }
    }

    placemark.style_url.as_ref().and_then(|style_url| {
        resolve_color_from_style_url(style_url, style_indexes)
    })
}

fn extract_preferred_color_from_style(style: &Style) -> Option<String> {
    if let Some(icon_style) = &style.icon_style {
        if let Some(color) = &icon_style.color {
            if let Ok(hex_color) = kml_color_to_hex(&color.body) {
                return Some(hex_color);
            }
        }
    }

    if let Some(line_style) = &style.line_style {
        if let Some(color) = &line_style.color {
            if let Ok(hex_color) = kml_color_to_hex(&color.body) {
                return Some(hex_color);
            }
        }
    }

    if let Some(poly_style) = &style.poly_style {
        if let Some(color) = &poly_style.color {
            if let Ok(hex_color) = kml_color_to_hex(&color.body) {
                return Some(hex_color);
            }
        }
    }

    None
}

fn resolve_color_from_style_url(
    style_url: &StyleUrl,
    style_indexes: &StyleIndexes,
) -> Option<String> {
    let mut style_ref = normalize_style_ref(&style_url.body);
    if style_ref.is_empty() {
        return None;
    }

    for _ in 0..4 {
        if let Some(style) = style_indexes.styles.get(&style_ref) {
            return extract_preferred_color_from_style(style);
        }

        let m_mapped_style_ref = style_indexes
            .style_map_refs
            .get(&style_ref)
            .map(|mapped| normalize_style_ref(mapped));
        let Some(mapped_style_ref) = m_mapped_style_ref else {
            break;
        };
        if mapped_style_ref.is_empty() || mapped_style_ref == style_ref {
            break;
        }
        style_ref = mapped_style_ref;
    }

    None
}

fn merge_color_aggregates(
    color_counts: &mut HashMap<String, ColorAggregate>,
    kml_color_counts: HashMap<String, ColorAggregate>,
) {
    for (color_hex, kml_color_aggregate) in kml_color_counts {
        let color_aggregate = color_counts.entry(color_hex).or_default();
        color_aggregate.count += kml_color_aggregate.count;

        for (parent_folder_name, count) in
            kml_color_aggregate.parent_folder_counts
        {
            *color_aggregate
                .parent_folder_counts
                .entry(parent_folder_name)
                .or_insert(0) += count;
        }
    }
}

fn extract_top_colors_from_aggregates(
    color_counts: HashMap<String, ColorAggregate>,
) -> Vec<KmzColorInfo> {
    let mut color_vec: Vec<(String, ColorAggregate)> =
        color_counts.into_iter().collect();
    color_vec
        .sort_by(|a, b| b.1.count.cmp(&a.1.count).then_with(|| a.0.cmp(&b.0)));

    color_vec
        .into_iter()
        .take(crate::config::PALITRA_KMZ_TOP_COLORS_LIMIT)
        .map(|(color_hex, color_aggregate)| KmzColorInfo {
            color_hex,
            count: color_aggregate.count,
            suggested_suffix: pick_suggested_suffix(
                &color_aggregate.parent_folder_counts,
            ),
        })
        .collect()
}

fn pick_suggested_suffix(
    parent_folder_counts: &HashMap<String, i32>,
) -> Option<String> {
    let mut folder_vec: Vec<(&String, &i32)> =
        parent_folder_counts.iter().collect();
    folder_vec.sort_by(|a, b| b.1.cmp(a.1).then_with(|| a.0.cmp(b.0)));
    folder_vec
        .first()
        .map(|(folder_name, _)| (*folder_name).clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[tokio::test]
    async fn test_load_coordinates_from_kml() -> anyhow::Result<()> {
        let path = PathBuf::from("data/test.kml");
        let data = load_coordinates_from_kml(path.as_path()).await.c(h!())?;
        assert_eq!(data.len(), 2247);
        Ok(())
    }

    #[tokio::test]
    async fn test_load_coordinates_from_kmz() -> anyhow::Result<()> {
        let path = PathBuf::from("data/test.kmz");
        let data = load_coordinates_from_kmz(path.as_path()).await.c(h!())?;
        assert_eq!(data.len(), 6991);
        Ok(())
    }

    #[tokio::test]
    async fn test_load_coordinates_from_kmz_with_atom_link(
    ) -> anyhow::Result<()> {
        let path = PathBuf::from(
            "data/951. Срібні - Новопідгородне Райполе 433 мсп.kmz",
        );
        let data = load_coordinates_from_kmz(path.as_path()).await.c(h!())?;
        assert_eq!(data.len(), 991);

        let first = data
            .iter()
            .find(|point| point.label.as_deref() == Some("1"))
            .expect("first placemark present");
        assert!((first.coords.lat - 48.2371106).abs() < 1e-6);
        assert!((first.coords.lng - 36.9258872).abs() < 1e-6);

        let last = data
            .iter()
            .find(|point| point.label.as_deref() == Some("991"))
            .expect("last placemark present");
        assert!(
            (last.coords.lat - 48.2752553).abs() < 1e-6,
            "unexpected lat: {}",
            last.coords.lat
        );
        assert!(
            (last.coords.lng - 36.8752738).abs() < 1e-6,
            "unexpected lng: {}",
            last.coords.lng
        );

        Ok(())
    }
}
