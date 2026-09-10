use crate::config::TAG_MINIMUM_CONFIDENCE;
use crate::entities::{prelude::*, *};
use crate::rer_importer::types::*;
use milgeo_rs::coordinates::{is_wgs84_ok, parse_latlng_f64, Coords, Wgs84};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use crate::error::AppError;
use crate::location::utils;
use crate::location::utils::to_location_list;
use crate::location::{CoordinateWithLocality, LocalityDetails};
use crate::messenger::group::types::SignalGroupEntry;
use crate::messenger::group::{collect_groups, CollectGroupsOpts};
use crate::palitra::bl::collect_accessible_palitra_ids;
use crate::rer_importer::collect_profiles_data;
use crate::rer_importer::highlight::*;
use crate::rer_importer::inbox::query::{
    build_inbox_map_query, build_inbox_settlement_ids_query,
    inbox_results_reverse_query_order,
};
use crate::rer_importer::signals::*;
use crate::sigint::sender::preferred_group_sender_expr;
use crate::storage::mk_media_url;
use crate::types::*;
use crate::utils::string::*;
use chrono::Utc;
use geoconvert::{LatLon, Mgrs};
use itertools::Itertools;
use sea_orm::*;
use sea_query::Expr;
use sqlx::Row;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InboxLocationSubmitMode {
    PreserveTyped,
    Parse,
}

#[derive(Debug, FromQueryResult)]
pub struct InboxMessageDesc {
    pub id: i64,
    pub id_uuid: Option<uuid::Uuid>,
    pub message_uid: Option<String>,
    pub body: Option<String>,
    pub timestamp: Option<NaiveDateTime>,
    pub created_at: NaiveDateTime,
    pub sender: Option<String>,
    pub freq: Option<String>,
    pub coords: Option<String>,
    pub callsign_tokens: Option<serde_json::Value>,
    pub signal_tokens: Option<serde_json::Value>,
    #[allow(dead_code)]
    pub keyword_tokens: Option<serde_json::Value>,
    pub location: Option<String>,
    pub location_v2: Option<String>,
    pub date: Option<String>,
    pub time: Option<String>,
    pub checked: Option<bool>,
    pub unit_v2: Option<String>,
    pub network: Option<String>,
    pub device_name: Option<String>,
    pub post_id: Option<i64>,
    pub post_name: Option<String>,
    #[allow(dead_code)]
    #[deprecated(note = "This field is deprecated; use `inbox_tags` instead.")]
    pub tags: Option<Vec<i64>>,
    pub inbox_tags: Option<serde_json::Value>,
    pub metadata: Option<serde_json::Value>,
}

#[derive(Default)]
struct IntelligenceReportSummaries {
    parents_by_message: HashMap<i64, Vec<InboxMessageSummary>>,
    reports_by_message: HashMap<i64, Vec<InboxMessageSummary>>,
}

fn reference_inbox_message_summary(
    message_id: i64,
    is_accessible: bool,
    is_deleted: bool,
    timestamp: Option<i64>,
    date: Option<String>,
    time: Option<String>,
    group_name: Option<String>,
) -> InboxMessageSummary {
    let (timestamp, date, time, group_name) = if is_deleted {
        (None, None, None, None)
    } else {
        (timestamp, date, time, group_name)
    };
    InboxMessageSummary {
        id: message_id,
        is_accessible,
        is_deleted,
        text: String::new(),
        attachments_count: 0,
        timestamp,
        date,
        time,
        group_name,
        group_master_key: None,
        coords: None,
        media_file_names: Vec::new(),
    }
}

fn inbox_message_summary(
    message_id: i64,
    is_accessible: bool,
    messages: &HashMap<i64, signal_message::Model>,
    inbox_items: &HashMap<i64, sigint_inbox_item::Model>,
    group_names: &HashMap<i64, String>,
    group_master_keys: &HashMap<i64, String>,
    attachment_counts: &HashMap<i64, i64>,
    media_file_names: &HashMap<i64, Vec<String>>,
) -> Option<InboxMessageSummary> {
    let message = messages.get(&message_id)?;
    let inbox_item = inbox_items.get(&message_id);
    let timestamp = message
        .timestamp
        .map(|timestamp| timestamp.and_utc().timestamp_millis());
    let date = inbox_item.and_then(|item| item.date.clone());
    let time = inbox_item.and_then(|item| item.time.clone());
    let group_name = group_names.get(&message_id).cloned();
    let coords = inbox_item.and_then(|item| item.coords.clone());
    let file_names = media_file_names
        .get(&message_id)
        .cloned()
        .unwrap_or_default();
    if message.deleted || !is_accessible {
        return Some(reference_inbox_message_summary(
            message_id,
            is_accessible,
            message.deleted,
            timestamp,
            date,
            time,
            group_name,
        ));
    }
    Some(InboxMessageSummary {
        id: message_id,
        is_accessible: true,
        is_deleted: false,
        text: message.body.clone().unwrap_or_default(),
        attachments_count: attachment_counts
            .get(&message_id)
            .copied()
            .unwrap_or_default(),
        timestamp,
        date,
        time,
        group_name,
        group_master_key: group_master_keys.get(&message_id).cloned(),
        coords,
        media_file_names: file_names,
    })
}

async fn load_attachment_info(
    message_ids: &HashSet<i64>,
    dbx: &DatabaseConnection,
) -> Result<(HashMap<i64, i64>, HashMap<i64, Vec<String>>), AppError> {
    let rows = signal_message_media::Entity::find()
        .filter(
            signal_message_media::Column::SignalMessageId
                .is_in(message_ids.iter().copied()),
        )
        .all(dbx)
        .await
        .c(h!())?;

    let mut counts = HashMap::new();
    let mut names: HashMap<i64, Vec<String>> = HashMap::new();
    for row in rows {
        *counts.entry(row.signal_message_id).or_insert(0) += 1;
        if let Some(file_name) = row.file_name {
            let trimmed = file_name.trim();
            if !trimmed.is_empty() {
                names
                    .entry(row.signal_message_id)
                    .or_default()
                    .push(trimmed.to_string());
            }
        }
    }
    Ok((counts, names))
}

