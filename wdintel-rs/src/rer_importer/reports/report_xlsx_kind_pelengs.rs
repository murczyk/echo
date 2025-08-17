use super::super::types::*;
use crate::entities::{prelude::*, *};
use crate::error::AppError;
use crate::location::peleng::collect_inbox_pelengs;
use crate::rer_importer::analysis::*;
use crate::types::*;
use actix_identity::Identity;
use anyhow::bail;
use chrono::prelude::*;
use itertools::Itertools;
use sea_orm::*;
use sea_query::SimpleExpr;
use std::collections::BTreeMap;

pub async fn get_inbox_messages_report(
    user: &Identity,
    env: &Env,
    req: &InboxMessagesReq,
) -> Result<Vec<(i64, Option<(f64, f64)>, InboxMessage)>, AppError> {
    let login = user.id()?;
    let include_peleng_locations =
        req.include_peleng_locations.unwrap_or(false);

    #[derive(FromQueryResult)]
    struct Message {
        pub id: i64,
        pub body: String,
        pub datasource_id: i64,
        pub timestamp: Option<chrono::NaiveDateTime>,
        pub group_master_key: String,
        pub sender: String,
        pub date: Option<String>,
        pub time: Option<String>,
        pub freq: Option<String>,
        pub callsigns: Option<serde_json::Value>,
        pub checked: Option<bool>,
        pub unit: Option<String>,
        pub location: Option<String>,
        pub has_coords: bool,
    }

    let mut q = SignalMessage::find()
        .inner_join(sigint_inbox_item::Entity)
        .column(signal_message::Column::Id)
        .column(signal_message::Column::Body)
        .column(signal_message::Column::DatasourceId)
        .column(signal_message::Column::Timestamp)
        .column(signal_message::Column::GroupMasterKey)
        .column(signal_message::Column::Sender)
        .column(sigint_inbox_item::Column::Date)
        .column(sigint_inbox_item::Column::Time)
        .column(sigint_inbox_item::Column::Freq)
        .column(sigint_inbox_item::Column::Callsigns)
        .column(sigint_inbox_item::Column::Checked)
        .column_as(sigint_inbox_item::Column::LocationV2, "location")
        .filter(signal_message::Column::Deleted.eq(false))
        .column_as(
            SimpleExpr::Custom(r#"
                COALESCE(
                    array_to_string(
                        NULLIF(
                            array_agg(
                                sigint_network_freq.kind || ' р/м ' || sigint_network.name || ' ' || sigint_unit.name || ' (' || UPPER(sigint_network.location) || ')'
                            )
                            FILTER
                            (WHERE sigint_unit.name IS NOT NULL),
                        '{}'),
                        ', '
                    ),
                    sigint_inbox_item.unit_v2
                )
            "#.to_string()),
            "unit",
        )
        .column_as(
            SimpleExpr::Custom(r#"
                sigint_inbox_item.lng IS NOT NULL AND sigint_inbox_item.lat IS NOT NULL"#.to_string()),
            "has_coords",
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintNetworkFreq.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_network_freq::Relation::SigintNetwork.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_network::Relation::SigintNetworkUnit.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_network_unit::Relation::SigintUnit.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintPost.def(),
        )
        .group_by(signal_message::Column::Id)
        .group_by(sigint_inbox_item::Column::Id)
        .filter(signal_message::Column::GroupMasterKey.is_in(
            crate::users::get_identity_sigint_groups(&env.dbx, &login).await?,
        ));

    q = crate::rer_importer::inbox::query::get_order_by(env, req, q.clone())
        .await?;
    if req.only_show_unprocessed == Some(true) {
        q = q.filter(sigint_inbox_item::Column::Reviewed.ne(Some(true)));
    }
    if req.checked_only == Some(true) {
        q = q.filter(sigint_inbox_item::Column::Checked.eq(Some(true)));
    }
    let q = filter_selected_groups(q, &req.selected_groups)?;
    let q = filter_selected_senders(q, &req.selected_senders)?;
    let q = filter_denied_senders(q, &req.denied_senders)?;
    let q = filter_selected_freqs(q, &req.selected_freqs)?;
    let q = filter_selected_posts(q, &req.selected_posts)?;
    let q = filter_denied_freqs(q, &req.denied_freqs)?;
    let q = filter_selected_callsigns(q, &req.selected_callsigns)?;
    let q = filter_search(q, &req.search)?;
    let q = filter_selected_units(
        q,
        &req.selected_units,
        &req.units_exact_match_only,
    )?;
    let q = filter_selected_tags(
        q,
        &req.selected_tags,
        &req.or_bookmarked,
        &req.or_important,
        &req.or_with_coords,
        &req.or_with_extended_form,
        &req.filter_tags_option,
        &user.id()?,
        true,
    )?;
    let q = filter_selected_locations(
        q,
        &req.selected_locations,
        include_peleng_locations,
    )?;

    // dbg!(&q.build(DbBackend::Postgres).to_string());

    info!("[get_inbox_messages_report] {}: query build", Utc::now());

    let messages: Vec<Message> =
        q.into_model::<Message>().all(&env.dbx).await?;

    let mut item_ids = vec![];
    let mut sigint_pelengs = vec![];
    let mut items_map = BTreeMap::new();
    for item in messages.into_iter().filter(|x| x.has_coords) {
        item_ids.push(item.id);
        items_map.insert(item.id, item);
        if item_ids.len() > 1000 {
            let pelengs = collect_inbox_pelengs(item_ids, &env.dbx)
                .await
                .context(h!())?;
            sigint_pelengs.push(pelengs);
            item_ids = vec![];
        }
    }
    sigint_pelengs.push(
        collect_inbox_pelengs(item_ids, &env.dbx)
            .await
            .context(h!())?,
    );

    let mut pelengs_map = BTreeMap::<i64, Vec<sigint_peleng::Model>>::new();
    for peleng in sigint_pelengs.into_iter().flat_map(|s| s.into_iter()) {
        pelengs_map
            .entry(peleng.source_inbox_item_id)
            .or_default()
            .push(peleng);
    }
    info!(
        "[get_inbox_messages_report] {}: query completed",
        Utc::now()
    );

    let mut res: Vec<(i64, Option<(f64, f64)>, InboxMessage)> = vec![];
    for (id, m) in items_map {
        let locations_w_coords = match pelengs_map.get(&id) {
            None => vec![(m.location.clone(), None, None)],
            Some(pelengs) => {
                let mut result = vec![];
                for p in pelengs {
                    let location = build_location(p).context(h!())?;
                    let coordinates = Some(format!("{}, {}", p.lat, p.lng));
                    result.push((location, coordinates, Some((p.lat, p.lng))));
                }
                result
            }
        };
        for (location, coords, coords_tuple) in locations_w_coords {
            res.push((
                m.id,
                coords_tuple,
                InboxMessage {
                    location,
                    coords,
                    text: m.body.clone(),
                    images: vec![],
                    image_recognized: vec![],
                    date: m.date.clone(),
                    time: m.time.clone(),
                    freq: m.freq.clone(),
                    callsigns: serde_json::from_value(
                        m.callsigns.clone().unwrap_or_default(),
                    )
                    .unwrap_or_else(|_| vec![]),
                    checked: m.checked.unwrap_or(false),
                    timestamp: m
                        .timestamp
                        .map(|x| x.and_utc().timestamp_millis()),
                    group_master_key: Some(m.group_master_key.clone()),
                    sender: Some(m.sender.clone()),
                    duplicate_ids: None,
                    extended_form: None,
                    unit: m.unit.clone(),
                    callsign_tokens: None,
                    keyword_tokens: None,
                    signal_tokens: None,
                    text_marked: None,
                    post: None,
                    post_id: None,
                    no_headers_body: None,
                    datasource_id: Some(m.datasource_id),
                    tags: None,
                    callsigns_alg2: vec![],
                    network_ids: None,
                },
            ));
        }
    }

    info!("[get_inbox_messages_report] {}: query done", Utc::now());
    Ok(res)
}

fn build_location(
    peleng: &sigint_peleng::Model,
) -> anyhow::Result<Option<String>> {
    match (
        peleng.distance_m,
        peleng.locality_direction.clone(),
        peleng.settlement.clone(),
    ) {
        (Some(distance_m), Some(direction_eng), Some(settlement)) => {
            if distance_m < 100.0 {
                return Ok(Some(settlement));
            }
            let distance = distance_m / 1000.0;
            let settlement_country_suffix = match peleng.country_code.clone() {
                None => "",
                Some(txt) => match &*txt {
                    "ru" => " рф",
                    "by" => " рб",
                    _ => "",
                },
            };
            let direction = translate_direction(direction_eng).context(h!())?;
            let result = format!(
                "{:.1}км {} {}{}",
                distance,
                direction,
                settlement.to_uppercase(),
                settlement_country_suffix
            );
            Ok(Some(result))
        }
        _ => Ok(None),
    }
}

fn translate_direction(dir: String) -> anyhow::Result<String> {
    match &*dir {
        "S" => Ok(String::from("Пд")),
        "N" => Ok(String::from("Пн")),
        "W" => Ok(String::from("Зх")),
        "E" => Ok(String::from("Сх")),
        _s => match _s.chars().collect_vec()[..] {
            [a, b] => {
                let prefix = translate_direction(String::from(a))?;
                let suffix = translate_direction(String::from(b))?;
                Ok(format!("{prefix}-{suffix}"))
            }
            _ => bail!("failed to parse: {}", dir),
        },
    }
}
