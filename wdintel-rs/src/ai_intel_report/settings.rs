use super::types::{
    AiIntelReportEngineBudgetItem, AiIntelReportSettingsItem,
    SaveAiIntelReportSettingsReq,
};
use crate::config::{
    AI_INTEL_REPORT_OUTPUT_MAX_TOKENS, AI_INTEL_REPORT_OUTPUT_TOKEN_LIMIT,
    AI_INTEL_REPORT_SETTINGS_ID, AI_INTEL_REPORT_TIMEOUT_LIMIT_SECS,
    AI_INTEL_REPORT_TIMEOUT_SECS,
};
use crate::entities::{
    ai_engine, ai_intel_report_engine_budget, ai_intel_report_settings,
};
use crate::error::AppError;
use crate::h;
use crate::types::{Env, ShortContext};
use crate::users::ensure_admin;
use actix_identity::Identity;
use actix_web::{get, post, web::Json};
use chrono::Utc;
use sea_orm::{
    sea_query::OnConflict, ActiveModelTrait, ActiveValue::Set, ColumnTrait,
    Condition, ConnectionTrait, DatabaseConnection, EntityTrait,
    IntoActiveModel, QueryFilter, QueryOrder, QuerySelect, TransactionTrait,
};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

#[get("/api/admin/ai-intel-report/settings")]
pub async fn get_settings(
    env: actix_web::web::Data<Env>,
    user: Identity,
) -> Result<Json<AiIntelReportSettingsItem>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    Ok(Json(load_settings_item(&env.dbx).await.c(h!())?))
}

#[post("/api/admin/ai-intel-report/settings")]
pub async fn save_settings(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<SaveAiIntelReportSettingsReq>,
) -> Result<Json<AiIntelReportSettingsItem>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let settings = load_settings(&env.dbx).await.c(h!())?;
    let settings = prepare_settings(&env.dbx, settings, &req).await.c(h!())?;
    let budgets = prepare_budgets(&env.dbx, req.engine_budgets.as_deref())
        .await
        .c(h!())?;
    let txn = env.dbx.begin().await.c(h!())?;
    settings.update(&txn).await.c(h!())?;
    if !budgets.is_empty() {
        ai_intel_report_engine_budget::Entity::insert_many(budgets)
            .on_conflict(
                OnConflict::column(
                    ai_intel_report_engine_budget::Column::AiEngineId,
                )
                .update_column(ai_intel_report_engine_budget::Column::MaxTokens)
                .to_owned(),
            )
            .exec(&txn)
            .await
            .c(h!())?;
    }
    txn.commit().await.c(h!())?;
    Ok(Json(load_settings_item(&env.dbx).await.c(h!())?))
}

async fn prepare_settings(
    db: &DatabaseConnection,
    settings: ai_intel_report_settings::Model,
    req: &SaveAiIntelReportSettingsReq,
) -> Result<ai_intel_report_settings::ActiveModel, AppError> {
    let primary_id = req
        .quick_ai_engine_id
        .as_deref()
        .map(parse_uuid)
        .transpose()
        .c(h!())?;
    let fallback_id = match &req.fallback_ai_engine_id {
        Some(id) => id.as_deref().map(parse_uuid).transpose().c(h!())?,
        None => settings.fallback_ai_engine_id,
    };
    if req.quick_suggestion_enabled && primary_id.is_none() {
        return Err(AppError::BL {
            msg: "Оберіть основну ШІ модель для розвіддонесень".into(),
        });
    }
    if primary_id.is_some() && primary_id == fallback_id {
        return Err(AppError::BL {
            msg: "Основна та резервна ШІ моделі мають відрізнятися".into(),
        });
    }
    for id in [primary_id, fallback_id].into_iter().flatten() {
        find_eligible_engine(db, id).await.c(h!())?;
    }
    let primary_timeout = timeout_value(
        req.primary_timeout_secs.or(settings.primary_timeout_secs),
    )
    .c(h!())?;
    let fallback_timeout = timeout_value(
        req.fallback_timeout_secs.or(settings.fallback_timeout_secs),
    )
    .c(h!())?;
    let total_timeout =
        timeout_value(req.total_timeout_secs.or(settings.total_timeout_secs))
            .c(h!())?;
    let mut settings = settings.into_active_model();
    settings.quick_suggestion_enabled = Set(req.quick_suggestion_enabled);
    settings.quick_ai_engine_id = Set(primary_id);
    settings.fallback_ai_engine_id = Set(fallback_id);
    settings.primary_timeout_secs = Set(Some(primary_timeout));
    settings.fallback_timeout_secs = Set(Some(fallback_timeout));
    settings.total_timeout_secs = Set(Some(total_timeout));
    settings.updated_at = Set(Utc::now().naive_utc());
    Ok(settings)
}

fn timeout_value(value: Option<i32>) -> Result<i32, AppError> {
    let value = value.unwrap_or(AI_INTEL_REPORT_TIMEOUT_SECS);
    if !(1..=AI_INTEL_REPORT_TIMEOUT_LIMIT_SECS).contains(&value) {
        return Err(AppError::BL {
            msg: format!("Ліміт часу має бути від 1 до {AI_INTEL_REPORT_TIMEOUT_LIMIT_SECS} с"),
        });
    }
    Ok(value)
}

