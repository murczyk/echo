use crate::entities::{prelude::*, *};
use crate::rer_importer::types::*;
use std::collections::BTreeSet;

use crate::error::AppError;
use crate::rer_importer::inbox::bl::*;
use crate::rer_importer::inbox::query::*;
use crate::session::record_page_visit;
use crate::types::*;
use actix_identity::Identity;
use actix_web::web::Json;
use actix_web::{get, post};
use chrono::{DateTime, Duration, NaiveDateTime, Utc};
use chrono_tz::Europe::Kyiv;
use itertools::Itertools;
use log::*;
use sea_orm::*;

mod bl;
pub mod query;

#[post("/api/rer-importer/get-inbox-map")]
async fn get_inbox_map(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<MapPointsReq>,
) -> Result<Json<MapPointsRsp>, AppError> {
    let user_id = user.id()?;
    let page_id = req.page_id.clone();
    let req = req.into_inner();

    let payload = serde_json::to_value(&req).context(h!())?;
    record_page_visit(&user_id, &page_id, &env, Some(payload))
        .await
        .context(h!())?;
    crate::users::has_role(&env.dbx, &user_id, "Rer").await?;
    let login = user.id()?;
    let logins = crate::users::get_organism_logins(&env.dbx, user)
        .await
        .context(h!())?;

    let mut filter = req.inbox_items_filter.clone();
    filter.nolimit = Some(true); // fetch all points
    if let Some(map_filter) = req.map_filter.clone() {
        let freq_whitelist = map_filter
            .network_units
            .iter()
            .flat_map(|r| r.frequencies.iter())
            .unique()
            .cloned()
            .collect_vec();
        filter.selected_freqs = Some(freq_whitelist);
    }

    let inbox_items = get_inbox_map_items(&login, &logins, &env, &filter)
        .await
        .context(h!())?;
    info!("messages found: {}", inbox_items.len());
    let points = crate::location::peleng::collect_inbox_item_pelengs(
        &inbox_items,
        &env.dbx,
    )
    .await
    .context(h!())?;
    info!("points found: {}", points.len());
    let units = crate::sigint::network::bl::collect_network_units(
        &inbox_items,
        &env.dbx,
        req.map_filter,
    )
    .await
    .context(h!())?;
    let network_units = aggregate_network_units(units);
    info!("units found: {}", points.len());
    let points = collect_map_points(inbox_items, points).context(h!())?;
    Ok(Json(MapPointsRsp {
        network_units,
        points,
    }))
}

#[post("/api/rer-importer/messages-by-id")]
async fn messages_by_id(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<MessageIdsReq>,
) -> Result<Json<MessageIdsRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    let login = user.id()?;
    let logins = crate::users::get_organism_logins(&env.dbx, user)
        .await
        .context(h!())?;

    let sigint_groups =
        crate::users::get_identity_sigint_groups(&env.dbx, &login).await?;
    let mut messages = SignalMessage::find()
        .join(
            JoinType::LeftJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .join(
            JoinType::LeftJoin,
            signal_message::Relation::SignalGroup.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintPost.def(),
        );
    messages = add_inbox_message_columns(messages);
    messages = messages
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(signal_message::Column::GroupMasterKey.is_in(sigint_groups))
        .filter(signal_message::Column::Id.is_in(req.message_ids.clone()));

    let messages = messages
        .into_model::<InboxMessageDesc>()
        .all(&env.dbx)
        .await
        .context(h!())?;
    let req = InboxMessagesReq::default();
    let env: &Env = &env;
    let messages = aggregate_to_inbox_messages(messages, &logins, &&req, &env)
        .await
        .context(h!())?;
    Ok(Json(MessageIdsRsp { messages }))
}

