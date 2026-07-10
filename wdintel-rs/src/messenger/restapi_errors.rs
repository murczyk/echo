use crate::error::AppError;
use crate::h;
use crate::types::{Env, ShortContext};
use actix_identity::Identity;
use actix_web::post;
use actix_web::web::Json;
use chrono::{DateTime, NaiveDateTime, TimeDelta, Utc};
use elm_rs::{Elm, ElmDecode, ElmEncode};
use sea_orm::{
    DatabaseBackend, DatabaseConnection, FromQueryResult, Statement,
};
use serde::{Deserialize, Serialize};

const MAX_RESTAPI_ERROR_ROWS: i64 = 1000;
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
    pub source: String,
    pub client_name: Option<String>,
    pub response_text: String,
    pub response_json: Option<String>,
    pub discord_sent_at: Option<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct SignalRestapiErrorLatestRsp {
    pub created_at: Option<String>,
}

#[derive(Debug, FromQueryResult)]
struct SignalRestapiErrorSqlRow {
    id: i64,
    created_at: NaiveDateTime,
    source: String,
    client_name: Option<String>,
    response_text: String,
    response_json: Option<String>,
    discord_sent_at: Option<NaiveDateTime>,
}

#[derive(Debug, FromQueryResult)]
struct SignalRestapiErrorDayCountRow {
    day: String,
    count: i64,
}

#[derive(Debug, FromQueryResult)]
struct SignalRestapiErrorLatestRow {
    created_at: NaiveDateTime,
}

impl From<SignalRestapiErrorSqlRow> for SignalRestapiErrorRow {
    fn from(error: SignalRestapiErrorSqlRow) -> Self {
        SignalRestapiErrorRow {
            id: error.id,
            created_at: format_dt(error.created_at),
            source: error.source,
            client_name: error.client_name,
            response_text: error.response_text,
            response_json: error.response_json,
            discord_sent_at: error.discord_sent_at.map(format_dt),
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
        .unwrap_or(MAX_RESTAPI_ERROR_ROWS)
        .clamp(1, MAX_RESTAPI_ERROR_ROWS);
    let sql = r#"
        select
            id::bigint as id,
            created_at,
            source::text as source,
            client_name,
            res_txt as response_text,
            case when res is null then null else jsonb_pretty(res) end as response_json,
            discord_sent_at
        from echo_restapi_error
        where created_at >= $1 and created_at < $2
        order by created_at desc, id desc
        limit $3
    "#;

    Ok(SignalRestapiErrorSqlRow::find_by_statement(
        Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            sql,
            vec![since.into(), till.into(), limit.into()],
        ),
    )
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
        from echo_restapi_error
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

pub async fn latest_signal_restapi_error_created_at(
    dbx: &DatabaseConnection,
) -> Result<Option<String>, AppError> {
    let sql = r#"
        select created_at
        from echo_restapi_error
        order by created_at desc, id desc
        limit 1
    "#;
    Ok(
        SignalRestapiErrorLatestRow::find_by_statement(Statement::from_string(
            DatabaseBackend::Postgres,
            sql.to_string(),
        ))
        .one(dbx)
        .await
        .c(h!())?
        .map(|row| format_dt(row.created_at)),
    )
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

#[post("/api/admin/signal-restapi-error/latest")]
pub async fn signal_restapi_error_latest(
    user: Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<SignalRestapiErrorLatestRsp>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Admin")
        .await
        .c(h!())?;
    Ok(Json(SignalRestapiErrorLatestRsp {
        created_at: latest_signal_restapi_error_created_at(&env.dbx).await?,
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
