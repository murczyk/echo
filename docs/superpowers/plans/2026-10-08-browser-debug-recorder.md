# Browser Debug Recorder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a production-safe, global, user-triggered browser flight recorder that captures up to 60 seconds of privacy-sanitized diagnostic events and downloads them as Markdown.

**Architecture:** A global TypeScript singleton owns lifecycle, bounded storage, sanitization, collectors, anomaly correlation, and Markdown export. It mounts one React panel outside route content, is activated by eight presses on the authenticated navbar megaphone, survives reload through one `sessionStorage` key, and accepts route-specific semantic events through a small API. Existing Duty instrumentation becomes an adapter to that API while its separate activator and panel are removed.

**Tech Stack:** TypeScript, React 18, browser APIs, Vitest/jsdom, Playwright, Elm navbar props; no new runtime dependency and no backend work.

**Spec:** `docs/superpowers/specs/2026-10-08-browser-debug-recorder-design.md`

## Global Constraints

- The recorder is available to every authenticated user in both `Debug` and `Live` modes; there is no environment or role gate.
- Activation is exactly eight presses within 4,000 ms on the existing header changelog/maintenance button.
- A recording retains its original 60,000 ms deadline across reloads and stores at most 1,000 events or 1,048,576 serialized bytes.
- Ready recordings expire after 600,000 ms, on logout, on the shared 401 event, or when their tab session ends.
- Collection and export must never retain request/response bodies or headers, cookies, query strings, fragments, input values, DOM text, clipboard/file/media content, storage values, raw user or application IDs, IPs, hostnames, or full user-agent strings.
- Collectors, observers, wrappers, and timers exist only while recording and must restore native behavior exactly on every stop path.
- Recorder failures are best-effort and fail closed; they may drop diagnostic data but may not alter product behavior.
- Exact component lifecycle remains semantic-adapter-only; generic DOM observation must not claim React lifecycle meaning.
- Do not add a backend endpoint, database migration, runtime dependency, screenshot/video capture, automatic upload, or cross-tab sharing.
- Leave `README.md` and `docs/README.md` unchanged.

## Review Focus

1. Hostile or malformed diagnostic inputs, including cyclic objects and throwing getters, must be dropped or structurally sanitized without reading secrets; Task 1 pins this with sentinel and getter tests.
2. Disabled/private storage, quota errors, malformed snapshots, and oversized restored values must preserve in-memory recording or safely clear only the recorder key; Task 2 pins each path.
3. Repeated initialization and start/finish cycles must not stack listeners or wrappers, and wrapped fetch/XHR/console/history behavior must stay byte-for-byte compatible from the caller's perspective; Tasks 4, 5, and 7 pin restoration and idempotency.
4. Unsupported performance entries and mutation/request floods must be coalesced without breaking or exhausting the recorder; Tasks 3 and 6 pin bounded behavior and capability reporting.
5. Reload, logout, 401, and separate-tab scenarios must retain only the intended current-tab session and clear it at authentication boundaries; Tasks 2, 7, and 10 pin these transitions.

---

## File Map

New production modules under `wdintel-web/src/ts/debug-recorder/`:

- `config.ts` — schema/storage constants, caps, thresholds, and coalescing rules.
- `types.ts` — public event API, persisted session, snapshot, collector, anomaly, and environment contracts.
- `sanitize.ts` — safe route templates, per-recording aliases, structural allowlists, error normalization, and defensive export sanitization.
- `export-markdown.ts` — deterministic report generation and browser download.
- `storage.ts` — validation and access to the single namespaced `sessionStorage` key.
- `store.ts` — lifecycle, ring buffer, byte/event caps, persistence, subscriptions, finish/expiry, and download state.
- `anomalies.ts` — pure bounded anomaly correlation and summary production.
- `collectors/http.ts` — temporary fetch/XHR wrappers and request coalescing.
- `collectors/errors.ts` — window/resource/rejection/CSP and console warning/error signals.
- `collectors/interaction-navigation.ts` — safe interaction, focus, history, navigation, page lifecycle, and reload/BFCache signals.
- `collectors/scroll-performance.ts` — user/programmatic scroll intent, scroll samples, layout shifts, long tasks, resources, and timer stalls.
- `collectors/dom-loading.ts` — bounded root/custom-element replacement and loading/skeleton transitions.
- `collectors/index.ts` — collector attachment, capability status, isolated cleanup, and collector failure accounting.
- `DebugRecorderPanel.tsx` — recording, ready, retry, and timer UI.
- `debug-recorder-root.tsx` — the single body-level React root.
- `index.ts` — singleton orchestration, environment configuration, hidden activator, semantic API, and auth-boundary cleanup.

Tests are colocated in `wdintel-web/src/ts/debug-recorder/__tests__/` and `collectors/__tests__/`. Existing integration files change only where listed in Tasks 7–9. One focused operator guide is added at `docs/browser-debug-recorder.md`; the changelog receives one `NEXT` entry.

### Task 1: Safe event contracts, sanitization, and Markdown export

**Files:**
- Create: `wdintel-web/src/ts/debug-recorder/config.ts`
- Create: `wdintel-web/src/ts/debug-recorder/types.ts`
- Create: `wdintel-web/src/ts/debug-recorder/sanitize.ts`
- Create: `wdintel-web/src/ts/debug-recorder/export-markdown.ts`
- Create: `wdintel-web/src/ts/debug-recorder/__tests__/sanitize.spec.ts`
- Create: `wdintel-web/src/ts/debug-recorder/__tests__/export-markdown.spec.ts`

