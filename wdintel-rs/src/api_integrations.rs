use crate::entities::{api_integration, login};
use crate::error::AppError;
use crate::types::*;
use crate::utils::string::normalize_optional_trimmed;
use actix_web::web::Json;
use actix_web::{post, HttpResponse};
use chrono::Utc;
use elm_rs::{Elm, ElmDecode, ElmEncode};
use sea_orm::*;
use serde::{Deserialize, Serialize};

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ApiIntegration {
    pub id: i64,
    pub description: Option<String>,
    pub api_user: String,
    pub has_iggy_connection: bool,
    pub iggy_url: Option<String>,
    pub iggy_login: Option<String>,
    pub iggy_password: Option<String>,
    pub iggy_inbox_topic: Option<String>,
    pub iggy_analytics_topic: Option<String>,
    pub sync_enabled: bool,
    pub last_sync_at_ms: Option<i64>,
    pub is_working: bool,
    pub created_at_ms: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListApiIntegrationsRsp {
    pub items: Vec<ApiIntegration>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UpsertApiIntegrationReq {
    pub id: Option<i64>,
    pub description: Option<String>,
    pub api_user: String,
    pub has_iggy_connection: bool,
    pub iggy_url: Option<String>,
    pub iggy_login: Option<String>,
    pub iggy_password: Option<String>,
    pub iggy_inbox_topic: Option<String>,
    pub iggy_analytics_topic: Option<String>,
    pub sync_enabled: bool,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct DeleteApiIntegrationReq {
    pub id: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct TestIggyConnectionReq {
    pub url: String,
    pub login: String,
    pub password: String,
}

struct ApiIntegrationValues {
    description: Option<String>,
    api_user: String,
    has_iggy_connection: bool,
    iggy_url: Option<String>,
    iggy_login: Option<String>,
    iggy_password: Option<String>,
    iggy_inbox_topic: Option<String>,
    iggy_analytics_topic: Option<String>,
    sync_enabled: bool,
}

#[post("/api/admin/api-integrations")]
pub async fn list_api_integrations(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<ListApiIntegrationsRsp>, AppError> {
    crate::users::ensure_admin(&env.dbx, &user).await?;

    let items = api_integration::Entity::find()
        .order_by_desc(api_integration::Column::CreatedAt)
        .order_by_desc(api_integration::Column::Id)
        .all(&env.dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(ApiIntegration::from)
        .collect();

    Ok(Json(ListApiIntegrationsRsp { items }))
}

#[post("/api/admin/api-integrations/upsert")]
pub async fn upsert_api_integration(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<UpsertApiIntegrationReq>,
) -> Result<Json<ApiIntegration>, AppError> {
    crate::users::ensure_admin(&env.dbx, &user).await?;

    let req = req.into_inner();
    let values = validate_and_normalize(&env.dbx, &req).await?;
    let api_integration = if let Some(id) = req.id {
        let api_integration = api_integration::Entity::find_by_id(id)
            .one(&env.dbx)
            .await
            .c(h!())?
            .ok_or(AppError::NotFound)?;
        let sync_was_enabled = api_integration.sync_enabled;
        let iggy_connection_changed =
            has_iggy_connection_changed(&api_integration, &values);
        let mut api_integration = api_integration.into_active_model();
        apply_values(&mut api_integration, values);
        if api_integration.sync_enabled == Set(true) && !sync_was_enabled {
            api_integration.last_sync_at = Set(Some(Utc::now().naive_utc()));
        }
        if api_integration.sync_enabled == Set(false) || iggy_connection_changed
        {
            api_integration.is_working = Set(false);
        }
        let api_integration = api_integration.update(&env.dbx).await.c(h!())?;
        if iggy_connection_changed {
            ensure_iggy_topics_for_api_integration(&api_integration).await?;
        }
        api_integration
    } else {
        let mut api_integration = api_integration::ActiveModel {
            id: NotSet,
            description: NotSet,
            api_user: NotSet,
            has_iggy_connection: NotSet,
            iggy_url: NotSet,
            iggy_login: NotSet,
            iggy_password: NotSet,
            iggy_inbox_topic: NotSet,
            iggy_analytics_topic: NotSet,
            created_at: NotSet,
            sync_enabled: Set(false),
            last_sync_at: NotSet,
            is_working: NotSet,
        };
        apply_values(&mut api_integration, values);
        let api_integration = api_integration.insert(&env.dbx).await.c(h!())?;
        ensure_iggy_topics_for_api_integration(&api_integration).await?;
        api_integration
    };

    Ok(Json(ApiIntegration::from(api_integration)))
}

#[post("/api/admin/api-integrations/delete")]
pub async fn delete_api_integration(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<DeleteApiIntegrationReq>,
) -> Result<Json<()>, AppError> {
    crate::users::ensure_admin(&env.dbx, &user).await?;

    api_integration::Entity::delete_by_id(req.id)
        .exec(&env.dbx)
        .await
        .c(h!())?;
    Ok(Json(()))
}

#[post("/api/admin/api-integrations/iggy/test-connection")]
pub async fn test_iggy_connection(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<TestIggyConnectionReq>,
) -> Result<HttpResponse, AppError> {
    crate::users::ensure_admin(&env.dbx, &user).await?;

    let req = req.into_inner();
    let url = required_trimmed(&req.url, "Вкажіть Iggy URL")?;
    let login = required_trimmed(&req.login, "Вкажіть Iggy логін")?;
    let password = required_trimmed(&req.password, "Вкажіть Iggy пароль")?;
    crate::iggy::test_connection(&url, &login, &password).await?;
    Ok(HttpResponse::Ok().finish())
}

pub async fn oneoff_ensure_iggy_topics(mode: Mode) -> Result<(), AppError> {
    info!("oneoff_ensure_iggy_topics started");
    let dbx = crate::new_pg_pool_from_mode(mode).await?;
    let api_integrations = api_integration::Entity::find()
        .filter(api_integration::Column::HasIggyConnection.eq(true))
        .order_by_asc(api_integration::Column::Id)
        .all(&dbx)
        .await
        .c(h!())?;

    for api_integration in api_integrations {
        ensure_iggy_topics_for_api_integration(&api_integration).await?;
    }

    info!("oneoff_ensure_iggy_topics completed");
    Ok(())
}

async fn ensure_iggy_topics_for_api_integration(
    api_integration: &api_integration::Model,
) -> Result<(), AppError> {
    if !api_integration.has_iggy_connection {
        return Ok(());
    }
    info!(
        "Ensuring Iggy topics for API integration {}",
        api_integration.id
    );
    crate::iggy::ensure_topics_for_all_users(
        api_integration.iggy_url.as_deref().c(h!())?,
        api_integration.iggy_login.as_deref().c(h!())?,
        api_integration.iggy_password.as_deref().c(h!())?,
        &[
            api_integration.iggy_inbox_topic.as_deref().c(h!())?,
            api_integration.iggy_analytics_topic.as_deref().c(h!())?,
        ],
    )
    .await
}

async fn validate_and_normalize(
    dbx: &DatabaseConnection,
    req: &UpsertApiIntegrationReq,
) -> Result<ApiIntegrationValues, AppError> {
    let api_user = required_trimmed(&req.api_user, "Вкажіть API користувача")?;
    ensure_api_user(dbx, &api_user).await?;
    let sync_enabled = normalize_sync_enabled(
        req.id,
        req.sync_enabled,
        req.has_iggy_connection,
    )?;

    let mut values = ApiIntegrationValues {
        description: normalize_optional_trimmed(req.description.clone()),
        api_user,
        has_iggy_connection: req.has_iggy_connection,
        iggy_url: None,
        iggy_login: None,
        iggy_password: None,
        iggy_inbox_topic: None,
        iggy_analytics_topic: None,
        sync_enabled,
    };
    if req.has_iggy_connection {
        values.iggy_url = Some(required_optional_trimmed(
            &req.iggy_url,
            "Вкажіть Iggy URL",
        )?);
        values.iggy_login = Some(required_optional_trimmed(
            &req.iggy_login,
            "Вкажіть Iggy логін",
        )?);
        values.iggy_password = Some(required_optional_trimmed(
            &req.iggy_password,
            "Вкажіть Iggy пароль",
        )?);
        values.iggy_inbox_topic = Some(required_optional_trimmed(
            &req.iggy_inbox_topic,
            "Вкажіть тему Iggy для вхідних повідомлень",
        )?);
        values.iggy_analytics_topic = Some(required_optional_trimmed(
            &req.iggy_analytics_topic,
            "Вкажіть тему Iggy для аналітичної інформації",
        )?);
    }
    Ok(values)
}

fn normalize_sync_enabled(
    id: Option<i64>,
    sync_enabled: bool,
    has_iggy_connection: bool,
) -> Result<bool, AppError> {
    let sync_enabled = id.is_some() && sync_enabled;
    if sync_enabled && !has_iggy_connection {
        return Err(AppError::BL {
            msg: "Синхронізація потребує підключення до Iggy".to_string(),
        });
    }
    Ok(sync_enabled)
}

async fn ensure_api_user(
    dbx: &DatabaseConnection,
    api_user: &str,
) -> Result<(), AppError> {
    let api_user = login::Entity::find_by_id(api_user)
        .filter(login::Column::DeletedPermanently.eq(false))
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    let roles: Vec<String> = serde_json::from_value(api_user.roles).c(h!())?;
    if !roles.iter().any(|role| role == "Api") {
        return Err(AppError::BL {
            msg: "Обраний користувач не має ролі Api".to_string(),
        });
    }
    Ok(())
}

fn required_optional_trimmed(
    value: &Option<String>,
    message: &str,
) -> Result<String, AppError> {
    normalize_optional_trimmed(value.clone()).ok_or_else(|| AppError::BL {
        msg: message.to_string(),
    })
}

fn required_trimmed(value: &str, message: &str) -> Result<String, AppError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(AppError::BL {
            msg: message.to_string(),
        });
    }
    Ok(value.to_string())
}

fn apply_values(
    api_integration: &mut api_integration::ActiveModel,
    values: ApiIntegrationValues,
) {
    api_integration.description = Set(values.description);
    api_integration.api_user = Set(values.api_user);
    api_integration.has_iggy_connection = Set(values.has_iggy_connection);
    api_integration.iggy_url = Set(values.iggy_url);
    api_integration.iggy_login = Set(values.iggy_login);
    api_integration.iggy_password = Set(values.iggy_password);
    api_integration.iggy_inbox_topic = Set(values.iggy_inbox_topic);
    api_integration.iggy_analytics_topic = Set(values.iggy_analytics_topic);
    api_integration.sync_enabled = Set(values.sync_enabled);
}

fn has_iggy_connection_changed(
    api_integration: &api_integration::Model,
    values: &ApiIntegrationValues,
) -> bool {
    api_integration.has_iggy_connection != values.has_iggy_connection
        || api_integration.iggy_url != values.iggy_url
        || api_integration.iggy_login != values.iggy_login
        || api_integration.iggy_password != values.iggy_password
        || api_integration.iggy_inbox_topic != values.iggy_inbox_topic
        || api_integration.iggy_analytics_topic != values.iggy_analytics_topic
}

impl From<api_integration::Model> for ApiIntegration {
    fn from(api_integration: api_integration::Model) -> Self {
        Self {
            id: api_integration.id,
            description: api_integration.description,
            api_user: api_integration.api_user,
            has_iggy_connection: api_integration.has_iggy_connection,
            iggy_url: api_integration.iggy_url,
            iggy_login: api_integration.iggy_login,
            iggy_password: api_integration.iggy_password,
            iggy_inbox_topic: api_integration.iggy_inbox_topic,
            iggy_analytics_topic: api_integration.iggy_analytics_topic,
            sync_enabled: api_integration.sync_enabled,
            last_sync_at_ms: api_integration
                .last_sync_at
                .map(|last_sync_at| last_sync_at.and_utc().timestamp_millis()),
            is_working: api_integration.is_working,
            created_at_ms: api_integration.created_at.timestamp_millis(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn synchronization_is_disabled_for_new_integration() {
        assert!(!normalize_sync_enabled(None, true, true).unwrap());
    }

    #[test]
    fn synchronization_requires_iggy_connection() {
        assert!(normalize_sync_enabled(Some(1), true, false).is_err());
    }

    #[test]
    fn synchronization_can_be_enabled_for_existing_integration() {
        assert!(normalize_sync_enabled(Some(1), true, true).unwrap());
    }
}
