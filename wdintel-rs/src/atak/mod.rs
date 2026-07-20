use self::types::*;
use crate::error::AppError;
use crate::h;
use crate::types::*;
use actix_web::get;
use actix_web::HttpRequest;
use chrono::SecondsFormat;
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::PathBuf;
use tempfile::TempDir;
use uuid::Uuid;
use walkdir::WalkDir;

pub mod types;

fn render_dt(dt: chrono::DateTime<chrono::Utc>) -> String {
    dt.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn placemark_to_event(
    placemark: &crate::kml::types::Placemark,
    uid: &str,
    style_maps: &BTreeMap<String, String>,
) -> Result<Option<Event>, AppError> {
    let dt = chrono::offset::Utc::now();
    match &placemark.point {
        None => {
            // todo Placemark has no point, thus no coordinates
            // Probably has line_string which should be handled here
            Ok(None)
        }
        Some(ref point) => {
            let coordinates = point
                .coordinates
                .clone()
                .ok_or("coordinates value is empty thus cannot be extracted")?;
            let (lat, lng) =
                milgeo_rs::coordinates::parse_point_coordinates(&coordinates)?;
            let point = Point {
                lat,
                lon: lng,
                // HACK: don't hardcode this
                hae: "70".to_string(),
                ce: "9999999.0".to_string(),
                le: "9999999.0".to_string(),
            };
            let detail = Detail {
                status: Status {
                    readiness: "true".to_string(),
                },
                archives: vec![],
                remarks: Remarks {
                    body: placemark
                        .description
                        .clone()
                        .unwrap_or("".to_string()),
                },
                link: Link {
                    uid: "ANDROID-dfd24c71c682b03a".to_string(),
                    production_time: render_dt(dt),
                    type_: "a-f-G-U-C".to_string(),
                    parent_callsign: "ziggy".to_string(),
                    relation: "p-p".to_string(),
                },
                color: Color {
                    argb: "-1".to_string(),
                },
                precisionlocation: Precisionlocation {
                    altsrc: "DTED0".to_string(),
                },
                usericon: Usericon {
                    iconsetpath: "COT_MAPPING_2525C/a-h/a-h-G".to_string(),
                },
                contact: Contact {
                    callsign: placemark.name.clone().unwrap_or("".to_string()),
                },
            };
            let mut event_type = "a-h-G".to_string();
            if let Some(style_url) = &placemark.style_url {
                let style_url_stripped: String =
                    style_url.body.chars().skip(1).collect();
                if let Some(icon) = style_maps.get(&style_url_stripped) {
                    let icon2 = crate::icons::convert_tsup_icon(icon)?;
                    if let Some(x) =
                        crate::icons::extract_atak_event_type_by_icon(&icon2)?
                    {
                        event_type = x;
                    }
                } else {
                    println!(
                        "warning: icon not found in style maps for style: {:?}",
                        &style_url_stripped
                    );
                }
            } else {
                println!("warning: placemark has no style: {:?}", &placemark);
            }
            Ok(Some(Event {
                version: "2.0".to_string(),
                uid: uid.to_string(),
                type_: event_type,
                time: render_dt(dt),
                start: render_dt(dt),
                stale: render_dt(dt),
                how: "h-g-i-g-o".to_string(),
                point,
                detail,
            }))
        }
    }
}

fn folder_to_manifest_and_placemarks(
    folder: &crate::kml::types::Folder,
    style_maps: &BTreeMap<String, String>,
) -> Result<(MissionPackageManifest, BTreeMap<String, Event>), AppError> {
    let mut event_map = BTreeMap::new();

    let mut contents = vec![];
    let placemarks = crate::kml::folder_placemarks(folder)?;
    for placemark in placemarks.iter() {
        let uuid = Uuid::new_v4().to_string();
        contents.push(Content {
            ignore: "false".to_string(),
            zip_entry: format!("{uuid}/{uuid}.cot"),
            parameters: vec![
                Parameter {
                    name: "uid".to_string(),
                    value: uuid.clone(),
                },
                Parameter {
                    name: "name".to_string(),
                    value: placemark.name.clone().unwrap_or("".to_string()),
                },
            ],
        });
        if let Some(event) = placemark_to_event(placemark, &uuid, style_maps)? {
            event_map.insert(uuid, event);
        }
    }

    let manifest = MissionPackageManifest {
        version: "2".to_string(),
        configuration: Configuration {
            parameters: vec![
                Parameter {
                    name: "uid".to_string(),
                    value: Uuid::new_v4().to_string(),
                },
                Parameter {
                    name: "name".to_string(),
                    value: folder
                        .name
                        .clone()
                        .map(|x| x.body)
                        .unwrap_or("".to_string()),
                },
            ],
        },
        contents: Contents { contents },
    };
    Ok((manifest, event_map))
}

/// Returns a zip path
fn folder_to_data_package_zip(
    tmp_dir: &TempDir,
    folder: &crate::kml::types::Folder,
    style_maps: &BTreeMap<String, String>,
) -> Result<PathBuf, AppError> {
    let (manifest, event_map) =
        folder_to_manifest_and_placemarks(folder, style_maps)?;
    let cots: Vec<Event> = event_map.values().cloned().collect();
    let folder_name = folder
        .name
        .clone()
        .map(|x| x.body)
        .unwrap_or("datapackage".to_string());
    let base_path = tmp_dir.path().join(&folder_name);
    std::fs::create_dir(&base_path)?;
    std::fs::create_dir(base_path.join("MANIFEST"))?;
    std::fs::write(
        base_path.join("MANIFEST").join("manifest.xml"),
        quick_xml::se::to_string(&manifest).c(h!())?,
    )?;
    for cot in cots.iter() {
        std::fs::create_dir(base_path.join(&cot.uid))?;
        let cot_content = format!(
            r###"<?xml version='1.0' encoding='UTF-8' standalone='yes'?>
{}
"###,
            quick_xml::se::to_string(&cot).c(h!())?
        );
        std::fs::write(
            base_path.join(&cot.uid).join(format!("{}.cot", &cot.uid)),
            cot_content,
        )?;
    }
    let dst_file = tmp_dir.path().join(format!("{}.zip", &folder_name));
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

pub fn main_test_xml_lib(mode: Mode) -> Result<(), AppError> {
    let input = r###"
<MissionPackageManifest version="2">
   <Configuration>
      <Parameter name="uid" value="c0611f01-af42-45d9-8e65-e743f32404a6"/>
      <Parameter name="name" value="twodots"/>
   </Configuration>
   <Contents>
      <Content ignore="false" zipEntry="e5259186-03a1-42dc-b633-59ad58618c20/e5259186-03a1-42dc-b633-59ad58618c20.cot">
         <Parameter name="uid" value="e5259186-03a1-42dc-b633-59ad58618c20"/>
         <Parameter name="name" value="Marker 1"/>
      </Content>
      <Content ignore="false" zipEntry="33b6dcdb-b381-4d33-bca4-6306a981deab/33b6dcdb-b381-4d33-bca4-6306a981deab.cot">
         <Parameter name="uid" value="33b6dcdb-b381-4d33-bca4-6306a981deab"/>
         <Parameter name="name" value="Marker 2"/>
    </Content>
  </Contents>
</MissionPackageManifest>
"###;

    // let manifest: MissionPackageManifest = serde_xml_rs::from_str(input)?;
    // println!("{:?}", manifest);
    // println!("");
    // println!("{}", serde_xml_rs::to_string(&manifest)?);

    let _manifest2: MissionPackageManifest =
        quick_xml::de::from_str(input).c(h!())?;
    // println!("{:?}", manifest2);
    // println!("");
    // println!("{}", quick_xml::se::to_string(&manifest2)?);

    let input2 = r###"
<?xml version='1.0' encoding='UTF-8' standalone='yes'?>
<event version='2.0' uid='e5259186-03a1-42dc-b633-59ad58618c20' type='a-h-G' time='2022-10-30T07:32:19.752Z' start='2022-10-30T07:32:19.752Z' stale='2023-10-30T07:32:19.752Z' how='h-g-i-g-o'>
	<point lat='47.083624' lon='33.5115994' hae='70.913' ce='9999999.0' le='9999999.0' />
	<detail>
		<status readiness='true'/>
		<archive/>
		<remarks>Comment 1</remarks>
		<link uid='ANDROID-dfd24c71c682b03a' production_time='2022-10-30T07:28:00.635Z' type='a-f-G-U-C' parent_callsign='ziggy' relation='p-p'/>
		<archive/>
		<color argb='-1'/>
		<precisionlocation altsrc='DTED0'/>
		<usericon iconsetpath='COT_MAPPING_2525C/a-h/a-h-G'/>
		<contact callsign='Marker 1'/>
	</detail>
</event>
"###;

    let _event: Event = quick_xml::de::from_str(input2).c(h!())?;
    // println!("{:?}", event);
    // println!("");
    // println!("{}", quick_xml::se::to_string(&event)?);

    let kml = crate::kml::read_myplaces(mode)?;
    let folders = crate::kml::extract_operatyvka_folders(&kml)?;
    for folder in folders.iter() {
        if folder.name.clone().map(|x| x.body) == Some("2022-10-28".to_string())
        {
            let tmp_dir = TempDir::new()?;
            let dst_file =
                folder_to_data_package_zip(&tmp_dir, folder, &BTreeMap::new())?;
            std::fs::copy(
                &dst_file,
                dirs::home_dir()
                    .unwrap()
                    .join("Downloads")
                    .join(dst_file.file_name().unwrap()),
            )?;
        }
    }

    Ok(())
}

#[derive(Deserialize)]
struct OperatyvkaDownloadReq {
    folder: String,
}

#[get("/api/atak/operatyvka/download")]
async fn operatyvka_download(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    http_req: HttpRequest,
    req: actix_web::web::Query<OperatyvkaDownloadReq>,
) -> Result<actix_web::HttpResponse, AppError> {
    crate::users::has_role(
        &env.dbx,
        &crate::users::identity_id(&user)?,
        "Bpla",
    )
    .await
    .c(h!())?;
    let kml = crate::kml::read_myplaces(env.mode)?;
    let style_maps = crate::kml::extract_style_maps(&kml.nodes.clone())?;
    let folders = crate::kml::extract_operatyvka_folders(&kml)?;
    for folder in folders.iter() {
        if folder.name.as_ref().map(|x| &x.body) == Some(&req.folder) {
            let tmp_dir = TempDir::new()?;
            let dst_file =
                folder_to_data_package_zip(&tmp_dir, folder, &style_maps)?;
            let file =
                actix_files::NamedFile::open_async(dst_file).await.c(h!())?;
            return Ok(file.into_response(&http_req));
        }
    }
    Ok(actix_web::HttpResponseBuilder::new(
        actix_web::http::StatusCode::NOT_FOUND,
    )
    .body("Folder not found"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_mission_package_manifest_simple() {
        let manifest = MissionPackageManifest {
            version: "2".to_string(),
            configuration: Configuration {
                parameters: vec![
                    Parameter {
                        name: "uid".to_string(),
                        value: "deadf00d".to_string(),
                    },
                    Parameter {
                        name: "name".to_string(),
                        value: "onehowitzer".to_string(),
                    },
                ],
            },
            contents: Contents {
                contents: vec![
                    Content {
                        ignore: "false".to_string(),
                        zip_entry: "5ad2a76e-13c3-4599-88cc-c13bc3b74945/5ad2a76e-13c3-4599-88cc-c13bc3b74945.cot".to_string(),
                        parameters: vec![
                            Parameter {
                                name: "uid".to_string(),
                                value: "5ad2a76e-13c3-4599-88cc-c13bc3b74945".to_string(),
                            },
                            Parameter {
                                name: "name".to_string(),
                                value: "Enemy One Self Propelled Howitzer".to_string(),
                            },
                        ],
                    }
                ],
            },
        };
        let xml = quick_xml::se::to_string(&manifest).unwrap();
        assert_eq!(
            xml,
            r###"<MissionPackageManifest version="2"><Configuration><Parameter name="uid" value="deadf00d"/><Parameter name="name" value="onehowitzer"/></Configuration><Contents><Content ignore="false" zipEntry="5ad2a76e-13c3-4599-88cc-c13bc3b74945/5ad2a76e-13c3-4599-88cc-c13bc3b74945.cot"><Parameter name="uid" value="5ad2a76e-13c3-4599-88cc-c13bc3b74945"/><Parameter name="name" value="Enemy One Self Propelled Howitzer"/></Content></Contents></MissionPackageManifest>"###,
        )
    }

    #[test]
    fn parse_cot_simple() {
        let point = Point {
            lat: "47.0973385".to_string(),
            lon: "33.4967971".to_string(),
            hae: "65.048".to_string(),
            ce: "9999999.0".to_string(),
            le: "9999999.0".to_string(),
        };
        let detail = Detail {
            status: Status {
                readiness: "true".to_string(),
            },
            archives: vec![],
            remarks: Remarks {
                body: "".to_string(),
            },
            link: Link {
                uid: "ANDROID-dfd24c71c682b03a".to_string(),
                production_time: "2022-10-29T13:39:51.411Z".to_string(),
                type_: "a-f-G-U-C".to_string(),
                parent_callsign: "ziggy".to_string(),
                relation: "p-p".to_string(),
            },
            color: Color {
                argb: "-1".to_string(),
            },
            precisionlocation: Precisionlocation {
                altsrc: "DTED0".to_string(),
            },
            usericon: Usericon {
                iconsetpath: "COT_MAPPING_2525C/a-h/a-h-G".to_string(),
            },
            contact: Contact {
                callsign: "Enemy One Self Propelled Howitzer".to_string(),
            },
        };
        let cot = Event {
            version: "2.0".to_string(),
            uid: "5ad2a76e-13c3-4599-88cc-c13bc3b74945".to_string(),
            type_: "a-h-G-E-W-H-H-S".to_string(),
            time: "2022-10-29T13:41:26.948Z".to_string(),
            start: "2022-10-29T13:41:26.948Z".to_string(),
            stale: "2023-10-29T13:41:26.948Z".to_string(),
            how: "h-g-i-g-o".to_string(),
            point,
            detail,
        };
        let cot_content = quick_xml::se::to_string(&cot).unwrap();
        assert_eq!(
            cot_content,
            r###"<event version="2.0" uid="5ad2a76e-13c3-4599-88cc-c13bc3b74945" type="a-h-G-E-W-H-H-S" time="2022-10-29T13:41:26.948Z" start="2022-10-29T13:41:26.948Z" stale="2023-10-29T13:41:26.948Z" how="h-g-i-g-o"><point lat="47.0973385" lon="33.4967971" hae="65.048" ce="9999999.0" le="9999999.0"/><detail><status readiness="true"/><remarks/><link uid="ANDROID-dfd24c71c682b03a" production_time="2022-10-29T13:39:51.411Z" type="a-f-G-U-C" parent_callsign="ziggy" relation="p-p"/><color argb="-1"/><precisionlocation altsrc="DTED0"/><usericon iconsetpath="COT_MAPPING_2525C/a-h/a-h-G"/><contact callsign="Enemy One Self Propelled Howitzer"/></detail></event>"###,
        )
    }
}