#[post("/api/rer-importer/get-inbox")]
async fn inbox_messages(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<InboxMessagesReq>,
) -> Result<Json<InboxMessagesRsp>, AppError> {
    let user_id = user.id()?;
    let page_id = req.page_id.clone();
    let req = req.into_inner();

    let payload = serde_json::to_value(&req).context(h!())?;
    record_page_visit(&user_id, &page_id, &env, Some(payload))
        .await
        .context(h!())?;
    crate::users::has_role(&env.dbx, &user_id, "Rer").await?;
    let is_admin = crate::users::has_role(&env.dbx, &user.id()?, "Admin")
        .await
        .is_ok();
    let login = user.id()?;
    let logins = crate::users::get_organism_logins(&env.dbx, user)
        .await
        .context(h!())?;
    let inbox_items = get_inbox_messages(&login, &logins, &env, &req)
        .await
        .context(h!())?;
    let txn = env.dbx.begin().await.context(h!())?;
    let callsigns: Vec<CallsignInfoRes> =
        load_inbox_callsigns(&inbox_items, &env).await?;
    let signal_profiles =
        load_inbox_signal_profiles(&inbox_items, &env.dbx).await?;
    let signal_groups =
        load_inbox_signal_groups(&inbox_items, &env.dbx, is_admin).await?;

    let freq_pelengs_summary = match req.calculate_freq_pelengs_summary {
        Some(true) => load_inbox_freq_pelengs_summary(&inbox_items, &env.dbx)
            .await
            .map(Some)
            .context(h!())?,
        _ => None,
    };
    txn.commit().await.context(h!())?;

    Ok(Json(InboxMessagesRsp {
        inbox_items,
        callsigns,
        signal_profiles,
        signal_groups,
        freq_pelengs_summary,
    }))
}

#[post("/api/rer-importer/get-inbox-group-stats")]
async fn inbox_group_stats(
    user: Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<InboxByGroupDigestRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    let login = user.id()?;
    let sigint_groups =
        crate::users::get_identity_sigint_groups(&env.dbx, &login).await?;
    let one_hour_ago = Utc::now() - Duration::hours(1);
    let signal_message_timestamps = signal_message::Entity::find()
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(
            signal_message::Column::GroupMasterKey.is_in(sigint_groups.clone()),
        )
        .filter(
            signal_message::Column::Timestamp
                .gte(one_hour_ago.clone().naive_utc()),
        )
        .order_by_asc(signal_message::Column::Timestamp)
        .select_only()
        .column(signal_message::Column::GroupMasterKey)
        .column(signal_message::Column::Timestamp)
        .into_model::<MessageTimestampPerGroupStat>()
        .all(&env.dbx)
        .await
        .context(h!())?;
    let signal_groups = signal_group::Entity::find()
        .filter(signal_group::Column::MasterKey.is_in(sigint_groups))
        .select_only()
        .column(signal_group::Column::MasterKey)
        .column(signal_group::Column::Name)
        .into_tuple()
        .all(&env.dbx)
        .await
        .context(h!())?
        .into_iter()
        .collect::<BTreeMap<String, String>>();
    let mut current_ts = one_hour_ago;
    let mut result = vec![];
    let mut current_rec = BTreeMap::new();

    fn print_utc_timestamp(ts: &DateTime<Utc>) -> String {
        ts.with_timezone(&Kyiv).clone().format("%H:%M").to_string()
    }

    for rec in signal_message_timestamps {
        // recordings are sorted by date, so each next is older
        while rec.timestamp > current_ts.naive_utc() {
            // fill in all previous minutes before this rec
            current_ts += Duration::minutes(1);
            result.push(InboxGroupStatsByMinute {
                timestamp: print_utc_timestamp(&current_ts),
                stats: current_rec,
            });
            current_rec = BTreeMap::new();
        }

        let counter = current_rec // add current rec
            .get(&rec.group_master_key)
            .map(|x| x.count)
            .unwrap_or(0);
        current_rec.insert(
            rec.group_master_key.clone(),
            InboxGroupStats {
                group_name: signal_groups.get(&rec.group_master_key).cloned(),
                count: counter + 1,
            },
        );
    }
    while result.len() < 60 {
        // fill in all future recs
        current_ts += Duration::minutes(1);
        result.push(InboxGroupStatsByMinute {
            timestamp: print_utc_timestamp(&current_ts),
            stats: current_rec,
        });
        current_rec = BTreeMap::new();
    }

    Ok(Json(InboxByGroupDigestRsp {
        stats_per_minute: result,
    }))
}

