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
    EntityTrait, IntoActiveModel, JsonValue, ModelTrait, PaginatorTrait,
    QueryFilter, QueryOrder, QuerySelect, Set, TransactionTrait,
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
    pub locations: Vec<String>,
    pub labels: Vec<String>,
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
    pub labels: Vec<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(deny_unknown_fields)]
pub struct UpdateRerReportMetadataReq {
    pub id: i64,
    pub sigint_unit_id: i64,
    pub locations: Vec<String>,
    pub labels: Vec<String>,
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
    validate_login_ids(&env.dbx, &login_ids).await.c(h!())?;

    let transaction = env.dbx.begin().await.c(h!())?;
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

    Ok(Json(RerReportAccessListRsp {
        login_ids: login_ids.into_iter().map(|id| id.to_string()).collect(),
    }))
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
    let (locations, labels) =
        normalize_metadata_lists(req.locations.clone(), req.labels.clone())
            .c(h!())?;
    validate_unit(&env.dbx, req.sigint_unit_id).await.c(h!())?;
    ensure_unit_is_unused(&env.dbx, req.sigint_unit_id, None)
        .await
        .c(h!())?;
    let row = sigint_unit_rer_report_metadata::ActiveModel {
        id: NotSet,
        sigint_unit_id: Set(req.sigint_unit_id),
        locations: Set(serde_json::to_value(locations).c(h!())?),
        labels: Set(serde_json::to_value(labels).c(h!())?),
        created_at: NotSet,
    }
    .insert(&env.dbx)
    .await
    .c(h!())?;
    Ok(Json(metadata_item_by_id(&env.dbx, row.id).await.c(h!())?))
}

#[post("/api/admin/rer-report/metadata/update")]
pub async fn rer_report_metadata_update(
    env: Data<Env>,
    user: Identity,
    req: Json<UpdateRerReportMetadataReq>,
) -> Result<Json<RerReportMetadataItem>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let (locations, labels) =
        normalize_metadata_lists(req.locations.clone(), req.labels.clone())
            .c(h!())?;
    validate_unit(&env.dbx, req.sigint_unit_id).await.c(h!())?;
    ensure_unit_is_unused(&env.dbx, req.sigint_unit_id, Some(req.id))
        .await
        .c(h!())?;
    let row = sigint_unit_rer_report_metadata::Entity::find_by_id(req.id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
        .c(h!())?;
    let mut row = row.into_active_model();
    row.sigint_unit_id = Set(req.sigint_unit_id);
    row.locations = Set(serde_json::to_value(locations).c(h!())?);
    row.labels = Set(serde_json::to_value(labels).c(h!())?);
    row.update(&env.dbx).await.c(h!())?;
    Ok(Json(metadata_item_by_id(&env.dbx, req.id).await.c(h!())?))
}

#[post("/api/admin/rer-report/metadata/delete")]
pub async fn rer_report_metadata_delete(
    env: Data<Env>,
    user: Identity,
    req: Json<DeleteRerReportMetadataReq>,
) -> Result<Json<()>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let result = sigint_unit_rer_report_metadata::Entity::delete_by_id(req.id)
        .exec(&env.dbx)
        .await
        .c(h!())?;
    if result.rows_affected == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(()))
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
) -> Result<(), AppError>
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
        });
    }
    Ok(())
}

async fn list_metadata<C>(
    dbx: &C,
) -> Result<Vec<RerReportMetadataItem>, AppError>
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
) -> Result<RerReportMetadataItem, AppError>
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
    Ok(metadata_item(row, unit.ok_or(AppError::NotFound).c(h!())?).c(h!())?)
}

fn metadata_item(
    row: sigint_unit_rer_report_metadata::Model,
    unit: sigint_unit::Model,
) -> Result<RerReportMetadataItem, AppError> {
    Ok(RerReportMetadataItem {
        id: row.id,
        sigint_unit_id: row.sigint_unit_id,
        sigint_unit_name: unit.name,
        locations: json_string_list(row.locations).c(h!())?,
        labels: json_string_list(row.labels).c(h!())?,
    })
}

