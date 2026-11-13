use crate::config::ROLE_CYBER_VIEWER_RESTRICTED;
use crate::sigint::callsign::bl_network_callsign::*;
use crate::sigint::callsign::ensure_callsign_write_role;
use crate::sigint::callsign::types::*;
use crate::types::*;
use crate::users::{ensure_base_role, has_any_role, login_id_from_identity};
use actix_web::post;
use actix_web::web::Json;
use sea_orm::*;

/// Отримання списку прив'язаних до мережі позивних
///
/// # API URL
/// - POST: /api/sigint/network-callsigns/list
///
/// # Параметри
///
/// * `user`: [`actix_identity::Identity`] - Ідентифікатор користувача, що виконує запит. Використовується для перевірки дозволів.
/// * `env`: [`actix_web::web::Data<Env>`] - де [`Env`] Середовище програми, що містить конфігурацію та підключення до бази даних.
/// * `req`: [`Json<ListNetworkCallsignsReq>`] - де [`ListNetworkCallsignsReq`] Тіло запиту, що містить параметри для вибору мережі сортування списку позивних.
///
/// # Повертає
///
/// [`Json<ListNetworkCallsignsRes>`], де [`ListNetworkCallsignsRes`] тип що містить список [`NetworkCallsign`] - структура, що представляє один прив'язаний до мережі позивний.
///
#[post("/api/sigint/network-callsigns/list")]
pub async fn list_network_callsigns(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ListNetworkCallsignsReq>,
) -> Result<Json<ListNetworkCallsignsRes>, AppError> {
    has_any_role(
        &env.dbx,
        &login_id_from_identity(&user)?,
        vec!["Rer", ROLE_CYBER_VIEWER_RESTRICTED, "Api", "ApiAgent"],
    )
    .await
    .c(h!())?;
    let user_id = login_id_from_identity(&user)?;

    trace!("network_callsigns; login: {user_id}; req: {:?}", req);
    let req = req.into_inner();
    let network =
        crate::sigint::network::bl::find_network(&env.dbx, req.network_id)
            .await
            .context(h!())?;
    if req.include_activity_info == Some(false) {
        let network_callsigns = bl_get_network_callsigns_list_without_activity(
            &req, &user_id, &env.dbx,
        )
        .await
        .context(h!())?;
        return Ok(Json(ListNetworkCallsignsRes { network_callsigns }));
    }
    let groups =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &user_id)
            .await
            .context(h!())?;
    let source_db = env.dbx.clone();
    let period = crate::sigint::network::resolve_network_callsign_period(
        req.period.clone(),
    );
    let period_filter = crate::sigint::network::network_callsign_period_filter(
        &network, &period,
    );
    let activity_required = period_filter.is_some();
    let analytics_groups = groups.clone();
    let analytics_req = req.clone();
    let postgres_req = req.clone();
    let res = crate::rer_importer::analysis::with_analytics_read_fallback(
        &env,
        "network callsigns assigned list",
        true,
        move |analytics_db| async move {
            let activity_info =
                crate::sigint::network::analytics::load_network_callsign_activity(
                    &source_db,
                    &analytics_db,
                    &analytics_groups,
                    analytics_req.network_id,
                    &period,
                )
                .await
                .context(h!())?;
            Ok(bl_get_network_callsigns_list_with_activity_info(
                &analytics_req,
                &user_id,
                &source_db,
                activity_info,
                activity_required,
            )
            .await
            .context(h!())?)
        },
        move |postgres_db| async move {
            if let Some(period_filter) = period_filter.as_ref() {
                Ok(bl_get_network_callsigns_list_with_activity_period(
                    &postgres_req,
                    &user_id,
                    &postgres_db,
                    period_filter,
                )
                .await
                .context(h!())?)
            } else {
                Ok(bl_get_network_callsigns_list(
                    &postgres_req,
                    &user_id,
                    &postgres_db,
                )
                .await
                .context(h!())?)
            }
        },
    )
    .await
    .context(h!())?;

    Ok(Json(ListNetworkCallsignsRes {
        network_callsigns: res,
    }))
}

