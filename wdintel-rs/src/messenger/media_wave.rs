use std::path::{Path, PathBuf};

use crate::config::MESSENGER_MEDIA_AUDIO_PNG_TMP_DIR;
use crate::entities::signal_message_media;
use crate::error::AppError;
use crate::h;
use crate::messenger::media::{
    ensure_media_access, fetch_media_bytes, is_audio_media,
};
use crate::types::{warn, Env, ShortContext};
use actix_web::http::header;
use actix_web::{get, HttpResponse};
use milgeo_audio_wave::{
    generate_spectrogram_png, generate_wave_png, PngGenRequest, PngGenResult,
    PNG_CONTENT_DISPOSITION, PNG_CONTENT_TYPE,
};
use sea_orm::EntityTrait;
use uuid::Uuid;

fn audio_temp_suffix(media: &signal_message_media::Model) -> &'static str {
    if let Some(ext) = media.file_ext.as_deref() {
        match ext.to_ascii_lowercase().as_str() {
            "mp3" | "mpeg" | "mpga" => return ".mp3",
            "wav" => return ".wav",
            "ogg" | "oga" => return ".ogg",
            "opus" => return ".opus",
            "m4a" => return ".m4a",
            "aac" => return ".aac",
            "flac" => return ".flac",
            "webm" => return ".webm",
            _ => {}
        }
    }
    if let Some(name) = media.file_name.as_deref() {
        let name = name.to_ascii_lowercase();
        if name.ends_with(".wav") {
            return ".wav";
        }
        if name.ends_with(".ogg") {
            return ".ogg";
        }
        if name.ends_with(".m4a") {
            return ".m4a";
        }
        if name.ends_with(".aac") {
            return ".aac";
        }
        if name.ends_with(".flac") {
            return ".flac";
        }
        if name.ends_with(".opus") {
            return ".opus";
        }
        if name.ends_with(".webm") {
            return ".webm";
        }
    }
    ".mp3"
}

fn wave_png_path(media_id: Uuid) -> PathBuf {
    PathBuf::from(format!(
        "{MESSENGER_MEDIA_AUDIO_PNG_TMP_DIR}/wave-{media_id}.png"
    ))
}

fn spectrogram_png_path(media_id: Uuid) -> PathBuf {
    PathBuf::from(format!(
        "{MESSENGER_MEDIA_AUDIO_PNG_TMP_DIR}/spectrogram-{media_id}.png"
    ))
}

fn png_http_response(bytes: Vec<u8>) -> HttpResponse {
    HttpResponse::Ok()
        .insert_header((header::CONTENT_TYPE, PNG_CONTENT_TYPE))
        .insert_header((header::CONTENT_DISPOSITION, PNG_CONTENT_DISPOSITION))
        .body(bytes)
}

fn png_gen_or_err(
    label: &str,
    media_id: Uuid,
    png: PngGenResult,
) -> Result<HttpResponse, AppError> {
    if png.used_fallback {
        warn!(
            "{label} generation failed for media {media_id}; ensure ffmpeg is installed and on PATH"
        );
        return Err(AppError::BL {
            msg: format!(
                "{label} generation failed for media {media_id}; ffmpeg is required"
            ),
        });
    }
    Ok(png_http_response(png.bytes))
}

async fn read_cached_png(path: &Path) -> Result<Option<Vec<u8>>, AppError> {
    if !tokio::fs::try_exists(path).await.c(h!())? {
        return Ok(None);
    }
    let bytes = tokio::fs::read(path).await.c(h!())?;
    Ok(Some(bytes))
}

