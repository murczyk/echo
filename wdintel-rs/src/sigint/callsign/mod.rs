use std::collections::HashSet;

use self::types::*;
use crate::entities::*;
use crate::event_stream::fanout;
use crate::event_stream::types::*;
use crate::types::*;
use crate::utils::dt_from_millis;
use actix_web::post;
use actix_web::web::Json;
use sea_orm::*;
use sea_orm::{DbBackend, Statement};
use sea_query::types::IntoColumnRef;
use sea_query::Alias;
use sea_query::{Expr, SimpleExpr};

pub mod network_callsign;
pub mod types;

#[post("/api/sigint/callsigns")]
pub async fn list_callsigns(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ListCallsignsReq>,
) -> Result<Json<ListCallsignsRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    let limit: u64 = match &req.limit {
        Some(new_limit) => (*new_limit) as u64,
        None => 1000,
    };

    let mut callsigns = sigint_callsign::Entity::find()
        .find_also_related(sigint_unit::Entity)
        .filter(sigint_callsign::Column::Deleted.eq(false));
    // just one sort_by supported for now
    if let Some(after_id) = &req.after_id {
        let after_callsign = find_callsign(&env.dbx, *after_id).await?;
        let after_unit =
            crate::sigint::unit::find_unit(&env.dbx, after_callsign.unit_id)
                .await?;
        callsigns = callsigns.filter(
            Expr::tuple([
                sigint_unit::Column::Army.into_column_ref().into(),
                sigint_unit::Column::Division.into_column_ref().into(),
                sigint_unit::Column::Regiment.into_column_ref().into(),
                sigint_unit::Column::Battalion.into_column_ref().into(),
                sigint_unit::Column::Company.into_column_ref().into(),
                sigint_callsign::Column::Callsign.into_column_ref().into(),
            ])
            .gt(SimpleExpr::Tuple(vec![
                after_unit.army.into(),
                after_unit.division.into(),
                after_unit.regiment.into(),
                after_unit.battalion.into(),
                after_unit.company.into(),
                after_callsign.callsign.into(),
            ])),
        );
    }
    if let Some(filter_callsign) = &req.filter_callsign {
        if !filter_callsign.is_empty() {
            callsigns = callsigns.filter(Expr::cust_with_values(
                "lower(sigint_callsign.callsign collate \"ru-x-icu\") ilike $1",
                vec![format!("%{}%", filter_callsign.to_lowercase())],
            ));
        }
    }
    if let Some(filter_position) = &req.filter_position {
        if !filter_position.is_empty() {
            callsigns = callsigns.filter(Expr::cust_with_values(
                "lower(sigint_callsign.position collate \"ru-x-icu\") ilike $1",
                vec![format!("%{}%", filter_position.to_lowercase())],
            ));
        }
    }
    if let Some(filter_comment) = &req.filter_comment {
        if !filter_comment.is_empty() {
            callsigns = callsigns.filter(Expr::cust_with_values(
                "lower(sigint_callsign.comment collate \"ru-x-icu\") ilike $1",
                vec![format!("%{}%", filter_comment.to_lowercase())],
            ));
        }
    }
    if let Some(filter_unit) = &req.filter_unit {
        if !filter_unit.is_empty() {
            callsigns = callsigns.filter(Expr::cust_with_values(
                "lower(sigint_unit.name collate \"ru-x-icu\") ilike $1",
                vec![format!("%{}%", filter_unit.to_lowercase())],
            ));
        }
    }

    if let Some(since_date_inclusive_ms) = req.since_date_inclusive_ms {
        callsigns = callsigns.filter(
            sigint_callsign::Column::CreatedAt
                .gte(dt_from_millis(since_date_inclusive_ms)?),
        );
    }
    if let Some(till_date_inclusive_ms) = req.till_date_inclusive_ms {
        callsigns = callsigns.filter(
            sigint_callsign::Column::CreatedAt
                .lte(dt_from_millis(till_date_inclusive_ms)?),
        );
    }

    // Apply sorting based on request
    callsigns =
        if let Some(sort_by) = &req.sort_by {
            sort_by
                .iter()
                .fold(callsigns, |callsigns, sort_by| match sort_by {
                    ListCallsignsSortBy::CallsignAsc => callsigns
                        .order_by_asc(sigint_callsign::Column::Callsign),
                    ListCallsignsSortBy::CallsignDesc => callsigns
                        .order_by_desc(sigint_callsign::Column::Callsign),
                    ListCallsignsSortBy::CallsignCreatedAtAsc => callsigns
                        .order_by_asc(sigint_callsign::Column::CreatedAt),
                    ListCallsignsSortBy::CallsignCreatedAtDesc => callsigns
                        .order_by_desc(sigint_callsign::Column::CreatedAt),
                    ListCallsignsSortBy::CallsignUnitAsc => callsigns
                        .order_by_asc(sigint_unit::Column::Army)
                        .order_by_asc(sigint_unit::Column::Division)
                        .order_by_asc(sigint_unit::Column::Regiment)
                        .order_by_asc(sigint_unit::Column::Battalion)
                        .order_by_asc(sigint_unit::Column::Company)
                        .order_by_asc(sigint_callsign::Column::Callsign),
                    ListCallsignsSortBy::CallsignUnitDesc => callsigns
                        .order_by_desc(sigint_unit::Column::Army)
                        .order_by_desc(sigint_unit::Column::Division)
                        .order_by_desc(sigint_unit::Column::Regiment)
                        .order_by_desc(sigint_unit::Column::Battalion)
                        .order_by_desc(sigint_unit::Column::Company)
                        .order_by_desc(sigint_callsign::Column::Callsign),
                })
        } else {
            // Default sorting (original behavior)
            callsigns
                .order_by_asc(sigint_unit::Column::Army)
                .order_by_asc(sigint_unit::Column::Division)
                .order_by_asc(sigint_unit::Column::Regiment)
                .order_by_asc(sigint_unit::Column::Battalion)
                .order_by_asc(sigint_unit::Column::Company)
                .order_by_asc(sigint_callsign::Column::Callsign)
        };
    // println!(
    //     "> callsigns sql: {}",
    //     callsigns.build(DbBackend::Postgres).to_string()
    // );
    let callsigns = callsigns.limit(limit).all(&env.dbx).await?;
    let mut res = vec![];
    for (callsign, unit) in callsigns {
        let mut c = render_callsign(&callsign, unit)?;
        if let Some(changelog) = sigint_callsign_changelog::Entity::find()
            .filter(
                sigint_callsign_changelog::Column::SigintCallsignId
                    .eq(callsign.id),
            )
            .order_by_desc(sigint_callsign_changelog::Column::Id)
            .one(&env.dbx)
            .await?
        {
            c.created_at = changelog.created_at.and_utc().timestamp_millis();
        }

        res.push(c);
    }
    Ok(Json(ListCallsignsRsp {
        show_load_more: res.len() as u64 == limit,
        callsigns: res,
    }))
}

