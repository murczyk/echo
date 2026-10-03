//! Position lookup for users and the AI agent: known locations first, then
//! mentions with coordinates, then other mentions for broader context. Only
//! the caller's groups are searched.

use super::list::{list, list_knowledge, Access};
use super::types::{
    AiPositionColumnFilter, AiPositionKnowledgeListReq, AiPositionLookupKnown,
    AiPositionLookupMention, AiPositionLookupReq, AiPositionLookupRsp,
    AiPositionMentionItem, AiPositionMentionListReq,
};
use crate::config::{
    AI_POSITION_KINDS, AI_POSITION_LOOKUP_DEFAULT_DAYS,
    AI_POSITION_LOOKUP_MAX_DAYS, AI_POSITION_LOOKUP_MAX_ITEMS,
    AI_POSITION_NEAR_DEFAULT_METERS,
};
use crate::error::AppError;
use crate::h;
use crate::types::Env;
use actix_identity::Identity;
use actix_web::{post, web::Json};
use anyhow::Context;
use chrono::{Duration, Utc};

#[post("/api/positions/lookup")]
pub async fn lookup_positions(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<AiPositionLookupReq>,
) -> Result<Json<AiPositionLookupRsp>, AppError> {
    let login = crate::users::login_id_from_identity(&user).context(h!())?;
    let groups =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login)
            .await
            .context(h!())?;
    Ok(Json(
        lookup(&env, req.into_inner(), groups).await.context(h!())?,
    ))
}

fn iso(millis: i64) -> String {
    chrono::DateTime::from_timestamp_millis(millis)
        .map(|at| at.format("%Y-%m-%dT%H:%MZ").to_string())
        .unwrap_or_default()
}

async fn lookup(
    env: &Env,
    req: AiPositionLookupReq,
    groups: Vec<String>,
) -> Result<AiPositionLookupRsp, AppError> {
    let name = req
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty());
    let place = req
        .coordinates
        .as_deref()
        .map(str::trim)
        .filter(|place| !place.is_empty());
    if name.is_none() && place.is_none() {
        return Err(AppError::BL {
            msg: "Вкажіть назву позиції або координати".to_string(),
        });
    }
    if let Some(kind) = &req.kind {
        if !AI_POSITION_KINDS.contains(&kind.as_str()) {
            return Err(AppError::BL {
                msg: "Тип має бути position, crew або callsign".to_string(),
            });
        }
    }
    let days = req
        .days
        .unwrap_or(AI_POSITION_LOOKUP_DEFAULT_DAYS)
        .clamp(1, AI_POSITION_LOOKUP_MAX_DAYS);
    let from = (Utc::now() - Duration::days(days))
        .format("%Y-%m-%d")
        .to_string();
    let radius = req.radius_meters.unwrap_or(AI_POSITION_NEAR_DEFAULT_METERS);
    let limit = req
        .limit
        .unwrap_or(AI_POSITION_LOOKUP_MAX_ITEMS)
        .clamp(1, AI_POSITION_LOOKUP_MAX_ITEMS);

    let mut filters = vec![filter("from", &from)];
    if let Some(name) = name {
        filters.push(filter("name", name));
    }
    if let Some(place) = place {
        filters.push(filter("near", &format!("{place}|{radius}")));
    }
    if let Some(kind) = &req.kind {
        filters.push(filter("kind", kind));
    }

    // 1. Known locations matching the name and/or near the point.
    let known = list_knowledge(
        &env.dbx,
        AiPositionKnowledgeListReq {
            limit: Some(limit),
            after: None,
            global_filter: None,
            column_filters: filters.clone(),
        },
        groups.clone(),
        Access::User,
    )
    .await
    .context(h!())?
    .items;

    // 2. Mentions with coordinates; 3. other mentions of the same names
    // (the known positions' names when only a point was given).
    let located = mentions(env, &groups, &filters, "так", limit)
        .await
        .context(h!())?;
    let mut broader_filters: Vec<AiPositionColumnFilter> = filters
        .iter()
        .filter(|filter| filter.id != "near")
        .cloned()
        .collect();
    let other = if name.is_some() {
        mentions(env, &groups, &broader_filters, "ні", limit)
            .await
            .context(h!())?
    } else {
        let mut other = Vec::new();
        for position in known.iter().take(3) {
            broader_filters.retain(|filter| filter.id != "positionKey");
            broader_filters.push(filter("positionKey", &position.name_key));
            other.extend(
                mentions(env, &groups, &broader_filters, "ні", limit)
                    .await
                    .context(h!())?,
            );
        }
        other.truncate(limit as usize);
        other
    };

    let note = match (known.is_empty(), located.is_empty(), other.is_empty()) {
        (true, true, true) => "Нічого не знайдено: спробуйте іншу назву, ширший радіус або період.",
        (false, _, _) => "Відоме розташування знайдено. Щоб цитувати, прочитайте повідомлення за messageId (echo_messages_by_id).",
        (true, false, _) => "Відомого розташування немає, але є згадки з координатами. Прочитайте їх за messageId.",
        (true, true, false) => "Координат немає; згадки без координат можуть дати контекст. Прочитайте їх за messageId.",
    };
    Ok(AiPositionLookupRsp {
        known: known
            .into_iter()
            .map(|item| AiPositionLookupKnown {
                name: item.name,
                kind: item.kind,
                mgrs: item.mgrs,
                lat: item.lat,
                lng: item.lng,
                certainty: item.certainty,
                conflicting: item.conflicting,
                fact_count: item.fact_count,
                first_fact_at: iso(item.first_fact_at),
                last_fact_at: iso(item.last_fact_at),
                scope: format!(
                    "{} {}",
                    if item.scope_kind == "aor" {
                        "РВ"
                    } else {
                        "група"
                    },
                    item.scope_name
                ),
            })
            .collect(),
        located: located.into_iter().map(lookup_mention).collect(),
        other: other.into_iter().map(lookup_mention).collect(),
        note: note.to_string(),
    })
}

