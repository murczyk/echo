<!-- impeccable:product-schema 1 -->
# Echo product context

## Platform

web

## Users

This context covers the main Echo application in `wdintel-web`, with its Elm shell and React surfaces. It does not describe the separate GOI or documentation applications.

The repository describes an analytical application used to work with incoming messages and related intelligence. Operational and analytical views, administrative views, and device access depend on roles and server permissions. A visible control is not an authorization boundary.

The primary audience, its relative priorities, and typical working conditions still need product-owner confirmation. Role names in code establish available access, not evidence of how frequently people use a feature.

## Product Purpose

Help permitted users find, inspect, connect, and act on relevant messages and their context. Preserve enough context to continue work after inspecting an attachment, changing a filter, following a link, or recovering from an error.

Repository-backed scenarios, without a priority ranking:

- Follow the operational Duty feed and inspect messages and attachments.
- Analyse messages using filters, dates, related entities, and maps.
- Create or edit permitted reports and maintain supporting information.

## Operating Context

The interface is primarily Ukrainian and contains dense, repeated information. It supports light and dark themes, keyboard interaction, and responsive layouts. Existing surfaces mix Elm, React, Bootstrap/legacy styles, and MUI; a change must respect the contract of the affected surface.

Do not assume a desktop-only audience, reliable connectivity, a particular device, or a specific assistive technology. These usage conditions require user evidence. Loading, stale responses, failed requests, and unavailable permissions already have observable behavior that must be preserved.

## Capabilities and Constraints

- **Continuity:** preserve applicable URL/filter state, feed position, selection, and navigation behavior. Duty chronology uses creation time; Analysis time-basis preferences must not change it.
- **Permissions:** retain server-enforced role, group, and device boundaries. Do not reveal restricted content through previews or new controls.
- **Feedback:** communicate API failures in Ukrainian through the surface's established error handling; preserve authentication redirects and the original destination.
- **Compatibility:** existing API shapes and local behavior contracts remain binding until an intentional behavior change is agreed and implemented with appropriate validation.
- **Design:** shared visual decisions belong in `DESIGN.md` and its canonical code sources; this file does not define colors, typography, or layout recipes.
- **Evidence handling:** use synthetic or appropriately redacted examples for external design tools. Repository access alone does not authorize exporting operational content.

## Evidence on Hand

- [System purpose and development setup](README.md), [architecture](docs/README.md).
- [Duty behavior](docs/frontend/react-behavior-contracts/duty.md) and [creation-time contract](docs/duty/README.md#creation-time-contract).
- [Analysis behavior](docs/frontend/react-behavior-contracts/analysis.md), [message cards](docs/frontend/react-behavior-contracts/message-card.md), and [document previews](docs/frontend/react-behavior-contracts/document-previews.md).
- [Navigation and URL state](docs/frontend/react-behavior-contracts/navigation-and-url-state.md), [API/error handling](docs/frontend/react-behavior-contracts/api-and-error-handling.md), and [remaining behavior contracts](docs/frontend/react-behavior-contracts/README.md).

These sources establish current behavior. They do not constitute user research or a usability benchmark.

## Product Principles

- Optimize for completing a named user task while retaining relevant context.
- Keep dense information readable and repeated interactions predictable.
- Make loading, failures, permissions, and recovery understandable.
- Prefer established components and behavior to a new interaction pattern for each screen.
- Separate observed evidence, inferred behavior, and proposed improvements.

## Open Questions

- Who is the primary user group, and what are its three highest-priority tasks?
- Which devices, connection conditions, and accessibility needs should guide those tasks?
- What baseline task-completion evidence should determine whether a future UI change helps?

Confirm these with the product owner and representative users before treating them as settled product requirements.
