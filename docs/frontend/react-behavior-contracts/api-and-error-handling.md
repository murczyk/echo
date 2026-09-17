# API and error handling

## User-settings save payload

- **Status:** operational compatibility
- **Behavior ID:** `user-settings-save-payload`
- **Expected observable result:** saving user settings sends the current preference values using the API wire representation, including the message-preview selection.
- **Source implementation:** `wdintel-web/src/ts/react/services/api/user-settings.ts`
- **Existing test(s):** No direct default-suite test; behavior is preserved by this contract.

## System settings create payload

- **Status:** operational compatibility
- **Behavior ID:** `system-settings-create-payload`
- **Expected observable result:** create requests preserve audio-transcription, replay-interval, battleline-distance, and bot-tag settings using backend snake-case fields.
- **Source implementation:** `wdintel-web/src/ts/react/services/api/system-settings.ts`
- **Existing test(s):** No direct default-suite test; behavior is preserved by this contract.

## Media summary endpoint selection

- **Status:** operational compatibility
- **Behavior ID:** `media-summary-endpoint-selection`
- **Expected observable result:** coordinate summaries use the authorized media endpoint and OCR evaluation uses the administrator summary endpoint with the caller's abort signal.
- **Source implementation:** `wdintel-web/src/ts/react/services/api/media-summary.ts`
- **Existing test(s):** No direct default-suite test; behavior is preserved by this contract.

## Authentication redirect

- **Status:** inferred characterization

- **Behavior ID:** `react-api-unauthorized-redirect`
- **Affected route/component:** shared React API client and authentication redirect boundary
- **User role or permission:** any authenticated user whose server session is no longer authorized
- **Preconditions:** the user is on a protected route; the client receives an HTTP 401 response
- **User action or external event:** a request is rejected with 401
- **Expected observable result:** the browser is replaced with `/login` and a `redirect` parameter containing the current relative path, query, and hash.
- **Loading/empty/error/success behavior:** non-401 failures remain errors and do not redirect; helpers that intentionally degrade ordinary failures to empty results must still rethrow 401.
- **URL, localStorage, or user-settings persistence:** the original URL is preserved only in the login `redirect` parameter. The login route itself never redirects again.
- **API endpoint and compatibility requirements:** applies to every shared client request method; server response text remains the error detail for non-401 responses.
- **Responsive and keyboard requirements:** none.
- **Known race/idempotency constraints:** redirect is a terminal authorization transition; a 401 must not be swallowed as an ordinary empty response.
- **Source implementation:** `src/ts/react/services/api/client.ts`, `src/ts/react/auth-redirect.ts`
- **Existing test(s):** `wdintel-web/src/ts/react/services/api/__tests__/client.spec.ts`
- **Original Echo issue/PR, if known:** none recorded; retained as an authorization safeguard.

## Direct-submit inline response normalization

- **Status:** operational compatibility
- **Behavior ID:** `react-direct-submit-inline-response-normalization`
- **Affected route/component:** direct message create and edit API boundary.
- **User role or permission:** users permitted to submit or edit a direct report.
- **Preconditions:** the create or edit endpoint returns a successful response with an optional inline message.
- **User action or external event:** the user submits or edits a direct report.
- **Expected observable result:** snake-case and camel-case inline messages normalize for React consumers; missing or null inline messages remain absent; request options are preserved for edits.
- **Loading/empty/error/success behavior:** a successful response without an inline message remains a successful response.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** create uses `/api/1.1/submit-direct`; edit uses `/api/1.1/message/:id/edit`; supported message fields normalize without changing request options.
- **Responsive and keyboard requirements:** none.
- **Known race/idempotency constraints:** none.
- **Source implementation:** `src/ts/react/services/api/direct-submit.ts`
- **Existing test(s):** `wdintel-web/src/ts/react/services/api/__tests__/direct-submit.spec.ts`
- **Original Echo issue/PR, if known:** none recorded; retained as operational parser coverage.

## Direct-submit error presentation

- **Status:** inferred characterization

- **Behavior ID:** `react-direct-submit-error-presentation`
- **Affected route/component:** direct message submission and deletion error boundary
- **User role or permission:** users permitted to submit or delete a direct report
- **Preconditions:** the direct-submit action reaches an API error
- **User action or external event:** the server returns a business error or an internal failure
- **Expected observable result:** explicit backend validation/business detail remains visible; internal server errors are replaced with an actionable Ukrainian save/delete message.
- **Loading/empty/error/success behavior:** an error leaves the action unsuccessful and communicates a user-safe explanation.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** backend validation/business detail remains available to the existing error formatter; internal server failures use an actionable Ukrainian fallback.
- **Responsive and keyboard requirements:** none.
- **Known race/idempotency constraints:** none.
- **Source implementation:** `src/ts/react/services/api/direct-submit.ts`
- **Existing test(s):** No direct default-suite test; behavior is preserved by this contract.
- **Original Echo issue/PR, if known:** none recorded.

## Direct-submit device and report-copy endpoint compatibility

