#!/usr/bin/env python3
"""#3938 regressions for documentation media transfers and packaging."""

import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest
from urllib.parse import unquote

from doc_media import EXTENSIONS

REPOSITORY = Path(__file__).resolve().parents[1]


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="doc-media-3938-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.sources = tempfile.TemporaryDirectory(prefix="doc media 3938 ", dir=REPOSITORY / "docs/static")
        self.addCleanup(self.sources.cleanup)
        self.source = Path(self.sources.name)
        (self.source / "ланцюжки.mp4").write_bytes(b"original")
        (self.source / "picture.PNG").write_bytes(b"image")
        (self.source / "release.md").write_text("not media")
        self.configs = self.root / "configs"
        self.configs.mkdir()
        for server in ("echo-a", "echo-b"):
            config = {
                "s3_bucket": server,
                "s3_endpoint": "http://127.0.0.1:1",
                "s3_region": "local",
                "s3_access_key_id": server,
                "s3_secret_access_key": "fixture",
            }
            (self.configs / f"{server}.toml").write_text("[s3_config]\n" + "\n".join(
                f"{key} = {json.dumps(value)}" for key, value in config.items()
            ))
        binary = self.root / "s5cmd"
        binary.write_text('''#!/usr/bin/env python3
import json, os, pathlib, shutil, sys
root = pathlib.Path(os.environ["DOC_MEDIA_FAKE_STORAGE"])
args = sys.argv[3:]
if args[0] == "--json": args = args[1:]
remote = args[-2] if args[0] == "cp" and args[-2].startswith("s3://") else args[-1]
bucket, key = remote.removeprefix("s3://").split("/", 1)
if os.environ["AWS_ACCESS_KEY_ID"] != bucket or bucket == os.environ.get("DOC_MEDIA_FAIL_SERVER"):
    sys.exit(1)
if args[0] == "ls":
    base = root / bucket / key.removesuffix("*")
    paths = [path for path in sorted(base.rglob("*")) if path.is_file()]
    if not paths:
        print(json.dumps({"operation": "ls", "error": "no object found"}), file=sys.stderr)
        sys.exit(1)
    for path in paths:
        print(json.dumps({"key": "s3://" + path.relative_to(root).as_posix()}))
    if os.environ.get("DOC_MEDIA_EXTRA_KEY"):
        print(json.dumps({"key": os.environ["DOC_MEDIA_EXTRA_KEY"]}))
elif args[-2].startswith("s3://"):
    bucket, key = args[-2].removeprefix("s3://").split("/", 1)
    destination = pathlib.Path(args[-1])
    if os.environ.get("DOC_MEDIA_FAIL_DOWNLOAD"):
        destination.write_bytes(b"partial")
        sys.exit(1)
    shutil.copyfile(root / bucket / key, destination)
else:
    destination = root / bucket / key
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(args[-2], destination)
    with (root / "uploads").open("a") as log: log.write(remote + "\\n")
''')
        binary.chmod(0o755)
        self.environment = os.environ | {
            "PATH": str(self.root) + os.pathsep + os.environ["PATH"],
            "DOC_MEDIA_CONFIG_DIR": str(self.configs),
            "DOC_MEDIA_FAKE_STORAGE": str(self.root),
        }

    def publish(self, *arguments):
        return subprocess.run([
            "just", "--justfile", str(REPOSITORY / "justfile"),
            "--set", "active_servers", "echo-a echo-b echo-a", "release-doc-media",
            "--only", str(self.source), *arguments,
        ], env=self.environment, capture_output=True, text=True)

    def stored(self, server, filename):
        return self.root / server / "doc-media" / self.source.relative_to(REPOSITORY) / filename

    def download(self, *arguments):
        checkout = self.root / "checkout"
        if not (checkout / "justfile").exists():
            (checkout / "deploy").mkdir(parents=True, exist_ok=True)
            shutil.copyfile(REPOSITORY / "justfile", checkout / "justfile")
            shutil.copyfile(REPOSITORY / "deploy/doc_media.py", checkout / "deploy/doc_media.py")
        return subprocess.run([
            "just", "--justfile", str(checkout / "justfile"), "download-doc-media",
            "--server", "echo-a", *arguments,
        ], env=self.environment, capture_output=True, text=True)

    def downloaded(self, filename):
        return self.root / "checkout" / self.source.relative_to(REPOSITORY) / filename

    def test_download_restores_both_roots_without_overwriting_local_edits(self):
        result = self.publish()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        release = self.root / "echo-a/doc-media/docs/releases/2099-01-01/media/відео з пробілом.mp4"
        release.parent.mkdir(parents=True)
        release.write_bytes(b"release video")
        release.with_suffix(".md").write_text("not media")
        uploads = (self.root / "uploads").read_text()
        result = self.download()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        local = self.downloaded("ланцюжки.mp4")
        self.assertEqual(local.read_bytes(), b"original")
        self.assertEqual(self.downloaded("picture.PNG").read_bytes(), b"image")
        self.assertEqual((self.root / "checkout/docs/releases/2099-01-01/media/відео з пробілом.mp4").read_bytes(), b"release video")
        self.assertFalse((self.root / "checkout/docs/releases/2099-01-01/media/відео з пробілом.md").exists())
        local.write_bytes(b"local edits")
        result = self.download()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(local.read_bytes(), b"local edits")
        self.assertIn("downloaded=0 skipped=3 failed=0", result.stdout)
        self.assertEqual((self.root / "uploads").read_text(), uploads)

    def test_download_force_replaces_only_the_selected_directory(self):
        result = self.publish()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        only = self.source.relative_to(REPOSITORY).as_posix()
        result = self.download("--only", only)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        local = self.downloaded("ланцюжки.mp4")
        local.write_bytes(b"local edits")
        sibling = self.root / "echo-a/doc-media/docs/static/other/clip.mp4"
        sibling.parent.mkdir(parents=True)
        sibling.write_bytes(b"other")
        result = self.download("--only", only, "--force")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(local.read_bytes(), b"original")
        self.assertFalse((self.root / "checkout/docs/static/other").exists())

    def test_failed_download_does_not_replace_edits_or_leave_partial_files(self):
        result = self.publish()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        local = self.downloaded("ланцюжки.mp4")
        local.parent.mkdir(parents=True)
        local.write_bytes(b"local edits")
        self.environment["DOC_MEDIA_FAIL_DOWNLOAD"] = "1"
        result = self.download("--force")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("failed=2", result.stdout)
        self.assertEqual(local.read_bytes(), b"local edits")
        self.assertFalse(self.downloaded("picture.PNG").exists())
        self.assertFalse(list(local.parent.glob(".doc-media-*")))

    def test_download_rejects_unsafe_remote_paths_before_writing_files(self):
        result = self.publish()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for relative in ("../../escaped.mp4", "nested/../../../escaped.mp4", r"invalid\name.mp4"):
            with self.subTest(relative=relative):
                self.environment["DOC_MEDIA_EXTRA_KEY"] = "s3://echo-a/doc-media/docs/static/" + relative
                result = self.download("--only", "docs/static")
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(self.downloaded("ланцюжки.mp4").exists())
        del self.environment["DOC_MEDIA_EXTRA_KEY"]
        destination = self.downloaded("ланцюжки.mp4")
        destination.parent.mkdir(parents=True)
        destination.symlink_to(self.source / "ланцюжки.mp4")
        result = self.download("--force")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("symlinks", result.stderr)
        self.assertEqual((self.source / "ланцюжки.mp4").read_bytes(), b"original")

    def test_each_destination_is_independent_and_force_and_only_apply_to_all(self):
        existing = self.stored("echo-a", "ланцюжки.mp4")
        existing.parent.mkdir(parents=True)
        existing.write_bytes(b"keep this different-sized copy")
        result = self.publish()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(existing.read_bytes(), b"keep this different-sized copy")
        self.assertEqual(self.stored("echo-b", "ланцюжки.mp4").read_bytes(), b"original")
        self.assertEqual(len((self.root / "uploads").read_text().splitlines()), 3)
        for server in ("echo-a", "echo-b"):
            self.assertFalse(self.stored(server, "release.md").exists())
        result = self.publish("--force")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(existing.read_bytes(), b"original")
        self.assertEqual(len((self.root / "uploads").read_text().splitlines()), 7)

    def test_a_failed_destination_is_reported_without_suppressing_the_next(self):
        self.environment["DOC_MEDIA_FAIL_SERVER"] = "echo-a"
        result = self.publish()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("incomplete destinations: echo-a", result.stderr)
        self.assertEqual(self.stored("echo-b", "ланцюжки.mp4").read_bytes(), b"original")

    def test_shared_buckets_use_the_configured_destination_without_inventing_namespaces(self):
        (self.configs / "echo-b.toml").write_text((self.configs / "echo-a.toml").read_text())
        result = self.publish()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("echo-b: selected=2 uploaded=0 skipped=2 failed=0", result.stdout)
        self.assertEqual(len((self.root / "uploads").read_text().splitlines()), 2)
        self.assertFalse((self.root / "echo-b").exists())
        result = self.publish("--force")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("echo-b: selected=2 uploaded=2 skipped=0 failed=0", result.stdout)
        self.assertEqual(len((self.root / "uploads").read_text().splitlines()), 6)

    def test_missing_configuration_and_lfs_pointers_fail_before_any_upload(self):
        config = self.configs / "echo-b.toml"
        config.unlink()
        result = self.publish()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / "uploads").exists())
        (self.source / "ланцюжки.mp4").write_text("version https://git-lfs.github.com/spec/v1\n")
        result = self.publish()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unresolved Git LFS pointer", result.stderr)
        self.assertFalse((self.root / "uploads").exists())

    def test_backslashes_in_media_paths_fail_before_any_upload(self):
        for relative in (r"invalid\name.mp4", r"invalid\directory/clip.mp4"):
            source = self.source / relative
            source.parent.mkdir(parents=True, exist_ok=True)
            source.write_bytes(b"media")
            for arguments in ((), ("--force",)):
                with self.subTest(relative=relative, arguments=arguments):
                    result = self.publish(*arguments)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("backslashes", result.stderr)
                    self.assertFalse((self.root / "uploads").exists())
            source.unlink()


