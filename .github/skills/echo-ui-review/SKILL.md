---
name: echo-ui-review
description: Use when an Echo wdintel-web UI change or proposal needs review against its brief, existing design system, or user-visible behavior. Not for backend-only work or separate GOI/docs applications.
---

# Echo UI review

Review the requested change against its intended user outcome and existing contracts. Findings need evidence; an unavailable browser is a verification limit, not a clean visual audit.

## Grounding

Resolve the repository root with `git rev-parse --show-toplevel`; repository paths below are root-relative even when cwd is `wdintel-web` or the skill is loaded through `.agents/skills`.

Read the brief/request, `PRODUCT.md`, `DESIGN.md`, `docs/frontend/layout-component-contract.md`, applicable local `AGENTS.md`, and the relevant behavior contracts in `docs/frontend/react-behavior-contracts/`. Inspect the actual diff or proposal and affected source. A proposal review cannot establish that an implementation exists or works.

Use the relevant `.github/skills/frontend-html-css-accessibility` and `frontend-regression-safety` guidance, plus the affected Elm/React/Power implementation skill. Product Design and Impeccable are optional, never prerequisites for source review.

## Check the affected scenario

- Compare observable behavior with the brief, including relevant loading/empty/error, permissions, keyboard/focus, navigation, feed position, filters, and persistence. Name any missing product decision rather than inventing a requirement.
- Check shared token/component reuse and local ownership boundaries. `tokens.json` is canonical; `DESIGN.md` is descriptive. `theme.echo` does not mean the Echo palette is globally active. Do not change MUI spacing/breakpoints or activate the global palette as a cleanup.
- When browser access exists, inspect the rendered changed scenario at relevant widths/themes and record what was observed. Use synthetic/redacted content for captures. Without the browser, report code findings and explicitly leave rendered contrast, layout, focus behavior, and usability unverified.
- Detector findings are additional evidence. Built-in Impeccable source scans do not cover Elm; a skipped file or empty result does not prove accessibility or UX correctness. Token freshness and builds do not replace rendered or user-task checks.

## Result

Return the highest-impact actionable findings first, each with severity, source path/line or captured evidence, observable impact, and a focused recommendation. Separate confirmed defects from proposals or uncertain concerns; report no findings when none are supported.

Finish with **Verified** and **Unverified / open decisions**. State the evidence actually available: source inspection, commands executed, rendered observations, or user research. Never fabricate screenshots, tests, user evidence, or a passing hook status.

If a draft rule conflicts with canonical tokens, the layout contract, or a local contract, cite both sources and explain the conflict. Report it without silently modifying code, theme, tokens, or ignore rules. A review request alone does not authorize fixes, installs, redesign, or publication.
