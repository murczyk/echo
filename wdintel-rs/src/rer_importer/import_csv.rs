use crate::config::{Config, IMPORT_DIRECTION_FINDING_UUID};
use crate::delta::finish_bgtask;
use crate::messenger::id;
use crate::rer_importer::bgtask_log;
use crate::utils::*;
use crate::{entities::*, error::*, types::*};
use actix_multipart::Multipart;
use actix_web::{post, web::Json};
use chrono::prelude::*;
use lazy_static::lazy_static;
use regex::Regex;
use sea_orm::ActiveValue::Set;
use sea_orm::*;
use tempfile::TempDir;

pub async fn oneoff_rer_csv_import_go(
    mode: Mode,
    dbx: &sea_orm::DatabaseConnection,
    redis: &mut redis::aio::ConnectionManager,
    ps: &crate::OneoffRerCsvImportPs,
    bgid: Option<i64>,
) -> Result<(), AppError> {
    let res = oneoff_rer_csv_import_1(mode, redis, ps, bgid).await;
    crate::delta::finish_bgtask(bgid, dbx, &res).await?;
    res
}

pub async fn oneoff_rer_csv_import_1(
    mode: Mode,
    redis: &mut redis::aio::ConnectionManager,
    ps: &crate::OneoffRerCsvImportPs,
    bgid: Option<i64>,
) -> Result<(), AppError> {
    let config = crate::config::read_config(mode)?;
    let dbx = crate::new_pg_pool_from_config(&config).await?;
    bgtask_log(
        bgid,
        &format!(
            "> rer_importer::oneoff_rer_importer_import starting; ps: {ps:?}"
        ),
        &dbx,
    )
    .await
    .context(h!())?;
    let settlements = Arc::new(RwLock::new(
        crate::location::load_from_file(
            config.settlement_paths().unwrap(),
            mode,
        )
        .unwrap(),
    ));
    let rq: reqwest::Client = reqwest::Client::builder()
        .timeout(core::time::Duration::from_secs(
            crate::config::RQ_TIMEOUT_SIGNAL_API,
        ))
        .build()?;

    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(false)
        .from_path(&ps.input)?;
    let mut bodies: Vec<String> = vec![];
    for e_rec in rdr.deserialize() {
        let rec: (String,) = e_rec?;
        let body = rec.0.trim().to_string();
        if !body.is_empty() {
            bodies.push(body);
        }
    }

    bgtask_log(bgid, &format!("> gathered bodies: {}", bodies.len()), &dbx)
        .await?;

    let group_name = config.signal_import_group_name.clone();
    let group = signal_group::Entity::find()
        .filter(signal_group::Column::Deleted.eq(false))
        .filter(signal_group::Column::Name.eq(group_name))
        .order_by_desc(signal_group::Column::CreatedAt)
        .one(&dbx)
        .await?;
    let Some(group) = group else {
        return Err(AppError::BL {
            msg: format!(
                "Signal group for import not found: {}; create in signal_group table",
                config.signal_import_group_name)
        });
    };
    let group_id = group.master_key;

    let sender_name = config.signal_import_fiven_name.clone();
    let signal_profile = signal_profile::Entity::find()
        .filter(signal_profile::Column::GivenName.eq(sender_name))
        .order_by_desc(signal_profile::Column::CreatedAt)
        .one(&dbx)
        .await?;
    let Some(signal_profile) = signal_profile else {
        return Err(AppError::BL {
            msg: format!(
                "Signal profile for import not found: {}; create in signal_profile table",
                config.signal_import_fiven_name)
        });
    };
    let source_uuid = signal_profile.uuid;

    // choose datasource for this group based on datasource_group mapping
    let datasource_id = datasource_group::Entity::find()
        .filter(datasource_group::Column::GroupMasterKey.eq(group_id.clone()))
        .order_by_desc(datasource_group::Column::CreatedAt)
        .one(&dbx)
        .await
        .map(|m| m.map(|dg| dg.datasource_id))
        .unwrap_or(None)
        .unwrap_or(crate::config::SIGNAL_DATASOURCE_ID);

    for body in bodies {
        // Normalize body
        let body = body.replace("\r\n", "\n");
        bgtask_log(bgid, &format!("> body: {body}"), &dbx).await?;

        let timestamp = Utc::now().naive_utc();

        let master_key = group_id.to_string();
        let datasource_group_id =
            crate::messenger::group::ensure_datasource_group_id(
                &dbx,
                master_key.to_string(),
                datasource_id,
            )
            .await
            .context(h!())?;

        let message = signal_message::ActiveModel {
            id: NotSet,
            body: Set(Some(body.clone())),
            created_at: NotSet,
            timestamp: Set(Some(timestamp)),
            sender: Set(Some(source_uuid.to_string())),
            duplicate_of: NotSet,
            format: Set(Some(2)),
            deleted: NotSet,
            external_id: NotSet,
            message_uid: NotSet,
            datasource_group_id: Set(Some(datasource_group_id)),
        }
        .insert(&dbx)
        .await
        .context(h!())?;
        let db_message_id = message.id;

        id::update_message_with_uid(&dbx, &config, message)
            .await
            .context(h!())?;

        crate::rer_importer::bgworker::inbox_item_oneoff_nofail(
            settlements.clone(),
            &dbx,
            &rq,
            &config,
            redis,
            db_message_id,
            None,
        )
        .await;
        crate::sigint::worker::incoming_message_after_insert(
            &dbx,
            db_message_id,
        )
        .await?;
    }
    Ok(())
}