**Interfaces:**
- Consumes: no feature code; only standard browser and TypeScript APIs.
- Produces: `DebugEventInput`, `DebugEvent`, `DebugTarget`, `DebugSafeValue`, `DebugBuildMetadata`, `DebugEnvironment`, `PersistedDebugSession`, `DebugRecorderSnapshot`, `DebugAnomalySummary`, `DebugEventSink`, `DebugCollectorCleanup`, and `DebugCollectorSupport`; `createDebugSanitizer(recordingId: string): DebugSanitizer`; `collectDebugEnvironment(metadata: DebugBuildMetadata): DebugEnvironment`; `buildDebugMarkdown(session: PersistedDebugSession): string`; `downloadDebugMarkdown(markdown: string, startedAt: number): boolean`.

- [ ] **Step 1: Write failing sanitizer tests**

  In `sanitize.spec.ts`, add named cases asserting:

  - `safeRoute('/rer-duty-neo/42?token=SECRET#SECRET')` returns `/rer-duty-neo/{id_1}` and never contains either secret;
  - repeated numeric/UUID values receive stable aliases within one sanitizer and different aliases do not collide;
  - target output contains only `tag`, `role`, `inputType`, and a validated static `testId`, never text/value/name/label/arbitrary attributes;
  - cyclic values, excessive depth/key count/string length, control characters, Markdown fences, HTML, and prompt-like strings are bounded/escaped;
  - a throwing getter is never invoked and raw console objects, headers, bodies, storage, DOM/input text, coordinates, callsigns, UUIDs, IPs, and hostnames seeded with `ECHO_SECRET_SENTINEL` do not survive sanitization.

- [ ] **Step 2: Write failing exporter tests**

  In `export-markdown.spec.ts`, assert a fixed session produces the same string twice, starts with an untrusted-evidence warning, contains schema/recording/version/mode/coarse-browser/viewport/route/minute-rounded-start/duration metadata, an anomaly summary, fenced JSONL in sequence order, and redaction/truncation/eviction/capability/persistence statistics. Assert `ECHO_SECRET_SENTINEL`, query/hash data, raw IDs, full UA, hostname, and a fence-closing payload are absent. Assert environment collection keeps only browser family and major version (`Chromium`, `Firefox`, `Safari`, `Edge`, or `Unknown`) plus viewport and DPR, never the raw UA.

- [ ] **Step 3: Run the focused tests and verify the missing-module failure**

  Run: `cd wdintel-web && npm run test:ts -- src/ts/debug-recorder/__tests__/sanitize.spec.ts src/ts/debug-recorder/__tests__/export-markdown.spec.ts`

  Expected: FAIL because the new modules do not exist.

- [ ] **Step 4: Define the contracts and fixed constants**

  Add the types listed in Interfaces and these exported constants in `config.ts`: `DEBUG_SCHEMA_VERSION = 1`, `DEBUG_STORAGE_KEY = 'echo-browser-debug-recorder-v1'`, `DEBUG_RECORDING_MS = 60_000`, `DEBUG_READY_TTL_MS = 600_000`, `DEBUG_MAX_EVENTS = 1_000`, `DEBUG_MAX_BYTES = 1_048_576`, `DEBUG_PERSIST_DEBOUNCE_MS = 250`, `DEBUG_ACTIVATOR_PRESSES = 8`, and `DEBUG_ACTIVATOR_WINDOW_MS = 4_000`.

- [ ] **Step 5: Implement the collection-boundary sanitizer**

  Implement `createDebugSanitizer(recordingId)` with `safeRoute(url)`, `safeTarget(element)`, `safeError(value)`, `sanitizeInput(input, context)`, `alias(scope, value)`, and `sanitizeSessionForExport(session)`. Use allowlisted structural copying without generic property enumeration or getter access; remove query/fragment before aliasing, and use per-recording sequential aliases rather than reversible hashes.

- [ ] **Step 6: Implement deterministic Markdown generation and download**

  `collectDebugEnvironment` combines configured Echo version/mode with a sanitized start route, browser family/major version, viewport, and DPR at start time. `buildDebugMarkdown` performs a second sanitizer pass and writes only the five sections fixed by the spec. `downloadDebugMarkdown` creates a UTF-8 Markdown `Blob`, clicks a temporary `a[download]` with filename `echo-debug-YYYYMMDD-HHmmss.md`, revokes the object URL, returns `true` only after setup/click succeeds, and returns `false` without throwing otherwise.

- [ ] **Step 7: Run and pass the focused tests**

  Run: `cd wdintel-web && npm run test:ts -- src/ts/debug-recorder/__tests__/sanitize.spec.ts src/ts/debug-recorder/__tests__/export-markdown.spec.ts`

  Expected: PASS.

- [ ] **Step 8: Format and commit the safety core**

  Run: `cd wdintel-web && npm run format:staged`

  ```bash
  git add wdintel-web/src/ts/debug-recorder
  git commit -m "feat(3709): added debug recorder safety core"
  ```

### Task 2: Recorder lifecycle, bounded buffer, and reload persistence

**Files:**
- Create: `wdintel-web/src/ts/debug-recorder/storage.ts`
- Create: `wdintel-web/src/ts/debug-recorder/store.ts`
- Create: `wdintel-web/src/ts/debug-recorder/__tests__/storage.spec.ts`
- Create: `wdintel-web/src/ts/debug-recorder/__tests__/store.spec.ts`

**Interfaces:**
- Consumes: Task 1 contracts, constants, sanitizer, exporter, and downloader.
- Produces: `BrowserDebugRecorder` with `configure(metadata: DebugBuildMetadata): void`, `start(): void`, `finish(): void`, `download(): boolean`, `record(input: DebugEventInput): void`, `flush(): void`, `aliasIdentifier(scope: string, value: string | number): string | null`, `clear(): void`, `subscribe(listener: () => void): () => void`, and `getSnapshot(): DebugRecorderSnapshot`; `createBrowserDebugRecorder(deps?: DebugRecorderDependencies): BrowserDebugRecorder`; `loadDebugSession(storage: Storage, nowMs: number): PersistedDebugSession | null`; `saveDebugSession(storage: Storage, session: PersistedDebugSession): boolean`; `clearDebugSession(storage: Storage): void`.

