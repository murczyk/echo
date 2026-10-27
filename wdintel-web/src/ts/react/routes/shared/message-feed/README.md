# Shared message feed

Duty and Analysis use this package for their native message scroller, viewport behavior, edge skeletons, and mounted-card navigation. Hosts import the public API from `index.ts`; they retain fetching, pagination, bounded windows, and card actions.

The current behavior and host integration contract are documented in [Message feed implementation](../../../../../../../docs/frontend/message-feed.md). Link resolution and route-specific landing are documented in [Links to Duty and Analysis messages](../../../../../../../docs/frontend/message-links.md).
