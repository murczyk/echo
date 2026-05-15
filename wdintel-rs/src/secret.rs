use crate::config::*;
use crate::error::AppError;
use crate::types::info;
use crate::types::*;
use anyhow::bail;
use std::sync::OnceLock;
use std::time::Duration;

pub static SECRET: OnceLock<SecretConfig> = OnceLock::new();
pub const MAX_SLEEP_SECONDS: u64 = 60;
const RETRY_TIME: u64 = 10 * 30;

#[derive(Serialize, Deserialize)]
struct LoginReq {
    password: String,
}

#[derive(Serialize, Deserialize)]
struct LoginResp {
    auth: AuthData,
}

#[derive(Serialize, Deserialize)]
struct AuthData {
    client_token: String,
}

#[derive(Serialize, Deserialize)]
struct SecretResp {
    data: SecretData,
}

#[derive(Serialize, Deserialize)]
struct SecretData {
    data: SecretConfig,
}

pub async fn secret_worker(config: VaultConfig) {
    loop {
        let _loop_guard =
            crate::utils::worker_watch::loop_guard("secret_worker");
        info!("> starting secret_worker");
        match fetch_config(&config).await {
            Ok(_) => return,
            Err(e) => {
                info!("retry scheduled, unable to load config: {e}");
            }
        }
        tokio::time::sleep(Duration::from_secs(RETRY_TIME)).await;
    }
}

async fn fetch_config(secret_config: &VaultConfig) -> anyhow::Result<()> {
    if SECRET.get().is_some() {
        return Ok(());
    };
    let mut attempt_count = 1;
    loop {
        info!("attempting lo fetch secret config: {attempt_count}/3");
        match do_fetch_config(secret_config).await {
            Ok(res) => match SECRET.set(res.clone()) {
                Ok(_) => return Ok(()),
                _ => bail!("unable to set value for a secret"),
            },
            Err(e) => {
                if attempt_count > 3 {
                    bail!(e)
                }
                debug!("attempt to fetch secret cnfig failed: {:?}", e);
                attempt_count += 1;
                // minimum between sleep_duration * 5 and MAX_SLEEP_SECONDS
                let sleep_duration = std::cmp::min(
                    RETRY_TIME * attempt_count,
                    MAX_SLEEP_SECONDS,
                );
                tokio::time::sleep(Duration::from_secs(sleep_duration)).await;
            }
        }
    }
}

async fn do_fetch_config(
    secret_config: &VaultConfig,
) -> Result<SecretConfig, AppError> {
    let rq = reqwest::Client::new();
    let login_url = format!(
        "{}/v1/auth/userpass/login/{}",
        secret_config.url, secret_config.login
    );
    let login_response = rq
        .post(login_url)
        .header("content-type", "application/json")
        .json(&LoginReq {
            password: secret_config.password.clone(),
        })
        .send()
        .await
        .c(h!())?;
    let response: LoginResp = login_response.json().await.c(h!())?;
    let token = response.auth.client_token;
    let config_url = format!(
        "{}/v1/echo/data/{}/config",
        secret_config.url, secret_config.server
    );
    let secret_response = rq
        .get(config_url)
        .header("X-Vault-Token", token)
        .send()
        .await
        .c(h!())?;
    let response: SecretResp = secret_response.json().await.c(h!())?;
    info!("successfully fetched secret");
    Ok(response.data.data)
}

pub async fn oneoff_backup_vault_secrets_to_bitwarden(
    _mode: Mode,
) -> Result<(), AppError> {
    echo_install_utils::secret::backup_vault_secrets_to_bitwarden(
        "echo",
        &list_server(),
    )
    .await
    .context(h!())?;
    Ok(())
}

pub async fn oneoff_restore_vault_secrets_from_bitwarden(
    _mode: Mode,
) -> Result<(), AppError> {
    echo_install_utils::secret::restore_vault_secrets_from_bitwarden(
        "echo",
        &list_server(),
        true,
    )
    .await
    .context(h!())?;
    Ok(())
}

fn list_server<'a>() -> [&'a str; 14] {
    [
        "echo-luhansk/config",
        "echo-donetsk2/config",
        "echo-volyn2/config",
        "echo-zaporizhzha2/config",
        "echo-kherson2/config",
        "echo-kharkiv2/config",
        "echo-siversk/config",
        "echo-lyman/config",
        "echo-kyiv/config",
        "echo-pivden/config",
        "echo-pivnich/config",
        "echo-skhid/config",
        "echo-kupiansk/config",
        "echo-zakhid/config",
    ]
}
