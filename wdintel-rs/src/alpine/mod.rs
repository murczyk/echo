use crate::delta::{bgtask_log, finish_bgtask};
use crate::entities::{bgtask, bgtask_res};
use crate::error::AppError;
use crate::h;
use crate::types::{Deserialize, Env, Serialize, ShortContext};
use actix_multipart::Multipart;
use actix_web::http::header;
use actix_web::post;
use actix_web::web::Json;
use actix_web::HttpResponse;
use bytes::Bytes;
use elm_rs::{Elm, ElmDecode, ElmEncode};
use futures_util::StreamExt;
use log::info;
use reqwest::header::CONTENT_TYPE;
use reqwest::multipart::{Form, Part};
use sea_orm::ActiveModelTrait;
use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::EntityTrait;
use std::time::Duration;

#[derive(Debug)]
struct UploadData {
    hide_titles: bool,
    file_bytes: Vec<u8>,
    field_name: Option<String>,
    file_name: Option<String>,
    content_type: Option<String>,
    output_format: String,
}

struct ConversionResult {
    body: Bytes,
    content_type: Option<String>,
    name: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TaskStatusRsp {
    pub statuses: Vec<TaskStatus>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TaskStatus {
    pub receipt: String,
    pub started: bool,
    pub completed: bool,
    pub is_ok: Option<bool>,
    pub geolocation_description: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TaskStatusReq {
    pub receipts: Vec<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct AlpineDownloadResultReq {
    pub bgtask_id: i64,
}

#[post("/api/alpine/convert")]
async fn convert_alpinequest_file(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    mut payload: Multipart,
) -> Result<Json<i64>, AppError> {
    info!("convert_alpinequest_file started");
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .c(h!())?;
    let converter_url = env.config.alpine_converter_url.clone().c(h!())?;
    let upload = read_payload(&mut payload).await.c(h!())?;

    info!("convert_alpinequest_file uploading data: {upload:?}");
    let loglines: Vec<String> = vec![];
    let bgtask = bgtask::ActiveModel {
        id: NotSet,
        progress: Set(0),
        loglines: Set(serde_json::to_value(loglines).c(h!())?),
        running: Set(true),
        finished_with_error: Set(None),
    }
    .insert(&env.dbx)
    .await
    .c(h!())?;

    let bgtask_id = bgtask.id;
    let env_inner = env.get_ref().clone();
    info!("convert_alpinequest_file starting alpine conversion");
    tokio::spawn(async move {
        let dbx = env_inner.dbx.clone();
        let res = async {
            bgtask_log(Some(bgtask_id), "> starting alpine conversion", &dbx)
                .await
                .c(h!())?;
            let result = convert_file(&env_inner, &converter_url, &upload)
                .await
                .map_err(|e| AppError::AnyhowError { source: e })?;
            bgtask_log(
                Some(bgtask_id),
                "> converter finished, uploading",
                &dbx,
            )
            .await
            .c(h!())?;
            let res_s3_id = crate::messenger::media::store_asset(
                &env_inner,
                &result.body,
                result.name.as_deref(),
                result.content_type.as_deref(),
            )
            .await
            .c(h!())?;
            bgtask_log(
                Some(bgtask_id),
                &format!("> uploaded result: {res_s3_id}"),
                &dbx,
            )
            .await
            .c(h!())?;
            let res_row = bgtask_res::ActiveModel {
                id: Set(bgtask_id),
                res_json: Set(None),
                res_bytes: Set(None),
                res_s3_id: Set(Some(res_s3_id)),
            };
            res_row.insert(&dbx).await.c(h!())?;
            bgtask_log(Some(bgtask_id), "> saved bgtask result", &dbx)
                .await
                .c(h!())?;
            Ok::<(), AppError>(())
        };
        let res = res.await;
        if let Err(ref e) = res {
            println!("> alpine conversion failed: {e:?}");
        }
        let _ = finish_bgtask(Some(bgtask_id), &dbx, &res).await;
    });

    Ok(Json(bgtask_id))
}

#[post("/api/alpine/download-result")]
async fn download_alpine_result(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AlpineDownloadResultReq>,
) -> Result<HttpResponse, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
    let res = bgtask_res::Entity::find_by_id(req.bgtask_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(format!("Result not found for task id: {}", req.bgtask_id))?;
    let res_s3_id = res.res_s3_id.clone().ok_or(format!(
        "res_s3_id must be non empty for task id: {}",
        req.bgtask_id
    ))?;
    let res_bytes = crate::messenger::media::fetch_media_bytes_by_key(
        env.as_ref(),
        &res_s3_id,
    )
    .await
    .c(h!())?;
    let filename = format!("alpinequest-{}.kmz", req.bgtask_id);
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
    Ok(HttpResponse::Ok()
        .insert_header((header::CONTENT_TYPE, crate::config::KMZ_CONTENT_TYPE))
        .insert_header(cd)
        .body(res_bytes))
}

async fn read_payload(payload: &mut Multipart) -> Result<UploadData, AppError> {
    let mut data = UploadData {
        hide_titles: false,
        file_bytes: vec![],
        field_name: None,
        file_name: None,
        content_type: None,
        output_format: "kmz".to_string(),
    };

    while let Some(item) = payload.next().await {
        let mut field = item.map_err(|e| -> AppError {
            format!("Multipart error: {e:?}").into()
        })?;
        let field_name = field.name().c(h!())?.to_string();
        if field_name == "hide_titles" {
            let mut value = Vec::new();
            while let Some(chunk) = field.next().await {
                value.extend(
                    chunk
                        .map_err(|e| -> AppError {
                            format!("Multipart error: {e:?}").into()
                        })?
                        .to_vec(),
                );
            }
            data.hide_titles = String::from_utf8(value)
                .ok()
                .map(|v| v == "1")
                .unwrap_or(false);
            continue;
        }

        if field_name == "output_format" {
            let mut value = Vec::new();
            while let Some(chunk) = field.next().await {
                value.extend(
                    chunk
                        .map_err(|e| -> AppError {
                            format!("Multipart error: {e:?}").into()
                        })?
                        .to_vec(),
                );
            }
            if let Ok(output_format) = String::from_utf8(value) {
                if !output_format.is_empty() {
                    data.output_format = output_format;
                }
            }
            continue;
        }

        let mut val_curr: Vec<u8> = vec![];
        while let Some(chunk) = field.next().await {
            val_curr.extend(
                chunk
                    .map_err(|e| -> AppError {
                        format!("Multipart error: {e:?}").into()
                    })?
                    .to_vec(),
            );
        }
        data.file_bytes = val_curr;
        data.field_name = Some(field_name.clone());
        data.file_name = field
            .content_disposition()
            .and_then(|cd| cd.get_filename().map(|v| v.to_string()))
            .or(Some(field_name));
        data.content_type = field.content_type().map(|ct| ct.to_string());
    }

    if data.file_bytes.is_empty() {
        return Err(AppError::BL {
            msg: "file is missing in multipart payload".to_string(),
        });
    }

    Ok(data)
}

async fn convert_file(
    env: &Env,
    converter_url: &str,
    upload: &UploadData,
) -> anyhow::Result<ConversionResult> {
    let mut part = Part::bytes(upload.file_bytes.clone());
    if let Some(fname) = upload.file_name.clone() {
        part = part.file_name(fname);
    }
    if let Some(ct) = upload.content_type.clone() {
        part = part.mime_str(&ct).map_err(|e| AppError::BL {
            msg: format!("invalid content type: {e}"),
        })?;
    }

    let form = Form::new()
        .text(
            "hide_titles",
            if upload.hide_titles {
                "1".to_string()
            } else {
                "0".to_string()
            },
        )
        .text("output_format", upload.output_format.clone())
        .part("src_file".to_string(), part);
    let host = converter_url.trim_end_matches('/');
    let resp = env
        .rq
        .post(format!("{host}/api/upload-task"))
        .timeout(Duration::from_secs(
            crate::config::RQ_TIMEOUT_ALPINE_CONVERTER,
        ))
        .multipart(form)
        .send()
        .await
        .c(h!())?;
    let status = resp.status();
    if !status.is_success() {
        anyhow::bail!("converter error: status {status}");
    }
    let response_text = resp.text().await.c(h!())?;
    let receipt = response_text.replace('"', "");
    info!(
        "✅ Upload successful, status: {status}, receipt: {receipt}. Waiting for conversion..."
    );

    wait_for_completion(env, &receipt, host).await.c(h!())?;
    let result = download_file(env, &receipt, host, &upload.output_format)
        .await
        .c(h!())?;
    info!("✅ Conversion successful, receipt: {receipt}");
    Ok(result)
}

async fn wait_for_completion(
    env: &Env,
    receipt: &str,
    host: &str,
) -> anyhow::Result<()> {
    loop {
        if let Ok(is_ok) = check_completion_status(env, receipt, host).await {
            if is_ok {
                return Ok(());
            } else {
                anyhow::bail!("failed to convert to KMZ")
            }
        };
        tokio::time::sleep(Duration::from_secs(10)).await;
    }
}

async fn check_completion_status(
    env: &Env,
    receipt: &str,
    host: &str,
) -> anyhow::Result<bool> {
    let body = TaskStatusReq {
        receipts: vec![receipt.to_string()],
    };
    let response = env
        .rq
        .post(format!("{host}/api/task-status-batch"))
        .timeout(Duration::from_secs(
            crate::config::RQ_TIMEOUT_ALPINE_CONVERTER,
        ))
        .json(&body)
        .send()
        .await
        .c(h!())?;
    if !response.status().is_success() {
        anyhow::bail!("Request failed with status: {}", response.status());
    }
    let rsp = response
        .json::<TaskStatusRsp>()
        .await
        .c(h!())?
        .statuses
        .into_iter()
        .next()
        .c(h!())?;

    if !rsp.completed {
        anyhow::bail!("Task {receipt} is not converted yet");
    }

    Ok(rsp.is_ok.unwrap_or_default())
}

async fn download_file(
    env: &Env,
    receipt: &str,
    host: &str,
    output_format: &str,
) -> anyhow::Result<ConversionResult> {
    let response = env
        .rq
        .get(format!("{host}/api/download-task/{receipt}"))
        .timeout(Duration::from_secs(
            crate::config::RQ_TIMEOUT_ALPINE_CONVERTER,
        ))
        .send()
        .await
        .c(h!())?;
    if !response.status().is_success() {
        anyhow::bail!("Request failed with status: {}", response.status());
    }
    let disposition_header = response
        .headers()
        .get(reqwest::header::CONTENT_DISPOSITION)
        .c("Content-Disposition header missing")?
        .to_str()?;
    let disposition =
        content_disposition::parse_content_disposition(disposition_header);
    let filename = disposition
        .filename()
        .map(|(stem, _)| format!("{stem}.{}", file_extension(output_format)))
        .unwrap_or_else(|| {
            format!("{receipt}.{}", file_extension(output_format))
        });

    let download_ct = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_string());
    let file_bytes = response.bytes().await.c(h!())?;
    info!(
        "result of converting #{receipt}: filename={filename} file_bytes={file_bytes:?}"
    );

    Ok(ConversionResult {
        body: file_bytes,
        content_type: download_ct,
        name: Some(filename),
    })
}

fn file_extension(output_format: &str) -> &'static str {
    match output_format {
        "cog" => "tif",
        "geotiff" => "tif",
        _ => "kmz",
    }
}
