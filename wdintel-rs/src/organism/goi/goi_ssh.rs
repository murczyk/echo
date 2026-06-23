use crate::config::{ORGANISM_GOI_SSH_LIST_LIMIT, ORGANISM_GOI_SSH_TIMEOUT_MS};
use crate::organism::types::CheckOrganismGoiConnectionReq;
use crate::types::*;
use std::env;
use std::io::Read;
use std::io::Write;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
        false,
    )
}

pub fn goi_exec_command_sync_capped_strict(
    req: CheckOrganismGoiConnectionReq,
    command: String,
    timeout_ms: u32,
    max_lines: usize,
) -> anyhow::Result<Vec<String>> {
    goi_exec_command_sync_impl(req, command, timeout_ms, Some(max_lines), true)
}

fn goi_exec_command_sync_impl(
    req: CheckOrganismGoiConnectionReq,
    command: String,
    timeout_ms: u32,
    max_lines: Option<usize>,
    fail_on_limit: bool,
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
            fail_on_limit,
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

pub fn goi_download_file_sync(
    req: CheckOrganismGoiConnectionReq,
    remote_file_path: String,
) -> anyhow::Result<Vec<u8>> {
    let addr = format!("{}:{}", req.ssh_host.trim(), req.ssh_port);
    let socket_addrs = goi_resolve_socket_addrs_ipv4_first(&addr)?;
    let timeout = Duration::from_millis(ORGANISM_GOI_SSH_TIMEOUT_MS.into());

    let mut errors = Vec::with_capacity(socket_addrs.len());
    for socket_addr in socket_addrs {
        match goi_try_download_file_for_socket(
            socket_addr,
            timeout,
            ORGANISM_GOI_SSH_TIMEOUT_MS,
            req.ssh_user.trim(),
            &remote_file_path,
        ) {
            Ok(file_data) => return Ok(file_data),
            Err(err) => errors.push(format!("{socket_addr}: {err:#}")),
        }
    }

    Err(anyhow::anyhow!(
        "GOI SSH file download failed for all resolved addresses for {addr}: {}",
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
            false,
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
    let remote_temp_file_path = goi_remote_upload_temp_path(remote_file_path);
    if let Err(err) =
        goi_scp_send_file(&session, &remote_temp_file_path, file_data)
    {
        let _ = goi_remove_remote_file(&session, &remote_temp_file_path);
        return Err(err);
    }

    let command = goi_verify_and_replace_upload_command(
        &remote_temp_file_path,
        remote_file_path,
        file_data.len(),
        &sha256::digest(file_data),
    );
    goi_exec_command_for_session(
        &session,
        &command,
        Some(ORGANISM_GOI_SSH_LIST_LIMIT),
        false,
    )?;
    Ok(())
}

fn goi_scp_send_file(
    session: &ssh2::Session,
    remote_file_path: &str,
    file_data: &[u8],
) -> anyhow::Result<()> {
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

fn goi_remove_remote_file(
    session: &ssh2::Session,
    remote_file_path: &str,
) -> anyhow::Result<()> {
    goi_exec_command_for_session(
        session,
        &format!("rm -f -- {}", goi_shell_quote_single(remote_file_path)),
        Some(ORGANISM_GOI_SSH_LIST_LIMIT),
        false,
    )?;
    Ok(())
}

fn goi_remote_upload_temp_path(remote_file_path: &str) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "{}.upload-{}-{now}.tmp",
        remote_file_path,
        std::process::id()
    )
}

fn goi_verify_and_replace_upload_command(
    remote_temp_file_path: &str,
    remote_file_path: &str,
    expected_size: usize,
    expected_sha256: &str,
) -> String {
    format!(
        "\
tmp={tmp}; \
dst={dst}; \
expected_size={expected_size}; \
expected_sha256={expected_sha256}; \
trap 'rm -f -- \"$tmp\"' EXIT; \
actual_size=$(wc -c < \"$tmp\" | tr -d '[:space:]') || exit 1; \
actual_sha256=$(sha256sum \"$tmp\" | awk '{{print $1}}') || exit 1; \
if [ \"$actual_size\" != \"$expected_size\" ] || [ \"$actual_sha256\" != \"$expected_sha256\" ]; then \
echo \"GOI upload verification failed for $tmp: expected size=$expected_size sha256=$expected_sha256, got size=$actual_size sha256=$actual_sha256\" >&2; \
exit 1; \
fi; \
mv -f -- \"$tmp\" \"$dst\" || exit 1; \
trap - EXIT\
",
        tmp = goi_shell_quote_single(remote_temp_file_path),
        dst = goi_shell_quote_single(remote_file_path),
        expected_sha256 = goi_shell_quote_single(expected_sha256),
    )
}

fn goi_try_download_file_for_socket(
    socket_addr: SocketAddr,
    timeout: Duration,
    timeout_ms: u32,
    ssh_user: &str,
    remote_file_path: &str,
) -> anyhow::Result<Vec<u8>> {
    let session =
        goi_connect_for_socket(socket_addr, timeout, timeout_ms, ssh_user)?;
    let (mut remote_file, _) =
        session.scp_recv(Path::new(remote_file_path)).c(h!())?;
    let mut file_data = Vec::new();
    remote_file.read_to_end(&mut file_data).c(h!())?;
    remote_file.send_eof().c(h!())?;
    remote_file.wait_eof().c(h!())?;
    remote_file.wait_close().c(h!())?;
    Ok(file_data)
}

fn goi_try_exec_command_for_socket(
    socket_addr: SocketAddr,
    timeout: Duration,
    timeout_ms: u32,
    ssh_user: &str,
    command: &str,
    max_lines: Option<usize>,
    fail_on_limit: bool,
) -> anyhow::Result<Vec<String>> {
    let session =
        goi_connect_for_socket(socket_addr, timeout, timeout_ms, ssh_user)?;
    goi_exec_command_for_session(&session, command, max_lines, fail_on_limit)
}

fn goi_exec_command_for_session(
    session: &ssh2::Session,
    command: &str,
    max_lines: Option<usize>,
    fail_on_limit: bool,
) -> anyhow::Result<Vec<String>> {
    let mut channel = session.channel_session().c(h!())?;
    channel.exec(command).c(h!())?;

    let stdout_lines =
        goi_read_stdout_lines(&mut channel, max_lines, fail_on_limit)?;
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
    max_lines: Option<usize>,
    fail_on_limit: bool,
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

            if let Some(limit) = max_lines {
                if lines.len() >= limit {
                    if fail_on_limit {
                        return Err(anyhow::anyhow!(
                            "remote command output exceeds line limit {limit}"
                        )
                        .context(h!()));
                    }
                    ignore_remaining_stdout = true;
                    current_line.clear();
                    continue;
                }
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

pub(super) fn goi_shell_quote_single(value: &str) -> String {
    let escaped = value.replace('\'', "'\\''");
    format!("'{escaped}'")
}
