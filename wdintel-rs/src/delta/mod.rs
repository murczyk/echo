use self::types::*;
use crate::config;
use crate::config::get_assets_url;
use crate::entities::{prelude::*, *};
use crate::error::AppError;
use crate::kml::types::*;
use crate::types::*;
use crate::utils::multipart;
use actix_multipart::Multipart;
use actix_web::http::header;
use actix_web::web::Json;
use actix_web::HttpResponse;
use actix_web::{get, post, HttpRequest};
use chrono::prelude::*;
use elm_rs::{Elm, ElmDecode, ElmEncode};
use sea_orm::*;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tempfile::TempDir;

pub mod csv;
pub mod login;
pub mod types;

const TEMPORARY_KML_FILE_EXTENSION: &str = "kml.tmp";

#[derive(Debug, Serialize, Deserialize)]
struct RadiosOutputKeys {
    kmz_per_radio: String,
    kmz_per_date: String,
    csv: String,
}

pub fn oneoff_kmz_to_geojson(
    ps: &crate::OneoffKmzToGeojsonPs,
) -> Result<(), AppError> {
    // let kml_path = crate::kml::get_storage_dir()?
    //     .join("ОУВ Запоріжжя 2022-12-14")
    //     .join("doc.kml");
    // let kml_path = crate::kml::get_storage_dir()?.join("ЛБЗ-7-12.kml");
    // let output = crate::kml::get_storage_dir()?.join("ЛБЗ-7-12.geojson");
    // let kml_path = crate::kml::get_storage_dir()?
    //     .join("2022-12-20-Маршрути противника")
    //     .join("doc.kml");
    // let output = crate::kml::get_storage_dir()?
    //     .join("2022-12-20-Маршрути противника.geojson");
    let kml_path = Path::new(&ps.from_kml);
    // let output = ps.to_geojson.clone();
    let output = kml_path.with_extension(".geojson");
    kmz_to_geojson_1(&kml_path.to_path_buf(), &output)?;

    Ok(())
}

pub fn kmz_to_geojson_1(
    input_path: &PathBuf,
    output: &PathBuf,
) -> Result<(), AppError> {
    let input: String = std::fs::read_to_string(input_path)?;
    let kml: Kml = quick_xml::de::from_str(&input[..]).c(h!())?;
    let style_map = crate::kml::extract_style_maps(&kml.nodes)?;
    let style_map_highlight =
        crate::kml::extract_style_maps_hightlight(&kml.nodes)?;

    let mut features: Vec<Feature> = vec![];
    let mut per_icon_counter: BTreeMap<String, i64> = BTreeMap::new();
    let all_placemarks = crate::kml::gather_all_placemarks(&kml.nodes)?;
    println!("> processing {} placemarks", all_placemarks.len());
    for placemark in all_placemarks.iter() {
        if let Some(point) = &placemark.point {
            if let Some(coordinates) = &point.coordinates {
                let (lat, lng) =
                    milgeo_rs::coordinates::parse_point_coordinates(
                        coordinates,
                    )?;
                let lat_f: f64 = lat.parse().c(h!())?;
                let lng_f: f64 = lng.parse().c(h!())?;
                let mut comments: Vec<String> = vec![];
                if let Some(name) = &placemark.name {
                    comments.push(name.to_string());
                }
                comments.extend(extract_comments(
                    &placemark.description.clone().unwrap_or("".to_string()),
                )?);
                let mut feature = Feature {
                    type_: "Feature".to_string(),
                    properties: Some(Properties {
                        name: placemark.name.clone(),
                        sidc: "10061000001211020000".to_string(),
                        comments,
                        observation_datetime: None,
                    }),
                    geometry: Geometry {
                        type_: "Point".to_string(),
                        coordinates: serde_json::to_value((lng_f, lat_f))
                            .unwrap(),
                    },
                };

                '_if: {
                    let Some(style) = &placemark.style else {
                        break '_if;
                    };
                    let Some(icon_style) = &style.icon_style else {
                        break '_if;
                    };
                    let Some(icon) = &icon_style.icon else {
                        break '_if;
                    };
                    let Some(href) = &icon.href else {
                        break '_if;
                    };
                    let Some(ref body) = href.body else {
                        break '_if;
                    };
                    let icon_stripped: String = match body.rfind('/') {
                        Some(pos) => String::from_utf8(
                            body.as_bytes()
                                .iter()
                                .skip(pos + 1)
                                .cloned()
                                .collect(),
                        )
                        .c(h!())?,
                        None => body.clone(),
                    };
                    let sidc =
                        crate::icons::filename_to_app6d_code(&icon_stripped);
                    if let Some(ref mut props) = feature.properties {
                        props.sidc = sidc;
                    }
                    match per_icon_counter.get_mut(&icon_stripped) {
                        None => {
                            per_icon_counter.insert(icon_stripped, 1);
                        }
                        Some(val) => {
                            *val += 1;
                        }
                    }
                }
                '_if: {
                    let Some(style_url) = &placemark.style_url else {
                        break '_if;
                    };
                    let style_url_stripped: String =
                        style_url.body.chars().skip(1).collect();
                    let Some(icon) =
                        style_map.get(&style_url_stripped).or_else(|| {
                            style_map_highlight.get(&style_url_stripped)
                        })
                    else {
                        break '_if;
                    };
                    let icon_stripped: String = match icon.rfind('/') {
                        Some(pos) => String::from_utf8(
                            icon.as_bytes()
                                .iter()
                                .skip(pos + 1)
                                .cloned()
                                .collect(),
                        )
                        .c(h!())?,
                        None => icon.clone(),
                    };
                    let sidc =
                        crate::icons::filename_to_app6d_code(&icon_stripped);
                    if let Some(ref mut props) = feature.properties {
                        props.sidc = sidc;
                    }
                    match per_icon_counter.get_mut(&icon_stripped) {
                        None => {
                            per_icon_counter.insert(icon_stripped, 1);
                        }
                        Some(val) => {
                            *val += 1;
                        }
                    }
                }

                features.push(feature);
            }
        } else if let Some(line_string) = &placemark.line_string {
            if let Some(coordinates) = &line_string.coordinates {
                if let Some(coord_s) = &coordinates.body {
                    let feature = feature_from_line_string(coord_s)?;
                    features.push(feature);
                }
            }
        } else if let Some(multi_geometry) = &placemark.multi_geometry {
            for line_string in multi_geometry.line_strings.iter() {
                if let Some(coordinates) = line_string.coordinates.clone() {
                    if let Some(coord_s) = &coordinates.body {
                        let feature = feature_from_line_string(coord_s)?;
                        features.push(feature);
                    }
                }
            }
        } else if let Some(polygon) = &placemark.polygon {
            if let Some(coordinates) = polygon
                .outer_boundary_is
                .as_ref()
                .and_then(|outer| outer.linear_ring.as_ref())
                .and_then(|ring| ring.coordinates.as_ref())
                .and_then(|coords| coords.body.as_ref())
            {
                let feature = feature_from_polygon(coordinates)?;
                features.push(feature);
            }
        }
    }

    println!("> gathered features: {}", features.len());
    let mut per_icon_sorted: Vec<(String, i64)> = vec![];
    for (k, v) in per_icon_counter.iter() {
        per_icon_sorted.push((k.clone(), *v));
    }
    per_icon_sorted.sort_by(|(_k1, v1), (_k2, v2)| v1.partial_cmp(v2).unwrap());
    // println!("> per_icon_sorted: {:?}", per_icon_sorted);
    // features = features[0..20].iter().cloned().collect();

    let geo_json = GeoJson {
        type_: "FeatureCollection".to_string(),
        features,
    };

    std::fs::write(output, serde_json::to_string_pretty(&geo_json).c(h!())?)?;
    let kml_output = quick_xml::se::to_string(&kml).c(h!())?;
    std::fs::write(
        input_path.with_extension(TEMPORARY_KML_FILE_EXTENSION),
        kml_output,
    )?;
    Ok(())
}