#[post("/api/sigint/callsigns-with-units-from-inbox")]
pub async fn get_callsigns_with_units_from_inbox(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<GetCallsignsWithUnitsFromInboxReq>,
) -> Result<Json<GetCallsignsWithUnitsFromInboxRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    let login = user.id()?;

    if req.callsigns.is_empty() {
        return Ok(Json(GetCallsignsWithUnitsFromInboxRsp {
            callsigns_with_units: vec![],
        }));
    }

    let dt_since = dt_from_millis(req.since_date_inclusive_ms)?;
    let dt_till = dt_from_millis(req.till_date_inclusive_ms)?;

    let sanitizied_callsigns: HashSet<String> = req
        .callsigns
        .iter()
        .map(|callsign| {
            callsign
                .replace(" ", "") // Escape spances
                .replace("\"", "") // Escape quotes
                .replace("\'", "") // Escape quotes
                .replace("\\", "") // Escape back slashes
                .replace("\n", "") // Escape newlines
                .replace("\t", "") // Escape tabs
        })
        .filter(|callsign| !callsign.trim().is_empty())
        .collect();

    // debug!(
    //         "> sanitizied callsigns count: {}: {}",
    //         sanitizied_callsigns.len(),
    //         sanitizied_callsigns.clone().into_iter().map(|callsign| { format!("'{}'", callsign) }).join(", ")
    //     );

    if sanitizied_callsigns.is_empty() {
        return Ok(Json(GetCallsignsWithUnitsFromInboxRsp {
            callsigns_with_units: vec![],
        }));
    }

    #[derive(FromQueryResult, Debug)]
    struct Row {
        callsign: String,
        unit: String,
    }

    // Build the IN clause for the query
    let callsigns_in_clause = sanitizied_callsigns
        .iter()
        .map(|callsign| format!("'{callsign}'"))
        .collect::<Vec<String>>()
        .join(", ");

    // Use DISTINCT ON with LATERAL join to get unique callsign-unit pairs efficiently
    let sql = format!(
        r#"
        SELECT DISTINCT ON (sii.unit_v2, cs.value)
            cs.value as callsign,
            sii.unit_v2 as unit
        FROM signal_message sm
        INNER JOIN sigint_inbox_item sii ON sm.id = sii.id,
        LATERAL jsonb_array_elements_text(sii.callsigns) AS cs(value)
        WHERE sm.group_master_key = ANY($1)
          AND sm.deleted = false
          AND sii.checked = true
          AND sii.unit_v2 IS NOT NULL
          AND sii.datetime >= $2
          AND sii.datetime < $3
          AND sii.callsigns ? ANY($4)
          AND cs.value IN ({callsigns_in_clause})
        ORDER BY sii.unit_v2, cs.value
        "#
    );

    let groups =
        crate::users::get_identity_sigint_groups(&env.dbx, &login).await?;
    let callsigns_array: Vec<String> =
        sanitizied_callsigns.iter().cloned().collect();

    let rows: Vec<Row> =
        Row::find_by_statement(Statement::from_sql_and_values(
            DbBackend::Postgres,
            &sql,
            vec![
                groups.into(),
                dt_since.into(),
                dt_till.into(),
                callsigns_array.into(),
            ],
        ))
        .all(&env.dbx)
        .await?;

    // Group results by callsign
    let mut callsign_units_map: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();

    for row in rows {
        callsign_units_map
            .entry(row.callsign)
            .or_default()
            .push(row.unit);
    }

    let mut callsigns_with_units = vec![];
    for callsign in sanitizied_callsigns {
        let units = callsign_units_map
            .get(&callsign)
            .cloned()
            .unwrap_or_default();
        callsigns_with_units.push((callsign, units));
    }

    Ok(Json(GetCallsignsWithUnitsFromInboxRsp {
        callsigns_with_units,
    }))
}

