use crate::error::AppError;
use crate::h;
use crate::types::ShortContext;
use actix_multipart::{Field, Multipart};
use futures_util::{future::poll_fn, Stream};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::task::Poll;
use std::time::Duration;

pub async fn next<S: Stream + Unpin>(
    stream: &mut S,
) -> Result<Option<S::Item>, AppError> {
    Ok(next_with_timeout(
        stream,
        Duration::from_secs(crate::config::MULTIPART_IDLE_TIMEOUT_SECS),
    )
    .await
    .c(h!())?)
}

pub async fn next_with_timeout<S: Stream + Unpin>(
    stream: &mut S,
    idle_timeout: Duration,
) -> Result<Option<S::Item>, AppError> {
    let next = poll_fn(|context| {
        let result = Pin::new(&mut *stream).poll_next(context);
        if result.is_pending() && super::multipart_payload::has_reached_eof() {
            Poll::Ready(Err(AppError::BL {
                msg: "Incomplete multipart stream".to_string(),
            }))
        } else {
            result.map(Ok)
        }
    });
    tokio::time::timeout(idle_timeout, next)
        .await
        .map_err(|_| AppError::BL {
            msg: "Multipart stream exceeded the idle timeout".to_string(),
        })?
}

pub async fn extract(
    payload: &mut Multipart,
) -> Result<(Field, Vec<u8>), AppError> {
    extract_limited(payload, crate::config::MULTIPART_MAX_BYTES)
        .await
        .c(h!())
        .map_err(Into::into)
}

pub async fn extract_limited(
    payload: &mut Multipart,
    maximum_bytes: usize,
) -> Result<(Field, Vec<u8>), AppError> {
    let Some(item) = next(payload).await.c(h!())? else {
        return Err(AppError::BL {
            msg: "No file found".to_string(),
        });
    };
    let mut field = item.map_err(to_app_error).c(h!())?;
    let value = read_field_limited(&mut field, maximum_bytes)
        .await
        .c(h!())?;
    Ok((field, value))
}

pub async fn read_field_limited(
    field: &mut Field,
    maximum_bytes: usize,
) -> Result<Vec<u8>, AppError> {
    Ok(read_field_limited_with_timeout(
        field,
        maximum_bytes,
        Duration::from_secs(crate::config::MULTIPART_IDLE_TIMEOUT_SECS),
    )
    .await
    .c(h!())?)
}

pub async fn read_field_limited_with_timeout(
    field: &mut Field,
    maximum_bytes: usize,
    idle_timeout: Duration,
) -> Result<Vec<u8>, AppError> {
    let mut value = Vec::new();
    while let Some(chunk) =
        next_with_timeout(field, idle_timeout).await.c(h!())?
    {
        let chunk = chunk.map_err(to_app_error).c(h!())?;
        if value.len().saturating_add(chunk.len()) > maximum_bytes {
            return Err(AppError::BL {
                msg: format!(
                    "Uploaded field exceeds the {maximum_bytes} byte limit"
                ),
            });
        }
        value.extend_from_slice(&chunk);
    }
    Ok(value)
}

pub fn download_filename(
    field: &Field,
    suffix: &str,
    extension: &str,
) -> String {
    let raw = field
        .name()
        .or_else(|| {
            field
                .content_disposition()
                .and_then(|disposition| disposition.get_filename())
        })
        .unwrap_or("upload");
    let basename = raw
        .rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty() && *name != "." && *name != "..")
        .unwrap_or("upload");
    if !suffix.is_empty() {
        return basename.replace(
            &format!(".{extension}"),
            &format!("{suffix}.{extension}"),
        );
    }
    let stem = Path::new(basename)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.is_empty() && *stem != "." && *stem != "..")
        .unwrap_or("upload");
    format!("{stem}{suffix}.{extension}")
}

pub fn download_content_disposition(
    filename: String,
) -> actix_web::http::header::ContentDisposition {
    use actix_web::http::header::{
        Charset, ContentDisposition, DispositionParam, DispositionType,
        ExtendedValue,
    };
    use mime_guess::mime;
    let content_type = mime_guess::from_path(&filename).first_or_octet_stream();
    let fallback = filename
        .replace('\n', "%0A")
        .replace('\x0B', "%0B")
        .replace('\x0C', "%0C")
        .replace('\r', "%0D");
    let mut disposition = ContentDisposition::attachment(fallback);
    disposition.disposition = match content_type.type_() {
        mime::IMAGE | mime::TEXT | mime::AUDIO | mime::VIDEO => {
            DispositionType::Inline
        }
        mime::APPLICATION => match content_type.subtype() {
            mime::JAVASCRIPT | mime::JSON => DispositionType::Inline,
            name if name == "wasm" || name == "xhtml" => {
                DispositionType::Inline
            }
            _ => DispositionType::Attachment,
        },
        _ => DispositionType::Attachment,
    };
    if !filename.is_ascii() {
        disposition.parameters.push(DispositionParam::FilenameExt(
            ExtendedValue {
                charset: Charset::Ext("UTF-8".to_string()),
                language_tag: None,
                value: filename.into_bytes(),
            },
        ));
    }
    disposition
}

