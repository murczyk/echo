mod history;
mod observations;
pub mod types;

use crate::config::{KPI_MAX_PERIOD_DAYS, KPI_QUERY_TIMEOUT_MS};
use crate::error::AppError;
use crate::h;
use crate::types::{Env, ShortContext};
use actix_identity::Identity;
use actix_web::{post, web};
use chrono::{DateTime, Duration, NaiveDateTime, Utc};
use sea_orm::{
    AccessMode, ConnectionTrait, DatabaseTransaction, TransactionTrait,
};
use types::*;

pub fn configure(config: &mut web::ServiceConfig) {
    config
        .service(reports)
        .service(notifications)
        .service(activity)
        .service(requests);
}

impl KpiPeriod {
    fn validate(&self) -> Result<(), AppError> {
        self.bounds().map(|_| ()).map_err(|error| AppError::BL {
            msg: error.to_string(),
        })
    }

    fn bounds(&self) -> anyhow::Result<(NaiveDateTime, NaiveDateTime)> {
        let since = DateTime::from_timestamp_millis(self.since)
            .ok_or_else(|| anyhow::anyhow!("Invalid KPI period start"))
            .c(h!())?;
        let until = DateTime::from_timestamp_millis(self.until)
            .ok_or_else(|| anyhow::anyhow!("Invalid KPI period end"))
            .c(h!())?;
        anyhow::ensure!(since < until, "KPI period must be nonempty");
        anyhow::ensure!(
            until - since <= Duration::days(KPI_MAX_PERIOD_DAYS),
            "KPI period exceeds {KPI_MAX_PERIOD_DAYS} days"
        );
        anyhow::ensure!(
            until <= Utc::now(),
            "KPI period cannot end in the future"
        );
        Ok((since.naive_utc(), until.naive_utc()))
    }
}

async fn read_transaction(env: &Env) -> anyhow::Result<DatabaseTransaction> {
    let transaction = env
        .dbx
        .begin_with_config(None, Some(AccessMode::ReadOnly))
        .await
        .c(h!())?;
    transaction
        .execute_unprepared(&format!(
            "set local statement_timeout = '{KPI_QUERY_TIMEOUT_MS}ms'"
        ))
        .await
        .c(h!())?;
    Ok(transaction)
}

#[post("/api/kpi/reports")]
async fn reports(
    user: Identity,
    env: web::Data<Env>,
    period: web::Json<KpiPeriod>,
) -> Result<web::Json<KpiReportsRsp>, AppError> {
    crate::users::ensure_admin(&env.dbx, &user).await.c(h!())?;
    period.validate().c(h!())?;
    Ok(web::Json(history::reports(&env, &period).await.c(h!())?))
}

#[post("/api/kpi/notifications")]
async fn notifications(
    user: Identity,
    env: web::Data<Env>,
    period: web::Json<KpiPeriod>,
) -> Result<web::Json<KpiNotificationsRsp>, AppError> {
    crate::users::ensure_admin(&env.dbx, &user).await.c(h!())?;
    period.validate().c(h!())?;
    Ok(web::Json(
        history::notifications(&env, &period).await.c(h!())?,
    ))
}

#[post("/api/kpi/activity")]
async fn activity(
    user: Identity,
    env: web::Data<Env>,
    period: web::Json<KpiPeriod>,
) -> Result<web::Json<KpiActivityRsp>, AppError> {
    crate::users::ensure_admin(&env.dbx, &user).await.c(h!())?;
    period.validate().c(h!())?;
    Ok(web::Json(
        observations::activity(&env, &period).await.c(h!())?,
    ))
}

#[post("/api/kpi/requests")]
async fn requests(
    user: Identity,
    env: web::Data<Env>,
    period: web::Json<KpiPeriod>,
) -> Result<web::Json<KpiRequestsRsp>, AppError> {
    crate::users::ensure_admin(&env.dbx, &user).await.c(h!())?;
    period.validate().c(h!())?;
    Ok(web::Json(
        observations::requests(&env, &period).await.c(h!())?,
    ))
}

#[cfg(test)]
mod tests;
