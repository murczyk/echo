pub mod scope;

use crate::entities::{
    login, rer_report_access_login, sigint_unit,
    sigint_unit_rer_report_metadata,
};
use crate::error::AppError;
use crate::h;
use crate::types::{Env, ShortContext};
use crate::users::ensure_admin;
use actix_identity::Identity;
use actix_web::post;
use actix_web::web::{Data, Json};
use elm_rs::{Elm, ElmDecode, ElmEncode};
use sea_orm::{
    ActiveModelTrait, ActiveValue::NotSet, ColumnTrait, ConnectionTrait,
    DatabaseConnection, DatabaseTransaction, EntityTrait, IntoActiveModel,
    JsonValue, ModelTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect, Set, TransactionTrait,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use uuid::Uuid;

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct RerReportAccessListRsp {
    pub login_ids: Vec<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(deny_unknown_fields)]
pub struct ReplaceRerReportAccessListReq {
    pub login_ids: Vec<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct RerReportMetadataItem {
    pub id: i64,
    pub sigint_unit_id: i64,
    pub sigint_unit_name: String,
    pub report_parent_context: String,
    pub sigint_unit_active: bool,
    pub sigint_unit_deleted: bool,
    pub locations: Vec<String>,
    pub report_name: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct RerReportMetadataListRsp {
    pub items: Vec<RerReportMetadataItem>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(deny_unknown_fields)]
pub struct CreateRerReportMetadataReq {
    pub sigint_unit_id: i64,
    pub locations: Vec<String>,
    pub report_name: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(deny_unknown_fields)]
pub struct UpdateRerReportMetadataReq {
    pub id: i64,
    pub sigint_unit_id: i64,
    pub locations: Vec<String>,
    pub report_name: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(deny_unknown_fields)]
pub struct DeleteRerReportMetadataReq {
    pub id: i64,
}

#[post("/api/admin/rer-report/access-list")]
pub async fn rer_report_access_list(
    env: Data<Env>,
    user: Identity,
) -> Result<Json<RerReportAccessListRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let login_ids = rer_report_access_login::Entity::find()
        .order_by_asc(rer_report_access_login::Column::CreatedAt)
        .all(&env.dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|row| row.login_id.to_string())
        .collect();
    Ok(Json(RerReportAccessListRsp { login_ids }))
}

#[post("/api/admin/rer-report/access-list/replace")]
pub async fn rer_report_access_replace(
    env: Data<Env>,
    user: Identity,
    req: Json<ReplaceRerReportAccessListReq>,
) -> Result<Json<RerReportAccessListRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let mut login_ids = req
        .login_ids
        .iter()
        .map(|login_id| {
            Uuid::parse_str(login_id).map_err(|_| AppError::BL {
                msg: format!(
                    "Некоректний ідентифікатор користувача: {login_id}"
                ),
            })
        })
        .collect::<Result<Vec<_>, _>>()
        .c(h!())?;
    login_ids.sort_unstable();
    login_ids.dedup();
    replace_access_list(&env.dbx, &login_ids).await.c(h!())?;
    Ok(Json(RerReportAccessListRsp {
        login_ids: login_ids.into_iter().map(|id| id.to_string()).collect(),
    }))
}

async fn replace_access_list(
    dbx: &DatabaseConnection,
    login_ids: &[Uuid],
) -> anyhow::Result<()> {
    let transaction = dbx.begin().await.c(h!())?;
    transaction
        .execute_unprepared(
            "lock table rer_report_access_login in exclusive mode",
        )
        .await
        .c(h!())?;
    validate_login_ids(&transaction, login_ids).await.c(h!())?;
    rer_report_access_login::Entity::delete_many()
        .exec(&transaction)
        .await
        .c(h!())?;
    if !login_ids.is_empty() {
        rer_report_access_login::Entity::insert_many(login_ids.iter().map(
            |login_id| rer_report_access_login::ActiveModel {
                id: NotSet,
                login_id: Set(*login_id),
                created_at: NotSet,
            },
        ))
        .exec(&transaction)
        .await
        .c(h!())?;
    }
    transaction.commit().await.c(h!())?;

    Ok(())
}

#[post("/api/admin/rer-report/metadata")]
pub async fn rer_report_metadata_list(
    env: Data<Env>,
    user: Identity,
) -> Result<Json<RerReportMetadataListRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    Ok(Json(RerReportMetadataListRsp {
        items: list_metadata(&env.dbx).await.c(h!())?,
    }))
}

