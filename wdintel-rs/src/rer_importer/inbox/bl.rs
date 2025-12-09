use crate::entities::{prelude::*, *};
use crate::rer_importer::types::*;
use milgeo_rs::coordinates::{
    parse_latlng_f64, rer_extract_coords, Coords, Wgs84,
};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use crate::error::AppError;
use crate::location::utils;
use crate::location::utils::to_location_list;
use crate::messenger::group::types::SignalGroupEntry;
use crate::messenger::group::{collect_groups, CollectGroupsOpts};
use crate::rer_importer::collect_profiles_data;
use crate::rer_importer::highlight::*;
use crate::rer_importer::inbox::query::build_inbox_query;
use crate::rer_importer::signals::*;
use crate::storage::mk_media_url;
use crate::types::*;
use crate::utils::orm::ArrayColumnOps;
use crate::utils::string::*;
use crate::utils::*;
use actix_web::web::Data;
use chrono::Utc;
use geoconvert::{LatLon, Mgrs};
use itertools::Itertools;
use log::*;
use sea_orm::*;
use sea_query::Expr;
use sqlx::Row;

#[derive(Debug, FromQueryResult)]
pub struct InboxMessageDesc {
    pub id: i64,
    pub message_uid: Option<String>,
    pub body: Option<String>,
    pub timestamp: Option<NaiveDateTime>,
    pub sender: Option<String>,
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
    #[allow(dead_code)]
    #[deprecated(note = "This field is deprecated; use `inbox_tags` instead.")]
    pub tags: Option<Vec<i64>>,
    pub inbox_tags: Option<serde_json::Value>,
}

pub async fn get_inbox_map_items(
    login: &str,
    logins: &Vec<String>,
    env: &Env,
    req: &InboxMessagesReq,
) -> Result<Vec<InboxMapItem>, AppError> {
    let q = build_inbox_query(login, logins, env, req).await.c(h!())?;
    let q = format!(
        r#"SELECT id, message_uid, "freq" as freq, "coords" as coords from ({q}) q"#
    );

    let query_res: Vec<QueryResult> = env
        .dbx
        .query_all(Statement::from_string(DatabaseBackend::Postgres, q))
        .await
        .context(h!())?;
    let mut result = vec![];
    for query_res in query_res {
        let id: i64 = query_res.try_get("", "id")?;
        let message_uid: Option<String> =
            query_res.try_get("", "message_uid")?;
        let freq: Option<String> = query_res.try_get("", "freq")?;
        let coords: Option<String> = query_res.try_get("", "coords")?;
        result.push(InboxMapItem {
            id,
            message_uid,
            freq,
            coords,
        });
    }
    Ok(result)
}

