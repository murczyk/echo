use crate::users::login_id_from_identity;
pub mod types;

pub use types::{
    DutyTagsLayout, MessageCardQuickAction, MessageTextPreviewLines,
    MessageTimeBasis, UserDutySettingsDto,
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
    ConnectionTrait, DatabaseConnection, EntityTrait, QueryFilter, QuerySelect,
};

async fn default_message_card_quick_action(
    dbx: &DatabaseConnection,
) -> anyhow::Result<MessageCardQuickAction> {
    let hide_networks = crate::system_settings::get_active_system_settings(dbx)
        .await
        .c(h!())?
        .and_then(|settings| settings.hide_networks)
        .unwrap_or(false);
    Ok(if hide_networks {
        MessageCardQuickAction::QuickActionCreateReport
    } else {
        MessageCardQuickAction::QuickActionCopyText
    })
}

fn parse_stored_quick_action(
    value: Option<&str>,
) -> Option<MessageCardQuickAction> {
    serde_json::from_value(serde_json::Value::String(value?.to_owned())).ok()
}

fn quick_action_column(
    action: MessageCardQuickAction,
) -> anyhow::Result<Option<String>> {
    Ok(serde_json::to_value(action)
        .c(h!())?
        .as_str()
        .map(str::to_owned))
}

fn is_valid_quick_action_count(count: u8) -> bool {
    (crate::config::USER_SETTINGS_MESSAGE_CARD_QUICK_ACTION_COUNT_MIN
        ..=crate::config::USER_SETTINGS_MESSAGE_CARD_QUICK_ACTION_COUNT_MAX)
        .contains(&count)
}

/// Keeps the second narrow-card action distinct from the first: a clash falls
/// back to importance, or to the server default when the first is importance.
fn resolve_second_quick_action(
    preferred: MessageCardQuickAction,
    first: MessageCardQuickAction,
    default_first: MessageCardQuickAction,
) -> MessageCardQuickAction {
    let default_second = types::default_message_card_second_quick_action();
    if preferred != first {
        preferred
    } else if first != default_second {
        default_second
    } else {
        default_first
    }
}

fn validate_quick_action_count(
    dto: &UserDutySettingsDto,
) -> Result<(), AppError> {
    if is_valid_quick_action_count(dto.message_card_quick_action_count) {
        Ok(())
    } else {
        Err(AppError::BL {
            msg: "Кількість швидких дій має бути 1 або 2".to_string(),
        })
    }
}

fn model_to_dto(
    m: &user_settings::Model,
    default_quick_action: MessageCardQuickAction,
) -> UserDutySettingsDto {
    let message_card_quick_action =
        parse_stored_quick_action(m.message_card_quick_action.as_deref())
            .unwrap_or(default_quick_action);
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
        large_media_previews: m.large_media_previews.unwrap_or(false),
        large_message_card_text: m.large_message_card_text.unwrap_or(false),
        message_card_quick_action,
        media_summary_enabled: m.media_summary_enabled,
        ai_position_highlights_enabled: m
            .ai_position_highlights_enabled
            .unwrap_or(false),
        message_sort_by: match m.message_sort_by.as_deref() {
            Some("creation") => MessageTimeBasis::MessageCreation,
            _ => MessageTimeBasis::MessageInterception,
        },
        message_auto_parse_enabled: m
            .message_auto_parse_enabled
            .unwrap_or_else(types::default_message_auto_parse_enabled),
        minimal_report_window_enabled: m
            .minimal_report_window_enabled
            .unwrap_or(false),
        duty_remember_report_group: m
            .duty_remember_report_group
            .unwrap_or(true),
        analysis_remember_report_group: m
            .analysis_remember_report_group
            .unwrap_or(true),
        important_only_my_organism: m
            .important_only_my_organism
            .unwrap_or(false),
        duty_hide_card_header: m.duty_hide_card_header.unwrap_or(false),
        duty_hide_card_frequency: m.duty_hide_card_frequency.unwrap_or(false),
        duty_hide_card_unit: m.duty_hide_card_unit.unwrap_or(false),
        message_card_quick_action_count: m
            .message_card_quick_action_count
            .and_then(|count| u8::try_from(count).ok())
            .filter(|count| is_valid_quick_action_count(*count))
            .unwrap_or_else(types::default_message_card_quick_action_count),
        message_card_second_quick_action: resolve_second_quick_action(
            parse_stored_quick_action(
                m.message_card_second_quick_action.as_deref(),
            )
            .unwrap_or_else(types::default_message_card_second_quick_action),
            message_card_quick_action,
            default_quick_action,
        ),
    }
}

