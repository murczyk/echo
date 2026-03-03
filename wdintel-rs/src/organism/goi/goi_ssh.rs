use crate::config::{ORGANISM_GOI_SSH_LIST_LIMIT, ORGANISM_GOI_SSH_TIMEOUT_MS};
use crate::organism::types::CheckOrganismGoiConnectionReq;
use crate::types::*;
use std::io::Read;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
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

    let command = format!("ls -1 {}", goi_shell_quote_single(path));
    let mut channel = session.channel_session().c(h!())?;
    channel.exec(&command).c(h!())?;

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
                "remote ls failed with status {exit_status}"
            )
            .context(h!()));
        }
        return Err(anyhow::anyhow!(
            "remote ls failed with status {exit_status}: {err}"
        )
        .context(h!()));
    }

    let listed_entries = stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(ORGANISM_GOI_SSH_LIST_LIMIT)
        .map(ToString::to_string)
        .collect();
    Ok(listed_entries)
}

fn goi_shell_quote_single(value: &str) -> String {
    let escaped = value.replace('\'', "'\\''");
    format!("'{escaped}'")
}
