use crate::error::AppError;
use crate::h;
use crate::palitra::types::{
    PalitraHighlightBlacklistAddReq, PalitraHighlightBlacklistEntry,
};
use crate::types::{Env, ShortContext};
use crate::users::{ensure_rer_role, login_id_from_identity};
use actix_web::web::{Data, Json, Path};
use actix_web::{delete, get, post};

pub(crate) mod bl;
mod query;

pub(crate) use bl::{filter_blacklisted_points, load_blacklisted_labels};

#[get("/api/palitra/{palitra_id}/highlight-blacklist")]
pub async fn list_palitra_highlight_blacklist(
    user: actix_identity::Identity,
    env: Data<Env>,
    path: Path<i64>,
) -> Result<Json<Vec<PalitraHighlightBlacklistEntry>>, AppError> {
    let palitra_id = path.into_inner();
    ensure_access(&user, &env, palitra_id).await?;

    Ok(Json(bl::list_entries(&env.dbx, palitra_id).await?))
}

#[post("/api/palitra/{palitra_id}/highlight-blacklist")]
pub async fn add_palitra_highlight_blacklist_entry(
    user: actix_identity::Identity,
    env: Data<Env>,
    path: Path<i64>,
    req: Json<PalitraHighlightBlacklistAddReq>,
) -> Result<Json<PalitraHighlightBlacklistEntry>, AppError> {
    let palitra_id = path.into_inner();
    ensure_access(&user, &env, palitra_id).await?;

    Ok(Json(bl::add_entry(&env.dbx, palitra_id, &req.label).await?))
}

#[delete("/api/palitra/{palitra_id}/highlight-blacklist/{blacklist_entry_id}")]
pub async fn delete_palitra_highlight_blacklist_entry(
    user: actix_identity::Identity,
    env: Data<Env>,
    path: Path<(i64, i64)>,
) -> Result<Json<()>, AppError> {
    let (palitra_id, blacklist_entry_id) = path.into_inner();
    ensure_access(&user, &env, palitra_id).await?;

    bl::delete_entry(&env.dbx, palitra_id, blacklist_entry_id).await?;
    Ok(Json(()))
}

async fn ensure_access(
    user: &actix_identity::Identity,
    env: &Data<Env>,
    palitra_id: i64,
) -> Result<(), AppError> {
    ensure_rer_role(&env.dbx, user).await.c(h!())?;
    let login = login_id_from_identity(user)?;
    let accessible_palitra_ids =
        super::bl::collect_accessible_palitra_ids(login, &env.dbx)
            .await
            .c(h!())?;
    if !accessible_palitra_ids.contains(&palitra_id) {
        return Err(AppError::Forbidden(
            "Palitra highlight blacklist is not accessible".into(),
        ));
    }
    Ok(())
}