fn feature_from_line_string(coord_s: &str) -> Result<Feature, AppError> {
    let coords = milgeo_rs::coordinates::parse_linestring_coordinates(coord_s)?;
    let coords_val: serde_json::Value = serde_json::Value::Array(
        coords
            .iter()
            .map(|(lng, lat)| serde_json::to_value((lng, lat)).unwrap())
            .collect(),
    );
    let feature = Feature {
        type_: "Feature".to_string(),
        properties: None,
        geometry: Geometry {
            type_: "LineString".to_string(),
            coordinates: coords_val,
        },
    };
    Ok(feature)
}

fn feature_from_polygon(coord_s: &str) -> Result<Feature, AppError> {
    let coords = milgeo_rs::coordinates::parse_linestring_coordinates(coord_s)?;
    let coords_val: serde_json::Value =
        serde_json::Value::Array(vec![serde_json::Value::Array(
            coords
                .iter()
                .map(|(lng, lat)| serde_json::to_value((lng, lat)).unwrap())
                .collect(),
        )]);
    let feature = Feature {
        type_: "Feature".to_string(),
        properties: None,
        geometry: Geometry {
            type_: "Polygon".to_string(),
            coordinates: coords_val,
        },
    };
    Ok(feature)
}

fn extract_comments(s: &str) -> Result<Vec<String>, AppError> {
    let document = tl::parse(s, tl::ParserOptions::default()).c(h!())?;
    let parser = document.parser();
    let children = document.children();
    let mut res = vec![];
    for child_ref in children.iter() {
        if let Some(child) = child_ref.get(parser) {
            res.extend(extract_comments_from_node(child, parser)?);
        }
    }

    Ok(res)
}

fn extract_comments_from_node(
    node: &tl::Node,
    parser: &tl::Parser,
) -> Result<Vec<String>, AppError> {
    match node {
        tl::Node::Raw(bytes) => Ok(vec![bytes.as_utf8_str().to_string()]),
        tl::Node::Tag(el) => {
            let mut res: Vec<String> = vec![];

            if el.name().as_utf8_str() == *"img" {
                if let Some(Some(src)) = el.attributes().get("src") {
                    let s = src.as_utf8_str().to_string();
                    if !res.contains(&s) {
                        res.push(s)
                    }
                }
            }

            for child in el.children().all(parser) {
                res.extend(extract_comments_from_node(child, parser)?)
            }
            Ok(res)
        }
        tl::Node::Comment(_) => Ok(vec![]),
    }
}

#[post("/api/delta/download/operatyvka.geojson")]
async fn download_geojson(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<crate::importer::DownloadKmzReq>,
) -> Result<Json<GeoJson>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Basic")
        .await
        .c(h!())?;
    let mut features = vec![];
    let now = Utc::now();
    for row in req.rows.iter() {
        let lat_f: f64 = row.lat.parse().c(h!())?;
        let lng_f: f64 = row.lng.parse().c(h!())?;
        let mut comments: Vec<String> =
            row.content.lines().map(|x| x.to_string()).collect();
        for image_url in row.image_urls.iter() {
            comments.push(image_url.clone());
        }
        let tz = crate::config::get_tz();
        let observation_datetime = tz.from_utc_datetime(&now.naive_utc());
        let observation_datetime_s =
            observation_datetime.format("%Y-%m-%dT%H:%M:%S").to_string();
        let properties = Properties {
            name: Some(row.title.clone()),
            sidc: crate::icons::filename_to_app6d_code(&row.icon),
            comments,
            observation_datetime: Some(observation_datetime_s),
        };
        let feature = Feature {
            type_: "Feature".to_string(),
            properties: Some(properties),
            geometry: Geometry {
                type_: "Point".to_string(),
                coordinates: serde_json::to_value((lng_f, lat_f)).unwrap(),
            },
        };
        features.push(feature);
    }
    Ok(Json(GeoJson {
        type_: "FeatureCollection".to_string(),
        features,
    }))
}

#[post("/api/radios-convert")]
async fn radios_convert(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    mut payload: Multipart,
) -> Result<Json<i64>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Basic")
        .await
        .c(h!())?;
    let (field, val) = multipart::extract(&mut payload).await.c(h!())?;
    let tmp_dir = TempDir::new()?;
    println!("> tmp_dir {}", &tmp_dir.path().display());
    let data_file = tmp_dir.path().join(field.name().c(h!())?);
    println!("> data_file: {}", &data_file.display());
    std::fs::write(&data_file, val)?;
    let loglines: Vec<String> = vec![];
    let bgtask = bgtask::ActiveModel {
        id: NotSet,
        progress: Set(0),
        loglines: Set(serde_json::to_value(loglines).c(h!())?),
        running: Set(true),
        finished_with_error: Set(None),
    }
    .insert(&env.dbx)
    .await
    .c(h!())?;
    let bgtask_id = bgtask.id;

    let env_spawn = env.clone();
    tokio::spawn(async {
        let _tmp_dir = tmp_dir;
        let data_file2 = data_file;
        radios_convert_go(env_spawn, &data_file2, Some(bgtask))
            .await
            .c(h!())?;
        Ok::<(), AppError>(())
    });

    Ok(Json(bgtask_id))
}

pub async fn radios_convert_go(
    env: actix_web::web::Data<Env>,
    data_file: &Path,
    m_bgtask: Option<bgtask::Model>,
) -> Result<(), AppError> {
    let res = radios_convert_go2(env.clone(), data_file, &m_bgtask).await;
    finish_bgtask(m_bgtask.map(|x| x.id), &env.dbx, &res)
        .await
        .c(h!())?;
    res
}

async fn radios_convert_go2(
    env: actix_web::web::Data<Env>,
    data_file: &Path,
    m_bgtask: &Option<bgtask::Model>,
) -> Result<(), AppError> {
    let bgtask_id = m_bgtask
        .clone()
        .map(|x| x.id)
        .ok_or("Must have bgtask id")?;
    let m_bgtask_id = Some(bgtask_id);
    bgtask_log(m_bgtask_id, "Starting radios_convert_go2", &env.dbx)
        .await
        .c(h!())?;

    let outputs = crate::kml::oneoff_radio_per_day_per_abonent(
        &env.config,
        &crate::OneoffRadioPerDayPerAbonentPs {
            input: data_file.to_path_buf().to_string_lossy().to_string(),
        },
        m_bgtask_id,
        Some(&env.dbx),
    )
    .await
    .c(h!())?;
    store_radios_outputs(env.as_ref(), bgtask_id, &outputs)
        .await
        .c(h!())?;

    bgtask_log(m_bgtask_id, "Finished radios_convert_go2", &env.dbx)
        .await
        .c(h!())?;

    Ok(())
}

