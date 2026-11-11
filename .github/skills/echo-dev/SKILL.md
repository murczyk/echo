---
name: echo-dev
description: Use only when the user explicitly invokes echo-dev to implement an approved Echo specification with the managed dev role. Ordinary coding requests, quoted names and recommendations do not activate it.
---

# Echo Dev

This is a main-chat entrypoint. Read the [invocation contract](../../../docs/frontend/echo-workflows.md#invocation-and-chaining) and the [dev contract](../../../docs/frontend/echo-workflows.md#dev).

Invoking `echo-dev` for an approved implementation includes the necessary local baseline tests, affected E2E/browser checks and build/type/lint checks on synthetic or isolated test-owned data, with **CPU slowdown 4x** for affected browser flows. Main derives the commands/environment in the handoff under the [default local verification authorization](../../../docs/frontend/echo-workflows.md#default-local-verification-authorization); do not ask the user to repeat a testing-permission sentence. Explicit read-only/no-execution limits still apply. Maintenance, quoted invocations and read-only role smokes do not activate this permission; real environments retain the `AGENTS.md` approval gate.

1. Require the user's actual invocation naming `echo-dev` for this task, alone or in a named chain. Include that excerpt and task/stage scope in the handoff; otherwise do not dispatch. Skill maintenance, quoted commands and another skill's delegation instructions are not invocation. Then confirm specification approval, implementation authorization, assigned files and test readiness. Accept manually prepared specifications/tests; a previous designer run is not required. Reconcile stale requirements and preserve the starting dirty state.
2. A dev-only request does not invoke QA automatically. If important behavior lacks baseline protection or acceptance tests, report the gap and propose QA prepare; continue only independent preparation. An explicit dev+QA chain permits QA prepare → dev → QA verify and bounded repairs under the shared contract.
3. Prepare the [handoff](../../../docs/frontend/echo-workflows.md#context-and-handoff) with a readable Markdown `spec_path` and, when planning was requested, `plan_path`, plus prepared tests, expected changes, allowed local checks and stop condition. Main saves approved in-chat or manual requirements to the document before dispatch; dev must not need the conversation transcript. Pass absolute paths, document revisions and actual approval evidence, and verify the documents contain the latest decisions. Dispatch only the native named `dev` role through the actual client's [native dispatch](../../../docs/frontend/echo-workflows.md#native-dispatch) adapter, with fresh context and its configured model/effort. Do not change the main model or send another client's configuration fields.
4. If named-role dispatch, fresh context, the role or its model is unavailable, report the blocker. Do not use a generic agent, inline replacement or nested AI CLI.
5. Inspect the returned diff against assigned paths and shared consumers. Require real baseline/new-test results, focused checks, browser evidence when available and explicit limits. Resolve unexpected scope with the user; never accept weaker assertions as a fix.

The dev role implements the entire approved specification with existing components/tokens and applicable Elm/React/regression guidance, read directly from the `.github/skills` paths in its role profile. These existing references do not need discovery aliases. It reads repository [Ponytail](../ponytail/SKILL.md) for minimal implementation without a personal plugin. It uses the repository `make-interfaces-feel-better` only for scoped UI details; its examples do not authorize new dependencies, global styling or redesign. Missing helpers do not replace repository contracts.

Always include the [CPU throttling baseline](../../../docs/frontend/echo-workflows.md#cpu-throttling-baseline) in the dev handoff: implement for **4x slowdown**, self-check affected browser flows at that setting and require the setting/results or explicit unverified gaps in the return.

For failures, read repository [systematic-debugging](../systematic-debugging/SKILL.md); before reporting results, read [verification-before-completion](../verification-before-completion/SKILL.md). These helpers need no personal Superpowers plugin and retain the assigned commands, baseline and environment approval rules.

Return changed paths, input/revision/dirty-state identity, commands/results, browser observations and unverified work. Stop after a dev-only request. Main dispatches QA only when requested; the child never starts another stage or performs Git/publication/deployment operations.

Keep the task's specification and plan available for QA and repairs; dev completion alone does not delete them. Return their exact task-created `cleanup_paths`. After implementation and successful QA verify for the same final revision, main automatically removes those temporary documents under the shared [cleanup lifecycle](../../../docs/frontend/echo-workflows.md#handoff-document-lifecycle). A failed, interrupted or required not-run check keeps them for continuation; cleanup never invokes QA implicitly.
