use super::error::StorageFailure;
use crate::{devices::config::*, h, storage::S3Config, types::ShortContext};
use anyhow::{ensure, Context, Result};
use reqsign::{AwsCredential, AwsV4Signer};
use reqwest::{Method, Response, StatusCode, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::Duration;

pub(super) struct Client {
    http: reqwest::Client,
    endpoint: Url,
    bucket: String,
    signer: AwsV4Signer,
    credential: AwsCredential,
}

pub(super) struct Metadata {
    pub size: u64,
    pub source_sha256: String,
}

impl Client {
    pub(super) fn new(config: &S3Config) -> Result<Self> {
        ensure!(
            config.prefix.is_empty() && !config.bucket.is_empty(),
            "archive storage must be prefix-free"
        );
        let endpoint = Url::parse(&config.endpoint).c(h!())?;
        ensure!(
            matches!(endpoint.scheme(), "http" | "https")
                && endpoint.username().is_empty()
                && endpoint.password().is_none()
                && endpoint.query().is_none()
                && endpoint.fragment().is_none(),
            "invalid archive storage endpoint"
        );
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(
                DEVICE_FILE_ARCHIVE_S3_REQUEST_SECONDS,
            ))
            .build()
            .c(h!())?;
        Ok(Self {
            http,
            endpoint,
            bucket: config.bucket.clone(),
            signer: AwsV4Signer::new(
                "s3",
                if config.region.is_empty() {
                    "us-east-1"
                } else {
                    &config.region
                },
            ),
            credential: AwsCredential {
                access_key_id: config.access_key_id.clone(),
                secret_access_key: config.secret_access_key.clone(),
                session_token: None,
                expires_in: None,
            },
        })
    }

    async fn request(
        &self,
        method: Method,
        key: Option<&str>,
        query: &[(&str, &str)],
        body: Vec<u8>,
        sha256: Option<&[u8; 32]>,
    ) -> Result<Response> {
        let mut url = self.endpoint.clone();
        {
            let mut path = url
                .path_segments_mut()
                .map_err(|_| anyhow::anyhow!("invalid S3 endpoint path"))
                .context(h!())?;
            path.pop_if_empty().push(&self.bucket);
            if let Some(key) = key {
                ensure!(
                    !key.is_empty()
                        && key
                            .split('/')
                            .all(|part| !matches!(part, "" | "." | "..")),
                    "invalid archive object key"
                );
                for part in key.split('/') {
                    path.push(part);
                }
            }
        }
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query.iter().copied());
        }
        let mut request = self
            .http
            .request(method, url)
            .header("Content-Type", "application/xml")
            .header("Content-Length", body.len())
            .header("x-amz-content-sha256", hex(&Sha256::digest(&body)))
            .body(body)
            .build()
            .c(h!())?;
        if let Some(sha256) = sha256 {
            request.headers_mut().insert(
                "x-amz-meta-source-sha256",
                hex(sha256).parse().c(h!())?,
            );
        }
        self.signer
            .sign(&mut request, &self.credential)
            .context(h!())?;
        self.http.execute(request).await.c(h!())
    }

    pub(super) async fn create(
        &self,
        key: &str,
        sha256: &[u8; 32],
    ) -> Result<String> {
        let response = self
            .request(
                Method::POST,
                Some(key),
                &[("uploads", "")],
                Vec::new(),
                Some(sha256),
            )
            .await
            .context(h!())?;
        successful(response.status()).context(h!())?;
        let response: Initiated =
            xml(&body(response).await.context(h!())?).context(h!())?;
        ensure!(
            !response.upload_id.is_empty()
                && response.upload_id.len()
                    <= DEVICE_FILE_ARCHIVE_S3_UPLOAD_ID_MAX_BYTES,
            "invalid S3 upload ID"
        );
        Ok(response.upload_id)
    }

    pub(super) async fn part(
        &self,
        key: &str,
        upload: &str,
        number: u32,
        bytes: Vec<u8>,
    ) -> Result<String> {
        ensure!(
            number > 0
                && number <= DEVICE_FILE_ARCHIVE_S3_MAX_PARTS
                && bytes.len() as u64 <= DEVICE_FILE_ARCHIVE_S3_CHUNK_BYTES,
            "invalid S3 part"
        );
        let response = self
            .request(
                Method::PUT,
                Some(key),
                &[("partNumber", &number.to_string()), ("uploadId", upload)],
                bytes,
                None,
            )
            .await
            .context(h!())?;
        successful(response.status()).context(h!())?;
        let etag = response
            .headers()
            .get("etag")
            .c(h!())?
            .to_str()
            .c(h!())?
            .to_owned();
        ensure!(
            !etag.is_empty()
                && etag.len() <= DEVICE_FILE_ARCHIVE_S3_ETAG_MAX_BYTES,
            "invalid S3 part ETag"
        );
        Ok(etag)
    }

    pub(super) async fn complete(
        &self,
        key: &str,
        upload: &str,
        parts: &[(u32, String)],
    ) -> Result<()> {
        ensure!(
            !parts.is_empty()
                && parts.len() <= DEVICE_FILE_ARCHIVE_S3_MAX_PARTS as usize,
            "invalid S3 part count"
        );
        let mut entries = Vec::with_capacity(parts.len());
        for (index, (number, etag)) in parts.iter().enumerate() {
            ensure!(
                *number as usize == index + 1
                    && !etag.is_empty()
                    && etag.len() <= DEVICE_FILE_ARCHIVE_S3_ETAG_MAX_BYTES,
                "invalid S3 completion part"
            );
            entries.push(Part {
                number: *number,
                etag: etag.clone(),
            });
        }
        let payload = quick_xml::se::to_string(&Complete { parts: entries })
            .c(h!())?
            .into_bytes();
        let response = self
            .request(
                Method::POST,
                Some(key),
                &[("uploadId", upload)],
                payload,
                None,
            )
            .await
            .context(h!())?;
        successful(response.status()).context(h!())?;
        let response: Completed =
            xml(&body(response).await.context(h!())?).context(h!())?;
        ensure!(
            response.key == key && !response.etag.is_empty(),
            "S3 completion is unconfirmed"
        );
        Ok(())
    }

    pub(super) async fn abort(&self, key: &str, upload: &str) -> Result<()> {
        let response = self
            .request(
                Method::DELETE,
                Some(key),
                &[("uploadId", upload)],
                Vec::new(),
                None,
            )
            .await
            .context(h!())?;
        let status = response.status();
        let bytes = body(response).await.context(h!())?;
        if !(status.is_success()
            || (status == StatusCode::NOT_FOUND
                && error_code(&bytes).as_deref() == Some("NoSuchUpload")))
        {
            return Err(StorageFailure::Status(status.as_u16()).into());
        }
        let response = self
            .request(
                Method::GET,
                Some(key),
                &[("uploadId", upload), ("max-parts", "1")],
                Vec::new(),
                None,
            )
            .await
            .context(h!())?;
        let status = response.status();
        let bytes = body(response).await.context(h!())?;
        if status == StatusCode::NOT_FOUND
            && error_code(&bytes).as_deref() == Some("NoSuchUpload")
        {
            return Ok(());
        }
        successful(status).context(h!())?;
        let parts: Parts = xml(&bytes).context(h!())?;
        ensure!(
            !parts.truncated && parts.parts.is_empty(),
            "S3 multipart parts remain; quota retained"
        );
        Ok(())
    }

    pub(super) async fn unfinished(
        &self,
        prefix: &str,
    ) -> Result<Vec<(String, String)>> {
        ensure!(
            !prefix.is_empty() && prefix.ends_with('/'),
            "multipart discovery requires a directory prefix"
        );
        let mut result = Vec::new();
        let mut key_marker = String::new();
        let mut upload_marker = String::new();
        for _ in 0..DEVICE_FILE_ARCHIVE_S3_LIST_MAX_PAGES {
            // B2 rejects empty markers with HTTP 400; send them only when paging.
            let mut query = vec![("uploads", ""), ("prefix", prefix)];
            if !key_marker.is_empty() {
                query.push(("key-marker", &key_marker));
            }
            if !upload_marker.is_empty() {
                query.push(("upload-id-marker", &upload_marker));
            }
            let response = self
                .request(Method::GET, None, &query, Vec::new(), None)
                .await
                .context(h!())?;
            let status = response.status();
            let bytes = body(response).await.context(h!())?;
            if !status.is_success() {
                if let Some(code) = error_code(&bytes) {
                    return Err(StorageFailure::Service(code).into());
                }
            }
            successful(status).context(h!())?;
            let listing: Uploads = xml(&bytes).context(h!())?;
            for upload in listing.uploads {
                if upload.key.starts_with(prefix) {
                    result.push((upload.key, upload.id));
                }
            }
            if !listing.truncated {
                return Ok(result);
            }
            let next_key = listing.next_key.c(h!())?;
            let next_upload = listing.next_upload.c(h!())?;
            ensure!(
                (next_key.as_str(), next_upload.as_str())
                    != (key_marker.as_str(), upload_marker.as_str()),
                "S3 upload cursor did not advance"
            );
            (key_marker, upload_marker) = (next_key, next_upload);
        }
        anyhow::bail!("S3 multipart listing limit")
    }

    pub(super) async fn head(&self, key: &str) -> Result<Option<Metadata>> {
        let response = self
            .request(Method::HEAD, Some(key), &[], Vec::new(), None)
            .await
            .context(h!())?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        successful(response.status()).context(h!())?;
        let size = response
            .headers()
            .get("content-length")
            .c(h!())?
            .to_str()
            .c(h!())?
            .parse()
            .c(h!())?;
        let source_sha256 = response
            .headers()
            .get("x-amz-meta-source-sha256")
            .c(h!())?
            .to_str()
            .c(h!())?
            .to_owned();
        Ok(Some(Metadata {
            size,
            source_sha256,
        }))
    }

    pub(super) async fn delete(&self, key: &str) -> Result<()> {
        let response = self
            .request(Method::DELETE, Some(key), &[], Vec::new(), None)
            .await
            .context(h!())?;
        successful(response.status()).context(h!())?;
        Ok(())
    }
}

