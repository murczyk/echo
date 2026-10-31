use super::query;
use super::types::{
    DirectSubmitAttachmentUpdates, DirectSubmitCopyRsp,
    DirectSubmitParsePayload, DirectSubmitParseRsp, DirectSubmitPayload,
    DirectSubmitRsp,
};
use crate::config::{
    FEATURE_DELETE_UPLOADED_ATTACHMENT_DEFAULT, SIGINT_MESSAGE_DATE_ONLY_HOUR,
    SIGINT_MESSAGE_MAX_ATTACHMENTS,
};
use crate::error::AppError;
use crate::messenger::media::MediaUploadInput;
use crate::rer_importer::inbox::submit_bl::SubmittedInboxItem;
use crate::rer_importer::types::InboxSubmitItem;
use crate::types::*;
use chrono::TimeZone;
use chrono::{SecondsFormat, Utc};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseTransaction,
    EntityTrait, QueryFilter, Set, TransactionTrait,
};
use std::collections::{BTreeMap, HashSet};
use uuid::Uuid;

pub async fn parse_signal_message(
    login: &uuid::Uuid,
    env: &Env,
    payload: DirectSubmitParsePayload,
) -> Result<DirectSubmitParseRsp, AppError> {
    let body = payload.full_body.trim().replace("\r\n", "\n");
    if body.is_empty() {
        return Err(AppError::BL {
            msg: "Введіть текст повідомлення.".to_string(),
        });
    }
    let master_key = payload
        .signal_group_master_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty());
    let (aor_id, is_aviation_group) = if let Some(master_key) = master_key {
        let group =
            query::find_available_signal_group(&env.dbx, login, master_key)
                .await
                .c(h!())?;
        (
            crate::messenger::group::resolve_group_aor_id(&env.dbx, master_key)
                .await
                .c(h!())?,
            group.is_aviation_group.unwrap_or(false),
        )
    } else {
        (None, false)
    };

    let mut parsed = parse_signal_message_body(
        env,
        &env.dbx,
        &body,
        aor_id,
        is_aviation_group,
    )
    .await
    .c(h!())?;
    if payload.include_ai_callsigns {
        super::callsigns::enrich(env, &body, is_aviation_group, &mut parsed)
            .await;
    }
    Ok(parsed)
}

pub async fn copy_signal_messages(
    login: &uuid::Uuid,
    env: &Env,
    signal_message_ids: Vec<i64>,
) -> Result<DirectSubmitCopyRsp, AppError> {
    if signal_message_ids.is_empty() {
        return Err(AppError::BL {
            msg: "Вкажіть хоча б одне повідомлення для копіювання.".to_string(),
        });
    }
    let mut unique_signal_message_ids = Vec::new();
    let mut seen_signal_message_ids = HashSet::new();
    for signal_message_id in signal_message_ids {
        if seen_signal_message_ids.insert(signal_message_id) {
            unique_signal_message_ids.push(signal_message_id);
        }
    }
    let signal_message_ids = unique_signal_message_ids;

    let allowed_groups =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, login)
            .await
            .c(h!())?;
    let logins = crate::users::get_organism_login_ids_by_id(&env.dbx, login)
        .await
        .c(h!())?;

    let sources = query::find_copyable_signal_messages_for_copy(
        &env.dbx,
        &signal_message_ids,
        &allowed_groups,
        login,
        &logins,
    )
    .await
    .c(h!())?;

    let request = crate::rer_importer::types::InboxMessagesReq {
        highlight_points: Some(true),
        ..Default::default()
    };
    let messages = crate::rer_importer::inbox::messages_by_id_bl(
        login,
        &logins,
        env,
        &signal_message_ids,
        &request,
    )
    .await
    .c(h!())?;
    let messages = messages
        .into_iter()
        .collect::<std::collections::HashMap<_, _>>();

    let mut payloads = Vec::with_capacity(sources.len());
    for source in sources {
        let message =
            messages.get(&source.id).ok_or(AppError::NotFound).c(h!())?;
        payloads.push(
            copy_signal_message_payload(env, &env.dbx, source, message)
                .await
                .c(h!())?,
        );
    }
    Ok(DirectSubmitCopyRsp { payloads })
}

fn copied_event_datetime(
    source_timestamp: Option<chrono::NaiveDateTime>,
    message: &crate::rer_importer::types::InboxMessage,
) -> anyhow::Result<(Option<chrono::NaiveDateTime>, Option<bool>)> {
    if message.date.is_none()
        && message.time.is_none()
        && message.is_time_null != Some(true)
    {
        return Ok((source_timestamp, message.is_time_null));
    }
    let local_timestamp = source_timestamp.map(|timestamp| {
        timestamp.and_utc().with_timezone(&chrono_tz::Europe::Kyiv)
    });
    let event_date = message.date.clone().or_else(|| {
        local_timestamp
            .map(|timestamp| timestamp.format("%Y-%m-%d").to_string())
    });
    let event_time = message.time.clone().or_else(|| {
        local_timestamp
            .map(|timestamp| timestamp.format("%H:%M:%S%.f").to_string())
    });
    let is_time_null = if event_date.is_some() && event_time.is_none() {
        Some(true)
    } else {
        message.is_time_null
    };
    let event_time = if is_time_null == Some(true) {
        Some(format!("{SIGINT_MESSAGE_DATE_ONLY_HOUR:02}:00"))
    } else {
        event_time
    };
    let timestamp = crate::inbox::datetime::from_date_time_text(
        event_date.as_deref(),
        event_time.as_deref(),
    )
    .c(h!())?
    .or(source_timestamp);
    Ok((timestamp, is_time_null))
}

async fn copy_signal_message_payload<C>(
    env: &Env,
    dbx: &C,
    source: crate::entities::signal_message::Model,
    message: &crate::rer_importer::types::InboxMessage,
) -> Result<DirectSubmitPayload, AppError>
where
    C: sea_orm::ConnectionTrait,
{
    let tag_ids = message.tags.clone().unwrap_or_default();
    let mut copy_inputs =
        query::find_copy_signal_message_inputs(dbx, source.id, &tag_ids)
            .await
            .c(h!())?;
    copy_inputs.media =
        crate::messenger::audio_ref::for_messages(env, dbx, &[source.id])
            .await
            .c(h!())?;

    let to = crate::rer_importer::inbox::metadata::
        dedupe_text_callsigns_case_insensitive(
            message
                .callsigns
                .iter()
                .chain(message.callsigns_alg2.iter())
                .cloned(),
        );

    let primary_coordinate = copy_inputs
        .inbox_item
        .lat
        .zip(copy_inputs.inbox_item.lng)
        .map(|(lat, lon)| crate::rer_importer::types::GeoCoordinates {
            lat,
            lon,
        })
        .into_iter()
        .collect::<Vec<_>>();
    let mut coordinates = primary_coordinate;
    for coordinate in message
        .coords_with_locality
        .iter()
        .map(|coordinate| coordinate.coords.clone())
    {
        if !coordinates.contains(&coordinate) {
            coordinates.push(coordinate);
        }
    }

    let parent_signal_message_ids = vec![source.id];

    let selections =
        crate::inbox::unit_selection::load_selections(dbx, &[source.id])
            .await
            .c(h!())?;
    let selected_unit_id = selections
        .get(&source.id)
        .filter(|selection| {
            crate::inbox::unit_selection::matches_source(
                selection,
                copy_inputs.inbox_item.unit_v2.as_deref(),
                copy_inputs.inbox_item.unit.as_deref(),
            )
        })
        .map(|selection| selection.unit_id);
    let (timestamp, is_time_null) =
        copied_event_datetime(source.timestamp, message).c(h!())?;
    Ok(DirectSubmitPayload {
        is_time_null,
        full_body: source.body.clone().or_else(|| Some(message.text.clone())),
        text: message
            .no_headers_body
            .as_ref()
            .map(|body| body.body.clone()),
        comment: message.extended_form.clone(),
        freq: message.freq.clone(),
        coords: coordinates,
        from_callsign: None,
        to,
        tags: Some(copy_inputs.tag_labels),
        timestamp: timestamp.map(|timestamp| {
            timestamp
                .and_utc()
                .to_rfc3339_opts(SecondsFormat::Millis, true)
        }),
        post: message.post.clone(),
        unit: message.unit.clone(),
        unit_id: selected_unit_id,
        create_unit: false,
        locations: message
            .location
            .as_deref()
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|location| !location.is_empty())
            .map(str::to_string)
            .collect(),
        network: copy_inputs.inbox_item.network.clone().map(|name| {
            crate::rer_importer::types::SubmitNetwork {
                signal_name: None,
                cc: None,
                name: Some(name),
            }
        }),
        dmr: vec![],
        signal_group_master_key: message.group_master_key.clone(),
        source_signal_group_master_key: None,
        device_name_id: Some(copy_inputs.inbox_item.device_name_id),
        upload_urls: None,
        attachment_updates: None,
        deleted_media_ids: None,
        retained_media_ids: Some(
            copy_inputs
                .media
                .into_iter()
                .map(|media| media.id.to_string())
                .collect(),
        ),
        parent_signal_message_ids,
        copy_source_signal_message_ids: vec![source.id],
        engaged_message_id: None,
    })
}

