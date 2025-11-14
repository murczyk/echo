use crate::config::*;
use crate::entities::*;
use crate::event_stream::fanout;
use crate::event_stream::types::*;
use crate::location::utils;
use crate::messenger::group::ensure_datasource_group_id;
use crate::rer_importer::multimessage::*;
use crate::types::*;
use crate::utils::pop_vector;
use chrono::prelude::*;
use chrono_tz::Europe::Kyiv;
use sea_orm::*;

const CAPACITY: usize = 2000;

pub async fn inbox_item_oneoff_nofail<'a, 'async_trait, C>(
    settlements: Arc<RwLock<crate::location::SettlementsData>>,
    txn: &'a C,
    rq: &reqwest::Client,
    config: &Config,
    redis: &mut redis::aio::ConnectionManager,
    message_id: i64,
    m_created_at: Option<(String, String)>,
) where
    C: ConnectionTrait + 'async_trait,
{
    let mut cache = TopKCache::<String, String>::new(CAPACITY);
    let mut recs = vec![message_id];
    while !recs.is_empty() {
        let Some(message_id) = recs.pop() else {
            break;
        };
        match inbox_item_worker_1(
            settlements.clone(),
            txn,
            rq,
            config,
            message_id,
            &mut cache,
            redis,
            m_created_at.clone(),
        )
        .await
        {
            Err(e) => {
                error!(
                    "> error while running inbox_item_oneoff_nofail: {e:#?}"
                );
            }
            Ok(new_recs) => {
                new_recs.iter().for_each(|rec| recs.push(*rec));
            }
        }
    }
}

