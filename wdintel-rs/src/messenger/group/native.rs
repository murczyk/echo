use crate::config::DATASOURCE_ECHO_NATIVE_GROUP_PREFIX;
use crate::datasource::native as native_source;
use crate::entities::*;
use crate::messenger::group::types::SignalGroupColor;
use crate::sigint::types::InterseptionKind;
use crate::sigint::zone::bl as zone_bl;
use crate::types::*;
use actix_web::{post, web::Json};
use anyhow::ensure;
use elm_rs::{Elm, ElmDecode, ElmEncode};
use sea_orm::sea_query::Expr;
use sea_orm::*;

#[cfg(test)]
mod tests;

#[derive(Clone, Debug, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct NativeGroupSettings {
    pub name: String,
    pub color_key: Option<SignalGroupColor>,
    pub short_note: Option<String>,
    pub long_note: Option<String>,
    pub is_secret: bool,
    pub user_logins: Vec<String>,
    pub organism_ids: Vec<i64>,
    pub admin_logins: Vec<String>,
    pub area_of_responsibility_ids: Vec<i64>,
    pub zone_ids: Vec<i64>,
    pub interseption_kind: InterseptionKind,
    pub disable_network_assignment: bool,
    pub is_aviation_group: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct NativeGroupCreateReq {
    pub request_id: String,
    pub settings: NativeGroupSettings,
}

#[derive(Clone, Debug, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct NativeGroupUpdateReq {
    pub master_key: String,
    pub settings: NativeGroupSettings,
}

#[derive(Clone, Debug, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct NativeGroupDetail {
    pub master_key: String,
    pub settings: NativeGroupSettings,
    pub is_archived: bool,
}

#[post("/api/messenger/native-groups/create")]
pub async fn create(
    env: actix_web::web::Data<Env>,
    user: actix_identity::Identity,
    req: Json<NativeGroupCreateReq>,
) -> Result<Json<NativeGroupDetail>, AppError> {
    crate::users::ensure_admin(&env.dbx, &user).await.c(h!())?;
    let creator_id = crate::users::login_id_from_identity(&user).c(h!())?;
    let txn = env.dbx.begin().await.c(h!())?;
    let detail = create_group(&txn, creator_id, req.into_inner())
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(Json(detail))
}

#[post("/api/messenger/native-groups/get")]
pub async fn get(
    env: actix_web::web::Data<Env>,
    user: actix_identity::Identity,
    req: Json<String>,
) -> Result<Json<NativeGroupDetail>, AppError> {
    crate::users::ensure_admin(&env.dbx, &user).await.c(h!())?;
    let txn = env.dbx.begin().await.c(h!())?;
    load_group(&txn, &req, false).await.c(h!())?;
    let detail = detail(&txn, &req).await.c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(Json(detail))
}

#[post("/api/messenger/native-groups/update")]
pub async fn update(
    env: actix_web::web::Data<Env>,
    user: actix_identity::Identity,
    req: Json<NativeGroupUpdateReq>,
) -> Result<Json<NativeGroupDetail>, AppError> {
    crate::users::ensure_admin(&env.dbx, &user).await.c(h!())?;
    let txn = env.dbx.begin().await.c(h!())?;
    let detail = update_group(&txn, req.into_inner()).await.c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(Json(detail))
}

pub async fn require_external_group<C: ConnectionTrait>(
    db: &C,
    master_key: &str,
) -> anyhow::Result<()> {
    ensure!(
        !native_source::is_native_group(db, master_key)
            .await
            .c(h!())?,
        "Для цієї групи використайте редактор груп Echo."
    );
    Ok(())
}

pub async fn load_group(
    txn: &DatabaseTransaction,
    master_key: &str,
    for_update: bool,
) -> anyhow::Result<signal_group::Model> {
    ensure!(
        native_source::is_native_group(txn, master_key)
            .await
            .c(h!())?,
        "Група не належить Echo Native."
    );
    let query = signal_group::Entity::find_by_id(master_key.to_string())
        .filter(signal_group::Column::Deleted.eq(false));
    let query = if for_update {
        crate::battle_line::lock_updates(txn).await.c(h!())?;
        query.lock_exclusive()
    } else {
        query.lock_shared()
    };
    query.one(txn).await.c(h!())?.c(h!())
}

pub async fn lock_for_edit_if_native(
    txn: &DatabaseTransaction,
    master_key: &str,
) -> anyhow::Result<bool> {
    if !native_source::is_native_group(txn, master_key)
        .await
        .c(h!())?
    {
        return Ok(false);
    }
    let group = load_group(txn, master_key, true).await.c(h!())?;
    ensure!(!group.is_archived, "Спочатку розархівуйте групу.");
    Ok(true)
}

