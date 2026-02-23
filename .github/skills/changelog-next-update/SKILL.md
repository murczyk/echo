---
name: changelog-next-update
description: Update CHANGELOG.md in this repo by adding concise user-facing entries under NEXT only, preserving existing format and ordering.
---

# Changelog NEXT Update

## Short description (for triggering)
Use when a task includes user-visible changes and requires updating `CHANGELOG.md`.

## When to use / When NOT to use
- Use: Feature, fix, UX, or deployment-impacting changes that should be announced.
- Do not use: Internal-only refactors with no user-visible effect unless requested.

## Inputs the agent should request or derive
- Derive ticket/scope from branch or issue link.
- Prefer parsing branch first:
- project + number token (for example `ABC-123`) when present
- otherwise number-only token (for example `123`)
- Derive user-visible impact from diff.
- Derive existing `NEXT` formatting from top of `CHANGELOG.md`.

## Procedure (checklist)
- Open `CHANGELOG.md` and find `## NEXT`.
- Add new entry only in `NEXT`.
- Preserve the existing style exactly:
- one-line bullets
- issue reference style (`[#1234](...)`) when available
- existing markers (`✅`, `🐞`, `👷`, `🚨`) when applicable
- Keep entry user-facing and concise.
- If branch provides `ABC-123`, use the numeric issue part for GitHub issue links unless task context explicitly indicates another tracker mapping.
- If categories exist in current `NEXT` format (Added/Changed/Fixed), place in correct category.
- Do not reorder old dated sections.
- Keep deployment/manual action notes explicit when needed.

## Definition of Done (checklist)
- Entry is under `## NEXT` only.
- Existing formatting and ordering are preserved.
- Entry is understandable for end users.
- Scope/ticket reference is included when available.

## Tiny examples
```txt
- [#1930](.../1930) ✅ Навігація: покращено keyboard та focus поведінку меню.
```

## Self-check
- Confirm no edits were made outside `NEXT` except minimal spacing.
- Confirm entry reflects actual shipped behavior from diff.
- Confirm API/UX side effects mentioned when relevant.
- Confirm commit scope/ticket alignment if commit skill is also used.

## Assumptions
- Current repository uses `NEXT` as a rolling unreleased section and keeps older dated sections immutable.
