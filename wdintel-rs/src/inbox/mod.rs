use crate::config::*;
use crate::entities::*;
use crate::event_stream::fanout_mult;
use crate::event_stream::types::EventMsg;
use crate::event_stream::types::EventType;
use crate::types::*;
use chrono::prelude::*;
use chrono::Duration;
use chrono_tz::Tz;
use sea_orm::*;

pub mod callsigns;
pub mod datetime;

pub struct ConstructInboxItemResult {
    pub spawned_message_ids: Vec<i64>,
    pub changed_inbox_item_id: Option<i64>,
}

impl ConstructInboxItemResult {
    fn spawned(spawned_message_ids: Vec<i64>) -> Self {
        Self {
            spawned_message_ids,
            changed_inbox_item_id: None,
        }
    }

    fn changed(changed_inbox_item_id: i64) -> Self {
        Self {
            spawned_message_ids: vec![],
            changed_inbox_item_id: Some(changed_inbox_item_id),
        }
    }
}

/// The main workhorse parsing [signal_message](crate::entities::signal_message) into [sigint_inbox_item](crate::entities::sigint_inbox_item)
///
/// It does not do any extremely-slow AI operations and such, those are done separately in TODO:link.
///
/// Some ofthe main tasks performed here:
/// - extracting callsigns
/// - extracting coordinates
/// - extracting datetime
/// - extracting frequency
/// - extracting unit and location
/// - marking important messages
/// - setting proper signal_message.sender if possible
/// - changing datasource_group_id if coordinates are present
/// - returning changed inbox item ids for callers to fan out after commit
pub async fn construct_inbox_item<'a, 'async_trait, C>(
    settlements: Arc<RwLock<crate::location::SettlementsDataConfig>>,
    txn: &'a C,
    rq: &reqwest::Client,
    config: &Config,
    message_id: i64,
    cache: &mut TopKCache<String, String>,
    m_created_at: Option<(String, String)>,
) -> Result<ConstructInboxItemResult, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let message = signal_message::Entity::find_by_id(message_id)
        .filter(signal_message::Column::Deleted.eq(false))
        .one(txn)
        .await
        .c(h!())?
        .ok_or(format!("Couldn't find a message id={message_id}"))?;
    let existing_inbox_item = sigint_inbox_item::Entity::find_by_id(message_id)
        .one(txn)
        .await
        .c(h!())?
        .is_some();
    let m_aor_ids = resolve_message_aor_ids_by_group(txn, message_id)
        .await
        .c(h!())?;
    let m_aor_id = if m_aor_ids.is_empty() {
        None
    } else {
        Some(m_aor_ids[0])
    };

    let body = message.body.clone().unwrap_or("".to_string());
    if crate::rer_importer::multimessage::should_try_split_message(&body) {
        let spawned =
            crate::rer_importer::multimessage::spawn_multiple_messages(
                txn, &message, &body,
            )
            .await
            .c(h!())?;
        if !spawned.is_empty() {
            return Ok(ConstructInboxItemResult::spawned(spawned));
        }
    }
    let tz = crate::config::get_tz();
    let lnow = Local::now().with_timezone(&tz);
    let allow_kraken_audio =
        message_has_other_interseption_group(txn, &message).await?;
    let (mut m_dt, meow_format) =
        extract_message_datetime(lnow, &body, allow_kraken_audio)?;
    if m_dt.is_none() {
        if let Some(ref timestamp) = message.timestamp {
            let dt2: DateTime<Utc> =
                DateTime::from_naive_utc_and_offset(*timestamp, Utc);
            m_dt = Some(dt2.with_timezone(&Kyiv));
        };
    }
    let datetime_from_body =
        m_dt.as_ref().map(|dt| dt.with_timezone(&Utc).naive_utc());
    let freq = crate::rer_importer::frequency::extract_freq(&body)?
        .map(|v| crate::rer_importer::frequency::etalon(&v));
    let known_callsign_tokens =
        crate::rer_importer::callsigns::find_known_callsigns(rq, &body)
            .await
            .c(h!())?;
    let callsign_etalons =
        crate::rer_importer::inbox::metadata::non_metadata_line_callsign_etalons(
            &known_callsign_tokens,
            &body,
        );
    let callsigns: Vec<String> =
        crate::rer_importer::inbox::metadata::append_metadata_text_callsigns(
            callsign_etalons,
            &body,
        )
        .into_iter()
        .map(|x| x.to_lowercase())
        .collect();
    let callsign_tokens = if callsigns.is_empty() {
        vec![]
    } else {
        crate::rer_importer::callsigns::highlight_callsigns(
            rq, &body, &callsigns,
        )
        .await
        .c(h!())?
    };
    let checked = freq.is_some();
    let reviewed = false;
    let comment_parsing_enabled =
        crate::system_settings::sigint_comment_parsing_enabled(txn)
            .await
            .c(h!())?;
    let body_noheader = match &meow_format {
        Some(meow_format) => meow_format.body_noheader.clone(),
        None if comment_parsing_enabled => {
            crate::sigint::parser::extract_text_without_top_comment(&body)?
        }
        None => crate::rer_importer::body_noheader::extract_text(&body)?,
    };
    let coords_body_noheader =
        crate::rer_importer::coordinates::body_noheader_for_inbox_coords(
            &body,
            meow_format.as_ref(),
        )?;
    let coords_vec = crate::rer_importer::coordinates::extract_inbox_coords(
        &body,
        &coords_body_noheader,
    )
    .await;
    let coords_vec =
        crate::location::peleng::filter_allowed_peleng_coords(coords_vec, txn)
            .await
            .c(h!())?;
    let mut other_coords = coords_vec.clone();
    let coords = crate::utils::pop_vector(&mut other_coords);
    let has_coords = coords.is_some();

    // let location = crate::rer_importer::location::extract_location(&body)?;
    let post = crate::rer_importer::post::extract_post(&body)?;
    let post_id = crate::sigint::post::get_or_create_post_id(txn, &post)
        .await
        .c(h!())?;
    let callsigns_alg1 = callsigns.clone();
    let callsigns_alg2 =
        crate::nlp::complete_callsigns(rq, &body).await.c(h!())?;
    let signal_tokens = crate::rer_importer::signals::find_signal_tokens(
        txn,
        &body,
        &body_noheader,
    )
    .await
    .c(h!())?;
    let all_callsigns = callsigns_alg1
        .clone()
        .into_iter()
        .chain(callsigns_alg2.clone())
        .unique()
        .collect_vec();
    let unit_and_loc = crate::unit::parser::extract_unit_with_aor(
        settlements.clone(),
        &body,
        all_callsigns,
        m_aor_id,
    )?;
    let unit = unit_and_loc.unit;
    let unit_v2 = find_unit_v2(txn, cache, &unit).await.c(h!())?;
    let location = unit_and_loc.locality.clone();
    let settlement_list =
        match (unit_and_loc.locality, unit_and_loc.locality_v2) {
            (Some(_), Some(locations)) => locations,
            (Some(location), None) => crate::location::parse_location_with_aor(
                settlements.clone(),
                location,
                m_aor_id,
            )
            .c(h!())?,
            _ => vec![],
        };

    let location_v2 = if settlement_list.is_empty() {
        None
    } else {
        Some(crate::location::utils::format_settlements_list(
            settlement_list,
        ))
    };

    if crate::rer_importer::important::is_important(&body) {
        sigint_important::Entity::insert(sigint_important::ActiveModel {
            id: NotSet,
            login_id: NotSet,
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

    let datetime = datetime_from_body.or(message.timestamp);
    let datetime_to_store = datetime;

    let (default_date_v, default_time_v) = match datetime_to_store {
        Some(dt) => {
            let (date, time) = format_date_time_fields(dt);
            (Some(date), Some(time))
        }
        None => (None, None),
    };

    let (date_v, time_v) = match m_created_at {
        None => (default_date_v, default_time_v),
        Some((d, t)) => (Some(d), Some(t)),
    };
    let datetime_neo =
        datetime::from_date_time_text(date_v.as_deref(), time_v.as_deref())
            .c(h!())?;

    let result = sigint_inbox_item::ActiveModel {
        id: Set(message.id),
        date: Set(date_v),
        time: Set(time_v),
        freq: Set(freq),
        coords: Set(coords.clone().map(|x| x.text)),
        lat: Set(coords.clone().map(|x| x.lat)),
        lng: Set(coords.clone().map(|x| x.lng)),
        checked: Set(Some(checked)),
        reviewed: Set(Some(reviewed)),
        unit: Set(unit.clone()),
        callsign_tokens: Set(Some(
            serde_json::to_value(callsign_tokens).c(h!())?,
        )),
        keyword_tokens: Set(None),
        nominatimres_id: Set(None),
        location: Set(location),
        location_v2: Set(location_v2),
        body_noheader: Set(Some(serde_json::to_value(&body_noheader).c(h!())?)),
        tags: NotSet,
        datetime: NotSet,
        datetime_neo: Set(datetime_neo),
        signal_tokens: Set(Some(serde_json::to_value(signal_tokens).c(h!())?)),
        post_id: Set(post_id),
        device_name_id: Set(None),
        unit_v2: Set(unit_v2),
        parsed_unit_v2: Set(true),
        network: Set(None),
    };
    let result = sigint_inbox_item::Entity::insert(result)
        .on_conflict(
            sea_query::OnConflict::column(sigint_inbox_item::Column::Id)
                .update_columns(reprocessed_inbox_item_update_columns())
                .to_owned(),
        )
        .exec_with_returning(txn)
        .await
        .c(h!())?;
    let system_login_id = crate::users::system_login_id(txn).await.c(h!())?;
    callsigns::sync(
        txn,
        result.id,
        callsigns::InboxItemCallsigns {
            primary: callsigns_alg1,
            alg2: callsigns_alg2,
        },
        system_login_id,
    )
    .await
    .c(h!())?;

    crate::rer_importer::inbox::metadata::refresh_metadata_for_body(
        result.id,
        &message.body.clone().unwrap_or_default(),
        txn,
    )
    .await
    .c(h!())?;

    if comment_parsing_enabled {
        insert_missing_auto_comments(txn, message.id, post_id, &body)
            .await
            .c(h!())?;
    }

    let ts = datetime
        .unwrap_or_else(|| result.datetime.unwrap_or(message.created_at));
    crate::location::peleng::delete_inbox_pelengs(result.id, txn)
        .await
        .c(h!())?;
    let pelengation_object =
        crate::rer_importer::pelengation_object::extract(&body);
    crate::location::peleng::insert_pelengs(
        coords_vec,
        result.id,
        ts,
        pelengation_object,
        txn,
    )
    .await
    .c(h!())?;

    // In case then some coords exists, change signal_group for this message grom RER Import
    // to MPORT_DIRECTION_FINDING
    let group_name = config.signal_import_group_name.clone();

    if has_coords {
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
            let datasource_group_id =
                crate::messenger::group::ensure_datasource_group_id(
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
    }

    tag_suggestion_worker_queue::Entity::insert(
        tag_suggestion_worker_queue::ActiveModel {
            sigint_inbox_item_id: Set(message.id),
        },
    )
    .on_conflict_do_nothing()
    .exec(txn)
    .await
    .c(h!())?;

    crate::ai_callsign::worker::enqueue_if_enabled(txn, message.id)
        .await
        .c(h!())?;

    crate::sigint::network::etalon_calc::calculate_sigint_inbox_item_networks(
        vec![result],
        txn,
    )
    .await
    .c(h!())?;
    if existing_inbox_item {
        crate::stats::enqueue_group_stats_recalculation_for_message(
            txn,
            message_id,
            format!("reprocessed inbox message {message_id}"),
        )
        .await
        .c(h!())?;
    }

    palitra_highlight_worker_job::Entity::insert(
        palitra_highlight_worker_job::ActiveModel {
            sigint_inbox_item_id: Set(message.id),
        },
    )
    .on_conflict_do_nothing()
    .exec(txn)
    .await
    .c(h!())?;

    Ok(ConstructInboxItemResult::changed(message.id))
}

fn reprocessed_inbox_item_update_columns() -> [sigint_inbox_item::Column; 21] {
    [
        sigint_inbox_item::Column::Date,
        sigint_inbox_item::Column::Time,
        sigint_inbox_item::Column::DatetimeNeo,
        sigint_inbox_item::Column::Freq,
        sigint_inbox_item::Column::Coords,
        sigint_inbox_item::Column::Lat,
        sigint_inbox_item::Column::Lng,
        sigint_inbox_item::Column::Checked,
        sigint_inbox_item::Column::Reviewed,
        sigint_inbox_item::Column::Unit,
        sigint_inbox_item::Column::CallsignTokens,
        sigint_inbox_item::Column::KeywordTokens,
        sigint_inbox_item::Column::NominatimresId,
        sigint_inbox_item::Column::Location,
        sigint_inbox_item::Column::LocationV2,
        sigint_inbox_item::Column::BodyNoheader,
        sigint_inbox_item::Column::SignalTokens,
        sigint_inbox_item::Column::PostId,
        sigint_inbox_item::Column::DeviceNameId,
        sigint_inbox_item::Column::UnitV2,
        sigint_inbox_item::Column::ParsedUnitV2,
    ]
}

fn extract_message_datetime(
    lnow: DateTime<Tz>,
    body: &str,
    allow_kraken_audio: bool,
) -> Result<
    (
        Option<DateTime<Tz>>,
        Option<crate::rer_importer::meow_format::MeowFormat>,
    ),
    AppError,
> {
    let (datetime, meow_format) = if allow_kraken_audio {
        if let Some(kraken_audio) =
            crate::rer_importer::meow_format::parse_kraken_audio(body)
        {
            (Some(kraken_audio.datetime), Some(kraken_audio.clone()))
        } else {
            extract_regular_message_datetime(lnow, body)?
        }
    } else if crate::rer_importer::meow_format::parse_kraken_audio(body)
        .is_some()
    {
        (None, None)
    } else {
        extract_regular_message_datetime(lnow, body)?
    };

    Ok((
        datetime
            .map(|datetime| normalize_future_message_datetime(lnow, datetime)),
        meow_format,
    ))
}

fn extract_regular_message_datetime(
    lnow: DateTime<Tz>,
    body: &str,
) -> Result<
    (
        Option<DateTime<Tz>>,
        Option<crate::rer_importer::meow_format::MeowFormat>,
    ),
    AppError,
> {
    let meow_format = crate::rer_importer::meow_format::parse(lnow, body);
    if let Some(meow_format) = &meow_format {
        return Ok((Some(meow_format.datetime), Some(meow_format.clone())));
    }

    Ok((extract_generic_body_datetime(lnow, body)?, None))
}

fn normalize_future_message_datetime(
    lnow: DateTime<Tz>,
    datetime: DateTime<Tz>,
) -> DateTime<Tz> {
    if datetime
        <= lnow + Duration::hours(RER_INBOX_PARSED_DATETIME_MAX_FUTURE_HOURS)
    {
        return datetime;
    }

    let current_date_with_parsed_time =
        lnow.date_naive().and_time(datetime.time());
    let normalized = match lnow
        .timezone()
        .from_local_datetime(&current_date_with_parsed_time)
    {
        chrono::offset::LocalResult::Single(datetime) => datetime,
        chrono::offset::LocalResult::Ambiguous(datetime, _) => datetime,
        chrono::offset::LocalResult::None => lnow,
    };
    warn!(
        "parsed inbox datetime {datetime} is more than {} hours in the future; using {normalized}",
        RER_INBOX_PARSED_DATETIME_MAX_FUTURE_HOURS
    );
    normalized
}

fn extract_generic_body_datetime(
    lnow: DateTime<Tz>,
    body: &str,
) -> Result<Option<DateTime<Tz>>, AppError> {
    let datetime = crate::rer_importer::datetime::extract_datetime(lnow, body)?;
    let Some(dt) = datetime
        .or_else(|| extract_far_future_datetime_with_current_date(lnow, body))
    else {
        return Ok(None);
    };

    Ok(match Kyiv.from_local_datetime(&dt) {
        chrono::offset::LocalResult::None => {
            println!(
                "> warning: couldn't convert datetime to Kyiv timezone: {dt:?}; body: {body}"
            );
            None
        }
        chrono::offset::LocalResult::Single(v) => Some(v),
        chrono::offset::LocalResult::Ambiguous(v1, v2) => {
            println!(
                "> warning: couldn't convert datetime to Kyiv timezone (ambiguous): v1: {v1:?}, v2: {v2:?}; {dt:?}; body: {body}"
            );
            None
        }
    })
}

fn extract_far_future_datetime_with_current_date(
    lnow: DateTime<Tz>,
    body: &str,
) -> Option<NaiveDateTime> {
    lazy_static::lazy_static! {
        static ref DATETIME_REGEX: regex::Regex = regex::Regex::new(
            r"(?P<day>\d{2})\.(?P<mon>\d{2})\.(?P<year>\d{4})[ \t]+(?P<hour>\d{1,2})[ \t]*:[ \t]*(?P<minute>\d{2})[ \t]*:[ \t]*(?P<second>\d{2})"
        )
        .unwrap();
    }

    let captures = DATETIME_REGEX.captures(body)?;
    let datetime = NaiveDate::from_ymd_opt(
        captures.name("year")?.as_str().parse().ok()?,
        captures.name("mon")?.as_str().parse().ok()?,
        captures.name("day")?.as_str().parse().ok()?,
    )?
    .and_hms_opt(
        captures.name("hour")?.as_str().parse().ok()?,
        captures.name("minute")?.as_str().parse().ok()?,
        captures.name("second")?.as_str().parse().ok()?,
    )?;
    let parsed_datetime =
        lnow.timezone().from_local_datetime(&datetime).earliest()?;
    if parsed_datetime
        <= lnow
            + chrono::Duration::hours(
                RER_INBOX_PARSED_DATETIME_MAX_FUTURE_HOURS,
            )
    {
        return None;
    }

    Some(lnow.date_naive().and_time(datetime.time()))
}

async fn message_has_other_interseption_group<'a, 'async_trait, C>(
    txn: &'a C,
    message: &signal_message::Model,
) -> Result<bool, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let linked_other_count = signal_message_group::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message_group::Relation::SignalGroup.def(),
        )
        .filter(signal_message_group::Column::SignalMessageId.eq(message.id))
        .filter(
            signal_group::Column::InterseptionKind.eq(
                crate::entities::sea_orm_active_enums::InterseptionKind::Other,
            ),
        )
        .count(txn)
        .await
        .c(h!())?;
    if linked_other_count > 0 {
        return Ok(true);
    }

    let Some(datasource_group_id) = message.datasource_group_id else {
        return Ok(false);
    };
    let direct_other_count =
        datasource_group::Entity::find_by_id(datasource_group_id)
            .join(
                JoinType::InnerJoin,
                datasource_group::Relation::SignalGroup.def(),
            )
            .filter(signal_group::Column::InterseptionKind.eq(
                crate::entities::sea_orm_active_enums::InterseptionKind::Other,
            ))
            .count(txn)
            .await
            .c(h!())?;
    Ok(direct_other_count > 0)
}
pub async fn fanout_inbox_changed(
    redis: &mut redis::aio::ConnectionManager,
    inbox_item_id: i64,
) -> Result<(), AppError> {
    fanout_inbox_changes(redis, vec![inbox_item_id]).await
}

pub async fn fanout_inbox_changes(
    redis: &mut redis::aio::ConnectionManager,
    inbox_item_ids: Vec<i64>,
) -> Result<(), AppError> {
    if inbox_item_ids.is_empty() {
        return Ok(());
    }
    let events = inbox_item_ids
        .into_iter()
        .map(|inbox_item_id| {
            EventMsg::new(EventType::ETInboxChanged(inbox_item_id))
        })
        .collect();
    fanout_mult(redis, events).await.c(h!())?;
    Ok(())
}

async fn insert_missing_auto_comments<'a, 'async_trait, C>(
    txn: &'a C,
    signal_message_id: i64,
    sigint_post_id: Option<i64>,
    body: &str,
) -> Result<(), AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let system_login_id = crate::users::system_login_id(txn).await.c(h!())?;
    let blacklist = crate::sigint::comments::load_blacklist(txn).await?;
    let parsed =
        crate::sigint::parser::parse_comments_with_blacklist(body, &blacklist);
    let mut texts = vec![];
    for text in [parsed.top, parsed.bottom].into_iter().flatten() {
        if !texts.contains(&text) {
            texts.push(text);
        }
    }

    for text in texts {
        let exists = sigint_comment::Entity::find()
            .filter(
                sigint_comment::Column::SignalMessageId.eq(signal_message_id),
            )
            .filter(sigint_comment::Column::LoginId.eq(system_login_id))
            .filter(sigint_comment::Column::Comment.eq(text.clone()))
            .one(txn)
            .await
            .c(h!())?
            .is_some();
        if exists {
            continue;
        }
        sigint_comment::ActiveModel {
            id: NotSet,
            signal_message_id: Set(signal_message_id),
            login_id: Set(system_login_id),
            comment: Set(text),
            created_at: NotSet,
            sigint_post_id: Set(sigint_post_id),
        }
        .insert(txn)
        .await
        .c(h!())?;
    }
    Ok(())
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
        let parsed_unit = parse_unit_v2(txn, unit).await?.unwrap_or_default();
        cache.put(unit.clone(), parsed_unit.clone());
        cached_m_unit = Some(parsed_unit);
    }
    let m_unit = cached_m_unit.filter(|u| !u.is_empty());
    Ok(m_unit)
}

