# Stage 2 review suggestions

Review scope: branch `2731-echo-int` against `5c00831ff4e849a930568a7044eda702d8f0d89d`, including current uncommitted changes and `echo-gpu-client` revision `03e6ae16f3d9a0043a307ced8404ce6f64971e4d`.

- [x] S1. Update the pinned `echo-gpu-client` revision. The branch still used `5a3a57b`, so it missed claimed-GPU persistence across reloads, retryable reloads, preferred-GPU refresh before upload, and immediate checksum-hit completion. Updated to `03e6ae1`.
- [ ] S2. Delete superseded/deleted media queue entries even while automatic transcription is disabled. `media_queue::reconcile` currently returns before deletion, allowing stale completed transcripts to survive and reappear when the feature is enabled again.
- [ ] S3. Preserve successful configuration mutations when post-commit refresh or restart initiation fails. A client-cache reload error currently turns a committed create/update/delete into a generic request failure, inviting unsafe retries instead of returning the documented partial-success result.
- [ ] S4. Reuse the operator's direct `systemctl` approach and verify that the restart request was accepted. The current code invokes `sudo systemctl` from a root service and reports success immediately after spawning it, even if `systemctl` exits with an error.
- [ ] S5. Reuse the operator's instance-form defaults and ordering behavior. Echo currently invents ports `8080`/`8000` and resets every new instance to ordering `1`; the operator uses Rust port `3001`, Python port `3000`, and `max(ordering) + 1`.
- [ ] S6. Disable all instance mutation controls while a request is in flight. Edit, activation, and delete remain usable during another mutation or health check, permitting overlapping requests and stale UI state.
- [ ] S7. Reject semantically invalid `--since-ts` values before invoking the backfill binary. The recipe checks only the timestamp shape, so impossible dates such as `2026-99-99T99:99:99` pass validation.
- [ ] S8. Require an explicit deployment branch for `deploy-transcriber-stg`. It currently inherits the global `main` default, so invoking the Stage 2 deploy recipe without an argument can deploy the wrong revision.
- [ ] S9. Make staging smoke checks assert their expected results. Several checks only print SQL output, and the journal pipeline can succeed through `tail` even when no queue metric was found.
- [x] S10. Verify the `pg_uuidv7` deployment prerequisite instead of adding a second installer. Echo already reuses `echo-install-utils setup-postgresql --install-pg-uuidv7` in `deploy/server.md`; the migration and staging smoke check now fail clearly if the extension is unavailable.
- [ ] S11. Add focused backend regression coverage for disabled cleanup and post-commit partial-success behavior; the current transcriber tests do not exercise either failure mode.
- [ ] S12. Do not gate the explicit legacy backfill on `enable_audio_transcription`. The roadmap gates automatic enqueue and worker execution, while the explicit one-off must remain usable for dry runs and safe pre-enablement queue preparation.
- [ ] S13. Leave systemd enough time to observe the application's 120-second drain timeout. `TimeoutStopSec=120s` currently expires at the same instant as the internal grace period and can force-kill the process before the timeout path finishes.
- [ ] S14. Expand focused boundary coverage for backfill outcome categories, semantically invalid timestamps, non-audio media, safe extension selection, and the Echo worker policy constants.
