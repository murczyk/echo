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
use rust_xlsxwriter::{Format, Workbook};
use sea_orm::*;
use sea_orm::{DbBackend, Statement};
use sea_query::types::IntoColumnRef;
use sea_query::Alias;
use sea_query::{Expr, SimpleExpr};

pub mod bl;
pub mod bl_network_callsign;
pub mod network_callsign;
pub mod oneoff;
pub mod types;

#[derive(Serialize)]
struct CallsignExportRow {
    pub id: i64,
    pub callsign: String,
    pub position: String,
    pub full_name: String,
    pub comment: String,
    pub unit_id: i64,
    pub unit_name: String,
    pub active: bool,
    pub source_id: Option<i32>,
    pub source_name: Option<String>,
    pub created_at: String,
    pub developing: bool,
    /// Set when source_id points to "radio" (id=2)
    pub radio_freq: Option<String>,
}

#[post("/api/sigint/callsigns")]
pub async fn list_callsigns(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    mut req: Json<ListCallsignsReq>,
) -> Result<Json<ListCallsignsRsp>, AppError> {
    crate::users::has_any_role(
        &env.dbx,
        &user.id().c(h!())?,
        vec!["Rer", "ApiAgent"],
    )
    .await
    .c(h!())?;

    let limit = *req.limit.get_or_insert(1000);
    req.limit = Some(limit.saturating_add(1));
    let mut res = list_callsigns_impl(&env.dbx, &req.0).await.c(h!())?;
    let show_load_more = res.len() > limit as usize;
    if show_load_more {
        res.truncate(limit as usize);
    }

    Ok(Json(ListCallsignsRsp {
        show_load_more,
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

    let rows = list_callsigns_export_rows(&env.dbx, &req.0).await.c(h!())?;

    let temp_file = tempfile::Builder::new()
        .prefix("sigint-callsigns")
        .suffix(".csv")
        .rand_bytes(5)
        .tempfile()
        .context(h!())?;

    let temp_file_name = temp_file.path().to_str().context(h!())?;
    {
        use std::io::Write as _;

        let mut csv_file = temp_file.reopen().context(h!())?;
        csv_file
            .write_all(crate::config::SIGINT_CSV_UTF8_BOM)
            .c(h!())?;
        let mut wtr = csv::Writer::from_writer(csv_file);
        for row in rows.into_iter() {
            wtr.serialize(&row).c(h!())?;
        }
        wtr.flush().c(h!())?;
    }

    let file = actix_files::NamedFile::open_async(temp_file_name)
        .await
        .c(h!())?;
    Ok(file.into_response(&http_req))
}

#[post("/api/sigint/callsigns/xlsx")]
pub async fn list_callsigns_xlsx(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ListCallsignsReq>,
    http_req: actix_web::HttpRequest,
) -> Result<actix_web::HttpResponse, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;

    let rows = list_callsigns_export_rows(&env.dbx, &req.0).await.c(h!())?;

    let temp_file = tempfile::Builder::new()
        .prefix("sigint-callsigns")
        .suffix(".xlsx")
        .rand_bytes(5)
        .tempfile()
        .context(h!())?;
    let temp_file_name = temp_file.path().to_str().context(h!())?;

    let mut workbook = Workbook::new();
    let sheet = workbook.add_worksheet();
    sheet.set_name("Позивні").c(h!())?;

    let headers = [
        "id",
        "callsign",
        "position",
        "full_name",
        "comment",
        "unit_id",
        "unit_name",
        "active",
        "source_id",
        "source_name",
        "created_at",
        "developing",
        "radio_freq",
    ];
    let col_widths = [
        10.0, 20.0, 24.0, 28.0, 40.0, 10.0, 34.0, 10.0, 10.0, 20.0, 22.0, 12.0,
        16.0,
    ];

    let format_bold = Format::new().set_bold();
    for (col, header) in headers.iter().enumerate() {
        sheet
            .write_string_with_format(0, col as u16, *header, &format_bold)
            .c(h!())?;
        sheet
            .set_column_width(col as u16, col_widths[col])
            .c(h!())?;
    }

    for (row_idx, row) in rows.iter().enumerate() {
        let row_num = row_idx as u32 + 1;
        sheet.write_number(row_num, 0, row.id as f64).c(h!())?;
        sheet.write_string(row_num, 1, &row.callsign).c(h!())?;
        sheet.write_string(row_num, 2, &row.position).c(h!())?;
        sheet.write_string(row_num, 3, &row.full_name).c(h!())?;
        sheet.write_string(row_num, 4, &row.comment).c(h!())?;
        sheet.write_number(row_num, 5, row.unit_id as f64).c(h!())?;
        sheet.write_string(row_num, 6, &row.unit_name).c(h!())?;
        sheet
            .write_string(row_num, 7, if row.active { "true" } else { "false" })
            .c(h!())?;
        if let Some(source_id) = row.source_id {
            sheet.write_number(row_num, 8, source_id as f64).c(h!())?;
        }
        if let Some(source_name) = row.source_name.as_ref() {
            sheet.write_string(row_num, 9, source_name).c(h!())?;
        }
        sheet.write_string(row_num, 10, &row.created_at).c(h!())?;
        sheet
            .write_string(
                row_num,
                11,
                if row.developing { "true" } else { "false" },
            )
            .c(h!())?;
        if let Some(radio_freq) = row.radio_freq.as_ref() {
            sheet.write_string(row_num, 12, radio_freq).c(h!())?;
        }
    }

    workbook.save(temp_file_name).c(h!())?;

    let file = actix_files::NamedFile::open_async(temp_file_name)
        .await
        .c(h!())?;
    Ok(file.into_response(&http_req))
}

async fn list_callsigns_export_rows(
    dbx: &DatabaseConnection,
    req: &ListCallsignsReq,
) -> Result<Vec<CallsignExportRow>, AppError> {
    let callsigns = list_callsigns_impl(dbx, req).await.c(h!())?;

    let sigint_unit_ids: Vec<i64> = callsigns
        .iter()
        .map(|callsign| callsign.unit_id)
        .unique()
        .collect();
    let source_ids: Vec<i64> = callsigns
        .iter()
        .flat_map(|callsign| callsign.source_id)
        .map(|source_id| source_id as i64)
        .unique()
        .collect();

    let units: HashMap<i64, String> = sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Id.is_in(sigint_unit_ids))
        .all(dbx)
        .await
        .context(h!())?
        .into_iter()
        .map(|unit| (unit.id, unit.name))
        .collect();
    let sources: HashMap<i64, String> = source::Entity::find()
        .filter(source::Column::Id.is_in(source_ids))
        .all(dbx)
        .await
        .context(h!())?
        .into_iter()
        .map(|source| (source.id, source.name))
        .collect();

    let tz = crate::config::get_tz();
    callsigns
        .into_iter()
        .map(|callsign| {
            let created_at =
                chrono::DateTime::from_timestamp_millis(callsign.created_at)
                    .unwrap()
                    .with_timezone(&tz)
                    .format("%Y-%m-%d %H:%M:%S")
                    .to_string();

            Ok(CallsignExportRow {
                id: callsign.id,
                callsign: callsign.callsign,
                position: callsign.position,
                full_name: callsign.full_name,
                comment: callsign.comment,
                unit_id: callsign.unit_id,
                unit_name: units
                    .get(&callsign.unit_id)
                    .cloned()
                    .unwrap_or_default(),
                active: callsign.active,
                source_id: callsign.source_id,
                source_name: callsign
                    .source_id
                    .and_then(|source_id| sources.get(&(source_id as i64)))
                    .cloned(),
                created_at,
                developing: callsign.developing,
                radio_freq: callsign.radio_freq,
            })
        })
        .collect()
}

async fn list_callsigns_impl(
    dbx: &DatabaseConnection,
    req: &ListCallsignsReq,
) -> Result<Vec<Callsign>, AppError> {
    let sort_by = effective_callsigns_sort(req);
    let mut callsigns = sigint_callsign::Entity::find()
        .find_also_related(sigint_unit::Entity)
        .filter(sigint_callsign::Column::Deleted.eq(false));
    if let Some(after_id) = &req.after_id {
        let after_cursor =
            load_callsign_seek_cursor(dbx, *after_id).await.c(h!())?;
        callsigns =
            apply_callsigns_after_cursor(callsigns, &sort_by, &after_cursor);
    }
    if let Some(filter_text) = &req.filter_text {
        if !filter_text.is_empty() {
            let pattern = format!("%{}%", filter_text.to_lowercase());
            callsigns = callsigns.filter(Condition::any().add(Expr::cust_with_values(
                "lower(sigint_callsign.callsign collate \"ru-x-icu\") ilike $1",
                vec![pattern.clone()],
            ))
            .add(Expr::cust_with_values(
                "lower(sigint_callsign.position collate \"ru-x-icu\") ilike $1",
                vec![pattern.clone()],
            ))
            .add(Expr::cust_with_values(
                "lower(sigint_callsign.full_name collate \"ru-x-icu\") ilike $1",
                vec![pattern.clone()],
            ))
            .add(Expr::cust_with_values(
                "lower(sigint_callsign.comment collate \"ru-x-icu\") ilike $1",
                vec![pattern.clone()],
            ))
            .add(Expr::cust_with_values(
                "lower(sigint_unit.name collate \"ru-x-icu\") ilike $1",
                vec![pattern],
            )));
        }
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
    if let Some(filter_full_name) = &req.filter_full_name {
        if !filter_full_name.is_empty() {
            callsigns = callsigns.filter(Expr::cust_with_values(
                "lower(sigint_callsign.full_name collate \"ru-x-icu\") ilike $1",
                vec![format!("%{}%", filter_full_name.to_lowercase())],
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
    if let Some(filter_unit_army) = &req.filter_unit_army {
        callsigns = callsigns
            .filter(sigint_unit::Column::Army.eq(filter_unit_army.clone()));
    }
    if let Some(filter_unit_division) = &req.filter_unit_division {
        callsigns = callsigns.filter(
            sigint_unit::Column::Division.eq(filter_unit_division.clone()),
        );
    }
    if let Some(filter_unit_regiment) = &req.filter_unit_regiment {
        callsigns = callsigns.filter(
            sigint_unit::Column::Regiment.eq(filter_unit_regiment.clone()),
        );
    }
    if let Some(filter_unit_battalion) = &req.filter_unit_battalion {
        callsigns = callsigns.filter(
            sigint_unit::Column::Battalion.eq(filter_unit_battalion.clone()),
        );
    }

    let filter_developing = req
        .filter_developing
        .clone()
        .unwrap_or(DevelopingFilter::All);
    callsigns = match filter_developing {
        DevelopingFilter::OnlyDeveloping => {
            callsigns.filter(sigint_callsign::Column::Developing.eq(true))
        }
        DevelopingFilter::OnlyNonDeveloping => {
            callsigns.filter(sigint_callsign::Column::Developing.eq(false))
        }
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

    callsigns = apply_callsigns_sort(callsigns, &sort_by);
    // println!(
    //     "> callsigns sql: {}",
    //     callsigns.build(DbBackend::Postgres).to_string()
    // );
    let callsigns = callsigns.limit(req.limit).all(dbx).await.c(h!())?;
    let mut res = vec![];
    for (callsign, unit) in callsigns {
        res.push(render_callsign(unit, callsign, vec![])?);
    }

    let callsign_ids =
        res.iter().map(|callsign| callsign.id).collect::<Vec<_>>();
    let mut effective_created_at_by_callsign =
        list_callsign_effective_created_at_batch(dbx, &callsign_ids)
            .await
            .c(h!())?;
    let mut source_ids_by_callsign =
        list_callsign_additional_source_ids_batch(dbx, &callsign_ids)
            .await
            .c(h!())?;
    for callsign in &mut res {
        if let Some(created_at) =
            effective_created_at_by_callsign.remove(&callsign.id)
        {
            callsign.created_at = created_at.and_utc().timestamp_millis();
        }
        callsign.callsign_additional_sources = source_ids_by_callsign
            .remove(&callsign.id)
            .unwrap_or_default();
    }

    Ok(res)
}

#[derive(Clone)]
struct CallsignSeekCursor {
    callsign: sigint_callsign::Model,
    unit: sigint_unit::Model,
    sort_created_at: chrono::NaiveDateTime,
    sort_position: String,
    sort_full_name: String,
    sort_comment: String,
    sort_source_name: String,
    sort_radio_freq: String,
}

#[derive(FromQueryResult)]
struct CallsignEffectiveCreatedAtRow {
    sigint_callsign_id: i64,
    created_at: chrono::NaiveDateTime,
}
fn effective_callsigns_sort(req: &ListCallsignsReq) -> ListCallsignsSortBy {
    req.sort_by
        .as_ref()
        .and_then(|sort_by| sort_by.first())
        .cloned()
        .unwrap_or(ListCallsignsSortBy::CallsignUnitAsc)
}

fn callsigns_sort_created_at_expr() -> SimpleExpr {
    Expr::cust(
        "COALESCE((SELECT MAX(sigint_callsign_changelog.created_at) \
         FROM sigint_callsign_changelog \
         WHERE sigint_callsign_changelog.sigint_callsign_id = sigint_callsign.id), \
         sigint_callsign.created_at)",
    )
}

fn callsigns_sort_source_name_expr() -> SimpleExpr {
    Expr::cust(
        "COALESCE((SELECT source.name FROM source WHERE source.id = sigint_callsign.source_id), '—')",
    )
}

fn callsigns_sort_radio_freq_expr() -> SimpleExpr {
    Expr::cust("COALESCE(NULLIF(BTRIM(sigint_callsign.radio_freq), ''), '—')")
}

fn callsigns_id_expr() -> SimpleExpr {
    Expr::col((sigint_callsign::Entity, sigint_callsign::Column::Id)).into()
}

async fn load_callsign_seek_cursor(
    dbx: &DatabaseConnection,
    callsign_id: i64,
) -> Result<CallsignSeekCursor, AppError> {
    let callsign = find_callsign(dbx, callsign_id).await.c(h!())?;
    let unit = crate::sigint::unit::find_unit(dbx, callsign.unit_id)
        .await
        .c(h!())?;
    let source_name = if let Some(source_id) = callsign.source_id {
        source::Entity::find_by_id(source_id as i64)
            .one(dbx)
            .await
            .c(h!())?
            .map(|source| source.name)
            .unwrap_or_else(|| "—".to_string())
    } else {
        "—".to_string()
    };
    let effective_created_at = load_callsign_effective_created_at(
        dbx,
        callsign_id,
        callsign.created_at,
    )
    .await
    .c(h!())?;

    Ok(CallsignSeekCursor {
        sort_created_at: effective_created_at,
        sort_position: callsign.position.clone(),
        sort_full_name: callsign.full_name.clone(),
        sort_comment: callsign.comment.clone(),
        sort_source_name: source_name,
        sort_radio_freq: normalize_callsign_sort_radio_freq_value(
            &callsign.radio_freq,
        ),
        callsign,
        unit,
    })
}

async fn load_callsign_effective_created_at<C>(
    dbx: &C,
    callsign_id: i64,
    fallback_created_at: chrono::NaiveDateTime,
) -> Result<chrono::NaiveDateTime, AppError>
where
    C: ConnectionTrait,
{
    let created_at =
        list_callsign_effective_created_at_batch(dbx, &[callsign_id])
            .await
            .c(h!())?
            .remove(&callsign_id)
            .unwrap_or(fallback_created_at);

    Ok(created_at)
}

async fn list_callsign_effective_created_at_batch<C>(
    dbx: &C,
    callsign_ids: &[i64],
) -> Result<HashMap<i64, chrono::NaiveDateTime>, AppError>
where
    C: ConnectionTrait,
{
    if callsign_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let rows = sigint_callsign_changelog::Entity::find()
        .filter(
            sigint_callsign_changelog::Column::SigintCallsignId
                .is_in(callsign_ids.to_vec()),
        )
        .select_only()
        .column_as(
            sigint_callsign_changelog::Column::SigintCallsignId,
            "sigint_callsign_id",
        )
        .expr_as(Expr::cust("MAX(created_at)"), "created_at")
        .group_by(sigint_callsign_changelog::Column::SigintCallsignId)
        .into_model::<CallsignEffectiveCreatedAtRow>()
        .all(dbx)
        .await
        .context(h!())?;

    Ok(rows
        .into_iter()
        .map(|row| (row.sigint_callsign_id, row.created_at))
        .collect())
}

fn normalize_callsign_sort_radio_freq_value(radio_freq: &str) -> String {
    let radio_freq = radio_freq.trim();
    if radio_freq.is_empty() {
        "—".to_string()
    } else {
        radio_freq.to_string()
    }
}
fn apply_callsigns_after_cursor(
    callsigns: SelectTwo<sigint_callsign::Entity, sigint_unit::Entity>,
    sort_by: &ListCallsignsSortBy,
    cursor: &CallsignSeekCursor,
) -> SelectTwo<sigint_callsign::Entity, sigint_unit::Entity> {
    match sort_by {
        ListCallsignsSortBy::CallsignAsc => callsigns.filter(
            Expr::tuple([
                sigint_callsign::Column::Callsign.into_column_ref().into(),
                callsigns_id_expr(),
            ])
            .gt(SimpleExpr::Tuple(vec![
                cursor.callsign.callsign.clone().into(),
                cursor.callsign.id.into(),
            ])),
        ),
        ListCallsignsSortBy::CallsignDesc => callsigns.filter(
            Expr::tuple([
                sigint_callsign::Column::Callsign.into_column_ref().into(),
                callsigns_id_expr(),
            ])
            .lt(SimpleExpr::Tuple(vec![
                cursor.callsign.callsign.clone().into(),
                cursor.callsign.id.into(),
            ])),
        ),
        ListCallsignsSortBy::CallsignPositionAsc => callsigns.filter(
            Expr::tuple([
                sigint_callsign::Column::Position.into_column_ref().into(),
                callsigns_id_expr(),
            ])
            .gt(SimpleExpr::Tuple(vec![
                cursor.sort_position.clone().into(),
                cursor.callsign.id.into(),
            ])),
        ),
        ListCallsignsSortBy::CallsignPositionDesc => callsigns.filter(
            Expr::tuple([
                sigint_callsign::Column::Position.into_column_ref().into(),
                callsigns_id_expr(),
            ])
            .lt(SimpleExpr::Tuple(vec![
                cursor.sort_position.clone().into(),
                cursor.callsign.id.into(),
            ])),
        ),
        ListCallsignsSortBy::CallsignFullNameAsc => callsigns.filter(
            Expr::tuple([
                sigint_callsign::Column::FullName.into_column_ref().into(),
                callsigns_id_expr(),
            ])
            .gt(SimpleExpr::Tuple(vec![
                cursor.sort_full_name.clone().into(),
                cursor.callsign.id.into(),
            ])),
        ),
        ListCallsignsSortBy::CallsignFullNameDesc => callsigns.filter(
            Expr::tuple([
                sigint_callsign::Column::FullName.into_column_ref().into(),
                callsigns_id_expr(),
            ])
            .lt(SimpleExpr::Tuple(vec![
                cursor.sort_full_name.clone().into(),
                cursor.callsign.id.into(),
            ])),
        ),
        ListCallsignsSortBy::CallsignCommentAsc => callsigns.filter(
            Expr::tuple([
                sigint_callsign::Column::Comment.into_column_ref().into(),
                callsigns_id_expr(),
            ])
            .gt(SimpleExpr::Tuple(vec![
                cursor.sort_comment.clone().into(),
                cursor.callsign.id.into(),
            ])),
        ),
        ListCallsignsSortBy::CallsignCommentDesc => callsigns.filter(
            Expr::tuple([
                sigint_callsign::Column::Comment.into_column_ref().into(),
                callsigns_id_expr(),
            ])
            .lt(SimpleExpr::Tuple(vec![
                cursor.sort_comment.clone().into(),
                cursor.callsign.id.into(),
            ])),
        ),
        ListCallsignsSortBy::CallsignSourceAsc => callsigns.filter(
            Expr::tuple([
                callsigns_sort_source_name_expr(),
                callsigns_id_expr(),
            ])
            .gt(SimpleExpr::Tuple(vec![
                cursor.sort_source_name.clone().into(),
                cursor.callsign.id.into(),
            ])),
        ),
        ListCallsignsSortBy::CallsignSourceDesc => callsigns.filter(
            Expr::tuple([
                callsigns_sort_source_name_expr(),
                callsigns_id_expr(),
            ])
            .lt(SimpleExpr::Tuple(vec![
                cursor.sort_source_name.clone().into(),
                cursor.callsign.id.into(),
            ])),
        ),
        ListCallsignsSortBy::CallsignRadioFreqAsc => callsigns.filter(
            Expr::tuple([
                callsigns_sort_radio_freq_expr(),
                callsigns_id_expr(),
            ])
            .gt(SimpleExpr::Tuple(vec![
                cursor.sort_radio_freq.clone().into(),
                cursor.callsign.id.into(),
            ])),
        ),
        ListCallsignsSortBy::CallsignRadioFreqDesc => callsigns.filter(
            Expr::tuple([
                callsigns_sort_radio_freq_expr(),
                callsigns_id_expr(),
            ])
            .lt(SimpleExpr::Tuple(vec![
                cursor.sort_radio_freq.clone().into(),
                cursor.callsign.id.into(),
            ])),
        ),
        ListCallsignsSortBy::CallsignCreatedAtAsc => callsigns.filter(
            Expr::tuple([
                callsigns_sort_created_at_expr(),
                callsigns_id_expr(),
            ])
            .gt(SimpleExpr::Tuple(vec![
                cursor.sort_created_at.into(),
                cursor.callsign.id.into(),
            ])),
        ),
        ListCallsignsSortBy::CallsignCreatedAtDesc => callsigns.filter(
            Expr::tuple([
                callsigns_sort_created_at_expr(),
                callsigns_id_expr(),
            ])
            .lt(SimpleExpr::Tuple(vec![
                cursor.sort_created_at.into(),
                cursor.callsign.id.into(),
            ])),
        ),
        ListCallsignsSortBy::CallsignUnitAsc => callsigns.filter(
            Expr::tuple([
                sigint_unit::Column::Army.into_column_ref().into(),
                sigint_unit::Column::Division.into_column_ref().into(),
                sigint_unit::Column::Regiment.into_column_ref().into(),
                sigint_unit::Column::Battalion.into_column_ref().into(),
                sigint_unit::Column::Company.into_column_ref().into(),
                sigint_callsign::Column::Callsign.into_column_ref().into(),
                callsigns_id_expr(),
            ])
            .gt(SimpleExpr::Tuple(vec![
                cursor.unit.army.clone().into(),
                cursor.unit.division.clone().into(),
                cursor.unit.regiment.clone().into(),
                cursor.unit.battalion.clone().into(),
                cursor.unit.company.clone().into(),
                cursor.callsign.callsign.clone().into(),
                cursor.callsign.id.into(),
            ])),
        ),
        ListCallsignsSortBy::CallsignUnitDesc => callsigns.filter(
            Expr::tuple([
                sigint_unit::Column::Army.into_column_ref().into(),
                sigint_unit::Column::Division.into_column_ref().into(),
                sigint_unit::Column::Regiment.into_column_ref().into(),
                sigint_unit::Column::Battalion.into_column_ref().into(),
                sigint_unit::Column::Company.into_column_ref().into(),
                sigint_callsign::Column::Callsign.into_column_ref().into(),
                callsigns_id_expr(),
            ])
            .lt(SimpleExpr::Tuple(vec![
                cursor.unit.army.clone().into(),
                cursor.unit.division.clone().into(),
                cursor.unit.regiment.clone().into(),
                cursor.unit.battalion.clone().into(),
                cursor.unit.company.clone().into(),
                cursor.callsign.callsign.clone().into(),
                cursor.callsign.id.into(),
            ])),
        ),
    }
}

fn apply_callsigns_sort(
    callsigns: SelectTwo<sigint_callsign::Entity, sigint_unit::Entity>,
    sort_by: &ListCallsignsSortBy,
) -> SelectTwo<sigint_callsign::Entity, sigint_unit::Entity> {
    match sort_by {
        ListCallsignsSortBy::CallsignAsc => callsigns
            .order_by_asc(sigint_callsign::Column::Callsign)
            .order_by_asc(sigint_callsign::Column::Id),
        ListCallsignsSortBy::CallsignDesc => callsigns
            .order_by_desc(sigint_callsign::Column::Callsign)
            .order_by_desc(sigint_callsign::Column::Id),
        ListCallsignsSortBy::CallsignPositionAsc => callsigns
            .order_by_asc(sigint_callsign::Column::Position)
            .order_by_asc(sigint_callsign::Column::Id),
        ListCallsignsSortBy::CallsignPositionDesc => callsigns
            .order_by_desc(sigint_callsign::Column::Position)
            .order_by_desc(sigint_callsign::Column::Id),
        ListCallsignsSortBy::CallsignFullNameAsc => callsigns
            .order_by_asc(sigint_callsign::Column::FullName)
            .order_by_asc(sigint_callsign::Column::Id),
        ListCallsignsSortBy::CallsignFullNameDesc => callsigns
            .order_by_desc(sigint_callsign::Column::FullName)
            .order_by_desc(sigint_callsign::Column::Id),
        ListCallsignsSortBy::CallsignCommentAsc => callsigns
            .order_by_asc(sigint_callsign::Column::Comment)
            .order_by_asc(sigint_callsign::Column::Id),
        ListCallsignsSortBy::CallsignCommentDesc => callsigns
            .order_by_desc(sigint_callsign::Column::Comment)
            .order_by_desc(sigint_callsign::Column::Id),
        ListCallsignsSortBy::CallsignSourceAsc => callsigns
            .order_by_asc(callsigns_sort_source_name_expr())
            .order_by_asc(sigint_callsign::Column::Id),
        ListCallsignsSortBy::CallsignSourceDesc => callsigns
            .order_by_desc(callsigns_sort_source_name_expr())
            .order_by_desc(sigint_callsign::Column::Id),
        ListCallsignsSortBy::CallsignRadioFreqAsc => callsigns
            .order_by_asc(callsigns_sort_radio_freq_expr())
            .order_by_asc(sigint_callsign::Column::Id),
        ListCallsignsSortBy::CallsignRadioFreqDesc => callsigns
            .order_by_desc(callsigns_sort_radio_freq_expr())
            .order_by_desc(sigint_callsign::Column::Id),
        ListCallsignsSortBy::CallsignCreatedAtAsc => callsigns
            .order_by_asc(callsigns_sort_created_at_expr())
            .order_by_asc(sigint_callsign::Column::Id),
        ListCallsignsSortBy::CallsignCreatedAtDesc => callsigns
            .order_by_desc(callsigns_sort_created_at_expr())
            .order_by_desc(sigint_callsign::Column::Id),
        ListCallsignsSortBy::CallsignUnitAsc => callsigns
            .order_by_asc(sigint_unit::Column::Army)
            .order_by_asc(sigint_unit::Column::Division)
            .order_by_asc(sigint_unit::Column::Regiment)
            .order_by_asc(sigint_unit::Column::Battalion)
            .order_by_asc(sigint_unit::Column::Company)
            .order_by_asc(sigint_callsign::Column::Callsign)
            .order_by_asc(sigint_callsign::Column::Id),
        ListCallsignsSortBy::CallsignUnitDesc => callsigns
            .order_by_desc(sigint_unit::Column::Army)
            .order_by_desc(sigint_unit::Column::Division)
            .order_by_desc(sigint_unit::Column::Regiment)
            .order_by_desc(sigint_unit::Column::Battalion)
            .order_by_desc(sigint_unit::Column::Company)
            .order_by_desc(sigint_callsign::Column::Callsign)
            .order_by_desc(sigint_callsign::Column::Id),
    }
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

    let callsign_additional_sources =
        list_callsign_additional_source_ids(&env.dbx, callsign.id)
            .await
            .context(h!())?;

    Ok(Json(
        render_callsign(
            sigint_unit::Entity::find_by_id(callsign.unit_id)
                .one(&env.dbx)
                .await
                .context(h!())?,
            callsign,
            callsign_additional_sources,
        )
        .context(h!())?,
    ))
}

#[post("/api/sigint/callsign/update")]
pub async fn update_callsign(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<UpdateCallsignReq>,
) -> Result<Json<Callsign>, AppError> {
    let user_id = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &user_id, "Rer")
        .await
        .c(h!())?;
    crate::users::has_role(&env.dbx, &user_id, "CallsignsEditor")
        .await
        .c(h!())?;

    info!("update_callsign; login: {user_id}; req: {:?}", req);
    let req = req.into_inner();

    let txn = env.dbx.begin().await.c(h!())?;
    let callsign = bl_callsign_update(&req, &user_id, &txn)
        .await
        .context(h!())?;
    txn.commit().await.context(h!())?;

    let event = EventMsg::new(EventType::ETCallsignChanged);
    fanout(&mut env.redis.clone(), event).await.context(h!())?;

    let callsign_additional_sources =
        list_callsign_additional_source_ids(&env.dbx, callsign.id)
            .await
            .context(h!())?;

    Ok(Json(render_callsign(
        sigint_unit::Entity::find_by_id(callsign.unit_id)
            .one(&env.dbx)
            .await
            .c(h!())?,
        callsign,
        callsign_additional_sources,
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

    let callsign_additional_sources =
        list_callsign_additional_source_ids(&env.dbx, callsign.id)
            .await
            .c(h!())?;

    Ok(Json(render_callsign(
        sigint_unit::Entity::find_by_id(callsign.unit_id)
            .one(&env.dbx)
            .await
            .c(h!())?,
        callsign,
        callsign_additional_sources,
    )?))
}

pub fn render_callsign(
    unit: Option<sigint_unit::Model>,
    callsign: sigint_callsign::Model,
    callsign_additional_sources: Vec<i64>,
) -> Result<Callsign, AppError> {
    Ok(Callsign {
        id: callsign.id,
        callsign: callsign.callsign,
        position: callsign.position,
        full_name: callsign.full_name,
        unit_id: callsign.unit_id,
        active: unit.is_none_or(|u| u.active),
        source_id: callsign.source_id,
        callsign_additional_sources,
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
    let units = list_callsign_unit_stats(&env.dbx).await?;
    Ok(Json(CallsignUnitStatsRsp { units }))
}

async fn list_callsign_unit_stats(
    dbx: &DatabaseConnection,
) -> Result<Vec<CallsignUnitStatRow>, AppError> {
    #[derive(FromQueryResult)]
    struct Row {
        unit_id: i64,
        count: i64,
    }
    let rows = sigint_callsign::Entity::find()
        .filter(sigint_callsign::Column::Deleted.eq(false))
        .filter(sigint_unit::Column::Deleted.eq(false))
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
        .all(dbx)
        .await
        .c(h!())?;
    let mut res = vec![];
    for row in rows {
        res.push(CallsignUnitStatRow {
            unit_id: row.unit_id,
            count: row.count,
        });
    }
    Ok(res)
}

pub async fn load_whitelist_from_file(
    mode: Mode,
) -> anyhow::Result<HashSet<String>> {
    let root_dir = crate::config::get_data_folder(mode).context(h!())?;
    let path = root_dir.join("callsigns_whitelist.txt");
    let callsigns = crate::utils::read_lines_from_file(path)
        .await
        .unwrap_or_else(|e| {
            error!("failed to load callsigns: {:?}\nfallback to empty set", e);
            vec![]
        })
        .into_iter()
        .collect();
    Ok(callsigns)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::functest::tests::*;
    use chrono::{Duration, Utc};
    use sea_orm::ActiveValue::Set;
    use serial_test::serial;

    async fn insert_test_unit(
        dbx: &DatabaseConnection,
        login: &str,
        name: &str,
    ) -> sigint_unit::Model {
        sigint_unit::ActiveModel {
            company: Set("C".to_string()),
            regiment: Set("R".to_string()),
            division: Set("D".to_string()),
            army: Set("A".to_string()),
            active: Set(true),
            deleted: Set(false),
            created_at: Set(Utc::now().naive_utc()),
            created_by: Set(login.to_string()),
            name: Set(name.to_string()),
            comment: Set(String::new()),
            battalion: Set("B".to_string()),
            ..Default::default()
        }
        .insert(dbx)
        .await
        .unwrap()
    }

    async fn insert_test_callsign(
        dbx: &DatabaseConnection,
        unit_id: i64,
        callsign: &str,
        created_at: chrono::NaiveDateTime,
        radio_freq: &str,
    ) -> sigint_callsign::Model {
        sigint_callsign::ActiveModel {
            callsign: Set(callsign.to_string()),
            position: Set("pos".to_string()),
            comment: Set("comment".to_string()),
            full_name: Set(String::new()),
            unit_id: Set(unit_id),
            deleted: Set(false),
            created_at: Set(created_at),
            source_id: Set(None),
            developing: Set(false),
            radio_freq: Set(radio_freq.to_string()),
            sigint_origin_id: Set(None),
            original_id: Set(None),
            ..Default::default()
        }
        .insert(dbx)
        .await
        .unwrap()
    }

    async fn insert_test_callsign_with_full_name(
        dbx: &DatabaseConnection,
        unit_id: i64,
        callsign: &str,
        full_name: &str,
        created_at: chrono::NaiveDateTime,
    ) -> sigint_callsign::Model {
        sigint_callsign::ActiveModel {
            callsign: Set(callsign.to_string()),
            position: Set("pos".to_string()),
            comment: Set("comment".to_string()),
            full_name: Set(full_name.to_string()),
            unit_id: Set(unit_id),
            deleted: Set(false),
            created_at: Set(created_at),
            source_id: Set(None),
            developing: Set(false),
            radio_freq: Set(String::new()),
            sigint_origin_id: Set(None),
            original_id: Set(None),
            ..Default::default()
        }
        .insert(dbx)
        .await
        .unwrap()
    }

    fn list_req(
        after_id: Option<i64>,
        limit: Option<u64>,
        sort_by: ListCallsignsSortBy,
    ) -> ListCallsignsReq {
        ListCallsignsReq {
            after_id,
            before_id: None,
            filter_text: None,
            filter_callsign: None,
            filter_position: None,
            filter_full_name: None,
            filter_comment: None,
            filter_unit: None,
            filter_unit_army: None,
            filter_unit_division: None,
            filter_unit_regiment: None,
            filter_unit_battalion: None,
            filter_developing: None,
            since_date_inclusive_ms: None,
            till_date_inclusive_ms: None,
            limit,
            sort_by: Some(vec![sort_by]),
        }
    }

    #[test]
    fn normalize_callsign_sort_radio_freq_value_maps_blank_to_placeholder() {
        assert_eq!(normalize_callsign_sort_radio_freq_value(""), "—");
        assert_eq!(normalize_callsign_sort_radio_freq_value("   "), "—");
    }

    #[test]
    fn normalize_callsign_sort_radio_freq_value_trims_non_blank_value() {
        assert_eq!(
            normalize_callsign_sort_radio_freq_value(" 149.200 "),
            "149.200",
        );
    }

    #[serial]
    #[tokio::test]
    async fn test_list_callsigns_created_at_sort_matches_visible_created_at() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let unit =
            insert_test_unit(&env.dbx, &login.login, "CallsignTestUnit").await;
        let now = Utc::now().naive_utc();

        let callsign_alpha =
            insert_test_callsign(&env.dbx, unit.id, "alpha", now, "").await;
        let _callsign_bravo = insert_test_callsign(
            &env.dbx,
            unit.id,
            "bravo",
            now + Duration::minutes(90),
            "",
        )
        .await;

        sigint_callsign_changelog::ActiveModel {
            sigint_callsign_id: Set(callsign_alpha.id),
            login: Set(login.login.clone()),
            action: Set("update".to_string()),
            created_at: Set(now + Duration::minutes(120)),
            new_value: Set(None),
            old_value: Set(None),
            req: Set(None),
            sigint_origin_id: Set(None),
            original_id: Set(None),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        sigint_callsign_changelog::ActiveModel {
            sigint_callsign_id: Set(callsign_alpha.id),
            login: Set(login.login.clone()),
            action: Set("update".to_string()),
            created_at: Set(now + Duration::minutes(60)),
            new_value: Set(None),
            old_value: Set(None),
            req: Set(None),
            sigint_origin_id: Set(None),
            original_id: Set(None),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        let callsigns = list_callsigns_impl(
            &env.dbx,
            &list_req(None, None, ListCallsignsSortBy::CallsignCreatedAtDesc),
        )
        .await
        .unwrap();

        assert_eq!(callsigns[0].id, callsign_alpha.id);
        assert_eq!(
            callsigns[0].created_at,
            (now + Duration::minutes(120)).and_utc().timestamp_millis(),
        );
        assert!(callsigns[0].created_at > callsigns[1].created_at);
    }

    #[serial]
    #[tokio::test]
    async fn test_callsign_unit_stats_excludes_deleted_units() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let active_unit =
            insert_test_unit(&env.dbx, &login.login, "ActiveUnit").await;
        let deleted_unit =
            insert_test_unit(&env.dbx, &login.login, "DeletedUnit").await;
        let now = Utc::now().naive_utc();

        sigint_unit::ActiveModel {
            id: Set(active_unit.id),
            deleted: Set(false),
            ..Default::default()
        }
        .update(&env.dbx)
        .await
        .unwrap();

        sigint_unit::ActiveModel {
            id: Set(deleted_unit.id),
            deleted: Set(true),
            ..Default::default()
        }
        .update(&env.dbx)
        .await
        .unwrap();

        insert_test_callsign(&env.dbx, active_unit.id, "alpha", now, "").await;
        sigint_callsign::ActiveModel {
            callsign: Set("alpha-deleted".to_string()),
            position: Set("pos".to_string()),
            comment: Set("comment".to_string()),
            full_name: Set(String::new()),
            unit_id: Set(active_unit.id),
            deleted: Set(true),
            created_at: Set(now + Duration::minutes(1)),
            source_id: Set(None),
            developing: Set(false),
            radio_freq: Set(String::new()),
            sigint_origin_id: Set(None),
            original_id: Set(None),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        insert_test_callsign(&env.dbx, deleted_unit.id, "bravo", now, "").await;

        let stats = list_callsign_unit_stats(&env.dbx).await.unwrap();

        assert_eq!(
            stats,
            vec![CallsignUnitStatRow {
                unit_id: active_unit.id,
                count: 1,
            }],
        );
    }

    #[serial]
    #[tokio::test]
    async fn test_list_callsigns_radio_freq_sort_pagination_matches_full_result(
    ) {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let unit =
            insert_test_unit(&env.dbx, &login.login, "CallsignTestUnit").await;
        let now = Utc::now().naive_utc();

        insert_test_callsign(&env.dbx, unit.id, "alpha", now, "   ").await;
        insert_test_callsign(&env.dbx, unit.id, "bravo", now, "149.200").await;
        insert_test_callsign(&env.dbx, unit.id, "charlie", now, "").await;

        let full = list_callsigns_impl(
            &env.dbx,
            &list_req(None, None, ListCallsignsSortBy::CallsignRadioFreqAsc),
        )
        .await
        .unwrap();
        let full_ids =
            full.iter().map(|callsign| callsign.id).collect::<Vec<_>>();

        let mut paged_ids = vec![];
        let mut after_id = None;
        for _ in 0..=full_ids.len() {
            let page = list_callsigns_impl(
                &env.dbx,
                &list_req(
                    after_id,
                    Some(1),
                    ListCallsignsSortBy::CallsignRadioFreqAsc,
                ),
            )
            .await
            .unwrap();
            if page.is_empty() {
                break;
            }
            after_id = page.last().map(|callsign| callsign.id);
            paged_ids.extend(page.into_iter().map(|callsign| callsign.id));
        }

        assert_eq!(paged_ids, full_ids);
    }

    #[serial]
    #[tokio::test]
    async fn test_list_callsigns_filters_by_unit_hierarchy_path() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let now = Utc::now().naive_utc();

        let matching_unit = sigint_unit::ActiveModel {
            company: Set("C".to_string()),
            regiment: Set("11".to_string()),
            division: Set("3".to_string()),
            army: Set("A".to_string()),
            active: Set(true),
            deleted: Set(false),
            created_at: Set(now),
            created_by: Set(login.login.clone()),
            name: Set("MatchingUnit".to_string()),
            comment: Set(String::new()),
            battalion: Set("B".to_string()),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        let other_division_unit = sigint_unit::ActiveModel {
            company: Set("C".to_string()),
            regiment: Set("11".to_string()),
            division: Set("5".to_string()),
            army: Set("A".to_string()),
            active: Set(true),
            deleted: Set(false),
            created_at: Set(now),
            created_by: Set(login.login.clone()),
            name: Set("OtherDivisionUnit".to_string()),
            comment: Set(String::new()),
            battalion: Set("B".to_string()),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        insert_test_callsign(&env.dbx, matching_unit.id, "alpha", now, "")
            .await;
        insert_test_callsign(
            &env.dbx,
            other_division_unit.id,
            "bravo",
            now,
            "",
        )
        .await;

        let mut req =
            list_req(None, Some(100), ListCallsignsSortBy::CallsignAsc);
        req.filter_unit_army = Some("A".to_string());
        req.filter_unit_division = Some("3".to_string());

        let callsigns = list_callsigns_impl(&env.dbx, &req).await.unwrap();

        assert_eq!(callsigns.len(), 1);
        assert_eq!(callsigns[0].callsign, "alpha");
    }

    #[serial]
    #[tokio::test]
    async fn test_list_callsigns_filters_and_sorts_by_full_name() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let unit =
            insert_test_unit(&env.dbx, &login.login, "CallsignTestUnit").await;
        let now = Utc::now().naive_utc();

        insert_test_callsign_with_full_name(
            &env.dbx,
            unit.id,
            "alpha",
            "Іваненко Іван Іванович",
            now,
        )
        .await;
        insert_test_callsign_with_full_name(
            &env.dbx,
            unit.id,
            "bravo",
            "Бондаренко Петро Петрович",
            now + Duration::minutes(1),
        )
        .await;

        let mut req =
            list_req(None, Some(100), ListCallsignsSortBy::CallsignFullNameAsc);
        req.filter_full_name = Some("бондаренко".to_string());

        let callsigns = list_callsigns_impl(&env.dbx, &req).await.unwrap();

        assert_eq!(callsigns.len(), 1);
        assert_eq!(callsigns[0].callsign, "bravo");
        assert_eq!(callsigns[0].full_name, "Бондаренко Петро Петрович");
    }
}
