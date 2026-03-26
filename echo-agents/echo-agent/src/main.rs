#![recursion_limit = "256"]

mod callsign_extraction;
mod cli;
mod commands;
mod config;
mod echo_api;
mod opencode;
mod output;

use anyhow::Result;
use clap::Parser;

fn main() -> Result<()> {
    commands::run(cli::Cli::parse())
}
