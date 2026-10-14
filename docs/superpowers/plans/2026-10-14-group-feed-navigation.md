# Group Feed Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reusable messenger-style group navigation with durable unread state to Duty and Analysis while preserving the existing aggregate feeds and filters.

**Architecture:** Merge the shared feed/navigation refactor first, then add a set-based backend group-state API backed by per-user/group creation-time cursors. A shared React controller/cache and dumb presentation components serve thin Duty and Analysis adapters; each Duty column owns its scope while Analysis stores its scope in the URL.

**Tech Stack:** Rust, Actix Web, SeaORM/PostgreSQL migrations, generated Elm/TypeScript bindings, React 18, MUI leaf controls, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-14-group-feed-navigation-design.md`

## Global Constraints

- Merge `3689-scroll-feed-refactoring` into `3727-groups-list` before feature code and retain its shared `message-feed` and `message-navigation` abstractions.
- Keep `Всі групи` behavior and aggregate filter state backward-compatible.
- Duty ordering, unread boundaries, and group activity use creation time `(signal_message.created_at, id)`; never consume Analysis `messageSortBy` for Duty.
- Group counts use one set-based request, shared single-flight caching, event coalescing, and no per-group or one-second polling.
- Group read state advances only for a single-group feed with no content-restricting filters at the validated current tail.
- Missing read state initializes at the current group tail, so historical messages start read.
- Build dumb shared UI components; route-specific components only adapt layout, persistence, and feed lifecycles.
- Use a text avatar only: first visible group-name grapheme and a neutral background until the backend owns a group color.
- Keep repeated Duty feed/card markup out of new MUI layout wrappers and preserve narrow active-only mounting.
- Define backend types in Rust and run `just gen-front`; never hand-write generated frontend codecs.
- Show every API failure through the existing standard toast/error path.
- Format changed frontend files with `cd wdintel-web && npm run format:staged`; avoid unrelated formatter diffs.
- Update `CHANGELOG.md` under `NEXT` with issue `#3727` only after the behavior is implemented.

## Review Focus

1. Rapid scope switches while old page/count requests are in flight must never commit stale rows, anchors, or acknowledgements; Tasks 4, 7, and 8 pin generation/abort behavior.
2. Revoked group access between catalog load, selection, and acknowledgement must fall back safely without leaking messages; Tasks 3, 7, and 8 test it.
3. Multiple open Duty panels plus an open Analysis panel must share one fresh batch result and coalesce inbox-event bursts; Tasks 4 and 9 assert request counts.
4. Equal creation timestamps, deleted boundary messages, and reversed Analysis orientation must retain a deterministic oldest-unread anchor; Tasks 2, 3, and 8 cover the tuple cursor.
5. Old short URLs/local state without group scopes and URLs with unknown group keys must hydrate as `Всі групи` without losing filters; Tasks 7 and 8 cover compatibility.

---

### Task 1: Integrate the shared feed refactor

**Files:**
- Merge: `3689-scroll-feed-refactoring`
- Verify: `wdintel-web/src/ts/react/routes/shared/message-feed/`
- Verify: `wdintel-web/src/ts/react/routes/shared/message-navigation/`
- Verify: `wdintel-web/src/ts/react/routes/rer-duty-neo/`
- Verify: `wdintel-web/src/ts/react/routes/rer-analysis-neo/`

**Interfaces:**
- Consumes: current `3727-groups-list` containing the approved design commit.
- Produces: the post-3689 shared `MessageFeed` and message-navigation controller used by every later task.

- [ ] **Step 1: Merge the dependency branch**

Run: `git merge --no-ff 3689-scroll-feed-refactoring`

Resolve conflicts in favor of the 3689 shared feed/windowing/navigation code while retaining the design and plan documents.

- [ ] **Step 2: Run the refactor's focused baseline tests**

Run:

```bash
cd wdintel-web
npx vitest run \
  src/ts/react/routes/shared/message-feed/__tests__/MessageFeed.spec.tsx \
  src/ts/react/routes/shared/message-navigation/__tests__/message-navigation-controller.spec.ts \
  src/ts/react/routes/rer-duty-neo/__tests__/index.spec.tsx \
  src/ts/react/routes/rer-analysis-neo/__tests__/use-analysis-message-list.spec.ts
```

Expected: PASS before group-navigation changes.

- [ ] **Step 3: Run the shared-feed browser regression**

Run: `cd wdintel-web && npm exec -- playwright test tests/e2e/message-feed-unification.spec.ts`

Expected: PASS; record any environment-only skip explicitly before continuing.

- [ ] **Step 4: Confirm the merge boundary**

Run: `git status --short && git log --oneline --max-count=3`

