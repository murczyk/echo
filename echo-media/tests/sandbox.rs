//! Generic sandbox enforcement, with shell utilities as the child process.
//! Runs unprivileged; root-only checks are skipped unless run as root.
//! Linux only: other platforms have no sandbox to test.
#![cfg(target_os = "linux")]

mod support;

use echo_media::process::{self, Output, Spec};
use echo_media::sandbox::kernel_landlock_abi;
use echo_media::{Limits, MediaError, Policy};
use std::path::Path;
use std::time::{Duration, Instant};
use support::*;

const SH: &str = "/bin/sh";
const BASH: &str = "/bin/bash";
const CAT: &str = "/usr/bin/cat";
const TIMEOUT: Duration = Duration::from_secs(10);

async fn run(
    program: &str,
    script: &str,
    policy: Policy,
) -> Result<Output, MediaError> {
    run_for(program, script, policy, TIMEOUT).await
}

async fn run_for(
    program: &str,
    script: &str,
    policy: Policy,
    timeout: Duration,
) -> Result<Output, MediaError> {
    let spec = Spec {
        program: program.into(),
        args: vec!["-c".into(), script.into()],
        policy,
        mode: sandbox_mode(),
        timeout,
        capture_stdout: true,
        redact: Vec::new(),
    };
    process::run(spec).await
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn denied(result: Result<Output, MediaError>) -> String {
    match result {
        Err(MediaError::InvalidMedia { stderr, .. }) => stderr,
        other => panic!("expected the sandbox to deny access, got {other:?}"),
    }
}

#[tokio::test]
async fn reads_only_granted_files() {
    let secrets = secrets();
    let allowed = tempfile::tempdir().unwrap();
    let file = write(allowed.path(), "input", b"granted");
    let policy = || Policy::for_programs(&[SH, CAT]).read_file(&file);

    let output = run(SH, &format!("cat {}", file.display()), policy())
        .await
        .unwrap();
    assert_eq!(stdout(&output), "granted");

    for path in [
        secrets.text.display().to_string(),
        "/etc/passwd".to_string(),
        format!("/proc/{}/environ", std::process::id()),
    ] {
        let stderr = denied(run(SH, &format!("cat {path}"), policy()).await);
        assert!(stderr.contains("Permission denied"), "{path}: {stderr}");
    }
}

#[tokio::test]
async fn symlinks_cannot_reach_ungranted_files() {
    let secrets = secrets();
    let out = tempfile::tempdir().unwrap();
    let link = out.path().join("link");
    std::os::unix::fs::symlink(&secrets.text, &link).unwrap();
    let policy = Policy::for_programs(&[SH, CAT]).write_dir(out.path());
    let stderr =
        denied(run(SH, &format!("cat {}", link.display()), policy).await);
    assert!(stderr.contains("Permission denied"), "{stderr}");
}

#[tokio::test]
async fn writes_only_inside_the_write_dir() {
    let out = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let policy = || Policy::for_programs(&[SH]).write_dir(out.path());

    let inside = out.path().join("file");
    run(SH, &format!("echo ok > {}", inside.display()), policy())
        .await
        .unwrap();
    assert_eq!(std::fs::read(&inside).unwrap(), b"ok\n");

    let outside = other.path().join("file");
    denied(
        run(SH, &format!("echo no > {}", outside.display()), policy()).await,
    );
    assert!(!outside.exists());
}

#[tokio::test]
async fn executes_only_listed_programs() {
    let policy = || Policy::for_programs(&[SH]);
    let output = run(SH, "echo builtin", policy()).await.unwrap();
    assert_eq!(stdout(&output), "builtin\n");
    for program in ["/usr/bin/ls /", "/usr/bin/cat /dev/null", "/usr/bin/env"] {
        let stderr = denied(run(SH, program, policy()).await);
        assert!(stderr.contains("Permission denied"), "{program}: {stderr}");
    }
}

#[tokio::test]
async fn file_size_limit_kills_with_sigxfsz() {
    let out = tempfile::tempdir().unwrap();
    let target = out.path().join("big");
    let policy = Policy::for_programs(&[SH, "/usr/bin/head"])
        .read_file("/dev/zero")
        .write_dir(out.path())
        .limits(Limits {
            file_size: Some(1024 * 1024),
        });
    let script =
        format!("exec head -c 4000000 /dev/zero > {}", target.display());
    let result = run(SH, &script, policy).await;
    assert!(matches!(result, Err(MediaError::OutputLimit)), "{result:?}");
    assert!(std::fs::metadata(&target).unwrap().len() <= 1024 * 1024);
}

#[tokio::test]
async fn environment_is_cleared() {
    std::env::set_var("ECHO_MEDIA_TEST_SECRET", "leaked");
    let spec = Spec {
        program: "/usr/bin/env".into(),
        args: Vec::new(),
        policy: Policy::for_programs(&["/usr/bin/env"]),
        mode: sandbox_mode(),
        timeout: TIMEOUT,
        capture_stdout: true,
        redact: Vec::new(),
    };
    let output = process::run(spec).await.unwrap();
    let mut lines: Vec<_> =
        stdout(&output).lines().map(str::to_owned).collect();
    lines.sort();
    assert_eq!(lines, ["AV_LOG_FORCE_NOCOLOR=1", "LC_ALL=C"]);
}

#[tokio::test]
async fn timeout_kills_the_whole_process_group() {
    let out = tempfile::tempdir().unwrap();
    let pid_file = out.path().join("pid");
    let policy =
        Policy::for_programs(&[SH, "/usr/bin/sleep"]).write_dir(out.path());
    let script = format!("sleep 30 & echo $! > {}; wait", pid_file.display());
    let started = Instant::now();
    let result = run_for(SH, &script, policy, Duration::from_millis(500)).await;
    assert!(matches!(result, Err(MediaError::Timeout(_))), "{result:?}");
    assert!(started.elapsed() < Duration::from_secs(5));
    let pid = std::fs::read_to_string(&pid_file).unwrap();
    wait_until_dead(pid.trim());
}

#[tokio::test]
async fn dropping_a_running_process_kills_it() {
    let out = tempfile::tempdir().unwrap();
    let pid_file = out.path().join("pid");
    let policy =
        Policy::for_programs(&[SH, "/usr/bin/sleep"]).write_dir(out.path());
    let spec = Spec {
        program: SH.into(),
        args: vec![
            "-c".into(),
            format!("echo $$ > {}; exec sleep 30", pid_file.display()).into(),
        ],
        policy,
        mode: sandbox_mode(),
        timeout: TIMEOUT,
        capture_stdout: false,
        redact: Vec::new(),
    };
    let running = process::spawn(spec).unwrap();
    let pid = wait_for_file(&pid_file);
    drop(running);
    wait_until_dead(pid.trim());
}

#[tokio::test]
async fn network_is_denied() {
    let landlock_tcp = kernel_landlock_abi().is_some_and(|abi| abi >= 4);
    if !landlock_tcp && !is_root() {
        eprintln!("skipped: needs root (network namespace) or Landlock ABI 4+");
        return;
    }
    let canary = Canary::start();
    let policy = Policy::for_programs(&[BASH]);
    let script = format!("exec 3<>/dev/tcp/127.0.0.1/{}", canary.port);
    denied(run(BASH, &script, policy).await);
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(canary.hits(), 0);
}

#[tokio::test]
async fn capabilities_are_dropped_and_no_new_privs_is_set() {
    let policy = Policy::for_programs(&[BASH]).read_dir("/proc");
    let script = "while read -r key value; do case $key in \
                  CapEff:|CapPrm:|CapAmb:|CapBnd:|NoNewPrivs:) echo \"$key $value\";; \
                  esac; done < /proc/self/status";
    let output = run(BASH, script, policy).await.unwrap();
    let status = stdout(&output);
    for line in [
        "CapEff: 0000000000000000",
        "CapPrm: 0000000000000000",
        "CapAmb: 0000000000000000",
        "NoNewPrivs: 1",
    ] {
        assert!(status.contains(line), "missing {line}:\n{status}");
    }
    if is_root() {
        assert!(status.contains("CapBnd: 0000000000000000"), "{status}");
    }
}

#[tokio::test]
async fn missing_granted_paths_are_rejected() {
    let policy =
        Policy::for_programs(&[SH]).read_file("/nonexistent/echo-media");
    let result = run(SH, "true", policy).await;
    assert!(matches!(result, Err(MediaError::Rejected(_))), "{result:?}");
}

fn wait_for_file(path: &Path) -> String {
    let deadline = Instant::now() + TIMEOUT;
    while Instant::now() < deadline {
        if let Ok(value) = std::fs::read_to_string(path) {
            if value.ends_with('\n') {
                return value;
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("{} was not written", path.display());
}

/// Dead means gone or a zombie waiting for its new parent to reap it.
fn wait_until_dead(pid: &str) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            Err(_) => return,
            Ok(stat)
                if stat
                    .rsplit(')')
                    .next()
                    .is_some_and(|rest| rest.trim_start().starts_with('Z')) =>
            {
                return
            }
            Ok(_) => std::thread::sleep(Duration::from_millis(20)),
        }
    }
    panic!("process {pid} survived");
}