#[post("/api/sigint/callsign/create")]
pub async fn create_callsign(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<CreateCallsignReq>,
) -> Result<Json<Callsign>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    crate::users::has_role(&env.dbx, &user.id()?, "CallsignsEditor").await?;

    info!("create_callsign; login: {}; req: {:?}", user.id()?, req);

    let callsign = sigint_callsign::ActiveModel {
        id: NotSet,
        callsign: Set(req.callsign.clone().to_lowercase()),
        position: Set(req.position.clone()),
        unit_id: Set(req.unit_id),
        comment: Set(req.comment.clone()),
        deleted: Set(false),
        source_id: Set(req.source_id),
        created_at: NotSet,
        developing: Set(req.developing),
        radio_freq: Set(req.radio_freq.clone().unwrap_or("".to_string())),
        sigint_origin_id: NotSet,
        mothership_id: NotSet,
    }
    .insert(&env.dbx)
    .await
    .context(h!())?;
    let callsign_json = sigint_callsign::Entity::find_by_id(callsign.id)
        .into_json()
        .one(&env.dbx)
        .await
        .context(h!())?
        .ok_or_else(|| AppError::NotFound)?;
    let _changelog = sigint_callsign_changelog::ActiveModel {
        sigint_origin_id: NotSet,
        mothership_id: NotSet,
        id: NotSet,
        sigint_callsign_id: Set(callsign.id),
        login: Set(user.id().context(h!())?.to_string()),
        action: Set("create".to_string()),
        created_at: NotSet,
        new_value: Set(Some(callsign_json)),
        old_value: NotSet,
        req: Set(Some(serde_json::to_value(&req).context(h!())?)),
    }
    .insert(&env.dbx)
    .await
    .context(h!())?;

    let event = EventMsg::new(EventType::ETCallsignChanged);
    fanout(&mut env.redis.clone(), event).await.context(h!())?;

    Ok(Json(
        render_callsign(
            &callsign,
            sigint_unit::Entity::find_by_id(callsign.unit_id)
                .one(&env.dbx)
                .await
                .context(h!())?,
        )
        .context(h!())?,
    ))
}