Expected: clean worktree and a merge commit whose second parent is `3689-scroll-feed-refactoring`.

### Task 2: Add the durable group read-state store

**Files:**
- Create: `echo-migration/src/m20261014_170250_user_group_feed_read_state.rs`
- Modify: `echo-migration/src/lib.rs`
- Generate: `wdintel-rs/src/entities/user_group_feed_read_state.rs`
- Generate: `wdintel-rs/src/entities/mod.rs`
- Generate: `wdintel-rs/src/entities/prelude.rs`
- Create: `wdintel-rs/src/rer_importer/group_feed_state.rs`
- Modify: `wdintel-rs/src/rer_importer/mod.rs`
- Test: `wdintel-rs/src/rer_importer/group_feed_state.rs`

**Interfaces:**
- Consumes: existing accessible-group query and `signal_message_group (group_master_key, signal_message_id)` index.
- Produces: `GroupFeedCursor`, `GroupFeedStateRecord`, `list_group_feed_states(dbx, login)`, and `acknowledge_group_feed_tail(dbx, login, master_key, cursor)`.

- [ ] **Step 1: Write failing database tests**

Add tests named:

```rust
first_list_initializes_existing_messages_as_read()
new_messages_increment_only_their_accessible_group()
oldest_unread_uses_created_at_then_id()
acknowledgement_is_monotonic_and_idempotent()
deleted_boundary_message_does_not_move_cursor_backwards()
concurrent_initialization_creates_one_row_per_user_and_group()
```

Assert that initialization returns zero unread, a later message returns count
one and its message reference, equal timestamps use ID as the tie-breaker, and
an older acknowledgement cannot replace a newer cursor.

- [ ] **Step 2: Run the tests to verify failure**

Run: `cargo test -p wdintel-rs group_feed_state -- --nocapture`

Expected: FAIL because the migration/entity/store do not exist.

- [ ] **Step 3: Add the pure SQL migration**

If implementation starts after this plan date, replace `20261014_170250` with
the actual Europe/Kyiv creation timestamp everywhere before creating the file.

Create `user_group_feed_read_state` with:

```text
login_id uuid not null references login(id) on delete cascade
group_master_key text not null references signal_group(master_key) on delete cascade
last_read_created_at timestamp without time zone null
last_read_message_id bigint null
updated_at timestamp without time zone not null default now()
primary key (login_id, group_master_key)
```

Keep the nullable cursor for empty groups. Register the migration in
`echo-migration/src/lib.rs`; use the repository's pure-SQL up/down style and
declare the correct analytics-catalog impact.

- [ ] **Step 4: Apply and generate models**

Run:

```bash
source deploy/setup_test_database.sh 3727-groups-list
just migrate-up
just gen-seaorm
```

Expected: migration succeeds and the new entity is generated without unrelated entity diffs.

- [ ] **Step 5: Implement the store functions**

Define:

```rust
pub struct GroupFeedCursor {
    pub created_at: NaiveDateTime,
    pub message_id: i64,
}

pub async fn list_group_feed_states(
    dbx: &DatabaseConnection,
    login: Uuid,
) -> anyhow::Result<Vec<GroupFeedStateRecord>>;

pub async fn acknowledge_group_feed_tail(
    dbx: &DatabaseConnection,
    login: Uuid,
    group_master_key: &str,
    cursor: GroupFeedCursor,
) -> anyhow::Result<GroupFeedStateRecord>;
```

Initialize missing rows and calculate states with set-based SQL in a
transaction. Count distinct message IDs after `(last_read_created_at,
last_read_message_id)`, sort groups by their latest creation-time tuple, and
reuse the existing group-access predicate.

- [ ] **Step 6: Run database tests and formatting**

Run:

```bash
cargo fmt --all
cargo test -p wdintel-rs group_feed_state -- --nocapture
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add echo-migration/src wdintel-rs/src/entities wdintel-rs/src/rer_importer
git commit -m "feat(3727): added durable group read state"
```

### Task 3: Expose one authorized group-state API

**Files:**
- Modify: `wdintel-rs/src/rer_importer/types.rs`
- Modify: `wdintel-rs/src/rer_importer/group_feed_state.rs`
- Modify: `wdintel-rs/src/elm.rs`
- Modify: `wdintel-rs/src/server/mod.rs`
- Generate: `wdintel-web/src/Bindings.elm`
- Generate: `wdintel-web/src/Bindings.ts`
- Create: `wdintel-web/src/ts/react/services/api/group-feed-state.ts`
- Test: `wdintel-rs/src/rer_importer/group_feed_state.rs`
- Test: `wdintel-web/src/ts/react/services/api/__tests__/group-feed-state.spec.ts`

