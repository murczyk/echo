---
name: conventional-commit-branch-scope
description: Compose Conventional Commit messages with scope derived from the current branch naming pattern, while respecting this repo rule to ask before git commit/push.
---

# Conventional Commit Branch Scope

## Short description (for triggering)
Use when preparing commit messages for this repo.

## When to use / When NOT to use
- Use: Any request to draft or perform a commit.
- Do not use: Code implementation with no commit preparation.

## Inputs the agent should request or derive
- Derive current branch name via `git branch --show-current`.
- Derive commit type from change intent (`feat`, `fix`, `refactor`, `docs`, `test`, `chore`).
- Derive scope from branch parser below.

## Procedure (checklist)
- Respect repo git rule:
- Never run `git commit` or `git push` without explicit user permission.
- Build header:
- `type(scope): past-simple summary`
- Scope parser from branch name:
- Take substring after first `/`.
- From that substring, extract ticket token:
- project tag + ticket id (for example `proj-1234` or `ABC-1234`) when present
- otherwise number-only token (for example `1234`)
- Recommended regex on substring (case-insensitive): `^(([a-z]+-\d+)|(\d+))`
- Example:
- `feature/proj-1234-add-navbar` -> scope `proj-1234`
- `feature/1234-add-navbar` -> scope `1234`
- If parser fails:
- Use known repo scope convention if present in task context.
- Otherwise omit scope: `type: summary`.
- Keep summary in past simple (for example `added`, `fixed`, `updated`), <=72 chars when feasible.
- Add body only when needed:
- breaking change notes
- migration/deploy instructions
- rationale for non-obvious tradeoff

## Definition of Done (checklist)
- Commit header is valid Conventional Commit.
- Scope follows branch-derived rule when pattern matches.
- Message is concise and uses past-simple wording.
- User permission requested before actual commit.

## Tiny examples
```txt
Branch: feature/proj-1234-add-navbar
Commit: feat(proj-1234): improved navbar keyboard handling
```

```txt
Branch: hotfix/navbar
Commit: fix: prevented menu from staying open after route change
```

## Self-check
- Re-parse branch name and verify scope extraction.
- Ensure summary matches actual diff, not planned work.
- Ensure summary tense is past simple, not imperative/present.
- Confirm no commit/push command is executed without user approval.
- Confirm related changelog update requirement was considered.

## Assumptions
- Branch names usually include a ticket token like `<tag>-<id>` after the first slash.
