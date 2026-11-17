//! Runs one sandboxed process with a wall-clock deadline, an optional stdout
//! progress deadline, bounded output capture and a redacted stderr tail.
//! Dropping a [`Running`] kills its whole process group.

use crate::constants::*;
use crate::error::{MediaError, Result};
use crate::limits::ECHO_MEDIA_STDERR_TAIL_BYTES;
use crate::sandbox::{Policy, SandboxMode};
use anyhow::Context;
use rustix::process::{kill_process_group, Pid, Signal};
use std::ffi::OsString;
use std::os::unix::process::ExitStatusExt;
use std::path::PathBuf;
use std::process::{ExitStatus, Stdio};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, ChildStdout, Command};
use tokio::task::JoinHandle;
use tokio::time::Instant;

/// One process to run inside the sandbox.
#[derive(Debug)]
pub struct Spec {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub policy: Policy,
    pub mode: SandboxMode,
    pub timeout: Duration,
    /// Pipe stdout to the caller; otherwise it goes to `/dev/null`.
    pub capture_stdout: bool,
    /// Strings replaced with `<redacted>` in the stderr tail.
    pub redact: Vec<String>,
}

/// A finished process: captured stdout and the sanitised stderr tail.
#[derive(Debug, Default)]
pub struct Output {
    pub stdout: Vec<u8>,
    pub stderr: String,
}

/// A process that is still running. Dropping it kills the process group.
#[derive(Debug)]
pub struct Running {
    // Declared first so it is dropped (and the group killed) before `child`.
    group: Group,
    child: Child,
    stdout: Option<ChildStdout>,
    stderr: Option<JoinHandle<Vec<u8>>>,
    deadline: Instant,
    timeout: Duration,
    redact: Vec<String>,
}

/// Run to completion, expecting no stdout: any output is
/// [`MediaError::OutputLimit`]. Use [`capture`] to keep stdout.
pub async fn run(spec: Spec) -> Result<Output> {
    capture(spec, 0).await
}

/// Run to completion, capturing stdout. More than `max_bytes` of it kills the
/// process with [`MediaError::OutputLimit`], so a hostile input cannot grow
/// the parent's memory through the decoder's stdout.
pub async fn capture(spec: Spec, max_bytes: usize) -> Result<Output> {
    let mut stdout = Vec::new();
    let consume = |chunk: &[u8]| {
        if stdout.len() + chunk.len() > max_bytes {
            return Err(MediaError::OutputLimit);
        }
        stdout.extend_from_slice(chunk);
        Ok(true)
    };
    let mut output = run_with(spec, None, consume).await?;
    output.stdout = stdout;
    Ok(output)
}

/// Run to completion, feeding stdout chunks to `consume`. `consume` returns
/// whether the chunk counts as progress for `progress_timeout`.
pub async fn run_with<F>(
    spec: Spec,
    progress_timeout: Option<Duration>,
    consume: F,
) -> Result<Output>
where
    F: FnMut(&[u8]) -> Result<bool>,
{
    let mut running = spawn(spec)?;
    if let Err(error) = running.read_stdout(progress_timeout, consume).await {
        running.terminate().await;
        return Err(error);
    }
    running.wait().await
}

