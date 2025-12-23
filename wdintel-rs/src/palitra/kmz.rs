use crate::h;
use crate::kml::types::*;
use crate::palitra::types::*;
use crate::types::ShortContext;
use log::error;
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
    storage_dir: &Path,
) -> anyhow::Result<Vec<PalitraPoint>> {
    let persistent_path = storage_dir.join(file_name.clone());
    fs::write(persistent_path.as_path(), data.clone())
        .await
        .c(h!())?;

    let tmp_dir = tempdir()?;
    let path = tmp_dir.path().join(&file_name);
    fs::write(path.as_path(), data).await.c(h!())?;
    let extension = path.extension().c(h!())?.to_string_lossy().to_string();
    match extension.as_str() {
        "kmz" => load_coordinates_from_kmz(path.as_path()).await,
        "kml" => load_coordinates_from_kml(path.as_path()).await,
        _ => anyhow::bail!("Unsupported coordinates extension: {extension}"),
    }
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

/// Extracts colors from KML document and counts their usage
/// Returns top 3 most frequent colors with their counts
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

    let mut color_counts: HashMap<String, i32> = HashMap::new();

    for entry in walkdir.filter_map(|e| e.ok()) {
        if entry.file_type().is_file() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) == Some("kml") {
                match extract_colors_from_kml(path).await {
                    Ok(colors) => {
                        for color in colors {
                            *color_counts.entry(color).or_insert(0) += 1;
                        }
                    }
                    Err(e) => {
                        error!("Failed to extract colors from {path:?}: {e:?}");
                        continue;
                    }
                }
            }
        }
    }

    // Sort by count descending and take top 3
    let mut color_vec: Vec<(String, i32)> = color_counts.into_iter().collect();
    color_vec.sort_by(|a, b| b.1.cmp(&a.1));
    
    let top_colors = color_vec
        .into_iter()
        .take(3)
        .map(|(color_hex, count)| KmzColorInfo { color_hex, count })
        .collect();

    Ok(top_colors)
}

/// Extracts top 3 colors from a single KML file
pub async fn extract_top_colors_from_kml(
    kml_path: &Path,
) -> anyhow::Result<Vec<KmzColorInfo>> {
    let mut color_counts: HashMap<String, i32> = HashMap::new();

    match extract_colors_from_kml(kml_path).await {
        Ok(colors) => {
            for color in colors {
                *color_counts.entry(color).or_insert(0) += 1;
            }
        }
        Err(e) => {
            error!("Failed to extract colors from {kml_path:?}: {e:?}");
            return Err(e);
        }
    }

    // Sort by count descending and take top 3
    let mut color_vec: Vec<(String, i32)> = color_counts.into_iter().collect();
    color_vec.sort_by(|a, b| b.1.cmp(&a.1));
    
    let top_colors = color_vec
        .into_iter()
        .take(3)
        .map(|(color_hex, count)| KmzColorInfo { color_hex, count })
        .collect();

    Ok(top_colors)
}

/// Extracts colors from a single KML file
async fn extract_colors_from_kml(path: &Path) -> anyhow::Result<Vec<String>> {
    let parent = path.parent().c(h!())?;
    let doc = crate::kml::read_and_fix_kml(false, path, parent)
        .await
        .c(h!())?;
    
    let mut colors = Vec::new();
    let mut queue = doc.nodes;
    
    loop {
        let Some(node) = queue.pop() else {
            break;
        };
        
        match node {
            Node::Folder(n) => {
                // Process styles from Folder
                for style in &n.styles {
                    extract_color_from_style(style, &mut colors);
                }
                // Process child nodes
                for n in n.nodes {
                    queue.push(n);
                }
            }
            Node::Document(n) => {
                // Process styles from Document
                for style in &n.styles {
                    extract_color_from_style(style, &mut colors);
                }
                // Process cascading styles from Document
                for cs in &n.cascading_styles {
                    if let Some(style) = &cs.style {
                        extract_color_from_style(style, &mut colors);
                    }
                }
                // Process child nodes
                for n in n.nodes {
                    queue.push(n);
                }
            }
            Node::Placemark(p) => {
                // Extract color from inline style
                if let Some(style) = p.style {
                    extract_color_from_style(&style, &mut colors);
                }
            }
            Node::Style(s) => {
                extract_color_from_style(&s, &mut colors);
            }
            Node::StyleMap(_) => {
                // StyleMaps not yet processed for colors
            }
            Node::CascadingStyle(cs) => {
                if let Some(style) = cs.style {
                    extract_color_from_style(&style, &mut colors);
                }
            }
            _ => continue,
        }
    }
    
    Ok(colors)
}

fn extract_color_from_style(style: &Style, colors: &mut Vec<String>) {
    // Extract from IconStyle
    if let Some(icon_style) = &style.icon_style {
        if let Some(color) = &icon_style.color {
            if let Ok(hex_color) = kml_color_to_hex(&color.body) {
                colors.push(hex_color);
            }
        }
    }
    
    // Extract from LineStyle
    if let Some(line_style) = &style.line_style {
        if let Some(color) = &line_style.color {
            if let Ok(hex_color) = kml_color_to_hex(&color.body) {
                colors.push(hex_color);
            }
        }
    }
    
    // Extract from PolyStyle
    if let Some(poly_style) = &style.poly_style {
        if let Some(color) = &poly_style.color {
            if let Ok(hex_color) = kml_color_to_hex(&color.body) {
                colors.push(hex_color);
            }
        }
    }
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
