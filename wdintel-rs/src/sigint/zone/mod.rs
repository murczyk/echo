use self::bl::*;
use super::types::*;
use crate::entities::*;
use crate::rer_importer::collect_group_aors;
use crate::sigint::area_of_responsibility::render_aor;
use crate::types::*;
use actix_web::post;
use actix_web::web::Json;
use sea_orm::*;

pub mod bl;

#[post("/api/sigint/zones/list")]
pub async fn zones_list(
    env: actix_web::web::Data<Env>,
    user: actix_identity::Identity,
) -> Result<Json<Vec<(i64, SigintZone)>>, AppError> {
    crate::users::has_any_role(&env.dbx, &user.id()?, vec!["Rer", "Api"])
        .await?;
    let zones = sigint_zone::Entity::find()
        .filter(sigint_zone::Column::Deleted.eq(false))
        .all(&env.dbx)
        .await?;
    let mut res = vec![];
    for zone in zones {
        res.push((
            zone.id,
            SigintZone {
                name: zone.name.clone(),
                created_at: zone.created_at.and_utc().timestamp_millis(),
            },
        ));
    }
    Ok(Json(res))
}

#[post("/api/sigint/zones/zone-datasources")]
pub async fn zones_datasources_list(
    env: actix_web::web::Data<Env>,
    user: actix_identity::Identity,
    req: Json<i64>,
) -> Result<Json<Vec<i64>>, AppError> {
    crate::users::has_any_role(&env.dbx, &user.id()?, vec!["Rer", "Api"])
        .await?;
    let zone_id: i64 = req.into_inner();
    let xs = sigint_zone_datasource::Entity::find()
        .filter(sigint_zone_datasource::Column::SigintZoneId.eq(zone_id))
        .all(&env.dbx)
        .await?;
    let mut res = vec![];
    for x in xs {
        if !res.contains(&x.datasource_id) {
            res.push(x.datasource_id);
        }
    }
    Ok(Json(res))
}

#[post("/api/sigint/zones/zone-datasource-groups")]
pub async fn zones_datasources_groups_list(
    env: actix_web::web::Data<Env>,
    user: actix_identity::Identity,
    req: Json<ZoneDatasourceGroupsReq>,
) -> Result<Json<ZoneDatasourceGroupListRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Admin").await?;
    let txn = env.dbx.begin().await?;

    #[derive(FromQueryResult, Debug)]
    struct Res {
        login: Option<String>,
        id: i64,
        group_master_key: String,
        is_secret: bool,
        short_note: Option<String>,
        long_note: Option<String>,
    }

    let req = req.into_inner();
    let rows = sigint_zone_datasource::Entity::find()
        .join(
            JoinType::LeftJoin,
            sigint_zone_datasource::Relation::SignalGroup.def(),
        )
        .join(
            JoinType::LeftJoin,
            signal_group::Relation::GroupAdminData.def(),
        )
        .join(
            JoinType::LeftJoin,
            signal_group::Relation::SecretGroupUser.def(),
        )
        .column_as(
            sigint_zone_datasource::Column::GroupMasterKey,
            "group_master_key",
        )
        .column_as(sigint_zone_datasource::Column::Id, "id")
        .column_as(signal_group::Column::IsSecret, "is_secret")
        .column_as(secret_group_user::Column::Login, "login")
        .column(group_admin_data::Column::ShortNote)
        .column(group_admin_data::Column::LongNote)
        .filter(sigint_zone_datasource::Column::SigintZoneId.eq(req.zone_id))
        .filter(
            sigint_zone_datasource::Column::DatasourceId.eq(req.datasource_id),
        )
        .into_model::<Res>()
        .all(&txn)
        .await
        .context(h!())?;

    let mut res = HashMap::<
        String,
        (bool, i64, Vec<String>, Option<String>, Option<String>),
    >::new();
    for row in rows {
        if let Some((_, _, login_vec, _, _)) =
            res.get_mut(&row.group_master_key)
        {
            if let Some(user_login) = row.login {
                login_vec.push(user_login);
            }
        } else {
            let logins = if let Some(user_login) = row.login {
                vec![user_login]
            } else {
                vec![]
            };
            res.insert(
                row.group_master_key,
                (row.is_secret, row.id, logins, row.short_note, row.long_note),
            );
        }
    }

    let keys = res.iter().map(|(key, _)| key.clone()).collect::<Vec<_>>();
    let group_aors = collect_group_aors(keys.clone(), &env.dbx)
        .await
        .context(h!())?;

    let zone_datasource_groups = res
        .into_iter()
        .map(
            |(
                master_key,
                (is_secret, szd_id, allowed_users, short_note, long_note),
            )| {
                let aor = group_aors.get(&master_key).cloned();
                ZoneDatasourceGroup {
                    area_of_responsibility: aor,
                    sigint_zone_datasource_id: szd_id,
                    group_master_key: master_key,
                    is_group_secret: is_secret,
                    allowed_users,
                    short_note,
                    long_note,
                }
            },
        )
        .collect();

    Ok(Json(ZoneDatasourceGroupListRsp {
        zone_datasource_groups,
    }))
}