pub async fn oneoff_rer_csv_import(
    mode: Mode,
    ps: &crate::OneoffRerCsvImportPs,
) -> Result<(), AppError> {
    let config = crate::config::read_config(mode).context(h!())?;
    let mut redis = crate::new_redis(&config).await.context(h!())?;
    oneoff_rer_csv_import_1(mode, &mut redis, ps, None).await
}

#[post("/api/rer/csv-import")]
pub async fn rer_csv_import(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    mut payload: Multipart,
) -> Result<Json<i64>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    let (field, val) = multipart::extract(&mut payload).await?;
    let tmp_dir = TempDir::new()?;
    println!("> tmp_dir {}", &tmp_dir.path().display());
    let csv_file = tmp_dir.path().join(field.name().context(h!())?);
    println!("> csv_file: {}", &csv_file.display());
    std::fs::write(&csv_file, val)?;
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
    .await?;
    let bgtask_id = bgtask.id;

    let dbx2 = env.dbx.clone();
    let redis2 = env.redis.clone();
    let mode = env.mode;
    let mode2 = Box::new(mode);
    let bgtask_id2 = Box::new(bgtask_id);
    tokio::spawn(async {
        let _tmp_dir = tmp_dir;
        let dbx3 = dbx2;
        let mut redis3 = redis2;
        let csv_file2 = csv_file;
        // crazy hacks due to bug in nightly. remove asap
        // possibly https://github.com/rust-lang/rust/issues/119757
        let mode3 = mode2;
        // crazy hacks due to bug in nightly. remove asap
        // possibly https://github.com/rust-lang/rust/issues/119757
        let bgtask_id3 = bgtask_id2;
        let res = oneoff_rer_csv_import_go(
            *mode3,
            &dbx3,
            &mut redis3,
            &crate::OneoffRerCsvImportPs {
                input: csv_file2.as_path().to_string_lossy().to_string(),
            },
            Some(*bgtask_id3),
        )
        .await;
        let res = finish_bgtask(Some(*bgtask_id3), &dbx3, &res).await;
        res
    });

    Ok(Json(bgtask_id))
}

