---
name: systematic-debugging
description: Use when explicitly requested or assigned by the managed Echo dev or QA role to investigate a bug, test failure or unexpected behavior within its authorized scope.
license: MIT
metadata:
  author: Jesse Vincent; Echo adaptation
---

# Systematic Debugging for Echo

Investigate the cause before changing behavior. This self-contained
[adaptation](NOTICE.md) needs no personal plugin or additional debugging skills.
Read `AGENTS.md`, `CODE_REVIEW.md`, the assigned criteria and owning contracts.

## Investigate before fixing

1. Read the exact failure, trace, revision and starting dirty diff. Record the
   relevant command, exit code, environment/API mode and reproduction steps.
2. Reproduce with an existing focused check or an authorized temporary example.
   If reproduction is unavailable or intermittent, gather evidence and state the
   uncertainty. Missing setup, credentials or browsers are environment failures,
   not proof of a product regression.
3. Inspect recent changes, callers, shared consumers and comparable working code.
   Trace the unexpected value backward through the affected boundaries to where
   the behavior first diverges. A familiar symptom is not a confirmed cause.
4. State one concrete hypothesis and the evidence supporting it. Choose the
   smallest authorized check that can distinguish it from alternatives; change
   one factor at a time. A failed check calls for revising the hypothesis, not
   stacking speculative fixes.

Use existing logs/configuration evidence first. Add local diagnostics only within
assigned write/command permissions, with synthetic or redacted data. Never print
secrets or operational content. Investigation does not authorize dependency
installation, service startup, external uploads or live changes. Even a health
check that writes metadata needs the real-environment approval in `AGENTS.md`.

## Act within the assigned role

| Assignment | Permitted response to a confirmed cause |
| --- | --- |
| `dev` | Reproduce the failure, satisfy the workflow's baseline requirements, fix the shared cause within assigned product paths, then rerun affected checks. |
| `qa prepare` | Prepare meaningful tests/fixtures in assigned paths; run only authorized commands. Return gaps and readiness to main. |
| `qa verify` | Report the defect and evidence to main; use only an allowed temporary reproduction, not product edits or permanent test/assertion changes. |

A QA-only request does not authorize a repair loop. Material changes to scope,
criteria or tests return through main. Dev stops dependent edits when a required
baseline cannot run. No role delegates or starts another stage through this helper.

For example, when a drawer loses input after a settings response, trace the state
update and shared callers before adding a timeout or disabling the response.
Verify the identified overwrite and preserved neighboring behavior rather than
making a screenshot look correct.

## Verify and stop

Use the existing test environment and meaningful categories in `CODE_REVIEW.md`;
no mandatory test per helper or new framework follows from this skill. Preserve
stronger coverage, assertions and `@regression` title tags. Do not hide a failure
with skips, retries, force clicks, arbitrary waits or a mock replacing its real
boundary. Apply repository [verification-before-completion](../verification-before-completion/SKILL.md)
before reporting success.

After three unsuccessful repair cycles for the same defect, stop and return the
evidence, failed hypotheses and diagnosis/options through main. Do not assume
that repeated failures prove an architectural defect or authorize a redesign.
If evidence points to an external/environment cause, report that limit and the
next useful check; a timeout/retry change still needs evidence and scope.

Return reproduction, expected/actual behavior, source/revision, commands/results,
findings and remaining uncertainty. No Git mutation, release operation or
real-environment mutation is authorized by a debugging request alone.
