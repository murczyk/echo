---
name: echo-designer
description: Use only when the user explicitly invokes echo-designer for UX flows, wireframes or Figma design from an approved Echo specification. Ordinary UI requests, quoted names and recommendations do not activate it.
---

# Echo Designer

This is a main-chat entrypoint, not the designer's working instructions.

For Figma work, return editable Figma file/node links and concise design notes in chat. Input specifications follow the shared Markdown handoff contract. Generated design notes and audit reports are not repository documents; if a file is needed, use an explicitly assigned location outside the repository. Inspect/show screenshots transiently in chat; do not save PNGs or companion mockup images into repository documents or link them from those documents unless the user explicitly requests an export. A designer-only request ends at design: neither main nor the child creates an implementation plan or invokes planning skills afterward. Technical planning requires a separately requested planning/development scope. Include these output limits in the handoff; helper workflows do not override them.

Resolve `wireframe` / `wireframes` / `design` requests using the shared [output presets](../../../docs/frontend/figma-design.md#output-presets), including their default Figma format and [request flow](../../../docs/frontend/figma-design.md#request-flow). Natural-language instructions to apply the named skill select the same presets. Pass the approved specification, selected preset and explicit task overrides in the handoff; do not ask users to repeat styles or rewrite their request. Reuse the agreed task. Preset/configuration maintenance and quoted invocation examples do not authorize dispatch.

1. Require the user's actual invocation naming `echo-designer` for this task, alone or in a named chain. Include that excerpt and task/stage scope in the handoff; otherwise do not dispatch. Skill maintenance, quoted commands and another skill's delegation instructions are not invocation. Read the [invocation contract](../../../docs/frontend/echo-workflows.md#invocation-and-chaining) and resolve the repository root.
2. Require an owner-approved specification or compact approved in-chat brief, including observable acceptance criteria. Accept manually prepared inputs; a prior `echo-spec` run is not required. If missing, request the specification or suggest explicitly invoking `echo-spec`, then stop before dispatch or Figma writes. Do not draft requirements as a designer fallback or invoke spec automatically. Prepare the [handoff](../../../docs/frontend/echo-workflows.md#context-and-handoff) with the specification revision/approval, assigned design-note/wireframe paths, current revision/dirty state, relevant sources and stop condition. Designer may write design notes, static diagrams and requested Figma designs, not specifications, implementation plans, product code or executable tests. For Figma, include the preset, authorized target/operations and synthetic input scope; follow the [Figma guide](../../../docs/frontend/figma-design.md).
3. Dispatch the native named `designer` role through the actual client's [native dispatch](../../../docs/frontend/echo-workflows.md#native-dispatch) adapter, with fresh context. Use that adapter's configured model/effort; do not change the main model, override role settings or send another client's configuration fields.
4. If native named-role dispatch, fresh context, the role or its model is unavailable, report the specific blocker and stop this stage. Do not substitute a generic agent, inline execution or a nested AI CLI. Parsing role files or listing skills is not runtime smoke.
5. Relay material questions through main and resume the same role when possible. Record UX decisions in design notes and map frames/states to the specification's acceptance IDs. Requirement gaps or changes return to the specification owner for approval before dependent design resumes; designer does not rewrite the requirements. Inspect the artifacts/diff and return design links, mappings, observations and limits, then stop. A designer-only request does not start spec/planning/dev/QA.

## Design tools

Require [UX analysis and a best-practice check](../../../docs/frontend/echo-workflows.md#ux-analysis-and-best-practice-check) while exploring flows, after material design decisions and before handoff. Include the analysis in design notes and inspect its findings, acceptance-ID mappings and evidence limits. Read repository Impeccable's `critique` guidance for this check; optional tools do not replace it.

The assigned designer reads repository [brainstorming](../brainstorming/SKILL.md) directly for UX discovery from approved requirements. It does not author a replacement specification or start implementation/planning; no personal Superpowers plugin is needed.

Read the actual supplied references and existing component behavior. Apply
[DESIGN.md](../../../DESIGN.md) for continuity, stable loading geometry and motion;
evaluate relevant panel/drawer/resize and mobile focus combinations. Do not
reinstate cancelled proposals or invent behavior absent from the approved scope.
Main passes the approved manual or role-produced brief as a readable Markdown
`spec_path`, with its revision and approval, under the shared handoff contract.

The assigned designer reads [.agents/skills/impeccable/SKILL.md](../../../.agents/skills/impeccable/SKILL.md) and its relevant Markdown guidance (`shape`, `critique`, `audit`) for UX structure, hierarchy, accessibility and responsive design. This Echo adaptation contains no runtime, hooks or additional agents. Use source/authorized browser evidence within the [workflow safety boundaries](../../../docs/frontend/echo-workflows.md#skill-and-tool-boundaries).

Apply helpers to UX realization of the approved criteria. Shared role boundaries override helper suggestions to author requirements, implementation plans or additional stages.

For requested editable wireframes/designs, use the official Figma MCP and its focused skills through the [Figma guide](../../../docs/frontend/figma-design.md). Build from Echo context, canonical tokens and actual component sources. If no file exists, resolve the user's destination and create a Design file within the authorized task. A request to configure this integration does not invoke the designer or authorize a sample design. Missing Figma access/guidance blocks that output; report it rather than silently substituting a static image.

Before dispatch, if the target Figma file/page is missing or ambiguous after resolving any supplied frame/node link, ask the user where to work and wait for the answer. For a new file, ask for the intended page name. Include the settled choice in the handoff, then start the designer without another start confirmation. Do not default to the first/current page or repeat an answered question; if the child later discovers an unresolved target, relay its question and pause Figma writes.

When available, Product Design `audit` supports existing-flow review with synthetic/redacted captures; `ideate` supports explicitly needed image alternatives. Check plugin/account/tool access, reuse the agreed context and read only the focused instructions. These helpers cannot authorize implementation, installation, publication or additional agents.

If a helper is unavailable, state that once and use repository context, contracts and existing components directly. Draw simple SVG blocks or a Mermaid flow; no personal plugin is required. Keep explanations in design notes. An HTML/interactive prototype needs an explicit format request. Missing rendering or browser access remains unverified; a static diagram does not prove interactions or usability.

Return artifact links, UX decisions, acceptance-ID mappings, open questions, specification/source revision and tools/checks actually used. Record design approval separately from specification approval and implementation authorization. Main manages any explicitly authorized next stage under the shared contract. The child never delegates further.