- [ ] **Step 1: Write failing storage validation tests**

  Assert only `DEBUG_STORAGE_KEY` is read/written/removed; valid schema-1 recording and ready states restore; malformed JSON, wrong schema, impossible state/deadline/sequence, expired ready state, and values over 1 MiB are removed. Simulate `getItem`, `setItem`, and quota errors and assert they return safe failure results without touching other keys.

- [ ] **Step 2: Write failing lifecycle and cap tests**

  With fake timers and injected clock/storage/downloader, assert: duplicate start is ignored; `startedAt`, `deadlineAt`, aliases, and sequence survive recreation; timeout occurs at the original 60-second deadline; event 1 is evicted when event 1,001 arrives; byte pressure evicts oldest events until serialized size is at most 1,048,576; `droppedEvents` is exact; failed persistence sets `persistenceFailed` but keeps memory; failed download remains `ready`; successful download clears memory/storage; ready expiry after 600,000 ms clears; finish/clear are idempotent; two injected storage objects do not share state.

- [ ] **Step 3: Run tests and verify failure**

  Run: `cd wdintel-web && npm run test:ts -- src/ts/debug-recorder/__tests__/storage.spec.ts src/ts/debug-recorder/__tests__/store.spec.ts`

  Expected: FAIL because storage/store do not exist.

- [ ] **Step 4: Implement isolated storage access and restore validation**

  Implement the three storage functions from Interfaces. Parse once, validate every field and cap before returning, never enumerate storage, and delete only `DEBUG_STORAGE_KEY` on invalid/expired input.

- [ ] **Step 5: Implement the external-store lifecycle**

  Implement `createBrowserDebugRecorder` with monotonic `seq`, elapsed time based on the injected wall clock, debounced persistence plus synchronous `pagehide` flush support, byte accounting through `TextEncoder`, oldest-first eviction, and transient internal `downloaded`/`expired` transitions that settle to the public `idle` snapshot. Restoring `recording` schedules only the remaining deadline.

- [ ] **Step 6: Run and pass lifecycle tests**

  Run: `cd wdintel-web && npm run test:ts -- src/ts/debug-recorder/__tests__/storage.spec.ts src/ts/debug-recorder/__tests__/store.spec.ts`

  Expected: PASS with no leaked fake timers.

- [ ] **Step 7: Format and commit the lifecycle**

  Run: `cd wdintel-web && npm run format:staged`

  ```bash
  git add wdintel-web/src/ts/debug-recorder/storage.ts wdintel-web/src/ts/debug-recorder/store.ts wdintel-web/src/ts/debug-recorder/__tests__
  git commit -m "feat(3709): persisted bounded debug recordings"
  ```

### Task 3: Pure anomaly correlation

**Files:**
- Create: `wdintel-web/src/ts/debug-recorder/anomalies.ts`
- Create: `wdintel-web/src/ts/debug-recorder/__tests__/anomalies.spec.ts`
- Modify: `wdintel-web/src/ts/debug-recorder/config.ts`
- Modify: `wdintel-web/src/ts/debug-recorder/store.ts`
- Modify: `wdintel-web/src/ts/debug-recorder/__tests__/store.spec.ts`

**Interfaces:**
- Consumes: sanitized `DebugEvent` values from Task 2.
- Produces: `createDebugAnomalyDetector(): DebugAnomalyDetector`, whose `observe(event: DebugEvent): DebugEventInput[]`, `finish(atMs: number): DebugEventInput[]`, and `getSummary(): DebugAnomalySummary` are called only by the store; anomaly inputs use `source: 'detector'` and `kind: 'anomaly.*'`.

- [ ] **Step 1: Write failing detector tests with fixed thresholds**

  Add table-driven tests for these exact first-version rules:

  - scroll jump: absolute delta at least `max(320 px, 0.5 * clientHeight)` with no user or known programmatic scroll intent in the prior 750 ms; correlate layout shift or focus within 500 ms;
  - DOM replacement storm: at least three substantial replacements in 2,000 ms;
  - skeleton flicker: at least four visibility transitions in 2,000 ms; stuck: continuously visible for 10,000 ms or still visible at finish;
  - duplicate HTTP: two overlapping same-method/safe-route requests; storm: ten starts for the same safe route in 5,000 ms; retry loop: three failed/aborted attempts in 10,000 ms; slow request: 3,000 ms except named long-poll rules;
  - repeated warning/error: same fingerprint three times in 5,000 ms;
  - long task: at least 50 ms; main-thread stall: timer drift at least 1,000 ms; semantic render storm: 20 render/commit events in 1,000 ms;
  - `navigation.reload` and `navigation.bfcache-restored` each create one anomaly summary item.

  Assert detector-generated events are not observed recursively and internal windows remain bounded after 10,000 input events.

- [ ] **Step 2: Run the detector test and verify failure**

  Run: `cd wdintel-web && npm run test:ts -- src/ts/debug-recorder/__tests__/anomalies.spec.ts`

  Expected: FAIL because the detector does not exist.

- [ ] **Step 3: Add threshold constants and implement the bounded detector**

  Put every numeric threshold above in `config.ts`. Implement correlation with short timestamp queues/maps keyed only by safe fingerprint/method/route, prune on every observation, and emit one anomaly episode until its triggering window recovers.

