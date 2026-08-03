# GOI XLSX Recovery

Date: 2026-08-01

## Summary

`echo-gpu-hammer` ran out of space and several GOI containers reported write
failures. A CRC/XML scan covered 191 XLSX files directly under the configured
GOI XLSX directories.

Recovered files:

| Container | File | Recovery | Validation |
| --- | --- | --- | --- |
| `goi-prod-04` | `knowledge.xlsx` | Repacked unchanged ZIP member payloads and recomputed the bad worksheet CRC | 4,659 rows; CRC/XML clean |
| `goi-prod-04` | `knowledge_bkp.xlsx` | Same lossless CRC repair | CRC/XML clean |
| `goi-prod-10` | `knowledge.xlsx` | Repacked unchanged ZIP member payloads and recomputed the bad worksheet CRC | 770 rows; CRC/XML clean |
| `goi-prod-05` | `associations.xlsx` | Used the valid daily workbook as the base and added PostgreSQL-preserved rows absent from it | 8,820 rows; CRC/XML clean |
| `goi-jf` | `associations.xlsx` | Used the valid pre-shrink workbook as the base and added PostgreSQL rows created after that copy | 13,270 recovery rows; CRC/XML clean |

The CRC failures in `goi-prod-04` and `goi-prod-10` were limited to
`xl/worksheets/sheet1.xml`. The decompressed XML was valid and remained
byte-identical through the repair. All available pre-repair ZFS snapshots had
the same corrupt copies, so they were not usable as clean restore sources.

`goi-prod-05` had repeatedly reported a missing XLSX end-of-central-directory
record. The application recreated a small valid workbook after space became
available. Its valid daily backup contained 7,980 rows, while PostgreSQL still
held 8,816 association records. Their union preserved four historical duplicate
file rows and produced 8,820 current rows/keys; the worker and PostgreSQL both
reported 8,820 after restart.

`goi-jf` had the same self-recreated association workbook pattern. Its daily
and hourly copies had already been overwritten by the small post-outage file,
so `associations_backup_preshrink.xlsx` supplied 13,157 valid base rows. The
113 PostgreSQL rows created after that copy produced a 13,270-row recovery
workbook. GOI imported it and normalized/deduplicated it to 13,140 rows, then
resumed normal live additions; the worker repeatedly read 13,141 rows without
errors after the next live write.

The deliberately named `knowledge_bkp_bad.xlsx` files in `goi-jf` and
`goi-jf-next` remain corrupt and unchanged as incident evidence. No other XLSX
under an active GOI XLSX directory failed CRC or XML validation.

## Safety Copies

- `goi-prod-04:/var/backups/goi-xlsx-recovery/20260801T190553Z/`
  - original `knowledge.xlsx` SHA-256:
    `e6b9f8ff884ddb012c59e4ce10ff9a7c5844aec91d7446556777922a6e816445`
  - original `knowledge_bkp.xlsx` has the same hash
  - repaired files SHA-256:
    `d17a170183c4fd54c2f94ba498e9f5a6086ee9eba921773a4d2eefd161517860`
- `goi-prod-10:/var/backups/goi-xlsx-recovery/20260801T190621Z/`
  - original SHA-256:
    `85af7d21ca0c08f2b539bf94b80bcde76403de886944bdf2e7a74f649a3d2729`
  - repaired SHA-256:
    `9f06939bd0e3f0b4cd014fc26ed6d2e78eacad67750d4894aab297486bada0b6`
- `goi-prod-05:/var/backups/goi-xlsx-recovery/20260801T191111Z/`
  - post-outage workbook SHA-256:
    `b9bebd09d0174e9d3aafdce367f54bad9b793f7cae27d6d2c36825fa4ccee699`
  - daily workbook SHA-256:
    `26a5f7dd3752f12ef5f6a43a38129068c91a058d27688e1484ec5f7387bbd7dd`
  - PostgreSQL `association` table dump
  - recovered workbook SHA-256:
    `dfb498f6ebe9bd2935c6d178f2447fc5b02c421225e6a2598467ba8933cd04fa`
