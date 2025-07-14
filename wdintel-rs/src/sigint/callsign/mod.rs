use std::collections::{HashMap, HashSet};

use self::types::*;
use crate::entities::*;
use crate::error::AppError;
use crate::types::*;
use crate::utils::dt_from_millis;
use actix_web::post;
use actix_web::web::Json;
use chrono::Utc;
use log::*;
use sea_orm::*;
use sea_orm::{DbBackend, Statement};
use sea_query::types::IntoColumnRef;
use sea_query::Alias;
use sea_query::{Expr, SimpleExpr};

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
    callsigns = callsigns.order_by_asc(sigint_unit::Column::Army);
    callsigns = callsigns.order_by_asc(sigint_unit::Column::Division);
    callsigns = callsigns.order_by_asc(sigint_unit::Column::Regiment);
    callsigns = callsigns.order_by_asc(sigint_unit::Column::Battalion);
    callsigns = callsigns.order_by_asc(sigint_unit::Column::Company);
    callsigns = callsigns.order_by_asc(sigint_callsign::Column::Callsign);
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
        .map(|callsign| format!("'{}'", callsign))
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
          AND cs.value IN ({})
        ORDER BY sii.unit_v2, cs.value
        "#,
        callsigns_in_clause
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
            .or_insert_with(Vec::new)
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
        original_id: NotSet,
    }
    .insert(&env.dbx)
    .await?;
    let callsign_json = sigint_callsign::Entity::find_by_id(callsign.id)
        .into_json()
        .one(&env.dbx)
        .await?
        .ok_or_else(|| AppError::NotFound)?;
    let _changelog = sigint_callsign_changelog::ActiveModel {
        sigint_origin_id: NotSet,
        mothership_id: NotSet,
        id: NotSet,
        sigint_callsign_id: Set(callsign.id),
        login: Set(user.id()?.to_string()),
        action: Set("create".to_string()),
        created_at: NotSet,
        new_value: Set(Some(callsign_json)),
        old_value: NotSet,
        req: Set(Some(serde_json::to_value(&req).context(h!())?)),
        original_id: NotSet,
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
        action: Set("update".to_string()),
        created_at: NotSet,
        new_value: Set(Some(callsign_json_new)),
        old_value: Set(Some(callsign_json_old)),
        req: Set(None),
        sigint_origin_id: NotSet,
        mothership_id: NotSet,
        original_id: NotSet,
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
        original_id: NotSet,
    }
    .insert(&env.dbx)
    .await?;
    for binding in sigint_callsign_bind::Entity::find()
        .filter(sigint_callsign_bind::Column::CallsignId.eq(callsign.id))
        .all(&env.dbx)
        .await?
    {
        delete_callsign_bind_by_id(&env.dbx, binding.id, &user.id()?).await?;
    }

    Ok(Json(render_callsign(
        &callsign,
        sigint_unit::Entity::find_by_id(callsign.unit_id)
            .one(&env.dbx)
            .await?,
    )?))
}

#[post("/api/sigint/callsign-binds")]
pub async fn callsign_binds(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ListCallsignBindsReq>,
) -> Result<Json<HashMap<String, Vec<CallsignBind>>>, AppError> {
    let user_id = user.id()?;
    crate::users::has_role(&env.dbx, &user_id, "Rer").await?;

    info!(
        "delete_callsign_bind; login: {}; req: {:?}",
        user.id()?,
        req
    );

    let mut res_map = HashMap::new();
    for one_callsign_id in &req.callsign_ids {
        let mut binds = sigint_callsign_bind::Entity::find()
            .join(
                JoinType::InnerJoin,
                sigint_callsign::Relation::SigintUnit.def(),
            )
            .filter(sigint_callsign_bind::Column::Deleted.eq(false))
            .filter(sigint_callsign::Column::Id.eq(*one_callsign_id));

        if let Some(since_date_inclusive_ms) = req.since_date_inclusive_ms {
            binds = binds.filter(
                sigint_callsign_bind::Column::Date
                    .gte(dt_from_millis(since_date_inclusive_ms)?),
            );
        }
        if let Some(till_date_inclusive_ms) = req.till_date_inclusive_ms {
            binds = binds.filter(
                sigint_callsign_bind::Column::Date
                    .lte(dt_from_millis(till_date_inclusive_ms)?),
            );
        }
        let binds = binds.all(&env.dbx).await?;
        res_map.insert(
            one_callsign_id.to_string(),
            binds
                .into_iter()
                .map(|bind| render_callsign_bind(bind))
                .collect(),
        );
    }
    Ok(Json(res_map))
}

