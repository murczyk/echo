import unittest
from unittest.mock import patch

import cutover
from migration_common import GIB, SafetyStop, guests


class CutoverSafetyTests(unittest.TestCase):
    def setUp(self):
        self.guest = next(g for g in guests() if g["id"] == 127)

    def test_large_delta_cannot_stop_source(self):
        with patch.multiple(cutover, check_config=lambda g: None,
                            transfer_guard=lambda g: None, protected=lambda g: None,
                            same_snapshot=lambda g, s: None,
                            read_state=lambda i: {"common": "base"},
                            prop=lambda *args: str(2 * GIB)), patch.object(cutover, "output") as output:
            with self.assertRaises(SafetyStop):
                cutover.stop_source(self.guest)
            output.assert_not_called()

    def test_running_source_prevents_destination_boot(self):
        with patch.object(cutover, "output", return_value="status: running"), \
                patch.object(cutover, "remote") as remote:
            with self.assertRaises(SafetyStop):
                cutover.boot_target(self.guest)
            remote.assert_not_called()

    def test_source_autostart_prevents_destination_boot(self):
        with patch.object(cutover, "require_status"), \
                patch.object(cutover, "config", return_value="onboot: 1\nlock: migrate\n"), \
                patch.object(cutover, "remote") as remote:
            with self.assertRaises(SafetyStop):
                cutover.boot_target(self.guest)
            remote.assert_not_called()


if __name__ == "__main__":
    unittest.main()
