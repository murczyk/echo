use crate::config::{ORGANISM_GOI_API_TIMEOUT_SEC, ORGANISM_GOI_PATH_DEFAULT};
use crate::entities::{goi_integration, organism};
use crate::organism::goi::shared::{
    goi_api_host, goi_api_port, goi_integration_api_host,
    goi_integration_api_port,
};
use crate::utils::string::{
    normalize_optional_trimmed, normalize_trimmed_or_default,
};
use anyhow::{bail, Context};
use goi_echo_worker::api::{
    GoiPaletteFileMoveReq, GoiPaletteFileReq, GoiPaletteFilesRsp, GoiService,
    GoiServiceReq, GoiSyncLockAcquireRsp, GoiSyncLockReq,
};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;
use url::Url;

#[derive(Clone)]
pub struct GoiApiTarget {
    rq: reqwest::Client,
    base_url: Url,
    login: String,
    password: String,
    palette_path: String,
    label: String,
}

impl GoiApiTarget {
    pub fn from_integration(
        rq: reqwest::Client,
        integration: &goi_integration::Model,
    ) -> anyhow::Result<Self> {
        let host = goi_integration_api_host(integration)
            .context("GOI API host is missing")?;
        let port = goi_integration_api_port(integration);
        let login = normalize_optional_trimmed(integration.api_login.clone())
            .context("GOI API login is missing")?;
        let password =
            normalize_optional_trimmed(integration.api_password.clone())
                .context("GOI API password is missing")?;
        Ok(Self {
            rq,
            base_url: goi_api_base_url(&host, port)?,
            login,
            password,
            palette_path: normalize_trimmed_or_default(
                integration.path.clone(),
                ORGANISM_GOI_PATH_DEFAULT,
            ),
            label: integration.server_label.clone(),
        })
    }

    pub fn from_organism(
        rq: reqwest::Client,
        organism: &organism::Model,
    ) -> anyhow::Result<Self> {
        let host = goi_api_host(organism).context("GOI API host is missing")?;
        let port = goi_api_port(organism);
        let login = normalize_optional_trimmed(organism.goi_api_login.clone())
            .context("GOI API login is missing")?;
        let password =
            normalize_optional_trimmed(organism.goi_api_password.clone())
                .context("GOI API password is missing")?;
        Ok(Self {
            rq,
            base_url: goi_api_base_url(&host, port)?,
            login,
            password,
            palette_path: normalize_trimmed_or_default(
                organism.goi_path.clone(),
                ORGANISM_GOI_PATH_DEFAULT,
            ),
            label: host,
        })
    }

    pub fn label(&self) -> &str {
        &self.label
    }

    pub fn endpoint_url(&self, path: &str) -> Url {
        let mut url = self.base_url.clone();
        url.set_path(path);
        url.set_query(None);
        url.set_fragment(None);
        url
    }

    pub async fn list_palette_files(&self) -> anyhow::Result<Vec<String>> {
        let response = self
            .request(reqwest::Method::GET, "/api/palettes/files")
            .send()
            .await?
            .error_for_status()?;
        Ok(response.json::<GoiPaletteFilesRsp>().await?.relative_paths)
    }

    pub async fn upload_palette_file(
        &self,
        path: &str,
        file_data: Vec<u8>,
    ) -> anyhow::Result<()> {
        let relative_path = self.palette_relative_path(path)?;
        self.request(reqwest::Method::PUT, "/api/palettes/file")
            .query(&GoiPaletteFileReq { relative_path })
            .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
            .body(file_data)
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }

    pub async fn download_palette_file(
        &self,
        path: &str,
    ) -> anyhow::Result<Vec<u8>> {
        let relative_path = self.palette_relative_path(path)?;
        let response = self
            .request(reqwest::Method::POST, "/api/palettes/file/download")
            .json(&GoiPaletteFileReq { relative_path })
            .send()
            .await?
            .error_for_status()?;
        Ok(response.bytes().await?.to_vec())
    }

    pub async fn delete_palette_file(&self, path: &str) -> anyhow::Result<()> {
        let relative_path = self.palette_relative_path(path)?;
        self.request(reqwest::Method::DELETE, "/api/palettes/file")
            .query(&GoiPaletteFileReq { relative_path })
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }

    pub async fn move_palette_file(
        &self,
        source_path: &str,
        target_path: &str,
    ) -> anyhow::Result<()> {
        let source_relative_path = self.palette_relative_path(source_path)?;
        let target_relative_path = self.palette_relative_path(target_path)?;
        self.request(reqwest::Method::POST, "/api/palettes/file/move")
            .json(&GoiPaletteFileMoveReq {
                source_relative_path,
                target_relative_path,
            })
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }

    pub async fn download_knowledge_workbook(&self) -> anyhow::Result<Vec<u8>> {
        let response = self
            .request(reqwest::Method::GET, "/api/knowledge/workbook")
            .send()
            .await?
            .error_for_status()?;
        Ok(response.bytes().await?.to_vec())
    }

