use crate::delta::{bgtask_log, finish_bgtask};
use crate::entities::{bgtask, bgtask_res};
use crate::error::AppError;
use crate::h;
use crate::types::info;
use crate::types::{Deserialize, Env, Serialize, ShortContext};
use crate::users::ensure_rer_role;
use actix_multipart::Multipart;
use actix_web::http::header;
use actix_web::post;
use actix_web::web::Json;
use actix_web::HttpResponse;
use bytes::Bytes;
use elm_rs::{Elm, ElmDecode, ElmEncode};
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
    receipt: String,
}

pub struct AlpineConversionOutput {
    pub body: Bytes,
    pub name: Option<String>,
    pub receipt: String,
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
    admission: crate::utils::multipart_admission::MultipartAdmission,
) -> Result<Json<i64>, AppError> {
    info!("convert_alpinequest_file started");
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let upload = read_payload(&mut payload).await.c(h!())?;
    let converter_url = env.config.alpine_converter_url.clone().c(h!())?;

    info!(
        "convert_alpinequest_file uploading {} bytes",
        upload.file_bytes.len()
    );
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
        let _admission = admission;
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
                result.body,
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
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
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

    let mut total_bytes = 0;
    let mut field_count = 0;
    while let Some(item) =
        crate::utils::multipart::next(payload).await.c(h!())?
    {
        field_count += 1;
        if field_count > crate::config::MULTIPART_MAX_FIELDS {
            return Err(AppError::BL {
                msg: "Too many multipart fields".to_string(),
            });
        }
        let mut field = item
            .map_err(crate::utils::multipart::to_app_error)
            .c(h!())?;
        let field_name = field
            .name()
            .ok_or_else(|| AppError::BL {
                msg: "Multipart field has no name".to_string(),
            })
            .c(h!())?
            .to_string();
        let is_option =
            matches!(field_name.as_str(), "hide_titles" | "output_format");
        if !is_option && data.field_name.is_some() {
            return Err(AppError::BL {
                msg: "Only one uploaded file is supported".to_string(),
            });
        }
        let remaining_bytes = crate::config::MULTIPART_MAX_BYTES - total_bytes;
        let maximum_bytes = if is_option {
            remaining_bytes.min(crate::config::MULTIPART_TEXT_MAX_BYTES)
        } else {
            remaining_bytes
        };
        let value = crate::utils::multipart::read_field_limited(
            &mut field,
            maximum_bytes,
        )
        .await
        .c(h!())?;
        total_bytes += value.len();
        match field_name.as_str() {
            "hide_titles" => data.hide_titles = value == b"1",
            "output_format" => {
                if let Ok(output_format) = String::from_utf8(value) {
                    if !output_format.is_empty() {
                        data.output_format = output_format;
                    }
                }
            }
            _ => {
                data.file_bytes = value;
                data.field_name = Some(field_name.clone());
                data.file_name = field
                    .content_disposition()
                    .and_then(|disposition| {
                        disposition.get_filename().map(str::to_string)
                    })
                    .or(Some(field_name));
                data.content_type =
                    field.content_type().map(ToString::to_string);
            }
        }
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
    let timeout = env
        .config
        .alpine_conversion_timeout_seconds
        .unwrap_or(crate::config::ALPINE_CONVERSION_TIMEOUT_SECONDS);
    convert_file_with_deadline(
        &env.rq,
        converter_url,
        upload,
        timeout,
        Duration::from_secs(
            crate::config::ALPINE_CONVERSION_POLL_INTERVAL_SECONDS,
        ),
    )
    .await
    .c(h!())
}

async fn convert_file_with_deadline(
    client: &reqwest::Client,
    converter_url: &str,
    upload: &UploadData,
    timeout_seconds: u64,
    poll_interval: Duration,
) -> anyhow::Result<ConversionResult> {
    anyhow::ensure!(
        (1..=crate::config::ALPINE_CONVERSION_MAX_TIMEOUT_SECONDS)
            .contains(&timeout_seconds),
        "alpine_conversion_timeout_seconds must be between 1 and {}",
        crate::config::ALPINE_CONVERSION_MAX_TIMEOUT_SECONDS
    );
    tokio::time::timeout(
        Duration::from_secs(timeout_seconds),
        convert_file_inner(client, converter_url, upload, poll_interval),
    )
    .await
    .c("Alpine conversion exceeded its overall deadline")
    .c(h!())?
    .c(h!())
}

async fn convert_file_inner(
    client: &reqwest::Client,
    converter_url: &str,
    upload: &UploadData,
    poll_interval: Duration,
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
    let resp = client
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

    wait_for_completion(client, &receipt, host, poll_interval)
        .await
        .c(h!())?;
    let mut result =
        download_file(client, &receipt, host, &upload.output_format)
            .await
            .c(h!())?;
    result.receipt = receipt.clone();
    info!("✅ Conversion successful, receipt: {receipt}");
    Ok(result)
}

pub async fn convert_bytes_to_kmz(
    env: &Env,
    file_bytes: Vec<u8>,
    file_name: Option<String>,
    content_type: Option<String>,
) -> anyhow::Result<AlpineConversionOutput> {
    let converter_url = env.config.alpine_converter_url.clone().c(h!())?;
    let upload = UploadData {
        hide_titles: false,
        file_bytes,
        field_name: Some("src_file".to_string()),
        file_name,
        content_type,
        output_format: "kmz".to_string(),
    };
    let result = convert_file(env, &converter_url, &upload).await.c(h!())?;
    Ok(AlpineConversionOutput {
        body: result.body,
        name: result.name,
        receipt: result.receipt,
    })
}

async fn wait_for_completion(
    client: &reqwest::Client,
    receipt: &str,
    host: &str,
    poll_interval: Duration,
) -> anyhow::Result<()> {
    let mut consecutive_failures = 0;
    loop {
        match check_completion_status(client, receipt, host)
            .await
            .c(h!())?
        {
            ConversionStatus::Completed => return Ok(()),
            ConversionStatus::Pending => consecutive_failures = 0,
            ConversionStatus::Retryable(error) => {
                consecutive_failures += 1;
                if consecutive_failures
                    >= crate::config::ALPINE_CONVERSION_MAX_CONSECUTIVE_POLL_FAILURES
                {
                    return Err(error).c("Alpine converter status remained unavailable");
                }
            }
        }
        tokio::time::sleep(poll_interval).await;
    }
}

enum ConversionStatus {
    Pending,
    Completed,
    Retryable(anyhow::Error),
}

async fn check_completion_status(
    client: &reqwest::Client,
    receipt: &str,
    host: &str,
) -> anyhow::Result<ConversionStatus> {
    let body = TaskStatusReq {
        receipts: vec![receipt.to_string()],
    };
    let response = client
        .post(format!("{host}/api/task-status-batch"))
        .timeout(Duration::from_secs(
            crate::config::ALPINE_CONVERSION_STATUS_TIMEOUT_SECONDS,
        ))
        .json(&body)
        .send()
        .await
        .c(h!());
    let response = match response {
        Ok(response) => response,
        Err(error) => return Ok(ConversionStatus::Retryable(error)),
    };
    let status = response.status();
    if status.is_server_error()
        || status == reqwest::StatusCode::TOO_MANY_REQUESTS
        || status == reqwest::StatusCode::REQUEST_TIMEOUT
    {
        return Ok(ConversionStatus::Retryable(anyhow::anyhow!(
            "Converter status request failed: {status}"
        )));
    }
    if !response.status().is_success() {
        anyhow::bail!("Request failed with status: {}", response.status());
    }
    let mut matching = response
        .json::<TaskStatusRsp>()
        .await
        .c(h!())?
        .statuses
        .into_iter()
        .filter(|status| status.receipt == receipt);
    let rsp = matching
        .next()
        .c("Converter response is missing the requested receipt")
        .c(h!())?;
    anyhow::ensure!(
        matching.next().is_none(),
        "Converter response contains duplicate statuses for the requested receipt"
    );

    if !rsp.completed {
        return Ok(ConversionStatus::Pending);
    }
    if !rsp.is_ok.unwrap_or_default() {
        anyhow::bail!("failed to convert to KMZ");
    }
    Ok(ConversionStatus::Completed)
}

async fn download_file(
    client: &reqwest::Client,
    receipt: &str,
    host: &str,
    output_format: &str,
) -> anyhow::Result<ConversionResult> {
    let response = client
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
        "Alpine conversion #{receipt} returned {} bytes",
        file_bytes.len()
    );

    Ok(ConversionResult {
        body: file_bytes,
        content_type: download_ct,
        name: Some(filename),
        receipt: String::new(),
    })
}

