# Shape

Echo adaptation of Impeccable's `shape` reference; see [source notice](../NOTICE.md).
Shape UX flows and layout from approved requirements, then return design notes
and the assigned wireframe/design. Specification ownership stays with `echo-spec`
or the manual specification owner. Do not implement the interface.

## Discovery

Read the approved specification, existing source and settled decisions before asking questions.
Ask a small group of related questions whose answers change the result. Continue
only independent analysis while material decisions remain unanswered; label
hypotheses instead of inventing answers. Do not repeat confirmed facts or ask
the owner to choose CSS values.

Resolve the concrete user/task, rather than relying on a broad persona:

- Who reaches this surface, in which situation, and what outcome do they need?
- What is the primary action, and what observable result means success?
- What content, evidence and context must remain visible during that action?
- Which permissions and existing workflows constrain the proposed behavior?
- What do we know from code, what did a person observe, and what needs validation?

Map the specified behavior and boundaries to the design:

- Entry points, navigation, selection and ownership of state; Back, reload and
  returning from another view without losing context.
- Realistic minimum, typical, long and missing content; loading, empty, stale,
  error, retry, cancellation, success and permission states.
- Changes that must remain out of scope, shared consumers and preserved behavior.
- Applicable widths, themes, keyboard/focus, localization and accessibility needs.
- Existing components, tokens and behavior contracts to reuse, with source paths.

## Resolve the layout

Use the established Echo design language. When navigation or placement is still
open, compare a few concrete arrangements against the same task and constraints.
Explain the consequence for scanning, actions, context retention and recovery;
recommend one direction and record the owner's decision.

Use the assigned format and shared Echo output presets for the wireframe/flow.
Keep UX decisions and acceptance-ID mappings in design notes.
Show the drawing when rendering is available; mark unrendered output. Do not
introduce a new visual system or HTML prototype without explicit scope.

## Record design decisions

Describe how the design realizes the approved requirements:

1. Input specification revision/approval, user/task and sources of evidence.
2. Selected UX structure and reasons within the approved scope/non-goals.
3. Existing scenario/acceptance IDs mapped to flows, frames and states.
4. How specified permissions, transitions, validation and recovery appear in UX.
5. Wireframe, relevant variants, reused components and applicable UI constraints.
6. Preserved behavior, affected consumers, existing coverage and meaningful gaps.
7. Owner UX decisions, requirement gaps returned through main, observations and evidence limits.

Keep small tasks compact. Missing or conflicting requirements return to their
owner through main; pause dependent design instead of rewriting the specification.
For the managed designer, follow the workflow's artifact/handoff contract.
Return the design for approval and stop; do not write implementation plans.
