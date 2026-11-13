---
name: echo-dev
description: Use only when the user explicitly invokes echo-dev to implement an approved Echo specification with the managed dev role. Ordinary coding requests, quoted names and recommendations do not activate it.
---

# Echo Dev

This is a main-chat entrypoint. Read the [invocation contract](../../../docs/frontend/echo-workflows.md#invocation-and-chaining) and the [dev contract](../../../docs/frontend/echo-workflows.md#dev).

Pass actual design references and require the role's own
[design and functionality verification](../../../docs/frontend/echo-workflows.md#design-and-functionality-verification).
Use the [test selection policy](../../../docs/frontend/echo-workflows.md#test-selection-policy)
and [default local authorization](../../../docs/frontend/echo-workflows.md#default-local-verification-authorization):
changed/related features only during development, full suite before PR, affected
browser flows at CPU slowdown 4x. Do not request a repeated testing-permission sentence.

1. Require the user's actual invocation naming `echo-dev` for this task, alone or in a named chain. Include that excerpt and task/stage scope in the handoff; otherwise do not dispatch. Skill maintenance, quoted commands and another skill's delegation instructions are not invocation. Then confirm specification approval, implementation authorization, assigned files and test readiness. Accept manually prepared specifications/tests; a previous designer run is not required. Reconcile stale requirements and preserve the starting dirty state.
2. A dev-only request does not invoke QA automatically. If important behavior lacks baseline protection or acceptance tests, report the gap and propose QA prepare; continue only independent preparation. An explicit dev+QA chain permits QA prepare → dev → QA verify and bounded repairs under the shared contract.
3. Prepare the [handoff](../../../docs/frontend/echo-workflows.md#context-and-handoff) with a readable Markdown `spec_path`, its approval/revision, applicable `plan_path`, prepared tests, expected changes, scoped local checks and stop condition. Main materializes approved chat/manual requirements before dispatch. Dispatch only the native named `dev` role through the actual client's [native dispatch](../../../docs/frontend/echo-workflows.md#native-dispatch) adapter, with fresh context and its configured model/effort. Do not change the main model or send another client's configuration fields.
4. If named-role dispatch, fresh context, the role or its model is unavailable, report the blocker. Do not use a generic agent, inline replacement or nested AI CLI.
5. Inspect the returned diff against assigned paths and shared consumers. Require real baseline/new-test results, focused checks, browser evidence when available and explicit limits. Resolve unexpected scope with the user; never accept weaker assertions as a fix.

The dev role implements the entire approved specification with existing components/tokens and applicable Elm/React/regression guidance, read directly from the `.github/skills` paths in its role profile. These existing references do not need discovery aliases. It reads repository [Ponytail](../ponytail/SKILL.md) for minimal implementation without a personal plugin. It uses the repository `make-interfaces-feel-better` only for scoped UI details; its examples do not authorize new dependencies, global styling or redesign. Missing helpers do not replace repository contracts.

For failures, read repository [systematic-debugging](../systematic-debugging/SKILL.md); before reporting results, read [verification-before-completion](../verification-before-completion/SKILL.md). These helpers need no personal Superpowers plugin and retain the assigned commands, baseline and environment approval rules.

Return changed paths, input/revision/dirty-state identity, commands/results, browser observations and unverified work. Stop after a dev-only request. Main dispatches QA only when requested; the child never starts another stage or performs Git/publication/deployment operations.

Return exact task-created `cleanup_paths`; keep handoff documents for QA/repairs.
After implementation and successful same-source QA VERIFY, main removes only
those documents under the [lifecycle](../../../docs/frontend/echo-workflows.md#handoff-document-lifecycle).
Dev completion alone does not trigger cleanup or implicitly invoke QA.
