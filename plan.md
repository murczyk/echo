 1. Add a dedicated activity changelog table, separate from generic object changelogs:
     sigint_activity_decision_changelog.

  2. Store only real state transitions:
     active -> inactive or inactive -> active.
     Skip no-op decisions entirely.

  3. Suggested columns:
     id, target_kind (network/frequency), network_id, network_freq_id, freq, decision (activate/deactivate), actor_kind (user/worker/import/merge/system), actor_login_id, worker_name, reason, old_active_from, old_active_to, new_active_from,
     new_active_to, lookback_since, lookback_till, interception_count, threshold_count, last_interception_at, metadata jsonb, created_at.

  4. Add one helper used by all mutation paths:
     record_activity_decision_if_changed(...).
     It compares old/new active_to; logs only when nullness changes.

  5. Wire manual paths:
     update_network, restore_network, add_network_freq, update_network_freq(_v2), reactivate_network_freq, delete_network_freq.

  6. Wire automatic paths:
     cleanup_networks_worker_1 should log:
     cleanup_frequency_no_recent_interceptions with interception_count = 0, cutoff window, last seen.
     cleanup_network_no_active_frequencies or synthetic inactivity reason for network-level deactivation.

  7. For future auto-reactivation by activity threshold, use reason:
     recent_interceptions_threshold_met, with interception_count, threshold_count, and window.

  8. Add API/read model for network details:
     return recent activity decisions for network and per-frequency rows.

  9. Tests:
     manual activate/deactivate logs once;
     no-op update logs nothing;
     cleanup stale frequency logs deactivation;
     protected do_not_archive no-op logs nothing;
     network deactivation logs separately from frequency deactivation.

  10. Migration:
     pure SQL migration in echo-migration/src, add to lib.rs, then run just migrate-up and just gen-seaorm.
