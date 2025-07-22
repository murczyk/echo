use chrono::offset::Local;
use std::env;
use std::fs::File;
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = PathBuf::from(env::current_dir()?).join("version.txt");

    let file = File::create(path)?;
    let version_hash = get_git_hash()?;
    let version = format!("1.0.{}", version_hash);
    (&file).write_all(version.as_bytes())?;

    Ok(())
}

fn get_git_hash() -> Result<String, String> {
    let output = Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .map_err(|e| format!("Failed to execute git command: {}", e))?;

    if !output.status.success() {
        return Err("git command failed".to_string());
    }

    String::from_utf8(output.stdout)
        .map(|s| s.trim().to_string())
        .map(|s| format!("{s} ({})", Local::now().format("%d.%b %H:%M")))
        .map_err(|e| format!("Failed to parse git hash: {}", e))
}
