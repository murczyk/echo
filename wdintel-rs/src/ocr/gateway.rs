use actix_multipart::Multipart;
use actix_web::{post, web, HttpResponse};
use base64::Engine;
use chrono::Utc;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use uuid::Uuid;

use crate::ai_engine::{request_ocr_response, AiEngineOcrRequest};
use crate::entities::{ai_engine, ocr_job};
use crate::error::AppError;
use crate::h;
use crate::types::{Env, ShortContext};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};

type HmacSha256 = Hmac<Sha256>;

const GRANT_TTL_SECONDS: i64 = 15 * 60;
const MAX_IMAGE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OcrGatewayGrant {
    pub version: u8,
    pub media_id: Uuid,
    pub engine_id: Uuid,
    pub instance_id: String,
    pub generation: i64,
    pub expires_at: i64,
}

pub(crate) fn issue_grant(
    key: &str,
    media_id: Uuid,
    engine_id: Uuid,
    instance_id: &str,
    generation: i64,
) -> anyhow::Result<String> {
    let grant = OcrGatewayGrant {
        version: 1,
        media_id,
        engine_id,
        instance_id: instance_id.to_string(),
        generation,
        expires_at: Utc::now().timestamp() + GRANT_TTL_SECONDS,
    };
    let payload = serde_json::to_vec(&grant).c(h!())?;
    let encoded =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&payload);
    let signature = sign(key, encoded.as_bytes());
    Ok(format!("{encoded}.{signature}"))
}

fn sign(key: &str, payload: &[u8]) -> String {
    let mut mac = HmacSha256::new_from_slice(key.as_bytes())
        .expect("HMAC accepts any key");
    mac.update(payload);
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(mac.finalize().into_bytes())
}

fn verify_grant(token: &str, key: &str) -> Result<OcrGatewayGrant, AppError> {
    let (payload, signature) =
        token.split_once('.').ok_or_else(invalid_grant)?;
    let expected = sign(key, payload.as_bytes());
    if !constant_time_equal(expected.as_bytes(), signature.as_bytes()) {
        return Err(invalid_grant());
    }
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| invalid_grant())?;
    let grant: OcrGatewayGrant =
        serde_json::from_slice(&payload).map_err(|_| invalid_grant())?;
    if grant.version != 1 || grant.expires_at <= Utc::now().timestamp() {
        return Err(invalid_grant());
    }
    Ok(grant)
}

fn constant_time_equal(first: &[u8], second: &[u8]) -> bool {
    first.len() == second.len()
        && first
            .iter()
            .zip(second)
            .fold(0_u8, |difference, (first, second)| {
                difference | (first ^ second)
            })
            == 0
}

fn invalid_grant() -> AppError {
    AppError::BL {
        msg: "Недійсний або прострочений OCR grant".to_string(),
    }
}

#[post("/internal/ocr/infer")]
pub async fn infer(
    env: web::Data<Env>,
    payload: Multipart,
) -> Result<HttpResponse, AppError> {
    let (grant, request) = parse_gateway_upload(payload).await?;
    let key = std::env::var(crate::config::OCR_GATEWAY_SIGNING_KEY_ENV)
        .map_err(|_| invalid_grant())?;
    let grant = verify_grant(grant.as_deref().unwrap_or_default(), &key)?;
    let expected_instance = env
        .config
        .ocr
        .as_ref()
        .map(|config| config.instance_id.trim())
        .unwrap_or_default();
    if grant.instance_id != expected_instance {
        return Err(invalid_grant());
    }
    if request.image_png.is_empty()
        || request.request_id.is_empty()
        || request.page_id.is_empty()
        || request.unit_id.is_empty()
    {
        return Err(AppError::BL {
            msg: "OCR gateway request is incomplete".to_string(),
        });
    }
    let job = ocr_job::Entity::find_by_id(grant.media_id)
        .filter(ocr_job::Column::AiEngineId.eq(grant.engine_id))
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or_else(invalid_grant)?;
    if job.discovered_at.and_utc().timestamp_micros() != grant.generation
        || !matches!(job.state.as_str(), "submitted" | "queued")
    {
        return Err(invalid_grant());
    }
    let ai_engine = ai_engine::Entity::find_by_id(grant.engine_id)
        .filter(ai_engine::Column::Enabled.eq(true))
        .filter(ai_engine::Column::OcrEnabled.eq(true))
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or_else(invalid_grant)?;
    let response = request_ocr_response(&ai_engine, request).await?;
    Ok(HttpResponse::Ok().json(response))
}

