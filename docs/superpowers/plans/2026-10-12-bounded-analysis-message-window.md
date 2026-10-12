# Bounded Analysis Message Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep at most 40 message payloads/cards in each Analysis feed while preserving its scroll-driven and button-driven pagination.

**Architecture:** Page-owned loaders retain explicit logical window coordinates and request cursors. A shared pure window operation bounds Duty and Analysis data; `MessageFeed` continues to own scroll geometry, anchoring, and edge skeletons without owning data or the limit. Analysis keeps its own first/previous/next/last controls and `messagesPage` URL behavior.

**Tech Stack:** React, TypeScript, Vitest, Playwright, existing Elm Land frontend.

**Spec:** `docs/superpowers/specs/2026-10-12-bounded-analysis-message-window-design.md`

## Global Constraints

- The default active window is 40 `InboxMessage` items; the Analysis API page is 20 items.
- The limit is configured by the page data owner and passed to shared window operations, never as a `MessageFeed` prop.
- Both Analysis orderings and focused direct-message navigation obey the limit.
- Analysis's first/previous/next/last controls, range/total label, and `messagesPage` URL remain functional. Scrolling and button navigation select the same logical page; only a button click additionally aligns the viewport.
- A load evicts the opposite edge; evicted pages remain fetchable. Empty responses exhaust only their requested edge; errors preserve the current window and use existing user-facing notifications.
- Preserve Duty's timestamp ordering, unread/pending accounting, evicted-tail semantics, and independent columns.
- Keep all written documents and new test names in English. Do not modify the backend pagination API or card actions.

## Review Focus

1. A duplicate/overlapping cursor page must not consume two slots or evict a visible row unnecessarily (Task 1 and Task 2 tests).
2. An evicted adjacent Analysis page must still enable its pager button even when the server's far edge is exhausted (Task 2 and Task 4 tests).
3. A short final page must display its correct logical range, not a range based on the 40-item window length (Task 4 test).
4. A focused target may leave the active window after scrolling; ordering, page index, and both loading edges must remain correct (Task 3 tests).
5. A stale request or failed request during a filter/order change must not overwrite the new window or strand its loading skeleton (Task 2 and Task 3 tests).

---

## File map

- `wdintel-web/src/ts/react/routes/shared/message-feed/windowing.ts`: generic ordered merge, deduplication, and opposite-edge eviction.
- `wdintel-web/src/ts/react/routes/shared/message-feed/__tests__/windowing.spec.ts`: pure window invariants.
- `wdintel-web/src/ts/react/routes/rer-duty-neo/utils.ts` and directional-load/polling/initial-load tests: keep Duty API, delegate only the common window operation.
- `wdintel-web/src/ts/react/routes/rer-analysis-neo/use-analysis-message-list.ts`: Analysis window coordinates, directional cursors/loads, focused loads, and bounded ingress.
- `wdintel-web/src/ts/react/routes/rer-analysis-neo/components/useAnalysisMessageFeed.ts`: map Analysis data edges to shared feed edges and preserve anchors on either load.
- `wdintel-web/src/ts/react/routes/rer-analysis-neo/use-rer-analysis-neo-page.ts`, `AnalysisCenterPanel.tsx`, `AnalysisPageHeader.tsx`, and `components/AnalysisPaginationControl.tsx`: keep pager state and labels correct independently of the bounded array.
- `wdintel-web/src/ts/react/routes/rer-analysis-neo/use-analysis-data.core.ts`, `use-analysis-data.reload.ts`, and related `types.ts`/`use-analysis-data.types.ts`: route every realtime, reload, and local-message ingress through bounded state; remove unused unlimited loading.
- Existing Analysis Vitest suites and `wdintel-web/tests/e2e/message-feed-unification.spec.ts`: browser-visible scroll, anchors, limits, and pagination.

### Task 1: Shared window operation and Duty compatibility

**Files:**
- Create: `wdintel-web/src/ts/react/routes/shared/message-feed/windowing.ts`
- Create: `wdintel-web/src/ts/react/routes/shared/message-feed/__tests__/windowing.spec.ts`
- Modify: `wdintel-web/src/ts/react/routes/rer-duty-neo/utils.ts:782-855`
- Test: `wdintel-web/src/ts/react/routes/rer-duty-neo/__tests__/useRerDutyFeedState.directional-loads.spec.tsx`, `useRerDutyFeedState.polling.spec.tsx`, and `useRerDutyFeedState.initial-load.spec.tsx`

