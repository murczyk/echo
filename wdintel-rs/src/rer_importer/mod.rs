use self::types::*;
use crate::delta::bgtask_log;
use crate::entities::signal_profile::Model;
use crate::entities::*;
use crate::error::AppError;
use crate::location::peleng::reset_inbox_pelengs;
use crate::location::utils;
use crate::sigint::sender::preferred_sender_expr;
use crate::types::*;
use actix_web::http::header;
use actix_web::web::{Bytes, Json};
use actix_web::{get, post, HttpResponse};
use chrono::prelude::*;
use futures_util::{stream, TryStreamExt};
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
pub mod datetime;
pub mod frequency;
pub mod gdoc;
pub mod highlight;
pub mod import_csv;
pub mod import_kmz;
pub mod important;
pub mod inbox;
pub mod keywords;
pub mod location;
mod multimessage;
pub mod post;
pub mod reports;
pub mod search;
pub mod signals;
pub mod types;
pub mod unit;

#[get("/api/messenger/media/{media_id}")]
async fn messenger_media(
    user: actix_identity::Identity,
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
    ensure_media_access(&env.dbx, &login, media.signal_message_id).await?;
    let data = crate::messenger::media::fetch_media_bytes(env.as_ref(), &media)
        .await?;
    let bytes = Bytes::from(data);
    let size = media.size_bytes.max(0) as u64;
    let stream_body =
        stream::once(async move { Ok::<Bytes, std::io::Error>(bytes) });
    let mut resp = HttpResponse::Ok();
    resp.insert_header((header::CONTENT_TYPE, media.content_type.clone()));
    resp.insert_header((header::CONTENT_LENGTH, size.to_string()));
    if let Some(file_name) = media.file_name.clone() {
        let cd = header::ContentDisposition {
            disposition: header::DispositionType::Attachment,
            parameters: vec![header::DispositionParam::FilenameExt(
                header::ExtendedValue {
                    charset: header::Charset::Ext("UTF-8".into()),
                    language_tag: None,
                    value: file_name.into_bytes(),
                },
            )],
        };
        resp.insert_header(cd);
    }
    Ok(resp.streaming(stream_body))
}

async fn ensure_media_access(
    dbx: &DatabaseConnection,
    login: &str,
    signal_message_id: i64,
) -> Result<(), AppError> {
    let allowed_groups =
        crate::messenger::group::get_identity_sigint_groups(dbx, login)
            .await
            .c(h!())?;
    let is_allowed = signal_message_group::Entity::find()
        .filter(
            signal_message_group::Column::SignalMessageId.eq(signal_message_id),
        )
        .filter(
            signal_message_group::Column::GroupMasterKey.is_in(allowed_groups),
        )
        .select_only()
        .column(signal_message_group::Column::Id)
        .into_tuple::<i64>()
        .one(dbx)
        .await
        .c(h!())?
        .is_some();
    if is_allowed {
        Ok(())
    } else {
        Err(AppError::Forbidden("media access denied".into()))
    }
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
        .filter(datasource_group::Column::GroupMasterKey.is_in(groups))
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
    .await
    .c(h!())?;
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
        crate::messenger::group::CollectGroupsOpts::default(),
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

pub async fn oneoff_reprocess_unit_names(mode: Mode) -> Result<(), AppError> {
    println!("> oneoff_reprocess_coords");
    let dbx = crate::new_pg_pool_from_mode(mode).await.c(h!())?;
    let config = crate::config::read_config(mode)?;
    let settlements = Arc::new(RwLock::new(
        crate::location::load_from_file(
            config.settlement_paths().c(h!())?,
            mode,
        )
        .unwrap(),
    ));

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
            let result = crate::unit::parser::extract_unit(
                settlements.clone(),
                &body,
                callsigns,
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
                        let locations = crate::location::parse_location(
                            settlements.clone(),
                            location,
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
        .filter(datasource_group::Column::GroupMasterKey.is_in(master_keys))
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
        .filter(signal_profile::Column::Uuid.is_in(sender_uuids.clone()))
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
