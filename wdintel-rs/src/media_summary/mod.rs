pub mod types;
pub mod worker;

use crate::config::{
    MEDIA_SUMMARY_SETTINGS_ID, MEDIA_SUMMARY_SOURCE_KIND_MAX_CHARS,
    MEDIA_SUMMARY_SOURCE_MAX_CHARS, MEDIA_SUMMARY_TRUNCATION_MARKER,
};
use crate::entities::{
    ai_engine, media_summary as media_summary_entity, media_summary_settings,
    signal_message_media,
};
use crate::h;
use crate::media_summary::types::{
    MediaSummaryEngineItem, MediaSummaryResult, MediaSummarySettingsItem,
    MediaSummaryStatus, SaveMediaSummarySettingsReq,
};
use crate::types::{Env, ShortContext};
use crate::users::ensure_admin;
use actix_identity::Identity;
use actix_web::{get, post, web::Json};
use chrono::Utc;
use sea_orm::{
    ActiveModelTrait,
    ActiveValue::{NotSet, Set},
    ColumnTrait, ConnectionTrait, DatabaseConnection, EntityTrait,
    IntoActiveModel, QueryFilter, QueryOrder, TryInsertResult,
};
use std::collections::HashMap;
use uuid::Uuid;

pub async fn enqueue<C>(
    dbx: &C,
    media_id: Uuid,
    source_kind: &str,
    source_text: &str,
) -> anyhow::Result<bool>
where
    C: ConnectionTrait,
{
    let source_kind = source_kind.trim();
    if source_kind.is_empty()
        || source_kind.chars().count() > MEDIA_SUMMARY_SOURCE_KIND_MAX_CHARS
    {
        anyhow::bail!("invalid media summary source kind");
    }
    let source_text = normalize_plain_text(source_text);
    if source_text.is_empty() {
        return Ok(false);
    }
    let Some(settings) =
        media_summary_settings::Entity::find_by_id(MEDIA_SUMMARY_SETTINGS_ID)
            .filter(media_summary_settings::Column::Enabled.eq(true))
            .one(dbx)
            .await
            .c(h!())?
    else {
        return Ok(false);
    };
    let Some(ai_engine_id) = settings.ai_engine_id else {
        return Ok(false);
    };
    let Some(ai_engine) = ai_engine::Entity::find_by_id(ai_engine_id)
        .filter(ai_engine::Column::Enabled.eq(true))
        .one(dbx)
        .await
        .c(h!())?
    else {
        return Ok(false);
    };
    let source_char_count = source_text.chars().count();
    let source_digest = sha256::digest(source_text.as_bytes());
    let source_text = bound_source_text(&source_text);
    let inserted = media_summary_entity::Entity::insert(
        media_summary_entity::ActiveModel {
            media_id: Set(media_id),
            source_kind: Set(source_kind.to_string()),
            source_digest: Set(source_digest),
            source_text: Set(Some(source_text)),
            source_char_count: Set(i32::try_from(source_char_count).c(h!())?),
            state: NotSet,
            ai_engine_id: Set(Some(ai_engine.id)),
            ai_engine_name: Set(ai_engine.name),
            model_name: Set(ai_engine.model_name),
            attempts: NotSet,
            lease_expires_at: NotSet,
            next_attempt_at: NotSet,
            last_error: NotSet,
            summary: NotSet,
            who: NotSet,
            where_text: NotSet,
            what_happened: NotSet,
            what_next: NotSet,
            purpose: NotSet,
            created_at: NotSet,
            started_at: NotSet,
            completed_at: NotSet,
            updated_at: NotSet,
        },
    )
    .on_conflict_do_nothing()
    .exec_without_returning(dbx)
    .await
    .c(h!())?;
    Ok(matches!(inserted, TryInsertResult::Inserted(_)))
}

pub fn plain_text_from_sanitized_html(html: &str) -> anyhow::Result<String> {
    let html = crate::ocr::package::sanitize_html_without_images(html);
    let dom = tl::parse(&html, tl::ParserOptions::default()).c(h!())?;
    let parser = dom.parser();
    let text = dom
        .children()
        .iter()
        .filter_map(|handle| handle.get(parser))
        .map(|node| node.inner_text(parser))
        .collect::<Vec<_>>()
        .join("\n");
    Ok(normalize_plain_text(&text))
}

pub async fn load_statuses(
    dbx: &DatabaseConnection,
    media: &[signal_message_media::Model],
) -> anyhow::Result<HashMap<Uuid, MediaSummaryStatus>> {
    if media.is_empty() {
        return Ok(HashMap::new());
    }
    let media_ids = media.iter().map(|media| media.id).collect::<Vec<_>>();
    Ok(media_summary_entity::Entity::find()
        .filter(media_summary_entity::Column::MediaId.is_in(media_ids))
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|summary| (summary.media_id, status(&summary)))
        .collect())
}

