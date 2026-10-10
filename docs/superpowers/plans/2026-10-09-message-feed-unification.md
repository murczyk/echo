# Message Feed Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One feed component and one viewport core for Duty and Analysis without changing their current behavior.

**Architecture:** Extract the Duty mechanism as the shared core's foundation, adding configuration for initial positioning, follow, and viewport preservation. Move Analysis focus/spacer/page alignment capabilities into this core. Hosts retain their own data lifecycles and card actions.

**Tech Stack:** React, TypeScript, native DOM/CSS, Vitest, Playwright; no new virtualization library.

**Spec:** [message-feed-unification-design.md](../../frontend/message-feed-unification-design.md).

## Global Constraints

- Duty: order by `(created_at, id)`, newest at the bottom, maximum 40 cards per feed.
- Analysis: page size 20, both sort orders and time bases, page accumulation.
- Before extraction, obtain a green E2E baseline or explain and fix its failures.
- Do not change polling, buffers, unread tracking, filters, URLs, card actions, or API contracts in a structural commit.
- Do not add MUI to repeated native list structure; do not add dependencies.
- Do not create a shared component that merely selects the old Duty/Analysis engine.
- New Duty copy-link behavior and search/Important/replies/mentions belong to a separate subsequent stage.
- Commit/push only with user permission; do not format unchanged files.

## Review Focus

1. Settings and the first inbox response arrive in different orders: manual reading must not restart initial landing.
2. Card height changes due to wrapping/media/editor: the reading anchor and target do not jump.
3. An old request/animation completes after reset/unmount: it neither alters the new feed nor leaves a spinner running.
4. Physical bottom and UI bottom differ: the 25px threshold must not enable automatic follow on its own.
5. Analysis newest-first reverses chronological direction: above/below load the correct data without duplication.

---

## Task 1: Baseline and Characterization Coverage Gaps

**Files:**
- Test: `wdintel-web/tests/e2e/rer-duty-scroll-stability.spec.ts`
- Test: `wdintel-web/tests/e2e/rer-duty-workflows.spec.ts`
- Test: `wdintel-web/tests/e2e/analysis-neo.spec.ts`
- Test: `wdintel-web/tests/e2e/analysis-workflows.spec.ts`
- Modify as needed: `wdintel-web/tests/e2e/analysis-neo.fixtures.ts`
- Create: `wdintel-web/tests/e2e/message-feed-unification.spec.ts`

**Interfaces:** Existing host selectors remain valid. New fixtures use generated `InboxMessage` and real pagination/cursor request fields, not hand-written backend bindings.

- [x] Run the four existing suites in one baseline invocation; preserve failing traces and record exact assertions.
- [x] Re-run failures unchanged to distinguish reproducible failures from timing sensitivity. Trace settings arrival, initial landing and layout before changing assertions or production code.
- [x] Correct each confirmed pre-existing defect or test-fixture defect separately; do not mask it with the extraction.
- [x] Add `#3689 Analysis accumulates pages and keeps the visible reading anchor`: load page 0 and page 1 with disjoint 20-message fixtures; assert both pages remain mounted, exact next-page request and unchanged anchor offset within 1px.
- [x] Add `#3689 Analysis navigates loaded and unloaded message pages`: loaded page navigation scrolls to its boundary without another inbox request; unloaded page requests its page, replaces/expands according to current behavior and updates visible page indicator.
- [x] Add `#3689 focus survives card height changes at the context boundary`: target near the end remains centered with spacer through width/media resize; real wheel input releases focus so further resize does not recenter it.
- [x] Add `#3689 Duty trims its window without moving the reading anchor`: prepend history, return toward tail; assert no more than 40 cards, correct cursors, no duplicate ids and anchor offset within 1px.
- [x] Exercise Analysis focused above/below loading for both sort orders; compare outgoing cursors and existing visible card offset, not only card presence.
- [x] Run all new characterization tests against unchanged production code. If an expected invariant fails, resolve it before extraction; passing characterization is not a new-feature RED test.

Run from `wdintel-web`:

```sh
npm exec -- playwright test tests/e2e/rer-duty-scroll-stability.spec.ts tests/e2e/rer-duty-workflows.spec.ts tests/e2e/analysis-neo.spec.ts tests/e2e/analysis-workflows.spec.ts tests/e2e/message-feed-unification.spec.ts
```

Expected: every scenario passes without retries being required to claim a green baseline.

## Task 2: Shared Viewport Core and Duty Migration

**Files:**
- Create directory: `wdintel-web/src/ts/react/routes/shared/message-feed/`
- Move and adapt into that directory: `useWindowedFeedScroll.ts`, `useWindowedFeedScrollAnchors.ts`, `useWindowedFeedScrollFollow.ts`, `useWindowedFeedScrollRefs.ts`, `useWindowedFeedScrollTracking.ts`, `windowed-feed-scroll-shared.ts` from `rer-duty-neo/`.
- Create: `MessageFeed.tsx`, `message-feed.types.ts`, `message-feed.css` in the shared directory.
- Modify: `wdintel-web/src/ts/react/routes/rer-duty-neo/FeedColumnContent.tsx`
- Modify imports: all consumers of the moved scroll files, located with `rg` before moving.
- Test: existing `rer-duty-neo/__tests__/useWindowedFeedScroll.spec.tsx` and `useFeedIdleViewportOffload.spec.tsx`.
- Create tests under `routes/shared/message-feed/__tests__/` for shared viewport contracts.

**Interfaces:**
- `MessageFeed<T>` consumes `items: readonly T[]`, `getMessageId: (item: T) => number`, `renderMessage: (item: T) => ReactNode`, `resetKey: string`, `policy: MessageFeedPolicy`, and the shared scroll options derived from existing `UseWindowedFeedScrollOptions`.
- `MessageFeedPolicy` contains `initialPosition: 'start' | 'end'`, `followAtBottom: boolean`, `aboveLoadBufferPx: number`, `belowLoadBufferPx: number`, `atBottomThresholdPx: number`, `underfilledEdgeLoading: boolean`.
- `MessageFeedHandle` exposes `scrollToBottom` and `scrollToMessage` with the existing argument/return contracts of `WindowedFeedScrollHandle`; retain the host's wake-offload behavior before calling them.
- Retain `AnchorSnapshot` shape, list/item/scroller refs, and visible-item callbacks so offload and remount do not lose measurements.
- The native scroller/list component owns ref attachment and per-item stable keys. Host slots supply loading/empty/spacer-adjacent content and card rendering; scroller attributes/style are accepted as presentation props.
- Diagnostic events/metrics go through injected callbacks. Shared modules must not import Duty debug state.

- [x] Write `#3689 preserves the visible card through prepend and resize` and `#3689 cancelled navigation cannot move a replacement feed` integration tests consuming `MessageFeed` in a Duty configuration; initially RED because the shared component does not exist. Assert visible-card offsets within 1px and the replacement feed's unchanged position after the old operation completes, not prop forwarding or snapshots.
- [x] Move the proven Duty core without changing its algorithms; adapt imports and inject diagnostics. Preserve navigation cancellation and initial-settings guard.
- [x] Introduce policies with Duty defaults matching current values: end, follow gated by existing auto-scroll/watch inputs, above 160px, below 640px, UI bottom 25px, underfilled loading enabled.
- [x] Replace Duty's native scroller/list owner with `MessageFeed`; keep memoized card rendering, loading states, FAB and idle placeholders. Avoid remounting cards when unrelated host state changes.
- [x] Run the shared core integration tests plus existing Duty scroll/offload tests; assert settings races, stale-owner cancellation and physical-vs-UI bottom semantics from Review Focus.
- [x] Run both Duty E2E suites and Task 1's window-budget test. No Analysis production changes in this task.

## Task 3: Analysis Uses the Same Core

