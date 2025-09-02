use crate::config::Config;
use crate::delta::finish_bgtask;
use crate::kml::types::*;
use crate::messenger::id;
use crate::rer_importer::bgtask_log;
use crate::utils::*;
use crate::{entities::*, error::*, types::*};
use actix_multipart::Multipart;
use actix_web::{post, web::Json};
use chrono::prelude::*;
use lazy_static::lazy_static;
use regex::Regex;
use sea_orm::*;
use std::path::PathBuf;
use tempfile::TempDir;

#[post("/api/rer/delta-kmz-import")]
pub async fn rer_delta_kmz_import(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    mut payload: Multipart,
) -> Result<Json<i64>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    let (field, val) = multipart::extract(&mut payload).await?;
    let tmp_dir = TempDir::new()?;
    println!("> tmp_dir {}", &tmp_dir.path().display());
    let kmz_file = tmp_dir.path().join(field.name().context(h!())?);
    let original_path = kmz_file.clone();
    println!("> kmz_file: {}", &original_path.display());
    std::fs::write(&kmz_file, val)?;
    println!("> running unzip {}", &original_path.display());
    crate::zip::unzip(&kmz_file)?;
    println!("> unzip done");
    let mut doc_kml = tmp_dir.path().join("doc.kml");
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
    crate::utils::backup_tmp_dir(tmp_dir.path())?;

    let loglines: Vec<String> = vec![];
    let bgtask = bgtask::ActiveModel {
        id: NotSet,
        progress: Set(0),
        loglines: Set(serde_json::to_value(loglines).context(h!())?),
        running: Set(true),
        finished_with_error: Set(None),
    }
    .insert(&env.dbx)
    .await
    .c(h!())?;
    let bgtask_id = bgtask.id;

    let dbx2 = env.dbx.clone();
    let config2 = env.config.clone();
    let rq2 = env.rq.clone();
    let redis2 = env.redis.clone();
    let settlements2 = env.settlements.clone();
    let bgtask_id2 = Box::new(bgtask_id);
    let file_name = kmz_file.file_name().unwrap().to_string_lossy().to_string();
    tokio::spawn(async {
        let _tmp_dir = tmp_dir;
        let dbx3 = dbx2;
        let config3 = config2;
        let rq3 = rq2;
        let mut redis3 = redis2;
        let settlements3 = settlements2;
        // crazy hacks due to bug in nightly. remove asap
        // possibly https://github.com/rust-lang/rust/issues/119757
        let bgtask_id3 = bgtask_id2;
        let res = rer_delta_kmz_import_go(
            settlements3,
            &dbx3,
            &config3,
            &mut redis3,
            &rq3,
            file_name,
            doc_kml,
            Some(*bgtask_id3),
            original_path,
        )
        .await;

        let res2 = finish_bgtask(Some(*bgtask_id3), &dbx3, &res).await;
        res2
    });

    Ok(Json(bgtask_id))
}

#[derive(Debug)]
pub struct DeltaKmzFreqRec {
    pub time: NaiveDateTime,
    pub freq: String,
    pub lat: f64,
    pub lon: f64,
    pub comment: String,
}