- [ ] **Step 4: Integrate detector output into store recording and finish**

  After a sanitized event enters the ring buffer, pass it to `observe`; append returned anomaly events through a detector-only path that does not re-observe. On finish, append stuck-loading events, persist the final `DebugAnomalySummary`, then enter `ready`.

- [ ] **Step 5: Run and pass detector plus store tests**

  Run: `cd wdintel-web && npm run test:ts -- src/ts/debug-recorder/__tests__/anomalies.spec.ts src/ts/debug-recorder/__tests__/store.spec.ts`

  Expected: PASS.

- [ ] **Step 6: Format and commit anomaly detection**

  Run: `cd wdintel-web && npm run format:staged`

  ```bash
  git add wdintel-web/src/ts/debug-recorder
  git commit -m "feat(3709): detected browser recording anomalies"
  ```

### Task 4: HTTP and error collectors

**Files:**
- Create: `wdintel-web/src/ts/debug-recorder/collectors/http.ts`
- Create: `wdintel-web/src/ts/debug-recorder/collectors/errors.ts`
- Create: `wdintel-web/src/ts/debug-recorder/collectors/__tests__/http.spec.ts`
- Create: `wdintel-web/src/ts/debug-recorder/collectors/__tests__/errors.spec.ts`
- Modify: `wdintel-web/src/ts/debug-recorder/config.ts`

**Interfaces:**
- Consumes: `(input: DebugEventInput) => void` sink and Task 1 sanitizer helpers.
- Produces: `attachHttpCollector(sink: DebugEventSink): DebugCollectorCleanup`; `attachErrorCollector(sink: DebugEventSink): DebugCollectorCleanup`.

- [ ] **Step 1: Write failing fetch/XHR compatibility and privacy tests**

  Assert fetch preserves its exact resolved `Response`, rejection identity, `this`, `Request`, abort, and streaming behavior; XHR preserves callbacks/events/status/response and abort. For both, assert emitted events contain only method, safe path, outcome/status/duration/abort-or-network classification, and already-exposed byte counts. Seed secrets in query/hash, headers, body, `FormData`, blob/file name, and response and assert neither collector accesses or emits them. After cleanup, assert native references are exactly restored; after two attach/cleanup cycles, assert no duplicate events.

- [ ] **Step 2: Write failing browser-error and console tests**

  Assert `window.error`, resource failure, `unhandledrejection`, worker-visible error, and `securitypolicyviolation` yield bounded structural events; `console.warn/error` still receive the original arguments and `this`, while output contains only safe class/code/fingerprint/message and application stack frames. Seed a console object with a throwing getter and secret and assert it is neither read nor exported. Cleanup restores exact console functions and listeners.

- [ ] **Step 3: Run focused collector tests and verify failure**

  Run: `cd wdintel-web && npm run test:ts -- src/ts/debug-recorder/collectors/__tests__/http.spec.ts src/ts/debug-recorder/collectors/__tests__/errors.spec.ts`

  Expected: FAIL because the collectors do not exist.

- [ ] **Step 4: Implement temporary fetch and XHR wrappers**

  Use native delegation with `Reflect.apply`, never clone/read bodies or headers, and finalize once per request. Add named coalescing metadata for `/api/event-stream/long-poll`, `/api/bgtask/{id}/status-and-logs`, and `/api/messenger/media/{id}/*/status`: retain failures and first/last success plus suppressed-count summaries; exempt event-stream long polls from the 3-second slow rule.

- [ ] **Step 5: Implement temporary error and console collection**

  Preserve native console behavior before best-effort recording. Normalize only allowlisted Error fields, strip browser-extension/cross-origin frames, cap application frames, and classify uninspectable rejection values without generic serialization.

- [ ] **Step 6: Run and pass focused collector tests**

  Run: `cd wdintel-web && npm run test:ts -- src/ts/debug-recorder/collectors/__tests__/http.spec.ts src/ts/debug-recorder/collectors/__tests__/errors.spec.ts`

  Expected: PASS.

- [ ] **Step 7: Format and commit HTTP/error collection**

  Run: `cd wdintel-web && npm run format:staged`

  ```bash
  git add wdintel-web/src/ts/debug-recorder/config.ts wdintel-web/src/ts/debug-recorder/collectors
  git commit -m "feat(3709): captured safe browser failures and requests"
  ```

### Task 5: Interaction, navigation, and document lifecycle collector

**Files:**
- Create: `wdintel-web/src/ts/debug-recorder/collectors/interaction-navigation.ts`
- Create: `wdintel-web/src/ts/debug-recorder/collectors/__tests__/interaction-navigation.spec.ts`
- Modify: `wdintel-web/src/ts/browser/navigation-guard.ts`
- Modify: `wdintel-web/src/ts/browser/__tests__/navigation-guard.spec.ts`

**Interfaces:**
- Consumes: event sink, safe target/route helpers, and existing `FORCED_NAVIGATION_EVENT` from `navigation-guard.ts`.
- Produces: `attachInteractionNavigationCollector(sink: DebugEventSink): DebugCollectorCleanup`; one new exported navigation signal `ECHO_NAVIGATION_EVENT = 'echo:navigation'` whose detail contains only `{ kind: 'push' | 'replace' | 'traverse' | 'load'; forced: boolean }`.

- [ ] **Step 1: Write failing interaction and focus tests**

  Assert capture-phase click/submit/focus events identify only event kind and safe target structure; recorder-root interactions are excluded; password/search/editor/file inputs, labels, text, selections, values, and arbitrary attributes are never read. Assert wheel/touch/pointer/key signals create user-intent timestamps without key contents.

