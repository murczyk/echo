use self::types::*;
use crate::delta::bgtask_log;
use crate::entities::signal_profile::Model;
use crate::entities::*;
use crate::error::AppError;
use crate::location::peleng::reset_inbox_pelengs;
use crate::location::utils;
use crate::sigint::sender::preferred_sender_expr;
use crate::types::*;
use crate::utils::orm::ArrayColumnOps;
use actix_web::http::header;
use actix_web::http::StatusCode;
use actix_web::web::{Bytes, Json};
use actix_web::{get, post, HttpRequest, HttpResponse};
use chrono::prelude::*;
use futures_util::TryStreamExt;
use indicatif::ProgressBar;
use itertools::Itertools;
use rand::prelude::IndexedRandom;
use sea_orm::sea_query::{Expr, Func};
use sea_orm::*;
use sqlx::Row;
use std::collections::BTreeMap;
use time::{Duration as TimeDuration, OffsetDateTime, PrimitiveDateTime};

pub mod analysis;
pub mod bgworker;
pub mod body_noheader;
pub mod bookmark;
pub mod callsigns;
pub mod coordinates;
pub mod datetime;
pub mod frequency;
pub mod gdoc;
pub mod highlight;
pub mod import_csv;
pub mod import_kmz;
pub mod important;
pub mod inbox;
pub mod location;
pub mod meow_format;
pub mod multimessage;
pub mod points;
pub mod post;
pub mod reports;
pub mod search;
pub mod signals;
pub mod types;
pub mod unit;

fn media_inline_content_disposition(
    file_name: Option<&str>,
) -> Option<header::ContentDisposition> {
    file_name.map(|file_name| header::ContentDisposition {
        disposition: header::DispositionType::Inline,
        parameters: vec![header::DispositionParam::FilenameExt(
            header::ExtendedValue {
                charset: header::Charset::Ext("UTF-8".into()),
                language_tag: None,
                value: file_name.as_bytes().to_vec(),
            },
        )],
    })
}

fn parse_single_byte_range(
    range_header: &str,
    total: u64,
) -> Option<(u64, u64)> {
    let spec = range_header.trim().strip_prefix("bytes=")?.trim();
    let spec = spec.split(',').next()?.trim();
    if spec.is_empty() || total == 0 {
        return None;
    }

    if let Some(suffix) = spec.strip_prefix('-') {
        let suffix_len: u64 = suffix.parse().ok()?;
        if suffix_len == 0 {
            return None;
        }
        let suffix_len = suffix_len.min(total);
        let start = total - suffix_len;
        return Some((start, total - 1));
    }

    let (start_str, end_str) = spec.split_once('-')?;
    let start: u64 = start_str.parse().ok()?;
    let end = if end_str.is_empty() {
        total - 1
    } else {
        end_str.parse().ok()?
    };
    if start >= total || start > end {
        return None;
    }
    Some((start, end.min(total - 1)))
}

fn apply_media_response_headers(
    builder: &mut actix_web::HttpResponseBuilder,
    content_type: &str,
    file_name: Option<&str>,
) {
    builder.insert_header((header::ACCEPT_RANGES, "bytes"));
    builder.insert_header((header::CONTENT_TYPE, content_type.to_string()));
    if let Some(cd) = media_inline_content_disposition(file_name) {
        builder.insert_header(cd);
    }
}

#[get("/api/messenger/media/{media_id}")]
async fn messenger_media(
    user: actix_identity::Identity,
    req: HttpRequest,
    env: actix_web::web::Data<Env>,
    path: actix_web::web::Path<(Uuid,)>,
) -> Result<HttpResponse, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .c(h!())?;
    let media_id = path.0;
    let media = signal_message_media::Entity::find_by_id(media_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    crate::messenger::media::ensure_media_access(
        &env.dbx,
        &login,
        media.signal_message_id,
    )
    .await?;
    let data = crate::messenger::media::fetch_media_bytes(env.as_ref(), &media)
        .await?;
    let bytes = Bytes::from(data);
    let total = bytes.len() as u64;
    let content_type = media.content_type.as_str();
    let file_name = media.file_name.as_deref();

    if let Some(range_header) = req.headers().get(header::RANGE) {
        let range_header = range_header.to_str().unwrap_or("");
        if let Some((start, end)) = parse_single_byte_range(range_header, total)
        {
            let slice = bytes.slice(start as usize..=end as usize);
            let length = end - start + 1;
            let mut resp = HttpResponse::PartialContent();
            apply_media_response_headers(&mut resp, content_type, file_name);
            return Ok(resp
                .insert_header((
                    header::CONTENT_RANGE,
                    format!("bytes {start}-{end}/{total}"),
                ))
                .insert_header((header::CONTENT_LENGTH, length.to_string()))
                .body(slice));
        }
        let mut resp = HttpResponse::build(StatusCode::RANGE_NOT_SATISFIABLE);
        apply_media_response_headers(&mut resp, content_type, file_name);
        return Ok(resp
            .insert_header((header::CONTENT_RANGE, format!("bytes */{total}")))
            .finish());
    }

    let mut resp = HttpResponse::Ok();
    apply_media_response_headers(&mut resp, content_type, file_name);
    Ok(resp
        .insert_header((header::CONTENT_LENGTH, total.to_string()))
        .body(bytes))
}