/// Import CSV with coordinates as exported from Delta [issue](https://github.com/k-bx/echo/issues/7)
#[post("/api/rer/delta-csv-import")]
pub async fn rer_delta_csv_import(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    mut payload: Multipart,
) -> Result<Json<i64>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    let (field, val) = multipart::extract(&mut payload).await?;
    let tmp_dir = TempDir::new()?;
    println!("> tmp_dir {}", &tmp_dir.path().display());
    let csv_file = tmp_dir.path().join(field.name().context(h!())?);
    println!("> csv_file: {}", &csv_file.display());
    std::fs::write(&csv_file, val)?;
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
    .await?;
    let bgtask_id = bgtask.id;

    let dbx2 = env.dbx.clone();
    let config2 = env.config.clone();
    let rq2 = env.rq.clone();
    let redis2 = env.redis.clone();
    let settlements2 = env.settlements.clone();
    let bgtask_id2 = Box::new(bgtask_id);
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
        let res = rer_delta_csv_import_go(
            settlements3,
            &dbx3,
            &config3,
            &mut redis3,
            &rq3,
            csv_file,
            Some(*bgtask_id3),
        )
        .await;

        let res2 = finish_bgtask(Some(*bgtask_id3), &dbx3, &res).await;
        res2
    });

    Ok(Json(bgtask_id))
}

/// Record extracted from Delta's CSV with additional freq extraction
#[derive(Debug)]
pub struct DeltaCsvFreqRec {
    pub freq: String,
    pub lat: f64,
    pub lon: f64,
    pub time: NaiveDateTime,
    pub comment: String,
}

