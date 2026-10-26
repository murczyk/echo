# MessageCard #3324: scoped design QA

## Source and scope

Source visual truth: the three inline image attachments supplied on 2026-10-26:
`/Users/finch/Desktop/Screenshot 2026-10-26 at 10.11.09.png` (diamond),
`/Users/finch/Desktop/Screenshot 2026-10-26 at 10.25.02.png` (desktop), and
`/Users/finch/Desktop/Screenshot 2026-10-26 at 10.27.02.png` (mobile).
These identify the attached references, not files available on the Linux host.

Scope: absolute footer time, red outlined unit diamond, header divider, and
two internal columns that stack on narrow cards. This is not a complete
pixel-for-pixel implementation of all the screenshot's controls or typography.

## Rendered evidence

- Desktop: `/tmp/echo-3324-final-qa/message-card-layout-ECHO-3-2fc26--layout-analysis-regression-chromium/analysis-1920-case-4.png`.
- Mobile: `/tmp/echo-3324-final-qa/message-card-layout-ECHO-3-2fc26--layout-analysis-regression-chromium/analysis-490-case-4.png`.
- Attachment-only mobile: `/tmp/echo-3324-final-qa/message-card-layout-ECHO-3-92f14-card-layout-duty-regression-chromium/duty-390-case-2.png`.
- Remaining captures, including light-theme checks: `/tmp/echo-3324-final-qa/`.

Browser viewport widths: 390, 490, 768, 1512, 1920, 2560, 3440; height 1080;
deviceScaleFactor 1. The reference desktop/mobile frames are approximately
1686×1332 and 490×1310 pixels. Implementation captures are component crops,
not full-browser captures: desktop 1568×285, mobile 474×326, attachment-only
mobile 355×353. Different fixture text, content length, app sidebars, and
existing typography mean that these are structural comparisons, not pixel diffs.

Both Analysis and Duty were exercised with long text/no attachments, no text/many
attachments, short text/no attachments, and short text/one attachment; no reports.

## Findings and comparison

- Full view: text and attachments share the left column; details stay right.
  Narrow cards preserve that content order in one column. No third track remains.
- Focused header/footer view: the MUI two-tone square rotated 45° gives the red
  outlined diamond with a faint interior; the divider spans the content width.
  Footer values use Kyiv calendar dates and switch from time to date/time at midnight.
- Fonts/typography: existing app family, weights, and responsive text sizing retained.
- Spacing/layout rhythm: existing card padding retained; equal desktop tracks,
  16px gutter, stacked mobile content, and attachments below text were verified.
- Colors/tokens: existing error, divider, surface, and text tokens retained;
  both dark and light themes captured. No new fixed theme colors.
- Image quality: existing attachment renderers/assets retained; fixture images
  intentionally differ from the user's message photo. No screenshot imagery recreated.
- Copy/content: no relative ages; dates use `DD.MM.YYYY, HH:mm` and today uses `HH:mm`.

The supplied reference and rendered captures were visually inspected for these
four changes. No actionable P0/P1/P2 mismatch was identified within that scope.
The existing app-wide floating create action can cover part of the final card's
footer in isolated crops; that page-level behavior is outside this change.

## Comparison history and checks

Initial automated captures exposed fixture issues: legacy image URLs survived in
no-attachment variants, auth initialization remounted cards, and the responsive
Analysis filter drawer covered mobile content. Fixtures now clear legacy images,
wait for the authenticated shell, and dismiss the drawer before mobile captures.
Geometry is sampled atomically to avoid mixing positions across scroll updates.
The final seven header/time/layout browser regressions and ten reply/chain browser
regressions pass; no page errors were observed in the four-variant matrix.
Media reveal, editor open/close, reply creation, read-only access, and mobile
reply overlays were tested. Independent code review found no actionable issues.

Production build passed; 398 Vitest files / 3515 tests passed. Full attachment E2E:
44 passed, six previously observed failures remain (missing ffmpeg, legacy KML
twice, Analysis KML, coordinate hover, and #3064 mobile positions).

Implementation checklist: all four scoped changes implemented and verified;
reply content preserved; no commit, push, deployment, migration, or database write.

## Follow-up: restored Duty column width

At the user's request, the single Duty feed and its loading skeleton again share
the previous maximum width of 960px (instead of 1280px). Multiple-feed widths,
mobile behavior, and the internal card layout are unchanged. Updated captures:
`/tmp/echo-3324-width-qa/`. The four-variant matrices for both hosts passed;
the three Duty header regressions passed in `/tmp/echo-3324-width-headers-green/`.
The midnight fixture now leaves ten simulated minutes for page initialization
before advancing across midnight, avoiding a five-second wall-clock loading race.
Production build and all 3515 Vitest tests passed again.

## Follow-up: restored internal column proportions

At the user's request, the earlier equal-track layout is superseded by the
pre-redesign CSS: `minmax(0, 1fr) minmax(220px, 32%)`, with a 24px gap.
The breakpoint and stacked mobile order are unchanged. Captures of all four
content variants in both hosts at 390–3440px are in
`/tmp/echo-3324-proportions-green/`; both layout matrices passed.
The three header/editor browser checks passed on rerun after a transient
initial-page loading timeout (`/tmp/echo-3324-proportions-headers-green/`).
Production build, formatting, and all 3515 Vitest tests passed.

## Follow-up: date-year visibility

Header dates now always include the year, without changing their selected time
basis. Receipt footer dates omit the year only for the current Kyiv calendar
year; today's messages still show time only. Visible date labels are scheduled
to refresh at the applicable day/year boundary. Captures before and after both
boundaries, including mobile, are in `/tmp/echo-3324-year-format-qa/`.
All eight affected browser checks, 3517 Vitest tests, production build, and
formatting passed. No commit or push was made.

final result: passed
