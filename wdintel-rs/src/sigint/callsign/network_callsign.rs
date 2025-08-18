use crate::entities::*;
use crate::event_stream::fanout;
use crate::event_stream::types::*;
use crate::sigint::callsign::bl_network_callsign::*;
use crate::sigint::callsign::types::*;
use crate::types::*;
use actix_web::post;
use actix_web::web::Json;
use sea_orm::QuerySelect;
use sea_orm::*;
use sea_query::JoinType;

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
    let user_id = user.id()?;
    crate::users::has_role(&env.dbx, &user_id, "Rer").await?;

    trace!("network_callsigns; login: {}; req: {:?}", user.id()?, req);

    let mut query = sigint_network_callsign::Entity::find()
        .join(
            JoinType::LeftJoin,
            sigint_network_callsign::Relation::SigintCallsign.def(),
        )
        .join_rev(
            JoinType::LeftJoin,
            sigint_unit::Relation::SigintCallsign.def(),
        )
        .select_also(sigint_callsign::Entity)
        .select_also(sigint_unit::Entity)
        .filter(
            sigint_network_callsign::Column::SigintNetworkId.eq(req.network_id),
        )
        .filter(sigint_network_callsign::Column::Deleted.eq(false))
        .filter(
            Condition::any()
                .add(sigint_callsign::Column::Deleted.eq(false))
                .add(sigint_callsign::Column::Deleted.is_null()),
        );

    // Apply sorting based on request
    query = if let Some(sort_by) = &req.sort_by {
        sort_by.iter().fold(
            query,
            |query, sort_by: &ListNetworkCallsignsSortBy| match sort_by {
                ListNetworkCallsignsSortBy::NetworkCallsignAsc => query
                    .order_by_asc(
                        sigint_network_callsign::Column::SigintCallsign,
                    ),
                ListNetworkCallsignsSortBy::NetworkCallsignDesc => query
                    .order_by_desc(
                        sigint_network_callsign::Column::SigintCallsign,
                    ),
                ListNetworkCallsignsSortBy::NetworkCallsignCreatedAtAsc => {
                    query.order_by_asc(
                        sigint_network_callsign::Column::CreatedAt,
                    )
                }
                ListNetworkCallsignsSortBy::NetworkCallsignCreatedAtDesc => {
                    query.order_by_desc(
                        sigint_network_callsign::Column::CreatedAt,
                    )
                }
            },
        )
    } else {
        // Default sorting (original behavior)
        query.order_by_asc(sigint_network_callsign::Column::SigintCallsign)
    };

    // debug!(
    //     "network_callsigns query sql: {}",
    //     query.build(DbBackend::Postgres).to_string()
    // );

    let network_callsigns: Vec<(
        sigint_network_callsign::Model,
        Option<sigint_callsign::Model>,
        Option<sigint_unit::Model>,
    )> = query.all(&env.dbx).await.context(h!())?;

    let comm_info = get_callsigns_communication_info(
        &env.dbx,
        &user_id,
        req.network_id,
        &network_callsigns
            .iter()
            .map(|(nc, _, _)| nc.sigint_callsign.clone())
            .collect::<Vec<_>>(),
    )
    .await
    .context(h!())?;

    let mut res = vec![];
    for (network_callsign, known_callsign, unit) in network_callsigns {
        let callsing_comm_info =
            comm_info.get(&network_callsign.sigint_callsign);
        let nc = render_network_callsign(
            &network_callsign,
            known_callsign,
            unit,
            callsing_comm_info,
        )?;

        res.push(nc);
    }
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
    let user_id = user.id()?;
    crate::users::has_role(&env.dbx, &user_id, "Rer")
        .await
        .context(h!())?;
    crate::users::has_role(&env.dbx, &user_id, "UnitsEditor")
        .await
        .context(h!())?;

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

    let event = EventMsg::new(EventType::ETNetworkChanged);
    fanout(&mut env.redis.clone(), event).await.context(h!())?;

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
pub async fn add_as_known_network_callsign(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AddAsKnownNetworkCallsignReq>,
) -> Result<Json<NetworkCallsign>, AppError> {
    let user_id = user.id()?;
    crate::users::has_role(&env.dbx, &user_id, "Rer")
        .await
        .context(h!())?;
    crate::users::has_role(&env.dbx, &user_id, "UnitsEditor")
        .await
        .context(h!())?;

    info!(
        "Adding known network callsign {} to network {}; user={}",
        req.known_callsign_id, req.network_id, user_id
    );

    let txn = env.dbx.begin().await.context(h!())?;
    let network_callsign_id = bl_add_as_known_network_callsign(
        req.network_id,
        req.known_callsign_id,
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
        vec![network_callsign_id],
    )
    .await
    .context(h!())?
    .into_iter()
    .next()
    .ok_or(AppError::NotFound)?;

    let event = EventMsg::new(EventType::ETNetworkChanged);
    fanout(&mut env.redis.clone(), event).await.context(h!())?;

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
    let user_id = user.id()?;
    crate::users::has_role(&env.dbx, &user_id, "Rer")
        .await
        .context(h!())?;
    crate::users::has_role(&env.dbx, &user_id, "UnitsEditor")
        .await
        .context(h!())?;

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

    let event = EventMsg::new(EventType::ETNetworkChanged);
    fanout(&mut env.redis.clone(), event).await.context(h!())?;

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
    let user_id = user.id()?;
    crate::users::has_role(&env.dbx, &user_id, "Rer").await?;
    crate::users::has_role(&env.dbx, &user_id, "UnitsEditor").await?;

    info!("Delete network callsign; login: {user_id}; req: {req:?}");
    let txn = env.dbx.begin().await.context(h!())?;
    let req = req.into_inner();

    let network_callsign =
        bl_delete_network_callsign(req, &txn).await.context(h!())?;
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
