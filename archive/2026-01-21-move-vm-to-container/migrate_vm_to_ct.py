#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

import typer


app = typer.Typer(add_completion=False)


@dataclass(frozen=True)
class SSHConfig:
    user: str
    host: str
    jump: Optional[str] = None
    agent: bool = False
    known_hosts: Optional[Path] = None
    strict_host_key: bool = False

    @property
    def target(self) -> str:
        return f"{self.user}@{self.host}"


class CommandError(RuntimeError):
    def __init__(self, cmd: List[str], returncode: int, stdout: str, stderr: str):
        super().__init__(f"Command failed ({returncode}): {' '.join(cmd)}\n{stderr.strip()}")
        self.cmd = cmd
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def run_command(cmd: List[str], check: bool = True) -> subprocess.CompletedProcess:
    result = subprocess.run(cmd, text=True, capture_output=True)
    if check and result.returncode != 0:
        raise CommandError(cmd, result.returncode, result.stdout, result.stderr)
    return result


def build_ssh_command(conf: SSHConfig, remote_cmd: Optional[str] = None) -> List[str]:
    cmd = [
        "ssh",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
    ]
    if conf.known_hosts:
        cmd.extend(
            [
                "-o",
                f"UserKnownHostsFile={conf.known_hosts}",
                "-o",
                "GlobalKnownHostsFile=/dev/null",
            ]
        )
    cmd.extend(
        [
            "-o",
            f"StrictHostKeyChecking={'accept-new' if conf.strict_host_key else 'no'}",
        ]
    )
    if conf.agent:
        cmd.append("-A")
    if conf.jump:
        cmd.extend(["-J", conf.jump])
    cmd.append(conf.target)
    if remote_cmd is not None:
        cmd.append(remote_cmd)
    return cmd


def run_ssh(conf: SSHConfig, remote_cmd: str, check: bool = True) -> str:
    cmd = build_ssh_command(conf, remote_cmd)
    result = run_command(cmd, check=check)
    return result.stdout.strip()


def run_ssh_result(conf: SSHConfig, remote_cmd: str) -> subprocess.CompletedProcess:
    cmd = build_ssh_command(conf, remote_cmd)
    return run_command(cmd, check=False)


def command_exists(conf: SSHConfig, command: str) -> bool:
    result = run_ssh_result(conf, f"command -v {shlex.quote(command)}")
    return result.returncode == 0


def prepare_known_hosts(path: Path, refresh: bool) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if refresh and path.exists():
        path.unlink()


def parse_ssh_command(line: str) -> Optional[Dict[str, str]]:
    if "ssh" not in line:
        return None
    idx = line.find("ssh")
    cmd = line[idx:]
    parts = shlex.split(cmd)
    if not parts or parts[0] != "ssh":
        return None
    jump = None
    agent = False
    target = None
    i = 1
    while i < len(parts):
        part = parts[i]
        if part == "-A":
            agent = True
            i += 1
            continue
        if part == "-J":
            if i + 1 < len(parts):
                jump = parts[i + 1]
                i += 2
                continue
            return None
        if part.startswith("-J") and len(part) > 2:
            jump = part[2:]
            i += 1
            continue
        if part in {"-o", "-p", "-i"}:
            i += 2
            continue
        if part.startswith("-"):
            i += 1
            continue
        target = part
        break
    if not target or "@" not in target:
        return None
    user, host = target.split("@", 1)
    return {"user": user, "host": host, "jump": jump, "agent": str(agent)}


def extract_ssh_defaults(readme_path: Path) -> Dict[str, Dict[str, str]]:
    if not readme_path.exists():
        return {}
    text = readme_path.read_text()
    commands: List[str] = []
    in_block = False
    for line in text.splitlines():
        if line.strip().startswith("```"):
            in_block = not in_block
            continue
        if in_block and "ssh" in line:
            commands.append(line.strip())
    defaults: Dict[str, Dict[str, str]] = {}
    if commands:
        vm = parse_ssh_command(commands[0])
        if vm:
            defaults["vm"] = vm
    if len(commands) > 1:
        ct = parse_ssh_command(commands[1])
        if ct:
            defaults["ct"] = ct
    return defaults


def parse_user_host(target: Optional[str]) -> Tuple[Optional[str], Optional[str]]:
    if not target:
        return None, None
    if "@" not in target:
        return None, None
    user, host = target.split("@", 1)
    return user, host


def major_version(version: str) -> str:
    match = re.search(r"(\d+)", version)
    return match.group(1) if match else "0"


