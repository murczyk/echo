# Government inference gateway

Echo supports `https://inference.ai.mod.gov.ua/v1` with Azure Entra application authentication. Configure it under **Admin → AI → Providers → Державний шлюз ШІ: авторизація Azure** (`/admin/ai/providers`). No new `config.toml` settings are needed.

## Setup and activation

1. Deploy the migration and application. The gateway starts disabled. The `ai_gov_ua_settings` singleton is excluded from analytics replication; deploy the packaged exclusion before migrating, as the deployment recipe does automatically.
2. Enter the provider's Tenant ID, Client ID, resource scope ending in `/.default`, and application secret in the admin dialog. The app needs the provider's application permission and admin consent. The scope is the resource's application ID URI; do not infer it from the inference URL. See [Microsoft's client credentials protocol](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow).
3. Click **Перевірити налаштування** to authenticate and list `/v1/models` using the current form values without saving or enabling the gateway. A blank secret reuses the saved secret; a new secret is used only for this check. Enable and save to activate the credentials. An hourly bearer token is insufficient for unattended operation.
4. Create two AI engines with that Base URL and empty per-engine tokens: `gpt-6-sol` for agents, security review and OCR (`openai_vision`); `gpt-6-luna` for callsigns, positions, settlements, intelligence reports and attachment summaries. Enable only Luna for callsign/report processing and only Sol for OCR.
5. In AI agent settings, allow both engines, choose Sol as default and reviewer, and create a Sol profile with context 65536, output 8192, reserve 16384 and recent messages 8192. Public activity titles prefer an allowed government Luna engine.
6. Enable the relevant background workers in their existing admin settings. Test each workflow with synthetic data before normal processing.

Secrets are encrypted using the server's existing `totp_strongbox_key` with a separate authentication context. Both target servers already have this key. Keep it in the server's existing secret backup: losing or replacing it requires re-entering the Azure secret. API responses expose only whether a secret exists. A blank secret field preserves it; entering a new value rotates it; deletion requires disabling the gateway. Do not put Azure credentials into per-engine tokens or the document extractor.

## Transport and renewal

Every government request reloads the shared settings. Each Echo process caches its bearer token in memory, renews it before expiry, and serializes concurrent renewals. Saving credentials invalidates the cached configuration on the next request without a restart. On an initial upstream 401, Echo renews and retries once; it never replays a stream after delivery begins. Azure failure responses are reported by status without exposing their bodies.

For `gpt-6-sol` and `gpt-6-luna`, Echo replaces `max_tokens` with `max_completion_tokens`, omits `temperature`, and supplies `reasoning_effort: none` with `allowed_openai_params: ["reasoning_effort"]` required by the provider's LiteLLM gateway. Tools, strict JSON schemas, vision content and streaming pass through. Other engine requests keep their existing parameters. Other listed provider models require separate compatibility checks before assignment.

Agent containers receive an Echo capability, never Azure secrets or bearer tokens. Semantic OCR uses the same client through `/internal/ocr/infer`. Document extraction continues to use the existing extractor, Paddle and NuExtract3.

## echo-tsur rollout

The application deployment does not activate Azure or change existing engine assignments. Enter production credentials using the admin dialog, verify models, then configure the engines and worker assignments above.

The shared extractor at `100.93.77.92:8000` and router at `100.105.172.96:8002` were unreachable from echo-tsur during preparation because it is in a different tailnet. Restore the required network access and configure the existing OCR extractor settings before enabling document jobs. The agent dispatcher must also be reachable from echo-tsur. These services do not need government credentials.

Acceptance: synthetic chat, streamed agent tool call, structured extraction/report, attachment summary, image OCR, and a document through the shared extractor. Repeat inference after an access-token lifetime to verify renewal under production Azure permissions. Live credential renewal and the document path cannot be certified until the keys and extractor connectivity are available.

## Recovery

If Azure returns 400/401, check tenant, client, scope, secret expiry and provider consent; 403 from inference may mean missing application permission. Use the model check to distinguish authentication from workflow configuration. Rotation takes effect on the next request. Existing streams may finish with their original credentials.

For rollback, select the previous engines in existing admin settings, restore their worker flags, then disable the government gateway. Keep the additive migration and encrypted settings when rolling back application code. Deleting the secret is optional after disable; it cannot be recovered from the API. Do not down-migrate to roll back a deployment.

Regression coverage: `wdintel-rs/src/ai_engine/client_tests.rs`, `wdintel-rs/src/ai_engine/gov_tests.rs`, and `wdintel-web/src/ts/react/routes/admin-system-settings-neo/__tests__/AiGovUaSettings.spec.tsx`.
