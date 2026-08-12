use crate::error::AppError;
use crate::h;
use crate::palitra::types::{
    PalitraHighlightBlacklistAddReq, PalitraHighlightBlacklistEntry,
    PalitraName, PalitraResolveNamesReq,
};
use crate::types::{Env, ShortContext};
use crate::users::{ensure_rer_role, login_id_from_identity};
use actix_web::web::{Data, Json, Path};
use actix_web::{delete, get, post};
use sea_orm::ConnectionTrait;

pub(crate) mod bl;
mod query;

pub(crate) use bl::{filter_blacklisted_points, load_blacklisted_labels};
pub(crate) use query::counts_by_palitra_ids;

async fn resolve_accessible_names<C>(
    dbx: &C,
    login: uuid::Uuid,
    requested_ids: &[i64],
) -> Result<Vec<PalitraName>, AppError>
where
    C: ConnectionTrait,
{
    let unique_ids = requested_ids
        .iter()
        .copied()
        .collect::<std::collections::BTreeSet<_>>();
    if unique_ids.len() > crate::config::PALITRA_RESOLVE_NAMES_MAX_IDS {
        return Err(AppError::BL {
            msg: format!(
                "Too many palette IDs; maximum is {}",
                crate::config::PALITRA_RESOLVE_NAMES_MAX_IDS
            ),
        });
    }
    let accessible_ids = super::bl::collect_accessible_palitra_ids(login, dbx)
        .await
        .c(h!())?
        .into_iter()
        .collect::<std::collections::HashSet<_>>();
    let query_ids = unique_ids
        .iter()
        .copied()
        .filter(|id| accessible_ids.contains(id))
        .collect::<Vec<_>>();
    let names = if query_ids.is_empty() {
        std::collections::HashMap::new()
    } else {
        query::resolve_names(dbx, &query_ids)
            .await
            .c(h!())?
            .into_iter()
            .collect::<std::collections::HashMap<_, _>>()
    };
    let mut seen = std::collections::HashSet::new();
    Ok(requested_ids
        .iter()
        .copied()
        .filter(|id| seen.insert(*id))
        .filter_map(|id| {
            names.get(&id).cloned().map(|name| PalitraName { id, name })
        })
        .collect())
}

#[post("/api/palitra/resolve-names")]
pub async fn resolve_palitra_names(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<PalitraResolveNamesReq>,
) -> Result<Json<Vec<PalitraName>>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user).c(h!())?;
    Ok(Json(
        resolve_accessible_names(&env.dbx, login, &req.palitra_ids)
            .await
            .c(h!())?,
    ))
}

#[get("/api/palitra/{palitra_id}/highlight-blacklist")]
pub async fn list_palitra_highlight_blacklist(
    user: actix_identity::Identity,
    env: Data<Env>,
    path: Path<i64>,
) -> Result<Json<Vec<PalitraHighlightBlacklistEntry>>, AppError> {
    let palitra_id = path.into_inner();
    ensure_access(&user, &env, palitra_id).await.c(h!())?;

    Ok(Json(bl::list_entries(&env.dbx, palitra_id).await.c(h!())?))
}

#[post("/api/palitra/{palitra_id}/highlight-blacklist")]
pub async fn add_palitra_highlight_blacklist_entry(
    user: actix_identity::Identity,
    env: Data<Env>,
    path: Path<i64>,
    req: Json<PalitraHighlightBlacklistAddReq>,
) -> Result<Json<PalitraHighlightBlacklistEntry>, AppError> {
    let palitra_id = path.into_inner();
    let login_id = ensure_access(&user, &env, palitra_id).await.c(h!())?;

    Ok(Json(
        bl::add_entry(&env.dbx, palitra_id, login_id, &req.label)
            .await
            .c(h!())?,
    ))
}

#[delete("/api/palitra/{palitra_id}/highlight-blacklist/{blacklist_entry_id}")]
pub async fn delete_palitra_highlight_blacklist_entry(
    user: actix_identity::Identity,
    env: Data<Env>,
    path: Path<(i64, i64)>,
) -> Result<Json<()>, AppError> {
    let (palitra_id, blacklist_entry_id) = path.into_inner();
    ensure_access(&user, &env, palitra_id).await.c(h!())?;

    bl::delete_entry(&env.dbx, palitra_id, blacklist_entry_id)
        .await
        .c(h!())?;
    Ok(Json(()))
}

async fn ensure_access(
    user: &actix_identity::Identity,
    env: &Data<Env>,
    palitra_id: i64,
) -> Result<uuid::Uuid, AppError> {
    ensure_rer_role(&env.dbx, user).await.c(h!())?;
    let login = login_id_from_identity(user).c(h!())?;
    let accessible_palitra_ids =
        super::bl::collect_accessible_palitra_ids(login, &env.dbx)
            .await
            .c(h!())?;
    if !accessible_palitra_ids.contains(&palitra_id) {
        return Err(AppError::Forbidden(
            "Palitra highlight blacklist is not accessible".into(),
        ));
    }
    Ok(login)
}