def get_packages(conf: SSHConfig) -> Dict[str, str]:
    output = run_ssh(conf, "dpkg-query -W -f='${Package}\\t${Version}\\n'")
    packages = {}
    for line in output.splitlines():
        if not line.strip():
            continue
        if "\t" not in line:
            continue
        pkg, ver = line.split("\t", 1)
        packages[pkg] = ver
    return packages


def get_users(conf: SSHConfig) -> List[Dict[str, str]]:
    output = run_ssh(conf, "getent passwd")
    users = []
    for line in output.splitlines():
        parts = line.split(":")
        if len(parts) < 7:
            continue
        users.append(
            {
                "name": parts[0],
                "uid": parts[2],
                "gid": parts[3],
                "home": parts[5],
                "shell": parts[6],
            }
        )
    return users


def regular_users(users: Iterable[Dict[str, str]]) -> List[Dict[str, str]]:
    regular = []
    for user in users:
        try:
            uid = int(user["uid"])
        except ValueError:
            continue
        if uid < 1000 or uid == 65534:
            continue
        shell = user["shell"]
        if "nologin" in shell or shell.endswith("/false"):
            continue
        regular.append(user)
    return regular


def get_service_status(conf: SSHConfig, service: str) -> str:
    output = run_ssh(conf, f"systemctl is-active {shlex.quote(service)}", check=False)
    if not output:
        return "unknown"
    return output.strip()