#[post("/api/rer-importer/get-inbox-count")]
async fn inbox_messages_count(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<InboxMessagesReq>,
) -> Result<Json<InboxMessagesDigestRsp>, AppError> {
    let user_id = user.id()?;
    let page_id = req.page_id.clone();
    let req = req.into_inner();

    let payload = serde_json::to_value(&req).context(h!())?;
    record_page_visit(&user_id, &page_id, &env, Some(payload))
        .await
        .context(h!())?;
    crate::users::has_role(&env.dbx, &user_id, "Rer").await?;
    let login = user_id;
    let logins = crate::users::get_organism_logins(&env.dbx, user)
        .await
        .context(h!())?;

    let q = build_inbox_query(&login, &logins, &env, &req)
        .await
        .context(h!())?;
    let q = format!(
        "SELECT COUNT(*) AS count, MIN(q.\"timestamp\") AS first_element_ts from ({}) q",
        q.build(DbBackend::Postgres));

    let query_res: Option<QueryResult> = env
        .dbx
        .query_one(Statement::from_string(DatabaseBackend::Postgres, q))
        .await?;
    let query_res = query_res.unwrap();
    let quantity: i64 = query_res.try_get("", "count")?;
    let first_element_ts: Option<NaiveDateTime> =
        query_res.try_get("", "first_element_ts")?;
    let first_element_ts =
        first_element_ts.map(|x| x.and_utc().timestamp_millis());
    Ok(Json(InboxMessagesDigestRsp {
        quantity,
        first_element_ts,
    }))
}

#[post("/api/rer-importer/delete-message")]
async fn delete_message(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<InboxDeleteReq>,
) -> Result<Json<()>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    let txn = env.dbx.begin().await.context(h!())?;
    let result = match signal_message::Entity::find_by_id(req.id)
        .filter(signal_message::Column::Deleted.eq(false))
        .one(&txn)
        .await
        .context(h!())?
    {
        None => Err(AppError::NotFound),
        Some(signal_message) => {
            let mut signal_message = signal_message.into_active_model();
            signal_message.deleted = Set(true);
            signal_message.update(&txn).await.context(h!())?;
            Ok(Json(()))
        }
    };
    txn.commit().await?;
    result
}

#[post("/api/rer-importer/inbox/submit")]
async fn inbox_submit(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<InboxSubmitReq>,
) -> Result<Json<()>, AppError> {
    let login = user.id()?;
    crate::users::has_role(&env.dbx, &login, "Rer").await?;
    let logins = crate::users::get_organism_logins(&env.dbx, user)
        .await
        .context(h!())?;
    let txn = env.dbx.begin().await?;

    let Some(new_cursor_val) = req.messages.iter().map(|(id, _x)| id).max()
    else {
        return Ok(Json(()));
    };
    delta_kv::Entity::insert(delta_kv::ActiveModel {
        id: NotSet,
        k: Set("rer_importer_id_cursor".to_string()),
        v: Set(serde_json::to_value(new_cursor_val).context(h!())?),
    })
    .on_conflict(
        sea_query::OnConflict::column(delta_kv::Column::K)
            .update_columns([delta_kv::Column::V])
            .to_owned(),
    );

    for (id, message) in req.messages.iter() {
        let mut message = message.clone();
        let callsigns: Vec<String> = crate::utils::uniq_via_btreeset(
            &message
                .callsigns
                .iter()
                .map(|x| x.to_lowercase())
                .collect::<Vec<String>>(),
        );
        fill_callsigns(&env.rq, &txn, &callsigns).await?;
        message.callsigns = callsigns.clone();
        message.callsign_tokens = Some(
            crate::rer_importer::callsigns::highlight_callsigns(
                &env.rq,
                &message.text,
                &callsigns,
            )
            .await?,
        );
        message.keyword_tokens = Some(
            crate::rer_importer::highlight::extract_keywords(&message.text)?,
        );
        let all_ids = find_all_duplicates(&txn, *id).await?;
        for id in all_ids {
            submit_upsert_inbox_item(
                env.settlements.clone(),
                &txn,
                id,
                &message,
                &login,
                &logins,
            )
            .await?;
        }
    }
    txn.commit().await?;
    Ok(Json(()))
}

/// Get the cursor position. Cursor is used as "since_id_noninclusive" default when loading inbox. So, equal to zero on empty inbox, or last seen/submitted message otherwise.
#[get("/api/rer-importer/inbox/cursor")]
async fn inbox_cursor(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<Option<i64>>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    let since_id_noninclusive: Option<i64> = match DeltaKv::find()
        .filter(delta_kv::Column::K.eq("rer_importer_id_cursor".to_string()))
        .one(&env.dbx)
        .await?
    {
        None => None,
        Some(kv) => Some(serde_json::from_value(kv.v).context(h!())?),
    };
    Ok(Json(since_id_noninclusive))
}

