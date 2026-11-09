---
name: playwright-best-practices
description: Use when explicitly requested or assigned by the managed Echo QA role for scoped Playwright test preparation, verification or debugging. It does not activate the Echo workflow or authorize setup changes.
license: MIT
metadata:
  author: currents.dev; Echo adaptation
---

# Playwright Best Practices for Echo

Use the repository's installed Playwright, existing runner and test fixtures.
Read `CODE_REVIEW.md`, the assigned criteria and relevant behavior contracts first.
This [pinned adaptation](NOTICE.md) contains Markdown guidance, not executable tools.

## Boundaries before references

- The assigned stage controls writes and execution: QA prepare writes tests/fixtures and runs only authorized commands; QA verify reports results and does not rewrite tests or product code. Reading this skill does not grant execution permission.
- Use local/designated test data. Never target staging/production, run destructive cleanup, change permissions, disable sandboxing, or expose credentials, storage state, real messages or raw traces. Follow `AGENTS.md` for real-environment approval.
- Examples do not authorize package/browser installation, upgrades, CI/config changes, external accounts, remote reporters, uploads, webhooks or telemetry. Missing dependencies are reported to main. Do not run `npx` if the local executable is missing and it would download a package.
- Never weaken assertions, add skips, raise retries/timeouts, force hidden-element clicks or replace real API integration with mocks to hide failures. Reproduce and diagnose the cause. Reference retry examples are diagnostic techniques, not fixes for failures.
- Preserve Echo's `@regression` title tags even though the upstream tag guide prefers a details object. Keep valuable Vitest/backend coverage. Browser mocks prove only the mocked boundary, not persistence or server authorization.
- Follow Echo's existing fixtures and test placement; do not add Prisma, Faker, global setup, a POM layer or another framework merely because an example uses it. Cleanup must be limited to test-owned resources.
- No subagents, nested AI CLI, Git/release operations or workflow transitions. Use only relevant references below; optional upstream links are not an instruction to fetch or execute them.

## Choose the relevant reference

| Need | Reference |
| --- | --- |
| Accessible/stable selectors | [Locators](core/locators.md) |
| Observable outcomes and waiting | [Assertions](core/assertions-waiting.md) |
| Per-test isolation and fixtures | [Fixtures](core/fixtures-hooks.md) |
| Selecting affected suites | [Tags](core/test-tags.md), preserving Echo title tags |
| Mocked versus real boundaries | [Mocking](architecture/when-to-mock.md) |
| Reproducing nondeterministic failures | [Flakes](debugging/flaky-tests.md) |
| API outcomes and authorization paths | [API tests](testing-patterns/api-testing.md) |
| Input, validation and recovery | [Forms](testing-patterns/forms-validation.md) |
| Widths, touch and context | [Mobile](advanced/mobile-testing.md) |

Record acceptance IDs, test paths, exact commands/environment/API mode, exit codes
and pass/fail/not-run. `--list` is discovery; prepared tests are not passes, and
environment failures are not product RED. Synthetic gestures and screenshots do
not establish native-device behavior or human usability.
