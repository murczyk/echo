# Navigation and URL-state contracts

## Battle Line tabs

- **Status:** issue-backed regression — https://github.com/echoua/echo/pull/3268

**Behavior ID:** `battle-line-tab-history`

- **Affected route/component:** `/admin/battle-line`.
- **User role or permission:** users allowed to access the Battle Line administration page.
- **Preconditions:** the route has a current URL and at least one supported tab.
- **External event:** tab click or browser `popstate`.
- **Expected observable result:** public tab values are pushed on user selection and restored by Back/Forward; unrelated query parameters and hash are retained.
- **Loading/empty/error/success behavior:** invalid/missing tab state opens the supported default without rendering an invalid panel.
- **Persistence:** missing or unsupported values resolve to LBZ and are canonicalized with `replaceState`.
- **API compatibility requirements:** none.
- **Responsive and keyboard requirements:** tab controls retain their standard keyboard selection behavior.
- **Known race/idempotency constraints:** selecting the active tab must not create another history entry.
- **Source implementation:** `wdintel-web/src/ts/react/routes/admin-battle-line/index.tsx`.
- **Existing test:** page-level click/history/popstate regression.
- **Original Echo issue/PR:** https://github.com/echoua/echo/pull/3268.

## Device Analytics tabs

- **Status:** inferred characterization

**Behavior ID:** `device-analytics-tab-history`

- **Affected route/component:** `/admin/device-analytics`.
- **User role or permission:** users allowed to access Device Analytics administration.
- **Preconditions:** the route has a current URL and a supported analytics tab.
- **User action or external event:** tab click, initial mount, or browser Back/Forward navigation.
- **Expected observable result:** `general` and `tags` map to URL state, missing/invalid values resolve to `general`, clicks do not duplicate the active history entry, and inactive panels remain lazy.
- **Loading/empty/error/success behavior:** invalid state selects General without an error panel.
- **Persistence:** unrelated query parameters and hashes survive URL writes; initial mount and `popstate` canonicalize invalid values with `replaceState`.
- **API compatibility requirements:** none.
- **Responsive and keyboard requirements:** tabs retain their standard keyboard selection behavior.
- **Known race/idempotency constraints:** canonicalization must run on `popstate` even when React state is already General.
- **Source implementation:** `wdintel-web/src/ts/react/routes/admin-device-analytics/index.tsx`.
- **Existing tests:** behavior is temporarily documented while its former mocked URL tests are under migration; a faithful browser-history regression requires enabled Playwright.
