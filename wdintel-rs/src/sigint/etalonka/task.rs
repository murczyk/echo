use super::types::{
    EtalonkaJimForksReq, EtalonkaNetworkBatchReq, EtalonkaReportType,
};
use super::{
    bl_etalonka_report_networks_batch_id_data,
    bl_etalonka_report_networks_data, generate_networks_docx_report_to_path,
    EtalonkaData,
};
use crate::delta::{bgtask_log, finish_bgtask};
use crate::entities::{bgtask, bgtask_res, prelude::*};
use crate::error::AppError;
use crate::h;
use crate::rer_importer::reports::{
    cleanup_old_reports_nofail, save_report_log,
};
use crate::types::ShortContext;
use crate::types::{Env, Uuid};
use actix_identity::Identity;
use actix_web::http::header;
use actix_web::web::Json;
use actix_web::{post, HttpRequest, HttpResponse};
use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::{ActiveModelTrait, DatabaseConnection, EntityTrait};
use serde::{Deserialize, Serialize};
use tempfile::NamedTempFile;

const DOCX_CONTENT_TYPE: &str =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct EtalonkaReportTaskResultMeta {
    filename: String,
    content_type: String,
    user_login: String,
}

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

async fn render_networks_docx_report_bytes(
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

async fn launch_networks_report_task_go(
    env: actix_web::web::Data<Env>,
    user_login: String,
    trace_id: Uuid,
    req: EtalonkaJimForksReq,
    bgtask_id: i64,
) -> Result<(), AppError> {
    cleanup_old_reports_nofail(&env.dbx, &env.config).await;
    bgtask_log(Some(bgtask_id), "[1/5] Підготовка даних", &env.dbx)
        .await
        .c(h!())?;
    bgtask_log(Some(bgtask_id), "[2/5] Пошук мереж", &env.dbx)
        .await
        .c(h!())?;
    let etalonka_data =
        bl_etalonka_report_networks_data(&env.dbx, &user_login, &req, trace_id)
            .await
            .c(h!())?;
    bgtask_log(
        Some(bgtask_id),
        "[3/5] Формування еталонного опису",
        &env.dbx,
    )
    .await
    .c(h!())?;
    let bytes =
        render_networks_docx_report_bytes(&req.etalonka_type, etalonka_data)
            .await
            .c(h!())?;
    bgtask_log(Some(bgtask_id), "[4/5] Збереження результату", &env.dbx)
        .await
        .c(h!())?;
    let meta = EtalonkaReportTaskResultMeta {
        filename: format!("etalonka_networks_{}.docx", bgtask_id),
        content_type: DOCX_CONTENT_TYPE.to_string(),
        user_login: user_login.clone(),
    };
    store_report_result_bytes(env.as_ref(), bgtask_id, &meta, bytes)
        .await
        .c(h!())?;
    save_report_log(
        &env.dbx,
        format!("reports_log/{}", meta.filename),
        &serde_json::to_string(&req).c(h!())?,
        &user_login,
    )
    .await
    .c(h!())?;
    bgtask_log(Some(bgtask_id), "[5/5] Готово до завантаження", &env.dbx)
        .await
        .c(h!())?;
    Ok(())
}

async fn launch_networks_batch_report_task_go(
    env: actix_web::web::Data<Env>,
    user_login: String,
    trace_id: Uuid,
    req: EtalonkaNetworkBatchReq,
    bgtask_id: i64,
) -> Result<(), AppError> {
    cleanup_old_reports_nofail(&env.dbx, &env.config).await;
    bgtask_log(Some(bgtask_id), "[1/5] Підготовка даних", &env.dbx)
        .await
        .c(h!())?;
    bgtask_log(Some(bgtask_id), "[2/5] Пошук мереж", &env.dbx)
        .await
        .c(h!())?;
    let etalonka_data = bl_etalonka_report_networks_batch_id_data(
        &env.dbx,
        &user_login,
        &req,
        trace_id,
    )
    .await
    .c(h!())?;
    bgtask_log(
        Some(bgtask_id),
        "[3/5] Формування еталонного опису",
        &env.dbx,
    )
    .await
    .c(h!())?;
    let bytes =
        render_networks_docx_report_bytes(&req.etalonka_type, etalonka_data)
            .await
            .c(h!())?;
    bgtask_log(Some(bgtask_id), "[4/5] Збереження результату", &env.dbx)
        .await
        .c(h!())?;
    let meta = EtalonkaReportTaskResultMeta {
        filename: format!("etalonka_networks_{}.docx", bgtask_id),
        content_type: DOCX_CONTENT_TYPE.to_string(),
        user_login: user_login.clone(),
    };
    store_report_result_bytes(env.as_ref(), bgtask_id, &meta, bytes)
        .await
        .c(h!())?;
    save_report_log(
        &env.dbx,
        format!("reports_log/{}", meta.filename),
        &serde_json::to_string(&req).c(h!())?,
        &user_login,
    )
    .await
    .c(h!())?;
    bgtask_log(Some(bgtask_id), "[5/5] Готово до завантаження", &env.dbx)
        .await
        .c(h!())?;
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
    let bgtask = create_running_bgtask(&env.dbx).await?;
    let bgtask_id = bgtask.id;
    let env_spawn = env.clone();
    let dbx = env.dbx.clone();
    tokio::spawn(async move {
        let trace_id = Uuid::new_v4();
        let res = launch_networks_report_task_go(
            env_spawn, user_login, trace_id, req, bgtask_id,
        )
        .await;
        let _ = finish_bgtask(Some(bgtask_id), &dbx, &res).await;
    });
    Ok(Json(bgtask_id))
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
    let bgtask = create_running_bgtask(&env.dbx).await?;
    let bgtask_id = bgtask.id;
    let env_spawn = env.clone();
    let dbx = env.dbx.clone();
    tokio::spawn(async move {
        let trace_id = Uuid::new_v4();
        let res = launch_networks_batch_report_task_go(
            env_spawn, user_login, trace_id, req, bgtask_id,
        )
        .await;
        let _ = finish_bgtask(Some(bgtask_id), &dbx, &res).await;
    });
    Ok(Json(bgtask_id))
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
    Ok(make_download_response(
        meta.filename,
        meta.content_type,
        bytes,
    ))
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