#[post("/api/sigint/callsign-bind/create")]
pub async fn create_callsign_bind(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<CreateCallsignsBindReq>,
) -> Result<Json<Vec<CallsignBind>>, AppError> {
    let user_id = user.id()?;
    crate::users::has_role(&env.dbx, &user_id, "Rer").await?;
    crate::users::has_role(&env.dbx, &user_id, "CallsignsEditor").await?;

    let mut res_vec = vec![];
    for one_binding in &req.bindings {
        let callsign_bind = sigint_callsign_bind::ActiveModel {
            id: NotSet,
            created_at: NotSet,
            updated_at: NotSet,
            deleted: Set(false),
            updated_by: Set(user_id.clone()),
            callsign_id: Set(req.callsign_id),
            freq: Set(one_binding.freq.clone()),
            comment: Set(one_binding.comment.clone()),
            date: Set(one_binding.date.clone()),
        }
        .insert(&env.dbx)
        .await?;
        res_vec.push(render_callsign_bind(callsign_bind));
    }
    Ok(Json(res_vec))
}

#[post("/api/sigint/callsign-bind/update")]
pub async fn update_callsign_bind(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<Vec<CallsignBind>>,
) -> Result<Json<Vec<CallsignBind>>, AppError> {
    let user_id = user.id()?;
    crate::users::has_role(&env.dbx, &user_id, "Rer").await?;
    crate::users::has_role(&env.dbx, &user_id, "CallsignsEditor").await?;

    let mut res_vec = vec![];
    for one_binding in req.0 {
        let callsign_bind =
            find_callsign_bind(&env.dbx, one_binding.id).await?;
        let mut callsign_bind = callsign_bind.into_active_model();
        callsign_bind.updated_at = Set(Utc::now().naive_utc());
        callsign_bind.updated_by = Set(user_id.clone());
        callsign_bind.freq = Set(one_binding.freq);
        callsign_bind.comment = Set(one_binding.comment);
        callsign_bind.date = Set(one_binding.date);
        let updated_callsign_bind = callsign_bind.update(&env.dbx).await?;
        res_vec.push(render_callsign_bind(updated_callsign_bind));
    }
    Ok(Json(res_vec))
}

#[post("/api/sigint/callsign-reporting/update")]
pub async fn update_callsign_reporting(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<UpdateCallsignReportingReq>,
) -> Result<Json<bool>, AppError> {
    let user_id = user.id()?;
    crate::users::has_role(&env.dbx, &user_id, "Rer").await?;
    crate::users::has_role(&env.dbx, &user_id, "CallsignsEditor").await?;

    let callsign_text = req.callsign.clone();
    let network_id = req.network_id;

    let existing_callsign = sigint_network_callsign::Entity::find()
        .filter(sigint_network_callsign::Column::Deleted.eq(false))
        .filter(
            sigint_network_callsign::Column::SigintCallsign.eq(&callsign_text),
        )
        .filter(sigint_network_callsign::Column::SigintNetworkId.eq(network_id))
        .one(&env.dbx)
        .await
        .context(h!())?;
    match existing_callsign {
        Some(c) => {
            let mut model = c.into_active_model();
            model.is_reported = Set(req.is_reported);
            model.is_reported = Set(req.is_reported);
            model.update(&env.dbx).await.context(h!())?;
        }
        None => {
            sigint_network_callsign::ActiveModel {
                id: NotSet,
                sigint_network_id: Set(network_id),
                sigint_callsign: Set(callsign_text),
                is_reported: Set(req.is_reported),
                created_at: NotSet,
                deleted: NotSet,
            }
            .insert(&env.dbx)
            .await
            .context(h!())?;
        }
    }
    Ok(Json(true))
}

