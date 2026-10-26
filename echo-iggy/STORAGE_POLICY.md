# Iggy disk and age retention (#3835)

`echo-iggy-storage-policy.timer` runs once per minute after the preceding run
finishes. Its job enforces both limits across **all local streams and topics**:

- 100 GB (`100000000000` bytes, approximately 93.13 GiB) of allocated topic data.
- 30 days, measured by the newest Iggy message timestamp in each sealed segment.

Allocated bytes come from `stat.st_blocks * 512`, including message logs,
indexes, consumer-offset files, and their directories. This accounts for filesystem compression;
Iggy's `max_topic_size` counts logical bytes per topic and cannot express this
global disk budget. Filesystem snapshots, backups, and server diagnostic logs
are outside the topic-data budget.

## How cleanup works

The job inventories local segment files and matches every partition against
the local HTTP API before changing anything. The API's `/stats` process must
hold an open file from the same storage directory, verified through Linux
`/proc/<pid>/fd`. Run the job in the server's process/filesystem namespace;
a copied data directory and matching numeric IDs are insufficient. It reads
the first and last 16-byte index records instead of scanning message payloads. Every partition's
last segment is protected; Iggy seals preceding segments during normal rotation
(1 GiB logical segments in the current configuration). No files are unlinked
by the script, and there is no forced rotation or topic purge.

Expired sealed segments are deleted first. When the total still exceeds the
budget, the oldest remaining sealed segments across partitions are deleted.
Each request uses Iggy's delete-oldest-segment API with `segments_count=1`;
the job verifies that the expected log and index disappeared. It preserves
partition offsets and checks the sealed files' identities and the native
cleaner state again before deletion. Changed files abort cleanup. It reads
the total again afterward. Each run is bounded to 1,000 deletions and a
ten-minute service timeout. A partially completed run
is safe to retry: committed deletions stay committed, and the next run
inventories the remaining files again.

The policy is a cleanup target, not a filesystem quota. Active segments are
never deleted, ingestion continues between checks, and allocated block counts
can lag recent writes on ZFS. The job fails visibly if it cannot reach the
target; it does not claim success while still over budget. Future segment
formats with a different index layout must be validated before upgrading Iggy.

### Consumer barriers

Iggy protects segments whose end offset is ahead of a stored consumer or
consumer-group offset. The job stops with `Segment deletion was blocked`,
listing blocking stored consumer/group IDs and offsets. It does not advance
offsets, remove consumers, skip to newer segments, or bypass the server by
deleting files. A stalled consumer can therefore prevent both limits from
being reached.

Inspect individual and group offsets and determine whether they represent
needed backlog before enabling cleanup. Catch-up, consumer removal, and offset
advancement are separate operations requiring explicit approval for the named
host and consumers.

## Preventing policy resets

The physical disk budget lives in the packaged maintenance job, outside
Iggy's mutable topic settings. Every run checks every topic's expiry, including
topics no longer registered with an Echo integration. A drifted expiry is
logged and restored to 30 days through an explicit read-modify-write request.
The request preserves the topic name, compression, replication, and logical
size limit. It re-reads each topic just before updating it, rejects a replaced
topic or changed partition inventory, and reads the settings back before
permitting deletion. Repeated runs make no topic update when the expiry is
already correct.

Echo's integration setup and reconciliation command also send the explicit
30-day expiry and preserve existing logical size limits. Other administration
clients must send complete settings when updating topics; constructing updates
with default expiry values can reset it to `NeverExpire`. Unknown
writers cannot be prevented from changing settings, but the timer detects and
repairs that drift on its next run.

Iggy's full-settings update API has no compare-and-swap operation. Serialize
integration edits, the reconciliation command, administrative topic updates,
and the maintenance job. Fresh reads narrow the race but cannot eliminate a
concurrent write between GET and PUT. Stopping/restarting the maintenance
timer to establish this window requires approval naming that host.

Iggy's native cleaner **must remain disabled** in the effective runtime config:

```toml
[data_maintenance.messages]
cleaner_enabled = false
```

The maintenance job owns both age and disk cleanup. Concurrent native cleanup
or manual segment deletion could invalidate a delete-by-count plan. The job
refuses to run when the effective native cleaner is enabled. Do not run other
segment deletion tools concurrently. A single-host lock prevents overlapping
maintenance invocations.
The service preserves its runtime lock directory between runs; manual apply
invocations must use the same lock file as the service.

## Approved rollout

Installation, topic updates, service changes, and deletion require approval
naming the target and operations. Package installation ships the job and units
but does not enable the timer. Prepare the following before requesting that
approval:

