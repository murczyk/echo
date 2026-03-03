use crate::config::{ORGANISM_GOI_PATH_DEFAULT, ORGANISM_GOI_SSH_PORT_DEFAULT};
use crate::entities::organism;
use crate::error::AppError;
use crate::organism::types::{
    CheckOrganismGoiConnectionReq, CheckOrganismGoiConnectionRsp,
    OrganismGoiSettings, UpdateOrganismGoiSettingsReq,
};
use crate::types::*;
use crate::utils::string::{
    normalize_optional_trimmed, normalize_trimmed_or_default,
};
use actix_web::post;
use actix_web::web::Json;
use sea_orm::*;

mod goi_ssh;

#[post("/api/organism/goi-settings")]
pub async fn organism_goi_settings(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<i64>,
) -> Result<Json<OrganismGoiSettings>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Admin").await?;

    let organism = organism::Entity::find_by_id(req.into_inner())
        .filter(organism::Column::DeletedPermanently.eq(false))
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;

    Ok(Json(OrganismGoiSettings {
        organism_id: organism.id,
        ssh_host: organism.goi_ssh_host,
        ssh_user: organism.goi_ssh_user,
        ssh_password: organism.goi_ssh_password,
        ssh_port: if organism.goi_ssh_port > 0 {
            organism.goi_ssh_port
        } else {
            ORGANISM_GOI_SSH_PORT_DEFAULT
        },
        path: normalize_trimmed_or_default(
            organism.goi_path,
            ORGANISM_GOI_PATH_DEFAULT,
        ),
    }))
}

#[post("/api/organism/goi-settings/update")]
pub async fn update_organism_goi_settings(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<UpdateOrganismGoiSettingsReq>,
) -> Result<Json<OrganismGoiSettings>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Admin").await?;

    let req = req.into_inner();
    goi_validate_ssh_port(req.ssh_port)?;

    let organism = organism::Entity::find_by_id(req.organism_id)
        .filter(organism::Column::DeletedPermanently.eq(false))
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;

    let mut organism: organism::ActiveModel = organism.into();
    organism.goi_ssh_host = Set(normalize_optional_trimmed(req.ssh_host));
    organism.goi_ssh_user = Set(normalize_optional_trimmed(req.ssh_user));
    organism.goi_ssh_password =
        Set(normalize_optional_trimmed(req.ssh_password));
    organism.goi_ssh_port = Set(req.ssh_port);
    organism.goi_path = Set(normalize_trimmed_or_default(
        req.path,
        ORGANISM_GOI_PATH_DEFAULT,
    ));
    let organism = organism.update(&env.dbx).await.c(h!())?;

    Ok(Json(OrganismGoiSettings {
        organism_id: organism.id,
        ssh_host: organism.goi_ssh_host,
        ssh_user: organism.goi_ssh_user,
        ssh_password: organism.goi_ssh_password,
        ssh_port: organism.goi_ssh_port,
        path: organism.goi_path,
    }))
}

#[post("/api/organism/goi-settings/check-connection")]
pub async fn check_organism_goi_connection(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<CheckOrganismGoiConnectionReq>,
) -> Result<Json<CheckOrganismGoiConnectionRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Admin").await?;

    let req = req.into_inner();
    goi_validate_connection_req(&req)?;

    let listed_entries = tokio::task::spawn_blocking(move || {
        goi_ssh::goi_check_connection_sync(req)
    })
    .await
    .c(h!())?
    .c(h!())?;

    Ok(Json(CheckOrganismGoiConnectionRsp { listed_entries }))
}

pub async fn goi_upload_file(
    req: CheckOrganismGoiConnectionReq,
    remote_file_path: String,
    file_data: Vec<u8>,
) -> anyhow::Result<()> {
    goi_validate_connection_req(&req)?;

    tokio::task::spawn_blocking(move || {
        goi_ssh::goi_upload_file_sync(req, remote_file_path, file_data)
    })
    .await
    .c(h!())??
}

pub async fn goi_delete_file(
    req: CheckOrganismGoiConnectionReq,
    remote_file_path: String,
) -> anyhow::Result<()> {
    goi_validate_connection_req(&req)?;

    tokio::task::spawn_blocking(move || {
        goi_ssh::goi_delete_file_sync(req, remote_file_path)
    })
    .await
    .c(h!())??
}

fn goi_validate_ssh_port(port: i32) -> Result<(), AppError> {
    if (1..=65535).contains(&port) {
        return Ok(());
    }
    Err(AppError::BL {
        msg: format!("invalid SSH port: {port}"),
    })
}

fn goi_validate_connection_req(
    req: &CheckOrganismGoiConnectionReq,
) -> Result<(), AppError> {
    if req.ssh_host.trim().is_empty() {
        return Err(AppError::BL {
            msg: "SSH host is required".to_string(),
        });
    }
    if req.ssh_user.trim().is_empty() {
        return Err(AppError::BL {
            msg: "SSH user is required".to_string(),
        });
    }
    if req.ssh_password.trim().is_empty() {
        return Err(AppError::BL {
            msg: "SSH password is required".to_string(),
        });
    }
    if req.path.trim().is_empty() {
        return Err(AppError::BL {
            msg: "GOI path is required".to_string(),
        });
    }
    goi_validate_ssh_port(req.ssh_port)
}