pub fn write_upload(
    directory: &Path,
    extension: &str,
    data: &[u8],
) -> anyhow::Result<PathBuf> {
    let mut upload = tempfile::Builder::new()
        .prefix("upload-")
        .suffix(&format!(".{extension}"))
        .tempfile_in(directory)
        .c(h!())?;
    upload.write_all(data).c(h!())?;
    let (_, path) = upload.keep().c(h!())?;
    Ok(path)
}

pub fn to_app_error(error: impl std::fmt::Display) -> AppError {
    AppError::BL {
        msg: format!("Multipart error: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::test::TestRequest;
    use actix_web::ResponseError;

    fn multipart(body: &str) -> Multipart {
        let (request, payload) = TestRequest::post()
            .insert_header((
                "content-type",
                "multipart/form-data; boundary=upload-test",
            ))
            .set_payload(body.to_owned())
            .to_http_parts();
        Multipart::new(request.headers(), payload)
    }

    #[actix_web::test]
    async fn truncated_crlf_field_and_incomplete_headers_have_bounded_idle_wait(
    ) {
        let deadline = Duration::from_millis(25);
        let mut payload = multipart("--upload-test\r\nContent-Disposition: form-data; name=\"file\"\r\n\r\ntruncated\r\n");
        let mut field = next_with_timeout(&mut payload, deadline)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let error = tokio::time::timeout(
            Duration::from_secs(1),
            read_field_limited_with_timeout(&mut field, 1024, deadline),
        )
        .await
        .unwrap()
        .unwrap_err();
        assert_eq!(
            error.error_response().status(),
            actix_web::http::StatusCode::BAD_REQUEST
        );
        assert!(error.to_string().contains("idle timeout"));
        let mut payload = multipart(
            "--upload-test\r\nContent-Disposition: form-data; name=\"file\"\r",
        );
        let result = tokio::time::timeout(
            Duration::from_secs(1),
            next_with_timeout(&mut payload, deadline),
        )
        .await
        .unwrap();
        assert!(!matches!(result, Ok(Some(Ok(_)))));
    }

    #[actix_web::test]
    async fn rejects_empty_and_truncated_file_uploads() {
        for body in [
            "--upload-test--\r\n",
            "--upload-test\r\nContent-Disposition: form-data; name=\"file\"\r\n\r\ntruncated",
        ] {
            let error = extract(&mut multipart(body)).await.unwrap_err();
            assert_eq!(error.error_response().status(), actix_web::http::StatusCode::BAD_REQUEST);
        }
    }

    #[actix_web::test]
    async fn converted_downloads_preserve_legacy_field_names_and_headers() {
        for (name, suffix, extension, expected_name) in [
            ("survey.csv", "", "kmz", "survey.kmz"),
            ("survey.kmz", "", "geojson", "survey.geojson"),
            ("Карта.kmz", "-fixed", "kmz", "Карта-fixed.kmz"),
            ("MAP.KMZ", "-fixed", "kmz", "MAP.KMZ"),
            ("file", "-fixed", "kmz", "file"),
            ("notes.txt", "-fixed", "kmz", "notes.txt"),
            (
                "map.kmz.backup.kmz",
                "-fixed",
                "kmz",
                "map-fixed.kmz.backup-fixed.kmz",
            ),
        ] {
            let body = format!("--upload-test\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"raw-export.kmz\"\r\n\r\naudit\r\n--upload-test--\r\n");
            let (field, _) = extract(&mut multipart(&body)).await.unwrap();
            let filename = download_filename(&field, suffix, extension);
            assert_eq!(filename, expected_name);
            let content_type =
                mime_guess::from_path(&filename).first_or_octet_stream();
            let request = TestRequest::default().to_http_request();
            let response = actix_files::NamedFile::from_file(
                tempfile::tempfile().unwrap(),
                "random-upload.kmz",
            )
            .unwrap()
            .set_content_type(content_type)
            .set_content_disposition(download_content_disposition(filename))
            .into_response(&request);
            let legacy_response = actix_files::NamedFile::from_file(
                tempfile::tempfile().unwrap(),
                expected_name,
            )
            .unwrap()
            .into_response(&request);
            assert_eq!(
                response.headers().get("content-disposition"),
                legacy_response.headers().get("content-disposition"),
            );
            assert_eq!(
                response.headers().get("content-type"),
                legacy_response.headers().get("content-type"),
            );
        }
        let disposition = download_content_disposition(
            "survey\r\nInjected: bad.kmz".to_string(),
        )
        .to_string();
        disposition
            .parse::<actix_web::http::header::HeaderValue>()
            .unwrap();
        assert!(!disposition.contains(['\r', '\n']));
    }

    #[actix_web::test]
    async fn field_metadata_cannot_choose_temporary_upload_destination() {
        let directory = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let sentinel = outside.path().join("sentinel.csv");
        std::fs::write(&sentinel, b"untouched").unwrap();
        for name in [
            sentinel.display().to_string(),
            "../../sentinel.csv".to_string(),
            "C:\\audit\\sentinel.csv".to_string(),
        ] {
            let body = format!("--upload-test\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"{name}\"\r\n\r\naudit\r\n--upload-test--\r\n");
            let (_, bytes) = extract(&mut multipart(&body)).await.unwrap();
            let upload = write_upload(directory.path(), "csv", &bytes).unwrap();
            assert_eq!(upload.parent(), Some(directory.path()));
            assert_eq!(std::fs::read(upload).unwrap(), b"audit");
            assert_eq!(std::fs::read(&sentinel).unwrap(), b"untouched");
        }
    }
}