fn file_extension(output_format: &str) -> &'static str {
    match output_format {
        "cog" => "tif",
        "geotiff" => "tif",
        _ => "kmz",
    }
}

#[cfg(test)]
mod conversion_tests;

#[cfg(test)]
mod upload_regression_tests {
    use super::*;
    use actix_web::test::TestRequest;
    use actix_web::ResponseError;

    fn multipart(fields: &[(&str, &[u8])]) -> Multipart {
        let mut bytes = Vec::new();
        for (name, value) in fields {
            bytes.extend_from_slice(format!("--upload-test\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n").as_bytes());
            bytes.extend_from_slice(value);
            bytes.extend_from_slice(b"\r\n");
        }
        bytes.extend_from_slice(b"--upload-test--\r\n");
        let (request, payload) = TestRequest::post()
            .insert_header((
                "content-type",
                "multipart/form-data; boundary=upload-test",
            ))
            .set_payload(bytes)
            .to_http_parts();
        Multipart::new(request.headers(), payload)
    }

    #[actix_web::test]
    async fn converter_rejects_extra_files_and_oversized_metadata() {
        let oversized = vec![b'x'; crate::config::MULTIPART_TEXT_MAX_BYTES + 1];
        for fields in [
            vec![],
            vec![
                ("source", b"first".as_slice()),
                ("second", b"other".as_slice()),
            ],
            vec![
                ("hide_titles", oversized.as_slice()),
                ("source", b"file".as_slice()),
            ],
        ] {
            let error =
                read_payload(&mut multipart(&fields)).await.unwrap_err();
            assert_eq!(
                error.error_response().status(),
                actix_web::http::StatusCode::BAD_REQUEST
            );
        }
        let mut fields = vec![
            ("hide_titles", b"".as_slice());
            crate::config::MULTIPART_MAX_FIELDS
        ];
        fields.push(("source", b"file"));
        assert!(read_payload(&mut multipart(&fields)).await.is_err());
        fields.remove(0);
        let data = read_payload(&mut multipart(&fields)).await.unwrap();
        assert_eq!(data.file_bytes, b"file");
    }

    #[actix_web::test]
    async fn converter_preserves_file_and_options_at_text_limit() {
        let limit = vec![b'x'; crate::config::MULTIPART_TEXT_MAX_BYTES];
        let data = read_payload(&mut multipart(&[
            ("hide_titles", &limit),
            ("output_format", b"kml"),
            ("source", b"file"),
            ("hide_titles", b"1"),
        ]))
        .await
        .unwrap();
        assert_eq!(data.file_bytes, b"file");
        assert_eq!(data.output_format, "kml");
        assert!(data.hide_titles);
    }
}
