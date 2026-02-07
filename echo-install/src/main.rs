use echo_install_utils::ssh::EnsureSshKeyOnlyLogin;
use echo_install_utils::ssh::InstallSshKeys;
use echo_install_utils::sudo::SudoWithoutPassword;
use echo_install_utils::types::*;
use tracing_subscriber::{
    layer::SubscriberExt, util::SubscriberInitExt, EnvFilter,
};

fn main() -> anyhow::Result<()> {
    tracing_subscriber::registry()
        .with(EnvFilter::new(
            std::env::var("RUST_LOG")
                .unwrap_or_else(|_| "info,echo_install=debug".to_string()),
        ))
        .with(tracing_subscriber::fmt::layer())
        .try_init()?;

    echo_install_utils::check_ubuntu2204().context(h!())?;
    echo_install_utils::check_superuser().context(h!())?;
    SudoWithoutPassword::new().run().context(h!())?;

    let ssh_keys: Vec<String> = include_str!("../../deploy/deploy.keys")
        .lines()
        .map(|s| s.to_string())
        .collect();
    InstallSshKeys::new().keys(ssh_keys).run().context(h!())?;
    EnsureSshKeyOnlyLogin::new().run().context(h!())?;

    echo_install_utils::vector::VectorInstaller::new()
        .run()
        .context(h!())?;

    echo_install_utils::pgbackrest::InstallPgbackrest::new()
        .run()
        .context(h!())?;

    Ok(())
}
