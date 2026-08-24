# Duty

## Keyword-set selection

- **Status:** inferred characterization

- **Behavior ID:** `react-duty-keyword-set-selection`
- **Affected route/component:** Duty keyword-set editor and feed keyword filter
- **User role or permission:** users allowed to edit or apply keyword sets
- **Preconditions:** keyword sets have been loaded for the current user
- **User action or external event:** the user creates a new set or selects a saved set for highlighting
- **Expected observable result:** a new set gets the first available `Новий набір` name; only an ID present in the loaded set list can be selected; labels use the saved set name.
- **Loading/empty/error/success behavior:** a missing or removed selected ID resolves to no selection.
- **URL, localStorage, or user-settings persistence:** selected state follows the duty filter model.
- **API endpoint and compatibility requirements:** keyword-set ACL fields returned as `can_edit` and `can_delete` normalize to camel case before determining available actions.
- **Responsive and keyboard requirements:** none specific to this shared logic.
- **Known race/idempotency constraints:** deleted sets must not remain selected after a refresh.
- **Source implementation:** `src/ts/react/services/api/organism-keyword-sets.ts`, `routes/rer-duty-neo/FeedKeywordsPanel.tsx`
- **Existing test(s):** `services/api/organism-keyword-sets.spec.ts` retains the operational ACL normalization fixture.
- **Original Echo issue/PR, if known:** none recorded.
