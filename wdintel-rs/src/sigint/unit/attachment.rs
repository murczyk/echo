use super::orbit::{
    can_view_orbit_data, has_any_orbit_unit, unit_orbit_details,
};
use super::types::{
    DeleteUnitAttachmentReq, DeleteUnitAttachmentRsp, UnitAttachment,
    UnitAttachmentAor, UnitAttachmentDownloadReq, UnitAttachmentUnitIdsRsp,
    UnitDetailsReq, UnitDetailsRsp, UpdateUnitAttachmentReq,
};
use super::{apply_unit_orbit_visibility, render_unit};
use crate::config::{
    SIGINT_UNIT_ATTACHMENT_DOWNLOAD_TIMEOUT_SECS,
    SIGINT_UNIT_ATTACHMENT_MAX_AORS,
    SIGINT_UNIT_ATTACHMENT_MAX_ENCRYPTED_BYTES,
    SIGINT_UNIT_ATTACHMENT_MAX_FILENAME_CHARS,
    SIGINT_UNIT_ATTACHMENT_MAX_FILE_BYTES,
    SIGINT_UNIT_ATTACHMENT_MAX_FULL_DESCRIPTION_CHARS,
    SIGINT_UNIT_ATTACHMENT_MAX_METADATA_FIELD_BYTES,
    SIGINT_UNIT_ATTACHMENT_MAX_SHORT_DESCRIPTION_CHARS,
};
use crate::entities::*;
use crate::error::AppError;
use crate::types::*;
use crate::users::{
    ensure_admin, ensure_rer_role, has_role, login_id_from_identity,
};
use actix_multipart::{Field, Multipart};
use actix_web::http::header;
use actix_web::web::{Data, Json};
use actix_web::{post, HttpResponse};
use sea_orm::*;
use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

struct AttachmentUploadFile {
    file_name: String,
    content_type: String,
    bytes: actix_web::web::Bytes,
}

struct AttachmentUpload {
    unit_id: i64,
    short_description: String,
    full_description: String,
    aor_ids: Vec<i64>,
    file: AttachmentUploadFile,
}

#[post("/api/sigint/unit/details")]
pub async fn unit_details(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<UnitDetailsReq>,
) -> Result<Json<UnitDetailsRsp>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    let unit = find_available_unit(&env.dbx, req.unit_id).await?;
    let attachments =
        list_visible_attachments(&env.dbx, &login, unit.id).await?;
    let labels = super::labels::list_labels(&env.dbx, unit.id)
        .await
        .c(h!())?;
    let can_view_orbit = can_view_orbit_data(&env.dbx, &login).await?;
    let orbit_units = if can_view_orbit {
        unit_orbit_details(&env.dbx, unit.id).await?
    } else {
        Vec::new()
    };
    let can_edit_units = match has_role(&env.dbx, &login, "UnitsEditor").await {
        Ok(()) => true,
        Err(AppError::Forbidden(_)) => false,
        Err(err) => return Err(err),
    };
    let can_edit_unit_labels = can_edit_units
        && match ensure_admin(&env.dbx, &user).await {
            Ok(()) => true,
            Err(AppError::Forbidden(_)) => false,
            Err(err) => return Err(err),
        };
    let can_link_orbit_unit = can_view_orbit
        && can_edit_units
        && orbit_units.is_empty()
        && has_any_orbit_unit(&env.dbx).await?;
    let can_create_device_network = can_edit_units
        && crate::system_settings::devices_section_enabled(&env.dbx).await?
        && !super::unit_has_active_network(&env.dbx, unit.id).await?;
    let mut unit = render_unit(&unit)?;
    apply_unit_orbit_visibility(&env.dbx, &mut unit, can_view_orbit)
        .await
        .context(h!())?;
    Ok(Json(UnitDetailsRsp {
        unit,
        attachments,
        labels,
        orbit_units,
        can_link_orbit_unit,
        can_create_device_network,
        can_edit_unit_labels,
    }))
}

#[post("/api/sigint/unit/attachment-unit-ids")]
pub async fn unit_attachment_unit_ids(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<Vec<i64>>,
) -> Result<Json<UnitAttachmentUnitIdsRsp>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    let requested_unit_ids = req.into_inner();
    let unit_ids = list_visible_attachment_unit_ids(
        &env.dbx,
        &login,
        Some(&requested_unit_ids),
    )
    .await?;
    Ok(Json(UnitAttachmentUnitIdsRsp { unit_ids }))
}

#[post("/api/sigint/unit/attachment/upload")]
pub async fn upload_unit_attachment(
    user: actix_identity::Identity,
    env: Data<Env>,
    payload: Multipart,
) -> Result<Json<UnitAttachment>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    ensure_attachment_storage_configured(&env)?;
    let login = login_id_from_identity(&user)?;
    let upload = parse_attachment_upload(payload).await.map_err(|err| {
        error!("failed to parse unit attachment upload: {err:#?}");
        err
    })?;
    validate_upload_target(&env.dbx, upload.unit_id, &upload.aor_ids).await?;
    store_attachment_upload(&env, &login, upload)
        .await
        .map(Json)
}

async fn store_attachment_upload(
    env: &Env,
    login: &uuid::Uuid,
    upload: AttachmentUpload,
) -> Result<UnitAttachment, AppError> {
    let storage_key = crate::messenger::media::store_asset(
        env,
        upload.file.bytes.clone(),
        Some(&upload.file.file_name),
        Some(&upload.file.content_type),
    )
    .await
    .c(h!())
    .map_err(|err| {
        error!(
            "failed to store unit attachment: unit_id={} file_name={:?} size_bytes={}: {err:#?}",
            upload.unit_id,
            upload.file.file_name,
            upload.file.bytes.len(),
        );
        err
    })?;

    let stored = UploadedUnitAttachment::new(env, storage_key.clone());
    match insert_attachment(env, login, upload, stored).await {
        Ok(attachment) => Ok(attachment),
        Err(err) => {
            error!(
                "failed to save unit attachment metadata: storage_key={storage_key}: {err:#?}"
            );
            Err(err)
        }
    }
}

#[post("/api/sigint/unit/attachment/update")]
pub async fn update_unit_attachment(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<UpdateUnitAttachmentReq>,
) -> Result<Json<UnitAttachment>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    Ok(Json(update_attachment(&env.dbx, req.into_inner()).await?))
}

#[post("/api/sigint/unit/attachment/delete")]
pub async fn delete_unit_attachment(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<DeleteUnitAttachmentReq>,
) -> Result<Json<DeleteUnitAttachmentRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let attachment =
        delete_attachment_record(&env.dbx, req.attachment_id).await?;
    delete_stored_asset_best_effort(&env, &attachment.storage_key).await;
    Ok(Json(DeleteUnitAttachmentRsp {
        attachment_id: attachment.id,
    }))
}