#[post("/api/sigint/zones/zone-datasource-group-update")]
pub async fn zones_datasources_group_update(
    env: actix_web::web::Data<Env>,
    user: actix_identity::Identity,
    req: Json<ZoneDatasourceGroupUpdateReq>,
) -> Result<Json<ZoneDatasourceGroup>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Admin").await?;
    let req = req.into_inner();

    let txn = env.dbx.begin().await?;
    let szd = sigint_zone_datasource::Entity::find_by_id(req.id)
        .one(&txn)
        .await
        .context(h!())?
        .context(h!())?;

    zones_datasources_group_update_bl(
        req.user_logins,
        req.is_secret,
        req.short_note,
        req.long_note,
        szd.clone(),
        &txn,
    )
    .await
    .context(h!())?;
    // Fetch updated allowed users
    let allowed_users = secret_group_user::Entity::find()
        .filter(secret_group_user::Column::MasterKey.eq(&szd.group_master_key))
        .all(&txn)
        .await
        .context(h!())?
        .into_iter()
        .map(|u| u.login)
        .collect::<Vec<_>>();

    // Fetch updated is_secret and other group attributes

    let is_secret = signal_group::Entity::find()
        .filter(signal_group::Column::MasterKey.eq(&szd.group_master_key))
        .select_only()
        .column(signal_group::Column::IsSecret)
        .into_tuple::<bool>()
        .one(&txn)
        .await
        .context(h!())?
        .unwrap_or(false);
    let (short_note, long_note) = group_admin_data::Entity::find()
        .filter(
            group_admin_data::Column::GroupMasterKey.eq(&szd.group_master_key),
        )
        .select_only()
        .columns([
            group_admin_data::Column::ShortNote,
            group_admin_data::Column::LongNote,
        ])
        .into_tuple::<(Option<String>, Option<String>)>()
        .one(&txn)
        .await
        .context(h!())?
        .unwrap_or((None, None));

    let aor = crate::messenger::bl::upsert_group_area_of_responsibility(
        &txn,
        &szd.group_master_key,
        req.area_of_responsibility_id.clone(),
    )
    .await
    .context(h!())?;

    txn.commit().await?;

    Ok(Json(ZoneDatasourceGroup {
        sigint_zone_datasource_id: szd.id,
        group_master_key: szd.group_master_key,
        is_group_secret: is_secret,
        area_of_responsibility: aor.map(render_aor),
        allowed_users,
        short_note,
        long_note,
    }))
}

