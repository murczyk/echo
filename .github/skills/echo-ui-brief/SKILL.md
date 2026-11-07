---
name: echo-ui-brief
description: Use when an Echo wdintel-web UI request needs a concise brief, scope, or acceptance criteria before implementation. Not for backend-only work or separate GOI/docs applications.
---

# Echo UI brief

Prepare a grounded brief for the requested surface. Scale detail to the change; do not turn a small improvement into a redesign or a long interview.

## Grounding

Resolve the repository root with `git rev-parse --show-toplevel`; all repository paths below are relative to that root, regardless of cwd or whether this skill was loaded through `.agents/skills`.

Read `PRODUCT.md`, `DESIGN.md`, `docs/frontend/layout-component-contract.md`, and the applicable local `AGENTS.md`. Inspect the named route/component and only the relevant behavior contracts in `docs/frontend/react-behavior-contracts/`. Derive existing components and behavior from their sources; do not invent user priorities from role names or feature availability.

## Brief

Return a short brief in the current task containing:

- **User and outcome:** the target role, task, and observable user benefit; mark assumptions.
- **Surface and scope:** route/components, current behavior with source paths, requested change, and boundaries.
- **Acceptance:** observable success and relevant loading/empty/error, permission, keyboard/focus, theme, width, long-content, and navigation/persistence states. Include only applicable states; mark new behavior as proposed, and avoid arbitrary numeric thresholds without evidence or an explicit proposal.
- **Reuse:** established components/tokens and the specific implementation/accessibility/regression skill relevant to the change. Reuse `.github/skills/frontend-elm-implementation`, `frontend-react-mui-implementation`, `frontend-html-css-accessibility`, `frontend-regression-safety`, or `power-wrapper-components` as appropriate; keep their rules at their source.
- **Evidence and open questions:** what is known, what needs confirmation, and how it will be checked. Browserless inspection establishes code facts, not rendered usability or visual quality.

For example, an attachment-preview brief should trace the existing MessageCard preview and feed behavior, then specify returning to the originating message and focus where applicable. It should not introduce a new preview architecture by default.

Ask a concise question only if a material decision cannot be derived. Preserve established behavior while that decision is open. Do not start implementation, image generation, a server, installation, or publication merely because a brief was requested. Product Design and Impeccable are optional helpers; neither is required for this output.