fn filter(id: &str, value: &str) -> AiPositionColumnFilter {
    AiPositionColumnFilter {
        id: id.to_string(),
        value: value.to_string(),
    }
}

async fn mentions(
    env: &Env,
    groups: &[String],
    filters: &[AiPositionColumnFilter],
    has_coordinates: &str,
    limit: i64,
) -> Result<Vec<AiPositionMentionItem>, AppError> {
    let mut column_filters = filters.to_vec();
    column_filters.push(filter("hasCoordinates", has_coordinates));
    Ok(list(
        &env.dbx,
        AiPositionMentionListReq {
            limit: Some(limit),
            after: None,
            global_filter: None,
            column_filters,
        },
        groups.to_vec(),
        Access::User,
    )
    .await
    .context(h!())?
    .items)
}

fn lookup_mention(item: AiPositionMentionItem) -> AiPositionLookupMention {
    AiPositionLookupMention {
        message_id: item.message_id,
        message_uuid: item.message_uuid,
        source: item.source_kind,
        at: iso(item.message_at),
        name: item.name,
        kind: item.kind,
        coordinates: item
            .coordinates
            .into_iter()
            .map(|coordinate| {
                format!(
                    "{} ({}, {})",
                    coordinate.text, coordinate.mgrs, coordinate.certainty
                )
            })
            .collect(),
        context: format!(
            "{}[{}]{}",
            item.context_before, item.context_match, item.context_after
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::lookup;
    use crate::ai_position::types::AiPositionLookupReq;
    use crate::entities::{
        ai_position_coordinate, ai_position_knowledge, ai_position_mention,
        signal_group, signal_message, signal_message_group,
    };
    use sea_orm::{
        ActiveModelTrait, ActiveValue::Set, ColumnTrait, EntityTrait,
        QueryFilter,
    };

    fn request(
        name: Option<&str>,
        coordinates: Option<&str>,
    ) -> AiPositionLookupReq {
        AiPositionLookupReq {
            name: name.map(str::to_string),
            coordinates: coordinates.map(str::to_string),
            radius_meters: Some(500.0),
            days: Some(30),
            kind: None,
            limit: None,
        }
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn finds_known_located_and_other_mentions_in_allowed_groups_3064() {
        let env = crate::functest::tests::cleanup().await.unwrap();
        let group = signal_group::Entity::find()
            .filter(signal_group::Column::Deleted.eq(false))
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        let now = chrono::Utc::now().naive_utc();
        let mut mention_ids = Vec::new();
        for (body, located) in [
            ("Переміщення до \"Циркон 9\" (36T XT 75734 68963)", true),
            ("ЦИРКОН-9 на зв'язку", false),
        ] {
            let message = crate::functest::tests::mk_signal_message(
                &env.dbx,
                signal_message::ActiveModel {
                    body: Set(Some(body.to_string())),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            signal_message_group::ActiveModel {
                signal_message_id: Set(message.id),
                group_master_key: Set(Some(group.master_key.clone())),
                created_at: Set(message.created_at),
                ..Default::default()
            }
            .insert(&env.dbx)
            .await
            .unwrap();
            crate::entities::sigint_inbox_item::ActiveModel {
                id: Set(message.id),
                parsed_unit_v2: Set(false),
                ..Default::default()
            }
            .insert(&env.dbx)
            .await
            .unwrap();
            let mention = ai_position_mention::ActiveModel {
                sigint_inbox_item_id: Set(Some(message.id)),
                name: Set("Циркон 9".to_string()),
                name_key: Set("циркон 9".to_string()),
                kind: Set("position".to_string()),
                begin_char: Set(0),
                end_char: Set(8),
                message_at: Set(now),
                group_master_key: Set(Some(group.master_key.clone())),
                group_is_secret: Set(false),
                aor_ids: Set(vec![]),
                model_name: Set("test".to_string()),
                ..Default::default()
            }
            .insert(&env.dbx)
            .await
            .unwrap();
            if located {
                ai_position_coordinate::ActiveModel {
                    mention_id: Set(mention.id),
                    coordinate_text: Set("36T XT 75734 68963".to_string()),
                    coordinate_system: Set("mgrs".to_string()),
                    mgrs: Set("36TXT7573468963".to_string()),
                    lat: Set(47.55029916845189),
                    lng: Set(35.335663776872615),
                    certainty: Set("high".to_string()),
                    evidence: Set(String::new()),
                    message_at: Set(now),
                    ..Default::default()
                }
                .insert(&env.dbx)
                .await
                .unwrap();
            }
            mention_ids.push(mention.id);
        }
        ai_position_knowledge::ActiveModel {
            scope_kind: Set("group".to_string()),
            scope_key: Set(group.master_key.clone()),
            name_key: Set("циркон 9".to_string()),
            name: Set("Циркон 9".to_string()),
            kind: Set("position".to_string()),
            mgrs: Set("36TXT7573468963".to_string()),
            lat: Set(47.55029916845189),
            lng: Set(35.335663776872615),
            certainty: Set("high".to_string()),
            fact_count: Set(1),
            conflicting: Set(false),
            first_fact_at: Set(now),
            last_fact_at: Set(now),
            source_group_keys: Set(vec![group.master_key.clone()]),
            updated_at: Set(now),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        let allowed = vec![group.master_key.clone()];
        let by_name =
            lookup(&env, request(Some("ЦИРКОН 9"), None), allowed.clone())
                .await
                .unwrap();
        assert_eq!(by_name.known.len(), 1);
        assert_eq!(by_name.located.len(), 1);
        assert_eq!(by_name.other.len(), 1);

        // By place only: the known position nearby, then its other mentions.
        let by_place =
            lookup(&env, request(None, Some("36T XT 75700 68900")), allowed)
                .await
                .unwrap();
        assert_eq!(by_place.known[0].name, "Циркон 9");
        assert_eq!(by_place.located.len(), 1);
        assert_eq!(by_place.other.len(), 1);

        // Without the group: nothing.
        let hidden = lookup(&env, request(Some("Циркон 9"), None), vec![])
            .await
            .unwrap();
        assert!(
            hidden.known.is_empty()
                && hidden.located.is_empty()
                && hidden.other.is_empty()
        );
        let far = lookup(
            &env,
            request(None, Some("37U CQ 11111 22222")),
            vec![group.master_key],
        )
        .await
        .unwrap();
        assert!(far.known.is_empty());
    }
}
