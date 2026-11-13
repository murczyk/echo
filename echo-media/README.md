# echo-media

Sandboxed ffmpeg and ffprobe jobs for Echo. It addresses G1, I2 and I3 in
[media-security-audit-checklist.md](../docs/media-security-audit-checklist.md)
and limits the damage of G2 (services running as root) for the processes it
starts.

Every production ffmpeg and ffprobe call in wdintel-rs goes through it:
thumbnails, the transcription probe, the messenger playback copy and HLS
preview, the messenger wave and spectrogram images, and device audio. Only
tests still run ffmpeg directly, to build fixtures. See [Wiring](#wiring).

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
   - stderr keeps its last 64 KiB, with control characters replaced and remote
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
   - Without Landlock (e.g. the Proxmox kernel), a parent with `CAP_SYS_ADMIN`
     uses a mount namespace instead (`sandbox/mounts.rs`, `FsIsolation::Auto`):
     - `unshare(CLONE_NEWNS)`, then `pivot_root` into an empty read-only tmpfs
       that holds only the same paths, bind-mounted from the host at their
       resolved locations, with the symlinks met on the way recreated, plus
       `/etc/alternatives` (read-only, `noexec`), which Debian library
       symlinks such as `libblas.so.3` pass through;
     - read paths are read-only, the job directory is writable and `noexec`,
       and `/bin`, `/sbin`, `/usr/bin`, `/usr/sbin` and `/usr/local/{bin,sbin}`
       are covered with an empty tmpfs, so only the listed binary can run
       from them;
     - unlike Landlock, `/usr` and `/lib*` stay executable (shared libraries
       are mapped executable), so programs elsewhere, such as `/usr/lib`, can
       still be run; and there are no TCP rules or scoping;
     - in an LXC container the service runs as root of a user namespace, which
       has `CAP_SYS_ADMIN` there; the container's AppArmor profile must allow
       tmpfs and bind mounts and `pivot_root` (on Proxmox, `nesting=1`);
     - `FsIsolation::MountNamespace` forces it, even with Landlock.
4. **Output staging** (`ffmpeg/output.rs`):
   - ffmpeg writes into a fresh `0700` directory next to the target;
   - the parent checks the size and magic bytes, sets the mode to `0600` and
     renames the file into place;
   - other files in the target directory stay out of the process's reach.

`SandboxMode::default()` depends on the platform:

- **Linux:** `Enforce`. Spawning fails if neither Landlock nor the mount
  namespace fallback (needs `CAP_SYS_ADMIN`) is available. `BestEffort` logs
  a warning and continues; use it only on development hosts without either.
- **macOS and other platforms:** `BestEffort`. Layer 3 is Linux-only, so there
  is no sandbox. Processes still get the whitelists, the cleared environment, a
  new session, rlimits and output staging, and a warning is logged once.
  `Enforce` refuses to spawn. `landlock` is a Linux-only dependency.

`SandboxMode::Disabled` skips layer 3's isolation on every platform: no
namespaces, capability drop, `NO_NEW_PRIVS` or Landlock. Layers 1, 2 and 4
stay, as do the parent-death signal and the rlimits. It is for deployments
that have not opted in to the sandbox (see [Wiring](#wiring)).
`Ffmpeg::with_sandbox_mode(mode)` returns a copy whose jobs run in `mode`.

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
- Without the sandbox (macOS, or `SandboxMode::Disabled`) nothing stops them.

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
| `probe` | `transcription/worker.rs` `ensure_audio`, `media_local_cache/playback.rs` `supported_source`, `media_preview/source.rs` `info`, `devices/audio/probe.rs` `media_metadata` | Wired |
| `remux_mp4_faststart` | `media_local_cache/playback.rs` `remux_watching_disk` | Wired |
| `hls_segments` | `media_preview/mod.rs` `render_window` | Wired |
| `decode_verify` | `devices/audio/probe.rs` `probe_owned` | Wired |
| `audio_rendition` | `devices/audio/probe.rs` `render`, called by `devices/audio/content.rs` | Wired |
| `audio_image` | `messenger/media_wave.rs` `generate_png` (replaced `milgeo-audio-wave`) | Wired |

`MediaError::is_terminal()` separates "this input will never work" from
transient failures, matching today's `InvalidMedia` and transient split.

The generic layer (`process::{run, run_with, spawn}` with a `sandbox::Policy`)
can wrap other decoders later, such as `pdftotext`.

## Wiring

All call sites are wired. Across them:

- Every call site takes its `Ffmpeg` from `wdintel-rs/src/media_sandbox.rs`
  `ffmpeg()`: `Ffmpeg::shared()` with the configured sandbox mode.
- `MediaError::is_terminal()` errors (input that can never decode) map to each
  call site's terminal failure; timeouts and environment failures stay
  transient or retryable.
- wdintel-rs passes its own `config.rs` constants (filters, limits, timeouts)
  through the option structs.

### Sandbox opt-in

The sandbox is off unless `config.toml` sets:

```toml
media_sandbox_enabled = true
```

- The web process and the bgworker read it once at startup
  (`init_runtime_env` calls `media_sandbox::init`); changing it needs a
  restart. Without it, jobs run in `SandboxMode::Disabled`.
- When enabled, jobs run in `SandboxMode::default()` (`Enforce` on Linux). A
  host without Landlock uses the mount namespace fallback when the service has
  `CAP_SYS_ADMIN` (and logs a warning once).
- When enabled, startup first probes and fully decodes a generated silent WAV
  in the sandbox. If that fails (no Landlock or `CAP_SYS_ADMIN`, a missing
  library, a broken ffmpeg), the process refuses to start and logs the
  decoder's stderr. Otherwise a broken sandbox would fail every job as a
  terminal error, and device audio would reject each upload as `InvalidAudio`.

### Thumbnails

- `wdintel-rs/src/thumbnail.rs` keeps its `generate` and `InvalidMedia`
  interface and calls `media_sandbox::ffmpeg()`; terminal errors become
  `InvalidMedia`.
- Messenger thumbnails gained the whitelists they lacked. Device thumbnails
  keep their 2 MiB output cap; messenger thumbnails pass no cap.
- The `*_THUMBNAIL_FFMPEG_BIN` constants and
  `THUMBNAIL_LOCAL_FORMAT_WHITELIST` are gone.

### Transcription probe

`transcription/worker.rs` `ensure_audio` probes with `Formats::AUDIO`, which
includes `mpegts` for audio-only transport streams. Input without an audio
stream, or that cannot decode, is a terminal `WorkError`; a timeout and
environment failures are retryable.

### Messenger playback copy

`media_local_cache/playback.rs` probes and remuxes with `Formats::VIDEO`:

- A source ffprobe can never read is marked `unsupported`, so clients get the
  original; previously it was retried. Transient probe errors still retry.
- The remux writes `<id>.playback.tmp` with `RLIMIT_FSIZE` set to the
  reservation. wdintel-rs still validates it, renames it to
  `<id>.playback.mp4`, and stops the job when free space on the cache volume
  drops below the configured floor.

### Messenger HLS preview

`media_preview/` reads either the locally retained original (`Input::File`) or
a pre-signed S3 URL:

- The URL becomes `Input::Remote(RemoteUrl::new(url, &[s3_endpoint])?)`, so it
  must match the configured `s3_endpoint` origin. An empty endpoint fails the
  preview instead of trusting opendal's default host.
- An `https` endpoint gets `https,tls,tcp`; an `http` endpoint (local MinIO)
  gets `http,tcp`. Before, both used `file,http,https,tcp,tls`.
- The encoder writes only into the window's `<id>.work` directory, and each
  segment is capped at `MESSENGER_MEDIA_PREVIEW_SEGMENT_MAX_BYTES` by
  `RLIMIT_FSIZE`. wdintel-rs still publishes segments from that directory.
- The pre-signed URL is still visible in `/proc/<pid>/cmdline` (G7).

### Messenger wave and spectrogram images

`messenger/media_wave.rs` uses `audio_image` with `Formats::AUDIO`, and the
`milgeo-audio-wave` dependency is gone:

- PNGs keep their `/tmp/wave-<id>.png` and `/tmp/spectrogram-<id>.png` names.
  Each is published atomically from a private job directory, and only a
  regular file is served from the cache, so a planted symlink is ignored. The
  names are still predictable in a shared `/tmp`, so G8 is only partly fixed.
- `delete_local_media_files` removes a message's PNGs (S7).
- Audio that cannot decode returns the existing "generation failed" error.
  Timeouts (120 s, `ECHO_MEDIA_AUDIO_IMAGE_TIMEOUT`) and environment failures
  are internal errors.

### Device audio

`devices/audio/probe.rs` runs every job, and `content.rs` calls its `render`:

- Every job passes `Formats::AUDIO`. A format outside that list fails to open,
  which is terminal, so it becomes `InvalidAudio` rather than unsupported.
- `media_metadata` probes, so FLAC or Ogg is reported as unsupported rather
  than invalid. As before this crate, only a `format_name` of `wav` or `mp3`
  continues; the check is in wdintel-rs, not an ffmpeg flag.
- `decode_verify` decodes the whole WAV or MP3 source and checks framecrc
  progress, with `DEVICE_AUDIO_DECODER_PROGRESS_TIMEOUT` as the stall limit.
- `audio_rendition` writes the MP3 rendition (capped at 512 MiB) and the wave
  and spectrogram PNGs (capped at 1 MiB), using the device audio filters.
- `DecodeOptions::new` and `RenditionOptions::new` default to
  `Formats::WAV_MP3`; device audio overrides it with `Formats::AUDIO`.
- Each job is dropped, killing its process group, when finalization shuts
  down.
- Every terminal failure becomes one `InvalidAudio` reason ("повне
  декодування або визначення формату завершилося з помилкою"); the more
  specific reasons from the old code are gone.

### Remaining

1. Close G1, I2 and I3 in the checklist after the device audio tests pass.
2. Clean up `.echo-media-*` job directories left by a crash. Cache cleanup
   ignores them in the playback cache root, the thumbnail directories and
   `/tmp`.
3. Check the deployment: Landlock in `/sys/kernel/security/lsm` (or the mount
   namespace fallback working there), `CAP_SYS_ADMIN` for the services, and
   root-owned `ffmpeg` and `ffprobe` on the service `PATH`. Then set
   `media_sandbox_enabled = true`; the startup self-check confirms it works.
4. Clean up `.echo-media-root-*` directories in the temp dir. They are empty,
   and are left only if the service dies while spawning a job.

## Tests

```bash
cargo test -p echo-media
ECHO_MEDIA_TEST_SANDBOX=best-effort cargo test -p echo-media  # Linux without Landlock
# Mount-namespace fallback; needs CAP_SYS_ADMIN (root, or a user namespace):
ECHO_MEDIA_TEST_SANDBOX=mount-namespace unshare -r cargo test -p echo-media --offline
```

Tests find ffmpeg on `PATH`. On macOS, `tests/sandbox.rs` and the G1 and
image2 tests in `tests/hostile.rs` are compiled out; the rest runs without
the sandbox. macOS builds have not been compiled or run yet.

- `tests/sandbox.rs` checks enforcement with `/bin/sh` and coreutils:
  - reads, writes and execs outside the policy, including through symlinks;
  - `SIGXFSZ`, the cleared environment, and group kill on timeout and on drop;
  - network denial, which runs with root or Landlock ABI 4+ and is skipped
    otherwise;
  - capabilities and `NoNewPrivs`. `CapBnd` is checked only as root;
  - `SandboxMode::Disabled` reads outside the policy but still clears the
    environment.
- `tests/jobs.rs` runs each job on lavfi fixtures.
- `wdintel-rs` `media_sandbox::tests` runs the startup self-check in the
  sandbox.
- `tests/hostile.rs`:
  - runs HLS, concat, `subfile:` and ffconcat payloads, under six names,
    against all nine jobs;
  - checks that the sandbox alone, without whitelists, blocks the leak;
  - covers image2 `%d` names and a 65535×65535 PNG pixel flood.