/// Створення нового позивного прив'язаного до мережі
///
///  Якщо для мережі вказано підрозділ, то позивний буде створено як прив'язаний до підрозділу.
///  а в таблиці `sigint_network_callsign` буде створено запис з посиланням на цей позивний.
///
/// # API URL
/// - POST: /api/sigint/network-callsign/create
///
/// # Параметри
///
/// * `user`: [`actix_identity::Identity`] - Ідентифікатор користувача, що виконує запит. Використовується для перевірки дозволів.
/// * `env`: [`actix_web::web::Data<Env>`] - де [`Env`] Середовище програми, що містить конфігурацію та підключення до бази даних.
/// * `req`: [`Json<CreateNetworkCallsignReq>`] - де [`CreateNetworkCallsignReq`] Тіло запиту, що містить параметри створення нового позивного прив'язаного до мережі.
///
/// # Повертає
///
/// [`Json<NetworkCallsign>`], де [`NetworkCallsign`] - структура, що представляє один прив'язаний до мережі позивний.
///
#[post("/api/sigint/network-callsign/create")]
pub async fn create_network_callsign(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<CreateNetworkCallsignReq>,
) -> Result<Json<NetworkCallsign>, AppError> {
    ensure_callsign_write_role(&env.dbx, &user, "UnitsEditor")
        .await
        .context(h!())?;
    let user_id = login_id_from_identity(&user)?;

    info!(
        "Adding callsign {} to network {}; user={}",
        req.callsign, req.network_id, user_id
    );

    let txn = env.dbx.begin().await.context(h!())?;
    let req = req.into_inner();

    let network_callsign_id = bl_create_network_callsign(&req, &user_id, &txn)
        .await
        .context(h!())?;

    txn.commit().await.context(h!())?;

    let res = bl_get_network_callsigns_info_batch(
        &env.dbx,
        &user_id,
        req.network_id,
        vec![network_callsign_id],
    )
    .await
    .context(h!())?
    .into_iter()
    .next()
    .ok_or(AppError::NotFound)?;

    crate::sigint::network::fanout_network_changed(&env).await?;

    Ok(Json(res))
}

/// Створення нового позивного прив'язаного до мережі, на основі вже існуючого прив'язаного (до підрозділу) позивного
///
/// # API URL
/// - POST: /api/sigint/network-callsign/add-as-known
///
/// # Параметри
///
/// * `user`: [`actix_identity::Identity`] - Ідентифікатор користувача, що виконує запит. Використовується для перевірки дозволів.
/// * `env`: [`actix_web::web::Data<Env>`] - де [`Env`] Середовище програми, що містить конфігурацію та підключення до бази даних.
/// * `req`: [`Json<AddAsKnownNetworkCallsignReq>`] - де [`AddAsKnownNetworkCallsignReq`] Тіло запиту, що містить параметри створення
///    нового позивного прив'язаного до мережі, на основі вже існуючого прив'язаного (до підрозділу) позивного.
///
/// # Повертає
///
/// [`Json<NetworkCallsign>`], де [`NetworkCallsign`] - структура, що представляє один прив'язаний до мережі позивний.
///
#[post("/api/sigint/network-callsign/add-as-known")]
pub async fn add_as_known_network_callsigns(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AddAsKnownNetworkCallsignReq>,
) -> Result<Json<Vec<NetworkCallsign>>, AppError> {
    ensure_callsign_write_role(&env.dbx, &user, "UnitsEditor")
        .await
        .context(h!())?;
    let user_id = login_id_from_identity(&user)?;

    info!(
        "Adding known network callsigns {} to network {}; user={}",
        req.known_callsign_ids.len(),
        req.network_id,
        user_id
    );

    let txn = env.dbx.begin().await.context(h!())?;
    let network_callsign_ids = bl_add_as_known_network_callsigns(
        req.network_id,
        req.known_callsign_ids.clone(),
        &user_id,
        &txn,
    )
    .await
    .context(h!())?;
    txn.commit().await.context(h!())?;

    let res = bl_get_network_callsigns_info_batch(
        &env.dbx,
        &user_id,
        req.network_id,
        network_callsign_ids,
    )
    .await
    .context(h!())?;

    crate::sigint::network::fanout_network_changed(&env).await?;

    Ok(Json(res))
}

