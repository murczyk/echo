# Using shared design context

This page covers the small context-use loop included with the shared design tools. For an optional task workflow, explicitly invoke [Echo Spec, Designer, Dev or QA](echo-workflows.md); those stages run only when requested, individually or in a named sequence. Spec owns requirements and acceptance criteria; designer uses an approved specification for UX flows, wireframes and design. A compact approved manual brief is sufficient for a small task.

## Start from the same sources

For main Echo web UI work, read [PRODUCT.md](../../PRODUCT.md), [DESIGN.md](../../DESIGN.md), the [layout contract](layout-component-contract.md), and local `AGENTS.md`. The product file records user goals and open questions; the design file points to the existing theme/components. Neither replaces code or behavior contracts.

Use this loop as appropriate to the request: brief → check the scenario and applicable contracts → implement the agreed scope → review against the brief. A brief request stops at the brief; a review request reports findings. Small changes can use a few lines inside the task rather than a separate document.

## Process and verification scope

- Fix a small, understood local bug directly: inspect/reproduce, make the narrow
  repair, run the meaningful affected checks, report the result. Do not start
  roles, a separate specification stage or a handoff-document lifecycle for
  ordinary work. An explicit Echo role invocation still uses its managed workflow.
- During development, select tests for changed features and related features
  affected through shared code. Name files/cases explicitly. Run the full test
  suite only for the pre-PR check or an explicit request; a role finishing or a
  local edit does not trigger it. Required build/type/format checks remain separate.
- Verify the concrete failure at the lowest faithful level; use browser execution
  when scrolling, focus, motion or actual geometry is the failure boundary.
  Follow `CODE_REVIEW.md`; do not add tests merely to mirror styling or helpers.
- Reuse successful evidence only for the same relevant source/dirty state,
  environment and scenarios. Repeat or broaden checks for a change, failure or
  unresolved risk. Dev checks its repair; independent QA exercises the affected
  outcomes itself, without automatically repeating all builds and dev scenarios.
- An implementation or QA request includes necessary checks using installed
  local tooling, synthetic or isolated test-owned data and disposable local
  previews. Affected browser flows use CPU slowdown **4x**, recorded with results.
  Do not ask for a repeated testing-permission sentence. Explicit no-execution
  limits win. This does not authorize installations, external uploads or any
  real-environment mutation; follow `AGENTS.md` for those operations. Configuration
  maintenance and quoted role names do not authorize product verification runs.
- Inspect supplied Figma nodes, screenshots or videos and compare with the
  rendered affected states. Dev and QA each do this when assigned UI work; neither
  delegates that responsibility to the other. Exercise behavior as well as visual
  appearance. Missing access/execution stays explicitly unverified.
- Apply the [motion acceptance gate](../../DESIGN.md#motion-and-state-continuity)
  to changed interactions. Define intended transition, interruption, focus and
  reduced-motion behavior in the brief when relevant; verify the intermediate
  states, not only final layout. A functionality pass does not waive known UX defects.
- Preserve the latest approved scope. Flag requirement gaps instead of inventing
  behavior; superseded or cancelled proposals are not requirements. Validate review
  comments against source and prior decisions before applying a repair.
- When a user cannot see a change, identify the actual URL/running revision before
  diagnosing the implementation. A service restart remains an environment mutation,
  requiring the applicable operation/target approval.

Managed role handoffs use the [Markdown document lifecycle](echo-workflows.md#handoff-document-lifecycle).

## Brief template

```text
User and task:
Route / components / current behavior:
Intended outcome and observable acceptance:
Applicable states, themes, widths, keyboard/focus and persistence:
Motion, interruptions and reduced-motion behavior (when affected):
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
