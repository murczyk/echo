# Audit

Echo adaptation of Impeccable's web `audit` reference; see [source notice](../NOTICE.md).
Inspect technical UI risks in the assigned surface and report evidence. This is
a source/browser review, not a bundled detector run or permission to fix code.

## Check relevant dimensions

### Accessibility

- Native semantics, accessible names, labels, headings, landmarks and useful
  alternative text; interactive elements must behave like their declared role.
- Keyboard navigation, visible focus, focus order and restoration, Escape,
  modal boundaries, errors and recovery without a pointer.
- Foreground/background combinations in actual states and themes. Measure
  contrast when tooling is available; a token's existence does not prove contrast.
- Motion sensitivity, reduced-motion behavior and feedback that does not rely
  solely on color or animation.
- Form instructions, validation messages, state announcements and zoom/reflow.

### Performance

- Evidence of unnecessary layout reads/writes, expensive effects, unbounded
  rendering, unnecessary imports or oversized assets on the affected path.
- Loading and rendering behavior with representative content density and size.
- Existing hot-path contracts; do not prescribe memoization or broad optimization
  without a concrete cause and appropriate measurement.

### Theming and consistency

- Existing semantic tokens, light/dark states, hover/focus/disabled/selected
  states and compatibility with Echo's existing MUI theme behavior.
- Approved components and variants, Tailwind/layout ownership and shared consumers.
- Hard-coded values that introduce drift; distinguish a real deviation from a
  documented compatibility value or a permitted local exception.

### Responsive behavior

- Narrow/wide layouts, long text, overflow, wrapping, scrolling and zoom.
- Touch target size/spacing, nonoverlapping hit areas and alternatives to hover.
- Pointer/touch cancellation, lost capture, drag behavior and preservation of
  page scroll where applicable. An emulated viewport proves layout, not gestures.
- State retention when layout changes, a panel opens/closes or navigation returns.

### Implementation integrity

- API errors reach the user and recovery retains useful input/context.
- Visible permissions agree with server authorization; mocked UI checks cannot
  establish persistence or backend access control.
- Meaningful behavior coverage for the affected scope and shared components.
- Consistent rules for loading, empty, stale, denied and error states.

## Evidence and output

Use existing source/test artifacts and an already available authorized preview.
The designer does not run tests/builds or start services; execution in another
assigned role remains subject to that role's allowed commands and stage.
Missing capabilities stay unverified; do not install or fetch a detector.

Report each issue with severity, scenario/state, source or observation, user
impact and a scoped recommendation. Cite an applicable accessibility criterion
only when verified. Do not infer full compliance, performance gains or task
usability from a screenshot, a numeric score or absence of findings.

Record the inspected revision, environment/API mode, widths/themes, tools and
unverified checks. Preserve stronger existing evidence and useful behavior.
Return findings and coverage gaps, then stop without applying fixes or invoking
unavailable upstream commands.
