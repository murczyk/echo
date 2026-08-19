# Duty Neo scroll performance — implementation plan

Issue: [#3059](https://github.com/echoua/echo/issues/3059).

Live summary: [`docs/duty/README.md`](../../docs/duty/README.md).  
Prior profile notes: [`../2026-08-12-duty-feed-scroll-perf/README.md`](../2026-08-12-duty-feed-scroll-perf/README.md).  
Route rules: [`wdintel-web/src/ts/react/routes/rer-duty-neo/AGENTS.md`](../../wdintel-web/src/ts/react/routes/rer-duty-neo/AGENTS.md).

## Goal

Make **3-feed Duty** usable while scrolling under CPU stress (incl. DevTools 4×), for the common case of hundreds of messages in the filter / multi-page windows.

Success is **not** “zero cost on MessageCard.” Success is:

1. Mid-list / near-zone scrolling stays interactive (no multi-second freezes under the finger).
2. One feed’s window commit does not freeze the other two columns’ scroll handlers.
3. Hitting bottom / arrow still catches up correctly (may hitch once; that hitch is acceptable).

## Constraint (do not forget)

One JS thread. Virtual DOM does not isolate columns. Iframes / micro-frontends are out of scope unless this plan fails after Phase C.

Do **not** restore Virtuoso without a dedicated validation spike (see Phase D). Prefer TanStack Virtual only after A–C land and still fail the acceptance bar.

---

## Current baseline (already on the #3059 branch)

| Lever | Status | Notes |
| --- | --- | --- |
| Cheap closed card chrome | **Done** | Native action buttons + CSS; duty relative time via `title` |
| `startTransition` window commits | **Done** | `commitFeedWindowUpdate`; urgent path for bottom/follow |
| Narrow active-only column mount | **Done** | `RerDutyNeoWorkspace` mounts only active feed on narrow |
| `pendingNewerItems` + idle / physical flush | **Done (needs soak)** | Buffer near-zone non-follow; flush idle (~140ms) or urgent at physical bottom / arrow |
| Desktop active-only columns | **Reverted** | Users need all feeds visible; replaced by idle viewport offload |
| Idle viewport offload (10s) | **Done (2026-08-13)** | Multi-feed: after idle, off-viewport MessageCards → height placeholders; wake on pointer/wheel/touch |
| Further cheap-card cuts | **Partial** | Closed path improved; open/expanded + shared MessageCard still heavy |
| Viewport virtualization | **Not done** | Virtuoso rolled back; TanStack not started |
| Prod-like re-profile | **Open** | Dev/Vite inflates absolute ms |

---

## Phase A — Stabilize pending / idle flush (finish what we started)

**Status: Done (2026-08-13)** — urgent live append + ref sync, stick-bottom without fake follow:disable, idle/physical flush, activate flush.

**Why first:** wrong flush timing looks like “bottom broken” and forces live commits that reintroduce jank. Ship behavior correctness before mounting fewer columns.

### Work

1. Soak / fix remaining races from recent logs:
   - Urgent live append at physical bottom + sync `messageFeedsRef` (so `since` advances).
   - Stick-bottom catch-up must not fake `follow:disable` from settle jitter.
   - Avoid double urgent flush where harmless but noisy.
2. Debug snapshot always includes `pendingNewerCount`, `buffer=`, `physical=`, `urgent=` (mostly present).
3. Acceptance scenarios (manual + extend unit tests where cheap):
   - Near-zone scroll while unread arrives → `buffer=true`, `items` tail unchanged, badge/pending grow.
   - Stop scrolling near bottom → `pending-newer:idle-flush` within ~140–200ms.
   - Physical bottom → `urgent` flush / live append; next `since` / `loadedTail` advances.
   - Arrow → flush + follow + catch-up.
   - Watch off + preserve-pending-tail → load continues without auto-follow; messages still appear after flush/append.

### Exit criteria

- No “reach bottom, pending stuck forever” reports.
- No repeated `since=<same tail>` after `added>0` at physical bottom.
- `docs/duty/README.md` matches actual flush rules.

### Owners / files

- `useRerDutyDirectionalLoads.ts`, `useWindowedFeedScroll.ts`, `utils.ts` (`pendingNewer*`), `index.tsx`, `feedWindowCommit.ts`

---

## Phase B — Desktop active-only (or visibility) column mounts

**Status: Reverted (2026-08-13)** — hiding inactive lists is not acceptable (users must see all feeds). Replaced by **idle viewport offload**: after ~10s without interaction on a feed, off-viewport MessageCards become height placeholders (`useFeedIdleViewportOffload`); all columns stay visible; pointer/wheel/touch wakes the feed.

### Design choices (decide in this phase)

| Option | Behavior | Recommendation |
| --- | --- | --- |
| **B1. Focus-active only** | Only `activeFeedId` mounts `FeedColumn` body (like narrow) | Best CPU; desktop users must click/focus a column to scroll it |
| **B2. Visible-only** | Mount columns intersecting the workspace viewport (horizontal scroll) | Better UX if columns can be off-screen; more work |
| **B3. Hybrid** | Mount active + optionally one neighbor | Compromise |

Default proposal: **B1 for `feedCount >= 2` on desktop**, same shell as narrow (headers/FAB chrome can stay; no MessageCard tree / no scroll tracking on inactive).

### Work

1. Extend `RerDutyNeoWorkspace` (or column wrapper):
   - Inactive: keep column chrome (title, badge via FAB store, filters entry) **without** `FeedColumnContent` list / `useWindowedFeedScroll`.
   - Active: full column as today.
2. Inactive feeds **must** keep:
   - Poll / unread / `pendingNewerItems` state (in hooks, not DOM).
   - Badge updates via `feedColumnFab`.
   - No `onLoadNewer` from scroll (no scroll hook).
3. On activate:
   - Mount list, restore scroll (bottom if watch / last anchor if we store it — v1: pin bottom or last known `scrollTop` if easy).
   - Flush pending urgently if near/physical intent is “catch up” (define: flush on activate when `pendingNewerCount > 0` and previous near/bottom flags were true — or always flush on activate to avoid surprise empty live edge).
4. Tests:
   - Workspace: only one content tree mounted when 3 feeds.
   - Switching active feed remounts the other without losing feed state (items/unread).
5. Docs + `AGENTS.md`: desktop multi-feed = active-only card trees.

### Exit criteria

- Profiling 3 feeds / 4×: scrolling the **active** column no longer shows multi-second commits driven by **inactive** columns’ MessageCards.
- Inactive columns still show correct badges and can be activated without reload.

### Risks

- Users expect to glance-scroll two columns at once → document; consider B2 later if product rejects B1.
- Remount cost on tab-switch between feeds — acceptable vs continuous jank.

---

## Phase C — Cheap closed cards (second pass)

**Status: Deferred** — first cheap-closed pass already shipped; do a profiler-guided second pass only if Phase B + pending flush still fail the 4× / 1-active-feed bar.

**Why:** even one active column still mounts up to 40 cards. Closed-row CPU is still the sample hot path.

### Work (prioritized)

1. Audit closed `MessageCard` / `MessageCardHeader` / duty list row under profiler (prod-like build).
2. Cut remaining always-mounted MUI on closed path (extra `Typography`, `ButtonBase`, tooltips, theme interpolations).
3. Keep menus/dialogs **unmounted until open** (already a rule).
4. Do **not** break XLSX / analysis MessageCard variants — duty-only or prop-gated cheap path.
5. Re-check `AGENTS.md` hot-path list after changes.

### Exit criteria

- Closed-row samples drop meaningfully vs Phase B baseline on the same 4× / 1-active-feed scenario.
- Visual parity with MUI theme (no hard-coded one-off colors).

### Files

- `routes/shared/message-card/*`, duty list item wrappers, `_base.css` utilities as needed

---

## Phase D — Viewport virtualization (optional, after A–C)

Only if Phase B+C still fail acceptance under 4× with **one** active feed of ~40 variable-height cards.

### Spike (time-box 1–2 days)

1. **TanStack Virtual** on **one** feed, Duty still owns:
   - window trim (40)
   - pending buffer / flush
   - anchor restore / stick-bottom
2. Measure:
   - prepend older (no jump > 1–2px after restore)
   - append newer / flush pending
   - physical bottom stick
3. **Pass:** mount count ≈ viewport+overscan; no white gap; no scrollbar teleport.
4. **Fail:** roll back spike; do not productize.

### Explicit non-goals for spike

- Virtuoso `customScrollParent` (already failed).
- Virtualizing inactive columns (they should not mount).
- Removing the 40-window (virtualization complements windowing; does not replace unread/tail rules).

---

## Phase E — Measure & gate

1. Capture profiles on **prod-like** front build (not only Vite dev).
2. Scenarios:
   - 1 feed, scroll mid-list + near-zone prefetch
   - 3 feeds, scroll **active** only (after Phase B)
   - Arrow catch-up / physical bottom
3. Compare DroppedFrame / longtask / FunctionCall to pre-B baseline.
4. Update this archive README + `docs/duty/README.md` with results.
5. Keep CHANGELOG `#3059` in sync with user-visible behavior.

---

## Suggested order of PRs

| PR | Scope |
| --- | --- |
| **PR1** | Phase A soak fixes only (ref/urgent/settle) + tests/docs |
| **PR2** | Phase B desktop active-only mounts |
| **PR3** | Phase C cheap closed card pass |
| **PR4** | Phase E profiles + doc results (can merge notes into PR2/PR3) |
| **PR5** | Phase D TanStack spike (optional; separate branch) |

Do not combine B + D in one PR.

---

## Acceptance bar (product)

Under DevTools **4× CPU**, **3 feeds**, hundreds of messages in the filter:

| Interaction | Expected |
| --- | --- |
| Scroll active column mid-list | No multi-second freezes; scroll continues |
| Near-zone while not following | Prefetch may buffer; list does not remount under finger |
| Stop near bottom | Pending appears after idle (~140ms) or on physical bottom urgently |
| Switch active feed | Other columns show badges; activating remounts that list |
| Arrow / watch catch-up | May hitch once; then correct tail / unread |

If this bar is met **without** Phase D, stop. Virtualization is optional insurance, not the default next step.
