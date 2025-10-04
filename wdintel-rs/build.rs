use chrono::{offset::Local, TimeZone, Utc};
use std::env;
use std::fs::File;
use std::io::Write;

use std::process::Command;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = (env::current_dir()?).join("version.txt");

    let file = File::create(path)?;
    let version_hash = get_git_hash()?;
    let version = format!("1.0.{version_hash}");
    (&file).write_all(version.as_bytes())?;

    Ok(())
}

fn get_git_hash() -> Result<String, String> {
    let output = Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .map_err(|e| format!("Failed to execute git command: {e}"))?;

    if !output.status.success() {
        return Err("git command failed".to_string());
    }

    let short_hash = String::from_utf8(output.stdout)
        .map_err(|e| format!("Failed to parse git hash: {e}"))?
        .trim()
        .to_string();

    let ts = build_timestamp()
        .map_err(|e| format!("Failed to compute build timestamp: {e}"))?;

    Ok(format!("{short_hash} ({ts})"))
}

fn build_timestamp() -> Result<String, Box<dyn std::error::Error>> {
    if let Ok(epoch) = env::var("SOURCE_DATE_EPOCH") {
        if let Ok(epoch) = epoch.parse::<i64>() {
            if let Some(dt_utc) = Utc.timestamp_opt(epoch, 0).single() {
                return Ok(dt_utc
                    .with_timezone(&Local)
                    .format("%d.%b %H:%M")
                    .to_string());
            }
        }
    }

    Ok(Local::now().format("%d.%b %H:%M").to_string())
}