def get_path_size(conf: SSHConfig, path: str) -> Tuple[bool, Optional[int]]:
    quoted = shlex.quote(path)
    cmd = (
        f"if sudo -n test -e {quoted}; "
        f"then sudo -n du -sx --block-size=1 {quoted} | cut -f1; "
        f"else echo MISSING; fi"
    )
    output = run_ssh(conf, cmd, check=False)
    if output.strip() == "MISSING":
        return False, None
    try:
        return True, int(output.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return False, None


def format_bytes(value: Optional[int]) -> str:
    if value is None:
        return "-"
    units = ["B", "KB", "MB", "GB", "TB"]
    size = float(value)
    for unit in units:
        if size < 1024 or unit == units[-1]:
            return f"{size:.1f}{unit}"
        size /= 1024
    return f"{size:.1f}TB"


def get_postgres_data_dir(conf: SSHConfig) -> Optional[str]:
    cmd = "sudo -n -u postgres psql -tAc \"SHOW data_directory;\""
    output = run_ssh(conf, cmd, check=False).strip()
    if output:
        return output.splitlines()[-1].strip()
    output = run_ssh(conf, "pg_lsclusters --no-header", check=False).strip()
    if not output:
        return None
    parts = output.split()
    if len(parts) >= 6:
        return parts[5]
    return None


def get_hostnamectl(conf: SSHConfig) -> str:
    return run_ssh(conf, "hostnamectl", check=False)


def get_nginx_config(conf: SSHConfig) -> Optional[str]:
    if not command_exists(conf, "nginx"):
        return None
    result = run_ssh_result(conf, "sudo -n nginx -T 2>/dev/null")
    if result.returncode != 0 or not result.stdout.strip():
        return None
    return result.stdout


def parse_nginx_paths(config_text: str) -> List[str]:
    paths: List[str] = []
    for raw in config_text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        match = re.search(r"\b(root|alias)\s+([^;]+);", line)
        if not match:
            continue
        path = match.group(2).strip().strip('"').strip("'")
        if "$" in path:
            continue
        if not path.startswith("/"):
            continue
        paths.append(path)
    return sorted({path.rstrip("/") if path != "/" else path for path in paths})


def parse_nginx_user(config_text: str) -> Optional[str]:
    for raw in config_text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        match = re.match(r"user\s+([^;]+);", line)
        if match:
            user_field = match.group(1).strip()
            return user_field.split()[0]
    return None


def get_user_group(conf: SSHConfig, user: str) -> Optional[str]:
    output = run_ssh(conf, f"getent passwd {shlex.quote(user)}", check=False).strip()
    if not output:
        return None
    parts = output.split(":")
    if len(parts) < 4:
        return None
    gid = parts[3]
    group = run_ssh(conf, f"getent group {shlex.quote(gid)}", check=False).strip()
    if not group:
        return None
    return group.split(":", 1)[0]


def path_chain(path: str) -> List[str]:
    normalized = os.path.normpath(path)
    if normalized == "/":
        return ["/"]
    parts = normalized.strip("/").split("/")
    chain = ["/"]
    current = ""
    for part in parts:
        current = f"{current}/{part}" if current else f"/{part}"
        chain.append(current)
    return chain


def stat_dir(conf: SSHConfig, path: str) -> str:
    output = run_ssh(
        conf, f"stat -c '%A %U %G %a' {shlex.quote(path)}", check=False
    )
    return output.strip()


def can_traverse(conf: SSHConfig, user: str, path: str) -> bool:
    result = run_ssh_result(
        conf, f"sudo -n -u {shlex.quote(user)} test -x {shlex.quote(path)}"
    )
    return result.returncode == 0


def build_nginx_permission_report(
    conf: SSHConfig, config_text: Optional[str]
) -> Dict[str, object]:
    if not config_text:
        return {"available": False, "reason": "nginx not available"}
    nginx_user = parse_nginx_user(config_text) or "www-data"
    nginx_group = get_user_group(conf, nginx_user)
    paths = parse_nginx_paths(config_text)
    issues = []
    for path in paths:
        exists_output = run_ssh(
            conf, f"test -e {shlex.quote(path)} && echo OK || echo MISSING", check=False
        )
        if exists_output.strip() != "OK":
            issues.append(
                {"path": path, "issue": "missing", "details": "path not found"}
            )
            continue
        for parent in path_chain(path):
            if nginx_user == "root":
                continue
            if not can_traverse(conf, nginx_user, parent):
                issues.append(
                    {
                        "path": path,
                        "issue": "no-traverse",
                        "parent": parent,
                        "stat": stat_dir(conf, parent),
                    }
                )
    return {
        "available": True,
        "user": nginx_user,
        "group": nginx_group,
        "paths": paths,
        "issues": issues,
    }

def build_plan_text(
    timestamp: str,
    vm_conf: SSHConfig,
    ct_conf: SSHConfig,
    vm_info: Dict[str, str],
    ct_info: Dict[str, str],
    package_diff: Dict[str, List[str]],
    user_diff: Dict[str, List[str]],
    service_status: Dict[str, Dict[str, str]],
    dir_rows: List[Dict[str, str]],
    copy_items: List[str],
    warnings: List[str],
    tailscale_owner: str,
    transfer_mode: str,
    nginx_reports: Dict[str, Dict[str, object]],
) -> str:
    lines: List[str] = []
    lines.append("Migration plan")
    lines.append(f"Generated: {timestamp}")
    lines.append("")
    lines.append(f"VM: {vm_conf.target} via {vm_conf.jump or 'direct'}")
    lines.append(f"CT: {ct_conf.target} via {ct_conf.jump or 'direct'}")
    if vm_conf.known_hosts:
        lines.append(f"Known hosts: {vm_conf.known_hosts}")
        lines.append(
            f"Host key checking: {'accept-new' if vm_conf.strict_host_key else 'no'}"
        )
    lines.append("")
    lines.append("VM hostnamectl:")
    lines.append(vm_info.get("hostnamectl", "").strip())
    lines.append("")
    lines.append("CT hostnamectl:")
    lines.append(ct_info.get("hostnamectl", "").strip())
    lines.append("")
    lines.append("Package differences:")
    lines.append(f"- VM-only packages: {len(package_diff['vm_only'])}")
    if package_diff["vm_only_sample"]:
        lines.append(f"- VM-only sample: {', '.join(package_diff['vm_only_sample'])}")
    lines.append(f"- CT-only packages: {len(package_diff['ct_only'])}")
    if package_diff["ct_only_sample"]:
        lines.append(f"- CT-only sample: {', '.join(package_diff['ct_only_sample'])}")
    lines.append(f"- Major version mismatches: {len(package_diff['major_mismatch'])}")
    if package_diff["major_mismatch_sample"]:
        lines.append(f"- Mismatch sample: {', '.join(package_diff['major_mismatch_sample'])}")
    lines.append("")
    lines.append("User differences:")
    lines.append(f"- VM regular users: {', '.join(user_diff['vm_users']) or 'none'}")
    lines.append(f"- CT regular users: {', '.join(user_diff['ct_users']) or 'none'}")
    if user_diff["missing_in_ct"]:
        lines.append(f"- Missing in CT: {', '.join(user_diff['missing_in_ct'])}")
    if user_diff["missing_in_vm"]:
        lines.append(f"- Missing in VM: {', '.join(user_diff['missing_in_vm'])}")
    if user_diff["uid_mismatch"]:
        lines.append(f"- UID mismatches: {', '.join(user_diff['uid_mismatch'])}")
    if user_diff["home_mismatch"]:
        lines.append(f"- Home mismatches: {', '.join(user_diff['home_mismatch'])}")
    lines.append("")
    lines.append("Service status:")
    for service, states in service_status.items():
        lines.append(f"- {service}: vm={states['vm']} ct={states['ct']}")
    lines.append("")
    vm_nginx = nginx_reports.get("vm", {})
    ct_nginx = nginx_reports.get("ct", {})
    lines.append("Nginx permission check:")
    if vm_nginx.get("available"):
        issues = vm_nginx.get("issues", [])
        lines.append(f"- VM nginx user: {vm_nginx.get('user')}")
        lines.append(f"- VM paths: {len(vm_nginx.get('paths', []))}")
        lines.append(f"- VM issues: {len(issues)}")
        for issue in issues[:10]:
            if issue.get("issue") == "missing":
                lines.append(f"  - missing: {issue.get('path')}")
            else:
                stat = issue.get("stat", "")
                lines.append(
                    f"  - no-traverse: {issue.get('parent')} (for {issue.get('path')}) {stat}"
                )
    else:
        lines.append(f"- VM nginx check skipped: {vm_nginx.get('reason')}")
    if ct_nginx.get("available"):
        issues = ct_nginx.get("issues", [])
        lines.append(f"- CT nginx user: {ct_nginx.get('user')}")
        lines.append(f"- CT paths: {len(ct_nginx.get('paths', []))}")
        lines.append(f"- CT issues: {len(issues)}")
        for issue in issues[:10]:
            if issue.get("issue") == "missing":
                lines.append(f"  - missing: {issue.get('path')}")
            else:
                stat = issue.get("stat", "")
                lines.append(
                    f"  - no-traverse: {issue.get('parent')} (for {issue.get('path')}) {stat}"
                )
    else:
        lines.append(f"- CT nginx check skipped: {ct_nginx.get('reason')}")
    lines.append("")
    lines.append("Directory stats (sizes are human-readable):")
    lines.append("path | vm_size | ct_size | copy")
    for row in dir_rows:
        lines.append(
            f"{row['path']} | {row['vm_size']} | {row['ct_size']} | {row['copy']}"
        )
    lines.append("")
    lines.append("Planned copy items (in order):")
    for path in copy_items:
        lines.append(f"- {path}")
    if warnings:
        lines.append("")
        lines.append("Warnings:")
        for warning in warnings:
            lines.append(f"- {warning}")
    lines.append("")
    lines.append(f"Transfer mode: {transfer_mode}")
    lines.append("")
    lines.append("Execution plan:")
    lines.append("1) Stop services: tailscaled/postgresql on VM, tailscaled/postgresql/nginx on CT")
    lines.append("2) Stream-copy planned directories from VM to CT")
    lines.append(f"3) Start services (tailscaled only on {tailscale_owner})")
    lines.append("4) Compare directory sizes (size-only)")
    lines.append("")
    return "\n".join(lines)


def write_plan_files(
    workdir: Path,
    timestamp: str,
    plan_text: str,
    details: Dict[str, object],
) -> Tuple[Path, Path]:
    plan_path = workdir / f"migration_plan_{timestamp}.md"
    details_path = workdir / f"migration_plan_{timestamp}.json"
    plan_path.write_text(plan_text)
    details_path.write_text(json.dumps(details, indent=2, sort_keys=True))
    return plan_path, details_path


def ensure_dir_exists(conf: SSHConfig, path: str) -> None:
    quoted = shlex.quote(path)
    run_ssh(conf, f"sudo -n mkdir -p {quoted}")


def stream_copy_path_local(vm_conf: SSHConfig, ct_conf: SSHConfig, path: str) -> None:
    rel_path = path.lstrip("/")
    src_cmd = build_ssh_command(
        vm_conf,
        f"sudo -n tar -cpf - -C / {shlex.quote(rel_path)}",
    )
    dst_cmd = build_ssh_command(
        ct_conf,
        "sudo -n tar -xpf - -C /",
    )
    src = subprocess.Popen(src_cmd, stdout=subprocess.PIPE)
    if src.stdout is None:
        raise RuntimeError("Failed to open source stream")
    dst = subprocess.Popen(dst_cmd, stdin=src.stdout)
    src.stdout.close()
    src_rc = src.wait()
    dst_rc = dst.wait()
    if src_rc != 0 or dst_rc != 0:
        raise RuntimeError(f"Stream copy failed for {path} (src={src_rc}, dst={dst_rc})")


def build_inner_ssh_args(ct_conf: SSHConfig, use_jump: bool) -> List[str]:
    args = [
        "ssh",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "GlobalKnownHostsFile=/dev/null",
    ]
    if use_jump and ct_conf.jump:
        args.extend(["-J", ct_conf.jump])
    args.append(ct_conf.target)
    return args


def stream_copy_path_remote(
    vm_conf: SSHConfig, ct_conf: SSHConfig, path: str, use_jump: bool
) -> None:
    rel_path = path.lstrip("/")
    inner_args = build_inner_ssh_args(ct_conf, use_jump)
    inner_cmd = "sudo -n tar -xpf - -C /"
    inner = " ".join(shlex.quote(part) for part in inner_args + [inner_cmd])
    remote_cmd = f"sudo -n tar -cpf - -C / {shlex.quote(rel_path)} | {inner}"
    result = run_ssh_result(vm_conf, remote_cmd)
    if result.returncode != 0:
        raise CommandError(
            build_ssh_command(vm_conf, remote_cmd),
            result.returncode,
            result.stdout,
            result.stderr,
        )


def probe_remote_transfer(vm_conf: SSHConfig, ct_conf: SSHConfig) -> Optional[bool]:
    inner_args = build_inner_ssh_args(ct_conf, use_jump=False)
    inner = " ".join(shlex.quote(part) for part in inner_args + ["true"])
    result = run_ssh_result(vm_conf, inner)
    if result.returncode == 0:
        return False
    if not ct_conf.jump:
        return None
    inner_args = build_inner_ssh_args(ct_conf, use_jump=True)
    inner = " ".join(shlex.quote(part) for part in inner_args + ["true"])
    result = run_ssh_result(vm_conf, inner)
    if result.returncode == 0:
        return True
    return None


def stop_service(conf: SSHConfig, service: str) -> None:
    run_ssh(conf, f"sudo -n systemctl stop {shlex.quote(service)}", check=False)


def start_service(conf: SSHConfig, service: str) -> None:
    run_ssh(conf, f"sudo -n systemctl start {shlex.quote(service)}", check=False)


def compare_sizes(
    vm_conf: SSHConfig, ct_conf: SSHConfig, paths: Iterable[str]
) -> List[Dict[str, str]]:
    rows = []
    for path in paths:
        vm_exists, vm_size = get_path_size(vm_conf, path)
        ct_exists, ct_size = get_path_size(ct_conf, path)
        rows.append(
            {
                "path": path,
                "vm_exists": str(vm_exists),
                "ct_exists": str(ct_exists),
                "vm_size": format_bytes(vm_size),
                "ct_size": format_bytes(ct_size),
            }
        )
    return rows


@app.command()
def main(
    vm_target: Optional[str] = typer.Option(None, "--vm-target", help="VM user@host"),
    ct_target: Optional[str] = typer.Option(None, "--ct-target", help="CT user@host"),
    vm_user: Optional[str] = typer.Option(None, "--vm-user"),
    vm_host: Optional[str] = typer.Option(None, "--vm-host"),
    vm_jump: Optional[str] = typer.Option(None, "--vm-jump"),
    ct_user: Optional[str] = typer.Option(None, "--ct-user"),
    ct_host: Optional[str] = typer.Option(None, "--ct-host"),
    ct_jump: Optional[str] = typer.Option(None, "--ct-jump"),
    ssh_agent: Optional[bool] = typer.Option(
        None, "--ssh-agent/--no-ssh-agent", help="Enable SSH agent forwarding"
    ),
    known_hosts: Optional[Path] = typer.Option(
        None, "--known-hosts", help="Known hosts file to use for SSH"
    ),
    refresh_known_hosts: bool = typer.Option(
        True,
        "--refresh-known-hosts/--no-refresh-known-hosts",
        help="Clear known hosts file before connecting",
    ),
    ssh_strict: bool = typer.Option(
        False,
        "--ssh-strict/--no-ssh-strict",
        help="Enable strict host key checking (accept-new)",
    ),
    tailscale_owner: str = typer.Option(
        "ct",
        "--tailscale-owner",
        help="Which node should run tailscaled after copy: ct or vm",
    ),
    transfer_mode: str = typer.Option(
        "auto",
        "--transfer-mode",
        help="Transfer mode: auto, remote, or local",
    ),
    include_dir: List[str] = typer.Option(
        [], "--include-dir", help="Extra directory to copy from VM to CT (directory)"
    ),
    copy_etc: bool = typer.Option(False, "--copy-etc", help="Copy /etc as a whole"),
    yes: bool = typer.Option(False, "--yes", help="Proceed without prompting"),
    workdir: Path = typer.Option(Path.cwd(), "--workdir"),
) -> None:
    defaults = extract_ssh_defaults(workdir / "README.md")

    if vm_target:
        vm_user, vm_host = parse_user_host(vm_target)
    if ct_target:
        ct_user, ct_host = parse_user_host(ct_target)

    if not vm_user and defaults.get("vm", {}).get("user"):
        vm_user = defaults["vm"]["user"]
    if not vm_host and defaults.get("vm", {}).get("host"):
        vm_host = defaults["vm"]["host"]
    if not vm_jump and defaults.get("vm", {}).get("jump"):
        vm_jump = defaults["vm"]["jump"]

    if not ct_user and defaults.get("ct", {}).get("user"):
        ct_user = defaults["ct"]["user"]
    if not ct_host and defaults.get("ct", {}).get("host"):
        ct_host = defaults["ct"]["host"]
    if not ct_jump and defaults.get("ct", {}).get("jump"):
        ct_jump = defaults["ct"]["jump"]
    if ssh_agent is None:
        ssh_agent = any(
            defaults.get(role, {}).get("agent") == "True" for role in ("vm", "ct")
        )
    if known_hosts is None:
        known_hosts = workdir / ".migration_known_hosts"

    if not vm_user or not vm_host:
        typer.echo("VM connection details missing. Use --vm-target or --vm-user/--vm-host.")
        raise typer.Exit(code=1)
    if not ct_user or not ct_host:
        typer.echo("CT connection details missing. Use --ct-target or --ct-user/--ct-host.")
        raise typer.Exit(code=1)
    tailscale_owner = tailscale_owner.strip().lower()
    if tailscale_owner not in {"vm", "ct"}:
        typer.echo("Invalid --tailscale-owner value. Use 'vm' or 'ct'.")
        raise typer.Exit(code=1)
    transfer_mode = transfer_mode.strip().lower()
    if transfer_mode not in {"auto", "remote", "local"}:
        typer.echo("Invalid --transfer-mode value. Use auto, remote, or local.")
        raise typer.Exit(code=1)

    prepare_known_hosts(known_hosts, refresh_known_hosts)
    vm_conf = SSHConfig(
        user=vm_user,
        host=vm_host,
        jump=vm_jump,
        agent=ssh_agent,
        known_hosts=known_hosts,
        strict_host_key=ssh_strict,
    )
    ct_conf = SSHConfig(
        user=ct_user,
        host=ct_host,
        jump=ct_jump,
        agent=ssh_agent,
        known_hosts=known_hosts,
        strict_host_key=ssh_strict,
    )

    typer.echo("Collecting VM/CT data...")
    vm_hostnamectl = get_hostnamectl(vm_conf)
    ct_hostnamectl = get_hostnamectl(ct_conf)

    vm_packages = get_packages(vm_conf)
    ct_packages = get_packages(ct_conf)

    vm_users_raw = get_users(vm_conf)
    ct_users_raw = get_users(ct_conf)
    vm_regular = regular_users(vm_users_raw)
    ct_regular = regular_users(ct_users_raw)

    vm_usernames = {user["name"] for user in vm_regular}
    ct_usernames = {user["name"] for user in ct_regular}

    missing_in_ct = sorted(vm_usernames - ct_usernames)
    missing_in_vm = sorted(ct_usernames - vm_usernames)

    uid_mismatch = []
    home_mismatch = []
    ct_by_name = {user["name"]: user for user in ct_regular}
    for user in vm_regular:
        other = ct_by_name.get(user["name"])
        if not other:
            continue
        if user["uid"] != other["uid"]:
            uid_mismatch.append(f"{user['name']} ({user['uid']} != {other['uid']})")
        if user["home"] != other["home"]:
            home_mismatch.append(
                f"{user['name']} ({user['home']} != {other['home']})"
            )

    vm_only = sorted(set(vm_packages) - set(ct_packages))
    ct_only = sorted(set(ct_packages) - set(vm_packages))
    major_mismatch = []
    major_mismatch_details: Dict[str, Dict[str, str]] = {}
    for pkg in sorted(set(vm_packages) & set(ct_packages)):
        if major_version(vm_packages[pkg]) != major_version(ct_packages[pkg]):
            major_mismatch.append(pkg)
            major_mismatch_details[pkg] = {
                "vm": vm_packages[pkg],
                "ct": ct_packages[pkg],
            }

    service_names = ["tailscaled", "postgresql", "nginx"]
    service_status = {
        service: {
            "vm": get_service_status(vm_conf, service),
            "ct": get_service_status(ct_conf, service),
        }
        for service in service_names
    }

    postgres_data_dir = get_postgres_data_dir(vm_conf)

    stat_only_dirs = ["/etc", "/usr"]
    candidate_dirs = [
        "/etc/ssh",
        "/etc/echo",
        "/etc/nginx",
        "/etc/letsencrypt",
        "/var/lib/letsencrypt",
        "/var/www",
        "/var/lib/tailscale",
        "/usr/local",
        "/opt",
        "/srv",
        "/root",
    ]
    if postgres_data_dir:
        candidate_dirs.append(postgres_data_dir)
    else:
        candidate_dirs.append("/var/lib/postgresql")
    for user in vm_regular:
        candidate_dirs.append(user["home"])
    candidate_dirs.extend(include_dir)
    candidate_dirs = sorted({path for path in candidate_dirs if path})

    dir_rows = []
    copy_items = []
    warnings: List[str] = []
    if postgres_data_dir is None:
        warnings.append("PostgreSQL data directory not detected; using /var/lib/postgresql.")
    if major_mismatch:
        warnings.append("PostgreSQL or package major versions differ; review before copy.")
    warnings.append(
        f"tailscaled will only be started on {tailscale_owner} to avoid duplicate keys."
    )

    remote_jump_decision: Optional[bool] = None
    if transfer_mode in {"auto", "remote"}:
        remote_jump_decision = probe_remote_transfer(vm_conf, ct_conf)
        if remote_jump_decision is None:
            if transfer_mode == "remote":
                typer.echo("Remote transfer probe failed; cannot reach CT from VM.")
                raise typer.Exit(code=1)
            warnings.append("Remote transfer probe failed; will use local streaming.")
            transfer_mode = "local"
        else:
            transfer_mode = "remote"

    vm_nginx_config = get_nginx_config(vm_conf)
    ct_nginx_config = get_nginx_config(ct_conf)
    nginx_reports = {
        "vm": build_nginx_permission_report(vm_conf, vm_nginx_config),
        "ct": build_nginx_permission_report(ct_conf, ct_nginx_config),
    }
    vm_nginx_issues = nginx_reports["vm"].get("issues", []) if nginx_reports["vm"].get("available") else []
    ct_nginx_issues = nginx_reports["ct"].get("issues", []) if nginx_reports["ct"].get("available") else []
    if vm_nginx_issues or ct_nginx_issues:
        warnings.append("Nginx path traversal issues detected; see Nginx permission check.")

    for path in stat_only_dirs + candidate_dirs:
        vm_exists, vm_size = get_path_size(vm_conf, path)
        ct_exists, ct_size = get_path_size(ct_conf, path)
        copy_flag = "yes" if path in candidate_dirs and vm_exists else "no"
        if path in stat_only_dirs:
            copy_flag = "no"
        if copy_etc and path == "/etc":
            copy_flag = "yes"
            if path not in candidate_dirs:
                candidate_dirs.append(path)
        if copy_flag == "yes":
            copy_items.append(path)
        dir_rows.append(
            {
                "path": path,
                "vm_size": format_bytes(vm_size),
                "ct_size": format_bytes(ct_size),
                "copy": copy_flag,
            }
        )

    def dedupe_preserve_order(items: List[str]) -> List[str]:
        seen = set()
        unique = []
        for item in items:
            if item in seen:
                continue
            seen.add(item)
            unique.append(item)
        return unique

    copy_items = dedupe_preserve_order(copy_items)

    major_mismatch_sample = [
        f"{pkg} ({vm_packages[pkg]} vs {ct_packages[pkg]})"
        for pkg in major_mismatch[:25]
    ]
    package_diff = {
        "vm_only": vm_only,
        "ct_only": ct_only,
        "major_mismatch": major_mismatch,
        "major_mismatch_sample": major_mismatch_sample,
        "major_mismatch_details": major_mismatch_details,
        "vm_only_sample": vm_only[:25],
        "ct_only_sample": ct_only[:25],
    }
    user_diff = {
        "vm_users": sorted(vm_usernames),
        "ct_users": sorted(ct_usernames),
        "missing_in_ct": missing_in_ct,
        "missing_in_vm": missing_in_vm,
        "uid_mismatch": uid_mismatch,
        "home_mismatch": home_mismatch,
    }

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    plan_text = build_plan_text(
        timestamp=timestamp,
        vm_conf=vm_conf,
        ct_conf=ct_conf,
        vm_info={"hostnamectl": vm_hostnamectl},
        ct_info={"hostnamectl": ct_hostnamectl},
        package_diff=package_diff,
        user_diff=user_diff,
        service_status=service_status,
        dir_rows=dir_rows,
        copy_items=copy_items,
        warnings=warnings,
        tailscale_owner=tailscale_owner,
        transfer_mode=transfer_mode,
        nginx_reports=nginx_reports,
    )

    details = {
        "timestamp": timestamp,
        "vm": {"target": vm_conf.target, "jump": vm_conf.jump, "agent": vm_conf.agent},
        "ct": {"target": ct_conf.target, "jump": ct_conf.jump, "agent": ct_conf.agent},
        "packages": package_diff,
        "users": user_diff,
        "services": service_status,
        "directories": dir_rows,
        "copy_items": copy_items,
        "warnings": warnings,
        "tailscale_owner": tailscale_owner,
        "transfer_mode": transfer_mode,
        "nginx_permissions": nginx_reports,
    }

    plan_path, details_path = write_plan_files(workdir, timestamp, plan_text, details)
    typer.echo(f"Plan written to {plan_path}")
    typer.echo(f"Details written to {details_path}")

    if not yes:
        response = input("Proceed with migration copy? Type 'yes' to continue: ").strip()
        if response.lower() != "yes":
            typer.echo("No changes made.")
            raise typer.Exit(code=0)

    typer.echo("Stopping services...")
    for service in ["tailscaled", "postgresql"]:
        if service_status[service]["vm"] != "unknown":
            stop_service(vm_conf, service)
    for service in ["tailscaled", "postgresql", "nginx"]:
        if service_status[service]["ct"] != "unknown":
            stop_service(ct_conf, service)

    typer.echo(f"Copying data (mode: {transfer_mode})...")
    for path in copy_items:
        ensure_dir_exists(ct_conf, path)
        typer.echo(f"- Copying {path}")
        if transfer_mode == "remote":
            if remote_jump_decision is None:
                raise typer.Exit(code=1)
            stream_copy_path_remote(vm_conf, ct_conf, path, remote_jump_decision)
        else:
            stream_copy_path_local(vm_conf, ct_conf, path)

    typer.echo("Starting services...")
    if service_status["postgresql"]["vm"] != "unknown":
        start_service(vm_conf, "postgresql")
    if service_status["postgresql"]["ct"] != "unknown":
        start_service(ct_conf, "postgresql")
    if service_status["nginx"]["ct"] != "unknown":
        start_service(ct_conf, "nginx")

    if tailscale_owner == "vm":
        if service_status["tailscaled"]["vm"] != "unknown":
            start_service(vm_conf, "tailscaled")
    else:
        if service_status["tailscaled"]["ct"] != "unknown":
            start_service(ct_conf, "tailscaled")
    if "/etc/ssh" in copy_items:
        start_service(ct_conf, "ssh")

    typer.echo("Comparing sizes after copy...")
    post_rows = compare_sizes(vm_conf, ct_conf, copy_items)
    post_nginx_config = get_nginx_config(ct_conf)
    post_nginx_report = build_nginx_permission_report(ct_conf, post_nginx_config)
    results_path = workdir / f"migration_results_{timestamp}.md"
    results_lines = ["Post-copy size comparison", f"Generated: {timestamp}", ""]
    results_lines.append("path | vm_size | ct_size")
    for row in post_rows:
        results_lines.append(f"{row['path']} | {row['vm_size']} | {row['ct_size']}")
    results_lines.append("")
    results_lines.append("Post-copy nginx permission check:")
    if post_nginx_report.get("available"):
        results_lines.append(f"- nginx user: {post_nginx_report.get('user')}")
        results_lines.append(f"- paths: {len(post_nginx_report.get('paths', []))}")
        issues = post_nginx_report.get("issues", [])
        results_lines.append(f"- issues: {len(issues)}")
        for issue in issues[:20]:
            if issue.get("issue") == "missing":
                results_lines.append(f"  - missing: {issue.get('path')}")
            else:
                stat = issue.get("stat", "")
                results_lines.append(
                    f"  - no-traverse: {issue.get('parent')} (for {issue.get('path')}) {stat}"
                )
    else:
        results_lines.append(f"- skipped: {post_nginx_report.get('reason')}")
    results_path.write_text("\n".join(results_lines))
    typer.echo(f"Results written to {results_path}")


if __name__ == "__main__":
    app()