#[post("/api/admin/media-summary/settings")]
pub async fn save_settings(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<SaveMediaSummarySettingsReq>,
) -> Result<Json<MediaSummarySettingsItem>, crate::error::AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let ai_engine_id = req
        .ai_engine_id
        .as_deref()
        .map(Uuid::parse_str)
        .transpose()
        .map_err(|_| crate::error::AppError::BL {
            msg: "Некоректний UUID ШІ движка".to_string(),
        })?;
    if req.enabled && ai_engine_id.is_none() {
        return Err(crate::error::AppError::BL {
            msg: "Оберіть ШІ движок для стислого опису документів".to_string(),
        });
    }
    if let Some(ai_engine_id) = ai_engine_id {
        let enabled = ai_engine::Entity::find_by_id(ai_engine_id)
            .filter(ai_engine::Column::Enabled.eq(true))
            .one(&env.dbx)
            .await
            .c(h!())?
            .is_some();
        if !enabled {
            return Err(crate::error::AppError::BL {
                msg: "Обраний ШІ движок вимкнено або видалено".to_string(),
            });
        }
    }
    let settings =
        media_summary_settings::Entity::find_by_id(MEDIA_SUMMARY_SETTINGS_ID)
            .one(&env.dbx)
            .await
            .c(h!())?
            .c(h!())?;
    let mut settings = settings.into_active_model();
    settings.enabled = Set(req.enabled);
    settings.ai_engine_id = Set(ai_engine_id);
    settings.updated_at = Set(Utc::now().naive_utc());
    settings.update(&env.dbx).await.c(h!())?;
    Ok(Json(load_settings(&env.dbx).await.c(h!())?))
}

#[get("/api/messenger/media/{media_id}/summary")]
pub async fn messenger_media_summary(
    env: actix_web::web::Data<Env>,
    user: Identity,
    path: actix_web::web::Path<(Uuid,)>,
) -> Result<Json<MediaSummaryResult>, crate::error::AppError> {
    let media = crate::ocr::authorized_media(env.as_ref(), &user, path.0)
        .await
        .c(h!())?;
    let summary = media_summary_entity::Entity::find_by_id(media.id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(crate::error::AppError::NotFound)
        .c(h!())?;
    Ok(Json(result(summary)))
}

pub async fn load_settings(
    dbx: &DatabaseConnection,
) -> anyhow::Result<MediaSummarySettingsItem> {
    let settings =
        media_summary_settings::Entity::find_by_id(MEDIA_SUMMARY_SETTINGS_ID)
            .one(dbx)
            .await
            .c(h!())?
            .c(h!())?;
    let engines = ai_engine::Entity::find()
        .filter(ai_engine::Column::Enabled.eq(true))
        .order_by_asc(ai_engine::Column::Name)
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|ai_engine| MediaSummaryEngineItem {
            id: ai_engine.id.to_string(),
            name: ai_engine.name,
            model_name: ai_engine.model_name,
        })
        .collect();
    Ok(MediaSummarySettingsItem {
        enabled: settings.enabled,
        ai_engine_id: settings.ai_engine_id.map(|id| id.to_string()),
        engines,
    })
}

fn status(summary: &media_summary_entity::Model) -> MediaSummaryStatus {
    MediaSummaryStatus {
        state: summary.state.clone(),
        last_error: summary.last_error.clone(),
    }
}

fn result(summary: media_summary_entity::Model) -> MediaSummaryResult {
    MediaSummaryResult {
        state: summary.state,
        summary: summary.summary,
        who: summary.who,
        where_text: summary.where_text,
        what_happened: summary.what_happened,
        what_next: summary.what_next,
        purpose: summary.purpose,
        last_error: summary.last_error,
        source_kind: summary.source_kind,
        source_char_count: summary.source_char_count,
        ai_engine_name: summary.ai_engine_name,
        model_name: summary.model_name,
    }
}