**Interfaces:**
- Produces: `mergeMessageWindow<T>(existing: readonly T[], incoming: readonly T[], edge: 'above' | 'below', options: { limit: number; getId: (item: T) => number; order?: (items: T[]) => T[] }): { items: T[]; addedItems: T[]; removedItems: T[] }`.
- `addedItems` contains unique incoming IDs absent from `existing`; `removedItems` contains items discarded by the cap. Existing items win duplicate IDs. `order` is optional and runs before trimming; without it, preserve supplied order.
- Duty's existing `windowInitialMessageItems`, `prependWindowedMessageItems`, and `appendWindowedMessageItems` exports and result shape remain unchanged. Their wrappers pass `sortMessageItemsByTime` and the existing 40-item default.

- [ ] **Step 1: Write failing shared tests.** Name cases for above/below insertion, first-occurrence deduplication, a 20+20+20 sequence retaining exactly 40, and custom `limit: 3`; assert literal IDs and exact `addedItems`/`removedItems`.
- [ ] **Step 2: Run RED.** `cd wdintel-web && npm exec -- vitest run src/ts/react/routes/shared/message-feed/__tests__/windowing.spec.ts` must fail because the new export does not exist.
- [ ] **Step 3: Implement the generic operation and change Duty wrappers to delegate.** Keep Duty's timestamp sort and existing unread/evicted-tail callers outside the shared module.
- [ ] **Step 4: Run GREEN and Duty regressions.** Run the new shared spec and the three named Duty integration specs with `npm exec -- vitest run` from `wdintel-web`; all selected tests pass.
- [ ] **Step 5: Commit this independently testable unit.** Stage only the shared helper, its tests, and Duty wrapper/tests; use `refactor(3689): centralized bounded message window operations`.

### Task 2: Bound regular Analysis scrolling in both directions

**Files:**
- Modify: `wdintel-web/src/ts/react/routes/rer-analysis-neo/use-analysis-message-list.ts:80-440,560-670`
- Modify: `wdintel-web/src/ts/react/routes/rer-analysis-neo/helpers.ts:26-36`
- Test: `wdintel-web/src/ts/react/routes/rer-analysis-neo/__tests__/use-analysis-message-list.spec.ts`
- Test: `wdintel-web/tests/e2e/message-feed-unification.spec.ts`

**Interfaces:**
- Consumes: `mergeMessageWindow` from Task 1.
- Add `messageWindowLimit?: number` to `useAnalysisMessageList` parameters, defaulting to 40.
- Expose `firstLoadedMessageIndex: number`, `hasMoreBeforeWindow: boolean`, `hasMoreAfterWindow: boolean`, `loadingBeforeWindow: boolean`, `loadingAfterWindow: boolean`, and `loadPreviousMessages(): Promise<boolean>` in display order. Retain `pageIndex` as the last loaded logical page and `loadMoreMessages(): Promise<boolean>` as the next-page scroll loader.
- `fetchPage` distinguishes `replace`, `above`, and `below`; the two latter modes merge through Task 1. The first loaded absolute index changes by retained additions/removals, not by assuming all preceding pages are mounted. Keep page cursors across eviction; reset them with query invalidation.

- [ ] **Step 1: Write failing hook and browser tests.** Name the tests with `bounded`. With literal pages `60..41`, `40..21`, `20..1`, assert forward scroll keeps 40 IDs, `firstLoadedMessageIndex === 20`, `pageIndex === 2`, and backward scroll refetches `60..41`, keeps `60..21`, and reports both edges accurately. Repeat the sequence oldest-first with `1..20`, `21..40`, `41..60`; include an overlapping ID and a short/empty response. Assert a failed load clears its loading flag without changing the window. Add a separate four-page Playwright fixture and test `Analysis keeps a bounded window while scrolling` asserting at most 40 `[data-message-id]` rows after the third scroll load.
- [ ] **Step 2: Run RED.** `cd wdintel-web && npm exec -- vitest run src/ts/react/routes/rer-analysis-neo/__tests__/use-analysis-message-list.spec.ts -t bounded` and `npm exec -- playwright test tests/e2e/message-feed-unification.spec.ts --grep 'Analysis keeps a bounded window while scrolling' --workers=1 --reporter=line` must fail on the current unbounded append or missing reverse-edge API.
- [ ] **Step 3: Implement regular window state and directional page requests.** Separate remote-edge exhaustion from evicted-edge availability; do not turn an error into exhaustion. Preserve the existing `loadNextPage`, `loadPrevPage`, `loadFirstPage`, and `loadLastPage` button entry points.
- [ ] **Step 4: Run GREEN and the complete hook spec.** Both the bounded cases and existing cursor/stale-response tests pass. If a pre-existing test asserted unlimited accumulation, update its expectation to the new 40-item contract without weakening anchor or request assertions.
- [ ] **Step 5: Commit.** Stage only the Analysis window owner and its unit/browser tests; use `feat(3689): bounded analysis scroll pages`.

