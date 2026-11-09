# Using shared design context

This page covers the small context-use loop included with the shared design tools. For an optional task workflow, explicitly invoke [Echo Spec, Designer, Dev or QA](echo-workflows.md); those stages run only when requested, individually or in a named sequence. Spec owns requirements and acceptance criteria; designer uses an approved specification for UX flows, wireframes and design. A compact approved manual brief is sufficient for a small task.

## Start from the same sources

For main Echo web UI work, read [PRODUCT.md](../../PRODUCT.md), [DESIGN.md](../../DESIGN.md), the [layout contract](layout-component-contract.md), and local `AGENTS.md`. The product file records user goals and open questions; the design file points to the existing theme/components. Neither replaces code or behavior contracts.

Use this loop as appropriate to the request: brief → check the scenario and applicable contracts → implement the agreed scope → review against the brief. A brief request stops at the brief; a review request reports findings. Small changes can use a few lines inside the task rather than a separate document.

## Brief template

```text
User and task:
Route / components / current behavior:
Intended outcome and observable acceptance:
Applicable states, themes, widths, keyboard/focus and persistence:
Existing components/tokens/contracts to reuse:
Evidence, assumptions, open decisions and verification method:
```

[Design tools](design-tools.md) explains discovery and prerequisites for the explicitly invoked [Echo workflows](echo-workflows.md). Reading the shared context does not activate a workflow.

For an implementation PR, link the brief or include its compact form, state the criterion of success, and attach the relevant verification evidence. If browser checks were unavailable, name the unverified states. A code review, a screenshot, and an observed user task provide different evidence; avoid calling one a substitute for all three.

## Maintain context

Update the relevant context file when a durable product/design decision changes. Keep task history, individual run results, and validation summaries in the task/PR. Propose token changes in the canonical manifest, not in copied scales or generated outputs. Resolve conflicting sources explicitly with their owners instead of silently normalizing legacy UI.

## Pilot measurements

Before trying the shared tools, choose comparable scoped tasks and a quality rubric: user/goal/acceptance, relevant states, reuse of existing contracts/components, and evidence plus unverified areas. Record a baseline using the current process, then repeat with shared context.

Record these in the pilot report or PR, with client/OS/tool versions and failure causes:

- Time from the task description to an accepted brief/review, and corrections needed before acceptance; compare time only when the same rubric is met.
- Successful setup attempts / all attempts.
- Developers with working core context/skills / all team developers, with coverage of each required client/OS combination.
- Checks actually performed, their evidence and unavailable capabilities; distinguish source-only review from rendered interactions.

A two-developer pilot checks onboarding and usefulness; it is not statistical proof of improved product UX. Team-wide acceptance needs actual access checks for the whole team.

For a later UI experiment, use the same role, task, and conditions before and after: successful completions / attempts, median completion time for successful attempts, and errors or backtracking per attempt. Define success and the improvement target from the baseline before changing UI. Page views and heartbeat events do not establish task completion. This iteration adds no product telemetry and makes no claim of measured UX improvement.
