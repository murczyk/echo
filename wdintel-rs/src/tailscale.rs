use crate::error::AppError;
use crate::types::*;
use chrono::prelude::*;
use xshell::{cmd, Shell};

#[tokio::main]
pub async fn renew_tailscale_cert(mode: Mode) -> Result<(), AppError> {
    let config = crate::config::read_config(mode)?;
    // only launch this command for tailscale domains
    if !config.public_host.ends_with(".ts.net") {
        return Ok(());
    }
    println!("> starting tailscale cert renewal");
    let now = Utc::now();
    println!("> current datetime: {}", now);
    let sh = Shell::new()?;
    let public_host = config.public_host;
    std::env::set_current_dir("/root")?;
    cmd!(sh, "tailscale cert {public_host}").run()?;
    cmd!(sh, "mv {public_host}.key /etc/echo/echo.key").run()?;
    cmd!(sh, "mv {public_host}.crt /etc/echo/echo.crt").run()?;
    // cmd!(sh, "cp /etc/echo/echo.key /etc/grafana/grafana.key").run()?;
    // cmd!(sh, "cp /etc/echo/echo.crt /etc/grafana/grafana.crt").run()?;
    // cmd!(sh, "chmod 640 /etc/grafana/grafana.key").run()?;
    // cmd!(sh, "chown grafana:grafana /etc/grafana/grafana.key").run()?;
    // cmd!(sh, "chmod 640 /etc/grafana/grafana.crt").run()?;
    // cmd!(sh, "chown grafana:grafana /etc/grafana/grafana.crt").run()?;
    cmd!(sh, "systemctl restart nginx").run()?;
    // cmd!(sh, "systemctl restart grafana-server").run()?;
    Ok(())
}
