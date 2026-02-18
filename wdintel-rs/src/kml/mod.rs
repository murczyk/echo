use crate::delta::bgtask_log2;
use crate::error::AppError;
use crate::kml::types::*;
use crate::types::*;
use crate::utils::*;
use ::zip::CompressionMethod;
use actix_identity::Identity;
use actix_multipart::Multipart;
use actix_web::web::Json;
use actix_web::HttpRequest;
use actix_web::{get, post};
use async_recursion::async_recursion;
use futures_util::StreamExt;
use lazy_static::lazy_static;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tempfile::TempDir;
use walkdir::WalkDir;

pub mod types;
pub mod views;

pub struct RadioRenderOutputs {
    pub csv_name: String,
    pub csv_bytes: Vec<u8>,
    pub kmz_per_date_name: String,
    pub kmz_per_date_bytes: Vec<u8>,
    pub kmz_per_radio_name: String,
    pub kmz_per_radio_bytes: Vec<u8>,
}

pub fn main_test_kml(mode: Mode) -> Result<(), AppError> {
    let kml_path = crate::config::get_data_folder(mode)?.join("myplaces.kml");
    // let kml_path = Path::new("/Users/kon/Downloads/myplaces2.kml");

    let input: String = std::fs::read_to_string(kml_path)?;
    let kml: Kml = quick_xml::de::from_str(&input).c(h!())?;
    println!("{}", crate::kml::views::render_kml(&kml)?);
    println!("{:?}", extract_style_maps(&kml.nodes));
    Ok(())
}

pub fn read_myplaces(mode: Mode) -> Result<Kml, AppError> {
    let kml_path: PathBuf =
        crate::config::get_data_folder(mode)?.join("myplaces.kml");
    // let reader = quick_xml::reader::Reader::from_file(kml_path)
    //     .map_err(|e| eyre!("xml error: {:?}", e))?;
    // let kml: Kml = quick_xml::de::from_reader(reader)
    //     .map_err(|e| eyre!("xml error: {:?}", e))?;
    let input: String = std::fs::read_to_string(kml_path)?;
    let kml: Kml = quick_xml::de::from_str(&input).c(h!())?;
    Ok(kml)
}

#[post("/api/kml/operatyvka.json")]
async fn operatyvka(
    user: Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<Operatyvka>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Bpla")
        .await
        .c(h!())?;
    let kml = read_myplaces(env.mode)?;
    let folders = extract_operatyvka_folders(&kml)?;
    let operatyvka = Operatyvka { folders };
    Ok(Json(operatyvka))
}

pub fn extract_operatyvka_folders(kml: &Kml) -> Result<Vec<Folder>, AppError> {
    let mut folders = vec![];
    // x1 = мої місця
    if let Some(folder) =
        node_as_folder(kml.nodes.first().ok_or("must not be empty")?)?
    {
        if let Some(x1) = folder.nodes.first() {
            if let Some(folder1) = node_as_folder(x1)? {
                for x2 in folder1.nodes.iter() {
                    let Some(folder2) = node_as_folder(x2)? else {
                        continue;
                    };
                    if interesting_folder_name(
                        &folder2
                            .name
                            .clone()
                            .map(|x| x.body)
                            .unwrap_or("".to_string()),
                    ) {
                        folders.push(folder2.clone());
                    }
                }
            }
        }
    }
    Ok(folders)
}

fn document_to_folder(doc: &Document) -> Folder {
    let mut styles = doc.styles.clone();
    styles.extend(
        doc.cascading_styles
            .clone()
            .iter()
            .filter_map(|x| x.style.clone()),
    );
    Folder {
        name: doc.name.clone(),
        look_at: doc.look_at.clone(),
        description: doc.description.clone(),
        open: doc.open.clone(),
        styles,
        style_maps: doc.style_maps.clone(),
        visibility: doc.visibility.clone(),
        snippet: doc.snippet.clone(),
        snippet_lower: doc.snippet_lower.clone(),
        link: doc.link.clone(),
        camera: doc.camera.clone(),
        gx_balloon_visibility: doc.gx_balloon_visibility.clone(),
        schema: doc.schema.clone(),
        nodes: doc.nodes.clone(),
    }
}

/// If it's a folder or a document -- convert into a folder.  If it 's
/// placement -- return None.
fn node_as_folder(node: &Node) -> Result<Option<Folder>, AppError> {
    match node {
        Node::Placemark(_) => Ok(None),
        Node::Folder(f) => Ok(Some(f.clone())),
        Node::Document(d) => Ok(Some(document_to_folder(d))),
        Node::NetworkLink(_) => Ok(None),
        Node::Style(_) => Ok(None),
        Node::CascadingStyle(_) => Ok(None),
        Node::StyleMap(_) => Ok(None),
        Node::Author(_) => Ok(None),
        Node::AtomLink(_) => Ok(None),
    }
}

/// Maps style id into an icon href like
/// "sn_Механізовані, ОіВТ300" -> C:/Users/Zip/Pictures/NATO/механізовані підрозділи, ОіВТ/Механізовані, ОіВТ.png
pub fn extract_style_maps(
    nodes: &[Node],
) -> Result<BTreeMap<String, String>, AppError> {
    extract_style_maps_gen(nodes, true, "normal")
}

pub fn extract_style_maps_hightlight(
    nodes: &[Node],
) -> Result<BTreeMap<String, String>, AppError> {
    extract_style_maps_gen(nodes, false, "highlight")
}

/// Maps style id into an icon href like
/// "sn_Механізовані, ОіВТ300" -> C:/Users/Zip/Pictures/NATO/механізовані підрозділи, ОіВТ/Механізовані, ОіВТ.png
pub fn extract_style_maps_gen(
    nodes: &[Node],
    keep_direct_styles: bool,
    key: &str,
) -> Result<BTreeMap<String, String>, AppError> {
    let mut style_maps: BTreeMap<String, String> = BTreeMap::new();
    let mut rv = BTreeMap::new();
    for node in nodes.iter() {
        if let Some(folder) = node_as_folder(node)? {
            for style in folder.styles.iter() {
                if let Some(id) = style.id.clone() {
                    if let Some(icon_style) = &style.icon_style {
                        if let Some(icon) = &icon_style.icon {
                            if let Some(href) = &icon.href {
                                if let Some(ref body) = href.body {
                                    rv.insert(id.clone(), body.clone());
                                }
                            }
                        }
                    }
                }
            }
            for style_map in folder.style_maps.iter() {
                if let Some(style_map_id) = &style_map.id {
                    for pair in style_map.pairs.iter() {
                        if pair.key.body == key
                            && pair.style_url.body.starts_with('#')
                        {
                            let style_url_stripped: String =
                                pair.style_url.body.chars().skip(1).collect();
                            style_maps.insert(
                                style_map_id.clone(),
                                style_url_stripped.clone(),
                            );
                        }
                    }
                }
            }
            let rv2 = rv.clone();
            if !keep_direct_styles {
                rv = BTreeMap::new();
            };
            for (k, v) in style_maps.iter() {
                if let Some(href) = rv2.get(v) {
                    rv.insert(k.clone(), href.clone());
                }
            }
            let inner_map1 =
                extract_style_maps_gen(&folder.nodes, keep_direct_styles, key)?;
            rv.extend(inner_map1);
        }
    }
    Ok(rv)
}