async fn load_intelligence_report_summaries(
    message_ids: &[i64],
    allowed_groups: &[String],
    login: &uuid::Uuid,
    organism_logins: &[uuid::Uuid],
    dbx: &DatabaseConnection,
) -> Result<IntelligenceReportSummaries, AppError> {
    if message_ids.is_empty() {
        return Ok(IntelligenceReportSummaries::default());
    }
    let links = intel_product::Entity::find()
        .filter(intel_product::relation_kind_is_in([
            intel_product::RELATION_KIND_REPORT,
            intel_product::RELATION_KIND_COMMENT,
        ]))
        .filter(
            Condition::any()
                .add(
                    intel_product::Column::IntelMessageId
                        .is_in(message_ids.to_vec()),
                )
                .add(
                    intel_product::Column::SourceMessageId
                        .is_in(message_ids.to_vec()),
                ),
        )
        .order_by_asc(intel_product::Column::CreatedAt)
        .order_by_asc(intel_product::Column::IntelMessageId)
        .all(dbx)
        .await
        .c(h!())?;
    if links.is_empty() {
        return Ok(IntelligenceReportSummaries::default());
    }

    let related_ids = links
        .iter()
        .flat_map(|link| [link.intel_message_id, link.source_message_id])
        .collect::<HashSet<_>>();
    let messages = signal_message::Entity::find()
        .filter(signal_message::Column::Id.is_in(related_ids.iter().copied()))
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|message| (message.id, message))
        .collect::<HashMap<_, _>>();
    let datasource_group_ids = messages
        .values()
        .filter_map(|message| message.datasource_group_id)
        .collect::<HashSet<_>>();
    let datasource_groups = datasource_group::Entity::find()
        .filter(datasource_group::Column::Id.is_in(datasource_group_ids))
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|group| (group.id, group))
        .collect::<HashMap<_, _>>();
    let inbox_items = sigint_inbox_item::Entity::find()
        .filter(
            sigint_inbox_item::Column::Id.is_in(related_ids.iter().copied()),
        )
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|item| (item.id, item))
        .collect::<HashMap<_, _>>();
    let (attachment_counts, media_file_names) =
        load_attachment_info(&related_ids, dbx).await.c(h!())?;
    let group_rows = signal_message_group::Entity::find()
        .filter(
            signal_message_group::Column::SignalMessageId
                .is_in(related_ids.iter().copied()),
        )
        .order_by_asc(signal_message_group::Column::Id)
        .all(dbx)
        .await
        .c(h!())?;
    let mut group_master_keys = group_rows
        .iter()
        .filter_map(|group| group.group_master_key.clone())
        .collect::<HashSet<_>>();
    group_master_keys.extend(
        datasource_groups
            .values()
            .map(|group| group.group_master_key.clone()),
    );
    let group_names_by_master_key = signal_group::Entity::find()
        .filter(signal_group::Column::MasterKey.is_in(group_master_keys))
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|group| {
            let name = group.name.unwrap_or_else(|| group.master_key.clone());
            (group.master_key, name)
        })
        .collect::<HashMap<_, _>>();
    let allowed_groups = allowed_groups.iter().collect::<HashSet<_>>();
    let mut grouped_message_ids = HashSet::new();
    let mut group_names = HashMap::new();
    let mut accessible_group_master_keys = HashMap::new();
    for group in group_rows {
        grouped_message_ids.insert(group.signal_message_id);
        let Some(group_master_key) = group.group_master_key else {
            continue;
        };
        let group_name =
            group_names_by_master_key.get(&group_master_key).cloned();
        if allowed_groups.contains(&group_master_key)
            && !accessible_group_master_keys
                .contains_key(&group.signal_message_id)
        {
            if let Some(group_name) = group_name {
                group_names.insert(group.signal_message_id, group_name);
            }
            accessible_group_master_keys
                .entry(group.signal_message_id)
                .or_insert(group_master_key);
        } else if let Some(group_name) = group_name {
            group_names
                .entry(group.signal_message_id)
                .or_insert(group_name);
        }
    }
    for message in messages.values() {
        let Some(datasource_group_id) = message.datasource_group_id else {
            continue;
        };
        grouped_message_ids.insert(message.id);
        let Some(datasource_group) =
            datasource_groups.get(&datasource_group_id)
        else {
            continue;
        };
        if allowed_groups.contains(&datasource_group.group_master_key) {
            accessible_group_master_keys
                .entry(message.id)
                .or_insert_with(|| datasource_group.group_master_key.clone());
            if let Some(group_name) = group_names_by_master_key
                .get(&datasource_group.group_master_key)
                .cloned()
            {
                group_names.entry(message.id).or_insert(group_name);
            }
        }
    }

    let owner_sender_ids = organism_logins
        .iter()
        .chain(std::iter::once(login))
        .map(ToString::to_string)
        .collect::<HashSet<_>>();
    let owner_message_ids = messages
        .values()
        .filter(|message| {
            let is_owner = message
                .sender
                .as_ref()
                .is_some_and(|sender| owner_sender_ids.contains(sender))
                || message.login_id.is_some_and(|login_id| {
                    owner_sender_ids.contains(&login_id.to_string())
                });
            message.datasource_group_id.is_none()
                && !grouped_message_ids.contains(&message.id)
                && is_owner
        })
        .map(|message| message.id)
        .collect::<HashSet<_>>();

    let requested_ids = message_ids.iter().copied().collect::<HashSet<_>>();
    let mut summaries = IntelligenceReportSummaries::default();
    for link in links {
        let parent_is_accessible = accessible_group_master_keys
            .contains_key(&link.source_message_id)
            || owner_message_ids.contains(&link.source_message_id);
        let message_is_deleted = messages
            .get(&link.intel_message_id)
            .is_none_or(|message| message.deleted);

        if link.relation_kind == intel_product::RELATION_KIND_COMMENT {
            if requested_ids.contains(&link.intel_message_id) {
                if let Some(parent) = inbox_message_summary(
                    link.source_message_id,
                    parent_is_accessible,
                    &messages,
                    &inbox_items,
                    &group_names,
                    &accessible_group_master_keys,
                    &attachment_counts,
                    &media_file_names,
                ) {
                    summaries
                        .parents_by_message
                        .entry(link.intel_message_id)
                        .or_default()
                        .push(parent);
                }
            }
            if requested_ids.contains(&link.source_message_id)
                && !message_is_deleted
                && parent_is_accessible
            {
                if let Some(linked_message) = inbox_message_summary(
                    link.intel_message_id,
                    true,
                    &messages,
                    &inbox_items,
                    &group_names,
                    &accessible_group_master_keys,
                    &attachment_counts,
                    &media_file_names,
                ) {
                    summaries
                        .reports_by_message
                        .entry(link.source_message_id)
                        .or_default()
                        .push(linked_message);
                }
            }
            continue;
        }

        if requested_ids.contains(&link.intel_message_id) {
            if let Some(parent) = inbox_message_summary(
                link.source_message_id,
                parent_is_accessible,
                &messages,
                &inbox_items,
                &group_names,
                &accessible_group_master_keys,
                &attachment_counts,
                &media_file_names,
            ) {
                summaries
                    .parents_by_message
                    .entry(link.intel_message_id)
                    .or_default()
                    .push(parent);
            }
        }
        let report_is_accessible = accessible_group_master_keys
            .contains_key(&link.intel_message_id)
            || !grouped_message_ids.contains(&link.intel_message_id)
            || parent_is_accessible;
        if requested_ids.contains(&link.source_message_id)
            && !message_is_deleted
        {
            if let Some(report) = inbox_message_summary(
                link.intel_message_id,
                report_is_accessible,
                &messages,
                &inbox_items,
                &group_names,
                &accessible_group_master_keys,
                &attachment_counts,
                &media_file_names,
            ) {
                summaries
                    .reports_by_message
                    .entry(link.source_message_id)
                    .or_default()
                    .push(report);
            }
        }
    }
    Ok(summaries)
}

async fn load_coords_with_locality(
    message_ids: &[i64],
    env: &Env,
) -> Result<HashMap<i64, Vec<CoordinateWithLocality>>, AppError> {
    let pelengs = sigint_peleng::Entity::find()
        .filter(sigint_peleng::Column::SourceInboxItemId.eq_any(message_ids))
        .filter(sigint_peleng::Column::Deleted.eq(false))
        .order_by_asc(sigint_peleng::Column::Id)
        .all(&env.dbx)
        .await
        .c(h!())?;
    let mut coords_by_id = BTreeMap::new();
    let mut pelengs_by_message: HashMap<
        i64,
        Vec<(sigint_peleng::Model, GeoCoordinates)>,
    > = HashMap::new();
    for peleng in pelengs {
        let coords = GeoCoordinates {
            lat: peleng.lat,
            lon: peleng.lng,
        };
        pelengs_by_message
            .entry(peleng.source_inbox_item_id)
            .or_default()
            .push((peleng, coords));
    }
    let mut stored_localities = HashMap::new();
    for pelengs in pelengs_by_message.values() {
        for (peleng, coords) in pelengs {
            if let Some(locality) = stored_locality(peleng) {
                stored_localities.insert(peleng.id, locality);
            } else if peleng.settlement.as_deref() != Some("") {
                coords_by_id.insert(
                    peleng.id,
                    milgeo_rs::coord_util::LatLng {
                        lat: coords.lat,
                        lng: coords.lon,
                    },
                );
            }
        }
    }
    let mapped_coords =
        milgeo_rs::coord_util::map_coords(coords_by_id, env.mil_geo.clone(), 3)
            .await
            .c(h!())?;
    Ok(pelengs_by_message
        .into_iter()
        .map(|(message_id, coords)| {
            let coords = coords
                .into_iter()
                .map(|(peleng, coords)| CoordinateWithLocality {
                    coords,
                    locality: stored_localities
                        .get(&peleng.id)
                        .cloned()
                        .or_else(|| {
                            mapped_coords
                                .get(&peleng.id)
                                .and_then(|localities| localities.first())
                                .map(locality_details)
                        }),
                })
                .collect();
            (message_id, coords)
        })
        .collect())
}

fn stored_locality(peleng: &sigint_peleng::Model) -> Option<LocalityDetails> {
    Some(LocalityDetails {
        settlement_name: peleng.settlement.clone()?,
        direction: peleng.locality_direction.clone()?,
        distance_m: peleng.distance_m?,
        is_rf: peleng.country_code.as_deref() == Some("ru"),
    })
    .filter(|locality| !locality.settlement_name.is_empty())
}

fn locality_details(
    locality: &milgeo_rs::coord_util::Locality,
) -> LocalityDetails {
    LocalityDetails {
        settlement_name: locality.settlement_name.clone(),
        direction: locality.direction.clone(),
        distance_m: locality.distance_m,
        is_rf: locality.is_rf,
    }
}

