use crate::entities::{login, user_settings};
use crate::error::AppError;
use crate::h;
use crate::types::Env;
use crate::types::ShortContext;
use actix_identity::Identity;
use actix_web::web::{Data, Json};
use actix_web::{get, put};
use chrono::Utc;
use sea_orm::{
    sea_query::OnConflict, ActiveValue::Set, ColumnTrait, DatabaseConnection,
    EntityTrait, QueryFilter,
};

#[get("/api/user/settings")]
pub async fn user_settings_get(
    env: Data<Env>,
    user: Identity,
) -> Result<Json<serde_json::Value>, AppError> {
    let login_id = user.id().c(h!())?;
    load_login(&env.dbx, &login_id).await?;
    let row = user_settings::Entity::find_by_id(login_id)
        .one(&env.dbx)
        .await
        .c(h!())?;
    let prefs: serde_json::Value = match row {
        Some(m) => m.prefs,
        None => serde_json::json!({}),
    };
    Ok(Json(prefs))
}

#[put("/api/user/settings")]
pub async fn user_settings_put(
    env: Data<Env>,
    user: Identity,
    req: Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, AppError> {
    let login_id = user.id().c(h!())?;
    load_login(&env.dbx, &login_id).await?;
    let prefs = req.into_inner();
    if !prefs.is_object() {
        return Err(AppError::BL {
            msg: "body must be a JSON object".to_string(),
        });
    }
    let now = Utc::now().naive_utc();
    user_settings::Entity::insert(user_settings::ActiveModel {
        login: Set(login_id),
        prefs: Set(prefs.clone()),
        updated_at: Set(now),
    })
    .on_conflict(
        OnConflict::column(user_settings::Column::Login)
            .update_columns([
                user_settings::Column::Prefs,
                user_settings::Column::UpdatedAt,
            ])
            .to_owned(),
    )
    .exec(&env.dbx)
    .await
    .c(h!())?;
    Ok(Json(prefs))
}

async fn load_login(
    dbx: &DatabaseConnection,
    login_id: &str,
) -> Result<(), AppError> {
    login::Entity::find()
        .filter(login::Column::Login.eq(login_id))
        .filter(login::Column::DeletedPermanently.eq(false))
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    Ok(())
}
