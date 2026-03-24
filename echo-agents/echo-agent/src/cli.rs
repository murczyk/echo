use clap::{Args, Parser, Subcommand, ValueEnum};
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(author, version, about)]
pub struct Cli {
    /// Override the bundled share directory. Defaults to $ECHO_AGENT_SHARE_DIR or auto-detection.
    #[arg(long, global = true)]
    pub share_dir: Option<PathBuf>,

    /// Override the agent config path. Defaults to $ECHO_AGENT_CONFIG or /etc/echo-agent/config.toml.
    #[arg(long, global = true)]
    pub config: Option<PathBuf>,

    #[command(subcommand)]
    pub command: Option<Commands>,
}

#[derive(Subcommand, Debug)]
pub enum Commands {
    /// Run the long-lived agent worker loop.
    Run,

    /// Produce end-user-facing output through OpenCode.
    Freeform {
        /// Output mode for the final response.
        #[arg(long, value_enum, default_value_t = OutputMode::Markdown)]
        output: OutputMode,

        /// Override the OpenCode binary path. Defaults to $OPENCODE_BIN or common install paths.
        #[arg(long)]
        opencode_bin: Option<PathBuf>,

        /// Override the configured model.
        #[arg(long = "model")]
        model_name: Option<String>,

        /// User request to pass to the analyst.
        prompt: String,
    },

    /// Extract speaker callsigns from a SIGINT message.
    SigintExtractCallsigns {
        #[command(flatten)]
        input: MessageInputArgs,

        /// Override the OpenCode binary path. Defaults to $OPENCODE_BIN or common install paths.
        #[arg(long)]
        opencode_bin: Option<PathBuf>,

        /// Override the configured model.
        #[arg(long = "model")]
        model_name: Option<String>,
    },

    /// Fetch ECHO API data for local skills and troubleshooting.
    Api {
        #[command(subcommand)]
        command: ApiCommands,
    },
}

#[derive(Args, Debug)]
#[command(group(
    clap::ArgGroup::new("message_input")
        .args(["message_id", "body"])
        .required(true)
))]
pub struct MessageInputArgs {
    /// Existing ECHO message id.
    #[arg(long)]
    pub message_id: Option<i64>,

    /// Raw message body to analyze without fetching ECHO context.
    #[arg(long)]
    pub body: Option<String>,
}

#[derive(Subcommand, Debug)]
pub enum ApiCommands {
    /// Fetch one inbox message by id.
    MessageById {
        #[arg(long)]
        message_id: i64,
    },

    /// Fetch nearby same-frequency messages plus related network context.
    SameFrequencyContext {
        #[arg(long)]
        message_id: i64,

        #[arg(long, default_value_t = 12)]
        hours_before: i64,

        #[arg(long, default_value_t = 12)]
        hours_after: i64,

        #[arg(long, default_value_t = 20)]
        limit: usize,
    },

    /// Search known callsigns in ECHO.
    CallsignsSearch {
        query: String,

        #[arg(long, default_value_t = 20)]
        limit: u64,
    },

    /// Fetch networks by id.
    NetworkInfo { network_ids: Vec<i64> },

    /// Fetch callsigns assigned to a network.
    NetworkCallsigns {
        #[arg(long)]
        network_id: i64,
    },
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, ValueEnum)]
pub enum OutputMode {
    Markdown,
    Json,
}
