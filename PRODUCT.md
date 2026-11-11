<!-- impeccable:product-schema 1 -->
# Echo product context

## Platform

web

## Users

This context covers the main Echo application in `wdintel-web`, with its Elm shell and React surfaces. It does not describe the separate GOI or documentation applications.

Three main user groups are confirmed by the product owner:

- **Contributors:** RER users and people reading Telegram who add raw information to draft groups («групи-чернетки»). Their messages appear on «Оперативний» (Duty) and «Аналіз» (Analysis).
- **Analysts:** people who process and sort those messages, then send important information to curated groups («групи-чистовики»).
- **Readers:** people who consume the information prepared by analysts and cannot create content. Convenient reading and inspection are core outcomes for this group.

For users in the RER role, a primary workflow is reading incoming messages from different groups in multiple columns in real time, mainly on «Оперативний» (Duty). Their goal is to read as many messages as possible across those streams and react as quickly as needed. This workflow includes reading and monitoring, alongside contributing information.

These are product user groups; derive their technical permissions from existing role and server access contracts. Operational and analytical views, administrative views, and device access still depend on roles and server permissions. A visible control is not an authorization boundary. Outside the confirmed RER workflow, relative task priorities, usage frequency, and typical working conditions still need confirmation.

## Product Purpose

Support the handoff from raw information in draft groups, through analysts' processing and selection, to prepared information in curated groups that readers can conveniently consume.

Help each group complete its part of that workflow within its permissions. Preserve enough context to continue work after inspecting an attachment, changing a filter, following a link, or recovering from an error.

On Duty, support RER users' continuous monitoring of multiple message streams and quick reactions. Search and message inspection should preserve awareness of incoming messages and make returning to live reading straightforward.

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

The user groups, draft-to-curated workflow, and RER users' real-time multi-column reading and reaction workflow above are confirmed product-owner context. The following repository sources describe current implementation and behavior:

- [System purpose and development setup](README.md), [architecture](docs/README.md).
- [Duty behavior](docs/frontend/react-behavior-contracts/duty.md) and [creation-time contract](docs/duty/README.md#creation-time-contract).
- [Analysis behavior](docs/frontend/react-behavior-contracts/analysis.md), [message cards](docs/frontend/react-behavior-contracts/message-card.md), and [document previews](docs/frontend/react-behavior-contracts/document-previews.md).
- [Navigation and URL state](docs/frontend/react-behavior-contracts/navigation-and-url-state.md), [API/error handling](docs/frontend/react-behavior-contracts/api-and-error-handling.md), and [remaining behavior contracts](docs/frontend/react-behavior-contracts/README.md).

These sources establish current behavior. They do not constitute user research or a usability benchmark.

## Product Principles

- Optimize for completing a named user task while retaining relevant context.
- Treat read-only consumption as a first-class task alongside contributing and curating information.
- Keep dense information readable and repeated interactions predictable.
- Make loading, failures, permissions, and recovery understandable.
- Prefer established components and behavior to a new interaction pattern for each screen.
- Separate observed evidence, inferred behavior, and proposed improvements.

## Open Questions

- Which additional scenarios within these three user groups should the next UX improvement prioritize?
- Which devices, connection conditions, and accessibility needs should guide those tasks?
- What baseline task-completion evidence should determine whether a future UI change helps?

Confirm these with the product owner and representative users before treating them as settled product requirements.