async fn inbox_item_worker_1<'a, 'async_trait, C>(
    settlements: Arc<RwLock<crate::location::SettlementsData>>,
    txn: &'a C,
    rq: &reqwest::Client,
    config: &Config,
    message_id: i64,
    cache: &mut TopKCache<String, String>,
    redis: &mut redis::aio::ConnectionManager,
    m_created_at: Option<(String, String)>,
) -> Result<Vec<i64>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let message = signal_message::Entity::find_by_id(message_id)
        .filter(signal_message::Column::Deleted.eq(false))
        .one(txn)
        .await
        .c(h!())?
        .ok_or(format!("Couldn't find a message id={message_id}"))?;

    let body = message.body.clone().unwrap_or("".to_string());
    if should_try_split_message(&body) {
        let spawned = spawn_multiple_messages(txn, &message, &body)
            .await
            .c(h!())?;
        if !spawned.is_empty() {
            return Ok(spawned);
        }
    }

    let mut m_dt: Option<chrono::DateTime<chrono_tz::Tz>> =
        match super::datetime::extract_datetime(&body)? {
            None => None,
            Some(dt) => match Kyiv.from_local_datetime(&dt) {
                chrono::offset::LocalResult::None => {
                    println!("> warning: couldn't convert datetime to Kyiv timezone: {dt:?}; body: {body}");
                    None
                }
                chrono::offset::LocalResult::Single(v) => Some(v),
                chrono::offset::LocalResult::Ambiguous(v1, v2) => {
                    println!("> warning: couldn't convert datetime to Kyiv timezone (ambiguous): v1: {v1:?}, v2: {v2:?}; {dt:?}; body: {body}");
                    None
                }
            },
        };
    if m_dt.is_none() {
        if let Some(ref timestamp) = message.timestamp {
            let dt2: DateTime<Utc> =
                DateTime::from_naive_utc_and_offset(*timestamp, Utc);
            m_dt = Some(dt2.with_timezone(&Kyiv));
        };
    }
    let date_v = m_dt
        .as_ref()
        .map(|dt| format!("{}-{:02}-{:02}", dt.year(), dt.month(), dt.day()));
    let time_v = m_dt
        .as_ref()
        .map(|dt| format!("{:02}:{:02}", dt.hour(), dt.minute()));
    let datetime_from_body =
        m_dt.as_ref().map(|dt| dt.with_timezone(&Utc).naive_utc());
    let freq = super::frequency::extract_freq(&body)?
        .map(|v| crate::rer_importer::frequency::etalon(&v));
    let coords_vec = milgeo_rs::coordinates::rer_extract_coords(&body).await;
    let mut other_coords = coords_vec.clone();
    let coords = pop_vector(&mut other_coords);
    let callsign_tokens = super::callsigns::find_known_callsigns(rq, &body)
        .await
        .c(h!())?;
    let keyword_tokens = super::highlight::extract_keywords(&body)?;
    let callsigns: Vec<String> = crate::utils::uniq_via_btreeset(
        &callsign_tokens
            .iter()
            .map(|x| x.etalon.clone())
            .collect::<Vec<String>>(),
    );
    let checked = freq.is_some();
    let reviewed = false;
    let body_noheader =
        crate::rer_importer::body_noheader::extract_text(&body)?;
    // let location = crate::rer_importer::location::extract_location(&body)?;
    let post = crate::rer_importer::post::extract_post(&body)?;
    let post_id = crate::sigint::post::get_or_create_post_id(txn, &post)
        .await
        .c(h!())?;
    let callsigns_alg1 = callsigns.clone();
    let callsigns_alg2 =
        crate::nlp::complete_callsigns(rq, &body).await.c(h!())?;
    let signal_tokens =
        super::signals::find_signal_tokens(txn, &body, &body_noheader)
            .await
            .c(h!())?;
    let all_callsigns = callsigns_alg1
        .clone()
        .into_iter()
        .chain(callsigns_alg2.clone().into_iter())
        .unique()
        .collect_vec();
    let unit_and_loc = crate::unit::parser::extract_unit(
        settlements.clone(),
        &body,
        all_callsigns,
    )?;
    let unit = unit_and_loc.unit;
    let unit_v2 = find_unit_v2(txn, cache, &unit).await.c(h!())?;
    let location = unit_and_loc.locality.clone();
    let settlement_list =
        match (unit_and_loc.locality, unit_and_loc.locality_v2) {
            (Some(_), Some(locations)) => locations,
            (Some(location), None) => {
                crate::location::parse_location(settlements.clone(), location)
                    .c(h!())?
            }
            _ => vec![],
        };

    let location_v2 = if settlement_list.is_empty() {
        None
    } else {
        Some(utils::format_settlements_list(settlement_list))
    };

    if crate::rer_importer::important::is_important(&body) {
        sigint_important::Entity::insert(sigint_important::ActiveModel {
            id: NotSet,
            user_id: NotSet,
            signal_message_id: Set(message_id),
            deleted: Set(false),
            created_at: NotSet,
        })
        .exec(txn)
        .await
        .c(h!())?;
    }

    let message = try_set_commintify_sender(&body, message, txn)
        .await
        .c(h!())?;

    let (date_v, time_v) = match m_created_at {
        None => (date_v, time_v),
        Some((d, t)) => (Some(d), Some(t)),
    };
    let datetime = datetime_from_body.or(message.timestamp);
    let datetime_to_store = datetime.clone();

    let result = sigint_inbox_item::ActiveModel {
        id: Set(message.id),
        date: Set(date_v),
        time: Set(time_v),
        freq: Set(freq),
        coords: Set(coords.clone().map(|x| x.text)),
        lat: Set(coords.clone().map(|x| x.lat)),
        lng: Set(coords.clone().map(|x| x.lng)),
        callsigns: Set(Some(serde_json::to_value(callsigns).c(h!())?)),
        checked: Set(Some(checked)),
        reviewed: Set(Some(reviewed)),
        unit: Set(unit.clone()),
        callsign_tokens: Set(Some(
            serde_json::to_value(callsign_tokens).c(h!())?,
        )),
        keyword_tokens: Set(Some(
            serde_json::to_value(keyword_tokens).c(h!())?,
        )),
        nominatimres_id: NotSet,
        location: Set(location),
        location_v2: Set(location_v2),
        body_noheader: Set(Some(serde_json::to_value(body_noheader).c(h!())?)),
        tags: NotSet,
        callsigns_alg1: Set(Some(
            serde_json::to_value(callsigns_alg1).c(h!())?,
        )),
        callsigns_alg2: Set(Some(
            serde_json::to_value(callsigns_alg2).c(h!())?,
        )),
        datetime: match datetime_to_store {
            Some(dt) => Set(Some(dt)),
            None => NotSet,
        },
        signal_tokens: Set(Some(serde_json::to_value(signal_tokens).c(h!())?)),
        post_id: Set(post_id),
        unit_v2: Set(unit_v2),
        parsed_unit_v2: Set(true),
    }
    .insert(txn)
    .await
    .c(h!())?;

    let ts = datetime
        .unwrap_or_else(|| result.datetime.unwrap_or(message.created_at));
    crate::location::peleng::insert_pelengs(coords_vec, result.id, ts, txn)
        .await
        .c(h!())?;

    // In case then some coords exists, change signal_group for this message grom RER Import
    // to MPORT_DIRECTION_FINDING
    let group_name = config.signal_import_group_name.clone();

    if let Some((signal_message, group)) =
        signal_message::Entity::find_by_id(message_id)
            .find_with_related(datasource_group::Entity)
            .join(
                JoinType::InnerJoin,
                datasource_group::Relation::SignalGroup.def(),
            )
            .filter(signal_message::Column::Deleted.eq(false))
            .filter(signal_group::Column::Deleted.eq(false))
            .filter(signal_group::Column::Name.eq(group_name))
            .all(txn)
            .await
            .c(h!())?
            .into_iter()
            .next()
            .and_then(|(m, gs)| gs.into_iter().next().map(|g| (m, g)))
    {
        let datasource_group_id = ensure_datasource_group_id(
            txn,
            IMPORT_DIRECTION_FINDING_UUID.to_string(),
            group.datasource_id,
        )
        .await
        .c(h!())?;
        let mut signal_message = signal_message.into_active_model();
        signal_message.datasource_group_id = Set(Some(datasource_group_id));
        signal_message.update(txn).await.c(h!())?;
    }

    let event = EventMsg::new(EventType::ETInboxChanged(result.id));
    fanout(redis, event).await.c(h!())?;

    Ok(vec![])
}

