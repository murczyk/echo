use crate::entities::{prelude::*, *};
use crate::rer_importer::types::*;
use milgeo_rs::coordinates::{
    parse_latlng_f64, rer_extract_coords, Coords, Wgs84,
};
use std::collections::BTreeSet;

use crate::error::AppError;
use crate::location::utils;
use crate::location::utils::to_location_list;
use crate::rer_importer::highlight::*;
use crate::rer_importer::inbox::query::build_inbox_query;
use crate::rer_importer::signals::*;
use crate::rer_importer::{collect_groups, collect_profiles_data};
use crate::sigint::network::types::Network;
use crate::types::*;
use crate::utils::string::*;
use crate::utils::*;
use actix_web::web::Data;
use chrono::Utc;
use geoconvert::{LatLon, Mgrs};
use itertools::Itertools;
use log::*;
use sea_orm::*;
use sea_query::Expr;

#[derive(Debug, FromQueryResult)]
pub struct InboxMessageDesc {
    pub id: i64,
    pub body: Option<String>,
    pub timestamp: Option<NaiveDateTime>,
    pub group_master_key: Option<String>,
    pub sender: Option<String>,
    pub datasource_id: Option<i64>,
    pub freq: Option<String>,
    pub coords: Option<String>,
    pub callsigns: Option<serde_json::Value>,
    pub callsigns_alg2: Option<serde_json::Value>,
    pub callsign_tokens: Option<serde_json::Value>,
    pub signal_tokens: Option<serde_json::Value>,
    pub keyword_tokens: Option<serde_json::Value>,
    pub location_v2: Option<String>,
    pub date: Option<String>,
    pub time: Option<String>,
    pub checked: Option<bool>,
    pub unit_v2: Option<String>,
    pub post_id: Option<i64>,
    pub post_name: Option<String>,
    pub tags: Option<serde_json::Value>,
}

pub async fn get_inbox_map_items(
    login: &str,
    logins: &Vec<String>,
    env: &Env,
    req: &InboxMessagesReq,
) -> Result<Vec<InboxMapItem>, AppError> {
    let q = build_inbox_query(login, logins, env, req).await?;
    let q = format!(
        r#"SELECT id, "freq" as freq, "coords" as coords from ({}) q"#,
        q.build(DbBackend::Postgres)
    );

    let query_res: Vec<QueryResult> = env
        .dbx
        .query_all(Statement::from_string(DatabaseBackend::Postgres, q))
        .await
        .context(h!())?;
    let mut result = vec![];
    for query_res in query_res {
        let id: i64 = query_res.try_get("", "id")?;
        let duplicate_of: Option<i64> = None; // FIXME actually retrieve duplicate_of from db
        let freq: Option<String> = query_res.try_get("", "freq")?;
        let coords: Option<String> = query_res.try_get("", "coords")?;
        result.push(InboxMapItem {
            id,
            freq,
            coords,
            duplicate_of,
        });
    }
    if req.return_duplicates != Some(true) {
        let mut deduplicated = BTreeMap::new();
        for m in result {
            let source_id = match m.duplicate_of {
                None => m.id,
                Some(sid) => sid,
            };
            deduplicated.insert(source_id, m);
        }
        result = deduplicated.into_iter().map(|(_, m)| m).collect_vec();
    }
    Ok(result)
}

