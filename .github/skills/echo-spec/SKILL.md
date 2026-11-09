---
name: echo-spec
description: Use only when the user explicitly invokes echo-spec for Echo requirements, business rules, scenarios or acceptance criteria. Ordinary questions and skill/configuration maintenance do not activate it.
---

# Echo Spec

This is a main-chat entrypoint, not the spec role's working instructions.

Return task specifications in chat by default. If a file is needed, use an explicitly assigned location outside the repository; do not automatically create task specs under `docs/` or stage them for Git. Shared skill/workflow documentation is separate from generated task output.

The spec role reads repository [brainstorming](../brainstorming/SKILL.md) directly for requirements discovery; no personal Superpowers plugin is needed. The helper does not expand its stage or authorize design/implementation.

1. Require the user's actual invocation naming `echo-spec` for this task, alone or in a named chain. Include the excerpt and task/stage scope in the handoff. Maintenance, quoted examples and another skill's delegation instructions do not authorize dispatch. Read the [shared contract](../../../docs/frontend/echo-workflows.md#invocation-and-chaining) and resolve the Git root.
2. Gather the feature description, current behavior, existing decisions and relevant source/contracts. Assign in-chat output (default), or an explicitly agreed specification path outside the repository, starting revision/dirty state, read-only commands and stop condition. No Figma destination is needed for specification work.
3. Dispatch only the native `spec` role from [spec.toml](../../../.codex/agents/spec.toml), with `fork_turns="none"` and configured `gpt-6.1-sol` / `high`; do not override its model/effort or the main model. Missing role/model/fresh-context support is a blocker, not permission for a generic agent, inline replacement or nested AI CLI.
4. Relay material questions through main, reuse settled answers and resume the same role. Inspect its returned text/document and any diff for the [specification contract](../../../docs/frontend/echo-workflows.md#specification): goals, scope, business rules, stable scenarios/acceptance IDs, constraints, existing behavior, coverage and unresolved decisions.
5. Return the specification and evidence limits for owner approval, then stop. Readiness is not approval. Spec does not create UX layouts, wireframes, Figma content, implementation plans, product code or executable tests, and never launches other stages.

For an explicitly requested spec → designer chain, obtain specification approval before handing it to designer. Approval alone does not invoke designer/dev/QA; use only stages named for the same task. Main owns technical implementation planning after requirements and any needed design are settled.