fn ensure_attachment_storage_configured(env: &Env) -> Result<(), AppError> {
    if env.config.s3_config.is_none()
        || env.s3_config.is_none()
        || env.s3.is_none()
    {
        return Err(AppError::BL {
            msg: "S3 is not configured".to_string(),
        });
    }
    Ok(())
}

#[post("/api/sigint/unit/attachment/download")]
pub async fn download_unit_attachment(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<UnitAttachmentDownloadReq>,
) -> Result<HttpResponse, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    let attachment =
        find_visible_attachment(&env.dbx, &login, req.attachment_id).await?;
    let expected_size = validate_download_size(attachment.size_bytes)?;
    let config = env.config.s3_config.as_ref().ok_or(AppError::BL {
        msg: "S3 is not configured".to_string(),
    })?;
    if env.s3.is_none() || env.s3_config.is_none() {
        return Err(AppError::BL {
            msg: "S3 is not configured".to_string(),
        });
    }
    let bytes = crate::storage::download_and_decrypt_messenger_media_from_s3_with_operator_timeout_and_size_limit(
        &env.s3,
        &env.s3_config,
        &config.strongbox_key,
        &attachment.storage_key,
        Duration::from_secs(SIGINT_UNIT_ATTACHMENT_DOWNLOAD_TIMEOUT_SECS),
        SIGINT_UNIT_ATTACHMENT_MAX_ENCRYPTED_BYTES,
    )
    .await
    .c(h!())?;
    if bytes.len() != expected_size {
        return Err(AppError::BL {
            msg: format!(
                "Unit attachment {} size mismatch: expected {}, downloaded {}",
                attachment.id,
                expected_size,
                bytes.len()
            ),
        });
    }

    Ok(attachment_download_response(&attachment, bytes))
}

async fn list_visible_attachments(
    dbx: &DatabaseConnection,
    login: &uuid::Uuid,
    unit_id: i64,
) -> Result<Vec<UnitAttachment>, AppError> {
    let user_is_admin = is_admin(dbx, login).await?;
    let mut attachments = sigint_unit_attachment::Entity::find()
        .filter(sigint_unit_attachment::Column::UnitId.eq(unit_id));
    if !user_is_admin {
        let aor_ids =
            crate::sigint::aor::bl::login_aor_ids_with_descendants(dbx, login)
                .await
                .c(h!())?;
        if aor_ids.is_empty() {
            return Ok(vec![]);
        }
        attachments = attachments
            .join(
                JoinType::InnerJoin,
                sigint_unit_attachment::Relation::SigintUnitAttachmentAor.def(),
            )
            .join(
                JoinType::InnerJoin,
                sigint_unit_attachment_aor::Relation::AreaOfResponsibility
                    .def(),
            )
            .filter(
                sigint_unit_attachment_aor::Column::AorId
                    .is_in(aor_ids.into_iter().collect::<Vec<_>>()),
            )
            .filter(area_of_responsibility::Column::Deleted.eq(false));
    }
    let attachments = attachments
        .order_by_desc(sigint_unit_attachment::Column::CreatedAt)
        .order_by_desc(sigint_unit_attachment::Column::Id)
        .all(dbx)
        .await
        .c(h!())?;
    render_attachments(dbx, attachments, user_is_admin).await
}

async fn list_visible_attachment_unit_ids(
    dbx: &DatabaseConnection,
    login: &uuid::Uuid,
    unit_ids: Option<&[i64]>,
) -> Result<Vec<i64>, AppError> {
    if unit_ids.is_some_and(|unit_ids| unit_ids.is_empty()) {
        return Ok(vec![]);
    }
    let mut attachments = sigint_unit_attachment::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_unit_attachment::Relation::SigintUnit.def(),
        )
        .filter(sigint_unit::Column::Deleted.eq(false));
    if let Some(unit_ids) = unit_ids {
        attachments = attachments.filter(
            sigint_unit_attachment::Column::UnitId
                .is_in(unit_ids.iter().copied()),
        );
    }
    if !is_admin(dbx, login).await? {
        let aor_ids =
            crate::sigint::aor::bl::login_aor_ids_with_descendants(dbx, login)
                .await
                .c(h!())?;
        if aor_ids.is_empty() {
            return Ok(vec![]);
        }
        let attachment_ids =
            visible_attachment_ids(dbx, aor_ids.into_iter().collect()).await?;
        if attachment_ids.is_empty() {
            return Ok(vec![]);
        }
        attachments = attachments
            .filter(sigint_unit_attachment::Column::Id.is_in(attachment_ids));
    }
    Ok(attachments
        .select_only()
        .column(sigint_unit_attachment::Column::UnitId)
        .distinct()
        .order_by_asc(sigint_unit_attachment::Column::UnitId)
        .into_tuple::<i64>()
        .all(dbx)
        .await
        .c(h!())?)
}

async fn visible_attachment_ids(
    dbx: &DatabaseConnection,
    aor_ids: Vec<i64>,
) -> Result<Vec<i64>, AppError> {
    Ok(sigint_unit_attachment_aor::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_unit_attachment_aor::Relation::AreaOfResponsibility.def(),
        )
        .filter(sigint_unit_attachment_aor::Column::AorId.is_in(aor_ids))
        .filter(area_of_responsibility::Column::Deleted.eq(false))
        .select_only()
        .column(sigint_unit_attachment_aor::Column::AttachmentId)
        .distinct()
        .into_tuple::<i64>()
        .all(dbx)
        .await
        .c(h!())?)
}

async fn render_attachments(
    dbx: &DatabaseConnection,
    attachments: Vec<sigint_unit_attachment::Model>,
    include_aors: bool,
) -> Result<Vec<UnitAttachment>, AppError> {
    let attachment_ids = attachments
        .iter()
        .map(|attachment| attachment.id)
        .collect::<Vec<_>>();
    let mut aors_by_attachment = BTreeMap::new();
    if include_aors && !attachment_ids.is_empty() {
        let rows = sigint_unit_attachment_aor::Entity::find()
            .find_also_related(area_of_responsibility::Entity)
            .filter(
                sigint_unit_attachment_aor::Column::AttachmentId
                    .is_in(attachment_ids),
            )
            .filter(area_of_responsibility::Column::Deleted.eq(false))
            .order_by_asc(area_of_responsibility::Column::Name)
            .order_by_asc(area_of_responsibility::Column::Id)
            .all(dbx)
            .await
            .c(h!())?;
        for (attachment_aor, aor) in rows {
            let Some(aor) = aor else {
                continue;
            };
            aors_by_attachment
                .entry(attachment_aor.attachment_id)
                .or_insert_with(Vec::new)
                .push(UnitAttachmentAor {
                    id: aor.id,
                    name: aor.name,
                });
        }
    }
    Ok(attachments
        .into_iter()
        .map(|attachment| {
            let aors = include_aors.then(|| {
                aors_by_attachment
                    .remove(&attachment.id)
                    .unwrap_or_default()
            });
            render_attachment(attachment, aors)
        })
        .collect())
}