async fn load_completed_audio_transcriptions(
    dbx: &DatabaseConnection,
    media: &[signal_message_media::Model],
) -> Result<HashMap<Uuid, String>, AppError> {
    let audio_media_ids = media
        .iter()
        .filter(|media| crate::messenger::media::is_audio_media(media))
        .map(|media| media.id)
        .collect::<Vec<_>>();
    if audio_media_ids.is_empty() {
        return Ok(HashMap::new());
    }
    if !crate::system_settings::audio_transcription_enabled(dbx)
        .await
        .c(h!())?
    {
        return Ok(HashMap::new());
    }

    crate::transcriber::completed_transcriptions(dbx, &audio_media_ids).await
}

pub async fn get_inbox_map_items(
    login: &uuid::Uuid,
    env: &Env,
    req: &InboxMessagesReq,
) -> Result<Vec<InboxMapItem>, AppError> {
    let q = build_inbox_map_query(login, env, req).await.c(h!())?;

    let query_res: Vec<QueryResult> = env
        .dbx
        .query_all_raw(Statement::from_string(DatabaseBackend::Postgres, q))
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

pub async fn get_inbox_map_settlements(
    login: &uuid::Uuid,
    env: &Env,
    req: &InboxMessagesReq,
) -> Result<Vec<MapSettlement>, AppError> {
    let filtered_ids = build_inbox_settlement_ids_query(login, env, req)
        .await
        .c(h!())?;
    let sql = format!(
        r#"
with filtered_items as ({filtered_ids})
select
    s.id as settlement_id,
    s.name,
    s.region,
    s.lat,
    s.lon,
    count(distinct link.item_id)::bigint as inbox_item_count
from filtered_items
join sigint_inbox_item_settlement link on link.item_id = filtered_items.id
join settlement s on s.id = link.settlement_id
where s.lat is not null
  and s.lon is not null
group by s.id, s.name, s.region, s.lat, s.lon
order by inbox_item_count desc, s.id
        "#
    );
    Ok(MapSettlement::find_by_statement(Statement::from_string(
        DatabaseBackend::Postgres,
        sql,
    ))
    .all(&env.dbx)
    .await
    .c(h!())?)
}

#[cfg(test)]
pub(crate) async fn get_inbox_map_settlements_for_items<C>(
    dbx: &C,
    inbox_item_ids: &[i64],
) -> Result<Vec<MapSettlement>, AppError>
where
    C: ConnectionTrait,
{
    if inbox_item_ids.is_empty() {
        return Ok(vec![]);
    }
    Ok(
        MapSettlement::find_by_statement(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
select
    s.id as settlement_id,
    s.name,
    s.region,
    s.lat,
    s.lon,
    count(distinct link.item_id)::bigint as inbox_item_count
from sigint_inbox_item_settlement link
join settlement s on s.id = link.settlement_id
where link.item_id = any($1::bigint[])
  and s.lat is not null
  and s.lon is not null
group by s.id, s.name, s.region, s.lat, s.lon
order by inbox_item_count desc, s.id
        "#,
            [inbox_item_ids.to_vec().into()],
        ))
        .all(dbx)
        .await
        .c(h!())?,
    )
}

pub(crate) async fn get_inbox_map_settlement_message_ids<C>(
    dbx: &C,
    filtered_ids: &str,
    settlement_id: i32,
    before_id_noninclusive: Option<i64>,
    limit: u64,
) -> anyhow::Result<Vec<i64>>
where
    C: ConnectionTrait,
{
    #[derive(FromQueryResult)]
    struct SettlementMessageId {
        item_id: i64,
    }

    let mut values = vec![settlement_id.into()];
    let cursor_condition =
        if let Some(before_id_noninclusive) = before_id_noninclusive {
            values.push(before_id_noninclusive.into());
            format!("and link.item_id < ${}", values.len())
        } else {
            String::new()
        };
    values.push(limit.into());
    let limit_parameter = values.len();
    let sql = format!(
        r#"
with filtered_items as ({filtered_ids})
select link.item_id
from sigint_inbox_item_settlement link
join filtered_items on filtered_items.id = link.item_id
where link.settlement_id = $1
  {cursor_condition}
group by link.item_id
order by link.item_id desc
limit ${limit_parameter}
        "#
    );
    Ok(
        SettlementMessageId::find_by_statement(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            sql,
            values,
        ))
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|row| row.item_id)
        .collect(),
    )
}