#[post("/api/admin/rer-report/metadata/create")]
pub async fn rer_report_metadata_create(
    env: Data<Env>,
    user: Identity,
    req: Json<CreateRerReportMetadataReq>,
) -> Result<Json<RerReportMetadataItem>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    Ok(Json(create_metadata(&env.dbx, &req).await.c(h!())?))
}

async fn create_metadata(
    dbx: &DatabaseConnection,
    req: &CreateRerReportMetadataReq,
) -> anyhow::Result<RerReportMetadataItem> {
    let (locations, report_name) =
        normalize_metadata(req.locations.clone(), &req.report_name).c(h!())?;
    let transaction = crate::sigint::unit::begin_unit_merge_transaction(
        dbx,
        &[req.sigint_unit_id],
    )
    .await
    .c(h!())?;
    validate_unit(&transaction, req.sigint_unit_id)
        .await
        .c(h!())?;
    ensure_unit_is_unused(&transaction, req.sigint_unit_id, None)
        .await
        .c(h!())?;
    scope::validate_parent(
        &transaction,
        req.sigint_unit_id,
        &report_name,
        None,
    )
    .await
    .c(h!())?;
    let row = sigint_unit_rer_report_metadata::ActiveModel {
        id: NotSet,
        sigint_unit_id: Set(req.sigint_unit_id),
        locations: Set(serde_json::to_value(locations).c(h!())?),
        labels: Set(serde_json::json!([report_name])),
        report_name: Set(Some(report_name)),
        created_at: NotSet,
    }
    .insert(&transaction)
    .await
    .c(h!())?;
    let item = metadata_item_by_id(&transaction, row.id).await.c(h!())?;
    transaction.commit().await.c(h!())?;
    Ok(item)
}

#[post("/api/admin/rer-report/metadata/update")]
pub async fn rer_report_metadata_update(
    env: Data<Env>,
    user: Identity,
    req: Json<UpdateRerReportMetadataReq>,
) -> Result<Json<RerReportMetadataItem>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    Ok(Json(update_metadata(&env.dbx, &req).await.c(h!())?))
}

async fn update_metadata(
    dbx: &DatabaseConnection,
    req: &UpdateRerReportMetadataReq,
) -> anyhow::Result<RerReportMetadataItem> {
    let (locations, report_name) =
        normalize_metadata(req.locations.clone(), &req.report_name).c(h!())?;
    let (transaction, row) =
        lock_metadata_for_write(dbx, req.id, Some(req.sigint_unit_id))
            .await
            .c(h!())?;
    if row.sigint_unit_id != req.sigint_unit_id {
        validate_unit(&transaction, req.sigint_unit_id)
            .await
            .c(h!())?;
    }
    ensure_unit_is_unused(&transaction, req.sigint_unit_id, Some(req.id))
        .await
        .c(h!())?;
    scope::validate_parent(
        &transaction,
        req.sigint_unit_id,
        &report_name,
        Some(req.id),
    )
    .await
    .c(h!())?;
    let mut row = row.into_active_model();
    row.sigint_unit_id = Set(req.sigint_unit_id);
    row.locations = Set(serde_json::to_value(locations).c(h!())?);
    row.labels = Set(serde_json::json!([report_name]));
    row.report_name = Set(Some(report_name));
    row.update(&transaction).await.c(h!())?;
    let item = metadata_item_by_id(&transaction, req.id).await.c(h!())?;
    transaction.commit().await.c(h!())?;
    Ok(item)
}

#[post("/api/admin/rer-report/metadata/delete")]
pub async fn rer_report_metadata_delete(
    env: Data<Env>,
    user: Identity,
    req: Json<DeleteRerReportMetadataReq>,
) -> Result<Json<()>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    delete_metadata(&env.dbx, req.id).await.c(h!())?;
    Ok(Json(()))
}

async fn delete_metadata(
    dbx: &DatabaseConnection,
    id: i64,
) -> anyhow::Result<()> {
    let (transaction, row) =
        lock_metadata_for_write(dbx, id, None).await.c(h!())?;
    row.delete(&transaction).await.c(h!())?;
    transaction.commit().await.c(h!())?;
    Ok(())
}

