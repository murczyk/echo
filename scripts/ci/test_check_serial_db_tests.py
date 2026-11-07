from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("check_serial_db_tests.py")
SPEC = importlib.util.spec_from_file_location("check_serial_db_tests", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def rust_test(attributes: str, body: str, name: str = "sample") -> str:
    return f"{attributes}\nasync fn {name}() {{\n    {body}\n}}\n"


class UnserializedWiperTests(unittest.TestCase):
    def test_wipe_without_serial_is_reported(self) -> None:
        for attribute in ("#[tokio::test]", "#[actix_web::test]", "#[tokio::test(flavor = \"multi_thread\")]"):
            source = rust_test(attribute, "cleanup().await.unwrap();")
            self.assertEqual(MODULE.unserialized_wipers(source), ["sample"], attribute)

    def test_locked_wipe_needs_serial_too(self) -> None:
        source = rust_test("#[tokio::test]", "let (env, _guard) = cleanup_locked().await.unwrap();")
        self.assertEqual(MODULE.unserialized_wipers(source), ["sample"])

    def test_serial_spellings_pass(self) -> None:
        for attribute in ("#[serial]", "#[serial_test::serial]"):
            source = rust_test(f"#[tokio::test]\n{attribute}", "cleanup().await.unwrap();")
            self.assertEqual(MODULE.unserialized_wipers(source), [], attribute)

    def test_ignored_tests_pass(self) -> None:
        source = rust_test('#[tokio::test]\n#[ignore = "manual"]', "cleanup().await.unwrap();")
        self.assertEqual(MODULE.unserialized_wipers(source), [])

    def test_tests_without_a_wipe_pass(self) -> None:
        self.assertEqual(MODULE.unserialized_wipers(rust_test("#[test]", "assert!(true);")), [])

    def test_wipe_through_a_local_helper_is_reported(self) -> None:
        helper = "async fn setup() -> Env {\n    cleanup().await.unwrap()\n}\n"
        source = helper + rust_test("#[tokio::test]", "let env = setup().await;")
        self.assertEqual(MODULE.unserialized_wipers(source), ["sample"])

    def test_a_following_helper_is_not_part_of_the_test(self) -> None:
        source = rust_test("#[test]", "assert!(true);") + "async fn later() {\n    cleanup().await.unwrap();\n}\n"
        self.assertEqual(MODULE.unserialized_wipers(source), [])


if __name__ == "__main__":
    unittest.main()