#[post("/api/sigint/callsign/update")]
pub async fn update_callsign(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<Callsign>,
) -> Result<Json<Callsign>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    crate::users::has_role(&env.dbx, &user.id()?, "CallsignsEditor").await?;

    info!("update_callsign; login: {}; req: {:?}", user.id()?, req);

    let callsign = find_callsign(&env.dbx, req.id).await?;
    let callsign_json_old = sigint_callsign::Entity::find_by_id(callsign.id)
        .into_json()
        .one(&env.dbx)
        .await?
        .ok_or_else(|| AppError::NotFound)?;
    let mut callsign = callsign.into_active_model();
    callsign.callsign = Set(req.callsign.clone().to_lowercase());
    callsign.position = Set(req.position.clone());
    callsign.unit_id = Set(req.unit_id);
    callsign.comment = Set(req.comment.clone());
    callsign.source_id = Set(req.source_id);
    callsign.developing = Set(req.developing);
    callsign.radio_freq = Set(req.radio_freq.clone().unwrap_or("".to_string()));
    let callsign = callsign.update(&env.dbx).await.context(h!())?;
    let callsign_json_new = sigint_callsign::Entity::find_by_id(callsign.id)
        .into_json()
        .one(&env.dbx)
        .await
        .context(h!())?
        .ok_or_else(|| AppError::NotFound)?;
    let _changelog = sigint_callsign_changelog::ActiveModel {
        id: NotSet,
        sigint_callsign_id: Set(callsign.id),
        login: Set(user.id()?.to_string()),
        action: Set("update".to_string()),
        created_at: NotSet,
        new_value: Set(Some(callsign_json_new)),
        old_value: Set(Some(callsign_json_old)),
        req: Set(None),
        sigint_origin_id: NotSet,
        mothership_id: NotSet,
    }
    .insert(&env.dbx)
    .await
    .context(h!())?;

    let event = EventMsg::new(EventType::ETCallsignChanged);
    fanout(&mut env.redis.clone(), event).await.context(h!())?;

    Ok(Json(render_callsign(
        &callsign,
        sigint_unit::Entity::find_by_id(callsign.unit_id)
            .one(&env.dbx)
            .await?,
    )?))
}

#[post("/api/sigint/callsign/delete")]
pub async fn delete_callsign(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<i64>,
) -> Result<Json<Callsign>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    crate::users::has_role(&env.dbx, &user.id()?, "CallsignsEditor").await?;

    info!("delete_callsign; login: {}; req: {:?}", user.id()?, req);

    let callsign = find_callsign(&env.dbx, *req).await?;
    let callsign_json_old = sigint_callsign::Entity::find_by_id(callsign.id)
        .into_json()
        .one(&env.dbx)
        .await?
        .ok_or_else(|| AppError::NotFound)?;
    let mut callsign = callsign.into_active_model();
    callsign.deleted = Set(true);
    let callsign = callsign.update(&env.dbx).await?;
    let callsign_json_new = sigint_callsign::Entity::find_by_id(callsign.id)
        .into_json()
        .one(&env.dbx)
        .await?
        .ok_or_else(|| AppError::NotFound)?;
    let _changelog = sigint_callsign_changelog::ActiveModel {
        id: NotSet,
        sigint_callsign_id: Set(callsign.id),
        login: Set(user.id()?.to_string()),
        action: Set("delete".to_string()),
        created_at: NotSet,
        new_value: Set(Some(callsign_json_new)),
        old_value: Set(Some(callsign_json_old)),
        req: Set(None),
        sigint_origin_id: NotSet,
        mothership_id: NotSet,
    }
    .insert(&env.dbx)
    .await?;

    Ok(Json(render_callsign(
        &callsign,
        sigint_unit::Entity::find_by_id(callsign.unit_id)
            .one(&env.dbx)
            .await?,
    )?))
}

