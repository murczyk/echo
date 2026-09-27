use crate::{h, types::ShortContext};
use std::{fs::File, io::Write, path::PathBuf};

pub(super) struct SessionLog {
    file: File,
    pub path: PathBuf,
}

impl SessionLog {
    pub fn new() -> anyhow::Result<Self> {
        let file = tempfile::Builder::new()
            .prefix("echo-ai-control-panel-")
            .suffix(".log")
            .tempfile()
            .c(h!())?;
        let (file, path) = file.keep().c(h!())?;
        Ok(Self { file, path })
    }

    pub fn write(&mut self, message: &str) -> anyhow::Result<()> {
        writeln!(self.file, "{} {message}", chrono::Utc::now().to_rfc3339())
            .c(h!())?;
        self.file.flush().c(h!())
    }
}

impl Drop for SessionLog {
    fn drop(&mut self) {
        eprintln!("AI control panel log: {}", self.path.display());
    }
}
