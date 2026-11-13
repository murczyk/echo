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
UPLOAD_ENDPOINT = "https://s3.eu-central-003.backblazeb2.com"
UPLOAD_REGION = "eu-central-003"
UPLOAD_BUCKETS = ("echouastaging", "echouastoragecbr", "echouastorage")


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


def existing_keys(bucket, config, destination):
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
        raise ValueError(f"{bucket}: could not list documentation media")
    keys = set()
    for line in result.stdout.splitlines():
        entry = json.loads(line)
        key = entry.get("key") if isinstance(entry, dict) else None
        if not isinstance(key, str) or not key.startswith(destination):
            raise ValueError(f"{bucket}: invalid documentation media listing")
        keys.add(key)
    return keys


def upload_bucket(bucket, config, files, force):
    destination = f"s3://{config['s3_bucket'].rstrip('/')}/doc-media/"
    existing = set() if force else existing_keys(bucket, config, destination)
    uploaded = skipped = failed = 0
    for relative, source in files.items():
        remote = destination + relative
        if remote in existing:
            skipped += 1
            continue
        result = s5cmd(config, "cp", str(source), remote)
        if result.returncode:
            failed += 1
            print(f"{bucket}: upload failed: {relative}", file=sys.stderr)
        else:
            uploaded += 1
    print(f"{bucket}: selected={len(files)} uploaded={uploaded} skipped={skipped} failed={failed}")
    return failed == 0


def bucket_configuration(bucket):
    access_key = os.environ.get("AWS_ACCESS_KEY_ID")
    secret_key = os.environ.get("AWS_SECRET_ACCESS_KEY")
    if not access_key or not secret_key:
        raise ValueError(
            "AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required. "
            f"Look for '{bucket}-lfs backblaze' in Bitwarden, as in goi/justfile."
        )
    return {
        "s3_bucket": bucket,
        "s3_endpoint": UPLOAD_ENDPOINT,
        "s3_region": UPLOAD_REGION,
        "s3_access_key_id": access_key,
        "s3_secret_access_key": secret_key,
    }


def release(arguments):
    config = bucket_configuration(arguments.bucket)
    if not shutil.which("s5cmd"):
        raise ValueError("required command is missing: s5cmd")
    files = media_files(REPOSITORY, arguments.only, arguments.extensions.split())
    if not files:
        raise ValueError("no documentation media selected")
    if not upload_bucket(arguments.bucket, config, files, arguments.force):
        raise ValueError(f"incomplete destination: {arguments.bucket}")


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
    if not shutil.which("s5cmd"):
        raise ValueError("required command is missing: s5cmd")
    bucket = arguments.bucket
    roots = download_roots(arguments.only)
    config = bucket_configuration(bucket)
    source = f"s3://{config['s3_bucket'].rstrip('/')}/doc-media/"
    files = {}
    for root in roots:
        for remote in sorted(existing_keys(bucket, config, source + root + "/")):
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
            print(f"{bucket}: download failed: {relative}", file=sys.stderr)
    print(f"{bucket}: selected={len(files)} downloaded={downloaded} skipped={skipped} failed={failed}")
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
    publish.add_argument("--extensions", default=EXTENSIONS)
    publish.add_argument("--only")
    publish.add_argument("--force", action="store_true")
    publish.set_defaults(run=release)
    fetch = commands.add_parser("download")
    fetch.add_argument("--only")
    fetch.add_argument("--force", action="store_true")
    fetch.set_defaults(run=download)
    for command in (publish, fetch):
        command.add_argument("--bucket", required=True, choices=UPLOAD_BUCKETS)
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
    finally:
        if arguments.command == "release":
            print("Reminder: upload documentation media to all three buckets: " + ", ".join(UPLOAD_BUCKETS))
    return 0


if __name__ == "__main__":
    sys.exit(main())
