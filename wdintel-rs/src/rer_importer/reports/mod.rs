use std::collections::BTreeMap;
use std::path::PathBuf;

use crate::config::CLEANUP_REPORT_DAYS;
use crate::entities::*;
use crate::error::AppError;
use crate::types::*;
use actix_identity::Identity;
use actix_web::web::Json;
use actix_web::{post, HttpRequest, HttpResponse};
use chrono::{Days, NaiveDateTime, Utc};
use futures_util::TryStreamExt;
use indicatif::ProgressBar;
use sea_orm::*;

pub mod babak;
mod digest;
pub mod interception;
pub mod mouse;
mod naushnom;
mod posts;
mod report_xlsx_kind_pelengs;
mod revo;
mod senders;
pub mod tag;
pub mod types;
mod util;

pub fn reports_storage_dir() -> PathBuf {
    std::env::temp_dir().join("reports_log")
}

pub(crate) async fn cleanup_old_reports_nofail(
    dbx: &DatabaseConnection,
    _config: &crate::Config,
) {
    if let Some(cleanup_until) = Utc::now()
        .naive_utc()
        .checked_sub_days(Days::new(CLEANUP_REPORT_DAYS))
    {
        match log_users_report_generation::Entity::find()
            .filter(
                log_users_report_generation::Column::CreatedAt
                    .lte(cleanup_until),
            )
            .filter(
                log_users_report_generation::Column::DeprecatedAt
                    .eq(None::<NaiveDateTime>),
            )
            .all(dbx)
            .await
        {
            Ok(logs) => {
                let storage_path = reports_storage_dir();
                for one_log in logs {
                    let filepath = PathBuf::from(&one_log.report_path);
                    if let Err(e) =
                        std::fs::remove_file(storage_path.join(&filepath))
                    {
                        warn!(
                            "Unable to delete file {filepath:?}: error {e:?}"
                        );
                    }
                    let mut log_active_model = one_log.into_active_model();
                    log_active_model.deprecated_at =
                        Set(Some(Utc::now().naive_utc()));
                    if let Err(e) = log_active_model.update(dbx).await {
                        warn!("Unable to update DB row, error {e:?}");
                    }
                }
            }
            Err(e) => {
                warn!("DB error in job that cleans up old reports: {e:?}")
            }
        }
    } else {
        warn!("Unable to get datetime in job that cleans up old reports");
    }
}

pub(crate) async fn save_report_log(
    dbx: &DatabaseConnection,
    filepath_relative_to_storage: String,
    report_query: &str,
    login: &str,
) -> Result<(), AppError> {
    let log_active_model = log_users_report_generation::ActiveModel {
        id: NotSet,
        login: Set(login.to_string()),
        report_query: Set(report_query.to_string()),
        report_path: Set(filepath_relative_to_storage),
        created_at: Set(Utc::now().naive_utc()),
        deprecated_at: Set(None),
    };
    log_active_model.insert(dbx).await.context(h!())?;
    Ok(())
}

