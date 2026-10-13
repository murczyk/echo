# Linked Message Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Duty and Analysis use one access-checked permalink-navigation lifecycle while preserving their distinct message-loading and pagination behavior.

**Architecture:** A small shared controller parses links, resolves context, sequences page-specific materialization and feed landing, and classifies outcomes. Duty and Analysis supply adapters for their existing data paths; `MessageFeed` remains independent of routing and APIs.

**Tech Stack:** React, TypeScript, Vitest, Playwright, existing inbox APIs and `MessageFeed`.

**Spec:** `docs/superpowers/specs/2026-10-13-linked-message-navigation-design.md`

## Global Constraints

- Copied URLs remain `/rer-duty-neo?m=<reference>` and `/rer-analysis-neo?m=<reference>`; `mid` and `messageUid` remain readable aliases.
- A copied Duty link opens one unfiltered feed without overwriting stored filters; normal Duty visits may still open multiple independent feeds.
- Analysis keeps its date-range adjustment, 20-message pages, page counts, ordering, and bidirectional focused loading. Duty keeps its bounded 40-card window, polling, unread state, and watch mode.
- The context API is the authority for availability; absent, deleted, and inaccessible targets have one privacy-safe user message.
- `MessageFeed` owns scroll geometry only. Do not move URL, access, filters, API, or pagination into it.
- Preserve unrelated working-tree edits, including pre-existing edits in files this plan touches. Stage only task-specific hunks (`git add -p` where needed), inspect the staged diff, and defer a task commit if the hunks cannot be separated safely; do not push without permission.
- Keep new documentation in English and frontend edits narrowly formatted with `npm run format:staged`.

## Review Focus

- A whitespace-only `m` with a valid `mid`: the first non-empty parameter wins, and no request is sent for a blank-only link (Task 1).
- A numeric reference with several context inbox IDs: Duty prefers the exact numeric ID when present, otherwise uses the context's IDs (Task 3).
- The target disappears between context lookup and window load: show `landing-error`, not an inaccessible-group diagnosis (Tasks 2, 4).
- An old request resolves after a filter, feed, date, sort, or page change: it cannot alter the URL, feed, viewport, or notification (Tasks 2–4).
- Analysis's focused context refresh fails after successful landing: retain or exit the focused window according to current page behavior, without duplicate notification (Task 4).

## File Map

- `shared/message-navigation/message-navigation-url.ts`: permalink query parsing and removal; copied-link builder stays in `message-card.utils.ts`.
- `shared/message-navigation/message-navigation-context.ts`: access-checked context resolution; no client-side group-access inference.
- `shared/message-navigation/message-navigation-controller.ts`: operation identity, abort, ordered lifecycle, outcome classification, notification text.
- `shared/message-navigation/index.ts`: public exports only.
- `rer-duty-neo/index.tsx`: Duty adapter and route integration; `utils.ts` keeps Duty-specific numeric-ID selection but loses duplicate URL parsing.
- `rer-analysis-neo/use-rer-analysis-neo-page.ts`: Analysis adapter and existing focused-window state; `helpers.ts` loses duplicate URL helpers.
- `rer-analysis-neo/components/AnalysisMessagesPane.tsx` and `AnalysisPageLayout.tsx`: landing acknowledgment and single error-notification path if needed; no pagination rewrite.
- Existing route tests and `tests/e2e` specs: regression coverage. Do not restructure folders as part of this change.

---

### Task 1: Share permalink URL handling

**Files:**
- Create: `wdintel-web/src/ts/react/routes/shared/message-navigation/message-navigation-url.ts`
- Create: `wdintel-web/src/ts/react/routes/shared/message-navigation/__tests__/message-navigation-url.spec.ts`
- Modify: `wdintel-web/src/ts/react/routes/rer-duty-neo/utils.ts`
- Modify: `wdintel-web/src/ts/react/routes/rer-duty-neo/useRerDutyFeedState.ts`
- Modify: `wdintel-web/src/ts/react/routes/rer-analysis-neo/helpers.ts`
- Modify: `wdintel-web/src/ts/react/routes/rer-analysis-neo/use-rer-analysis-neo-page.ts`

**Interfaces:** Produce `readLinkedMessageReference(searchParams: URLSearchParams): string | null`, `readLinkedMessageReferenceFromWindow(): string | null`, and `removeLinkedMessageReferenceFromWindowUrl(): void`. `m`, then `mid`, then `messageUid` is the priority among non-empty trimmed values. URL removal preserves every unrelated query parameter and hash.

- [ ] **Step 1: Write failing URL tests.** Assert the three aliases, precedence with a blank `m`, blank-only result `null`, encoded references, and removal preserving `state`, `messagesPage`, and `#fragment`.
- [ ] **Step 2: Run `cd wdintel-web && npm run test:ts -- src/ts/react/routes/shared/message-navigation/__tests__/message-navigation-url.spec.ts`; confirm missing export failure.**
- [ ] **Step 3: Implement the three signatures in `message-navigation-url.ts`; replace both route parsers and Analysis's removal helper with imports, including Duty's filter-persistence checks.** Keep existing copied-link generation unchanged.
- [ ] **Step 4: Run the URL test and affected helper/state tests; confirm pass.**
- [ ] **Step 5: Commit only Task 1 files with `refactor(3689): shared linked-message URL handling`.**