pub async fn lock_for_publish_if_native(
    txn: &DatabaseTransaction,
    master_key: &str,
    login: &Uuid,
) -> anyhow::Result<()> {
    if !native_source::is_native_group(txn, master_key)
        .await
        .c(h!())?
    {
        return Ok(());
    }
    crate::battle_line::lock_updates_shared(txn).await.c(h!())?;
    let group = load_group(txn, master_key, false).await.c(h!())?;
    ensure!(!group.is_archived, "Спочатку розархівуйте групу.");
    super::ensure_identity_group_available(txn, login, master_key)
        .await
        .c(h!())?;
    Ok(())
}

pub async fn lock_message_groups_if_native(
    txn: &DatabaseTransaction,
    message_id: i64,
    destination: Option<&str>,
) -> anyhow::Result<()> {
    crate::battle_line::lock_updates_shared(txn).await.c(h!())?;
    signal_message::Entity::find_by_id(message_id)
        .lock_exclusive()
        .one(txn)
        .await
        .c(h!())?;
    let keys = signal_message_group::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message_group::Relation::SignalGroup.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_group::Relation::Datasource.def(),
        )
        .filter(signal_message_group::Column::SignalMessageId.eq(message_id))
        .filter(
            datasource::Column::Kind
                .eq(crate::config::DATASOURCE_ECHO_NATIVE_KIND),
        )
        .select_only()
        .column(signal_message_group::Column::GroupMasterKey)
        .order_by_asc(signal_message_group::Column::GroupMasterKey)
        .into_tuple::<String>()
        .all(txn)
        .await
        .c(h!())?;
    let native_destination = match destination {
        Some(key) => native_source::is_native_group(txn, key).await.c(h!())?,
        None => false,
    };
    let native_origin = !keys.is_empty();
    ensure!(
        native_destination == native_origin,
        "Щоб перенести повідомлення між Echo та зовнішнім джерелом, створіть копію повідомлення."
    );
    for key in keys {
        load_group(txn, &key, false).await.c(h!())?;
    }
    Ok(())
}

pub async fn create_group(
    txn: &DatabaseTransaction,
    creator_id: Uuid,
    req: NativeGroupCreateReq,
) -> anyhow::Result<NativeGroupDetail> {
    let request_id = Uuid::parse_str(&req.request_id).c(h!())?;
    let master_key =
        format!("{DATASOURCE_ECHO_NATIVE_GROUP_PREFIX}{request_id}");
    crate::battle_line::lock_updates(txn).await.c(h!())?;
    if signal_group::Entity::find_by_id(master_key.clone())
        .one(txn)
        .await
        .c(h!())?
        .is_some()
    {
        load_group(txn, &master_key, false).await.c(h!())?;
        return detail(txn, &master_key).await.c(h!());
    }
    let settings = validate_settings(txn, req.settings, None).await.c(h!())?;
    let datasource = native_source::load(txn).await.c(h!())?;
    signal_group::ActiveModel {
        master_key: Set(master_key.clone()),
        name: Set(Some(settings.name.clone())),
        datasource_id: Set(Some(datasource.id)),
        created_by_login_id: Set(Some(creator_id)),
        fetch_new_messages: Set(Some(false)),
        ..Default::default()
    }
    .insert(txn)
    .await
    .c(h!())?;
    datasource_group::ActiveModel {
        group_master_key: Set(master_key.clone()),
        datasource_id: Set(datasource.id),
        name: Set(settings.name.clone()),
        ..Default::default()
    }
    .insert(txn)
    .await
    .c(h!())?;
    apply_settings(txn, &master_key, datasource.id, settings)
        .await
        .c(h!())?;
    detail(txn, &master_key).await.c(h!())
}

pub async fn update_group(
    txn: &DatabaseTransaction,
    req: NativeGroupUpdateReq,
) -> anyhow::Result<NativeGroupDetail> {
    let group = load_group(txn, &req.master_key, true).await.c(h!())?;
    ensure!(!group.is_archived, "Спочатку розархівуйте групу.");
    let settings = validate_settings(txn, req.settings, Some(&group))
        .await
        .c(h!())?;
    apply_settings(
        txn,
        &req.master_key,
        group.datasource_id.c(h!())?,
        settings,
    )
    .await
    .c(h!())?;
    detail(txn, &req.master_key).await.c(h!())
}

