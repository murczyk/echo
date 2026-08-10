use crate::config::{
    get_tz, ONEOFF_ETALONKA_REPORT_OUTPUT_DIR, TAG_SUGGEST_WORKER_BATCH_SIZE,
};
use crate::entities::{
    area_of_responsibility, sigint_inbox_item, sigint_inbox_item_tag,
};
use crate::error::AppError;
use crate::types::{info, warn};
use crate::types::{Mode, ShortContext};
use crate::utils::parse_local_datetime;
use crate::{h, OneoffSuggestInboxMessageTagsPs};
use chrono::{Duration, NaiveDate, NaiveDateTime, Utc};
use csv::Writer;
use indicatif::{MultiProgress, ProgressBar, ProgressStyle};
use sea_orm::prelude::*;
use sea_orm::*;
use std::collections::{BTreeMap, BTreeSet, HashSet};

pub async fn oneoff_fill_sigint_inbox_item_tags(
    mode: Mode,
) -> Result<(), AppError> {
    info!("starting oneoff_fill_sigint_inbox_item_tags...");
    let config = crate::config::read_config(mode)?;
    let db = crate::new_pg_pool_from_config(&config).await?;

    db.execute_unprepared(
        r#"
            insert into sigint_inbox_item_tag (
                sigint_inbox_item_id,
                tag_id
            )
            select distinct
                x.sigint_inbox_item_id,
                x.tag_id::bigint
            from (
                select
                    id as sigint_inbox_item_id,
                    jsonb_array_elements(tags) as tag_id
                from
                    sigint_inbox_item i
                where
                    i.tags is not null
                    and not exists (
                        select 1 from sigint_inbox_item_tag it
                        where it.sigint_inbox_item_id = i.id
                    )
            ) as x;
    "#,
    )
    .await
    .c(h!())?;
    info!("done oneoff_fill_sigint_inbox_item_tags");
    Ok(())
}

pub async fn oneoff_backfill_inbox_unit_links(
    mode: Mode,
    ps: &crate::OneoffBackfillInboxUnitLinksPs,
) -> Result<(), AppError> {
    let db = crate::new_pg_pool_from_mode(mode).await.c(h!())?;
    let now = Utc::now().naive_utc();
    let start_ts = parse_optional_utc_ts(ps.start_ts.as_deref())
        .c(h!())?
        .unwrap_or(now - Duration::days(30));
    let till_ts = parse_optional_utc_ts(ps.till_ts.as_deref())
        .c(h!())?
        .unwrap_or(now - Duration::hours(1));
    let processed = crate::inbox::unit_resolution::backfill_inbox_unit_links(
        &db, start_ts, till_ts,
    )
    .await
    .c(h!())?;
    info!("backfilled {processed} inbox unit links in [{start_ts}, {till_ts})");
    Ok(())
}

fn parse_optional_utc_ts(
    value: Option<&str>,
) -> Result<Option<NaiveDateTime>, AppError> {
    value
        .map(|value| {
            NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S").map_err(
                |error| AppError::BL {
                    msg: format!("Invalid UTC timestamp {value:?}: {error}"),
                },
            )
        })
        .transpose()
}

