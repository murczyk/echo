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

    echo_install_utils::vector::VectorInstaller::new()
        .run()
        .context(h!())?;

    Ok(())
}