### Task 2: Share access resolution and lifecycle

**Files:**
- Create: `wdintel-web/src/ts/react/routes/shared/message-navigation/message-navigation-context.ts`
- Create: `wdintel-web/src/ts/react/routes/shared/message-navigation/message-navigation-controller.ts`
- Create: `wdintel-web/src/ts/react/routes/shared/message-navigation/index.ts`
- Create: `wdintel-web/src/ts/react/routes/shared/message-navigation/__tests__/message-navigation-controller.spec.ts`

**Interfaces:** `resolveLinkedMessageContext(reference: string, signal: AbortSignal): Promise<{ status: 'found'; context: InboxItemContextRsp } | { status: 'unavailable' }>` calls `fetchInboxItemContext({ messageUid: reference }, { signal })`; it throws request failures. `MessageNavigationHost<Landing>` exposes `materialize(context: InboxItemContextRsp, signal: AbortSignal): Promise<Landing | null>`, `land(landing: Landing, signal: AbortSignal): Promise<boolean>`, and `invalidateNavigation(): void`. `createMessageNavigationController<Landing>(getHost: () => MessageNavigationHost<Landing>, onOutcome: (outcome: MessageNavigationOutcome) => void)` returns `{ navigate(reference: string): Promise<MessageNavigationOutcome>; cancel(): void }`; outcomes are `{ status: 'focused' | 'unavailable' | 'load-error' | 'landing-error' | 'cancelled' }`. `onOutcome` is never called for `cancelled`. `messageNavigationErrorText(outcome)` returns `null` for `focused`/`cancelled`, `Повідомлення за посиланням не знайдено або воно недоступне.` for `unavailable`, `Не вдалося відкрити повідомлення за посиланням. Спробуйте ще раз.` for `load-error`, and `Повідомлення за посиланням відсутнє у стрічці.` for `landing-error`. A new `navigate` or `cancel` aborts and invalidates the previous operation.

- [ ] **Step 1: Write failing fake-host tests.** Assert resolution precedes materialization and landing; `message: null` never calls the host; context rejection and materialization rejection return `load-error`; `null` materialization and `false` landing return `landing-error`; cancellation at each awaited stage returns `cancelled` without outcome callback or scroll; a second navigation supersedes the first; an aborted API request is not reported as an error.
- [ ] **Step 2: Run `cd wdintel-web && npm run test:ts -- src/ts/react/routes/shared/message-navigation/__tests__/message-navigation-controller.spec.ts`; confirm missing export failure.**
- [ ] **Step 3: Implement resolver/controller and public exports.** Check operation identity after every await and before callbacks; catch abort separately; never include group identity or raw API text in `unavailable` copy.
- [ ] **Step 4: Run the controller test; confirm pass.**
- [ ] **Step 5: Commit only Task 2 files with `refactor(3689): unified message navigation lifecycle`.**

### Task 3: Attach the Duty adapter

**Files:**
- Modify: `wdintel-web/src/ts/react/routes/rer-duty-neo/index.tsx`
- Test: `wdintel-web/src/ts/react/routes/rer-duty-neo/__tests__/index.spec.tsx`
- Test: `wdintel-web/src/ts/react/routes/rer-duty-neo/__tests__/useRerDutyFeedState.initial-load.spec.tsx`

**Interfaces:** Consume Task 2's controller. Duty's `materialize` keeps `resolveDutyTargetMessageIds`, `setFeedInitialTarget`, `applyFilter`, and the current loading-observed guard; its landing value is `{ feedId: string; targetIds: number[] }`. Bridge the state-driven feed load to the returned promise: settle it when the matching feed's loading cycle finishes, reject it on that load's error, and cancel it on feed removal/filter change. `land` uses the matching column's `scrollToMessage` handle and `scrollToAndHighlightMessage` only after this acknowledgment. `invalidateNavigation` clears pending target IDs/load guards; user filter/feed changes and unmount call `cancel`.

- [ ] **Step 1: Add failing Duty route tests.** Cover one unfiltered cold-link feed with stored filters unchanged, exact numeric ID preference, context unavailable, context/window errors, target absent after load, pending request invalidated by feed/filter change, one notification per failure, and no false unread count.
- [ ] **Step 2: Run `cd wdintel-web && npm run test:ts -- src/ts/react/routes/rer-duty-neo/__tests__/index.spec.tsx src/ts/react/routes/rer-duty-neo/__tests__/useRerDutyFeedState.initial-load.spec.tsx`; confirm new assertions fail.**
- [ ] **Step 3: Replace Duty's two independent permalink effects with the adapter/controller path in `index.tsx`; preserve existing live-feed state updates and route-specific loading behavior.** Pass failures to the existing snackbar through shared error text; do not show success on landing.
- [ ] **Step 4: Run the two tests plus `rer-duty-scroll-stability.spec.ts`; confirm Duty's bounded window and newer/older loading still pass.**
- [ ] **Step 5: Commit only Task 3 files with `refactor(3689): routed Duty links through shared navigation`.**