pub async fn oneoff_suggest_inbox_message_tags(
    mode: Mode,
    ps: &OneoffSuggestInboxMessageTagsPs,
) -> Result<(), AppError> {
    info!("starting oneoff_suggest_inbox_message_tags...");
    let env = crate::server::new_env(mode).await.c(h!())?;

    let dbx = env.dbx.clone();
    let start = parse_local_datetime(&ps.start).c(h!())?;
    let end = parse_local_datetime(&ps.end).c(h!())?;

    let q = sigint_inbox_item_tag::Entity::find()
        .filter(
            Expr::col((
                sigint_inbox_item_tag::Entity,
                sigint_inbox_item_tag::Column::SigintInboxItemId,
            ))
            .equals((sigint_inbox_item::Entity, sigint_inbox_item::Column::Id)),
        )
        .filter(sigint_inbox_item_tag::Column::Model.is_not_null())
        .select_only();
    let exists = Expr::exists(q.expr(Expr::value(1)).into_query());

    let message_ids: Vec<i64> = sigint_inbox_item::Entity::find()
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintInboxItemTag.def(),
        )
        .select_only()
        .filter(sigint_inbox_item::Column::BodyNoheader.is_not_null())
        .filter(sigint_inbox_item::Column::Datetime.gte(start))
        .filter(sigint_inbox_item::Column::Datetime.lte(end))
        .filter(exists.not())
        .column(sigint_inbox_item::Column::Id)
        .into_tuple::<i64>()
        .all(&dbx)
        .await
        .c(h!())?;

    let total_len = message_ids.len();
    info!(
        "oneoff_suggest_inbox_message_tags, about to process {total_len} messages"
    );
    let mut processed = 0;
    let mut suggested = 0;
    let batch_size = ps
        .batch_size
        .filter(|sz| *sz > 0)
        .unwrap_or(TAG_SUGGEST_WORKER_BATCH_SIZE);
    for chunk in message_ids.chunks(batch_size) {
        let txn: DatabaseTransaction = dbx.begin().await.c(h!())?;

        let result = crate::tags::worker::process_messages(
            chunk.to_vec(),
            &env.rq,
            &txn,
            &env.tag_keyword_regex_cache,
        )
        .await
        .c(h!())?;

        processed += chunk.len();
        suggested += result.inserted_count;

        info!(
            "oneoff_suggest_inbox_message_tags, {suggested} tags suggested for {processed}/{total_len} messages"
        );

        txn.commit().await.c(h!())?;
    }

    if suggested == 0 {
        warn!(
            "no tags suggested for {processed} messages, did you forget to set up tag keywords or run `just ai-sync-from-cloud`?"
        )
    } else {
        info!(
            "done oneoff_suggest_inbox_message_tags, total {suggested} tags suggested for {processed} messages"
        );
    }

    Ok(())
}

pub async fn oneoff_tag_messages_report(
    mode: Mode,
    ps: &crate::OneoffTagMessagesReportPs,
) -> Result<(), AppError> {
    info!("starting oneoff_tag_messages_report...");
    let db = crate::new_pg_pool_from_mode(mode).await.c(h!())?;
    let start_date = parse_local_date(&ps.start).c(h!())?;
    let end_date = parse_local_date(&ps.end).c(h!())?;
    if end_date < start_date {
        return Err(AppError::BL {
            msg: format!(
                "end date {} must be on or after start date {}",
                ps.end, ps.start
            ),
        });
    }

    let end_date_exclusive = next_date(end_date).c(h!())?;
    let start_utc = local_midnight_to_utc(start_date).c(h!())?;
    let end_utc = local_midnight_to_utc(end_date_exclusive).c(h!())?;

    let tz = get_tz().to_string();
    let total_counts =
        load_total_message_counts(&db, start_utc, end_utc, &tz).await?;
    let tag_counts =
        load_tagged_message_counts(&db, start_utc, end_utc, &tz).await?;

    let days = collect_days(start_date, end_date).c(h!())?;
    write_report_csv(&ps.output, &days, &total_counts, &tag_counts).c(h!())?;
    info!("done oneoff_tag_messages_report");
    Ok(())
}

