use crate::entities::sea_orm_active_enums::SettlementKind;
use crate::entities::{api_integration, login, settlement, tag};
use crate::error::AppError;
use crate::types::*;
use crate::utils::string::normalize_optional_trimmed;
use actix_web::web::Json;
use actix_web::{get, post, HttpResponse};
use chrono::Utc;
use elm_rs::{Elm, ElmDecode, ElmEncode};
use sea_orm::*;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ApiIntegration {
    pub id: i64,
    pub description: Option<String>,
    pub api_user_login_id: String,
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
    pub api_user_login_id: String,
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

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct ApiSettlement {
    pub id: i32,
    pub kind: SettlementKind,
    pub name: String,
    pub territorial_community: Option<String>,
    pub district: Option<String>,
    pub region: Option<String>,
    pub lon: Option<f64>,
    pub lat: Option<f64>,
    pub tag: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct ApiTag {
    pub id: i64,
    pub label: String,
    pub extra: Option<bool>,
    pub ord: Option<f64>,
    pub title: Option<String>,
    pub enabled: bool,
    pub is_palitra: bool,
    pub owner_organism_id: Option<i64>,
}

struct ApiIntegrationValues {
    description: Option<String>,
    api_user_login_id: Uuid,
    has_iggy_connection: bool,
    iggy_url: Option<String>,
    iggy_login: Option<String>,
    iggy_password: Option<String>,
    iggy_inbox_topic: Option<String>,
    iggy_analytics_topic: Option<String>,
    sync_enabled: bool,
}

#[get("/api/1.1/settlements")]
pub async fn list_api_settlements(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<Vec<ApiSettlement>>, AppError> {
    ensure_api_role(&env.dbx, &user).await.c(h!())?;
    let settlements = settlement::Entity::find()
        .order_by_asc(settlement::Column::Id)
        .all(&env.dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(ApiSettlement::from)
        .collect();
    Ok(Json(settlements))
}

#[get("/api/1.1/tags")]
pub async fn list_api_tags(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<Vec<ApiTag>>, AppError> {
    ensure_api_role(&env.dbx, &user).await.c(h!())?;
    let tags = tag::Entity::find()
        .order_by_asc(tag::Column::Id)
        .all(&env.dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(ApiTag::from)
        .collect();
    Ok(Json(tags))
}

async fn ensure_api_role(
    dbx: &DatabaseConnection,
    user: &actix_identity::Identity,
) -> Result<(), AppError> {
    crate::users::has_role(
        dbx,
        &crate::users::login_id_from_identity(user).c(h!())?,
        crate::config::ROLE_API,
    )
    .await
    .c(h!())?;
    Ok(())
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
        let transaction = env.dbx.begin().await.c(h!())?;
        crate::iggy::worker::lock_integration_for_update(&transaction, id)
            .await
            .context(h!())?;
        let api_integration = api_integration::Entity::find_by_id(id)
            .one(&transaction)
            .await
            .c(h!())?
            .ok_or(AppError::NotFound)?;
        let sync_was_enabled = api_integration.sync_enabled;
        let iggy_connection_changed =
            has_iggy_connection_changed(&api_integration, &values);
        if iggy_connection_changed {
            ensure_iggy_topics_for_values(&values).await?;
        }
        let mut api_integration = api_integration.into_active_model();
        apply_values(&mut api_integration, values);
        if api_integration.sync_enabled == Set(true) && !sync_was_enabled {
            api_integration.last_sync_at = Set(Some(Utc::now().naive_utc()));
        }
        if api_integration.sync_enabled == Set(false) || iggy_connection_changed
        {
            api_integration.is_working = Set(false);
        }
        let api_integration =
            api_integration.update(&transaction).await.c(h!())?;
        transaction.commit().await.c(h!())?;
        api_integration
    } else {
        let mut api_integration = api_integration::ActiveModel {
            id: NotSet,
            description: NotSet,
            api_user_login_id: NotSet,
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
        ensure_iggy_topics_for_values(&values).await?;
        apply_values(&mut api_integration, values);
        let api_integration = api_integration.insert(&env.dbx).await.c(h!())?;
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

async fn ensure_iggy_topics_for_values(
    values: &ApiIntegrationValues,
) -> Result<(), AppError> {
    if !values.has_iggy_connection {
        return Ok(());
    }
    info!("Ensuring Iggy topics for API integration settings");
    crate::iggy::ensure_topics_for_all_users(
        values.iggy_url.as_deref().c(h!())?,
        values.iggy_login.as_deref().c(h!())?,
        values.iggy_password.as_deref().c(h!())?,
        &[
            values.iggy_inbox_topic.as_deref().c(h!())?,
            values.iggy_analytics_topic.as_deref().c(h!())?,
        ],
    )
    .await
}

async fn validate_and_normalize(
    dbx: &DatabaseConnection,
    req: &UpsertApiIntegrationReq,
) -> Result<ApiIntegrationValues, AppError> {
    let api_user_login_id =
        required_trimmed(&req.api_user_login_id, "Вкажіть API користувача")?;
    let api_user_login_id =
        Uuid::parse_str(&api_user_login_id).map_err(|_| AppError::BL {
            msg: "Некоректний ID API користувача".to_string(),
        })?;
    ensure_api_user(dbx, &api_user_login_id).await?;
    let sync_enabled = normalize_sync_enabled(
        req.id,
        req.sync_enabled,
        req.has_iggy_connection,
    )?;

    let mut values = ApiIntegrationValues {
        description: normalize_optional_trimmed(req.description.clone()),
        api_user_login_id,
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
    api_user_login_id: &Uuid,
) -> Result<(), AppError> {
    let api_user_login = login::Entity::find_by_id(*api_user_login_id)
        .filter(login::Column::DeletedPermanently.eq(false))
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    let roles: Vec<String> =
        serde_json::from_value(api_user_login.roles).c(h!())?;
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
    api_integration.api_user_login_id = Set(values.api_user_login_id);
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
            api_user_login_id: api_integration.api_user_login_id.to_string(),
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

impl From<settlement::Model> for ApiSettlement {
    fn from(settlement: settlement::Model) -> Self {
        Self {
            id: settlement.id,
            kind: settlement.kind,
            name: settlement.name,
            territorial_community: settlement.territorial_community,
            district: settlement.district,
            region: settlement.region,
            lon: settlement.lon,
            lat: settlement.lat,
            tag: settlement.tag,
        }
    }
}

impl From<tag::Model> for ApiTag {
    fn from(tag: tag::Model) -> Self {
        Self {
            id: tag.id,
            label: tag.label,
            extra: tag.extra,
            ord: tag.ord,
            title: tag.title,
            enabled: tag.enabled,
            is_palitra: tag.is_palitra,
            owner_organism_id: tag.owner_organism_id,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::organism;
    use crate::functest::tests::{
        cleanup_locked, mk_login, mk_organism, mk_tag,
    };
    use actix_identity::IdentityMiddleware;
    use actix_session::{storage::RedisSessionStore, SessionMiddleware};
    use actix_web::{cookie::Key, test as actix_test, web, App, HttpRequest};
    use serial_test::serial;

    async fn start_test_session(
        env: web::Data<Env>,
        request: HttpRequest,
        login_id: web::Path<Uuid>,
    ) -> Result<HttpResponse, AppError> {
        crate::users::start_user_session(
            &env,
            &request,
            login_id.into_inner(),
            &env.dbx,
        )
        .await
        .c(h!())?;
        Ok(HttpResponse::Ok().finish())
    }

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

    #[actix_web::test]
    #[serial]
    async fn reference_dictionaries_are_complete_and_api_only() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let api_login = mk_login(
            &env.dbx,
            login::ActiveModel {
                roles: Set(serde_json::json!([crate::config::ROLE_API])),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let regular_login = mk_login(
            &env.dbx,
            login::ActiveModel {
                roles: Set(serde_json::json!(["Rer"])),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let other_organism = mk_organism(
            &env.dbx,
            organism::ActiveModel {
                name: Set("API reference other organism".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let other_tag = mk_tag(
            &env.dbx,
            tag::ActiveModel {
                label: Set("API reference other tag".to_string()),
                enabled: Set(false),
                owner_organism_id: Set(Some(other_organism.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let settlement = settlement::Entity::find()
            .order_by_asc(settlement::Column::Id)
            .one(&env.dbx)
            .await
            .unwrap()
            .expect("test database must contain the settlement dictionary");
        let settlement_count =
            settlement::Entity::find().count(&env.dbx).await.unwrap();
        let tag_count = tag::Entity::find().count(&env.dbx).await.unwrap();

        let store = RedisSessionStore::new(
            crate::redis_conn_string(&env.config).unwrap(),
        )
        .await
        .unwrap();
        let app = actix_test::init_service(
            App::new()
                .wrap(IdentityMiddleware::default())
                .wrap(SessionMiddleware::new(store, Key::generate()))
                .app_data(web::Data::from(env.clone()))
                .route(
                    "/test/session/{login_id}",
                    web::post().to(start_test_session),
                )
                .service(list_api_settlements)
                .service(list_api_tags),
        )
        .await;

        let response = actix_test::call_service(
            &app,
            actix_test::TestRequest::post()
                .uri(&format!("/test/session/{}", api_login.id))
                .to_request(),
        )
        .await;
        assert!(response.status().is_success());
        let api_cookie =
            response.response().cookies().next().unwrap().into_owned();
        let response = actix_test::call_service(
            &app,
            actix_test::TestRequest::get()
                .uri("/api/1.1/settlements")
                .cookie(api_cookie.clone())
                .to_request(),
        )
        .await;
        assert!(response.status().is_success());
        let settlements: Vec<ApiSettlement> =
            actix_test::read_body_json(response).await;
        assert_eq!(settlements.len() as u64, settlement_count);
        assert!(settlements.iter().any(|entry| entry.id == settlement.id));
        let response = actix_test::call_service(
            &app,
            actix_test::TestRequest::get()
                .uri("/api/1.1/tags")
                .cookie(api_cookie)
                .to_request(),
        )
        .await;
        assert!(response.status().is_success());
        let tags: Vec<ApiTag> = actix_test::read_body_json(response).await;
        assert_eq!(tags.len() as u64, tag_count);
        assert!(tags.iter().any(|entry| {
            entry.id == other_tag.id
                && entry.owner_organism_id == Some(other_organism.id)
                && !entry.enabled
        }));

        let response = actix_test::call_service(
            &app,
            actix_test::TestRequest::post()
                .uri(&format!("/test/session/{}", regular_login.id))
                .to_request(),
        )
        .await;
        assert!(response.status().is_success());
        let regular_cookie =
            response.response().cookies().next().unwrap().into_owned();
        for path in ["/api/1.1/settlements", "/api/1.1/tags"] {
            let response = actix_test::call_service(
                &app,
                actix_test::TestRequest::get()
                    .uri(path)
                    .cookie(regular_cookie.clone())
                    .to_request(),
            )
            .await;
            assert_eq!(
                response.status(),
                actix_web::http::StatusCode::FORBIDDEN
            );
        }
    }
}
