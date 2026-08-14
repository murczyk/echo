use super::types::{
    EtalonkaJimForksReq, EtalonkaNetworkBatchReq, EtalonkaReportType,
};
use super::{
    generate_networks_docx_report_to_path, normalize_etalonka_report_period,
    EtalonkaData,
};
use crate::error::AppError;
use crate::h;
use crate::types::Env;
use crate::types::ShortContext;
use crate::users::ensure_rer_role;
use crate::users::login_id_from_identity;
use actix_identity::Identity;
use actix_web::post;
use actix_web::web::Json;
use anyhow::Context;
use tempfile::NamedTempFile;

pub(crate) const DOCX_CONTENT_TYPE: &str =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

pub(crate) async fn render_networks_docx_report_bytes(
    etalonka_type: &EtalonkaReportType,
    etalonka_data: EtalonkaData,
) -> Result<Vec<u8>, AppError> {
    let temp = NamedTempFile::new().c(h!())?;
    generate_networks_docx_report_to_path(
        temp.path(),
        etalonka_type,
        etalonka_data,
    )
    .await
    .c(h!())?;
    Ok(std::fs::read(temp.path()).c(h!())?)
}

#[post("/api/sigint/etalonka/report-networks-task-launch")]
pub async fn report_networks_task_launch(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<EtalonkaJimForksReq>,
) -> Result<Json<i64>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let user_login = login_id_from_identity(&user).context(h!())?;
    let mut req = req.into_inner();
    normalize_etalonka_report_period(
        &mut req.etalonka_type,
        chrono::Utc::now().timestamp_millis(),
    );
    let report_history = crate::report_history::enqueue_report(
        &env.dbx,
        &user_login,
        crate::report_history::KIND_ETALONKA,
        crate::report_history::ReportHistoryRequest::EtalonkaFilter {
            payload: Box::new(req),
        },
        None,
        Some(DOCX_CONTENT_TYPE.to_string()),
    )
    .await
    .c(h!())?;
    Ok(Json(report_history.id))
}

#[post("/api/sigint/etalonka/report-networks-batch-id-task-launch")]
pub async fn report_networks_batch_id_task_launch(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<EtalonkaNetworkBatchReq>,
) -> Result<Json<i64>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let user_login = login_id_from_identity(&user).context(h!())?;
    let mut req = req.into_inner();
    normalize_etalonka_report_period(
        &mut req.etalonka_type,
        chrono::Utc::now().timestamp_millis(),
    );
    let report_history = crate::report_history::enqueue_report(
        &env.dbx,
        &user_login,
        crate::report_history::KIND_ETALONKA,
        crate::report_history::ReportHistoryRequest::EtalonkaBatch {
            payload: Box::new(req),
        },
        None,
        Some(DOCX_CONTENT_TYPE.to_string()),
    )
    .await
    .c(h!())?;
    Ok(Json(report_history.id))
}