pub async fn oneoff_etalonka_report_networks_from_rer_analysis(
    mode: Mode,
    ps: &crate::OneoffEtalonkaReportNetworksFromRerAnalysisPs,
) -> Result<(), AppError> {
    info!("starting oneoff_etalonka_report_networks_from_rer_analysis...");
    let db = crate::new_pg_pool_from_mode(mode).await.c(h!())?;
    let login_id = crate::users::login_id_by_name(&db, &ps.login).await?;

    let (start_date, end_date, start_ms, end_ms) =
        parse_date_range_to_millis(&ps.start, &ps.end).c(h!())?;

    let multi = MultiProgress::new();
    let pb = multi.add(ProgressBar::new(4));
    pb.set_style(oneoff_progress_style());
    pb.set_message("resolving aors");
    let selected_aors = resolve_aor_ids(&db, &ps.only_aor).await?;
    pb.inc(1);

    pb.set_message("resolving groups");
    let groups =
        crate::messenger::group::get_identity_sigint_groups(&db, &login_id)
            .await
            .c(h!())?;
    pb.inc(1);

    pb.set_message("selecting networks");
    let analysis_req =
        build_analysis_stats_req(start_ms, end_ms, selected_aors);
    let networks =
        crate::rer_importer::analysis::stats::fetch_networks_for_login(
            &analysis_req,
            &login_id,
            &db,
            groups.clone(),
        )
        .await
        .c(h!())?;
    let network_ids = collect_network_ids(&networks);
    if network_ids.is_empty() {
        return Err(AppError::BL {
            msg: "no networks matched for the provided filters".to_string(),
        });
    }
    pb.inc(1);

    pb.set_message("building report");
    let report_req = build_etalonka_report_request(network_ids);
    let networks_data =
        crate::sigint::etalonka::query::load_networks_by_id(&db, &report_req)
            .await
            .c(h!())?;
    let trace_id = uuid::Uuid::new_v4();
    let etalonka_progress = crate::sigint::etalonka::EtalonkaProgress::new(
        &multi,
        networks_data.len(),
    );
    let etalonka_data =
        crate::sigint::etalonka::collect_etalonka_data_with_progress(
            &db,
            &login_id,
            groups,
            networks_data,
            &report_req.etalonka_type,
            trace_id,
            Some(&etalonka_progress),
        )
        .await
        .c(h!())?;

    std::fs::create_dir_all(ONEOFF_ETALONKA_REPORT_OUTPUT_DIR).c(h!())?;
    let outpath = build_etalonka_output_path(start_date, end_date);
    crate::sigint::etalonka::generate_networks_docx_report_to_path(
        &outpath,
        &report_req.etalonka_type,
        etalonka_data,
    )
    .await
    .c(h!())?;

    pb.inc(1);
    pb.finish_with_message(format!("saved {}", outpath.display()));
    println!("> report saved to {}", outpath.display());
    Ok(())
}

fn oneoff_progress_style() -> ProgressStyle {
    ProgressStyle::with_template(
        "{msg} [{elapsed_precise}] {bar:40.cyan/blue} {pos}/{len} ({percent}%) ETA {eta}",
    )
    .expect("progress style template")
    .progress_chars("=>-")
}

fn parse_local_date(val: &str) -> Result<NaiveDate, AppError> {
    Ok(NaiveDate::parse_from_str(val, "%Y-%m-%d").c(h!())?)
}

fn parse_date_range_to_millis(
    start: &str,
    end: &str,
) -> Result<(NaiveDate, NaiveDate, i64, i64), AppError> {
    let start_date = parse_local_date(start).c(h!())?;
    let end_date = parse_local_date(end).c(h!())?;
    if end_date <= start_date {
        return Err(AppError::BL {
            msg: format!(
                "end date {} must be after start date {} (non-inclusive)",
                end, start
            ),
        });
    }

    let start_utc = local_midnight_to_utc(start_date).c(h!())?;
    let end_utc = local_midnight_to_utc(end_date).c(h!())?;
    let start_ms = start_utc.and_utc().timestamp_millis();
    let end_ms = end_utc.and_utc().timestamp_millis();
    Ok((start_date, end_date, start_ms, end_ms))
}