/// Get the cursor position. Cursor is used as "since_id_noninclusive" default when loading inbox. So, equal to zero on empty inbox, or last seen/submitted message otherwise.
#[post("/api/rer-importer/inbox/cursor-update")]
async fn update_inbox_cursor(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<UpdateCursorReq>,
) -> Result<Json<()>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    let txn = env.dbx.begin().await?;
    let cursor_existing = DeltaKv::find()
        .filter(delta_kv::Column::K.eq("rer_importer_id_cursor".to_string()))
        .one(&txn)
        .await?;
    // {
    //     None => None,
    //     Some(kv) => Some(serde_json::from_value(kv.v)?),
    // };
    match cursor_existing {
        None => {
            let kv = delta_kv::ActiveModel {
                id: NotSet,
                k: Set("rer_importer_id_cursor".to_string()),
                v: Set(serde_json::to_value(req.cursor).context(h!())?),
            };
            kv.insert(&txn).await?;
        }
        Some(kv) => {
            let mut kv: delta_kv::ActiveModel = kv.into();
            kv.v = Set(serde_json::to_value(req.cursor).context(h!())?);
            kv.update(&txn).await?;
        }
    }
    txn.commit().await?;

    Ok(Json(()))
}

pub async fn get_inbox_messages(
    login: &str,
    logins: &Vec<String>,
    env: &Env,
    req: &InboxMessagesReq,
) -> Result<Vec<(i64, InboxMessage)>, AppError> {
    let q = build_inbox_query(login, logins, env, req).await?;

    trace!(
        ">get_inbox_messages inbox items query sql: {}",
        q.build(DbBackend::Postgres)
    );

    let messages = q
        .into_model::<InboxMessageDesc>()
        .all(&env.dbx)
        .await
        .context(h!())?;
    let res = aggregate_to_inbox_messages(messages, logins, &req, &env)
        .await
        .context(h!())?;
    Ok(res)
}

/// Find our dups and dups of our duplicate_of origin. Don't do anything fancy beyond this.
pub async fn find_all_duplicates<'a, 'async_trait, C>(
    txn: &'a C,
    id: i64,
) -> Result<Vec<i64>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut res: BTreeSet<i64> = BTreeSet::new();
    res.insert(id);
    let m_signal_message = SignalMessage::find_by_id(id)
        .filter(signal_message::Column::Deleted.eq(false))
        .one(txn)
        .await?;
    if let Some(signal_message) = m_signal_message {
        let our_dups = SignalMessage::find()
            .filter(signal_message::Column::Deleted.eq(false))
            .filter(signal_message::Column::DuplicateOf.eq(id))
            .all(txn)
            .await?;
        for dup in our_dups.iter() {
            res.insert(dup.id);
        }
        if let Some(duplicate_of) = signal_message.duplicate_of {
            let sibling_dups = SignalMessage::find()
                .filter(signal_message::Column::Deleted.eq(false))
                .filter(signal_message::Column::DuplicateOf.eq(duplicate_of))
                .all(txn)
                .await?;
            for dup in sibling_dups.iter() {
                res.insert(dup.id);
            }
        }
    }
    Ok(res.iter().cloned().collect())
}

#[post("/api/rer-importer/get-freq-pelengs-summary")]
async fn get_freq_pelengs_summary(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<InboxMessagesReq>,
) -> Result<Json<FreqPelengsActivityRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    let login = user.id()?;
    let logins = crate::users::get_organism_logins(&env.dbx, user)
        .await
        .context(h!())?;

    let q = build_inbox_query(&login, &logins, &env, &req.into_inner())
        .await
        .context(h!())?;

    let q = format!(
        r#"SELECT "freq" as freq, COUNT(*) AS count
            FROM ({}) q
            INNER JOIN sigint_peleng sp ON sp.source_inbox_item_id = q."id"
            WHERE sp.deleted = false
            AND "freq" IS NOT NULL
            GROUP BY "freq"
            "#,
        q.build(DbBackend::Postgres)
    );

    let query_res = env
        .dbx
        .query_all(Statement::from_string(DatabaseBackend::Postgres, q))
        .await
        .context(h!())?;

    let mut result = vec![];
    for row in query_res {
        let freq = row.try_get("", "freq")?;
        let pelengs_count = row.try_get("", "count")?;
        result.push(FreqPelengsEntry {
            freq,
            pelengs_count,
        });
    }

    Ok(Json(FreqPelengsActivityRsp {
        freq_pelengs_summary: result,
    }))
}