fn render_attachment(
    attachment: sigint_unit_attachment::Model,
    aors: Option<Vec<UnitAttachmentAor>>,
) -> UnitAttachment {
    UnitAttachment {
        id: attachment.id,
        unit_id: attachment.unit_id,
        file_name: attachment.file_name,
        content_type: attachment.content_type,
        size_bytes: attachment.size_bytes,
        short_description: attachment.short_description,
        full_description: attachment.full_description,
        aors,
        created_at: attachment.created_at.and_utc().timestamp_millis(),
    }
}

async fn find_visible_attachment(
    dbx: &DatabaseConnection,
    login: &uuid::Uuid,
    attachment_id: i64,
) -> Result<sigint_unit_attachment::Model, AppError> {
    let attachment = sigint_unit_attachment::Entity::find_by_id(attachment_id)
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    find_available_unit(dbx, attachment.unit_id).await?;
    if is_admin(dbx, login).await? {
        return Ok(attachment);
    }

    let aor_ids =
        crate::sigint::aor::bl::login_aor_ids_with_descendants(dbx, login)
            .await
            .c(h!())?;
    if aor_ids.is_empty() {
        return Err(AppError::NotFound);
    }
    let visible = sigint_unit_attachment_aor::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_unit_attachment_aor::Relation::AreaOfResponsibility.def(),
        )
        .filter(
            sigint_unit_attachment_aor::Column::AttachmentId.eq(attachment.id),
        )
        .filter(
            sigint_unit_attachment_aor::Column::AorId
                .is_in(aor_ids.into_iter().collect::<Vec<_>>()),
        )
        .filter(area_of_responsibility::Column::Deleted.eq(false))
        .select_only()
        .column(sigint_unit_attachment_aor::Column::Id)
        .into_tuple::<i64>()
        .one(dbx)
        .await
        .c(h!())?
        .is_some();
    if visible {
        Ok(attachment)
    } else {
        Err(AppError::NotFound)
    }
}

async fn is_admin(
    dbx: &DatabaseConnection,
    login: &uuid::Uuid,
) -> Result<bool, AppError> {
    match has_role(dbx, login, "Admin").await {
        Ok(()) => Ok(true),
        Err(AppError::Forbidden(_)) => Ok(false),
        Err(err) => Err(err),
    }
}

async fn find_available_unit<C>(
    dbx: &C,
    unit_id: i64,
) -> Result<sigint_unit::Model, AppError>
where
    C: ConnectionTrait,
{
    sigint_unit::Entity::find_by_id(unit_id)
        .filter(sigint_unit::Column::Deleted.eq(false))
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
}

async fn validate_upload_target<C>(
    dbx: &C,
    unit_id: i64,
    aor_ids: &[i64],
) -> Result<Vec<area_of_responsibility::Model>, AppError>
where
    C: ConnectionTrait,
{
    find_available_unit(dbx, unit_id).await?;
    let aors = area_of_responsibility::Entity::find()
        .filter(area_of_responsibility::Column::Id.is_in(aor_ids.to_vec()))
        .filter(area_of_responsibility::Column::Deleted.eq(false))
        .order_by_asc(area_of_responsibility::Column::Name)
        .order_by_asc(area_of_responsibility::Column::Id)
        .all(dbx)
        .await
        .c(h!())?;
    if aors.len() != aor_ids.len() {
        return Err(AppError::BL {
            msg: "One or more selected AORs do not exist".to_string(),
        });
    }
    Ok(aors)
}

async fn insert_attachment(
    env: &Env,
    login: &uuid::Uuid,
    upload: AttachmentUpload,
    stored: UploadedUnitAttachment,
) -> Result<UnitAttachment, AppError> {
    let txn = env.dbx.begin().await.c(h!())?;
    let aors =
        validate_upload_target(&txn, upload.unit_id, &upload.aor_ids).await?;
    let attachment = sigint_unit_attachment::ActiveModel {
        id: NotSet,
        unit_id: Set(upload.unit_id),
        file_name: Set(upload.file.file_name),
        content_type: Set(upload.file.content_type),
        size_bytes: Set(i64::try_from(upload.file.bytes.len()).c(h!())?),
        storage_key: Set(stored.key.as_ref().unwrap().clone()),
        short_description: Set(upload.short_description),
        full_description: Set(upload.full_description),
        created_by_login_id: Set(*login),
        created_at: NotSet,
    }
    .insert(&txn)
    .await
    .c(h!())?;
    let attachment_aors = upload
        .aor_ids
        .into_iter()
        .map(|aor_id| sigint_unit_attachment_aor::ActiveModel {
            id: NotSet,
            attachment_id: Set(attachment.id),
            aor_id: Set(aor_id),
            created_at: NotSet,
        })
        .collect::<Vec<_>>();
    sigint_unit_attachment_aor::Entity::insert_many(attachment_aors)
        .exec(&txn)
        .await
        .c(h!())?;
    commit_attachment_upload(txn, stored).await.c(h!())?;

    Ok(render_attachment(
        attachment,
        Some(
            aors.into_iter()
                .map(|aor| UnitAttachmentAor {
                    id: aor.id,
                    name: aor.name,
                })
                .collect(),
        ),
    ))
}