#[cfg(test)]
mod tests {
    use super::resolve_accessible_names;
    use crate::config::PALITRA_RESOLVE_NAMES_MAX_IDS;
    use crate::entities::{login, palitra, palitra_access_login};
    use crate::functest::tests::{
        cleanup, find_test_login, mk_login, mk_palitra,
    };
    use actix_identity::{Identity, IdentityMiddleware};
    use actix_session::storage::RedisSessionStore;
    use actix_session::SessionMiddleware;
    use actix_web::cookie::Key;
    use actix_web::{
        http::StatusCode, test, web, App, HttpMessage, HttpRequest,
        HttpResponse,
    };
    use chrono::Utc;
    use sea_orm::{ActiveModelTrait, ActiveValue::NotSet, Set};
    use serial_test::serial;

    async fn login_identity(
        request: HttpRequest,
        login: web::Path<String>,
    ) -> HttpResponse {
        Identity::login(&request.extensions(), login.into_inner()).unwrap();
        HttpResponse::NoContent().finish()
    }

    async fn create_palitra(
        dbx: &sea_orm::DatabaseConnection,
        name: &str,
        login_id: Option<uuid::Uuid>,
        deleted: bool,
    ) -> palitra::Model {
        let palitra = mk_palitra(
            dbx,
            palitra::ActiveModel {
                name: Set(name.to_string()),
                hex_legacy: Set(Some("#abcdef".to_string())),
                author_login_id: Set(None),
                deleted: Set(deleted),
                created_at: Set(Utc::now().naive_utc()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        if let Some(login_id) = login_id {
            palitra_access_login::ActiveModel {
                id: NotSet,
                palitra_id: Set(palitra.id),
                login_id: Set(login_id),
                created_at: Set(Utc::now().naive_utc()),
            }
            .insert(dbx)
            .await
            .unwrap();
        }
        palitra
    }

    #[serial]
    #[tokio::test]
    async fn resolve_accessible_names_omits_inaccessible_and_deleted_palitra() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let first =
            create_palitra(&env.dbx, "Resolver first", Some(login.id), false)
                .await;
        let inaccessible =
            create_palitra(&env.dbx, "Resolver hidden", None, false).await;
        let deleted =
            create_palitra(&env.dbx, "Resolver deleted", Some(login.id), true)
                .await;
        let second =
            create_palitra(&env.dbx, "Resolver second", Some(login.id), false)
                .await;

        let names = resolve_accessible_names(
            &env.dbx,
            login.id,
            &[second.id, inaccessible.id, first.id, second.id, deleted.id],
        )
        .await
        .unwrap();

        assert_eq!(
            names
                .into_iter()
                .map(|entry| (entry.id, entry.name))
                .collect::<Vec<_>>(),
            vec![
                (second.id, "Resolver second".to_string()),
                (first.id, "Resolver first".to_string()),
            ],
        );
    }

    #[serial]
    #[tokio::test]
    async fn resolve_accessible_names_rejects_too_many_distinct_ids() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let ids =
            (0..=PALITRA_RESOLVE_NAMES_MAX_IDS as i64).collect::<Vec<_>>();

        assert!(resolve_accessible_names(&env.dbx, login.id, &ids)
            .await
            .is_err());
    }

    #[serial]
    #[actix_web::test]
    async fn resolver_requires_rer_role() {
        let env = cleanup().await.unwrap();
        let login = mk_login(
            &env.dbx,
            login::ActiveModel {
                roles: Set(serde_json::json!([])),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let config = env.config.clone();
        let redis_session_store =
            RedisSessionStore::new(crate::redis_conn_string(&config).unwrap())
                .await
                .unwrap();
        let app = test::init_service(
            App::new()
                .app_data(web::Data::from(env.clone()))
                .wrap(IdentityMiddleware::default())
                .wrap(SessionMiddleware::new(
                    redis_session_store,
                    Key::generate(),
                ))
                .route("/test/login/{login}", web::post().to(login_identity))
                .service(super::resolve_palitra_names),
        )
        .await;
        let login_response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri(&format!("/test/login/{}", login.id))
                .to_request(),
        )
        .await;
        let session_cookie = login_response
            .response()
            .cookies()
            .next()
            .unwrap()
            .into_owned();
        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri("/api/palitra/resolve-names")
                .cookie(session_cookie)
                .set_json(serde_json::json!({ "palitra_ids": [] }))
                .to_request(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
}
