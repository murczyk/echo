# Plan Template

## Introduction

Use this file as a temporary working plan for tasks that need visible tracking, reviewable assumptions, or deferred decisions.

Replace 'Plan Template` title in this document with a brief description of the work you intend to do.

Then delete Introduction segment of this document, we don't need it anymore.
You must the HOWTO section though, it's an instruction on how to work with the plan file next.

## HOWTO

Keep implementation work in `Open Items` as a checkbox list. Check items as they are completed, add new items when new required work appears, and remove the plan file once all items are complete and there are no unresolved questions.
Put any blocking or review-needed questions in `QnA`; add your suggested answers. If a question is answered, fold the answer back into `Open Items` as concrete work or a concrete decision, then remove the answered question. Do not delete the plan file while `QnA` still has unresolved questions. If all QnA items are resolved and there are still some Open Items - start implementing those items; if some questions arise durins the implementation so you're blocked with the solution of a current open item - pause the execution and ask user to answer them.
Example `Open Items` usage:
- [ ] Add a focused regression test for the failing scenario.
- [ ] Implement the smallest code change that satisfies the test.
- [x] Confirm the relevant helper already handles empty input.
Example `QnA` usage:
- [ ] Should the migration backfill old rows or only affect new rows?
  - Suggested answer: backfill old rows if the user-facing UI depends on consistent historical data.

## Open Items

## QnA