- `goi-jf:/var/backups/goi-xlsx-recovery/20260801T192330Z/`
  - post-outage 93-row workbook SHA-256:
    `2827ea34d573eb5c26e32902b0c2789809bb5d0b6b4a7b388f6d6f4eb1c5d1fb`
  - 13,157-row pre-shrink workbook SHA-256:
    `2cad9d2d9f5e8fe9bebdd27f77f975eeefb6377ddc0d1db4777f35bb140f602a`
  - PostgreSQL `association` table dump
  - 13,270-row recovery candidate SHA-256:
    `3e231120916580268b0ba3476f39155b6c67581756635a8781d34cbaf52ede59`

Each application and worker service was stopped for its active-file swap, the
replacement was moved atomically within `/etc/goi/data/xlsx`, and only services
that had been active were restarted.

## Backups

Fresh, forced backups were created and verified through temporary read-only ZFS
clones:

| Container | Verified target snapshot |
| --- | --- |
| `goi-jf` | `snapshot-incusbak_20260801T192645Z` |
| `goi-prod-04` | `snapshot-incusbak_20260801T191545Z` |
| `goi-prod-05` | `snapshot-incusbak_20260801T192704Z` |
| `goi-prod-10` | `snapshot-incusbak_20260801T191645Z` |

The backup job's unrelated fleet blockers were also repaired:

- Renamed the protected `goi-jf` snapshot to
  `manualkeep_incident_20260618T014513Z`. Its incident clone still points to the
  renamed origin. Retention then removed 41 obsolete managed snapshots, and a
  forced `goi-jf` backup completed successfully.
- Reconciled the stale `goi-144ombr/incusbak_20260801T020227Z` Incus record by
  temporarily recreating its missing raw ZFS snapshot and deleting it through
  Incus. The target backup snapshot was preserved.
- Full `incus-zfs-backup-preflight` completed with exit code 0 for every
  configured GOI container.
- Each checked target now has three managed snapshots; `goi-jf` additionally
  retains its one manual incident snapshot.
- `echo-incus-zfs-backup.timer` is enabled and active, and the stale failed
  service state was reset after successful targeted backup validation.

Final storage state was healthy: `rpool` was 81% allocated with 171 GB free,
and `hdd0` was 12% allocated with 19.0 TB free.

## Recurrence on 2026-08-02

The host ran out of space again. Host and container logs showed `ENOSPC`, and
the GOI association worker reported invalid ZIP end-of-central-directory
errors in three containers:

| Container | Invalid-ZIP window (Europe/Kyiv) | Result |
| --- | --- | --- |
| `goi-159ombr` | 10:52-10:59 | The application recovered the complete workbook from retained state; no restore was needed |
| `goi-jf` | 07:40-11:11 | The application replaced the 13,242-row workbook with an empty workbook; restored below |
| `goi-prod-05` | 08:03-08:18 | The application recovered the complete workbook from retained state; no restore was needed |

A fresh CRC/XML scan checked all 191 top-level XLSX files in the active GOI
directories. Every current file was structurally clean except the deliberately
preserved `knowledge_bkp_bad.xlsx` evidence files in `goi-jf` and
`goi-jf-next`.

Structural validity alone was not enough to find this incident. The recreated
`goi-jf` workbook was a valid XLSX, but its worker row count restarted at one
and only reached 100 before recovery. The latest pre-incident source snapshot
contained 13,171 rows, and the live `associations_backup_preshrink.xlsx`
contained 13,242 clean rows. The GOI log recorded the exact transition:

```text
[associations][backup] live file shrank to 0b from 26736150b — kept the pre-shrink copy at associations_backup_preshrink.xlsx
```