#[post("/api/rer-importer/callsigns")]
async fn rer_importer_callsigns(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<RerImporterCallsignsReq>,
) -> Result<Json<Vec<CallsignWithFrequencies>>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
    let sixty_days_ago_offset =
        OffsetDateTime::now_utc() - TimeDuration::days(60);
    let sixty_days_ago_primitive = PrimitiveDateTime::new(
        sixty_days_ago_offset.date(),
        sixty_days_ago_offset.time(),
    );
    let res1_rows = sqlx::query(
        r#"
select
  jsonb_array_elements_text(sii.callsigns) as callsign,
  array_agg(distinct coalesce(sii.freq, '')) as freqs
from sigint_inbox_item sii
inner join signal_message sm on sm.id = sii.id
inner join datasource d on d.id=sm.datasource_id
inner join sigint_zone_datasource szd on szd.datasource_id = d.id
inner join sigint_zone sz on sz.id=szd.sigint_zone_id
inner join login l on l.sigint_zone_id = sz.id
where sm.created_at >= $1 and sii.checked and l.login=$2
 group by 1"#,
    )
    .bind(sixty_days_ago_primitive)
    .bind(user.id().c(h!())?)
    .fetch_all(env.dbx.get_postgres_connection_pool())
    .await
    .c(h!())?;

    let mut res = vec![];
    for row in res1_rows.iter() {
        let callsign: Option<String> = row.try_get("callsign").ok();
        let freqs: Option<Vec<String>> = row.try_get("freqs").ok();
        if req.filter.is_none() || (callsign == req.filter.clone()) {
            if let Some(callsign) = callsign.clone() {
                if let Some(freqs) = freqs.clone() {
                    res.push(CallsignWithFrequencies {
                        callsign,
                        frequencies: freqs
                            .iter()
                            .filter(|x| !x.is_empty())
                            .cloned()
                            .collect(),
                    })
                }
            }
        }
    }

    Ok(Json(res))
}

#[get("/api/rer-importer/grafana/messages")]
async fn list_messages(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: actix_web::web::Query<MessagesReq>,
) -> Result<Json<Vec<MessageRsp>>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;

    let groups = crate::messenger::group::get_identity_sigint_groups_noimport(
        &env.dbx,
        &user,
        &env.config,
    )
    .await
    .c(h!())?;

    let result = signal_message::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::DatasourceGroup.def(),
        )
        .join(
            JoinType::LeftJoin,
            datasource_group::Relation::SignalGroup.def(),
        )
        .columns([
            signal_message::Column::Id,
            signal_message::Column::Body,
            signal_message::Column::Timestamp,
        ])
        .columns([
            sigint_inbox_item::Column::Lat,
            sigint_inbox_item::Column::Lng,
            sigint_inbox_item::Column::Freq,
        ])
        .expr_as(
            Func::cust(crate::utils::orm::Concat)
                .arg(Expr::col(sigint_inbox_item::Column::Lat))
                .arg(Expr::val(", "))
                .arg(Expr::col(sigint_inbox_item::Column::Lng)),
            "coordinates",
        )
        .to_owned()
        .join(
            JoinType::InnerJoin,
            signal_group::Relation::SigintZoneDatasource.def(),
        )
        .filter(datasource_group::Column::GroupMasterKey.eq_any(groups))
        .filter(sigint_inbox_item::Column::Lat.is_not_null())
        .filter(sigint_inbox_item::Column::Lng.is_not_null())
        .filter(sigint_inbox_item::Column::Lat.ne(0.0))
        .filter(sigint_inbox_item::Column::Lng.ne(0.0))
        .filter(signal_message::Column::Deleted.eq(false))
        .apply_if(req.freq.as_ref(), |q, freq| {
            q.filter(sigint_inbox_item::Column::Freq.eq(freq))
        })
        .apply_if(req.from, |q, from| {
            q.filter(
                signal_message::Column::Timestamp
                    .gte::<chrono::NaiveDateTime>(from),
            )
        })
        .apply_if(req.to, |q, to| {
            q.filter(
                signal_message::Column::Timestamp
                    .lte::<chrono::NaiveDateTime>(to),
            )
        })
        .into_model::<MessageRsp>()
        .all(&env.dbx)
        .await
        .c(h!())?;
    Ok(Json(result))
}

