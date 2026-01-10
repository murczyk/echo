use crate::delta::{bgtask_log, finish_bgtask};
use crate::entities::{bgtask, bgtask_res};
use crate::error::AppError;
use crate::h;
use crate::types::{Env, ShortContext};
use actix_multipart::Multipart;
use actix_web::get;
use actix_web::web::Json;
use bytes::Bytes;
use futures_util::StreamExt;
use reqwest::header::CONTENT_TYPE;
use reqwest::multipart::{Form, Part};
use sea_orm::ActiveModelTrait;
use sea_orm::ActiveValue::{NotSet, Set};
use std::path::Path;

struct UploadData {
    hide_titles: bool,
    file_bytes: Vec<u8>,
    field_name: Option<String>,
    file_name: Option<String>,
    content_type: Option<String>,
}

struct ConversionResult {
    body: Bytes,
    content_type: Option<String>,
    name: Option<String>,
}

#[get("/api/alpine/convert")]
async fn convert_alpinequest_file(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    mut payload: Multipart,
) -> Result<Json<i64>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .c(h!())?;
    let converter_url = env.config.alpine_converter_url.clone().c(h!())?;
    let upload = read_payload(&mut payload).await.c(h!())?;

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
    tokio::spawn(async move {
        let dbx = env_inner.dbx.clone();
        let res = async {
            bgtask_log(Some(bgtask_id), "> starting alpine conversion", &dbx)
                .await
                .c(h!())?;
            let result = call_converter(&env_inner, &converter_url, &upload)
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

async fn read_payload(payload: &mut Multipart) -> Result<UploadData, AppError> {
    let mut data = UploadData {
        hide_titles: false,
        file_bytes: vec![],
        field_name: None,
        file_name: None,
        content_type: None,
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

async fn call_converter(
    env: &Env,
    converter_url: &str,
    upload: &UploadData,
) -> anyhow::Result<ConversionResult> {
    let field_name = upload
        .field_name
        .clone()
        .unwrap_or_else(|| "file".to_string());
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
        .part(field_name, part);
    let host = converter_url.trim_end_matches('/');
    let url = format!("{host}/api/upload-task");
    let resp = env.rq.post(&url).multipart(form).send().await.c(h!())?;
    let status = resp.status();
    if !status.is_success() {
        anyhow::bail!("converter error: status {status}");
    }
    let content_type = resp
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_string());
    let body = resp.bytes().await.c(h!())?;

    if content_type
        .as_deref()
        .is_some_and(|ct| ct.starts_with("application/json"))
    {
        let download_path: String =
            serde_json::from_slice(&body).map_err(|e| AppError::BL {
                msg: format!("invalid converter response: {e}"),
            })?;
        let download_url = if download_path.starts_with("http") {
            download_path.clone()
        } else {
            format!(
                "{}/{}",
                converter_url.trim_end_matches('/'),
                download_path.trim_start_matches('/')
            )
        };
        let download_resp = env.rq.get(&download_url).send().await.c(h!())?;
        if !download_resp.status().is_success() {
            anyhow::bail!(
                "failed to download converted file: {}",
                download_resp.status()
            );
        }
        let download_ct = download_resp
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|v| v.to_string());
        let download_body = download_resp.bytes().await.c(h!())?;
        let download_name = Path::new(&download_url)
            .file_name()
            .and_then(|v| v.to_str())
            .map(|v| v.to_string())
            .or_else(|| upload.file_name.clone());
        return Ok(ConversionResult {
            body: download_body,
            content_type: download_ct,
            name: download_name,
        });
    }

    let name = upload.file_name.clone();
    Ok(ConversionResult {
        body,
        content_type,
        name,
    })
}
