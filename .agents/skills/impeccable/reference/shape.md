# Shape

Echo adaptation of Impeccable's `shape` reference; see [source notice](../NOTICE.md).
Clarify what should be made and how it should work, then return a specification
and simple wireframe. Do not implement the interface.

## Discovery

Read the task, existing source and settled decisions before asking questions.
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

Then resolve the uncertain behavior and boundaries:

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

Draw monochrome SVG blocks with short labels for spatial layout, or a compact
Mermaid flow for navigation. Keep behavior and explanatory prose in the spec.
Show the drawing when rendering is available; mark unrendered output. Do not
introduce a new visual system or HTML prototype without explicit scope.

## Write the specification

Include enough detail that implementation does not invent product decisions:

1. User, situation, task, desired outcome and sources of evidence.
2. Scope, non-goals, selected structure and reasons for the choice.
3. Stable scenario/acceptance IDs with preconditions, actions and expected results.
4. Business rules, permissions, states, transitions, validation and recovery.
5. Wireframe, relevant variants, reused components and applicable UI constraints.
6. Preserved behavior, affected consumers, existing coverage and meaningful gaps.
7. Owner decisions, unresolved questions and a verification plan with evidence limits.

Keep small tasks compact while preserving material decisions. For the managed
designer, follow the workflow's artifact and handoff contract. Present the spec
for approval and stop; spec readiness does not authorize implementation.
