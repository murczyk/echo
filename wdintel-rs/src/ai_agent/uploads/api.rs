//! User-facing upload routes for the AI chat composer.

use super::{formats, image, store, types::*};
use crate::ai_agent::access;
use crate::config::{
    AI_AGENT_UPLOAD_MAX_BYTES, AI_AGENT_UPLOAD_MAX_DRAFTS,
    AI_AGENT_UPLOAD_MAX_PER_CONVERSATION,
};
use crate::entities::{ai_agent_conversation, ai_agent_upload};
use crate::error::AppError;
use crate::h;
use crate::types::{Env, ShortContext};
use actix_identity::Identity;
use actix_multipart::Multipart;
use actix_web::{
    get,
    http::header,
    post,
    web::{Data, Json, Path},
    HttpResponse,
};
use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, EntityTrait,
    PaginatorTrait, QueryFilter, QueryOrder, TransactionTrait,
};
use uuid::Uuid;

struct UploadForm {
    conversation_id: Option<Uuid>,
    file_name: String,
    supplied_content_type: Option<String>,
    bytes: Vec<u8>,
}

#[post("/api/ai-agent/uploads/create")]
pub async fn create_upload(
    env: Data<Env>,
    user: Identity,
    payload: Multipart,
) -> Result<Json<AiAgentUploadItem>, AppError> {
    let human = access::current_human_login(&env.dbx, &user, true)
        .await
        .c(h!())?;
    if env.s3.is_none() || env.s3_config.is_none() {
        return Err(AppError::BL {
            msg: "Сховище файлів не налаштоване".to_string(),
        });
    }
    let form = parse_form(payload).await.c(h!())?;
    if let Some(conversation_id) = form.conversation_id {
        owned_active_conversation(&env, human.id, conversation_id)
            .await
            .c(h!())?;
    }
    ensure_capacity(&env.dbx, human.id, form.conversation_id)
        .await
        .c(h!())?;
    let upload = store_upload(&env, human.id, form).await.c(h!())?;
    Ok(Json(store::item(&upload)))
}

#[post("/api/ai-agent/uploads/list")]
pub async fn list_uploads(
    env: Data<Env>,
    user: Identity,
    req: Json<AiAgentUploadListReq>,
) -> Result<Json<AiAgentUploadListRsp>, AppError> {
    let human = access::current_human_login(&env.dbx, &user, false)
        .await
        .c(h!())?;
    let mut query = ai_agent_upload::Entity::find()
        .filter(ai_agent_upload::Column::HumanLoginId.eq(human.id));
    if let Some(conversation_id) = &req.conversation_id {
        query = query.filter(
            ai_agent_upload::Column::ConversationId
                .eq(access::parse_uuid(conversation_id).c(h!())?),
        );
    } else if !req.ids.is_empty() {
        let ids = req
            .ids
            .iter()
            .take(AI_AGENT_UPLOAD_MAX_DRAFTS as usize)
            .map(|id| access::parse_uuid(id))
            .collect::<Result<Vec<_>, _>>()
            .c(h!())?;
        query = query.filter(ai_agent_upload::Column::Id.is_in(ids));
    } else {
        return Ok(Json(AiAgentUploadListRsp { uploads: vec![] }));
    }
    let uploads = query
        .order_by_asc(ai_agent_upload::Column::CreatedAt)
        .order_by_asc(ai_agent_upload::Column::Id)
        .all(&env.dbx)
        .await
        .c(h!())?;
    Ok(Json(AiAgentUploadListRsp {
        uploads: uploads.iter().map(store::item).collect(),
    }))
}

/// Removes an upload that has not been sent with a message yet.
#[post("/api/ai-agent/uploads/delete")]
pub async fn delete_upload(
    env: Data<Env>,
    user: Identity,
    req: Json<AiAgentUploadIdReq>,
) -> Result<Json<()>, AppError> {
    let human = access::current_human_login(&env.dbx, &user, false)
        .await
        .c(h!())?;
    let upload =
        store::owned(&env.dbx, human.id, access::parse_uuid(&req.id).c(h!())?)
            .await
            .c(h!())?;
    if upload.request_id.is_some() {
        return Err(AppError::BL {
            msg: "Надісланий файл можна видалити лише разом із розмовою"
                .to_string(),
        });
    }
    if !store::delete_draft(&env, &upload).await.c(h!())? {
        return Err(AppError::BL {
            msg: "Надісланий файл можна видалити лише разом із розмовою"
                .to_string(),
        });
    }
    Ok(Json(()))
}

#[get("/api/ai-agent/uploads/{id}/original")]
pub async fn download_upload(
    env: Data<Env>,
    user: Identity,
    path: Path<String>,
) -> Result<HttpResponse, AppError> {
    let human = access::current_human_login(&env.dbx, &user, false)
        .await
        .c(h!())?;
    let upload =
        store::owned(&env.dbx, human.id, access::parse_uuid(&path).c(h!())?)
            .await
            .c(h!())?;
    if let Some(conversation_id) = upload.conversation_id {
        owned_active_conversation(&env, human.id, conversation_id)
            .await
            .c(h!())?;
    }
    let bytes = crate::messenger::media::fetch_media_bytes_by_key(
        &env,
        &upload.storage_key,
    )
    .await
    .c(h!())?;
    Ok(original_response(&upload, bytes))
}