**Interfaces:**
- Consumes: Task 2 store functions.
- Produces: `GET /api/rer-importer/group-feed-state`, `POST /api/rer-importer/group-feed-state/acknowledge`, generated `GroupFeedState` types, `fetchGroupFeedStates(signal?)`, and `acknowledgeGroupFeedTail(request, signal?)`.

- [ ] **Step 1: Write failing endpoint and client tests**

Backend assertions:

```rust
group_feed_state_excludes_inaccessible_groups()
group_feed_state_requires_base_role()
acknowledge_rejects_inaccessible_group()
acknowledge_rejects_a_stale_or_non_tail_cursor()
acknowledge_returns_the_committed_count()
```

Frontend assertions:

```ts
it('maps snake-case state and optional unread references')
it('passes AbortSignal to list and acknowledge requests')
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
cargo test -p wdintel-rs group_feed_state -- --nocapture
cd wdintel-web && npx vitest run src/ts/react/services/api/__tests__/group-feed-state.spec.ts
```

Expected: FAIL because routes and client functions are absent.

- [ ] **Step 3: Define Rust-generated API types**

Add:

```rust
pub struct GroupFeedState {
    pub master_key: String,
    pub name: String,
    pub ignore_operativny: bool,
    pub unread_count: i64,
    pub oldest_unread_message_ref: Option<String>,
    pub last_activity_at: Option<i64>,
    pub latest_cursor: Option<GroupFeedCursorDto>,
}

pub struct GroupFeedStatesRsp { pub groups: Vec<GroupFeedState> }
pub struct AcknowledgeGroupFeedReq {
    pub master_key: String,
    pub cursor: GroupFeedCursorDto,
}
```

Register all frontend-facing types in `wdintel-rs/src/elm.rs`.

- [ ] **Step 4: Implement and register handlers**

The GET handler verifies the same base roles as inbox access and returns all
accessible groups in one response. The POST handler rechecks group access and
requires the submitted cursor to equal the current group tail; a newer server
tail returns a stale/conflict response instead of acknowledging unseen rows.
Then perform the monotonic acknowledgement. Register both in
`wdintel-rs/src/server/mod.rs`.

- [ ] **Step 5: Generate bindings and implement the API client**

Run: `just gen-front`

Implement the two client functions using the shared JSON helpers and standard
error propagation. Do not add hand-written generated decoders.

- [ ] **Step 6: Run tests and checks**

Run:

```bash
cargo fmt --all
cargo test -p wdintel-rs group_feed_state -- --nocapture
cargo check -p wdintel-rs
cd wdintel-web && npx vitest run src/ts/react/services/api/__tests__/group-feed-state.spec.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add wdintel-rs/src wdintel-web/src/Bindings.elm wdintel-web/src/Bindings.ts wdintel-web/src/ts/react/services/api
git commit -m "feat(3727): added group feed state API"
```

### Task 4: Build the shared navigation domain, cache, and controller

**Files:**
- Create: `wdintel-web/src/ts/react/routes/shared/group-navigation/group-navigation.types.ts`
- Create: `wdintel-web/src/ts/react/routes/shared/group-navigation/group-feed-request.ts`
- Create: `wdintel-web/src/ts/react/routes/shared/group-navigation/group-feed-state-store.ts`
- Create: `wdintel-web/src/ts/react/routes/shared/group-navigation/useGroupFeedNavigation.ts`
- Create: `wdintel-web/src/ts/react/routes/shared/group-navigation/index.ts`
- Test: `wdintel-web/src/ts/react/routes/shared/group-navigation/__tests__/group-feed-request.spec.ts`
- Test: `wdintel-web/src/ts/react/routes/shared/group-navigation/__tests__/group-feed-state-store.spec.ts`
- Test: `wdintel-web/src/ts/react/routes/shared/group-navigation/__tests__/useGroupFeedNavigation.spec.tsx`

**Interfaces:**
- Consumes: Task 3 API client and existing `useInboxChangedMessageIds`.
- Produces: `GroupScope`, `applyGroupScopeToInboxRequest`, route-specific unfiltered predicates, `groupFeedStateStore`, and `useGroupFeedNavigation(options)`.

- [ ] **Step 1: Write failing pure-function tests**

Assert:

```ts
applyGroupScopeToInboxRequest(req, { kind: 'all' }) === req
applyGroupScopeToInboxRequest(req, { kind: 'group', masterKey: 'g-2' })
// selectedGroups: ['g-2'], deniedGroups: null; every other filter unchanged

isDutyGroupViewAcknowledgeable(emptyDutyFilter) === true
isDutyGroupViewAcknowledgeable({ ...emptyDutyFilter, sendersSelected: ['s'] }) === false
isAnalysisGroupViewAcknowledgeable(defaultAnalysisQuery) === true
isAnalysisGroupViewAcknowledgeable({ ...defaultAnalysisQuery, search: 'x' }) === false
```