pub async fn rer_delta_kmz_import_go(
    settlements: Arc<RwLock<crate::location::SettlementsData>>,
    dbx: &sea_orm::DatabaseConnection,
    config: &Config,
    redis: &mut redis::aio::ConnectionManager,
    rq: &reqwest::Client,
    file_name: String,
    doc_kml: std::path::PathBuf,
    bgtask_id: Option<i64>,
    original_path: PathBuf,
) -> Result<(), AppError> {
    bgtask_log(
        bgtask_id,
        &format!("> rer_delta_kmz_import_go starting; kmz_file: {file_name}",),
        dbx,
    )
    .await?;

    let filename = original_path
        .file_name()
        .and_then(|x| x.to_str())
        .unwrap_or("");
    let input: String = std::fs::read_to_string(doc_kml)?;

    let recs = parse_delta_kmz(&input, filename)?;
    bgtask_log(bgtask_id, &format!("> parsed {} records", recs.len()), dbx)
        .await?;

    let group_name = config.signal_import_group_name.clone();
    let group = signal_group::Entity::find()
        .filter(signal_group::Column::Deleted.eq(false))
        .filter(signal_group::Column::Name.eq(group_name))
        .order_by_desc(signal_group::Column::CreatedAt)
        .one(dbx)
        .await?;
    let Some(group) = group else {
        return Err(AppError::BL {
            msg: format!(
                "Signal group for import not found: {}; edit config.signal_admin_api_recepients",
                config.signal_import_group_name)
        });
    };
    let group_id = group.master_key;
    // choose datasource for this group based on datasource_group mapping
    let datasource_id = datasource_group::Entity::find()
        .filter(datasource_group::Column::GroupMasterKey.eq(group_id.clone()))
        .order_by_desc(datasource_group::Column::CreatedAt)
        .one(dbx)
        .await
        .map(|m| m.map(|dg| dg.datasource_id))
        .c(h!())?
        .unwrap_or(crate::config::SIGNAL_DATASOURCE_ID);

    let sender_name = config.signal_import_fiven_name.clone();
    let signal_profile = signal_profile::Entity::find()
        .filter(signal_profile::Column::GivenName.eq(sender_name))
        .order_by_desc(signal_profile::Column::CreatedAt)
        .one(dbx)
        .await?;
    let Some(signal_profile) = signal_profile else {
        return Err(AppError::BL {
            msg: format!(
                "Signal profile for import not found: {}; edit config.signal_admin_api_recepients",
                config.signal_import_fiven_name)
        });
    };
    let source_uuid = signal_profile.uuid;

    for rec in recs {
        bgtask_log(bgtask_id, &format!("> rec: {rec:?}"), dbx).await?;

        let timestamp = Utc::now().naive_utc();
        let body: String = format!(
            "{} F={}(МГц)\n\n{:.6} {:.6}\n\n{}",
            rec.time.format("%Y-%m-%dT%H:%M:%S"),
            rec.freq.replace(".", ","),
            rec.lat,
            rec.lon,
            rec.comment
        );

        // Normalize body
        let body = body.replace("\r\n", "\n");
        let master_key = group_id.to_string();

        let group_id = crate::messenger::group::ensure_group_id(
            dbx,
            master_key.to_string(),
            datasource_id,
        )
        .await
        .context(h!())?;

        let message = signal_message::ActiveModel {
            id: NotSet,
            body: Set(Some(body.clone())),
            created_at: NotSet,
            group_master_key: Set(Some(master_key)),
            timestamp: Set(Some(timestamp)),
            sender: Set(Some(source_uuid.to_string())),
            duplicate_of: NotSet,
            format: Set(Some(2)),
            datasource_id: Set(Some(datasource_id)),
            deleted: NotSet,
            external_id: NotSet,
            message_uid: NotSet,
            group_id: Set(Some(group_id)),
        }
        .insert(dbx)
        .await
        .context(h!())?;
        let db_message_id = message.id;

        id::update_message_with_uid(dbx, config, message)
            .await
            .context(h!())?;

        crate::rer_importer::bgworker::inbox_item_oneoff_nofail(
            settlements.clone(),
            dbx,
            rq,
            config,
            redis,
            db_message_id,
            None,
        )
        .await;
        crate::sigint::worker::incoming_message_after_insert(
            dbx,
            db_message_id,
        )
        .await?;
    }

    Ok(())
}

pub fn parse_delta_kmz(
    input: &str,
    filename: &str,
) -> Result<Vec<DeltaKmzFreqRec>, AppError> {
    lazy_static! {
        static ref RE: Regex = Regex::new(
            r#"^time: (?<time>\d{4}-\d{2}-\d{2}, \d{2}:\d{2}:\d{2})"#
        )
        .unwrap();
        static ref FILENAME_RE: Regex = Regex::new(
            r#"([^\p{Z}\p{C}_]+)_(\d{2})_(\d{2})_(\d{2,4})-(\d{2})_(\d{2})\.[a-zA-Z0-9]+"#
        )
        .unwrap();
    }
    println!("file name is '{filename}'");
    let fallback_datetime = extract_datetime(&filename, &FILENAME_RE);

    let placemarks = crate::kml::gather_all_placemarks(
        &quick_xml::de::from_str::<Kml>(input).context(h!())?.nodes,
    )?;

    let (parsed, skipped): (Vec<_>, Vec<_>) =
        placemarks.into_iter().partition(|pm| {
            pm.point.is_some()
                && pm.point.as_ref().unwrap().coordinates.is_some()
                && pm.name.is_some()
                && pm.description.is_some()
        });

    let res = parsed
        .clone()
        .into_iter()
        .filter_map(|pm| {
            let (lat, lon) = milgeo_rs::coordinates::parse_point_coordinates(
                &pm.point.unwrap().coordinates.unwrap(),
            )
                .ok()?;

            let description = pm.description.as_ref().unwrap();

            let time_str = match RE.captures(description) {
                None => None,
                Some(cap) => m_cap_s(&cap, "time")
            };

            if time_str.is_none() {
                warn!("missing time in description, potentially incorrect data occurred in KML")
            }

            let time = match time_str {
                Some(t) => NaiveDateTime::parse_from_str(
                    &t,
                    "%Y-%m-%d, %H:%M:%S",
                )
                    .ok()?,
                None => fallback_datetime.unwrap_or_else(|| Utc::now().naive_utc()),
            };

            Some(DeltaKmzFreqRec {
                freq: super::frequency::round_to_nearest_005(
                    super::frequency::etalon(&pm.name.unwrap()).to_string(),
                ),
                lat: lat.parse().ok()?,
                lon: lon.parse().ok()?,
                // comment: pm.description.clone().unwrap().to_string(),
                comment: description.to_string(),
                time,
            })
        })
        .collect::<Vec<_>>();

    println!(
        "> parse_delta_kmz: skipped: {}, parsed: {}",
        skipped.len(),
        parsed.len(),
    );

    Ok(res)
}

