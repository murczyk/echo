# Mattermost notification destinations

Configure AI hooks at `/admin/ai/settings`. Security alerts and dialogue monitoring have independent URL fields and clear controls. Leaving a URL blank preserves the saved value; API responses expose only whether each hook is configured.

| Destination | Trigger and payload |
| --- | --- |
| Security alerts | An asynchronous reviewer flags suspicious agent activity. Sends the user, server, request ID, severity, categorical assessment and audit link. Does not send prompts, responses or tool payloads. |
| Dialogues | When **Надсилати запити ШІ чату до Mattermost** is enabled, sends each user request with provider/model, user, server and audit link. The prompt is capped at 12,288 characters; replies and full transcripts are not forwarded. |
| Devices | A separate hook at `/admin/device-analytics` sends new-device notifications and completed analysis summaries with tagged files. |

Security review requires its security hook; dialogue monitoring requires its dialogue hook. Clearing the dialogue hook disables monitoring and discards pending dialogue notifications without changing security alerts. A security hook cannot be cleared while security review is enabled or security alerts remain unsent.

Deployment copies the existing shared hook into the dialogue field only where monitoring was already enabled. Existing destinations therefore remain unchanged until an administrator assigns separate URLs. Older local AI profiles with enabled monitoring and a shared hook retain that destination on import; new profiles export both fields.

Before rolling application code back to a version with the shared field, disable dialogue monitoring to prevent prompts from reaching the security destination. Keep the additive database column when rolling back code.

Echo must resolve and reach each HTTPS endpoint. A Mattermost host in a different Tailscale tailnet needs a shared node or another established network path. Agent containers do not need the hooks; Echo's background workers deliver notifications.

The workspace's `.env` `MATTERMOST_NOTIFICATION_HOOK` is a separate tooling setting for work-completion notifications. Changing app destinations does not change it.

Regression coverage:

- `wdintel-rs/src/ai_agent/chat_monitoring.rs`: database-backed notification eligibility requires the dialogue destination, without falling back to security.
- `wdintel-rs/src/ai_agent/profile.rs`: profile import preserves independent destinations and older shared-hook profiles.
- `wdintel-web/src/ts/react/routes/admin-ai-agent/__tests__/index.spec.tsx`: independent clear controls preserve the other notification setting.
