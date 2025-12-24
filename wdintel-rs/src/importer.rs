use crate::error::AppError;
use crate::here;
use crate::kml::types::*;
use crate::types::*;
use crate::utils::trim_lines;
use actix_web::post;
use actix_web::web::Json;
use actix_web::HttpRequest;
use anyhow::Context;
use chrono::prelude::*;
use elm_rs::{Elm, ElmDecode, ElmEncode};
use log::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use tempfile::TempDir;
use walkdir::WalkDir;

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct RowInfo {
    pub content: String,
    pub image_urls: Vec<String>,
    pub lat: String,
    pub lng: String,
    pub title: String,
    pub icon: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct DownloadKmzReq {
    pub rows: Vec<RowInfo>,
    pub folder_name: String,
}

pub fn icon_to_style_id(icon: &str) -> String {
    format!("st_icon_{icon}")
}

#[post("/api/importer/download/operatyvka.kmz")]
async fn download_kmz(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    http_req: HttpRequest,
    req: Json<DownloadKmzReq>,
) -> Result<actix_web::HttpResponse, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Basic")
        .await
        .c(h!())?;
    let mut nodes = vec![];
    let mut style_ids = BTreeMap::new();
    for row in req.rows.iter() {
        match style_ids.get(&row.icon) {
            Some(_style_id) => {}
            None => {
                style_ids.insert(row.icon.clone(), icon_to_style_id(&row.icon));
            }
        }
    }
    let mut styles = vec![];
    for (icon, style_id) in style_ids.iter() {
        styles.push(Style {
            id: Some(style_id.clone()),
            icon_style: Some(IconStyle {
                color: None,
                scale: Some(Scale {
                    body: "1.0".to_string(),
                }),
                icon: Some(Icon {
                    href: Some(Href {
                        body: Some(icon.to_string()),
                    }),
                }),
            }),
            balloon_style: None,
            line_style: None,
            poly_style: None,
            label_style: None,
        });
    }
    for row in req.rows.iter() {
        let mut imgs_s = "".to_string();
        for image_url in row.image_urls.iter() {
            imgs_s.push_str(&format!(
                r###"<div><a target="_blank" href="{image_url}"><img src="{image_url}" style="max-width=600px; max-height: 600px;"/></a></div>"###
            ));
        }
        let description = format!(
            "{}\n\n{}",
            trim_lines(&row.content).replace('\n', "<br>\n"),
            imgs_s
        );
        nodes.push(Node::Placemark(Placemark {
            name: Some(trim_lines(&row.title)),
            visibility: None,
            description: Some(description),
            style_url: Some(StyleUrl {
                body: format!("#{}", icon_to_style_id(&row.icon)),
            }),
            style: None,
            point: Some(Point {
                draw_order: None,
                coordinates: Some(format!("{},{},0", row.lng, row.lat)),
            }),
            line_string: None,
            multi_geometry: None,
            polygon: None,
            extended_data: None,
            snippet: None,
            snippet_lower: None,
        }));
    }
    let now = Utc::now();
    let (_is_common_era, year) = now.year_ce();
    let folder_name = req
        .folder_name
        .clone()
        .replace(
            "<DATETIME>",
            &format!(
                "{}-{:02}-{:02}-{:02}-{:02}",
                year,
                now.month(),
                now.day(),
                now.hour(),
                now.minute()
            ),
        )
        .replace(
            "<DATE>",
            &format!("{}-{:02}-{:02}", year, now.month(), now.day()),
        );
    let folder = Folder {
        name: Some(Name { body: folder_name }),
        look_at: None,
        description: None,
        open: None,
        styles,
        style_maps: vec![],
        visibility: None,
        snippet: None,
        snippet_lower: None,
        link: None,
        camera: None,
        gx_balloon_visibility: None,
        schema: vec![],
        nodes,
    };
    let node = Node::Folder(folder);
    let kml: Kml = Kml { nodes: vec![node] };
    let tmp_dir = TempDir::new()?;
    // keep res to not remove tmp dir
    let dst_file_res = package_up_kmz(
        Arc::new(tmp_dir),
        kml,
        style_ids,
        crate::icons::get_icon_path(&env.config),
    )
    .await
    .context(here!())?;
    let dst_file = dst_file_res.path;
    let file = actix_files::NamedFile::open_async(dst_file).await.c(h!())?;
    Ok(file.into_response(&http_req))
}

pub struct PackageUpKmzRes {
    pub dir: Arc<TempDir>,
    pub path: PathBuf,
}