pub async fn aggregate_to_inbox_messages(
    messages: Vec<InboxMessageDesc>,
    logins: &Vec<String>,
    req: &&InboxMessagesReq,
    env: &&Env,
) -> Result<Vec<(i64, InboxMessage)>, AppError> {
    let mut res: Vec<(i64, InboxMessage)> = vec![];
    let dbx_raw = env.dbx.get_postgres_connection_pool();
    for message in messages {
        // for message in messages {
        // let m_inbox: Option<sigint_inbox_item::Model> =
        //     SigintInboxItem::find_by_id(message.id)
        //         .one(&env.dbx)
        //         .await?;
        let attachments: Vec<signal_attachment::Model> =
            SignalAttachment::find()
                .filter(
                    signal_attachment::Column::SignalMessageId.eq(message.id),
                )
                .all(&env.dbx)
                .await?;
        let mut images = vec![];
        for attach in attachments {
            let x = attach.path.to_lowercase();
            if x.ends_with(".png")
                || x.ends_with(".jpg")
                || x.ends_with(".jpeg")
                || x.ends_with(".jpe")
            {
                images.push(format!(
                    "/api/rer-importer/attachment/{}",
                    attach.id
                ));
            }
        }
        let body = message.body.unwrap_or("".to_string());
        let no_headers_body =
            crate::rer_importer::body_noheader::extract_text(&body)?;
        let freq = message.freq.clone();
        let coords = message.coords.clone();
        let callsigns = match message.callsigns.as_ref() {
            Some(v) => serde_json::from_value(v.clone()).context(h!())?,
            None => vec![],
        };
        let dups = SignalMessage::find()
            .filter(signal_message::Column::Deleted.eq(false))
            .filter(signal_message::Column::DuplicateOf.eq(message.id))
            .all(&env.dbx)
            .await?;
        let m_callsign_tokens: Option<Vec<CNCallsign>> =
            match message.callsign_tokens {
                None => None,
                Some(jv) => Some(serde_json::from_value(jv).context(h!())?),
            };
        let m_signal_tokens: Option<Vec<CNSignal>> = match message.signal_tokens
        {
            None => None,
            Some(jv) => Some(serde_json::from_value(jv).context(h!())?),
        };
        let m_keyword_tokens: Option<Vec<CNHighlight>> =
            match message.keyword_tokens {
                None => None,
                Some(jv) => Some(serde_json::from_value(jv).context(h!())?),
            };
        let ts_headline = match m_str_trim(&req.search) {
            None => None,
            Some(ref search) => {
                sqlx::query!(
                    "select ts_headline('russian', $1, websearch_to_tsquery('russian', $2), 'HighlightAll=true') as headline from sigint_search where id=$3",
                    body.clone().to_lowercase(),
                    search.to_lowercase().clone(),
                    message.id
                    ).fetch_one(dbx_raw).await.ok().map(|q| q.headline).flatten()
            }
        };
        let text_marked = crate::rer_importer::highlight::highlight(
            &body,
            Some(&no_headers_body),
            &m_callsign_tokens.clone().unwrap_or(vec![]),
            &m_keyword_tokens.clone().unwrap_or(vec![]),
            &m_signal_tokens.clone().unwrap_or(vec![]),
            ts_headline,
            crate::rer_importer::highlight::HighlightOpts {
                highlight_callsigns: req.highlight_callsigns,
                highlight_keywords: req.highlight_keywords,
                highlight_signals: req.highlight_signals,
                highlight_searchres: req.highlight_searchres,
            },
        )?;
        let m_comment = sigint_comment::Entity::find()
            .filter(sigint_comment::Column::SignalMessageId.eq(message.id))
            .filter(sigint_comment::Column::Login.is_in(logins.clone()))
            .one(&env.dbx)
            .await?;
        let location_v2 = match message.location_v2.clone() {
            None => None,
            Some(location) => Some(to_location_list(&location).join(", ")),
        };
        res.push((
            message.id,
            InboxMessage {
                text: body.clone(),
                images,
                image_recognized: vec![],
                date: message.date.clone(),
                time: message.time.clone(),
                freq: freq.clone(),
                coords,
                callsigns,
                checked: message.checked.unwrap_or(false),
                timestamp: message
                    .timestamp
                    .map(|x| x.and_utc().timestamp_millis()),
                group_master_key: message.group_master_key.clone(),
                sender: message.sender.clone(),
                duplicate_ids: Some(dups.iter().map(|dup| dup.id).collect()),
                extended_form: m_comment.as_ref().map(|x| x.comment.clone()),
                unit: message.unit_v2.clone(),
                no_headers_body: Some(no_headers_body),
                callsign_tokens: m_callsign_tokens,
                keyword_tokens: m_keyword_tokens,
                signal_tokens: m_signal_tokens,
                text_marked: Some(text_marked),
                post: message.post_name.clone(),
                post_id: message.post_id,
                datasource_id: message.datasource_id.clone(),
                location: location_v2,
                tags: Some(from_m_val_vec(message.tags.clone())?),
                callsigns_alg2: from_m_val_vec(message.callsigns_alg2.clone())?,
            },
        ));
    }

    if req.load_latest == Some(true)
        || (req.load_latest != Some(true)
            && req.newest_first != Some(true)
            && req.before_id_noninclusive.is_some())
    {
        res.reverse();
    }

    if req.return_duplicates != Some(true) {
        res = deduplicate(&res)?;
    }
    Ok(res)
}

