use self::types::*;
use crate::entities::*;
use crate::error::AppError;
use crate::types::*;
use actix_web::post;
use actix_web::web::Json;
use sea_orm::*;

pub mod types;

#[post("/api/sigint/sources")]
pub async fn list_sources(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    _req: Json<()>,
) -> Result<Json<ListSourcesRsp>, AppError> {
    crate::users::has_any_role(
        &env.dbx,
        &crate::users::identity_id(&user)?,
        vec!["Rer", "Api"],
    )
    .await
    .c(h!())?;

    let res = bl_list_sources(&env.dbx).await.context(h!())?;

    Ok(Json(ListSourcesRsp { sources: res }))
}

pub fn render_source(source: &source::Model) -> Result<Source, AppError> {
    Ok(Source {
        id: source.id,
        name: source.name.clone(),
        created_at: source.created_at.and_utc().timestamp_millis(),
    })
}

pub async fn bl_list_sources(
    dbx: &DatabaseConnection,
) -> Result<Vec<Source>, AppError> {
    let sources = source::Entity::find()
        .filter(source::Column::Deleted.eq(false))
        .all(dbx)
        .await
        .c(h!())?;
    let mut res = vec![];
    for source in sources {
        res.push(render_source(&source)?);
    }
    Ok(res)
}