pub async fn aggregate_to_inbox_messages(
    login: &uuid::Uuid,
    messages: Vec<InboxMessageDesc>,
    logins: &Vec<uuid::Uuid>,
    req: &&InboxMessagesReq,
    env: &&Env,
) -> Result<Vec<(i64, InboxMessage)>, AppError> {
    let mut res: Vec<(i64, InboxMessage)> = vec![];
    let dbx_raw = env.dbx.get_postgres_connection_pool();

    let message_ids: Vec<i64> = messages.iter().map(|m| m.id).collect();
    let mut coords_with_locality =
        load_coords_with_locality(&message_ids, env).await.c(h!())?;
    let message_comments =
        crate::rer_importer::analysis::batch_message_comments_bl(
            &env.dbx,
            login,
            &message_ids,
        )
        .await
        .c(h!())?;
    let message_comments_by_id: HashMap<i64, Vec<MessageComment>> =
        message_comments
            .data
            .into_iter()
            .map(|entry| (entry.message_id, entry.comments))
            .collect();
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
        .filter(sigint_bookmark::Column::LoginId.eq(*login))
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
    let mut intelligence_report_summaries = load_intelligence_report_summaries(
        &message_ids,
        &sigint_groups,
        login,
        logins,
        &env.dbx,
    )
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
    if let Some(selected_senders) = req.selected_senders.as_ref() {
        if !selected_senders.is_empty() {
            group_query = group_query.filter(
                preferred_group_sender_expr(None)
                    .is_in(selected_senders.clone()),
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
    let mut message_unit_ids = load_message_unit_ids(&message_ids, &env.dbx)
        .await
        .c(h!())?;
    let media_entries = signal_message_media::Entity::find()
        .filter(
            signal_message_media::Column::SignalMessageId
                .eq_any(message_ids.clone()),
        )
        .order_by_asc(signal_message_media::Column::Id)
        .all(&env.dbx)
        .await
        .c(h!())?;
    let transcriptions_by_media =
        load_completed_audio_transcriptions(&env.dbx, &media_entries)
            .await
            .c(h!())?;
    let ocr_by_media =
        crate::ocr::load_media_summaries(&env.dbx, &media_entries)
            .await
            .c(h!())?;
    let summaries_by_media =
        crate::media_summary::load_statuses(&env.dbx, &media_entries)
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

    let highlight_keywords = req.highlight_keywords.unwrap_or(false);
    let keyword_set: Option<BTreeSet<String>> = if !highlight_keywords {
        None
    } else {
        match crate::organism::keyword_sets::try_resolve_viewer_organism_id(
            &env.dbx, login,
        )
        .await
        .c(h!())?
        {
            Some(oid) => {
                let words =
                    crate::organism::keyword_sets::resolve_inbox_keyword_words(
                        &env.dbx,
                        oid,
                        req.highlight_keyword_set_id,
                        true,
                    )
                    .await
                    .c(h!())?;
                if words.is_empty() {
                    None
                } else {
                    Some(keyword_set_from_words(&words))
                }
            }
            None => None,
        }
    };

    let highlight_points = req.highlight_points.unwrap_or(false);
    let mut palitra_points_by_message = if highlight_points {
        get_palitra_points_by_message(&env.dbx, *login, message_ids.clone())
            .await
            .context(h!())?
    } else {
        Default::default()
    };

    let comment_parsing_enabled =
        crate::system_settings::sigint_comment_parsing_enabled(&env.dbx)
            .await
            .c(h!())?;
    let mut normalized_callsigns =
        crate::inbox::callsigns::load_by_item_ids(&env.dbx, &message_ids)
            .await
            .c(h!())?;

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
                transcription: transcriptions_by_media.get(&m.id).cloned(),
                ocr: ocr_by_media.get(&m.id).cloned(),
                summary: summaries_by_media.get(&m.id).cloned(),
            })
            .collect_vec();
        let images = media
            .iter()
            .filter(|m| m.content_type.to_lowercase().starts_with("image/"))
            .map(mk_media_url)
            .collect_vec();
        let body = message.body.clone().unwrap_or("".to_string());
        let no_headers_body = if comment_parsing_enabled {
            crate::sigint::parser::extract_text_without_top_comment(&body)?
        } else {
            crate::rer_importer::body_noheader::extract_text(&body)?
        };
        let freq = message.freq.clone();
        let coords = message.coords.clone();
        let normalized_callsigns =
            normalized_callsigns.remove(&message.id).unwrap_or_default();
        let callsigns = normalized_callsigns.primary;
        let callsigns_alg2 = normalized_callsigns.alg2;
        let group_entry = groups_map.get(&message.id).and_then(|entries| {
            entries.iter().min_by_key(|(entry, _)| entry.id).cloned()
        });
        let sender = group_entry
            .as_ref()
            .and_then(|(entry, _)| entry.sender.clone())
            .or_else(|| message.sender.clone());
        let m_callsign_tokens: Option<Vec<CNCallsign>> =
            match message.callsign_tokens {
                None | Some(serde_json::Value::Null) => None,
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
        let metadata = match message.metadata {
            None => vec![],
            Some(jv) => serde_json::from_value::<Vec<InboxMessageMetadata>>(jv)
                .context(h!())?,
        };
        let inbox_tag_ids = m_inbox_tags
            .as_ref()
            .map(|tags| tags.iter().map(|tag| tag.tag_id).collect::<Vec<_>>());

        let m_point_tokens = if highlight_points {
            palitra_points_by_message.remove(&message.id)
        } else {
            None
        };

        let m_signal_tokens: Option<Vec<CNSignal>> = match message.signal_tokens
        {
            None => None,
            Some(jv) => Some(serde_json::from_value(jv).context(h!())?),
        };
        let m_keyword_tokens: Vec<CNHighlight> = match &keyword_set {
            Some(set) => extract_keywords_with_set(&body, set)?,
            None => vec![],
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
        let text_marked = highlight(
            &body,
            Some(&no_headers_body),
            &m_callsign_tokens.clone().unwrap_or_default(),
            &m_point_tokens.clone().unwrap_or_default(),
            &m_keyword_tokens,
            &m_signal_tokens.clone().unwrap_or_default(),
            ts_headline,
            HighlightOpts {
                highlight_callsigns: req.highlight_callsigns,
                highlight_keywords: req.highlight_keywords,
                highlight_points: req.highlight_points,
                highlight_signals: req.highlight_signals,
                highlight_searchres: req.highlight_searchres,
            },
        )?;
        let m_comment = find_editable_linked_message_comment(
            &env.dbx, message.id, login, logins,
        )
        .await
        .c(h!())?;
        let location = format_inbox_message_location(
            message.location,
            message.location_v2,
        );
        let network_ids = messages_networks.get(&message.id).cloned();

        res.push((
            message.id,
            InboxMessage {
                message_uuid: message.id_uuid.map(|uuid| uuid.to_string()),
                message_uid: message.message_uid,
                text: body.clone(),
                media: media_infos,
                images,
                image_recognized: vec![],
                date: message.date.clone(),
                time: message.time.clone(),
                freq: freq.clone(),
                coords,
                coords_with_locality: coords_with_locality
                    .remove(&message.id)
                    .unwrap_or_default(),
                callsigns,
                checked: message.checked.unwrap_or(false),
                important: important_ids.contains(&message.id),
                bookmarked: bookmarked_ids.contains(&message.id),
                timestamp: message
                    .timestamp
                    .map(|x| x.and_utc().timestamp_millis()),
                created_at: Some(
                    message.created_at.and_utc().timestamp_millis(),
                ),
                has_date_in_header: crate::rer_importer::body_noheader::leading_header_has_calendar_date(&body),
                group_master_key: group_entry
                    .as_ref()
                    .and_then(|(entry, _)| entry.group_master_key.clone()),
                sender,
                extended_form: m_comment.as_ref().map(|x| x.comment.clone()),
                message_comments: message_comments_by_id
                    .get(&message.id)
                    .cloned()
                    .unwrap_or_default(),
                unit: message.unit_v2.clone(),
                no_headers_body: Some(no_headers_body),
                callsign_tokens: m_callsign_tokens,
                point_tokens: m_point_tokens,
                keyword_tokens: None,
                signal_tokens: m_signal_tokens,
                text_marked: Some(text_marked),
                post: message.post_name.clone(),
                post_id: message.post_id,
                unit_ids: message_unit_ids
                    .remove(&message.id)
                    .unwrap_or_default(),
                datasource_id: group_entry
                    .as_ref()
                    .and_then(|(_, datasource_group)| datasource_group.as_ref())
                    .map(|dg| dg.datasource_id),
                location,
                tags: inbox_tag_ids,
                callsigns_alg2,
                network_ids,
                network_name: message.network,
                device_name: message.device_name,
                inbox_tags: m_inbox_tags,
                metadata,
                parent_messages: intelligence_report_summaries
                    .parents_by_message
                    .remove(&message.id)
                    .unwrap_or_default(),
                intelligence_reports: intelligence_report_summaries
                    .reports_by_message
                    .remove(&message.id)
                    .unwrap_or_default(),
            },
        ));
    }

    if inbox_results_reverse_query_order(req) {
        res.reverse();
    }

    Ok(res)
}

fn comment_ownership_logins(
    login: &uuid::Uuid,
    logins: &[uuid::Uuid],
) -> Vec<uuid::Uuid> {
    let mut res = vec![*login];
    for login in logins {
        if !res.contains(login) {
            res.push(*login);
        }
    }
    res
}

pub(crate) async fn find_editable_linked_message_comment<C>(
    db: &C,
    item_id: i64,
    login: &uuid::Uuid,
    logins: &[uuid::Uuid],
) -> Result<Option<crate::sigint::comments::LinkedMessageComment>, AppError>
where
    C: ConnectionTrait,
{
    let owner_logins = comment_ownership_logins(login, logins);
    Ok(
        crate::sigint::comments::find_linked_message_comments(db, &[item_id])
            .await
            .c(h!())?
            .into_iter()
            .filter(|comment| {
                comment.post_id.is_none()
                    && comment.login_id.is_some_and(|login_id| {
                        owner_logins.contains(&login_id)
                    })
            })
            .min_by_key(|comment| {
                (
                    comment.login_id != Some(*login),
                    comment.created_at,
                    comment.intel_message_id,
                )
            }),
    )
}

pub(crate) async fn upsert_existing_editable_linked_message_comment<C>(
    db: &C,
    item_id: i64,
    login: &uuid::Uuid,
    logins: &[uuid::Uuid],
    comment: &str,
) -> Result<bool, AppError>
where
    C: ConnectionTrait,
{
    let Some(existing) =
        find_editable_linked_message_comment(db, item_id, login, logins)
            .await
            .c(h!())?
    else {
        return Ok(false);
    };
    update_linked_message_comment(db, &existing, comment)
        .await
        .c(h!())?;
    delete_editable_linked_message_comment_duplicates(
        db, item_id, login, logins, &existing,
    )
    .await
    .c(h!())?;
    Ok(true)
}

pub(crate) async fn upsert_editable_linked_message_comment(
    db: &DatabaseTransaction,
    env: &Env,
    item_id: i64,
    login: &uuid::Uuid,
    logins: &[uuid::Uuid],
    comment: &str,
) -> Result<(), AppError> {
    if !upsert_existing_editable_linked_message_comment(
        db, item_id, login, logins, comment,
    )
    .await
    .c(h!())?
    {
        crate::sigint::comments::create_linked_message_comment(
            env, db, item_id, login, logins, comment, None, None,
        )
        .await
        .c(h!())?;
    }
    Ok(())
}

async fn update_linked_message_comment<C>(
    db: &C,
    comment: &crate::sigint::comments::LinkedMessageComment,
    text: &str,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    if let Some(legacy_comment_id) = comment.legacy_comment_id {
        let mut legacy_comment =
            sigint_comment::Entity::find_by_id(legacy_comment_id)
                .one(db)
                .await
                .c(h!())?
                .ok_or(AppError::NotFound)
                .c(h!())?
                .into_active_model();
        legacy_comment.comment = Set(text.to_string());
        legacy_comment.update(db).await.c(h!())?;
    } else {
        let mut message =
            signal_message::Entity::find_by_id(comment.intel_message_id)
                .one(db)
                .await
                .c(h!())?
                .ok_or(AppError::NotFound)
                .c(h!())?
                .into_active_model();
        message.body = Set(Some(text.to_string()));
        message.update(db).await.c(h!())?;
    }
    Ok(())
}

async fn delete_editable_linked_message_comment_duplicates<C>(
    db: &C,
    item_id: i64,
    login: &uuid::Uuid,
    logins: &[uuid::Uuid],
    retained: &crate::sigint::comments::LinkedMessageComment,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    let owner_logins = comment_ownership_logins(login, logins);
    let comments =
        crate::sigint::comments::find_linked_message_comments(db, &[item_id])
            .await
            .c(h!())?;
    for comment in comments.into_iter().filter(|comment| {
        comment.post_id.is_none()
            && comment
                .login_id
                .is_some_and(|login_id| owner_logins.contains(&login_id))
            && (comment.intel_message_id != retained.intel_message_id
                || comment.legacy_comment_id != retained.legacy_comment_id)
    }) {
        delete_linked_message_comment(db, &comment).await.c(h!())?;
    }
    Ok(())
}

async fn delete_linked_message_comment<C>(
    db: &C,
    comment: &crate::sigint::comments::LinkedMessageComment,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    if let Some(legacy_comment_id) = comment.legacy_comment_id {
        sigint_comment::Entity::delete_by_id(legacy_comment_id)
            .exec(db)
            .await
            .c(h!())?;
    } else {
        let message_id = comment.intel_message_id;
        crate::rer_importer::inbox::prepare_message_network_activity_change(
            db,
            message_id,
            &format!("deleted linked message comment {message_id}"),
        )
        .await
        .c(h!())?;
        let mut message = signal_message::Entity::find_by_id(message_id)
            .one(db)
            .await
            .c(h!())?
            .ok_or(AppError::NotFound)
            .c(h!())?
            .into_active_model();
        message.deleted = Set(true);
        message.update(db).await.c(h!())?;
    }
    Ok(())
}

pub(crate) async fn delete_editable_linked_message_comments<C>(
    db: &C,
    item_id: i64,
    login: &uuid::Uuid,
    logins: &[uuid::Uuid],
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    let owner_logins = comment_ownership_logins(login, logins);
    let comments =
        crate::sigint::comments::find_linked_message_comments(db, &[item_id])
            .await
            .c(h!())?;
    for comment in comments.into_iter().filter(|comment| {
        comment.post_id.is_none()
            && comment
                .login_id
                .is_some_and(|login_id| owner_logins.contains(&login_id))
    }) {
        delete_linked_message_comment(db, &comment).await.c(h!())?;
    }
    Ok(())
}

pub(crate) async fn find_editable_sigint_comments_by_signal_message_id_and_logins<
    'a,
    'async_trait,
    C,
>(
    db: &'a C,
    item_id: i64,
    login: &uuid::Uuid,
    logins: &[uuid::Uuid],
) -> Result<Vec<sigint_comment::Model>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let owner_logins = comment_ownership_logins(login, logins);
    let mut comments = sigint_comment::Entity::find()
        .filter(sigint_comment::Column::SignalMessageId.eq(item_id))
        .filter(sigint_comment::Column::LoginId.eq_any(owner_logins))
        .filter(sigint_comment::Column::SigintPostId.is_null())
        .all(db)
        .await
        .c(h!())?;

    comments.sort_by(|a, b| {
        let a_rank = if a.login_id == *login { 0 } else { 1 };
        let b_rank = if b.login_id == *login { 0 } else { 1 };
        a_rank
            .cmp(&b_rank)
            .then(a.created_at.cmp(&b.created_at))
            .then(a.id.cmp(&b.id))
    });

    Ok(comments)
}

#[allow(dead_code)]
pub(crate) async fn find_editable_sigint_comment_by_signal_message_id_and_logins<
    'a,
    'async_trait,
    C,
>(
    db: &'a C,
    item_id: i64,
    login: &uuid::Uuid,
    logins: &[uuid::Uuid],
) -> Result<Option<sigint_comment::Model>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    Ok(
        find_editable_sigint_comments_by_signal_message_id_and_logins(
            db, item_id, login, logins,
        )
        .await?
        .into_iter()
        .next(),
    )
}