async fn store_radios_outputs(
    env: &Env,
    bgtask_id: i64,
    outputs: &crate::kml::RadioRenderOutputs,
) -> Result<(), AppError> {
    let kmz_per_radio_key = crate::messenger::media::store_asset(
        env,
        &outputs.kmz_per_radio_bytes,
        Some(outputs.kmz_per_radio_name.as_str()),
        Some(crate::config::KMZ_CONTENT_TYPE),
    )
    .await
    .c(h!())?;
    let kmz_per_date_key = crate::messenger::media::store_asset(
        env,
        &outputs.kmz_per_date_bytes,
        Some(outputs.kmz_per_date_name.as_str()),
        Some(crate::config::KMZ_CONTENT_TYPE),
    )
    .await
    .c(h!())?;
    let csv_key = crate::messenger::media::store_asset(
        env,
        &outputs.csv_bytes,
        Some(outputs.csv_name.as_str()),
        Some("text/csv"),
    )
    .await
    .c(h!())?;

    let payload = json!(RadiosOutputKeys {
        kmz_per_radio: kmz_per_radio_key,
        kmz_per_date: kmz_per_date_key,
        csv: csv_key,
    });
    let payload_bytes = serde_json::to_vec(&payload).c(h!())?;
    let payload_key = crate::messenger::media::store_asset(
        env,
        &payload_bytes,
        Some(&format!("radios-{}-outputs.json", bgtask_id)),
        Some("application/json"),
    )
    .await
    .c(h!())?;

    if let Some(existing) = BgtaskRes::find_by_id(bgtask_id)
        .one(&env.dbx)
        .await
        .c(h!())?
    {
        let mut model: bgtask_res::ActiveModel = existing.into();
        model.res_json = Set(None);
        model.res_s3_id = Set(Some(payload_key));
        model.res_bytes = Set(None);
        model.update(&env.dbx).await.c(h!())?;
    } else {
        let model = bgtask_res::ActiveModel {
            id: Set(bgtask_id),
            res_json: Set(None),
            res_bytes: Set(None),
            res_s3_id: Set(Some(payload_key)),
        };
        model.insert(&env.dbx).await.c(h!())?;
    }
    Ok(())
}

async fn load_radios_output_keys(
    env: &Env,
    bgtask_id: i64,
) -> Result<Option<RadiosOutputKeys>, AppError> {
    let Some(res) = BgtaskRes::find_by_id(bgtask_id)
        .one(&env.dbx)
        .await
        .c(h!())?
    else {
        return Ok(None);
    };
    if let Some(res_json) = res.res_json {
        let keys: RadiosOutputKeys =
            serde_json::from_value(res_json).c(h!())?;
        return Ok(Some(keys));
    }
    let Some(res_s3_id) = res.res_s3_id else {
        return Ok(None);
    };
    let data =
        crate::messenger::media::fetch_media_bytes_by_key(env, &res_s3_id)
            .await
            .c(h!())?;
    if data.is_empty() {
        return Ok(None);
    }
    let keys: RadiosOutputKeys = serde_json::from_slice(&data).c(h!())?;
    Ok(Some(keys))
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct RadiosDownloadResultReq {
    pub bgtask_id: i64,
    /// We split by 2000 rows due to Delta import limits
    pub csv_page: Option<i64>,
}

#[post("/api/radios-download-result-per-radio")]
pub async fn radios_download_result_per_radio(
    user: actix_identity::Identity,
    _http_req: HttpRequest,
    env: actix_web::web::Data<Env>,
    req: Json<RadiosDownloadResultReq>,
) -> Result<HttpResponse, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Basic")
        .await
        .c(h!())?;
    if let Some(keys) =
        load_radios_output_keys(env.as_ref(), req.bgtask_id).await?
    {
        let data = crate::messenger::media::fetch_media_bytes_by_key(
            env.as_ref(),
            &keys.kmz_per_radio,
        )
        .await
        .c(h!())?;
        let cd = header::ContentDisposition {
            disposition: header::DispositionType::Attachment,
            parameters: vec![header::DispositionParam::FilenameExt(
                header::ExtendedValue {
                    charset: header::Charset::Ext("UTF-8".into()),
                    language_tag: None,
                    value: format!("radios-{}-radio.kmz", req.bgtask_id)
                        .into_bytes(),
                },
            )],
        };
        return Ok(HttpResponse::Ok()
            .insert_header((
                header::CONTENT_TYPE,
                crate::config::KMZ_CONTENT_TYPE,
            ))
            .insert_header(cd)
            .body(data));
    }
    Err(AppError::NotFound)
}

#[post("/api/radios-download-result-per-date")]
pub async fn radios_download_result_per_date(
    user: actix_identity::Identity,
    _http_req: HttpRequest,
    env: actix_web::web::Data<Env>,
    req: Json<RadiosDownloadResultReq>,
) -> Result<HttpResponse, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Basic")
        .await
        .c(h!())?;
    if let Some(keys) =
        load_radios_output_keys(env.as_ref(), req.bgtask_id).await?
    {
        let data = crate::messenger::media::fetch_media_bytes_by_key(
            env.as_ref(),
            &keys.kmz_per_date,
        )
        .await
        .c(h!())?;
        let cd = header::ContentDisposition {
            disposition: header::DispositionType::Attachment,
            parameters: vec![header::DispositionParam::FilenameExt(
                header::ExtendedValue {
                    charset: header::Charset::Ext("UTF-8".into()),
                    language_tag: None,
                    value: format!("radios-{}-date.kmz", req.bgtask_id)
                        .into_bytes(),
                },
            )],
        };
        return Ok(HttpResponse::Ok()
            .insert_header((
                header::CONTENT_TYPE,
                crate::config::KMZ_CONTENT_TYPE,
            ))
            .insert_header(cd)
            .body(data));
    }
    Err(AppError::NotFound)
}

#[post("/api/radios-download-result-csv")]
pub async fn radios_download_result_csv(
    user: actix_identity::Identity,
    _http_req: HttpRequest,
    env: actix_web::web::Data<Env>,
    req: Json<RadiosDownloadResultReq>,
) -> Result<HttpResponse, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Basic")
        .await
        .c(h!())?;
    let page_part = match req.csv_page {
        None => "".to_string(),
        Some(page) => format!("-page-{page}"),
    };
    if let Some(keys) =
        load_radios_output_keys(env.as_ref(), req.bgtask_id).await?
    {
        let data = crate::messenger::media::fetch_media_bytes_by_key(
            env.as_ref(),
            &keys.csv,
        )
        .await
        .c(h!())?;
        let cd = header::ContentDisposition {
            disposition: header::DispositionType::Attachment,
            parameters: vec![header::DispositionParam::FilenameExt(
                header::ExtendedValue {
                    charset: header::Charset::Ext("UTF-8".into()),
                    language_tag: None,
                    value: format!(
                        "radios-{}-radio{page_part}.csv",
                        req.bgtask_id
                    )
                    .into_bytes(),
                },
            )],
        };
        return Ok(HttpResponse::Ok()
            .insert_header((header::CONTENT_TYPE, "text/csv"))
            .insert_header(cd)
            .body(data));
    }
    Err(AppError::NotFound)
}