fn interesting_folder_name(x: &str) -> bool {
    x.starts_with("202") || x.to_lowercase().contains("лбз")
}

#[derive(Deserialize)]
struct OperatyvkaDownloadReq {
    folder: String,
}

#[get("/api/kml/operatyvka/download")]
async fn operatyvka_download(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    http_req: HttpRequest,
    req: actix_web::web::Query<OperatyvkaDownloadReq>,
) -> Result<actix_web::HttpResponse, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Bpla")
        .await
        .c(h!())?;
    let kml = read_myplaces(env.mode)?;
    let folders = extract_operatyvka_folders(&kml)?;
    let style_maps = extract_style_maps(&kml.nodes)?;
    for folder in folders.iter() {
        if folder.name.as_ref().map(|x| &x.body) == Some(&req.folder) {
            let mut new_style_maps_map: BTreeMap<String, String> =
                BTreeMap::new();
            let mut style_ids = BTreeMap::new();
            for placemark in folder_placemarks(folder)?.iter() {
                if let Some(style_url) = &placemark.style_url {
                    let style_url_stripped: String =
                        style_url.body.chars().skip(1).collect();
                    if let Some(tsup_icon) = style_maps.get(&style_url_stripped)
                    {
                        let icon = crate::icons::convert_tsup_icon(tsup_icon)?;
                        match style_ids.get(&icon) {
                            Some(_style_id) => {}
                            None => {
                                style_ids.insert(
                                    icon.clone(),
                                    crate::importer::icon_to_style_id(&icon),
                                );
                            }
                        }
                        new_style_maps_map.insert(
                            style_url_stripped,
                            crate::importer::icon_to_style_id(&icon),
                        );
                    } else {
                        println!(
                            "warning: style map not found for url: {}",
                            &style_url.body
                        );
                    }
                }
            }

            let mut styles = vec![];
            let mut style_ids_covered = BTreeSet::new();
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
                style_ids_covered.insert(style_id.clone());
            }
            let mut new_style_maps: Vec<StyleMap> = vec![];
            for (style_map_id, style_url) in new_style_maps_map.iter() {
                let style_url_prefixed = format!("#{style_url}");
                if !style_ids_covered.contains(style_map_id) {
                    new_style_maps.push(StyleMap {
                        id: Some(style_map_id.clone()),
                        pairs: vec![
                            Pair {
                                key: Key {
                                    body: "normal".to_string(),
                                },
                                style_url: StyleUrl {
                                    body: style_url_prefixed.clone(),
                                },
                            },
                            Pair {
                                key: Key {
                                    body: "highlight".to_string(),
                                },
                                style_url: StyleUrl {
                                    body: style_url_prefixed,
                                },
                            },
                        ],
                    });
                }
            }

            let mut folder2 = folder.clone();
            folder2.style_maps = new_style_maps;
            folder2.styles = styles;
            let kml = Kml {
                nodes: vec![Node::Folder(folder2)],
            };
            let tmp_dir = TempDir::new()?;
            println!("> style_ids: {style_ids:?}");
            // keep res to not remove tmp dir
            let dst_file_res = crate::importer::package_up_kmz(
                Arc::new(tmp_dir),
                kml,
                style_ids,
                crate::icons::get_icon_path(&env.config),
            )
            .await
            .c(h!())?;
            let dst_file = dst_file_res.path;
            let file =
                actix_files::NamedFile::open_async(dst_file).await.c(h!())?;
            // todo: insert headers for content-type and content-disposition?
            return Ok(file.into_response(&http_req));
        }
    }
    Ok(actix_web::HttpResponseBuilder::new(
        actix_web::http::StatusCode::NOT_FOUND,
    )
    .body("Folder not found"))
}

/// Gather all placemarks recursively
pub fn folder_placemarks(folder: &Folder) -> Result<Vec<Placemark>, AppError> {
    let mut rv = vec![];
    for node in folder.nodes.iter() {
        match node {
            Node::Placemark(p) => rv.push(p.clone()),
            Node::Folder(f) => {
                rv.extend(folder_placemarks(f)?);
            }
            Node::Document(d) => {
                rv.extend(folder_placemarks(&document_to_folder(d))?);
            }
            Node::NetworkLink(_) => {}
            Node::Style(_) => {}
            Node::CascadingStyle(_) => {}
            Node::StyleMap(_) => {}
            Node::Author(_) => {}
            Node::AtomLink(_) => {}
        }
    }
    Ok(rv)
}

pub fn gather_all_placemarks(
    nodes: &[Node],
) -> Result<Vec<Placemark>, AppError> {
    let mut ret_val = vec![];
    for node in nodes.iter() {
        match node {
            Node::Placemark(x) => {
                ret_val.push(x.clone());
            }
            Node::Folder(x) => ret_val.extend(gather_all_placemarks(&x.nodes)?),
            Node::Document(x) => {
                ret_val.extend(gather_all_placemarks(&x.nodes)?)
            }
            Node::NetworkLink(_) => {}
            Node::Style(_) => {}
            Node::CascadingStyle(_) => {}
            Node::StyleMap(_) => {}
            Node::Author(_) => {}
            Node::AtomLink(_) => {}
        }
    }
    Ok(ret_val)
}

pub fn oneoff_print_description_icon_title(mode: Mode) -> Result<(), AppError> {
    #[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
    struct Row {
        pub title: String,
        pub icon: String,
        pub descrption: String,
    }

    let kml_path: PathBuf =
        crate::config::get_data_folder(mode)?.join("myplaces.kml");
    let input: String = std::fs::read_to_string(kml_path)?;
    let kml: Kml = quick_xml::de::from_str(&input).c(h!())?;
    let placemarks = gather_all_placemarks(&kml.nodes)?;
    let style_map = extract_style_maps(&kml.nodes)?;
    // println!("> style_map: {:?}", style_map);
    // println!("> kml: {}", &serde_json::to_string(&kml)?);
    let mut ret_val: Vec<Row> = vec![];
    for placemark in placemarks.iter() {
        let Some(placemark_name) = &placemark.name else {
            continue;
        };
        let Some(style_url) = &placemark.style_url else {
            continue;
        };
        let style_url_stripped: String =
            style_url.body.chars().skip(1).collect();
        let Some(icon) = style_map.get(&style_url_stripped) else {
            continue;
        };
        let icon_stripped: String = match icon.rfind('/') {
            Some(pos) => String::from_utf8(
                icon.as_bytes().iter().skip(pos + 1).cloned().collect(),
            )
            .c(h!())?,
            None => icon.clone(),
        };
        ret_val.push(Row {
            title: placemark_name.clone(),
            icon: icon_stripped,
            descrption: placemark.description.clone().unwrap_or("".to_string()),
        });
    }
    println!("{}", serde_json::to_string(&ret_val).c(h!())?);
    Ok(())
}