pub(crate) async fn upsert_editable_sigint_comment<'a, 'async_trait, C>(
    db: &'a C,
    item_id: i64,
    signal_message_uuid: Option<uuid::Uuid>,
    login: &uuid::Uuid,
    logins: &[uuid::Uuid],
    comment: &str,
) -> Result<(), AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut comments =
        find_editable_sigint_comments_by_signal_message_id_and_logins(
            db, item_id, login, logins,
        )
        .await?;
    let Some(comment_to_update) = comments.first().cloned() else {
        sigint_comment::ActiveModel {
            id: NotSet,
            signal_message_id: Set(item_id),
            signal_message_uuid: Set(signal_message_uuid),
            login_id: Set(*login),
            comment: Set(comment.to_string()),
            created_at: NotSet,
            sigint_post_id: NotSet,
            migrated_signal_message_id: NotSet,
            migrated_signal_message_uuid: NotSet,
        }
        .insert(db)
        .await
        .c(h!())?;
        return Ok(());
    };

    sigint_comment::ActiveModel {
        id: Set(comment_to_update.id),
        signal_message_id: Set(item_id),
        signal_message_uuid: Set(comment_to_update.signal_message_uuid),
        login_id: Set(comment_to_update.login_id),
        comment: Set(comment.to_string()),
        created_at: NotSet,
        sigint_post_id: NotSet,
        migrated_signal_message_id: Set(
            comment_to_update.migrated_signal_message_id
        ),
        migrated_signal_message_uuid: Set(
            comment_to_update.migrated_signal_message_uuid
        ),
    }
    .update(db)
    .await
    .c(h!())?;

    comments.remove(0);
    delete_sigint_comments(db, comments).await
}

async fn delete_sigint_comments<'a, 'async_trait, C>(
    db: &'a C,
    comments: Vec<sigint_comment::Model>,
) -> Result<(), AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let comment_ids =
        comments.into_iter().map(|comment| comment.id).collect_vec();
    if comment_ids.is_empty() {
        return Ok(());
    }

    sigint_comment::Entity::delete_many()
        .filter(sigint_comment::Column::Id.eq_any(comment_ids))
        .exec(db)
        .await
        .c(h!())?;
    Ok(())
}

#[allow(dead_code)]
pub(crate) async fn delete_editable_sigint_comments<'a, 'async_trait, C>(
    db: &'a C,
    item_id: i64,
    login: &uuid::Uuid,
    logins: &[uuid::Uuid],
) -> Result<(), AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let comments =
        find_editable_sigint_comments_by_signal_message_id_and_logins(
            db, item_id, login, logins,
        )
        .await?;
    delete_sigint_comments(db, comments).await
}

#[allow(dead_code)]
pub(crate) async fn find_sigint_comment_by_signal_message_id_and_logins(
    env: &Env,
    item_id: i64,
    logins: &[uuid::Uuid],
) -> Result<Option<sigint_comment::Model>, AppError> {
    let login = logins.first().copied().unwrap_or_default();
    find_editable_sigint_comment_by_signal_message_id_and_logins(
        &env.dbx, item_id, &login, logins,
    )
    .await
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

pub(crate) async fn get_palitra_points_by_message(
    dbx: &DatabaseConnection,
    login: uuid::Uuid,
    message_ids: Vec<i64>,
) -> Result<HashMap<i64, Vec<CNPoint>>, AppError> {
    let palitra_ids = collect_accessible_palitra_ids(login, dbx)
        .await
        .context(h!())?;
    if palitra_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let palitra_points = sigint_inbox_item_point_token::Entity::find()
        .filter(
            sigint_inbox_item_point_token::Column::SigintInboxItemId
                .eq_any(message_ids),
        )
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item_point_token::Relation::Palitra.def(),
        )
        .filter(palitra::Column::Deleted.eq(false))
        .filter(palitra::Column::IsArchived.eq(false))
        .filter(palitra::Column::Id.eq_any(palitra_ids))
        .select_only()
        .column(sigint_inbox_item_point_token::Column::SigintInboxItemId)
        .column(sigint_inbox_item_point_token::Column::PalitraId)
        .column(sigint_inbox_item_point_token::Column::PointTokens)
        .into_tuple::<(i64, i64, serde_json::Value)>()
        .all(dbx)
        .await
        .context(h!())?;
    let point_palitra_ids = palitra_points
        .iter()
        .map(|(_, palitra_id, _)| *palitra_id)
        .unique()
        .collect();
    let blacklisted_labels =
        crate::palitra::highlight_blacklist::load_blacklisted_labels(
            dbx,
            point_palitra_ids,
        )
        .await
        .c(h!())?;
    let mut palitra_points_by_message: HashMap<i64, Vec<CNPoint>> =
        HashMap::new();
    for (sigint_inbox_item_id, palitra_id, points) in palitra_points {
        let mut points: Vec<CNPoint> = serde_json::from_value(points)
            .map_err(|e| anyhow::anyhow!("json convert error: {e}"))?;
        for point in &mut points {
            point.palitra_ids = vec![palitra_id];
        }
        crate::palitra::highlight_blacklist::filter_blacklisted_points(
            &blacklisted_labels,
            palitra_id,
            &mut points,
        );
        palitra_points_by_message
            .entry(sigint_inbox_item_id)
            .or_default()
            .append(&mut points);
    }
    for points in palitra_points_by_message.values_mut() {
        merge_point_palitra_ids(points);
    }
    Ok(palitra_points_by_message)
}