fn normalize_plain_text(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn bound_source_text(text: &str) -> String {
    let char_count = text.chars().count();
    if char_count <= MEDIA_SUMMARY_SOURCE_MAX_CHARS {
        return text.to_string();
    }
    let marker_chars = MEDIA_SUMMARY_TRUNCATION_MARKER.chars().count();
    let retained = MEDIA_SUMMARY_SOURCE_MAX_CHARS.saturating_sub(marker_chars);
    let beginning_chars = retained / 2;
    let ending_chars = retained - beginning_chars;
    let beginning = text.chars().take(beginning_chars).collect::<String>();
    let mut ending = text.chars().rev().take(ending_chars).collect::<Vec<_>>();
    ending.reverse();
    format!(
        "{beginning}{MEDIA_SUMMARY_TRUNCATION_MARKER}{}",
        ending.into_iter().collect::<String>()
    )
}

#[cfg(test)]
mod tests {
    use super::{bound_source_text, plain_text_from_sanitized_html};
    use crate::config::{
        MEDIA_SUMMARY_SETTINGS_ID, MEDIA_SUMMARY_SOURCE_MAX_CHARS,
        MEDIA_SUMMARY_TRUNCATION_MARKER,
    };
    use crate::entities::{
        ai_engine, media_summary as media_summary_entity,
        media_summary_settings, signal_message_media,
    };
    use sea_orm::{
        ActiveModelTrait, ActiveValue::Set, EntityTrait, IntoActiveModel,
    };
    use uuid::Uuid;

    #[test]
    fn source_text_keeps_the_beginning_and_end_within_limit() {
        let source = format!("{}{}", "а".repeat(40_000), "я".repeat(40_000));
        let bounded = bound_source_text(&source);
        assert_eq!(bounded.chars().count(), MEDIA_SUMMARY_SOURCE_MAX_CHARS);
        assert!(bounded.starts_with('а'));
        assert!(bounded.ends_with('я'));
        assert!(bounded.contains(MEDIA_SUMMARY_TRUNCATION_MARKER));
    }

    #[test]
    fn sanitized_html_becomes_normalized_plain_text() {
        let text = plain_text_from_sanitized_html(
            "<article><p> Перший   рядок </p><script>bad()</script><p>Другий</p></article>",
        )
        .unwrap();
        assert_eq!(text, "Перший рядок Другий");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn enqueue_is_generic_bounded_and_snapshots_the_selected_engine() {
        let env = crate::functest::tests::cleanup().await.unwrap();
        let now = chrono::Utc::now().naive_utc();
        let first_engine = ai_engine::ActiveModel {
            id: Set(Uuid::now_v7()),
            name: Set(format!("summary-first-{}", Uuid::now_v7())),
            url: Set("http://127.0.0.1:8000/v1".to_string()),
            token: Set(None),
            model_name: Set("first-model".to_string()),
            created_at: Set(now),
            updated_at: Set(now),
            enabled: Set(true),
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let second_engine = ai_engine::ActiveModel {
            id: Set(Uuid::now_v7()),
            name: Set(format!("summary-second-{}", Uuid::now_v7())),
            url: Set("http://127.0.0.1:8001/v1".to_string()),
            token: Set(None),
            model_name: Set("second-model".to_string()),
            created_at: Set(now),
            updated_at: Set(now),
            enabled: Set(true),
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let message = crate::functest::tests::mk_signal_message(
            &env.dbx,
            Default::default(),
        )
        .await
        .unwrap();
        let media = signal_message_media::ActiveModel {
            id: Set(Uuid::now_v7()),
            signal_message_id: Set(message.id),
            content_type: Set("image/png".to_string()),
            file_ext: Set(Some("png".to_string())),
            file_name: Set(Some("scan.png".to_string())),
            size_bytes: Set(1),
            created_at: Set(now),
            is_encrypted: Set(true),
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        assert!(media_summary_entity::Entity::find_by_id(media.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .is_none());

        let settings = media_summary_settings::Entity::find_by_id(
            MEDIA_SUMMARY_SETTINGS_ID,
        )
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
        let mut settings = settings.into_active_model();
        settings.enabled = Set(true);
        settings.ai_engine_id = Set(Some(first_engine.id));
        settings.update(&env.dbx).await.unwrap();

        let source =
            format!("{} {}", "початок".repeat(10_000), "кінець".repeat(10_000));
        assert!(super::enqueue(&env.dbx, media.id, "ocr_text", &source)
            .await
            .unwrap());
        let summary = media_summary_entity::Entity::find_by_id(media.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(summary.ai_engine_id, Some(first_engine.id));
        assert_eq!(summary.model_name, "first-model");
        assert_eq!(
            summary.source_text.unwrap().chars().count(),
            MEDIA_SUMMARY_SOURCE_MAX_CHARS
        );
        assert_eq!(summary.source_digest, sha256::digest(source.as_bytes()));

        let settings = media_summary_settings::Entity::find_by_id(
            MEDIA_SUMMARY_SETTINGS_ID,
        )
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
        let mut settings = settings.into_active_model();
        settings.ai_engine_id = Set(Some(second_engine.id));
        settings.update(&env.dbx).await.unwrap();
        let summary = media_summary_entity::Entity::find_by_id(media.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(summary.ai_engine_id, Some(first_engine.id));
        assert!(!super::enqueue(&env.dbx, media.id, "ocr_text", "  \n ")
            .await
            .unwrap());
    }
}
