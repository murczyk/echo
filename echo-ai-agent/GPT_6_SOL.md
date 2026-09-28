# GPT-6 Sol and Luna rollout

This release supports `gpt-6-sol` and `gpt-6-luna` in the homepage AI chat, using Echo's existing
OpenAI Chat Completions gateway. Both the gateway and runner explicitly disable
reasoning for tool calls. Both models require `reasoning_effort: "none"` for
function calling on this endpoint; enabling reasoning with tools would require
an independent Responses API migration ([Sol documentation](https://developers.openai.com/api/docs/models/gpt-6-sol),
[Luna documentation](https://developers.openai.com/api/docs/models/gpt-6-luna)).

## Deployment order

1. Deploy this Echo version, including its normal database migrations, and restart
   the server and background workers. Echo must report required harness
   `2026.09.27.3` before its namespace can be upgraded. An older Echo build without
   the management helper must be deployed first. No new schema migration is
   specific to the model switch; the earlier citation migration is still required.
2. Upgrade the matching agents from this checkout, first on staging:

   ```bash
   just ai-control-panel upgrade --host echo-cbr-staging --release 2026.09.27.3 --dry-run
   just ai-control-panel upgrade --host echo-cbr-staging --release 2026.09.27.3
   ```

   Wait for queued/running requests to finish if preflight reports a busy namespace.
   The panel preserves existing conversations and old containers as backups;
   recovery details are in [CONTROL_PANEL.md](CONTROL_PANEL.md#upgrade-and-recovery).
   Shared preparation retains compatibility with `2026.09.27.2`, `2026.09.27.1` and existing older
   runners, so unselected production namespaces keep their deployed versions.
3. Configure and validate GPT-6 Sol and Luna on that environment as described below.
4. After staging succeeds, deploy the same Echo version to production, then run:

   ```bash
   just ai-control-panel upgrade --host echo-cbr --release 2026.09.27.3 --dry-run
   just ai-control-panel upgrade --host echo-cbr --release 2026.09.27.3
   ```

   Configure and validate both engines separately on production. Agent rollout does
   **not** change model settings or the default engine.

For local development, rebuild the backend, run `just dev-tmux-restart`, wait for
server and workers to start, and use the same upgrade commands with `--host local`.
The restart recipe stops this checkout's workers before starting its tmux session;
it does not stop other checkouts.

## Engine settings (repeat for each environment)

In **ШІ → Провайдери** (`/admin/ai/providers`), add two separate engines:

| Setting | Sol | Luna |
| --- | --- | --- |
| Name | `OpenAI 6 Sol` | `OpenAI 6 Luna` |
| Model | `gpt-6-sol` | `gpt-6-luna` |
| URL | `https://api.openai.com/v1` | `https://api.openai.com/v1` |
| Token | Existing Sol API key with model access | Existing Luna API key with model access |
| Enabled | Yes | Yes |

Use the exact model IDs above, without `6.0`. Keep the existing 5.6 Sol and Luna
engines unchanged for rollback and older conversations. Do not enable the new
engines for unrelated callsign parsing or OCR workloads.
In **ШІ → Налаштування ШІ** (`/admin/ai/settings`), add both new engines to the allowed providers and use these
runtime settings (the UI supplies these defaults):

| Setting | Sol tokens | Luna tokens |
| --- | ---: | ---: |
| Context window | 1,050,000 | 1,050,000 |
| Maximum output | 65,536 | 32,768 |
| Compaction reserve | 131,072 | 131,072 |
| Recent context retained | 49,152 | 32,768 |

The output allowances preserve each engine's existing workload limit. The
compaction threshold is 918,928 tokens for both models, below their documented
922,000-token maximum input, with room for output inside the total context window.

Save the settings, choose each new engine in a separate **new conversation**, and run a
small read-only query that requires an Echo tool. Verify successful streamed text,
a successful tool call in request monitoring, and source links when the answer
uses individual messages. A connection test only checks agent connectivity; it
does not prove OpenAI model access or tool compatibility.

After validation, select `OpenAI 6 Sol` as the default provider and save. Reload the
homepage or start a new conversation. Existing conversations remain pinned to
their original engine; changing the default does not migrate their history or engine.
Luna remains available in the provider picker for focused tasks. Adding Luna does
not change the Sol default or the separately configured security-review engine.

## Rollback

Set the default provider back to the existing `OpenAI 5.6 Sol`, or select
`OpenAI 5.6 Luna` when rolling back a Luna conversation, and start a new conversation.
Keep each old engine enabled and allowed wherever it was previously used. The
updated Echo and harness remain compatible with both 5.6 engines, so a model
rollback does not require a binary or container downgrade. Disable a new engine
only after its queued and running requests finish. Leave its record in place to
preserve conversation links.
