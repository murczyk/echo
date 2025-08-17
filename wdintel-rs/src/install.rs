use crate::{h, OneoffInstallPs};
use anyhow::Context;
use cmd_lib::run_cmd;
use echo_install_utils::tmpdir::mount_tmp_to_tmpfs;

pub async fn mount_tmp(args: &OneoffInstallPs) -> anyhow::Result<()> {
    run_mount_tmp_to_tmpfs(args.interactive).await
}

pub async fn run_mount_tmp_to_tmpfs(interactive: bool) -> anyhow::Result<()> {
    run_cmd!(sudo systemctl stop echo-signal-cli).context(h!())?;
    mount_tmp_to_tmpfs(interactive).await.context(h!())?;
    run_cmd!(sudo systemctl start echo-signal-cli).context(h!())?;
    Ok(())
}