@unittest.skipUnless(shutil.which("zola"), "Zola is required to build documentation")
class DocumentationBuildTests(unittest.TestCase):
    def test_issue_3938_rebuilds_all_image_and_video_urls_without_public_media_copies(self):
        for include_media in (False, True):
            with self.subTest(include_media=include_media):
                self.check_documentation_build(include_media)

    def check_documentation_build(self, include_media):
        with tempfile.TemporaryDirectory(prefix="doc-media-build-3938-") as directory:
            repository = Path(directory)
            shutil.copyfile(REPOSITORY / "justfile", repository / "justfile")
            (repository / "deploy").mkdir()
            shutil.copyfile(REPOSITORY / "deploy/doc_media.py", repository / "deploy/doc_media.py")
            docs = repository / "docs"
            docs.mkdir()
            shutil.copyfile(REPOSITORY / "docs/config.toml", docs / "config.toml")
            for name in ("content", "templates", "themes"):
                shutil.copytree(REPOSITORY / "docs" / name, docs / name)
            shutil.copytree(REPOSITORY / "docs/static", docs / "static", ignore=lambda directory, names: [
                name for name in names if name != "icon.png"
                and Path(name).suffix.lower().lstrip(".") in EXTENSIONS.split()
            ])
            if include_media:
                for page in (docs / "content").rglob("*.md"):
                    for relative in re.findall(r'\{\{\s*(?:img|video)\(id="([^"]+)"', page.read_text()):
                        source = docs / "static" / relative
                        source.parent.mkdir(parents=True, exist_ok=True)
                        source.write_bytes(b"media fixture")
            (docs / "releases").mkdir()
            public = docs / "public"
            (public / "overview").mkdir(parents=True)
            (public / "overview/index.html").write_text('<video src="/docs/overview.mp4"></video>')

            result = subprocess.run([
                "just", "--justfile", str(repository / "justfile"), "docs",
            ], cwd=repository, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

            media_types = set()
            for page in public.rglob("*.html"):
                for kind, url in re.findall(r'<(img|video)\b[^>]*\bsrc="([^"]+)"', page.read_text()):
                    with self.subTest(page=page.relative_to(public), url=url):
                        self.assertTrue(url.startswith("/doc-media/docs/static/"))
                        relative = Path(unquote(url.removeprefix("/doc-media/")))
                        self.assertEqual((repository / "wdintel-web/.doc-media" / relative).is_file(), include_media)
                        self.assertFalse((public / relative.relative_to("docs/static")).exists())
                        media_types.add(kind)
            self.assertEqual(media_types, {"img", "video"})
            overview = unquote((public / "overview/index.html").read_text())
            self.assertIn('/doc-media/docs/static/overview.mp4', overview)
            self.assertIn('/doc-media/docs/static/overview_mar2026.mp4', overview)
            self.assertTrue((public / "icon.png").is_file())
            self.assertTrue((public / "css/custom.css").is_file())


if __name__ == "__main__":
    unittest.main()