### Task 3: Bound focused links and every Analysis message ingress

**Files:**
- Modify: `wdintel-web/src/ts/react/routes/rer-analysis-neo/use-analysis-message-list.ts:180-255,315-350,445-555`
- Modify: `wdintel-web/src/ts/react/routes/rer-analysis-neo/use-analysis-data.core.ts:900-975,1200-1230`
- Modify: `wdintel-web/src/ts/react/routes/rer-analysis-neo/use-analysis-data.reload.ts:830-1060`
- Modify: `wdintel-web/src/ts/react/routes/rer-analysis-neo/use-analysis-data.state-utils.ts`
- Modify: related Analysis types/wiring only where old unlimited-loading fields are removed.
- Test: `wdintel-web/src/ts/react/routes/rer-analysis-neo/__tests__/use-analysis-message-list.spec.ts`, `use-analysis-data.core.inbox-refresh.spec.tsx`, and focused E2E in `message-feed-unification.spec.ts`.

**Interfaces:**
- Consumes: Task 2 window coordinates and Task 1 merge operation.
- Focused context and earlier/later API responses are normalized to the active display order before merging. Preserve an absolute first-message coordinate even after the target ID is evicted; focus release does not reset the window.
- Replace or constrain raw `setMessages` ingress so initial/reload, realtime insertion, local prepend, and edit paths cannot exceed the configured limit. Remove `loadAllMessages`/`nolimitShown` if their production-caller audit remains empty; otherwise route the call to bounded navigation and remove the `nolimit` request.

- [ ] **Step 1: Write failing tests.** From a focused 20-item context, load one 20-item page on each side and assert 40 items, the evicted target's absolute page index remains known, order is correct for `newestFirst=true/false`, and the removed edge is re-fetchable. Add a 40-item realtime/local insertion case that remains at 40, plus a stale reload that cannot restore evicted payloads.
- [ ] **Step 2: Run RED.** `cd wdintel-web && npm exec -- vitest run src/ts/react/routes/rer-analysis-neo/__tests__/use-analysis-message-list.spec.ts src/ts/react/routes/rer-analysis-neo/__tests__/use-analysis-data.core.inbox-refresh.spec.tsx src/ts/react/routes/rer-analysis-neo/__tests__/use-analysis-data.loaders.spec.ts -t bounded` must fail on the current 60-item focus or unbounded prepend.
- [ ] **Step 3: Normalize focused order and cap all ingress.** Keep target alignment/highlighting and existing error toasts. Prune message-ID-specific cached comments for evicted items only when no other active consumer needs them; do not prune shared catalogs or cursor metadata.
- [ ] **Step 4: Run GREEN.** Run the complete Analysis message-list, reload, and realtime suites; focused-link request direction and stale-generation tests pass.
- [ ] **Step 5: Commit.** Stage only focused/ingress code and its tests; use `feat(3689): bounded focused analysis messages`.

### Task 4: Preserve feed scroll anchoring and the Analysis pager contract

**Files:**
- Modify: `wdintel-web/src/ts/react/routes/rer-analysis-neo/components/useAnalysisMessageFeed.ts:25-175`
- Modify: `wdintel-web/src/ts/react/routes/rer-analysis-neo/components/AnalysisMessagesPane.tsx`
- Modify: `wdintel-web/src/ts/react/routes/rer-analysis-neo/AnalysisCenterPanel.tsx:140-165,230-260`
- Modify: `wdintel-web/src/ts/react/routes/rer-analysis-neo/AnalysisPageHeader.tsx:220-245`
- Modify: `wdintel-web/src/ts/react/routes/rer-analysis-neo/components/AnalysisPaginationControl.tsx:165-200`
- Modify: `wdintel-web/src/ts/react/routes/rer-analysis-neo/use-rer-analysis-neo-page.ts:535-715`
- Create: `wdintel-web/src/ts/react/routes/rer-analysis-neo/components/__tests__/useAnalysisMessageFeed.spec.tsx`
- Test: `wdintel-web/src/ts/react/routes/rer-analysis-neo/components/__tests__/AnalysisPaginationControl.spec.tsx` and `wdintel-web/src/ts/react/routes/rer-analysis-neo/__tests__/use-rer-analysis-neo-page.spec.tsx`