async fn lock_metadata_for_write(
    dbx: &DatabaseConnection,
    id: i64,
    target_unit_id: Option<i64>,
) -> anyhow::Result<(DatabaseTransaction, sigint_unit_rer_report_metadata::Model)>
{
    let previous = sigint_unit_rer_report_metadata::Entity::find_by_id(id)
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
        .c(h!())?;
    let transaction = crate::sigint::unit::begin_unit_merge_transaction(
        dbx,
        &[
            previous.sigint_unit_id,
            target_unit_id.unwrap_or(previous.sigint_unit_id),
        ],
    )
    .await
    .c(h!())?;
    let row = sigint_unit_rer_report_metadata::Entity::find_by_id(id)
        .lock_exclusive()
        .one(&transaction)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
        .c(h!())?;
    anyhow::ensure!(
        row.sigint_unit_id == previous.sigint_unit_id,
        "Метадані підрозділу змінилися; оновіть список і повторіть дію"
    );
    Ok((transaction, row))
}

pub(crate) async fn user_is_eligible<C>(
    dbx: &C,
    login_id: &Uuid,
) -> anyhow::Result<bool>
where
    C: ConnectionTrait,
{
    Ok(rer_report_access_login::Entity::find()
        .filter(rer_report_access_login::Column::LoginId.eq(*login_id))
        .count(dbx)
        .await
        .c(h!())?
        > 0)
}

async fn validate_login_ids<C>(
    dbx: &C,
    login_ids: &[Uuid],
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    let count = login::Entity::find()
        .filter(login::Column::Id.is_in(login_ids.iter().copied()))
        .filter(login::Column::DeletedPermanently.eq(false))
        .count(dbx)
        .await
        .c(h!())?;
    if count != login_ids.len() as u64 {
        return Err(AppError::BL {
            msg: "Один або кілька користувачів більше не існують".to_string(),
        }
        .into());
    }
    Ok(())
}

async fn list_metadata<C>(dbx: &C) -> anyhow::Result<Vec<RerReportMetadataItem>>
where
    C: ConnectionTrait,
{
    let rows = sigint_unit_rer_report_metadata::Entity::find()
        .find_also_related(sigint_unit::Entity)
        .order_by_asc(sigint_unit::Column::Name)
        .order_by_asc(sigint_unit_rer_report_metadata::Column::Id)
        .all(dbx)
        .await
        .c(h!())?;
    let mut items = Vec::with_capacity(rows.len());
    for (row, unit) in rows {
        let unit = unit.ok_or(AppError::NotFound).c(h!())?;
        items.push(metadata_item(row, unit).c(h!())?);
    }
    Ok(items)
}

async fn metadata_item_by_id<C>(
    dbx: &C,
    id: i64,
) -> anyhow::Result<RerReportMetadataItem>
where
    C: ConnectionTrait,
{
    let (row, unit) = sigint_unit_rer_report_metadata::Entity::find_by_id(id)
        .find_also_related(sigint_unit::Entity)
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
        .c(h!())?;
    metadata_item(row, unit.ok_or(AppError::NotFound).c(h!())?).c(h!())
}

fn metadata_item(
    row: sigint_unit_rer_report_metadata::Model,
    unit: sigint_unit::Model,
) -> anyhow::Result<RerReportMetadataItem> {
    Ok(RerReportMetadataItem {
        id: row.id,
        sigint_unit_id: row.sigint_unit_id,
        report_parent_context: serde_json::to_string(&scope::parent(&unit).0)
            .c(h!())?,
        sigint_unit_active: unit.active,
        sigint_unit_deleted: unit.deleted,
        sigint_unit_name: unit.name,
        locations: json_string_list(row.locations).c(h!())?,
        report_name: row.report_name.unwrap_or_default(),
    })
}

fn json_string_list(value: JsonValue) -> anyhow::Result<Vec<String>> {
    serde_json::from_value(value).c(h!())
}

fn normalize_metadata(
    locations: Vec<String>,
    report_name: &str,
) -> anyhow::Result<(Vec<String>, String)> {
    let report_name = report_name.trim();
    if report_name.is_empty() || report_name.contains(['\r', '\n']) {
        return Err(AppError::BL {
            msg: "Вкажіть непорожню назву для звіту одним рядком".into(),
        }
        .into());
    }
    Ok((
        normalize_string_list(locations).c(h!())?,
        report_name.to_string(),
    ))
}

