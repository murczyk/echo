use crate::{h, OneoffInstallPs};
use anyhow::Context;
use echo_install_utils::tmpdir::mount_tmp_to_tmpfs;

pub async fn mount_tmp(args: &OneoffInstallPs) -> anyhow::Result<()> {
    run_mount_tmp_to_tmpfs(args.interactive).await
}

pub async fn run_mount_tmp_to_tmpfs(interactive: bool) -> anyhow::Result<()> {
    mount_tmp_to_tmpfs(interactive).await.context(h!())
}
