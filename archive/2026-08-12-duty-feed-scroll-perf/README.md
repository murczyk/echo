# Duty Neo feed scroll performance (2026-08-12)

Issue context: [#3059](https://github.com/echoua/echo/issues/3059).

Related live summary: [`docs/duty/README.md`](../../docs/duty/README.md).

Route rules: [`wdintel-web/src/ts/react/routes/rer-duty-neo/AGENTS.md`](../../wdintel-web/src/ts/react/routes/rer-duty-neo/AGENTS.md).

---

## Symptom

- Scroll staggers grow as the user loads more older/newer pages.
- More open feeds makes it worse: lag in one feed blocks the whole page.
- Profile captured while scrolling **two feeds** in sequence (`after.json`, Vite/dev).

---

## Profile verdict (`after.json`)

- Dominant stalls are React **`performWorkUntilDeadline`** (~2.0–2.9s each), repeating while scrolling.
- Thousands of **DroppedFrame** events; layout/paint are secondary to JS/React commit cost.
- CPU samples concentrate in **MessageCard / MUI Emotion** hot path:
  - `handleInterpolation`, `serializeStyles`, `murmur2`
  - `ButtonBase`, `Tooltip`, `Popper`
  - Dev tax: `jsxDEV`, `checkPropTypes`
- Scroll-hook / window math (`useWindowedFeedScroll`) is present but not the multi-second cost center.

Dev/Vite builds inflate absolute ms; the **shape** of the bottleneck is still real.

---

## Why it worsens with more loads / more feeds

1. **Full-window card mounts** — each column keeps up to **40** messages fully mounted (Virtuoso mount-layer attempt was rolled back; see below). Each older/newer page trim remounts a large chunk of heavy cards → multi-second commits.
2. **Single React tree / single JS thread** — a commit for feed A blocks scroll/input for feed B and the rest of the page. `memo` / `feedListRenderStateEqual` / FAB store avoid *unnecessary* list rebuilds; they do **not** make two feeds’ work concurrent.
3. **Shared parent updates** still run column shells; when `items` identity changes on a feed, that feed pays the full MessageCard reconcile cost.

---

## What was tried around this date

| Change | Intent | Outcome |
| --- | --- | --- |
| Stable per-feed actions + `feedListRenderStateEqual` | Stop poll/badge from invalidating the list | Helps isolation; not enough alone |
| FAB state store (`feedColumnFab.ts`, formerly `feedColumnChrome`) | Badge/arrow updates without list remount | Helps; publish must be in `useLayoutEffect` (not during render) |
| Scroll-idle newer loads, pixel near-bottom, prefetch ≥10 | Smoother load arming / less mid-fling trim | Behavior wins; does not cut MessageCard CPU |
| Virtuoso as **DOM mount layer** only (`customScrollParent`) | Mount viewport+overscan only | Rolled back: spacer/height churn fought Duty anchor restore → jumping scrollbar / white viewport. Team also flagged Virtuoso docs: hard to avoid list jump with external window/scroll control |

`AGENTS.md` again: **do not restore Virtuoso to Duty** without deliberate validation. XLSX Virtuoso usage is unrelated.

---

## Suggested next levers (no Virtuoso)

Ordered by expected impact on this profile:

1. **Cheap closed cards** — fewer `Tooltip` / `ButtonBase` / Emotion paths on the default closed Duty row (largest sample share). **Done (2026-08-13):** native action buttons + CSS group; duty relative time uses `title` instead of Tooltip/Typography.
2. **`startTransition` for window `items` updates** — keep scrolling responsive while the list commit runs (softens jank; does not remove CPU). **Done (2026-08-13):** `commitFeedWindowUpdate` wraps older/newer window commits in `useRerDutyDirectionalLoads`.
3. **Freeze / unmount non-visible feeds** — especially narrow multi-feed: inactive columns must not keep full live card trees when practical. **Done (2026-08-13):** narrow workspace mounts only the active `FeedColumn`. **Desktop:** do not hide columns — use idle viewport offload instead (below).
4. **`pendingNewerItems` (Elm `notRenderedMessagesYet`)** — near-bottom non-follow newer pages stay off the DOM until scroll idle / follow / arrow. Prefetch counts pending unread. **Done (2026-08-13); idle flush + activate flush same day.**
5. **Idle viewport offload** — multi-feed: after ~10s without pointer/wheel/touch on a feed, replace off-viewport MessageCards with height placeholders; wake remounts the window. **Done (2026-08-13).**
6. **Re-measure on a prod-like build** — confirm absolute timings without `jsxDEV` / `checkPropTypes`. *(still open)*

Do **not** prioritize more scroll-hook micro-opts as the primary fix; the profile points at **card render volume × MUI**, amplified by **multi-feed single-threaded commits**.

Phased follow-up (desktop active-only, pending soak, cheap cards, optional TanStack):
[`../2026-08-13-duty-scroll-perf-plan/README.md`](../2026-08-13-duty-scroll-perf-plan/README.md).

---

## Code map (perf-related)

| Concern | File |
| --- | --- |
| Window + anchor + load zones | `useWindowedFeedScroll.ts` |
| List / card / FAB UI | `FeedColumnContent.tsx` |
| FAB badge store (poll isolation) | `feedColumnFab.ts` |
| Transition window commits | `feedWindowCommit.ts` |
| Pending newer buffer / flush | `utils.ts` (`pendingNewerItems`, `flushPendingNewerItems`), `useRerDutyDirectionalLoads.ts` |
| Narrow active-only column mount | `RerDutyNeoWorkspace.tsx` |
| Idle viewport offload (multi-feed) | `useFeedIdleViewportOffload.ts`, `FeedColumnContent.tsx` |
| List memo equality (ignore unread/readIds/pending) | `utils.ts` → `feedListRenderStateEqual` |
| Hot-path rules | `rer-duty-neo/AGENTS.md` |
| Message card hot path | `routes/shared/message-card/*` |