pub async fn package_up_kmz(
    tmp_dir: Arc<TempDir>,
    kml: Kml,
    style_ids: BTreeMap<String, String>,
    icon_path: PathBuf,
) -> Result<PackageUpKmzRes, AppError> {
    let tmp_dir2 = tmp_dir.clone();

    // do all work in bg thread to not block
    let j = tokio::task::spawn_blocking(move || {
        let base_path = tmp_dir2.path().join("operatyvka");
        debug!("> create dir {}", base_path.display());
        debug!("> icon path 1: {}", icon_path.display());
        std::fs::create_dir(&base_path)?;
        std::fs::write(
            base_path.join("doc.kml"),
            crate::kml::views::render_kml(&kml)?,
        )?;
        for (icon, _style_id) in style_ids.iter() {
            // println!(
            //     "> copy {} into {}",
            //     // &get_icon_path(mode)?.join(icon).display(),
            //     icon_path.join(icon).display(),
            //     base_path.join(icon).display()
            // );
            if let Err(e) = std::fs::copy(
                // &get_icon_path(mode)?.join(icon),
                icon_path.join(icon),
                base_path.join(icon),
            ) {
                if !known_to_error(icon) {
                    eprintln!("> error in copying {icon}: {e:?}");
                }
            }
        }
        crate::utils::backup_tmp_dir(tmp_dir2.path())?;
        let dst_file: PathBuf = tmp_dir2.path().join("operatyvka.kmz");
        debug!("dst_file: {}", dst_file.display());
        let walkdir = WalkDir::new(&base_path);
        let it = walkdir.into_iter();
        debug!("creating dst_file {}", dst_file.display());
        let dst_file_opened =
            std::fs::File::create(&dst_file).context(here!())?;
        debug!("zip on dir {}", base_path.to_string_lossy());
        crate::utils::zip::zip_dir(
            &mut it.filter_map(|e| e.ok()),
            &base_path.to_string_lossy(),
            &dst_file_opened,
            zip::CompressionMethod::Deflated,
        )
        .context(here!())?;
        debug!("zip done");
        Ok::<PathBuf, AppError>(dst_file)
    });
    let dst_file = j.await.context(here!())?.context(here!())?;

    Ok(PackageUpKmzRes {
        dir: tmp_dir,
        path: dst_file,
    })
}

/// A cleaner attempt for packaging up kmz
pub fn package_up_kmz2(
    config: &crate::config::Config,
    tmp_dir: &TempDir,
    kml: &Kml,
) -> Result<PathBuf, AppError> {
    let base_path = tmp_dir.path().join("operatyvka");
    let icon_path = crate::icons::get_icon_path(config);
    println!("> create dir {}", base_path.display());
    println!("> icon path 2: {}", icon_path.display());
    std::fs::create_dir(&base_path)?;
    std::fs::write(
        base_path.join("doc.kml"),
        crate::kml::views::render_kml(kml)?,
    )?;
    let mut icons: Vec<String> = vec![];
    icons.extend(
        crate::kml::extract_style_maps(&kml.nodes)?
            .values()
            .cloned(),
    );
    icons.extend(
        crate::kml::extract_style_maps_hightlight(&kml.nodes)?
            .values()
            .cloned(),
    );
    for icon in icons.iter() {
        // println!(
        //     "> copy {} into {}",
        //     // &get_icon_path(mode)?.join(icon).display(),
        //     icon_path.join(icon).display(),
        //     base_path.join(icon).display()
        // );
        if let Err(e) = std::fs::copy(
            // &get_icon_path(mode)?.join(icon),
            icon_path.join(icon),
            base_path.join(icon),
        ) {
            if !known_to_error(icon) {
                eprintln!("> error in copying {icon}: {e:?}");
            }
        }
    }
    let dst_file: PathBuf = tmp_dir.path().join("operatyvka.kmz");
    println!("> dst_file: {}", dst_file.display());
    let walkdir = WalkDir::new(&base_path);
    let it = walkdir.into_iter();
    let dst_file_opened = std::fs::File::create(&dst_file)?;
    crate::utils::zip::zip_dir(
        &mut it.filter_map(|e| e.ok()),
        &base_path.to_string_lossy(),
        &dst_file_opened,
        zip::CompressionMethod::Deflated,
    )?;
    Ok(dst_file)
}

fn known_to_error(icon: &str) -> bool {
    let known = [
        "10012500002902020000.png",
        "10012500002902040000.png",
        "10032500002902020000.png",
        "10052500002909000000.png",
        "10062500001510000000.png",
        "10062500002902020000.png",
        "10062500002902040000.png",
        "10062500002909000000.png",
        "10062500002910000000.png",
        "10062510001510000000.png",
        "10062510002909000000.png",
    ];
    known.contains(&icon)
}
