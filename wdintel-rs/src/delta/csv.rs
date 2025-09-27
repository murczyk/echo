use super::types::*;
use crate::error::AppError;
use crate::types::*;
use crate::utils::multipart;
use actix_multipart::Multipart;
use actix_web::{post, HttpRequest};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tempfile::TempDir;

#[derive(Debug, serde::Deserialize)]
pub struct Record {
    #[serde(rename = "app6d sidc")]
    pub app6d_sidc: String,
    #[serde(rename = "app6d type")]
    pub app6d_type: String,
    #[serde(rename = "overlay name")]
    pub overlay_name: String,
    #[serde(rename = "object id")]
    pub object_id: String,
    #[serde(rename = "objects count")]
    pub objects_count: String,
    #[serde(rename = "name")]
    pub name: String,
    #[serde(rename = "status of presence")]
    pub status_of_presence: String,
    #[serde(rename = "coordinates(sk-42)")]
    pub coordinates_sk42: String,
    #[serde(rename = "coordinates(wgs,yx)")]
    pub coordinates_wgs: String,
    #[serde(rename = "observation date/time")]
    pub observation_date_time: String,
    #[serde(rename = "updating datetime")]
    pub updateing_datetime: String,
    #[serde(rename = "closest settlement")]
    pub closest_settlement: String,
    #[serde(rename = "comments")]
    pub comments: String,
}

fn extract_lat_lng(cor_pair: &str) -> Result<(f64, f64), AppError> {
    let res: Vec<String> =
        cor_pair.split(", ").map(|x| x.to_string()).collect();
    if res.clone().len() != 2 {
        return Err(AppError::BL {
            msg: format!("Bad wgs yx pair: {cor_pair}"),
        });
    }
    let lat: f64 = res[0].parse().c(h!())?;
    let lng: f64 = res[1].parse().c(h!())?;
    Ok((lat, lng))
}

pub fn csv_to_kmz(
    mode: Mode,
    ps: &crate::OneoffDeltaCsvToKmzPs,
) -> Result<PathBuf, AppError> {
    println!("> starting csv_to_kmz");
    let config = crate::config::read_config(mode)?;
    let inpath = Path::new(&ps.path);
    let mut rdr = csv::Reader::from_path(inpath).c(h!())?;
    let mut objs: Vec<ObjectContract> = vec![];
    let obj_detail: BTreeMap<String, ObjectRsp> = BTreeMap::new();
    let obj_attachments: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for e_rec in rdr.deserialize() {
        let rec: Record = e_rec.c(h!())?;
        let mut line_points: Vec<LocationGeometryRsp> = vec![];
        let cors: Vec<String> = rec
            .coordinates_wgs
            .split("; ")
            .map(|x| x.to_string())
            .collect();
        for cor_pair in cors.iter() {
            let (lat, lng) = extract_lat_lng(cor_pair)?;
            line_points.push(LocationGeometryRsp {
                type_: "AbsolutePointTypeCustom".to_string(),
                extension: None,
                absolute_point_latitude_coordinate:
                    AbsolutePointLatitudeCoordinateRsp {
                        latitude_coordinate_coordinate: lat,
                    },
                absolute_point_longitude_coordinate:
                    AbsolutePointLongitudeCoordinateRsp {
                        longitude_coordinate_coordinate: lng,
                    },
                absolute_point_vertical_distance:
                    AbsolutePointVerticalDistanceRsp {
                        vertical_distance_dimension: None,
                    },
            });
        }
        if cors.len() == 1 {
            let (lat, lng) = extract_lat_lng(&cors[0])?;
            objs.push(ObjectContract {
                type_: None,
                id: rec.object_id.clone(),
                name: Some(format!("{} {}", rec.app6d_type, rec.name.clone())),
                type_id: None,
                type_name: None,
                parent_type_name: None,
                layer_id: rec.overlay_name.clone(),
                reporting_date_time: 1672665090828,
                geometry: ObjectContractGeometry {
                    type_: "AbsolutePointTypeCustom".to_string(),
                    absolute_point_latitude_coordinate: Some(
                        AbsolutePointLatitudeCoordinateRsp {
                            latitude_coordinate_coordinate: lat,
                        },
                    ),
                    absolute_point_longitude_coordinate: Some(
                        AbsolutePointLongitudeCoordinateRsp {
                            longitude_coordinate_coordinate: lng,
                        },
                    ),
                    absolute_point_vertical_distance: None,
                    velocity_type: None,
                    line_point: Some(line_points),
                },
                source: None,
                symbol: SymbolRsp {
                    app6d: App6dRsp {
                        sidc: rec.app6d_sidc.clone(),
                        amplifier_fields: None,
                    },
                    milstd2525c: None,
                },
                attachments_count: None,
                layer_list: None,
                action: None,
            });
        } else {
            objs.push(ObjectContract {
                type_: None,
                id: rec.object_id.clone(),
                name: Some(rec.name.clone()),
                type_id: None,
                type_name: None,
                parent_type_name: None,
                layer_id: rec.overlay_name.clone(),
                reporting_date_time: 1672665090828,
                geometry: ObjectContractGeometry {
                    type_: "LineTypeCustom".to_string(),
                    absolute_point_latitude_coordinate: None,
                    absolute_point_longitude_coordinate: None,
                    absolute_point_vertical_distance: None,
                    velocity_type: None,
                    line_point: Some(line_points),
                },
                source: None,
                symbol: SymbolRsp {
                    app6d: App6dRsp {
                        sidc: rec.app6d_sidc.clone(),
                        amplifier_fields: None,
                    },
                    milstd2525c: None,
                },
                attachments_count: None,
                layer_list: None,
                action: None,
            });
        }
    }
    let res_bytes = crate::delta::delta_objs_to_kmz(
        &config,
        &objs,
        &obj_detail,
        &obj_attachments,
    )?;
    let outfile = inpath.with_extension("kmz");
    println!("Done. Writing result to: {}", outfile.display());
    std::fs::write(&outfile, &res_bytes)?;
    Ok(outfile)
}

#[post("/api/delta/csv2kmz")]
pub async fn api_delta_csv_to_kmz(
    user: actix_identity::Identity,
    http_req: HttpRequest,
    env: actix_web::web::Data<Env>,
    mut payload: Multipart,
) -> Result<actix_web::HttpResponse, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Bpla")
        .await
        .c(h!())?;
    let (field, val) = multipart::extract(&mut payload).await.c(h!())?;
    let tmp_dir = TempDir::new()?;
    println!("> tmp_dir {}", &tmp_dir.path().display());
    let csv_file = tmp_dir.path().join(field.name().c(h!())?);
    println!("> csv_file: {}", &csv_file.display());
    std::fs::write(&csv_file, val)?;
    crate::utils::backup_tmp_dir(tmp_dir.path())?;

    let output = csv_to_kmz(
        env.mode,
        &crate::OneoffDeltaCsvToKmzPs {
            path: csv_file.as_path().display().to_string(),
        },
    )?;

    let file = actix_files::NamedFile::open_async(&output).await.c(h!())?;
    Ok(file.into_response(&http_req))
}