/// Only rasters and PDFs render inline; everything else downloads as an
/// opaque attachment so user-supplied HTML never executes on our origin.
fn original_response(
    upload: &ai_agent_upload::Model,
    bytes: Vec<u8>,
) -> HttpResponse {
    let inline_type = match upload.extension.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "pdf" => Some("application/pdf"),
        _ => None,
    };
    let mut disposition = crate::utils::multipart::download_content_disposition(
        upload.file_name.clone(),
    );
    disposition.disposition = if inline_type.is_some() {
        header::DispositionType::Inline
    } else {
        header::DispositionType::Attachment
    };
    HttpResponse::Ok()
        .insert_header((
            header::CONTENT_TYPE,
            inline_type.unwrap_or("application/octet-stream"),
        ))
        .insert_header(disposition)
        .insert_header((header::CACHE_CONTROL, "private, no-store"))
        .insert_header(("X-Content-Type-Options", "nosniff"))
        .insert_header(("Content-Security-Policy", "sandbox"))
        .body(bytes)
}

async fn owned_active_conversation(
    env: &Env,
    human_login_id: Uuid,
    conversation_id: Uuid,
) -> Result<ai_agent_conversation::Model, AppError> {
    ai_agent_conversation::Entity::find_by_id(conversation_id)
        .filter(ai_agent_conversation::Column::HumanLoginId.eq(human_login_id))
        .filter(ai_agent_conversation::Column::DeletedAt.is_null())
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
}

/// Early rejection before storing objects; `insert_row` repeats the check
/// under the owner's upload lock, which is authoritative for concurrent uploads.
async fn ensure_capacity<C: sea_orm::ConnectionTrait>(
    db: &C,
    human_login_id: Uuid,
    conversation_id: Option<Uuid>,
) -> Result<(), AppError> {
    let drafts = ai_agent_upload::Entity::find()
        .filter(ai_agent_upload::Column::HumanLoginId.eq(human_login_id))
        .filter(ai_agent_upload::Column::RequestId.is_null())
        .count(db)
        .await
        .c(h!())?;
    if drafts >= AI_AGENT_UPLOAD_MAX_DRAFTS {
        return Err(AppError::BL {
            msg: format!(
                "Забагато ненадісланих файлів (максимум {AI_AGENT_UPLOAD_MAX_DRAFTS})"
            ),
        });
    }
    if let Some(conversation_id) = conversation_id {
        let total = ai_agent_upload::Entity::find()
            .filter(ai_agent_upload::Column::ConversationId.eq(conversation_id))
            .count(db)
            .await
            .c(h!())?;
        if total >= AI_AGENT_UPLOAD_MAX_PER_CONVERSATION {
            return Err(AppError::BL {
                msg: format!(
                    "У розмові вже максимальна кількість файлів ({AI_AGENT_UPLOAD_MAX_PER_CONVERSATION})"
                ),
            });
        }
    }
    Ok(())
}

async fn parse_form(mut payload: Multipart) -> Result<UploadForm, AppError> {
    let mut conversation_id = None;
    let mut file = None;
    while let Some(item) =
        crate::utils::multipart::next(&mut payload).await.c(h!())?
    {
        let mut field = item
            .map_err(crate::utils::multipart::to_app_error)
            .c(h!())?;
        match field.name().unwrap_or_default() {
            "conversationId" => {
                let value =
                    crate::utils::multipart::read_field_limited(&mut field, 64)
                        .await
                        .c(h!())?;
                let value = String::from_utf8(value)
                    .map_err(|_| AppError::BL {
                        msg: "Некоректний ідентифікатор".to_string(),
                    })
                    .c(h!())?;
                if !value.trim().is_empty() {
                    conversation_id =
                        Some(access::parse_uuid(value.trim()).c(h!())?);
                }
            }
            "file" if file.is_none() => {
                let raw_name = field
                    .content_disposition()
                    .and_then(|disposition| disposition.get_filename())
                    .unwrap_or("upload")
                    .to_string();
                let supplied_content_type =
                    field.content_type().map(ToString::to_string);
                let bytes = crate::utils::multipart::read_field_limited(
                    &mut field,
                    AI_AGENT_UPLOAD_MAX_BYTES,
                )
                .await
                .c(h!())?;
                file = Some((raw_name, supplied_content_type, bytes));
            }
            name => {
                return Err(AppError::BL {
                    msg: format!("Unexpected multipart field: {name}"),
                })
            }
        }
    }
    let (raw_name, supplied_content_type, bytes) = file
        .ok_or_else(|| AppError::BL {
            msg: "Файл не надіслано".to_string(),
        })
        .c(h!())?;
    if bytes.is_empty() {
        return Err(AppError::BL {
            msg: "Файл порожній".to_string(),
        });
    }
    Ok(UploadForm {
        conversation_id,
        file_name: crate::sigint::unit::attachment::sanitize_file_name(
            &raw_name,
        )
        .c(h!())?,
        supplied_content_type,
        bytes,
    })
}

