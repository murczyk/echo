use crate::config::{ORGANISM_GOI_SSH_LIST_LIMIT, ORGANISM_GOI_SSH_TIMEOUT_MS};
use crate::organism::types::CheckOrganismGoiConnectionReq;
use crate::types::*;
use std::env;
use std::io::Read;
use std::io::Write;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::Path;
use std::time::Duration;

pub fn goi_check_connection_sync(
    req: CheckOrganismGoiConnectionReq,
) -> anyhow::Result<Vec<String>> {
    let command = format!("ls -1 {}", goi_shell_quote_single(req.path.trim()));
    goi_exec_command_sync(req, command, ORGANISM_GOI_SSH_TIMEOUT_MS)
}

pub fn goi_exec_command_sync(
    req: CheckOrganismGoiConnectionReq,
    command: String,
    timeout_ms: u32,
) -> anyhow::Result<Vec<String>> {
    goi_exec_command_sync_impl(
        req,
        command,
        timeout_ms,
        Some(ORGANISM_GOI_SSH_LIST_LIMIT),
    )
}

pub fn goi_exec_command_sync_unlimited(
    req: CheckOrganismGoiConnectionReq,
    command: String,
    timeout_ms: u32,
) -> anyhow::Result<Vec<String>> {
    goi_exec_command_sync_impl(req, command, timeout_ms, None)
}

fn goi_exec_command_sync_impl(
    req: CheckOrganismGoiConnectionReq,
    command: String,
    timeout_ms: u32,
    max_lines: Option<usize>,
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
            max_lines,
        ) {
            Ok(output_lines) => return Ok(output_lines),
            Err(err) => errors.push(format!("{socket_addr}: {err:#}")),
        }
    }

    Err(anyhow::anyhow!(
        "GOI SSH command failed for all resolved addresses for {addr}: {}",
        errors.join("; ")
    )
    .context(h!()))
}

pub fn goi_upload_file_sync(
    req: CheckOrganismGoiConnectionReq,
    remote_file_path: String,
    file_data: Vec<u8>,
) -> anyhow::Result<()> {
    let addr = format!("{}:{}", req.ssh_host.trim(), req.ssh_port);
    let socket_addrs = goi_resolve_socket_addrs_ipv4_first(&addr)?;
    let timeout = Duration::from_millis(ORGANISM_GOI_SSH_TIMEOUT_MS.into());

    let mut errors = Vec::with_capacity(socket_addrs.len());
    for socket_addr in socket_addrs {
        match goi_try_upload_file_for_socket(
            socket_addr,
            timeout,
            ORGANISM_GOI_SSH_TIMEOUT_MS,
            req.ssh_user.trim(),
            &remote_file_path,
            &file_data,
        ) {
            Ok(_) => return Ok(()),
            Err(err) => errors.push(format!("{socket_addr}: {err:#}")),
        }
    }

    Err(anyhow::anyhow!(
        "GOI SSH file upload failed for all resolved addresses for {addr}: {}",
        errors.join("; ")
    )
    .context(h!()))
}

pub fn goi_delete_file_sync(
    req: CheckOrganismGoiConnectionReq,
    remote_file_path: String,
) -> anyhow::Result<()> {
    let addr = format!("{}:{}", req.ssh_host.trim(), req.ssh_port);
    let socket_addrs = goi_resolve_socket_addrs_ipv4_first(&addr)?;
    let timeout = Duration::from_millis(ORGANISM_GOI_SSH_TIMEOUT_MS.into());

    let command =
        format!("rm -f -- {}", goi_shell_quote_single(&remote_file_path));
    let mut errors = Vec::with_capacity(socket_addrs.len());
    for socket_addr in socket_addrs {
        match goi_try_exec_command_for_socket(
            socket_addr,
            timeout,
            ORGANISM_GOI_SSH_TIMEOUT_MS,
            req.ssh_user.trim(),
            &command,
            Some(ORGANISM_GOI_SSH_LIST_LIMIT),
        ) {
            Ok(_) => return Ok(()),
            Err(err) => errors.push(format!("{socket_addr}: {err:#}")),
        }
    }

    Err(anyhow::anyhow!(
        "GOI SSH file delete failed for all resolved addresses for {addr}: {}",
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

fn goi_try_upload_file_for_socket(
    socket_addr: SocketAddr,
    timeout: Duration,
    timeout_ms: u32,
    ssh_user: &str,
    remote_file_path: &str,
    file_data: &[u8],
) -> anyhow::Result<()> {
    let session =
        goi_connect_for_socket(socket_addr, timeout, timeout_ms, ssh_user)?;
    let mut remote_file = session
        .scp_send(
            Path::new(remote_file_path),
            0o644,
            file_data.len() as u64,
            None,
        )
        .c(h!())?;
    remote_file.write_all(file_data).c(h!())?;
    remote_file.send_eof().c(h!())?;
    remote_file.wait_eof().c(h!())?;
    remote_file.wait_close().c(h!())?;
    Ok(())
}

fn goi_try_exec_command_for_socket(
    socket_addr: SocketAddr,
    timeout: Duration,
    timeout_ms: u32,
    ssh_user: &str,
    command: &str,
    max_lines: Option<usize>,
) -> anyhow::Result<Vec<String>> {
    let session =
        goi_connect_for_socket(socket_addr, timeout, timeout_ms, ssh_user)?;
    goi_exec_command_for_session(session, command, max_lines)
}

fn goi_exec_command_for_session(
    session: ssh2::Session,
    command: &str,
    max_lines: Option<usize>,
) -> anyhow::Result<Vec<String>> {
    let mut channel = session.channel_session().c(h!())?;
    channel.exec(command).c(h!())?;

    let mut stdout = String::new();
    channel.read_to_string(&mut stdout).c(h!())?;
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

    let lines = stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToString::to_string);
    Ok(match max_lines {
        Some(limit) => lines.take(limit).collect(),
        None => lines.collect(),
    })
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
    // We intentionally skip SSH host-key verification in this probe.
    // GOI hosts are accessed through private Tailscale networking, which we
    // treat as sufficient MITM mitigation for this internal admin workflow.
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
