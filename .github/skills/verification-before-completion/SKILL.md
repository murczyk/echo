---
name: verification-before-completion
description: Use when explicitly requested or assigned by the managed Echo dev or QA role before reporting implementation, test preparation or verification complete, fixed or passing.
license: MIT
metadata:
  author: Jesse Vincent; Echo adaptation
---

# Verification Before Completion for Echo

Match each claim to observed evidence. This self-contained
[adaptation](NOTICE.md) needs no personal plugin or other verification skills.
Read `AGENTS.md`, `CODE_REVIEW.md`, the assigned criteria and owning contracts.

## Check the claim

1. Identify the exact result and the evidence that can establish it. Record the
   revision, relevant staged/unstaged/untracked changes, environment/API mode,
   scenarios and permitted commands.
2. Inspect the actual files and shared consumers against the criteria. A dev
   report, generated artifact or configured command alone is not a verified result.
3. Run the applicable authorized checks to completion and inspect their output,
   exit code and failures. Do not turn command discovery, `--list`, a partial run
   or an environment/setup failure into passing evidence.
4. Report pass, fail or not-run per criterion, including exact commands, material
   failures and evidence limits. A passing check supports only the boundary and
   scenarios it actually exercises.

| Claim | Required evidence |
| --- | --- |
| Tests/build/lint passed | Completed relevant command and inspected result for the identified source state. |
| Bug fixed | The original failure is reproduced, the scoped fix removes it, and affected preserved behavior is checked. |
| Requirements met | Criteria mapped to observed outcomes; tests alone do not establish every UX/business criterion. |
| Tests prepared | Actual test/fixture files and a coverage map; mark execution not-run if unauthorized or unavailable. |
| Native role/tool works | Actual authorized dispatch/tool evidence; valid TOML, metadata or source review alone is insufficient. |

For example, Playwright `--list` finding a regression confirms selection, not
that its interactions pass. A mocked successful API response does not establish
server permissions or persistence; screenshots do not establish keyboard behavior.

## Keep verification proportional and authorized

Select checks from the affected behavior and repository contracts. Use the
existing build/type/lint/test commands where applicable; follow `CODE_REVIEW.md`
instead of adding a test for every helper. Affected Playwright suites must execute
and pass before merge; discovery and unrelated passing suites do not replace them.
Full E2E/final acceptance retains the workflow's separate scope/environment gate.

Reuse prior evidence only when its source/dirty state, environment and scenarios
still match. After a fix, rerun affected checks; broaden or repeat only for a
concrete change, failure or unresolved concern. Never quietly reuse stale green
results, hide a failure or weaken assertions to make a completion claim.

Verification does not authorize installation, service startup, live sessions,
health-metadata writes, deployment or other environment mutations. If a required
check cannot run, state the exact blocker and unverified result; continue only
independent authorized work. Do not bypass the approval rules in `AGENTS.md`.

## Respect the role and return evidence

Dev performs scoped self-checks and fixes within its authorization. QA prepare
writes assigned tests/fixtures and executes only permitted commands. QA verify
reports defects to main without product or permanent test/assertion edits.
Prepared tests, self-checks, QA verification and human acceptance are distinct.
This helper never delegates, starts another role or authorizes a repair loop,
Git mutation, release or publication.

Return the assigned paths/diff, criteria outcomes, commands/results, source and
environment identity, relevant captures and remaining gaps. Keep sensitive logs
out of chat and use only assigned synthetic/redacted artifact locations. A
limited result can be complete for its assigned stage while runtime or human
acceptance remains explicitly unverified.