fn extract_datetime(filepath: &&str, regex: &Regex) -> Option<NaiveDateTime> {
    let captures = regex.captures(filepath)?;
    let _filename_prefix = captures.get(1).unwrap().as_str().to_string();
    let day = captures.get(2).unwrap().as_str().parse().ok();
    let month = captures.get(3).unwrap().as_str().parse().ok();
    let year_str = captures.get(4).unwrap().as_str();
    let hour = captures.get(5).unwrap().as_str().parse().ok();
    let minute = captures.get(6).unwrap().as_str().parse().ok();

    let year = if year_str.len() == 2 {
        let current_year = 2000; // Adjust this if needed
        let m_year = year_str.parse::<u32>().ok();
        m_year.map(|y| current_year / 100 * 100 + y)
    } else {
        year_str.parse().ok()
    };

    let (Some(year), Some(month), Some(day), Some(hour), Some(minute)) =
        (year, month, day, hour, minute)
    else {
        return None;
    };

    let date = NaiveDate::from_ymd_opt(year as i32, month, day);
    let time = NaiveTime::from_hms_opt(hour, minute, 0);
    if let (Some(date), Some(time)) = (date, time) {
        return Some(NaiveDateTime::new(date, time));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_delta_kmz_01() {
        let res = parse_delta_kmz(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
<name>name</name>
<Style id="icon-1899-FF5252-nodesc-normal">
<IconStyle>
<color>ff5252ff</color>
<Icon>
<href>https://www.gstatic.com/mapspro/images/stock/503-wht-blank_maps.png</href>
</Icon>
</IconStyle>
</Style>
<StyleMap id="redmap">
<Pair>
<key>normal</key>
<styleUrl>#icon-1899-FF5252-nodesc-normal</styleUrl>
</Pair>
</StyleMap>
<Folder>
<name>415.624</name>
<Placemark id="415.624">
<name>415.624</name>
<styleUrl>#redmap</styleUrl>
<description>time: 2024-03-31, 18:51:05
bandwidth: 9.375 Khz
duration: 3.915 sec
amplitude: -101.59 dBm
</description>
<Point>
<coordinates>35.9148310,47.3888626</coordinates>
</Point>
</Placemark>
<Placemark id="415.625">
<name>415.625</name>
<styleUrl>#redmap</styleUrl>
<description>Tis is a test description
bandwidth: 9.375 Khz
duration: 3.915 sec
amplitude: -101.59 dBm
</description>
<Point>
<coordinates>35.9148444,47.3888555</coordinates>
</Point>
</Placemark>
</Folder>
</Document>
</kml>"#,
            "Report_09_02_2025-15_19.kmz",
        )
        .unwrap();
        assert_eq!(res.len(), 2);
        let rec1 = &res[0];
        assert_eq!(rec1.freq, "415.6250".to_string());
        assert_eq!(rec1.lat, 47.3888626);
        assert_eq!(rec1.lon, 35.9148310);
        assert_eq!(
            rec1.time,
            NaiveDate::from_ymd_opt(2024, 3, 31)
                .unwrap()
                .and_hms_opt(18, 51, 5)
                .unwrap()
        );
        let rec2 = &res[1];
        assert_eq!(rec2.freq, "415.6250".to_string());
        assert_eq!(rec2.lat, 47.3888555);
        assert_eq!(rec2.lon, 35.9148444);
        assert_eq!(
            rec2.time,
            NaiveDate::from_ymd_opt(2025, 2, 9)
                .unwrap()
                .and_hms_opt(15, 19, 0)
                .unwrap()
        );
    }
}