async fn update_attachment(
    dbx: &DatabaseConnection,
    req: UpdateUnitAttachmentReq,
) -> Result<UnitAttachment, AppError> {
    let short_description = validate_description(
        req.short_description,
        "short_description",
        SIGINT_UNIT_ATTACHMENT_MAX_SHORT_DESCRIPTION_CHARS,
    )?;
    let full_description = validate_description(
        req.full_description,
        "full_description",
        SIGINT_UNIT_ATTACHMENT_MAX_FULL_DESCRIPTION_CHARS,
    )?;
    let aor_ids = validate_aor_ids(req.aor_ids)?;
    let txn = dbx.begin().await.c(h!())?;
    let attachment =
        sigint_unit_attachment::Entity::find_by_id(req.attachment_id)
            .one(&txn)
            .await
            .c(h!())?
            .ok_or(AppError::NotFound)?;
    let aors =
        validate_upload_target(&txn, attachment.unit_id, &aor_ids).await?;
    let mut attachment = attachment.into_active_model();
    attachment.short_description = Set(short_description);
    attachment.full_description = Set(full_description);
    let attachment = attachment.update(&txn).await.c(h!())?;

    sigint_unit_attachment_aor::Entity::delete_many()
        .filter(
            sigint_unit_attachment_aor::Column::AttachmentId.eq(attachment.id),
        )
        .exec(&txn)
        .await
        .c(h!())?;
    let attachment_aors = aor_ids
        .into_iter()
        .map(|aor_id| sigint_unit_attachment_aor::ActiveModel {
            id: NotSet,
            attachment_id: Set(attachment.id),
            aor_id: Set(aor_id),
            created_at: NotSet,
        })
        .collect::<Vec<_>>();
    sigint_unit_attachment_aor::Entity::insert_many(attachment_aors)
        .exec(&txn)
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;

    Ok(render_attachment(
        attachment,
        Some(
            aors.into_iter()
                .map(|aor| UnitAttachmentAor {
                    id: aor.id,
                    name: aor.name,
                })
                .collect(),
        ),
    ))
}

async fn delete_attachment_record(
    dbx: &DatabaseConnection,
    attachment_id: i64,
) -> Result<sigint_unit_attachment::Model, AppError> {
    let attachment = sigint_unit_attachment::Entity::find_by_id(attachment_id)
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    attachment.clone().delete(dbx).await.c(h!())?;
    Ok(attachment)
}

async fn parse_attachment_upload(
    mut payload: Multipart,
) -> Result<AttachmentUpload, AppError> {
    let mut unit_id = None;
    let mut short_description = None;
    let mut full_description = None;
    let mut aor_ids = None;
    let mut file = None;

    while let Some(item) = crate::utils::multipart::next(&mut payload).await? {
        let mut field = item.map_err(|err| AppError::BL {
            msg: format!("Multipart error: {err:?}"),
        })?;
        let field_name = field
            .content_disposition()
            .and_then(|disposition| disposition.get_name())
            .map(str::to_string)
            .ok_or_else(|| AppError::BL {
                msg: "Multipart field name is required".to_string(),
            })?;
        match field_name.as_str() {
            "unit_id" => {
                ensure_missing(&unit_id, "unit_id")?;
                let value = read_text_field(&mut field, "unit_id").await?;
                let value =
                    value.trim().parse::<i64>().map_err(|_| AppError::BL {
                        msg: "unit_id must be an integer".to_string(),
                    })?;
                if value <= 0 {
                    return Err(AppError::BL {
                        msg: "unit_id must be positive".to_string(),
                    });
                }
                unit_id = Some(value);
            }
            "short_description" => {
                ensure_missing(&short_description, "short_description")?;
                short_description = Some(
                    read_text_field(&mut field, "short_description").await?,
                );
            }
            "full_description" => {
                ensure_missing(&full_description, "full_description")?;
                full_description = Some(
                    read_text_field(&mut field, "full_description").await?,
                );
            }
            "aor_ids" => {
                ensure_missing(&aor_ids, "aor_ids")?;
                let value = read_text_field(&mut field, "aor_ids").await?;
                aor_ids = Some(parse_aor_ids(&value)?);
            }
            "file" => {
                ensure_missing(&file, "file")?;
                file = Some(read_upload_file(&mut field).await?);
            }
            _ => {
                return Err(AppError::BL {
                    msg: format!("Unknown multipart field: {field_name}"),
                });
            }
        }
    }

    Ok(AttachmentUpload {
        unit_id: required(unit_id, "unit_id")?,
        short_description: validate_description(
            required(short_description, "short_description")?,
            "short_description",
            SIGINT_UNIT_ATTACHMENT_MAX_SHORT_DESCRIPTION_CHARS,
        )?,
        full_description: validate_description(
            required(full_description, "full_description")?,
            "full_description",
            SIGINT_UNIT_ATTACHMENT_MAX_FULL_DESCRIPTION_CHARS,
        )?,
        aor_ids: required(aor_ids, "aor_ids")?,
        file: required(file, "file")?,
    })
}

fn ensure_missing<T>(
    value: &Option<T>,
    field_name: &str,
) -> Result<(), AppError> {
    if value.is_some() {
        return Err(AppError::BL {
            msg: format!("Duplicate multipart field: {field_name}"),
        });
    }
    Ok(())
}

fn required<T>(value: Option<T>, field_name: &str) -> Result<T, AppError> {
    value.ok_or_else(|| AppError::BL {
        msg: format!("Multipart field is required: {field_name}"),
    })
}

async fn read_text_field(
    field: &mut Field,
    field_name: &str,
) -> Result<String, AppError> {
    let bytes = read_field_bytes(
        field,
        SIGINT_UNIT_ATTACHMENT_MAX_METADATA_FIELD_BYTES,
        field_name,
    )
    .await?;
    String::from_utf8(bytes).map_err(|_| AppError::BL {
        msg: format!("{field_name} must be valid UTF-8"),
    })
}

async fn read_upload_file(
    field: &mut Field,
) -> Result<AttachmentUploadFile, AppError> {
    let raw_file_name = field
        .content_disposition()
        .and_then(|disposition| disposition.get_filename())
        .unwrap_or("attachment.bin")
        .to_string();
    let file_name = sanitize_file_name(&raw_file_name)?;
    let supplied_content_type = field.content_type().map(ToString::to_string);
    let bytes =
        read_field_bytes(field, SIGINT_UNIT_ATTACHMENT_MAX_FILE_BYTES, "file")
            .await?;
    if bytes.is_empty() {
        return Err(AppError::BL {
            msg: "Attachment file must not be empty".to_string(),
        });
    }
    let content_type =
        normalize_content_type(supplied_content_type.as_deref(), &file_name);
    Ok(AttachmentUploadFile {
        file_name,
        content_type,
        bytes: bytes.into(),
    })
}

