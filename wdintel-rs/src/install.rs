use crate::{h, OneoffInstallPs};
use anyhow::{anyhow, Context};
use echo_install_utils::tmpdir::mount_tmp_to_tmpfs;
use std::process::Command;

pub async fn mount_tmp(args: &OneoffInstallPs) -> anyhow::Result<()> {
    run_mount_tmp_to_tmpfs(args.interactive).await
}

pub async fn run_mount_tmp_to_tmpfs(interactive: bool) -> anyhow::Result<()> {
    let status = Command::new("sudo")
        .args(["systemctl", "stop", "echo-signal-cli"])
        .status()
        .context(h!())?;
    if !status.success() {
        return Err(anyhow!("failed to stop echo-signal-cli")).context(h!());
    }

    mount_tmp_to_tmpfs(interactive).await.context(h!())?;

    let status = Command::new("sudo")
        .args(["systemctl", "start", "echo-signal-cli"])
        .status()
        .context(h!())?;
    if !status.success() {
        return Err(anyhow!("failed to start echo-signal-cli")).context(h!());
    }
    Ok(())
}