async fn resolve_aor_ids(
    db: &DatabaseConnection,
    only_aor: &[String],
) -> Result<Option<Vec<i64>>, AppError> {
    if only_aor.is_empty() {
        return Ok(None);
    }

    let unique_names: BTreeSet<String> = only_aor.iter().cloned().collect();

    let aors = area_of_responsibility::Entity::find()
        .filter(area_of_responsibility::Column::Deleted.eq(false))
        .filter(
            area_of_responsibility::Column::Name
                .is_in(unique_names.iter().cloned()),
        )
        .all(db)
        .await
        .c(h!())?;

    let found_names: HashSet<String> =
        aors.iter().map(|a| a.name.clone()).collect();
    let missing: Vec<String> = unique_names
        .iter()
        .filter(|name| !found_names.contains(*name))
        .cloned()
        .collect();
    if !missing.is_empty() {
        return Err(AppError::BL {
            msg: format!("unknown aor names: {}", missing.join(", ")),
        });
    }

    let ids: Vec<i64> = aors
        .into_iter()
        .map(|aor| aor.id)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    Ok(Some(ids))
}

fn build_analysis_stats_req(
    start_ms: i64,
    end_ms: i64,
    selected_aors: Option<Vec<i64>>,
) -> crate::rer_importer::types::AnalysisStatsReq {
    crate::rer_importer::types::AnalysisStatsReq {
        since_date_inclusive_ms: start_ms,
        till_date_noninclusive_ms: end_ms,
        selected_groups: None,
        selected_senders: None,
        selected_freqs: None,
        selected_posts: None,
        selected_callsigns: None,
        selected_units: None,
        selected_locations: None,
        selected_device_names: None,
        selected_aors,
        or_with_extended_form: None,
        or_bookmarked: None,
        or_important: None,
        or_with_coords: None,
        or_without_coords: None,
        search: None,
        selected_tags: None,
        denied_tags: None,
        tag_presence: None,
        selected_networks: None,
        without_network: None,
        metadata_cc: None,
        metadata_sender: None,
        metadata_receiver: None,
        metadata_hash: None,
        only_with_metadata: None,
        without_metadata: None,
        include_peleng_locations: None,
        units_exact_match_only: None,
        filter_tags_option: None,
        without_model_tags: None,
        report_tags_only_this_unit: None,
    }
}

fn collect_network_ids(
    networks: &[crate::rer_importer::types::AnalysisStatsNetwork],
) -> Vec<i64> {
    networks
        .iter()
        .map(|network| network.network_id)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn build_etalonka_report_request(
    network_ids: Vec<i64>,
) -> crate::sigint::etalonka::types::EtalonkaNetworkBatchReq {
    crate::sigint::etalonka::types::EtalonkaNetworkBatchReq {
        network_ids,
        sort_by: None,
        etalonka_type:
            crate::sigint::etalonka::types::EtalonkaReportType::AccordingToTheForm(
                crate::sigint::etalonka::types::EtalonkaSettings {
                    active_freqs_only: true,
                    include_callsign_full_names: false,
                    include_sigint_signs: false,
                    include_confirmation: false,
                    include_headings_and_freqs: false,
                },
            ),
    }
}

fn build_etalonka_output_path(
    start_date: NaiveDate,
    end_date: NaiveDate,
) -> std::path::PathBuf {
    let timestamp = Utc::now().format("%Y-%m-%d-%H-%M-%S-%3f");
    let filename = format!(
        "etalonka_report_{}_to_{}_{}.docx",
        start_date.format("%Y-%m-%d"),
        end_date.format("%Y-%m-%d"),
        timestamp
    );
    std::path::PathBuf::from(ONEOFF_ETALONKA_REPORT_OUTPUT_DIR).join(filename)
}

fn next_date(date: NaiveDate) -> Result<NaiveDate, AppError> {
    date.checked_add_signed(Duration::days(1))
        .ok_or(AppError::BL {
            msg: format!("date overflow while adding a day to {date}"),
        })
}

fn local_midnight_to_utc(date: NaiveDate) -> Result<NaiveDateTime, AppError> {
    let local_midnight = date.and_hms_opt(0, 0, 0).ok_or(AppError::BL {
        msg: format!("invalid local midnight for date {date}"),
    })?;
    let zoned = local_midnight.and_local_timezone(get_tz()).single().ok_or(
        AppError::BL {
            msg: format!("ambiguous local datetime: {local_midnight}"),
        },
    )?;
    Ok(zoned.to_utc().naive_utc())
}

fn collect_days(
    start_date: NaiveDate,
    end_date: NaiveDate,
) -> Result<Vec<NaiveDate>, AppError> {
    let mut days = Vec::new();
    let mut current = start_date;
    while current <= end_date {
        days.push(current);
        current = next_date(current).c(h!())?;
    }
    Ok(days)
}

async fn load_total_message_counts(
    db: &DatabaseConnection,
    start_utc: NaiveDateTime,
    end_utc: NaiveDateTime,
    tz: &str,
) -> Result<BTreeMap<NaiveDate, u64>, AppError> {
    let sql = format!(
        r#"
        SELECT
            (datetime AT TIME ZONE 'UTC' AT TIME ZONE '{tz}')::date AS day,
            count(*) AS message_count
        FROM sigint_inbox_item
        WHERE datetime >= $1 AND datetime < $2
        GROUP BY day
        ORDER BY day
        "#
    );

    let rows = db
        .query_all_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            sql,
            [start_utc.into(), end_utc.into()],
        ))
        .await
        .c(h!())?;

    let mut counts = BTreeMap::new();
    for row in rows {
        let day: NaiveDate = row.try_get("", "day")?;
        let message_count: i64 = row.try_get("", "message_count")?;
        counts.insert(day, message_count as u64);
    }

    Ok(counts)
}

