import importlib.util
import io
import json
import pathlib
import unittest
from unittest import mock


DISPATCHER_PATH = (
    pathlib.Path(__file__).parents[1]
    / "dispatcher"
    / "echo_ai_agent_dispatcher.py"
)
SPEC = importlib.util.spec_from_file_location("echo_ai_agent_dispatcher", DISPATCHER_PATH)
assert SPEC and SPEC.loader
DISPATCHER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DISPATCHER)


class DispatcherValidationTests(unittest.TestCase):
    def test_accepts_multiple_echo_namespaces(self):
        for namespace in (
            "echo-staging",
            "echo-cbr-staging",
            "echo-cbr",
            "echo-kharkiv2",
        ):
            self.assertIsNotNone(DISPATCHER.NAMESPACE_RE.fullmatch(namespace))

        for namespace in ("echo-", "Echo-cbr", "echo-cbr-", "other-cbr"):
            self.assertIsNone(DISPATCHER.NAMESPACE_RE.fullmatch(namespace))

    def test_container_identity_matches_host_configuration(self):
        host_config = {}
        config_path = pathlib.Path(__file__).parents[1] / "config" / "host.env"
        for line in config_path.read_text().splitlines():
            if line and not line.startswith("#"):
                key, value = line.split("=", 1)
                host_config[key] = value
        self.assertEqual(DISPATCHER.AGENT_UID, int(host_config["AGENT_CONTAINER_UID"]))
        self.assertEqual(DISPATCHER.AGENT_GID, int(host_config["AGENT_CONTAINER_GID"]))
        self.assertEqual(str(DISPATCHER.LOCK_PATH), host_config["DISPATCH_LOCK_PATH"])
        versions = {}
        versions_path = pathlib.Path(__file__).parents[1] / "versions.env"
        for line in versions_path.read_text().splitlines():
            if line and not line.startswith("#"):
                key, value = line.split("=", 1)
                versions[key] = value
        self.assertEqual(DISPATCHER.HARNESS_RELEASE, versions["HARNESS_RELEASE"])
        self.assertEqual(DISPATCHER.NODE_VERSION, versions["NODE_VERSION"])
        self.assertEqual(DISPATCHER.PI_VERSION, versions["PI_VERSION"])

    def test_runner_output_rejects_and_drains_oversized_line(self):
        stream = io.StringIO(
            "x" * (DISPATCHER.MAX_EVENT_CHARACTERS + 1) + "\n{\"ok\":true}\n"
        )

        with self.assertRaises(DISPATCHER.DispatchError):
            DISPATCHER.read_runner_event_line(stream)

        self.assertEqual(stream.readline(), '{"ok":true}\n')

    def test_runner_stderr_is_drained_in_bounded_chunks(self):
        class RecordingStream(io.StringIO):
            def __init__(self, value):
                super().__init__(value)
                self.sizes = []

            def read(self, size=-1):
                self.sizes.append(size)
                return super().read(size)

        stream = RecordingStream("x" * (DISPATCHER.STDERR_CHUNK_CHARACTERS * 2 + 1))
        captured = DISPATCHER.drain_runner_stderr(stream)

        self.assertTrue(stream.sizes)
        self.assertEqual(set(stream.sizes), {DISPATCHER.STDERR_CHUNK_CHARACTERS})
        self.assertEqual(
            len(captured.encode()),
            DISPATCHER.STDERR_TAIL_BYTES,
        )

    def test_runner_stderr_tail_redacts_credentials(self):
        bootstrap_token = "A" * 43
        provider_api_key = "budget-limited-provider-token"
        captured = DISPATCHER.drain_runner_stderr(
            io.StringIO(
                "old\n"
                + "x" * DISPATCHER.STDERR_TAIL_BYTES
                + f'\nbootstrapToken: {bootstrap_token}\n'
                + f'providerApiKey: {provider_api_key}\n'
                + "Authorization: Bearer secret-value\n"
                + "Cookie=session-secret\n"
            )
        )

        self.assertLessEqual(len(captured.encode()), DISPATCHER.STDERR_TAIL_BYTES)
        self.assertNotIn(bootstrap_token, captured)
        self.assertNotIn(provider_api_key, captured)
        self.assertNotIn("secret-value", captured)
        self.assertNotIn("session-secret", captured)
        self.assertIn("[REDACTED]", captured)

    def test_validates_runner_protocol_and_release_handshake(self):
        DISPATCHER.validate_runner_hello(
            {
                "type": "runner_hello",
                "protocolVersion": DISPATCHER.RUNNER_PROTOCOL_VERSION,
                "harnessRelease": DISPATCHER.HARNESS_RELEASE,
            }
        )
        DISPATCHER.validate_runner_hello(
            {
                "type": "runner_hello",
                "protocolVersion": DISPATCHER.RUNNER_PROTOCOL_VERSION,
                "harnessRelease": "2026.08.05.2",
            }
        )
        with self.assertRaisesRegex(DISPATCHER.DispatchError, "protocol version"):
            DISPATCHER.validate_runner_hello(
                {
                    "type": "runner_hello",
                    "protocolVersion": DISPATCHER.RUNNER_PROTOCOL_VERSION + 1,
                    "harnessRelease": DISPATCHER.HARNESS_RELEASE,
                }
            )
        with self.assertRaisesRegex(DISPATCHER.DispatchError, "harness release"):
            DISPATCHER.validate_runner_hello(
                {
                    "type": "runner_hello",
                    "protocolVersion": DISPATCHER.RUNNER_PROTOCOL_VERSION,
                    "harnessRelease": "2026.08.04.3",
                }
            )

    def test_agent_summary_exposes_harness_release(self):
        summary = DISPATCHER.agent_summary(
            {
                "name": "echo-ai-agent-019fc7f7-9770-7f83-9c1a-211af29b02e7",
                "status": "STOPPED",
                "profiles": [DISPATCHER.PROFILE_NAME],
                "config": {
                    "user.echo.ai.agent_id": "019fc7f7-9770-7f83-9c1a-211af29b02e7",
                    "user.echo.ai.namespace": "echo-cbr",
                    "user.echo.ai.harness_release": "2026.08.05.2",
                },
            }
        )

        self.assertEqual(summary["harness_release"], "2026.08.05.2")

    def test_runner_failure_records_request_and_exit_status(self):
        failure = DISPATCHER.runner_failure("request-42", 1, "failed", "stack")

        self.assertIn("dispatcher_request_id=request-42", failure)
        self.assertIn("exit_status=1", failure)
        self.assertIn("runner_stderr_tail=stack", failure)

    def test_parses_allowlisted_request(self):
        request = DISPATCHER.parse_request(
            json.dumps({"id": "r1", "operation": "list"}).encode()
        )
        self.assertEqual(request.request_id, "r1")
        self.assertEqual(request.operation, "list")

    def test_rejects_missing_id(self):
        with self.assertRaises(DISPATCHER.DispatchError):
            DISPATCHER.parse_request(json.dumps({"operation": "list"}).encode())

    def test_rejects_unlisted_operation(self):
        with self.assertRaises(DISPATCHER.DispatchError):
            DISPATCHER.parse_request(
                json.dumps({"id": "r1", "operation": "exec"}).encode()
            )

    def test_rejects_non_string_operation(self):
        with self.assertRaisesRegex(DISPATCHER.DispatchError, "not allowed"):
            DISPATCHER.parse_request(
                json.dumps({"id": "r1", "operation": []}).encode()
            )

    def test_rejects_caller_namespace(self):
        with self.assertRaisesRegex(DISPATCHER.DispatchError, "unsupported fields"):
            DISPATCHER.parse_request(
                json.dumps(
                    {
                        "id": "r1",
                        "operation": "list",
                        "namespace": "echo-production",
                    }
                ).encode()
            )

    def test_rejects_fields_from_another_operation(self):
        with self.assertRaisesRegex(DISPATCHER.DispatchError, "unsupported fields"):
            DISPATCHER.parse_request(
                json.dumps(
                    {
                        "id": "r1",
                        "operation": "start",
                        "agent_id": "019fc7f7-9770-7f83-9c1a-211af29b02e6",
                        "timeout_seconds": 30,
                    }
                ).encode()
            )

    def test_requires_uuid_v7_agent_id(self):
        body = {"agent_id": "019fc7f7-9770-7f83-9c1a-211af29b02e6"}
        self.assertEqual(
            DISPATCHER.instance_name(body),
            "echo-ai-agent-019fc7f7-9770-7f83-9c1a-211af29b02e6",
        )
        with self.assertRaises(DISPATCHER.DispatchError):
            DISPATCHER.instance_name({"agent_id": "not-a-uuid"})

    def test_endpoint_validation_does_not_accept_commands(self):
        self.assertEqual(
            DISPATCHER.parse_endpoint("100.105.172.96:8000", "upstream"),
            ("100.105.172.96", 8000),
        )
        with self.assertRaises(DISPATCHER.DispatchError):
            DISPATCHER.parse_endpoint("host:8000;id", "upstream")

    def test_configure_proxies_accepts_transport_field(self):
        request = DISPATCHER.parse_request(
            json.dumps(
                {
                    "id": "r1",
                    "operation": "configure_proxies",
                    "agent_id": "019fc7f7-9770-7f83-9c1a-211af29b02e6",
                    "echo_hostname": "echo.example.test",
                    "echo_upstream": "100.64.63.98:443",
                    "provider_transport": "echo_gateway",
                }
            ).encode()
        )
        self.assertEqual(request.body["provider_transport"], "echo_gateway")

    @mock.patch.object(DISPATCHER, "run")
    @mock.patch.object(DISPATCHER, "remove_proxy")
    @mock.patch.object(DISPATCHER, "replace_proxy")
    @mock.patch.object(DISPATCHER, "resolve_endpoint")
    @mock.patch.object(DISPATCHER, "require_instance")
    def test_gateway_transport_removes_direct_provider_proxy(
        self,
        require_instance,
        resolve_endpoint,
        replace_proxy,
        remove_proxy,
        run,
    ):
        require_instance.return_value = {"status": "RUNNING", "config": {}}
        resolve_endpoint.return_value = ("100.64.63.98", 443)
        body = {
            "agent_id": "019fc7f7-9770-7f83-9c1a-211af29b02e6",
            "echo_hostname": "echo.example.test",
            "echo_upstream": "100.64.63.98:443",
            "provider_transport": "echo_gateway",
        }

        DISPATCHER.op_configure_proxies("echo-staging", body)

        resolve_endpoint.assert_called_once_with(
            "100.64.63.98:443", "echo_upstream"
        )
        replace_proxy.assert_called_once_with(
            "echo-ai-agent-019fc7f7-9770-7f83-9c1a-211af29b02e6",
            "echo-upstream",
            18443,
            "100.64.63.98:443",
        )
        remove_proxy.assert_called_once_with(
            "echo-ai-agent-019fc7f7-9770-7f83-9c1a-211af29b02e6",
            "vllm-upstream",
        )
        self.assertTrue(
            any(
                "user.echo.ai.provider_transport=echo_gateway" in call.args[0]
                for call in run.call_args_list
            )
        )

    def test_gateway_transport_rejects_direct_upstream(self):
        body = {
            "agent_id": "019fc7f7-9770-7f83-9c1a-211af29b02e6",
            "echo_hostname": "echo.example.test",
            "echo_upstream": "100.64.63.98:443",
            "provider_transport": "echo_gateway",
            "vllm_upstream": "100.105.172.96:8000",
        }
        with mock.patch.object(
            DISPATCHER,
            "require_instance",
            return_value={"status": "RUNNING"},
        ), mock.patch.object(
            DISPATCHER,
            "resolve_endpoint",
            return_value=("100.64.63.98", 443),
        ):
            with self.assertRaisesRegex(
                DISPATCHER.DispatchError, "not allowed"
            ):
                DISPATCHER.op_configure_proxies("echo-staging", body)

    @mock.patch.object(DISPATCHER.socket, "getaddrinfo")
    def test_resolves_hostname_before_configuring_incus_proxy(self, getaddrinfo):
        getaddrinfo.return_value = [
            (
                DISPATCHER.socket.AF_INET,
                DISPATCHER.socket.SOCK_STREAM,
                DISPATCHER.socket.IPPROTO_TCP,
                "",
                ("100.69.44.87", 8300),
            )
        ]

        self.assertEqual(
            DISPATCHER.resolve_endpoint("echo.example:8300", "echo_upstream"),
            ("100.69.44.87", 8300),
        )

    @mock.patch.object(DISPATCHER.socket, "getaddrinfo")
    def test_rejects_hostname_without_ipv4_result(self, getaddrinfo):
        getaddrinfo.side_effect = DISPATCHER.socket.gaierror()

        with self.assertRaisesRegex(DISPATCHER.DispatchError, "resolve to IPv4"):
            DISPATCHER.resolve_endpoint("echo.example:8300", "echo_upstream")

    @mock.patch.object(DISPATCHER, "run")
    def test_parses_plain_incus_version_output(self, run):
        run.return_value.stdout = "Client version: 7.3\nServer version: 7.3\n"

        self.assertEqual(
            DISPATCHER.incus_versions(),
            {"client_version": "7.3", "server_version": "7.3"},
        )

    @mock.patch.object(DISPATCHER, "run")
    def test_rejects_incomplete_incus_version_output(self, run):
        run.return_value.stdout = "Client version: 7.3\n"

        with self.assertRaisesRegex(
            DISPATCHER.DispatchError, "unexpected Incus version output"
        ):
            DISPATCHER.incus_versions()

    @mock.patch.object(DISPATCHER, "running_agent_count", return_value=0)
    @mock.patch.object(
        DISPATCHER,
        "incus_versions",
        return_value={"client_version": "7.3", "server_version": "7.3"},
    )
    @mock.patch.object(DISPATCHER, "instance_record")
    def test_preflight_validates_selected_template(
        self, instance_record, _incus_versions, _running_agent_count
    ):
        template_id = "019fc7f7-9770-7f83-9c1a-211af29b02e7"
        template_name = f"echo-ai-agent-{template_id}"
        instance_record.return_value = {
            "name": template_name,
            "status": "STOPPED",
            "profiles": [DISPATCHER.PROFILE_NAME],
            "config": self.ready_template_config(),
        }
        result = DISPATCHER.op_preflight(
            "echo-staging", {"template_id": template_id}
        )
        instance_record.assert_called_once_with(template_name)
        self.assertEqual(result["template_id"], template_id)
        self.assertEqual(result["template_name"], template_name)
        self.assertTrue(result["template_ready"])

    @mock.patch.object(DISPATCHER, "run_json")
    @mock.patch.object(DISPATCHER, "require_instance")
    def test_stats_uses_incus_state_api(self, require_instance, run_json):
        agent_id = "019fc7f7-9770-7f83-9c1a-211af29b02e7"
        name = f"echo-ai-agent-{agent_id}"
        require_instance.return_value = {"status": "RUNNING"}
        run_json.return_value = {
            "status": "Running",
            "cpu": {"usage": 1},
            "memory": {"usage": 2},
            "disk": {"root": {"usage": 3}},
            "processes": 4,
        }

        result = DISPATCHER.op_stats("echo-staging", {"agent_id": agent_id})

        run_json.assert_called_once_with(
            ["incus", "query", f"/1.0/instances/{name}/state"]
        )
        self.assertEqual(result["status"], "running")

    @mock.patch.object(DISPATCHER, "run")
    @mock.patch.object(DISPATCHER, "instance_record")
    def test_clone_clears_inherited_template_marker(self, instance_record, run):
        agent_id = "019fc7f7-9770-7f83-9c1a-211af29b02e7"
        name = f"echo-ai-agent-{agent_id}"
        template = {
            "name": DISPATCHER.TEMPLATE_NAME,
            "status": "STOPPED",
            "profiles": [DISPATCHER.PROFILE_NAME],
            "config": self.ready_template_config(),
        }
        child = {
            "name": name,
            "status": "STOPPED",
            "config": {
                "user.echo.ai.managed": "true",
                "user.echo.ai.namespace": "echo-staging",
                "user.echo.ai.agent_id": agent_id,
                "user.echo.ai.template.ready": "false",
            },
        }
        instance_record.side_effect = [None, template, child]

        result = DISPATCHER.op_clone(
            "echo-staging", {"agent_id": agent_id}
        )

        config_set = run.call_args_list[1].args[0]
        self.assertIn("user.echo.ai.template.ready=false", config_set)
        self.assertEqual(result["instance"]["name"], name)

    @mock.patch.object(DISPATCHER, "run")
    @mock.patch.object(DISPATCHER, "instance_record")
    def test_clone_failure_clears_delete_protection_before_cleanup(
        self, instance_record, run
    ):
        agent_id = "019fc7f7-9770-7f83-9c1a-211af29b02e7"
        name = f"echo-ai-agent-{agent_id}"
        template = {
            "name": DISPATCHER.TEMPLATE_NAME,
            "status": "STOPPED",
            "profiles": [DISPATCHER.PROFILE_NAME],
            "config": {
                **self.ready_template_config(),
                "security.protection.delete": "true",
            },
        }
        instance_record.side_effect = [None, template]
        run.side_effect = [None, DISPATCHER.DispatchError("config failed"), None, None]

        with self.assertRaises(DISPATCHER.DispatchError):
            DISPATCHER.op_clone("echo-staging", {"agent_id": agent_id})

        self.assertEqual(
            run.call_args_list[2],
            mock.call(
                [
                    "incus",
                    "config",
                    "set",
                    name,
                    "security.protection.delete=false",
                ],
                check=False,
            ),
        )
        self.assertEqual(
            run.call_args_list[3],
            mock.call(["incus", "delete", name], check=False),
        )

    def test_rejects_stale_ready_template(self):
        template = {
            "name": DISPATCHER.TEMPLATE_NAME,
            "status": "STOPPED",
            "profiles": [DISPATCHER.PROFILE_NAME],
            "config": {
                **self.ready_template_config(),
                "user.echo.ai.harness_release": "2026.08.03.2",
            },
        }
        with mock.patch.object(DISPATCHER, "instance_record", return_value=template):
            with self.assertRaisesRegex(
                DISPATCHER.DispatchError, "another harness release"
            ):
                DISPATCHER.require_template({})

    @staticmethod
    def ready_template_config():
        return {
            "user.echo.ai.template.ready": "true",
            "user.echo.ai.harness_release": DISPATCHER.HARNESS_RELEASE,
            "user.echo.ai.node_version": DISPATCHER.NODE_VERSION,
            "user.echo.ai.pi_version": DISPATCHER.PI_VERSION,
            "user.echo.ai.guestapi_disabled": "true",
            "user.echo.ai.container_uid": str(DISPATCHER.AGENT_UID),
            "user.echo.ai.container_gid": str(DISPATCHER.AGENT_GID),
        }


if __name__ == "__main__":
    unittest.main()