/// Редагування позивного прив'язаного до мережі
///
/// # API URL
/// - POST: /api/sigint/network-callsign/update
///
/// # Параметри
///
/// * `user`: [`actix_identity::Identity`] - Ідентифікатор користувача, що виконує запит. Використовується для перевірки дозволів.
/// * `env`: [`actix_web::web::Data<Env>`] - де [`Env`] Середовище програми, що містить конфігурацію та підключення до бази даних.
/// * `req`: [`Json<UpdateNetworkCallsignReq>`] - де [`UpdateNetworkCallsignReq`] Тіло запиту, що містить параметри для редагування позивного прив'язаного до мережі.
///
/// # Повертає
///
/// [`Json<NetworkCallsign>`], де [`NetworkCallsign`] - структура, що представляє один прив'язаний до мережі позивний.
///
#[post("/api/sigint/network-callsign/update")]
pub async fn update_network_callsign(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<UpdateNetworkCallsignReq>,
) -> Result<Json<NetworkCallsign>, AppError> {
    ensure_callsign_write_role(&env.dbx, &user, "UnitsEditor")
        .await
        .context(h!())?;
    let user_id = login_id_from_identity(&user)?;

    info!(
        "Updating callsign {} in network {}; user={}",
        req.callsign, req.network_id, user_id
    );

    let txn = env.dbx.begin().await.context(h!())?;
    let req = req.into_inner();

    let network_callsign_id = bl_update_network_callsign(&req, &user_id, &txn)
        .await
        .context(h!())?;
    txn.commit().await.context(h!())?;

    let res = bl_get_network_callsigns_info_batch(
        &env.dbx,
        &user_id,
        req.network_id,
        vec![network_callsign_id],
    )
    .await
    .context(h!())?
    .into_iter()
    .next()
    .ok_or(AppError::NotFound)?;

    crate::sigint::network::fanout_network_changed(&env).await?;

    Ok(Json(res))
}

/// Видалення позивного прив'язаного до мережі
///
/// # API URL
/// - POST: /api/sigint/network-callsign/update
///
/// # Параметри
///
/// * `user`: [`actix_identity::Identity`] - Ідентифікатор користувача, що виконує запит. Використовується для перевірки дозволів.
/// * `env`: [`actix_web::web::Data<Env>`] - де [`Env`] Середовище програми, що містить конфігурацію та підключення до бази даних.
/// * `req`: [`Json<i64>`] - де [`i64`] ідентифікатор позивного прив'язаного до мережі, що має бути видалений.
///
/// # Повертає
///
/// [`Json<NetworkCallsign>`], де [`NetworkCallsign`] - структура, що представляє один прив'язаний до мережі позивний.
///  Видалений позивний буде позначено як active = false, але не буде видалено з бази даних.
///
#[post("/api/sigint/network-callsign/delete")]
pub async fn delete_network_callsign(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<i64>,
) -> Result<Json<NetworkCallsign>, AppError> {
    ensure_callsign_write_role(&env.dbx, &user, "UnitsEditor")
        .await
        .c(h!())?;
    let user_id = login_id_from_identity(&user)?;

    info!("Delete network callsign; login: {user_id}; req: {:?}", req);
    let txn = env.dbx.begin().await.context(h!())?;
    let req = req.into_inner();

    let network_callsign = bl_delete_network_callsign(req, &user_id, &txn)
        .await
        .context(h!())?;
    txn.commit().await.context(h!())?;

    let res = bl_get_network_callsigns_info_batch(
        &env.dbx,
        &user_id,
        network_callsign.sigint_network_id,
        vec![network_callsign.id],
    )
    .await
    .context(h!())?
    .into_iter()
    .next()
    .ok_or(AppError::NotFound)?;

    Ok(Json(res))
}