PostgreSQL retained 108 unique `association` records created at or after the
shrink time, `2026-08-02 08:11:42 UTC`. The recovery candidate therefore used
the 13,242-row pre-shrink workbook as its base and appended the exact serialized
cell values from those 108 database records. The resulting 13,350-row workbook
had SHA-256
`ae9843151654772ea6c0e2b0c0d8dffdf9c87c756e1bc57971d4132fbb4e5774`.
ZIP CRC, worksheet XML, and `openpyxl` validation passed. After the atomic
replacement, `goi-echo-worker` read all 13,350 rows and all previously active
services returned to `active`. GOI then normalized/deduplicated the workbook to
13,046 live rows, and normal additions resumed at 13,047 rows without errors.

No replacement was made in the two containers that recovered themselves:

- `goi-159ombr` progressed from 914 rows in the 04:33 Kyiv source snapshot to
  943 live rows after the event.
- `goi-prod-05` progressed from 8,847 rows in the same snapshot to 8,940 live
  rows after the event.

Both workbooks continued receiving new rows, remained CRC/XML clean, and were
consistent with their append-only PostgreSQL history.

### 2026-08-02 safety copies

`goi-jf:/var/backups/goi-xlsx-recovery/20260802T124521Z/` contains:

- the 100-row post-outage live workbook;
- the clean 13,242-row pre-shrink base;
- a custom-format dump of the PostgreSQL `association` table;
- the 108 post-shrink database rows as JSONL;
- the installed 13,350-row recovery candidate;
- pre-recovery and recovered SHA-256 manifests; and
- the list of services that were active before the maintenance window.

The writers stopped for the swap were `goi.service`,
`goi-echo-worker.service`, `echo-swapp.service`, `swapp.service`, and
`swapp-alt.service`. The last two were found by checking the cgroups of
orphan-looking `next-server` processes; checking only the three familiar units
would not have stopped every possible writer.

### Backup-chain repair

The scheduled 2026-08-02 backup successfully processed the other GOI
containers but failed on `goi-144ombr`. The target still had three managed
snapshots, while the source had no common snapshot after the previous day's
Incus metadata reconciliation. The backup tool correctly refused to overwrite
the existing target with a full receive.

The old 143 GB target, including all three snapshots, was preserved without
deletion by renaming it to:

```text
hdd0/manual-keep/echo-gpu-hammer/default/goi-144ombr-prechain-20260802T125033Z
```

The canonical target name then passed targeted preflight as a new chain, and a
forced full backup completed from source snapshot
`snapshot-incusbak_20260802T125051Z`. The matching target snapshot was present,
targeted preflight passed, and the new target occupied 69.2 GB for 260 GB of
logical data at 3.80x compression. Run backup commands as the unprivileged
`echo` user, matching the systemd unit; running preflight under `sudo` uses the
wrong SSH known-hosts file and fails host-key verification.

A forced incremental backup of restored `goi-jf` then created matching source
and target snapshot `snapshot-incusbak_20260802T131749Z`. A temporary read-only
clone of the target snapshot contained a CRC/XML-clean 13,062-row live
workbook. Full fleet preflight subsequently passed for all 27 configured GOI
containers.

The post-recovery fleet scan covered 200 current top-level XLSX files and found
zero unexpected CRC or XML failures. The only failures were the same two
intentional `knowledge_bkp_bad.xlsx` evidence files. At the final live check,
the normalized `goi-jf` workbook had advanced to 13,065 rows, PostgreSQL held
94,033 unique association records, every previously active service was active,
and the worker had logged zero new invalid-ZIP errors since the swap.

At the start of recovery, both pools were ONLINE: `rpool` had about 260 GB free
and `hdd0` had about 17 TB free. Managed GOI source snapshots accounted for
about 32 GB, so snapshot retention alone does not explain the transient pool
exhaustion. The immediate corruption mechanism is confirmed as failed XLSX
writes during `ENOSPC`; the workload that temporarily consumed the remaining
pool space is not yet proven.

Final pool state was healthy: `rpool` was 72% allocated with 250 GB free, and
`hdd0` was 23% allocated with 16.8 TB free. The failed scheduled service state
was reset after successful manual verification; `echo-incus-zfs-backup.timer`
remained enabled and active for the next scheduled run. Temporary local,
remote-host, and read-only-clone working copies were removed. The timestamped
container rollback set and the preserved old `goi-144ombr` target remain.