/// Generates report in docx format using docx-rs library looking similar to html produced by the report_generate_html function
#[post("/api/rer/report-docx")]
pub async fn report_docx(
    user: Identity,
    env: actix_web::web::Data<Env>,
    http_req: HttpRequest,
    req: Json<types::ReportPreviewReq>,
) -> Result<HttpResponse, AppError> {
    info!("> Start RER report generation...");

    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
    cleanup_old_reports_nofail(&env.dbx, &env.config).await;
    let mut req = req.into_inner().clone();
    req.req.nolimit = Some(true);

    let outfolder = reports_storage_dir();
    let _ = std::fs::create_dir_all(&outfolder);
    let filename =
        format!("report_{}.docx", Utc::now().format("%Y-%m-%d-%H-%M-%S-%3f"));
    let outpath = outfolder.join(&filename);
    let user_login = user.id().context(h!())?;
    if req.kind == "tags" {
        self::tag::report_docx_kind_tag(user, &env, &req, &outpath)
            .await
            .c(h!())?;
    } else if req.kind == "interception" {
        self::interception::report_xlsx_kind_interception(
            user, &env, &req, &outpath,
        )
        .await
        .c(h!())?;
    } else if req.kind == "babak" {
        self::babak::report_docx_kind_babak(&user_login, &env, &req, &outpath)
            .await
            .c(h!())?;
    } else if req.kind == "mouse" {
        self::mouse::report_docx_kind_mouse(user, &env, &req, &outpath)
            .await
            .c(h!())?;
    } else if req.kind == "pelengs" {
        self::report_xlsx_kind_pelengs::report_xlsx_kind_pelengs1(
            user, &env, &req, &outpath,
        )
        .await
        .c(h!())?;
    } else if req.kind == "senders" {
        self::senders::report_xlsx_kind_senders(
            types::ReportAggregation::ByProfile,
            user,
            &env,
            &req.req,
            &outpath,
        )
        .await
        .c(h!())?;
    } else if req.kind == "posts" {
        self::senders::report_xlsx_kind_senders(
            types::ReportAggregation::ByPost,
            user,
            &env,
            &req.req,
            &outpath,
        )
        .await
        .c(h!())?;
    } else if req.kind == "naushnom" {
        self::naushnom::report_docx_kind_naushnom(user, &env, &req, &outpath)
            .await
            .c(h!())?;
    } else if req.kind == "reo" {
        crate::users::has_any_role(
            &env.dbx,
            &user.id().c(h!())?,
            vec!["UnitsEditor", "CallsignsEditor", "Admin"],
        )
        .await
        .c(h!())?;
        self::revo::report_docx_kind_revo(user, &env, &req, &outpath)
            .await
            .c(h!())?;
    } else if req.kind == "digest" {
        crate::users::has_any_role(
            &env.dbx,
            &user.id().c(h!())?,
            vec!["UnitsEditor", "CallsignsEditor", "Admin"],
        )
        .await
        .c(h!())?;
        self::digest::report_docx_kind_digest(user, &env, &req, &outpath)
            .await
            .c(h!())?;
    } else if req.kind == "posts_docx" {
        self::posts::report_docx_kind_posts(user, &env, &req, &outpath)
            .await
            .c(h!())?;
    } else {
        return Err(format!("Unknown report kind {}", req.kind).into());
    }
    let file = actix_files::NamedFile::open(&outpath)?;
    save_report_log(
        &env.dbx,
        format!("reports_log/{filename}"),
        &serde_json::to_string(&req).context(h!())?,
        &user_login,
    )
    .await
    .context(h!())?;
    Ok(file.into_response(&http_req))
}

/// Fills the comp_freq table with data about when the frequency was first seen.
pub async fn oneoff_fill_comp_freq(
    mode: Mode,
    ps: &crate::OneoffFillCompFreqPs,
) -> Result<(), AppError> {
    println!("> starting oneoff_fill_comp_freq");
    let start_dt: NaiveDateTime =
        NaiveDateTime::parse_from_str(&ps.start, "%Y-%m-%dT%H:%M:%S")
            .context(h!())?;
    let end_dt: NaiveDateTime =
        NaiveDateTime::parse_from_str(&ps.end, "%Y-%m-%dT%H:%M:%S")
            .context(h!())?;
    let dbx = crate::new_pg_pool_from_mode(mode).await.c(h!())?;
    fill_comp_freq(&dbx, start_dt, end_dt).await.c(h!())?;
    Ok(())
}

