use std::collections::{HashMap, HashSet};

use self::bl::*;
use self::types::*;
use crate::entities::*;
use crate::event_stream::fanout;
use crate::event_stream::types::*;
use crate::types::*;
use crate::utils::dt_from_millis;
use actix_web::post;
use actix_web::web::Json;
use itertools::Itertools;
use sea_orm::*;
use sea_orm::{DbBackend, Statement};
use sea_query::types::IntoColumnRef;
use sea_query::Alias;
use sea_query::{Expr, SimpleExpr};

pub mod bl;
pub mod bl_network_callsign;
pub mod network_callsign;
pub mod types;

#[post("/api/sigint/callsigns")]
pub async fn list_callsigns(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    mut req: Json<ListCallsignsReq>,
) -> Result<Json<ListCallsignsRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;

    let limit = *req.limit.get_or_insert(1000);
    let res = list_callsigns_impl(&env.dbx, &req.0).await.c(h!())?;

    Ok(Json(ListCallsignsRsp {
        show_load_more: res.len() as u64 == limit,
        callsigns: res,
    }))
}

#[post("/api/sigint/callsigns/csv")]
pub async fn list_callsigns_csv(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ListCallsignsReq>,
    http_req: actix_web::HttpRequest,
) -> Result<actix_web::HttpResponse, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;

    let res = list_callsigns_impl(&env.dbx, &req.0).await.c(h!())?;

    let sigint_unit_ids: Vec<i64> = res
        .iter()
        .map(|callsign| callsign.unit_id)
        .unique()
        .collect();

    let source_ids: Vec<i64> = res
        .iter()
        .flat_map(|callsign| callsign.source_id)
        .map(|id| id as i64)
        .unique()
        .collect();

    let units: HashMap<i64, String> = sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Id.is_in(sigint_unit_ids))
        .all(&env.dbx)
        .await
        .context(h!())?
        .into_iter()
        .map(|unit| (unit.id, unit.name))
        .collect();

    let sources: HashMap<i64, String> = source::Entity::find()
        .filter(source::Column::Id.is_in(source_ids))
        .all(&env.dbx)
        .await
        .context(h!())?
        .into_iter()
        .map(|source| (source.id, source.name))
        .collect();

    let temp_file = tempfile::Builder::new()
        .prefix("sigint-callsigns")
        .suffix(".csv")
        .rand_bytes(5)
        .tempfile()
        .context(h!())?;

    let temp_file_name = temp_file.path().to_str().context(h!())?;
    {
        #[derive(Serialize)]
        pub struct CallsignCsvRow<'se> {
            pub id: i64,
            pub callsign: String,
            pub position: String,
            pub comment: String,
            pub unit_id: i64,
            pub unit_name: &'se str,
            pub active: bool,
            pub source_id: Option<i32>,
            pub source_name: Option<&'se str>,
            pub created_at: String,
            pub developing: bool,
            /// Set when source_id points to "radio" (id=2)
            pub radio_freq: Option<String>,
        }
        let tz = crate::config::get_tz();
        let mut wtr = csv::Writer::from_path(temp_file_name).c(h!())?;
        for callsign in res.into_iter() {
            let created_at =
                chrono::DateTime::from_timestamp_millis(callsign.created_at)
                    .unwrap();
            let row = CallsignCsvRow {
                id: callsign.id,
                callsign: callsign.callsign,
                position: callsign.position,
                comment: callsign.comment,
                unit_id: callsign.unit_id,
                unit_name: units
                    .get(&callsign.unit_id)
                    .map(String::as_str)
                    .unwrap_or(""),
                active: callsign.active,
                source_id: callsign.source_id,
                source_name: callsign.source_id.and_then(|id| {
                    sources.get(&(id as i64)).map(String::as_str)
                }),
                created_at: created_at
                    .with_timezone(&tz)
                    .format("%Y-%m-%d %H:%M:%S")
                    .to_string(),
                developing: callsign.developing,
                radio_freq: callsign.radio_freq,
            };
            wtr.serialize(&row).c(h!())?;
        }
        wtr.flush().c(h!())?;
    }

    let file = actix_files::NamedFile::open_async(temp_file_name)
        .await
        .c(h!())?;
    Ok(file.into_response(&http_req))
}