async fn parse_signal_message_body<C>(
    env: &Env,
    dbx: &C,
    body: &str,
    aor_id: Option<i64>,
    is_aviation_group: bool,
) -> Result<DirectSubmitParseRsp, AppError>
where
    C: ConnectionTrait,
{
    let callsign_tokens =
        crate::rer_importer::callsigns::find_known_callsigns_for_group(
            &env.rq,
            body,
            is_aviation_group,
        )
        .await
        .c(h!())?;
    let callsign_etalons =
        crate::rer_importer::inbox::metadata::non_metadata_line_callsign_etalons(
            &callsign_tokens,
            body,
        );
    let callsigns =
        crate::rer_importer::inbox::metadata::append_metadata_text_callsigns(
            callsign_etalons,
            body,
        )
        .into_iter()
        .map(|callsign| callsign.to_lowercase())
        .collect::<Vec<_>>();
    let coords = crate::rer_importer::coordinates::extract_coords(body).await;
    let coords =
        crate::location::peleng::filter_allowed_peleng_coords(coords, dbx)
            .await
            .c(h!())?;
    let (unit_and_location, unit_v2) = crate::unit::parse_message_unit(
        dbx,
        env.settlements.clone(),
        body,
        callsigns.clone(),
        aor_id,
    )
    .await
    .c(h!())?;
    let unit: Option<String> = unit_and_location.unit;
    let comment_parsing_enabled =
        crate::system_settings::sigint_comment_parsing_enabled(&env.dbx)
            .await
            .c(h!())?;
    let text = if comment_parsing_enabled {
        crate::sigint::parser::extract_text_without_top_comment(body)?
    } else {
        crate::rer_importer::body_noheader::extract_text(body)?
    };
    let timezone = crate::config::get_tz();
    let local_now = chrono::Local::now().with_timezone(&timezone);
    let extracted_dt =
        crate::rer_importer::datetime::extract_datetime_with_precision(
            local_now, body,
        )
        .c(h!())?;
    let timestamp = extracted_dt.as_ref().and_then(|dt| {
        timezone
            .from_local_datetime(&dt.datetime)
            .single()
            .map(|datetime| datetime.to_rfc3339_opts(SecondsFormat::Secs, true))
    });
    let is_time_null = extracted_dt.map(|dt| !dt.has_time);
    let comments = if comment_parsing_enabled {
        let comment_blacklist =
            crate::sigint::comments::load_blacklist(dbx).await.c(h!())?;
        crate::sigint::parser::parse_comments_with_blacklist(
            body,
            &comment_blacklist,
        )
    } else {
        crate::sigint::parser::ParsedComments::default()
    };

    Ok(DirectSubmitParseRsp {
        ai_callsign_warning: None,
        text: text.body,
        freq: crate::rer_importer::frequency::extract_freq(body)?
            .map(|freq| crate::rer_importer::frequency::etalon(&freq)),
        coords: coords
            .into_iter()
            .map(|coords| crate::rer_importer::types::GeoCoordinates {
                lat: coords.lat,
                lon: coords.lng,
            })
            .collect(),
        to: callsigns,
        timestamp,
        is_time_null,
        comment: comments.bottom.or(comments.top),
        post: crate::rer_importer::post::extract_post(body)?,
        unit,
        unit_v2,
        locations: unit_and_location
            .locality
            .map(|l| {
                l.split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default(),
    })
}

pub async fn submit_signal_message(
    login: &uuid::Uuid,
    env: &Env,
    payload: DirectSubmitPayload,
) -> Result<DirectSubmitRsp, AppError> {
    crate::users::role_settings::validate_creation(&env.dbx, login, &payload)
        .await
        .c(h!())?;
    save_signal_message(login, env, None, payload).await
}

pub async fn edit_signal_message(
    login: &uuid::Uuid,
    env: &Env,
    signal_message_id: i64,
    payload: DirectSubmitPayload,
) -> Result<DirectSubmitRsp, AppError> {
    save_signal_message(login, env, Some(signal_message_id), payload).await
}

async fn save_signal_message(
    login: &uuid::Uuid,
    env: &Env,
    signal_message_id: Option<i64>,
    mut payload: DirectSubmitPayload,
) -> Result<DirectSubmitRsp, AppError> {
    let is_new_message = signal_message_id.is_none();
    if payload.engaged_message_id.is_some()
        && (!is_new_message
            || !payload.parent_signal_message_ids.is_empty()
            || !payload.copy_source_signal_message_ids.is_empty())
    {
        return Err(AppError::BL {
            msg:
                "Відповідь не можна поєднувати з редагуванням або копіюванням."
                    .to_string(),
        });
    }
    let upload_urls = payload.upload_urls.clone().unwrap_or_default();
    let attachment_updates = payload.attachment_updates.clone().unwrap_or(
        DirectSubmitAttachmentUpdates {
            replacements: vec![],
            renames: vec![],
        },
    );
    let delete_uploaded_attachments = env
        .config
        .feature_delete_uploaded_attachment
        .unwrap_or(FEATURE_DELETE_UPLOADED_ATTACHMENT_DEFAULT);

    let txn = env.dbx.begin().await.c(h!())?;
    if let Some(message_id) = signal_message_id {
        crate::messenger::group::native::lock_message_groups_if_native(
            &txn,
            message_id,
            payload.signal_group_master_key.as_deref().map(str::trim),
        )
        .await
        .c(h!())?;
    }
    let allowed_groups =
        crate::messenger::group::get_identity_sigint_groups(&txn, login)
            .await
            .c(h!())?;
    let stored_parent_signal_message_ids = match signal_message_id {
        Some(signal_message_id) => {
            query::find_intel_product_parent_ids(&txn, signal_message_id)
                .await
                .c(h!())?
        }
        None => vec![],
    };
    let parent_signal_message_ids = match signal_message_id {
        Some(_) => stored_parent_signal_message_ids,
        None => query::normalize_copy_parent_signal_message_ids(
            &txn,
            &payload.parent_signal_message_ids,
        )
        .await
        .c(h!())?,
    };
    let copy_parent_signal_message_ids = match signal_message_id {
        Some(_) => &[][..],
        None => parent_signal_message_ids.as_slice(),
    };
    let copy_source_signal_message_ids = match signal_message_id {
        Some(_) => &[][..],
        None if payload.copy_source_signal_message_ids.is_empty() => {
            parent_signal_message_ids.as_slice()
        }
        None => payload.copy_source_signal_message_ids.as_slice(),
    };
    let is_intelligence_report = !parent_signal_message_ids.is_empty();
    validate_direct_submit_payload(
        env,
        &payload,
        signal_message_id.is_none(),
        is_intelligence_report,
    )
    .c(h!())?;
    let uploads = resolve_direct_submit_uploads(env, login, &upload_urls)
        .await
        .c(h!())?;
    let replacement_urls = attachment_updates
        .replacements
        .iter()
        .map(|replacement| replacement.upload_url.clone())
        .collect::<Vec<_>>();
    let replacement_uploads =
        resolve_direct_submit_uploads(env, login, &replacement_urls)
            .await
            .c(h!())?;

    let signal_group_master_key = payload
        .signal_group_master_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty());
    let signal_group = if let (None, Some(engaged_message_id)) =
        (signal_message_id, payload.engaged_message_id)
    {
        Some(
            crate::message_reply::prepare_submission(
                &txn,
                login,
                engaged_message_id,
                signal_group_master_key,
            )
            .await
            .c(h!())?,
        )
    } else {
        match signal_group_master_key {
            Some(signal_group_master_key) => Some(
                query::find_available_signal_group(
                    &txn,
                    login,
                    signal_group_master_key,
                )
                .await
                .c(h!())?,
            ),
            None => None,
        }
    };
    let logins = crate::users::get_organism_login_ids_by_id(&txn, login)
        .await
        .c(h!())?;

    if signal_message_id.is_none() && !parent_signal_message_ids.is_empty() {
        query::find_copyable_signal_messages_for_copy(
            &txn,
            &parent_signal_message_ids,
            &allowed_groups,
            login,
            &logins,
        )
        .await
        .c(h!())?;
    }

    let copy_sources = if copy_source_signal_message_ids.is_empty() {
        vec![]
    } else {
        query::find_copyable_signal_messages_for_copy(
            &txn,
            copy_source_signal_message_ids,
            &allowed_groups,
            login,
            &logins,
        )
        .await
        .c(h!())?
    };
    let signal_message = match signal_message_id {
        Some(signal_message_id) => Some(
            query::find_editable_signal_message(
                &txn,
                signal_message_id,
                &allowed_groups,
                login,
                &logins,
            )
            .await
            .c(h!())?,
        ),
        None => None,
    };
    if let Some(signal_message) = &signal_message {
        query::ensure_edit_source_group_available(
            &txn,
            &allowed_groups,
            signal_message.id,
            payload.source_signal_group_master_key.as_deref(),
        )
        .await
        .c(h!())?;
        if !is_intelligence_report {
            query::ensure_edit_group_change_allowed(
                &env.dbx,
                &txn,
                login,
                signal_message,
                payload.source_signal_group_master_key.as_deref(),
                signal_group_master_key,
            )
            .await
            .c(h!())?;
        }
    }

    let deleted_media_ids = payload
        .deleted_media_ids
        .as_deref()
        .unwrap_or_default()
        .iter()
        .map(|media_id| {
            Uuid::parse_str(media_id)
                .map_err(anyhow::Error::from)
                .map_err(AppError::from)
        })
        .collect::<Result<Vec<_>, AppError>>()
        .c(h!())?;
    let (retained_media_count, media_to_delete) = match signal_message_id {
        Some(signal_message_id) => {
            load_edit_media(env, &txn, signal_message_id, &deleted_media_ids)
                .await
                .c(h!())?
        }
        None => {
            let media = load_copy_media(
                env,
                &txn,
                copy_source_signal_message_ids,
                &payload,
            )
            .await
            .c(h!())?;
            (media.len(), vec![])
        }
    };
    let existing_media = match signal_message_id {
        Some(signal_message_id) => crate::messenger::audio_ref::for_messages(
            env,
            &txn,
            &[signal_message_id],
        )
        .await
        .c(h!())?,
        None => {
            load_copy_media(env, &txn, copy_source_signal_message_ids, &payload)
                .await
                .c(h!())?
        }
    };
    validate_attachment_updates(
        signal_message_id.is_some(),
        signal_message_id.is_none() && !parent_signal_message_ids.is_empty(),
        &attachment_updates,
        &existing_media,
        &deleted_media_ids,
    )
    .c(h!())?;

    validate_direct_submit_content(&payload, retained_media_count).c(h!())?;
    validate_direct_submit_attachment_count(
        retained_media_count,
        uploads.len(),
    )
    .c(h!())?;
    let sender = match signal_message
        .as_ref()
        .and_then(|signal_message| signal_message.sender.clone())
    {
        Some(sender) => sender,
        None => query::ensure_current_user_sender(&txn, login)
            .await
            .c(h!())?,
    };
    let existing_device_name_id = match signal_message_id {
        Some(signal_message_id) => {
            query::find_inbox_item_device_name_id(&txn, signal_message_id)
                .await
                .c(h!())?
        }
        None => None,
    };
    let device_name_id = match payload.device_name_id {
        Some(device_name_id) => device_name_id,
        None => existing_device_name_id,
    };
    if let Some(device_name_id) = device_name_id {
        query::validate_device_name_id(&txn, device_name_id)
            .await
            .c(h!())?;
    }
    let is_time_null = match payload.is_time_null {
        Some(is_time_null) => Some(is_time_null),
        None => match signal_message_id {
            Some(id) => query::find_inbox_item_is_time_null(&txn, id)
                .await
                .c(h!())?,
            None => None,
        },
    };
    let previous_timestamp =
        signal_message.and_then(|signal_message| signal_message.timestamp);
    let keep_timestamp_missing = is_time_null != Some(true)
        && payload.timestamp.is_none()
        && ((signal_message_id.is_some() && previous_timestamp.is_none())
            || !copy_sources.is_empty());
    let unit_requested =
        is_new_message || payload.unit_id.is_some() || payload.create_unit;
    let selected_unit = if unit_requested {
        super::units::resolve_unit(
            &txn,
            login,
            &payload,
            copy_source_signal_message_ids,
        )
        .await
        .c(h!())?
    } else {
        super::units::preserve_unit(&txn, signal_message_id.c(h!())?, &payload)
            .await
            .c(h!())?
    };
    if let Some(unit) = &selected_unit {
        payload.unit = Some(unit.name.clone());
    }
    let submit_item = direct_submit_payload_to_item(
        &payload,
        sender,
        previous_timestamp,
        is_time_null,
    )
    .c(h!())?;
    let submitted = persist_direct_submit_item(
        env,
        &txn,
        signal_message_id,
        signal_group,
        &parent_signal_message_ids,
        &allowed_groups,
        login,
        &logins,
        submit_item,
        !uploads.is_empty() || retained_media_count > 0,
        keep_timestamp_missing,
        payload.source_signal_group_master_key.as_deref(),
    )
    .await
    .c(h!())?;
    if let (true, Some(id)) = (is_new_message, payload.engaged_message_id) {
        crate::message_reply::insert(
            &txn,
            Some(id),
            submitted.signal_message_id,
            false,
            false,
        )
        .await
        .c(h!())?;
    }
    if let Some(unit) = &selected_unit {
        super::units::attach_unit(&txn, submitted.inbox_id, unit)
            .await
            .c(h!())?;
    }
    if let Some(is_time_null) = is_time_null {
        query::set_inbox_item_is_time_null(
            &txn,
            submitted.inbox_id,
            is_time_null,
        )
        .await
        .c(h!())?;
    }
    let network = payload
        .network
        .as_ref()
        .and_then(|network| network.name.as_deref())
        .map(str::trim)
        .filter(|network| !network.is_empty())
        .map(str::to_string);
    query::set_inbox_item_network(&txn, submitted.inbox_id, network)
        .await
        .c(h!())?;

    let mut rsp = finish_direct_submit(
        env,
        txn,
        submitted,
        login,
        &logins,
        device_name_id,
        &uploads,
        &attachment_updates,
        &replacement_uploads,
        &existing_media,
        &media_to_delete,
        delete_uploaded_attachments,
        copy_parent_signal_message_ids,
        copy_source_signal_message_ids,
        &payload,
        is_intelligence_report,
        is_new_message,
    )
    .await
    .c(h!())?;
    if unit_requested && selected_unit.is_some() {
        crate::sigint::unit::fanout_unit_changed_data(env)
            .await
            .c(h!())?;
    }

    let req = crate::rer_importer::types::InboxMessagesReq {
        highlight_points: Some(true),
        ..Default::default()
    };
    let messages = crate::rer_importer::inbox::messages_by_id_bl(
        login,
        &logins,
        env,
        &[rsp.signal_message_id],
        &req,
    )
    .await
    .c(h!())?;
    if let Some((_, message)) = messages.into_iter().next() {
        rsp.message = Some(message);
    }

    Ok(rsp)
}

fn validate_direct_submit_payload(
    env: &Env,
    payload: &DirectSubmitPayload,
    validate_parent_ids: bool,
    is_intelligence_report: bool,
) -> Result<(), AppError> {
    let upload_urls = payload.upload_urls.as_deref().unwrap_or_default();
    validate_signal_group_master_key(
        payload.signal_group_master_key.as_deref(),
        is_intelligence_report || payload.engaged_message_id.is_some(),
    )?;
    if !upload_urls.is_empty()
        && (env.config.s3_config.is_none() || env.s3.is_none())
    {
        return Err(AppError::BL {
            msg: "Завантаження медіафайлів зараз недоступне. Збережіть повідомлення без них або зверніться до адміністратора."
                .to_string(),
        });
    }
    if validate_parent_ids
        && payload.parent_signal_message_ids.len()
            != payload
                .parent_signal_message_ids
                .iter()
                .collect::<HashSet<_>>()
                .len()
    {
        return Err(AppError::BL {
            msg:
                "Список батьківських повідомлень не повинен містити дублікати."
                    .to_string(),
        });
    }
    Ok(())
}

fn validate_attachment_updates(
    is_edit: bool,
    is_copy: bool,
    updates: &DirectSubmitAttachmentUpdates,
    existing_media: &[crate::entities::signal_message_media::Model],
    deleted_media_ids: &[Uuid],
) -> Result<(), AppError> {
    if !is_edit && !updates.replacements.is_empty() {
        return Err(AppError::BL {
            msg: "Замінювати вкладення можна лише під час редагування."
                .to_string(),
        });
    }
    if !is_edit && !is_copy && !updates.renames.is_empty() {
        return Err(AppError::BL {
            msg: "Перейменовувати вкладення можна лише під час редагування або копіювання повідомлення."
                .to_string(),
        });
    }
    if !is_edit {
        let mut ids = HashSet::new();
        for rename in &updates.renames {
            let id = parse_attachment_media_id(&rename.media_id).c(h!())?;
            let media = existing_media
                .iter()
                .find(|media| media.id == id)
                .ok_or(AppError::NotFound)
                .c(h!())?;
            if !ids.insert(id) {
                return Err(AppError::BL {
                    msg: "Вкладення не можуть повторюватися.".to_string(),
                });
            }
            validate_file_name(&rename.file_name).c(h!())?;
            if media.file_ext.as_deref().map(str::to_ascii_lowercase)
                != file_extension(&rename.file_name)
                    .map(str::to_ascii_lowercase)
            {
                return Err(AppError::BL {
                    msg: "Розширення файлу змінювати не можна.".to_string(),
                });
            }
        }
        return Ok(());
    }
    let existing_ids = existing_media
        .iter()
        .map(|media| media.id)
        .collect::<HashSet<_>>();
    let mut ids = HashSet::new();
    let mut urls = HashSet::new();
    for replacement in &updates.replacements {
        let id = parse_attachment_media_id(&replacement.media_id).c(h!())?;
        let Some(media) = existing_media.iter().find(|media| media.id == id)
        else {
            return Err(AppError::BL {
                msg: "Вкладення для заміни не може бути видаленим, повтореним або недоступним."
                    .to_string(),
            });
        };
        if !existing_ids.contains(&id)
            || !ids.insert(id)
            || !urls.insert(&replacement.upload_url)
            || deleted_media_ids.contains(&id)
        {
            return Err(AppError::BL {
                msg: "Вкладення для заміни не може бути видаленим, повтореним або недоступним."
                .to_string(),
            });
        }
        if !media_is_editable_image(media) {
            return Err(AppError::BL {
                msg: "Замінювати можна лише зображення JPEG, PNG або WebP."
                    .to_string(),
            });
        }
    }
    for rename in &updates.renames {
        let id = parse_attachment_media_id(&rename.media_id).c(h!())?;
        let media = existing_media
            .iter()
            .find(|media| media.id == id)
            .ok_or(AppError::NotFound)
            .c(h!())?;
        if !ids.insert(id) {
            return Err(AppError::BL {
                msg: "Вкладення не можуть повторюватися.".to_string(),
            });
        }
        validate_file_name(&rename.file_name).c(h!())?;
        if media.file_ext.as_deref().map(str::to_ascii_lowercase)
            != file_extension(&rename.file_name).map(str::to_ascii_lowercase)
        {
            return Err(AppError::BL {
                msg: "Розширення файлу змінювати не можна.".to_string(),
            });
        }
    }
    Ok(())
}

fn media_is_editable_image(
    media: &crate::entities::signal_message_media::Model,
) -> bool {
    let content_type = media
        .content_type
        .split(';')
        .next()
        .unwrap_or(&media.content_type)
        .trim()
        .to_ascii_lowercase();
    if matches!(
        content_type.as_str(),
        "image/jpeg" | "image/jpg" | "image/png" | "image/webp"
    ) {
        return true;
    }
    if !content_type.is_empty() && content_type != "application/octet-stream" {
        return false;
    }
    media.file_name.as_deref().is_some_and(|file_name| {
        file_extension(file_name).is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "jpg" | "jpeg" | "png" | "webp"
            )
        })
    })
}

fn parse_attachment_media_id(media_id: &str) -> Result<Uuid, AppError> {
    Uuid::parse_str(media_id).map_err(|_| AppError::NotFound)
}

