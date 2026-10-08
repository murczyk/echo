# Browser Debug Recorder Design

**Status:** Approved

**Issue:** [#3709](https://github.com/echoua/echo/issues/3709)

**Base branch:** `main`

## Context

Some browser defects occur only under real production timing and user state.
Examples include unexpected scroll jumps, full-page reloads, component or DOM
root replacement, skeleton flicker, request races, and loading states that do
not finish. These defects are difficult to diagnose from a screenshot or an
ordinary error message because the useful evidence is the sequence of browser
events immediately before the visible symptom.

Echo already has a route-specific Duty scroll debugger. It is enabled by a
hidden eight-press gesture, keeps bounded in-memory events, records detailed
feed and scroll metrics, and shows a local diagnostic panel. It proves that
user-driven diagnostic capture is useful, but its store, activation, UI, and
data model are tied to `RerDutyNeo` feeds. It does not survive reloads or
produce a shareable artifact.

The new feature is a global browser flight recorder. An authenticated user
starts it through a hidden header gesture, reproduces a problem for at most one
minute, and exports a privacy-safe Markdown trace for Codex or a developer. It
must work in both debug and live deployments because production-only failures
are the primary use case.

## Goals

1. Let any authenticated Echo user start a global browser recording without
   DevTools, a special role, or an external extension.
2. Capture a bounded, ordered account of browser interactions, navigation,
   network lifecycle, errors, loading UI, scroll and layout changes, and
   performance anomalies across all Elm and React routes.
3. Continue the same recording across an unexpected full-page reload in the
   current tab.
4. Export a deterministic `.md` file that Codex can correlate with application
   code and use to propose a fix and a regression test.
5. Reuse the proven Duty scroll instrumentation through a generic semantic
   event API without making the recorder depend on Duty.
6. Keep inactive production overhead negligible and make recorder failures
   unable to change application behavior.
7. Prevent credentials, operational content, form values, request payloads,
   and other sensitive data from entering the trace.

## Non-goals

- Video, screenshots, DOM replay, or visual session replay.
- Capturing backend logs, SQL statements, Rust panics, response bodies, or
  server-side request traces.
- Automatically executing the recorded flow as an E2E test.
- Persisting traces on the server, uploading them in the background, sending
  analytics about them, or sharing them between tabs.
- Reading application `localStorage`, unrelated `sessionStorage`, clipboard
  contents, files, media, or input values.
- Exact React component lifecycle capture for every component. Generic DOM and
  custom-element changes are captured; exact component semantics require an
  explicit adapter event.
- Replacing product observability or the future production backend diagnostics
  design.

## Product workflow

The existing changelog megaphone in the global header is the activator.

1. The authenticated user presses the megaphone eight times within four
   seconds. This matches the proven gesture used by the current Duty debugger.
2. On the eighth press, the changelog dropdown closes and a global fixed panel
   appears below the header. Recording starts immediately after activation, so
   the activator presses are not part of the trace.
3. The panel shows a red recording indicator, `Запис діагностики`, elapsed and
   maximum time (`00:00 / 01:00`), and a `Завершити` button.
4. The user reproduces the defect. SPA navigation and full-page reloads retain
   the active recording and deadline.
5. Pressing `Завершити` stops collection and downloads the Markdown file from
   the same user gesture.
6. At 60 seconds the recorder stops automatically and the panel changes to a
   `Запис готовий` state with a `Завантажити` button. Automatic download is not
   attempted because browsers may block downloads that do not originate from
   a user gesture.
7. A successful download clears the recorder state. A ready recording also
   expires ten minutes after its deadline, on logout or 401, or when the tab's
   session storage is cleared.

The feature is available in both `Debug` and `Live` modes. The hidden gesture
is discoverability, not authorization: recording grants no additional access
and makes no additional product API calls. Each tab owns an independent
recording.

The changelog button keeps its normal product behavior during the first seven
presses. Activation closes the dropdown on the eighth press. If changelog data
is temporarily unavailable, the authenticated header still renders the
megaphone activator without an empty dropdown so the diagnostic workflow
remains available.

## Architectural boundary

```text
header megaphone --8 presses--> recorder lifecycle/store <--> sessionStorage
                                      |      |                 (own key only)
                                      |      +--> global panel
                                      |
             +------------------------+-------------------------+
             |              |               |                  |
       browser events   HTTP lifecycle   performance       semantic API
             |              |               |                  |
             +---------------- sanitized event stream ---------+
                                      |
                              anomaly detectors
                                      |
                              Markdown exporter
```

The implementation lives under `wdintel-web/src/ts/debug-recorder/` and has no
route dependency. Its public surface remains small:

```ts
type DebugEventInput = {
  kind: string;
  source?: string;
  target?: DebugTarget;
  details?: Record<string, DebugSafeValue>;
};

interface BrowserDebugRecorder {
  start(): void;
  finish(): void;
  download(): boolean;
  record(event: DebugEventInput): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): DebugRecorderSnapshot;
}
```

Route modules may call `record` through a convenience
`recordDebugEvent(...)` function. They cannot read or mutate the internal
buffer, storage representation, or exporter.

## Lifecycle and storage

The lifecycle is explicit:

```text
idle -> recording -> ready -> downloaded -> idle
                  \-> expired ----------> idle
```

Starting a new recording replaces any previous expired or ready state. An
active second start is ignored. The recording has a fixed wall-clock
`startedAt` and `deadlineAt`; reload does not reset either value.

The primary ring buffer is in memory. It is bounded by all of these limits:

- 60 seconds from the original activation;
- 1,000 events;
- 1 MiB of serialized sanitized data.

When an event or byte limit is reached, the oldest events are evicted and
`droppedEvents` is incremented. The most recent evidence around the visible
failure is retained.

While recording, a debounced sanitized snapshot is written to one namespaced
`sessionStorage` key. `pagehide` triggers a best-effort synchronous flush.
Startup validates the schema version, size, state, and expiry before restoring
it. Invalid, incompatible, oversized, or expired values are deleted. If
storage is unavailable or its quota is exceeded, collection continues in
memory and the report records `persistenceFailed: true`; a later reload cannot
be recovered in that case.

The recorder never enumerates or reads other storage keys. Logout and the
global unauthorized event clear its key immediately.

## Event model

Stored events use a stable, versioned envelope:

```ts
type DebugEvent = {
  seq: number;
  tMs: number;
  kind: string;
  source: string;
  route: string;
  target?: DebugTarget;
  details?: Record<string, DebugSafeValue>;
};
```

`tMs` is milliseconds since the original recording start. Sequence numbers
remain monotonic across reloads. The event route is a sanitized path template,
not a full URL. Event names use dotted categories such as
`navigation.reload`, `http.completed`, `scroll.jump`, `skeleton.visible`, and
`duty.anchor.changed`.

Every collector sends input through the same source sanitizer before it can
reach memory or storage. Export applies a second defensive sanitization pass.

## Global collectors

Collectors attach only while the lifecycle is `recording`. They return cleanup
functions and restore the exact native functions and listeners on finish,
expiry, logout, or initialization failure.

### Interaction and focus

Capture-phase listeners record `click`, `submit`, and meaningful focus changes.
They record only the interaction kind and a safe target descriptor composed of
tag, role, input type, and a validated static `data-testid` when available.
They do not read DOM text, values, selections, names, labels, clipboard data,
or arbitrary attributes. Recorder panel elements are marked and excluded from
capture.

### Navigation and page lifecycle

The collector observes the existing navigation guard, `history.pushState`,
`history.replaceState`, `popstate`, `hashchange`, `pagehide`, `pageshow`, and
`PerformanceNavigationTiming`. It distinguishes SPA navigation, back/forward,
BFCache restoration, and full reload. The persisted active-session marker is
the evidence that a new document belongs to the same recording.

### HTTP

Temporary wrappers cover both `fetch` and `XMLHttpRequest`, including Elm HTTP,
the shared React client, and route-local raw requests. They retain original
`this`, arguments, abort behavior, streaming semantics, and return types.

The trace includes only method, sanitized same-origin path template, outcome,
status, duration, abort/network classification, and declared byte counts when
already exposed by safe browser metadata. It does not inspect request or
response bodies, headers, cookies, query parameters, fragments, `FormData`,
blobs, streams, or file names. High-frequency long-poll, keepalive, media, and
map traffic is coalesced through named filter rules rather than silently
disappearing.

### Errors and console signals

The collector listens for `window.error`, `unhandledrejection`, resource load
errors, worker errors visible to the page, and security-policy violations. It
temporarily wraps `console.warn` and `console.error` while preserving their
original behavior.

Only error class, a bounded sanitized message, safe error code, and bounded
application stack frames are retained. Raw console arguments and arbitrary
object serialization are forbidden.

### Scroll, layout, and performance

The recorder tracks user scroll intent from wheel, touch, pointer, and keyboard
signals, plus programmatic scroll calls and focus changes. Scroll samples are
coalesced by scroll container. A candidate jump is a large delta without
recent user or known programmatic intent; the detector correlates it with
layout-shift, focus, resize, and DOM replacement signals before emitting
`scroll.jump`.

Feature-detected `PerformanceObserver` collectors record long tasks,
non-user-initiated layout shifts, resource failures, and relevant navigation
timing. Unsupported entry types are skipped and reported in metadata; they do
not fail the recording.

### DOM lifecycle and loading UI

A bounded, coalescing `MutationObserver` tracks substantial subtree
replacement, known custom-element connect/disconnect behavior, and loading UI
identified by a small allowlist: `aria-busy`, `data-debug-skeleton`, and known
shared skeleton primitives. It never serializes nodes or text.

The generic observer can identify root replacement and loading transitions,
but it must not claim exact React component lifecycle. Features that need exact
mount, unmount, render, or commit meaning publish semantic events through the
public API.

## Anomaly detection

Detection converts repeated low-level samples into a small number of useful
events and a report summary. Thresholds are centralized constants and covered
by tests. The first version detects:

- full reload or BFCache restoration during an active recording;
- scroll jumps without recent user or known programmatic intent;
- correlated layout shifts and focus-induced scrolling;
- repeated substantial DOM-root replacement;
- skeleton flicker, repeated content/loading transitions, and skeletons still
  visible at finish;
- overlapping duplicate requests, request storms, slow requests, retry loops,
  aborts, network failures, and HTTP failures;
- uncaught errors, rejected promises, resource failures, and repeated console
  warnings or errors;
- long tasks and main-thread stalls;
- semantic render or lifecycle storms reported by adapters.

An anomaly detector is advisory evidence. It cannot suppress, retry, cancel,
or otherwise affect an application operation.

## Duty debugger integration

The existing Duty event producers and detailed scroll/render metrics are
valuable and remain feature-owned. They are adapted to
`recordDebugEvent(...)` with `source: "duty"` and safe feed aliases. Raw feed
IDs and message IDs are not exported.

The old Duty notification-bell activation and per-feed debug panel are retired
after parity tests prove that their events appear in the global trace. This
avoids two hidden gestures, two stores, and multiple diagnostic panels while
preserving the existing instrumentation investment.

## Privacy and sanitization

The recorder uses an allowlist at the collection boundary. A denylist exists
only as defense in depth.

The following data is never collected:

- request or response bodies and headers;
- cookies, authorization values, CSRF values, API keys, webhook URLs, OAuth
  data, TOTP data, or storage values;
- form, editor, search, clipboard, file, media, or upload contents;
- DOM text, message text, comments, transcripts, OCR, callsigns, frequencies,
  units, networks, coordinates, device names, or other operational content;
- raw login IDs, display names, UUIDs, database IDs, IP addresses, hostnames, or
  full user-agent strings.

Path segments matching numeric IDs, UUIDs, or other dynamic identifiers become
stable per-recording aliases such as `{id_1}`. Query strings and fragments are
removed before any path enters the buffer. Target descriptors use only
allowlisted structural fields. Strings have length limits, control characters
are normalized, object depth and key counts are bounded, cycles are rejected,
and getters are never invoked by generic serialization.

Dynamic values are escaped so they cannot close the Markdown code fence,
inject HTML, or become instructions to Codex. The exported report explicitly
labels captured content as untrusted diagnostic evidence.

## Markdown export

The filename is fixed-format and contains no application data:

```text
echo-debug-YYYYMMDD-HHmmss.md
```

The document contains:

1. an untrusted-evidence warning;
2. metadata: schema version, random recording ID, Echo version, deployment
   mode, browser family/version, viewport, device-pixel ratio, sanitized start
   route, minute-rounded start time, and duration;
3. anomaly summary and counts;
4. a chronological fenced JSONL timeline;
5. redaction, truncation, eviction, collector-support, and persistence status.

`Blob` and an object URL produce the download. The URL is revoked after use.
A successful manual finish or download clears memory and storage. If export or
download setup fails, the state remains `ready`, the panel shows a retryable
error, and no diagnostic data is discarded.

## Failure isolation

Recorder code is best-effort and must fail closed:

- collector exceptions increment an internal failure count and detach only the
  failed collector;
- sanitizer rejection drops the event and increments `droppedEvents`;
- storage failure falls back to memory;
- observer or exporter failure never throws into product event handlers;
- wrapped browser APIs call native behavior even when recording fails;
- finish cleanup is idempotent and restores all temporary wrappers;
- malformed restored state is deleted rather than partially trusted.

The inactive path performs only the megaphone press registration and a small
startup check for the recorder's own session key. No global observers, HTTP
wrappers, scroll listeners, or timers remain active while idle.

## UI ownership

The global panel is a single React root mounted outside route content so route
navigation cannot unmount it. It uses a fixed top-right position below the
navbar, a high but bounded z-index, responsive width, keyboard-accessible
buttons, visible focus, and an `aria-live` status. It must not cover the header
activator or prevent normal page interaction.

The panel has only the controls needed by the workflow:

- recording: elapsed/max time and `Завершити`;
- ready: concise result counts and `Завантажити`;
- export failure: error text and retry;
- no event browser, raw payload preview, settings, or persistent enable toggle.

## Planned code boundaries

Expected new frontend modules include:

- `src/ts/debug-recorder/types.ts` — versioned public and stored contracts;
- `src/ts/debug-recorder/store.ts` — lifecycle, caps, subscriptions, restore;
- `src/ts/debug-recorder/sanitize.ts` — allowlist and aliasing;
- `src/ts/debug-recorder/collectors/` — independent attach/cleanup units;
- `src/ts/debug-recorder/anomalies.ts` — bounded correlation rules;
- `src/ts/debug-recorder/export-markdown.ts` — deterministic report;
- `src/ts/debug-recorder/DebugRecorderPanel.tsx` — global UI;
- `src/ts/debug-recorder/index.ts` — initialization and public semantic API.

Expected integration points are:

- `src/interop.ts` for startup restore and global mounting;
- `src/ts/react/components/app-navbar/ChangelogDropdown.tsx` for activation;
- navbar props for Echo version and mode metadata;
- Duty scroll-debug producers for semantic adapter events;
- the global unauthorized/logout path for immediate clearing.

No backend route, database migration, new runtime dependency, or overview edit
to `README.md` or `docs/README.md` is required.

## Testing strategy

### Unit tests

Vitest covers:

- lifecycle transitions, duplicate starts, 60-second deadline, ready expiry,
  idempotent finish, and cleanup;
- event/byte caps, eviction counts, debounce flush, restore, schema rejection,
  quota failure, and multi-tab isolation assumptions;
- URL templating, alias stability, string/depth limits, cycle handling,
  Markdown escaping, and deterministic export;
- sentinel secrets placed in URL query, headers, bodies, DOM text, inputs,
  storage, console objects, and errors never appearing in storage or export;
- fetch and XHR return/abort/stream semantics and exact restoration;
- navigation, error, performance, scroll, DOM, and skeleton collectors;
- anomaly thresholds, coalescing, and high-volume route filters;
- Duty adapter parity for existing scroll, activity, and timing signals.

### Component tests

React tests cover:

- eight presses inside four seconds activate once; slower presses do not;
- normal changelog behavior remains before activation;
- recording, ready, retry, timer, accessibility, and responsive panel states;
- recorder panel interactions are excluded from the trace;
- manual finish requests download and successful download clears state;
- automatic timeout requires an explicit download click;
- live and debug modes both permit activation.

### Browser regression

A Playwright `@regression` scenario runs the real user workflow: activate from
the header, perform navigation and scroll activity, start an HTTP request,
reload mid-recording, finish, download the Markdown file, and assert that the
trace contains the safe event sequence but none of the seeded secret values.

### Required validation

After implementation:

```bash
cd wdintel-web
npm run format:staged
npm run test:ts
npm run e2e:regression
cd ..
just build-front
```

Affected focused Vitest files should run during TDD before the complete
frontend checks. Browser test discovery alone is not sufficient.

## Acceptance criteria

1. Any authenticated user can activate the recorder in both local and live
   deployments with eight megaphone presses in four seconds.
2. Exactly one visible global panel records for at most 60 seconds across route
   changes and a full reload.
3. Manual finish and post-timeout download produce a deterministic Markdown
   trace that Codex can consume.
4. The trace includes the agreed global signals, detected anomalies, and
   existing Duty scroll semantics without route-specific recorder ownership.
5. Secret and operational sentinel values never enter the buffer, storage, or
   exported file.
6. The inactive recorder has no global collectors or API wrappers, and active
   recorder failures do not alter application behavior.
7. The old Duty-specific hidden activation and panel are removed only after
   parity tests demonstrate equivalent trace evidence.