async fn load_authorized_audio_media_meta(
    env: &Env,
    login: &str,
    media_id: Uuid,
) -> Result<signal_message_media::Model, AppError> {
    let media = signal_message_media::Entity::find_by_id(media_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    if !is_audio_media(&media) {
        return Err(AppError::NotFound);
    }
    ensure_media_access(&env.dbx, login, media.signal_message_id).await?;
    Ok(media)
}

async fn write_audio_temp_file(
    media: &signal_message_media::Model,
    data: &[u8],
) -> Result<tempfile::NamedTempFile, AppError> {
    let suffix = audio_temp_suffix(media);
    let temp_file = tempfile::Builder::new()
        .prefix("echo-inbox-audio-")
        .suffix(suffix)
        .rand_bytes(5)
        .tempfile()
        .c(h!())?;
    tokio::fs::write(temp_file.path(), data).await.c(h!())?;
    Ok(temp_file)
}

enum AudioPngKind {
    Wave,
    Spectrogram,
}

async fn serve_cached_or_generate_png(
    env: &Env,
    login: &str,
    media_id: Uuid,
    output_path: &Path,
    kind: AudioPngKind,
) -> Result<HttpResponse, AppError> {
    let label = match kind {
        AudioPngKind::Wave => "waveform",
        AudioPngKind::Spectrogram => "spectrogram",
    };
    let media = load_authorized_audio_media_meta(env, login, media_id).await?;
    if let Some(bytes) = read_cached_png(output_path).await? {
        return Ok(png_http_response(bytes));
    }
    let data = fetch_media_bytes(env, &media).await?;
    let audio_file = write_audio_temp_file(&media, &data).await?;
    let req = PngGenRequest::new(audio_file.path(), output_path);
    let png = match kind {
        AudioPngKind::Wave => generate_wave_png(&req).await,
        AudioPngKind::Spectrogram => generate_spectrogram_png(&req).await,
    };
    png_gen_or_err(label, media_id, png)
}

#[get("/api/messenger/media/{media_id}/wave")]
pub async fn messenger_media_wave(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    path: actix_web::web::Path<(Uuid,)>,
) -> Result<HttpResponse, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .c(h!())?;
    let media_id = path.0;
    serve_cached_or_generate_png(
        env.as_ref(),
        &login,
        media_id,
        &wave_png_path(media_id),
        AudioPngKind::Wave,
    )
    .await
}

#[get("/api/messenger/media/{media_id}/spectrogram")]
pub async fn messenger_media_spectrogram(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    path: actix_web::web::Path<(Uuid,)>,
) -> Result<HttpResponse, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .c(h!())?;
    let media_id = path.0;
    serve_cached_or_generate_png(
        env.as_ref(),
        &login,
        media_id,
        &spectrogram_png_path(media_id),
        AudioPngKind::Spectrogram,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::{audio_temp_suffix, spectrogram_png_path, wave_png_path};
    use crate::config::MESSENGER_MEDIA_AUDIO_PNG_TMP_DIR;
    use crate::entities::signal_message_media;
    use sea_orm::prelude::DateTime;
    use std::path::PathBuf;

    fn media(
        content_type: &str,
        file_ext: Option<&str>,
        file_name: Option<&str>,
    ) -> signal_message_media::Model {
        signal_message_media::Model {
            id: uuid::Uuid::nil(),
            signal_message_id: 1,
            content_type: content_type.to_string(),
            file_ext: file_ext.map(str::to_string),
            file_name: file_name.map(str::to_string),
            size_bytes: 0,
            created_at: DateTime::default(),
        }
    }

    #[test]
    fn audio_temp_suffix_defaults_to_mp3() {
        assert_eq!(audio_temp_suffix(&media("audio/mpeg", None, None)), ".mp3");
    }

    #[test]
    fn audio_temp_suffix_uses_file_ext() {
        assert_eq!(
            audio_temp_suffix(&media("audio/ogg", Some("ogg"), None)),
            ".ogg"
        );
    }

    #[test]
    fn wave_png_path_uses_tmp_dir_and_media_id() {
        let media_id =
            uuid::Uuid::parse_str("550e8400-e29b-41d4-a716-446655440000")
                .unwrap();
        assert_eq!(
            wave_png_path(media_id),
            PathBuf::from(format!(
                "{MESSENGER_MEDIA_AUDIO_PNG_TMP_DIR}/wave-{media_id}.png"
            ))
        );
    }

    #[test]
    fn spectrogram_png_path_uses_tmp_dir_and_media_id() {
        let media_id =
            uuid::Uuid::parse_str("550e8400-e29b-41d4-a716-446655440000")
                .unwrap();
        assert_eq!(
            spectrogram_png_path(media_id),
            PathBuf::from(format!(
                "{MESSENGER_MEDIA_AUDIO_PNG_TMP_DIR}/spectrogram-{media_id}.png"
            ))
        );
    }
}