fn validate_file_name(file_name: &str) -> Result<(), AppError> {
    let file_name = file_name.trim();
    if file_name.is_empty()
        || file_name.chars().any(|ch| {
            ch.is_control()
                || matches!(
                    ch,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
        })
    {
        return Err(AppError::BL {
            msg: "Назва файлу містить неприпустимі символи.".to_string(),
        });
    }
    Ok(())
}

fn file_extension(file_name: &str) -> Option<&str> {
    std::path::Path::new(file_name)
        .extension()
        .and_then(|extension| extension.to_str())
        .filter(|extension| !extension.is_empty())
}

fn validate_signal_group_master_key(
    signal_group_master_key: Option<&str>,
    is_intelligence_report: bool,
) -> Result<(), AppError> {
    if !is_intelligence_report
        && signal_group_master_key.is_none_or(|key| key.trim().is_empty())
    {
        return Err(AppError::Form(BTreeMap::from([(
            "signal_group_master_key".to_string(),
            "Оберіть групу.".to_string(),
        )])));
    }
    Ok(())
}

fn validate_direct_submit_content(
    payload: &DirectSubmitPayload,
    retained_media_count: usize,
) -> Result<(), AppError> {
    if has_direct_submit_content(payload) || retained_media_count > 0 {
        return Ok(());
    }
    Err(AppError::BL {
        msg: "Додайте текст повідомлення або хоча б один медіафайл."
            .to_string(),
    })
}

fn validate_direct_submit_attachment_count(
    retained_media_count: usize,
    new_media_count: usize,
) -> Result<(), AppError> {
    if retained_media_count.saturating_add(new_media_count)
        <= SIGINT_MESSAGE_MAX_ATTACHMENTS
    {
        return Ok(());
    }
    Err(AppError::BL {
        msg: format!(
            "Кількість вкладень не може перевищувати {SIGINT_MESSAGE_MAX_ATTACHMENTS}."
        ),
    })
}

fn has_direct_submit_content(payload: &DirectSubmitPayload) -> bool {
    payload
        .full_body
        .as_deref()
        .is_some_and(|body| !body.trim().is_empty())
        || payload
            .text
            .as_deref()
            .is_some_and(|body| !body.trim().is_empty())
        || payload
            .upload_urls
            .as_ref()
            .is_some_and(|upload_urls| !upload_urls.is_empty())
}

async fn load_edit_media(
    env: &Env,
    txn: &DatabaseTransaction,
    signal_message_id: i64,
    deleted_media_ids: &[Uuid],
) -> Result<(usize, Vec<crate::entities::signal_message_media::Model>), AppError>
{
    let media = crate::messenger::audio_ref::for_messages(
        env,
        txn,
        &[signal_message_id],
    )
    .await
    .c(h!())?;
    let deleted_media_ids =
        deleted_media_ids.iter().copied().collect::<HashSet<_>>();
    let (media_to_delete, retained_media): (Vec<_>, Vec<_>) = media
        .into_iter()
        .partition(|media| deleted_media_ids.contains(&media.id));
    Ok((retained_media.len(), media_to_delete))
}

async fn load_copy_media(
    env: &Env,
    txn: &DatabaseTransaction,
    source_signal_message_ids: &[i64],
    payload: &DirectSubmitPayload,
) -> Result<Vec<crate::entities::signal_message_media::Model>, AppError> {
    if source_signal_message_ids.is_empty() {
        if payload.retained_media_ids.is_some() {
            return Err(AppError::BL {
                msg: "Медіафайли можна зберегти лише для копії повідомлення."
                    .to_string(),
            });
        }
        return Ok(vec![]);
    }
    let source_media = crate::messenger::audio_ref::for_messages_locked(
        env,
        txn,
        source_signal_message_ids,
    )
    .await
    .c(h!())?;
    let deleted_media_ids = parse_media_ids(
        payload.deleted_media_ids.as_deref().unwrap_or_default(),
    )
    .c(h!())?;
    let source_media_ids = source_media
        .iter()
        .map(|media| media.id)
        .collect::<HashSet<_>>();
    if deleted_media_ids
        .iter()
        .any(|media_id| !source_media_ids.contains(media_id))
    {
        return Err(AppError::NotFound);
    }
    let retained_media_ids = match payload.retained_media_ids.as_deref() {
        Some(ids) => parse_media_ids(ids).c(h!())?,
        None => source_media.iter().map(|media| media.id).collect(),
    };
    let retained_media_ids = retained_media_ids
        .into_iter()
        .filter(|id| !deleted_media_ids.contains(id))
        .collect::<HashSet<_>>();
    let mut source_media_by_id = source_media
        .into_iter()
        .map(|media| (media.id, media))
        .collect::<BTreeMap<_, _>>();
    retained_media_ids
        .into_iter()
        .map(|media_id| {
            source_media_by_id
                .remove(&media_id)
                .ok_or(AppError::NotFound)
        })
        .collect()
}

fn parse_media_ids(media_ids: &[String]) -> Result<Vec<Uuid>, AppError> {
    media_ids
        .iter()
        .map(|media_id| {
            Uuid::parse_str(media_id).map_err(|_| AppError::BL {
                msg: format!(
                    "Некоректний ідентифікатор медіафайлу: {media_id}"
                ),
            })
        })
        .collect()
}

async fn resolve_direct_submit_uploads(
    env: &Env,
    login: &uuid::Uuid,
    upload_urls: &[String],
) -> Result<Vec<MediaUploadInput>, AppError> {
    let tus_handler = crate::sigint::file_upload::tus::TusHandler::new(
        env.config.storage_dir.clone(),
        crate::sigint::file_upload::TUS_PATH_BASE,
    );
    Ok(tus_handler
        .resolve_completed_uploads(login, upload_urls)
        .await
        .c(h!())?)
}

async fn persist_direct_submit_item(
    env: &Env,
    txn: &DatabaseTransaction,
    signal_message_id: Option<i64>,
    signal_group: Option<crate::entities::signal_group::Model>,
    parent_signal_message_ids: &[i64],
    allowed_groups: &[String],
    login: &uuid::Uuid,
    logins: &Vec<uuid::Uuid>,
    submit_item: InboxSubmitItem,
    allow_empty_content: bool,
    keep_timestamp_missing: bool,
    source_group_master_key: Option<&str>,
) -> Result<SubmittedInboxItem, AppError> {
    let (datasource_id, groups) = match signal_group {
        Some(signal_group) => {
            crate::messenger::group::native::lock_for_publish_if_native(
                txn,
                &signal_group.master_key,
                login,
            )
            .await
            .c(h!())?;
            let datasource_id = signal_group.datasource_id.unwrap_or(
                query::resolve_datasource_id_for_group(
                    txn,
                    &signal_group.master_key,
                )
                .await
                .c(h!())?,
            );
            let datasource_group_id =
                crate::messenger::group::ensure_datasource_group_id(
                    txn,
                    signal_group.master_key.clone(),
                    datasource_id,
                )
                .await
                .c(h!())?;
            (
                Some(datasource_id),
                vec![(signal_group.master_key, datasource_group_id)],
            )
        }
        None => {
            let datasource_id = if signal_message_id.is_some()
                || parent_signal_message_ids.is_empty()
            {
                None
            } else {
                query::resolve_parent_datasource_id_or_none(
                    txn,
                    parent_signal_message_ids,
                    allowed_groups,
                )
                .await
                .c(h!())?
            };
            (datasource_id, vec![])
        }
    };
    let linked_comment = if signal_message_id.is_none()
        && parent_signal_message_ids.is_empty()
    {
        submit_item
            .comment
            .as_deref()
            .map(str::trim)
            .filter(|comment| !comment.is_empty())
            .map(str::to_string)
    } else {
        None
    };
    let submitted = match signal_message_id {
        Some(signal_message_id) => {
            crate::rer_importer::inbox::submit_bl::edit_inbox_item_with_groups_location_mode(
                env,
                txn,
                signal_message_id,
                datasource_id,
                &groups,
                login,
                logins,
                submit_item,
                allow_empty_content,
                keep_timestamp_missing,
                crate::rer_importer::inbox::bl::InboxLocationSubmitMode::PreserveTyped,
                source_group_master_key,
            )
            .await
            .c(h!())?
        }
        None => {
            crate::rer_importer::inbox::submit_bl::submit_inbox_item_with_groups_location_mode(
                env,
                txn,
                datasource_id,
                &groups,
                login,
                logins,
                submit_item,
                allow_empty_content,
                keep_timestamp_missing,
                crate::rer_importer::inbox::bl::InboxLocationSubmitMode::PreserveTyped,
            )
            .await
            .c(h!())?
        }
    };
    let legacy_comment_id = if linked_comment.is_some() {
        query::find_unmigrated_legacy_comment_id(
            txn,
            submitted.signal_message_id,
            login,
            linked_comment.as_deref().unwrap_or_default(),
        )
        .await
        .c(h!())?
    } else {
        None
    };
    if let Some(comment) = linked_comment {
        let linked_message_id =
            crate::sigint::comments::create_linked_message_comment(
                env,
                txn,
                submitted.signal_message_id,
                login,
                logins,
                &comment,
                None,
                None,
            )
            .await
            .c(h!())?;
        if let Some(legacy_comment_id) = legacy_comment_id {
            crate::sigint::comments::mark_legacy_comment_as_migrated(
                txn,
                legacy_comment_id,
                linked_message_id,
            )
            .await
            .c(h!())?;
        }
    }
    Ok(submitted)
}

async fn cleanup_replacement_uploads(
    env: &Env,
    replacements: &[crate::messenger::media::ReplacementMediaResult],
) {
    let mut uploads = vec![];
    for replacement in replacements {
        replacement
            .cleanup_after_rollback(&env.config, &env.s3)
            .await;
        uploads.extend(replacement.uploaded_files_ready_after_discard());
    }
    crate::messenger::media::delete_uploaded_attachment_files(&uploads).await;
}

async fn cleanup_failed_direct_submit_uploads(
    env: &Env,
    upload_result: &crate::messenger::media::StoreMediaAttachmentsResult,
    replacements: &[crate::messenger::media::ReplacementMediaResult],
    delete_uploaded_attachments: bool,
) {
    cleanup_replacement_uploads(env, replacements).await;
    crate::messenger::media::delete_stored_media_files(
        &env.dbx,
        &upload_result.media,
        &[],
        &env.config,
        &env.s3,
    )
    .await;
    crate::messenger::media::delete_local_media_files(
        &upload_result.media,
        &env.config,
    )
    .await;
    if delete_uploaded_attachments {
        crate::messenger::media::delete_uploaded_attachment_files(
            &upload_result.stored_uploads,
        )
        .await;
    }
}

async fn finish_direct_submit(
    env: &Env,
    txn: DatabaseTransaction,
    submitted: SubmittedInboxItem,
    login: &uuid::Uuid,
    logins: &[uuid::Uuid],
    device_name_id: Option<i64>,
    uploads: &[MediaUploadInput],
    attachment_updates: &DirectSubmitAttachmentUpdates,
    replacement_uploads: &[MediaUploadInput],
    existing_media: &[crate::entities::signal_message_media::Model],
    media_to_delete: &[crate::entities::signal_message_media::Model],
    delete_uploaded_attachments: bool,
    parent_signal_message_ids: &[i64],
    copy_source_signal_message_ids: &[i64],
    payload: &DirectSubmitPayload,
    is_intelligence_report: bool,
    is_new_message: bool,
) -> Result<DirectSubmitRsp, AppError> {
    let signal_message_id = submitted.signal_message_id;
    let inbox_item_id = submitted.inbox_id;

    query::set_inbox_items_device_name(
        &txn,
        vec![inbox_item_id],
        device_name_id,
    )
    .await
    .c(h!())?;

    let deletion = if delete_uploaded_attachments {
        crate::messenger::media::UploadedAttachmentDeletion::DeleteAfterCommit
    } else {
        crate::messenger::media::UploadedAttachmentDeletion::Preserve
    };
    let upload_result = crate::messenger::media::store_media_attachments(
        uploads,
        signal_message_id,
        submitted.signal_message_uuid,
        &env.config,
        &env.s3,
        &txn,
        deletion,
    )
    .await
    .c(h!())?;

    let replacement_old_media = attachment_updates
        .replacements
        .iter()
        .map(|replacement| {
            let id =
                parse_attachment_media_id(&replacement.media_id).c(h!())?;
            existing_media
                .iter()
                .find(|media| media.id == id)
                .cloned()
                .ok_or(AppError::NotFound)
        })
        .collect::<Result<Vec<_>, AppError>>()
        .c(h!())?;
    let replacement_media_ids = replacement_old_media
        .iter()
        .map(|media| media.id)
        .collect::<Vec<_>>();
    let replacement_ocr_result_keys =
        crate::ocr::load_result_keys(&txn, &replacement_media_ids)
            .await
            .c(h!())?;
    let replacement_converted_result_keys =
        crate::sigint::media_conversion::lock_and_load_converted_storage_keys(
            &txn,
            &replacement_media_ids,
        )
        .await
        .c(h!())?;
    let mut replacement_results = Vec::new();
    for (replacement, upload) in attachment_updates
        .replacements
        .iter()
        .zip(replacement_uploads)
    {
        let id = parse_attachment_media_id(&replacement.media_id).c(h!())?;
        let existing = existing_media
            .iter()
            .find(|media| media.id == id)
            .ok_or(AppError::NotFound)
            .c(h!())?;
        match crate::messenger::media::replace_media_attachment(
            upload,
            existing,
            &env.config,
            &env.s3,
            &txn,
            deletion,
        )
        .await
        .c(h!())
        {
            Ok(result) => replacement_results.push(result),
            Err(err) => {
                cleanup_failed_direct_submit_uploads(
                    env,
                    &upload_result,
                    &replacement_results,
                    delete_uploaded_attachments,
                )
                .await;
                return Err(err.into());
            }
        }
    }

    let precommit_result = async {
        for replacement in &replacement_results {
            crate::ocr::queue_replaced_media(&txn, &replacement.media)
                .await
                .c(h!())?;
        }
        if !is_new_message {
            for rename in &attachment_updates.renames {
                let id = parse_attachment_media_id(&rename.media_id).c(h!())?;
                if crate::messenger::audio_ref::rename(
                    &txn,
                    signal_message_id,
                    id,
                    rename.file_name.trim(),
                )
                .await
                .c(h!())?
                {
                    continue;
                }
                crate::entities::signal_message_media::ActiveModel {
                    id: Set(id),
                    file_name: Set(Some(rename.file_name.trim().to_string())),
                    ..Default::default()
                }
                .update(&txn)
                .await
                .c(h!())?;
            }
        }

        if is_new_message {
            let mut scheduled_media = upload_result.media.clone();
            scheduled_media.extend(
                replacement_results
                    .iter()
                    .map(|result| result.media.clone()),
            );
            let mut scheduled_uploads = upload_result.stored_uploads.clone();
            scheduled_uploads.extend_from_slice(replacement_uploads);
            crate::sigint::media_conversion::schedule_uploaded_media(
                &txn,
                signal_message_id,
                &scheduled_media,
                &scheduled_uploads,
            )
            .await
            .c(h!())?;
        }

        let mut removed_media = media_to_delete.to_vec();
        removed_media.extend(replacement_old_media);
        let media_to_delete_ids = removed_media
            .iter()
            .map(|media| media.id)
            .collect::<Vec<_>>();
        let mut ocr_result_keys =
            crate::ocr::load_result_keys(&txn, &media_to_delete_ids)
                .await
                .c(h!())?;
        ocr_result_keys.extend(replacement_ocr_result_keys);
        let mut converted_result_keys =
        crate::sigint::media_conversion::lock_and_load_converted_storage_keys(
            &txn,
            &media_to_delete_ids,
        )
        .await
        .c(h!())?;
        converted_result_keys.extend(replacement_converted_result_keys);

        if !media_to_delete.is_empty() {
            crate::messenger::audio_ref::delete(
                &txn,
                signal_message_id,
                &media_to_delete
                    .iter()
                    .map(|media| media.id)
                    .collect::<Vec<_>>(),
            )
            .await
            .c(h!())?;
            crate::entities::signal_message_media::Entity::delete_many()
                .filter(
                    crate::entities::signal_message_media::Column::Id
                        .is_in(media_to_delete.iter().map(|media| media.id)),
                )
                .exec(&txn)
                .await
                .c(h!())?;
        }
        let media_to_delete_after_commit =
            query::find_unreferenced_media(&txn, &removed_media)
                .await
                .c(h!())?;

        if !parent_signal_message_ids.is_empty() {
            let mut source_media = load_copy_media(
                env,
                &txn,
                copy_source_signal_message_ids,
                payload,
            )
            .await
            .c(h!())?;
            for rename in &attachment_updates.renames {
                let id = parse_attachment_media_id(&rename.media_id).c(h!())?;
                let media = source_media
                    .iter_mut()
                    .find(|media| media.id == id)
                    .ok_or(AppError::NotFound)
                    .c(h!())?;
                validate_file_name(&rename.file_name).c(h!())?;
                if media.file_ext.as_deref().map(str::to_ascii_lowercase)
                    != file_extension(&rename.file_name)
                        .map(str::to_ascii_lowercase)
                {
                    return Err(AppError::BL {
                        msg: "Розширення файлу змінювати не можна.".to_string(),
                    });
                }
                media.file_name = Some(rename.file_name.trim().to_string());
            }
            query::copy_signal_message_media(
                env,
                &txn,
                signal_message_id,
                submitted.signal_message_uuid,
                &source_media,
            )
            .await
            .c(h!())?;
            query::copy_signal_message_comments(
                env,
                &txn,
                parent_signal_message_ids,
                signal_message_id,
                login,
                logins,
                payload.comment.as_deref(),
            )
            .await
            .c(h!())?;
            query::copy_signal_message_relations(
                &txn,
                parent_signal_message_ids,
                inbox_item_id,
                login,
                payload,
            )
            .await
            .c(h!())?;
            query::insert_intel_product_links(
                &txn,
                signal_message_id,
                submitted.signal_message_uuid,
                parent_signal_message_ids,
            )
            .await
            .c(h!())?;
        }

        let deleted_media_ids = media_to_delete
            .iter()
            .map(|media| media.id)
            .collect::<Vec<_>>();
        crate::messenger::audio_ref::reconcile(env, &txn, signal_message_id)
            .await
            .c(h!())?;
        crate::transcriber::media_queue::reconcile_message(
            &txn,
            signal_message_id,
            &deleted_media_ids,
        )
        .await
        .c(h!())?;

        crate::sigint::worker::incoming_message_after_insert(
            &txn,
            signal_message_id,
        )
        .await
        .c(h!())?;

        txn.commit().await.c(h!())?;
        Ok((
            media_to_delete_after_commit,
            ocr_result_keys,
            converted_result_keys,
        ))
    }
    .await;
    let (media_to_delete_after_commit, ocr_result_keys, converted_result_keys) =
        match precommit_result {
            Ok(result) => result,
            Err(err) => {
                cleanup_failed_direct_submit_uploads(
                    env,
                    &upload_result,
                    &replacement_results,
                    delete_uploaded_attachments,
                )
                .await;
                return Err(err);
            }
        };

    for replacement in &replacement_results {
        replacement
            .finalize_after_commit(&env.config, &env.s3, &env.dbx)
            .await;
    }

    crate::messenger::media_local_cache::pin_message_best_effort(
        env,
        signal_message_id,
    )
    .await;

    if delete_uploaded_attachments {
        crate::messenger::media::delete_uploaded_attachment_files(
            &upload_result.uploaded_files_ready_for_deletion,
        )
        .await;
    }
    if !media_to_delete.is_empty() {
        crate::messenger::media::delete_local_media_files(
            media_to_delete,
            &env.config,
        )
        .await;
    }
    if !media_to_delete_after_commit.is_empty() || !ocr_result_keys.is_empty() {
        crate::messenger::media::delete_stored_media_files(
            &env.dbx,
            &media_to_delete_after_commit,
            &ocr_result_keys,
            &env.config,
            &env.s3,
        )
        .await;
    }
    crate::sigint::media_conversion::delete_stored_results_best_effort(
        env,
        &converted_result_keys,
    )
    .await;
    let mut redis = env.redis.clone();
    if is_intelligence_report {
        let mut changed_message_ids = parent_signal_message_ids.to_vec();
        if !changed_message_ids.contains(&inbox_item_id) {
            changed_message_ids.push(inbox_item_id);
        }
        crate::inbox::fanout_intelligence_report_changes(
            &mut redis,
            changed_message_ids,
        )
        .await
        .c(h!())?;
    } else {
        crate::inbox::fanout_inbox_changes(&mut redis, vec![inbox_item_id])
            .await
            .c(h!())?;
    }

    Ok(DirectSubmitRsp {
        signal_message_id,
        message: None,
    })
}

fn direct_submit_payload_to_item(
    payload: &DirectSubmitPayload,
    sender: String,
    previous_timestamp: Option<chrono::NaiveDateTime>,
    is_time_null: Option<bool>,
) -> anyhow::Result<InboxSubmitItem> {
    Ok(InboxSubmitItem {
        full_body: payload.full_body.clone(),
        text: payload.text.clone(),
        comment: payload.comment.clone(),
        freq: payload.freq.clone(),
        coords: payload.coords.clone(),
        from_callsign: payload.from_callsign.clone(),
        to: payload.to.clone(),
        tags: payload.tags.clone(),
        timestamp: direct_submit_timestamp(
            payload,
            previous_timestamp,
            is_time_null,
        )
        .c(h!())?,
        sender: Some(sender),
        post: payload.post.clone(),
        unit: payload.unit.clone(),
        locations: payload.locations.clone(),
        group_names: None,
        network: payload.network.clone(),
        dmr: payload.dmr.clone(),
        parse_body_coordinates: false,
    })
}

fn direct_submit_timestamp(
    payload: &DirectSubmitPayload,
    previous_timestamp: Option<chrono::NaiveDateTime>,
    is_time_null: Option<bool>,
) -> anyhow::Result<String> {
    let timestamp = payload.timestamp.clone().unwrap_or_else(|| {
        previous_timestamp
            .map(|timestamp| timestamp.and_utc())
            .unwrap_or_else(Utc::now)
            .to_rfc3339_opts(SecondsFormat::Millis, true)
    });
    if is_time_null != Some(true) {
        return Ok(timestamp);
    }
    let timezone = crate::config::get_tz();
    let date = chrono::DateTime::parse_from_rfc3339(&timestamp)
        .c(h!())?
        .with_timezone(&timezone)
        .date_naive();
    let noon = date
        .and_hms_opt(SIGINT_MESSAGE_DATE_ONLY_HOUR, 0, 0)
        .c(h!())?;
    let timestamp = timezone.from_local_datetime(&noon).single().c(h!())?;
    Ok(timestamp
        .with_timezone(&Utc)
        .to_rfc3339_opts(SecondsFormat::Millis, true))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::{
        ai_engine, device_name, intel_product, login, media_summary, ocr_job,
        ocr_settings, ocr_settings_ai_engine, palitra,
        palitra_highlight_worker_job, sigint_comment, sigint_inbox_item,
        sigint_inbox_item_point_token, sigint_inbox_item_tag, signal_message,
        signal_message_group, signal_message_media, system_settings, tag,
        tag_suggestion_worker_queue,
    };
    use crate::functest::tests::cleanup;
    use opendal::{services::Memory, Operator};
    use sea_orm::{
        ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait,
        IntoActiveModel, NotSet, PaginatorTrait, QueryFilter, Set,
    };
    use serde_json::json;
    use serial_test::serial;

    const TEST_LOGIN: &str = "Tester";
    const TEST_SIGNAL_GROUP_KEY: &str = "vukho-test-master-key";

    async fn enable_devices_section(db: &DatabaseConnection) {
        if let Some(settings) =
            system_settings::Entity::find().one(db).await.unwrap()
        {
            let mut settings = settings.into_active_model();
            settings.devices_section_enabled = Set(true);
            settings.update(db).await.unwrap();
        } else {
            system_settings::ActiveModel {
                devices_section_enabled: Set(true),
                ..Default::default()
            }
            .insert(db)
            .await
            .unwrap();
        }
    }

    fn direct_submit_payload(text: &str) -> DirectSubmitPayload {
        DirectSubmitPayload {
            is_time_null: None,
            full_body: None,
            text: Some(text.to_string()),
            comment: None,
            freq: None,
            coords: vec![],
            from_callsign: None,
            to: vec![],
            tags: None,
            timestamp: None,
            post: None,
            unit: None,
            unit_id: None,
            create_unit: false,
            locations: vec![],
            network: None,
            dmr: vec![],
            signal_group_master_key: Some(TEST_SIGNAL_GROUP_KEY.to_string()),
            source_signal_group_master_key: None,
            device_name_id: None,
            upload_urls: None,
            attachment_updates: None,
            deleted_media_ids: None,
            retained_media_ids: None,
            parent_signal_message_ids: vec![],
            copy_source_signal_message_ids: vec![],
            engaged_message_id: None,
        }
    }

    async fn set_signal_message_deleted(
        dbx: &DatabaseConnection,
        signal_message_id: i64,
        deleted: bool,
    ) {
        let mut signal_message =
            signal_message::Entity::find_by_id(signal_message_id)
                .one(dbx)
                .await
                .unwrap()
                .unwrap()
                .into_active_model();
        signal_message.deleted = Set(deleted);
        signal_message.update(dbx).await.unwrap();
    }

    #[tokio::test]
    #[serial]
    async fn issue_3955_destination_changes_require_delete_role_and_preserve_other_groups(
    ) {
        for (canonical_group, linked_datasource_group) in
            [(true, true), (true, false), (false, true), (false, false)]
        {
            assert_destination_changes(
                canonical_group,
                linked_datasource_group,
            )
            .await;
        }
    }

    async fn assert_destination_changes(
        canonical_group: bool,
        linked_datasource_group: bool,
    ) {
        use crate::entities::datasource_group;

        let env = cleanup().await.unwrap();
        let login = login::Entity::find()
            .filter(login::Column::Login.eq(TEST_LOGIN))
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        let created = submit_signal_message(
            &login.id,
            &env,
            direct_submit_payload("Original message"),
        )
        .await
        .unwrap();
        let original_link = signal_message_group::Entity::find()
            .filter(
                signal_message_group::Column::SignalMessageId
                    .eq(created.signal_message_id),
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        let original_group = datasource_group::Entity::find_by_id(
            original_link.datasource_group_id.unwrap(),
        )
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
        let destinations =
            seed_destination_groups(&env, &login, original_group.datasource_id)
                .await;
        let mut secondary_link = original_link.clone().into_active_model();
        secondary_link.id = NotSet;
        secondary_link.group_master_key =
            Set(Some(destinations[1].group_master_key.clone()));
        secondary_link.datasource_group_id = Set(Some(destinations[1].id));
        secondary_link.sender =
            Set(Some("issue-3955-secondary-sender".to_string()));
        secondary_link.message_uid =
            Set(Some("issue-3955-secondary-receipt".to_string()));
        let secondary_link = secondary_link.insert(&env.dbx).await.unwrap();
        assert_secondary_group_edit(
            &env,
            &login.id,
            created.signal_message_id,
            &original_group,
            &secondary_link,
            &destinations[0].group_master_key,
        )
        .await;

        set_group_link_ids(
            &env.dbx,
            created.signal_message_id,
            original_link.id,
            canonical_group,
            linked_datasource_group,
        )
        .await;

        edit_signal_message(
            &login.id,
            &env,
            created.signal_message_id,
            direct_submit_payload("Edited message"),
        )
        .await
        .unwrap();
        set_group_link_ids(
            &env.dbx,
            created.signal_message_id,
            original_link.id,
            canonical_group,
            linked_datasource_group,
        )
        .await;
        let original_link =
            signal_message_group::Entity::find_by_id(original_link.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        if !canonical_group {
            let mut duplicate_link = original_link.clone().into_active_model();
            duplicate_link.id = NotSet;
            duplicate_link.insert(&env.dbx).await.unwrap();
        }
        let mut payload = direct_submit_payload("Moved message");
        payload.locations = vec!["issue-3955-location".to_string()];
        payload.signal_group_master_key =
            Some(destinations[0].group_master_key.clone());
        let error = edit_signal_message(
            &login.id,
            &env,
            created.signal_message_id,
            payload.clone(),
        )
        .await
        .unwrap_err();
        assert!(
            matches!(error, AppError::Forbidden(message) if message.contains("DeleteMsg"))
        );
        let mut login = login.into_active_model();
        login.roles = Set(json!(["Rer", "DeleteMsg"]));
        let login = login.update(&env.dbx).await.unwrap();
        let mut inaccessible_payload = payload.clone();
        inaccessible_payload.signal_group_master_key =
            Some(destinations[2].group_master_key.clone());
        assert!(edit_signal_message(
            &login.id,
            &env,
            created.signal_message_id,
            inaccessible_payload
        )
        .await
        .is_err());
        let unchanged_link =
            signal_message_group::Entity::find_by_id(original_link.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(unchanged_link, original_link);

        let settlement =
            seed_group_move_settlement(&env.dbx, created.signal_message_id)
                .await;

        edit_signal_message(
            &login.id,
            &env,
            created.signal_message_id,
            payload,
        )
        .await
        .unwrap();
        let settlement =
            crate::entities::sigint_inbox_item_settlement::Entity::find_by_id(
                settlement.id,
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(settlement.is_undefined, None);
        let mut expected_link = original_link;
        expected_link.datasource_group_id = Some(destinations[0].id);
        expected_link.group_master_key =
            Some(destinations[0].group_master_key.clone());
        assert_eq!(
            signal_message_group::Entity::find_by_id(expected_link.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap(),
            expected_link
        );
        assert_eq!(
            signal_message_group::Entity::find_by_id(secondary_link.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap(),
            secondary_link
        );
        let message =
            signal_message::Entity::find_by_id(created.signal_message_id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(message.datasource_group_id, Some(destinations[0].id));
        for (group_key, expected_count) in [
            (TEST_SIGNAL_GROUP_KEY, 0),
            (destinations[0].group_master_key.as_str(), 1),
        ] {
            let query = crate::rer_importer::inbox::query::build_inbox_query_for_candidate_ids(
                &env.dbx,
                &login.id,
                &env,
                &crate::rer_importer::types::InboxMessagesReq {
                    since_id_noninclusive: Some(0),
                    selected_groups: Some(vec![group_key.to_string()]),
                    ..Default::default()
                },
                &[created.signal_message_id],
                false,
            )
            .await
            .unwrap();
            let messages = env
                .dbx
                .query_all_raw(sea_orm::Statement::from_string(
                    sea_orm::DbBackend::Postgres,
                    query,
                ))
                .await
                .unwrap();
            assert_eq!(messages.len(), expected_count);
        }
        let mut payload = direct_submit_payload("Moved into an existing group");
        payload.source_signal_group_master_key =
            Some(destinations[0].group_master_key.clone());
        payload.signal_group_master_key =
            Some(destinations[1].group_master_key.clone());
        edit_signal_message(
            &login.id,
            &env,
            created.signal_message_id,
            payload,
        )
        .await
        .unwrap();
        assert!(signal_message_group::Entity::find_by_id(expected_link.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .is_none());
        let remaining_groups = signal_message_group::Entity::find()
            .filter(
                signal_message_group::Column::SignalMessageId
                    .eq(created.signal_message_id),
            )
            .all(&env.dbx)
            .await
            .unwrap();
        assert_eq!(remaining_groups, vec![secondary_link]);
    }

    async fn seed_destination_groups(
        env: &Env,
        login: &login::Model,
        datasource_id: i64,
    ) -> Vec<crate::entities::datasource_group::Model> {
        use crate::entities::{
            datasource_group, sigint_zone_datasource, signal_group,
            signal_group_aor,
        };
        use crate::functest::tests::{
            mk_datasource_group, mk_sigint_zone_datasource, mk_signal_group,
        };

        let original_group_aor = signal_group_aor::Entity::find()
            .filter(
                signal_group_aor::Column::MasterKey.eq(TEST_SIGNAL_GROUP_KEY),
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        let mut destinations = vec![];
        for name in ["destination", "secondary", "inaccessible"] {
            let group = mk_signal_group(
                &env.dbx,
                signal_group::ActiveModel {
                    master_key: Set(format!("issue-3955-{name}")),
                    datasource_id: Set(Some(datasource_id)),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            let group = mk_datasource_group(
                &env.dbx,
                datasource_group::ActiveModel {
                    group_master_key: Set(group.master_key),
                    datasource_id: Set(datasource_id),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            if name != "inaccessible" {
                let mut group_aor =
                    original_group_aor.clone().into_active_model();
                group_aor.id = NotSet;
                group_aor.master_key = Set(group.group_master_key.clone());
                group_aor.insert(&env.dbx).await.unwrap();
                mk_sigint_zone_datasource(
                    &env.dbx,
                    sigint_zone_datasource::ActiveModel {
                        sigint_zone_id: Set(login.sigint_zone_id.unwrap()),
                        datasource_id: Set(group.datasource_id),
                        group_master_key: Set(group.group_master_key.clone()),
                        ..Default::default()
                    },
                )
                .await
                .unwrap();
            }
            destinations.push(group);
        }
        destinations
    }

    async fn set_group_link_ids(
        dbx: &DatabaseConnection,
        message_id: i64,
        group_link_id: i64,
        canonical_group: bool,
        linked_datasource_group: bool,
    ) {
        if !canonical_group {
            signal_message::ActiveModel {
                id: Set(message_id),
                datasource_group_id: Set(None),
                ..Default::default()
            }
            .update(dbx)
            .await
            .unwrap();
        }
        if !linked_datasource_group {
            signal_message_group::ActiveModel {
                id: Set(group_link_id),
                datasource_group_id: Set(None),
                ..Default::default()
            }
            .update(dbx)
            .await
            .unwrap();
        }
    }

    async fn assert_secondary_group_edit(
        env: &Env,
        login: &Uuid,
        message_id: i64,
        original_group: &crate::entities::datasource_group::Model,
        secondary_link: &signal_message_group::Model,
        nonmember_group_key: &str,
    ) {
        let mut payload =
            direct_submit_payload("Edited from a secondary group");
        payload.source_signal_group_master_key =
            secondary_link.group_master_key.clone();
        payload.signal_group_master_key =
            secondary_link.group_master_key.clone();
        edit_signal_message(login, env, message_id, payload.clone())
            .await
            .unwrap();
        let message = signal_message::Entity::find_by_id(message_id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(message.datasource_group_id, Some(original_group.id));
        assert_eq!(
            signal_message_group::Entity::find_by_id(secondary_link.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap(),
            *secondary_link
        );
        payload.source_signal_group_master_key =
            Some("not-a-message-group".to_string());
        assert!(edit_signal_message(login, env, message_id, payload)
            .await
            .is_err());
        let mut payload = direct_submit_payload("Rejected forged source group");
        payload.source_signal_group_master_key =
            Some(nonmember_group_key.to_string());
        payload.signal_group_master_key = Some(nonmember_group_key.to_string());
        assert!(edit_signal_message(login, env, message_id, payload)
            .await
            .is_err());
    }

    async fn seed_group_move_settlement(
        dbx: &DatabaseConnection,
        message_id: i64,
    ) -> crate::entities::sigint_inbox_item_settlement::Model {
        let mut item = sigint_inbox_item::Entity::find_by_id(message_id)
            .one(dbx)
            .await
            .unwrap()
            .unwrap()
            .into_active_model();
        item.location_v2 = Set(Some("|issue-3955-location|".to_string()));
        let item = item.update(dbx).await.unwrap();
        crate::entities::sigint_inbox_item_settlement::ActiveModel {
            item_id: Set(message_id),
            item_uuid: Set(item.id_uuid),
            settlement_text: Set("issue-3955-location".to_string()),
            is_undefined: Set(Some(true)),
            ..Default::default()
        }
        .insert(dbx)
        .await
        .unwrap()
    }

    #[test]
    fn direct_submit_maps_explicit_fields_without_parsing() {
        let payload: DirectSubmitPayload =
            serde_json::from_value(serde_json::json!({
                "full_body": "full source",
                "text": "body only",
                "comment": "operator comment",
                "from": "ALPHA",
                "to": ["BRAVO"],
                "timestamp": "2026-07-11T12:34:56Z",
                "signal_group_master_key": "group"
            }))
            .unwrap();

        let item = direct_submit_payload_to_item(
            &payload,
            "sender".to_string(),
            None,
            None,
        )
        .unwrap();

        assert_eq!(item.full_body.as_deref(), Some("full source"));
        assert_eq!(item.text.as_deref(), Some("body only"));
        assert_eq!(item.comment.as_deref(), Some("operator comment"));
        assert_eq!(item.from_callsign.as_deref(), Some("ALPHA"));
        assert_eq!(item.to, vec!["BRAVO"]);
        assert!(!item.parse_body_coordinates);
    }

    #[test]
    fn direct_submit_accepts_attachment_without_text() {
        let mut payload = direct_submit_payload("");
        payload.upload_urls = Some(vec!["attachment-url".to_string()]);

        assert!(has_direct_submit_content(&payload));
    }

    #[test]
    fn direct_edit_accepts_retained_attachment_without_text() {
        let payload = direct_submit_payload("");

        assert!(validate_direct_submit_content(&payload, 1).is_ok());
        assert!(validate_direct_submit_content(&payload, 0).is_err());
    }

    #[test]
    fn direct_edit_limits_retained_and_new_attachments_together() {
        assert!(validate_direct_submit_attachment_count(19, 1).is_ok());
        assert!(validate_direct_submit_attachment_count(20, 1).is_err());
    }

    #[test]
    fn direct_submit_requires_signal_group() {
        assert!(matches!(
            validate_signal_group_master_key(Some(" "), false),
            Err(AppError::Form(_))
        ));
        assert!(validate_signal_group_master_key(None, true).is_ok());
    }

    #[tokio::test]
    #[serial]
    async fn direct_submit_parse_3758_respects_comment_parsing_setting() {
        let env = cleanup().await.unwrap();
        let login = crate::users::login_id_by_name(&env.dbx, TEST_LOGIN)
            .await
            .unwrap();
        let settings = system_settings::ActiveModel {
            sigint_comment_parsing_enabled: Set(false),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let comment = "Важлива аналітична примітка";
        let body = "19.10.2026, 13:59\n149.5000\n\n- Прийом.";

        for enabled in [false, true, false] {
            let mut settings = settings.clone().into_active_model();
            settings.sigint_comment_parsing_enabled = Set(enabled);
            settings.update(&env.dbx).await.unwrap();
            for body in [
                format!("{comment}\n\n{body}"),
                format!("{body}\n\nКоментар: {comment}"),
            ] {
                let parsed = parse_signal_message(
                    &login,
                    &env,
                    DirectSubmitParsePayload {
                        full_body: body,
                        include_ai_callsigns: false,
                        signal_group_master_key: Some(
                            TEST_SIGNAL_GROUP_KEY.to_string(),
                        ),
                    },
                )
                .await
                .unwrap();

                assert_eq!(
                    parsed.comment.as_deref(),
                    enabled.then_some(comment)
                );
                assert_eq!(parsed.freq.as_deref(), Some("149.5000"));
                assert!(parsed.text.contains("- Прийом."));
            }
        }
    }

    #[tokio::test]
    #[serial]
    async fn issue_3894_unit_header_does_not_create_linked_comment() {
        let env = cleanup().await.unwrap();
        let login = crate::users::login_id_by_name(&env.dbx, TEST_LOGIN)
            .await
            .unwrap();
        system_settings::ActiveModel {
            sigint_comment_parsing_enabled: Set(true),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        for unit in ["50 обрБпС", "51 пдп 3 пдб 515"] {
            let body =
                format!("{unit}\n28.10.2026, 17:00\n- Тестове повідомлення.");
            let parsed = parse_signal_message(
                &login,
                &env,
                DirectSubmitParsePayload {
                    full_body: body.clone(),
                    include_ai_callsigns: false,
                    signal_group_master_key: Some(
                        TEST_SIGNAL_GROUP_KEY.to_string(),
                    ),
                },
            )
            .await
            .unwrap();
            assert_eq!(parsed.comment, None);
            assert_eq!(parsed.text, "- Тестове повідомлення.");

            let mut payload = direct_submit_payload(&parsed.text);
            payload.full_body = Some(body);
            payload.comment = parsed.comment;
            let created =
                submit_signal_message(&login, &env, payload).await.unwrap();
            let messages = crate::rer_importer::inbox::messages_by_id_bl(
                &login,
                &vec![login],
                &env,
                &[created.signal_message_id],
                &crate::rer_importer::types::InboxMessagesReq::default(),
            )
            .await
            .unwrap();
            assert_eq!(messages.len(), 1);
            assert_eq!(messages[0].1.extended_form, None);
            assert!(messages[0].1.intelligence_reports.is_empty());
        }
    }

    #[tokio::test]
    #[serial]
    async fn direct_submit_parse_suggests_inbox_fields() {
        let env = cleanup().await.unwrap();
        let body = "01.04.2023_15:00 F=411,7500(МГЦ)\n49.12345, 37.12345\nID➡️:110(ЯРУС)\nID(CG)⬅️:50(СВЕТЛЫЙ)\nТекст повідомлення";

        let parsed =
            parse_signal_message_body(&env, &env.dbx, body, None, false)
                .await
                .unwrap();

        assert_eq!(parsed.freq.as_deref(), Some("411.7500"));
        assert_eq!(parsed.coords.len(), 1);
        assert_eq!(parsed.to, vec!["ярус".to_string(), "светлый".to_string()]);
        assert!(parsed.text.contains("Текст повідомлення"));
        assert!(parsed.timestamp.is_some());

        let unit = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            crate::entities::sigint_unit::ActiveModel {
                name: Set("взвБпЛА КТ рБпЛА 24 обБпС 7 дшд".to_string()),
                active: Set(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let label = "24 обБпС рБпЛА вБпЛА КТ";
        crate::sigint::unit::labels::insert_label(&env.dbx, unit.id, label)
            .await
            .unwrap();
        let body = format!("{label}  | 2026-09-16\n17-45\n- С тест");
        let parsed =
            parse_signal_message_body(&env, &env.dbx, &body, None, false)
                .await
                .unwrap();
        assert_eq!(parsed.unit.as_deref(), Some(label));
        assert_eq!(parsed.unit_v2.as_deref(), Some(unit.name.as_str()));
        assert_eq!(parsed.is_time_null, Some(false));
        assert!(parsed.timestamp.is_some());

        let body_no_time = format!("{label}  | 2026-09-16\n- С тест");
        let parsed_no_time = parse_signal_message_body(
            &env,
            &env.dbx,
            &body_no_time,
            None,
            false,
        )
        .await
        .unwrap();
        assert_eq!(parsed_no_time.unit.as_deref(), Some(label));
        assert_eq!(parsed_no_time.is_time_null, Some(true));
        assert!(parsed_no_time.timestamp.is_some());
    }

    #[tokio::test]
    #[serial]
    async fn direct_submit_preserves_typed_locations_without_parsing() {
        let env = cleanup().await.unwrap();
        let login_id = crate::users::login_id_by_name(&env.dbx, TEST_LOGIN)
            .await
            .unwrap();
        let mut payload = direct_submit_payload("body");
        payload.timestamp = Some("2026-07-11T12:34:56Z".to_string());
        payload.locations =
            vec!["Робоботине".to_string(), "район 1".to_string()];

        let created = submit_signal_message(&login_id, &env, payload)
            .await
            .unwrap();

        assert_eq!(
            created
                .message
                .as_ref()
                .and_then(|message| message.location.as_deref()),
            Some("Робоботине, район 1")
        );
        let inbox_item =
            sigint_inbox_item::Entity::find_by_id(created.signal_message_id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(inbox_item.location.as_deref(), Some("Робоботине, район 1"));
        assert_eq!(
            inbox_item.location_v2.as_deref(),
            Some("|Робоботине|район 1|")
        );
    }

    #[tokio::test]
    #[serial]
    async fn direct_edit_updates_existing_message_by_id() {
        let env = cleanup().await.unwrap();
        let login_id = crate::users::login_id_by_name(&env.dbx, TEST_LOGIN)
            .await
            .unwrap();
        let login = login::Entity::find_by_id(login_id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        let mut login = login.into_active_model();
        login.roles = Set(serde_json::json!(["Rer", "Cyber"]));
        login.update(&env.dbx).await.unwrap();
        enable_devices_section(&env.dbx).await;
        let device_name_id =
            device_name::Entity::insert(device_name::ActiveModel {
                name: Set(Some("edit-test-device".to_string())),
                login_id: Set(login_id),
                ..Default::default()
            })
            .exec(&env.dbx)
            .await
            .unwrap()
            .last_insert_id;
        let mut create_payload = direct_submit_payload("original body");
        create_payload.timestamp = Some("2026-07-11T12:34:56Z".to_string());
        create_payload.freq = Some("145.025".to_string());
        create_payload.device_name_id = Some(Some(device_name_id));
        create_payload.comment = Some("old comment".to_string());
        create_payload.network =
            Some(crate::rer_importer::types::SubmitNetwork {
                signal_name: None,
                cc: None,
                name: Some("original network".to_string()),
            });
        let created = submit_signal_message(&login_id, &env, create_payload)
            .await
            .unwrap();
        assert_eq!(
            created
                .message
                .as_ref()
                .and_then(|message| message.network_name.as_deref()),
            Some("original network")
        );
        assert_eq!(
            created
                .message
                .as_ref()
                .and_then(|message| message.device_name.as_deref()),
            Some("edit-test-device")
        );
        let linked_comments =
            crate::sigint::comments::find_linked_message_comments(
                &env.dbx,
                &[created.signal_message_id],
            )
            .await
            .unwrap();
        assert_eq!(linked_comments.len(), 1);
        assert_eq!(linked_comments[0].comment, "old comment");
        let linked_message = signal_message::Entity::find_by_id(
            linked_comments[0].intel_message_id,
        )
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
        assert_eq!(linked_message.timestamp, Some(linked_message.created_at));

        let inbox_item =
            sigint_inbox_item::Entity::find_by_id(created.signal_message_id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(inbox_item.device_name_id, Some(device_name_id));
        assert_eq!(inbox_item.network.as_deref(), Some("original network"));
        crate::inbox::callsigns::sync(
            &env.dbx,
            inbox_item.id,
            inbox_item.id_uuid,
            crate::inbox::callsigns::InboxItemCallsigns {
                primary: vec!["OLD_CALLSIGN_1".to_string()],
                alg2: vec!["OLD_CALLSIGN_2".to_string()],
            },
            login_id,
        )
        .await
        .unwrap();
        let mut inbox_item = inbox_item.into_active_model();
        inbox_item.signal_tokens = Set(Some(serde_json::json!([{
            "text": "old signal",
            "start": 0,
            "end": 10
        }])));
        inbox_item.update(&env.dbx).await.unwrap();
        let palitra = palitra::Entity::find()
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        sigint_inbox_item_point_token::ActiveModel {
            sigint_inbox_item_id: Set(created.signal_message_id),
            palitra_id: Set(palitra.id),
            point_tokens: Set(serde_json::json!([{
                "text": "old point",
                "start": 0,
                "end": 9
            }])),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let tag = tag::Entity::find().one(&env.dbx).await.unwrap().unwrap();
        sigint_inbox_item_tag::ActiveModel {
            sigint_inbox_item_id: Set(created.signal_message_id),
            tag_id: Set(tag.id),
            confidence: Set(0.9),
            login_id: Set(None),
            model: Set(Some("old-model".to_string())),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        let mut edit_payload = direct_submit_payload("updated body");
        edit_payload.freq = Some("146.125".to_string());
        edit_payload.network =
            Some(crate::rer_importer::types::SubmitNetwork {
                signal_name: None,
                cc: None,
                name: Some("updated network".to_string()),
            });
        let edited = edit_signal_message(
            &login_id,
            &env,
            created.signal_message_id,
            edit_payload,
        )
        .await
        .unwrap();

        assert_eq!(edited.signal_message_id, created.signal_message_id);
        assert_eq!(
            edited
                .message
                .as_ref()
                .and_then(|message| message.network_name.as_deref()),
            Some("updated network")
        );
        assert_eq!(
            edited
                .message
                .as_ref()
                .and_then(|message| message.device_name.as_deref()),
            Some("edit-test-device")
        );
        let signal_message =
            signal_message::Entity::find_by_id(created.signal_message_id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(signal_message.body.as_deref(), Some("updated body"));
        assert_eq!(signal_message.sender, None);
        assert_eq!(signal_message.login_id, Some(login_id));
        assert_eq!(
            signal_message.timestamp,
            Some(
                chrono::DateTime::parse_from_rfc3339("2026-07-11T12:34:56Z")
                    .unwrap()
                    .naive_utc()
            )
        );
        let inbox_item =
            sigint_inbox_item::Entity::find_by_id(created.signal_message_id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(inbox_item.freq.as_deref(), Some("146.1250"));
        assert_eq!(inbox_item.device_name_id, Some(device_name_id));
        assert_eq!(inbox_item.network.as_deref(), Some("updated network"));
        assert_eq!(inbox_item.signal_tokens, None);
        assert_eq!(
            sigint_comment::Entity::find()
                .filter(
                    sigint_comment::Column::SignalMessageId
                        .eq(created.signal_message_id)
                )
                .filter(sigint_comment::Column::LoginId.eq(login_id))
                .count(&env.dbx)
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            sigint_inbox_item_tag::Entity::find()
                .filter(
                    sigint_inbox_item_tag::Column::SigintInboxItemId
                        .eq(created.signal_message_id)
                )
                .filter(sigint_inbox_item_tag::Column::Model.is_not_null())
                .count(&env.dbx)
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            sigint_inbox_item_point_token::Entity::find()
                .filter(
                    sigint_inbox_item_point_token::Column::SigintInboxItemId
                        .eq(created.signal_message_id)
                )
                .count(&env.dbx)
                .await
                .unwrap(),
            0
        );
        assert!(tag_suggestion_worker_queue::Entity::find_by_id(
            created.signal_message_id
        )
        .one(&env.dbx)
        .await
        .unwrap()
        .is_some());
        assert!(palitra_highlight_worker_job::Entity::find_by_id(
            created.signal_message_id
        )
        .one(&env.dbx)
        .await
        .unwrap()
        .is_some());
        assert_eq!(
            signal_message::Entity::find()
                .count(&env.dbx)
                .await
                .unwrap(),
            2
        );

        let mut clear_device_payload = direct_submit_payload("updated body");
        clear_device_payload.device_name_id = Some(None);
        let cleared = edit_signal_message(
            &login_id,
            &env,
            created.signal_message_id,
            clear_device_payload,
        )
        .await
        .unwrap();
        assert_eq!(
            cleared
                .message
                .as_ref()
                .and_then(|message| message.device_name.as_deref()),
            None
        );
        assert_eq!(
            sigint_inbox_item::Entity::find_by_id(created.signal_message_id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .device_name_id,
            None
        );
    }

    #[tokio::test]
    #[serial]
    async fn direct_submit_redacts_device_name_without_cyber_access() {
        let env = cleanup().await.unwrap();
        let login_id = crate::users::login_id_by_name(&env.dbx, TEST_LOGIN)
            .await
            .unwrap();
        let device_name_id =
            device_name::Entity::insert(device_name::ActiveModel {
                name: Set(Some("rer-only-device".to_string())),
                login_id: Set(login_id),
                ..Default::default()
            })
            .exec(&env.dbx)
            .await
            .unwrap()
            .last_insert_id;
        let mut payload = direct_submit_payload("rer-only device visibility");
        payload.device_name_id = Some(Some(device_name_id));

        let submitted = submit_signal_message(&login_id, &env, payload)
            .await
            .unwrap();

        assert_eq!(
            submitted
                .message
                .as_ref()
                .and_then(|message| message.device_name.as_deref()),
            None
        );
    }

    #[tokio::test]
    #[serial]
    async fn ungrouped_report_returns_reciprocal_summaries_and_can_be_edited() {
        let env = cleanup().await.unwrap();
        let login_id = crate::users::login_id_by_name(&env.dbx, TEST_LOGIN)
            .await
            .unwrap();
        let original = submit_signal_message(
            &login_id,
            &env,
            direct_submit_payload("original body"),
        )
        .await
        .unwrap();

        let mut report_payload = direct_submit_payload("report body");
        report_payload.signal_group_master_key = None;
        report_payload.parent_signal_message_ids =
            vec![original.signal_message_id];
        let report = submit_signal_message(&login_id, &env, report_payload)
            .await
            .unwrap();

        let report_message = report.message.as_ref().unwrap();
        assert_eq!(report_message.parent_messages.len(), 1);
        assert!(report_message.parent_messages[0].is_accessible);
        assert!(!report_message.parent_messages[0].is_deleted);
        assert_eq!(
            report_message.parent_messages[0].id,
            original.signal_message_id
        );
        assert_eq!(report_message.parent_messages[0].text, "original body");
        assert_eq!(
            report_message.parent_messages[0].group_name.as_deref(),
            Some("Вухо-Тест")
        );
        assert_eq!(report_message.parent_messages[0].attachments_count, 0);
        assert_eq!(report_message.group_master_key, None);

        signal_message_media::ActiveModel {
            id: Set(Uuid::now_v7()),
            signal_message_id: Set(report.signal_message_id),
            signal_message_uuid: Set(
                crate::sigint::message_id::find_signal_message_uuid(
                    &env.dbx,
                    report.signal_message_id,
                )
                .await
                .unwrap(),
            ),
            content_type: Set("image/png".into()),
            file_ext: Set(Some("png".into())),
            file_name: Set(Some("report.png".into())),
            size_bytes: Set(1),
            is_encrypted: Set(false),
            storage_key: NotSet,
            created_at: Set(chrono::Utc::now().naive_utc()),
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        let logins =
            crate::users::get_organism_login_ids_by_id(&env.dbx, &login_id)
                .await
                .unwrap();
        let messages = crate::rer_importer::inbox::messages_by_id_bl(
            &login_id,
            &logins,
            &env,
            &[original.signal_message_id],
            &crate::rer_importer::types::InboxMessagesReq::default(),
        )
        .await
        .unwrap();
        let original_message = &messages[0].1;
        assert_eq!(original_message.intelligence_reports.len(), 1);
        assert!(original_message.intelligence_reports[0].is_accessible);
        assert!(!original_message.intelligence_reports[0].is_deleted);
        assert_eq!(
            original_message.intelligence_reports[0].id,
            report.signal_message_id
        );
        assert_eq!(
            original_message.intelligence_reports[0].text,
            "report body"
        );
        assert_eq!(
            original_message.intelligence_reports[0].attachments_count,
            1
        );

        set_signal_message_deleted(&env.dbx, report.signal_message_id, true)
            .await;
        let messages = crate::rer_importer::inbox::messages_by_id_bl(
            &login_id,
            &logins,
            &env,
            &[original.signal_message_id],
            &crate::rer_importer::types::InboxMessagesReq::default(),
        )
        .await
        .unwrap();
        assert!(messages[0].1.intelligence_reports.is_empty());

        set_signal_message_deleted(&env.dbx, report.signal_message_id, false)
            .await;

        let mut edit_payload = direct_submit_payload("updated report body");
        edit_payload.signal_group_master_key = None;
        let edited = edit_signal_message(
            &login_id,
            &env,
            report.signal_message_id,
            edit_payload,
        )
        .await
        .unwrap();
        assert_eq!(edited.message.unwrap().text, "updated report body");
        assert_eq!(
            signal_message_group::Entity::find()
                .filter(
                    signal_message_group::Column::SignalMessageId
                        .eq(report.signal_message_id)
                )
                .count(&env.dbx)
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            intel_product::Entity::find()
                .filter(
                    intel_product::Column::IntelMessageId
                        .eq(report.signal_message_id)
                )
                .count(&env.dbx)
                .await
                .unwrap(),
            1
        );

        set_signal_message_deleted(&env.dbx, original.signal_message_id, true)
            .await;

        let messages = crate::rer_importer::inbox::messages_by_id_bl(
            &login_id,
            &logins,
            &env,
            &[report.signal_message_id],
            &crate::rer_importer::types::InboxMessagesReq::default(),
        )
        .await
        .unwrap();
        let deleted_parent = &messages[0].1.parent_messages[0];
        assert!(deleted_parent.is_accessible);
        assert!(deleted_parent.is_deleted);
        assert!(deleted_parent.text.is_empty());
        assert_eq!(deleted_parent.attachments_count, 0);
        assert_eq!(deleted_parent.timestamp, None);
        assert_eq!(deleted_parent.date, None);
        assert_eq!(deleted_parent.time, None);
        assert_eq!(deleted_parent.group_name, None);
    }

    #[tokio::test]
    #[serial]
    async fn issue_3891_report_copies_comments_without_resubmitting_them() {
        let env = cleanup().await.unwrap();
        let login = crate::users::login_id_by_name(&env.dbx, TEST_LOGIN)
            .await
            .unwrap();
        for legacy in [false, true] {
            let mut payload = direct_submit_payload("#3891 commented source");
            if !legacy {
                payload.comment = Some("Source comment".to_string());
            }
            let source = submit_signal_message(&login, &env, payload)
                .await
                .unwrap()
                .signal_message_id;
            if legacy {
                sigint_comment::ActiveModel {
                    signal_message_id: Set(source),
                    login_id: Set(login),
                    comment: Set("Source comment".to_string()),
                    created_at: Set((chrono::Utc::now()
                        - chrono::Duration::days(7))
                    .naive_utc()),
                    ..Default::default()
                }
                .insert(&env.dbx)
                .await
                .unwrap();
            }
            let source_comments =
                crate::sigint::comments::find_linked_message_comments(
                    &env.dbx,
                    &[source],
                )
                .await
                .unwrap();
            assert_eq!(source_comments.len(), 1);
            for additional_comment in [None, Some("Additional comment")] {
                let mut payload =
                    copy_signal_messages(&login, &env, vec![source])
                        .await
                        .unwrap()
                        .payloads
                        .remove(0);
                assert_eq!(payload.comment.as_deref(), Some("Source comment"));
                payload.full_body = Some("#3891 report".to_string());
                payload.comment = additional_comment.map(str::to_string);
                let report = submit_signal_message(&login, &env, payload)
                    .await
                    .unwrap()
                    .signal_message_id;
                let comments =
                    crate::sigint::comments::find_linked_message_comments(
                        &env.dbx,
                        &[report],
                    )
                    .await
                    .unwrap();
                assert_eq!(
                    comments.len(),
                    1 + usize::from(additional_comment.is_some())
                );
                let inherited = comments
                    .iter()
                    .find(|comment| comment.comment == "Source comment")
                    .unwrap();
                assert_eq!(inherited.login_id, source_comments[0].login_id);
                assert_eq!(inherited.created_at, source_comments[0].created_at);
                assert_eq!(inherited.post_id, source_comments[0].post_id);
                if let Some(additional_comment) = additional_comment {
                    assert!(comments.iter().any(|comment| {
                        comment.comment == additional_comment
                            && comment.login_id == Some(login)
                    }));
                }
            }
            assert_eq!(
                crate::sigint::comments::find_linked_message_comments(
                    &env.dbx,
                    &[source],
                )
                .await
                .unwrap(),
                source_comments
            );
        }
    }

    #[tokio::test]
    #[serial]
    async fn issue_3891_copy_preserves_event_date_and_time() {
        let env = cleanup().await.unwrap();
        let login = crate::users::login_id_by_name(&env.dbx, TEST_LOGIN)
            .await
            .unwrap();
        for (date, time, is_time_null, expected) in [
            ("2026-10-20", "09:46:00", false, "2026-10-20T06:46:00Z"),
            ("2026-10-16", "19:41", false, "2026-10-16T16:41:00Z"),
            ("2026-10-16", "12:00:00", true, "2026-10-16T09:00:00Z"),
        ] {
            let mut payload = direct_submit_payload("#3891 original message");
            payload.timestamp = Some("2026-10-21T10:20:00Z".to_string());
            let created =
                submit_signal_message(&login, &env, payload).await.unwrap();
            let mut item = sigint_inbox_item::Entity::find_by_id(
                created.signal_message_id,
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap()
            .into_active_model();
            item.date = Set(Some(date.to_string()));
            item.time = Set(Some(time.to_string()));
            item.is_time_null = Set(Some(is_time_null));
            item.datetime = Set(crate::inbox::datetime::from_date_time_text(
                Some(date),
                Some(time),
            )
            .unwrap());
            item.update(&env.dbx).await.unwrap();

            let copied = copy_signal_messages(
                &login,
                &env,
                vec![created.signal_message_id],
            )
            .await
            .unwrap()
            .payloads
            .remove(0);
            let timestamp = chrono::DateTime::parse_from_rfc3339(
                copied.timestamp.as_ref().unwrap(),
            )
            .unwrap();
            assert_eq!(
                timestamp,
                chrono::DateTime::parse_from_rfc3339(expected).unwrap()
            );
            assert_eq!(copied.is_time_null, Some(is_time_null));
            let report = submit_signal_message(&login, &env, copied)
                .await
                .unwrap()
                .message
                .unwrap();
            assert_eq!(report.date.as_deref(), Some(date));
            assert_eq!(report.is_time_null, Some(is_time_null));
            assert_eq!(
                report.time.as_deref(),
                Some(if is_time_null {
                    "12:00:00"
                } else if time == "19:41" {
                    "19:41:00"
                } else {
                    time
                })
            );
        }
    }

    #[tokio::test]
    #[serial]
    async fn issue_3891_copy_preserves_partial_event_metadata() {
        let env = cleanup().await.unwrap();
        let login = crate::users::login_id_by_name(&env.dbx, TEST_LOGIN)
            .await
            .unwrap();
        for (date, time, has_timestamp, expected, is_time_null) in [
            (Some("2026-10-16"), None, true, "2026-10-16T10:20:00Z", None),
            (None, Some("09:46"), true, "2026-10-21T06:46:00Z", None),
            (
                Some("2026-10-16"),
                None,
                false,
                "2026-10-16T09:00:00Z",
                Some(true),
            ),
        ] {
            let mut payload = direct_submit_payload("#3891 partial metadata");
            payload.timestamp = Some("2026-10-21T10:20:00Z".to_string());
            let source = submit_signal_message(&login, &env, payload)
                .await
                .unwrap()
                .signal_message_id;
            let mut item = sigint_inbox_item::Entity::find_by_id(source)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .into_active_model();
            item.date = Set(date.map(str::to_string));
            item.time = Set(time.map(str::to_string));
            item.is_time_null = Set(None);
            item.update(&env.dbx).await.unwrap();
            if !has_timestamp {
                let mut signal = signal_message::Entity::find_by_id(source)
                    .one(&env.dbx)
                    .await
                    .unwrap()
                    .unwrap()
                    .into_active_model();
                signal.timestamp = Set(None);
                signal.update(&env.dbx).await.unwrap();
            }
            let copied = copy_signal_messages(&login, &env, vec![source])
                .await
                .unwrap()
                .payloads
                .remove(0);
            assert_eq!(copied.is_time_null, is_time_null);
            assert_eq!(
                chrono::DateTime::parse_from_rfc3339(
                    copied.timestamp.as_ref().unwrap()
                )
                .unwrap(),
                chrono::DateTime::parse_from_rfc3339(expected).unwrap()
            );
        }
    }

    #[tokio::test]
    #[serial]
    async fn issue_3515_date_only_create_edit_and_copy() {
        let env = cleanup().await.unwrap();
        let login_id = crate::users::login_id_by_name(&env.dbx, TEST_LOGIN)
            .await
            .unwrap();
        for (input, date, expected) in [
            ("2026-01-14T23:30:00Z", "2026-01-15", "2026-01-15T10:00:00Z"),
            ("2026-07-14T22:30:00Z", "2026-07-15", "2026-07-15T09:00:00Z"),
        ] {
            let expected = chrono::DateTime::parse_from_rfc3339(expected)
                .unwrap()
                .naive_utc();
            let mut payload = direct_submit_payload("date-only message #3515");
            payload.timestamp = Some(input.to_string());
            payload.is_time_null = Some(true);
            let created = submit_signal_message(&login_id, &env, payload)
                .await
                .unwrap();
            let id = created.signal_message_id;
            assert_eq!(created.message.unwrap().is_time_null, Some(true));
            let inbox_item = sigint_inbox_item::Entity::find_by_id(id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(inbox_item.date.as_deref(), Some(date));
            assert_eq!(inbox_item.time.as_deref(), Some("12:00:00"));
            assert_eq!(inbox_item.datetime, Some(expected));
            assert_eq!(inbox_item.is_time_null, Some(true));
            let message = signal_message::Entity::find_by_id(id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(message.timestamp, Some(expected));

            let edited = edit_signal_message(
                &login_id,
                &env,
                id,
                direct_submit_payload("unrelated edit #3515"),
            )
            .await
            .unwrap();
            assert_eq!(edited.message.unwrap().is_time_null, Some(true));
            let copied = copy_signal_messages(&login_id, &env, vec![id])
                .await
                .unwrap()
                .payloads
                .remove(0);
            assert_eq!(copied.is_time_null, Some(true));
            let copy = submit_signal_message(&login_id, &env, copied)
                .await
                .unwrap();
            assert_eq!(copy.message.as_ref().unwrap().is_time_null, Some(true));
            assert_eq!(
                copy.message.as_ref().unwrap().timestamp,
                Some(expected.and_utc().timestamp_millis())
            );
            assert_eq!(
                copy.message.unwrap().parent_messages[0].is_time_null,
                Some(true)
            );

            let mut known = direct_submit_payload("known noon #3515");
            known.is_time_null = Some(false);
            known.timestamp = Some(expected.and_utc().to_rfc3339());
            let edited = edit_signal_message(&login_id, &env, id, known)
                .await
                .unwrap();
            assert_eq!(edited.message.unwrap().is_time_null, Some(false));
            let mut unknown = direct_submit_payload("clear time #3515");
            unknown.is_time_null = Some(true);
            let edited = edit_signal_message(&login_id, &env, id, unknown)
                .await
                .unwrap();
            let edited = edited.message.unwrap();
            assert_eq!(edited.is_time_null, Some(true));
            assert_eq!(
                edited.timestamp,
                Some(expected.and_utc().timestamp_millis())
            );
        }
    }

    #[tokio::test]
    #[serial]
    async fn direct_edit_preserves_missing_timestamp() {
        let env = cleanup().await.unwrap();
        let login_id = crate::users::login_id_by_name(&env.dbx, TEST_LOGIN)
            .await
            .unwrap();
        let mut create_payload = direct_submit_payload("original body");
        create_payload.timestamp = Some("2026-07-11T12:34:56Z".to_string());
        let created = submit_signal_message(&login_id, &env, create_payload)
            .await
            .unwrap();

        let signal_message =
            signal_message::Entity::find_by_id(created.signal_message_id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        let mut signal_message = signal_message.into_active_model();
        signal_message.timestamp = Set(None);
        signal_message.update(&env.dbx).await.unwrap();
        let inbox_item =
            sigint_inbox_item::Entity::find_by_id(created.signal_message_id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        let mut inbox_item = inbox_item.into_active_model();
        inbox_item.date = Set(None);
        inbox_item.time = Set(None);
        inbox_item.datetime = Set(None);
        inbox_item.update(&env.dbx).await.unwrap();

        edit_signal_message(
            &login_id,
            &env,
            created.signal_message_id,
            direct_submit_payload("updated body"),
        )
        .await
        .unwrap();

        let signal_message =
            signal_message::Entity::find_by_id(created.signal_message_id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(signal_message.timestamp, None);
        let inbox_item =
            sigint_inbox_item::Entity::find_by_id(created.signal_message_id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(inbox_item.date, None);
        assert_eq!(inbox_item.time, None);
        assert_eq!(inbox_item.datetime, None);
    }

    #[tokio::test]
    #[serial]
    async fn direct_edit_retains_shared_transcription_after_media_deletion() {
        let env = cleanup().await.unwrap();
        let login_id = crate::users::login_id_by_name(&env.dbx, TEST_LOGIN)
            .await
            .unwrap();
        let created = submit_signal_message(
            &login_id,
            &env,
            direct_submit_payload("original body"),
        )
        .await
        .unwrap();
        let media_id = Uuid::now_v7();
        let media = signal_message_media::ActiveModel {
            id: Set(media_id),
            signal_message_id: Set(created.signal_message_id),
            signal_message_uuid: Set(
                crate::sigint::message_id::find_signal_message_uuid(
                    &env.dbx,
                    created.signal_message_id,
                )
                .await
                .unwrap(),
            ),
            content_type: Set("audio/ogg".into()),
            file_ext: Set(Some("ogg".into())),
            file_name: Set(Some("recording.ogg".into())),
            size_bytes: Set(1),
            is_encrypted: Set(false),
            storage_key: NotSet,
            created_at: Set(chrono::Utc::now().naive_utc()),
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let (source, _) = crate::transcription::service::enqueue(
            &env.dbx,
            &crate::transcriber::media_queue::source_key(&media),
        )
        .await
        .unwrap();

        let mut payload = direct_submit_payload("updated body");
        payload.deleted_media_ids = Some(vec![media_id.to_string()]);
        edit_signal_message(
            &login_id,
            &env,
            created.signal_message_id,
            payload,
        )
        .await
        .unwrap();

        assert!(signal_message_media::Entity::find_by_id(media_id)
            .one(&env.dbx)
            .await
            .unwrap()
            .is_none());
        assert!(echo_gpu_client::lookup(&env.dbx, source)
            .await
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    #[serial]
    async fn issue_3595_replacement_requeues_old_ocr_media() {
        const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01\0\0\0\x01\x08\x06\0\0\0\x1f\x15\xc4\x89\0\0\0\x0dIDAT\x08\xd7c\xf8\xcf\xc0\xf0\x1f\0\x05\0\x01\xff\x89\x99=\x1d\0\0\0\0IEND\xaeB`\x82";
        let env = cleanup().await.unwrap();
        let mut env = env.as_ref().clone();
        let s3_config = crate::config::S3Config {
            s3_access_key_id: "test".into(),
            s3_secret_access_key: "test".into(),
            s3_endpoint: String::new(),
            s3_region: String::new(),
            s3_bucket: "test".into(),
            strongbox_key: crate::storage::generate_strongbox_key_b64(),
        };
        env.s3_config = Some(crate::storage::S3Config::from(&s3_config));
        env.config.s3_config = Some(s3_config);
        env.s3 = Some(Operator::new(Memory::default()).unwrap().finish());
        let upload_dir = tempfile::tempdir().unwrap();
        env.config.storage_dir = upload_dir.path().display().to_string();
        let login_id = crate::users::login_id_by_name(&env.dbx, TEST_LOGIN)
            .await
            .unwrap();
        let created = submit_signal_message(
            &login_id,
            &env,
            direct_submit_payload("original #3595"),
        )
        .await
        .unwrap();
        let media_id = Uuid::now_v7();
        let created_at =
            (chrono::Utc::now() - chrono::Duration::days(8)).naive_utc();
        let original = signal_message_media::ActiveModel {
            id: Set(media_id),
            signal_message_id: Set(created.signal_message_id),
            signal_message_uuid: Set(
                crate::sigint::message_id::find_signal_message_uuid(
                    &env.dbx,
                    created.signal_message_id,
                )
                .await
                .unwrap(),
            ),
            content_type: Set("image/png".into()),
            file_ext: Set(Some("png".into())),
            file_name: Set(Some("old.png".into())),
            size_bytes: Set(1),
            is_encrypted: Set(false),
            storage_key: Set(Some("old-key".into())),
            created_at: Set(created_at),
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let now = chrono::Utc::now().naive_utc();
        let engine = ai_engine::ActiveModel {
            id: Set(Uuid::now_v7()),
            name: Set(format!("OCR #3595 {}", Uuid::now_v7())),
            url: Set("http://127.0.0.1:8000/v1".into()),
            token: Set(None),
            model_name: Set("ocr-model".into()),
            created_at: Set(now),
            updated_at: Set(now),
            enabled: Set(true),
            callsign_enabled: Set(true),
            ocr_enabled: Set(true),
            ocr_request_profile: Set("openai_vision".into()),
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let mut settings =
            ocr_settings::Entity::find_by_id(crate::config::OCR_SETTINGS_ID)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .into_active_model();
        settings.main_ai_engine_id = Set(Some(engine.id));
        settings.update(&env.dbx).await.unwrap();
        ocr_settings_ai_engine::ActiveModel {
            ocr_settings_id: Set(crate::config::OCR_SETTINGS_ID),
            ai_engine_id: Set(engine.id),
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        ocr_job::ActiveModel {
            media_id: Set(media_id),
            state: Set("completed".into()),
            attempts: Set(3),
            html_s3_key: Set(Some("old.html".into())),
            completed_at: Set(Some(now)),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        media_summary::ActiveModel {
            media_id: Set(media_id),
            source_kind: Set("ocr_text".into()),
            source_digest: Set("a".repeat(64)),
            source_text: Set(None),
            source_char_count: Set(1),
            state: Set("completed".into()),
            ai_engine_id: Set(None),
            ai_engine_name: Set("old".into()),
            model_name: Set("old".into()),
            summary: Set(Some("old".into())),
            coordinates: Set(json!([])),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let tus = crate::sigint::file_upload::tus::TusHandler::new(
            env.config.storage_dir.clone(),
            crate::sigint::file_upload::TUS_PATH_BASE,
        );
        let crate::sigint::file_upload::tus::CompletedUploadWriteResult::Stored { upload_url, .. } = tus.create_completed_upload(&login_id, crate::sigint::file_upload::tus::TusUploadMetadata { filename: Some("replacement.png".into()), meta_type: Some("image/png".into()), ..Default::default() }, futures_util::stream::iter([Ok(actix_web::web::Bytes::from_static(PNG))])).await.unwrap() else { panic!() };
        let mut payload = direct_submit_payload("edited #3595");
        payload.attachment_updates = Some(DirectSubmitAttachmentUpdates {
            replacements: vec![
                crate::sigint::direct_submit::types::DirectSubmitAttachmentReplacement {
                    media_id: media_id.to_string(),
                    upload_url,
                },
            ],
            renames: vec![],
        });
        edit_signal_message(
            &login_id,
            &env,
            created.signal_message_id,
            payload,
        )
        .await
        .unwrap();
        let media = signal_message_media::Entity::find_by_id(media_id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        let job = ocr_job::Entity::find_by_id(media_id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(media.id, original.id);
        assert_eq!(media.created_at, original.created_at);
        assert_eq!(job.state, "queued");
        assert_eq!(job.ai_engine_id, Some(engine.id));
        assert_eq!(job.attempts, 0);
        assert_eq!(job.completed_at, None);
        assert!(job.html_s3_key.is_none());
        assert!(job.discovered_at > original.created_at);
        assert!(job.next_attempt_at > original.created_at);
        assert!(media_summary::Entity::find_by_id(media_id)
            .one(&env.dbx)
            .await
            .unwrap()
            .is_none());

        let replacement_storage_key = media.storage_key.clone();
        let crate::sigint::file_upload::tus::CompletedUploadWriteResult::Stored { upload_url, .. } = tus.create_completed_upload(&login_id, crate::sigint::file_upload::tus::TusUploadMetadata { filename: Some("disguised.png".into()), meta_type: Some("image/png".into()), ..Default::default() }, futures_util::stream::iter([Ok(actix_web::web::Bytes::from_static(b"not an image"))])).await.unwrap() else { panic!() };
        let mut payload =
            direct_submit_payload("invalid image replacement #3595");
        payload.attachment_updates = Some(DirectSubmitAttachmentUpdates {
            replacements: vec![crate::sigint::direct_submit::types::DirectSubmitAttachmentReplacement {
                media_id: media_id.to_string(),
                upload_url,
            }],
            renames: vec![],
        });
        assert!(matches!(
            edit_signal_message(
                &login_id,
                &env,
                created.signal_message_id,
                payload
            )
            .await,
            Err(AppError::BL { .. })
        ));
        let unchanged = signal_message_media::Entity::find_by_id(media_id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(unchanged, media);
        assert_eq!(unchanged.storage_key, replacement_storage_key);

        let document_id = Uuid::now_v7();
        let document = signal_message_media::ActiveModel {
            id: Set(document_id),
            signal_message_id: Set(created.signal_message_id),
            signal_message_uuid: Set(original.signal_message_uuid),
            content_type: Set("application/pdf".into()),
            file_ext: Set(Some("pdf".into())),
            file_name: Set(Some("original.pdf".into())),
            size_bytes: Set(1),
            is_encrypted: Set(false),
            storage_key: Set(Some("document-key".into())),
            created_at: Set(original.created_at),
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let crate::sigint::file_upload::tus::CompletedUploadWriteResult::Stored { upload_url, .. } = tus.create_completed_upload(&login_id, crate::sigint::file_upload::tus::TusUploadMetadata { filename: Some("replacement.png".into()), meta_type: Some("image/png".into()), ..Default::default() }, futures_util::stream::iter([Ok(actix_web::web::Bytes::from_static(PNG))])).await.unwrap() else { panic!() };
        let mut payload =
            direct_submit_payload("invalid document replacement #3595");
        payload.attachment_updates = Some(DirectSubmitAttachmentUpdates {
            replacements: vec![crate::sigint::direct_submit::types::DirectSubmitAttachmentReplacement {
                media_id: document_id.to_string(),
                upload_url,
            }],
            renames: vec![],
        });
        assert!(matches!(
            edit_signal_message(
                &login_id,
                &env,
                created.signal_message_id,
                payload
            )
            .await,
            Err(AppError::BL { .. })
        ));
        let unchanged = signal_message_media::Entity::find_by_id(document_id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(unchanged, document);
    }

    #[tokio::test]
    #[serial]
    async fn issue_3595_failed_replacement_cleans_ordinary_uploads() {
        let env = cleanup().await.unwrap();
        let mut env = env.as_ref().clone();
        let s3_config = crate::config::S3Config {
            s3_access_key_id: "test".into(),
            s3_secret_access_key: "test".into(),
            s3_endpoint: String::new(),
            s3_region: String::new(),
            s3_bucket: "test".into(),
            strongbox_key: crate::storage::generate_strongbox_key_b64(),
        };
        env.s3_config = Some(crate::storage::S3Config::from(&s3_config));
        env.config.s3_config = Some(s3_config);
        env.config.feature_delete_uploaded_attachment = Some(true);
        env.s3 = Some(Operator::new(Memory::default()).unwrap().finish());
        let upload_dir = tempfile::tempdir().unwrap();
        env.config.storage_dir = upload_dir.path().display().to_string();
        let login_id = crate::users::login_id_by_name(&env.dbx, TEST_LOGIN)
            .await
            .unwrap();
        let created = submit_signal_message(
            &login_id,
            &env,
            direct_submit_payload("original #3595 cleanup"),
        )
        .await
        .unwrap();
        let media_id = Uuid::now_v7();
        let original = signal_message_media::ActiveModel {
            id: Set(media_id),
            signal_message_id: Set(created.signal_message_id),
            signal_message_uuid: Set(
                crate::sigint::message_id::find_signal_message_uuid(
                    &env.dbx,
                    created.signal_message_id,
                )
                .await
                .unwrap(),
            ),
            content_type: Set("image/png".into()),
            file_ext: Set(Some("png".into())),
            file_name: Set(Some("original.png".into())),
            size_bytes: Set(1),
            is_encrypted: Set(false),
            storage_key: Set(Some("original-key".into())),
            created_at: Set(chrono::Utc::now().naive_utc()),
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let tus = crate::sigint::file_upload::tus::TusHandler::new(
            env.config.storage_dir.clone(),
            crate::sigint::file_upload::TUS_PATH_BASE,
        );
        let crate::sigint::file_upload::tus::CompletedUploadWriteResult::Stored { upload_url: ordinary_upload_url, .. } = tus.create_completed_upload(&login_id, crate::sigint::file_upload::tus::TusUploadMetadata { filename: Some("ordinary.mp4".into()), meta_type: Some("video/mp4".into()), ..Default::default() }, futures_util::stream::iter([Ok(actix_web::web::Bytes::from_static(b"ordinary video"))])).await.unwrap() else { panic!() };
        let crate::sigint::file_upload::tus::CompletedUploadWriteResult::Stored { upload_url: replacement_upload_url, .. } = tus.create_completed_upload(&login_id, crate::sigint::file_upload::tus::TusUploadMetadata { filename: Some("replacement.png".into()), meta_type: Some("image/png".into()), ..Default::default() }, futures_util::stream::iter([Ok(actix_web::web::Bytes::from_static(b"not an image"))])).await.unwrap() else { panic!() };
        let ordinary_upload = tus
            .resolve_completed_uploads(
                &login_id,
                std::slice::from_ref(&ordinary_upload_url),
            )
            .await
            .unwrap()
            .pop()
            .unwrap();
        let replacement_upload = tus
            .resolve_completed_uploads(
                &login_id,
                std::slice::from_ref(&replacement_upload_url),
            )
            .await
            .unwrap()
            .pop()
            .unwrap();

        let mut payload = direct_submit_payload("failed #3595 cleanup");
        payload.upload_urls = Some(vec![ordinary_upload_url]);
        payload.attachment_updates = Some(DirectSubmitAttachmentUpdates {
            replacements: vec![crate::sigint::direct_submit::types::DirectSubmitAttachmentReplacement {
                media_id: media_id.to_string(),
                upload_url: replacement_upload_url,
            }],
            renames: vec![],
        });
        assert!(matches!(
            edit_signal_message(
                &login_id,
                &env,
                created.signal_message_id,
                payload
            )
            .await,
            Err(AppError::BL { .. })
        ));

        let media = query::find_signal_message_media(
            &env.dbx,
            created.signal_message_id,
        )
        .await
        .unwrap();
        assert_eq!(media, vec![original]);
        assert!(env.s3.as_ref().unwrap().list("/").await.unwrap().is_empty());
        assert!(!std::path::Path::new(&ordinary_upload.path).exists());
        assert!(!std::path::Path::new(&replacement_upload.path).exists());
        let local_files = walkdir::WalkDir::new(upload_dir.path())
            .into_iter()
            .filter_map(Result::ok)
            .filter(|entry| !entry.file_type().is_dir())
            .filter(|entry| {
                !entry.path().starts_with(
                    upload_dir.path().join("file_upload_tus/locks"),
                ) && entry.file_name() != ".source-budget.lock"
            })
            .map(|entry| entry.path().display().to_string())
            .collect::<Vec<_>>();
        assert!(local_files.is_empty(), "{local_files:?}");
    }

    #[tokio::test]
    #[serial]
    async fn report_copy_rename_keeps_source_media_immutable() {
        let env = cleanup().await.unwrap();
        let login_id = crate::users::login_id_by_name(&env.dbx, TEST_LOGIN)
            .await
            .unwrap();
        let source = submit_signal_message(
            &login_id,
            &env,
            direct_submit_payload("source body #3595"),
        )
        .await
        .unwrap();
        let source_media_id = Uuid::now_v7();
        signal_message_media::ActiveModel {
            id: Set(source_media_id),
            signal_message_id: Set(source.signal_message_id),
            signal_message_uuid: Set(
                crate::sigint::message_id::find_signal_message_uuid(
                    &env.dbx,
                    source.signal_message_id,
                )
                .await
                .unwrap(),
            ),
            content_type: Set("image/png".into()),
            file_ext: Set(Some("png".into())),
            file_name: Set(Some("source.png".into())),
            size_bytes: Set(1),
            is_encrypted: Set(false),
            storage_key: NotSet,
            created_at: Set(chrono::Utc::now().naive_utc()),
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        let mut payload = direct_submit_payload("report body #3595");
        payload.signal_group_master_key = None;
        payload.parent_signal_message_ids = vec![source.signal_message_id];
        payload.retained_media_ids = Some(vec![source_media_id.to_string()]);
        payload.attachment_updates = Some(DirectSubmitAttachmentUpdates {
            replacements: vec![],
            renames: vec![crate::sigint::direct_submit::types::DirectSubmitAttachmentRename {
                media_id: source_media_id.to_string(),
                file_name: "report-name.png".to_string(),
            }],
        });
        let mut duplicate_payload = payload.clone();
        duplicate_payload
            .attachment_updates
            .as_mut()
            .unwrap()
            .renames
            .push(crate::sigint::direct_submit::types::DirectSubmitAttachmentRename {
                media_id: source_media_id.to_string(),
                file_name: "duplicate-name.png".to_string(),
            });
        assert!(matches!(
            submit_signal_message(&login_id, &env, duplicate_payload).await,
            Err(AppError::BL { .. })
        ));
        let report = submit_signal_message(&login_id, &env, payload)
            .await
            .unwrap();

        let source_media =
            signal_message_media::Entity::find_by_id(source_media_id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(source_media.file_name.as_deref(), Some("source.png"));
        let report_media = signal_message_media::Entity::find()
            .filter(
                signal_message_media::Column::SignalMessageId
                    .eq(report.signal_message_id),
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_ne!(report_media.id, source_media_id);
        assert_eq!(report_media.file_name.as_deref(), Some("report-name.png"));
    }

    #[tokio::test]
    #[serial]
    async fn chained_intelligence_reports_preserve_parent_child_hierarchy() {
        let env = cleanup().await.unwrap();
        let login_id = crate::users::login_id_by_name(&env.dbx, TEST_LOGIN)
            .await
            .unwrap();
        let original_a = submit_signal_message(
            &login_id,
            &env,
            direct_submit_payload("message A body"),
        )
        .await
        .unwrap();

        let mut report_b_payload = direct_submit_payload("report B body");
        report_b_payload.signal_group_master_key = None;
        report_b_payload.parent_signal_message_ids =
            vec![original_a.signal_message_id];
        let report_b = submit_signal_message(&login_id, &env, report_b_payload)
            .await
            .unwrap();

        let copy_from_b = copy_signal_messages(
            &login_id,
            &env,
            vec![report_b.signal_message_id],
        )
        .await
        .unwrap();
        assert_eq!(
            copy_from_b.payloads[0].parent_signal_message_ids,
            vec![report_b.signal_message_id]
        );

        let mut report_c_payload = direct_submit_payload("report C body");
        report_c_payload.signal_group_master_key = None;
        report_c_payload.parent_signal_message_ids =
            vec![report_b.signal_message_id];
        let report_c = submit_signal_message(&login_id, &env, report_c_payload)
            .await
            .unwrap();

        let logins =
            crate::users::get_organism_login_ids_by_id(&env.dbx, &login_id)
                .await
                .unwrap();
        let messages = crate::rer_importer::inbox::messages_by_id_bl(
            &login_id,
            &logins,
            &env,
            &[
                original_a.signal_message_id,
                report_b.signal_message_id,
                report_c.signal_message_id,
            ],
            &crate::rer_importer::types::InboxMessagesReq::default(),
        )
        .await
        .unwrap();
        let message_map = messages
            .into_iter()
            .collect::<std::collections::HashMap<_, _>>();

        let msg_a = message_map.get(&original_a.signal_message_id).unwrap();
        assert_eq!(msg_a.parent_messages.len(), 0);
        assert_eq!(msg_a.intelligence_reports.len(), 1);
        assert_eq!(
            msg_a.intelligence_reports[0].id,
            report_b.signal_message_id
        );

        let msg_b = message_map.get(&report_b.signal_message_id).unwrap();
        assert_eq!(msg_b.parent_messages.len(), 1);
        assert_eq!(msg_b.parent_messages[0].id, original_a.signal_message_id);
        assert_eq!(msg_b.intelligence_reports.len(), 1);
        assert_eq!(
            msg_b.intelligence_reports[0].id,
            report_c.signal_message_id
        );

        let msg_c = message_map.get(&report_c.signal_message_id).unwrap();
        assert_eq!(msg_c.parent_messages.len(), 1);
        assert_eq!(msg_c.parent_messages[0].id, report_b.signal_message_id);
        assert_eq!(msg_c.intelligence_reports.len(), 0);

        let mut edit_c_payload = direct_submit_payload("updated report C body");
        edit_c_payload.signal_group_master_key = None;
        let edited_c = edit_signal_message(
            &login_id,
            &env,
            report_c.signal_message_id,
            edit_c_payload,
        )
        .await
        .unwrap();
        assert_eq!(edited_c.message.unwrap().text, "updated report C body");
    }
}
