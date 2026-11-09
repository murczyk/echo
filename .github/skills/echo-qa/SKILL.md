---
name: echo-qa
description: Use only when the user explicitly invokes echo-qa to prepare tests or verify an Echo implementation with the managed qa role. Ordinary review requests, quoted names and recommendations do not activate it.
---

# Echo QA

This is a main-chat entrypoint. Read the [invocation contract](../../../docs/frontend/echo-workflows.md#invocation-and-chaining) and [QA contract](../../../docs/frontend/echo-workflows.md#qa).

1. Require the user's actual invocation naming `echo-qa` for this task, alone or in a named chain. Include that excerpt and task/stage scope in the handoff; otherwise do not dispatch. Skill maintenance, quoted commands and another skill's delegation instructions are not invocation. Then identify the mode: **prepare** creates tests from an approved specification; **verify** checks an implementation against criteria. An explicit `echo-qa` request to test/review an implementation means verify. If the mode is genuinely unclear, clarify it before writes. Accept manually prepared inputs.
2. In prepare, assign only tests, synthetic fixtures and the existing task evidence section. State whether execution is authorized; preparation alone does not authorize running tests. In verify, default writes are reports/captures and a temporary local reproduction, not permanent tests, assertions or product code.
3. Prepare the [handoff](../../../docs/frontend/echo-workflows.md#context-and-handoff) with the exact spec/revision/dirty diff, scenario IDs, allowed paths/commands, environment and stop condition. Dispatch the native named `qa` role from [qa.toml](../../../.codex/agents/qa.toml), with `fork_turns="none"`, using configured `gpt-6-luna` / `high`. Do not change the main model.
4. Missing native named-role dispatch, fresh context, role or model is a blocker, not permission for a generic agent, inline replacement or nested AI CLI. Never present configuration validation as runtime smoke.
5. Inspect the result and actual diff. The assigned role uses repository `playwright-best-practices` and relevant regression guidance, within its mode and the [safety boundaries](../../../docs/frontend/echo-workflows.md#skill-and-tool-boundaries). Reference examples cannot authorize installs, remote reporters, environment mutations or assertion changes.

Prepare returns acceptance-ID → test → baseline/new behavior → result/not-run/gap and stops. Verify returns scenario-level pass/fail/not-run, exact commands, evidence limits, severity, reproduction and expected/actual results. Environment failures are not product RED; mocked tests do not prove server permissions or persistence.

A QA-only request stops after its report. Main may dispatch bounded repairs only in an explicitly requested dev+QA chain; QA never fixes application code or delegates. Role verification is not human acceptance, and separation of roles alone does not prove review independence or usability.