fn deduplicate(
    items: &Vec<(i64, InboxMessage)>,
) -> Result<Vec<(i64, InboxMessage)>, AppError> {
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut res = vec![];
    for (k, item) in items.iter() {
        if !seen.contains(&item.text) {
            res.push((*k, item.clone()));
            seen.insert(item.text.clone());
        }
    }
    Ok(res)
}

pub async fn fill_callsigns(
    rq: &reqwest::Client,
    txn: &DatabaseTransaction,
    callsigns: &Vec<String>,
) -> Result<(), AppError> {
    for callsign in callsigns.iter() {
        let is_already_filled = CallsignLexeme::find()
            .filter(callsign_lexeme::Column::Lexeme.eq(callsign))
            .one(txn)
            .await?
            .is_some();
        if !is_already_filled {
            let lexemes = crate::nlp::token_lexemes(rq, callsign).await?;
            for lexeme in lexemes {
                callsign_lexeme::ActiveModel {
                    id: NotSet,
                    callsign: Set(callsign.to_string()),
                    lexeme: Set(lexeme),
                }
                .insert(txn)
                .await?;
            }
        }
    }
    Ok(())
}

pub async fn load_inbox_networks(
    inbox_items: &Vec<(i64, InboxMessage)>,
    txn: &DatabaseTransaction,
// ) -> Result<Vec<(i64, Vec<Network>)>, AppError> {
) -> Result<Vec<Network>, AppError> {

    // Get all (group_master_key, freq) pairs from inbox items
    let mut group_freq_map: HashMap<String, HashSet<String>> = HashMap::new();
    for (_, msg) in inbox_items {
        if let (Some(group_key), Some(freq)) =
            (&msg.group_master_key, &msg.freq)
        {
            group_freq_map
                .entry(group_key.clone())
                .or_default()
                .insert(freq.clone());
        }
    }
    let group_ids: Vec<String> = group_freq_map.keys().copied().collect();


    let freqs = inbox_items
        .iter()
        .filter_map(|x| x.1.freq.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect_vec();
    let networks = crate::sigint::network::bl_network_info_freqs(freqs, txn)
        .await
        .context(h!())?;
    Ok(networks)
}

pub async fn load_inbox_callsigns(
    inbox_items: &Vec<(i64, InboxMessage)>,
    env: &Data<Env>,
) -> Result<Vec<CallsignInfoRes>, AppError> {
    let callsigns = inbox_items
        .iter()
        .flat_map(|x| {
            x.1.callsigns
                .clone()
                .into_iter()
                .chain(x.1.callsigns_alg2.clone().into_iter())
        })
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect_vec();
    let data = crate::rer_importer::gdoc::load_callsigns(&env, callsigns)
        .await
        .context(h!())?;
    Ok(data)
}

pub async fn load_inbox_signal_profiles(
    inbox_items: &Vec<(i64, InboxMessage)>,
    txn: &DatabaseConnection,
) -> Result<BTreeMap<String, Option<SignalProfileEntry>>, AppError> {
    let callsigns = inbox_items
        .iter()
        .filter_map(|x| x.1.sender.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect_vec();
    let data = collect_profiles_data(txn, callsigns).await.context(h!())?;
    Ok(data)
}

pub async fn load_inbox_signal_groups(
    inbox_items: &Vec<(i64, InboxMessage)>,
    txn: &DatabaseConnection,
    is_admin: bool,
) -> Result<Vec<SignalGroupEntry>, AppError> {
    let callsigns = inbox_items
        .iter()
        .filter_map(|x| x.1.group_master_key.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect_vec();
    let data = collect_groups(callsigns, txn, is_admin)
        .await
        .context(h!())?;
    Ok(data)
}

pub async fn load_inbox_freq_pelengs_summary(
    inbox_items: &Vec<(i64, InboxMessage)>,
    txn: &DatabaseConnection,
) -> Result<Vec<FreqPelengsEntry>, AppError> {
    let res = sigint_inbox_item::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SigintPeleng.def(),
        )
        .select_only()
        .column(sigint_inbox_item::Column::Freq)
        .column_as(Expr::col(sigint_peleng::Entity).count(), "pelengs_count")
        .filter(sigint_peleng::Column::Deleted.eq(false))
        .filter(sigint_inbox_item::Column::Freq.is_not_null())
        .filter(
            sigint_inbox_item::Column::Id
                .is_in(inbox_items.iter().map(|x| x.0).collect_vec()),
        )
        .group_by(sigint_inbox_item::Column::Freq)
        .into_model::<FreqPelengsEntry>()
        .all(txn)
        .await
        .context(h!())?;

    Ok(res)
}

pub fn collect_map_points(
    inbox_items: Vec<InboxMapItem>,
    points: BTreeMap<i64, Vec<sigint_peleng::Model>>,
) -> Result<Vec<FreqDetailedPoint>, AppError> {
    let mut result: Vec<FreqDetailedPoint> = vec![];
    for item in inbox_items {
        let item_id = item.id;
        let freq = item.freq;
        let points = points.get(&item_id).cloned().unwrap_or(vec![]);
        for point in points {
            let lat = point.lat;
            let lng = point.lng;
            let sk42_coords =
                milgeo_rs::coordinates::usk2000::wgs84_to_usk2000(Wgs84 {
                    lat,
                    lng,
                })
                .context(h!())?;
            let sk42_coords = format!("{} {}", sk42_coords.x, sk42_coords.y);
            let mgrs_coords =
                Mgrs::from_latlon(&LatLon::create(lat, lng).context(h!())?, 6)
                    .to_string();
            let freq = freq.clone();
            result.push(FreqDetailedPoint {
                freq,
                lat,
                lng,
                mgrs_coords,
                sk42_coords,
                id: point.id,
                message_id: item_id,
            });
        }
    }

    Ok(result)
}

pub fn aggregate_network_units(
    units: BTreeMap<String, Vec<sigint_unit::Model>>,
) -> Vec<NetworkUnit> {
    let mut res = vec![];
    let mut result = BTreeMap::new();
    for (freq, units) in units {
        for unit in units {
            result.entry(unit.name).or_insert(vec![]).push(freq.clone());
        }
    }
    for (name, frequencies) in result {
        res.push(NetworkUnit { name, frequencies });
    }
    res
}

pub async fn submit_upsert_inbox_item(
    settlements: Arc<RwLock<crate::location::SettlementsData>>,
    txn: &DatabaseTransaction,
    id: i64,
    message: &InboxMessage,
    login: &str,
    logins: &Vec<String>,
) -> Result<i64, AppError> {
    let m_existing = SigintInboxItem::find_by_id(id).one(txn).await?;
    if let Some(existing) = m_existing {
        // cleanup before logging
        let mut existing = existing.clone();
        existing.signal_tokens = None;
        existing.body_noheader = None;
        let mut message = message.clone();
        message.signal_tokens = None;
        message.text_marked = None;
        message.keyword_tokens = None;
        info!(
            "upsert request id = {}; login = {}; new value: {:?}; old value: {:?}",
            id, login, message, existing
        );
    }

    let (lat, lng) = match message
        .coords
        .clone()
        .map(|c| parse_latlng_f64(&c.clone()[..]))
        .map(|x| x.ok())
        .flatten()
    {
        None => (None, None),
        Some((lat, lng)) => (Some(lat), Some(lng)),
    };

    let coords_s = match (lat, lng) {
        (Some(lat), Some(lng)) => {
            let text = format!("{}, {}", lat, lng);
            let mgrs: String =
                Mgrs::from_latlon(&LatLon::create(lat, lng).context(h!())?, 6)
                    .to_string();
            Some(Coords {
                text: text.clone(),
                lat,
                lng,
                mgrs,
                capture: text.clone(),
            })
        }
        _ => None,
    };

    let mut coords_vec = match &message.no_headers_body.clone().map(|n| n.body)
    {
        Some(body) => rer_extract_coords(body).await,
        None => vec![],
    };
    if let Some(c1) = &coords_s {
        if !coords_vec.iter().any(|c| c.text.eq(&c1.text)) {
            coords_vec.push(c1.clone())
        }
    }

    let freq = message
        .freq
        .as_ref()
        .map(|x| crate::rer_importer::frequency::etalon(x));

    // upsert sigint_comment
    if let Some(extended_form) = message.extended_form.as_ref() {
        let m_comment = sigint_comment::Entity::find()
            .filter(sigint_comment::Column::SignalMessageId.eq(id))
            .filter(sigint_comment::Column::Login.is_in(logins.clone()))
            .one(txn)
            .await?;
        match m_comment {
            None => {
                sigint_comment::ActiveModel {
                    id: NotSet,
                    signal_message_id: Set(id),
                    login: Set(login.to_string()),
                    comment: Set(extended_form.clone()),
                    created_at: NotSet,
                }
                .insert(txn)
                .await?;
            }
            Some(comment) => {
                debug!(
                    "> updating comment for message {}: old: {}, new: {}",
                    comment.signal_message_id, comment.comment, extended_form
                );
                sigint_comment::ActiveModel {
                    id: Set(comment.id),
                    signal_message_id: Set(id),
                    login: Set(login.to_string()),
                    comment: Set(extended_form.clone()),
                    created_at: NotSet,
                }
                .update(txn)
                .await?;
            }
        }
    }

    let location = message.location.clone();
    let location_v2 = match location.clone() {
        Some(location) => {
            let locations =
                crate::location::parse_location(settlements.clone(), location)
                    .context(h!())?;
            Some(utils::format_settlements_list(locations))
        }
        None => location.clone(), //fallback
    };

    let insert_res =
        sigint_inbox_item::Entity::insert(sigint_inbox_item::ActiveModel {
            id: Set(id),
            date: Set(message.date.clone()),
            time: Set(message.time.clone()),
            freq: Set(freq),
            coords: Set(coords_s.map(|x| x.text)),
            callsigns: Set(Some(
                serde_json::to_value(
                    &message
                        .callsigns
                        .iter()
                        .map(|x| x.to_lowercase().trim().to_string())
                        .collect::<Vec<String>>(),
                )
                .context(h!())?,
            )),
            checked: Set(Some(message.checked)),
            reviewed: Set(Some(true)),
            unit: Set(message.unit.clone()),
            callsign_tokens: Set(Some(
                serde_json::to_value(&message.callsign_tokens).context(h!())?,
            )),
            keyword_tokens: Set(Some(
                serde_json::to_value(&message.keyword_tokens).context(h!())?,
            )),
            lat: Set(lat),
            lng: Set(lng),
            nominatimres_id: Set(None),
            location: Set(location),
            location_v2: Set(location_v2),
            tags: Set(Some(
                serde_json::to_value(message.tags.clone()).context(h!())?,
            )),
            callsigns_alg1: NotSet,
            callsigns_alg2: NotSet,
            signal_tokens: NotSet,
            datetime: NotSet,
            body_noheader: NotSet,
            post_id: Set(message.post_id),
            unit_v2: Set(message.unit.clone()),
            parsed_unit_v2: Set(true),
        })
        .on_conflict(
            sea_query::OnConflict::column(sigint_inbox_item::Column::Id)
                .update_columns([
                    sigint_inbox_item::Column::Date,
                    sigint_inbox_item::Column::Time,
                    sigint_inbox_item::Column::Freq,
                    sigint_inbox_item::Column::Coords,
                    sigint_inbox_item::Column::Callsigns,
                    sigint_inbox_item::Column::Checked,
                    sigint_inbox_item::Column::Reviewed,
                    sigint_inbox_item::Column::Unit,
                    sigint_inbox_item::Column::UnitV2,
                    sigint_inbox_item::Column::ParsedUnitV2,
                    sigint_inbox_item::Column::CallsignTokens,
                    sigint_inbox_item::Column::KeywordTokens,
                    sigint_inbox_item::Column::Lat,
                    sigint_inbox_item::Column::Lng,
                    sigint_inbox_item::Column::Location,
                    sigint_inbox_item::Column::LocationV2,
                    sigint_inbox_item::Column::Tags,
                    sigint_inbox_item::Column::PostId,
                ])
                .to_owned(),
        )
        .exec(txn)
        .await?;
    let inbox_id = insert_res.last_insert_id;
    crate::location::peleng::delete_inbox_pelengs(inbox_id, txn).await?;
    crate::location::peleng::insert_pelengs(
        coords_vec,
        inbox_id,
        Utc::now().naive_utc(),
        txn,
    )
    .await?;
    Ok(inbox_id)
}
