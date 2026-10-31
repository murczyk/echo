use crate::config::ROLE_API;
use crate::entities::{api_sender, login};
use crate::types::*;
use actix_identity::Identity;
use actix_web::{post, web};
use elm_rs::{Elm, ElmDecode, ElmEncode};
use sea_orm::*;

#[derive(Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct ApiSender {
    pub api_id: Uuid,
    pub display_name: String,
    pub sender_uuid: Uuid,
    pub login_id: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct ListApiSendersReq {
    pub api_id: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct UpsertApiSenderReq {
    pub api_id: Uuid,
    pub display_name: String,
    pub sender_uuid: Option<Uuid>,
    pub login_id: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct DeleteApiSenderReq {
    pub api_id: Uuid,
    pub sender_uuid: Uuid,
}

impl From<api_sender::Model> for ApiSender {
    fn from(sender: api_sender::Model) -> Self {
        Self {
            api_id: sender.api_id,
            display_name: sender.display_name,
            sender_uuid: sender.sender_uuid,
            login_id: sender.login_id,
        }
    }
}

async fn list(
    db: &DatabaseConnection,
    api_id: Uuid,
) -> anyhow::Result<Vec<ApiSender>> {
    Ok(api_sender::Entity::find()
        .filter(api_sender::Column::ApiId.eq(api_id))
        .order_by_asc(api_sender::Column::DisplayName)
        .order_by_asc(api_sender::Column::SenderUuid)
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .map(ApiSender::from)
        .collect())
}

#[post("/api/echo-operator/fetch-senders")]
pub async fn fetch_senders(
    user: Identity,
    env: web::Data<Env>,
) -> Result<web::Json<Vec<ApiSender>>, AppError> {
    let api_id = crate::users::login_id_from_identity(&user).c(h!())?;
    crate::users::has_role(&env.dbx, &api_id, ROLE_API)
        .await
        .c(h!())?;
    Ok(web::Json(list(&env.dbx, api_id).await.c(h!())?))
}

#[post("/api/admin/api-senders")]
pub async fn list_senders(
    user: Identity,
    env: web::Data<Env>,
    req: web::Json<ListApiSendersReq>,
) -> Result<web::Json<Vec<ApiSender>>, AppError> {
    crate::users::ensure_admin(&env.dbx, &user).await.c(h!())?;
    Ok(web::Json(list(&env.dbx, req.api_id).await.c(h!())?))
}

async fn save(
    db: &DatabaseConnection,
    req: UpsertApiSenderReq,
) -> anyhow::Result<ApiSender> {
    let display_name = req.display_name.trim();
    if display_name.is_empty() {
        return Err(AppError::BL {
            msg: "Вкажіть ім’я відправника.".to_string(),
        })
        .c(h!());
    }
    let api = login::Entity::find_by_id(req.api_id)
        .filter(login::Column::DeletedPermanently.eq(false))
        .one(db)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
        .c(h!())?;
    let roles: Vec<String> = serde_json::from_value(api.roles).c(h!())?;
    if !roles.iter().any(|role| role == ROLE_API) {
        return Err(AppError::BL {
            msg: "Обраний користувач не має ролі Api.".to_string(),
        })
        .c(h!());
    }
    login::Entity::find_by_id(req.login_id)
        .filter(login::Column::DeletedPermanently.eq(false))
        .one(db)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
        .c(h!())?;
    let mut sender = match req.sender_uuid {
        Some(sender_uuid) => api_sender::Entity::find_by_id(sender_uuid)
            .filter(api_sender::Column::ApiId.eq(req.api_id))
            .one(db)
            .await
            .c(h!())?
            .ok_or(AppError::NotFound)
            .c(h!())?
            .into_active_model(),
        None => api_sender::ActiveModel {
            sender_uuid: Set(Uuid::new_v4()),
            api_id: Set(req.api_id),
            ..Default::default()
        },
    };
    sender.display_name = Set(display_name.to_string());
    sender.login_id = Set(req.login_id);
    let sender = if req.sender_uuid.is_some() {
        sender.update(db).await.c(h!())?
    } else {
        sender.insert(db).await.c(h!())?
    };
    Ok(sender.into())
}

#[post("/api/admin/api-senders/upsert")]
pub async fn upsert_sender(
    user: Identity,
    env: web::Data<Env>,
    req: web::Json<UpsertApiSenderReq>,
) -> Result<web::Json<ApiSender>, AppError> {
    crate::users::ensure_admin(&env.dbx, &user).await.c(h!())?;
    Ok(web::Json(save(&env.dbx, req.into_inner()).await.c(h!())?))
}

#[post("/api/admin/api-senders/delete")]
pub async fn delete_sender(
    user: Identity,
    env: web::Data<Env>,
    req: web::Json<DeleteApiSenderReq>,
) -> Result<web::Json<()>, AppError> {
    crate::users::ensure_admin(&env.dbx, &user).await.c(h!())?;
    api_sender::Entity::delete_many()
        .filter(api_sender::Column::SenderUuid.eq(req.sender_uuid))
        .filter(api_sender::Column::ApiId.eq(req.api_id))
        .exec(&env.dbx)
        .await
        .c(h!())?;
    Ok(web::Json(()))
}

pub(crate) async fn find<C: ConnectionTrait>(
    db: &C,
    api_id: Uuid,
    sender_id: &str,
) -> anyhow::Result<Option<api_sender::Model>> {
    let Ok(sender_uuid) = Uuid::parse_str(sender_id) else {
        return Ok(None);
    };
    api_sender::Entity::find_by_id(sender_uuid)
        .filter(api_sender::Column::ApiId.eq(api_id))
        .one(db)
        .await
        .c(h!())
}

#[cfg(test)]
mod tests;