### Task 4: Attach the Analysis adapter

**Files:**
- Modify: `wdintel-web/src/ts/react/routes/rer-analysis-neo/use-rer-analysis-neo-page.ts`
- Modify: `wdintel-web/src/ts/react/routes/rer-analysis-neo/components/AnalysisMessagesPane.tsx`
- Modify: `wdintel-web/src/ts/react/routes/rer-analysis-neo/AnalysisPageLayout.tsx`
- Modify: `wdintel-web/src/ts/react/routes/rer-analysis-neo/types.ts` (only if a landing acknowledgment must cross the page/pane boundary)
- Test: `wdintel-web/src/ts/react/routes/rer-analysis-neo/__tests__/use-rer-analysis-neo-page.spec.tsx`
- Test: `wdintel-web/src/ts/react/routes/rer-analysis-neo/components/__tests__/AnalysisMessagesPane.spec.tsx`

**Interfaces:** Consume Task 2's controller. Analysis `materialize` retains default-role/date/time-basis readiness, `adjustQueryDateRangeForDirectMessage`, `fetchInboxWindow`, and focused-window/page-count bookkeeping; its landing value is `{ targetMessageId: number; window: InboxWindowRsp }`. Add `onLinkedMessageMounted: (messageId: number) => void` to the page view model and pane props; the pane invokes it after its `MessageFeed` exposes and highlights the target, fulfilling the adapter's pending `land` promise. `invalidateNavigation` uses the existing request generation and focus/window cleanup; user query/page changes cancel only pending navigation, while ordinary focused-window pagination remains active. Keep `directMessageError` and the layout's existing snackbar effect as the single notification path; set that state from the shared `messageNavigationErrorText`.

- [ ] **Step 1: Add failing Analysis tests.** Cover an old target outside default dates, saved sort basis, no saved-filter reapplication on copied links, unavailable target, window missing after context, late context/window replies after query or page change, context refresh, mounted-target acknowledgment, and exactly one privacy-safe notification.
- [ ] **Step 2: Run `cd wdintel-web && npm run test:ts -- src/ts/react/routes/rer-analysis-neo/__tests__/use-rer-analysis-neo-page.spec.tsx src/ts/react/routes/rer-analysis-neo/components/__tests__/AnalysisMessagesPane.spec.tsx`; confirm new assertions fail.**
- [ ] **Step 3: Replace the Analysis context/window chain with its adapter/controller path and wire `onLinkedMessageMounted` through the page layout to the pane.** Preserve the existing state used by `useAnalysisData`, page buttons, scroll-driven page changes, reverse ordering, and bidirectional focused loading. Set `directMessageError` from shared outcome text and keep the existing layout snackbar effect; do not notify from the controller callback directly.
- [ ] **Step 4: Run the Analysis tests and `message-feed-unification.spec.ts`; confirm page/chunk behavior still passes.**
- [ ] **Step 5: Commit only Task 4 files with `refactor(3689): routed Analysis links through shared navigation`.**

### Task 5: Browser regressions and final verification

**Files:**
- Modify: `wdintel-web/tests/e2e/rer-duty-workflows.spec.ts`
- Modify: `wdintel-web/tests/e2e/analysis-neo.spec.ts`
- Modify: `wdintel-web/tests/e2e/rer-duty-scroll-stability.spec.ts` or `wdintel-web/tests/e2e/message-feed-unification.spec.ts` only if an existing assertion needs extension

**Interfaces:** No new production API. Browser tests verify the route contracts from the spec end to end.

- [ ] **Step 1: Extend Playwright coverage for copying/opening links on both routes and an unavailable link.** Assert exact route, one unfiltered Duty column, visible/highlighted target, one error notification for unavailable, and unaffected Duty newer loading/Analysis scroll-driven pagination.
- [ ] **Step 2: Run `cd wdintel-web && npm exec -- playwright test tests/e2e/rer-duty-workflows.spec.ts tests/e2e/analysis-neo.spec.ts tests/e2e/rer-duty-scroll-stability.spec.ts tests/e2e/message-feed-unification.spec.ts`; confirm pass or report environment-only failures precisely.**
- [ ] **Step 3: Run `cd wdintel-web && npm run format:staged`, the affected Vitest suites, `just test-fe`, and `just build-front`; inspect `git diff --check` and verify no unrelated formatter changes.**
- [ ] **Step 4: Commit only final task files with `test(3689): covered shared message navigation`.** Do not push without permission.