#[get("/api/sigint/callsigns-alchemy.json")]
async fn callsigns_alchemy(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<CallsignsAlchemyRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
    let callsigns = network_callsign::Entity::find()
        .all(&env.dbx)
        .await
        .c(h!())?;
    let mut callsigns_s = vec![];
    for callsign in callsigns.iter() {
        if !callsigns_s.contains(&callsign.callsign) {
            callsigns_s.push(callsign.callsign.clone());
        }
    }
    let mut per_freq: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for callsign in callsigns.iter() {
        per_freq
            .entry(callsign.freq.clone())
            .and_modify(|x| {
                if !x.contains(&callsign.callsign) {
                    x.push(callsign.callsign.clone())
                }
            })
            .or_insert(vec![callsign.callsign.clone()]);
    }
    let mut freqs_per_callsign: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for callsign in callsigns.iter() {
        freqs_per_callsign
            .entry(callsign.callsign.clone())
            .and_modify(|x| {
                if !x.contains(&callsign.freq) {
                    x.push(callsign.freq.clone())
                }
            })
            .or_insert(vec![callsign.freq.clone()]);
    }
    let mut nodes = vec![];
    let mut edges = vec![];
    let rng = &mut rand::rng();
    for callsign in callsigns_s.iter() {
        let cluster: String = freqs_per_callsign
            .get(callsign)
            .expect("impossible! seed=81737")
            .choose(rng)
            .expect("impossible! seed=71928")
            .clone();
        nodes.push(CallsignsAlchemyNode {
            id: format!("node-{callsign}"),
            cluster,
            title: callsign.to_string(),
            relatedness: "1.0".to_string(),
        });
    }
    for (freq, callsigns) in per_freq.iter() {
        // for callsign in callsigns.iter() {
        //     nodes.push(CallsignsAlchemyNode {
        //         id: format!("node-{}-{}", freq, callsign),
        //         cluster: freq.clone(),
        //         title: format!("{} ({})", callsign, freq),
        //         relatedness: "1.0".to_string(),
        //     });
        // }
        edges.extend(fill_edges(freq, callsigns.clone())?);
    }
    Ok(Json(CallsignsAlchemyRsp { nodes, edges }))
}

fn fill_edges(
    _freq: &str,
    callsigns: Vec<String>,
) -> Result<Vec<CallsignAlchemyEdge>, AppError> {
    let mut res = vec![];
    if !callsigns.is_empty() {
        let (c1, cs) = callsigns.split_at(1);
        let c1 = &c1[0];
        for c in cs.iter() {
            res.push(CallsignAlchemyEdge {
                source: format!("node-{c1}"),
                target: format!("node-{c}"),
                relatedness: "1.0".to_string(),
            });
        }
        res.extend(fill_edges(_freq, cs.to_vec())?);
    }
    Ok(res)
}

#[post("/api/rer-importer/unread-counters")]
pub async fn unread_counters(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<UnreadCountersReq>,
) -> Result<Json<UnreadCountersRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
    let newer_msg_count = match req.only_show_unprocessed {
        Some(true) => sqlx::query(
            r#"
SELECT count(*) as cnt
FROM signal_message sm
INNER JOIN sigint_inbox_item sii ON sm.id=sii.id
WHERE sm.id > $1
  AND not sii.reviewed
"#,
        )
        .bind(req.last_id)
        .fetch_one(env.dbx.get_postgres_connection_pool())
        .await
        .ok()
        .and_then(|row| row.try_get::<i64, _>("cnt").ok())
        .unwrap_or(0),
        _ => sqlx::query(
            r#"
SELECT count(*) as cnt
FROM signal_message sm
WHERE sm.id > $1
"#,
        )
        .bind(req.last_id)
        .fetch_one(env.dbx.get_postgres_connection_pool())
        .await
        .ok()
        .and_then(|row| row.try_get::<i64, _>("cnt").ok())
        .unwrap_or(0),
    };

    Ok(Json(UnreadCountersRsp { newer_msg_count }))
}

