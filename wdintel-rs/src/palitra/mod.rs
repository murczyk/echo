use crate::config::PALITRA_STORAGE_DIR_NAME;
use crate::entities::*;
use crate::error::AppError;
use crate::h;
use crate::palitra::types::*;
use crate::types::*;
use crate::utils::multipart;
use actix_multipart::Multipart;
use actix_web::post;
use actix_web::web::{Data, Json};
use anyhow::{bail, Context};
use chrono::Utc;
use itertools::Itertools;
use sea_orm::*;

mod bl;
mod kmz;
pub mod types;

#[derive(Clone)]
struct UserScope {
    organism_ids: Vec<i64>,
    aor_ids: Vec<i64>,
}

#[post("/api/palitra/upload-points/{palitra_id}")]
pub async fn upload_palitra_points(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    path: actix_web::web::Path<i64>,
    mut payload: Multipart,
) -> Result<Json<()>, AppError> {
    let login = user.id().c(h!())?;
    let scope = load_user_scope(&env.dbx, &login).await.c(h!())?;
    let palitra_id = path.into_inner();
    let palitra = palitra::Entity::find_by_id(palitra_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .c(h!())?;
    let is_admin = crate::users::has_role(&env.dbx, &login, "Admin")
        .await
        .is_ok();
    if !is_admin {
        match &palitra.author {
            Some(author) if author == &login => {}
            _ => {
                return Err(AppError::Forbidden(
                    "Only author or Admin may upload palitra points".into(),
                ));
            }
        }
    }
    let existing_access =
        read_palitra_access(&env.dbx, palitra_id).await.c(h!())?;
    ensure_palitra_permissions(&env, &login, &existing_access, &scope)
        .await
        .c(h!())?;

    let (field, val) = multipart::extract(&mut payload).await.c(h!())?;
    let filename = field.name().c(h!())?.to_string();
    let storage_dir = ensure_storage_dir(&env).await.c(h!())?;
    let points = kmz::load_coordinates_from_file(
        filename.clone(),
        val,
        storage_dir.as_path(),
    )
    .await
    .c(h!())?;
    let txn = env.dbx.begin().await.c(h!())?;

    let palitra_id = palitra.id;
    let mut model = palitra.into_active_model();
    model.source_file_name = Set(Some(filename));
    model.update(&env.dbx).await.c(h!())?;

    bl::rewrite_palitra_points(palitra_id, points, &txn)
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(Json(()))
}

async fn ensure_storage_dir(env: &Data<Env>) -> anyhow::Result<PathBuf> {
    let storage_dir = PathBuf::from(env.config.storage_dir.clone())
        .join(PALITRA_STORAGE_DIR_NAME)
        .join(format!("{}", Utc::now().naive_utc().date()));
    tokio::fs::create_dir_all(storage_dir.as_path())
        .await
        .c(h!())?;
    Ok(storage_dir)
}

async fn ensure_palitra_permissions(
    env: &Data<Env>,
    login: &str,
    access: &PalitraAccess,
    scope: &UserScope,
) -> anyhow::Result<()> {
    let is_empty = match access {
        PalitraAccess::ByLogins { logins } => logins.is_empty(),
        PalitraAccess::ByOrganisms { organism_ids } => organism_ids.is_empty(),
        PalitraAccess::ByAor { aor_ids } => aor_ids.is_empty(),
    };
    if is_empty {
        bail!("Palitra access list may not be empty");
    }

    let is_admin = crate::users::has_role(&env.dbx, login, "Admin")
        .await
        .is_ok();
    let is_editor = crate::users::has_any_role(
        &env.dbx,
        login,
        vec!["UnitsEditor", "CallsignsEditor"],
    )
    .await
    .is_ok();

    let is_rer = crate::users::has_role(&env.dbx, login, "Rer").await.is_ok();

    match access {
        PalitraAccess::ByLogins { logins } => {
            if is_admin {
                return Ok(());
            }
            if is_editor {
                // Editor can only manage palitra scoped to own login
                let all_self = logins.iter().all(|l| l == login);
                if !all_self {
                    bail!("Editor may only manage palitra scoped to own login");
                }
                return Ok(());
            }
            if !is_rer {
                bail!("Only Rer may manage login-scoped palitra");
            }
            let all_self = logins.iter().all(|l| l == login);
            if !all_self {
                bail!("Rer may only manage palitra scoped to own login");
            }
        }
        PalitraAccess::ByOrganisms { organism_ids } => {
            if is_admin {
                return Ok(());
            }
            if is_editor {
                // Editor can only manage palitra scoped to own organisms
                let permitted: Vec<_> = scope.organism_ids.to_vec();
                let all_known =
                    organism_ids.iter().all(|id| permitted.contains(id));
                if !all_known {
                    bail!(
                        "Editor may only manage palitra scoped to own organism"
                    );
                }
                return Ok(());
            }
            if !is_rer {
                bail!("Only Rer may manage organism-scoped palitra");
            }
            let permitted: Vec<_> = scope.organism_ids.to_vec();
            let all_known =
                organism_ids.iter().all(|id| permitted.contains(id));
            if !all_known {
                bail!("Rer may only manage palitra scoped to own organism");
            }
        }
        PalitraAccess::ByAor { aor_ids } => {
            if is_admin {
                return Ok(());
            }
            if !is_editor {
                bail!("Only Editor/Admin may manage AOR-scoped palitra");
            }
            let permitted: Vec<_> = scope.aor_ids.to_vec();
            let all_known = aor_ids.iter().all(|id| permitted.contains(id));
            if !all_known {
                bail!("Editor may only manage palitra scoped to own AOR");
            }
        }
    };
    Ok(())
}

async fn load_user_scope(
    dbx: &DatabaseConnection,
    login: &str,
) -> anyhow::Result<UserScope> {
    let organism_aors = organism_aor::Entity::find()
        .join(JoinType::InnerJoin, organism_aor::Relation::Organism.def())
        .join(JoinType::InnerJoin, organism::Relation::Login.def())
        .filter(login::Column::Login.eq(login.to_string()))
        .all(dbx)
        .await
        .c(h!())?;
    let organism_ids =
        organism_aors.iter().map(|o| o.organism_id).collect_vec();
    let aor_ids = organism_aors.iter().map(|o| o.aor_id).collect_vec();
    Ok(UserScope {
        organism_ids,
        aor_ids,
    })
}

async fn read_palitra_access(
    dbx: &DatabaseConnection,
    palitra_id: i64,
) -> anyhow::Result<PalitraAccess> {
    let logins = bl::collect_palitra_access_logins(dbx, palitra_id)
        .await
        .c(h!())?;
    let organism_ids = bl::collect_palitra_access_organisms(dbx, palitra_id)
        .await
        .c(h!())?;
    let aor_ids = bl::collect_palitra_access_aors(dbx, palitra_id)
        .await
        .c(h!())?;
    pick_access(logins, organism_ids, aor_ids)
}

fn pick_access(
    logins: Vec<String>,
    organism_ids: Vec<i64>,
    aor_ids: Vec<i64>,
) -> anyhow::Result<PalitraAccess> {
    if !logins.is_empty() {
        return Ok(PalitraAccess::ByLogins { logins });
    }
    if !organism_ids.is_empty() {
        return Ok(PalitraAccess::ByOrganisms { organism_ids });
    }
    if !aor_ids.is_empty() {
        return Ok(PalitraAccess::ByAor { aor_ids });
    }
    bail!("Palitra must have explicit access scope");
}

#[post("/api/palitra/list")]
pub async fn list_all_palitras(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<Vec<Palitra>>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .context(h!())?;
    let palitra = bl::list_all_palitras(login, &env.dbx).await.context(h!())?;
    Ok(Json(palitra))
}

#[post("/api/palitra/list-detailed")] // TODO implement filter
pub async fn list_all_palitras_detailed(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<Vec<PalitraDetails>>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .context(h!())?;
    let palitra = bl::list_all_palitras_detailed(login, &env.dbx)
        .await
        .context(h!())?;
    Ok(Json(palitra))
}

#[post("/api/palitra/create")]
pub async fn create_palitra(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<CreatePalitraReq>,
) -> Result<Json<Palitra>, AppError> {
    let login = user.id().c(h!())?;
    let req = req.into_inner();
    let scope = load_user_scope(&env.dbx, &login).await.c(h!())?;
    ensure_palitra_permissions(&env, &login, &req.access, &scope)
        .await
        .c(h!())?;
    let palitra = bl::create_palitra(login, req, &env.dbx)
        .await
        .context(h!())?;
    Ok(Json(palitra))
}

#[post("/api/palitra/update/{palitra_id}")]
pub async fn update_palitra(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<CreatePalitraReq>,
    path: actix_web::web::Path<i64>,
) -> Result<Json<PalitraDetails>, AppError> {
    let login = user.id().c(h!())?;
    let req = req.into_inner();
    let scope = load_user_scope(&env.dbx, &login).await.c(h!())?;
    ensure_palitra_permissions(&env, &login, &req.access, &scope)
        .await
        .c(h!())?;
    let palitra_id = path.into_inner();
    let txn = (env.dbx).begin().await.c(h!())?;
    let palitra = palitra::Entity::find_by_id(palitra_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .c(h!())?;
    let is_admin = crate::users::has_role(&env.dbx, &login, "Admin")
        .await
        .is_ok();
    if !is_admin {
        match &palitra.author {
            Some(author) if author == &login => {}
            _ => {
                return Err(AppError::Forbidden(
                    "Only author or Admin may update palitra".into(),
                ));
            }
        }
    }

    let existing_access =
        read_palitra_access(&env.dbx, palitra_id).await.c(h!())?;
    ensure_palitra_permissions(&env, &login, &existing_access, &scope)
        .await
        .c(h!())?;
    let result = bl::update_palitra(palitra.id, req, &txn).await.c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(Json(result))
}

#[post("/api/palitra/delete/{palitra_id}")]
pub async fn delete_palitra(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    path: actix_web::web::Path<i64>,
) -> Result<Json<()>, AppError> {
    let login = user.id().c(h!())?;
    let scope = load_user_scope(&env.dbx, &login).await.c(h!())?;
    let palitra_id = path.into_inner();
    let txn = (env.dbx).begin().await.c(h!())?;
    let palitra = palitra::Entity::find_by_id(palitra_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .c(h!())?;
    let is_admin = crate::users::has_role(&env.dbx, &login, "Admin")
        .await
        .is_ok();
    if !is_admin {
        match &palitra.author {
            Some(author) if author == &login => {}
            _ => {
                return Err(AppError::Forbidden(
                    "Only author or Admin may delete palitra".into(),
                ));
            }
        }
    }
    let existing_access =
        read_palitra_access(&env.dbx, palitra_id).await.c(h!())?;
    ensure_palitra_permissions(&env, &login, &existing_access, &scope)
        .await
        .c(h!())?;
    bl::delete_palitra(palitra.id, &txn).await.c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(Json(()))
}
