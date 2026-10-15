# Browser diagnostic recorder

The recorder captures up to 60 seconds of privacy-safe browser events in the current tab and generates a Markdown report for a developer or Codex. It works in Debug and Live environments and does not send the recording to the backend.

## Record a problem

1. Click the megaphone icon in the global header eight times within four seconds.
2. Confirm that the diagnostic recording panel appears with a `00:00 / 01:00` timer.
3. Reproduce the problem in this tab. A full page reload continues the same recording with its original deadline.
4. Click Finish to stop and download the report. After automatic stopping at 60 seconds, click Download: browsers cannot reliably initiate a download without a user action.

The file is named `echo-debug-YYYYMMDD-HHMMSS.md` and contains `Metadata`, `Anomaly summary`, `Timeline`, and `Capture status`. Attach it to the report with a short description of what was visible and approximately when it occurred.

## Privacy and lifecycle

The recorder does not read or store page text, input values, request or response bodies, headers, cookies, query strings or fragments, clipboard contents, files, media, or other `localStorage` or `sessionStorage` keys. URLs are stored only as sanitized path patterns; dynamic IDs become aliases scoped to one recording.

An active recording uses only its own `sessionStorage` key in the current tab. Logout or HTTP 401 clears it immediately. A finished, undownloaded recording expires after ten minutes. If `sessionStorage` is unavailable, recording continues in memory but cannot survive a reload, and the panel shows a warning. If downloading fails, the report remains ready for another attempt.

## Safe semantic events

When browser signals are insufficient, feature code can add a structured event through `recordDebugEvent`:

```ts
recordDebugEvent({
  kind: 'semantic.render',
  source: 'feature-name',
  details: { phase: 'commit', durationMs },
});
```

Use only allowlisted keys and structural numbers, booleans, or safe tokens. Do not pass text, URLs, DOM content, input values, headers, bodies, or raw IDs. Use `aliasDebugIdentifier` for identifiers. The implementation and sanitizer live in `wdintel-web/src/ts/debug-recorder/`.