async fn validate_settings(
    txn: &DatabaseTransaction,
    mut settings: NativeGroupSettings,
    existing: Option<&signal_group::Model>,
) -> anyhow::Result<NativeGroupSettings> {
    settings.name = settings.name.trim().to_string();
    ensure!(!settings.name.is_empty(), "Вкажіть назву групи.");
    settings.zone_ids.sort_unstable();
    settings.zone_ids.dedup();
    settings.organism_ids.sort_unstable();
    settings.organism_ids.dedup();
    settings.area_of_responsibility_ids.sort_unstable();
    settings.area_of_responsibility_ids.dedup();
    ensure!(
        settings.zone_ids.is_empty()
            || !settings.area_of_responsibility_ids.is_empty(),
        "Для групи в напрямку виберіть хоча б одну смугу."
    );
    ensure_active_admin(txn, &settings.admin_logins)
        .await
        .c(h!())?;
    validate_logins(txn, &settings.admin_logins).await.c(h!())?;
    validate_logins(txn, &settings.user_logins).await.c(h!())?;
    validate_references(txn, &settings).await.c(h!())?;
    let category_changed = existing
        .map(|group| {
            InterseptionKind::from(group.interseption_kind.clone())
                != settings.interseption_kind
        })
        .unwrap_or(true);
    let involves_other = settings.interseption_kind
        == InterseptionKind::InterseptionOther
        || existing.is_some_and(|group| {
            group.interseption_kind
                == sea_orm_active_enums::InterseptionKind::Other
        });
    if category_changed && involves_other {
        ensure!(
            crate::system_settings::support_non_rer_interceptions_enabled(txn)
                .await
                .c(h!())?,
            "Категорія other недоступна: підтримку non-RER вимкнено."
        );
    }
    Ok(settings)
}

fn login_ids(logins: &[String]) -> anyhow::Result<BTreeSet<Uuid>> {
    logins
        .iter()
        .map(|login| Uuid::parse_str(login.trim()).c(h!()))
        .collect::<anyhow::Result<BTreeSet<_>>>()
        .c(h!())
}

async fn validate_logins(
    txn: &DatabaseTransaction,
    logins: &[String],
) -> anyhow::Result<()> {
    let ids = login_ids(logins).c(h!())?;
    let found = login::Entity::find()
        .filter(login::Column::Id.eq_any(ids.iter().copied()))
        .filter(login::Column::Deleted.eq(false))
        .filter(login::Column::DeletedPermanently.eq(false))
        .count(txn)
        .await
        .c(h!())?;
    ensure!(
        found == ids.len() as u64,
        "Один із вибраних користувачів недоступний."
    );
    Ok(())
}

pub async fn ensure_active_admin(
    txn: &DatabaseTransaction,
    logins: &[String],
) -> anyhow::Result<()> {
    let ids = login_ids(logins).c(h!())?;
    let count = login::Entity::find()
        .filter(login::Column::Id.eq_any(ids))
        .filter(login::Column::Deleted.eq(false))
        .filter(login::Column::DeletedPermanently.eq(false))
        .count(txn)
        .await
        .c(h!())?;
    ensure!(
        count > 0,
        "Група повинна мати щонайменше одного активного адміністратора."
    );
    Ok(())
}

async fn validate_references(
    txn: &DatabaseTransaction,
    settings: &NativeGroupSettings,
) -> anyhow::Result<()> {
    let organisms = organism::Entity::find()
        .filter(organism::Column::Id.eq_any(settings.organism_ids.clone()))
        .filter(organism::Column::Enabled.eq(true))
        .filter(organism::Column::DeletedPermanently.eq(false))
        .count(txn)
        .await
        .c(h!())?;
    ensure!(
        organisms == settings.organism_ids.len() as u64,
        "Один із вибраних організмів недоступний."
    );
    let aors = area_of_responsibility::Entity::find()
        .filter(
            area_of_responsibility::Column::Id
                .eq_any(settings.area_of_responsibility_ids.clone()),
        )
        .filter(area_of_responsibility::Column::Deleted.eq(false))
        .count(txn)
        .await
        .c(h!())?;
    ensure!(
        aors == settings.area_of_responsibility_ids.len() as u64,
        "Одна з вибраних смуг недоступна."
    );
    let zones = sigint_zone::Entity::find()
        .filter(sigint_zone::Column::Id.eq_any(settings.zone_ids.clone()))
        .filter(sigint_zone::Column::Deleted.eq(false))
        .count(txn)
        .await
        .c(h!())?;
    ensure!(
        zones == settings.zone_ids.len() as u64,
        "Один із вибраних напрямків недоступний."
    );
    Ok(())
}