fn normalize_string_list(values: Vec<String>) -> anyhow::Result<Vec<String>> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for value in values {
        let value = value.trim().to_string();
        if value.is_empty() {
            return Err(AppError::BL {
                msg: "Порожні значення у метаданих РЕР не дозволені"
                    .to_string(),
            }
            .into());
        }
        if seen.insert(value.clone()) {
            normalized.push(value);
        }
    }
    Ok(normalized)
}

async fn validate_unit<C>(dbx: &C, unit_id: i64) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    let exists = sigint_unit::Entity::find_by_id(unit_id)
        .filter(sigint_unit::Column::Active.eq(true))
        .filter(sigint_unit::Column::Deleted.eq(false))
        .count(dbx)
        .await
        .c(h!())?
        > 0;
    if !exists {
        return Err(AppError::BL {
            msg: "Підрозділ не знайдено або він неактивний".to_string(),
        }
        .into());
    }
    Ok(())
}

async fn ensure_unit_is_unused<C>(
    dbx: &C,
    unit_id: i64,
    except_id: Option<i64>,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    let mut query = sigint_unit_rer_report_metadata::Entity::find().filter(
        sigint_unit_rer_report_metadata::Column::SigintUnitId.eq(unit_id),
    );
    if let Some(except_id) = except_id {
        query = query
            .filter(sigint_unit_rer_report_metadata::Column::Id.ne(except_id));
    }
    if query.count(dbx).await.c(h!())? > 0 {
        return Err(AppError::BL {
            msg: "Для цього підрозділу метадані РЕР уже створені".to_string(),
        }
        .into());
    }
    Ok(())
}

pub(crate) async fn merge_unit_metadata<C>(
    dbx: &C,
    source_unit_id: i64,
    target_unit_id: i64,
) -> anyhow::Result<u64>
where
    C: ConnectionTrait,
{
    let rows = sigint_unit_rer_report_metadata::Entity::find()
        .filter(
            sigint_unit_rer_report_metadata::Column::SigintUnitId
                .is_in([source_unit_id, target_unit_id]),
        )
        .lock_exclusive()
        .all(dbx)
        .await
        .c(h!())?;
    let source = rows
        .iter()
        .find(|row| row.sigint_unit_id == source_unit_id)
        .cloned();
    let Some(source) = source else {
        validate_unit_metadata_parent(dbx, target_unit_id)
            .await
            .c(h!())?;
        return Ok(0);
    };
    let target = rows
        .iter()
        .find(|row| row.sigint_unit_id == target_unit_id)
        .cloned();
    match target {
        None => {
            let mut source = source.into_active_model();
            source.sigint_unit_id = Set(target_unit_id);
            source.update(dbx).await.c(h!())?;
        }
        Some(target) => {
            let locations = merge_json_lists(
                target.locations.clone(),
                source.locations.clone(),
            )
            .c(h!())?;
            let mut target = target.into_active_model();
            target.locations = Set(serde_json::to_value(locations).c(h!())?);
            target.update(dbx).await.c(h!())?;
            source.delete(dbx).await.c(h!())?;
        }
    }
    validate_unit_metadata_parent(dbx, target_unit_id)
        .await
        .c(h!())?;
    Ok(1)
}

pub(crate) async fn validate_unit_metadata_parent<C: ConnectionTrait>(
    dbx: &C,
    unit_id: i64,
) -> anyhow::Result<()> {
    let row = sigint_unit_rer_report_metadata::Entity::find()
        .filter(
            sigint_unit_rer_report_metadata::Column::SigintUnitId.eq(unit_id),
        )
        .select_only()
        .column(sigint_unit_rer_report_metadata::Column::Id)
        .column(sigint_unit_rer_report_metadata::Column::ReportName)
        .into_tuple::<(i64, Option<String>)>()
        .one(dbx)
        .await
        .c(h!())?;
    if let Some((id, report_name)) = row {
        scope::validate_parent(
            dbx,
            unit_id,
            report_name.as_deref().unwrap_or_default().trim(),
            Some(id),
        )
        .await
        .c(h!())?;
    }
    Ok(())
}

fn merge_json_lists(
    target: JsonValue,
    source: JsonValue,
) -> anyhow::Result<Vec<String>> {
    let target: Vec<String> = serde_json::from_value(target).c(h!())?;
    let source: Vec<String> = serde_json::from_value(source).c(h!())?;
    let mut seen = HashSet::new();
    Ok(target
        .into_iter()
        .chain(source)
        .filter(|value| seen.insert(value.clone()))
        .collect())
}

#[cfg(test)]
mod tests;