async fn load_tagged_message_counts(
    db: &DatabaseConnection,
    start_utc: NaiveDateTime,
    end_utc: NaiveDateTime,
    tz: &str,
) -> Result<BTreeMap<NaiveDate, (u64, u64)>, AppError> {
    let sql = format!(
        r#"
        SELECT
            (i.datetime AT TIME ZONE 'UTC' AT TIME ZONE '{tz}')::date AS day,
            count(DISTINCT i.id) FILTER (WHERE t.model IS NULL) AS human_count,
            count(DISTINCT i.id) FILTER (WHERE t.model IS NOT NULL) AS robot_count
        FROM sigint_inbox_item i
        INNER JOIN sigint_inbox_item_tag t
            ON t.sigint_inbox_item_id = i.id
        WHERE i.datetime >= $1 AND i.datetime < $2
        GROUP BY day
        ORDER BY day
        "#
    );

    let rows = db
        .query_all_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            sql,
            [start_utc.into(), end_utc.into()],
        ))
        .await
        .c(h!())?;

    let mut counts = BTreeMap::new();
    for row in rows {
        let day: NaiveDate = row.try_get("", "day")?;
        let human_count: i64 = row.try_get("", "human_count")?;
        let robot_count: i64 = row.try_get("", "robot_count")?;
        counts.insert(day, (human_count as u64, robot_count as u64));
    }

    Ok(counts)
}

fn write_report_csv(
    output: &str,
    days: &[NaiveDate],
    total_counts: &BTreeMap<NaiveDate, u64>,
    tag_counts: &BTreeMap<NaiveDate, (u64, u64)>,
) -> Result<(), AppError> {
    let mut writer = Writer::from_path(output).c(h!())?;
    writer
        .write_record([
            "day",
            "number of messages",
            "number of tagged messages made by human",
            "number of tagged messages made by robots",
        ])
        .c(h!())?;

    for day in days {
        let total = total_counts.get(day).copied().unwrap_or(0);
        let (human_count, robot_count) =
            tag_counts.get(day).copied().unwrap_or((0, 0));
        writer
            .write_record([
                day.format("%Y-%m-%d").to_string(),
                total.to_string(),
                human_count.to_string(),
                robot_count.to_string(),
            ])
            .c(h!())?;
    }

    writer.flush().c(h!())?;
    Ok(())
}