- [ ] **Step 2: Write failing navigation/lifecycle tests**

  Assert existing navigation guard publishes safe navigation intent for programmatic SPA navigation; direct `pushState`/`replaceState`, `popstate`, `hashchange`, `pagehide`, `pageshow.persisted`, and `PerformanceNavigationTiming.type` map to SPA/back-forward/reload/BFCache kinds without URL query/hash. Assert `online`, `offline`, and `visibilitychange` emit structural state only. Assert history functions are exactly restored and repeated attach does not stack wrappers.

- [ ] **Step 3: Run focused tests and verify failure**

  Run: `cd wdintel-web && npm run test:ts -- src/ts/debug-recorder/collectors/__tests__/interaction-navigation.spec.ts src/ts/browser/__tests__/navigation-guard.spec.ts`

  Expected: FAIL on the missing collector/navigation event.

- [ ] **Step 4: Publish a structural navigation event from the existing guard**

  Emit `ECHO_NAVIGATION_EVENT` alongside existing behavior at the point where `requestNavigation` commits its kind/forced decision. Do not include the destination URL in the custom-event detail; the collector reads and sanitizes `window.location` after the navigation signal.

- [ ] **Step 5: Implement interaction/navigation collection and exact cleanup**

  Attach only capture listeners required by the spec, mark recorder DOM with `data-debug-recorder-root`, feature-detect navigation timing, and ensure wrappers/listeners survive partial setup failure through one idempotent cleanup.

- [ ] **Step 6: Run and pass focused tests**

  Run: `cd wdintel-web && npm run test:ts -- src/ts/debug-recorder/collectors/__tests__/interaction-navigation.spec.ts src/ts/browser/__tests__/navigation-guard.spec.ts`

  Expected: PASS.

- [ ] **Step 7: Format and commit lifecycle collection**

  Run: `cd wdintel-web && npm run format:staged`

  ```bash
  git add wdintel-web/src/ts/debug-recorder/collectors wdintel-web/src/ts/browser
  git commit -m "feat(3709): captured browser interaction and navigation"
  ```

### Task 6: Scroll, performance, DOM, and skeleton collectors

**Files:**
- Create: `wdintel-web/src/ts/debug-recorder/collectors/scroll-performance.ts`
- Create: `wdintel-web/src/ts/debug-recorder/collectors/dom-loading.ts`
- Create: `wdintel-web/src/ts/debug-recorder/collectors/index.ts`
- Create: `wdintel-web/src/ts/debug-recorder/collectors/__tests__/scroll-performance.spec.ts`
- Create: `wdintel-web/src/ts/debug-recorder/collectors/__tests__/dom-loading.spec.ts`
- Create: `wdintel-web/src/ts/debug-recorder/collectors/__tests__/index.spec.ts`

**Interfaces:**
- Consumes: sink and Task 4–5 attach functions.
- Produces: `attachScrollPerformanceCollector(sink: DebugEventSink): DebugCollectorCleanup`; `attachDomLoadingCollector(sink: DebugEventSink): DebugCollectorCleanup`; `attachGlobalCollectors(sink: DebugEventSink): { cleanup: DebugCollectorCleanup; support: DebugCollectorSupport }`.

- [ ] **Step 1: Write failing scroll/performance tests**

  Assert wheel/touch/pointer/scroll-key intent, focus intent, `window.scroll/scrollTo/scrollBy`, and element scroll methods are distinguished; scroll samples are at most one per animation frame per container and contain only geometry. Assert window/orientation/visual-viewport resize emits dimensions only. Feed mocked layout-shift, longtask, resource, and navigation entries and assert structural output; repeated cross-origin tile resources are coalesced as `map-tile` without retaining hostnames or numeric tile paths. When entry types or `PerformanceObserver` are unsupported, assert support metadata reports them and no exception occurs. Advance a heartbeat across 1,000 ms drift and assert one stall event, not a timer flood.

- [ ] **Step 2: Write failing DOM/loading tests**

  Assert the observer emits coalesced events for connected/disconnected custom-element hosts and substantial body subtrees containing at least 50 elements, excluding the recorder root. Assert loading visibility is tracked only for `[aria-busy="true"]`, `[data-debug-skeleton]`, and `.MuiSkeleton-root`; no node, text, attribute dump, or descendant content enters events. Simulate 10,000 mutations and assert bounded one-per-animation-frame summaries and exact observer disconnect.

- [ ] **Step 3: Write failing collector-orchestrator isolation tests**

  Inject one collector that throws during attach and one whose sink later throws. Assert only the failed collector is marked unsupported/detached, remaining collectors continue, cleanup is idempotent/reverse-order, and no collector remains after finish.

- [ ] **Step 4: Run focused tests and verify failure**

  Run: `cd wdintel-web && npm run test:ts -- src/ts/debug-recorder/collectors/__tests__/scroll-performance.spec.ts src/ts/debug-recorder/collectors/__tests__/dom-loading.spec.ts src/ts/debug-recorder/collectors/__tests__/index.spec.ts`

  Expected: FAIL because the collectors do not exist.

- [ ] **Step 5: Implement scroll/performance collection**

  Track intent timestamps and coalesced geometry in weakly held container state, restore wrapped scroll methods exactly, feature-detect observer entry types, and use a 250 ms heartbeat only while recording to detect at least 1,000 ms drift. Coalesce `img`/resource entries matching common numeric map-tile path shapes under one `map-tile` rule without storing origin or coordinates.

- [ ] **Step 6: Implement bounded DOM/loading collection**

  Observe `document.body` with child-list and allowlisted-attribute filters, inspect only structural counts/tag names/known selectors, exclude `[data-debug-recorder-root]`, and flush one aggregated mutation batch per animation frame.

- [ ] **Step 7: Implement collector orchestration and capability reporting**

  Attach interaction/navigation, HTTP, errors, scroll/performance, and DOM/loading independently. Wrap every sink and cleanup in failure isolation; report supported/unsupported/failed collector names in `DebugCollectorSupport` for persistence/export.