**Interfaces:**
- Consume Task 2's window edges and first absolute index. Regular and focused modes expose physical `loadingAbove`/`loadingBelow`, `hasMoreAbove`/`hasMoreBelow`, and callbacks to the shared feed; do not add a second scroll engine.
- After active target alignment is released, `onFirstVisibleMessage(id, localIndex)` selects `Math.floor((firstLoadedMessageIndex + localIndex) / 20)` through the existing `setVisibleMessagesPageIndex` path. Button navigation additionally sets `pageNavigationTarget`; scroll-driven selection does not.
- Pager range uses the selected logical page and total/partial-page count, not `messages.length` as though it described one page. Enablement uses logical edge availability, not whether the adjacent page is mounted.

- [ ] **Step 1: Write failing tests.** Assert scroll-driven first-visible index selects page 2 and writes `messagesPage=2`, the range shows `41-45 з 45` for a partial final page with 40 cards mounted, and Previous/Next remains enabled for an evicted adjacent page. Assert a button click aligns the requested page, while a scroll change does not create a navigation target.
- [ ] **Step 2: Run RED.** `cd wdintel-web && npm exec -- vitest run src/ts/react/routes/rer-analysis-neo/components/__tests__/useAnalysisMessageFeed.spec.tsx src/ts/react/routes/rer-analysis-neo/components/__tests__/AnalysisPaginationControl.spec.tsx src/ts/react/routes/rer-analysis-neo/__tests__/use-rer-analysis-neo-page.spec.tsx -t bounded` must fail in page identity/range or missing edge loading, not fixtures.
- [ ] **Step 3: Wire both Analysis edges and explicit coordinates to `MessageFeed`.** Preserve scroll position for both append and prepend, not only the current `appendRequestedRef` path. Keep shared viewport anchor capture for eviction, the existing skeletons, the four page buttons, and URL update path. Replace `getFirstLoadedMessagesPageIndex(pageIndex, messages.length)` consumers with the explicit first-window coordinate.
- [ ] **Step 4: Run GREEN.** Run the complete modified Analysis unit suites; no layout or focus assertions are relaxed.
- [ ] **Step 5: Commit.** Stage only pager/feed wiring and tests; use `feat(3689): preserved analysis pagination with bounded scroll`.

### Task 5: Browser regression and full verification

**Files:**
- Modify: `wdintel-web/tests/e2e/message-feed-unification.spec.ts`
- Modify: `docs/frontend/react-behavior-contracts/analysis.md` only for durable pagination/window behavior; leave `README.md` and `docs/README.md` unchanged.

**Interfaces:** No new production API. This task verifies the interfaces and visible behavior from Tasks 1-4.

- [ ] **Step 1: Extend the Task 2 browser regression.** Use the separate four-page fixture without changing the existing three-page default. Assert Analysis never mounts more than 40 `[data-message-id]` rows while scrolling down/up, fetches an evicted chunk again, preserves the first visible card's offset, updates pager range and `messagesPage` through scroll, and lets pager buttons jump to evicted/first/last pages. Run both orderings and a focused-link route. Keep the existing Duty cap and edge-skeleton regression.
- [ ] **Step 2: Prove each additional E2E assertion can fail.** Temporarily mutate the relevant window/page behavior locally, run `cd wdintel-web && npm exec -- playwright test tests/e2e/message-feed-unification.spec.ts --workers=1 --reporter=line`, then restore the mutation before proceeding.
- [ ] **Step 3: Fix only integration defects exposed by the browser tests, then rerun the affected E2E suite until green.** Do not weaken count, range, anchor, or request assertions to hide a regression.
- [ ] **Step 4: Format and verify.** Run `cd wdintel-web && npm run format:staged`, `just test-fe`, `just build-front`, the affected Duty/Analysis Playwright suites, and `git diff --check`; report unrelated failures by test name rather than claiming a clean run.
- [ ] **Step 5: Update the focused behavior document and commit the final integration/test change.** Use `test(3689): covered bounded analysis pagination`; do not edit overview documentation or push without asking.
