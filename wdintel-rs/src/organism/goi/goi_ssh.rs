use crate::config::{ORGANISM_GOI_SSH_LIST_LIMIT, ORGANISM_GOI_SSH_TIMEOUT_MS};
use crate::organism::types::CheckOrganismGoiConnectionReq;
use crate::types::*;
use std::io::Read;
use std::io::Write;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::Path;
use std::time::Duration;

pub fn goi_check_connection_sync(
    req: CheckOrganismGoiConnectionReq,
) -> anyhow::Result<Vec<String>> {
    let addr = format!("{}:{}", req.ssh_host.trim(), req.ssh_port);
    let socket_addrs = goi_resolve_socket_addrs_ipv4_first(&addr)?;
    let timeout = Duration::from_millis(ORGANISM_GOI_SSH_TIMEOUT_MS.into());

    let mut errors = Vec::with_capacity(socket_addrs.len());
    for socket_addr in socket_addrs {
        match goi_try_check_connection_for_socket(
            socket_addr,
            timeout,
            req.ssh_user.trim(),
            req.ssh_password.trim(),
            req.path.trim(),
        ) {
            Ok(listed_entries) => return Ok(listed_entries),
            Err(err) => errors.push(format!("{socket_addr}: {err:#}")),
        }
    }

    Err(anyhow::anyhow!(
        "GOI SSH check failed for all resolved addresses for {addr}: {}",
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
            req.ssh_user.trim(),
            req.ssh_password.trim(),
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
            req.ssh_user.trim(),
            req.ssh_password.trim(),
            &command,
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

fn goi_try_check_connection_for_socket(
    socket_addr: SocketAddr,
    timeout: Duration,
    ssh_user: &str,
    ssh_password: &str,
    path: &str,
) -> anyhow::Result<Vec<String>> {
    let session =
        goi_connect_for_socket(socket_addr, timeout, ssh_user, ssh_password)?;

    let command = format!("ls -1 {}", goi_shell_quote_single(path));
    goi_exec_command_for_session(session, &command)
}

fn goi_try_upload_file_for_socket(
    socket_addr: SocketAddr,
    timeout: Duration,
    ssh_user: &str,
    ssh_password: &str,
    remote_file_path: &str,
    file_data: &[u8],
) -> anyhow::Result<()> {
    let session =
        goi_connect_for_socket(socket_addr, timeout, ssh_user, ssh_password)?;
    let mut remote_file = session
        .scp_send(Path::new(remote_file_path), 0o644, file_data.len() as u64, None)
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
    ssh_user: &str,
    ssh_password: &str,
    command: &str,
) -> anyhow::Result<()> {
    let session =
        goi_connect_for_socket(socket_addr, timeout, ssh_user, ssh_password)?;
    goi_exec_command_for_session(session, command).map(|_| ())
}

fn goi_exec_command_for_session(
    session: ssh2::Session,
    command: &str,
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

    Ok(stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(ORGANISM_GOI_SSH_LIST_LIMIT)
        .map(ToString::to_string)
        .collect())
}

fn goi_connect_for_socket(
    socket_addr: SocketAddr,
    timeout: Duration,
    ssh_user: &str,
    ssh_password: &str,
) -> anyhow::Result<ssh2::Session> {
    let tcp = TcpStream::connect_timeout(&socket_addr, timeout).c(h!())?;
    tcp.set_read_timeout(Some(timeout)).c(h!())?;
    tcp.set_write_timeout(Some(timeout)).c(h!())?;

    let mut session = ssh2::Session::new().c(h!())?;
    session.set_tcp_stream(tcp);
    session.set_timeout(ORGANISM_GOI_SSH_TIMEOUT_MS);
    session.handshake().c(h!())?;
    // We intentionally skip SSH host-key verification in this probe.
    // GOI hosts are accessed through private Tailscale networking, which we
    // treat as sufficient MITM mitigation for this internal admin workflow.
    session.userauth_password(ssh_user, ssh_password).c(h!())?;
    if !session.authenticated() {
        return Err(anyhow::anyhow!("SSH authentication failed").context(h!()));
    }

    Ok(session)
}

fn goi_shell_quote_single(value: &str) -> String {
    let escaped = value.replace('\'', "'\\''");
    format!("'{escaped}'")
}