fn preserve_omitted_compatibility_fields(
    body: &serde_json::Value,
    incoming: &mut UserDutySettingsDto,
    existing: &UserDutySettingsDto,
) {
    if body.get("largeMessageCardText").is_none() {
        incoming.large_message_card_text = existing.large_message_card_text;
    }
    if body.get("messageCardQuickAction").is_none() {
        incoming.message_card_quick_action = existing.message_card_quick_action;
    }
    if body.get("largeMediaPreviews").is_none() {
        incoming.large_media_previews = existing.large_media_previews;
    }
    if body.get("messageSortBy").is_none() {
        incoming.message_sort_by = existing.message_sort_by;
    }
    if body.get("aiPositionHighlightsEnabled").is_none() {
        incoming.ai_position_highlights_enabled =
            existing.ai_position_highlights_enabled;
    }
    if body.get("messageAutoParseEnabled").is_none() {
        incoming.message_auto_parse_enabled =
            existing.message_auto_parse_enabled;
    }
    if body.get("minimalReportWindowEnabled").is_none() {
        incoming.minimal_report_window_enabled =
            existing.minimal_report_window_enabled;
    }
    if body.get("importantOnlyMyOrganism").is_none() {
        incoming.important_only_my_organism =
            existing.important_only_my_organism;
    }
    if body.get("dutyRememberReportGroup").is_none() {
        incoming.duty_remember_report_group =
            existing.duty_remember_report_group;
    }
    if body.get("analysisRememberReportGroup").is_none() {
        incoming.analysis_remember_report_group =
            existing.analysis_remember_report_group;
    }
    if body.get("dutyHideCardHeader").is_none() {
        incoming.duty_hide_card_header = existing.duty_hide_card_header;
    }
    if body.get("dutyHideCardFrequency").is_none() {
        incoming.duty_hide_card_frequency = existing.duty_hide_card_frequency;
    }
    if body.get("dutyHideCardUnit").is_none() {
        incoming.duty_hide_card_unit = existing.duty_hide_card_unit;
    }
    if body.get("messageCardQuickActionCount").is_none() {
        incoming.message_card_quick_action_count =
            existing.message_card_quick_action_count;
    }
    if body.get("messageCardSecondQuickAction").is_none() {
        incoming.message_card_second_quick_action =
            existing.message_card_second_quick_action;
    }
}

