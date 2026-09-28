import copy
from pathlib import Path
import signal
import tempfile
import unittest
from unittest.mock import patch

import migration_common as common
import stage


class MigrationSafeguards(unittest.TestCase):
    def test_process_signal_requests_a_persistent_safe_pause(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            with patch.object(stage, "STATE", state), patch.object(common, "STATE", state):
                stage.request_signal_pause(signal.SIGINT, None)
                self.assertIn("SIGINT", (state / "STOP").read_text())
                with self.assertRaises(common.SafetyStop):
                    common.check_pause()

    def test_small_guests_also_send_completion_notifications(self):
        guest = common.guests()[4] | {"stream_bytes": 100}
        with patch.object(stage, "notify") as notify:
            stage.notify_base(guest)
            self.assertEqual(notify.call_args.args[1], f"base-{guest['id']}")

    def test_manifest_cannot_expand_or_redirect_scope(self):
        original = {"run": common.RUN, "snapshot": common.SNAPSHOT, "guests": common.guests()}
        common.validate_manifest(original)
        for change in ("extra", "dataset", "target", "id"):
            altered = copy.deepcopy(original)
            if change == "extra":
                altered["guests"].append(altered["guests"][0])
            else:
                altered["guests"][0][change] = "unrelated"
            with self.subTest(change=change), self.assertRaises(common.SafetyStop):
                common.validate_manifest(altered)

    def test_staged_config_cannot_autostart_or_reference_missing_snapshot(self):
        source = (
            "name: srv-echo-ai-agent-vm\nonboot: 1\nparent: old\nlock: backup\n"
            "ide2: local:iso/old.iso,media=cdrom\nscsi0: local-zfs:vm-129-disk-0\n"
            "\n[old]\nonboot: 1\n"
        )
        target = common.target_config(source, "qemu")
        self.assertEqual(common.config_values(target)["onboot"], "0")
        self.assertNotIn("parent:", target)
        self.assertNotIn("lock:", target)
        self.assertNotIn("[old]", target)
        self.assertIn("ide2: none,media=cdrom", target)
        self.assertIn("scsi0: local-zfs:vm-129-disk-0", target)

    def test_existing_unrelated_destination_is_not_overwritten(self):
        guest = common.guests()[0] | {"snapshot_guid": "expected"}
        with patch.object(stage, "exists", return_value=True), \
             patch.object(stage, "prop", return_value="-"), \
             patch.object(stage, "verify_received", side_effect=common.SafetyStop("unrelated")):
            with self.assertRaises(common.SafetyStop):
                stage.choose_send(guest)

    def test_protection_separates_filesystems_from_zvols(self):
        for guest in common.guests():
            args = common.protect_args(guest)
            self.assertIn("readonly=on", args)
            self.assertIn(f"echo:migration={common.RUN}", args)
            self.assertIn("canmount=noauto" if guest["kind"] == "lxc" else "volmode=none", args)
            self.assertNotIn("-F", args)

    def test_snapshot_guid_mismatch_is_fatal(self):
        guest = common.guests()[0] | {"snapshot_guid": "expected"}
        properties = {
            "type": "filesystem", "readonly": "on", "echo:migration": common.RUN,
            "receive_resume_token": "-", "canmount": "noauto", "mounted": "no",
            "guid": "different",
        }
        with patch.object(common, "prop", side_effect=lambda host, dataset, name: properties[name]):
            with self.assertRaises(common.SafetyStop):
                common.verify_received(guest)

    def test_only_resume_token_can_resume_partial_receive(self):
        guest = common.guests()[0] | {"snapshot_guid": "123"}
        properties = {"echo:migration": common.RUN, "readonly": "on",
                      "receive_resume_token": "resume-token"}
        details = f"toname = {guest['dataset']}@{common.SNAPSHOT}\ntoguid = 0x7b\n"
        with patch.object(stage, "exists", return_value=True), \
             patch.object(stage, "prop", side_effect=lambda host, dataset, name: properties[name]), \
             patch.object(stage, "zfs", return_value=details) as zfs, patch.object(stage, "event"):
            self.assertEqual(stage.choose_send(guest), ["-t", "resume-token"])
            zfs.assert_called_once_with(guest["source"], "send", "-nPv", "-t", "resume-token")

    def test_resume_token_cannot_copy_another_snapshot(self):
        guest = common.guests()[0] | {"snapshot_guid": "123"}
        for details in (
            f"toname = {guest['dataset']}@other\ntoguid = 0x7b\n",
            f"toname = {guest['dataset']}@{common.SNAPSHOT}\ntoguid = 0x7c\n",
        ):
            with self.assertRaises(common.SafetyStop):
                stage.validate_resume_token(guest, details)


if __name__ == "__main__":
    unittest.main()