async fn try_set_commintify_sender<C>(
    body: &str,
    signal_message: signal_message::Model,
    txn: &C,
) -> Result<signal_message::Model, AppError>
where
    C: ConnectionTrait,
{
    if let Some(sender_id) = &signal_message.sender {
        if let Some(operator) =
            crate::unit::parser::try_extract_comm_operator(body)
        {
            let sender = signal_profile::Entity::find_by_id(sender_id)
                .order_by_desc(signal_profile::Column::CreatedAt)
                .one(txn)
                .await
                .c(h!())?;
            if let Some(sender) = sender {
                if let Some(given_name) = sender.given_name {
                    if given_name == "Commintify sender" {
                        return set_sender(&signal_message, txn, operator)
                            .await;
                    }
                }
            }
        }
    }

    Ok(signal_message)
}

async fn set_sender<C>(
    signal_message: &signal_message::Model,
    txn: &C,
    operator: String,
) -> Result<signal_message::Model, AppError>
where
    C: ConnectionTrait,
{
    let oper_record = signal_profile::Entity::find()
        .filter(signal_profile::Column::GivenName.eq(operator.clone()))
        .order_by_desc(signal_profile::Column::CreatedAt)
        .one(txn)
        .await
        .c(h!())?;

    let oper_id = match oper_record {
        Some(oper_record) => oper_record.uuid,
        None => {
            signal_profile::Entity::insert(signal_profile::ActiveModel {
                uuid: Set(Uuid::new_v4().to_string()),
                created_at: NotSet,
                given_name: Set(Some(operator.clone())),
                family_name: Set(Some("Commintify sender".to_string())),
            })
            .exec(txn)
            .await
            .c(h!())?
            .last_insert_id
        }
    };

    let mut signal_message = signal_message.clone().into_active_model();
    signal_message.sender = Set(Some(oper_id));
    Ok(signal_message.update(txn).await.c(h!())?)
}

async fn find_unit_v2<'a, 'async_trait, C>(
    txn: &'a C,
    cache: &mut TopKCache<String, String>,
    unit: &Option<String>,
) -> Result<Option<String>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let Some(unit) = unit else {
        return Ok(None);
    };
    let mut cached_m_unit = cache.get(unit).cloned();
    if cached_m_unit.is_none() {
        let parsed_unit = crate::unit::parse_unit(unit, txn)
            .await
            .c(h!())?
            .unwrap_or("".to_string());
        cache.put(unit.clone(), parsed_unit.clone());
        cached_m_unit = Some(parsed_unit);
    }
    let m_unit = cached_m_unit.filter(|u| !u.is_empty());
    Ok(m_unit)
}