pub(crate) async fn parse_unit_v2<C>(
    dbx: &C,
    unit: &String,
) -> Result<Option<String>, AppError>
where
    C: ConnectionTrait,
{
    Ok(crate::unit::parse_unit(unit, dbx)
        .await
        .c(h!())?
        .filter(|unit| !unit.is_empty()))
}

pub async fn resolve_message_aor_ids_by_group<'a, 'async_trait, C>(
    txn: &'a C,
    message_id: i64,
) -> Result<Vec<i64>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let m_group_master_key = signal_message_group::Entity::find()
        .filter(signal_message_group::Column::SignalMessageId.eq(message_id))
        .filter(signal_message_group::Column::GroupMasterKey.is_not_null())
        .order_by_asc(signal_message_group::Column::Id)
        .select_only()
        .column(signal_message_group::Column::GroupMasterKey)
        .into_tuple::<String>()
        .one(txn)
        .await
        .c(h!())?;
    let Some(group_master_key) = m_group_master_key else {
        return Ok(vec![]);
    };
    let m_aor_ids = signal_group_aor::Entity::find()
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
        .all(txn)
        .await
        .c(h!())?;
    Ok(m_aor_ids)
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

fn format_date_time_fields(dt_utc: NaiveDateTime) -> (String, String) {
    let dt_kyiv = DateTime::<Utc>::from_naive_utc_and_offset(dt_utc, Utc)
        .with_timezone(&Kyiv);
    let date = dt_kyiv.format("%Y-%m-%d").to_string();
    let time = dt_kyiv.format("%H:%M:%S").to_string();
    (date, time)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::functest::tests::{
        cleanup_locked, find_test_datasource_group, mk_signal_message,
    };

    #[test]
    fn format_date_time_fields_keeps_seconds() {
        let dt_utc = NaiveDate::from_ymd_opt(2025, 11, 20)
            .unwrap()
            .and_hms_opt(10, 29, 18)
            .unwrap();
        let (date, time) = format_date_time_fields(dt_utc);
        assert_eq!(date, "2025-11-20");
        assert_eq!(time, "12:29:18");
    }

    #[test]
    fn reprocessed_inbox_item_update_columns_reset_reviewed() {
        assert!(reprocessed_inbox_item_update_columns()
            .iter()
            .any(|column| {
                matches!(column, sigint_inbox_item::Column::Reviewed)
            }));
        assert!(reprocessed_inbox_item_update_columns()
            .iter()
            .any(|column| {
                matches!(column, sigint_inbox_item::Column::DeviceNameId)
            }));
        assert!(reprocessed_inbox_item_update_columns()
            .iter()
            .all(|column| {
                !matches!(column, sigint_inbox_item::Column::Datetime)
            }));
        assert!(reprocessed_inbox_item_update_columns()
            .iter()
            .any(|column| {
                matches!(column, sigint_inbox_item::Column::DatetimeNeo)
            }));
    }

    #[tokio::test]
    async fn coordinate_extraction_keeps_standard_header_and_comments() {
        let body = "36T VS 89904 14667\n01.07.2026, 02:55:19\n155.0250\nКоординати: 36U XB 66512 50880\nУКХ р/м\n\n— репліка";

        assert!(!crate::rer_importer::coordinates::extract_coords(body)
            .await
            .is_empty());

        let body_noheader =
            crate::sigint::parser::extract_text_without_top_comment(body)
                .unwrap();

        assert_eq!(body_noheader.body, "— репліка");
        let coords = crate::rer_importer::coordinates::extract_inbox_coords(
            body,
            &body_noheader,
        )
        .await;

        assert_eq!(coords.len(), 2);
        assert!(coords.iter().any(|coord| coord.mgrs == "36TVS8990414667"));
        assert!(coords.iter().any(|coord| coord.mgrs == "36UXB6651250880"));
    }

    #[test]
    fn extract_message_datetime_prefers_meow_header_over_body_time() {
        let now = Kyiv.with_ymd_and_hms(2026, 6, 28, 12, 0, 0).unwrap();
        let body = "50 обрБпС\n05.58 (МСК/Київ) +- 10хв\n\nПерехоплення о 08:30\nрядок 2";

        let (m_dt, meow_format) =
            extract_message_datetime(now, body, false).unwrap();

        assert_eq!(
            m_dt,
            Some(Kyiv.with_ymd_and_hms(2026, 6, 28, 5, 58, 0).unwrap())
        );
        assert_eq!(
            meow_format.unwrap().body_noheader.body,
            "Перехоплення о 08:30\nрядок 2"
        );
    }

    #[test]
    fn extract_message_datetime_replaces_far_future_date_with_current_date() {
        let now = Kyiv.with_ymd_and_hms(2026, 7, 29, 12, 0, 0).unwrap();
        let body = "Дата та час: 18.08.2032 08:18:41";

        let (datetime, _) = extract_message_datetime(now, body, false).unwrap();

        assert_eq!(
            datetime,
            Some(Kyiv.with_ymd_and_hms(2026, 7, 29, 8, 18, 41).unwrap())
        );
    }

    #[test]
    fn extract_message_datetime_allows_up_to_24_hours_in_future() {
        let now = Kyiv.with_ymd_and_hms(2026, 7, 29, 12, 0, 0).unwrap();
        let body = "Дата та час: 30.07.2026 11:59:59";

        let (datetime, _) = extract_message_datetime(now, body, false).unwrap();

        assert_eq!(
            datetime,
            Some(Kyiv.with_ymd_and_hms(2026, 7, 30, 11, 59, 59).unwrap())
        );
    }

    fn report_125_sample_body(mgrs: &str) -> String {
        format!(
            "Назва: А-50 (А-50У) РЛС з РТК «Шмєль-М»;\n\
             Частота: 3330;\n\
             Дата та час: 16.07.2026 11:34:32;\n\
             Умовні координати для бота: MGRS {mgrs};"
        )
    }

    #[tokio::test]
    #[serial]
    async fn auto_comments_use_database_blacklist() {
        let (env, _cleanup_guard) = cleanup_locked().await.unwrap();
        let datasource_group =
            find_test_datasource_group(&env.dbx).await.unwrap();
        let body = "++\nважливий коментар\n\n24.07.2025, 08:05:21\n149.7300\nУКХ\nНВ\n\n— репліка\n\nМітка перехоплення: +";
        let message = mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                body: Set(Some(body.to_string())),
                datasource_group_id: Set(Some(datasource_group.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        insert_missing_auto_comments(&env.dbx, message.id, None, body)
            .await
            .unwrap();

        let comments = sigint_comment::Entity::find()
            .filter(sigint_comment::Column::SignalMessageId.eq(message.id))
            .all(&env.dbx)
            .await
            .unwrap();
        assert_eq!(comments.len(), 1);
        assert_eq!(comments[0].comment, "важливий коментар");

        let system_login_id =
            crate::users::system_login_id(&env.dbx).await.unwrap();
        let seeded = sigint_comment_blacklist::Entity::find()
            .filter(sigint_comment_blacklist::Column::IsPersistent.eq(true))
            .all(&env.dbx)
            .await
            .unwrap();
        assert_eq!(seeded.len(), 24);
        assert!(seeded
            .iter()
            .all(|entry| entry.created_by_login_id == system_login_id));

        let manual_text = format!("manual-{}", Uuid::new_v4());
        let manual = sigint_comment_blacklist::ActiveModel {
            text: Set(manual_text.clone()),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        assert!(!manual.is_persistent);
        assert_eq!(manual.created_by_login_id, system_login_id);
        sigint_comment_blacklist::Entity::delete_by_id(manual_text)
            .exec(&env.dbx)
            .await
            .unwrap();
    }

    #[tokio::test]
    #[serial]
    async fn construct_inbox_item_imports_extended_peleng_format() {
        let (env, _cleanup_guard) = cleanup_locked().await.unwrap();
        let datasource_group =
            find_test_datasource_group(&env.dbx).await.unwrap();
        let body = "пост Фокстрот-Наутілус-Дракар\n446.300 TYT назва: ретранслятор\nр-н Верхній Рогачик\nx:52-41410\ny:65-99914\nУКХ радіомережа ППО смуга 49 А\nНВ\nНВ\n\n— Кольцо 22, я техас, прием.\n23:59 31.07.2026";
        let message = mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                body: Set(Some(body.to_string())),
                created_at: Set(Utc::now().naive_utc()),
                timestamp: Set(None),
                message_uid: Set(Some(format!(
                    "extended-peleng-format-{}",
                    Uuid::new_v4()
                ))),
                datasource_group_id: Set(Some(datasource_group.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let mut cache = TopKCache::<String, String>::new(64);

        construct_inbox_item(
            env.settlements.clone(),
            &env.dbx,
            &env.rq,
            &env.config,
            message.id,
            &mut cache,
            None,
        )
        .await
        .unwrap();

        let inbox_item = sigint_inbox_item::Entity::find_by_id(message.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        let post = sigint_post::Entity::find_by_id(inbox_item.post_id.unwrap())
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        let pelengs = active_pelengs(message.id, &env.dbx).await;

        assert_eq!(inbox_item.freq.as_deref(), Some("446.3000"));
        assert_eq!(
            inbox_item.unit.as_deref(),
            Some("УКХ радіомережа ППО смуга 49 А")
        );
        assert_eq!(inbox_item.location.as_deref(), Some("р-н Верхній Рогачик"));
        assert_eq!(inbox_item.date.as_deref(), Some("2026-07-31"));
        assert_eq!(inbox_item.time.as_deref(), Some("23:59:00"));
        assert_eq!(post.name, "Фокстрот-Наутілус-Дракар");
        assert_eq!(pelengs.len(), 1);
        assert_eq!(
            pelengs[0].pelengation_object.as_deref(),
            Some("TYT назва: ретранслятор")
        );
    }

    #[tokio::test]
    #[serial]
    async fn construct_inbox_item_imports_report_125_sample_and_replaces_pelengs(
    ) {
        let (env, _cleanup_guard) = cleanup_locked().await.unwrap();
        let datasource_group =
            find_test_datasource_group(&env.dbx).await.unwrap();
        let created_at = NaiveDate::from_ymd_opt(2026, 7, 16)
            .unwrap()
            .and_hms_opt(8, 34, 32)
            .unwrap();
        let message = mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                body: Set(Some(report_125_sample_body("37U DR 32515 05505"))),
                created_at: Set(created_at),
                timestamp: Set(Some(created_at)),
                message_uid: Set(Some(format!(
                    "report-125-sample-{}",
                    Uuid::new_v4()
                ))),
                datasource_group_id: Set(Some(datasource_group.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let mut cache = TopKCache::<String, String>::new(64);

        construct_inbox_item(
            env.settlements.clone(),
            &env.dbx,
            &env.rq,
            &env.config,
            message.id,
            &mut cache,
            None,
        )
        .await
        .unwrap();

        let inbox_item = sigint_inbox_item::Entity::find_by_id(message.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            inbox_item.unit.as_deref(),
            Some("А-50 (А-50У) РЛС з РТК «Шмєль-М»")
        );
        assert_eq!(inbox_item.freq.as_deref(), Some("3330"));
        assert_eq!(inbox_item.date.as_deref(), Some("2026-07-16"));
        assert_eq!(inbox_item.time.as_deref(), Some("11:34:32"));
        assert_eq!(
            inbox_item.datetime,
            Some(
                NaiveDate::from_ymd_opt(2026, 7, 16)
                    .unwrap()
                    .and_hms_opt(8, 34, 32)
                    .unwrap()
            )
        );
        let pelengs = active_pelengs(message.id, &env.dbx).await;
        assert_eq!(pelengs.len(), 1);
        assert_eq!(
            pelengs[0].pelengation_object.as_deref(),
            Some("А-50 (А-50У) РЛС з РТК «Шмєль-М»")
        );

        let mut message = message.into_active_model();
        message.body = Set(Some(report_125_sample_body("37U DR 32615 05605")));
        let message = message.update(&env.dbx).await.unwrap();

        construct_inbox_item(
            env.settlements.clone(),
            &env.dbx,
            &env.rq,
            &env.config,
            message.id,
            &mut cache,
            None,
        )
        .await
        .unwrap();

        let inbox_item = sigint_inbox_item::Entity::find_by_id(message.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        let pelengs = active_pelengs(message.id, &env.dbx).await;
        assert_eq!(pelengs.len(), 1);
        assert_eq!(
            pelengs[0].pelengation_object.as_deref(),
            Some("А-50 (А-50У) РЛС з РТК «Шмєль-М»")
        );
        assert_eq!(inbox_item.lat, Some(pelengs[0].lat));
        assert_eq!(inbox_item.lng, Some(pelengs[0].lng));
    }

    async fn active_pelengs(
        inbox_item_id: i64,
        dbx: &DatabaseConnection,
    ) -> Vec<sigint_peleng::Model> {
        sigint_peleng::Entity::find()
            .filter(sigint_peleng::Column::SourceInboxItemId.eq(inbox_item_id))
            .filter(sigint_peleng::Column::Deleted.eq(false))
            .order_by_asc(sigint_peleng::Column::Id)
            .all(dbx)
            .await
            .unwrap()
    }

    #[test]
    fn extract_message_datetime_prefers_meow_7d_header_over_body_time() {
        let now = Kyiv.with_ymd_and_hms(2026, 7, 2, 12, 0, 0).unwrap();
        let body = "50 обрБпС | 2026-07-01\n01-12\nПерехоплення о 08:30";

        let (m_dt, meow_format) =
            extract_message_datetime(now, body, false).unwrap();

        assert_eq!(
            m_dt,
            Some(Kyiv.with_ymd_and_hms(2026, 7, 1, 1, 12, 0).unwrap())
        );
        assert_eq!(
            meow_format.unwrap().body_noheader.body,
            "Перехоплення о 08:30"
        );
    }

    #[test]
    fn extract_message_datetime_uses_kraken_audio_only_when_allowed() {
        let now = Kyiv.with_ymd_and_hms(2026, 7, 2, 12, 0, 0).unwrap();
        let body =
            "передмова\n audio | 2026-07-01_14-47-03\nПерехоплення о 08:30";

        let (m_dt, meow_format) =
            extract_message_datetime(now, body, false).unwrap();
        assert_eq!(m_dt, None);
        assert!(meow_format.is_none());

        let (m_dt, meow_format) =
            extract_message_datetime(now, body, true).unwrap();
        assert_eq!(
            m_dt,
            Some(Kyiv.with_ymd_and_hms(2026, 7, 1, 14, 47, 3).unwrap())
        );
        assert_eq!(
            meow_format.unwrap().body_noheader.body,
            "Перехоплення о 08:30\n(Коментар: передмова)"
        );
    }

    #[test]
    fn extract_message_datetime_recovers_time_from_rejected_future_date() {
        let now = Kyiv.with_ymd_and_hms(2026, 7, 29, 12, 0, 0).unwrap();

        let (datetime, _) = extract_message_datetime(
            now,
            "Дата та час: 18.08.2032 08:18:41",
            false,
        )
        .unwrap();

        assert_eq!(
            datetime,
            Some(Kyiv.with_ymd_and_hms(2026, 7, 29, 8, 18, 41).unwrap())
        );
    }
}