pub async fn oneoff_radio_by_freq() -> Result<(), AppError> {
    let kml_path = Path::new(
        "/Users/kon/Library/Application Support/Google Earth/myplaces.kml",
    );
    let kml: Kml =
        quick_xml::de::from_str(&std::fs::read_to_string(kml_path)?).c(h!())?;
    let rer = get_rer_folders(&kml)?;
    let mut per_freq_per_date: BTreeMap<
        String,
        BTreeMap<String, Vec<Placemark>>,
    > = BTreeMap::new();
    for folder in rer.iter() {
        let folder_name = folder.name_s();
        println!("> rer folder: {}", &folder_name);
        lazy_static! {
            static ref RE_DATE: Regex =
                Regex::new(r"(?P<date>\d\d\d\d-\d\d-\d\d)").unwrap();
        }
        let capts = RE_DATE
            .captures(&folder_name)
            .ok_or("failed parsing date")?;
        let date = capts
            .name("date")
            .ok_or("No match date")?
            .as_str()
            .to_string();
        // gathering the map
        for placemark in folder_placemarks(folder)?.iter() {
            let Some(placemark_name) = placemark.name.clone() else {
                continue;
            };
            lazy_static! {
                static ref RE_FREQ: Regex =
                    Regex::new(r"(?P<freq>\d+\.\d+)").unwrap();
            }
            let Some(capts) = RE_FREQ.captures(&placemark_name) else {
                continue;
            };
            let freq: String = capts
                .name("freq")
                .ok_or("No match freq")?
                .as_str()
                .to_string();
            per_freq_per_date
                .entry(freq.clone())
                .and_modify(|per_date| {
                    per_date
                        .entry(date.clone())
                        .and_modify(|xs| xs.push(placemark.clone()))
                        .or_default();
                })
                .or_insert(new_btmap(date.clone(), vec![placemark.clone()]));
        }
    }
    // rendering the map
    let mut kml_nodes = vec![];
    for (freq, per_date_map) in per_freq_per_date.iter() {
        let mut freq_nodes = vec![];
        for (date, vs) in per_date_map.iter() {
            let mut date_nodes = vec![];
            for v in vs.iter() {
                date_nodes.push(Node::Placemark(v.clone()));
            }
            let date_folder = Folder {
                name: Some(Name { body: date.clone() }),
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
                nodes: date_nodes,
            };
            freq_nodes.push(Node::Folder(date_folder));
        }
        let freq_folder = Folder {
            name: Some(Name { body: freq.clone() }),
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
            nodes: freq_nodes,
        };
        kml_nodes.push(Node::Folder(freq_folder));
    }
    let kml_fol1 =
        node_as_folder(kml.nodes.first().ok_or("kml has no nodes")?)?
            .ok_or("kml node must be a folderish")?;
    let root_node = Node::Folder(Folder {
        name: Some(Name {
            body: "РЕР".to_string(),
        }),
        look_at: None,
        description: None,
        open: None,
        styles: kml_fol1.styles.clone(),
        style_maps: kml_fol1.style_maps,
        visibility: None,
        snippet: None,
        snippet_lower: None,
        link: None,
        camera: None,
        gx_balloon_visibility: None,
        schema: vec![],
        nodes: kml_nodes,
    });
    let res_kml = Kml {
        nodes: vec![root_node],
    };
    // persist with styles and icons
    let tmp_dir = TempDir::new()?;
    let style_maps = extract_style_maps(&kml.nodes)?;
    let mut style_maps_reversed = BTreeMap::new();
    for (style, icon) in style_maps {
        style_maps_reversed.insert(icon, style);
    }
    let path = Path::new(kml_path);
    let path = path.parent().ok_or("no parent")?;
    // keep res to not remove tmp dir
    let dst_file_res = crate::importer::package_up_kmz(
        Arc::new(tmp_dir),
        res_kml,
        style_maps_reversed,
        path.to_path_buf(),
    )
    .await
    .c(h!())?;
    let dst_file = dst_file_res.path;
    println!("> done packaging {}", dst_file.display());
    std::fs::copy(dst_file, "/Users/kon/Downloads/rer.kmz")?;
    println!("> done. see /Users/kon/Downloads/rer.kmz");
    for (freq, per_date_map) in per_freq_per_date.iter() {
        let num_items: usize = per_date_map.values().map(|v| v.len()).sum();
        println!("> freq: {freq}, items: {num_items}");
    }
    Ok(())
}

fn get_rer_folders(kml: &Kml) -> Result<Vec<Folder>, AppError> {
    let mut res = vec![];
    for node in kml.nodes.iter() {
        let Some(folder) = node_as_folder(node)? else {
            continue;
        };
        if folder.name_s() == *"default_my_places" {
            for node in folder.nodes.iter() {
                let Some(folder) = node_as_folder(node)? else {
                    continue;
                };
                if folder.name_s() == *"Мої місця" {
                    for node in folder.nodes.iter() {
                        let Some(folder) = node_as_folder(node)? else {
                            continue;
                        };
                        if folder.name_s() == *"РЕР" {
                            for node in folder.nodes.iter() {
                                let Some(folder) = node_as_folder(node)? else {
                                    continue;
                                };
                                res.push(folder.clone());
                            }
                        }
                    }
                }
            }
        }
    }
    res.sort_by(|a, b| a.name_s().partial_cmp(&b.name_s()).unwrap());
    Ok(res)
}

/// Checks broken images, ideally replaces them
pub async fn oneoff_fix_kml_main(
    mode: Mode,
    ps: &crate::OneoffFixKmzPs,
) -> Result<(), AppError> {
    oneoff_fix_kml(mode, ps).await.c(h!())?;
    Ok(())
}

