use super::types::{
    EtalonkaJimForksReq, EtalonkaNetworkBatchReq, EtalonkaReportType,
};
use super::{generate_networks_docx_report_to_path, EtalonkaData};
use crate::entities::prelude::*;
#[cfg(test)]
use crate::entities::{bgtask, bgtask_res};
use crate::error::AppError;
use crate::h;
use crate::types::Env;
use crate::types::ShortContext;
use actix_identity::Identity;
use actix_web::http::header;
use actix_web::web::Json;
use actix_web::{post, HttpRequest, HttpResponse};
#[cfg(test)]
use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::EntityTrait;
#[cfg(test)]
use sea_orm::{ActiveModelTrait, DatabaseConnection};
use serde::{Deserialize, Serialize};
use tempfile::NamedTempFile;

pub(crate) const DOCX_CONTENT_TYPE: &str =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct EtalonkaReportTaskResultMeta {
    filename: String,
    content_type: String,
    user_login: String,
}

#[cfg(test)]
async fn create_running_bgtask(
    dbx: &DatabaseConnection,
) -> Result<bgtask::Model, AppError> {
    let bgtask = bgtask::ActiveModel {
        id: NotSet,
        progress: Set(0),
        loglines: Set(serde_json::json!([])),
        running: Set(true),
        finished_with_error: Set(None),
    }
    .insert(dbx)
    .await
    .c(h!())?;
    Ok(bgtask)
}

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

#[cfg(test)]
async fn store_report_result_bytes(
    env: &Env,
    bgtask_id: i64,
    meta: &EtalonkaReportTaskResultMeta,
    bytes: Vec<u8>,
) -> Result<(), AppError> {
    let result = bgtask_res::ActiveModel {
        id: Set(bgtask_id),
        res_json: Set(Some(serde_json::to_value(meta).c(h!())?)),
        res_bytes: Set(Some(bytes)),
        res_s3_id: Set(None),
    };
    result.insert(&env.dbx).await.c(h!())?;
    Ok(())
}

fn make_download_response(
    filename: String,
    content_type: String,
    bytes: Vec<u8>,
) -> HttpResponse {
    let cd = header::ContentDisposition {
        disposition: header::DispositionType::Attachment,
        parameters: vec![header::DispositionParam::FilenameExt(
            header::ExtendedValue {
                charset: header::Charset::Ext("UTF-8".into()),
                language_tag: None,
                value: filename.into_bytes(),
            },
        )],
    };

    HttpResponse::Ok()
        .insert_header((header::CONTENT_TYPE, content_type))
        .insert_header(cd)
        .body(bytes)
}

fn parse_report_meta(
    res_json: serde_json::Value,
) -> Result<EtalonkaReportTaskResultMeta, AppError> {
    Ok(serde_json::from_value(res_json).c(h!())?)
}

