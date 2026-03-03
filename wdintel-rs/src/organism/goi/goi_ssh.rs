use crate::config::{ORGANISM_GOI_SSH_LIST_LIMIT, ORGANISM_GOI_SSH_TIMEOUT_MS};
use crate::organism::types::CheckOrganismGoiConnectionReq;
use crate::types::*;
use std::io::Read;
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

pub fn goi_check_connection_sync(
    req: CheckOrganismGoiConnectionReq,
) -> anyhow::Result<Vec<String>> {
    let addr = format!("{}:{}", req.ssh_host.trim(), req.ssh_port);
    let socket_addr = addr
        .to_socket_addrs()
        .c(h!())?
        .next()
        .ok_or_else(|| anyhow::anyhow!("no socket addresses for {addr}"))
        .c(h!())?;

    let timeout = Duration::from_millis(ORGANISM_GOI_SSH_TIMEOUT_MS.into());
    let tcp = TcpStream::connect_timeout(&socket_addr, timeout).c(h!())?;
    tcp.set_read_timeout(Some(timeout)).c(h!())?;
    tcp.set_write_timeout(Some(timeout)).c(h!())?;

    let mut session = ssh2::Session::new().c(h!())?;
    session.set_tcp_stream(tcp);
    session.set_timeout(ORGANISM_GOI_SSH_TIMEOUT_MS);
    session.handshake().c(h!())?;
    session
        .userauth_password(req.ssh_user.trim(), req.ssh_password.trim())
        .c(h!())?;
    if !session.authenticated() {
        return Err(anyhow::anyhow!("SSH authentication failed").context(h!()));
    }

    let command = format!("ls -1 {}", goi_shell_quote_single(req.path.trim()));
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