- [ ] **Step 8: Run and pass focused collector tests**

  Run: `cd wdintel-web && npm run test:ts -- src/ts/debug-recorder/collectors`

  Expected: PASS with no open handles.

- [ ] **Step 9: Format and commit global collectors**

  Run: `cd wdintel-web && npm run format:staged`

  ```bash
  git add wdintel-web/src/ts/debug-recorder/collectors
  git commit -m "feat(3709): captured scroll layout and loading signals"
  ```

### Task 7: Global runtime, semantic API, auth cleanup, and recording panel

**Files:**
- Create: `wdintel-web/src/ts/debug-recorder/index.ts`
- Create: `wdintel-web/src/ts/debug-recorder/DebugRecorderPanel.tsx`
- Create: `wdintel-web/src/ts/debug-recorder/debug-recorder-root.tsx`
- Create: `wdintel-web/src/ts/debug-recorder/__tests__/index.spec.ts`
- Create: `wdintel-web/src/ts/debug-recorder/__tests__/DebugRecorderPanel.spec.tsx`
- Modify: `wdintel-web/src/interop.ts:24-25,436-468`

**Interfaces:**
- Consumes: store, collector orchestrator, `AUTH_UNAUTHORIZED_EVENT`, and React external-store APIs.
- Produces: `initializeBrowserDebugRecorder(): void`; `mountDebugRecorderPanelIfNeeded(): void`; `configureBrowserDebugRecorder(metadata: DebugBuildMetadata): void`; `registerBrowserDebugRecorderPress(nowMs?: number): boolean`; `recordDebugEvent(input: DebugEventInput): void`; `aliasDebugIdentifier(scope: string, value: string | number): string | null`; `isBrowserDebugRecording(): boolean`; `subscribeBrowserDebugRecorder(listener: () => void): () => void`; `getBrowserDebugRecorderSnapshot(): DebugRecorderSnapshot`; `finishBrowserDebugRecording(): void`; `downloadBrowserDebugRecording(): boolean`; `clearBrowserDebugRecording(): void`.

- [ ] **Step 1: Write failing singleton/runtime tests**

  Assert initialization restores once and mounts one root only for restored non-idle state; eight presses inside 4,000 ms start once, seven or a slower sequence do not; active starts are ignored; environment configured before start is persisted; start attaches collectors and finish/timeout/clear detaches them exactly once; inactive runtime has no React root, collector, timer, or wrapper; `recordDebugEvent` and aliasing are no-ops outside recording; initialization twice does not stack listeners; `AUTH_UNAUTHORIZED_EVENT` and a same-origin HTTP 401 each clear memory/storage synchronously.

- [ ] **Step 2: Write failing panel tests**

  Assert recording UI shows a red status, `Запис діагностики`, `00:00 / 01:00`, an `aria-live` status, visible keyboard focus, and `Завершити`; elapsed time updates without exceeding `01:00`; manual finish calls finish and download within the click; timeout shows `Запис готовий`, counts, and `Завантажити`; failed download shows retry without clearing; successful retry clears; panel DOM is marked/excluded; narrow viewport keeps controls reachable.

- [ ] **Step 3: Run runtime/panel tests and verify failure**

  Run: `cd wdintel-web && npm run test:ts -- src/ts/debug-recorder/__tests__/index.spec.ts src/ts/debug-recorder/__tests__/DebugRecorderPanel.spec.tsx`

  Expected: FAIL because the runtime and panel do not exist.

- [ ] **Step 4: Implement singleton orchestration and auth-boundary cleanup**

  Initialize restore before/at Elm startup, attach collectors only for `recording`, forward collector support/failure counts to the store, and flush on `pagehide`. While state is non-idle, listen for the existing unauthorized event; detach that listener on clear. The collector sink clears the session instead of recording when a same-origin `http.completed` event has status 401, covering Elm XHR and raw clients that do not emit the shared event. Keep the public API exception-free and preserve press state only in memory.

- [ ] **Step 5: Implement and mount the body-level panel**

  `mountDebugRecorderPanel()` lazily creates/reuses `#echo-debug-recorder-root` only for `recording` or `ready`, marks it `data-debug-recorder-root`, and renders once via `createRoot`; clear/download/expiry unmounts and removes it. Use `top: calc(var(--app-shell-navbar-height, 58px) + 8px)` and `z-index: 2500` for a fixed top-right responsive panel above page content but below the changelog dropdown/critical dialogs; subscribe via `useSyncExternalStore` and derive the timer from `deadlineAt`.

- [ ] **Step 6: Wire initialization into interop**

  Import the runtime from `interop.ts`; call lightweight restore initialization from `flags()` before Elm starts and call `mountDebugRecorderPanelIfNeeded()` from `onReady()` after the document/app is ready. With idle state the latter is a no-op. Keep both calls idempotent so HMR/tests cannot duplicate work.

- [ ] **Step 7: Run and pass runtime/panel/auth tests**

  Run: `cd wdintel-web && npm run test:ts -- src/ts/debug-recorder`

  Expected: PASS.

- [ ] **Step 8: Format and commit the global runtime**

  Run: `cd wdintel-web && npm run format:staged`

  ```bash
  git add wdintel-web/src/interop.ts wdintel-web/src/ts/debug-recorder
  git commit -m "feat(3709): added global browser recording panel"
  ```

### Task 8: Navbar activation and deployment metadata