/// Checks broken images, ideally replaces them
pub async fn oneoff_fix_kml(
    mode: Mode,
    ps: &crate::OneoffFixKmzPs,
) -> Result<(), AppError> {
    let config = crate::config::read_config(mode)?;
    let kmz_path = Path::new(&ps.kmz);
    let tmp_dir = TempDir::new()?;
    let kmz_fname = kmz_path.file_name().ok_or("no filename")?;
    let tmp_dir_kmz = tmp_dir.path().join(kmz_fname);
    std::fs::copy(kmz_path, &tmp_dir_kmz)?;
    crate::utils::zip::unzip(&tmp_dir_kmz)?;
    std::fs::remove_file(&tmp_dir_kmz)?;
    crate::utils::backup_tmp_dir(tmp_dir.path())?;
    // todo: list dir, search for kml file name
    let mut kml_path = tmp_dir
        .path()
        .join(kmz_path.file_stem().ok_or("no stem 28471")?)
        .join("doc.kml");
    if !kml_path.exists() {
        kml_path = tmp_dir.path().join("doc.kml");
    }
    println!("> kml_path: {kml_path:?}");
    let base_path = Path::new(&kml_path)
        .parent()
        .ok_or("base path doesnt exist")?;
    let kml =
        read_and_fix_kml(ps.hide_titles, kml_path.as_path(), base_path).await?;

    let tmp_dir_res = TempDir::new()?;
    let res_p = tmp_dir_res.path();
    std::fs::write(
        res_p.join("doc.kml"),
        crate::kml::views::render_kml(&kml)?,
    )?;

    // copy icons into kmz output directory
    let style_map = extract_style_maps(&kml.nodes.clone())?;
    for (_style_name, icon) in style_map.iter() {
        // let icon: String = icon.chars().skip(1).collect();
        let mut icon = base_path.join(icon);
        if !icon.exists() {
            icon = crate::icons::get_icon_path(&config)
                .join(icon.file_name().ok_or("no icon name")?);
        }
        let icon_suffix = match icon.strip_prefix(base_path) {
            Ok(v) => v,
            Err(_) => Path::new(icon.file_name().ok_or("can't get filename")?),
        };
        let icon_dist = res_p.join(icon_suffix);
        std::fs::create_dir_all(icon_dist.parent().ok_or("no parent")?)?;
        // let icon_dist = res_p.join(icon.file_name().ok_or("no file name")?);
        // println!("> cp {} {}", icon.display(), icon_dist.display());
        if let Err(e) = std::fs::copy(&icon, &icon_dist) {
            eprintln!(
                "> error {:?} on cp {} {}",
                e,
                &icon.display(),
                &icon_dist.display()
            );
        }
    }

    // crate::utils::backup_tmp_dir(&res_p)?;

    let walkdir = WalkDir::new(res_p);
    let it = walkdir.into_iter();
    let dst_file_opened = std::fs::File::create(&ps.res)?;
    crate::utils::zip::zip_dir(
        &mut it.filter_map(|e| e.ok()),
        &res_p.to_string_lossy(),
        &dst_file_opened,
        CompressionMethod::Deflated,
    )
    .c(h!())?;

    Ok(())
}

pub async fn read_and_fix_kml(
    hide_titles: bool,
    kml_path: &Path,
    base_path: &Path,
) -> Result<Kml, AppError> {
    let input = std::fs::read_to_string(kml_path)?;
    let input = strip_kml_description(&input)?;
    let mut kml: Kml = quick_xml::de::from_str(&input).c(h!())?;
    let style_maps = extract_style_maps(&kml.nodes.clone())?;
    let style_maps_highlight =
        extract_style_maps_hightlight(&kml.nodes.clone())?;
    let mut replacement_map: BTreeMap<String, String> = BTreeMap::new();
    let mut image_checksums: BTreeMap<String, String> = BTreeMap::new();
    for node in kml.nodes.iter() {
        oneoff_fix_kml_go1(
            &style_maps,
            base_path,
            node,
            &mut replacement_map,
            &mut image_checksums,
        )
        .await
        .c(h!())?;
    }
    let mut checksum_image: BTreeMap<String, String> = BTreeMap::new();
    for (k, v) in image_checksums.iter() {
        checksum_image.insert(v.clone(), k.clone());
    }
    for node in kml.nodes.iter_mut() {
        oneoff_fix_kml_go2(
            base_path,
            node,
            &replacement_map,
            &image_checksums,
            &checksum_image,
            hide_titles,
            &style_maps,
            &style_maps_highlight,
        )?;
    }
    Ok(kml)
}

fn strip_kml_description(input: &str) -> Result<String, AppError> {
    let re = Regex::new(r"(?s)<description>.*?</description>").c(h!())?;
    Ok(re
        .replace_all(input, "<description></description>")
        .to_string())
}

