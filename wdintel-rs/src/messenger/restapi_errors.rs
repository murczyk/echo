use crate::entities::signal_restapi_error;
use crate::error::AppError;
use crate::h;
use crate::types::{Env, ShortContext};
use actix_identity::Identity;
use actix_web::post;
use actix_web::web::Json;
use chrono::{DateTime, NaiveDateTime, TimeDelta, Utc};
use elm_rs::{Elm, ElmDecode, ElmEncode};
use sea_orm::{
    ColumnTrait, DatabaseBackend, DatabaseConnection, EntityTrait,
    FromQueryResult, QueryFilter, QueryOrder, QuerySelect, Statement,
};
use serde::{Deserialize, Serialize};

const MAX_RESTAPI_ERROR_ROWS: u64 = 1000;
const MAX_RESTAPI_ERROR_COUNT_DAYS: i64 = 120;
const APP_TIME_ZONE_SQL: &str = "Europe/Kiev";

#[derive(Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct SignalRestapiErrorListReq {
    pub since: String,
    pub till: String,
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct SignalRestapiErrorRow {
    pub id: i64,
    pub created_at: String,
    pub response_text: String,
    pub response_json: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct SignalRestapiErrorListRsp {
    pub items: Vec<SignalRestapiErrorRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct SignalRestapiErrorCountsReq {
    pub since: String,
    pub till: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct SignalRestapiErrorDayCount {
    pub day: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct SignalRestapiErrorCountsRsp {
    pub items: Vec<SignalRestapiErrorDayCount>,
}

#[derive(Debug, FromQueryResult)]
struct SignalRestapiErrorDayCountRow {
    day: String,
    count: i64,
}

impl From<signal_restapi_error::Model> for SignalRestapiErrorRow {
    fn from(error: signal_restapi_error::Model) -> Self {
        SignalRestapiErrorRow {
            id: error.id,
            created_at: format_dt(error.created_at),
            response_text: error.res_txt,
            response_json: error
                .res
                .and_then(|value| serde_json::to_string_pretty(&value).ok()),
        }
    }
}

impl From<SignalRestapiErrorDayCountRow> for SignalRestapiErrorDayCount {
    fn from(row: SignalRestapiErrorDayCountRow) -> Self {
        SignalRestapiErrorDayCount {
            day: row.day,
            count: row.count,
        }
    }
}

pub async fn list_signal_restapi_errors(
    dbx: &DatabaseConnection,
    req: SignalRestapiErrorListReq,
) -> Result<Vec<SignalRestapiErrorRow>, AppError> {
    let (since, till) = parse_time_range(&req.since, &req.till, None)?;
    let limit = req
        .limit
        .unwrap_or(MAX_RESTAPI_ERROR_ROWS as i64)
        .clamp(1, MAX_RESTAPI_ERROR_ROWS as i64) as u64;

    Ok(signal_restapi_error::Entity::find()
        .filter(signal_restapi_error::Column::CreatedAt.gte(since))
        .filter(signal_restapi_error::Column::CreatedAt.lt(till))
        .order_by_desc(signal_restapi_error::Column::CreatedAt)
        .order_by_desc(signal_restapi_error::Column::Id)
        .limit(limit)
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(SignalRestapiErrorRow::from)
        .collect())
}

pub async fn count_signal_restapi_errors_by_day(
    dbx: &DatabaseConnection,
    req: SignalRestapiErrorCountsReq,
) -> Result<Vec<SignalRestapiErrorDayCount>, AppError> {
    let (since, till) = parse_time_range(
        &req.since,
        &req.till,
        Some(MAX_RESTAPI_ERROR_COUNT_DAYS),
    )?;
    let sql = format!(
        r#"
        select
            to_char(
                (((created_at at time zone 'UTC') at time zone '{APP_TIME_ZONE_SQL}')::date),
                'YYYY-MM-DD'
            ) as day,
            count(*)::bigint as count
        from signal_restapi_error
        where created_at >= $1 and created_at < $2
        group by 1
        order by 1
        "#
    );

    Ok(SignalRestapiErrorDayCountRow::find_by_statement(
        Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            &sql,
            [since.into(), till.into()],
        ),
    )
    .all(dbx)
    .await
    .c(h!())?
    .into_iter()
    .map(SignalRestapiErrorDayCount::from)
    .collect())
}

#[post("/api/admin/signal-restapi-error/list")]
pub async fn signal_restapi_error_list(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<SignalRestapiErrorListReq>,
) -> Result<Json<SignalRestapiErrorListRsp>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Admin")
        .await
        .c(h!())?;
    Ok(Json(SignalRestapiErrorListRsp {
        items: list_signal_restapi_errors(&env.dbx, req.into_inner()).await?,
    }))
}

#[post("/api/admin/signal-restapi-error/counts")]
pub async fn signal_restapi_error_counts(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<SignalRestapiErrorCountsReq>,
) -> Result<Json<SignalRestapiErrorCountsRsp>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Admin")
        .await
        .c(h!())?;
    Ok(Json(SignalRestapiErrorCountsRsp {
        items: count_signal_restapi_errors_by_day(&env.dbx, req.into_inner())
            .await?,
    }))
}

fn parse_time_range(
    since: &str,
    till: &str,
    max_days: Option<i64>,
) -> Result<(NaiveDateTime, NaiveDateTime), AppError> {
    let since = parse_utc_rfc3339(since, "since")?;
    let till = parse_utc_rfc3339(till, "till")?;

    if till <= since {
        return Err(AppError::BL {
            msg: "till must be after since".to_string(),
        });
    }

    if let Some(max_days) = max_days {
        if till - since > TimeDelta::days(max_days) {
            return Err(AppError::BL {
                msg: format!("range must be {max_days} days or less"),
            });
        }
    }

    Ok((since, till))
}

fn parse_utc_rfc3339(
    value: &str,
    field_name: &str,
) -> Result<NaiveDateTime, AppError> {
    DateTime::parse_from_rfc3339(value)
        .map(|dt| dt.with_timezone(&Utc).naive_utc())
        .map_err(|_| AppError::BL {
            msg: format!("{field_name} must be RFC3339 datetime"),
        })
}

fn format_dt(dt: NaiveDateTime) -> String {
    dt.and_utc().to_rfc3339()
}