#[post("/api/rer-importer/signal-group")]
pub async fn signal_group_info(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<SignalGroupReq>,
) -> Result<Json<SignalGroupRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
    let m_signal_group = signal_group::Entity::find()
        .filter(signal_group::Column::Deleted.eq(false))
        .filter(signal_group::Column::MasterKey.eq(&req.master_key))
        .one(&env.dbx)
        .await
        .c(h!())?;
    match m_signal_group {
        None => Ok(Json(SignalGroupRsp { name: None })),
        Some(signal_group) => Ok(Json(SignalGroupRsp {
            name: signal_group.name,
        })),
    }
}

#[post("/api/rer-importer/signal-group-batch")]
pub async fn signal_group_info_batch(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<BatchSignalGroupReq>,
) -> Result<Json<SignalGroupsRsp>, AppError> {
    crate::users::has_any_role(
        &env.dbx,
        &user.id().c(h!())?,
        vec!["Rer", "Api"],
    )
    .await?;
    let is_admin =
        crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Admin")
            .await
            .is_ok();
    let keys: Vec<String> =
        req.groups.iter().map(|b| b.master_key.clone()).collect();
    let data = crate::messenger::group::collect_groups(
        keys,
        &env.dbx,
        is_admin,
        crate::messenger::group::CollectGroupsOpts {
            skip_group_stats: req.skip_group_stats.unwrap_or(false),
        },
    )
    .await
    .c(h!())?;
    Ok(Json(SignalGroupsRsp { data }))
}

#[post("/api/rer-importer/signal-profile")]
pub async fn signal_profile_info(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<SignalProfileReq>,
) -> Result<Json<Option<SignalProfileRsp>>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
    // signal_profile::Column::Uuid
    //     .eq(&req.uuid)
    //     .or(signal_profile::Column::GivenName.eq(&req.uuid)),
    let m_signal_profile = signal_profile::Entity::find()
        .filter(signal_profile::Column::Uuid.eq(&req.uuid))
        .one(&env.dbx)
        .await
        .c(h!())?;
    match m_signal_profile {
        None => Ok(Json(None)),
        Some(signal_profile) => Ok(Json(Some(SignalProfileRsp {
            given_name: signal_profile.given_name,
            family_name: signal_profile.family_name,
        }))),
    }
}

#[post("/api/rer-importer/signal-profile-batch")]
pub async fn signal_profile_info_batch(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<BatchSignalProfileReq>,
) -> Result<Json<SignalProfilesRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
    let txn = env.dbx.begin().await.c(h!())?;
    // signal_profile::Column::Uuid
    //     .eq(&req.uuid)
    //     .or(signal_profile::Column::GivenName.eq(&req.uuid)),
    let ids: Vec<String> =
        req.profiles.iter().map(|p| p.uuid.clone()).collect();
    let data = collect_profiles_data(&txn, ids).await.c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(Json(SignalProfilesRsp { data }))
}

#[post("/api/rer-importer/signal-profile/save")]
pub async fn signal_profile_save(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<SignalProfileSaveReq>,
) -> Result<Json<()>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
    signal_profile::Entity::insert(signal_profile::ActiveModel {
        uuid: Set(req.uuid.clone()),
        given_name: Set(req.given_name.clone()),
        family_name: Set(req.family_name.clone()),
        created_at: NotSet,
    })
    .on_conflict(
        sea_query::OnConflict::column(signal_profile::Column::Uuid)
            .update_columns([
                signal_profile::Column::GivenName,
                signal_profile::Column::FamilyName,
            ])
            .to_owned(),
    )
    .exec(&env.dbx)
    .await
    .c(h!())?;
    Ok(Json(()))
}

