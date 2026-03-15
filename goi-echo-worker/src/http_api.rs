use crate::config::Config;
use crate::entities::association;
use actix_web::error::{ErrorInternalServerError, ErrorUnauthorized};
use actix_web::http::header;
use actix_web::{post, web, Error, HttpRequest, HttpResponse};
use anyhow::Context;
use base64::engine::general_purpose::STANDARD as Base64;
use base64::Engine;
use goi_echo_worker::api::{AssociationApiItem, ListAssociationsReq};
use goi_echo_worker::row::AssociationRow;
use sea_orm::{
    ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder,
};

#[derive(Clone)]
pub struct AppState {
    pub db: DatabaseConnection,
    pub config: Config,
}

#[post("/api/associations")]
pub async fn list_associations(
    http_req: HttpRequest,
    state: web::Data<AppState>,
    req: web::Json<ListAssociationsReq>,
) -> Result<HttpResponse, Error> {
    require_basic_auth(&http_req, &state.config)?;

    let mut query =
        association::Entity::find().order_by_asc(association::Column::Id);
    if let Some(since_id) = req.since_id_nonincl {
        query = query.filter(association::Column::Id.gt(since_id));
    }

    let items = query
        .all(&state.db)
        .await
        .context("fetching associations")
        .map_err(ErrorInternalServerError)?
        .into_iter()
        .map(to_api_item)
        .collect::<Result<Vec<_>, _>>()?;

    Ok(HttpResponse::Ok().json(items))
}

fn to_api_item(
    association: association::Model,
) -> Result<AssociationApiItem, Error> {
    let row: AssociationRow = serde_json::from_value(association.row)
        .context("deserializing association row")
        .map_err(ErrorInternalServerError)?;
    Ok(AssociationApiItem {
        id: association.id,
        row,
        created_at: association.created_at.with_timezone(&chrono::Utc),
        deleted: association.deleted,
    })
}

fn require_basic_auth(
    http_req: &HttpRequest,
    config: &Config,
) -> Result<(), Error> {
    let auth_value = http_req
        .headers()
        .get(header::AUTHORIZATION)
        .ok_or_else(|| ErrorUnauthorized("missing authorization header"))?;
    let auth_value = auth_value
        .to_str()
        .map_err(|_| ErrorUnauthorized("invalid authorization header"))?;
    let encoded = auth_value
        .strip_prefix("Basic ")
        .ok_or_else(|| ErrorUnauthorized("unsupported authorization scheme"))?;
    let decoded = Base64
        .decode(encoded)
        .map_err(|_| ErrorUnauthorized("invalid authorization value"))?;
    let decoded = String::from_utf8(decoded)
        .map_err(|_| ErrorUnauthorized("invalid credentials"))?;
    let mut parts = decoded.splitn(2, ':');
    let login = parts.next().unwrap_or_default();
    let password = parts.next().unwrap_or_default();
    if login == config.api_login && password == config.api_password {
        Ok(())
    } else {
        Err(ErrorUnauthorized("invalid credentials"))
    }
}
