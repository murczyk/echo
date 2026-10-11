use super::types::{
    ListSettlementAliasesReq, ListSettlementAliasesRsp, SaveSettlementAliasReq,
    SearchAliasSettlementsReq, SettlementAliasIdReq, SettlementAliasItem,
    SettlementAliasSettlement,
};
use crate::config::{SETTLEMENT_ALIAS_MAX_CHARS, SETTLEMENT_ALIAS_PAGE_SIZE};
use crate::entities::{settlement, settlement_alias};
use crate::error::AppError;
use crate::h;
use crate::types::{Env, ShortContext};
use crate::users::ensure_admin;
use actix_identity::Identity;
use actix_web::{post, web};
use anyhow::Context;
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, ConnectionTrait,
    EntityTrait, FromQueryResult, IntoActiveModel, JoinType, QueryFilter,
    QueryOrder, QuerySelect, RelationTrait, SqlErr,
};
use uuid::Uuid;

#[cfg(test)]
mod tests;

#[post("/api/admin/ai-settlements/aliases/list")]
pub async fn list_settlement_aliases(
    env: web::Data<Env>,
    user: Identity,
    req: web::Json<ListSettlementAliasesReq>,
) -> Result<web::Json<ListSettlementAliasesRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let after_id = req
        .after_id
        .as_deref()
        .map(super::parse_uuid)
        .transpose()
        .context(h!())?
        .unwrap_or(Uuid::nil());
    Ok(web::Json(load_aliases(&env.dbx, after_id).await.c(h!())?))
}

#[post("/api/admin/ai-settlements/aliases/settlements")]
pub async fn search_alias_settlements(
    env: web::Data<Env>,
    user: Identity,
    req: web::Json<SearchAliasSettlementsReq>,
) -> Result<web::Json<Vec<SettlementAliasSettlement>>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    Ok(web::Json(
        search_settlements(&env.dbx, &req.query).await.c(h!())?,
    ))
}

#[post("/api/admin/ai-settlements/aliases/save")]
pub async fn save_settlement_alias(
    env: web::Data<Env>,
    user: Identity,
    req: web::Json<SaveSettlementAliasReq>,
) -> Result<web::Json<SettlementAliasItem>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    Ok(web::Json(
        save_alias(&env.dbx, req.into_inner()).await.context(h!())?,
    ))
}

#[post("/api/admin/ai-settlements/aliases/delete")]
pub async fn delete_settlement_alias(
    env: web::Data<Env>,
    user: Identity,
    req: web::Json<SettlementAliasIdReq>,
) -> Result<web::Json<()>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let id = super::parse_uuid(&req.id).context(h!())?;
    delete_alias(&env.dbx, id).await.context(h!())?;
    Ok(web::Json(()))
}

#[derive(FromQueryResult)]
struct AliasRow {
    id: Uuid,
    settlement_id: i32,
    text: String,
    name: String,
    district: Option<String>,
    region: Option<String>,
}

async fn load_aliases<C: ConnectionTrait>(
    dbx: &C,
    after_id: Uuid,
) -> anyhow::Result<ListSettlementAliasesRsp> {
    let mut rows = settlement_alias::Entity::find()
        .select_only()
        .columns([
            settlement_alias::Column::Id,
            settlement_alias::Column::SettlementId,
            settlement_alias::Column::Text,
        ])
        .columns([
            settlement::Column::Name,
            settlement::Column::District,
            settlement::Column::Region,
        ])
        .join(
            JoinType::InnerJoin,
            settlement_alias::Relation::Settlement.def(),
        )
        .filter(settlement_alias::Column::Id.gt(after_id))
        .order_by_asc(settlement_alias::Column::Id)
        .limit(SETTLEMENT_ALIAS_PAGE_SIZE + 1)
        .into_model::<AliasRow>()
        .all(dbx)
        .await
        .c(h!())?;
    let next_id = if rows.len() > SETTLEMENT_ALIAS_PAGE_SIZE as usize {
        rows.pop();
        rows.last().map(|row| row.id.to_string())
    } else {
        None
    };
    Ok(ListSettlementAliasesRsp {
        items: rows
            .into_iter()
            .map(|row| SettlementAliasItem {
                id: row.id.to_string(),
                text: row.text,
                settlement: SettlementAliasSettlement {
                    id: row.settlement_id,
                    name: row.name,
                    district: row.district,
                    region: row.region,
                },
            })
            .collect(),
        next_id,
    })
}

async fn search_settlements<C: ConnectionTrait>(
    dbx: &C,
    query: &str,
) -> anyhow::Result<Vec<SettlementAliasSettlement>> {
    Ok(crate::settlement::search_by_name(dbx, query)
        .await
        .c(h!())?
        .into_iter()
        .map(|settlement| SettlementAliasSettlement {
            id: settlement.id,
            name: settlement.name,
            district: settlement.district,
            region: settlement.region,
        })
        .collect())
}

async fn save_alias<C: ConnectionTrait>(
    dbx: &C,
    req: SaveSettlementAliasReq,
) -> Result<SettlementAliasItem, AppError> {
    let text = super::validate_required(
        req.text.split_whitespace().collect::<Vec<_>>().join(" "),
        "Вкажіть текст синоніма",
        SETTLEMENT_ALIAS_MAX_CHARS,
    )
    .context(h!())?;
    let settlement = settlement::Entity::find_by_id(req.settlement_id)
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
        .context(h!())?;
    let is_edit = req.id.is_some();
    let mut alias = if let Some(id) = req.id {
        settlement_alias::Entity::find_by_id(
            super::parse_uuid(&id).context(h!())?,
        )
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
        .context(h!())?
        .into_active_model()
    } else {
        settlement_alias::ActiveModel {
            id: Set(Uuid::now_v7()),
            ..Default::default()
        }
    };
    alias.settlement_id = Set(settlement.id);
    alias.text = Set(text);
    let alias = if is_edit {
        alias.update(dbx).await
    } else {
        alias.insert(dbx).await
    }
    .map_err(|error| match error.sql_err() {
        Some(SqlErr::UniqueConstraintViolation(_)) => AppError::BL {
            msg: "Цей синонім уже додано для вибраного населеного пункту"
                .to_string(),
        },
        _ => AppError::from(anyhow::Error::new(error).context(h!())),
    })
    .context(h!())?;
    Ok(SettlementAliasItem {
        id: alias.id.to_string(),
        text: alias.text,
        settlement: SettlementAliasSettlement {
            id: settlement.id,
            name: settlement.name,
            district: settlement.district,
            region: settlement.region,
        },
    })
}

async fn delete_alias<C: ConnectionTrait>(
    dbx: &C,
    id: Uuid,
) -> Result<(), AppError> {
    let result = settlement_alias::Entity::delete_by_id(id)
        .exec(dbx)
        .await
        .c(h!())?;
    if result.rows_affected == 0 {
        return Err(AppError::NotFound);
    }
    Ok(())
}
