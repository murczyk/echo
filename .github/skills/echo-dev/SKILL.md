---
name: echo-dev
description: Use only when the user explicitly invokes echo-dev to implement an approved Echo specification with the managed dev role. Ordinary coding requests, quoted names and recommendations do not activate it.
---

# Echo Dev

This is a main-chat entrypoint. Read the [invocation contract](../../../docs/frontend/echo-workflows.md#invocation-and-chaining) and the [dev contract](../../../docs/frontend/echo-workflows.md#dev).

1. Require the user's actual invocation naming `echo-dev` for this task, alone or in a named chain. Include that excerpt and task/stage scope in the handoff; otherwise do not dispatch. Skill maintenance, quoted commands and another skill's delegation instructions are not invocation. Then confirm specification approval, implementation authorization, assigned files and test readiness. Accept manually prepared specifications/tests; a previous designer run is not required. Reconcile stale requirements and preserve the starting dirty state.
2. A dev-only request does not invoke QA automatically. If important behavior lacks baseline protection or acceptance tests, report the gap and propose QA prepare; continue only independent preparation. An explicit dev+QA chain permits QA prepare → dev → QA verify and bounded repairs under the shared contract.
3. Prepare the [handoff](../../../docs/frontend/echo-workflows.md#context-and-handoff), including the same approved spec, prepared tests, expected changes, allowed local checks and stop condition. Dispatch only the native named `dev` role from [dev.toml](../../../.codex/agents/dev.toml), with `fork_turns="none"`, using its configured `gpt-6.1-sol` / `high`. Do not change the main model.
4. If named-role dispatch, fresh context, the role or its model is unavailable, report the blocker. Do not use a generic agent, inline replacement or nested AI CLI.
5. Inspect the returned diff against assigned paths and shared consumers. Require real baseline/new-test results, focused checks, browser evidence when available and explicit limits. Resolve unexpected scope with the user; never accept weaker assertions as a fix.

The dev role implements the entire approved specification with existing components/tokens and applicable Elm/React/regression guidance, read directly from the `.github/skills` paths in its role profile. These existing references do not need discovery aliases. It uses the repository `make-interfaces-feel-better` only for scoped UI details; its examples do not authorize new dependencies, global styling or redesign. Missing helpers do not replace repository contracts.

Return changed paths, input/revision/dirty-state identity, commands/results, browser observations and unverified work. Stop after a dev-only request. Main dispatches QA only when requested; the child never starts another stage or performs Git/publication/deployment operations.