## Recurrence on 2026-08-03

`goi-jf` lost its active association workbook for a third time. Before repair,
the structurally valid replacement had only 105 XML rows and the worker read
104 data rows. The worker log contained 1,092 invalid-ZIP/end-of-central-
directory errors during the incident window. The same five writers as on
2026-08-02 were stopped and their active-state list was preserved before the
swap.

The clean `associations_backup_daily.xlsx` from 2026-08-02 22:00 Kyiv supplied
13,210 base rows. PostgreSQL preserved 308 unique association rows created
after that file's mtime. Appending their serialized cell values with
`openpyxl` produced a 13,518-row recovery candidate with SHA-256
`aacc3ee73495224f5e730df38d1927fac791fc9099de37c70feb680467180b3e`.
ZIP CRC, worksheet XML, and `openpyxl` validation all passed. The worker read
all 13,518 rows immediately after the atomic replacement. GOI subsequently
normalized the workbook to 13,205 rows; it had progressed to 13,208 during the
final fleet scan without another invalid-ZIP error.

The complete rollback set is retained at:

```text
goi-jf:/var/backups/goi-xlsx-recovery/20260803T085624Z/
```

It contains the 105-row post-outage workbook, daily/hourly/pre-shrink/monthly
copies, a full PostgreSQL association dump, the 308 selected database rows as
JSON, hashes, the recovery candidate, and the pre-maintenance service list.

No other live workbook required restoration. `goi-159ombr`,
`goi-prod-05`, and `goi-475oshb` had transient errors or suspicious row-count
differences but were structurally clean and continued progressing from their
latest snapshots. The apparent `goi-475oshb` knowledge reduction matched
26,998 intentional database deletions and 2,651 active rows; its readonly
frequency workbook is derived from that state. The small `goi-prod-05`
`inbox.xlsx` is a drained queue, not a lost append-only workbook. The final
fleet scan checked 182 current top-level XLSX files. Its only two failures were
the intentionally retained `knowledge_bkp_bad.xlsx` evidence files in
`goi-jf` and `goi-jf-next`.

### Space-consumer diagnosis and prevention

The previous free-space operation had finished: no cleanup or ZFS-send process
was still running and both pools reported `freeing=0`. Space appeared not to
stay free because `goi-144ombr` continuously recreated JNI extraction files
under `/tmp`:

- 101 `libsignal*` directories in that container accounted for 17.64 GB of
  logical data, with a new approximately 175 MB logical extraction appearing
  about every 20 seconds;
- 6,486 `sqlite-3.53.1.0-*-libsqlitejdbc.so` files accounted for another
  7.08 GB of logical data; and
- the existing `cleanup-libsignal-tmp` timer ignored the SQLite files and its
  original five-minute cadence/ten-minute age threshold allowed a large steady
  working set.

The cleanup unit was tightened to run every minute, delete only matching
top-level files/directories older than one minute, and cover both the
`libsignal*` directories and the precise SQLite JNI filename patterns. Original
and intermediate units are retained under
`goi-144ombr:/var/backups/goi-space-fix/20260803T090543Z/` and
`goi-144ombr:/var/backups/goi-space-fix/20260803T090737Z/`. After the final
rule ran, SQLite JNI files fell from 6,486 to 8 and `/tmp` fell from about
5.8 GB to 610 MB. The timer remained enabled and active.

The scheduled backup began at 05:57 Kyiv, reached an incremental send of
`goi-144ombr`, and was still running when the host rebooted at 07:17. Later
space cleanup removed its source snapshots, leaving two stale Incus snapshot
records and no common snapshot with the canonical target. Both records were
reconciled safely by temporarily recreating their raw ZFS snapshots and then
deleting them through Incus. The old 69.2 GB target and its restore point were
preserved without deletion as:

```text
hdd0/manual-keep/echo-gpu-hammer/default/goi-144ombr-preleakfix-20260803T091001Z
```

A new full `goi-144ombr` chain was created at matching source/target snapshot
`snapshot-incusbak_20260803T091022Z`; its target used 9.90 GB. The repaired
`goi-jf` then received matching source/target snapshot
`snapshot-incusbak_20260803T091213Z`. A temporary read-only clone contained a
CRC/XML-clean 13,205-row workbook. Full preflight passed for all 26 configured
GOI containers.

At final verification, the live workbook had reached 13,210 rows, all five
`goi-jf` writers were active,
`cleanup-libsignal-tmp.timer` and `echo-incus-zfs-backup.timer` were enabled and
active, and neither pool had pending freeing work. `rpool` was 60% allocated
with 359 GB free; `hdd0` was 14% allocated with 18.7 TB free. Both pools were
ONLINE.

## Repeatable recovery procedure

1. Confirm `rpool` and the backup pool are ONLINE and have safe headroom with
   `zpool list`, `zpool status`, `zfs list`, and `df`. Do not start workbook
   repair while the pool is still full.
2. Check `echo-incus-zfs-backup.service`, its timer, recent journal, and
   `incus-zfs-backup-preflight`. A current source snapshot is useful even when
   the scheduled target receive failed later in the run.
3. Enumerate every `goi*` container. Test every active top-level XLSX with
   `ZipFile.testzip()` and parse each ZIP XML member. Do not treat the known
   `knowledge_bkp_bad.xlsx` evidence files as new failures.
4. Search `goi.service` and `goi-echo-worker.service` logs for `ENOSPC`, bad CRC,
   and invalid ZIP/EOCD errors. Compare worker row counts before and after the
   error. A tiny but valid workbook is a corruption symptom.
5. Compare the current workbook with daily, hourly, pre-shrink, monthly, and
   read-only copies. Also inspect the newest pre-incident ZFS source and target
   snapshots. Prefer the newest clean copy with a row progression consistent
   with the logs.
6. Compare candidate bases with the PostgreSQL `association` table. For a
   pre-shrink base, preserve database rows created after the base mtime. Do not
   union the complete database into containers with monthly archives because
   the table is append-only history, not only the active workbook.
7. Stop every writer and verify process cgroups. Preserve the post-outage file,
   selected base, a PostgreSQL table dump, and hashes under a timestamped
   `/var/backups/goi-xlsx-recovery/` directory before changing the active file.
8. Build the candidate with `openpyxl`, retaining the base workbook's sheet and
   cell layout and appending database `row.cells` values in creation order. If
   GOI wrote `Invalid Date` into `docProps/core.xml`, repair those metadata
   values only in the working copy before loading it with `openpyxl`.
9. Validate ZIP CRC, every XML member, workbook loading, meaningful row count,
   and SHA-256. Copy the candidate onto the same filesystem, set owner and mode
   from the active file, then replace it with an atomic `mv`.
10. Start the worker first and confirm its exact parsed row count. Start only
    services recorded as previously active, then watch for GOI normalization,
    new invalid-ZIP errors, or another unexpected shrink.
11. Force a targeted ZFS backup, verify source/target snapshot agreement, and
    inspect the XLSX through a temporary read-only clone. Finish with full fleet
    preflight and confirm the timer is enabled and active.
12. On `goi-144ombr`, check both `libsignal*` directories and
    `sqlite-*-libsqlitejdbc.so` files in `/tmp`, plus snapshot-pinned space. A
    small current directory does not prove the leak is harmless if an older
    source snapshot still pins deleted generations. Confirm the one-minute
    `cleanup-libsignal-tmp.timer` is active and that the file counts remain in a
    short rolling window.

For a CRC-only failure where the decompressed XML is valid, repacking the ZIP
members can repair the central-directory CRC without changing worksheet XML.
For a self-recreated/truncated workbook, repacking is insufficient; recover
from a clean workbook plus the PostgreSQL delta as described above.