/// Start the process and return immediately.
pub fn spawn(spec: Spec) -> Result<Running> {
    let mut command = Command::new(&spec.program);
    command
        .args(&spec.args)
        .stdin(Stdio::null())
        .stdout(if spec.capture_stdout {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    spec.policy.apply(spec.mode, &mut command)?;
    let mut child = command
        .spawn()
        .with_context(|| format!("spawn {}", spec.program.display()))?;
    let group = Group(child.id().and_then(|pid| Pid::from_raw(pid as i32)));
    let stderr = child.stderr.take().map(|pipe| {
        tokio::spawn(read_tail(pipe, ECHO_MEDIA_STDERR_TAIL_BYTES))
    });
    Ok(Running {
        group,
        stdout: child.stdout.take(),
        child,
        stderr,
        deadline: Instant::now() + spec.timeout,
        timeout: spec.timeout,
        redact: spec.redact,
    })
}

impl Running {
    /// `Ok(Some)` once the process has exited successfully, `Ok(None)` while
    /// it runs. Past the deadline the process is killed.
    pub async fn try_wait(&mut self) -> Result<Option<Output>> {
        if Instant::now() >= self.deadline {
            self.terminate().await;
            return Err(MediaError::Timeout(self.timeout));
        }
        match self.child.try_wait().context("poll media process")? {
            Some(status) => self.finish(status).await.map(Some),
            None => Ok(None),
        }
    }

    /// Wait for exit, killing the process group at the deadline.
    pub async fn wait(&mut self) -> Result<Output> {
        match tokio::time::timeout_at(self.deadline, self.child.wait()).await {
            Ok(status) => {
                let status = status.context("wait for media process")?;
                self.finish(status).await
            }
            Err(_) => {
                self.terminate().await;
                Err(MediaError::Timeout(self.timeout))
            }
        }
    }

    /// Kill the process group and reap the process.
    pub async fn terminate(&mut self) {
        self.group.kill();
        let _ = self.child.kill().await;
    }

    async fn read_stdout<F>(
        &mut self,
        progress_timeout: Option<Duration>,
        mut consume: F,
    ) -> Result<()>
    where
        F: FnMut(&[u8]) -> Result<bool>,
    {
        let Some(mut stdout) = self.stdout.take() else {
            return Ok(());
        };
        let mut buffer = [0u8; ECHO_MEDIA_READ_CHUNK_BYTES];
        let mut progressed = Instant::now();
        loop {
            let stalled = progress_timeout.map(|limit| progressed + limit);
            let wake =
                stalled.map_or(self.deadline, |at| at.min(self.deadline));
            let read =
                tokio::time::timeout_at(wake, stdout.read(&mut buffer)).await;
            let Ok(read) = read else {
                return Err(match progress_timeout {
                    Some(limit) if Instant::now() < self.deadline => {
                        MediaError::ProgressTimeout(limit)
                    }
                    _ => MediaError::Timeout(self.timeout),
                });
            };
            let length = read.context("read media process stdout")?;
            if length == 0 {
                return Ok(());
            }
            if consume(&buffer[..length])? {
                progressed = Instant::now();
            }
        }
    }

    async fn finish(&mut self, status: ExitStatus) -> Result<Output> {
        // Leftover processes forked by the child die with the group.
        self.group.kill();
        let stderr = match self.stderr.take() {
            Some(task) => task.await.unwrap_or_default(),
            None => Vec::new(),
        };
        let stderr = sanitize(&stderr, &self.redact);
        classify(status, stderr)
    }
}

fn classify(status: ExitStatus, stderr: String) -> Result<Output> {
    if status.success() {
        return Ok(Output {
            stdout: Vec::new(),
            stderr,
        });
    }
    Err(match status.signal() {
        Some(libc::SIGXFSZ) => MediaError::OutputLimit,
        Some(signal) => MediaError::Crashed { signal, stderr },
        None => MediaError::InvalidMedia {
            reason: format!("process exited with {status}"),
            stderr,
        },
    })
}

#[derive(Debug)]
struct Group(Option<Pid>);

impl Group {
    fn kill(&mut self) {
        if let Some(pid) = self.0.take() {
            // ESRCH: the group is already gone.
            let _ = kill_process_group(pid, Signal::KILL);
        }
    }
}

impl Drop for Group {
    fn drop(&mut self) {
        self.kill();
    }
}

/// Drains `pipe` to EOF, keeping only its last `limit` bytes so a chatty
/// decoder cannot grow memory for the whole job. A truncated tail starts at
/// the next full line, so a cut-off secret cannot escape redaction.
async fn read_tail(mut pipe: impl AsyncRead + Unpin, limit: usize) -> Vec<u8> {
    let mut tail = Vec::with_capacity(limit.min(ECHO_MEDIA_READ_CHUNK_BYTES));
    let mut buffer = [0u8; ECHO_MEDIA_READ_CHUNK_BYTES];
    let mut truncated = false;
    while let Ok(length @ 1..) = pipe.read(&mut buffer).await {
        tail.extend_from_slice(&buffer[..length]);
        if tail.len() > limit {
            tail.drain(..tail.len() - limit);
            truncated = true;
        }
    }
    if truncated {
        let line_start = tail
            .iter()
            .position(|&byte| byte == b'\n')
            .map_or(tail.len(), |newline| newline + 1);
        tail.drain(..line_start);
    }
    tail
}

/// Removes secrets and control characters from decoder stderr before it
/// reaches logs (checklist L1).
pub(crate) fn sanitize(bytes: &[u8], redact: &[String]) -> String {
    let mut text = String::from_utf8_lossy(bytes).into_owned();
    for secret in redact.iter().filter(|secret| !secret.is_empty()) {
        text = text.replace(secret.as_str(), ECHO_MEDIA_REDACTED);
    }
    text.chars()
        .map(|c| if c.is_control() && c != '\n' { '?' } else { c })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_redacts_secrets_and_control_characters() {
        let stderr = b"open https://s3/x?sig=abc failed\x1b[31m\r\nnext";
        let clean = sanitize(stderr, &["https://s3/x?sig=abc".to_string()]);
        assert_eq!(clean, "open <redacted> failed?[31m?\nnext");
    }

    #[tokio::test]
    async fn read_tail_keeps_last_full_lines() {
        let line = b"open https://s3/x?sig=abc failed\n";
        let input = line.repeat(10_000);
        let tail = read_tail(input.as_slice(), 1000).await;
        assert!(tail.len() <= 1000);
        assert!(tail.starts_with(b"open "));
        assert!(input.ends_with(&tail));

        let tail = read_tail(&b"short"[..], 1000).await;
        assert_eq!(tail, b"short");

        let tail = read_tail(&[b'x'; 5000][..], 1000).await;
        assert!(tail.is_empty());
    }
}
