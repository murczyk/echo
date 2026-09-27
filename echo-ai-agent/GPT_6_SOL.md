# GPT-6 Sol rollout

This release supports `gpt-6-sol` in the homepage AI chat, using Echo's existing
OpenAI Chat Completions gateway. Both the gateway and runner explicitly disable
reasoning for tool calls. GPT-6 Sol requires `reasoning_effort: "none"` for
function calling on this endpoint; enabling reasoning with tools would require
an independent Responses API migration ([OpenAI model documentation](https://developers.openai.com/api/docs/models/gpt-6-sol)).

## Deployment order

1. Deploy this Echo version, including its normal database migrations, and restart
   the server and background workers. Echo must report required harness
   `2026.09.27.2` before its namespace can be upgraded. An older Echo build without
   the management helper must be deployed first. No new schema migration is
   specific to the model switch; the earlier citation migration is still required.
2. Upgrade the matching agents from this checkout, first on staging:

   ```bash
   just ai-control-panel upgrade --host echo-cbr-staging --release 2026.09.27.2 --dry-run
   just ai-control-panel upgrade --host echo-cbr-staging --release 2026.09.27.2
   ```

   Wait for queued/running requests to finish if preflight reports a busy namespace.
   The panel preserves existing conversations and old containers as backups;
   recovery details are in [CONTROL_PANEL.md](CONTROL_PANEL.md#upgrade-and-recovery).
   Shared preparation retains compatibility with `2026.09.27.1` and existing older
   runners, so unselected production namespaces keep their deployed versions.
3. Configure and validate GPT-6 Sol on that environment as described below.
4. After staging succeeds, deploy the same Echo version to production, then run:

   ```bash
   just ai-control-panel upgrade --host echo-cbr --release 2026.09.27.2 --dry-run
   just ai-control-panel upgrade --host echo-cbr --release 2026.09.27.2
   ```

   Configure and validate the engine separately on production. Agent rollout does
   **not** change model settings or the default engine.

For local development, rebuild the backend, run `just dev-tmux-restart`, wait for
server and workers to start, and use the same upgrade commands with `--host local`.
The restart recipe stops this checkout's workers before starting its tmux session;
it does not stop other checkouts.

## Engine settings (repeat for each environment)

In **ШІ → Провайдери** (`/admin/ai/providers`), add a separate engine:

| Setting | Value |
| --- | --- |
| Name | `OpenAI 6 Sol` |
| Model | `gpt-6-sol` (not `gpt-6.0-sol`) |
| URL | `https://api.openai.com/v1` |
| Token | Existing OpenAI API key, provided its project has access to `gpt-6-sol` |
| Enabled | Yes |

Keep the existing 5.6 Sol engine unchanged for rollback and older conversations.
Do not enable the new engine for unrelated callsign parsing or OCR workloads.
In **ШІ → Налаштування ШІ** (`/admin/ai/settings`), add the new engine to the allowed providers and use these
runtime settings (the UI supplies these defaults for `gpt-6-sol`):

| Setting | Tokens |
| --- | ---: |
| Context window | 1,050,000 |
| Maximum output | 65,536 |
| Compaction reserve | 131,072 |
| Recent context retained | 49,152 |

The output allowance preserves the existing Sol workload limit. The compaction
threshold is 918,928 tokens, below GPT-6 Sol's documented 922,000-token maximum
input, with room for output inside its total context window.

Save the settings, choose the new engine in a **new conversation**, and run a
small read-only query that requires an Echo tool. Verify successful streamed text,
a successful tool call in request monitoring, and source links when the answer
uses individual messages. A connection test only checks agent connectivity; it
does not prove OpenAI model access or tool compatibility.

After validation, select `OpenAI 6 Sol` as the default provider and save. Reload the
homepage or start a new conversation. Existing conversations remain pinned to
5.6 Sol; changing the default does not migrate their history or engine.

## Rollback

Set the default provider back to the existing `OpenAI 5.6 Sol` and start a new
conversation. Keep it allowed/enabled throughout the rollout. The updated Echo and
harness remain compatible with 5.6 Sol, so a model rollback does not require a
binary or container downgrade. Disable the new engine only after its queued and
running requests finish. Leave its record in place to preserve conversation links.