pub async fn oneoff_round_freq(mode: Mode) -> Result<(), AppError> {
    println!("> starting oneoff_round_freq");
    let dbx = crate::new_pg_pool_from_mode(mode).await.c(h!())?;

    let group = crate::config::read_config(mode)?.signal_import_group_name;

    let q = Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"UPDATE sigint_inbox_item AS sii
                SET freq = res
                FROM (
                    SELECT
                        sii.id, TO_CHAR(FLOOR(CAST(sii.freq AS NUMERIC)) + ROUND(MOD(CAST(sii.freq AS NUMERIC) * 1000, 1000) / 5) * 0.005, '999.9999') AS res
                    FROM sigint_inbox_item AS sii
                        INNER JOIN signal_message AS sm ON sm.id = sii.id
                        INNER JOIN datasource_group dg ON sm.datasource_group_id = dg.id
                        INNER JOIN signal_group AS sg ON sg.master_key = dg.group_master_key
                    WHERE
                        sii.lat IS NOT NULL
                        AND sii.lng IS NOT NULL
                        AND sg.name = $1
                        AND sg.deleted = false
                        AND sii.freq <> TO_CHAR(FLOOR(CAST(sii.freq AS NUMERIC)) + ROUND(MOD(CAST(sii.freq AS NUMERIC) * 1000, 1000) / 5) * 0.005, '999.9999')
                ) AS updated
                WHERE
                  sii.id = updated.id
            "#,
        [group.clone().into()],
    );

    // println!("Query: {}", q);

    let res = dbx.execute(q).await.c(h!())?;

    println!("> rounded {} freqs", res.rows_affected());

    Ok(())
}

pub async fn oneoff_nominalize_freq(mode: Mode) -> Result<(), AppError> {
    println!("> starting oneoff_nominalize_freq");
    let dbx = crate::new_pg_pool_from_mode(mode).await.c(h!())?;
    let inbox_items = sigint_inbox_item::Entity::find()
        .order_by_asc(sigint_inbox_item::Column::Id);
    // println!(
    //     "> inbox items query: {}",
    //     inbox_items.build(DbBackend::Postgres).to_string()
    // );
    let count: u64 = inbox_items.clone().count(&dbx).await.c(h!())?;
    println!("> overall: {count}");
    let mut inbox_items = inbox_items.stream(&dbx).await.c(h!())?;
    let pb = ProgressBar::new(count);
    while let Some(item) = inbox_items.try_next().await.c(h!())? {
        pb.inc(1);

        if let Some(freq) = item.freq.as_ref() {
            let freq2 = self::frequency::etalon(freq);
            if &freq2 != freq {
                let mut item: sigint_inbox_item::ActiveModel = item.into();
                item.freq = Set(Some(freq2));
                item.update(&dbx).await.c(h!())?;
            }
        }
    }
    Ok(())
}

#[derive(FromQueryResult)]
struct InboxPostRecalcRow {
    id: i64,
    post_id: Option<i64>,
    body: Option<String>,
}

pub async fn oneoff_reprocess_inbox_posts(
    mode: Mode,
    ps: &crate::OneoffReprocessInboxPostsPs,
) -> Result<(), AppError> {
    println!(
        "> oneoff_reprocess_inbox_posts start_day={} dry_run={}",
        ps.start_day, ps.dry_run
    );
    let dbx = crate::new_pg_pool_from_mode(mode).await.c(h!())?;
    let start_utc = parse_start_day_to_utc(&ps.start_day).c(h!())?;

    let q = build_inbox_posts_recalc_query(start_utc);
    let page_size = 1000_u64;
    let paginator = q.paginate(&dbx, page_size);
    let total_pages = paginator.num_pages().await.c(h!())?;

    let mut total = 0_u64;
    let mut updated = 0_u64;
    let mut unchanged = 0_u64;
    let mut skipped_no_body = 0_u64;

    for page in 0..total_pages {
        let rows = paginator.fetch_page(page).await.c(h!())?;
        for row in rows {
            total += 1;
            let Some(body) = row.body else {
                skipped_no_body += 1;
                continue;
            };

            let post = crate::rer_importer::post::extract_post(&body)?;
            let new_post_id =
                crate::sigint::post::get_or_create_post_id(&dbx, &post)
                    .await
                    .c(h!())?;

            if row.post_id == new_post_id {
                unchanged += 1;
                continue;
            }

            updated += 1;
            if ps.dry_run {
                continue;
            }

            let inbox_item = sigint_inbox_item::ActiveModel {
                id: Set(row.id),
                post_id: Set(new_post_id),
                ..Default::default()
            };
            let inbox_item = inbox_item.update(&dbx).await.c(h!())?;
            crate::sigint::network::etalon_calc::calculate_sigint_inbox_item_networks(
                vec![inbox_item],
                &dbx,
            )
            .await
            .c(h!())?;
        }
    }

    println!(
        "> done oneoff_reprocess_inbox_posts: total={total} updated={updated} unchanged={unchanged} skipped_no_body={skipped_no_body}"
    );
    Ok(())
}

