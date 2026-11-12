---
name: brainstorming
description: Use when explicitly requested or assigned by the managed Echo spec or designer role to clarify requirements or explore UX choices within its stage. Ordinary requests do not activate Echo roles.
license: MIT
metadata:
  author: Jesse Vincent; Echo adaptation
---

# Brainstorming for Echo

Understand the user outcome before proposing a solution. This self-contained
[adaptation](NOTICE.md) supports the assigned stage; it needs no personal plugin.
Read `AGENTS.md`, the relevant source/contracts and the settled task context first.

## Keep the stage

| Assignment | Work and stopping point |
| --- | --- |
| `spec` | Clarify requirements, business rules, scenarios and observable acceptance criteria; return the specification for owner approval. |
| `designer` | Explore UX flows and layout from an approved specification or approved manual brief; return design decisions and artifacts for the required approval. |

Designer preserves requirement ownership: missing or conflicting acceptance
criteria go through main to the specification owner. Do not write a replacement
specification. Spec does not make wireframes or visual design decisions unless
the owner has already fixed them as requirements.

This helper does not invoke roles, delegate, write implementation plans, edit
product code/tests, run builds, start previews or perform Git/release operations.
Implementation and later stages require their existing authorization under
`docs/frontend/echo-workflows.md`; readiness is not approval. For a requested
Figma deliverable, use the existing destination and tool rules, not an automatic
browser companion or upload.

## Clarify only what matters

1. Read the task, current behavior and prior decisions before asking questions.
   Main UI uses `PRODUCT.md`, `DESIGN.md`, the layout contract and owning behavior
   contracts; do not apply those rules to GOI/docs by analogy.
2. Identify the user, task, intended outcome, preserved behavior and scope.
   Check permissions, state ownership, persistence, navigation, validation,
   errors/recovery and applicable accessibility, widths and themes.
3. Separate confirmed facts, owner decisions and hypotheses. Ask through main
   only about unresolved choices that materially change the result. Reuse settled
   answers; a clear small task needs no invented questionnaire or approval round.
4. Continue independent analysis while a material answer is pending. Pause the
   dependent scope rather than inventing requirements or treating silence as consent.
5. Compare alternatives only for a real open choice: state their consequences,
   recommend one and record the owner's decision. Spec compares business scope
   and behavior; designer compares UX arrangements within the approved behavior.

For example, if the approved flow requires a draft to survive cancellation,
designer can compare drawer and inline editing while preserving that rule.
An unspecified persistence rule returns to its owner instead of being decided
through a layout choice.

## Return the assigned result

Keep a small task compact. Preserve stable scenario/acceptance IDs and cite actual
source and coverage paths; distinguish existing, planned and executed checks.
Spec returns requirements/open questions; designer maps approved criteria to
flows, states, reused components and UX decisions. Source review and static
drawings do not establish rendered behavior or usability.

Return task output in chat, or an explicitly assigned location outside the
repository. Do not create or commit task design/spec documents under `docs/`.
Report evidence limits and unresolved decisions, then stop at the assigned stage.