pub async fn find_callsign(
    dbx: &DbConn,
    callsign_id: i64,
) -> Result<sigint_callsign::Model, AppError> {
    let callsign = sigint_callsign::Entity::find_by_id(callsign_id)
        .one(dbx)
        .await?
        .ok_or_else(|| AppError::NotFound)?;
    Ok(callsign)
}

pub fn render_callsign(
    callsign: &sigint_callsign::Model,
    unit: Option<sigint_unit::Model>,
) -> Result<Callsign, AppError> {
    Ok(Callsign {
        id: callsign.id,
        callsign: callsign.callsign.clone(),
        position: callsign.position.clone(),
        unit_id: callsign.unit_id,
        active: unit.is_none_or(|u| u.active),
        source_id: callsign.source_id,
        comment: callsign.comment.clone(),
        created_at: callsign.created_at.and_utc().timestamp_millis(),
        developing: callsign.developing,
        radio_freq: Some(callsign.radio_freq.clone()),
    })
}

#[post("/api/sigint/callsign/unit-stats")]
pub async fn callsign_unit_stats(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    _req: Json<()>,
) -> Result<Json<CallsignUnitStatsRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    #[derive(FromQueryResult)]
    struct Row {
        unit_id: i64,
        count: i64,
    }
    let units = sigint_callsign::Entity::find()
        .filter(sigint_callsign::Column::Deleted.eq(false))
        .join_as(
            JoinType::InnerJoin,
            sigint_callsign::Relation::SigintUnit.def(),
            Alias::new("sigint_unit"),
        )
        .select_only()
        .column_as(sigint_callsign::Column::UnitId.count(), "count")
        .column_as(sigint_callsign::Column::UnitId, "unit_id")
        .order_by_asc(sigint_unit::Column::Army)
        .order_by_asc(sigint_unit::Column::Division)
        .order_by_asc(sigint_unit::Column::Regiment)
        .order_by_asc(sigint_unit::Column::Battalion)
        .order_by_asc(sigint_unit::Column::Company)
        .group_by(sigint_callsign::Column::UnitId)
        .group_by(sigint_unit::Column::Army)
        .group_by(sigint_unit::Column::Division)
        .group_by(sigint_unit::Column::Regiment)
        .group_by(sigint_unit::Column::Battalion)
        .group_by(sigint_unit::Column::Company)
        .into_model::<Row>()
        .all(&env.dbx)
        .await?;
    let mut res = vec![];
    for unit in units {
        res.push(CallsignUnitStatRow {
            unit_id: unit.unit_id,
            count: unit.count,
        });
    }
    Ok(Json(CallsignUnitStatsRsp { units: res }))
}

pub async fn load_whitelist_from_file(
    mode: Mode,
) -> anyhow::Result<HashSet<String>> {
    let root_dir = crate::config::get_data_folder(mode).context(h!())?;
    let path = root_dir.join("callsigns_whitelist.txt");
    let callsigns = crate::utils::read_lines_from_file(path)
        .await
        .unwrap_or_else(|e| {
            error!("failed to load callsigns: {e:?}\nfallback to empty set");
            vec![]
        })
        .into_iter()
        .collect();
    Ok(callsigns)
}
