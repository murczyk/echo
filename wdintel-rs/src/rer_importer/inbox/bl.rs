use crate::config::TAG_MINIMUM_CONFIDENCE;
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
use crate::palitra::bl::{group_palitra_ids_by_scope, PalitraScopeKey};
use crate::rer_importer::collect_profiles_data;
use crate::rer_importer::highlight::*;
use crate::rer_importer::inbox::query::build_inbox_query;
use crate::rer_importer::points::{
    highlight_points, load_point_lexemes_by_palitra_ids,
};
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
use sea_query::{Expr, OnConflict};
use serde_json::json;
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
    env: &Env,
    req: &InboxMessagesReq,
) -> Result<Vec<InboxMapItem>, AppError> {
    let q = build_inbox_query(login, env, req).await.c(h!())?;
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

    let sigint_groups =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, login)
            .await
            .c(h!())?;
    let mut group_query = signal_message_group::Entity::find()
        .filter(
            signal_message_group::Column::SignalMessageId
                .eq_any(message_ids.clone()),
        )
        .filter(
            signal_message_group::Column::GroupMasterKey
                .eq_any(sigint_groups.clone()),
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

    let messages_networks = load_messages_networks(&messages, &env.dbx)
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

    let login_row = login::Entity::find()
        .filter(login::Column::Login.eq(login))
        .one(&env.dbx)
        .await
        .context(h!())?;
    let mut scope_keys = HashSet::new();
    scope_keys.insert(PalitraScopeKey::User(login.to_string()));
    if let Some(login_row) = login_row {
        if let Some(organism_id) = login_row.organism_id {
            scope_keys.insert(PalitraScopeKey::Organism(organism_id));
        }
    }
    if let Some(selected_aors) = &req.selected_aors {
        for &aor_id in selected_aors {
            scope_keys.insert(PalitraScopeKey::Aor(aor_id));
        }
    }
    let scope_groups = group_palitra_ids_by_scope(&env.dbx).await.c(h!())?;
    let mut scope_point_forms = Vec::new();
    let mut scope_pairs = Vec::new();
    for scope_key in scope_keys {
        let Some(palitra_ids) = scope_groups.get(&scope_key) else {
            continue;
        };
        if palitra_ids.is_empty() {
            continue;
        }
        let point_forms =
            load_point_lexemes_by_palitra_ids(&env.dbx, palitra_ids.clone())
                .await
                .context(h!())?;
        if point_forms.is_empty() {
            continue;
        }
        let (scope_type, scope_id) = match scope_key {
            PalitraScopeKey::User(login) => ("user".to_string(), Some(login)),
            PalitraScopeKey::Organism(organism_id) => {
                ("organism".to_string(), Some(organism_id.to_string()))
            }
            PalitraScopeKey::Aor(aor_id) => {
                ("aor".to_string(), Some(aor_id.to_string()))
            }
        };
        scope_pairs.push((scope_type.clone(), scope_id.clone()));
        scope_point_forms.push((scope_type, scope_id, point_forms));
    }
    let palitra_tag_id = tag::Entity::find()
        .filter(tag::Column::Label.eq("палітра"))
        .select_only()
        .column(tag::Column::Id)
        .into_tuple::<i64>()
        .one(&env.dbx)
        .await
        .context(h!())?;

    let mut scope_condition = Condition::any();
    for (scope_type, scope_id) in &scope_pairs {
        let mut pair_condition = Condition::all().add(
            sigint_inbox_item_point_tokens::Column::ScopeType.eq(scope_type),
        );
        pair_condition = match scope_id {
            Some(scope_id) => pair_condition.add(
                sigint_inbox_item_point_tokens::Column::ScopeId.eq(scope_id),
            ),
            None => pair_condition
                .add(sigint_inbox_item_point_tokens::Column::ScopeId.is_null()),
        };
        scope_condition = scope_condition.add(pair_condition);
    }
    let highlight_scope = if scope_pairs.len() == 1 {
        let (scope_type, scope_id) = &scope_pairs[0];
        match scope_type.as_str() {
            "user" => {
                scope_id.clone().map(|login| HighlightScope::User { login })
            }
            "organism" => scope_id
                .as_ref()
                .and_then(|id| id.parse().ok())
                .map(|organism_id| HighlightScope::Organism { organism_id }),
            "aor" => scope_id
                .as_ref()
                .and_then(|id| id.parse().ok())
                .map(|aor_id| HighlightScope::Aor { aor_id }),
            _ => None,
        }
    } else {
        None
    };
    let per_scope_tokens = sigint_inbox_item_point_tokens::Entity::find()
        .filter(scope_condition)
        .filter(
            sigint_inbox_item_point_tokens::Column::SigintInboxItemId
                .eq_any(message_ids),
        )
        .all(&env.dbx)
        .await
        .context(h!())?;
    let mut point_tokens_map: HashMap<i64, Vec<CNPoint>> = HashMap::new();
    let mut scope_tokens_map: HashMap<
        (i64, String, Option<String>),
        Vec<CNPoint>,
    > = HashMap::new();
    for row in per_scope_tokens {
        let point_tokens: Vec<CNPoint> =
            serde_json::from_value(row.point_tokens).context(h!())?;
        scope_tokens_map.insert(
            (
                row.sigint_inbox_item_id,
                row.scope_type.clone(),
                row.scope_id.clone(),
            ),
            point_tokens.clone(),
        );
        point_tokens_map
            .entry(row.sigint_inbox_item_id)
            .or_default()
            .extend(point_tokens);
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
        let without_model_tags = req.without_model_tags.unwrap_or(false);
        let m_inbox_tags: Option<Vec<InboxMessageTag>> =
            match message.inbox_tags {
                None => None,
                Some(jv) => Some(
                    serde_json::from_value::<Vec<InboxMessageTag>>(jv)
                        .context(h!())?
                        .into_iter()
                        .filter(|tag| {
                            tag.confidence >= TAG_MINIMUM_CONFIDENCE
                                && (!without_model_tags || tag.model.is_none())
                        })
                        .collect(),
                ),
            };
        let inbox_tag_ids = m_inbox_tags
            .as_ref()
            .map(|tags| tags.iter().map(|tag| tag.tag_id).collect::<Vec<_>>());
        let has_palitra_tag = palitra_tag_id.is_some_and(|tag_id| {
            inbox_tag_ids
                .as_ref()
                .map(|tags| tags.contains(&tag_id))
                .unwrap_or(false)
        });
        let mut m_point_tokens: Option<Vec<CNPoint>> =
            point_tokens_map.get(&message.id).cloned();

        if req.highlight_points.unwrap_or(false) && has_palitra_tag {
            for (scope_type, scope_id, point_forms) in &scope_point_forms {
                let scope_key =
                    (message.id, scope_type.clone(), scope_id.clone());
                if scope_tokens_map.contains_key(&scope_key) {
                    continue;
                }
                let tokens = crate::rer_importer::points::offset_point_tokens(
                    highlight_points(
                        &env.rq,
                        &no_headers_body.body,
                        point_forms,
                    )
                    .await
                    .c(h!())?,
                    no_headers_body.start,
                );
                if tokens.is_empty() {
                    continue;
                }
                let point_tokens_active_model =
                    sigint_inbox_item_point_tokens::ActiveModel {
                        sigint_inbox_item_id: Set(message.id),
                        scope_type: Set(scope_type.clone()),
                        scope_id: Set(scope_id.clone()),
                        point_tokens: Set(json!(tokens)),
                        ..Default::default()
                    };
                sigint_inbox_item_point_tokens::Entity::insert(
                    point_tokens_active_model,
                )
                .on_conflict(
                    OnConflict::columns([
                        sigint_inbox_item_point_tokens::Column::SigintInboxItemId,
                        sigint_inbox_item_point_tokens::Column::ScopeType,
                        sigint_inbox_item_point_tokens::Column::ScopeId,
                    ])
                    .do_nothing()
                    .to_owned(),
                )
                .exec(&env.dbx)
                .await
                .c(h!())?;
                scope_tokens_map.insert(scope_key, tokens.clone());
                point_tokens_map
                    .entry(message.id)
                    .or_default()
                    .extend(tokens);
            }
            m_point_tokens = point_tokens_map.get(&message.id).cloned();
        }
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
            &m_point_tokens.clone().unwrap_or_default(),
            &m_keyword_tokens.clone().unwrap_or_default(),
            &m_signal_tokens.clone().unwrap_or_default(),
            ts_headline,
            crate::rer_importer::highlight::HighlightOpts {
                highlight_callsigns: req.highlight_callsigns,
                highlight_keywords: req.highlight_keywords,
                highlight_points: req.highlight_points,
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
                point_tokens: m_point_tokens,
                highlight_scope: highlight_scope.clone(),
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
    dbx: &DatabaseConnection,
) -> Result<HashMap<i64, Vec<i64>>, AppError> {
    let message_ids = messages.iter().map(|m| m.id).collect_vec();
    if message_ids.is_empty() {
        return Ok(HashMap::new());
    }

    backfill_missing_messages_networks(&message_ids, dbx)
        .await
        .context(h!())?;

    let rows = sigint_inbox_item_network::Entity::find()
        .inner_join(sigint_network::Entity)
        .select_only()
        .column(sigint_inbox_item_network::Column::SigintInboxItemId)
        .column(sigint_inbox_item_network::Column::SigintNetworkId)
        .filter(
            sigint_inbox_item_network::Column::SigintInboxItemId
                .is_in(message_ids),
        )
        .filter(sigint_network::Column::Deleted.eq(false))
        .into_tuple::<(i64, i64)>()
        .all(dbx)
        .await
        .context(h!())?;

    let mut result: HashMap<i64, Vec<i64>> = HashMap::new();
    for (message_id, network_id) in rows {
        result.entry(message_id).or_default().push(network_id);
    }
    Ok(result)
}

async fn backfill_missing_messages_networks(
    message_ids: &[i64],
    dbx: &DatabaseConnection,
) -> Result<(), AppError> {
    let existing_message_ids = sigint_inbox_item_network::Entity::find()
        .select_only()
        .column(sigint_inbox_item_network::Column::SigintInboxItemId)
        .filter(
            sigint_inbox_item_network::Column::SigintInboxItemId
                .is_in(message_ids.to_vec()),
        )
        .into_tuple::<i64>()
        .all(dbx)
        .await
        .context(h!())?;
    let existing_message_ids =
        existing_message_ids.into_iter().collect::<HashSet<_>>();

    let missing_message_ids = message_ids
        .iter()
        .filter(|id| !existing_message_ids.contains(id))
        .copied()
        .collect_vec();
    if missing_message_ids.is_empty() {
        return Ok(());
    }

    let items_to_recalculate = sigint_inbox_item::Entity::find()
        .filter(sigint_inbox_item::Column::Id.is_in(missing_message_ids))
        .all(dbx)
        .await
        .context(h!())?;
    if items_to_recalculate.is_empty() {
        return Ok(());
    }

    crate::sigint::network::etalon_calc::calculate_sigint_inbox_item_networks(
        items_to_recalculate,
        dbx,
    )
    .await
    .context(h!())?;
    Ok(())
}

pub async fn load_inbox_callsigns(
    inbox_items: &Vec<(i64, InboxMessage)>,
    env: &Data<Env>,
) -> Result<Vec<CallsignInfoRes>, AppError> {
    let mut callsigns: HashMap<String, Vec<i64>> = HashMap::new();
    inbox_items
        .iter()
        .map(|(_id, item)| {
            let callsigns = item
                .callsigns
                .clone()
                .into_iter()
                .chain(item.callsigns_alg2.clone().into_iter())
                .unique()
                .collect_vec();
            (item.network_ids.clone(), callsigns)
        })
        .for_each(|(network_ids, callsigns_vec)| {
            if let Some(network_ids) = network_ids {
                for c in callsigns_vec {
                    callsigns
                        .entry(c.clone())
                        .and_modify(|ns| {
                            for network_id in &network_ids {
                                ns.push(*network_id)
                            }
                        })
                        .or_insert(network_ids.clone());
                }
            }
        });
    let mut callsigns_data = vec![];
    for (callsign, network_ids) in callsigns {
        callsigns_data.push(CallsignNetworks {
            network_ids: network_ids.into_iter().unique().collect_vec(),
            callsign,
        });
    }
    let data = crate::rer_importer::gdoc::load_callsigns(env, callsigns_data)
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
    settlements: Arc<RwLock<crate::location::SettlementsDataConfig>>,
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
    let m_aor_id = match message.group_master_key.clone() {
        Some(group_master_key) => signal_group_aor::Entity::find()
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
            .one(txn)
            .await
            .c(h!())?,
        None => None,
    };
    let location_v2 = match location.clone() {
        Some(location) => {
            let locations = crate::location::parse_location_with_aor(
                settlements.clone(),
                location,
                m_aor_id,
            )
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
    let new_item = sigint_inbox_item::Entity::find_by_id(inbox_id)
        .one(txn)
        .await
        .c(h!())?
        .c(h!())?;
    crate::sigint::network::etalon_calc::calculate_sigint_inbox_item_networks(
        vec![new_item],
        txn,
    )
    .await
    .c(h!())?;
    Ok(inbox_id)
}
