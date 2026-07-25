use crate::users::login_id_from_identity;
pub mod types;

pub use types::{DutyTagsLayout, UserDutySettingsDto};

use crate::entities::sea_orm_active_enums::UserSettingsTagsLayout as DbTagsLayout;
use crate::entities::{login, user_settings};
use crate::error::AppError;
use crate::h;
use crate::types::{Env, ShortContext};
use actix_identity::Identity;
use actix_web::web::{Data, Json};
use actix_web::{get, put};
use chrono::Utc;
use sea_orm::{
    sea_query::OnConflict, ActiveValue::NotSet, ActiveValue::Set, ColumnTrait,
    DatabaseConnection, EntityTrait, QueryFilter,
};

fn model_to_dto(m: &user_settings::Model) -> UserDutySettingsDto {
    UserDutySettingsDto {
        tags_layout: match m.tags_layout {
            DbTagsLayout::Full => DutyTagsLayout::Full,
            DbTagsLayout::Compact => DutyTagsLayout::Compact,
            DbTagsLayout::Hidden => DutyTagsLayout::Hidden,
        },
        disable_auto_scroll: m.disable_auto_scroll,
        analysis_map_in_sidebar: m.analysis_map_in_sidebar,
        duty_audio_transcription_collapsed: m
            .duty_audio_transcription_collapsed,
        analysis_audio_transcription_collapsed: m
            .analysis_audio_transcription_collapsed,
    }
}

#[get("/api/user/settings")]
pub async fn user_settings_get(
    env: Data<Env>,
    user: Identity,
) -> Result<Json<UserDutySettingsDto>, AppError> {
    let login_id = login_id_from_identity(&user)?;
    load_login(&env.dbx, &login_id).await.c(h!())?;
    let row = user_settings::Entity::find()
        .filter(user_settings::Column::LoginId.eq(login_id))
        .one(&env.dbx)
        .await
        .c(h!())?;
    let dto = match row {
        Some(m) => model_to_dto(&m),
        None => UserDutySettingsDto::default(),
    };
    Ok(Json(dto))
}

#[put("/api/user/settings")]
pub async fn user_settings_put(
    env: Data<Env>,
    user: Identity,
    req: Json<UserDutySettingsDto>,
) -> Result<Json<UserDutySettingsDto>, AppError> {
    let login_id = login_id_from_identity(&user)?;
    load_login(&env.dbx, &login_id).await.c(h!())?;
    let dto = req.into_inner();
    let now = Utc::now().naive_utc();
    user_settings::Entity::insert(user_settings::ActiveModel {
        id: NotSet,
        login_id: Set(login_id),
        tags_layout: Set(match dto.tags_layout {
            DutyTagsLayout::Full => DbTagsLayout::Full,
            DutyTagsLayout::Compact => DbTagsLayout::Compact,
            DutyTagsLayout::Hidden => DbTagsLayout::Hidden,
        }),
        disable_auto_scroll: Set(dto.disable_auto_scroll),
        analysis_map_in_sidebar: Set(dto.analysis_map_in_sidebar),
        duty_audio_transcription_collapsed: Set(
            dto.duty_audio_transcription_collapsed
        ),
        analysis_audio_transcription_collapsed: Set(
            dto.analysis_audio_transcription_collapsed
        ),
        updated_at: Set(now),
    })
    .on_conflict(
        OnConflict::column(user_settings::Column::LoginId)
            .update_columns([
                user_settings::Column::TagsLayout,
                user_settings::Column::DisableAutoScroll,
                user_settings::Column::AnalysisMapInSidebar,
                user_settings::Column::DutyAudioTranscriptionCollapsed,
                user_settings::Column::AnalysisAudioTranscriptionCollapsed,
                user_settings::Column::UpdatedAt,
            ])
            .to_owned(),
    )
    .exec(&env.dbx)
    .await
    .c(h!())?;
    Ok(Json(dto))
}

async fn load_login(
    dbx: &DatabaseConnection,
    login_id: &uuid::Uuid,
) -> Result<(), AppError> {
    login::Entity::find_by_id(*login_id)
        .filter(login::Column::DeletedPermanently.eq(false))
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    Ok(())
}