**Files:**
- Create: `wdintel-web/src/ts/react/components/app-navbar/__tests__/ChangelogDropdown.debug-recorder.spec.tsx`
- Modify: `wdintel-web/src/ts/react/components/app-navbar/ChangelogDropdown.tsx:47-165`
- Modify: `wdintel-web/src/ts/react/components/app-navbar/AppNavbar.tsx:78-113,635-640`
- Modify: `wdintel-web/src/ts/react/app-navbar-element.tsx:3-36`
- Modify: `wdintel-web/src/Layouts/Navbar.elm:267-273`
- Modify: `wdintel-web/src/ts/react/components/app-navbar/__tests__/AppNavbar.cyber-visibility.regression.spec.tsx`

**Interfaces:**
- Consumes: Task 7 configuration, press-registration, and clear APIs.
- Produces: navbar `shared.serverInfo: { mode: string; version: string } | null`; no new Elm message or port.

- [ ] **Step 1: Write failing changelog activator tests**

  Mock runtime APIs and assert: the first seven presses preserve normal open/close and unseen-changelog behavior; the eighth qualifying press closes the dropdown and starts recording exactly once; a gap over 4,000 ms resets the sequence; both `Debug` and `Live` server modes configure/start; the megaphone button still renders for an authenticated navbar when maintenance and changelog data are absent; ordinary maintenance content still works.

- [ ] **Step 2: Extend existing AppNavbar test data for server version and logout**

  Assert AppNavbar configures `{ deploymentMode: 'Live', echoVersion: '2026.10.8' }`, and the custom element clears the recorder synchronously before dispatching `navbar-logout`.

- [ ] **Step 3: Run navbar tests and verify failure**

  Run: `cd wdintel-web && npm run test:ts -- src/ts/react/components/app-navbar/__tests__/ChangelogDropdown.debug-recorder.spec.tsx src/ts/react/components/app-navbar/__tests__/AppNavbar.cyber-visibility.regression.spec.tsx`

  Expected: FAIL on missing activation/configuration behavior.

- [ ] **Step 4: Pass complete safe server metadata from Elm to React**

  Change only the existing `serverInfo` JSON object to encode both `mode` and `version`; update `AppNavbarProps` accordingly. Do not add generated frontend types or manually duplicate backend encoders.

- [ ] **Step 5: Wire runtime configuration, activation, and explicit logout clearing**

  Configure the environment from AppNavbar props, call `registerBrowserDebugRecorderPress()` from the existing header button, and if it returns `true`, close the dropdown and skip that press's ordinary toggle. Remove the early null return so the authenticated header always has the megaphone activator; render no empty dropdown body when no content exists. Clear the recorder in `AppNavbarRoot.onLogout` before dispatching the existing event.

- [ ] **Step 6: Run and pass navbar tests plus Elm type-check**

  Run: `cd wdintel-web && npm run test:ts -- src/ts/react/components/app-navbar`

  Run: `cd wdintel-web && elm make src/Layouts/Navbar.elm --output=/dev/null`

  Expected: both commands PASS.

- [ ] **Step 7: Format and commit navbar activation**

  Run: `cd wdintel-web && npm run format:staged`

  ```bash
  git add wdintel-web/src/Layouts/Navbar.elm wdintel-web/src/ts/react/app-navbar-element.tsx wdintel-web/src/ts/react/components/app-navbar
  git commit -m "feat(3709): activated recording from the navbar"
  ```

### Task 9: Adapt Duty diagnostics and retire the duplicate debugger UI

**Files:**
- Create: `wdintel-web/src/ts/react/routes/rer-duty-neo/__tests__/duty-scroll-debug.spec.ts`
- Modify: `wdintel-web/src/ts/react/routes/rer-duty-neo/duty-scroll-debug.ts:1-314`
- Modify: `wdintel-web/src/ts/react/routes/rer-duty-neo/FeedColumn.tsx:26-27,94-100,158-160,306`
- Delete: `wdintel-web/src/ts/react/routes/rer-duty-neo/DutyScrollDebugPanel.tsx`

**Interfaces:**
- Consumes: Task 7 `recordDebugEvent`, `aliasDebugIdentifier`, `isBrowserDebugRecording`, `subscribeBrowserDebugRecorder`, and snapshot APIs.
- Produces: compatibility producer functions already imported by Duty (`isDutyScrollDebugEnabled`, `useDutyScrollDebugEnabled`, `recordDutyScrollDebugEvent`, `recordDutyScrollDebugMetrics`, `recordDutyScrollDebugTiming`, `beginDutyScrollDebugActivity`) with unchanged call signatures and global-recorder-backed behavior.

- [ ] **Step 1: Write failing Duty adapter parity/privacy tests**

  Assert the compatibility enabled hook follows global recording; event/timing/metric/activity start+finish calls emit `source: 'duty'` semantic events; scroll geometry, loading flags, activity counts, and render durations survive; feed/message/item/anchor IDs and numeric IDs embedded in legacy detail strings become stable aliases; raw IDs and a detail sentinel never appear; an activity finish closure is idempotent; calls outside recording are cheap no-ops.

- [ ] **Step 2: Run the adapter test and verify failure**

  Run: `cd wdintel-web && npm run test:ts -- src/ts/react/routes/rer-duty-neo/__tests__/duty-scroll-debug.spec.ts`

  Expected: FAIL because the old module still owns its own state.

- [ ] **Step 3: Replace the Duty store with a semantic compatibility adapter**

  Keep producer-facing types/signatures used by current hooks, map legacy names to `duty.<normalized-name>`, alias every feed/message/item/anchor identifier, retain only allowlisted metric booleans/counts/geometry, and normalize legacy free-form detail into structural tokens/fingerprints rather than passing it verbatim.

- [ ] **Step 4: Remove the notification-bell activation and per-feed panels**

  Remove both `registerDutyScrollDebugBellPress()` calls and their import from `FeedColumn`; remove `DutyScrollDebugPanel` import/render; delete the panel file and old panel/store-only exports. Leave normal notification behavior unchanged.

