use anyhow::{Context, Result, bail};
use serde::Deserialize;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

pub const ECHO_AGENT_CONFIG_ENV: &str = "ECHO_AGENT_CONFIG";
const SYSTEM_CONFIG_PATH: &str = "/etc/echo-agent/config.toml";

#[derive(Debug, Clone, Deserialize)]
pub struct AgentConfig {
    pub echo_login: String,
    pub echo_password: String,
    pub echo_server: String,
}

#[derive(Debug, Clone)]
pub struct LoadedAgentConfig {
    pub path: PathBuf,
    pub config: AgentConfig,
}

#[derive(Debug, Clone, Copy)]
pub struct AgentConfigPath<'a> {
    override_path: Option<&'a Path>,
}

impl<'a> AgentConfigPath<'a> {
    pub fn new(override_path: Option<&'a Path>) -> Self {
        Self { override_path }
    }

    pub fn optional_env(self) -> Option<(String, OsString)> {
        self.resolve().map(|path| {
            (ECHO_AGENT_CONFIG_ENV.to_owned(), path.into_os_string())
        })
    }

    pub fn load_required(self) -> Result<LoadedAgentConfig> {
        try_load_agent_config(&self)?.ok_or_else(|| {
            anyhow::anyhow!(
                "failed to locate echo-agent config; set --config, {} or install /etc/echo-agent/config.toml",
                ECHO_AGENT_CONFIG_ENV
            )
        })
    }

    fn resolve(self) -> Option<PathBuf> {
        if let Some(path) = self.override_path {
            return Some(path.to_path_buf());
        }

        if let Some(path) = env::var_os(ECHO_AGENT_CONFIG_ENV) {
            return Some(PathBuf::from(path));
        }

        let system_path = PathBuf::from(SYSTEM_CONFIG_PATH);
        if system_path.is_file() {
            return Some(system_path);
        }

        None
    }
}

pub fn try_load_agent_config(
    config_path: &AgentConfigPath<'_>,
) -> Result<Option<LoadedAgentConfig>> {
    let Some(path) = config_path.resolve() else {
        return Ok(None);
    };

    let raw = fs::read_to_string(&path)
        .with_context(|| format!("failed to read config {}", path.display()))?;
    let config: AgentConfig = toml::from_str(&raw).with_context(|| {
        format!("failed to parse config {}", path.display())
    })?;
    let config = normalize_config(config, &path)?;

    Ok(Some(LoadedAgentConfig { path, config }))
}

fn normalize_config(config: AgentConfig, path: &Path) -> Result<AgentConfig> {
    let echo_login = config.echo_login.trim().to_owned();
    let echo_password = config.echo_password.trim().to_owned();
    let echo_server =
        config.echo_server.trim().trim_end_matches('/').to_owned();

    if echo_login.is_empty() {
        bail!("echo_login is empty in {}", path.display());
    }
    if echo_password.is_empty() {
        bail!("echo_password is empty in {}", path.display());
    }
    if echo_server.is_empty() {
        bail!("echo_server is empty in {}", path.display());
    }

    Ok(AgentConfig {
        echo_login,
        echo_password,
        echo_server,
    })
}
