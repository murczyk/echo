import subprocess
import unittest
from unittest.mock import patch

import backup_bind


class BindBackupSafetyTests(unittest.TestCase):
    def test_retention_candidates_exclude_migration_and_child_snapshots(self):
        dataset = backup_bind.SOURCE
        rows = (f"{dataset}@hzbindbak_20260926T000000Z\t1\t100\n"
                f"{dataset}@echo-hz-migrate-retain\t2\t101\n"
                f"{dataset}/child@hzbindbak_20260926T000001Z\t3\t102\n")
        result = subprocess.CompletedProcess([], 0, rows, "")
        with patch.object(backup_bind, "run", return_value=result):
            self.assertEqual(backup_bind.snapshots(dataset), [("hzbindbak_20260926T000000Z", "1", 100)])

    def test_receiver_connectivity_failure_is_not_an_empty_backup(self):
        result = subprocess.CompletedProcess([], 255, "", "Connection timed out")
        with patch.object(backup_bind, "run", return_value=result):
            with self.assertRaises(RuntimeError):
                backup_bind.snapshots(backup_bind.TARGET, True)

    def test_wrong_host_cannot_mutate_storage(self):
        with patch.object(backup_bind.subprocess, "check_output", return_value="pve-1\n"), \
                patch.object(backup_bind, "run") as run:
            with self.assertRaises(RuntimeError):
                backup_bind.backup()
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