fn merge_point_palitra_ids(points: &mut Vec<CNPoint>) {
    points.sort_by(|a, b| {
        (&a.begin, &a.end, &a.etalon, &a.text)
            .cmp(&(&b.begin, &b.end, &b.etalon, &b.text))
    });

    let mut merged: Vec<CNPoint> = Vec::with_capacity(points.len());
    for mut point in points.drain(..) {
        if let Some(previous) = merged.last_mut().filter(|previous| {
            previous.begin == point.begin
                && previous.end == point.end
                && previous.etalon == point.etalon
                && previous.text == point.text
        }) {
            previous.palitra_ids.append(&mut point.palitra_ids);
        } else {
            merged.push(point);
        }
    }
    for point in &mut merged {
        point.palitra_ids.sort_unstable();
        point.palitra_ids.dedup();
    }
    *points = merged;
}

pub async fn load_messages_networks(
    messages: &Vec<InboxMessageDesc>,
    dbx: &DatabaseConnection,
) -> Result<HashMap<i64, Vec<i64>>, AppError> {
    let message_ids = messages.iter().map(|m| m.id).collect_vec();
    load_messages_networks_by_ids(&message_ids, dbx).await
}

async fn load_message_unit_ids(
    message_ids: &[i64],
    dbx: &DatabaseConnection,
) -> Result<HashMap<i64, Vec<i64>>, AppError> {
    let mut unit_ids_by_message = HashMap::<i64, BTreeSet<i64>>::new();
    for message_ids in message_ids.chunks(20000) {
        let links = sigint_inbox_item_unit::Entity::find()
            .join(
                JoinType::InnerJoin,
                sigint_inbox_item_unit::Relation::SigintUnit.def(),
            )
            .select_only()
            .column(sigint_inbox_item_unit::Column::ItemId)
            .column(sigint_inbox_item_unit::Column::UnitId)
            .filter(
                sigint_inbox_item_unit::Column::ItemId
                    .is_in(message_ids.to_vec()),
            )
            .filter(sigint_unit::Column::Deleted.eq(false))
            .into_tuple::<(i64, i64)>()
            .all(dbx)
            .await
            .c(h!())?;
        for (message_id, unit_id) in links {
            unit_ids_by_message
                .entry(message_id)
                .or_default()
                .insert(unit_id);
        }
    }
    Ok(unit_ids_by_message
        .into_iter()
        .map(|(message_id, unit_ids)| {
            (message_id, unit_ids.into_iter().collect())
        })
        .collect())
}

pub async fn load_messages_networks_by_ids(
    message_ids: &[i64],
    dbx: &DatabaseConnection,
) -> Result<HashMap<i64, Vec<i64>>, AppError> {
    if message_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let result = backfill_missing_messages_networks(message_ids, dbx)
        .await
        .context(h!())?;
    Ok(result)
}

async fn backfill_missing_messages_networks(
    message_ids: &[i64],
    dbx: &DatabaseConnection,
) -> Result<HashMap<i64, Vec<i64>>, AppError> {
    let mut result: HashMap<i64, Vec<i64>> = HashMap::new();
    let mut existing_message_ids = HashSet::new();
    let mut processed_message_networks = HashSet::new();
    for ids in message_ids.chunks(20000) {
        sigint_inbox_item_network::Entity::find()
            .select_only()
            .column(sigint_inbox_item_network::Column::SigintInboxItemId)
            .column(sigint_inbox_item_network::Column::SigintNetworkId)
            .filter(
                sigint_inbox_item_network::Column::SigintInboxItemId
                    .is_in(ids.to_vec()),
            )
            .into_tuple::<(i64, i64)>()
            .all(dbx)
            .await
            .context(h!())?
            .into_iter()
            .for_each(|(item_id, network_id)| {
                existing_message_ids.insert(item_id);
                if !processed_message_networks.insert((item_id, network_id)) {
                    return;
                }
                result.entry(item_id).or_default().push(network_id);
            });
    }
    let missing_message_ids = message_ids
        .iter()
        .filter(|id| !existing_message_ids.contains(id))
        .copied()
        .collect_vec();
    if missing_message_ids.is_empty() {
        return Ok(result);
    }

    let mut items_to_recalculate = vec![];
    for ids in missing_message_ids.chunks(20000) {
        sigint_inbox_item::Entity::find()
            .filter(sigint_inbox_item::Column::Id.is_in(ids.to_vec()))
            .all(dbx)
            .await
            .context(h!())?
            .into_iter()
            .for_each(|r| items_to_recalculate.push(r));
    }

    if items_to_recalculate.is_empty() {
        return Ok(result);
    }

    let new_entries = crate::sigint::network::etalon_calc::calculate_sigint_inbox_item_networks(
        items_to_recalculate,
        dbx,
    )
    .await
    .context(h!())?;
    for (id, ids) in new_entries {
        result.insert(id, ids.into_iter().unique().collect_vec());
    }
    Ok(result)
}