async fn apply_settings(
    txn: &DatabaseTransaction,
    master_key: &str,
    datasource_id: i64,
    settings: NativeGroupSettings,
) -> anyhow::Result<()> {
    super::set_signal_group_color(txn, master_key, settings.color_key)
        .await
        .c(h!())?;
    signal_group::Entity::update_many()
        .col_expr(
            signal_group::Column::Name,
            Expr::value(settings.name.clone()),
        )
        .filter(signal_group::Column::MasterKey.eq(master_key))
        .exec(txn)
        .await
        .c(h!())?;
    datasource_group::Entity::update_many()
        .col_expr(datasource_group::Column::Name, Expr::value(settings.name))
        .filter(datasource_group::Column::GroupMasterKey.eq(master_key))
        .filter(datasource_group::Column::DatasourceId.eq(datasource_id))
        .exec(txn)
        .await
        .c(h!())?;
    zone_bl::update_group_admin_data(
        txn,
        master_key,
        settings.short_note,
        settings.long_note,
    )
    .await
    .c(h!())?;
    zone_bl::update_signal_group_access_and_admins(
        settings.user_logins,
        settings.organism_ids,
        settings.admin_logins,
        settings.is_secret,
        master_key,
        txn,
    )
    .await
    .c(h!())?;
    zone_bl::update_group_interseption_kind_if_enabled(
        Some(settings.interseption_kind),
        master_key,
        txn,
    )
    .await
    .c(h!())?;
    let mut network_invalidation_enqueued = false;
    zone_bl::update_group_disable_network_assignment_if_present(
        Some(settings.disable_network_assignment),
        master_key,
        txn,
        &mut network_invalidation_enqueued,
    )
    .await
    .c(h!())?;
    zone_bl::update_group_aviation_if_present(
        Some(settings.is_aviation_group),
        master_key,
        txn,
    )
    .await
    .c(h!())?;
    crate::messenger::bl::upsert_group_area_of_responsibility(
        txn,
        master_key,
        Some(settings.area_of_responsibility_ids),
        &mut network_invalidation_enqueued,
    )
    .await
    .c(h!())?;
    replace_zones(txn, master_key, datasource_id, settings.zone_ids)
        .await
        .c(h!())?;
    Ok(())
}

async fn replace_zones(
    txn: &DatabaseTransaction,
    master_key: &str,
    datasource_id: i64,
    zone_ids: Vec<i64>,
) -> anyhow::Result<()> {
    sigint_zone_datasource::Entity::delete_many()
        .filter(sigint_zone_datasource::Column::GroupMasterKey.eq(master_key))
        .exec(txn)
        .await
        .c(h!())?;
    for zone_id in zone_ids {
        sigint_zone_datasource::ActiveModel {
            sigint_zone_id: Set(zone_id),
            datasource_id: Set(datasource_id),
            group_master_key: Set(master_key.to_string()),
            ..Default::default()
        }
        .insert(txn)
        .await
        .c(h!())?;
    }
    Ok(())
}

pub async fn detail(
    txn: &DatabaseTransaction,
    master_key: &str,
) -> anyhow::Result<NativeGroupDetail> {
    let group = signal_group::Entity::find_by_id(master_key.to_string())
        .one(txn)
        .await
        .c(h!())?
        .c(h!())?;
    let notes = group_admin_data::Entity::find()
        .filter(group_admin_data::Column::GroupMasterKey.eq(master_key))
        .one(txn)
        .await
        .c(h!())?;
    let keys = vec![master_key.to_string()];
    let user_logins =
        zone_bl::collect_direct_secret_group_users(keys.clone(), txn)
            .await
            .c(h!())?
            .remove(master_key)
            .unwrap_or_default();
    let organism_ids =
        zone_bl::collect_secret_group_organism_ids(keys.clone(), txn)
            .await
            .c(h!())?
            .remove(master_key)
            .unwrap_or_default();
    let admin_logins = zone_bl::collect_signal_group_admins(keys, txn)
        .await
        .c(h!())?
        .remove(master_key)
        .unwrap_or_default();
    let area_of_responsibility_ids =
        super::resolve_group_aor_ids(txn, master_key)
            .await
            .c(h!())?;
    let zone_ids = sigint_zone_datasource::Entity::find()
        .filter(sigint_zone_datasource::Column::GroupMasterKey.eq(master_key))
        .select_only()
        .column(sigint_zone_datasource::Column::SigintZoneId)
        .order_by_asc(sigint_zone_datasource::Column::SigintZoneId)
        .into_tuple::<i64>()
        .all(txn)
        .await
        .c(h!())?;
    Ok(NativeGroupDetail {
        master_key: group.master_key,
        is_archived: group.is_archived,
        settings: NativeGroupSettings {
            name: group.name.unwrap_or_default(),
            color_key: Some(
                SignalGroupColor::from_optional_db_value(
                    group.color_key.as_deref(),
                )
                .c(h!())?,
            ),
            short_note: notes
                .as_ref()
                .and_then(|notes| notes.short_note.clone()),
            long_note: notes.and_then(|notes| notes.long_note),
            is_secret: group.is_secret,
            user_logins,
            organism_ids,
            admin_logins,
            area_of_responsibility_ids,
            zone_ids,
            interseption_kind: group.interseption_kind.into(),
            disable_network_assignment: group.disable_network_assignment,
            is_aviation_group: group.is_aviation_group.unwrap_or(false),
        },
    })
}
