#!/usr/bin/env python3
"""Package, download, and publish documentation media in Echo S3 destinations."""

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


REPOSITORY = Path(__file__).resolve().parents[1]
EXTENSIONS = "mp4 webm jpg jpeg png mp3 gif svg ico"
SOURCE_ROOTS = ("docs/releases", "docs/static")


def media_files(repository, only, extensions):
    roots = [Path(only)] if only else [repository / root for root in SOURCE_ROOTS]
    selected = {}
    for root in roots:
        root = root if root.is_absolute() else repository / root
        root = root.resolve()
        if not root.is_relative_to(repository) or not root.is_dir():
            raise ValueError("media directory must exist inside the repository")
        for path in sorted(root.rglob("*")):
            if path.suffix.lower().lstrip(".") not in extensions or not path.is_file():
                continue
            if path.is_symlink() or not path.resolve().is_relative_to(root):
                raise ValueError("media symlinks are not supported")
            relative = path.relative_to(repository).as_posix()
            if any(character in relative for character in "\n\r\0\\*?["):
                raise ValueError("media paths must not contain control characters, backslashes or glob patterns")
            with path.open("rb") as source:
                if source.read(128).startswith(b"version https://git-lfs.github.com/spec/v1"):
                    raise ValueError(f"unresolved Git LFS pointer: {relative}")
            selected[relative] = path
    return selected


def server_config(server, config_directory):
    if config_directory:
        source = (Path(config_directory) / f"{server}.toml").read_text()
    else:
        result = subprocess.run(
            ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", server,
             "cat /etc/echo/config.toml"], capture_output=True, text=True, timeout=30,
        )
        if result.returncode:
            raise ValueError(f"{server}: could not read existing server configuration")
        source = result.stdout
    result = subprocess.run(
        ["tq", "--output", "json", "s3_config"], input=source,
        capture_output=True, text=True, check=False,
    )
    if result.returncode:
        raise ValueError(f"{server}: could not parse S3 configuration")
    config = json.loads(result.stdout)
    required = ("s3_bucket", "s3_endpoint", "s3_region", "s3_access_key_id", "s3_secret_access_key")
    if not isinstance(config, dict) or any(not config.get(key) for key in required):
        raise ValueError(f"{server}: incomplete S3 configuration")
    return config


def s5cmd(config, *arguments):
    environment = os.environ.copy()
    environment.update(
        AWS_ACCESS_KEY_ID=config["s3_access_key_id"],
        AWS_SECRET_ACCESS_KEY=config["s3_secret_access_key"],
        AWS_REGION=config["s3_region"],
    )
    environment.pop("AWS_SESSION_TOKEN", None)
    return subprocess.run(
        ["s5cmd", "--endpoint-url", config["s3_endpoint"], *arguments],
        env=environment, capture_output=True, text=True, timeout=900,
    )


def existing_keys(server, config, destination):
    result = s5cmd(config, "--json", "ls", destination + "*")
    if result.returncode:
        try:
            errors = [json.loads(line) for line in result.stderr.splitlines() if line.strip()]
        except ValueError:
            errors = []
        empty = (
            result.returncode == 1 and not result.stdout.strip() and len(errors) == 1
            and isinstance(errors[0], dict)
            and errors[0].get("operation") == "ls"
            and errors[0].get("error") == "no object found"
        )
        if empty:
            return set()
        raise ValueError(f"{server}: could not list documentation media")
    keys = set()
    for line in result.stdout.splitlines():
        entry = json.loads(line)
        key = entry.get("key") if isinstance(entry, dict) else None
        if not isinstance(key, str) or not key.startswith(destination):
            raise ValueError(f"{server}: invalid documentation media listing")
        keys.add(key)
    return keys


def upload_server(server, config, files, force):
    destination = f"s3://{config['s3_bucket'].rstrip('/')}/doc-media/"
    existing = set() if force else existing_keys(server, config, destination)
    uploaded = skipped = failed = 0
    for relative, source in files.items():
        remote = destination + relative
        if remote in existing:
            skipped += 1
            continue
        result = s5cmd(config, "cp", str(source), remote)
        if result.returncode:
            failed += 1
            print(f"{server}: upload failed: {relative}", file=sys.stderr)
        else:
            uploaded += 1
    print(f"{server}: selected={len(files)} uploaded={uploaded} skipped={skipped} failed={failed}")
    return failed == 0


def release(arguments):
    for command in ("ssh", "tq", "s5cmd"):
        if not shutil.which(command):
            raise ValueError(f"required command is missing: {command}")
    files = media_files(REPOSITORY, arguments.only, arguments.extensions.split())
    if not files:
        raise ValueError("no documentation media selected")
    servers = list(dict.fromkeys(arguments.servers.split()))
    if not servers or any(not server or server.startswith("-") or "/" in server for server in servers):
        raise ValueError("invalid or empty server inventory")
    configurations = {server: server_config(server, arguments.config_dir) for server in servers}
    failed = []
    for server, config in configurations.items():
        try:
            succeeded = upload_server(server, config, files, arguments.force)
        except (ValueError, subprocess.TimeoutExpired):
            print(f"{server}: documentation upload failed", file=sys.stderr)
            succeeded = False
        if not succeeded:
            failed.append(server)
    print(f"Servers: succeeded={len(servers) - len(failed)} failed={len(failed)}")
    if failed:
        raise ValueError("incomplete destinations: " + ", ".join(failed))