pub async fn load_inbox_callsigns(
    inbox_items: &Vec<(i64, InboxMessage)>,
    env: &Env,
) -> Result<Vec<CallsignInfoRes>, AppError> {
    let mut callsigns: HashMap<String, Vec<i64>> = HashMap::new();
    inbox_items
        .iter()
        .map(|(_id, item)| {
            let callsigns = item
                .callsigns
                .clone()
                .into_iter()
                .chain(item.callsigns_alg2.clone())
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
    env: &Env,
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
        env,
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
                battle_line_distance: point.battle_line_distance,
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
    login: &uuid::Uuid,
    logins: &Vec<uuid::Uuid>,
    location_mode: InboxLocationSubmitMode,
    parse_body_coordinates: bool,
    invalidate_body_derived_fields: bool,
) -> Result<i64, AppError> {
    let m_existing = SigintInboxItem::find_by_id(id).one(txn).await.c(h!())?;
    let existing_message = m_existing.is_some();
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
            "upsert request id = {id}; login = {login}; new value: {:?}; old value: {:?}",
            message, existing
        );
    }
    if existing_message {
        crate::rer_importer::inbox::prepare_message_network_activity_change(
            txn,
            id,
            &format!("updated inbox message {id}"),
        )
        .await
        .c(h!())?;
    }

    let submitted_coords =
        parse_submitted_coords(message.coords.as_deref()).await;

    let mut coords_vec = if parse_body_coordinates {
        match &message.no_headers_body.clone().map(|n| n.body) {
            Some(body) => {
                crate::rer_importer::coordinates::extract_coords(body).await
            }
            None => vec![],
        }
    } else {
        vec![]
    };
    for coord in &submitted_coords {
        if !coords_vec
            .iter()
            .any(|existing| existing.text == coord.text)
        {
            coords_vec.push(coord.clone());
        }
    }
    let peleng_bounds = crate::system_settings::get_active_peleng_bounds(txn)
        .await
        .c(h!())?;
    let coords_s = submitted_coords.into_iter().find(|coord| {
        crate::location::peleng::coord_matches_peleng_bounds(
            coord,
            peleng_bounds.as_ref(),
        )
    });
    let (lat, lng) = match coords_s.as_ref() {
        Some(coord) => (Some(coord.lat), Some(coord.lng)),
        None => (None, None),
    };
    let coords_vec = crate::location::peleng::filter_coords_by_peleng_bounds(
        coords_vec,
        peleng_bounds.as_ref(),
    );

    let freq = message
        .freq
        .as_ref()
        .map(|x| crate::rer_importer::frequency::etalon(x));
    let body_noheader = match message.no_headers_body.clone() {
        Some(body_noheader) => body_noheader,
        None => crate::rer_importer::body_noheader::extract_text(&message.text)
            .c(h!())?,
    };
    let signal_message_uuid =
        crate::sigint::message_id::find_signal_message_uuid(txn, id)
            .await
            .c(h!())?;
    // upsert sigint_comment
    if let Some(extended_form) = message.extended_form.as_ref() {
        if !upsert_existing_editable_linked_message_comment(
            txn,
            id,
            login,
            logins,
            extended_form,
        )
        .await
        .c(h!())?
        {
            upsert_editable_sigint_comment(
                txn,
                id,
                signal_message_uuid,
                login,
                logins,
                extended_form,
            )
            .await
            .c(h!())?;
        }
    }

    let location = message
        .location
        .clone()
        .map(|location| location.trim().to_string())
        .filter(|location| !location.is_empty());
    let location_v2 = resolve_manual_location_v2(
        settlements,
        txn,
        message,
        location.clone(),
        location_mode,
    )
    .await
    .c(h!())?;

    if invalidate_body_derived_fields {
        clear_body_derived_fields(txn, id, signal_message_uuid)
            .await
            .c(h!())?;
    }
    let datetime = crate::inbox::datetime::from_date_time_text(
        message.date.as_deref(),
        message.time.as_deref(),
    )
    .c(h!())?;

    let insert_res =
        sigint_inbox_item::Entity::insert(sigint_inbox_item::ActiveModel {
            id: Set(id),
            id_uuid: Set(signal_message_uuid),
            date: Set(message.date.clone()),
            time: Set(message.time.clone()),
            freq: Set(freq),
            coords: Set(coords_s.map(|x| x.text)),
            checked: Set(Some(message.checked)),
            reviewed: Set(Some(true)),
            unit: Set(message.unit.clone()),
            callsign_tokens: Set(message
                .callsign_tokens
                .as_ref()
                .map(serde_json::to_value)
                .transpose()
                .context(h!())?),
            keyword_tokens: Set(None),
            lat: Set(lat),
            lng: Set(lng),
            nominatimres_id: Set(None),
            location: Set(location),
            location_v2: Set(location_v2),
            tags: NotSet,
            signal_tokens: NotSet,
            datetime_old: NotSet,
            datetime: Set(datetime),
            body_noheader: Set(Some(
                serde_json::to_value(&body_noheader).context(h!())?,
            )),
            post_id: Set(message.post_id),
            device_name_id: Set(None),
            unit_v2: Set(message.unit.clone()),
            parsed_unit_v2: Set(true),
            network: Set(None),
        })
        .on_conflict(
            sea_query::OnConflict::column(sigint_inbox_item::Column::Id)
                .update_columns([
                    sigint_inbox_item::Column::Date,
                    sigint_inbox_item::Column::Time,
                    sigint_inbox_item::Column::Datetime,
                    sigint_inbox_item::Column::Freq,
                    sigint_inbox_item::Column::Coords,
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
                    sigint_inbox_item::Column::BodyNoheader,
                    sigint_inbox_item::Column::PostId,
                ])
                .to_owned(),
        )
        .exec(txn)
        .await
        .c(h!())?;
    let inbox_id = insert_res.last_insert_id;
    crate::inbox::unit_resolution::resolve_and_sync_inbox_item(
        txn,
        inbox_id,
        signal_message_uuid,
        message.unit.as_deref(),
        message.unit.as_deref(),
    )
    .await
    .c(h!())?;
    crate::rer_importer::inbox::metadata::refresh_metadata(inbox_id, txn)
        .await
        .c(h!())?;
    crate::tags::modify::upsert_tags(
        login,
        inbox_id,
        signal_message_uuid,
        message,
        txn,
    )
    .await
    .c(h!())?;
    crate::location::peleng::delete_inbox_pelengs(inbox_id, txn)
        .await
        .c(h!())?;
    crate::location::peleng::insert_pelengs(
        coords_vec,
        inbox_id,
        signal_message_uuid,
        Utc::now().naive_utc(),
        crate::rer_importer::pelengation_object::extract(&message.text),
        txn,
    )
    .await
    .c(h!())?;
    let new_item = sigint_inbox_item::Entity::find_by_id(inbox_id)
        .one(txn)
        .await
        .c(h!())?
        .c(h!())?;
    crate::battle_line::settlement_queue::reconcile_item_locations(
        txn,
        inbox_id,
        new_item.id_uuid,
        new_item.location_v2.as_deref(),
    )
    .await
    .c(h!())?;
    let existing_alg2 = if invalidate_body_derived_fields {
        Vec::new()
    } else {
        crate::inbox::callsigns::load_by_item_ids(txn, &[inbox_id])
            .await?
            .remove(&inbox_id)
            .unwrap_or_default()
            .alg2
    };
    let callsigns = crate::inbox::callsigns::InboxItemCallsigns {
        primary: crate::utils::uniq_via_btreeset(
            &message
                .callsigns
                .iter()
                .map(|callsign| callsign.to_lowercase().trim().to_string())
                .collect::<Vec<_>>(),
        ),
        alg2: existing_alg2,
    };
    crate::inbox::callsigns::sync(
        txn,
        inbox_id,
        new_item.id_uuid,
        callsigns,
        *login,
    )
    .await
    .c(h!())?;
    crate::sigint::network::etalon_calc::calculate_sigint_inbox_item_networks(
        vec![new_item],
        txn,
    )
    .await
    .c(h!())?;
    if existing_message {
        crate::stats::enqueue_group_stats_recalculation_for_message(
            txn,
            id,
            format!("updated inbox message {id}"),
        )
        .await
        .c(h!())?;
    }
    Ok(inbox_id)
}

async fn resolve_manual_location_v2(
    settlements: Arc<RwLock<crate::location::SettlementsDataConfig>>,
    txn: &DatabaseTransaction,
    message: &InboxMessage,
    location: Option<String>,
    location_mode: InboxLocationSubmitMode,
) -> Result<Option<String>, AppError> {
    let Some(location) = location else {
        return Ok(None);
    };
    if location_mode == InboxLocationSubmitMode::PreserveTyped {
        return Ok(Some(format_unvalidated_manual_location_v2(location)));
    }

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
    let locations = crate::location::parse_location_with_aor(
        settlements,
        location.clone(),
        m_aor_id,
    )
    .context(h!())?;
    Ok(Some(format_manual_location_v2(location, locations)))
}

async fn clear_body_derived_fields(
    txn: &DatabaseTransaction,
    inbox_id: i64,
    inbox_item_uuid: Option<uuid::Uuid>,
) -> Result<(), AppError> {
    sigint_inbox_item::Entity::update_many()
        .col_expr(
            sigint_inbox_item::Column::SignalTokens,
            Expr::value(Option::<serde_json::Value>::None),
        )
        .filter(sigint_inbox_item::Column::Id.eq(inbox_id))
        .exec(txn)
        .await
        .c(h!())?;
    sigint_inbox_item_point_token::Entity::delete_many()
        .filter(
            sigint_inbox_item_point_token::Column::SigintInboxItemId
                .eq(inbox_id),
        )
        .exec(txn)
        .await
        .c(h!())?;
    sigint_inbox_item_tag::Entity::delete_many()
        .filter(sigint_inbox_item_tag::Column::SigintInboxItemId.eq(inbox_id))
        .filter(sigint_inbox_item_tag::Column::Model.is_not_null())
        .exec(txn)
        .await
        .c(h!())?;
    tag_suggestion_worker_queue::Entity::insert(
        tag_suggestion_worker_queue::ActiveModel {
            sigint_inbox_item_id: Set(inbox_id),
        },
    )
    .on_conflict_do_nothing()
    .exec(txn)
    .await
    .c(h!())?;
    palitra_highlight_worker_job::Entity::insert(
        palitra_highlight_worker_job::ActiveModel {
            sigint_inbox_item_id: Set(inbox_id),
        },
    )
    .on_conflict_do_nothing()
    .exec(txn)
    .await
    .c(h!())?;
    crate::ai_callsign::worker::enqueue_if_enabled(
        txn,
        inbox_id,
        inbox_item_uuid,
    )
    .await
    .c(h!())?;
    crate::ai_settlement::worker::enqueue_if_enabled(txn, inbox_id)
        .await
        .c(h!())?;
    Ok(())
}

async fn parse_submitted_coords(coords: Option<&str>) -> Vec<Coords> {
    let Some(coords) =
        coords.map(str::trim).filter(|coords| !coords.is_empty())
    else {
        return vec![];
    };
    let mut result = vec![];

    for line in coords
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        if let Ok((lat, lng)) = parse_latlng_f64(line) {
            if let Some(coords) = coords_from_latlng(lat, lng) {
                result.push(coords);
            }
        }
    }

    for coord in crate::rer_importer::coordinates::extract_coords(coords).await
    {
        if !result
            .iter()
            .any(|existing: &Coords| existing.text == coord.text)
        {
            result.push(coord);
        }
    }

    result
}

