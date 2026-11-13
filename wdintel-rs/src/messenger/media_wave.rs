use crate::users::{ensure_base_role, login_id_from_identity};
use std::path::{Path, PathBuf};

use crate::config::{
    MESSENGER_MEDIA_AUDIO_PNG_CONTENT_DISPOSITION,
    MESSENGER_MEDIA_AUDIO_PNG_CONTENT_TYPE, MESSENGER_MEDIA_AUDIO_PNG_TMP_DIR,
};
use crate::entities::signal_message_media;
use crate::error::AppError;
use crate::h;
use crate::messenger::media::{fetch_media_bytes, is_audio_media};
use crate::types::{warn, Env, ShortContext};
use actix_web::http::header;
use actix_web::{get, HttpResponse};
use echo_media::ffmpeg::{AudioImage, AudioImageOptions};
use echo_media::Input;
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

/// Removes a message's cached wave and spectrogram PNGs.
pub(crate) async fn remove_audio_pngs_best_effort(media_id: Uuid) {
    for path in [wave_png_path(media_id), spectrogram_png_path(media_id)] {
        match tokio::fs::remove_file(&path).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => warn!(
                "failed to remove audio PNG file={}: {error:#?}",
                path.display()
            ),
        }
    }
}

fn png_http_response(bytes: Vec<u8>) -> HttpResponse {
    HttpResponse::Ok()
        .insert_header((
            header::CONTENT_TYPE,
            MESSENGER_MEDIA_AUDIO_PNG_CONTENT_TYPE,
        ))
        .insert_header((
            header::CONTENT_DISPOSITION,
            MESSENGER_MEDIA_AUDIO_PNG_CONTENT_DISPOSITION,
        ))
        .body(bytes)
}

/// Only a regular file counts as a cached PNG; anything else (a symlink, a
/// directory) is ignored and replaced by the next generation.
async fn read_cached_png(path: &Path) -> Result<Option<Vec<u8>>, AppError> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) if metadata.is_file() => {
            Ok(Some(tokio::fs::read(path).await.c(h!())?))
        }
        Ok(_) => Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error).c(h!())?,
    }
}

/// Renders the PNG with the sandboxed ffmpeg. Audio that cannot decode is a
/// user-facing error; anything else (timeout, missing ffmpeg) is internal.
async fn generate_png(
    label: &str,
    media_id: Uuid,
    audio_path: &Path,
    output_path: &Path,
    kind: AudioImage,
) -> Result<Vec<u8>, AppError> {
    let input = Input::file(audio_path).c(h!())?;
    let generated = crate::media_sandbox::ffmpeg()
        .c(h!())?
        .audio_image(&input, output_path, &AudioImageOptions::new(kind))
        .await;
    match generated {
        Ok(_) => Ok(tokio::fs::read(output_path).await.c(h!())?),
        Err(error) if error.is_terminal() => {
            warn!("{label} generation failed for media {media_id}: {error}");
            Err(AppError::BL {
                msg: format!("{label} generation failed for media {media_id}"),
            })
        }
        Err(error) => Err(error).c(h!())?,
    }
}

fn ensure_audio_png_source_supported(
    media: &signal_message_media::Model,
) -> Result<(), AppError> {
    if !media.is_encrypted {
        return Err(AppError::NotFound);
    }
    Ok(())
}

async fn load_authorized_audio_media_meta(
    env: &Env,
    login: &uuid::Uuid,
    media_id: Uuid,
) -> Result<signal_message_media::Model, AppError> {
    let media = crate::messenger::audio_ref::authorized(env, login, media_id)
        .await
        .c(h!())?;
    if !is_audio_media(&media) {
        return Err(AppError::NotFound);
    }
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
    login: &uuid::Uuid,
    media_id: Uuid,
    output_path: &Path,
    kind: AudioPngKind,
) -> Result<HttpResponse, AppError> {
    let label = match kind {
        AudioPngKind::Wave => "waveform",
        AudioPngKind::Spectrogram => "spectrogram",
    };
    let media = load_authorized_audio_media_meta(env, login, media_id).await?;
    if super::audio_ref::is_reference(&media) {
        let representation = match kind {
            AudioPngKind::Wave => crate::devices::audio::types::DeviceAudioRepresentation::Wave,
            AudioPngKind::Spectrogram => crate::devices::audio::types::DeviceAudioRepresentation::Spectrogram,
        };
        return crate::devices::audio::message_representation(
            env,
            *login,
            media_id,
            representation,
            None,
        )
        .await;
    }
    if let Some(bytes) = read_cached_png(output_path).await? {
        return Ok(png_http_response(bytes));
    }
    ensure_audio_png_source_supported(&media)?;
    let data = fetch_media_bytes(env, &media).await?;
    let audio_file = write_audio_temp_file(&media, &data).await?;
    let image = match kind {
        AudioPngKind::Wave => AudioImage::Wave,
        AudioPngKind::Spectrogram => AudioImage::Spectrogram,
    };
    let bytes =
        generate_png(label, media_id, audio_file.path(), output_path, image)
            .await?;
    Ok(png_http_response(bytes))
}

#[get("/api/messenger/media/{media_id}/wave")]
pub async fn messenger_media_wave(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    path: actix_web::web::Path<(Uuid,)>,
) -> Result<HttpResponse, AppError> {
    ensure_base_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
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
    ensure_base_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
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
    use super::{
        audio_temp_suffix, ensure_audio_png_source_supported,
        spectrogram_png_path, wave_png_path,
    };
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
            signal_message_uuid: Some(uuid::Uuid::now_v7()),
            content_type: content_type.to_string(),
            file_ext: file_ext.map(str::to_string),
            file_name: file_name.map(str::to_string),
            size_bytes: 0,
            is_encrypted: true,
            storage_key: None,
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
    fn plaintext_audio_does_not_generate_derived_images() {
        let mut media = media("audio/mpeg", Some("mp3"), Some("audio.mp3"));
        media.is_encrypted = false;

        assert!(matches!(
            ensure_audio_png_source_supported(&media),
            Err(crate::error::AppError::NotFound)
        ));
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
