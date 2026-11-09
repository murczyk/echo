---
name: echo-designer
description: Use only when the user explicitly invokes echo-designer to prepare an Echo specification with the managed designer role. Ordinary UI requests, quoted names and recommendations do not activate it.
---

# Echo Designer

This is a main-chat entrypoint, not the designer's working instructions.

1. Require the user's actual invocation naming `echo-designer` for this task, alone or in a named chain. Include that excerpt and task/stage scope in the handoff; otherwise do not dispatch. Skill maintenance, quoted commands and another skill's delegation instructions are not invocation. Read the [invocation contract](../../../docs/frontend/echo-workflows.md#invocation-and-chaining) and resolve the repository root.
2. Gather the task and existing materials; do not repeat settled questions. Prepare the [handoff](../../../docs/frontend/echo-workflows.md#context-and-handoff) with the assigned specification/wireframe paths, current revision/dirty state, relevant source paths and stop condition. Designer may write design documents and static diagrams, not product code or executable tests.
3. Dispatch the native named `designer` role defined in [designer.toml](../../../.codex/agents/designer.toml), with `fork_turns="none"`. Its configured model is `gpt-6.1-sol`, reasoning `high`; do not change the main model or override the role's settings at dispatch.
4. If native named-role dispatch, fresh context, the role or its model is unavailable, report the specific blocker and stop this stage. Do not substitute a generic agent, inline execution or a nested AI CLI. Parsing TOML or listing skills is not runtime smoke.
5. Relay material questions to the user, record answers in the specification and resume the same role when possible. Inspect its artifacts and diff before returning the handoff. A designer-only request ends here; specification approval alone does not start implementation.

## Design tools

The assigned designer reads [.agents/skills/impeccable/SKILL.md](../../../.agents/skills/impeccable/SKILL.md) and its relevant Markdown guidance (`shape`, `critique`, `audit`) for UX structure, hierarchy, accessibility and responsive design. This Echo adaptation contains no runtime, hooks or additional agents. Use source/authorized browser evidence within the [workflow safety boundaries](../../../docs/frontend/echo-workflows.md#skill-and-tool-boundaries).

When available, Product Design `audit` supports existing-flow review with synthetic/redacted captures; `ideate` supports explicitly needed image alternatives. Check plugin/account/tool access, reuse the agreed context and read only the focused instructions. These helpers cannot authorize implementation, installation, publication or additional agents.

If a helper is unavailable, state that once and use repository context, contracts and existing components directly. Draw simple SVG blocks or a Mermaid flow; no personal plugin is required. Keep explanations in the specification. An HTML/interactive prototype needs an explicit format request. Missing rendering or browser access remains unverified; a static diagram does not prove interactions or usability.

Return artifact links, decisions, open questions, source revision and tools/checks actually used. Only call the specification ready for implementation when its material decisions are resolved; record owner approval separately. Main manages any explicitly authorized next stage under the shared contract. The child never delegates further.