Include every filter field that can hide messages so a newly added filter
cannot silently become acknowledgement-safe.

- [ ] **Step 2: Write failing cache/controller tests**

Test names and assertions:

```ts
it('single-flights concurrent visible consumers')
it('keeps a closed consumer stale without fetching')
it('coalesces an inbox-event burst into one refresh')
it('revalidates stale data on visibility and focus')
it('discards a response from an obsolete generation')
it('applies acknowledgement response without a follow-up GET')
it('keeps all-groups unread supplied by the owning feed')
```

- [ ] **Step 3: Run tests to verify failure**

Run: `cd wdintel-web && npx vitest run src/ts/react/routes/shared/group-navigation/__tests__`

Expected: FAIL because the module does not exist.

- [ ] **Step 4: Implement the domain and store**

Define:

```ts
export type GroupScope = { kind: 'all' } | { kind: 'group'; masterKey: string };

export function applyGroupScopeToInboxRequest(
  request: InboxMessagesReq,
  scope: GroupScope,
): InboxMessagesReq;

export function useGroupFeedNavigation(options: {
  enabled: boolean;
  scope: GroupScope;
  allUnreadCount: number;
  onSelect: (scope: GroupScope) => void;
  onError: (error: unknown) => void;
}): GroupFeedNavigationModel;
```

Use one module-level external store with subscribe/getSnapshot semantics,
short TTL, one `AbortController` per generation, reference-counted visible
consumers, and a bounded debounce for inbox-event bursts. Synthetic `Всі
групи` data receives `allUnreadCount` from the owning route and is never stored
as a server group.

- [ ] **Step 5: Run tests and format**

Run:

```bash
cd wdintel-web
npm run format:staged
npx vitest run src/ts/react/routes/shared/group-navigation/__tests__
```

Expected: PASS and no unrelated formatting diff.

- [ ] **Step 6: Commit**

```bash
git add wdintel-web/src/ts/react/routes/shared/group-navigation
git commit -m "feat(3727): added shared group navigation state"
```

### Task 5: Add dumb group-navigation UI

**Files:**
- Create: `wdintel-web/src/ts/react/routes/shared/group-navigation/GroupAvatar.tsx`
- Create: `wdintel-web/src/ts/react/routes/shared/group-navigation/GroupIsland.tsx`
- Create: `wdintel-web/src/ts/react/routes/shared/group-navigation/GroupList.tsx`
- Create: `wdintel-web/src/ts/react/routes/shared/group-navigation/GroupPanel.tsx`
- Create: `wdintel-web/src/ts/react/routes/shared/group-navigation/group-navigation.css`
- Modify: `wdintel-web/src/ts/react/routes/shared/group-navigation/index.ts`
- Test: `wdintel-web/src/ts/react/routes/shared/group-navigation/__tests__/group-navigation-ui.spec.tsx`

**Interfaces:**
- Consumes: Task 4 presentation model only.
- Produces: dumb `GroupIsland`, `GroupList`, and responsive `GroupPanel` components with no API or route imports.

- [ ] **Step 1: Write failing component tests**

Assert that the components:

```ts
render the first Unicode grapheme and never an image avatar
keep "Всі групи" first and render 99+ overflow
expose selected and unread state to assistive technology
call onSelect without mutating or fetching data
close on Escape/backdrop and restore focus to the island
truncate long names without removing the accessible full name
```

- [ ] **Step 2: Run the test to verify failure**

Run: `cd wdintel-web && npx vitest run src/ts/react/routes/shared/group-navigation/__tests__/group-navigation-ui.spec.tsx`

Expected: FAIL because components are absent.

- [ ] **Step 3: Implement the UI**

Use native structural markup and app/theme CSS variables. MUI leaf primitives
are allowed for modal/focus behavior, but the components accept only values,
state flags, refs, and callbacks. Keep closed panels unmounted.

- [ ] **Step 4: Run tests, token checks, and formatting**

Run:

```bash
cd wdintel-web
npm run format:staged
npx vitest run src/ts/react/routes/shared/group-navigation/__tests__/group-navigation-ui.spec.tsx
npm run tokens:check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add wdintel-web/src/ts/react/routes/shared/group-navigation
git commit -m "feat(3727): added group navigation components"
```

### Task 6: Prefill the shared create-message drawer