#[get("/api/user/settings")]
pub async fn user_settings_get(
    env: Data<Env>,
    user: Identity,
) -> Result<Json<UserDutySettingsDto>, AppError> {
    let login_id = login_id_from_identity(&user)?;
    load_login(&env.dbx, &login_id).await.c(h!())?;
    let default_quick_action =
        default_message_card_quick_action(&env.dbx).await.c(h!())?;
    let row = user_settings::Entity::find()
        .filter(user_settings::Column::LoginId.eq(login_id))
        .one(&env.dbx)
        .await
        .c(h!())?;
    let dto = match row {
        Some(m) => model_to_dto(&m, default_quick_action),
        None => UserDutySettingsDto {
            message_card_quick_action: default_quick_action,
            ..Default::default()
        },
    };
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
    let quick_action_changed = body.get("messageCardQuickAction").is_some();
    let second_quick_action_changed =
        body.get("messageCardSecondQuickAction").is_some();
    let needs_existing = body.get("largeMessageCardText").is_none()
        || body.get("messageCardQuickAction").is_none()
        || body.get("largeMediaPreviews").is_none()
        || body.get("messageSortBy").is_none()
        || body.get("messageAutoParseEnabled").is_none()
        || body.get("aiPositionHighlightsEnabled").is_none()
        || body.get("minimalReportWindowEnabled").is_none()
        || body.get("importantOnlyMyOrganism").is_none()
        || body.get("dutyRememberReportGroup").is_none()
        || body.get("analysisRememberReportGroup").is_none()
        || body.get("dutyHideCardHeader").is_none()
        || body.get("dutyHideCardFrequency").is_none()
        || body.get("dutyHideCardUnit").is_none()
        || body.get("messageCardQuickActionCount").is_none()
        || !second_quick_action_changed;
    let mut dto: UserDutySettingsDto =
        serde_json::from_value(body.clone()).c(h!())?;
    validate_quick_action_count(&dto)?;
    let default_quick_action =
        default_message_card_quick_action(&env.dbx).await.c(h!())?;
    if needs_existing {
        let existing = user_settings::Entity::find()
            .filter(user_settings::Column::LoginId.eq(login_id))
            .one(&env.dbx)
            .await
            .c(h!())?
            .map(|settings| model_to_dto(&settings, default_quick_action))
            .unwrap_or(UserDutySettingsDto {
                message_card_quick_action: default_quick_action,
                ..Default::default()
            });
        preserve_omitted_compatibility_fields(&body, &mut dto, &existing);
    }
    dto.message_card_second_quick_action = resolve_second_quick_action(
        dto.message_card_second_quick_action,
        dto.message_card_quick_action,
        default_quick_action,
    );
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
        large_media_previews: Set(Some(dto.large_media_previews)),
        large_message_card_text: Set(Some(dto.large_message_card_text)),
        message_card_quick_action: if quick_action_changed {
            Set(quick_action_column(dto.message_card_quick_action).c(h!())?)
        } else {
            NotSet
        },
        message_card_quick_action_count: Set(Some(i16::from(
            dto.message_card_quick_action_count,
        ))),
        message_card_second_quick_action: if second_quick_action_changed {
            Set(quick_action_column(dto.message_card_second_quick_action)
                .c(h!())?)
        } else {
            NotSet
        },
        media_summary_enabled: Set(dto.media_summary_enabled),
        ai_position_highlights_enabled: Set(Some(
            dto.ai_position_highlights_enabled,
        )),
        message_sort_by: Set(Some(match dto.message_sort_by {
            MessageTimeBasis::MessageInterception => "interception".to_owned(),
            MessageTimeBasis::MessageCreation => "creation".to_owned(),
        })),
        message_auto_parse_enabled: Set(Some(dto.message_auto_parse_enabled)),
        minimal_report_window_enabled: Set(Some(
            dto.minimal_report_window_enabled,
        )),
        important_only_my_organism: Set(Some(dto.important_only_my_organism)),
        duty_remember_report_group: Set(Some(dto.duty_remember_report_group)),
        analysis_remember_report_group: Set(Some(
            dto.analysis_remember_report_group,
        )),
        duty_hide_card_header: Set(Some(dto.duty_hide_card_header)),
        duty_hide_card_frequency: Set(Some(dto.duty_hide_card_frequency)),
        duty_hide_card_unit: Set(Some(dto.duty_hide_card_unit)),
        receive_alerts_in_messenger: NotSet,
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
                user_settings::Column::LargeMediaPreviews,
                user_settings::Column::LargeMessageCardText,
                user_settings::Column::MediaSummaryEnabled,
                user_settings::Column::AiPositionHighlightsEnabled,
                user_settings::Column::MessageSortBy,
                user_settings::Column::MessageAutoParseEnabled,
                user_settings::Column::MinimalReportWindowEnabled,
                user_settings::Column::ImportantOnlyMyOrganism,
                user_settings::Column::DutyRememberReportGroup,
                user_settings::Column::AnalysisRememberReportGroup,
                user_settings::Column::DutyHideCardHeader,
                user_settings::Column::DutyHideCardFrequency,
                user_settings::Column::DutyHideCardUnit,
                user_settings::Column::MessageCardQuickActionCount,
                user_settings::Column::UpdatedAt,
            ])
            .update_columns(
                quick_action_changed
                    .then_some(user_settings::Column::MessageCardQuickAction),
            )
            .update_columns(
                second_quick_action_changed.then_some(
                    user_settings::Column::MessageCardSecondQuickAction,
                ),
            )
            .to_owned(),
    )
    .exec(&env.dbx)
    .await
    .c(h!())?;
    Ok(Json(dto))
}

