use self::types::*;
use crate::delta::bgtask_log;
use crate::entities::signal_profile::Model;
use crate::entities::{prelude::*, *};
use crate::error::AppError;
use crate::location::peleng::reset_inbox_pelengs;
use crate::location::utils;
use crate::types::*;
use actix_web::web::Json;
use actix_web::{get, post, HttpRequest, HttpResponse};
use chrono::prelude::*;
use futures_util::TryStreamExt;
use indicatif::ProgressBar;
use itertools::Itertools;
use rand::prelude::IndexedRandom;
use sea_orm::sea_query::{Expr, Func};
use sea_orm::*;
use std::collections::BTreeMap;
use std::path::Path;
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

#[get("/api/rer-importer/attachment/{attachment_id}")]
async fn attachment(
    user: actix_identity::Identity,
    http_req: HttpRequest,
    env: actix_web::web::Data<Env>,
    path: actix_web::web::Path<(i64,)>,
) -> Result<HttpResponse, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    let attachment_id = path.0;
    let attachment: signal_attachment::Model =
        SignalAttachment::find_by_id(attachment_id)
            .one(&env.dbx)
            .await?
            .ok_or(AppError::NotFound)?;
    let file = actix_files::NamedFile::open_async(&Path::new(&attachment.path))
        .await
        .map_err(|_e| AppError::NotFound)?;
    Ok(file.into_response(&http_req))
}