fn build_inbox_posts_recalc_query(
    start_utc: NaiveDateTime,
) -> Selector<SelectModel<InboxPostRecalcRow>> {
    sigint_inbox_item::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .filter(sigint_inbox_item::Column::Datetime.gte(start_utc))
        .filter(signal_message::Column::Deleted.eq(false))
        .select_only()
        .column(sigint_inbox_item::Column::Id)
        .column(sigint_inbox_item::Column::PostId)
        .column_as(signal_message::Column::Body, "body")
        .order_by_asc(sigint_inbox_item::Column::Id)
        .into_model::<InboxPostRecalcRow>()
}

fn parse_start_day_to_utc(start_day: &str) -> Result<NaiveDateTime, AppError> {
    let local_date =
        NaiveDate::parse_from_str(start_day, "%Y-%m-%d").c(h!())?;
    let local_midnight =
        local_date.and_hms_opt(0, 0, 0).ok_or(AppError::BL {
            msg: format!("invalid local midnight for date {start_day}"),
        })?;
    let zoned = local_midnight
        .and_local_timezone(crate::config::get_tz())
        .single()
        .ok_or(AppError::BL {
            msg: format!("ambiguous local datetime: {local_midnight}"),
        })?;
    Ok(zoned.to_utc().naive_utc())
}

pub async fn oneoff_reprocess_unit_names(mode: Mode) -> Result<(), AppError> {
    println!("> oneoff_reprocess_coords");
    let dbx = crate::new_pg_pool_from_mode(mode).await.c(h!())?;
    let config = crate::config::read_config(mode)?;
    let settlements = Arc::new(RwLock::new(
        crate::location::load_settlements_data_config(
            config.settlement_paths().c(h!())?,
            mode,
        )
        .unwrap(),
    ));
    crate::location::aor_config::init_aor_location_config(
        &dbx,
        settlements.clone(),
    )
    .await
    .c(h!())?;

    let q = sigint_inbox_item::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .filter(
            sigint_inbox_item::Column::Datetime
                .gte(Utc::now() - chrono::Duration::days(10)),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .order_by_asc(sigint_inbox_item::Column::Id);
    // let count = q.clone().count(&dbx).await
    let mut inbox_items = q.stream(&dbx).await.c(h!())?;
    // let pb = ProgressBar::new(count);
    while let Some(item) = inbox_items.try_next().await.c(h!())? {
        // pb.inc(1);
        let id = item.id;
        let inbox_message = signal_message::Entity::find_by_id(id)
            .filter(signal_message::Column::Deleted.eq(false))
            .one(&dbx)
            .await
            .c(h!())?
            .ok_or("error 17263")?;
        let m_aor_id = resolve_message_aor_id(&dbx, id).await.c(h!())?;

        let unit_old = item.unit.clone();
        if let Some(body) = inbox_message.body {
            let callsigns: Vec<String> = match item.callsigns.as_ref() {
                Some(v) => serde_json::from_value(v.clone()).c(h!())?,
                None => vec![],
            };
            let callsigns = callsigns
                .into_iter()
                .map(|x| x.to_uppercase())
                .collect_vec();
            let result = crate::unit::parser::extract_unit_with_aor(
                settlements.clone(),
                &body,
                callsigns,
                m_aor_id,
            )?;
            let unit_new = result.unit.clone();
            if unit_new.is_none() && unit_old.is_some() {
                continue;
            }
            println!("{unit_old:?} -> {unit_new:?}");
            let mut item: sigint_inbox_item::ActiveModel = item.into();
            let location_v2 =
                match (result.locality.clone(), result.locality_v2.clone()) {
                    (_, Some(locations)) => {
                        Some(utils::format_settlements_list(locations))
                    }
                    (Some(location), None) => {
                        let locations =
                            crate::location::parse_location_with_aor(
                                settlements.clone(),
                                location,
                                m_aor_id,
                            )
                            .c(h!())?;
                        Some(utils::format_settlements_list(locations))
                    }
                    _ => None,
                };
            item.unit = Set(unit_new);
            item.unit_v2 = Set(None);
            item.location = Set(result.locality);
            item.location_v2 = Set(location_v2);
            item.parsed_unit_v2 = Set(false);
            item.update(&dbx).await.c(h!())?;
            reset_inbox_pelengs(id, &dbx).await.c(h!())?;
        }
    }
    Ok(())
}

async fn resolve_message_aor_id(
    dbx: &DatabaseConnection,
    message_id: i64,
) -> Result<Option<i64>, AppError> {
    let m_group_master_key = signal_message_group::Entity::find()
        .filter(signal_message_group::Column::SignalMessageId.eq(message_id))
        .filter(signal_message_group::Column::GroupMasterKey.is_not_null())
        .order_by_asc(signal_message_group::Column::Id)
        .select_only()
        .column(signal_message_group::Column::GroupMasterKey)
        .into_tuple::<String>()
        .one(dbx)
        .await
        .c(h!())?;
    let Some(group_master_key) = m_group_master_key else {
        return Ok(None);
    };
    let m_aor_id = signal_group_aor::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_group_aor::Relation::AreaOfResponsibility.def(),
        )
        .filter(signal_group_aor::Column::MasterKey.eq(group_master_key))
        .filter(area_of_responsibility::Column::Deleted.eq(false))
        .order_by_asc(signal_group_aor::Column::Id)
        .select_only()
        .column(signal_group_aor::Column::AorId)
        .into_tuple::<i64>()
        .one(dbx)
        .await
        .c(h!())?;
    Ok(m_aor_id)
}

