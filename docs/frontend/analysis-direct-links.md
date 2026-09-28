# Analysis direct-link dates

Opening `/rer-analysis-neo?m=<message-reference>` resolves an accessible message
through the existing inbox window lookup, independently of the date filter.
Other filters and access restrictions still apply. Missing or inaccessible
messages retain the normal range and show the existing error notification.

The initial range uses the resolved role defaults (one day with Rer access,
90 days otherwise), or explicit URL dates, and the saved Analysis time basis.
A message inside the start-inclusive, end-exclusive range leaves it unchanged.
Otherwise the range moves around the message while preserving its size:

- Calendar-day ranges stay on midnight boundaries in the application timezone
  (`Europe/Kiev`), including across daylight-saving changes. One day shows the
  message's day. Ninety days includes 45 days before it and 44 days after it.
- Custom datetime ranges preserve their elapsed duration and center on the
  message's minute; odd minute counts put the extra minute after that minute.
- Interception mode uses the message's date and time, falling back to its
  timestamp when unavailable. A date without a time uses midnight. Creation
  mode uses only `createdAt`; a missing creation timestamp leaves dates unchanged.
- Invalid ranges are left for the existing date validation. Future dates are
  not clamped to today.

Adjusted dates are persisted in the URL with the message reference and other
filters. Role/settings initialization and automatic adjustment preserve focus.
User date or search edits leave direct-message navigation and invalidate a
pending lookup. Existing context pagination is unchanged.

Regression coverage:

- `wdintel-web/src/ts/react/routes/rer-analysis-neo/__tests__/helpers.spec.ts`
- `wdintel-web/src/ts/react/routes/rer-analysis-neo/__tests__/use-rer-analysis-neo-page.spec.tsx`
- `wdintel-web/tests/e2e/analysis-neo.spec.ts`