#[post("/api/rer-importer/callsigns")]
async fn rer_importer_callsigns(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<RerImporterCallsignsReq>,
) -> Result<Json<Vec<CallsignWithFrequencies>>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    let sixty_days_ago_offset =
        OffsetDateTime::now_utc() - TimeDuration::days(60);
    let sixty_days_ago_primitive = PrimitiveDateTime::new(
        sixty_days_ago_offset.date(),
        sixty_days_ago_offset.time(),
    );
    let res1 = sqlx::query!(
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
        sixty_days_ago_primitive, // Use the PrimitiveDateTime
        user.id()?
    )
    .fetch_all(env.dbx.get_postgres_connection_pool())
    .await?;

    let mut res = vec![];
    for x in res1.iter() {
        if req.filter.is_none() || (x.callsign == req.filter.clone()) {
            if let Some(callsign) = x.callsign.clone() {
                if let Some(freqs) = x.freqs.clone() {
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
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;

    let groups = crate::users::get_identity_sigint_groups_noimport(
        &env.dbx,
        &user,
        &env.config,
    )
    .await?;

    Ok(Json(
        SignalMessage::find()
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
            .join_rev(
                JoinType::LeftJoin,
                signal_group::Entity::belongs_to(signal_message::Entity)
                    .from(signal_group::Column::MasterKey)
                    .to(signal_message::Column::GroupMasterKey)
                    .into(),
            )
            .join(
                JoinType::InnerJoin,
                signal_group::Relation::SigintZoneDatasource.def(),
            )
            .filter(signal_message::Column::GroupMasterKey.is_in(groups))
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
            .await?,
    ))
}

#[get("/api/sigint/callsigns-alchemy.json")]
async fn callsigns_alchemy(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<CallsignsAlchemyRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    let callsigns = NetworkCallsign::find().all(&env.dbx).await?;
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
            id: format!("node-{}", callsign),
            cluster,
            title: format!("{}", callsign),
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
    freq: &str,
    callsigns: Vec<String>,
) -> Result<Vec<CallsignAlchemyEdge>, AppError> {
    let mut res = vec![];
    if callsigns.len() > 0 {
        let (c1, cs) = callsigns.split_at(1);
        let c1 = &c1[0];
        for c in cs.iter() {
            res.push(CallsignAlchemyEdge {
                source: format!("node-{}", c1),
                target: format!("node-{}", c),
                relatedness: "1.0".to_string(),
            });
        }
        res.extend(fill_edges(freq, cs.to_vec())?);
    }
    Ok(res)
}

#[post("/api/rer-importer/unread-counters")]
pub async fn unread_counters(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<UnreadCountersReq>,
) -> Result<Json<UnreadCountersRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    let newer_msg_count = match req.only_show_unprocessed {
        Some(true) => {
            sqlx::query!(
                r#"
SELECT count(*) as cnt
FROM signal_message sm
INNER JOIN sigint_inbox_item sii ON sm.id=sii.id
WHERE sm.id > $1 AND sm.duplicate_of is null
  AND not sii.reviewed
"#,
                req.last_id,
            )
            .fetch_one(env.dbx.get_postgres_connection_pool())
            .await?
            .cnt
        }
        _ => {
            sqlx::query!(
                r#"
SELECT count(*) as cnt
FROM signal_message sm
WHERE sm.id > $1 AND sm.duplicate_of is null
"#,
                req.last_id,
            )
            .fetch_one(env.dbx.get_postgres_connection_pool())
            .await?
            .cnt
        }
    };
    let newer_msg_count = newer_msg_count.unwrap_or(0);

    Ok(Json(UnreadCountersRsp { newer_msg_count }))
}

#[post("/api/rer-importer/signal-group")]
pub async fn signal_group_info(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<SignalGroupReq>,
) -> Result<Json<SignalGroupRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    let m_signal_group = SignalGroup::find()
        .filter(signal_group::Column::MasterKey.eq(&req.master_key))
        .one(&env.dbx)
        .await?;
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
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    let keys: Vec<String> =
        req.groups.iter().map(|b| b.master_key.clone()).collect();
    let data = collect_groups(keys, &env.dbx).await?;
    Ok(Json(SignalGroupsRsp { data }))
}

#[post("/api/rer-importer/orphan-signal-groups")]
pub async fn orphan_signal_groups(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<Vec<OrphanSignalGroupEntry>>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Admin").await?;

    // Отримати всі master_key, які вже прив'язані
    let assigned_keys: Vec<String> = sigint_zone_datasource::Entity::find()
        .select_only()
        .column(sigint_zone_datasource::Column::GroupMasterKey)
        .into_tuple::<String>()
        .all(&env.dbx)
        .await?;

    // Знайти всі signal_group, яких немає серед assigned_keys
    let orphan_groups = signal_group::Entity::find()
        .filter(
                signal_group::Column::MasterKey.is_not_in(assigned_keys)
        )
        .all(&env.dbx)
        .await?;

    let data: Vec<OrphanSignalGroupEntry> = orphan_groups
        .into_iter()
        .filter_map(|g| {
            g.name.clone().map(|name| OrphanSignalGroupEntry {
                name,
                master_key: g.master_key,
                ignore_operativny: g.ignore_operativny,
                datasource_id: g.datasource_id,
            })
        })
        .collect();

    Ok(Json(data))
}

pub async fn collect_groups(
    keys: Vec<String>,
    txn: &DatabaseConnection,
) -> Result<Vec<SignalGroupEntry>, AppError> {
    let signal_groups = SignalGroup::find()
        .filter(signal_group::Column::MasterKey.is_in(keys))
        .all(txn)
        .await?;
    let data: Vec<SignalGroupEntry> = signal_groups
        .iter()
        .filter_map(|g| {
            g.name.clone().map(|name| SignalGroupEntry {
                name,
                master_key: g.master_key.clone(),
                ignore_operativny: g.ignore_operativny,
            })
        })
        .collect();
    Ok(data)
}

#[post("/api/rer-importer/signal-profile")]
pub async fn signal_profile_info(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<SignalProfileReq>,
) -> Result<Json<Option<SignalProfileRsp>>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    // signal_profile::Column::Uuid
    //     .eq(&req.uuid)
    //     .or(signal_profile::Column::GivenName.eq(&req.uuid)),
    let m_signal_profile = SignalProfile::find()
        .filter(signal_profile::Column::Uuid.eq(&req.uuid))
        .one(&env.dbx)
        .await?;
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
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    let txn = env.dbx.begin().await?;
    // signal_profile::Column::Uuid
    //     .eq(&req.uuid)
    //     .or(signal_profile::Column::GivenName.eq(&req.uuid)),
    let ids: Vec<String> =
        req.profiles.iter().map(|p| p.uuid.clone()).collect();
    let data = collect_profiles_data(&txn, ids).await?;
    txn.commit().await?;
    Ok(Json(SignalProfilesRsp { data }))
}

#[post("/api/rer-importer/signal-profile/save")]
pub async fn signal_profile_save(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<SignalProfileSaveReq>,
) -> Result<Json<()>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
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
    .await?;
    Ok(Json(()))
}

#[tokio::main]
pub async fn oneoff_round_freq(mode: Mode) -> Result<(), AppError> {
    println!("> starting oneoff_round_freq");
    let dbx = crate::new_pg_pool_from_mode(mode).await?;

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
                        INNER JOIN signal_group AS sg ON sg.master_key = sm.group_master_key
                    WHERE
                        sii.lat IS NOT NULL
                        AND sii.lng IS NOT NULL
                        AND sg.name = $1
                        AND sii.freq <> TO_CHAR(FLOOR(CAST(sii.freq AS NUMERIC)) + ROUND(MOD(CAST(sii.freq AS NUMERIC) * 1000, 1000) / 5) * 0.005, '999.9999')
                ) AS updated
                WHERE
                  sii.id = updated.id
            "#,
        [group.clone().into()],
    );

    // println!("Query: {}", q);

    let res = dbx.execute(q).await?;

    println!("> rounded {} freqs", res.rows_affected());

    Ok(())
}

