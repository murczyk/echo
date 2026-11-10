# echo-media

Sandboxed ffmpeg and ffprobe jobs for Echo. It addresses G1, I2 and I3 in
[media-security-audit-checklist.md](../docs/media-security-audit-checklist.md)
and limits the damage of G2 (services running as root) for the processes it
starts.

Messenger and Device thumbnails (through `wdintel-rs/src/thumbnail.rs`), the
transcription audio probe, the messenger playback copy and the messenger HLS
preview use it. The other ffmpeg call sites are not wired
yet; see [Wiring](#wiring).

## Threat model

Every byte ffmpeg reads comes from a remote sender, and decoding starts with no
user action. Assume a hostile file can:

- name other files or URLs for ffmpeg to open, for example through HLS
  playlists, concat lists or `subfile:` names;
- run code in the decoder through a memory-safety bug;
- exhaust CPU, disk or time.

The process runs as root and can read `/etc/echo/config.toml`, the StrongBox key
and the S3 credentials, so a single file read or a code-execution bug is a full
compromise.

## Layers

Each layer works on its own. `tests/hostile.rs` checks the whitelists and the
sandbox separately.

1. **ffmpeg allowlists** (`ffmpeg/args.rs`). Every input gets
   `-protocol_whitelist` and `-format_whitelist`:
   - Local inputs use `file`. Remote inputs use `https,tls,tcp` or `http,tcp`,
     chosen by the URL scheme. `RemoteUrl::new` accepts only `http` and
     `https` URLs whose origin (scheme, host and port) is on the caller's
     allowlist, such as `https://s3.example.com` or `http://127.0.0.1:9000`.
   - Local paths are passed as `file:<absolute path>`.
   - `hls`, `concat`, `lavfi`, `dash` and the RTP family can never be
     whitelisted (`Formats::custom` refuses them).
2. **Process hygiene** (`sandbox/mod.rs`, `process.rs`):
   - `MediaConfig::from_path()` finds `ffmpeg` and `ffprobe` on `PATH` once
     (skipping relative entries) and stores canonical absolute paths. Jobs
     always run those paths, so a later `PATH` change cannot swap the
     binary. The service's `PATH` must be trusted (checklist I3).
     `Ffmpeg::shared()` keeps one such instance per process; a failed lookup
     is retried on the next call;
   - the environment is cleared, keeping only `LC_ALL=C` and
     `AV_LOG_FORCE_NOCOLOR=1`;
   - the working directory is `/` and stdin is `/dev/null`;
   - each child gets a new session. A timeout or a dropped `Running` kills the
     whole process group;
   - stderr is captured in full, with control characters replaced and remote
     URLs redacted. stdout is captured in full when a job reads it.
3. **Child sandbox** (`sandbox/child.rs`, Linux-only steps in
   `sandbox/linux.rs`). It runs between `fork` and `exec`, using only
   async-signal-safe syscalls:
   - `PR_SET_PDEATHSIG(SIGKILL)`, and `SIGXFSZ` reset to its default action;
   - `unshare(CLONE_NEWNET | CLONE_NEWIPC)` for offline jobs, when the parent has
     `CAP_SYS_ADMIN` (root in production);
   - `RLIMIT_FSIZE` (a job's output cap, enforced by the kernel) and
     `RLIMIT_CORE=0`. Time is bounded by each job's wall-clock timeout. There
     are no CPU, open-file or address-space limits; the service cgroup bounds
     memory;
   - every capability is dropped: the bounding set, the ambient set and `capset`
     to empty. When root, securebits are also locked, so `exec` cannot restore
     them;
   - `PR_SET_NO_NEW_PRIVS`;
   - Landlock (`sandbox/landlock.rs`):
     - the child can read `/usr`, `/lib*`, `ld.so.cache`, `/dev/null`,
       `/dev/urandom` and `/sys/devices/system/cpu`;
     - it can execute only the listed binary and the common dynamic loader
       paths (`ECHO_MEDIA_SANDBOX_DYNAMIC_LOADERS`; missing ones are skipped);
     - it can read its input file, and write only in a private job directory;
     - network jobs can also read the resolver files and `/etc/ssl`;
     - ABI 1 (Linux 5.13, Ubuntu 22.04) is required in `Enforce` mode;
     - TCP rules (ABI 4) and signal/abstract-socket scoping (ABI 6) apply when
       the kernel has them.
4. **Output staging** (`ffmpeg/output.rs`):
   - ffmpeg writes into a fresh `0700` directory next to the target;
   - the parent checks the size and magic bytes, sets the mode to `0600` and
     renames the file into place;
   - other files in the target directory stay out of the process's reach.

`SandboxMode::default()` depends on the platform:

- **Linux:** `Enforce`. Spawning fails if Landlock is unavailable.
  `BestEffort` logs a warning and continues; use it only on development hosts
  without Landlock.
- **macOS and other platforms:** `BestEffort`. Layer 3 is Linux-only, so there
  is no sandbox. Processes still get the whitelists, the cleared environment, a
  new session, rlimits and output staging, and a warning is logged once.
  `Enforce` refuses to spawn. `landlock` is a Linux-only dependency.

## Residual risks

- **No seccomp yet.** `fork`, `io_uring`, `bpf`, `userfaultfd` and the rest of
  the kernel attack surface stay reachable. Landlock still blocks `exec` of
  anything other than the listed binary. A `Policy` syscall layer (for example
  with `seccompiler`) can be added without changing the API.
- **Signals.** On kernels older than 6.12 (no Landlock ABI 6), a compromised
  child keeps the service's uid (root in production), only without
  capabilities. It can `kill()` other processes of that uid, wdintel-rs
  included.
- **Network.** For offline jobs, network isolation needs root (network
  namespace) or Landlock ABI 4. Unprivileged runs on 5.15 kernels have neither,
  so only the protocol whitelist stops network access. Network jobs can
  `connect()` to any host on the allowed port when Landlock has no TCP support.
  ffmpeg follows HTTP redirects to any host its protocol whitelist allows, so
  the origin allowlist covers only the first request. Plain `http` origins also
  send pre-signed URLs unencrypted; allow them only for local storage such as a
  development MinIO.
- **Pre-signed URLs in argv (G7).** A remote input's URL is visible in
  `/proc/<pid>/cmdline` for the length of the job. Mount `/proc` with
  `hidepid=2`, or later serve S3 reads through a loopback proxy.
- **`PR_SET_PDEATHSIG`** follows the thread that spawned the child. Spawn from
  async tasks, never from a short-lived `spawn_blocking` thread, or the child
  dies when that thread exits.
- **Memory and CPU** are bounded only by the service cgroup and each job's
  wall-clock timeout. Decoder stderr and ffprobe stdout are not capped, so a
  decoder that floods its output grows the parent's memory until the timeout.

## Input names

`image2` is allowed for thumbnails and images, matching wdintel-rs's
`THUMBNAIL_LOCAL_FORMAT_WHITELIST`, so names such as `photo.jpg` work. `image2`
also expands `%d` and glob patterns in the input name to neighbouring files:

- On Linux the sandbox grants only the input file, so those reads fail
  (`tests/hostile.rs` `image2_sequence_names_cannot_read_neighbours`).
- Without the sandbox (macOS) nothing stops them.

Input names must therefore be chosen by Echo, never by the sender, as
wdintel-rs already does with `<id>.source` and `source-XXXX`.

## API

```rust
use echo_media::ffmpeg::ThumbnailOptions;
use echo_media::{Ffmpeg, Input};

let media = Ffmpeg::shared()?; // process-wide; or Ffmpeg::new(MediaConfig { .. })
let input = Input::file("/var/lib/echo/messenger_media_cache/thumbnail_sources/<id>.source")?;
media
    .thumbnail(&input, &thumbnail_path, &ThumbnailOptions::new(filter))
    .await?;
```

| Method | Call sites in wdintel-rs | Status |
| --- | --- | --- |
| `thumbnail` | `thumbnail.rs` `generate`, called by `messenger/media_thumbnail.rs` and `devices/files/content/thumbnail/source.rs` | Wired |
| `probe` | `transcription/worker.rs` `ensure_audio`, `media_local_cache/playback.rs` `supported_source`, `media_preview/source.rs` `info` | Wired |
| `probe` | `devices/audio/probe.rs` `media_metadata` | Not wired |
| `remux_mp4_faststart` | `media_local_cache/playback.rs` `remux_watching_disk` | Wired |
| `hls_segments` | `media_preview/mod.rs` `render_window` | Wired |
| `decode_verify` | `devices/audio/probe.rs` `decoder_command`, `run_media_process`, `read_output` | Not wired |
| `audio_rendition` | `devices/audio/content.rs` `media_command` | Not wired |
| `audio_image` | `milgeo_audio_wave::generate_wave_png` / `generate_spectrogram_png` (`messenger/media_wave.rs`) | Not wired |

`MediaError::is_terminal()` separates "this input will never work" from
transient failures, matching today's `InvalidMedia` and transient split.

The generic layer (`process::{run, run_with, spawn}` with a `sandbox::Policy`)
can wrap other decoders later, such as `pdftotext`.

## Wiring

Thumbnails are done:

- `wdintel-rs/src/thumbnail.rs` keeps its `generate` and `InvalidMedia`
  interface and calls `Ffmpeg::shared()`.
- `MediaError::is_terminal()` errors become `InvalidMedia`; timeouts and
  environment failures stay transient.
- Messenger thumbnails gained the whitelists they lacked. Device thumbnails
  keep their 2 MiB output cap. The `*_THUMBNAIL_FFMPEG_BIN` constants and
  `THUMBNAIL_LOCAL_FORMAT_WHITELIST` are gone.
- On Linux the default is `Enforce`: a host without Landlock, or a root service
  without `CAP_SYS_ADMIN`, now fails thumbnail jobs as transient errors instead
  of running them unsandboxed. Check every host's kernel before deploying.

The transcription probe (`transcription/worker.rs` `ensure_audio`) uses
`Formats::AUDIO`, which now includes `mpegts` for audio-only transport
streams. Input that cannot decode is a terminal `WorkError`; timeouts and
environment failures are retryable, as before.

The messenger playback copy (`media_local_cache/playback.rs`) probes and
remuxes with `Formats::VIDEO`:

- A source ffprobe can never read is marked `unsupported`, so clients get the
  original; previously it was retried. Transient probe errors still retry.
- The remux writes `<id>.playback.tmp` with `RLIMIT_FSIZE` set to the
  reservation. wdintel-rs still validates it, renames it to
  `<id>.playback.mp4`, and stops the job when free space on the cache volume
  drops below the configured floor.
- The `.echo-media-*` job directory lives in the cache root for the length of a
  remux. Cache cleanup ignores it, so one left by a crash is never removed.

The messenger HLS preview (`media_preview/`) reads either the locally
retained original (`Input::File`) or a pre-signed S3 URL:

- The URL becomes `Input::Remote(RemoteUrl::new(url, &[s3_endpoint])?)`, so it
  must match the configured `s3_endpoint` origin. An empty endpoint fails the
  preview instead of trusting opendal's default host.
- An `https` endpoint gets `https,tls,tcp`; an `http` endpoint (local MinIO)
  gets `http,tcp`. Before, both used `file,http,https,tcp,tls`.
- The encoder writes only into the window's `<id>.work` directory, and each
  segment is capped at `MESSENGER_MEDIA_PREVIEW_SEGMENT_MAX_BYTES` by
  `RLIMIT_FSIZE`. wdintel-rs still publishes segments from that directory.
- The pre-signed URL is still visible in `/proc/<pid>/cmdline` (G7).

Remaining:

1. Replace the device audio call sites in the table above. Pass the existing
   wdintel-rs `config.rs` constants (filters, limits, timeouts) through the
   option structs.
2. Remove the `milgeo-audio-wave` ffmpeg path, then close G1, I2 and I3 in the
   checklist.

## Tests

```bash
cargo test -p echo-media
ECHO_MEDIA_TEST_SANDBOX=best-effort cargo test -p echo-media  # Linux without Landlock
```

Tests find ffmpeg on `PATH`. On macOS, `tests/sandbox.rs` and
`sandbox_alone_blocks_the_playlist` are compiled out; the rest runs without
the sandbox. macOS builds have not been compiled or run yet.

- `tests/sandbox.rs` checks enforcement with `/bin/sh` and coreutils:
  - reads, writes and execs outside the policy, including through symlinks;
  - `SIGXFSZ`, the cleared environment, and group kill on timeout and on drop;
  - network denial, which runs with root or Landlock ABI 4+ and is skipped
    otherwise;
  - capabilities and `NoNewPrivs`. `CapBnd` is checked only as root.
- `tests/jobs.rs` runs each job on lavfi fixtures.
- `tests/hostile.rs`:
  - runs HLS, concat, `subfile:` and ffconcat payloads, under six names,
    against all nine jobs;
  - includes a control test showing that unprotected ffmpeg really leaks the
    secret;
  - checks that the sandbox alone, without whitelists, blocks the leak;
  - covers image2 `%d` names and a 65535×65535 PNG pixel flood.