pub async fn rer_delta_csv_import_go(
    settlements: Arc<RwLock<crate::location::SettlementsData>>,
    dbx: &sea_orm::DatabaseConnection,
    config: &Config,
    redis: &mut redis::aio::ConnectionManager,
    rq: &reqwest::Client,
    csv_file: std::path::PathBuf,
    bgtask_id: Option<i64>,
) -> Result<(), AppError> {
    bgtask_log(
        bgtask_id,
        &format!(
            "> rer_delta_csv_import_go starting; csv_file: {}",
            csv_file.display()
        ),
        dbx,
    )
    .await?;

    let recs = parse_delta_csv(csv_file)?;
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
        .unwrap_or(None)
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
        let datasource_group_id =
            crate::messenger::group::ensure_datasource_group_id(
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
            timestamp: Set(Some(timestamp)),
            sender: Set(Some(source_uuid.to_string())),
            duplicate_of: NotSet,
            format: Set(Some(2)),
            deleted: NotSet,
            external_id: NotSet,
            message_uid: NotSet,
            datasource_group_id: Set(Some(datasource_group_id)),
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

pub fn parse_delta_csv(
    csv_file: std::path::PathBuf,
) -> Result<Vec<DeltaCsvFreqRec>, AppError> {
    let mut errors: Vec<AppError> = vec![];
    match parse_delta_csv_method1(csv_file.clone()) {
        Ok(res) => return Ok(res),
        Err(e) => errors.push(e),
    };
    match parse_delta_csv_method2(csv_file.clone()) {
        Ok(res) => return Ok(res),
        Err(e) => errors.push(e),
    };
    match parse_delta_csv_method3(csv_file.clone()) {
        Ok(res) => return Ok(res),
        Err(e) => errors.push(e),
    };
    Err(AppError::BL {
        msg: format!(
            "Failed to parse Delta CSV file: {}; errors: {:?}",
            csv_file.display(),
            errors
        ),
    })
}

pub fn parse_delta_csv_method1(
    csv_file: std::path::PathBuf,
) -> Result<Vec<DeltaCsvFreqRec>, AppError> {
    #[derive(Debug, serde::Deserialize)]
    struct Rec {
        r#type: String,
        name: String,
        time: String,
        y: f64,
        x: f64,
        comment: String,
    }

    let mut rdr = csv::Reader::from_path(&csv_file)?;
    let mut res: Vec<DeltaCsvFreqRec> = vec![];
    for e_rec in rdr.deserialize() {
        let rec: Rec = e_rec?;
        if rec.r#type != "10061500002001000000" {
            println!("Only type 10061500002001000000 (Antennae) is supported. Skpiing record: {rec:?}");
            continue;
        }
        let Some(freq) =
            crate::rer_importer::frequency::extract_freq(&rec.name)?
        else {
            continue;
        };
        let rec: DeltaCsvFreqRec = DeltaCsvFreqRec {
            freq: crate::rer_importer::frequency::round_to_nearest_005(freq),
            lat: rec.y,
            lon: rec.x,
            time: NaiveDateTime::parse_from_str(
                &rec.time,
                "%Y-%m-%dT%H:%M:%S",
            )?,
            comment: rec.comment,
        };
        res.push(rec);
    }
    Ok(res)
}

pub fn parse_delta_csv_method2(
    csv_file: std::path::PathBuf,
) -> Result<Vec<DeltaCsvFreqRec>, AppError> {
    #[derive(Debug, serde::Deserialize)]
    struct Rec {
        sidc: String,
        name: String,
        observation_datetime: String,
        coordinates: String,
    }

    let mut rdr = csv::Reader::from_path(&csv_file)?;
    let mut res: Vec<DeltaCsvFreqRec> = vec![];
    for e_rec in rdr.deserialize() {
        let rec: Rec = e_rec?;
        if rec.sidc != "10061500002001000000" {
            println!("Only type 10061500002001000000 (Antennae) is supported. Skpiing record: {rec:?}");
            continue;
        }
        let Some(freq) =
            crate::rer_importer::frequency::extract_freq(&rec.name)?
        else {
            continue;
        };
        lazy_static! {
            static ref RE: Regex =
                Regex::new(r"POINT \((?P<lng>\d\d\.\d\d\d\d?\d?\d?\d?\d?)\s+(?P<lat>\d\d\.\d\d\d\d?\d?\d?\d?\d?)\)")
                    .unwrap();
        }
        let Some(capts) = RE.captures(&rec.coordinates) else {
            continue;
        };
        let Some(lat) = m_cap_s(&capts, "lat") else {
            continue;
        };
        let lat: f64 = lat.parse().context(h!())?;
        let Some(lng) = m_cap_s(&capts, "lng") else {
            continue;
        };
        let lng: f64 = lng.parse().context(h!())?;
        let rec: DeltaCsvFreqRec = DeltaCsvFreqRec {
            freq: crate::rer_importer::frequency::round_to_nearest_005(freq),
            lat,
            lon: lng,
            time: NaiveDateTime::parse_from_str(
                &rec.observation_datetime,
                "%Y-%m-%dT%H:%M:%S",
            )?,
            comment: "".to_string(),
        };
        res.push(rec);
    }
    Ok(res)
}

pub fn parse_delta_csv_method3(
    csv_file: std::path::PathBuf,
) -> Result<Vec<DeltaCsvFreqRec>, AppError> {
    #[derive(Debug, serde::Deserialize)]
    struct Rec {
        #[serde(rename = "app6d sidc")]
        sidc: String,
        name: String,
        #[serde(rename = "observation date/time")]
        observation_datetime: String,
        #[serde(rename = "coordinates(wgs,yx)")]
        coordinates: String,
        comments: String,
    }

    let mut rdr = csv::Reader::from_path(&csv_file)?;
    let mut res: Vec<DeltaCsvFreqRec> = vec![];
    for e_rec in rdr.deserialize() {
        let rec: Rec = e_rec?;
        println!("rec: {rec:?}");
        if rec.sidc != "10061500002001000000" {
            println!("Only type 10061500002001000000 (Antennae) is supported. Skpiing record: {rec:?}");
            continue;
        }
        let Some(freq) =
            crate::rer_importer::frequency::extract_freq(&rec.name)?
        else {
            continue;
        };
        lazy_static! {
            static ref RE: Regex =
                Regex::new(r"(?P<lat>\d\d\.\d\d\d\d?\d?\d?\d?\d?),\s+(?P<lng>\d\d\.\d\d\d\d?\d?\d?\d?\d?)")
                    .unwrap();
        }
        let Some(capts) = RE.captures(&rec.coordinates) else {
            continue;
        };
        let Some(lat) = m_cap_s(&capts, "lat") else {
            continue;
        };
        let lat: f64 = lat.parse().context(h!())?;
        let Some(lng) = m_cap_s(&capts, "lng") else {
            continue;
        };
        let lng: f64 = lng.parse().context(h!())?;
        println!("lat: {lat}, lng: {lng}");
        let rec: DeltaCsvFreqRec = DeltaCsvFreqRec {
            freq: super::frequency::round_to_nearest_005(freq),
            lat,
            lon: lng,
            time: crate::rer_importer::datetime::parse_delta_csv_dt(
                &rec.observation_datetime,
            )?,
            comment: rec.comments,
        };
        res.push(rec);
    }
    Ok(res)
}

pub async fn ensure_import_group_exists(
    dbx: &sea_orm::DatabaseConnection,
    config: &Config,
) -> Result<(), AppError> {
    let datasource = datasource::Entity::find()
        .filter(datasource::Column::Id.eq(1_i64))
        .one(dbx)
        .await
        .context(h!())?;
    let datasource_id = match datasource {
        Some(datasource) => datasource.id,
        None => {
            log::warn!("No datasource found -- creating a default one!");
            datasource::ActiveModel {
                id: Set(1),
                kind: Set("signal".to_string()),
                display_name: Set("signal_phone".to_string()),
                signal_phone: Set(Some("+3800000000".to_string())),
                signal_docker_port: Set(Some("8083".to_string())),
                enabled: Set(Some(true)),
                ..Default::default()
            }
            .insert(dbx)
            .await
            .context(h!())?
            .id
        }
    };

    let group_name = config.signal_import_group_name.clone();
    let group = signal_group::Entity::find()
        .filter(signal_group::Column::Deleted.eq(false))
        .filter(signal_group::Column::Name.eq(group_name.clone()))
        .order_by_desc(signal_group::Column::CreatedAt)
        .one(dbx)
        .await
        .context(h!())?;
    let master_key = match group {
        Some(group) => group.master_key,
        None => {
            log::warn!("No signal_group found -- creating a default one!");
            let group = signal_group::ActiveModel {
                master_key: Set(Uuid::new_v4().to_string()),
                name: Set(Some(group_name.clone())),
                ..Default::default()
            };

            let inserted = crate::messenger::group::add_group(group, dbx)
                .await
                .context(h!())?;
            // ensure datasource_group mapping
            let _ = datasource_group::ActiveModel {
                id: NotSet,
                group_master_key: Set(inserted.master_key.clone()),
                datasource_id: Set(datasource_id),
                last_sync_at: NotSet,
                created_at: NotSet,
                name: Set(group_name.clone()),
                deleted: NotSet,
            }
            .insert(dbx)
            .await
            .c(h!())?;
            inserted.master_key
        }
    };

    let sender_name = config.signal_import_fiven_name.clone();
    let signal_profile = signal_profile::Entity::find()
        .filter(signal_profile::Column::GivenName.eq(sender_name.clone()))
        .order_by_desc(signal_profile::Column::CreatedAt)
        .one(dbx)
        .await
        .context(h!())?;
    let _signal_profile = match signal_profile {
        Some(signal_profile) => signal_profile,
        None => {
            log::warn!("No signal_profile found -- creating a default one!");
            signal_profile::ActiveModel {
                uuid: Set(uuid::Uuid::new_v4().to_string()),
                given_name: Set(Some(sender_name)),
                ..Default::default()
            }
            .insert(dbx)
            .await
            .context(h!())?
        }
    };
    let sigint_zone_datasource = sigint_zone_datasource::Entity::find()
        .filter(sigint_zone_datasource::Column::DatasourceId.eq(datasource_id))
        .order_by_desc(sigint_zone_datasource::Column::CreatedAt)
        .one(dbx)
        .await
        .context(h!())?;
    let _sigint_zone_datasource = match sigint_zone_datasource {
        Some(sigint_zone_datasource) => sigint_zone_datasource,
        None => {
            log::warn!(
                "No sigint_zone_datasource found -- creating a default one!"
            );
            sigint_zone_datasource::ActiveModel {
                sigint_zone_id: Set(1),
                datasource_id: Set(datasource_id),
                group_master_key: Set(master_key),
                ..Default::default()
            }
            .insert(dbx)
            .await
            .context(h!())?
        }
    };

    let group = signal_group::Entity::find_by_id(IMPORT_DIRECTION_FINDING_UUID)
        .one(dbx)
        .await
        .context(h!())?;
    let _master_key = match group {
        Some(group) => group.master_key,
        None => {
            log::warn!("No signal_group found for direction finding imports -- creating a default one!");
            let group = signal_group::ActiveModel {
                master_key: Set(IMPORT_DIRECTION_FINDING_UUID.to_string()),
                name: Set(Some("Імпорт Пеленгів".to_string())),
                ignore_operativny: Set(true),
                ..Default::default()
            };
            let inserted = crate::messenger::group::add_group(group, dbx)
                .await
                .context(h!())?;
            let _ = datasource_group::ActiveModel {
                id: NotSet,
                group_master_key: Set(inserted.master_key.clone()),
                datasource_id: Set(datasource_id),
                last_sync_at: NotSet,
                created_at: NotSet,
                name: Set(group_name),
                deleted: NotSet,
            }
            .insert(dbx)
            .await
            .ok();
            inserted.master_key
        }
    };

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn parse_delta_csv_01() {
        let res = parse_delta_csv(PathBuf::from("data/parse_delta_csv_01.csv"))
            .unwrap();
        assert_eq!(res.len(), 1);
        assert_eq!(res[0].freq, "139.3350".to_string());
        assert_eq!(res[0].lat, 47.3605);
        assert_eq!(res[0].lon, 36.05332);
        assert_eq!(
            res[0].time,
            NaiveDate::from_ymd_opt(2023, 11, 6)
                .unwrap()
                .and_hms_opt(5, 14, 54)
                .unwrap()
        );
        assert_eq!(
            res[0].comment,
            "НВ(Викликаючий) УКХ НВ 139.3375 (33_ombr_T01)".to_string()
        );
    }

    #[test]
    fn parse_delta_csv_02() {
        let res = parse_delta_csv(PathBuf::from("data/parse_delta_csv_02.csv"))
            .unwrap();
        assert_eq!(res.len(), 1);
        assert_eq!(res[0].freq, "139.3350".to_string());
        assert_eq!(res[0].lat, 46.2054276);
        assert_eq!(res[0].lon, 33.2139756);
        assert_eq!(
            res[0].time,
            NaiveDate::from_ymd_opt(2023, 12, 11)
                .unwrap()
                .and_hms_opt(19, 53, 00)
                .unwrap()
        );
    }

    #[test]
    fn parse_delta_csv_03() {
        let res = parse_delta_csv(PathBuf::from("data/parse_delta_csv_03.csv"))
            .unwrap();
        assert_eq!(res.len(), 1);
        assert_eq!(res[0].freq, "139.3350".to_string());
        assert_eq!(res[0].lat, 46.2054276);
        assert_eq!(res[0].lon, 33.2139756);
        assert_eq!(
            res[0].time,
            NaiveDate::from_ymd_opt(2023, 12, 11)
                .unwrap()
                .and_hms_opt(19, 46, 00)
                .unwrap()
        );
    }
}