**Files:**
- Modify: `wdintel-web/src/ts/react/routes/shared/manage-message/ManageMessageDrawer.tsx`
- Modify: `wdintel-web/src/ts/react/routes/shared/manage-message/useManageMessageDrawer.ts`
- Test: `wdintel-web/src/ts/react/routes/shared/manage-message/__tests__/ManageMessageDrawer.edit.spec.tsx`

**Interfaces:**
- Consumes: an optional accessible group master key from a route adapter.
- Produces: `initialGroupMasterKey?: string | null` on `ManageMessageDrawer`; create mode applies it after catalog validation, while edit/report modes and absent values preserve current behavior.

- [ ] **Step 1: Write failing drawer tests**

Add assertions:

```ts
it('prefills an accessible initial group in create mode')
it('falls back to current recent-group behavior for all-groups scope')
it('rejects an inaccessible initial group and reports an error')
it('does not overwrite edit or report group state')
it('resets the initial group between create intents without leaking a draft')
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd wdintel-web && npx vitest run src/ts/react/routes/shared/manage-message/__tests__/ManageMessageDrawer.edit.spec.tsx`

Expected: FAIL on the new prop behavior.

- [ ] **Step 3: Implement the optional intent field**

Thread `initialGroupMasterKey` through the drawer hook's create intent. Apply it
only after `getUserSigintGroups(null)` confirms access, and use the existing
intent-change/dirty-draft guard when the source column changes.

- [ ] **Step 4: Run tests and format**

Run:

```bash
cd wdintel-web
npm run format:staged
npx vitest run src/ts/react/routes/shared/manage-message/__tests__/ManageMessageDrawer.edit.spec.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add wdintel-web/src/ts/react/routes/shared/manage-message
git commit -m "feat(3727): prefilled create message groups"
```

### Task 7: Integrate independent group scopes into Duty

**Files:**
- Modify: `wdintel-rs/src/rer_importer/types.rs`
- Modify: `wdintel-rs/src/elm.rs`
- Generate: `wdintel-web/src/Bindings.elm`
- Generate: `wdintel-web/src/Bindings.ts`
- Modify: `wdintel-web/src/ts/react/routes/rer-duty-neo/types.ts`
- Modify: `wdintel-web/src/ts/react/routes/rer-duty-neo/utils.ts`
- Modify: `wdintel-web/src/ts/react/routes/rer-duty-neo/duty-filter-persistence.ts`
- Modify: `wdintel-web/src/ts/react/routes/rer-duty-neo/useRerDutyShortState.ts`
- Modify: `wdintel-web/src/ts/react/routes/rer-duty-neo/useRerDutyNavigation.ts`
- Modify: `wdintel-web/src/ts/react/routes/rer-duty-neo/useDutyFeedColumnModel.ts`
- Modify: `wdintel-web/src/ts/react/routes/rer-duty-neo/FeedFilterPanel.tsx`
- Modify: `wdintel-web/src/ts/react/routes/rer-duty-neo/FeedColumn.tsx`
- Modify: `wdintel-web/src/ts/react/routes/rer-duty-neo/RerDutyNeoWorkspace.tsx`
- Modify: `wdintel-web/src/ts/react/routes/rer-duty-neo/index.tsx`
- Test: `wdintel-web/src/ts/react/routes/rer-duty-neo/__tests__/RerDutyNeoWorkspace.spec.tsx`
- Test: `wdintel-web/src/ts/react/routes/rer-duty-neo/__tests__/useRerDutyFeedState.initial-load.spec.tsx`
- Test: `wdintel-web/src/ts/react/routes/rer-duty-neo/__tests__/duty-filter-persistence.spec.ts`
- Create/Test: `wdintel-web/tests/e2e/group-feed-navigation-duty.spec.ts`

**Interfaces:**
- Consumes: Tasks 3–6 and the 3689 feed generation/around-message APIs.
- Produces: one persisted `groupScopeMasterKey: string | null` per Duty feed, independent panels/islands/FABs, scoped requests, unread anchoring, and validated acknowledgement.

- [ ] **Step 1: Write failing state and persistence tests**

Assert:

```ts
legacy state without groupScopes hydrates every feed as all-groups
two feeds persist and restore different group master keys
selecting a group overrides only that feed request
returning to all-groups restores the untouched aggregate groupsSelected filter
rapid selection aborts the previous generation and cannot acknowledge it
content filters prevent group acknowledgement at the tail
```

- [ ] **Step 2: Write the failing Duty E2E contract**

In `group-feed-navigation-duty.spec.ts`, seed three groups and assert:

```text
column 1 selects group A while column 2 selects group B
each feed shows only its group and peer scroll/filter state remains unchanged
all-groups can still select A+B through the existing filter
each column FAB opens create with that column's group
desktop hover/focus and coarse-pointer FAB visibility follow the contract
mobile group drawer overlays the feed and preserves its scroll position
```