#[tokio::main]
pub async fn oneoff_nominalize_freq(mode: Mode) -> Result<(), AppError> {
    println!("> starting oneoff_nominalize_freq");
    let dbx = crate::new_pg_pool_from_mode(mode).await?;
    let inbox_items =
        SigintInboxItem::find().order_by_asc(sigint_inbox_item::Column::Id);
    // println!(
    //     "> inbox items query: {}",
    //     inbox_items.build(DbBackend::Postgres).to_string()
    // );
    let count: u64 = inbox_items.clone().count(&dbx).await?;
    println!("> overall: {count}");
    let mut inbox_items = inbox_items.stream(&dbx).await?;
    let pb = ProgressBar::new(count);
    while let Some(item) = inbox_items.try_next().await? {
        pb.inc(1);

        if let Some(ref freq) = item.freq.as_ref() {
            let freq2 = self::frequency::etalon(&freq);
            if &freq2 != *freq {
                let mut item: sigint_inbox_item::ActiveModel = item.into();
                item.freq = Set(Some(freq2));
                item.update(&dbx).await?;
            }
        }
    }
    Ok(())
}

#[tokio::main]
pub async fn oneoff_reprocess_unit_names(mode: Mode) -> Result<(), AppError> {
    println!("> oneoff_reprocess_coords");
    let dbx = crate::new_pg_pool_from_mode(mode).await?;
    let config = crate::config::read_config(mode)?;
    let settlements = Arc::new(RwLock::new(
        crate::location::load_from_file(
            config.settlement_paths().context(h!())?,
        )
        .unwrap(),
    ));

    let q = SigintInboxItem::find()
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
    // let count = q.clone().count(&dbx).await?;
    let mut inbox_items = q.stream(&dbx).await?;
    // let pb = ProgressBar::new(count);
    while let Some(item) = inbox_items.try_next().await? {
        // pb.inc(1);
        let id = item.id;
        let inbox_message = SignalMessage::find_by_id(id)
            .filter(signal_message::Column::Deleted.eq(false))
            .one(&dbx)
            .await?
            .ok_or("error 17263")?;

        let unit_old = item.unit.clone();
        if let Some(body) = inbox_message.body {
            let callsigns: Vec<String> = match item.callsigns.as_ref() {
                Some(v) => serde_json::from_value(v.clone()).context(h!())?,
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
            if unit_new.is_none() {
                if unit_old.is_some() {
                    continue;
                }
            }
            println!("{:?} -> {:?}", unit_old, unit_new);
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
                        .context(h!())?;
                        Some(utils::format_settlements_list(locations))
                    }
                    _ => None,
                };
            item.unit = Set(unit_new);
            item.unit_v2 = Set(None);
            item.location = Set(result.locality);
            item.location_v2 = Set(location_v2);
            item.parsed_unit_v2 = Set(false);
            item.update(&dbx).await?;
            reset_inbox_pelengs(id, &dbx).await.context(h!())?;
        }
    }
    Ok(())
}

#[post("/api/rer-importer/latest-senders")]
pub async fn latest_senders(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<SignalProfilesRsp>, AppError> {
    let login = user.id()?;
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    let now = Utc::now();
    #[derive(FromQueryResult)]
    struct Res {
        sender: String,
    }
    let txn = env.dbx.begin().await?;
    let master_keys =
        crate::users::get_identity_sigint_groups(&txn, &login).await?;
    let sender_uuids: Vec<String> = SignalMessage::find()
        .select_only()
        .column_as(signal_message::Column::Sender, "sender")
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(signal_message::Column::GroupMasterKey.is_in(master_keys))
        .filter(
            signal_message::Column::CreatedAt
                .gt(now - chrono::Duration::days(2)),
        )
        .group_by(signal_message::Column::Sender)
        .into_model::<Res>()
        .all(&txn)
        .await?
        .iter()
        .map(|x| x.sender.clone())
        .collect();
    let data = collect_profiles_data(&txn, sender_uuids).await?;
    txn.commit().await?;
    Ok(Json(SignalProfilesRsp { data }))
}

pub async fn collect_profiles_data<'a, 'async_trait, C>(
    txn: &'a C,
    sender_uuids: Vec<String>,
) -> Result<BTreeMap<String, Option<SignalProfileEntry>>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let profiles: BTreeMap<String, Model> = SignalProfile::find()
        .filter(signal_profile::Column::Uuid.is_in(sender_uuids.clone()))
        .all(txn)
        .await?
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
