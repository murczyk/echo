---
name: ponytail
description: Use when explicitly requested or assigned by the managed Echo dev role for implementation, bug fixes or refactoring within an approved scope. Ordinary requests do not activate the Echo workflow.
license: MIT
metadata:
  author: DietrichGebert; Echo adaptation
---

# Ponytail for Echo

Choose the simplest complete solution after understanding the task and its
shared consumers. This [pinned adaptation](NOTICE.md) is self-contained Markdown;
it needs no personal plugin, router or runtime.

## Scope before shortcuts

Read `AGENTS.md`, `CODE_REVIEW.md`, the approved specification and the owning
contracts. They take precedence over generic simplification advice. Preserve
the full requested behavior, permissions, validation, error handling, accessibility
and required checks. A smaller diff that leaves the task incomplete is not simpler.

For main Echo UI, preserve existing Power components, tokens and the layout
contract. A native control is not a replacement for an established wrapper merely
because it uses fewer lines. Do not add dependencies or global styling to simplify
one local change.

This helper does not invoke Echo stages, delegate, install tools, publish data,
change environments or authorize Git/release operations. It applies within the
assigned task; it does not create a session-wide mode or override the requested
output format and evidence requirements. Managed dev reads this repository file
directly, even when a personal skill has the same name.

## The ladder

Stop at the first option that satisfies the approved behavior:

1. Omit speculative work outside the requested scope.
2. Reuse an existing repository helper, type, component or pattern.
3. Use the standard library.
4. Use a native platform feature compatible with the owning contract.
5. Reuse an installed dependency before considering a new one.
6. Write the smallest clear implementation that handles the real cases.

Trace the affected flow and callers before choosing a shortcut. Fix a bug at its
shared cause when appropriate; do not patch one symptom while leaving sibling
callers broken. Keep unrelated behavior and other people's changes intact.

Avoid speculative abstractions, one-implementation interfaces, one-product
factories, unused configuration and scaffolding for later. Prefer deletion and
boring readable code over compressed expressions that hide important behavior.
Do not rename or refactor adjacent code just to shorten it.

## Intensity

Use `full` unless the task explicitly selects `lite` or `ultra`:

| Level | Application within the approved scope |
| --- | --- |
| `lite` | Implement the request; mention a materially simpler alternative when useful. |
| `full` | Apply the ladder and keep the smallest complete change. |
| `ultra` | Challenge speculative additions and remove unnecessary complexity; still deliver every explicit requirement. |

Example: before adding a custom cache, check whether an existing cache or bounded
standard-library primitive covers the required lifetime, invalidation and
concurrency behavior. Do not add a cache without a demonstrated need, or silently
replace an explicitly required cache policy with a different one.

## Verification and handoff

Use the project's existing checks and the test categories in `CODE_REVIEW.md`.
Do not add a demo self-check or a test for every helper merely to satisfy generic
Ponytail advice. Preserve meaningful regression, authorization, migration,
concurrency and data-integrity coverage; never weaken tests to obtain green.

Mark a deliberate shortcut with a `ponytail:` comment only when it accepts a real
known ceiling; name that ceiling and the condition for revisiting it. Do not add
comments for ordinary straightforward code.

Keep the result concise while returning the assigned changed paths, checks and
evidence limits. Report missing dependencies or unverified behavior honestly;
brevity does not replace the managed role's handoff contract.
