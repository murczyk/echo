use crate::config::{ORGANISM_GOI_SSH_LIST_LIMIT, ORGANISM_GOI_SSH_TIMEOUT_MS};
use crate::organism::types::CheckOrganismGoiConnectionReq;
use crate::types::*;
use std::env;
use std::io::Read;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::Path;
use std::time::Duration;

pub fn goi_check_connection_sync(
    req: CheckOrganismGoiConnectionReq,
) -> anyhow::Result<Vec<String>> {
    let command = format!("ls -1 {}", goi_shell_quote_single(req.path.trim()));
    goi_exec_bootstrap_command_sync(req, command, ORGANISM_GOI_SSH_TIMEOUT_MS)
}

pub fn goi_setup_worker_sync(
    req: CheckOrganismGoiConnectionReq,
    setup_command: String,
    timeout_ms: u32,
) -> anyhow::Result<()> {
    goi_exec_bootstrap_command_sync(req, setup_command, timeout_ms).map(drop)
}

fn goi_exec_bootstrap_command_sync(
    req: CheckOrganismGoiConnectionReq,
    command: String,
    timeout_ms: u32,
) -> anyhow::Result<Vec<String>> {
    let addr = format!("{}:{}", req.ssh_host.trim(), req.ssh_port);
    let socket_addrs = goi_resolve_socket_addrs_ipv4_first(&addr)?;
    let timeout = Duration::from_millis(timeout_ms.into());

    let mut errors = Vec::with_capacity(socket_addrs.len());
    for socket_addr in socket_addrs {
        match goi_try_exec_command_for_socket(
            socket_addr,
            timeout,
            timeout_ms,
            req.ssh_user.trim(),
            &command,
        ) {
            Ok(output_lines) => return Ok(output_lines),
            Err(err) => errors.push(format!("{socket_addr}: {err:#}")),
        }
    }

    Err(anyhow::anyhow!(
        "GOI SSH bootstrap command failed for all resolved addresses for {addr}: {}",
        errors.join("; ")
    )
    .context(h!()))
}

fn goi_resolve_socket_addrs_ipv4_first(
    addr: &str,
) -> anyhow::Result<Vec<SocketAddr>> {
    let mut ipv4 = Vec::new();
    let mut other = Vec::new();
    for socket_addr in addr.to_socket_addrs().c(h!())? {
        if socket_addr.is_ipv4() {
            ipv4.push(socket_addr);
        } else {
            other.push(socket_addr);
        }
    }
    if ipv4.is_empty() && other.is_empty() {
        return Err(
            anyhow::anyhow!("no socket addresses for {addr}").context(h!())
        );
    }
    ipv4.extend(other);
    Ok(ipv4)
}

fn goi_try_exec_command_for_socket(
    socket_addr: SocketAddr,
    timeout: Duration,
    timeout_ms: u32,
    ssh_user: &str,
    command: &str,
) -> anyhow::Result<Vec<String>> {
    let session =
        goi_connect_for_socket(socket_addr, timeout, timeout_ms, ssh_user)?;
    goi_exec_command_for_session(&session, command)
}

fn goi_exec_command_for_session(
    session: &ssh2::Session,
    command: &str,
) -> anyhow::Result<Vec<String>> {
    let mut channel = session.channel_session().c(h!())?;
    channel.exec(command).c(h!())?;

    let stdout_lines = goi_read_stdout_lines(&mut channel)?;
    let mut stderr = String::new();
    channel.stderr().read_to_string(&mut stderr).c(h!())?;
    channel.wait_close().c(h!())?;
    let exit_status = channel.exit_status().c(h!())?;
    if exit_status != 0 {
        let err = stderr.trim();
        if err.is_empty() {
            return Err(anyhow::anyhow!(
                "remote command failed with status {exit_status}"
            )
            .context(h!()));
        }
        return Err(anyhow::anyhow!(
            "remote command failed with status {exit_status}: {err}"
        )
        .context(h!()));
    }
    Ok(stdout_lines)
}

fn goi_read_stdout_lines(
    channel: &mut ssh2::Channel,
) -> anyhow::Result<Vec<String>> {
    let mut lines = Vec::new();
    let mut current_line = Vec::new();
    let mut ignore_remaining_stdout = false;
    let mut buf = [0_u8; 8192];

    loop {
        let bytes_read = channel.read(&mut buf).c(h!())?;
        if bytes_read == 0 {
            break;
        }

        for byte in &buf[..bytes_read] {
            if ignore_remaining_stdout {
                continue;
            }
            if lines.len() >= ORGANISM_GOI_SSH_LIST_LIMIT {
                ignore_remaining_stdout = true;
                current_line.clear();
                continue;
            }
            if *byte == b'\n' {
                goi_push_stdout_line(&mut lines, &mut current_line);
            } else {
                current_line.push(*byte);
            }
        }
    }

    if !ignore_remaining_stdout {
        goi_push_stdout_line(&mut lines, &mut current_line);
    }
    Ok(lines)
}

fn goi_push_stdout_line(lines: &mut Vec<String>, line_buf: &mut Vec<u8>) {
    let line = String::from_utf8_lossy(line_buf);
    let line = line.trim();
    if !line.is_empty() {
        lines.push(line.to_string());
    }
    line_buf.clear();
}

fn goi_connect_for_socket(
    socket_addr: SocketAddr,
    timeout: Duration,
    timeout_ms: u32,
    ssh_user: &str,
) -> anyhow::Result<ssh2::Session> {
    let tcp = TcpStream::connect_timeout(&socket_addr, timeout).c(h!())?;
    tcp.set_read_timeout(Some(timeout)).c(h!())?;
    tcp.set_write_timeout(Some(timeout)).c(h!())?;

    let mut session = ssh2::Session::new().c(h!())?;
    session.set_tcp_stream(tcp);
    session.set_timeout(timeout_ms);
    session.handshake().c(h!())?;
    if session.userauth_agent(ssh_user).is_err() {
        goi_auth_with_pubkey_file(&mut session, ssh_user)?;
    }
    if !session.authenticated() {
        return Err(anyhow::anyhow!("SSH authentication failed").context(h!()));
    }
    Ok(session)
}

fn goi_auth_with_pubkey_file(
    session: &mut ssh2::Session,
    ssh_user: &str,
) -> anyhow::Result<()> {
    let home = env::var("HOME").context("HOME is not set")?;
    let home = Path::new(&home);
    let key_paths = [
        home.join(".ssh/id_ed25519"),
        home.join(".ssh/id_rsa"),
        home.join(".ssh/id_ecdsa"),
    ];

    for key_path in key_paths {
        if !key_path.exists() {
            continue;
        }
        if session
            .userauth_pubkey_file(ssh_user, None, &key_path, None)
            .is_ok()
        {
            return Ok(());
        }
    }

    Err(anyhow::anyhow!(
        "No working SSH key was found for authentication at ~/.ssh/id_ed25519, ~/.ssh/id_rsa, or ~/.ssh/id_ecdsa"
    ))
}

fn goi_shell_quote_single(value: &str) -> String {
    let escaped = value.replace('\'', "'\\''");
    format!("'{escaped}'")
}
