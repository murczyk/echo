use crate::error::AppError;
use crate::types::*;
use echo_install_utils::tailscale::renew_cert;

#[tokio::main]
pub async fn renew_tailscale_cert(mode: Mode) -> Result<(), AppError> {
    let config = crate::config::read_config(mode)?;
    renew_cert(&config.public_host, "echo").context(h!())?;
    Ok(())
}

