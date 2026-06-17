use crate::entities::signal_message_media;
use crate::error::AppError;
use crate::h;
use crate::messenger::media::{
    ensure_media_access, fetch_media_bytes, is_audio_media,
};
use crate::types::{Env, ShortContext, warn};
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

fn png_http_response(bytes: Vec<u8>) -> HttpResponse {
    HttpResponse::Ok()
        .insert_header((header::CONTENT_TYPE, PNG_CONTENT_TYPE))
        .insert_header((header::CONTENT_DISPOSITION, PNG_CONTENT_DISPOSITION))
        .body(bytes)
}

fn png_gen_or_err(label: &str, media_id: Uuid, png: PngGenResult) -> Result<HttpResponse, AppError> {
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

async fn load_authorized_audio_media(
    env: &Env,
    login: &str,
    media_id: Uuid,
) -> Result<(signal_message_media::Model, Vec<u8>), AppError> {
    let media = signal_message_media::Entity::find_by_id(media_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    if !is_audio_media(&media) {
        return Err(AppError::NotFound);
    }
    ensure_media_access(&env.dbx, login, media.signal_message_id).await?;
    let data = fetch_media_bytes(env, &media).await?;
    Ok((media, data))
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

fn png_output_temp_file(prefix: &str) -> Result<tempfile::NamedTempFile, AppError> {
    let file = tempfile::Builder::new()
        .prefix(prefix)
        .suffix(".png")
        .rand_bytes(5)
        .tempfile()
        .c(h!())?;
    Ok(file)
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
    let (media, data) =
        load_authorized_audio_media(env.as_ref(), &login, media_id).await?;
    let audio_file = write_audio_temp_file(&media, &data).await?;
    let output_file = png_output_temp_file("echo-inbox-wave-")?;
    let req = PngGenRequest::new(audio_file.path(), output_file.path());
    let png = generate_wave_png(&req).await;
    png_gen_or_err("waveform", media_id, png)
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
    let (media, data) =
        load_authorized_audio_media(env.as_ref(), &login, media_id).await?;
    let audio_file = write_audio_temp_file(&media, &data).await?;
    let output_file = png_output_temp_file("echo-inbox-spectrogram-")?;
    let req = PngGenRequest::new(audio_file.path(), output_file.path());
    let png = generate_spectrogram_png(&req).await;
    png_gen_or_err("spectrogram", media_id, png)
}

#[cfg(test)]
mod tests {
    use super::audio_temp_suffix;
    use crate::entities::signal_message_media;
    use sea_orm::prelude::DateTimeUtc;

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
            created_at: DateTimeUtc::default(),
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
}