#[async_recursion]
pub async fn oneoff_fix_kml_go1(
    style_map: &BTreeMap<String, String>,
    base_path: &Path,
    node: &Node,
    replacement_map: &mut BTreeMap<String, String>,
    image_checksums: &mut BTreeMap<String, String>,
) -> Result<(), AppError> {
    match node {
        Node::Folder(x) => {
            for node in x.nodes.iter() {
                oneoff_fix_kml_go1(
                    style_map,
                    base_path,
                    node,
                    replacement_map,
                    image_checksums,
                )
                .await
                .c(h!())?;
            }
        }
        Node::Document(x) => {
            for node in x.nodes.iter() {
                oneoff_fix_kml_go1(
                    style_map,
                    base_path,
                    node,
                    replacement_map,
                    image_checksums,
                )
                .await
                .c(h!())?;
            }
        }
        Node::Placemark(placemark) => {
            let Some(style_url) = placemark.style_url.clone() else {
                return Ok(());
            };
            let style_url: String = style_url.body;
            let style_url: String = style_url.chars().skip(1).collect();
            // println!("> style_url: {:?}", style_url);
            let Some(icon) = style_map.get(&style_url) else {
                return Ok(());
            };
            let icon_full_path = base_path.join(icon);
            // println!("> icon_full_path: {}", icon_full_path.display());
            if !icon_full_path.exists() {
                // println!("> non-existing path: {}", icon_full_path.display());
                let replacement_icon = crate::icons::convert_tsup_icon(icon)?;
                // let replacement_icon =
                //     Path::new("../wdintel-web/public/img/google_earth_icons")
                //         .join(replacement_icon);
                // println!("> would replace with: {}", replacement_icon);
                replacement_map.insert(icon.to_string(), replacement_icon);
            } else {
                let checksum =
                    sha256::try_async_digest(icon_full_path.as_path())
                        .await
                        .c(h!())?;
                image_checksums.insert(icon.to_string(), checksum);
            }
        }
        Node::NetworkLink(_) => {}
        Node::Style(_) => {}
        Node::CascadingStyle(_) => {}
        Node::StyleMap(_) => {}
        Node::Author(_) => {}
        Node::AtomLink(_) => {}
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub fn oneoff_fix_kml_go2(
    _base_path: &Path,
    node: &mut Node,
    replacement_map: &BTreeMap<String, String>,
    image_checksums: &BTreeMap<String, String>,
    checksum_image: &BTreeMap<String, String>,
    hide_titles: bool,
    style_maps: &BTreeMap<String, String>,
    style_maps_highlight: &BTreeMap<String, String>,
) -> Result<(), AppError> {
    match node {
        Node::Folder(x) => {
            for node in x.nodes.iter_mut() {
                oneoff_fix_kml_go2(
                    _base_path,
                    node,
                    replacement_map,
                    image_checksums,
                    checksum_image,
                    hide_titles,
                    style_maps,
                    style_maps_highlight,
                )?;
            }
            for style in x.styles.iter_mut() {
                oneoff_fix_kml_replace_style(
                    style,
                    replacement_map,
                    image_checksums,
                    checksum_image,
                    hide_titles,
                    style_maps,
                    style_maps_highlight,
                )?;
            }
        }
        Node::Document(x) => {
            for node in x.nodes.iter_mut() {
                oneoff_fix_kml_go2(
                    _base_path,
                    node,
                    replacement_map,
                    image_checksums,
                    checksum_image,
                    hide_titles,
                    style_maps,
                    style_maps_highlight,
                )?
            }
            for style in x.styles.iter_mut() {
                oneoff_fix_kml_replace_style(
                    style,
                    replacement_map,
                    image_checksums,
                    checksum_image,
                    hide_titles,
                    style_maps,
                    style_maps_highlight,
                )?;
            }
        }
        Node::Placemark(placemark) => {
            if let Some(name) = placemark.name.as_mut() {
                *name = replace_bad_symbols(name)?;
            }
            if let Some(description) = placemark.description.as_mut() {
                *description = replace_bad_symbols(description)?;
            }
        }
        Node::NetworkLink(_) => {}
        Node::Style(_) => {}
        Node::CascadingStyle(_) => {}
        Node::StyleMap(_) => {}
        Node::Author(_) => {}
        Node::AtomLink(_) => {}
    }
    Ok(())
}

pub fn oneoff_fix_kml_replace_style(
    style: &mut Style,
    replacement_map: &BTreeMap<String, String>,
    image_checksums: &BTreeMap<String, String>,
    checksum_image: &BTreeMap<String, String>,
    hide_titles: bool,
    style_maps: &BTreeMap<String, String>,
    style_maps_highlight: &BTreeMap<String, String>,
) -> Result<(), AppError> {
    if let Some(ref mut icon_style) = style.icon_style {
        if let Some(ref mut icon) = icon_style.icon {
            if let Some(ref mut href) = icon.href {
                if let Some(ref body) = href.body {
                    if let Some(new_href) = replacement_map.get(body) {
                        let href_body = &mut href.body;
                        *href_body = Some(new_href.clone());
                    }
                }
                if let Some(ref body) = href.body {
                    if let Some(checksum) = image_checksums.get(body) {
                        if let Some(checksum_image) =
                            checksum_image.get(&checksum.clone())
                        {
                            let href_body = &mut href.body;
                            *href_body = Some(checksum_image.to_string());
                        }
                    };
                }
            }
        }
    }
    if hide_titles {
        if let Some(style_id) = style.id.clone() {
            println!("> style_id: {style_id}");
            let for_normal_stylemap = style_maps.contains_key(&style_id);
            println!("> for_normal_stylemap: {for_normal_stylemap}");
            if for_normal_stylemap {
                if let Some(ref mut label_style) = style.label_style {
                    if let Some(ref mut scale) = label_style.scale {
                        println!("> p1");
                        scale.body = "0".to_string();
                    } else {
                        println!("> p2");
                        label_style.scale = Some(Scale {
                            body: "0".to_string(),
                        });
                    }
                } else {
                    style.label_style = Some(LabelStyle {
                        scale: Some(Scale {
                            body: "0".to_string(),
                        }),
                    });
                    println!("> p3; style: {style:?}");
                }
            }
            let for_highlight_stylemap =
                style_maps_highlight.contains_key(&style_id);
            if for_highlight_stylemap {
                if let Some(ref mut label_style) = style.label_style {
                    if let Some(ref mut scale) = label_style.scale {
                        let scale_body = &mut scale.body;
                        *scale_body = "1.0".to_string();
                    } else {
                        label_style.scale = Some(Scale {
                            body: "1.0".to_string(),
                        });
                    }
                } else {
                    style.label_style = Some(LabelStyle {
                        scale: Some(Scale {
                            body: "1.0".to_string(),
                        }),
                    });
                }
            }
        }
    }
    Ok(())
}

fn replace_bad_symbols(s: &str) -> Result<String, AppError> {
    Ok(s.to_string().replace("", "-"))
}

#[post("/api/kmz/fix")]
pub async fn api_fix_kmz(
    user: actix_identity::Identity,
    http_req: HttpRequest,
    env: actix_web::web::Data<Env>,
    mut payload: Multipart,
) -> Result<actix_web::HttpResponse, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Basic")
        .await
        .c(h!())?;
    let mut hide_titles: bool = false;
    let mut val = vec![];
    let mut filename: String = "".to_string();

    while let Some(item) = payload.next().await {
        let mut field = item.map_err(|e| -> AppError {
            format!("Multipart error: {e:?}").into()
        })?;
        let field_name = field.name().c(h!())?;
        if field_name == "hide_titles" {
            while let Some(chunk) = field.next().await {
                let v = chunk
                    .map_err(|e| -> AppError {
                        format!("Multipart error: {e:?}").into()
                    })?
                    .to_vec();
                if String::from_utf8(v) == Ok("1".to_string()) {
                    hide_titles = true;
                }
            }
        } else {
            filename = field_name.to_string();
            let mut val_curr: Vec<u8> = vec![];
            while let Some(chunk) = field.next().await {
                val_curr.extend(
                    chunk
                        .map_err(|e| -> AppError {
                            format!("Multipart error: {e:?}").into()
                        })?
                        .to_vec(),
                );
            }
            val = val_curr;
        }
    }
    let tmp_dir = TempDir::new()?;
    println!("> tmp_dir {}", &tmp_dir.path().display());
    let kmz_file = tmp_dir.path().join(filename);
    println!("> kmz_file: {}", &kmz_file.display());
    std::fs::write(&kmz_file, val)?;
    crate::utils::backup_tmp_dir(tmp_dir.path())?;

    let output =
        format!("{}", kmz_file.display()).replace(".kmz", "-fixed.kmz");
    oneoff_fix_kml(
        env.mode,
        &crate::OneoffFixKmzPs {
            kmz: format!("{}", kmz_file.display()),
            res: output.clone(),
            hide_titles,
        },
    )
    .await
    .c(h!())?;
    println!("> output: {}", &output);

    let file = actix_files::NamedFile::open_async(&output).await.c(h!())?;
    Ok(file.into_response(&http_req))
}

#[derive(PartialEq, Debug)]
struct RadioInfo {
    radio: String,
    day: String,
    mon: String,
    year: String,
}

fn extract_radio_info(nn: &str) -> Result<Option<RadioInfo>, AppError> {
    '_if: {
        // like: R-168 (10.05.2023 06:52:00)
        lazy_static! {
            static ref RE: Regex =
                Regex::new(r"(?P<radio>[a-zA-Z\d\-]+),?\s*\(?(?P<day>\d\d)\.(?P<mon>\d\d)\.(?P<year>\d\d\d\d)( (?<hour>\d\d):(?P<min>\d\d):(?P<sec>\d\d)\)?)?")
                    .unwrap();
        }
        let Some(capts) = RE.captures(nn) else {
            break '_if;
        };
        let Some(radio) = m_cap_s(&capts, "radio") else {
            break '_if;
        };
        let Some(day) = m_cap_s(&capts, "day") else {
            break '_if;
        };
        let Some(mon) = m_cap_s(&capts, "mon") else {
            break '_if;
        };
        let Some(year) = m_cap_s(&capts, "year") else {
            break '_if;
        };

        return Ok(Some(RadioInfo {
            radio,
            day,
            mon,
            year,
        }));
    }
    '_if: {
        // like: Unidentified, 18.05.2023 02:17Z
        lazy_static! {
            static ref RE: Regex =
                Regex::new(r"(?P<radio>[a-zA-Z\d\-]+)(,)?\s+(?P<day>\d\d)\.(?P<mon>\d\d)\.(?P<year>\d\d\d\d)( (?<hour>\d\d):(?P<min>\d\d):(?P<sec>\d\d)?Z?)?")
                    .unwrap();
        }
        let Some(capts) = RE.captures(nn) else {
            break '_if;
        };
        let Some(radio) = m_cap_s(&capts, "radio") else {
            break '_if;
        };
        let Some(day) = m_cap_s(&capts, "day") else {
            break '_if;
        };
        let Some(mon) = m_cap_s(&capts, "mon") else {
            break '_if;
        };
        let Some(year) = m_cap_s(&capts, "year") else {
            break '_if;
        };

        return Ok(Some(RadioInfo {
            radio,
            day,
            mon,
            year,
        }));
    }
    '_if: {
        // like: РЛС РВЦ С-300/400, 92Н6Е, 08.05.2023 07:53Z
        lazy_static! {
            static ref RE: Regex =
                Regex::new(r"(?P<radio>[a-zA-Zа-яА-Я/\d\-\s,]+),\s+(?P<day>\d\d)\.(?P<mon>\d\d)\.(?P<year>\d\d\d\d)( (?<hour>\d\d):(?P<min>\d\d):(?P<sec>\d\d)?Z?)?")
                    .unwrap();
        }
        let Some(capts) = RE.captures(nn) else {
            break '_if;
        };
        let Some(radio) = m_cap_s(&capts, "radio") else {
            break '_if;
        };
        let Some(day) = m_cap_s(&capts, "day") else {
            break '_if;
        };
        let Some(mon) = m_cap_s(&capts, "mon") else {
            break '_if;
        };
        let Some(year) = m_cap_s(&capts, "year") else {
            break '_if;
        };

        return Ok(Some(RadioInfo {
            radio,
            day,
            mon,
            year,
        }));
    }
    Ok(None)
}

