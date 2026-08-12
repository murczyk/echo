# Duty Neo feed scroll performance (2026-08-12)

Issue context: [#3059](https://github.com/echoua/echo/issues/3059).

Related live summary: [`docs/ai-spec/duty_scroll_behavior.md`](../../docs/ai-spec/duty_scroll_behavior.md).

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

1. **Cheap closed cards** — fewer `Tooltip` / `ButtonBase` / Emotion paths on the default closed Duty row (largest sample share).
2. **`startTransition` for window `items` updates** — keep scrolling responsive while the list commit runs (softens jank; does not remove CPU).
3. **Freeze / unmount non-visible feeds** — especially narrow multi-feed: inactive columns must not keep full live card trees when practical (already: inactive must not arm loads / unread; extend toward not paying full commit cost).
4. **Re-measure on a prod-like build** — confirm absolute timings without `jsxDEV` / `checkPropTypes`.

Do **not** prioritize more scroll-hook micro-opts as the primary fix; the profile points at **card render volume × MUI**, amplified by **multi-feed single-threaded commits**.

---

## Code map (perf-related)

| Concern | File |
| --- | --- |
| Window + anchor + load zones | `useWindowedFeedScroll.ts` |
| List / card / FAB UI | `FeedColumnContent.tsx` |
| FAB badge store (poll isolation) | `feedColumnFab.ts` |
| List memo equality (ignore unread/readIds) | `utils.ts` → `feedListRenderStateEqual` |
| Hot-path rules | `rer-duty-neo/AGENTS.md` |
| Message card hot path | `routes/shared/message-card/*` |
