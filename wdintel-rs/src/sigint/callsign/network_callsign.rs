use crate::sigint::callsign::bl_network_callsign::*;
use crate::sigint::callsign::types::*;
use crate::types::*;
use crate::users::{
    ensure_rer_role, has_any_role, has_role, login_id_from_identity,
};
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
        vec!["Rer", "ApiAgent"],
    )
    .await
    .c(h!())?;
    let user_id = login_id_from_identity(&user)?;

    trace!("network_callsigns; login: {user_id}; req: {:?}", req);
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
        "network callsigns assigned list",
        true,
        move |analytics_db| async move {
            let activity_info =
                crate::sigint::network::analytics::load_network_callsign_activity(
                    &source_db,
                    &analytics_db,
                    &analytics_groups,
                    analytics_req.network_id,
                )
                .await?;
            bl_get_network_callsigns_list_with_activity_info(
                &analytics_req,
                &user_id,
                &source_db,
                activity_info,
            )
            .await
        },
        move |postgres_db| async move {
            bl_get_network_callsigns_list(
                &postgres_req,
                &user_id,
                &postgres_db,
            )
            .await
        },
    )
    .await?;

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
    ensure_rer_role(&env.dbx, &user).await.context(h!())?;
    has_role(&env.dbx, &login_id_from_identity(&user)?, "UnitsEditor")
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
    ensure_rer_role(&env.dbx, &user).await.context(h!())?;
    has_role(&env.dbx, &login_id_from_identity(&user)?, "UnitsEditor")
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
    ensure_rer_role(&env.dbx, &user).await.context(h!())?;
    has_role(&env.dbx, &login_id_from_identity(&user)?, "UnitsEditor")
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
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    has_role(&env.dbx, &login_id_from_identity(&user)?, "UnitsEditor")
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
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
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
            let activity_info =
                crate::sigint::network::analytics::load_network_callsign_activity(
                    &source_db,
                    &analytics_db,
                    &analytics_groups,
                    analytics_req.network_id,
                )
                .await?;
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