pub async fn oneoff_radio_per_day_per_abonent_main(
    mode: Mode,
    ps: &crate::OneoffRadioPerDayPerAbonentPs,
    m_bgtask_id: Option<i64>,
    m_dbx: Option<&sea_orm::DatabaseConnection>,
) -> Result<RadioRenderOutputs, AppError> {
    let config = crate::config::read_config(mode)?;
    oneoff_radio_per_day_per_abonent(&config, ps, m_bgtask_id, m_dbx).await
}

pub async fn oneoff_radio_per_day_per_abonent(
    _config: &crate::config::Config,
    ps: &crate::OneoffRadioPerDayPerAbonentPs,
    m_bgtask_id: Option<i64>,
    m_dbx: Option<&sea_orm::DatabaseConnection>,
) -> Result<RadioRenderOutputs, AppError> {
    bgtask_log2(
        m_bgtask_id,
        &format!("> oneoff_radio_per_day_per_abonent, ps: {ps:?}"),
        m_dbx,
    )
    .await
    .c(h!())?;
    let kmz_path = Path::new(&ps.input);
    let tmp_dir = TempDir::new()?;
    let tmp_dir_kmz = tmp_dir
        .path()
        .join(kmz_path.file_name().ok_or("no filename")?);
    bgtask_log2(
        m_bgtask_id,
        &format!(
            "> copying {} to {}",
            kmz_path.display(),
            tmp_dir_kmz.display()
        ),
        m_dbx,
    )
    .await
    .c(h!())?;
    if !kmz_path.exists() {
        bgtask_log2(
            m_bgtask_id,
            &format!("> Error: kmz_path {} doesn't exist", kmz_path.display()),
            m_dbx,
        )
        .await
        .c(h!())?;
        return Err(AppError::NotFound);
    }
    std::fs::copy(kmz_path, &tmp_dir_kmz)?;
    bgtask_log2(m_bgtask_id, "> unzip", m_dbx).await.c(h!())?;
    crate::utils::zip::unzip(&tmp_dir_kmz)?;
    bgtask_log2(m_bgtask_id, "> rm", m_dbx).await.c(h!())?;
    std::fs::remove_file(&tmp_dir_kmz)?;
    bgtask_log2(m_bgtask_id, "> backup", m_dbx).await.c(h!())?;
    crate::utils::backup_tmp_dir(tmp_dir.path())?;
    let mut kml_path = tmp_dir
        .path()
        .join(kmz_path.file_stem().ok_or("no stem 92832")?)
        .join("doc.kml");
    if !kml_path.exists() {
        kml_path = tmp_dir.path().join("doc.kml");
    }
    bgtask_log2(
        m_bgtask_id,
        &format!("> kml_path: {}", kml_path.display()),
        m_dbx,
    )
    .await
    .c(h!())?;
    let kml: Kml =
        quick_xml::de::from_str(&std::fs::read_to_string(kml_path.clone())?)
            .c(h!())?;
    let nodes = gather_all_placemarks(&kml.nodes)?;
    bgtask_log2(
        m_bgtask_id,
        &format!("> kml_path: {}", kml_path.display()),
        m_dbx,
    )
    .await
    .c(h!())?;
    bgtask_log2(
        m_bgtask_id,
        &format!("> found {} nodes", nodes.len()),
        m_dbx,
    )
    .await
    .c(h!())?;

    let mut nodes_per_date_per_radio: BTreeMap<
        String,
        BTreeMap<String, Vec<Placemark>>,
    > = BTreeMap::new();
    let mut nodes_per_radio_per_date: BTreeMap<
        String,
        BTreeMap<String, Vec<Placemark>>,
    > = BTreeMap::new();
    for node in nodes.iter() {
        let nn: String = node
            .name
            .as_ref()
            .unwrap_or(&"<unknown>".to_string())
            .clone();
        let Some(rinfo) = extract_radio_info(&nn)? else {
            bgtask_log2(m_bgtask_id, &format!("> skipping {nn}"), m_dbx)
                .await
                .c(h!())?;
            continue;
        };
        let date = format!("{}-{}-{}", rinfo.year, rinfo.mon, rinfo.day);
        nodes_per_date_per_radio
            .entry(date.clone())
            .and_modify(|per_radio| {
                per_radio
                    .entry(rinfo.radio.clone())
                    .and_modify(|xs| xs.push(node.clone()))
                    .or_insert(vec![node.clone()]);
            })
            .or_insert(new_btmap(rinfo.radio.clone(), vec![node.clone()]));
        nodes_per_radio_per_date
            .entry(rinfo.radio.clone())
            .and_modify(|per_date| {
                per_date
                    .entry(date.clone())
                    .and_modify(|xs| xs.push(node.clone()))
                    .or_insert(vec![node.clone()]);
            })
            .or_insert(new_btmap(date.clone(), vec![node.clone()]));
    }

    let output_dir = TempDir::new()?;
    let (csv_name, kmz_per_date_name, kmz_per_radio_name) =
        if let Some(bgtask_id) = m_bgtask_id {
            (
                format!("radios-{bgtask_id}-radio.csv"),
                format!("radios-{bgtask_id}-date.kmz"),
                format!("radios-{bgtask_id}-radio.kmz"),
            )
        } else {
            let stem = kmz_path
                .file_name()
                .ok_or("error 19283")?
                .to_str()
                .ok_or("error 27364")?
                .trim_end_matches(".kmz")
                .to_string();
            (
                format!("{stem}.csv"),
                format!("{stem}-date.kmz"),
                format!("{stem}-radio.kmz"),
            )
        };

    let csv_path_out = output_dir.path().join(&csv_name);
    render_nodes_csv(
        &nodes_per_date_per_radio,
        &csv_path_out,
        m_bgtask_id,
        m_dbx,
    )
    .await
    .c(h!())?;

    let kmz_path_out_date = output_dir.path().join(&kmz_per_date_name);
    render_nodes(
        &kml,
        kmz_path,
        &kml_path,
        &nodes_per_date_per_radio,
        &kmz_path_out_date,
        m_bgtask_id,
        m_dbx,
    )
    .await
    .c(h!())?;
    let kmz_path_out_radio = output_dir.path().join(&kmz_per_radio_name);
    render_nodes(
        &kml,
        kmz_path,
        &kml_path,
        &nodes_per_radio_per_date,
        &kmz_path_out_radio,
        m_bgtask_id,
        m_dbx,
    )
    .await
    .c(h!())?;

    Ok(RadioRenderOutputs {
        csv_name,
        csv_bytes: std::fs::read(&csv_path_out).c(h!())?,
        kmz_per_date_name,
        kmz_per_date_bytes: std::fs::read(&kmz_path_out_date).c(h!())?,
        kmz_per_radio_name,
        kmz_per_radio_bytes: std::fs::read(&kmz_path_out_radio).c(h!())?,
    })
}