- [ ] **Step 3: Run focused tests to verify failure**

Run:

```bash
cd wdintel-web
npx vitest run \
  src/ts/react/routes/rer-duty-neo/__tests__/RerDutyNeoWorkspace.spec.tsx \
  src/ts/react/routes/rer-duty-neo/__tests__/useRerDutyFeedState.initial-load.spec.tsx \
  src/ts/react/routes/rer-duty-neo/__tests__/duty-filter-persistence.spec.ts
npm exec -- playwright test tests/e2e/group-feed-navigation-duty.spec.ts
```

Expected: FAIL on missing group navigation.

- [ ] **Step 4: Extend only the outer short-state type**

Add a backward-compatible optional mapping to `RerDutyQueryState`:

```rust
#[serde(default)]
pub group_scopes: Option<Vec<(String, String)>>,
```

Do not add navigation scope to `RerDutyQueryStateWf`, because that type is also
the saved-filter payload. Run `just gen-front` and update state converters.

- [ ] **Step 5: Integrate the per-column adapter**

Add `groupScopeMasterKey` to each `MessageFeedState`. Build the effective inbox
request through Task 4 helpers without mutating `feed.filter`. Selecting a group
must abort/increment/reset/load only that feed, using
`oldestUnreadMessageRef` with the 3689 around-message controller. Keep creation
time and narrow active-only constraints.

- [ ] **Step 6: Integrate panels, hidden group filter, and FABs**

Render `GroupIsland` and a conditionally mounted `GroupPanel` inside each
column. Pass `hideGroupSelection={groupScopeMasterKey !== null}` to the filter
panel. Replace the workspace-level create intent with
`openCreateMessageComposer(feedId)` and pass the active feed's group to Task 6.

- [ ] **Step 7: Wire read acknowledgement**

On the refactored physical-tail callback, acknowledge only when the current
generation, exact group scope, unfiltered predicate, and server-confirmed tail
cursor still match. Update the shared cache from the acknowledgement response.

- [ ] **Step 8: Run Duty tests and formatting**

Run:

```bash
cd wdintel-web
npm run format:staged
npx vitest run \
  src/ts/react/routes/rer-duty-neo/__tests__/RerDutyNeoWorkspace.spec.tsx \
  src/ts/react/routes/rer-duty-neo/__tests__/useRerDutyFeedState.initial-load.spec.tsx \
  src/ts/react/routes/rer-duty-neo/__tests__/duty-filter-persistence.spec.ts \
  src/ts/react/routes/rer-duty-neo/__tests__/useRerDutyFeedState.polling.spec.tsx
npm exec -- playwright test tests/e2e/group-feed-navigation-duty.spec.ts tests/e2e/rer-duty-scroll-stability.spec.ts
```

Expected: PASS, including existing creation-time/scroll regressions.

- [ ] **Step 9: Commit**

```bash
git add wdintel-rs/src/rer_importer/types.rs wdintel-rs/src/elm.rs wdintel-web/src/Bindings.elm wdintel-web/src/Bindings.ts wdintel-web/src/ts/react/routes/rer-duty-neo wdintel-web/tests/e2e/group-feed-navigation-duty.spec.ts
git commit -m "feat(3727): added per-column Duty group feeds"
```

### Task 8: Integrate group navigation into Analysis

**Files:**
- Modify: `wdintel-web/src/ts/react/routes/rer-analysis-neo/types.ts`
- Modify: `wdintel-web/src/ts/react/routes/rer-analysis-neo/helpers.ts`
- Modify: `wdintel-web/src/ts/react/routes/rer-analysis-neo/use-rer-analysis-neo-page.ts`
- Modify: `wdintel-web/src/ts/react/routes/rer-analysis-neo/use-analysis-data.reload.ts`
- Modify: `wdintel-web/src/ts/react/routes/rer-analysis-neo/components/AnalysisFiltersPanel.tsx`
- Modify: `wdintel-web/src/ts/react/routes/rer-analysis-neo/components/analysis-filters-panel-sections.tsx`
- Modify: `wdintel-web/src/ts/react/routes/rer-analysis-neo/AnalysisLeftPanel.tsx`
- Modify: `wdintel-web/src/ts/react/routes/rer-analysis-neo/AnalysisPageLayout.tsx`
- Modify: `wdintel-web/src/ts/react/routes/rer-analysis-neo/components/useAnalysisMessageFeed.ts`
- Test: `wdintel-web/src/ts/react/routes/rer-analysis-neo/__tests__/helpers.spec.ts`
- Test: `wdintel-web/src/ts/react/routes/rer-analysis-neo/__tests__/use-rer-analysis-neo-page.spec.tsx`
- Test: `wdintel-web/src/ts/react/routes/rer-analysis-neo/__tests__/index.spec.tsx`
- Test: `wdintel-web/src/ts/react/routes/rer-analysis-neo/components/__tests__/AnalysisFiltersPanel.spec.tsx`
- Test: `wdintel-web/src/ts/react/routes/rer-analysis-neo/components/__tests__/useAnalysisMessageFeed.spec.tsx`
- Create/Test: `wdintel-web/tests/e2e/group-feed-navigation-analysis.spec.ts`