- **Status:** operational compatibility
- **Behavior ID:** `react-direct-submit-device-and-report-copy-endpoints`
- **Affected route/component:** direct-submit device-name resolution and report-copy actions.
- **User role or permission:** users permitted to submit direct reports or copy report content.
- **Preconditions:** the caller supplies device identifiers or a source message for report copying.
- **User action or external event:** the user resolves device names or copies a report.
- **Expected observable result:** device names resolve through the established batch endpoint and report copies use the message-copy endpoint with the expected request shape.
- **Loading/empty/error/success behavior:** unavailable optional device names or copy results are handled by the existing caller error paths.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** preserves established batch device-name lookup and message-copy endpoint paths and payload fields.
- **Responsive and keyboard requirements:** none.
- **Known race/idempotency constraints:** none.
- **Source implementation:** `src/ts/react/services/api/direct-submit.ts`
- **Existing test(s):** No direct default-suite test; behavior is preserved by this contract.
- **Original Echo issue/PR, if known:** none recorded.

## Legacy API compatibility

- **Status:** operational compatibility

- **Behavior ID:** `react-api-legacy-response-compatibility`
- **Affected route/component:** shared location, messenger, and report-history API boundaries
- **User role or permission:** users with access to the respective route
- **Preconditions:** the backend returns a supported legacy wire representation
- **User action or external event:** locality lookup, messenger service-name validation, or report cancellation status is loaded
- **Expected observable result:** snake-case locality and messenger fields normalize for React consumers; explicit and legacy/debug-formatted cancellation messages classify as cancelled without classifying unrelated failures as cancelled.
- **Loading/empty/error/success behavior:** missing locality fields remain null; unrelated report failures remain failures.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** location coordinates use `lon` on the wire; messenger availability uses `system_service_name`; cancellation compatibility accepts the current marker and known legacy error forms.
- **Responsive and keyboard requirements:** none.
- **Known race/idempotency constraints:** cancellation classification must not turn an unrelated late failure into a successful cancellation.
- **Source implementation:** `services/api/location.ts`, `messenger.ts`, `report-history.ts`
- **Existing test(s):** `wdintel-web/src/ts/react/services/api/__tests__/location.spec.ts`, `wdintel-web/src/ts/react/services/api/__tests__/messenger.spec.ts`, `wdintel-web/src/ts/react/services/api/__tests__/report-history.spec.ts`
- **Original Echo issue/PR, if known:** none recorded; retained as operational compatibility coverage.

## Shared response-key normalization

- **Status:** operational compatibility

- **Behavior ID:** `react-api-snake-key-normalization`
- **Affected route/component:** shared API payload transformer used by React routes
- **User role or permission:** any user receiving an API-backed React view
- **Preconditions:** a supported server response includes snake-case keys, including keys with numeric suffixes
- **User action or external event:** the response is consumed by a typed React API service
- **Expected observable result:** nested keys normalize to their established camel-case fields, including `unit_1`/`unit_2` and `network_ids_reported_in` compatibility fields.
- **Loading/empty/error/success behavior:** none beyond normal response handling.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** preserves shared backwards-compatible wire-to-client key mapping.
- **Responsive and keyboard requirements:** none.
- **Known race/idempotency constraints:** none.
- **Source implementation:** `src/ts/snake-to-camel.ts`
- **Existing test(s):** `wdintel-web/src/ts/snake-to-camel.spec.ts`
- **Original Echo issue/PR, if known:** none recorded; retained as operational parser coverage.

## Administrative API optional fields and rules

- **Status:** operational compatibility

- **Behavior ID:** `react-admin-api-optional-field-compatibility`
- **Affected route/component:** Battle Line, Device Analytics, GOI administration, settlement lookup, System Settings, tag display, user settings, and saved Duty filters
- **User role or permission:** users authorized for the respective administrative or filtered route
- **Preconditions:** a route loads or saves a supported wire response/request
- **User action or external event:** the user uploads Battle Line state, edits a rule, looks up a settlement, adjusts settings, displays tags, or saves a Duty filter
- **Expected observable result:** strict rule expressions, optional booleans, coordinates, tagged IDs, saved-filter state, and legacy snake-case responses retain their supported client meaning.
- **Loading/empty/error/success behavior:** omitted optional fields receive their documented defaults without masking explicit false/null values.
- **URL, localStorage, or user-settings persistence:** route-owned persistence remains outside the mapper.
- **API endpoint and compatibility requirements:** each request preserves its established casing and field names; returned values normalize before use by React components. Settlement prefix lookup sends `query`, nullable `related_coordinates`, nullable `signal_group_master_key`, and explicit null `region`/`aor_id` values to preserve the backend's accepted search shape.
- **Responsive and keyboard requirements:** none at the API boundary.
- **Known race/idempotency constraints:** none in the mapper itself.
- **Source implementation:** corresponding modules in `src/ts/react/services/api/`.
- **Existing test(s):** `wdintel-web/src/ts/react/services/api/__tests__/battle-line.spec.ts`, `wdintel-web/src/ts/react/services/api/__tests__/device-analytics.spec.ts`, `wdintel-web/src/ts/react/services/api/__tests__/goi-admin.spec.ts`, `wdintel-web/src/ts/react/services/api/__tests__/system-settings.spec.ts`, `wdintel-web/src/ts/react/services/api/__tests__/tags.spec.ts`, `wdintel-web/src/ts/react/services/api/__tests__/user-settings.spec.ts`, `wdintel-web/src/ts/react/services/api/__tests__/rer-duty-saved-filters.spec.ts`
- **Original Echo issue/PR, if known:** none recorded; retained as operational compatibility coverage.