pub async fn aggregate_to_inbox_messages(
    login: &str,
    messages: Vec<InboxMessageDesc>,
    logins: &Vec<String>,
    req: &&InboxMessagesReq,
    env: &&Env,
) -> Result<Vec<(i64, InboxMessage)>, AppError> {
    let mut res: Vec<(i64, InboxMessage)> = vec![];
    let dbx_raw = env.dbx.get_postgres_connection_pool();

    let message_ids: Vec<i64> = messages.iter().map(|m| m.id).collect();
    let important_ids = sigint_important::Entity::find()
        .filter(
            sigint_important::Column::SignalMessageId
                .eq_any(message_ids.clone()),
        )
        .filter(sigint_important::Column::Deleted.eq(false))
        .all(&env.dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|imp| imp.signal_message_id)
        .collect::<HashSet<_>>();
    let bookmarked_ids = sigint_bookmark::Entity::find()
        .filter(
            sigint_bookmark::Column::SignalMessageId
                .eq_any(message_ids.clone()),
        )
        .filter(sigint_bookmark::Column::UserId.eq(login.to_string()))
        .filter(sigint_bookmark::Column::Deleted.eq(false))
        .all(&env.dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|bm| bm.signal_message_id)
        .collect::<HashSet<_>>();
    let tags = sigint_inbox_item_tag::Entity::find()
        .filter(
            sigint_inbox_item_tag::Column::SigintInboxItemId
                .eq_any(message_ids.clone()),
        )
        .into_model::<InboxMessageTagDesc>()
        .all(&env.dbx)
        .await
        .context(h!())?;

    let mut tags_map: HashMap<i64, Vec<InboxMessageTag>> = HashMap::new();
    for tag in tags {
        tags_map.entry(tag.sigint_inbox_item_id).or_default().push(
            InboxMessageTag {
                id: tag.id,
                tag_id: tag.tag_id,
                confidence: tag.confidence,
                login: tag.login,
                model: tag.model,
            },
        );
    }

    let mut group_query = signal_message_group::Entity::find().filter(
        signal_message_group::Column::SignalMessageId
            .eq_any(message_ids.clone()),
    );
    if let Some(selected_groups) = req.selected_groups.as_ref() {
        if !selected_groups.is_empty() {
            group_query = group_query.filter(
                signal_message_group::Column::GroupMasterKey
                    .eq_any(selected_groups.clone()),
            );
        }
    }

    let group_rows = group_query
        .find_with_related(datasource_group::Entity)
        .all(&env.dbx)
        .await
        .context(h!())?;

    let mut groups_map: HashMap<
        i64,
        Vec<(signal_message_group::Model, Option<datasource_group::Model>)>,
    > = HashMap::new();
    for (entry, related) in group_rows {
        let related_group = related.into_iter().next();
        groups_map
            .entry(entry.signal_message_id)
            .or_default()
            .push((entry, related_group));
    }

    let messages_networks =
        load_messages_networks(&messages, &groups_map, &env.dbx)
            .await
            .context(h!())?;
    let media_entries = signal_message_media::Entity::find()
        .filter(
            signal_message_media::Column::SignalMessageId
                .eq_any(message_ids.clone()),
        )
        .all(&env.dbx)
        .await
        .c(h!())?;
    let mut media_by_message: HashMap<i64, Vec<signal_message_media::Model>> =
        HashMap::new();
    for media in media_entries {
        media_by_message
            .entry(media.signal_message_id)
            .or_default()
            .push(media);
    }

    for message in messages {
        // for message in messages {
        // let m_inbox: Option<sigint_inbox_item::Model> =
        //     SigintInboxItem::find_by_id(message.id)
        //         .one(&env.dbx)
        //         .await.c(h!())?;
        let media = media_by_message
            .get(&message.id)
            .cloned()
            .unwrap_or_default();
        let media_infos = media
            .iter()
            .map(|m| MessageMediaInfo {
                id: m.id.to_string(),
                content_type: m.content_type.clone(),
                file_name: m.file_name.clone(),
                size_bytes: m.size_bytes,
                href: mk_media_url(m),
            })
            .collect_vec();
        let images = media
            .iter()
            .filter(|m| m.content_type.to_lowercase().starts_with("image/"))
            .map(mk_media_url)
            .collect_vec();
        let body = message.body.unwrap_or("".to_string());
        let no_headers_body =
            crate::rer_importer::body_noheader::extract_text(&body)?;
        let freq = message.freq.clone();
        let coords = message.coords.clone();
        let callsigns = match message.callsigns.as_ref() {
            Some(v) => serde_json::from_value(v.clone()).context(h!())?,
            None => vec![],
        };
        let group_entry = groups_map.get(&message.id).and_then(|entries| {
            entries.iter().min_by_key(|(entry, _)| entry.id).cloned()
        });
        let sender = group_entry
            .as_ref()
            .and_then(|(entry, _)| entry.sender.clone())
            .or_else(|| message.sender.clone());
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
                sqlx::query(
                    "select ts_headline('russian', $1, websearch_to_tsquery('russian', $2), 'HighlightAll=true') as headline from sigint_search where id=$3"
                )
                    .bind(body.clone().to_lowercase())
                    .bind(search.to_lowercase().clone())
                    .bind(message.id)
                    .fetch_one(dbx_raw)
                    .await
                    .ok()
                    .and_then(|row| row.try_get::<Option<String>, _>("headline").ok())
                    .flatten()
            }
        };
        let text_marked = crate::rer_importer::highlight::highlight(
            &body,
            Some(&no_headers_body),
            &m_callsign_tokens.clone().unwrap_or_default(),
            &m_keyword_tokens.clone().unwrap_or_default(),
            &m_signal_tokens.clone().unwrap_or_default(),
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
            .filter(sigint_comment::Column::Login.eq_any(logins.clone()))
            .one(&env.dbx)
            .await
            .c(h!())?;
        let location_v2 = match message.location_v2.clone() {
            None => None,
            Some(location) => Some(to_location_list(&location).join(", ")),
        };
        let network_ids = messages_networks.get(&message.id).cloned();
        let m_inbox_tags: Option<Vec<InboxMessageTag>> =
            match message.inbox_tags {
                None => None,
                Some(jv) => Some(serde_json::from_value(jv).context(h!())?),
            };
        let inbox_tag_ids = m_inbox_tags
            .as_ref()
            .map(|tags| tags.iter().map(|tag| tag.tag_id).collect::<Vec<_>>());

        res.push((
            message.id,
            InboxMessage {
                message_uid: message.message_uid,
                text: body.clone(),
                media: media_infos,
                images,
                image_recognized: vec![],
                date: message.date.clone(),
                time: message.time.clone(),
                freq: freq.clone(),
                coords,
                callsigns,
                checked: message.checked.unwrap_or(false),
                important: important_ids.contains(&message.id),
                bookmarked: bookmarked_ids.contains(&message.id),
                timestamp: message
                    .timestamp
                    .map(|x| x.and_utc().timestamp_millis()),
                group_master_key: group_entry
                    .as_ref()
                    .and_then(|(entry, _)| entry.group_master_key.clone()),
                sender,
                extended_form: m_comment.as_ref().map(|x| x.comment.clone()),
                unit: message.unit_v2.clone(),
                no_headers_body: Some(no_headers_body),
                callsign_tokens: m_callsign_tokens,
                keyword_tokens: m_keyword_tokens,
                signal_tokens: m_signal_tokens,
                text_marked: Some(text_marked),
                post: message.post_name.clone(),
                post_id: message.post_id,
                datasource_id: group_entry
                    .as_ref()
                    .and_then(|(_, datasource_group)| datasource_group.as_ref())
                    .map(|dg| dg.datasource_id),
                location: location_v2,
                tags: inbox_tag_ids,
                callsigns_alg2: from_m_val_vec(message.callsigns_alg2.clone())?,
                network_ids,
                inbox_tags: m_inbox_tags,
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
            .await
            .c(h!())?
            .is_some();
        if !is_already_filled {
            let lexemes =
                crate::nlp::token_lexemes(rq, callsign).await.c(h!())?;
            for lexeme in lexemes {
                callsign_lexeme::ActiveModel {
                    id: NotSet,
                    callsign: Set(callsign.to_string()),
                    lexeme: Set(lexeme),
                }
                .insert(txn)
                .await
                .c(h!())?;
            }
        }
    }
    Ok(())
}

pub async fn load_messages_networks(
    messages: &Vec<InboxMessageDesc>,
    groups_map: &HashMap<
        i64,
        Vec<(signal_message_group::Model, Option<datasource_group::Model>)>,
    >,
    dbx: &DatabaseConnection,
) -> Result<HashMap<i64, Vec<i64>>, AppError> {
    #[derive(Debug, FromQueryResult)]
    pub struct NetworkFreqResult {
        pub network_id: i64,
        pub freq: String,
    }

    // Step 1: Collect group_ids and freqs from messages
    let mut group_master_keys = HashSet::new();
    let mut freqs = HashSet::new();
    for msg in messages {
        if let Some(freq) = &msg.freq {
            freqs.insert(freq.clone());
        }
        if let Some(entries) = groups_map.get(&msg.id) {
            for (entry, _) in entries {
                if let Some(group_master_key) = entry.group_master_key.clone() {
                    group_master_keys.insert(group_master_key);
                }
            }
        }
    }

    // Step 2. Load groups bounds
    let groups_with_aors = signal_group_aor::Entity::find()
        .find_with_related(area_of_responsibility::Entity)
        .filter(
            signal_group_aor::Column::MasterKey
                .eq_any(group_master_keys.into_iter().collect()),
        )
        .filter(area_of_responsibility::Column::Deleted.eq(false))
        .all(dbx)
        .await
        .context(h!())?;

    let mut group_bounds_map: HashMap<String, Vec<(f64, f64)>> = HashMap::new();
    for (group_aor, aors) in groups_with_aors {
        for aor in aors {
            group_bounds_map
                .entry(group_aor.master_key.clone())
                .or_default()
                .push((aor.left_bound, aor.right_bound));
        }
    }

    // Step 3: Load network_freq + networks, collect network_ids
    let networks_freqs = sigint_network_freq::Entity::find()
        .inner_join(sigint_network::Entity)
        .select_only()
        .column(sigint_network_freq::Column::NetworkId)
        .column(sigint_network_freq::Column::Freq)
        .filter(
            sigint_network_freq::Column::Freq
                .eq_any(freqs.into_iter().collect()),
        )
        .filter(
            Condition::any()
                .add(sigint_network_freq::Column::ActiveTo.is_null())
                .add(
                    sigint_network_freq::Column::ActiveTo
                        .gte(Utc::now().naive_utc()),
                ),
        )
        .filter(sigint_network_freq::Column::Deleted.eq(false))
        .filter(sigint_network::Column::Deleted.eq(false))
        .filter(
            Condition::any()
                .add(sigint_network::Column::ActiveTo.is_null())
                .add(
                    sigint_network::Column::ActiveTo
                        .gte(Utc::now().naive_utc()),
                ),
        )
        .into_model::<NetworkFreqResult>()
        .all(dbx)
        .await
        .context(h!())?;

    let mut network_ids = HashSet::new();
    let mut freq_networks_map: HashMap<String, HashSet<i64>> = HashMap::new();
    for nf in networks_freqs {
        network_ids.insert(nf.network_id);
        freq_networks_map
            .entry(nf.freq)
            .or_default()
            .insert(nf.network_id);
    }

    // Step 5: Load AORs for networks
    let network_aors = sigint_network_aor::Entity::find()
        .find_with_related(area_of_responsibility::Entity)
        .filter(area_of_responsibility::Column::Deleted.eq(false))
        .filter(
            sigint_network_aor::Column::NetworkId
                .eq_any(network_ids.into_iter().collect()),
        )
        .all(dbx)
        .await
        .context(h!())?;

    let mut network_bounds_map: HashMap<i64, Vec<(f64, f64)>> = HashMap::new();
    for (na, aors) in network_aors {
        for aor in aors {
            network_bounds_map
                .entry(na.network_id)
                .or_default()
                .push((aor.left_bound, aor.right_bound));
        }
    }

    // Step 6: Match messages to networks
    let res = match_network_ids_for_messages(
        messages,
        groups_map,
        &group_bounds_map,
        &network_bounds_map,
        &freq_networks_map,
    )
    .context(h!())?;

    Ok(res)
}

fn match_network_ids_for_messages(
    messages: &Vec<InboxMessageDesc>,
    groups_map: &HashMap<
        i64,
        Vec<(signal_message_group::Model, Option<datasource_group::Model>)>,
    >,
    group_bounds_map: &HashMap<String, Vec<(f64, f64)>>,
    network_bounds_map: &HashMap<i64, Vec<(f64, f64)>>,
    freq_networks_map: &HashMap<String, HashSet<i64>>,
) -> Result<HashMap<i64, Vec<i64>>, AppError> {
    let mut result = HashMap::new();

    for msg in messages {
        let Some(entries) = groups_map.get(&msg.id) else {
            continue;
        };
        let Some(group_master_key) = entries
            .iter()
            .min_by_key(|(entry, _)| entry.id)
            .and_then(|(entry, _)| entry.group_master_key.clone())
        else {
            continue;
        };
        let Some(freq) = &msg.freq else { continue };

        let Some(group_bounds) = group_bounds_map.get(&group_master_key) else {
            continue;
        };

        let Some(candidate_networks) = freq_networks_map.get(freq) else {
            continue;
        };

        let mut matched = HashSet::new();

        for network_id in candidate_networks {
            if let Some(net_bounds) = network_bounds_map.get(network_id) {
                for (gl, gr) in group_bounds {
                    for (nl, nr) in net_bounds {
                        // 1. Group starts inside network
                        // Network: |----[nl=======nr]-------|
                        // Group:   |----------[gl=====gr]---|

                        // 2. Group ends inside network
                        // Network: |------[nl========nr]----|
                        // Group:   |--[gl======gr]----------|

                        // 3. Group covers network
                        // Network: |-------[nl==nr]---------|
                        // Group:   |---[gl===========gr]----|

                        if (gl >= nl && gl <= nr)                   // group left inside network
                            || (gr >= nl && gr <= nr)               // group right inside network
                            || (gl <= nl && gr >= nr)
                        // group fully covers network
                        {
                            matched.insert(*network_id);
                            break;
                        }
                    }
                }
            }
        }

        result.insert(msg.id, matched.into_iter().collect::<Vec<_>>());
    }

    Ok(result)
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
    let data = crate::rer_importer::gdoc::load_callsigns(env, callsigns)
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
    skip_group_stats: bool,
) -> Result<Vec<SignalGroupEntry>, AppError> {
    let callsigns = inbox_items
        .iter()
        .filter_map(|x| x.1.group_master_key.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect_vec();
    let data = collect_groups(
        callsigns,
        txn,
        is_admin,
        CollectGroupsOpts { skip_group_stats },
    )
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
                .eq_any(inbox_items.iter().map(|x| x.0).collect_vec()),
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
        let message_uid = item.message_uid;
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
                message_uid: message_uid.clone(),
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
    let m_existing = SigintInboxItem::find_by_id(id).one(txn).await.c(h!())?;
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
            "upsert request id = {id}; login = {login}; new value: {message:?}; old value: {existing:?}"
        );
    }

    let (lat, lng) = match message
        .coords
        .clone()
        .map(|c| parse_latlng_f64(&c.clone()[..]))
        .and_then(|x| x.ok())
    {
        None => (None, None),
        Some((lat, lng)) => (Some(lat), Some(lng)),
    };

    let coords_s = match (lat, lng) {
        (Some(lat), Some(lng)) => {
            let text = format!("{lat}, {lng}");
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
            .filter(sigint_comment::Column::Login.eq_any(logins.clone()))
            .one(txn)
            .await
            .c(h!())?;
        match m_comment {
            None => {
                debug!("> creating comment for message {id} by {login}: {extended_form}");
                sigint_comment::ActiveModel {
                    id: NotSet,
                    signal_message_id: Set(id),
                    login: Set(login.to_string()),
                    comment: Set(extended_form.clone()),
                    created_at: NotSet,
                }
                .insert(txn)
                .await
                .c(h!())?;
            }
            Some(comment) => {
                debug!(
                    "> updating comment for message {} by {}: old: {}, new: {}",
                    comment.signal_message_id,
                    login,
                    comment.comment,
                    extended_form
                );
                sigint_comment::ActiveModel {
                    id: Set(comment.id),
                    signal_message_id: Set(id),
                    login: Set(login.to_string()),
                    comment: Set(extended_form.clone()),
                    created_at: NotSet,
                }
                .update(txn)
                .await
                .c(h!())?;
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
                    message
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
            tags: NotSet,
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
                    sigint_inbox_item::Column::PostId,
                ])
                .to_owned(),
        )
        .exec(txn)
        .await
        .c(h!())?;
    let inbox_id = insert_res.last_insert_id;
    crate::tags::modify::upsert_tags(login, inbox_id, message, txn)
        .await
        .c(h!())?;
    crate::location::peleng::delete_inbox_pelengs(inbox_id, txn)
        .await
        .c(h!())?;
    crate::location::peleng::insert_pelengs(
        coords_vec,
        inbox_id,
        Utc::now().naive_utc(),
        txn,
    )
    .await
    .c(h!())?;
    Ok(inbox_id)
}