async fn render_nodes(
    kml: &Kml,
    kmz_path: &Path,
    kml_path: &Path,
    node_map: &BTreeMap<String, BTreeMap<String, Vec<Placemark>>>,
    kmz_path_out: &Path,
    m_bgtask_id: Option<i64>,
    m_dbx: Option<&sea_orm::DatabaseConnection>,
) -> Result<(), AppError> {
    // rendering the map
    let mut kml_nodes = vec![];
    for (date, per_radio_map) in node_map.iter() {
        let mut date_nodes = vec![];
        for (radio, vs) in per_radio_map.iter() {
            let mut radio_nodes = vec![];
            for v in vs.iter() {
                radio_nodes.push(Node::Placemark(v.clone()));
            }
            let radio_folder = Folder {
                name: Some(Name {
                    body: radio.clone(),
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
                nodes: radio_nodes,
            };
            date_nodes.push(Node::Folder(radio_folder));
        }
        let date_folder = Folder {
            name: Some(Name { body: date.clone() }),
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
            nodes: date_nodes,
        };
        kml_nodes.push(Node::Folder(date_folder));
    }
    let kml_fol1 =
        node_as_folder(kml.nodes.first().ok_or("kml has no nodes")?)?
            .ok_or("kml node must be a folderish")?;
    let root_node = Node::Folder(Folder {
        name: Some(Name {
            body: kmz_path
                .file_name()
                .and_then(|x| x.to_str())
                .map(|x| x.to_string())
                .unwrap_or("Signals".to_string())
                .replace(".kmz", ""),
        }),
        look_at: None,
        description: None,
        open: None,
        styles: kml_fol1.styles.clone(),
        style_maps: kml_fol1.style_maps,
        visibility: None,
        snippet: None,
        snippet_lower: None,
        link: None,
        camera: None,
        gx_balloon_visibility: None,
        schema: vec![],
        nodes: kml_nodes,
    });
    let res_kml = Kml {
        nodes: vec![root_node],
    };
    // persist with styles and icons
    let tmp_dir = Arc::new(TempDir::new()?);
    let style_maps = extract_style_maps(&kml.nodes)?;
    let mut style_maps_reversed = BTreeMap::new();
    for (style, icon) in style_maps {
        style_maps_reversed.insert(icon, style);
    }
    let path = PathBuf::from(kml_path);
    let path = path.parent().ok_or("no parent")?;
    // keep res to not remove tmp dir
    let dst_file_res = crate::importer::package_up_kmz(
        tmp_dir.clone(),
        res_kml,
        style_maps_reversed,
        path.to_path_buf(),
    )
    .await
    .c(h!())?;
    let dst_file = dst_file_res.path;
    bgtask_log2(
        m_bgtask_id,
        &format!("> done packaging {}", dst_file.display()),
        m_dbx,
    )
    .await
    .c(h!())?;
    println!(
        "> copying {} to {}",
        dst_file.display(),
        kmz_path_out.display()
    );
    println!("> dst_file is exist: {}", dst_file.exists());
    let res = std::fs::copy(dst_file, kmz_path_out);
    println!("> res: {res:?}");
    res?;
    println!("> done copying");
    bgtask_log2(
        m_bgtask_id,
        &format!("> done. see {}", kmz_path_out.display()),
        m_dbx,
    )
    .await
    .c(h!())?;
    for (date, per_radio_map) in node_map.iter() {
        let num_items: usize = per_radio_map.values().map(|v| v.len()).sum();
        bgtask_log2(
            m_bgtask_id,
            &format!("> date: {date}, items: {num_items}"),
            m_dbx,
        )
        .await
        .c(h!())?;
    }
    println!("> tmp_dir: {}", tmp_dir.clone().path().display());
    Ok(())
}

async fn render_nodes_csv(
    node_map: &BTreeMap<String, BTreeMap<String, Vec<Placemark>>>,
    csv_path_out: &Path,
    m_bgtask_id: Option<i64>,
    m_dbx: Option<&sea_orm::DatabaseConnection>,
) -> Result<(), AppError> {
    let per_page = 2000;
    let mut rows = vec![];
    for (date, per_radio_map) in node_map.iter() {
        println!("> render_nodes_csv date: {date}");
        for (radio, vs) in per_radio_map.iter() {
            for v in vs.iter() {
                let Some(point) = v.point.clone() else {
                    continue;
                };
                let Some(coordinates) = point.coordinates else {
                    continue;
                };
                let (lat, lon) =
                    milgeo_rs::coordinates::parse_point_coordinates(
                        &coordinates,
                    )?;
                let row = crate::delta::types::DeltaCsvRow {
                    sidc: "10061500002001000000".to_string(),
                    quantity: "".to_string(),
                    name: radio.clone(),
                    // like 2023-10-11T00:00:00
                    observation_datetime: format!("{date}T12:00:00"),
                    reliability_credibility: "B3".to_string(),
                    staff_comments: "".to_string(),
                    platform_type: "ELINT".to_string(),
                    direction: "".to_string(),
                    speed: "".to_string(),
                    // like POINT (37.083 47.5489)
                    coordinates: format!("POINT ({lon} {lat})"),
                    // comment_1: v.description.clone().unwrap_or("".to_string()),
                    comment_1: "".to_string(),
                };
                rows.push(row);
            }
        }
    }
    for (i, page_rows) in rows.chunks(per_page).enumerate() {
        let page = i + 1;
        let csv_path_out_paged = csv_path_out.with_file_name(
            csv_path_out
                .file_name()
                .ok_or("no filename")?
                .to_str()
                .ok_or("no str")?
                .to_string()
                .replace(".csv", &format!("-page-{page}.csv")[..]),
        );
        println!("> csv_path_out_paged: {}", csv_path_out_paged.display());
        let mut wtr = csv::Writer::from_path(&csv_path_out_paged).c(h!())?;
        for row in page_rows.iter() {
            wtr.serialize(row).c(h!())?;
        }
        wtr.flush().c(h!())?;
        bgtask_log2(
            m_bgtask_id,
            &format!("> wrote {}", csv_path_out_paged.display()),
            m_dbx,
        )
        .await
        .c(h!())?;
    }

    for (date, per_radio_map) in node_map.iter() {
        let num_items: usize = per_radio_map.values().map(|v| v.len()).sum();
        bgtask_log2(
            m_bgtask_id,
            &format!("> date: {date}, items: {num_items}"),
            m_dbx,
        )
        .await
        .c(h!())?;
    }
    Ok(())
}

pub struct BuildStyleMapsRes {
    pub style_maps: Vec<StyleMap>,
    pub styles: Vec<Style>,
}

pub fn build_style_maps_per_app6d(
    sidcs: &[String],
) -> Result<BuildStyleMapsRes, AppError> {
    // per app6d
    let mut styles_normal: BTreeMap<String, Style> = BTreeMap::new();
    // per app6d
    let mut styles_highlight: BTreeMap<String, Style> = BTreeMap::new();
    for sidc in sidcs.iter() {
        let icon = format!("{sidc}.png");
        styles_normal.insert(
            sidc.clone(),
            Style {
                id: Some(format!("normal-{}", sidc.clone())),
                icon_style: Some(IconStyle {
                    color: None,
                    scale: None,
                    icon: Some(Icon {
                        href: Some(Href {
                            body: Some(icon.clone()),
                        }),
                    }),
                }),
                label_style: Some(LabelStyle {
                    scale: Some(Scale {
                        body: "0".to_string(),
                    }),
                }),
                balloon_style: None,
                line_style: None,
                poly_style: None,
            },
        );
        styles_highlight.insert(
            sidc.clone(),
            Style {
                id: Some(format!("highlight-{}", sidc.clone())),
                icon_style: Some(IconStyle {
                    color: None,
                    scale: None,
                    icon: Some(Icon {
                        href: Some(Href {
                            body: Some(icon.clone()),
                        }),
                    }),
                }),
                label_style: Some(LabelStyle {
                    scale: Some(Scale {
                        body: "1.0".to_string(),
                    }),
                }),
                line_style: None,
                balloon_style: None,
                poly_style: None,
            },
        );
    }
    let mut styles: Vec<Style> = vec![];
    for (_, style) in styles_normal.iter() {
        styles.push(style.clone());
    }
    for (_, style) in styles_highlight.iter() {
        styles.push(style.clone());
    }
    let mut style_maps = vec![];
    for key in styles_normal.keys() {
        style_maps.push(StyleMap {
            id: Some(format!("map-{key}")),
            pairs: vec![
                Pair {
                    key: Key {
                        body: "normal".to_string(),
                    },
                    style_url: StyleUrl {
                        body: format!("#normal-{key}"),
                    },
                },
                Pair {
                    key: Key {
                        body: "highlight".to_string(),
                    },
                    style_url: StyleUrl {
                        body: format!("#highlight-{key}"),
                    },
                },
            ],
        });
    }
    Ok(BuildStyleMapsRes { style_maps, styles })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_replace_bad_symbols() {
        assert_eq!(replace_bad_symbols("Ту154").unwrap(), "Ту-154")
    }

    #[test]
    fn test_extract_radio_info_01() {
        assert_eq!(
            extract_radio_info("R-168 (10.05.2023 06:52:00)")
                .unwrap()
                .unwrap(),
            RadioInfo {
                radio: "R-168".to_string(),
                day: "10".to_string(),
                mon: "05".to_string(),
                year: "2023".to_string(),
            }
        )
    }

    #[test]
    fn test_extract_radio_info_02() {
        assert_eq!(
            extract_radio_info("Unidentified, 18.05.2023 02:17Z")
                .unwrap()
                .unwrap(),
            RadioInfo {
                radio: "Unidentified".to_string(),
                day: "18".to_string(),
                mon: "05".to_string(),
                year: "2023".to_string(),
            }
        )
    }

    #[test]
    fn test_extract_radio_info_03() {
        assert_eq!(
            extract_radio_info("РЛС РВЦ С-300/400, 92Н6Е, 08.05.2023 07:53Z")
                .unwrap()
                .unwrap(),
            RadioInfo {
                radio: "РЛС РВЦ С-300/400, 92Н6Е".to_string(),
                day: "08".to_string(),
                mon: "05".to_string(),
                year: "2023".to_string(),
            }
        )
    }

    #[test]
    fn test_extract_radio_info_04() {
        assert_eq!(
            extract_radio_info("С-350, 50Р6А, 08.05.2023 23:18Z")
                .unwrap()
                .unwrap(),
            RadioInfo {
                radio: "С-350, 50Р6А".to_string(),
                day: "08".to_string(),
                mon: "05".to_string(),
                year: "2023".to_string(),
            }
        )
    }

    #[test]
    fn test_extract_radio_info_05() {
        assert_eq!(
            extract_radio_info("R-187,21.08.2023 11:42:00")
                .unwrap()
                .unwrap(),
            RadioInfo {
                radio: "R-187".to_string(),
                day: "21".to_string(),
                mon: "08".to_string(),
                year: "2023".to_string(),
            }
        )
    }
}