fn coords_from_latlng(lat: f64, lng: f64) -> Option<Coords> {
    if !is_wgs84_ok(lat, lng) {
        return None;
    }

    let text = format!("{lat}, {lng}");
    let latlon = LatLon::create(lat, lng).ok()?;
    let mgrs = Mgrs::from_latlon(&latlon, 6).to_string();
    Some(Coords {
        text: text.clone(),
        lat,
        lng,
        mgrs,
        capture: text,
    })
}

fn format_manual_location_v2(
    location: String,
    locations: Vec<crate::location::SettlementDetails>,
) -> String {
    if locations.is_empty() {
        utils::format_locations_list(vec![location])
    } else {
        utils::format_settlements_list(locations)
    }
}

fn format_unvalidated_manual_location_v2(location: String) -> String {
    let locations = split_manual_locations(&location);
    if locations.is_empty() {
        return utils::format_locations_list(vec![location]);
    }
    utils::format_locations_list(locations)
}

pub(crate) fn format_inbox_message_location(
    location: Option<String>,
    location_v2: Option<String>,
) -> Option<String> {
    let location_v2 = location_v2
        .as_deref()
        .map(to_location_list)
        .unwrap_or_default();
    if !location_v2.is_empty() {
        return Some(location_v2.join(", "));
    }

    let location = location
        .as_deref()
        .map(split_manual_locations)
        .unwrap_or_default();
    if location.is_empty() {
        None
    } else {
        Some(location.join(", "))
    }
}

fn split_manual_locations(location: &str) -> Vec<String> {
    location
        .split(',')
        .map(|location| location.trim().to_string())
        .filter(|location| !location.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacted_intelligence_summary_exposes_only_safe_metadata() {
        let summary = reference_inbox_message_summary(
            42,
            false,
            false,
            Some(1_755_252_200_000),
            Some("2026-08-15".to_string()),
            Some("09:10".to_string()),
            Some("Група оригіналу".to_string()),
        );

        assert_eq!(summary.id, 42);
        assert!(!summary.is_accessible);
        assert!(!summary.is_deleted);
        assert!(summary.text.is_empty());
        assert_eq!(summary.attachments_count, 0);
        assert_eq!(summary.timestamp, Some(1_755_252_200_000));
        assert_eq!(summary.date.as_deref(), Some("2026-08-15"));
        assert_eq!(summary.time.as_deref(), Some("09:10"));
        assert_eq!(summary.group_name.as_deref(), Some("Група оригіналу"));
        assert_eq!(summary.group_master_key, None);
    }

    #[test]
    fn deleted_intelligence_summary_is_a_tombstone() {
        let summary = reference_inbox_message_summary(
            42,
            true,
            true,
            Some(1_755_252_200_000),
            Some("2026-08-15".to_string()),
            Some("09:10".to_string()),
            Some("Група оригіналу".to_string()),
        );

        assert!(summary.is_accessible);
        assert!(summary.is_deleted);
        assert!(summary.text.is_empty());
        assert_eq!(summary.attachments_count, 0);
        assert_eq!(summary.timestamp, None);
        assert_eq!(summary.date, None);
        assert_eq!(summary.time, None);
        assert_eq!(summary.group_name, None);
    }

    #[test]
    fn merge_point_palitra_ids_keeps_all_source_palitras() {
        let mut points = vec![
            CNPoint {
                begin: 1,
                end: 4,
                etalon: "Альфа".to_string(),
                text: "альфа".to_string(),
                palitra_ids: vec![9],
            },
            CNPoint {
                begin: 1,
                end: 4,
                etalon: "Альфа".to_string(),
                text: "альфа".to_string(),
                palitra_ids: vec![7, 9],
            },
        ];

        merge_point_palitra_ids(&mut points);

        assert_eq!(points.len(), 1);
        assert_eq!(points[0].palitra_ids, vec![7, 9]);
    }

    #[test]
    fn format_manual_location_v2_keeps_unmatched_manual_location() {
        assert_eq!(
            format_manual_location_v2("район 1".to_string(), vec![]),
            "|район 1|"
        );
    }

    #[test]
    fn format_unvalidated_manual_location_v2_preserves_typed_location() {
        assert_eq!(
            format_unvalidated_manual_location_v2("Робоботине".to_string()),
            "|Робоботине|"
        );
    }

    #[test]
    fn format_unvalidated_manual_location_v2_keeps_round_tripped_locations() {
        assert_eq!(
            format_unvalidated_manual_location_v2(
                "КУП'ЯНСЬК, СЕНЬКОВЕ".to_string()
            ),
            "|КУП'ЯНСЬК|СЕНЬКОВЕ|"
        );
    }

    #[test]
    fn format_unvalidated_manual_location_v2_does_not_fix_typos() {
        assert_eq!(
            format_unvalidated_manual_location_v2(
                "Запоріжя, Хирсон".to_string()
            ),
            "|Запоріжя|Хирсон|"
        );
    }

    #[test]
    fn format_manual_location_v2_uses_parsed_location_when_present() {
        assert_eq!(
            format_manual_location_v2(
                "Робоботине".to_string(),
                vec![crate::location::SettlementDetails {
                    name: "РОБОТИНЕ".to_string(),
                    ..Default::default()
                }],
            ),
            "|РОБОТИНЕ|"
        );
    }

    #[test]
    fn format_inbox_message_location_prefers_location_v2() {
        assert_eq!(
            format_inbox_message_location(
                Some("Робоботине".to_string()),
                Some("|РОБОТИНЕ|".to_string()),
            )
            .as_deref(),
            Some("РОБОТИНЕ")
        );
    }

    #[test]
    fn format_inbox_message_location_keeps_worker_appended_locations() {
        assert_eq!(
            format_inbox_message_location(
                Some("Робоботине".to_string()),
                Some("|Робоботине|НОВОПРОКОПІВКА|".to_string()),
            )
            .as_deref(),
            Some("Робоботине, НОВОПРОКОПІВКА")
        );
    }

    #[test]
    fn format_inbox_message_location_uses_location_v2_without_raw_merge() {
        assert_eq!(
            format_inbox_message_location(
                Some("ручний район".to_string()),
                Some("|НОВОПРОКОПІВКА|".to_string()),
            )
            .as_deref(),
            Some("НОВОПРОКОПІВКА")
        );
    }

    #[test]
    fn format_inbox_message_location_formats_location_v2() {
        assert_eq!(
            format_inbox_message_location(
                None,
                Some("|КУП'ЯНСЬК|СЕНЬКОВЕ|".to_string()),
            )
            .as_deref(),
            Some("КУП'ЯНСЬК, СЕНЬКОВЕ")
        );
    }

    #[test]
    fn format_inbox_message_location_falls_back_to_raw_location() {
        assert_eq!(
            format_inbox_message_location(
                Some("Запоріжя, Хирсон".to_string()),
                None,
            )
            .as_deref(),
            Some("Запоріжя, Хирсон")
        );
    }

    #[tokio::test]
    async fn parse_submitted_coords_keeps_decimal_wgs84() {
        let coords =
            parse_submitted_coords(Some("50.4494874, 30.6658124")).await;
        let coords = coords.first().unwrap();

        assert_eq!(coords.text, "50.4494874, 30.6658124");
        assert_eq!(coords.lat, 50.4494874);
        assert_eq!(coords.lng, 30.6658124);
    }

    #[tokio::test]
    async fn parse_submitted_coords_falls_back_to_main_parser_for_usk2000() {
        let coords = parse_submitted_coords(Some("52-20714 65-51696")).await;
        let coords = coords.first().unwrap();

        assert_eq!(coords.capture.trim(), "52-20714 65-51696");
        assert!((coords.lat - 47.11815353886478).abs() < 0.000001);
        assert!((coords.lng - 33.67970217653172).abs() < 0.000001);
    }

    #[tokio::test]
    async fn parse_submitted_coords_falls_back_for_invalid_integer_latlng() {
        let coords = parse_submitted_coords(Some("4494874 6658124")).await;
        let coords = coords.first().unwrap();

        assert_eq!(coords.capture.trim(), "4494874 6658124");
        assert!(is_wgs84_ok(coords.lat, coords.lng));
        assert_ne!(coords.text, "4494874, 6658124");
    }

    #[tokio::test]
    async fn parse_submitted_coords_keeps_all_decimal_wgs84_values() {
        let coords = parse_submitted_coords(Some(
            "50.4494874, 30.6658124\n49.12345, 37.12345",
        ))
        .await;

        assert_eq!(coords.len(), 2);
        assert_eq!(coords[0].text, "50.4494874, 30.6658124");
        assert_eq!(coords[1].text, "49.12345, 37.12345");
    }
}