#[post("/api/rer-importer/latest-senders")]
pub async fn latest_senders(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<SignalProfilesRsp>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
    let now = Utc::now();
    #[derive(FromQueryResult)]
    struct Res {
        sender: Option<String>,
    }
    let txn = env.dbx.begin().await.c(h!())?;
    let master_keys =
        crate::messenger::group::get_identity_sigint_groups(&txn, &login)
            .await
            .c(h!())?;
    let sender_expr = preferred_sender_expr(None);
    let sender_uuids: Vec<String> = signal_message::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::DatasourceGroup.def(),
        )
        .select_only()
        .column_as(sender_expr.clone(), "sender")
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(datasource_group::Column::GroupMasterKey.eq_any(master_keys))
        .filter(
            signal_message::Column::CreatedAt
                .gt(now - chrono::Duration::days(2)),
        )
        .group_by(sender_expr)
        .into_model::<Res>()
        .all(&txn)
        .await
        .c(h!())?
        .iter()
        .filter_map(|x| x.sender.clone())
        .collect();
    let data = collect_profiles_data(&txn, sender_uuids).await.c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(Json(SignalProfilesRsp { data }))
}

pub async fn collect_profiles_data<'a, 'async_trait, C>(
    txn: &'a C,
    sender_uuids: Vec<String>,
) -> Result<BTreeMap<String, Option<SignalProfileEntry>>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let profiles: BTreeMap<String, Model> = signal_profile::Entity::find()
        .filter(signal_profile::Column::Uuid.eq_any(sender_uuids.clone()))
        .all(txn)
        .await
        .c(h!())?
        .iter()
        .map(|p| (p.uuid.clone(), p.clone()))
        .collect();
    let mut data = BTreeMap::new();
    for id in sender_uuids {
        let m_profile = profiles.get(&id).map(|p| SignalProfileEntry {
            family_name: p.family_name.clone(),
            given_name: p.given_name.clone(),
        });
        data.insert(id, m_profile);
    }
    Ok(data)
}

#[cfg(test)]
mod messenger_media_tests {
    use super::parse_single_byte_range;

    #[test]
    fn parse_byte_range_from_start() {
        assert_eq!(parse_single_byte_range("bytes=0-99", 1000), Some((0, 99)));
    }

    #[test]
    fn parse_byte_range_open_end() {
        assert_eq!(
            parse_single_byte_range("bytes=500-", 1000),
            Some((500, 999))
        );
    }

    #[test]
    fn parse_byte_range_suffix() {
        assert_eq!(
            parse_single_byte_range("bytes=-100", 1000),
            Some((900, 999))
        );
    }

    #[test]
    fn parse_byte_range_rejects_out_of_bounds() {
        assert_eq!(parse_single_byte_range("bytes=1000-1100", 1000), None);
    }
}