async fn store_upload(
    env: &Env,
    human_login_id: Uuid,
    form: UploadForm,
) -> Result<ai_agent_upload::Model, AppError> {
    let extension = formats::extension(&form.file_name);
    if formats::extraction(&extension).is_none() {
        return Err(AppError::BL {
            msg: format!(
                "Непідтримуваний формат файлу. Підтримуються: {}",
                formats::accepted_extensions().join(", ")
            ),
        });
    }
    formats::validate_content(&extension, &form.bytes).c(h!())?;
    let preview = preview(&extension, &form.bytes).await.c(h!())?;
    let content_type = crate::sigint::unit::attachment::normalize_content_type(
        form.supplied_content_type.as_deref(),
        &form.file_name,
    );
    let row = UploadRow {
        human_login_id,
        conversation_id: form.conversation_id,
        size_bytes: form.bytes.len() as i64,
        sha256: sha256::digest(form.bytes.as_slice()),
        file_name: form.file_name,
        extension,
        content_type,
    };
    let keys = store_objects(env, form.bytes, preview, &row)
        .await
        .c(h!())?;
    match insert_row(env, row, &keys).await {
        Ok(upload) => Ok(upload),
        Err(error) => {
            delete_keys(env, &keys).await;
            Err(error).c(h!())?
        }
    }
}

struct UploadRow {
    human_login_id: Uuid,
    conversation_id: Option<Uuid>,
    file_name: String,
    extension: String,
    content_type: String,
    size_bytes: i64,
    sha256: String,
}

struct StoredKeys {
    original: String,
    preview: Option<String>,
}

async fn preview(
    extension: &str,
    bytes: &[u8],
) -> Result<Option<Vec<u8>>, AppError> {
    if !formats::is_image(extension) {
        return Ok(None);
    }
    let bytes = bytes.to_vec();
    let preview =
        tokio::task::spawn_blocking(move || image::preview_jpeg(&bytes))
            .await
            .c(h!())?
            .map_err(|_| AppError::BL {
                msg: "Не вдалося прочитати зображення".to_string(),
            })
            .c(h!())?;
    Ok(Some(preview))
}

/// Stores the original and preview; a failed preview removes the original so
/// no object outlives a missing row.
async fn store_objects(
    env: &Env,
    bytes: Vec<u8>,
    preview: Option<Vec<u8>>,
    row: &UploadRow,
) -> Result<StoredKeys, AppError> {
    let original = crate::messenger::media::store_asset(
        env,
        bytes.into(),
        Some(&row.file_name),
        Some(&row.content_type),
    )
    .await
    .c(h!())?;
    let Some(preview) = preview else {
        return Ok(StoredKeys {
            original,
            preview: None,
        });
    };
    match crate::messenger::media::store_asset(
        env,
        preview.into(),
        Some("preview.jpg"),
        Some("image/jpeg"),
    )
    .await
    {
        Ok(preview) => Ok(StoredKeys {
            original,
            preview: Some(preview),
        }),
        Err(error) => {
            delete_keys(
                env,
                &StoredKeys {
                    original,
                    preview: None,
                },
            )
            .await;
            Err(error).c(h!())?
        }
    }
}

async fn delete_keys(env: &Env, keys: &StoredKeys) {
    for key in std::iter::once(&keys.original).chain(&keys.preview) {
        crate::sigint::unit::attachment::delete_stored_asset_best_effort(
            env, key,
        )
        .await;
    }
}

async fn insert_row(
    env: &Env,
    row: UploadRow,
    keys: &StoredKeys,
) -> anyhow::Result<ai_agent_upload::Model> {
    let txn = env.dbx.begin().await.c(h!())?;
    store::lock_owner(&txn, row.human_login_id).await.c(h!())?;
    ensure_capacity(&txn, row.human_login_id, row.conversation_id)
        .await
        .c(h!())?;
    let now = Utc::now().naive_utc();
    let upload = ai_agent_upload::ActiveModel {
        id: Set(Uuid::now_v7()),
        human_login_id: Set(row.human_login_id),
        conversation_id: Set(row.conversation_id),
        request_id: Set(None),
        file_name: Set(row.file_name),
        extension: Set(row.extension),
        content_type: Set(row.content_type),
        size_bytes: Set(row.size_bytes),
        sha256: Set(row.sha256),
        storage_key: Set(keys.original.clone()),
        preview_key: Set(keys.preview.clone()),
        state: Set("uploaded".to_string()),
        extractor_job_id: Set(None),
        chunk_count: Set(0),
        text_chars: Set(0),
        warnings: Set(serde_json::json!([])),
        last_error: Set(None),
        attempts: Set(0),
        lease: Set(None),
        lease_until: Set(None),
        next_attempt_at: Set(now),
        created_at: Set(now),
        updated_at: Set(now),
    }
    .insert(&txn)
    .await
    .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(upload)
}