async fn fill_comp_freq(
    dbx: &DatabaseConnection,
    start: NaiveDateTime,
    end: NaiveDateTime,
) -> Result<(), AppError> {
    // iterate over all messages in a streaming fashion
    let filter = Condition::all()
        .add(signal_message::Column::Deleted.eq(false))
        .add(sigint_inbox_item::Column::Datetime.gte(start))
        .add(sigint_inbox_item::Column::Datetime.lt(end));

    let count = signal_message::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .filter(filter.clone())
        .clone()
        .count(dbx)
        .await
        .c(h!())?;
    let pb = ProgressBar::new(count);

    let mut stream = signal_message::Entity::find()
        .find_with_related(datasource_group::Entity)
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .filter(filter)
        .order_by_asc(signal_message::Column::Id)
        .stream(dbx)
        .await
        .c(h!())?;
    let datasource_zones = crate::sigint::zone::get_datasources_zones(dbx)
        .await
        .c(h!())?;
    let mut per_freq_seen: BTreeMap<(i64, String), NaiveDateTime> =
        BTreeMap::new();
    let mut per_freq_callsign_seen: BTreeMap<
        (i64, String, String),
        NaiveDateTime,
    > = BTreeMap::new();
    while let Some((message, group)) = stream
        .try_next()
        .await
        .c(h!())?
        .and_then(|(m, m_g)| m_g.map(|g| (m, g)))
    {
        pb.inc(1);
        let Some(inbox) = sigint_inbox_item::Entity::find_by_id(message.id)
            .one(dbx)
            .await
            .c(h!())?
        else {
            continue;
        };
        let Some(freq) = inbox.freq else {
            continue;
        };
        let Some(timestamp) = message.timestamp else {
            continue;
        };
        for zone_id in datasource_zones
            .get(&group.datasource_id)
            .into_iter()
            .flatten()
        {
            let key = (*zone_id, freq.clone());
            match per_freq_seen.get(&key) {
                Some(first_seen) => {
                    if timestamp < *first_seen {
                        per_freq_seen.insert(key.clone(), timestamp);
                    }
                }
                None => {
                    per_freq_seen.insert(key.clone(), timestamp);
                }
            }
            for callsign in serde_json::from_value::<Vec<String>>(
                inbox.callsigns.clone().unwrap_or(serde_json::Value::Null),
            )
            .context(h!())?
            {
                let key = (*zone_id, freq.clone(), callsign.clone());
                match per_freq_callsign_seen.get(&key) {
                    Some(first_seen) => {
                        if timestamp < *first_seen {
                            per_freq_callsign_seen
                                .insert(key.clone(), timestamp);
                        }
                    }
                    None => {
                        per_freq_callsign_seen.insert(key.clone(), timestamp);
                    }
                }
            }
        }
    }
    pb.finish();
    let pb = ProgressBar::new(per_freq_seen.len() as u64);
    for ((zone_id, freq), first_seen) in per_freq_seen {
        pb.inc(1);
        let do_insert = async || {
            comp_freq::ActiveModel {
                id: NotSet,
                zone_id: Set(zone_id),
                freq: Set(freq.clone()),
                first_seen: Set(Some(first_seen)),
                updated_at: NotSet,
            }
            .insert(dbx)
            .await
            .c(h!())?;
            Ok::<(), AppError>(())
        };
        let existing = comp_freq::Entity::find()
            .filter(comp_freq::Column::ZoneId.eq(zone_id))
            .filter(comp_freq::Column::Freq.eq(freq.clone()))
            .one(dbx)
            .await
            .c(h!())?;
        match existing {
            None => do_insert().await.c(h!())?,
            Some(existing) => match existing.first_seen {
                None => do_insert().await.c(h!())?,
                Some(existing_first_seen) => {
                    if existing_first_seen > first_seen {
                        let mut existing: comp_freq::ActiveModel =
                            existing.into();
                        existing.first_seen = Set(Some(first_seen));
                        existing.update(dbx).await.c(h!())?;
                    }
                }
            },
        }
    }
    pb.finish();
    let pb = ProgressBar::new(per_freq_callsign_seen.len() as u64);
    for ((zone_id, freq, callsign), first_seen) in per_freq_callsign_seen {
        pb.inc(1);
        let do_insert = async || {
            comp_freq_callsign::ActiveModel {
                id: NotSet,
                zone_id: Set(zone_id),
                freq: Set(freq.clone()),
                callsign: Set(callsign.clone().to_lowercase()),
                first_seen: Set(Some(first_seen)),
                updated_at: NotSet,
            }
            .insert(dbx)
            .await
            .c(h!())?;
            Ok::<(), AppError>(())
        };
        let existing = comp_freq_callsign::Entity::find()
            .filter(comp_freq_callsign::Column::ZoneId.eq(zone_id))
            .filter(comp_freq_callsign::Column::Freq.eq(freq.clone()))
            .filter(comp_freq_callsign::Column::Callsign.eq(callsign.clone()))
            .one(dbx)
            .await
            .c(h!())?;
        match existing {
            None => do_insert().await.c(h!())?,
            Some(existing) => match existing.first_seen {
                None => do_insert().await.c(h!())?,
                Some(existing_first_seen) => {
                    if existing_first_seen > first_seen {
                        let mut existing: comp_freq_callsign::ActiveModel =
                            existing.into();
                        existing.first_seen = Set(Some(first_seen));
                        existing.update(dbx).await.c(h!())?;
                    }
                }
            },
        }
    }
    pb.finish();
    Ok(())
}

/// Never-failing task that fills the comp_freq table every minute with fresh data.
pub async fn fill_comp_freq_worker(dbx: &DatabaseConnection) {
    loop {
        let _loop_guard =
            crate::utils::worker_watch::loop_guard("fill_comp_freq_worker");
        match fill_comp_freq_worker_1(dbx).await {
            Ok(_) => {}
            Err(e) => {
                println!("fill_comp_freq_worker error: {e:#?}");
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(10 * 60)).await;
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FillCompFreqWorkerState {
    pub processed_until: NaiveDateTime,
}

pub async fn fill_comp_freq_worker_1(
    dbx: &DatabaseConnection,
) -> Result<(), AppError> {
    let mut state: FillCompFreqWorkerState =
        crate::kv::get_kv(dbx, "fill_comp_freq_worker_state")
            .await
            .c(h!())?
            .unwrap_or(FillCompFreqWorkerState {
                processed_until: Utc::now().naive_utc()
                    - chrono::Duration::hours(24),
            });
    let start = state.processed_until;
    let end = Utc::now().naive_utc();
    fill_comp_freq(dbx, start, end).await.c(h!())?;
    state.processed_until = end;
    crate::kv::put_kv(dbx, "fill_comp_freq_worker_state", state)
        .await
        .c(h!())?;
    Ok(())
}