async fn prepare_budgets(
    db: &DatabaseConnection,
    budgets: Option<&[AiIntelReportEngineBudgetItem]>,
) -> Result<Vec<ai_intel_report_engine_budget::ActiveModel>, AppError> {
    let engines = ai_engine::Entity::find()
        .select_only()
        .column(ai_engine::Column::Id)
        .into_tuple::<Uuid>()
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .collect::<HashSet<_>>();
    let mut seen = HashSet::new();
    let mut values = Vec::new();
    for budget in budgets.unwrap_or_default() {
        let id = parse_uuid(&budget.ai_engine_id).c(h!())?;
        if !engines.contains(&id) || !seen.insert(id) {
            return Err(AppError::BL {
                msg: "Список бюджетів містить невідому або повторну ШІ модель"
                    .into(),
            });
        }
        if !(1..=AI_INTEL_REPORT_OUTPUT_TOKEN_LIMIT)
            .contains(&budget.max_tokens)
        {
            return Err(AppError::BL {
                msg: format!("Бюджет токенів має бути від 1 до {AI_INTEL_REPORT_OUTPUT_TOKEN_LIMIT}"),
            });
        }
        values.push(ai_intel_report_engine_budget::ActiveModel {
            ai_engine_id: Set(id),
            max_tokens: Set(budget.max_tokens),
        });
    }
    Ok(values)
}

pub(super) async fn load_settings(
    db: &DatabaseConnection,
) -> Result<ai_intel_report_settings::Model, AppError> {
    Ok(ai_intel_report_settings::Entity::find_by_id(
        AI_INTEL_REPORT_SETTINGS_ID,
    )
    .one(db)
    .await
    .c(h!())?
    .c(h!())?)
}

pub(super) async fn load_settings_item(
    db: &DatabaseConnection,
) -> Result<AiIntelReportSettingsItem, AppError> {
    let settings = load_settings(db).await.c(h!())?;
    let engines = ai_engine::Entity::find()
        .select_only()
        .column(ai_engine::Column::Id)
        .order_by_asc(ai_engine::Column::Name)
        .into_tuple::<Uuid>()
        .all(db)
        .await
        .c(h!())?;
    let budgets = ai_intel_report_engine_budget::Entity::find()
        .all(db)
        .await
        .c(h!())?;
    let budgets = budgets
        .into_iter()
        .map(|budget| (budget.ai_engine_id, budget.max_tokens))
        .collect::<HashMap<_, _>>();
    Ok(AiIntelReportSettingsItem {
        quick_suggestion_enabled: settings.quick_suggestion_enabled,
        quick_ai_engine_id: settings
            .quick_ai_engine_id
            .map(|id| id.to_string()),
        fallback_ai_engine_id: settings
            .fallback_ai_engine_id
            .map(|id| id.to_string()),
        engine_budgets: engines
            .into_iter()
            .map(|engine_id| AiIntelReportEngineBudgetItem {
                ai_engine_id: engine_id.to_string(),
                max_tokens: budgets
                    .get(&engine_id)
                    .copied()
                    .unwrap_or(AI_INTEL_REPORT_OUTPUT_MAX_TOKENS),
            })
            .collect(),
        primary_timeout_secs: settings
            .primary_timeout_secs
            .unwrap_or(AI_INTEL_REPORT_TIMEOUT_SECS),
        fallback_timeout_secs: settings
            .fallback_timeout_secs
            .unwrap_or(AI_INTEL_REPORT_TIMEOUT_SECS),
        total_timeout_secs: settings
            .total_timeout_secs
            .unwrap_or(AI_INTEL_REPORT_TIMEOUT_SECS),
        legacy_comment_cutoff: settings
            .legacy_comment_cutoff
            .and_utc()
            .timestamp_millis(),
        updated_at: settings.updated_at.and_utc().timestamp_millis(),
    })
}

pub(super) async fn load_engine_budget(
    db: &DatabaseConnection,
    id: Uuid,
) -> anyhow::Result<i32> {
    Ok(ai_intel_report_engine_budget::Entity::find_by_id(id)
        .one(db)
        .await
        .c(h!())?
        .map(|budget| budget.max_tokens)
        .unwrap_or(AI_INTEL_REPORT_OUTPUT_MAX_TOKENS))
}

pub(super) async fn find_eligible_engine(
    db: &DatabaseConnection,
    id: Uuid,
) -> Result<ai_engine::Model, AppError> {
    ai_engine::Entity::find_by_id(id)
        .filter(ai_engine::Column::Enabled.eq(true))
        .filter(ai_engine::Column::CallsignEnabled.eq(true))
        .one(db).await.c(h!())?
        .ok_or_else(|| AppError::BL {
            msg: "Обрана ШІ модель вимкнена або не підтримує обробку розвіддонесень".into(),
        })
}

pub(crate) async fn ensure_engine_not_used<C: ConnectionTrait>(
    db: &C,
    id: Uuid,
) -> Result<(), AppError> {
    let used = ai_intel_report_settings::Entity::find()
        .filter(
            ai_intel_report_settings::Column::QuickSuggestionEnabled.eq(true),
        )
        .filter(
            Condition::any()
                .add(ai_intel_report_settings::Column::QuickAiEngineId.eq(id))
                .add(
                    ai_intel_report_settings::Column::FallbackAiEngineId.eq(id),
                ),
        )
        .one(db)
        .await
        .c(h!())?
        .is_some();
    if used {
        return Err(AppError::BL {
            msg: "ШІ модель використовується швидкими розвіддонесеннями. Спочатку вимкніть пропозиції або виберіть іншу модель.".into(),
        });
    }
    Ok(())
}

fn parse_uuid(value: &str) -> Result<Uuid, AppError> {
    Uuid::parse_str(value).map_err(|_| AppError::BL {
        msg: "Некоректний UUID ШІ моделі".into(),
    })
}
