#!/usr/bin/env python3
"""Protect destructive cleanup boundaries using real processes and scratch DBs."""

import json
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch


def main():
    script = Path(__file__).with_name("device_audio_harness.py")
    result = subprocess.run([sys.executable, str(script), "prepare"], capture_output=True, text=True)
    assert result.returncode == 0, f"Audio prepare failed: {result.stderr}"
    root = Path(result.stdout.strip())
    import device_audio_harness as audio
    import file_preview_harness as preview
    import test_file_preview_ownership as ownership

    root, environment = audio.load(root)
    assert environment["main_db"].startswith("wd_test_device_audio_")
    assert environment["files_db"].startswith("wd_files_test_device_audio_")
    assert environment["bucket"].startswith("device-audio-")
    ownership.refused(lambda: preview.load(root))
    exported = (root / "environment.sh").read_text()
    for variable in ("AUDIO_TEST_ROOT", "AUDIO_TEST_RUN", "AUDIO_S3_BUCKET", "AUDIO_S3_ENDPOINT", "AUDIO_STORAGE_DIR"):
        assert f"export {variable}=" in exported, variable
    assert json.loads((root / "fixtures-private.json").read_text())["run"] == environment["run"]
    original_load = preview.load
    with patch.object(preview, "load", lambda root: original_load(root, "device-audio")):
        ownership.check(root, environment, database=True)


if __name__ == "__main__":
    main()
