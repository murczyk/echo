# Stage 1 status

Run: 20260925T083354Z. Updated: 2026-09-26T07:41:31+00:00.

**Showtime authorized. See [CUTOVER.md](CUTOVER.md) for current guest locations and autostart state. The table below records completed base staging.**

| Guest | Destination | Phase | Stream GiB sent | Updated UTC |
| --- | --- | --- | ---: | --- |
| 128 | pve-hz-3-ziggy | base_verified | 0.71 | 2026-09-25T14:32:00+00:00 |
| 127 | pve-hz-1-ziggy | base_verified | 51.67 | 2026-09-25T14:32:18+00:00 |
| 126 | pve-hz-3-ziggy | base_verified | 41.64 | 2026-09-25T16:24:04+00:00 |
| 129 | pve-hz-1-ziggy | base_verified | 55.98 | 2026-09-25T19:50:04+00:00 |
| 647 | pve-hz-3-ziggy | base_verified | 0.77 | 2026-09-25T14:32:00+00:00 |
| 650 | pve-hz-3-ziggy | base_verified | 1.35 | 2026-09-25T14:32:19+00:00 |
| 421 | pve-hz-3-ziggy | base_verified | 5.62 | 2026-09-25T14:32:40+00:00 |
| 420 | pve-hz-1-ziggy | base_verified | 0.81 | 2026-09-25T14:33:00+00:00 |
| 131 | pve-hz-1-ziggy | base_verified | 55.28 | 2026-09-25T15:54:46+00:00 |
| 405 | pve-hz-3-ziggy | base_verified | 183.62 | 2026-09-26T03:13:47+00:00 |

Stream bytes include retries and exclude CT 420's separate bind-mount copy. A verified base is not an application-consistent final cutover snapshot.
