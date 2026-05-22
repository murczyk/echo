---
name: backend-frontend-permissions-sync
description: Align backend role checks with frontend visibility, actions, and API access by updating auth helpers, UI gating, and tests together.
---

# Backend-Frontend Permissions Sync

## Short description
Use when access rules must match across backend handlers and frontend UI.

## When to use
- Use for role/permission changes that affect API access, tab visibility, buttons, menus, route guards, or mutation availability.
- Use when the backend already changed and the frontend must mirror the same access model.
- Use when the frontend exposes a feature that can still fail at the backend because of a role mismatch.

## When not to use
- Do not use for pure API shape changes with no access semantics.
- Do not use for UI-only polish that does not depend on permissions.

## Workflow
1. Treat backend authorization as the source of truth.
2. Find every affected backend handler and shared role helper.
3. Find every affected frontend permission helper, route guard, and visible action.
4. Update backend and frontend in the same change when the role matrix changes.
5. Keep legacy and new pages consistent if they share the same access rules.
6. Add or update tests for both the backend check and the frontend visibility/disabled state.
7. If a feature is no longer allowed for a role, hide it in the UI instead of leaving a dead control.

## Rules
- Prefer explicit permission helpers with names that describe the user action or tab, such as `canViewNetworkRelationsTab`.
- Keep duplicated role logic in sync across Rust and Elm helpers when both are used.
- If a frontend feature calls an endpoint, the frontend gate must be at least as strict as the backend endpoint.
- If the backend expands access, update any frontend helper that would otherwise hide the feature from newly allowed users.
- If the backend narrows access, update any frontend helper that would otherwise expose a control that now fails.

## Validation
- Run backend formatting and checks when Rust auth changes: `cargo fmt`, `cargo check`, `cargo clippy`.
- Run frontend build/tests when UI permissions change: `just build-front` and targeted frontend tests.
- Re-open the diff and verify each changed role/permission is reflected on both sides.
