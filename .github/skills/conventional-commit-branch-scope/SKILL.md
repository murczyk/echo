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
- `type(scope): imperative summary`
- Scope parser from branch name:
- Take substring after first `/`.
- From that substring, extract token up to the next `-` group that matches project tag + ticket id shape.
- Recommended regex on substring: `^([a-z]+-\d+)`.
- Example:
- `feature/proj-1234-add-navbar` -> scope `proj-1234`
- If parser fails:
- Use known repo scope convention if present in task context.
- Otherwise omit scope: `type: summary`.
- Keep summary imperative, <=72 chars when feasible.
- Add body only when needed:
- breaking change notes
- migration/deploy instructions
- rationale for non-obvious tradeoff

## Definition of Done (checklist)
- Commit header is valid Conventional Commit.
- Scope follows branch-derived rule when pattern matches.
- Message is concise and imperative.
- User permission requested before actual commit.

## Tiny examples
```txt
Branch: feature/proj-1234-add-navbar
Commit: feat(proj-1234): improve navbar keyboard handling
```

```txt
Branch: hotfix/navbar
Commit: fix: prevent menu from staying open after route change
```

## Self-check
- Re-parse branch name and verify scope extraction.
- Ensure summary matches actual diff, not planned work.
- Confirm no commit/push command is executed without user approval.
- Confirm related changelog update requirement was considered.

## Assumptions
- Branch names usually include a ticket token like `<tag>-<id>` after the first slash.
