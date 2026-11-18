#!/usr/bin/env python3
"""#3938 regressions for documentation media transfers and packaging."""

import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tempfile
import unittest
from urllib.parse import unquote

from doc_media import EXTENSIONS, UPLOAD_BUCKETS

REPOSITORY = Path(__file__).resolve().parents[1]


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="doc-media-3938-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.checkout = self.root / "upload-checkout"
        self.download_checkout = self.root / "checkout"
        for checkout in (self.checkout, self.download_checkout):
            self.prepare_checkout(checkout)
        self.source = self.checkout / "docs/static/doc media 3938"
        self.source.mkdir(parents=True)
        (self.source / "ланцюжки.mp4").write_bytes(b"original")
        (self.source / "picture.PNG").write_bytes(b"image")
        (self.source / "release.md").write_text("not media")
        self.buckets = dict(zip(("echo-a", "echo-b", "echo-c"), UPLOAD_BUCKETS))
        binary = self.root / "s5cmd"
        binary.write_text('''#!/usr/bin/env python3
import json, os, pathlib, shutil, sys
root = pathlib.Path(os.environ["DOC_MEDIA_FAKE_STORAGE"])
with (root / "operations").open("a") as log: log.write(json.dumps(sys.argv[1:]) + "\\n")
args = sys.argv[3:]
if args[0] == "--json": args = args[1:]
remote = args[-2] if args[0] == "cp" and args[-2].startswith("s3://") else args[-1]
bucket, key = remote.removeprefix("s3://").split("/", 1)
if (os.environ["AWS_ACCESS_KEY_ID"] != bucket
    or os.environ["AWS_SECRET_ACCESS_KEY"] != "fixture-" + bucket
    or bucket == os.environ.get("DOC_MEDIA_FAIL_SERVER")):
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
            "AWS_ACCESS_KEY_ID": "wrong-ambient-key",
            "AWS_SECRET_ACCESS_KEY": "wrong-ambient-secret",
            "DOC_MEDIA_FAKE_STORAGE": str(self.root),
        }
        self.credentials = {
            f"{bucket.upper()}_DOCS_AWS_{field}": value
            for bucket in UPLOAD_BUCKETS
            for field, value in (("ACCESS_KEY_ID", bucket), ("SECRET_ACCESS_KEY", f"fixture-{bucket}"))
        }
        self.environment.update(self.credentials)
        self.write_credentials(self.credentials)

    def prepare_checkout(self, checkout):
        (checkout / "deploy").mkdir(parents=True)
        shutil.copyfile(REPOSITORY / "justfile", checkout / "justfile")
        shutil.copyfile(REPOSITORY / "deploy/doc_media.py", checkout / "deploy/doc_media.py")

    def write_credentials(self, credentials):
        for checkout in (self.checkout, self.download_checkout):
            (checkout / ".env").write_text("".join(
                f"{key}={shlex.quote(value)}\n" for key, value in credentials.items()
            ))

    def publish(self, *arguments, bucket=UPLOAD_BUCKETS[0]):
        command = [
            "just", "--justfile", str(self.checkout / "justfile"),
            "release-doc-media", "--only", str(self.source),
        ]
        if bucket is not None:
            command.extend(["--bucket", bucket])
        return subprocess.run(command + list(arguments), env=self.environment, capture_output=True, text=True)

    def stored(self, server, filename):
        return self.root / self.buckets[server] / "doc-media" / self.source.relative_to(self.checkout) / filename

    def download(self, *arguments, bucket=UPLOAD_BUCKETS[0]):
        command = [
            "just", "--justfile", str(self.download_checkout / "justfile"), "download-doc-media",
        ]
        if bucket is not None:
            command.extend(["--bucket", bucket])
        return subprocess.run(command + list(arguments), env=self.environment, capture_output=True, text=True)

    def downloaded(self, filename):
        return self.download_checkout / self.source.relative_to(self.checkout) / filename

    def test_transfers_reject_unknown_buckets_and_download_requires_a_bucket(self):
        for transfer in (self.publish, self.download):
            for bucket in (("unknown-bucket",) if transfer == self.publish else (None, "", "unknown-bucket")):
                with self.subTest(command=transfer.__name__, bucket=bucket):
                    result = transfer(bucket=bucket)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("error:", result.stderr)
                    for available in UPLOAD_BUCKETS:
                        self.assertIn(available, result.stderr)
                    self.assertFalse((self.root / "operations").exists())
                    self.assertFalse((self.root / "checkout/docs").exists())

    def test_download_uses_only_the_selected_buckets_credentials_and_objects(self):
        bucket = self.buckets["echo-b"]
        self.write_credentials({
            key: value for key, value in self.credentials.items()
            if key.startswith(f"{bucket.upper()}_DOCS_AWS_")
        })
        result = self.publish(bucket=bucket)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.stored("echo-b", "ланцюжки.mp4").write_bytes(b"selected bucket")
        result = self.download(bucket=bucket)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.downloaded("ланцюжки.mp4").read_bytes(), b"selected bucket")

    def test_download_restores_both_roots_without_overwriting_local_edits(self):
        result = self.publish()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        release = self.root / self.buckets["echo-a"] / "doc-media/docs/releases/2099-01-01/media/відео з пробілом.mp4"
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
        only = self.source.relative_to(self.checkout).as_posix()
        result = self.download("--only", only)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        local = self.downloaded("ланцюжки.mp4")
        local.write_bytes(b"local edits")
        sibling = self.root / self.buckets["echo-a"] / "doc-media/docs/static/other/clip.mp4"
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
                self.environment["DOC_MEDIA_EXTRA_KEY"] = f"s3://{self.buckets['echo-a']}/doc-media/docs/static/" + relative
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

    def test_force_and_only_apply_to_the_selected_bucket(self):
        existing = self.stored("echo-a", "ланцюжки.mp4")
        existing.parent.mkdir(parents=True)
        existing.write_bytes(b"keep this different-sized copy")
        result = self.publish()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(existing.read_bytes(), b"keep this different-sized copy")
        self.assertEqual(len((self.root / "uploads").read_text().splitlines()), 1)
        for server in self.buckets:
            if server != "echo-a":
                self.assertFalse(self.stored(server, "ланцюжки.mp4").exists())
            self.assertFalse(self.stored(server, "release.md").exists())
        result = self.publish("--force")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(existing.read_bytes(), b"original")
        self.assertEqual(len((self.root / "uploads").read_text().splitlines()), 3)

    def test_a_failed_bucket_is_reported_and_others_can_be_uploaded_separately(self):
        self.environment["DOC_MEDIA_FAIL_SERVER"] = self.buckets["echo-a"]
        result = self.publish("--force")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(f"incomplete destination: {self.buckets['echo-a']}", result.stderr)
        self.assertFalse((self.root / "uploads").exists())
        result = self.publish(bucket=self.buckets["echo-b"])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.stored("echo-b", "ланцюжки.mp4").read_bytes(), b"original")
        self.assertFalse(self.stored("echo-c", "ланцюжки.mp4").exists())

    def test_uploads_all_buckets_in_order_with_their_own_credentials(self):
        expected = []
        for force in (False, True):
            with self.subTest(force=force):
                result = self.publish(*(["--force"] if force else []), bucket=None)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                expected.extend(
                    f"s3://{bucket}/doc-media/{self.source.relative_to(self.checkout)}/{filename}"
                    for bucket in ("echouastaging", "echouastorage", "echouastoragecbr")
                    for filename in ("picture.PNG", "ланцюжки.mp4")
                )
                self.assertEqual((self.root / "uploads").read_text().splitlines(), expected)
        result = self.publish(bucket=None)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stdout.count("uploaded=0 skipped=2 failed=0"), 3)
        self.assertEqual((self.root / "uploads").read_text().splitlines(), expected)

    def test_all_bucket_upload_stops_after_a_failed_destination_and_can_resume(self):
        self.environment["DOC_MEDIA_FAIL_SERVER"] = "echouastorage"
        result = self.publish("--force", bucket=None)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("incomplete destination: echouastorage", result.stderr)
        self.assertTrue(self.stored("echo-a", "ланцюжки.mp4").exists())
        self.assertFalse(self.stored("echo-b", "ланцюжки.mp4").exists())
        self.assertFalse(self.stored("echo-c", "ланцюжки.mp4").exists())
        del self.environment["DOC_MEDIA_FAIL_SERVER"]
        result = self.publish(bucket=None)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("echouastaging: selected=2 uploaded=0 skipped=2 failed=0", result.stdout)
        self.assertEqual(len((self.root / "uploads").read_text().splitlines()), 6)

    def test_upload_destinations_are_independent_of_server_configurations(self):
        self.environment["DOC_MEDIA_CONFIG_DIR"] = str(self.root / "missing-server-configs")
        result = self.publish()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.stored("echo-a", "ланцюжки.mp4").read_bytes(), b"original")

    def test_all_upload_credentials_and_download_credentials_are_required_in_dotenv(self):
        for key in self.credentials:
            bucket = key.split("_")[0].lower()
            for value in (None, "", "   "):
                credentials = self.credentials | {key: value}
                if value is None:
                    del credentials[key]
                self.write_credentials(credentials)
                for transfer, target in ((self.publish, None), (self.publish, bucket), (self.download, bucket)):
                    with self.subTest(key=key, value=value, command=transfer.__name__, bucket=target):
                        result = transfer(bucket=target)
                        self.assertNotEqual(result.returncode, 0)
                        self.assertIn("required in .env", result.stderr)
                        self.assertIn(key, result.stderr)
                        self.assertIn(f"'{bucket}-lfs backblaze'", result.stderr)
                        self.assertFalse((self.root / "operations").exists())

    def test_missing_dotenv_fails_even_with_exported_credentials(self):
        for checkout in (self.checkout, self.download_checkout):
            (checkout / ".env").unlink()
        for transfer in (self.publish, self.download):
            result = transfer()
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("required in .env", result.stderr)
            self.assertFalse((self.root / "operations").exists())

    def test_worktree_uses_main_dotenv_with_local_overrides(self):
        result = self.publish()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for arguments in (
            ("init",),
            ("-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "fixture"),
        ):
            subprocess.run(["git", "-C", str(self.checkout), *arguments], check=True, capture_output=True)
        worktree = self.root / "worktree"
        subprocess.run(["git", "-C", str(self.checkout), "-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", str(worktree), "HEAD"], check=True, capture_output=True)
        self.prepare_checkout(worktree)
        self.download_checkout = worktree
        result = self.download()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.downloaded("ланцюжки.mp4").read_bytes(), b"original")
        with (self.checkout / ".env").open("a") as dotenv:
            dotenv.write("ECHOUASTAGING_DOCS_AWS_ACCESS_KEY_ID=wrong-main-key\n")
        (worktree / ".env").write_text("ECHOUASTAGING_DOCS_AWS_ACCESS_KEY_ID=echouastaging\n")
        result = self.download("--force")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        (worktree / ".env").write_text("ECHOUASTAGING_DOCS_AWS_ACCESS_KEY_ID=\n")
        operations = (self.root / "operations").read_text()
        result = self.download("--force")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("required in .env", result.stderr)
        self.assertEqual((self.root / "operations").read_text(), operations)

    def test_lfs_pointers_fail_before_any_upload(self):
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