pub async fn bgtask_log(
    m_bgtask_id: Option<i64>,
    s: &str,
    dbx: &sea_orm::DatabaseConnection,
) -> Result<(), AppError> {
    println!("{s}");
    let Some(bgtask_id) = m_bgtask_id else {
        return Ok(());
    };
    match Bgtask::find()
        .filter(bgtask::Column::Id.eq(bgtask_id))
        .one(dbx)
        .await
        .c(h!())?
    {
        None => {
            println!("> couldn't find bgtask {bgtask_id}. skipping");
        }
        Some(bgtask) => {
            let mut bgtask_a: bgtask::ActiveModel = bgtask.clone().into();
            let mut loglines2: Vec<String> =
                serde_json::from_value(bgtask.loglines.clone()).c(h!())?;
            loglines2.push(s.to_string());
            bgtask_a.loglines = Set(serde_json::to_value(loglines2).c(h!())?);
            bgtask_a.update(dbx).await.c(h!())?;
        }
    };
    Ok(())
}

pub async fn bgtask_log2(
    m_bgtask_id: Option<i64>,
    s: &str,
    m_dbx: Option<&sea_orm::DatabaseConnection>,
) -> Result<(), AppError> {
    let Some(dbx) = m_dbx else {
        println!("{s}");
        return Ok(());
    };
    bgtask_log(m_bgtask_id, s, dbx).await.c(h!())?;
    Ok(())
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "snake_case")]
pub enum BgtaskErrorCode {
    NoDefaultAor,
}

fn bgtask_error_code_from_message(
    finished_with_error: Option<&String>,
) -> Option<BgtaskErrorCode> {
    let message = finished_with_error?;
    if message.contains("No default AOR found") {
        Some(BgtaskErrorCode::NoDefaultAor)
    } else {
        None
    }
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct BgtaskStatusAndLogsRsp {
    pub running: bool,
    pub loglines: Vec<String>,
    pub finished_with_error: Option<String>,
    pub finished_with_error_code: Option<BgtaskErrorCode>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct BgtaskStatusAndLogsQuery {
    skip: i64,
}

#[get("/api/delta/geojson/latest")]
pub async fn get_geojson(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<GeoJson>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Basic")
        .await
        .c(h!())?;

    let geojson = EnemyUnitsGeojson::find()
        .filter(
            enemy_units_geojson::Column::Status
                .eq(sea_orm_active_enums::StatusEnum::Success),
        )
        .order_by_desc(enemy_units_geojson::Column::Id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .unwrap();

    let key = geojson
        .geojson_s3_id
        .clone()
        .unwrap_or_else(|| format!("enemy-units-{}.geojson", geojson.id));
    let data =
        crate::messenger::media::fetch_media_bytes_by_key(env.as_ref(), &key)
            .await
            .c(h!())?;
    if data.is_empty() {
        return Err(AppError::NotFound);
    }
    let geojson: GeoJson = serde_json::from_slice(&data).c(h!())?;
    Ok(Json(geojson))
}

#[get("/api/delta/kml/latest")]
pub async fn get_kml(
    user: actix_identity::Identity,
    http_req: HttpRequest,
    env: actix_web::web::Data<Env>,
) -> Result<HttpResponse, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Basic")
        .await
        .c(h!())?;
    match EnemyUnitsGeojson::find()
        .filter(
            enemy_units_geojson::Column::Status
                .eq(sea_orm_active_enums::StatusEnum::Success),
        )
        .order_by_desc(enemy_units_geojson::Column::Id)
        .one(&env.dbx)
        .await
        .c(h!())?
    {
        None => Err(AppError::NotFound),
        Some(ref geojson) => match geojson.kml_s3_id.clone() {
            Some(kml_key) => {
                let data = crate::messenger::media::fetch_media_bytes_by_key(
                    env.as_ref(),
                    &kml_key,
                )
                .await
                .c(h!())?;
                if data.is_empty() {
                    return Err(AppError::NotFound);
                }
                Ok(HttpResponse::Ok()
                    .content_type("application/vnd.google-earth.kml+xml")
                    .body(data))
            }
            None => {
                let kml_file =
                    PathBuf::from(config::get_assets_folder(&env.config))
                        .join(format!("enemy-units-{}.kml", geojson.id));
                if kml_file.exists() {
                    let file = actix_files::NamedFile::open_async(&kml_file)
                        .await
                        .c(h!())?;
                    Ok(file.into_response(&http_req))
                } else {
                    Err(AppError::NotFound)
                }
            }
        },
    }
}

#[post("/api/delta/convert-kmz-to-geojson")]
pub async fn import_map(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    mut payload: Multipart,
) -> Result<Json<i64>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
    let (field, val) = multipart::extract(&mut payload).await.c(h!())?;
    let filename = field.name().c(h!())?.to_string();
    let convert = enemy_units_geojson::ActiveModel {
        id: NotSet,
        status: Set(Some(sea_orm_active_enums::StatusEnum::Pending)),
        geojson_s3_id: Set(None),
        kml_s3_id: Set(None),
        created_at: Set(Utc::now().naive_utc()),
        created_by: Set(user.id().c(h!())?),
    }
    .insert(&env.dbx)
    .await
    .c(h!())?;

    let loglines: Vec<String> = vec![];
    let bgtask = bgtask::ActiveModel {
        id: NotSet,
        progress: Set(0),
        loglines: Set(serde_json::to_value(loglines).c(h!())?),
        running: Set(true),
        finished_with_error: Set(None),
    }
    .insert(&env.dbx)
    .await
    .c(h!())?;
    let bgtask_id = bgtask.id;
    let dbx = env.dbx.clone();
    let env_clone = env.clone();
    let convert_id = convert.id;

    tokio::spawn(async move {
        let res = async {
            let tmp_dir = TempDir::new()?;
            bgtask_log(
                Some(bgtask_id),
                &format!("> tmp_dir {}", &tmp_dir.path().display()),
                &dbx,
            )
            .await
            .c(h!())?;
            let geojson_file = Path::new(&filename).with_extension("geojson");
            let geojson_file = geojson_file.file_name().ok_or("impossible")?;
            let kmz_file = tmp_dir.path().join(filename);
            bgtask_log(
                Some(bgtask_id),
                &format!("> kmz_file: {}", &kmz_file.display()),
                &dbx,
            )
            .await
            .c(h!())?;
            std::fs::write(&kmz_file, val)?;
            std::process::Command::new("ls")
                .args([tmp_dir.path()])
                .spawn()?;
            bgtask_log(
                Some(bgtask_id),
                &format!("> running unzip {}", &kmz_file.display()),
                &dbx,
            )
            .await
            .c(h!())?;
            crate::utils::zip::unzip(&kmz_file)?;
            bgtask_log(Some(bgtask_id), "> unzip done", &dbx)
                .await
                .c(h!())?;
            crate::utils::backup_tmp_dir(tmp_dir.path())?;
            let mut doc_kml = tmp_dir
                .path()
                .join(kmz_file.file_stem().ok_or("no stem 28471")?)
                .join("doc.kml");
            if !doc_kml.exists() {
                doc_kml = tmp_dir.path().join("doc.kml");
            }
            if !doc_kml.exists() {
                let entries: Vec<std::fs::DirEntry> =
                    std::fs::read_dir(tmp_dir.path())?
                        .filter_map(|x| x.ok())
                        .collect();
                for entry in entries {
                    if entry.file_type()?.is_file() {
                        let path = entry.path();
                        if path.extension() == Some("kml".as_ref()) {
                            doc_kml = path;
                            break;
                        }
                    }
                }
            }
            bgtask_log(
                Some(bgtask_id),
                &format!("> doc_kml: {}", &doc_kml.display()),
                &dbx,
            )
            .await
            .c(h!())?;

            let geojson_name = format!("enemy-units-{convert_id}.geojson");

            let output = tmp_dir.path().join(geojson_file);
            kmz_to_geojson_1(&doc_kml, &output).map_err(|e| -> AppError {
                format!("convert error: {e:?}").into()
            })?;

            let kmz_dir = output.parent().unwrap();
            let geojson_id = PathBuf::from(&geojson_name).with_extension("");
            let processed_kml_path =
                doc_kml.with_extension(TEMPORARY_KML_FILE_EXTENSION);
            let mut input = std::fs::read_to_string(&processed_kml_path)?;
            std::fs::remove_file(&processed_kml_path)?;
            let dest_url = &PathBuf::from(get_assets_url()).join(&geojson_id);
            let target_path = tmp_dir.path().join(&geojson_id);
            let orig_copied_files = copy_kmz_contents(
                kmz_dir.to_path_buf(),
                target_path.clone(),
                "",
            )?;
            for orig_filename in orig_copied_files {
                let old_tag =
                    format!("<href>{}</href>", orig_filename.display());
                let new_tag = format!(
                    "<href>{}</href>",
                    dest_url.join(orig_filename).display()
                );
                input = input.replace(&old_tag[..], &new_tag[..]);
            }
            std::fs::write(target_path.with_extension("kml"), &input)?;
            let geojson_bytes = std::fs::read(&output)?;
            let geojson_key = crate::messenger::media::store_asset(
                env_clone.as_ref(),
                &geojson_bytes,
                Some(geojson_name.as_str()),
                Some("application/geo+json"),
            )
            .await
            .c(h!())?;
            let kml_name = format!("enemy-units-{convert_id}.kml");
            let kml_key = crate::messenger::media::store_asset(
                env_clone.as_ref(),
                input.as_bytes(),
                Some(kml_name.as_str()),
                Some("application/vnd.google-earth.kml+xml"),
            )
            .await
            .c(h!())?;
            bgtask_log(
                Some(bgtask_id),
                &format!("> stored geojson to {geojson_key}"),
                &dbx,
            )
            .await
            .c(h!())?;
            bgtask_log(
                Some(bgtask_id),
                &format!("> stored kml to {kml_key}"),
                &dbx,
            )
            .await
            .c(h!())?;

            Ok::<(String, String), AppError>((geojson_key, kml_key))
        };

        println!("> task finished");
        let res = res.await;
        let res_for_bgtask =
            res.as_ref().map(|_| ()).map_err(|e| AppError::BL {
                msg: format!("{e:?}"),
            });
        let mut convert_active = convert.into_active_model();

        match res {
            Ok((geojson_key, kml_key)) => {
                convert_active.status =
                    Set(Some(sea_orm_active_enums::StatusEnum::Success));
                convert_active.geojson_s3_id = Set(Some(geojson_key));
                convert_active.kml_s3_id = Set(Some(kml_key));
            }
            Err(e) => {
                println!("> error: {e:?}");
                convert_active.status =
                    Set(Some(sea_orm_active_enums::StatusEnum::Failed));
            }
        }
        let _ = finish_bgtask(Some(bgtask_id), &dbx, &res_for_bgtask).await;
        let _ = convert_active.update(&dbx).await;
    });

    Ok(Json(bgtask_id))
}

fn copy_kmz_contents(
    src: PathBuf,
    dst: PathBuf,
    root_rel: &str,
) -> std::io::Result<Vec<PathBuf>> {
    let root_path = PathBuf::from(root_rel);
    let mut collector: Vec<PathBuf> = vec![];
    for entry in std::fs::read_dir(src.clone())? {
        let entry = entry?;
        let ty = entry.file_type()?;
        if ty.is_dir() {
            let root_path = root_path
                .clone()
                .join(entry.file_name())
                .to_str()
                .unwrap()
                .to_string();
            let paths: &mut Vec<PathBuf> = &mut copy_kmz_contents(
                entry.path(),
                dst.join(entry.file_name()),
                &root_path[..],
            )?;
            collector.append(paths);
        } else {
            let from = entry.path();
            let extension = from.extension().and_then(|e| e.to_str());
            match extension {
                Some("geojson") => {} //ignore
                Some("kmz") => {}     //ignore
                Some("kml") => {}     //ignore
                _ => {
                    let to = dst.clone().join(entry.file_name());
                    std::fs::create_dir_all(&dst)?;
                    std::fs::copy(from.clone(), to.clone())?;
                    let from_rel = root_path.clone().join(entry.file_name());
                    collector.push(from_rel);
                }
            };
        }
    }
    Ok(collector)
}

#[get("/api/bgtask/{bgtask_id}/status-and-logs")]
async fn bgtask_get_status_and_logs(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    bgtask_id: actix_web::web::Path<(i64,)>,
    q: actix_web::web::Query<BgtaskStatusAndLogsQuery>,
) -> Result<Json<BgtaskStatusAndLogsRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Basic")
        .await
        .c(h!())?;
    match Bgtask::find()
        .filter(bgtask::Column::Id.eq(bgtask_id.0))
        .one(&env.dbx)
        .await
        .c(h!())?
    {
        None => {
            println!("> couldn't find bgtask {}. skipping", bgtask_id.0);
            Err(AppError::BL {
                msg: format!("task id not found: {}", bgtask_id.0),
            })
        }
        Some(bgtask) => {
            let finished_with_error = bgtask.finished_with_error.clone();
            let loglines: Vec<String> =
                serde_json::from_value(bgtask.loglines).c(h!())?;
            let loglines =
                loglines.iter().skip(q.skip as usize).cloned().collect();
            Ok(Json(BgtaskStatusAndLogsRsp {
                running: bgtask.running,
                loglines,
                finished_with_error,
                finished_with_error_code: bgtask_error_code_from_message(
                    bgtask.finished_with_error.as_ref(),
                ),
            }))
        }
    }
}