async fn load_report_task_result(
    env: &Env,
    bgtask_id: i64,
    user_login: &str,
) -> Result<(EtalonkaReportTaskResultMeta, Vec<u8>), AppError> {
    let bgtask_res = BgtaskRes::find_by_id(bgtask_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(format!("Result not found for task id: {bgtask_id}"))?;
    let res_json = bgtask_res.res_json.clone().ok_or(format!(
        "res_json must be non empty for task id: {bgtask_id}"
    ))?;
    let meta = parse_report_meta(res_json)?;
    if meta.user_login != user_login {
        return Err(AppError::Forbidden(
            "Task result belongs to another user".to_string(),
        ));
    }
    let bytes = bgtask_res.res_bytes.clone().ok_or(format!(
        "res_bytes must be non empty for task id: {bgtask_id}"
    ))?;
    Ok((meta, bytes))
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EtalonkaReportTaskDownloadReq {
    pub bgtask_id: i64,
}

#[post("/api/sigint/etalonka/report-networks-task-download")]
pub async fn report_networks_task_download(
    user: Identity,
    env: actix_web::web::Data<Env>,
    _http_req: HttpRequest,
    req: Json<EtalonkaReportTaskDownloadReq>,
) -> Result<HttpResponse, AppError> {
    let user_login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &user_login, "Rer")
        .await
        .c(h!())?;
    let (meta, bytes) =
        load_report_task_result(env.as_ref(), req.bgtask_id, &user_login)
            .await?;
    // Clear stored bytes after download to avoid unbounded DB growth.
    let result_row = bgtask_res::ActiveModel {
        id: Set(req.bgtask_id),
        res_json: NotSet,
        res_bytes: Set(None),
        res_s3_id: NotSet,
    };
    result_row.update(&env.dbx).await.c(h!())?;

    Ok(make_download_response(meta.filename, meta.content_type, bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::delta::finish_bgtask;
    use crate::entities::{bgtask, bgtask_res};
    use crate::functest::tests::cleanup;
    use sea_orm::ActiveModelTrait;
    use sea_orm::ActiveValue::Set;
    use sea_orm::EntityTrait;
    use serial_test::serial;

    #[serial]
    #[tokio::test]
    async fn create_running_bgtask_marks_task_as_running() {
        let env = cleanup().await.unwrap();

        let bgtask = create_running_bgtask(&env.dbx).await.unwrap();
        assert!(bgtask.running);
        assert_eq!(bgtask.progress, 0);
        assert!(bgtask.finished_with_error.is_none());

        let stored = bgtask::Entity::find_by_id(bgtask.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .expect("expected stored bgtask");
        assert!(stored.running);
        assert_eq!(stored.progress, 0);
    }

    #[serial]
    #[tokio::test]
    async fn store_and_load_report_result_roundtrips_bytes() {
        let env = cleanup().await.unwrap();
        let bgtask = create_running_bgtask(&env.dbx).await.unwrap();
        let meta = EtalonkaReportTaskResultMeta {
            filename: "etalonka_networks_1.docx".to_string(),
            content_type: DOCX_CONTENT_TYPE.to_string(),
            user_login: "user-1".to_string(),
        };

        store_report_result_bytes(&env, bgtask.id, &meta, vec![1, 2, 3, 4])
            .await
            .unwrap();

        let (loaded_meta, loaded_bytes) =
            load_report_task_result(&env, bgtask.id, "user-1")
                .await
                .unwrap();
        assert_eq!(loaded_meta.filename, meta.filename);
        assert_eq!(loaded_meta.content_type, meta.content_type);
        assert_eq!(loaded_meta.user_login, meta.user_login);
        assert_eq!(loaded_bytes, vec![1, 2, 3, 4]);
    }

    #[serial]
    #[tokio::test]
    async fn finish_bgtask_marks_task_as_failed() {
        let env = cleanup().await.unwrap();
        let bgtask = create_running_bgtask(&env.dbx).await.unwrap();
        let result: Result<(), AppError> = Err(AppError::BL {
            msg: "boom".to_string(),
        });

        finish_bgtask(Some(bgtask.id), &env.dbx, &result)
            .await
            .unwrap();

        let stored = bgtask::Entity::find_by_id(bgtask.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .expect("expected stored bgtask");
        assert!(!stored.running);
        assert!(stored.finished_with_error.is_some());
        assert!(stored.finished_with_error.unwrap().contains("boom"));
    }

    #[serial]
    #[tokio::test]
    async fn download_result_requires_stored_bytes() {
        let env = cleanup().await.unwrap();
        let bgtask = create_running_bgtask(&env.dbx).await.unwrap();
        let result_row = bgtask_res::ActiveModel {
            id: Set(bgtask.id),
            res_json: Set(Some(
                serde_json::to_value(EtalonkaReportTaskResultMeta {
                    filename: "etalonka_networks_1.docx".to_string(),
                    content_type: DOCX_CONTENT_TYPE.to_string(),
                    user_login: "user-1".to_string(),
                })
                .unwrap(),
            )),
            res_bytes: Set(Some(vec![5, 6, 7])),
            res_s3_id: Set(None),
        };
        result_row.insert(&env.dbx).await.unwrap();

        let (meta, bytes) = load_report_task_result(&env, bgtask.id, "user-1")
            .await
            .unwrap();
        assert_eq!(meta.filename, "etalonka_networks_1.docx");
        assert_eq!(bytes, vec![5, 6, 7]);
    }

    #[serial]
    #[tokio::test]
    async fn download_result_for_other_user_is_forbidden() {
        let env = cleanup().await.unwrap();
        let bgtask = create_running_bgtask(&env.dbx).await.unwrap();
        let result_row = bgtask_res::ActiveModel {
            id: Set(bgtask.id),
            res_json: Set(Some(
                serde_json::to_value(EtalonkaReportTaskResultMeta {
                    filename: "etalonka_networks_1.docx".to_string(),
                    content_type: DOCX_CONTENT_TYPE.to_string(),
                    user_login: "owner-user".to_string(),
                })
                .unwrap(),
            )),
            res_bytes: Set(Some(vec![5, 6, 7])),
            res_s3_id: Set(None),
        };
        result_row.insert(&env.dbx).await.unwrap();

        let err = load_report_task_result(&env, bgtask.id, "other-user")
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Forbidden(_)));
    }
}