async fn list_callsigns_impl(
    dbx: &DatabaseConnection,
    req: &ListCallsignsReq,
) -> Result<Vec<Callsign>, AppError> {
    let mut callsigns = sigint_callsign::Entity::find()
        .find_also_related(sigint_unit::Entity)
        .filter(sigint_callsign::Column::Deleted.eq(false));
    // just one sort_by supported for now
    if let Some(after_id) = &req.after_id {
        let after_callsign = find_callsign(dbx, *after_id).await.c(h!())?;
        let after_unit =
            crate::sigint::unit::find_unit(dbx, after_callsign.unit_id)
                .await
                .c(h!())?;
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

    let filter_developing = req
        .filter_developing
        .clone()
        .unwrap_or(DevelopingFilter::OnlyNonDeveloping);
    callsigns = match filter_developing {
        DevelopingFilter::OnlyDeveloping => callsigns
            .filter(sigint_callsign::Column::Developing.eq(true)),
        DevelopingFilter::OnlyNonDeveloping => callsigns
            .filter(sigint_callsign::Column::Developing.eq(false)),
        DevelopingFilter::All => callsigns,
    };

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
    let callsigns = callsigns.limit(req.limit).all(dbx).await.c(h!())?;
    let mut res = vec![];
    for (callsign, unit) in callsigns {
        let mut c = render_callsign(unit, callsign)?;
        if let Some(changelog) = sigint_callsign_changelog::Entity::find()
            .filter(
                sigint_callsign_changelog::Column::SigintCallsignId.eq(c.id),
            )
            .order_by_desc(sigint_callsign_changelog::Column::Id)
            .one(dbx)
            .await
            .c(h!())?
        {
            c.created_at = changelog.created_at.and_utc().timestamp_millis();
        }

        res.push(c);
    }
    Ok(res)
}

#[post("/api/sigint/callsigns-with-units-from-inbox")]
pub async fn get_callsigns_with_units_from_inbox(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<GetCallsignsWithUnitsFromInboxReq>,
) -> Result<Json<GetCallsignsWithUnitsFromInboxRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
    let login = user.id().c(h!())?;

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
        INNER JOIN datasource_group dg ON sm.datasource_group_id = dg.id
        INNER JOIN sigint_inbox_item sii ON sm.id = sii.id,
        LATERAL jsonb_array_elements_text(sii.callsigns) AS cs(value)
        WHERE dg.group_master_key = ANY($1)
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
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login)
            .await
            .c(h!())?;
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
        .await
        .c(h!())?;

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
    let user_id = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &user_id, "Rer")
        .await
        .c(h!())?;
    crate::users::has_role(&env.dbx, &user_id, "CallsignsEditor")
        .await
        .c(h!())?;

    info!(
        "create_callsign; login: {}; req: {:?}",
        user.id().c(h!())?,
        req
    );

    let txn = env.dbx.begin().await.c(h!())?;
    let req = req.into_inner();
    let callsign = bl_callsign_create(&req, &user_id, &txn)
        .await
        .context(h!())?;

    txn.commit().await.context(h!())?;

    let event = EventMsg::new(EventType::ETCallsignChanged);
    fanout(&mut env.redis.clone(), event).await.context(h!())?;

    Ok(Json(
        render_callsign(
            sigint_unit::Entity::find_by_id(callsign.unit_id)
                .one(&env.dbx)
                .await
                .context(h!())?,
            callsign,
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
    let user_id = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &user_id, "Rer")
        .await
        .c(h!())?;
    crate::users::has_role(&env.dbx, &user_id, "CallsignsEditor")
        .await
        .c(h!())?;

    info!("update_callsign; login: {user_id}; req: {req:?}");
    let req = req.into_inner();

    let txn = env.dbx.begin().await.c(h!())?;
    let callsign = bl_callsign_update(&req, &user_id, &txn)
        .await
        .context(h!())?;
    txn.commit().await.context(h!())?;

    let event = EventMsg::new(EventType::ETCallsignChanged);
    fanout(&mut env.redis.clone(), event).await.context(h!())?;

    Ok(Json(render_callsign(
        sigint_unit::Entity::find_by_id(callsign.unit_id)
            .one(&env.dbx)
            .await
            .c(h!())?,
        callsign,
    )?))
}

#[post("/api/sigint/callsign/delete")]
pub async fn delete_callsign(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<i64>,
) -> Result<Json<Callsign>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "CallsignsEditor")
        .await
        .c(h!())?;

    info!(
        "delete_callsign; login: {}; req: {:?}",
        user.id().c(h!())?,
        req
    );

    let callsign = find_callsign(&env.dbx, *req).await.c(h!())?;
    let callsign_json_old = sigint_callsign::Entity::find_by_id(callsign.id)
        .into_json()
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or_else(|| AppError::NotFound)?;
    let mut callsign = callsign.into_active_model();
    callsign.deleted = Set(true);
    let callsign = callsign.update(&env.dbx).await.c(h!())?;
    let callsign_json_new = sigint_callsign::Entity::find_by_id(callsign.id)
        .into_json()
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or_else(|| AppError::NotFound)?;
    let _changelog = sigint_callsign_changelog::ActiveModel {
        id: NotSet,
        sigint_callsign_id: Set(callsign.id),
        login: Set(user.id().c(h!())?.to_string()),
        action: Set("delete".to_string()),
        created_at: NotSet,
        new_value: Set(Some(callsign_json_new)),
        old_value: Set(Some(callsign_json_old)),
        req: Set(None),
        sigint_origin_id: NotSet,
        original_id: NotSet,
    }
    .insert(&env.dbx)
    .await
    .c(h!())?;

    Ok(Json(render_callsign(
        sigint_unit::Entity::find_by_id(callsign.unit_id)
            .one(&env.dbx)
            .await
            .c(h!())?,
        callsign,
    )?))
}

pub fn render_callsign(
    unit: Option<sigint_unit::Model>,
    callsign: sigint_callsign::Model,
) -> Result<Callsign, AppError> {
    Ok(Callsign {
        id: callsign.id,
        callsign: callsign.callsign,
        position: callsign.position,
        unit_id: callsign.unit_id,
        active: unit.is_none_or(|u| u.active),
        source_id: callsign.source_id,
        comment: callsign.comment,
        created_at: callsign.created_at.and_utc().timestamp_millis(),
        developing: callsign.developing,
        radio_freq: Some(callsign.radio_freq),
    })
}

#[post("/api/sigint/callsign/unit-stats")]
pub async fn callsign_unit_stats(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    _req: Json<()>,
) -> Result<Json<CallsignUnitStatsRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
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
        .await
        .c(h!())?;
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