#[post("/api/sigint/zones/zone-datasource-group-add")]
pub async fn zones_datasources_group_add(
    env: actix_web::web::Data<Env>,
    user: actix_identity::Identity,
    req: Json<ZoneDatasourceGroupAddReq>,
) -> Result<Json<ZoneDatasourceGroupAddRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Admin").await?;

    let txn = env.dbx.begin().await?;
    let req = req.into_inner();
    let szd = sigint_zone_datasource::ActiveModel {
        sigint_zone_id: Set(req.zone_id),
        datasource_id: Set(req.datasource_id),
        group_master_key: Set(req.master_key.clone()),
        ..Default::default()
    }
    .insert(&txn)
    .await
    .context(h!())?;

    zones_datasources_group_update_bl(
        req.user_logins.clone(),
        req.is_secret,
        req.short_note,
        req.long_note,
        szd.clone(),
        &txn,
    )
    .await
    .context(h!())?;

    // Fetch the final allowed users after update
    let allowed_users = secret_group_user::Entity::find()
        .filter(secret_group_user::Column::MasterKey.eq(&szd.group_master_key))
        .all(&txn)
        .await
        .context(h!())?
        .into_iter()
        .map(|u| u.login)
        .collect::<Vec<_>>();

    // Fetch the group name and notes
    let group_name = signal_group::Entity::find()
        .filter(signal_group::Column::MasterKey.eq(&szd.group_master_key))
        .select_only()
        .column(signal_group::Column::Name)
        .into_tuple::<Option<String>>()
        .one(&txn)
        .await
        .context(h!())?
        .flatten();

    let (short_note, long_note) = group_admin_data::Entity::find()
        .filter(
            group_admin_data::Column::GroupMasterKey.eq(&szd.group_master_key),
        )
        .select_only()
        .columns([
            group_admin_data::Column::ShortNote,
            group_admin_data::Column::LongNote,
        ])
        .into_tuple::<(Option<String>, Option<String>)>()
        .one(&txn)
        .await
        .context(h!())?
        .unwrap_or((None, None));

    let group_master_key = szd.group_master_key.clone();
    let area_of_responsibility =
        collect_group_aors(vec![group_master_key.clone()], &env.dbx)
            .await
            .context(h!())?
            .remove(&group_master_key);

    txn.commit().await?;

    Ok(Json(ZoneDatasourceGroupAddRsp {
        zone_id: req.zone_id,
        datasource_id: req.datasource_id,
        group_master_key: group_master_key.clone(),
        group_name,
        zone_datasource_group: ZoneDatasourceGroup {
            sigint_zone_datasource_id: szd.id,
            is_group_secret: req.is_secret,
            area_of_responsibility,
            group_master_key,
            allowed_users,
            short_note,
            long_note,
        },
    }))
}

#[post("/api/sigint/zones/zone-datasource-group-delete")]
pub async fn zones_datasources_group_delete(
    env: actix_web::web::Data<Env>,
    user: actix_identity::Identity,
    req: Json<i64>,
) -> Result<Json<()>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Admin").await?;

    let txn = env.dbx.begin().await?;

    if let Some(szd) = sigint_zone_datasource::Entity::find_by_id(req.0)
        .one(&txn)
        .await
        .context(h!())?
    {
        szd.delete(&txn).await.context(h!())?;
    }

    txn.commit().await?;

    Ok(Json(()))
}

pub fn filter_out_ineligible_secret_chats<E: EntityTrait>(
    select: Select<E>,
    login: &str,
) -> Select<E> {
    select.filter(
        signal_group::Column::IsSecret.eq(false).or(
            signal_group::Column::MasterKey.in_subquery(
                sea_query::Query::select()
                    .expr_as(
                        sea_query::Expr::cust("master_key"),
                        sea_query::Alias::new("master_key"),
                    )
                    .from(secret_group_user::Entity)
                    .and_where(secret_group_user::Column::Login.eq(login))
                    .to_owned(),
            ),
        ),
    )
}

pub async fn get_datasources_zones<'a, 'async_trait, C>(
    dbx: &'a C,
) -> Result<BTreeMap<i64, Vec<i64>>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let zone_datasources =
        sigint_zone_datasource::Entity::find().all(dbx).await?;
    let mut res: BTreeMap<i64, Vec<i64>> = BTreeMap::new();
    for zd in zone_datasources {
        res.entry(zd.datasource_id)
            .and_modify(|zs| {
                if !zs.contains(&zd.sigint_zone_id) {
                    zs.push(zd.sigint_zone_id);
                }
            })
            .or_insert(vec![zd.sigint_zone_id]);
    }
    Ok(res)
}

pub async fn get_user_zone_id(
    dbx: &DbConn,
    user_id: &str,
) -> Result<Option<i64>, AppError> {
    let user = login::Entity::find()
        .filter(login::Column::DeletedPermanently.eq(false))
        .filter(login::Column::Login.eq(user_id))
        .one(dbx)
        .await?;
    Ok(user.and_then(|x| x.sigint_zone_id))
}