async fn parse_gateway_upload(
    mut payload: Multipart,
) -> Result<(Option<String>, AiEngineOcrRequest), AppError> {
    let mut grant = None;
    let mut request = AiEngineOcrRequest {
        request_id: String::new(),
        page_id: String::new(),
        unit_id: String::new(),
        prompt_version: String::new(),
        retry: false,
        image_png: Vec::new(),
    };
    let mut field_count = 0;
    let mut total_bytes: usize = 0;
    while let Some(field) = crate::utils::multipart::next(&mut payload).await? {
        field_count += 1;
        if field_count > crate::config::MULTIPART_MAX_FIELDS {
            return Err(AppError::BL {
                msg: "Too many OCR multipart fields".to_string(),
            });
        }
        let mut field = field.map_err(|error| AppError::BL {
            msg: format!("OCR gateway multipart error: {error}"),
        })?;
        let name = field.name().unwrap_or_default().to_string();
        let field_limit = if name == "image" {
            MAX_IMAGE_BYTES
        } else {
            crate::config::MULTIPART_TEXT_MAX_BYTES
        };
        let bytes = crate::utils::multipart::read_field_limited(
            &mut field,
            field_limit,
        )
        .await?;
        total_bytes = total_bytes.saturating_add(bytes.len());
        if total_bytes > crate::config::MULTIPART_MAX_BYTES {
            return Err(AppError::BL {
                msg: "OCR multipart exceeds the total size limit".to_string(),
            });
        }
        match name.as_str() {
            "grant" => {
                grant = Some(
                    String::from_utf8(bytes).map_err(|_| invalid_grant())?,
                )
            }
            "request_id" => {
                request.request_id = String::from_utf8(bytes)
                    .map_err(crate::utils::multipart::to_app_error)
                    .c(h!())?
            }
            "page_id" => {
                request.page_id = String::from_utf8(bytes)
                    .map_err(crate::utils::multipart::to_app_error)
                    .c(h!())?
            }
            "unit_id" => {
                request.unit_id = String::from_utf8(bytes)
                    .map_err(crate::utils::multipart::to_app_error)
                    .c(h!())?
            }
            "prompt_version" => {
                request.prompt_version = String::from_utf8(bytes)
                    .map_err(crate::utils::multipart::to_app_error)
                    .c(h!())?
            }
            "retry" => request.retry = bytes == b"true",
            "image" => request.image_png = bytes,
            _ => {}
        }
    }
    Ok((grant, request))
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "gateway-test-key-with-at-least-32-bytes";

    #[test]
    fn grant_round_trip_and_tamper_rejection() {
        let grant =
            issue_grant(KEY, Uuid::now_v7(), Uuid::now_v7(), "test", 42)
                .expect("grant should be issued");
        let verified = verify_grant(&grant, KEY).expect("grant should verify");
        assert_eq!(verified.instance_id, "test");
        assert!(verify_grant(&format!("{grant}x"), KEY).is_err());
    }

    #[test]
    fn expired_grant_is_rejected() {
        let grant = OcrGatewayGrant {
            version: 1,
            media_id: Uuid::now_v7(),
            engine_id: Uuid::now_v7(),
            instance_id: "test".to_string(),
            generation: 42,
            expires_at: Utc::now().timestamp() - 1,
        };
        let payload =
            serde_json::to_vec(&grant).expect("grant should serialize");
        let encoded =
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload);
        let token = format!("{encoded}.{}", sign(KEY, encoded.as_bytes()));
        assert!(verify_grant(&token, KEY).is_err());
    }
    #[actix_web::test]
    async fn gateway_upload_bounds_and_invalid_utf8_are_client_errors() {
        use actix_web::ResponseError;
        for (name, fields) in [
            ("invalid-utf8", vec![("request_id", vec![0xff])]),
            (
                "text-limit",
                vec![(
                    "prompt_version",
                    vec![b'x'; crate::config::MULTIPART_TEXT_MAX_BYTES + 1],
                )],
            ),
            (
                "image-limit",
                vec![("image", vec![b'x'; MAX_IMAGE_BYTES + 1])],
            ),
            (
                "field-count",
                vec![
                    ("unknown", vec![]);
                    crate::config::MULTIPART_MAX_FIELDS + 1
                ],
            ),
        ] {
            let mut body = Vec::new();
            for (field, value) in fields {
                body.extend_from_slice(format!("--gateway-test\r\nContent-Disposition: form-data; name=\"{field}\"\r\n\r\n").as_bytes());
                body.extend(value);
                body.extend_from_slice(b"\r\n");
            }
            body.extend_from_slice(b"--gateway-test--\r\n");
            let (request, payload) = actix_web::test::TestRequest::post()
                .insert_header((
                    "content-type",
                    "multipart/form-data; boundary=gateway-test",
                ))
                .set_payload(body)
                .to_http_parts();
            let error = parse_gateway_upload(Multipart::new(
                request.headers(),
                payload,
            ))
            .await
            .err()
            .unwrap();
            assert_eq!(
                error.error_response().status(),
                actix_web::http::StatusCode::BAD_REQUEST,
                "{name}"
            );
        }
    }
}
