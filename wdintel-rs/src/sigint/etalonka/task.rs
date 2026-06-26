use super::types::{
    EtalonkaJimForksReq, EtalonkaNetworkBatchReq, EtalonkaReportType,
};
use super::{generate_networks_docx_report_to_path, EtalonkaData};
use crate::error::AppError;
use crate::h;
use crate::types::Env;
use crate::types::ShortContext;
use actix_identity::Identity;
use actix_web::post;
use actix_web::web::Json;
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
    let user_login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &user_login, "Rer")
        .await
        .c(h!())?;
    let req = req.into_inner();
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
    let user_login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &user_login, "Rer")
        .await
        .c(h!())?;
    let req = req.into_inner();
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