- [ ] **Step 5: Run Duty adapter and affected route tests**

  Run: `cd wdintel-web && npm run test:ts -- src/ts/react/routes/rer-duty-neo/__tests__/duty-scroll-debug.spec.ts src/ts/react/routes/rer-duty-neo/__tests__/useRerDutyFeedState.polling.spec.tsx src/ts/react/routes/rer-duty-neo/__tests__/useRerDutyFeedState.directional-loads.spec.tsx`

  Expected: PASS, and `rg 'DutyScrollDebugPanel|registerDutyScrollDebugBellPress|data-duty-scroll-debug-panel' wdintel-web/src` returns no matches.

- [ ] **Step 6: Format and commit Duty integration**

  Run: `cd wdintel-web && npm run format:staged`

  ```bash
  git add -A wdintel-web/src/ts/react/routes/rer-duty-neo
  git commit -m "refactor(3709): reused global recording for Duty diagnostics"
  ```

### Task 10: Browser regression, operator documentation, changelog, and full verification

**Files:**
- Create: `wdintel-web/tests/e2e/browser-debug-recorder.spec.ts`
- Create: `docs/browser-debug-recorder.md`
- Modify: `CHANGELOG.md` under `## NEXT` only

**Interfaces:**
- Consumes: complete user workflow from Tasks 1–9.
- Produces: one end-to-end regression, durable operator instructions, and the issue-linked release note.

- [ ] **Step 1: Write the failing Playwright production-path regression**

  Create `@regression #3709` coverage that:

  1. uses the existing `installRerDutyShortStateMocks` fixture to open an authenticated Duty route in `Live` mode and presses the visible header button eight times;
  2. verifies one global panel and `00:00 / 01:00` recording state;
  3. performs click/focus/scroll/history activity, a successful fetch, a failing fetch, a mocked slow/duplicate request, console error, skeleton show/hide, and a substantial custom-element replacement;
  4. seeds `ECHO_SECRET_SENTINEL` separately into URL query/hash, request header/body, DOM text, input value, console object, and unrelated local/session storage;
  5. reloads mid-recording, verifies the same deadline/recording ID resumes, then opens an independent second page in the same browser context and asserts it is idle while the first remains active;
  6. returns to the first page, finishes from the panel, captures the download, and asserts safe navigation/HTTP/error/scroll/loading/Duty event ordering and anomaly summary while every secret/raw ID/full URL/storage value is absent;
  7. starts a fresh recording, dispatches `AUTH_UNAUTHORIZED_EVENT`, and asserts recorder storage/panel clear.

- [ ] **Step 2: Run the new browser test and verify the first missing behavior**

  Run: `cd wdintel-web && npm exec -- playwright test tests/e2e/browser-debug-recorder.spec.ts --project=chromium`

  Expected before final integration fixes: FAIL on the first unmet workflow assertion; after fixes: PASS.

- [ ] **Step 3: Fix only integration defects exposed by the browser test**

  Keep fixes inside the owning Task 1–9 modules, add a focused Vitest regression for each defect first, then rerun its focused test and the Playwright scenario until both pass.

- [ ] **Step 4: Add concise operator documentation**

  In `docs/browser-debug-recorder.md`, document: eight megaphone presses in four seconds; 60-second maximum; manual finish versus timeout download; reload recovery; filename/report sections; how to attach the `.md` to Codex; data intentionally excluded; logout/401/ten-minute expiry; storage/download failure behavior; no backend upload; and how to add a safe semantic event. Link to the approved spec for architecture instead of duplicating it.

- [ ] **Step 5: Add the issue-linked `NEXT` changelog entry**

  Add exactly one concise top entry under `## NEXT`, preserving existing spacing/order:

  ```text
  - [#3709](https://github.com/echoua/echo/issues/3709) ✅ Загальне: додано прихований 60-секундний запис браузерної діагностики з безпечним Markdown-звітом для помилок, перезавантажень, стрибків прокрутки та завислих завантажень.
  ```

- [ ] **Step 6: Run formatting and all focused TypeScript tests**

  Run: `cd wdintel-web && npm run format:staged`

  Run: `cd wdintel-web && npm run test:ts -- src/ts/debug-recorder src/ts/react/components/app-navbar src/ts/react/routes/rer-duty-neo/__tests__/duty-scroll-debug.spec.ts src/ts/browser/__tests__/navigation-guard.spec.ts`

  Expected: PASS.

- [ ] **Step 7: Run full frontend verification**

  Run: `just test-fe`

  Run: `cd wdintel-web && npm run e2e:regression -- tests/e2e/browser-debug-recorder.spec.ts`

  Run: `just build-front`

  Expected: all commands exit 0; the build adds no dependency, backend, migration, or overview-document diff.

- [ ] **Step 8: Inspect the final diff for privacy and scope**

  Run: `git diff main --check`

  Run: `git diff main -- README.md docs/README.md wdintel-rs echo-migration`

  Expected: no whitespace errors and no changes in the forbidden overview/backend/migration paths. Manually search the recorder diff for body/header/text/value/storage serialization and confirm each match is a test assertion or explicit exclusion.

- [ ] **Step 9: Commit the regression and release documentation**

  ```bash
  git add wdintel-web/tests/e2e/browser-debug-recorder.spec.ts docs/browser-debug-recorder.md CHANGELOG.md
  git commit -m "test(3709): verified browser debug recording workflow"
  ```

- [ ] **Step 10: Request final code review before integration**

  Use `superpowers:requesting-code-review` against `main`, address only verified findings, rerun the affected focused checks plus `just build-front`, and then use `superpowers:finishing-a-development-branch` to choose merge/PR handling with the user.
