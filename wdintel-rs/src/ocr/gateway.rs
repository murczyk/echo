use actix_multipart::Multipart;
use actix_web::{post, web, HttpResponse};
use base64::Engine;
use chrono::Utc;
use futures_util::StreamExt;
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
    mut payload: Multipart,
) -> Result<HttpResponse, AppError> {
    let mut grant = None;
    let mut request = AiEngineOcrRequest {
        request_id: String::new(),
        page_id: String::new(),
        unit_id: String::new(),
        prompt_version: String::new(),
        retry: false,
        image_png: Vec::new(),
    };
    while let Some(field) = payload.next().await {
        let mut field = field.map_err(|error| AppError::BL {
            msg: format!("OCR gateway multipart error: {error}"),
        })?;
        let name = field.name().unwrap_or_default().to_string();
        let mut bytes = Vec::new();
        while let Some(chunk) = field.next().await {
            let chunk = chunk.map_err(|error| AppError::BL {
                msg: format!("OCR gateway multipart error: {error}"),
            })?;
            if bytes.len().saturating_add(chunk.len()) > MAX_IMAGE_BYTES {
                return Err(AppError::BL {
                    msg: "OCR crop exceeds the gateway size limit".to_string(),
                });
            }
            bytes.extend_from_slice(&chunk);
        }
        match name.as_str() {
            "grant" => {
                grant = Some(
                    String::from_utf8(bytes).map_err(|_| invalid_grant())?,
                )
            }
            "request_id" => {
                request.request_id = String::from_utf8(bytes).c(h!())?
            }
            "page_id" => request.page_id = String::from_utf8(bytes).c(h!())?,
            "unit_id" => request.unit_id = String::from_utf8(bytes).c(h!())?,
            "prompt_version" => {
                request.prompt_version = String::from_utf8(bytes).c(h!())?
            }
            "retry" => request.retry = bytes == b"true",
            "image" => request.image_png = bytes,
            _ => {}
        }
    }
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
}
