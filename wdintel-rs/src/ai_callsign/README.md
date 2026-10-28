# AI callsign processing

The worker enriches parser results using the complete original message and
optional user-feedback refinement. Explicit user overrides remain authoritative.
Normal queued work and reparses use the saved primary and optional fallback.

The **Воркер** tab at `/admin/ai/callsigns` selects **Основний ШІ движок** and
**Резервний ШІ движок**. See [AI queue reliability](../ai_worker/README.md)
for failure, deadline, progress, and deployment semantics.

Queue health is published in `POST /api/monitoring` under `ai.callsign`.
Future queries revealing recurring health conditions must be surfaced there
and in Echo Sergeant, following the [monitoring contract](../server/README.md).
