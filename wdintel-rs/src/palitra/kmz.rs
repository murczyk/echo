use crate::h;
use crate::kml::types::*;
use crate::palitra::types::*;
use crate::types::ShortContext;
use log::error;
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
}