pub async fn ai_position_highlights_enabled<C>(
    dbx: &C,
    login_id: uuid::Uuid,
) -> anyhow::Result<bool>
where
    C: ConnectionTrait,
{
    if crate::system_settings::get_active_system_settings(dbx)
        .await
        .c(h!())?
        .and_then(|settings| settings.ai_position_highlights_enabled)
        .unwrap_or(false)
    {
        return Ok(true);
    }
    Ok(user_settings::Entity::find()
        .select_only()
        .column(user_settings::Column::AiPositionHighlightsEnabled)
        .filter(user_settings::Column::LoginId.eq(login_id))
        .into_tuple::<Option<bool>>()
        .one(dbx)
        .await
        .c(h!())?
        .flatten()
        .unwrap_or(false))
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

#[cfg(test)]
mod functional_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn omitted_auto_parse_setting_preserves_the_stored_value() {
        let body = serde_json::json!({ "tagsLayout": "compact" });
        let mut incoming = UserDutySettingsDto::default();
        let existing = UserDutySettingsDto {
            message_auto_parse_enabled: false,
            message_sort_by: MessageTimeBasis::MessageCreation,
            ..UserDutySettingsDto::default()
        };

        preserve_omitted_compatibility_fields(&body, &mut incoming, &existing);

        assert!(!incoming.message_auto_parse_enabled);
        assert_eq!(incoming.message_sort_by, MessageTimeBasis::MessageCreation);
    }

    #[test]
    fn explicit_auto_parse_setting_overwrites_the_stored_value() {
        let body = serde_json::json!({
            "tagsLayout": "compact",
            "messageAutoParseEnabled": false,
            "messageSortBy": "interception"
        });
        let mut incoming = serde_json::from_value(body.clone()).unwrap();
        let existing = UserDutySettingsDto {
            message_auto_parse_enabled: true,
            message_sort_by: MessageTimeBasis::MessageCreation,
            ..UserDutySettingsDto::default()
        };

        preserve_omitted_compatibility_fields(&body, &mut incoming, &existing);

        assert!(!incoming.message_auto_parse_enabled);
        assert_eq!(
            incoming.message_sort_by,
            MessageTimeBasis::MessageInterception
        );
    }

    #[test]
    fn issue_4219_second_quick_action_never_repeats_the_first() {
        use MessageCardQuickAction::*;
        let cases = [
            (
                QuickActionImportant,
                QuickActionCopyText,
                QuickActionImportant,
            ),
            (
                QuickActionBookmark,
                QuickActionCopyText,
                QuickActionBookmark,
            ),
            (
                QuickActionBookmark,
                QuickActionBookmark,
                QuickActionImportant,
            ),
            (
                QuickActionImportant,
                QuickActionImportant,
                QuickActionCopyText,
            ),
        ];
        for (preferred, first, expected) in cases {
            assert_eq!(
                resolve_second_quick_action(
                    preferred,
                    first,
                    QuickActionCopyText
                ),
                expected,
                "{preferred:?} after {first:?}"
            );
        }
        assert_eq!(
            resolve_second_quick_action(
                QuickActionImportant,
                QuickActionImportant,
                QuickActionCreateReport
            ),
            QuickActionCreateReport
        );
    }

    #[test]
    fn issue_4219_quick_action_count_accepts_only_one_or_two() {
        for (count, valid) in [(0, false), (1, true), (2, true), (3, false)] {
            let dto = UserDutySettingsDto {
                message_card_quick_action_count: count,
                ..UserDutySettingsDto::default()
            };
            assert_eq!(
                validate_quick_action_count(&dto).is_ok(),
                valid,
                "count {count}"
            );
        }
    }
}