/// Для списку позивних і заданої мережі повертає активності цих позивних в етері на частотах мережі
///
/// # API URL
/// - POST: /api/sigint/network-callsigns/activity
///
/// # Параметри
///
/// * `user`: [`actix_identity::Identity`] - Ідентифікатор користувача, що виконує запит. Використовується для перевірки дозволів.
/// * `env`: [`actix_web::web::Data<Env>`] - де [`Env`] Середовище програми, що містить конфігурацію та підключення до бази даних.
/// * `req`: [`Json<NetworkCallsignsActivityReq>`] - де [`NetworkCallsignsActivityReq`] Тіло запиту, що містить ідентифікатор мережі та список позивних для перевірки їх активності.
///
/// # Повертає
///
/// [`Json<NetworkCallsignsActivityRsp>`], де [`NetworkCallsignsActivityRsp`] тип що містить список [`CallsignActivityItem`] - структура, що представляє статистику по активності одного позивного
///
#[post("/api/sigint/network-callsigns/activity")]
pub async fn network_callsigns_activity(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<NetworkCallsignsActivityReq>,
) -> Result<Json<NetworkCallsignsActivityRsp>, AppError> {
    ensure_base_role(&env.dbx, &user).await.c(h!())?;
    let user_id = login_id_from_identity(&user)?;

    trace!(
        "network callsigns activity; login: {user_id}; req: {:?}",
        req
    );
    let req = req.into_inner();

    let groups =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &user_id)
            .await
            .context(h!())?;

    let source_db = env.dbx.clone();
    let analytics_groups = groups.clone();
    let analytics_req = req.clone();
    let postgres_req = req.clone();
    let res = crate::rer_importer::analysis::with_analytics_read_fallback(
        &env,
        "network callsigns activity",
        true,
        move |analytics_db| async move {
            let period = crate::sigint::network::types::NetworkFreqCallsignsPeriod::Unlimited;
            let activity_info =
                crate::sigint::network::analytics::load_network_callsign_activity(
                    &source_db,
                    &analytics_db,
                    &analytics_groups,
                    analytics_req.network_id,
                    &period,
                )
                .await
                .context(h!())?;
            Ok(render_network_callsigns_activity(
                &analytics_req,
                &activity_info,
            ))
        },
        move |postgres_db| async move {
            bl_get_network_callsigns_activity(
                &postgres_req,
                groups,
                &postgres_db,
            )
            .await
        },
    )
    .await?;

    Ok(Json(NetworkCallsignsActivityRsp {
        callsigns_activity: res,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::sigint_network_callsign;
    use crate::functest::tests::{
        cleanup, find_test_login, mk_sigint_network, mk_sigint_unit,
    };
    use crate::sigint::callsign::{
        create_callsign, delete_callsign, update_callsign,
    };
    use crate::sigint::network::types::NetworkFreqCallsignsPeriod;
    use actix_identity::{Identity, IdentityMiddleware};
    use actix_session::{storage::RedisSessionStore, SessionMiddleware};
    use actix_web::cookie::Key;
    use actix_web::web::{self, Data};
    use actix_web::{test, App, HttpMessage, HttpRequest, HttpResponse};
    use serial_test::serial;

    async fn sign_in(
        request: HttpRequest,
        login: web::Path<String>,
    ) -> HttpResponse {
        Identity::login(&request.extensions(), login.into_inner()).unwrap();
        HttpResponse::NoContent().finish()
    }

    fn callsign_write_body(
        path: &str,
        unit_id: i64,
        network_id: i64,
        callsign_id: i64,
        network_callsign_id: i64,
    ) -> serde_json::Value {
        let id = if path.contains("network-callsign") {
            network_callsign_id
        } else {
            callsign_id
        };
        if path.ends_with("/delete") {
            return serde_json::json!(id);
        }
        serde_json::json!({
            "id": id,
            "callsign": if path.ends_with("/update") { "сокіл-2" } else { "сокіл" },
            "position": "оператор",
            "comment": "",
            "unit_id": unit_id,
            "network_id": network_id,
            "known_callsign_ids": [callsign_id],
            "active": true,
            "created_at": 0,
            "developing": false,
            "unit_developing": true,
            "main_radio_station": false,
            "command_control": false,
        })
    }

    async fn assert_callsigns_deleted(
        dbx: &DatabaseConnection,
        callsign_id: i64,
        network_callsign_id: i64,
    ) {
        let callsign =
            crate::entities::sigint_callsign::Entity::find_by_id(callsign_id)
                .one(dbx)
                .await
                .unwrap()
                .unwrap();
        let network_callsign =
            sigint_network_callsign::Entity::find_by_id(network_callsign_id)
                .one(dbx)
                .await
                .unwrap()
                .unwrap();
        assert!(callsign.deleted);
        assert_eq!(callsign.callsign, "сокіл-2");
        assert!(network_callsign.deleted);
        assert_eq!(network_callsign.sigint_callsign, "сокіл-2");
    }

    #[actix_web::test]
    #[serial]
    async fn callsign_write_role_authorization() {
        let env = cleanup().await.unwrap();
        let test_login = find_test_login(&env.dbx).await.unwrap();
        let network = mk_sigint_network(&env.dbx, Default::default())
            .await
            .unwrap();
        let unit = mk_sigint_unit(&env.dbx, Default::default()).await.unwrap();
        let sessions = RedisSessionStore::new(
            crate::redis_conn_string(&env.config).unwrap(),
        )
        .await
        .unwrap();
        let app = test::init_service(
            App::new()
                .app_data(Data::from(env.clone()))
                .wrap(IdentityMiddleware::default())
                .wrap(SessionMiddleware::new(sessions, Key::generate()))
                .route("/test/login/{login}", web::post().to(sign_in))
                .service(create_callsign)
                .service(update_callsign)
                .service(delete_callsign)
                .service(create_network_callsign)
                .service(update_network_callsign)
                .service(delete_network_callsign)
                .service(add_as_known_network_callsigns)
                .service(list_network_callsigns),
        )
        .await;

        for (roles, allowed) in [
            (vec!["Api"], true),
            (vec!["Admin"], true),
            (vec!["Rer", "CallsignsEditor", "UnitsEditor"], true),
            (
                vec!["CyberViewerRestricted", "CallsignsEditor", "UnitsEditor"],
                true,
            ),
            (vec!["Rer"], false),
            (vec!["Full"], false),
            (vec!["ApiAgent"], false),
            (vec!["CyberViewerRestricted"], false),
            (vec!["CallsignsEditor", "UnitsEditor"], false),
            (vec![], false),
        ] {
            let mut login = test_login.clone().into_active_model();
            login.roles = Set(serde_json::json!(roles));
            login.update(&env.dbx).await.unwrap();
            let response = test::call_service(
                &app,
                test::TestRequest::post()
                    .uri(&format!("/test/login/{}", test_login.id))
                    .to_request(),
            )
            .await;
            let cookie =
                response.response().cookies().next().unwrap().into_owned();
            let mut callsign_id = 0;
            let mut network_callsign_id = 0;

            for path in [
                "/api/sigint/callsign/create",
                "/api/sigint/callsign/update",
                "/api/sigint/network-callsign/create",
                "/api/sigint/network-callsign/update",
                "/api/sigint/network-callsign/add-as-known",
                "/api/sigint/network-callsign/delete",
                "/api/sigint/callsign/delete",
            ] {
                let body = callsign_write_body(
                    path,
                    unit.id,
                    network.id,
                    callsign_id,
                    network_callsign_id,
                );
                let response = test::call_service(
                    &app,
                    test::TestRequest::post()
                        .uri(path)
                        .cookie(cookie.clone())
                        .set_json(body)
                        .to_request(),
                )
                .await;
                let status = response.status();
                let body = test::read_body(response).await;
                assert_eq!(
                    status,
                    if allowed {
                        actix_web::http::StatusCode::OK
                    } else {
                        actix_web::http::StatusCode::FORBIDDEN
                    },
                    "roles={roles:?}, path={path}, body={body:?}"
                );
                if !allowed {
                    continue;
                }
                let body: serde_json::Value =
                    serde_json::from_slice(&body).unwrap();
                if path == "/api/sigint/callsign/create" {
                    callsign_id = body["id"].as_i64().unwrap();
                }
                if path == "/api/sigint/network-callsign/create" {
                    network_callsign_id = body["id"].as_i64().unwrap();
                }
            }
            if allowed {
                assert_callsigns_deleted(
                    &env.dbx,
                    callsign_id,
                    network_callsign_id,
                )
                .await;
                let response = test::call_service(
                    &app,
                    test::TestRequest::post()
                        .uri("/api/sigint/network-callsigns/list")
                        .cookie(cookie)
                        .set_json(serde_json::json!({
                            "network_id": network.id,
                            "include_activity_info": false,
                        }))
                        .to_request(),
                )
                .await;
                assert_eq!(response.status(), actix_web::http::StatusCode::OK);
            }
        }
    }

    #[actix_web::test]
    #[serial]
    async fn list_without_activity_ignores_period_4047() {
        let env = cleanup().await.unwrap();
        let test_login = find_test_login(&env.dbx).await.unwrap();
        let test_login_id = test_login.id;
        let mut test_login = test_login.into_active_model();
        test_login.roles = Set(serde_json::json!(["Rer"]));
        test_login.update(&env.dbx).await.unwrap();
        let network = mk_sigint_network(&env.dbx, Default::default())
            .await
            .unwrap();
        let network_callsign = sigint_network_callsign::ActiveModel {
            sigint_network_id: Set(network.id),
            sigint_callsign: Set("сокіл-1".to_string()),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let sessions = RedisSessionStore::new(
            crate::redis_conn_string(&env.config).unwrap(),
        )
        .await
        .unwrap();
        let app = test::init_service(
            App::new()
                .app_data(Data::from(env.clone()))
                .wrap(IdentityMiddleware::default())
                .wrap(SessionMiddleware::new(sessions, Key::generate()))
                .route("/test/login/{login}", web::post().to(sign_in))
                .service(list_network_callsigns),
        )
        .await;
        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri(&format!("/test/login/{test_login_id}"))
                .to_request(),
        )
        .await;
        let cookie = response.response().cookies().next().unwrap().into_owned();

        let mut listed = Vec::new();
        for include_activity_info in [Some(false), None] {
            let list: ListNetworkCallsignsRes = test::call_and_read_body_json(
                &app,
                test::TestRequest::post()
                    .uri("/api/sigint/network-callsigns/list")
                    .cookie(cookie.clone())
                    .set_json(ListNetworkCallsignsReq {
                        network_id: network.id,
                        sort_by: None,
                        period: Some(NetworkFreqCallsignsPeriod::Last21Days),
                        include_activity_info,
                    })
                    .to_request(),
            )
            .await;
            listed.push(
                list.network_callsigns
                    .iter()
                    .map(|callsign| (callsign.id, callsign.message_count))
                    .collect::<Vec<_>>(),
            );
        }

        assert_eq!(listed[0], vec![(network_callsign.id, 0)]);
        assert_eq!(
            listed[1],
            vec![],
            "the same period drops a row without activity on the stats path"
        );
    }
}