pub async fn finish_bgtask(
    bgid: Option<i64>,
    dbx: &sea_orm::DatabaseConnection,
    res: &Result<(), AppError>,
) -> Result<(), AppError> {
    if let Some(bgtask_id) = bgid {
        if let Some(bgtask) = Bgtask::find()
            .filter(bgtask::Column::Id.eq(bgtask_id))
            .one(dbx)
            .await
            .c(h!())?
        {
            let mut bgtask: bgtask::ActiveModel = bgtask.into();
            bgtask.running = Set(false);
            if let Err(ref e) = res {
                bgtask.finished_with_error = Set(Some(format!("{e:?}")));
            }
            bgtask.update(dbx).await.c(h!())?;
        }
    }
    Ok(())
}

#[post("/api/delta/kmz-to-geojson")]
pub async fn kmz_to_geojson(
    user: actix_identity::Identity,
    http_req: HttpRequest,
    env: actix_web::web::Data<Env>,
    mut payload: Multipart,
) -> Result<actix_web::HttpResponse, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Basic")
        .await
        .c(h!())?;
    let (field, val) = multipart::extract(&mut payload).await.c(h!())?;
    let filename = field.name().c(h!())?;
    let tmp_dir = TempDir::new()?;
    println!("> tmp_dir {}", &tmp_dir.path().display());
    let geojson_file = Path::new(&filename).with_extension("geojson");
    let geojson_file = geojson_file.file_name().ok_or("impossible")?;
    let kmz_file = tmp_dir.path().join(filename);
    println!("> kmz_file: {}", &kmz_file.display());
    std::fs::write(&kmz_file, val)?;
    println!("> running ls");
    std::process::Command::new("ls")
        .args([tmp_dir.path()])
        .spawn()?;
    println!("> running unzip {}", &kmz_file.display());
    crate::utils::zip::unzip(&kmz_file)?;
    println!("> unzip done");
    crate::utils::backup_tmp_dir(tmp_dir.path())?;
    let src_dir = tmp_dir
        .path()
        .join(kmz_file.file_stem().ok_or("no stem 28471")?);
    let mut doc_kml = src_dir.join("doc.kml");
    if !doc_kml.exists() {
        doc_kml = tmp_dir.path().join("doc.kml");
    }
    if !doc_kml.exists() {
        // read the first kml file in the directory
        let entries: Vec<std::fs::DirEntry> =
            std::fs::read_dir(tmp_dir.path())?
                .filter_map(|x| x.ok())
                .collect();
        for entry in entries {
            if entry.file_type()?.is_file() {
                let path = entry.path();
                if path.extension() == Some("kml".as_ref()) {
                    doc_kml = path;
                    break;
                }
            }
        }
    }
    println!("> doc_kml: {}", &doc_kml.display());
    let output = tmp_dir.path().join(geojson_file);
    kmz_to_geojson_1(&doc_kml, &output)?;

    let file = actix_files::NamedFile::open_async(&output).await.c(h!())?;
    Ok(file.into_response(&http_req))
}