**Interfaces:**
- Consumes: Tasks 3–6 and the 3689 Analysis `MessageFeed` adapter.
- Produces: URL-backed Analysis group scope, left-panel group list, persistent island, scoped requests, orientation-independent unread navigation, and group-prefilled create intent.

- [ ] **Step 1: Write failing URL, request, and filter tests**

Assert:

```ts
an absent or unknown group URL value resolves to all-groups
a known master key round-trips through browser navigation
group scope overrides request.selectedGroups without mutating queryState.groupsSelected
the groups filter section is absent only for a dedicated group
returning to all-groups restores the original selected groups
closing the left panel unmounts the list but leaves the island available
```

- [ ] **Step 2: Write failing orientation and E2E tests**

Seed unread messages with equal timestamps and assert the same oldest unread
message is focused for ascending and descending Analysis orientations. Also
assert the island reopens the closed left panel, reload preserves the URL scope,
filtered views do not acknowledge, and mobile uses an overlay drawer.

- [ ] **Step 3: Run tests to verify failure**

Run:

```bash
cd wdintel-web
npx vitest run \
  src/ts/react/routes/rer-analysis-neo/__tests__/helpers.spec.ts \
  src/ts/react/routes/rer-analysis-neo/__tests__/use-rer-analysis-neo-page.spec.tsx \
  src/ts/react/routes/rer-analysis-neo/__tests__/index.spec.tsx \
  src/ts/react/routes/rer-analysis-neo/components/__tests__/AnalysisFiltersPanel.spec.tsx \
  src/ts/react/routes/rer-analysis-neo/components/__tests__/useAnalysisMessageFeed.spec.tsx
npm exec -- playwright test tests/e2e/group-feed-navigation-analysis.spec.ts
```

Expected: FAIL on missing Analysis group navigation.

- [ ] **Step 4: Add separate URL-backed scope state**

Keep navigation outside saved-filter equality and payloads. Add helpers:

```ts
readAnalysisGroupScopeFromUrl(): GroupScope
writeAnalysisGroupScopeToUrl(scope: GroupScope): void
```

The page hook owns scope separately from `AnalysisQueryState`; browser
back/forward updates it without destroying filter state.

- [ ] **Step 5: Integrate the left panel and island**

Render the list only while `leftPanelOpen`; keep `GroupIsland` above the center
feed. Island activation opens the left panel at the group list. Dedicated scope
passes `hideGroupSelection` to the filters and uses Task 4 effective requests.

- [ ] **Step 6: Integrate unread navigation and acknowledgement**

Use the 3689 navigation controller to load around the oldest unread reference.
Map the semantic chronological anchor to either physical orientation without
changing Analysis's event/creation-time preference. A default date window may
expand through the existing direct-message navigation path to include the
anchor. A current content filter blocks acknowledgement.

- [ ] **Step 7: Integrate create intent and access fallback**

Pass the selected group to Task 6. If catalog refresh no longer includes the
URL group, switch to all-groups, replace the invalid URL value, and show the
standard toast.

- [ ] **Step 8: Run Analysis tests and formatting**

Run:

```bash
cd wdintel-web
npm run format:staged
npx vitest run \
  src/ts/react/routes/rer-analysis-neo/__tests__/helpers.spec.ts \
  src/ts/react/routes/rer-analysis-neo/__tests__/use-rer-analysis-neo-page.spec.tsx \
  src/ts/react/routes/rer-analysis-neo/__tests__/index.spec.tsx \
  src/ts/react/routes/rer-analysis-neo/components/__tests__/AnalysisFiltersPanel.spec.tsx \
  src/ts/react/routes/rer-analysis-neo/components/__tests__/useAnalysisMessageFeed.spec.tsx
npm exec -- playwright test tests/e2e/group-feed-navigation-analysis.spec.ts tests/e2e/analysis-neo.spec.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add wdintel-web/src/ts/react/routes/rer-analysis-neo wdintel-web/tests/e2e/group-feed-navigation-analysis.spec.ts
git commit -m "feat(3727): added Analysis group navigation"
```