async fn read_field_bytes(
    field: &mut Field,
    max_bytes: usize,
    field_name: &str,
) -> Result<Vec<u8>, AppError> {
    let mut bytes = Vec::new();
    while let Some(chunk) = crate::utils::multipart::next(field).await? {
        let chunk = chunk.map_err(|err| AppError::BL {
            msg: format!("Multipart error: {err:?}"),
        })?;
        let new_len =
            bytes.len().checked_add(chunk.len()).ok_or_else(|| {
                AppError::BL {
                    msg: format!("{field_name} is too large"),
                }
            })?;
        if new_len > max_bytes {
            return Err(AppError::BL {
                msg: format!(
                    "{field_name} is too large: maximum is {max_bytes} bytes"
                ),
            });
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn validate_description(
    description: String,
    field_name: &str,
    max_chars: usize,
) -> Result<String, AppError> {
    let description = description.trim().to_string();
    if description.is_empty() {
        return Err(AppError::BL {
            msg: format!("{field_name} must not be empty"),
        });
    }
    if description.chars().count() > max_chars {
        return Err(AppError::BL {
            msg: format!("{field_name} must not exceed {max_chars} characters"),
        });
    }
    Ok(description)
}

fn parse_aor_ids(value: &str) -> Result<Vec<i64>, AppError> {
    let aor_ids =
        serde_json::from_str::<Vec<i64>>(value.trim()).map_err(|_| {
            AppError::BL {
                msg: "aor_ids must be a JSON array of integers".to_string(),
            }
        })?;
    validate_aor_ids(aor_ids)
}

fn validate_aor_ids(aor_ids: Vec<i64>) -> Result<Vec<i64>, AppError> {
    let aor_ids = aor_ids.into_iter().collect::<BTreeSet<_>>();
    if aor_ids.is_empty() {
        return Err(AppError::BL {
            msg: "At least one AOR must be selected".to_string(),
        });
    }
    if aor_ids.len() > SIGINT_UNIT_ATTACHMENT_MAX_AORS {
        return Err(AppError::BL {
            msg: format!(
                "Too many AORs: maximum is {SIGINT_UNIT_ATTACHMENT_MAX_AORS}"
            ),
        });
    }
    if aor_ids.iter().any(|aor_id| *aor_id <= 0) {
        return Err(AppError::BL {
            msg: "aor_ids must contain only positive integers".to_string(),
        });
    }
    Ok(aor_ids.into_iter().collect())
}

fn sanitize_file_name(raw_file_name: &str) -> Result<String, AppError> {
    let file_name = raw_file_name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .chars()
        .map(|character| {
            if character.is_control() {
                '_'
            } else {
                character
            }
        })
        .collect::<String>();
    let file_name = file_name.trim().to_string();
    let file_name =
        if file_name.is_empty() || matches!(file_name.as_str(), "." | "..") {
            "attachment.bin".to_string()
        } else {
            file_name
        };
    if file_name.chars().count() > SIGINT_UNIT_ATTACHMENT_MAX_FILENAME_CHARS {
        return Err(AppError::BL {
            msg: format!(
                "Filename must not exceed {SIGINT_UNIT_ATTACHMENT_MAX_FILENAME_CHARS} characters"
            ),
        });
    }
    Ok(file_name)
}

fn normalize_content_type(
    supplied_content_type: Option<&str>,
    file_name: &str,
) -> String {
    supplied_content_type
        .and_then(|content_type| {
            content_type
                .parse::<actix_web::mime::Mime>()
                .ok()
                .map(|content_type| content_type.to_string())
        })
        .or_else(|| {
            mime_guess::from_path(file_name)
                .first_raw()
                .map(str::to_string)
        })
        .unwrap_or_else(|| "application/octet-stream".to_string())
}

fn validate_download_size(size_bytes: i64) -> Result<usize, AppError> {
    let size_bytes = usize::try_from(size_bytes).map_err(|_| AppError::BL {
        msg: "Invalid unit attachment size".to_string(),
    })?;
    if size_bytes == 0 || size_bytes > SIGINT_UNIT_ATTACHMENT_MAX_FILE_BYTES {
        return Err(AppError::BL {
            msg: "Invalid unit attachment size".to_string(),
        });
    }
    Ok(size_bytes)
}

fn attachment_download_response(
    attachment: &sigint_unit_attachment::Model,
    bytes: Vec<u8>,
) -> HttpResponse {
    let file_name = sanitize_file_name(&attachment.file_name)
        .unwrap_or_else(|_| "attachment.bin".to_string());
    let content_type =
        normalize_content_type(Some(&attachment.content_type), &file_name);
    let content_disposition = header::ContentDisposition {
        disposition: header::DispositionType::Attachment,
        parameters: vec![header::DispositionParam::FilenameExt(
            header::ExtendedValue {
                charset: header::Charset::Ext("UTF-8".to_string()),
                language_tag: None,
                value: file_name.into_bytes(),
            },
        )],
    };
    HttpResponse::Ok()
        .insert_header((header::CONTENT_TYPE, content_type))
        .insert_header(content_disposition)
        .insert_header((header::CACHE_CONTROL, "private, no-store"))
        .insert_header(("X-Content-Type-Options", "nosniff"))
        .insert_header((header::CONTENT_LENGTH, bytes.len().to_string()))
        .body(bytes)
}

struct UploadedUnitAttachment {
    env: Env,
    key: Option<String>,
}

impl UploadedUnitAttachment {
    fn new(env: &Env, key: String) -> Self {
        Self {
            env: env.clone(),
            key: Some(key),
        }
    }
}

impl Drop for UploadedUnitAttachment {
    fn drop(&mut self) {
        let Some(key) = self.key.take() else {
            return;
        };
        let env = self.env.clone();
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => {
                runtime.spawn(async move {
                    delete_stored_asset_best_effort(&env, &key).await;
                });
            }
            Err(error) => {
                error!(
                    "cannot clean unpublished unit attachment {key}: {error}"
                );
            }
        }
    }
}

async fn commit_attachment_upload(
    txn: DatabaseTransaction,
    mut stored: UploadedUnitAttachment,
) -> anyhow::Result<()> {
    tokio::spawn(async move {
        // A missing COMMIT acknowledgement cannot prove the object is unreferenced.
        let key = stored.key.take().unwrap();
        if let Err(error) = txn.commit().await {
            warn!("unit attachment COMMIT outcome is unknown; retaining {key}: {error:?}");
            return Err(error).c(h!());
        }
        Ok(())
    })
    .await
    .c(h!())?
}

async fn delete_stored_asset_best_effort(env: &Env, storage_key: &str) {
    let (Some(s3), Some(s3_config)) = (&env.s3, &env.s3_config) else {
        return;
    };
    let remote_key = s3_config.prefixed_key(storage_key);
    if let Err(err) = s3.delete(&remote_key).await {
        warn!(
            "failed to delete orphaned unit attachment object {remote_key}: {err:#?}"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::functest::tests::{
        cleanup, find_test_aor, find_test_login, mk_aor, mk_login, mk_organism,
        mk_organism_aor, mk_sigint_unit,
    };
    use serial_test::serial;

    struct AccessFixture {
        env: std::sync::Arc<Env>,
        unit: sigint_unit::Model,
        parent_login_id: uuid::Uuid,
        child_login_id: uuid::Uuid,
        unrelated_login_id: uuid::Uuid,
        admin_login_id: uuid::Uuid,
        parent_aor: area_of_responsibility::Model,
        child_aor: area_of_responsibility::Model,
        unrelated_aor: area_of_responsibility::Model,
    }

    struct UploadFixture {
        env: Env,
        login: uuid::Uuid,
        unit_id: i64,
        aor_id: i64,
    }

    impl UploadFixture {
        async fn new() -> Self {
            let env = cleanup().await.unwrap();
            let mut env = env.as_ref().clone();
            let login = find_test_login(&env.dbx).await.unwrap().id;
            let aor_id = find_test_aor(&env.dbx).await.unwrap().id;
            let unit_id = mk_sigint_unit(
                &env.dbx,
                sigint_unit::ActiveModel {
                    created_by_login_id: Set(login),
                    ..Default::default()
                },
            )
            .await
            .unwrap()
            .id;
            let config = crate::config::S3Config {
                s3_access_key_id: "test".into(),
                s3_secret_access_key: "test".into(),
                s3_endpoint: String::new(),
                s3_region: String::new(),
                s3_bucket: "unit-attachment-upload-test".into(),
                strongbox_key: crate::storage::generate_strongbox_key_b64(),
            };
            env.s3_config = Some(crate::storage::S3Config::from(&config));
            env.config.s3_config = Some(config);
            env.s3 = Some(
                opendal::Operator::new(opendal::services::Memory::default())
                    .unwrap()
                    .finish(),
            );
            Self {
                env,
                login,
                unit_id,
                aor_id,
            }
        }

        fn upload(&self) -> AttachmentUpload {
            AttachmentUpload {
                unit_id: self.unit_id,
                aor_ids: vec![self.aor_id],
                short_description: "upload recovery".into(),
                full_description: "upload recovery test".into(),
                file: AttachmentUploadFile {
                    file_name: "recovery.txt".into(),
                    content_type: "text/plain".into(),
                    bytes: actix_web::web::Bytes::from_static(
                        b"attachment bytes",
                    ),
                },
            }
        }

        async fn object_keys(&self) -> Vec<String> {
            self.env
                .s3
                .as_ref()
                .unwrap()
                .list_with("/")
                .recursive(true)
                .await
                .unwrap()
                .into_iter()
                .filter(|entry| entry.metadata().is_file())
                .map(|entry| entry.path().to_owned())
                .collect()
        }

        async fn wait_for_objects(&self, count: usize) {
            tokio::time::timeout(Duration::from_secs(5), async {
                while self.object_keys().await.len() != count {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
        }
    }

    async fn backend_pid(txn: &DatabaseTransaction) -> i32 {
        txn.query_one_raw(Statement::from_string(
            DatabaseBackend::Postgres,
            "SELECT pg_backend_pid() AS pid",
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "pid")
        .unwrap()
    }

    async fn wait_for_blocked_query(env: &Env, blocker: i32) {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let waiting: bool = env.dbx.query_one_raw(
                    Statement::from_sql_and_values(DatabaseBackend::Postgres,
                        "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1 = ANY(pg_blocking_pids(pid))) AS waiting",
                        [blocker.into()],
                    ),
                ).await.unwrap().unwrap().try_get("", "waiting").unwrap();
                if waiting { return; }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.unwrap();
    }

    #[tokio::test]
    #[serial]
    async fn cancelled_attachment_insert_removes_object_and_retry_preserves_content(
    ) {
        let fixture = UploadFixture::new().await;
        let blocker = fixture.env.dbx.begin().await.unwrap();
        blocker
            .execute_unprepared(
                "LOCK TABLE sigint_unit_attachment IN SHARE MODE",
            )
            .await
            .unwrap();
        let blocker_pid = backend_pid(&blocker).await;
        let env = fixture.env.clone();
        let login = fixture.login;
        let upload = fixture.upload();
        let request = tokio::spawn(async move {
            store_attachment_upload(&env, &login, upload).await
        });
        wait_for_blocked_query(&fixture.env, blocker_pid).await;
        assert_eq!(fixture.object_keys().await.len(), 1);
        request.abort();
        assert!(request.await.unwrap_err().is_cancelled());
        blocker.rollback().await.unwrap();
        fixture.wait_for_objects(0).await;
        assert_eq!(
            sigint_unit_attachment::Entity::find()
                .filter(
                    sigint_unit_attachment::Column::UnitId.eq(fixture.unit_id)
                )
                .count(&fixture.env.dbx)
                .await
                .unwrap(),
            0
        );

        let attachment = store_attachment_upload(
            &fixture.env,
            &fixture.login,
            fixture.upload(),
        )
        .await
        .unwrap();
        let saved = sigint_unit_attachment::Entity::find_by_id(attachment.id)
            .one(&fixture.env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            fixture.object_keys().await,
            vec![fixture
                .env
                .s3_config
                .as_ref()
                .unwrap()
                .prefixed_key(&saved.storage_key),]
        );
        let bytes = crate::storage::download_and_decrypt_messenger_media_from_s3_with_operator(
            &fixture.env.s3,
            &fixture.env.s3_config,
            &fixture.env.config.s3_config.as_ref().unwrap().strongbox_key,
            &saved.storage_key,
        ).await.unwrap();
        assert_eq!(bytes, b"attachment bytes");
    }

    #[tokio::test]
    #[serial]
    async fn attachment_insert_failure_cleans_object_but_commit_failure_retains_it(
    ) {
        let fixture = UploadFixture::new().await;
        assert!(store_attachment_upload(
            &fixture.env,
            &uuid::Uuid::new_v4(),
            fixture.upload(),
        )
        .await
        .is_err());
        fixture.wait_for_objects(0).await;

        let key = "commit-outcome-unknown".to_owned();
        let remote = fixture.env.s3_config.as_ref().unwrap().prefixed_key(&key);
        fixture
            .env
            .s3
            .as_ref()
            .unwrap()
            .write(&remote, "retain me")
            .await
            .unwrap();
        let txn = fixture.env.dbx.begin().await.unwrap();
        let pid = backend_pid(&txn).await;
        let terminated: bool = fixture
            .env
            .dbx
            .query_one_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "SELECT pg_terminate_backend($1, 5000) AS terminated",
                [pid.into()],
            ))
            .await
            .unwrap()
            .unwrap()
            .try_get("", "terminated")
            .unwrap();
        assert!(terminated);
        let result = commit_attachment_upload(
            txn,
            UploadedUnitAttachment::new(&fixture.env, key),
        )
        .await;
        assert!(result.is_err());
        assert_eq!(
            fixture
                .env
                .s3
                .as_ref()
                .unwrap()
                .read(&remote)
                .await
                .unwrap()
                .to_bytes(),
            "retain me"
        );
    }

    #[tokio::test]
    #[serial]
    async fn cancelled_attachment_commit_finishes_and_retains_referenced_object(
    ) {
        let fixture = UploadFixture::new().await;
        let key = "cancelled-commit".to_owned();
        let remote = fixture.env.s3_config.as_ref().unwrap().prefixed_key(&key);
        fixture
            .env
            .s3
            .as_ref()
            .unwrap()
            .write(&remote, "committed bytes")
            .await
            .unwrap();
        let blocker = fixture.env.dbx.begin().await.unwrap();
        let blocker_pid = backend_pid(&blocker).await;
        blocker
            .execute_unprepared("SELECT pg_advisory_xact_lock(7829130645)")
            .await
            .unwrap();
        let txn = fixture.env.dbx.begin().await.unwrap();
        txn.execute_unprepared(r#"
CREATE TEMP TABLE attachment_commit_barrier (id integer) ON COMMIT DROP;
CREATE OR REPLACE FUNCTION pg_temp.wait_attachment_commit() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(7829130645); RETURN NEW; END $$;
CREATE CONSTRAINT TRIGGER attachment_commit_wait AFTER INSERT ON attachment_commit_barrier
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pg_temp.wait_attachment_commit();
INSERT INTO attachment_commit_barrier VALUES (1);
"#).await.unwrap();
        let attachment = sigint_unit_attachment::ActiveModel {
            unit_id: Set(fixture.unit_id),
            file_name: Set("commit.txt".into()),
            content_type: Set("text/plain".into()),
            size_bytes: Set(15),
            storage_key: Set(key.clone()),
            short_description: Set("commit".into()),
            full_description: Set("commit cancellation".into()),
            created_by_login_id: Set(fixture.login),
            ..Default::default()
        }
        .insert(&txn)
        .await
        .unwrap();
        let stored = UploadedUnitAttachment::new(&fixture.env, key);
        let request = tokio::spawn(commit_attachment_upload(txn, stored));
        wait_for_blocked_query(&fixture.env, blocker_pid).await;
        request.abort();
        assert!(request.await.unwrap_err().is_cancelled());
        assert!(sigint_unit_attachment::Entity::find_by_id(attachment.id)
            .one(&fixture.env.dbx)
            .await
            .unwrap()
            .is_none());
        blocker.rollback().await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while sigint_unit_attachment::Entity::find_by_id(attachment.id)
                .one(&fixture.env.dbx)
                .await
                .unwrap()
                .is_none()
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            fixture
                .env
                .s3
                .as_ref()
                .unwrap()
                .read(&remote)
                .await
                .unwrap()
                .to_bytes(),
            "committed bytes"
        );
    }

    async fn create_test_aor(
        dbx: &DatabaseConnection,
        name: &str,
        left_bound: f64,
        right_bound: f64,
    ) -> area_of_responsibility::Model {
        mk_aor(
            dbx,
            area_of_responsibility::ActiveModel {
                name: Set(name.to_string()),
                left_bound: Set(left_bound),
                right_bound: Set(right_bound),
                ..Default::default()
            },
        )
        .await
        .unwrap()
    }

    async fn create_login_on_aor(
        dbx: &DatabaseConnection,
        login_name: &str,
        roles: &[&str],
        aor_id: i64,
    ) -> login::Model {
        let organism = mk_organism(
            dbx,
            organism::ActiveModel {
                name: Set(format!("{login_name} organism")),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_organism_aor(
            dbx,
            organism_aor::ActiveModel {
                organism_id: Set(organism.id),
                aor_id: Set(aor_id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_login(
            dbx,
            login::ActiveModel {
                login: Set(login_name.to_string()),
                roles: Set(serde_json::to_value(roles).unwrap()),
                organism_id: Set(Some(organism.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap()
    }

    async fn access_fixture() -> AccessFixture {
        let env = cleanup().await.unwrap();
        let parent_aor = find_test_aor(&env.dbx).await.unwrap();
        let parent_login = find_test_login(&env.dbx).await.unwrap();
        let child_aor =
            create_test_aor(&env.dbx, "Attachment child AOR", 10.0, 20.0).await;
        let unrelated_aor =
            create_test_aor(&env.dbx, "Attachment unrelated AOR", 200.0, 300.0)
                .await;
        let child_login = create_login_on_aor(
            &env.dbx,
            "attachment-child-login",
            &["Rer"],
            child_aor.id,
        )
        .await;
        let unrelated_login = create_login_on_aor(
            &env.dbx,
            "attachment-unrelated-login",
            &["Rer"],
            unrelated_aor.id,
        )
        .await;
        let admin_login = create_login_on_aor(
            &env.dbx,
            "attachment-admin-login",
            &["Admin"],
            parent_aor.id,
        )
        .await;
        let unit = mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                name: Set("Attachment test unit".to_string()),
                created_by_login_id: Set(parent_login.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        AccessFixture {
            env,
            unit,
            parent_login_id: parent_login.id,
            child_login_id: child_login.id,
            unrelated_login_id: unrelated_login.id,
            admin_login_id: admin_login.id,
            parent_aor,
            child_aor,
            unrelated_aor,
        }
    }

    async fn insert_attachment_for_aor(
        fixture: &AccessFixture,
        aor_id: i64,
        label: &str,
    ) -> sigint_unit_attachment::Model {
        let attachment = sigint_unit_attachment::ActiveModel {
            unit_id: Set(fixture.unit.id),
            file_name: Set(format!("{label}.txt")),
            content_type: Set("text/plain".to_string()),
            size_bytes: Set(1),
            storage_key: Set(format!(
                "test/unit-attachment/{}",
                uuid::Uuid::now_v7()
            )),
            short_description: Set(format!("{label} short")),
            full_description: Set(format!("{label} full")),
            created_by_login_id: Set(fixture.parent_login_id),
            ..Default::default()
        }
        .insert(&fixture.env.dbx)
        .await
        .unwrap();
        sigint_unit_attachment_aor::ActiveModel {
            attachment_id: Set(attachment.id),
            aor_id: Set(aor_id),
            ..Default::default()
        }
        .insert(&fixture.env.dbx)
        .await
        .unwrap();
        attachment
    }

    #[test]
    fn sanitizes_cross_platform_file_names() {
        assert_eq!(
            sanitize_file_name(r"C:\fake\path\report.pdf").unwrap(),
            "report.pdf"
        );
        assert_eq!(
            sanitize_file_name("../../report.pdf").unwrap(),
            "report.pdf"
        );
        assert_eq!(sanitize_file_name("..").unwrap(), "attachment.bin");
    }

    #[test]
    fn parses_unique_sorted_aor_ids() {
        assert_eq!(parse_aor_ids("[3, 1, 3, 2]").unwrap(), vec![1, 2, 3]);
        assert!(parse_aor_ids("[]").is_err());
        assert!(parse_aor_ids("[0]").is_err());
    }

    #[test]
    fn validates_description_by_characters() {
        assert_eq!(
            validate_description("  line one\nline two  ".to_string(), "x", 20)
                .unwrap(),
            "line one\nline two"
        );
        assert!(validate_description("".to_string(), "x", 20).is_err());
        assert!(validate_description("її".to_string(), "x", 1).is_err());
    }

    #[tokio::test]
    #[serial]
    async fn denies_attachment_to_unrelated_aor() {
        let fixture = access_fixture().await;
        let attachment =
            insert_attachment_for_aor(&fixture, fixture.child_aor.id, "child")
                .await;

        let result = find_visible_attachment(
            &fixture.env.dbx,
            &fixture.unrelated_login_id,
            attachment.id,
        )
        .await;
        assert!(matches!(result, Err(AppError::NotFound)));
        assert!(list_visible_attachments(
            &fixture.env.dbx,
            &fixture.unrelated_login_id,
            fixture.unit.id,
        )
        .await
        .unwrap()
        .is_empty());
        assert!(!list_visible_attachment_unit_ids(
            &fixture.env.dbx,
            &fixture.unrelated_login_id,
            None,
        )
        .await
        .unwrap()
        .contains(&fixture.unit.id));
    }

    #[tokio::test]
    #[serial]
    async fn applies_aor_hierarchy_from_parent_to_child() {
        let fixture = access_fixture().await;
        let child_attachment =
            insert_attachment_for_aor(&fixture, fixture.child_aor.id, "child")
                .await;
        let parent_attachment = insert_attachment_for_aor(
            &fixture,
            fixture.parent_aor.id,
            "parent",
        )
        .await;

        assert_eq!(
            find_visible_attachment(
                &fixture.env.dbx,
                &fixture.parent_login_id,
                child_attachment.id,
            )
            .await
            .unwrap()
            .id,
            child_attachment.id
        );
        assert!(matches!(
            find_visible_attachment(
                &fixture.env.dbx,
                &fixture.child_login_id,
                parent_attachment.id,
            )
            .await,
            Err(AppError::NotFound)
        ));

        let parent_visible = list_visible_attachments(
            &fixture.env.dbx,
            &fixture.parent_login_id,
            fixture.unit.id,
        )
        .await
        .unwrap();
        assert!(parent_visible
            .iter()
            .all(|attachment| attachment.aors.is_none()));
        assert!(parent_visible
            .iter()
            .any(|attachment| attachment.id == child_attachment.id));
        assert!(parent_visible
            .iter()
            .any(|attachment| attachment.id == parent_attachment.id));

        let child_visible = list_visible_attachments(
            &fixture.env.dbx,
            &fixture.child_login_id,
            fixture.unit.id,
        )
        .await
        .unwrap();
        assert!(child_visible
            .iter()
            .any(|attachment| attachment.id == child_attachment.id));
        assert!(!child_visible
            .iter()
            .any(|attachment| attachment.id == parent_attachment.id));
        assert!(list_visible_attachment_unit_ids(
            &fixture.env.dbx,
            &fixture.child_login_id,
            None,
        )
        .await
        .unwrap()
        .contains(&fixture.unit.id));
    }

    #[tokio::test]
    #[serial]
    async fn updates_and_deletes_attachment_metadata() {
        let fixture = access_fixture().await;
        let attachment =
            insert_attachment_for_aor(&fixture, fixture.child_aor.id, "edit")
                .await;

        let updated = update_attachment(
            &fixture.env.dbx,
            UpdateUnitAttachmentReq {
                attachment_id: attachment.id,
                short_description: "updated short".to_string(),
                full_description: "updated full".to_string(),
                aor_ids: vec![fixture.unrelated_aor.id],
            },
        )
        .await
        .unwrap();
        assert_eq!(updated.short_description, "updated short");
        assert_eq!(updated.full_description, "updated full");
        assert_eq!(
            updated.aors.unwrap(),
            vec![UnitAttachmentAor {
                id: fixture.unrelated_aor.id,
                name: fixture.unrelated_aor.name.clone(),
            }]
        );

        let deleted = delete_attachment_record(&fixture.env.dbx, attachment.id)
            .await
            .unwrap();
        assert_eq!(deleted.id, attachment.id);
        assert!(sigint_unit_attachment::Entity::find_by_id(attachment.id)
            .one(&fixture.env.dbx)
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            sigint_unit_attachment_aor::Entity::find()
                .filter(
                    sigint_unit_attachment_aor::Column::AttachmentId
                        .eq(attachment.id),
                )
                .count(&fixture.env.dbx)
                .await
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    #[serial]
    async fn admin_bypasses_aor_but_deleted_scope_is_denied() {
        let fixture = access_fixture().await;
        let attachment = insert_attachment_for_aor(
            &fixture,
            fixture.unrelated_aor.id,
            "unrelated",
        )
        .await;

        assert_eq!(
            find_visible_attachment(
                &fixture.env.dbx,
                &fixture.admin_login_id,
                attachment.id,
            )
            .await
            .unwrap()
            .id,
            attachment.id
        );
        let admin_visible = list_visible_attachments(
            &fixture.env.dbx,
            &fixture.admin_login_id,
            fixture.unit.id,
        )
        .await
        .unwrap();
        assert!(admin_visible.iter().any(|item| item.id == attachment.id));
        assert!(admin_visible.iter().all(|item| item.aors.is_some()));
        assert!(list_visible_attachment_unit_ids(
            &fixture.env.dbx,
            &fixture.admin_login_id,
            None,
        )
        .await
        .unwrap()
        .contains(&fixture.unit.id));
        assert!(list_visible_attachment_unit_ids(
            &fixture.env.dbx,
            &fixture.admin_login_id,
            Some(&[-1]),
        )
        .await
        .unwrap()
        .is_empty());

        let mut unrelated_aor = fixture.unrelated_aor.into_active_model();
        unrelated_aor.deleted = Set(true);
        unrelated_aor.update(&fixture.env.dbx).await.unwrap();
        assert!(matches!(
            find_visible_attachment(
                &fixture.env.dbx,
                &fixture.unrelated_login_id,
                attachment.id,
            )
            .await,
            Err(AppError::NotFound)
        ));

        let mut unit = fixture.unit.into_active_model();
        unit.deleted = Set(true);
        unit.update(&fixture.env.dbx).await.unwrap();
        assert!(matches!(
            find_visible_attachment(
                &fixture.env.dbx,
                &fixture.admin_login_id,
                attachment.id,
            )
            .await,
            Err(AppError::NotFound)
        ));
    }
}