def download_roots(only):
    if not only:
        return SOURCE_ROOTS
    root = Path(only)
    root = root if root.is_absolute() else REPOSITORY / root
    if not root.resolve().is_relative_to(REPOSITORY):
        raise ValueError("media directory must be inside the repository")
    relative = root.resolve().relative_to(REPOSITORY).as_posix()
    if not any(relative == source or relative.startswith(source + "/") for source in SOURCE_ROOTS):
        raise ValueError("download directory must be inside docs/releases or docs/static")
    if any(character in relative for character in "\n\r\0\\*?["):
        raise ValueError("invalid media directory")
    return (relative,)


def download_destination(relative):
    if any(part in ("", ".", "..") for part in relative.split("/")) or any(
        character in relative for character in "\n\r\0\\*?["
    ):
        raise ValueError("invalid documentation media path")
    destination = REPOSITORY / relative
    if destination.is_symlink() or destination.resolve() != destination:
        raise ValueError("media symlinks are not supported")
    return destination


def download_file(config, remote, destination, force):
    if destination.exists() and not force:
        return False
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".doc-media-", dir=destination.parent) as directory:
        temporary = Path(directory) / destination.name
        result = s5cmd(config, "cp", remote, str(temporary))
        if result.returncode:
            raise ValueError("media download failed")
        if force:
            temporary.replace(destination)
        else:
            try:
                os.link(temporary, destination)
            except FileExistsError:
                return False
    return True


def download(arguments):
    for command in ("ssh", "tq", "s5cmd"):
        if not shutil.which(command):
            raise ValueError(f"required command is missing: {command}")
    server = arguments.server
    if not server or server.startswith("-") or any(character in server for character in "/\\\n\r\0"):
        raise ValueError("invalid or empty source server")
    roots = download_roots(arguments.only)
    config = server_config(server, arguments.config_dir)
    source = f"s3://{config['s3_bucket'].rstrip('/')}/doc-media/"
    files = {}
    for root in roots:
        for remote in sorted(existing_keys(server, config, source + root + "/")):
            relative = remote.removeprefix(source)
            if Path(relative).suffix.lower().lstrip(".") in EXTENSIONS.split():
                files[relative] = download_destination(relative)
    if not files:
        raise ValueError("no documentation media selected")
    downloaded = skipped = failed = 0
    for relative, destination in files.items():
        try:
            if download_file(config, source + relative, destination, arguments.force):
                downloaded += 1
            else:
                skipped += 1
        except (ValueError, OSError, subprocess.TimeoutExpired):
            failed += 1
            print(f"{server}: download failed: {relative}", file=sys.stderr)
    print(f"{server}: selected={len(files)} downloaded={downloaded} skipped={skipped} failed={failed}")
    if failed:
        raise ValueError("incomplete downloads")


def prepare(arguments):
    files = media_files(REPOSITORY, None, EXTENSIONS.split())
    roots = [Path(arguments.cache)]
    if arguments.dist:
        roots.append(Path(arguments.dist) / "doc-media")
    for relative, source in files.items():
        for root in roots:
            destination = root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)
        if arguments.dist and relative.startswith("docs/releases/"):
            old = Path(arguments.dist) / relative.removeprefix("docs/")
            if not old.resolve().is_relative_to(Path(arguments.dist).resolve()):
                raise ValueError("frontend release output must not link to source media")
            if old.is_file():
                old.unlink()
        if arguments.docs_public and relative.startswith("docs/static/") and source.name != "icon.png":
            old = Path(arguments.docs_public) / relative.removeprefix("docs/static/")
            if old.is_file():
                old.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    publish = commands.add_parser("release")
    publish.add_argument("--servers", required=True)
    publish.add_argument("--extensions", default=EXTENSIONS)
    publish.add_argument("--only")
    publish.add_argument("--force", action="store_true")
    publish.add_argument("--config-dir", default=os.environ.get("DOC_MEDIA_CONFIG_DIR"))
    publish.set_defaults(run=release)
    fetch = commands.add_parser("download")
    fetch.add_argument("--server", required=True)
    fetch.add_argument("--only")
    fetch.add_argument("--force", action="store_true")
    fetch.add_argument("--config-dir", default=os.environ.get("DOC_MEDIA_CONFIG_DIR"))
    fetch.set_defaults(run=download)
    package = commands.add_parser("prepare")
    package.add_argument("--dist")
    package.add_argument("--docs-public")
    package.add_argument("--cache", default=str(REPOSITORY / "wdintel-web/.doc-media"))
    package.set_defaults(run=prepare)
    arguments = parser.parse_args()
    try:
        arguments.run(arguments)
    except (ValueError, OSError, subprocess.TimeoutExpired) as error:
        print(f"doc-media: {error if isinstance(error, ValueError) else 'operation failed'}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
