---
name: make-interfaces-feel-better
description: Use when explicitly requested or assigned by the managed Echo dev role for approved interface details using existing components and tokens. It does not authorize a redesign or activate the Echo workflow.
license: MIT
metadata:
  author: Jakub Krehel; Echo adaptation
---

# Make Interfaces Feel Better for Echo

Read the approved specification, `DESIGN.md`, the layout contract and affected
component sources before applying this [pinned Markdown guidance](NOTICE.md).
Use only the reference needed for the assigned UI detail.

## Boundaries before references

- Existing Echo components, Power wrappers, tokens and the approved design take precedence. Fixed upstream colors, sizes, radii, scale factors and timings are examples, not mandatory replacements for project values.
- Preserve Tailwind layout and MUI/Power interaction boundaries. Do not add a styling system, motion/icon/font dependency, global font smoothing or global CSS reset as a polish side effect. No package installation, codemods or auto-updates.
- Keep edits within assigned files and explain shared-consumer impact before expanding scope. New components/variants or visual-language changes need a documented design decision, not an inferred permission from a polish request.
- Prefer no motion for frequent interactions; honor reduced-motion preferences and static feedback. Keep semantic controls, focus, accessible names, contrast and nonoverlapping hit areas. Do not replace the existing icon set just to match stroke examples.
- Do not publish captures or send operational content to external tools. Use synthetic/redacted data in authorized local previews. No subagents, nested AI CLI, Git/release operations or environment changes.
- A source review is not rendered verification. Report unavailable checks honestly; do not claim approval or usability from absence of findings.

## Motion acceptance gate

Apply [DESIGN.md: Motion and state continuity](../../../DESIGN.md#motion-and-state-continuity)
as required acceptance criteria for the affected interaction, not optional polish.
Use the animation/performance references only to realize those criteria; their
sample timings and effects are not a mandate to animate every action. Verify
enter/exit midpoints, rapid interruption, input/focus, stable geometry and reduced
motion in the browser at CPU slowdown 4x. Known flicker, jumping, blocked actions
or lost context prevents a completion claim; missing browser execution stays
unverified. Keep scope and test selection proportional to the change.

| Detail | Reference |
| --- | --- |
| Wrapping and numeric alignment | [Typography](typography.md) |
| Radius, alignment and hit areas | [Surfaces](surfaces.md) |
| Interruptions and motion restraint | [Animations](animations.md) |
| Accessible icon states and direction | [Icons](icons.md) |
| Transition properties and composition | [Performance](performance.md) |

Inspect the actual affected states, relevant themes/widths and keyboard/reduced
motion behavior with available browser control. Return changed/proposed paths,
the user-visible benefit, checks performed and unverified states. This helper
does not expand the assigned implementation or replace QA/owner acceptance.