fn json_string_list(value: JsonValue) -> Result<Vec<String>, AppError> {
    serde_json::from_value(value).map_err(|error| AppError::BL {
        msg: format!("Некоректні метадані РЕР: {error}"),
    })
}

fn normalize_metadata_lists(
    locations: Vec<String>,
    labels: Vec<String>,
) -> Result<(Vec<String>, Vec<String>), AppError> {
    let locations = normalize_string_list(locations).c(h!())?;
    let labels = normalize_string_list(labels).c(h!())?;
    if locations.is_empty() && labels.is_empty() {
        return Err(AppError::BL {
            msg: "Додайте принаймні одну локацію або мітку".to_string(),
        });
    }
    Ok((locations, labels))
}

fn normalize_string_list(values: Vec<String>) -> Result<Vec<String>, AppError> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for value in values {
        let value = value.trim().to_string();
        if value.is_empty() {
            return Err(AppError::BL {
                msg: "Порожні значення у метаданих РЕР не дозволені"
                    .to_string(),
            });
        }
        if seen.insert(value.clone()) {
            normalized.push(value);
        }
    }
    Ok(normalized)
}

async fn validate_unit<C>(dbx: &C, unit_id: i64) -> Result<(), AppError>
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
        });
    }
    Ok(())
}

async fn ensure_unit_is_unused<C>(
    dbx: &C,
    unit_id: i64,
    except_id: Option<i64>,
) -> Result<(), AppError>
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
        });
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
            let labels =
                merge_json_lists(target.labels.clone(), source.labels.clone())
                    .c(h!())?;
            let mut target = target.into_active_model();
            target.locations = Set(serde_json::to_value(locations).c(h!())?);
            target.labels = Set(serde_json::to_value(labels).c(h!())?);
            target.update(dbx).await.c(h!())?;
            source.delete(dbx).await.c(h!())?;
        }
    }
    Ok(1)
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
mod tests {
    use super::*;
    use crate::functest::tests::{cleanup_locked, mk_login, mk_sigint_unit};
    use sea_orm::{ActiveModelTrait, EntityTrait};
    use serial_test::serial;

    #[tokio::test]
    #[serial]
    async fn rer_report_eligibility_matches_exact_access_list() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let login = mk_login(&env.dbx, Default::default()).await.unwrap();
        assert!(!user_is_eligible(&env.dbx, &login.id).await.unwrap());

        rer_report_access_login::ActiveModel {
            login_id: Set(login.id),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        assert!(user_is_eligible(&env.dbx, &login.id).await.unwrap());
    }

    #[tokio::test]
    #[serial]
    async fn unit_merge_unions_rer_report_metadata() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let source =
            mk_sigint_unit(&env.dbx, Default::default()).await.unwrap();
        let target =
            mk_sigint_unit(&env.dbx, Default::default()).await.unwrap();
        for (unit_id, locations, labels) in [
            (
                source.id,
                serde_json::json!(["B", "C"]),
                serde_json::json!(["S"]),
            ),
            (
                target.id,
                serde_json::json!(["A", "B"]),
                serde_json::json!(["T"]),
            ),
        ] {
            sigint_unit_rer_report_metadata::ActiveModel {
                sigint_unit_id: Set(unit_id),
                locations: Set(locations),
                labels: Set(labels),
                ..Default::default()
            }
            .insert(&env.dbx)
            .await
            .unwrap();
        }

        assert_eq!(
            merge_unit_metadata(&env.dbx, source.id, target.id)
                .await
                .unwrap(),
            1
        );
        let rows = sigint_unit_rer_report_metadata::Entity::find()
            .all(&env.dbx)
            .await
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].sigint_unit_id, target.id);
        assert_eq!(rows[0].locations, serde_json::json!(["A", "B", "C"]));
        assert_eq!(rows[0].labels, serde_json::json!(["T", "S"]));
    }
}
