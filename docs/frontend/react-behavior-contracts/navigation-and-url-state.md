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

## Profile navigation menu

- **Status:** inferred characterization
- **Behavior ID:** `app-navbar-profile-menu`
- **Affected route/component:** `ProfileDropdown` in the application navbar.
- **User role or permission:** authenticated users; basic users additionally see personal-report and group-settings links.
- **Preconditions:** the navbar receives the authenticated user, theme state, and dropdown ownership callbacks.
- **User action or external event:** the user opens the profile menu, selects a theme, follows an eligible internal link, or signs out.
- **Expected observable result:** profile actions delegate to navbar-owned theme, navigation, and logout handlers and close the active dropdown after an action.
- **Loading/empty/error/success behavior:** the menu remains closed unless the navbar marks the profile dropdown active.
- **URL, localStorage, or user-settings persistence:** the navbar owns theme and route persistence.
- **API endpoint and compatibility requirements:** logout/session handling is owned by the parent application boundary.
- **Responsive and keyboard requirements:** the native menu trigger exposes its expanded state; responsive visibility remains owned by navbar styling.
- **Known race/idempotency constraints:** none.
- **Source implementation:** `components/app-navbar/ProfileDropdown.tsx`
- **Existing test(s):** no default-suite test; prior callback/render tests were removed.
- **Original Echo issue/PR, if known:** none recorded.

## Navbar menu composition

- **Status:** inferred characterization
- **Behavior ID:** `app-navbar-menu-composition`
- **Affected route/component:** `menu-items.ts` and `AppNavbar`.
- **User role or permission:** authenticated users receive only the menu groups enabled by their roles and system settings.
- **Preconditions:** the navbar has current role, feature-setting, and optional GOI integration state.
- **User action or external event:** the current route changes, settings refresh, or a menu item is selected.
- **Expected observable result:** the navbar derives active items from the configured tree, conditionally includes RER/Devices groups, and opens configured GOI hosts as external URLs while preserving explicit HTTP(S) schemes.
- **Loading/empty/error/success behavior:** unavailable feature groups are absent; an empty GOI host creates no external navigation target.
- **URL, localStorage, or user-settings persistence:** the parent route and system-settings state own persistence.
- **API endpoint and compatibility requirements:** none.
- **Responsive and keyboard requirements:** desktop/mobile menu rendering owns interaction semantics; the static tree does not.
- **Known race/idempotency constraints:** none.
- **Source implementation:** `components/app-navbar/menu-items.ts`, `AppNavbar.tsx`
- **Existing test(s):** no default-suite test; prior direct tree/default assertions were removed.
- **Original Echo issue/PR, if known:** none recorded.

## Changelog and maintenance notice

- **Status:** inferred characterization
- **Behavior ID:** `app-navbar-changelog-maintenance`
- **Affected route/component:** `ChangelogDropdown` in the application navbar.
- **User role or permission:** authenticated users receiving changelog or deployment-maintenance state.
- **Preconditions:** shared state may contain a changelog preview, last-seen version, and/or active deployment maintenance ID.
- **User action or external event:** a new maintenance ID arrives, maintenance ends, or the user opens the notification control.
- **Expected observable result:** a newly active maintenance notice opens once, ends by closing an open notice, and takes priority over changelog preview content. An unseen release delegates its version to the parent before opening the preview.
- **Loading/empty/error/success behavior:** no trigger renders without maintenance or preview state.
- **URL, localStorage, or user-settings persistence:** last-seen version and changelog loading state are owned by shared application state.
- **API endpoint and compatibility requirements:** none.
- **Responsive and keyboard requirements:** the native notification trigger exposes its expanded state.
- **Known race/idempotency constraints:** repeated renders of the same maintenance ID do not repeatedly reopen the dropdown.
- **Source implementation:** `components/app-navbar/ChangelogDropdown.tsx`
- **Existing test(s):** no default-suite test; prior callback/timer/render checks were removed.
- **Original Echo issue/PR, if known:** none recorded.