#[post("/api/sigint/callsign-reporting/update-batch")]
pub async fn update_callsign_reporting_batch(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<UpdateCallsignReportingBatchReq>,
) -> Result<Json<bool>, AppError> {
    let user_id = user.id()?;
    crate::users::has_role(&env.dbx, &user_id, "Rer").await?;
    crate::users::has_role(&env.dbx, &user_id, "CallsignsEditor").await?;

    let network_id = req.network_id;

    // Get all callsign texts to query for
    let callsign_texts: Vec<String> =
        req.items.iter().map(|item| item.callsign.clone()).collect();

    // Find existing records for this network and these callsigns
    let existing_records = sigint_network_callsign::Entity::find()
        .filter(sigint_network_callsign::Column::SigintNetworkId.eq(network_id))
        .filter(
            sigint_network_callsign::Column::SigintCallsign
                .is_in(callsign_texts.clone()),
        )
        .all(&env.dbx)
        .await
        .context(h!())?;

    // Create a map of callsign -> existing record for quick lookup
    let mut existing_map: HashMap<String, sigint_network_callsign::Model> =
        HashMap::new();
    for record in existing_records {
        existing_map.insert(record.sigint_callsign.clone(), record);
    }

    // Process each item in the batch
    for item in &req.items {
        match existing_map.get(&item.callsign) {
            Some(existing_record) => {
                // Update existing record
                let mut model = existing_record.clone().into_active_model();
                model.is_reported = Set(item.is_reported);
                model.update(&env.dbx).await.context(h!())?;
            }
            None => {
                // Create new record
                sigint_network_callsign::ActiveModel {
                    id: NotSet,
                    sigint_network_id: Set(network_id),
                    sigint_callsign: Set(item.callsign.clone()),
                    is_reported: Set(item.is_reported),
                    created_at: NotSet,
                    deleted: NotSet,
                }
                .insert(&env.dbx)
                .await
                .context(h!())?;
            }
        }
    }

    Ok(Json(true))
}

#[post("/api/sigint/callsign-bind/delete")]
pub async fn delete_callsign_bind(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<Vec<i64>>,
) -> Result<Json<Vec<CallsignBind>>, AppError> {
    let user_id = user.id()?;
    crate::users::has_role(&env.dbx, &user_id, "Rer").await?;
    crate::users::has_role(&env.dbx, &user_id, "CallsignsEditor").await?;

    info!(
        "delete_callsign_bind; login: {}; req: {:?}",
        user.id()?,
        req
    );

    let mut res_vec = vec![];
    for binding_id in req.0 {
        res_vec.push(render_callsign_bind(
            delete_callsign_bind_by_id(&env.dbx, binding_id, &user_id).await?,
        ));
    }
    Ok(Json(res_vec))
}

async fn delete_callsign_bind_by_id(
    db: &DbConn,
    binding_id: i64,
    user_id: &str,
) -> Result<sigint_callsign_bind::Model, AppError> {
    let callsign_bind = find_callsign_bind(db, binding_id).await?;
    let mut callsign_bind = callsign_bind.into_active_model();
    callsign_bind.deleted = Set(true);
    callsign_bind.updated_at = Set(Utc::now().naive_utc());
    callsign_bind.updated_by = Set(user_id.to_string());
    let updated_callsign_bind = callsign_bind.update(db).await?;
    Ok(updated_callsign_bind)
}

async fn find_callsign_bind(
    dbx: &DbConn,
    callsign_bind_id: i64,
) -> Result<sigint_callsign_bind::Model, AppError> {
    let callsign_bind =
        sigint_callsign_bind::Entity::find_by_id(callsign_bind_id)
            .one(dbx)
            .await?
            .ok_or_else(|| AppError::NotFound)?;
    Ok(callsign_bind)
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

fn render_callsign_bind(
    callsign_bind: sigint_callsign_bind::Model,
) -> CallsignBind {
    CallsignBind {
        id: callsign_bind.id,
        freq: callsign_bind.freq,
        comment: callsign_bind.comment,
        date: callsign_bind.date,
        updated_by: callsign_bind.updated_by,
        updated_at: callsign_bind.updated_at.and_utc().timestamp_millis(),
    }
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
        active: unit.map_or(true, |u| u.active),
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