    pub async fn upload_knowledge_workbook(
        &self,
        file_data: Vec<u8>,
    ) -> anyhow::Result<()> {
        self.request(reqwest::Method::PUT, "/api/knowledge/workbook")
            .header(
                reqwest::header::CONTENT_TYPE,
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            )
            .body(file_data)
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }

    pub async fn download_palettes_archive(&self) -> anyhow::Result<Vec<u8>> {
        let response = self
            .request(reqwest::Method::GET, "/api/palettes/archive")
            .send()
            .await?
            .error_for_status()?;
        Ok(response.bytes().await?.to_vec())
    }

    pub async fn upload_categories(
        &self,
        categories_json: Vec<u8>,
    ) -> anyhow::Result<()> {
        self.request(reqwest::Method::PUT, "/api/categories")
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(categories_json)
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }

    pub async fn restart_service(
        &self,
        service: GoiService,
    ) -> anyhow::Result<()> {
        self.post_service_action("/api/services/restart", service)
            .await
    }

    pub async fn unlink_whatsapp(
        &self,
        service: GoiService,
    ) -> anyhow::Result<()> {
        self.post_service_action("/api/services/unlink-whatsapp", service)
            .await
    }

    pub async fn try_acquire_sync_lock(
        &self,
    ) -> anyhow::Result<Option<GoiSyncLock>> {
        let response = self
            .request(reqwest::Method::POST, "/api/sync-lock/acquire")
            .send()
            .await?
            .error_for_status()?
            .json::<GoiSyncLockAcquireRsp>()
            .await?;
        Ok(response.lock_id.map(|lock_id| GoiSyncLock {
            target: self.clone(),
            lock_id,
        }))
    }

    fn request(
        &self,
        method: reqwest::Method,
        path: &str,
    ) -> reqwest::RequestBuilder {
        self.rq
            .request(method, self.endpoint_url(path))
            .timeout(Duration::from_secs(ORGANISM_GOI_API_TIMEOUT_SEC))
            .basic_auth(&self.login, Some(&self.password))
    }

    async fn post_service_action(
        &self,
        path: &str,
        service: GoiService,
    ) -> anyhow::Result<()> {
        self.request(reqwest::Method::POST, path)
            .json(&GoiServiceReq { service })
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }

    async fn update_sync_lock(
        &self,
        path: &str,
        lock_id: &str,
    ) -> anyhow::Result<()> {
        self.request(reqwest::Method::POST, path)
            .json(&GoiSyncLockReq {
                lock_id: lock_id.to_string(),
            })
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }

    fn palette_relative_path(&self, path: &str) -> anyhow::Result<String> {
        let path = path.trim();
        let palette_path = self.palette_path.trim().trim_end_matches('/');
        let relative_path = if Path::new(path).is_absolute() {
            Path::new(path)
                .strip_prefix(Path::new(palette_path))
                .context(
                    "GOI palette path is outside the configured palette root",
                )?
                .to_str()
                .context("GOI palette path is not valid UTF-8")?
        } else {
            path.trim_start_matches("./").trim_start_matches('/')
        };
        normalize_relative_palette_path(relative_path)
    }
}

pub struct GoiSyncLock {
    target: GoiApiTarget,
    lock_id: String,
}

impl GoiSyncLock {
    pub fn target(&self) -> &str {
        self.target.label()
    }

    pub async fn refresh(&self) -> anyhow::Result<()> {
        self.target
            .update_sync_lock("/api/sync-lock/refresh", &self.lock_id)
            .await
    }

    pub async fn release(&self) -> anyhow::Result<()> {
        self.target
            .update_sync_lock("/api/sync-lock/release", &self.lock_id)
            .await
    }
}

pub fn goi_api_base_url(host: &str, port: i32) -> anyhow::Result<Url> {
    if !(1..=65535).contains(&port) {
        bail!("invalid GOI API port: {port}");
    }
    let mut url = if host.starts_with("http://") || host.starts_with("https://")
    {
        Url::parse(host)?
    } else {
        Url::parse(&format!("https://{host}"))?
    };
    if url.port().is_none() {
        url.set_port(Some(port as u16))
            .map_err(|_| anyhow::anyhow!("invalid GOI API port: {port}"))?;
    }
    url.set_path("/");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

fn normalize_relative_palette_path(path: &str) -> anyhow::Result<String> {
    let mut normalized = PathBuf::new();
    for component in Path::new(path).components() {
        match component {
            Component::Normal(component) => normalized.push(component),
            Component::CurDir => {}
            Component::ParentDir
            | Component::RootDir
            | Component::Prefix(_) => {
                bail!("GOI palette path must be relative and may not contain '..'")
            }
        }
    }
    if normalized.as_os_str().is_empty() {
        bail!("GOI palette path is empty");
    }
    Ok(normalized.to_string_lossy().replace('\\', "/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_url_defaults_to_https() {
        assert_eq!(
            goi_api_base_url("goi.example", 8088).unwrap().as_str(),
            "https://goi.example:8088/"
        );
    }

    #[test]
    fn palette_path_rejects_traversal() {
        assert!(normalize_relative_palette_path("../outside.kmz").is_err());
    }
}
