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

from doc_media import EXTENSIONS, UPLOAD_BUCKETS

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
            "AWS_ACCESS_KEY_ID": UPLOAD_BUCKETS[0],
            "AWS_SECRET_ACCESS_KEY": "fixture",
            "DOC_MEDIA_FAKE_STORAGE": str(self.root),
        }

    def publish(self, *arguments, bucket=UPLOAD_BUCKETS[0]):
        command = [
            "just", "--justfile", str(REPOSITORY / "justfile"),
            "release-doc-media", "--only", str(self.source),
        ]
        if bucket is not None:
            command.extend(["--bucket", bucket])
        return subprocess.run(command + list(arguments), env=self.environment, capture_output=True, text=True)

    def stored(self, server, filename):
        return self.root / self.buckets[server] / "doc-media" / self.source.relative_to(REPOSITORY) / filename

    def download(self, *arguments, bucket=UPLOAD_BUCKETS[0]):
        checkout = self.root / "checkout"
        if not (checkout / "justfile").exists():
            (checkout / "deploy").mkdir(parents=True, exist_ok=True)
            shutil.copyfile(REPOSITORY / "justfile", checkout / "justfile")
            shutil.copyfile(REPOSITORY / "deploy/doc_media.py", checkout / "deploy/doc_media.py")
        command = [
            "just", "--justfile", str(checkout / "justfile"), "download-doc-media",
        ]
        if bucket is not None:
            command.extend(["--bucket", bucket])
        return subprocess.run(command + list(arguments), env=self.environment, capture_output=True, text=True)

    def downloaded(self, filename):
        return self.root / "checkout" / self.source.relative_to(REPOSITORY) / filename

    def test_transfers_require_a_known_bucket_before_accessing_credentials_or_storage(self):
        self.environment.pop("AWS_ACCESS_KEY_ID")
        self.environment.pop("AWS_SECRET_ACCESS_KEY")
        for transfer in (self.publish, self.download):
            for bucket in (None, "", "unknown-bucket"):
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
        self.environment["AWS_ACCESS_KEY_ID"] = bucket
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
        only = self.source.relative_to(REPOSITORY).as_posix()
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
        self.assertIn("Reminder: upload documentation media to all three buckets:", result.stdout)
        self.environment["AWS_ACCESS_KEY_ID"] = self.buckets["echo-b"]
        result = self.publish(bucket=self.buckets["echo-b"])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.stored("echo-b", "ланцюжки.mp4").read_bytes(), b"original")
        self.assertFalse(self.stored("echo-c", "ланцюжки.mp4").exists())

    def test_each_invocation_uploads_once_to_one_bucket_and_reminds_about_all_three(self):
        expected = []
        for force in (False, True):
            for bucket in UPLOAD_BUCKETS:
                with self.subTest(bucket=bucket, force=force):
                    self.environment["AWS_ACCESS_KEY_ID"] = bucket
                    result = self.publish(*(["--force"] if force else []), bucket=bucket)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    expected.extend(
                        f"s3://{bucket}/doc-media/{self.source.relative_to(REPOSITORY)}/{filename}"
                        for filename in ("ланцюжки.mp4", "picture.PNG")
                    )
                    self.assertCountEqual((self.root / "uploads").read_text().splitlines(), expected)
                    self.assertEqual(result.stdout.splitlines()[-1],
                                     "Reminder: upload documentation media to all three buckets: " + ", ".join(UPLOAD_BUCKETS))

    def test_upload_destinations_are_independent_of_server_configurations(self):
        self.environment["DOC_MEDIA_CONFIG_DIR"] = str(self.root / "missing-server-configs")
        result = self.publish()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.stored("echo-a", "ланцюжки.mp4").read_bytes(), b"original")

    def test_missing_environment_credentials_and_lfs_pointers_fail_before_any_upload(self):
        environment = self.environment.copy()
        for bucket in UPLOAD_BUCKETS:
            for missing in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
                with self.subTest(bucket=bucket, missing=missing):
                    self.environment = environment | {"AWS_ACCESS_KEY_ID": bucket}
                    self.environment.pop(missing)
                    result = self.publish(bucket=bucket)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required", result.stderr)
                    self.assertIn(f"'{bucket}-lfs backblaze'", result.stderr)
                    self.assertIn("goi/justfile", result.stderr)
                    self.assertFalse((self.root / "operations").exists())
        self.environment = environment
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