### Task 9: Lock cross-route unread and performance behavior

**Files:**
- Create/Test: `wdintel-web/tests/e2e/group-feed-unread-state.spec.ts`
- Modify: `wdintel-web/tests/e2e/fixture-responses.ts`
- Modify: `CHANGELOG.md`
- Verify: all files changed by Tasks 1–8

**Interfaces:**
- Consumes: completed backend, shared controller, Duty, and Analysis integrations.
- Produces: cross-route E2E coverage, network-call budget assertions, changelog entry, and release verification evidence.

- [ ] **Step 1: Write the failing cross-route E2E tests**

Assert:

```text
first use reports zero historical unread messages
a new message increments the same group badge in Duty and Analysis
reaching the unfiltered live tail in one route clears the other route after refresh
a filtered group remains unread after reaching its visible tail
two nearly simultaneous Duty panels cause one group-state GET
an echo-inbox-changed burst causes at most one coalesced GET while visible
events cause zero group-state GETs while all group panels are closed
revoked selected access falls back to all-groups with a toast
```

- [ ] **Step 2: Run the E2E test and fix only integration defects**

Run: `cd wdintel-web && npm exec -- playwright test tests/e2e/group-feed-unread-state.spec.ts`

Expected before fixes: at least one assertion exposes missing cross-route or
request-budget wiring. Make the narrowest correction in the owning Task 2–8
file, then rerun until PASS.

- [ ] **Step 3: Verify the backend query plan**

Against the restored standard test database with realistic seeded group/message
cardinality, run `EXPLAIN (ANALYZE, BUFFERS)` for the batch state query.

Expected: one set-based plan using the group/message lookup index, no repeated
per-group application queries, and no unbounded sequential scan attributable to
the new endpoint. Add an index migration only if this evidence requires it.

- [ ] **Step 4: Add the changelog entry**

Under `NEXT`, add one concise entry beginning:

```text
- [#3727](https://github.com/echoua/echo/issues/3727) ✅ Оперативний, Аналіз:
```

Describe group navigation, independent Duty columns, and unread counters. Add a
deployment marker only if the final migration requires an operation beyond the
normal migration run.

- [ ] **Step 5: Run repository formatting and focused suites**

Run:

```bash
cargo fmt --all -- --check
cargo check -p wdintel-rs
cargo clippy -p wdintel-rs -- -D warnings
cargo test -p wdintel-rs group_feed_state -- --nocapture
cd wdintel-web
npm run format:staged
npm run test:structure-check
npx vitest run \
  src/ts/react/routes/shared/group-navigation/__tests__ \
  src/ts/react/routes/rer-duty-neo/__tests__ \
  src/ts/react/routes/rer-analysis-neo/__tests__
```

Expected: PASS and a clean formatter diff.

- [ ] **Step 6: Run full frontend and affected E2E verification**

Run:

```bash
just test-fe
just build-front
cd wdintel-web
npm exec -- playwright test \
  tests/e2e/group-feed-navigation-duty.spec.ts \
  tests/e2e/group-feed-navigation-analysis.spec.ts \
  tests/e2e/group-feed-unread-state.spec.ts \
  tests/e2e/message-feed-unification.spec.ts \
  tests/e2e/rer-duty-scroll-stability.spec.ts \
  tests/e2e/analysis-neo.spec.ts \
  tests/e2e/manage-message-drawer.spec.ts
```

Expected: PASS.

- [ ] **Step 7: Run catalog-aware migration validation**

Run in one shell:

```bash
source deploy/setup_test_database.sh 3727-groups-list
GITHUB_BASE_REF=main TEST_DB_NAME="$DB_NAME" scripts/ci/check_analytics_migration_catalog.sh
```

Expected: PASS against the restored standard test dump.

- [ ] **Step 8: Run Impeccable UI checks and manual responsive audit**

Run `impeccable lint`, `impeccable audit`, and `impeccable responsive` on the
changed frontend files. Manually verify keyboard focus, Escape/backdrop,
focus restoration, 360 px mobile overlay, multi-column desktop widths, long
group names, empty/error/loading states, and `99+` badges.

Expected: no critical findings; fix material findings and rerun affected tests.

- [ ] **Step 9: Commit the verified feature**

```bash
git add CHANGELOG.md wdintel-web/tests/e2e wdintel-web/tests/e2e/fixture-responses.ts
git commit -m "test(3727): covered group feed navigation"
```

- [ ] **Step 10: Final clean-state check**

Run: `git status --short && git log --oneline --decorate --max-count=12`

Expected: clean worktree with the 3689 merge and small, reviewable 3727 commits.
