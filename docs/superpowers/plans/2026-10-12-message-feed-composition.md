# Message Feed Composition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Duty and Analysis compose cards inside a self-contained `MessageFeed` that owns scrolling and feed-card loading UI, while keeping each host's data and actions separate.

**Architecture:** Keep the existing `useWindowedFeedScroll` engine; move its invocation behind the shared component and expose only an imperative feed handle plus read-only scroller access. Preserve native card markup and a children-based API. Add the shared skeleton first, migrate each host independently, then remove the temporary legacy component API.

**Tech Stack:** React 18, TypeScript, MUI Skeleton leaf components, Vitest/happy-dom, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-12-message-feed-composition-design.md`

## Global Constraints

- Issue #3689; this step does not change copied-link destinations or add new navigation sources.
- Preserve Duty's 40-card window, memoized native card rows, idle offload, follow/unread behavior, and independent one-to-four columns; mobile mounts only the active column.
- Preserve Analysis page accumulation, both sort directions, focused-context loading, anchor preservation, page alignment, and card actions.
- Keep fetching, filters, errors/toasts, empty-state copy, and card actions in hosts. Do not add host imports or a second scroll engine to `shared/message-feed`.
- Keep existing `data-duty-*`, `data-analysis-*`, and `data-message-id` selectors, native `div`/`ul` semantics, and transparent feed skeleton backgrounds.
- Preserve the three already-staged Analysis skeleton files; inspect their diff before editing, exclude them from Tasks 1–2 commits, and incorporate them intentionally in Task 3.
- Format only changed frontend files via `cd wdintel-web && npm run format:staged`; remove unrelated formatter-only diffs. Keep documents in English.

## Review Focus

- An explicit target arrives while cards are loading: skeleton nodes never count as messages, and the target lands when its real card mounts (Task 1).
- One Duty filter or reset changes: other mounted feeds keep their cards and scroll positions (Task 2).
- Analysis newest-first flips: physical edge loads still map to the correct chronological direction (Task 3).
- A refresh starts while a reader is mid-list: real cards stay mounted and the reading anchor survives the skeleton overlay (Tasks 1 and 3).
- Loading ends with zero results or an API failure: the host's empty/error behavior appears, not a stuck skeleton (Tasks 2 and 3).

---

## File map

- `wdintel-web/src/ts/react/routes/shared/message-feed/MessageFeed.tsx`: temporary legacy wrapper, then final public component with hook ownership, children, loading flags, and imperative handle.
- `wdintel-web/src/ts/react/routes/shared/message-feed/MessageFeedViewport.tsx` (new): sole native scroller/list renderer, shared by old and new facades during migration.
- `wdintel-web/src/ts/react/routes/shared/message-feed/MessageFeedItem.tsx` (new): native Duty row registration without an additional DOM wrapper.
- `wdintel-web/src/ts/react/routes/shared/message-feed/MessageFeedSkeletons.tsx` (new) and `message-feed.css`: one feed-card skeleton presentation for initial, refresh, and physical edge loading.
- `wdintel-web/src/ts/react/routes/shared/message-feed/message-feed.types.ts`, `index.ts`, `README.md`: public contracts, exports, and ownership documentation.
- `wdintel-web/src/ts/react/routes/rer-duty-neo/FeedColumnContent.tsx`, `RerDutyNeoWorkspace.tsx`: compose memoized cards, pass Duty policy/loading, keep column shell and offload.
- `wdintel-web/src/ts/react/routes/rer-analysis-neo/components/useAnalysisMessageFeed.ts`, `AnalysisMessagesPane.tsx`, `AnalysisCenterPanel.tsx`, `AnalysisLoadingSkeletons.tsx`: keep Analysis data/direction mapping, pass policy/loading, remove route-local card skeletons.
- Existing colocated Vitest and affected `wdintel-web/tests/e2e/` files verify observable behavior; do not add source-text assertions.

### Task 1: Shared component-owned viewport and loading contract

**Files:** Create `wdintel-web/src/ts/react/routes/shared/message-feed/MessageFeedViewport.tsx`, `MessageFeedItem.tsx`, `MessageFeedSkeletons.tsx`; modify `wdintel-web/src/ts/react/routes/shared/message-feed/MessageFeed.tsx`, `message-feed.css`, `message-feed.types.ts`, `index.ts`, `__tests__/MessageFeed.spec.tsx`.

**Interfaces:** Temporarily export `ManagedMessageFeed<T>` while the existing `MessageFeed<T>` remains available to unmigrated hosts; both render through one `MessageFeedViewport`. Export `MessageFeedScrollOptions = Omit<UseWindowedFeedScrollOptions, 'itemIds' | 'loadingOlder' | 'loadingNewer'>`; `ManagedMessageFeedProps<T>` takes `items`, `getMessageId`, `scrollOptions`, optional `children`/`renderMessage`, `isLoading`, `loadingAbove`, `loadingBelow`, `skeletonCount`, `scrollerRef`, and the existing native props/slots. Export `MessageFeedHandle` with `scrollToBottom`, `scrollToMessage`, `getItemElement`, `getScrollerElement`, and `getBottomSpacerPx`. `MessageFeedItem` accepts `id` and native `div` attributes, replacing Duty's existing wrapper. `MessageFeedSkeletons` accepts count, list tag, and edge/initial presentation without entering the item registry.

- [ ] **Step 1:** Run baseline Vitest before extraction: `cd wdintel-web && npm exec -- vitest run src/ts/react/routes/shared/message-feed/__tests__/MessageFeed.spec.tsx src/ts/react/routes/rer-duty-neo/__tests__/FeedColumnContent.spec.tsx src/ts/react/routes/rer-analysis-neo/components/__tests__/AnalysisMessagesPane.spec.tsx`; record any failures without changing assertions.
- [ ] **Step 2:** Separately run baseline Playwright: `cd wdintel-web && npm exec -- playwright test tests/e2e/message-feed-unification.spec.ts tests/e2e/rer-duty-workflows.spec.ts tests/e2e/analysis-workflows.spec.ts`; record any failures before extraction.
- [ ] **Step 3:** Add tests mounting `ManagedMessageFeed` without a host scroll hook: children render in order; `scrollToMessage(2)` finds the mounted card; controlled focus on ID 2 lands after an initial loading skeleton is replaced by the real card; two feeds with different IDs do not share refs or scroll state; `MessageFeedItem` registers its existing wrapper; initial, refresh, and edge skeletons remain outside the item registry. Refresh must preserve the original card nodes and `scrollTop`. The new component is absent before this task.
- [ ] **Step 4:** Run `cd wdintel-web && npm exec -- vitest run src/ts/react/routes/shared/message-feed/__tests__/MessageFeed.spec.tsx` and confirm the new contract fails for missing behavior, not fixture setup.
- [ ] **Step 5:** Implement `ManagedMessageFeed` over the existing hook/one native viewport renderer and the shared transparent skeleton. Compose the optional external scroller ref with the internal ref; keep item registration before explicit landing. On refresh keep existing child DOM mounted under the overlay. Do not add per-card MUI wrappers.
- [ ] **Step 6:** Run `cd wdintel-web && npm exec -- vitest run src/ts/react/routes/shared/message-feed/__tests__/MessageFeed.spec.tsx src/ts/react/routes/rer-duty-neo/__tests__/useWindowedFeedScroll.spec.tsx`; both suites must pass.
- [ ] **Step 7:** Run `cd wdintel-web && npm run format:staged`, inspect formatter-only changes, and commit only Task 1 files with `refactor(3689): moved feed viewport ownership into component`.

### Task 2: Migrate Duty without changing its feed state

**Files:** Modify `wdintel-web/src/ts/react/routes/rer-duty-neo/FeedColumnContent.tsx`, `RerDutyNeoWorkspace.tsx`, `__tests__/FeedColumnContent.spec.tsx`, `__tests__/RerDutyNeoWorkspace.spec.tsx`; extend `wdintel-web/tests/e2e/rer-duty-workflows.spec.ts` and, if needed, `rer-duty-scroll-stability.spec.ts`.

**Interfaces:** Consume `ManagedMessageFeed`, `MessageFeedItem`, `MessageFeedHandle`, `MessageFeedScrollOptions`, and `MessageFeedSkeletons` from Task 1. Duty passes `DUTY_FEED_POLICY`, existing edge callbacks/reset keys, `feed.items`, and its memoized `DutyMessageList` children. `FeedColumnContentHandle` remains unchanged for callers; the host wakes idle offload before delegating explicit scroll to `MessageFeedHandle`. The workspace keeps its header skeleton but uses the shared card skeleton for initial loading.

- [ ] **Step 1:** Add a host test asserting initial/older message-area loading renders the shared skeleton, not the current spinner; add preservation tests for two Duty columns with distinct IDs/scroll positions and an E2E assertion for four independent card trees. Only the new loading assertion is expected to fail on the baseline.
- [ ] **Step 2:** Run `cd wdintel-web && npm exec -- vitest run src/ts/react/routes/rer-duty-neo/__tests__/FeedColumnContent.spec.tsx src/ts/react/routes/rer-duty-neo/__tests__/RerDutyNeoWorkspace.spec.tsx` and confirm the loading assertion fails for the current spinner, not fixture setup.
- [ ] **Step 3:** Replace Duty's direct scroll-hook call with `ManagedMessageFeed` props/ref; replace its native row wrapper with `MessageFeedItem` without adding DOM depth. Use shared card skeletons in the workspace and feed. Keep offload, memoization comparator, FAB, placeholders, selectors, and callbacks.
- [ ] **Step 4:** Run the two Duty Vitest files from Step 2, then separately `cd wdintel-web && npm exec -- playwright test tests/e2e/rer-duty-workflows.spec.ts tests/e2e/rer-duty-scroll-stability.spec.ts`; all relevant tests must pass.
- [ ] **Step 5:** Run `cd wdintel-web && npm run format:staged`, inspect formatter-only changes, and commit only Task 2 files with `refactor(3689): migrated duty columns to component-owned feed scroll`.

### Task 3: Migrate Analysis while retaining page navigation

**Files:** Modify `wdintel-web/src/ts/react/routes/rer-analysis-neo/components/useAnalysisMessageFeed.ts`, `AnalysisMessagesPane.tsx`, `components/__tests__/AnalysisMessagesPane.spec.tsx`, `wdintel-web/src/ts/react/routes/rer-analysis-neo/AnalysisCenterPanel.tsx`, `AnalysisLoadingSkeletons.tsx`, `AnalysisPageLayout.tsx` if required; extend `__tests__/index.spec.tsx` and `wdintel-web/tests/e2e/message-feed-unification.spec.ts`.

**Interfaces:** `useAnalysisMessageFeed` returns `{ scrollOptions: MessageFeedScrollOptions, displayedMessages, loadingAbove, loadingBelow }` rather than calling the shared hook. `AnalysisMessagesPane` passes that contract to `ManagedMessageFeed` and uses `MessageFeedHandle` only for mounted-card lookup and diagnostics; it keeps direct-message context loading and card actions. Analysis page-shell tabs/right-panel skeletons remain host-owned, but their card area uses `MessageFeedSkeletons`.

- [ ] **Step 1:** Add a host test that refresh loading is rendered by the feed without replacing a mounted card, and that loading clears to the existing empty/error state; add preservation tests for page-index alignment and focused targets. Extend browser coverage for both newest-first values and current `getFocusedLoadDirection` mapping. The current route-level refresh overlay must fail the new feed-owned loading assertion.
- [ ] **Step 2:** Run `cd wdintel-web && npm exec -- vitest run src/ts/react/routes/rer-analysis-neo/components/__tests__/AnalysisMessagesPane.spec.tsx src/ts/react/routes/rer-analysis-neo/__tests__/index.spec.tsx` and confirm the feed-owned loading assertion fails, not fixture setup.
- [ ] **Step 3:** Move only the hook invocation into `ManagedMessageFeed`; pass initial/refresh/edge loading flags and reuse shared card skeletons in page shells. Keep Analysis's `appendRequestedRef`, page-index calculations, focus, controlled reset/preservation keys, debug snapshots, `ul > li` markup, and the intent of the staged refresh tests.
- [ ] **Step 4:** Run the two Analysis Vitest files from Step 2, then separately `cd wdintel-web && npm exec -- playwright test tests/e2e/message-feed-unification.spec.ts`; all relevant tests must pass.
- [ ] **Step 5:** Run `cd wdintel-web && npm run format:staged`, compare the three pre-existing staged files with their baseline diff, and intentionally include their integrated changes in the Task 3 commit `refactor(3689): migrated analysis to component-owned feed scroll`.

### Task 4: Remove transition API and verify both hosts

**Files:** Modify `wdintel-web/src/ts/react/routes/shared/message-feed/MessageFeed.tsx`, `MessageFeedViewport.tsx`, `index.ts`, `README.md`, `__tests__/MessageFeed.spec.tsx`, and `wdintel-web/src/ts/react/routes/rer-duty-neo/__tests__/useWindowedFeedScroll.spec.tsx`; adjust only tests affected by the final export. No root `README.md` or `docs/README.md` overview edit.

**Interfaces:** Rename `ManagedMessageFeed<T>` to the final `MessageFeed<T>` and remove the old `scroll` prop path. Remove `useWindowedFeedScroll` from the package entry point; existing hook-focused tests may import its implementation module directly, but production hosts may not. `MessageFeedRows` may remain as a keyed-rendering helper for Duty's memoized list.

- [ ] **Step 1:** Add a public-package test importing final `MessageFeed` with `scrollOptions`, composing both host-style children and calling `scrollToMessage` through its ref. It fails against the legacy `scroll`-required API.
- [ ] **Step 2:** Rename the managed facade, remove the legacy path/export, and update host imports and the focused package README with the new contract and next-stage permalink boundary.
- [ ] **Step 3:** Run `cd wdintel-web && npm run format:staged`, inspect and discard unrelated formatter-only diffs, then run `just test-fe` and `just build-front`.
- [ ] **Step 4:** Separately run `cd wdintel-web && npm exec -- playwright test tests/e2e/message-feed-unification.spec.ts tests/e2e/rer-duty-workflows.spec.ts tests/e2e/rer-duty-scroll-stability.spec.ts tests/e2e/analysis-neo.spec.ts tests/e2e/analysis-workflows.spec.ts`; inspect failures rather than weakening assertions.
- [ ] **Step 5:** Check `rg -n 'useWindowedFeedScroll' wdintel-web/src/ts/react/routes/rer-duty-neo wdintel-web/src/ts/react/routes/rer-analysis-neo --glob '!**/__tests__/**'` has no production host calls; inspect `git diff --check` and commit only scoped cleanup with `refactor(3689): completed shared feed composition migration`.