**Files:**
- Modify: `wdintel-web/src/ts/react/routes/rer-analysis-neo/components/AnalysisMessagesPane.tsx`
- Modify as needed: `wdintel-web/src/ts/react/routes/rer-analysis-neo/components/AnalysisCenterPanel.tsx`
- Modify: shared `message-feed.types.ts`, viewport core, and `MessageFeed.tsx`.
- Create: `message-feed-focus.ts`, `message-feed-viewport.ts` under the shared directory for focused positioning and capture/restore operations.
- Modify tests: `rer-analysis-neo/components/__tests__/AnalysisMessagesPane.spec.tsx`.
- Test: Task 1 E2E tests and shared core integration tests.

**Interfaces:**
- Extend shared options with viewport preservation generation and capture callback, and focused target generation/cancellation; reuse host `AnalysisDirectMessageNavigation` callbacks through a thin binding, without importing the host type into core.
- Shared `MessageViewportCapture` represents leading edge, trailing edge, or a stable message-id/offset anchor. Shared capture/restore functions consume the scroller and registered items.
- Visible-item callbacks allow host page alignment using page size 20. Host maps physical `above | below` to chronological direction according to `newestFirst`.
- Analysis policy: initial start, follow disabled, focused load buffers 480px, underfilled loading only where current Analysis behavior enables it. No 40-card trimming or Duty idle offload is enabled for Analysis.

- [x] Add RED shared-core tests for initial start, preserving refresh at top vs in history, page-boundary alignment, focused target centering and bottom-spacer calculation. Use measurable container/card rectangles in integration tests, not JSDOM's default zero geometry.
- [x] Move Analysis capture/restore, bounded alignment stabilization and focus/spacer logic into shared modules. Explicit target takes priority over follow; wheel/touch/navigation keys release focus, card actions do not.
- [x] Wire Analysis to `MessageFeed` and shared core. Keep query state, request cursor mapping, accumulated pages, dialogs and card-specific props in the host.
- [x] Delete Analysis's local scroll handlers/observers/capture/restore engine after switching ownership. Do not retain it behind a mode flag.
- [x] Run existing Analysis component tests and all Analysis E2E plus Task 1 scenarios for page accumulation, both focused load directions and resized target.
- [x] Re-run both Duty suites to prove the new shared start/focus modes did not change live-tail behavior.

## Task 4: Verification, Cleanup, and Permalink Handoff

**Files:**
- Modify: relevant component-scoped documentation under `docs/frontend/`.
- Remove: obsolete route-local scroll modules/imports after all consumers migrate.
- Modify `CHANGELOG.md` only if this stage is released, using issue #3689 and the repository changelog skill.

**Interfaces:** No shared module imports either host. Both hosts render `MessageFeed`; both use the same anchor/focus/resize/loading mechanics. Only data lifecycle and explicit policies differ.

- [x] Review core for leftover route checks, duplicate handlers, observers/timers without cleanup, and unstable per-row callbacks that invalidate memoized cards.
- [x] Verify all pre-existing message-card actions, including current copied link destination, remain unchanged. Add the existing copy-link E2E to the final affected suite run; do not change its expectation in this stage.
- [x] Run `npm run format:staged` after TS/TSX/CSS edits, keeping unrelated formatting out of the diff.
- [x] Run affected Vitest suites, the full frontend test command `just test-fe`, and `just build-front`; Rust checks only if Rust is actually changed.
- [x] Run the six affected E2E suites: the four baseline suites, `message-feed-unification.spec.ts`, and `message-card-media-preview.spec.ts`.
- [x] Check wide four-feed Duty under 4x CPU throttle and mobile tab switching: only active mobile feed mounted, window budget retained, no new per-card MUI wrappers or card-remount storm. Compare against pre-extraction measurements, not arbitrary new latency promises.
- [x] Document config and host binding contracts beside the owning component; leave system overview README files unchanged.
- [x] Report verification evidence and remaining limits; notify through the configured Mattermost hook. Do not commit or push without permission.

Next stage: Duty copies `/rer-duty-neo?m=<reference>`; both hosts' existing context loaders land through shared `scrollToMessage`, with out-of-window, reload, unavailable target and cancellation E2E. Future search/Important/reply/mention producers then reuse that navigation entry point without another viewport engine.
