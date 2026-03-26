use anyhow::Result;
use std::thread;
use std::time::Duration;

pub fn run() -> Result<()> {
    loop {
        thread::sleep(Duration::from_secs(3600));
    }
}