pub fn delta_objs_to_kmz(
    config: &crate::config::Config,
    objs: &[ObjectContract],
    obj_detail: &BTreeMap<String, ObjectRsp>,
    obj_attachments: &BTreeMap<String, Vec<String>>,
) -> Result<Vec<u8>, AppError> {
    let mut per_day: BTreeMap<String, Vec<ObjectContract>> = BTreeMap::new();
    for obj in objs.iter() {
        let dt = DateTime::from_timestamp_millis(obj.reporting_date_time)
            .ok_or("error converting from timestamp millis")?
            .naive_utc();
        let dt_s = format!("{}-{:02}-{:02}", dt.year(), dt.month(), dt.day());
        per_day
            .entry(dt_s)
            .and_modify(|v| v.push(obj.clone()))
            .or_insert(vec![obj.clone()]);
    }

    // per app6d
    let mut styles_normal: BTreeMap<String, Style> = BTreeMap::new();
    // per app6d
    let mut styles_highlight: BTreeMap<String, Style> = BTreeMap::new();
    for obj in objs.iter() {
        let symbol = &obj.symbol;
        if !styles_normal.contains_key(&symbol.app6d.sidc) {
            let icon = format!("{}.png", symbol.app6d.sidc);
            styles_normal.insert(
                symbol.app6d.sidc.clone(),
                Style {
                    id: Some(format!("normal-{}", symbol.app6d.sidc.clone())),
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
                symbol.app6d.sidc.clone(),
                Style {
                    id: Some(format!(
                        "highlight-{}",
                        symbol.app6d.sidc.clone()
                    )),
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
    }
    let mut styles: Vec<Style> = vec![];
    for (_, style) in styles_normal.iter() {
        styles.push(style.clone());
    }
    for (_, style) in styles_highlight.iter() {
        styles.push(style.clone());
    }
    styles.extend(get_kmz_line_styles());
    let mut style_maps = vec![];
    style_maps.extend(get_kmz_line_style_maps());

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

    let mut folders = vec![];
    for (day, objs) in per_day.iter() {
        let mut placemarks = vec![];
        for obj in objs.iter() {
            let m_objd = obj_detail.get(&obj.id);
            // let objd: &ObjectRsp = objd;
            let mut description = m_objd
                .map(|x| x.comments.clone().unwrap_or_default().join("<br>\n"))
                .unwrap_or("".to_string());
            for img in obj_attachments.get(&obj.id).unwrap_or(&vec![]).iter() {
                description += &format!("<img src=\"{img}\" width=600><br>\n");
            }
            // if it's a placemark
            if let (Some(lng), Some(lat)) = (
                obj.geometry.absolute_point_longitude_coordinate.as_ref(),
                obj.geometry.absolute_point_latitude_coordinate.as_ref(),
            ) {
                let symbol = &obj.symbol;
                placemarks.push(Node::Placemark(Placemark {
                    name: Some(obj.name.clone().unwrap_or("".to_string())),
                    visibility: None,
                    snippet: None,
                    snippet_lower: None,
                    description: Some(description),
                    style: None,
                    style_url: Some(StyleUrl {
                        body: format!("#map-{}", symbol.app6d.sidc),
                    }),
                    point: Some(Point {
                        draw_order: None,
                        coordinates: Some(format!(
                            "{},{},0",
                            lng.longitude_coordinate_coordinate,
                            lat.latitude_coordinate_coordinate
                        )),
                    }),
                    line_string: None,
                    multi_geometry: None,
                    polygon: None,
                    extended_data: None,
                }));
            } else if obj.geometry.type_ == "LineTypeCustom" {
                if let Some(locations) = obj.geometry.line_point.as_ref() {
                    let app6d =
                        crate::icons::parse_app6d(&obj.symbol.app6d.sidc)?;
                    // println!("{} {:?}", &obj.symbol.app6d.sidc, app6d);
                    let mut style_url =
                        if matches!(app6d.identity.as_str(), "3" | "2") {
                            "map-line-friendly"
                        } else if &app6d.identity == "4" {
                            "map-line-neutral"
                        } else if matches!(app6d.identity.as_str(), "1" | "0") {
                            "map-line-unknown"
                        } else if matches!(app6d.identity.as_str(), "6" | "5") {
                            "map-line-hostile"
                        } else {
                            return Err(AppError::BL {
                                msg: format!(
                                    "Couldn't handle identity: {}",
                                    app6d.identity
                                ),
                            });
                        };
                    // зуби дракона
                    if &app6d.main_icon == "290202"
                        || &app6d.main_icon == "290204"
                    {
                        style_url = "map-line-neutral";
                    }
                    let coords_s = locations
                        .iter()
                        .map(|location| {
                            format!(
                                "{},{},{}",
                                location
                                    .absolute_point_longitude_coordinate
                                    .longitude_coordinate_coordinate,
                                location
                                    .absolute_point_latitude_coordinate
                                    .latitude_coordinate_coordinate,
                                location
                                    .absolute_point_vertical_distance
                                    .vertical_distance_dimension
                                    .unwrap_or(0.0)
                            )
                        })
                        .collect::<Vec<String>>()
                        .join(" ");
                    placemarks.push(Node::Placemark(Placemark {
                        name: Some(obj.name.clone().unwrap_or("".to_string())),
                        visibility: None,
                        description: Some(description),
                        style: None,
                        style_url: Some(StyleUrl {
                            body: format!("#{style_url}"),
                        }),
                        point: None,
                        line_string: Some(LineString {
                            tessellate: Some(Tessellate {
                                body: Some("1".to_string()),
                            }),
                            coordinates: Some(Coordinates {
                                body: Some(coords_s),
                            }),
                        }),
                        multi_geometry: None,
                        polygon: None,
                        extended_data: None,
                        snippet: None,
                        snippet_lower: None,
                    }));
                }
            }
        }
        folders.push(Node::Folder(Folder {
            name: Some(Name {
                body: day.to_string(),
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
            nodes: placemarks,
        }));
    }

    let now = Utc::now();
    let now_s = format!("{}-{:02}-{:02}", now.year(), now.month(), now.day());
    let root_folder = Folder {
        name: Some(Name {
            body: format!("operatyvka-{now_s}"),
        }),
        look_at: None,
        description: None,
        open: None,
        styles,
        style_maps,
        visibility: None,
        snippet: None,
        snippet_lower: None,
        link: None,
        camera: None,
        gx_balloon_visibility: None,
        schema: vec![],
        nodes: folders,
    };
    let kml = Kml {
        nodes: vec![Node::Folder(root_folder)],
    };

    // bgtask_log(m_bgtask_id, "Wrapping in kmz", dbx).await.c(h!())?;

    let tmp_dir = TempDir::new()?;
    let res_path = crate::importer::package_up_kmz2(config, &tmp_dir, &kml)?;
    let res_bytes = std::fs::read(res_path)?;

    Ok(res_bytes)
}

fn get_kmz_line_styles() -> Vec<Style> {
    let styles = vec![
        Style {
            id: Some("normal-line-friendly".to_string()),
            icon_style: None,
            label_style: None,
            balloon_style: None,
            line_style: Some(LineStyle {
                color: Some(Color {
                    body: crate::icons::COLOR_FRIENDLY_LINE.to_string(),
                }),
                width: Some(Width {
                    body: "2.0".to_string(),
                }),
            }),
            poly_style: None,
        },
        Style {
            id: Some("normal-line-neutral".to_string()),
            icon_style: None,
            label_style: None,
            balloon_style: None,
            line_style: Some(LineStyle {
                color: Some(Color {
                    body: crate::icons::COLOR_NEUTRAL_LINE.to_string(),
                }),
                width: Some(Width {
                    body: "2.0".to_string(),
                }),
            }),
            poly_style: None,
        },
        Style {
            id: Some("normal-line-unknown".to_string()),
            icon_style: None,
            label_style: None,
            balloon_style: None,
            line_style: Some(LineStyle {
                color: Some(Color {
                    body: crate::icons::COLOR_UNKNOWN_LINE.to_string(),
                }),
                width: Some(Width {
                    body: "2.0".to_string(),
                }),
            }),
            poly_style: None,
        },
        Style {
            id: Some("normal-line-hostile".to_string()),
            icon_style: None,
            label_style: None,
            balloon_style: None,
            line_style: Some(LineStyle {
                color: Some(Color {
                    body: crate::icons::COLOR_HOSTILE_LINE.to_string(),
                }),
                width: Some(Width {
                    body: "2.0".to_string(),
                }),
            }),
            poly_style: None,
        },
        Style {
            id: Some("highlight-line-friendly".to_string()),
            icon_style: None,
            label_style: None,
            balloon_style: None,
            line_style: Some(LineStyle {
                color: Some(Color {
                    body: crate::icons::COLOR_FRIENDLY_LINE.to_string(),
                }),
                width: Some(Width {
                    body: "3.0".to_string(),
                }),
            }),
            poly_style: None,
        },
        Style {
            id: Some("highlight-line-neutral".to_string()),
            icon_style: None,
            label_style: None,
            balloon_style: None,
            line_style: Some(LineStyle {
                color: Some(Color {
                    body: crate::icons::COLOR_NEUTRAL_LINE.to_string(),
                }),
                width: Some(Width {
                    body: "3.0".to_string(),
                }),
            }),
            poly_style: None,
        },
        Style {
            id: Some("highlight-line-unknown".to_string()),
            icon_style: None,
            label_style: None,
            balloon_style: None,
            line_style: Some(LineStyle {
                color: Some(Color {
                    body: crate::icons::COLOR_UNKNOWN_LINE.to_string(),
                }),
                width: Some(Width {
                    body: "3.0".to_string(),
                }),
            }),
            poly_style: None,
        },
        Style {
            id: Some("highlight-line-hostile".to_string()),
            icon_style: None,
            label_style: None,
            balloon_style: None,
            line_style: Some(LineStyle {
                color: Some(Color {
                    body: crate::icons::COLOR_HOSTILE_LINE.to_string(),
                }),
                width: Some(Width {
                    body: "3.0".to_string(),
                }),
            }),
            poly_style: None,
        },
    ];
    styles
}

fn get_kmz_line_style_maps() -> Vec<StyleMap> {
    let style_maps = vec![
        StyleMap {
            id: Some("map-line-friendly".to_string()),
            pairs: vec![
                Pair {
                    key: Key {
                        body: "normal".to_string(),
                    },
                    style_url: StyleUrl {
                        body: "#normal-line-friendly".to_string(),
                    },
                },
                Pair {
                    key: Key {
                        body: "highlight".to_string(),
                    },
                    style_url: StyleUrl {
                        body: "#highlight-line-friendly".to_string(),
                    },
                },
            ],
        },
        StyleMap {
            id: Some("map-line-neutral".to_string()),
            pairs: vec![
                Pair {
                    key: Key {
                        body: "normal".to_string(),
                    },
                    style_url: StyleUrl {
                        body: "#normal-line-neutral".to_string(),
                    },
                },
                Pair {
                    key: Key {
                        body: "highlight".to_string(),
                    },
                    style_url: StyleUrl {
                        body: "#highlight-line-neutral".to_string(),
                    },
                },
            ],
        },
        StyleMap {
            id: Some("map-line-unknown".to_string()),
            pairs: vec![
                Pair {
                    key: Key {
                        body: "normal".to_string(),
                    },
                    style_url: StyleUrl {
                        body: "#normal-line-unknown".to_string(),
                    },
                },
                Pair {
                    key: Key {
                        body: "highlight".to_string(),
                    },
                    style_url: StyleUrl {
                        body: "#highlight-line-unknown".to_string(),
                    },
                },
            ],
        },
        StyleMap {
            id: Some("map-line-hostile".to_string()),
            pairs: vec![
                Pair {
                    key: Key {
                        body: "normal".to_string(),
                    },
                    style_url: StyleUrl {
                        body: "#normal-line-hostile".to_string(),
                    },
                },
                Pair {
                    key: Key {
                        body: "highlight".to_string(),
                    },
                    style_url: StyleUrl {
                        body: "#highlight-line-hostile".to_string(),
                    },
                },
            ],
        },
    ];
    style_maps
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct DownloadLayerResultReq {
    pub bgtask_id: i64,
}

#[post("/api/delta/download-layer/result")]
async fn download_layer_result(
    user: actix_identity::Identity,
    http_req: HttpRequest,
    env: actix_web::web::Data<Env>,
    req: Json<DownloadLayerResultReq>,
) -> Result<HttpResponse, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Bpla")
        .await
        .c(h!())?;
    let bgtask_res = BgtaskRes::find_by_id(req.bgtask_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(format!("Result not found for task id: {}", req.bgtask_id))?;
    let res_json = bgtask_res.res_json.clone().ok_or(format!(
        "res_json must be non empty for task id: {}",
        req.bgtask_id
    ))?;
    let downloaded_layer: DownloadedLayer =
        serde_json::from_value(res_json).c(h!())?;
    let tmp_dir = TempDir::new()?;
    let filename = format!("{}.kmz", downloaded_layer.overlay_name);
    let outfile = tmp_dir.path().join(filename);
    let res_bytes = match bgtask_res.res_s3_id.as_deref() {
        Some(key) => {
            crate::messenger::media::fetch_media_bytes_by_key(env.as_ref(), key)
                .await
                .c(h!())?
        }
        None => {
            let res_bytes = bgtask_res.res_bytes.clone().ok_or(format!(
                "res_bytes must be non empty for task id: {}",
                req.bgtask_id
            ))?;
            if env.config.s3_config.is_none() || env.s3_config.is_none() {
                res_bytes
            } else {
                let filename_s = outfile
                    .file_name()
                    .ok_or("missing kmz filename")?
                    .to_string_lossy()
                    .to_string();
                let res_s3_id = crate::messenger::media::store_asset(
                    env.as_ref(),
                    &res_bytes,
                    Some(filename_s.as_str()),
                    Some(crate::config::KMZ_CONTENT_TYPE),
                )
                .await
                .c(h!())?;
                let mut bgtask_res_active: bgtask_res::ActiveModel =
                    bgtask_res.into();
                bgtask_res_active.res_s3_id = Set(Some(res_s3_id));
                bgtask_res_active.res_bytes = Set(None);
                bgtask_res_active.update(&env.dbx).await.c(h!())?;
                res_bytes
            }
        }
    };
    std::fs::write(&outfile, &res_bytes)?;
    let filename = outfile
        .file_name()
        .ok_or("missing kmz filename")?
        .to_string_lossy()
        .to_string();
    let cd = header::ContentDisposition {
        disposition: header::DispositionType::Attachment,
        parameters: vec![header::DispositionParam::FilenameExt(
            header::ExtendedValue {
                charset: header::Charset::Ext("UTF-8".into()),
                language_tag: None,
                value: filename.into_bytes(),
            },
        )],
    };
    let file = actix_files::NamedFile::open_async(outfile).await.c(h!())?;
    Ok(file.set_content_disposition(cd).into_response(&http_req))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_comments_parse_html_comment() {
        let input = r###"<img src="https://doc-10-7s-mymaps.googleusercontent.com/untrusted/hostedimage/sag4sl88enunkd89ogmm94u390/62vneq6b20sh1qob9t8onvap7c/1670998949750/UaaIfY3en9gpS6MgoKqy75U75UeAEbb4/00643509500519283002/5AKgB-9nQF2GXY4BpbZCx_eHUG_7MXg26ktb-JiJTb0vMs7U6gsAUoKARrQDNp0Cy7mDKlqomnuvdVHjHdT001Dd5LhO9THW9z6k5V9r67Oz-4MEK_rIbrM2ry9jZ2GaVsUNlmahCgPh3-Tf8j9vZtI2Be-xz_wvUGCGKfaXe7xRfhVwyokikyGZEwYn2-YD5X47wfg?session=0&fife" height="200" width="auto" /><br><br>Hello"###;
        let result = vec![
            r"https://doc-10-7s-mymaps.googleusercontent.com/untrusted/hostedimage/sag4sl88enunkd89ogmm94u390/62vneq6b20sh1qob9t8onvap7c/1670998949750/UaaIfY3en9gpS6MgoKqy75U75UeAEbb4/00643509500519283002/5AKgB-9nQF2GXY4BpbZCx_eHUG_7MXg26ktb-JiJTb0vMs7U6gsAUoKARrQDNp0Cy7mDKlqomnuvdVHjHdT001Dd5LhO9THW9z6k5V9r67Oz-4MEK_rIbrM2ry9jZ2GaVsUNlmahCgPh3-Tf8j9vZtI2Be-xz_wvUGCGKfaXe7xRfhVwyokikyGZEwYn2-YD5X47wfg?session=0&fife",
            "Hello",
        ];
        let res = extract_comments(input).unwrap();
        assert_eq!(res, result);
    }

    #[test]
    fn extract_comments_hanging() {
        let input = "foo<div><a target=\"_blank\" href=\"https://foo.png\"><img src=\"https://foo\" style=\"max-width=100px; max-height: 100px;\"/></a><div><a target=\"_blank\" href=\"https:///862de2d3-542a-416b-a1af-bfa3d9a1369a.png\"><img src=\"https:///862de2d3-542a-416b-a1af-bfa3d9a1369a.png\" style=\"max-width=100px; max-height: 100px;\"/></a><div><a target=\"_blank\" href=\"https:///e020e9e1-7b06-49b1-bfda-3263d63ada7c.png\"><img src=\"https:///e020e9e1-7b06-49b1-bfda-3263d63ada7c.png\" style=\"max-width=100px; max-height: 100px;\"/></a><div><a target=\"_blank\" href=\"https:///54f40740-af8a-40f0-a818-b4723aa36088.png\"><img src=\"https:///54f40740-af8a-40f0-a818-b4723aa36088.png\" style=\"max-width=100px; max-height: 100px;\"/></a><div><a target=\"_blank\" href=\"https:///5dd429d6-061f-4aa8-ad4d-ab25ec164b8c.png\"><img src=\"https:///5dd429d6-061f-4aa8-ad4d-ab25ec164b8c.png\" style=\"max-width=100px; max-height: 100px;\"/></a><div><a target=\"_blank\" href=\"https:///3c27b9b9-aaf9-4656-a896-43031ed9d186.png\"><img src=\"https:///3c27b9b9-aaf9-4656-a896-43031ed9d186.png\" style=\"max-width=100px; max-height: 100px;\"/></a><div><a target=\"_blank\" href=\"https:///7bc9e25a-6bf0-4eba-98b6-c540ed343c60.png\"><img src=\"https:///7bc9e25a-6bf0-4eba-98b6-c540ed343c60.png\" style=\"max-width=100px; max-height: 100px;\"/></a><div><a target=\"_blank\" href=\"https:///e3b7a976-b1d4-4d1e-8960-d421a16f8e55.png\"><img src=\"https:///e3b7a976-b1d4-4d1e-8960-d421a16f8e55.png\" style=\"max-width=100px; max-height: 100px;\"/></a><div><a target=\"_blank\" href=\"https:///e3361d20-3713-40ad-ba4b-00270411862f.png\"><img src=\"https:///e3361d20-3713-40ad-ba4b-00270411862f.png\" style=\"max-width=100px; max-height: 100px;\"/></a><div><a target=\"_blank\" href=\"https:///ff08771e-6a3a-4c85-8a96-8bf589b79bc5.png\"><img src=\"https:///ff08771e-6a3a-4c85-8a96-8bf589b79bc5.png\" style=\"max-width=100px; max-height: 100px;\"/></a><div><a target=\"_blank\" href=\"https:///99661e50-7676-493b-a89d-8b4a44a51abd.png\"><img src=\"https:///99661e50-7676-493b-a89d-8b4a44a51abd.png\" style=\"max-width=100px; max-height: 100px;\"/></a><div><a target=\"_blank\" href=\"https:///ad86a5ba-dfe3-4791-be87-b6cbc7f5619c.png\"><img src=\"https:///ad86a5ba-dfe3-4791-be87-b6cbc7f5619c.png\" style=\"max-width=100px; max-height: 100px;\"/></a><div><a target=\"_blank\" href=\"https:///53ca3a5f-89ea-4172-824b-c5b8bf4a8fb5.png\"><img src=\"https:///53ca3a5f-89ea-4172-824b-c5b8bf4a8fb5.png\" style=\"max-width=100px; max-height: 100px;\"/></a>";
        let _res = tl::parse(input, tl::ParserOptions::default()).unwrap();
    }

    #[test]
    fn test_kml_example_01() {
        // parse data/kml_example_01.kml
        let input = std::fs::read_to_string("data/kml_example_01.kml").unwrap();
        let kml: Kml = quick_xml::de::from_str(&input).unwrap();
        println!("> kml: {kml:?}");
    }
}
