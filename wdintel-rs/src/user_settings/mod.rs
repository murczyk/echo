use crate::users::{has_role, login_id_from_identity};
pub mod types;

pub use types::{
    DutyTagsLayout, MessageTextPreviewLines, MessageTimeBasis,
    UserDutySettingsDto,
};

use crate::entities::sea_orm_active_enums::{
    UserSettingsMessageTextPreviewLines as DbMessageTextPreviewLines,
    UserSettingsTagsLayout as DbTagsLayout,
};
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
        message_text_preview_lines: match m.message_text_preview_lines {
            DbMessageTextPreviewLines::Twenty => {
                MessageTextPreviewLines::Twenty
            }
            DbMessageTextPreviewLines::Forty => MessageTextPreviewLines::Forty,
            DbMessageTextPreviewLines::Off => MessageTextPreviewLines::Off,
        },
        disable_auto_scroll: m.disable_auto_scroll,
        analysis_map_in_sidebar: m.analysis_map_in_sidebar,
        duty_audio_transcription_collapsed: m
            .duty_audio_transcription_collapsed,
        analysis_audio_transcription_collapsed: m
            .analysis_audio_transcription_collapsed,
        show_analysis_callsign_add_form: m.show_analysis_callsign_add_form,
        show_classic_duty: m.show_classic_duty,
        show_classic_analysis: m.show_classic_analysis,
        duty_collapse_media_previews: m.duty_collapse_media_previews,
        media_summary_enabled: m.media_summary_enabled,
        message_sort_by: match m.message_sort_by.as_deref() {
            Some("creation") => MessageTimeBasis::MessageCreation,
            _ => MessageTimeBasis::MessageInterception,
        },
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
    let mut dto = match row {
        Some(m) => model_to_dto(&m),
        None => UserDutySettingsDto::default(),
    };
    if dto.message_sort_by == MessageTimeBasis::MessageCreation
        && has_role(&env.dbx, &login_id, "Cyber").await.is_err()
    {
        dto.message_sort_by = MessageTimeBasis::MessageInterception;
    }
    Ok(Json(dto))
}

#[put("/api/user/settings")]
pub async fn user_settings_put(
    env: Data<Env>,
    user: Identity,
    req: Json<serde_json::Value>,
) -> Result<Json<UserDutySettingsDto>, AppError> {
    let login_id = login_id_from_identity(&user)?;
    load_login(&env.dbx, &login_id).await.c(h!())?;
    let body = req.into_inner();
    let has_explicit_message_sort_by = body.get("messageSortBy").is_some();
    let mut dto: UserDutySettingsDto = serde_json::from_value(body).c(h!())?;
    if !has_explicit_message_sort_by {
        dto.message_sort_by = user_settings::Entity::find()
            .filter(user_settings::Column::LoginId.eq(login_id))
            .one(&env.dbx)
            .await
            .c(h!())?
            .map(|settings| model_to_dto(&settings).message_sort_by)
            .unwrap_or_default();
    }
    if dto.message_sort_by == MessageTimeBasis::MessageCreation {
        has_role(&env.dbx, &login_id, "Cyber").await.c(h!())?;
    }
    let now = Utc::now().naive_utc();
    user_settings::Entity::insert(user_settings::ActiveModel {
        id: NotSet,
        login_id: Set(login_id),
        tags_layout: Set(match dto.tags_layout {
            DutyTagsLayout::Full => DbTagsLayout::Full,
            DutyTagsLayout::Compact => DbTagsLayout::Compact,
            DutyTagsLayout::Hidden => DbTagsLayout::Hidden,
        }),
        message_text_preview_lines: Set(match dto.message_text_preview_lines {
            MessageTextPreviewLines::Twenty => {
                DbMessageTextPreviewLines::Twenty
            }
            MessageTextPreviewLines::Forty => DbMessageTextPreviewLines::Forty,
            MessageTextPreviewLines::Off => DbMessageTextPreviewLines::Off,
        }),
        disable_auto_scroll: Set(dto.disable_auto_scroll),
        analysis_map_in_sidebar: Set(dto.analysis_map_in_sidebar),
        duty_audio_transcription_collapsed: Set(
            dto.duty_audio_transcription_collapsed
        ),
        analysis_audio_transcription_collapsed: Set(
            dto.analysis_audio_transcription_collapsed
        ),
        show_analysis_callsign_add_form: Set(
            dto.show_analysis_callsign_add_form
        ),
        show_classic_duty: Set(dto.show_classic_duty),
        show_classic_analysis: Set(dto.show_classic_analysis),
        duty_collapse_media_previews: Set(dto.duty_collapse_media_previews),
        media_summary_enabled: Set(dto.media_summary_enabled),
        message_sort_by: Set(Some(match dto.message_sort_by {
            MessageTimeBasis::MessageInterception => "interception".to_owned(),
            MessageTimeBasis::MessageCreation => "creation".to_owned(),
        })),
        updated_at: Set(now),
    })
    .on_conflict(
        OnConflict::column(user_settings::Column::LoginId)
            .update_columns([
                user_settings::Column::TagsLayout,
                user_settings::Column::MessageTextPreviewLines,
                user_settings::Column::DisableAutoScroll,
                user_settings::Column::AnalysisMapInSidebar,
                user_settings::Column::DutyAudioTranscriptionCollapsed,
                user_settings::Column::AnalysisAudioTranscriptionCollapsed,
                user_settings::Column::ShowAnalysisCallsignAddForm,
                user_settings::Column::ShowClassicDuty,
                user_settings::Column::ShowClassicAnalysis,
                user_settings::Column::DutyCollapseMediaPreviews,
                user_settings::Column::MediaSummaryEnabled,
                user_settings::Column::MessageSortBy,
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