fn successful(status: StatusCode) -> Result<()> {
    if status.is_success() {
        Ok(())
    } else {
        Err(StorageFailure::Status(status.as_u16()).into())
    }
}

pub(super) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

async fn body(mut response: Response) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.c(h!())? {
        ensure!(
            bytes.len().saturating_add(chunk.len())
                <= DEVICE_FILE_ARCHIVE_S3_RESPONSE_MAX_BYTES,
            "S3 response exceeds archive metadata limit"
        );
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn xml<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T> {
    if let Some(code) = error_code(bytes) {
        return Err(StorageFailure::Service(code).into());
    }
    quick_xml::de::from_reader(bytes).c(h!())
}
fn error_code(bytes: &[u8]) -> Option<String> {
    quick_xml::de::from_reader::<_, ServiceError>(bytes)
        .ok()
        .and_then(|error| error.code)
}

#[derive(Deserialize)]
struct ServiceError {
    #[serde(rename = "Code", default)]
    code: Option<String>,
}
#[derive(Deserialize)]
struct Initiated {
    #[serde(rename = "UploadId")]
    upload_id: String,
}
#[derive(Serialize)]
#[serde(rename = "CompleteMultipartUpload")]
struct Complete {
    #[serde(rename = "Part")]
    parts: Vec<Part>,
}
#[derive(Serialize)]
struct Part {
    #[serde(rename = "PartNumber")]
    number: u32,
    #[serde(rename = "ETag")]
    etag: String,
}
#[derive(Deserialize)]
struct Completed {
    #[serde(rename = "Key")]
    key: String,
    #[serde(rename = "ETag")]
    etag: String,
}
#[derive(Deserialize)]
struct Parts {
    #[serde(rename = "IsTruncated")]
    truncated: bool,
    #[serde(rename = "Part", default)]
    parts: Vec<serde::de::IgnoredAny>,
}
#[derive(Deserialize)]
struct Uploads {
    #[serde(rename = "IsTruncated")]
    truncated: bool,
    #[serde(rename = "Upload", default)]
    uploads: Vec<Upload>,
    #[serde(rename = "NextKeyMarker")]
    next_key: Option<String>,
    #[serde(rename = "NextUploadIdMarker")]
    next_upload: Option<String>,
}
#[derive(Deserialize)]
struct Upload {
    #[serde(rename = "Key")]
    key: String,
    #[serde(rename = "UploadId")]
    id: String,
}
