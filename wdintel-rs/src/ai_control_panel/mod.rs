mod cli;
pub(crate) mod probe;
mod session_log;
mod tui;
mod worker;

use crate::{
    h,
    types::{Mode, ShortContext},
};
use std::path::PathBuf;

#[derive(clap::Args, Debug)]
pub struct Options {
    /// Repository containing the harness bundle and servers-ai recipe.
    #[arg(long, default_value = ".", global = true)]
    repo: PathBuf,
    /// Add an SSH alias to this session's fleet.
    #[arg(long, global = true)]
    host: Vec<String>,
    /// Override the agent management connection; otherwise discover it from Echo.
    #[arg(long, global = true)]
    agent_host: Option<String>,
    #[arg(long, hide = true, conflicts_with = "maintenance")]
    probe: bool,
    #[arg(long, hide = true)]
    maintenance: bool,
    #[command(subcommand)]
    action: Option<Action>,
}

#[derive(clap::Subcommand, Debug)]
enum Action {
    /// Scan fleet, installed agents, and available releases.
    Scan {
        /// Print JSON-lines events for automation.
        #[arg(long)]
        json: bool,
    },
    /// Upgrade explicitly selected --host targets.
    Upgrade {
        #[arg(long)]
        release: String,
        /// Preserve stopped agents missing from the database as recoverable backups.
        #[arg(long)]
        reconcile_orphans: bool,
        /// Validate and preview without making changes.
        #[arg(long)]
        dry_run: bool,
    },
    /// Recover an interrupted rollout for one --host.
    Recover,
}

pub async fn run(mode: Mode, options: Options) -> anyhow::Result<()> {
    if options.probe {
        println!("{}", probe::inspect(mode).await.c(h!())?);
        return Ok(());
    }
    if options.maintenance {
        return probe::maintenance(mode).await.c(h!());
    }
    if options.action.is_some() {
        return cli::run(mode, options).await.c(h!());
    }
    tui::run(mode, options).c(h!())
}