1. Inventory the target's actual streams directory, local HTTP listener,
   effective native cleaner state, topic settings, and consumer offsets.
   `/etc/iggy/root.env` must contain `IGGY_ROOT_USERNAME` and
   `IGGY_ROOT_PASSWORD` for an account allowed to manage the topics and delete
   segments, and to read `/stats`. Keep this file mode `0600`; credentials are
   never printed.
2. Build the updated `echo-iggy` package using the approved server binary.
   The package declares `python3` and `python3-toml` dependencies. Avoid
   rebuilding/upgrading Iggy itself just to install this policy. The existing
   package maintainer scripts restart `echo-iggy`; approval must cover this
   restart even when the binary is unchanged.
   The packaged server unit sets `LimitNOFILE=1048576`; verify any local
   drop-in does not retain the 1,024-descriptor limit that can prevent a
   large existing store from opening after restart.
3. Include any required native-cleaner configuration change/restart, the
   exact deletion scope, and any separately reviewed consumer repair in the
   approval request. Keep the native cleaner disabled in the authoritative
   `iggy-config-<server>` configuration note as well as on disk.

After those operations are approved, install the package on that host and
reload systemd. Run the default dry run with the existing root credentials
loaded into the process environment:

```sh
sudo systemctl daemon-reload
sudo sh -c 'set -a; . /etc/iggy/root.env; exec python3 /usr/local/lib/echo-iggy/storage_policy.py'
```

The dry run authenticates and reads data; it issues no topic updates or
deletions and creates no lock file. Its JSON output reports drift, current
allocated bytes, proposed deletion count, and projected bytes. Each `candidate`
identifies its segment path, partition, end offset/timestamp, age/budget reason,
and stored consumer barriers. `scheduled` identifies this run's bounded batch;
`projected_bytes` assumes the full plan completes, while
`batch_projected_bytes` covers only that batch. Consumer progress and concurrent
ingestion can change the result. Review this concrete plan and consumer
barriers before authorizing actual deletion.
Under approval covering that plan, start one job and inspect it before
enabling recurrence:

```sh
sudo systemctl start echo-iggy-storage-policy.service
sudo journalctl -u echo-iggy-storage-policy.service --no-pager -n 100
sudo systemctl status echo-iggy-storage-policy.service --no-pager
sudo systemctl enable --now echo-iggy-storage-policy.timer
```

Require a successful `result` with no pending segments and allocated bytes
at or below `100000000000`. Check retained recent messages, unchanged topic
settings other than expiry, consumer progress, and available disk space.
Watch failed service runs and `retention_drift` events; a running timer alone
does not establish that cleanup succeeds. Large initial cleanup can require
multiple bounded runs. ZFS snapshots may delay filesystem free-space recovery.

The service defaults to `/etc/iggy/data/local_data/streams` and
`http://127.0.0.1:3000`. For another layout, prepare a reviewed systemd
`ExecStart` override using `--data-path` and `--url`. The API must be loopback
and serve exactly the local partition inventory. `--max-bytes` and
`--max-deletions` are explicit disk-budget and batch-size overrides. The
30-day expiry stays aligned with Echo's integration reconciliation.

Stopping/disabling the timer and stopping an in-progress job require approval
for that host. Stopping can interrupt an API request whose server-side change
has already committed; inspect the files and topic settings before retrying.
Already deleted segments cannot be recovered by disabling the job or rolling
back code.
After errors, inspect committed progress before proposing a narrower retry.

## Local verification

Run the regression and destructive-data safeguards with Python 3.11+, or
Python 3.10 with `toml` available:

```sh
python3 echo-iggy/deploy/test_storage_policy.py -v
IGGY_TEST_BINARY=/absolute/path/to/iggy-server python3 echo-iggy/deploy/test_storage_policy_live.py -v
```

The live tests start isolated local servers and temporary storage; they never
connect to a real environment. They cover physical cleanup across two topics,
active-segment and offset preservation, retention drift, restart persistence,
and consumer barriers. The policy accepts `server 0.8.1-edge.1` (the local live
fixture binary) and `server 0.8.2-edge.1` (the repository's pinned
[`iggy-0.10.3-edge.3` source](https://github.com/apache/iggy/tree/iggy-0.10.3-edge.3/core/server)).
Other versions fail before mutation. Source compatibility review does not
replace a live run: test the exact approved binary before installation and
repeat these tests for every binary upgrade. Do not change the repository's
pinned server revision merely to obtain a policy test binary.
