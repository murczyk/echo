//! Fixed names, paths, ffmpeg allowlists, filters and file signatures.
//! Bounds (timeouts, sizes, threads) are in `limits.rs`.

/// Program names looked up on `PATH` by `MediaConfig::from_path`.
pub const ECHO_MEDIA_FFMPEG_NAME: &str = "ffmpeg";

pub const ECHO_MEDIA_FFPROBE_NAME: &str = "ffprobe";

/// The only environment a sandboxed child receives.
pub const ECHO_MEDIA_CHILD_ENV: &[(&str, &str)] =
    &[("LC_ALL", "C"), ("AV_LOG_FORCE_NOCOLOR", "1")];
pub const ECHO_MEDIA_CHILD_CWD: &str = "/";

pub const ECHO_MEDIA_JOB_DIR_PREFIX: &str = ".echo-media-";

pub const ECHO_MEDIA_OUTPUT_FILE_MODE: u32 = 0o600;
pub const ECHO_MEDIA_OUTPUT_DIR_MODE: u32 = 0o700;

pub const ECHO_MEDIA_READ_CHUNK_BYTES: usize = 8192;

pub const ECHO_MEDIA_REDACTED: &str = "<redacted>";

pub const ECHO_MEDIA_SANDBOX_CAP_LAST_CAP_PATH: &str =
    "/proc/sys/kernel/cap_last_cap";
pub const ECHO_MEDIA_SANDBOX_CAP_LAST_CAP_FALLBACK: u32 = 63;
/// Read-only system paths every sandboxed binary needs to load and run.
/// Missing entries are skipped, so merged-`/usr` hosts work unchanged.
pub const ECHO_MEDIA_SANDBOX_SYSTEM_READ_DIRS: &[&str] = &[
    "/usr",
    "/lib",
    "/lib64",
    "/lib32",
    "/sys/devices/system/cpu",
];
/// Dynamic loaders the kernel executes for every dynamically linked binary
/// (glibc and musl, x86_64 and aarch64). Missing entries are skipped;
/// symlinks such as `/lib64/ld-linux-x86-64.so.2` resolve to the real file.
pub const ECHO_MEDIA_SANDBOX_DYNAMIC_LOADERS: &[&str] = &[
    "/lib64/ld-linux-x86-64.so.2",
    "/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2",
    "/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2",
    "/lib/ld-linux-aarch64.so.1",
    "/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1",
    "/usr/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1",
    "/lib/ld-musl-x86_64.so.1",
    "/lib/ld-musl-aarch64.so.1",
];
pub const ECHO_MEDIA_SANDBOX_SYSTEM_READ_FILES: &[&str] = &[
    "/etc/ld.so.cache",
    "/etc/localtime",
    "/dev/null",
    "/dev/urandom",
];
/// Mount-namespace fallback (kernels without Landlock): these program
/// directories are covered with an empty tmpfs, so only the policy's
/// executables can run from them. Missing entries are skipped.
pub const ECHO_MEDIA_SANDBOX_MASKED_DIRS: &[&str] = &[
    "/bin",
    "/sbin",
    "/usr/bin",
    "/usr/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
];
/// Mount-namespace fallback: directories of symlinks that system libraries
/// resolve through, bound read-only and `noexec` when they exist. Debian's
/// `update-alternatives` links `libblas.so.3` and `liblapack.so.3` (ffmpeg
/// dependencies) through `/etc/alternatives`. Landlock needs no rule for
/// them: it only checks the file a path finally resolves to.
pub const ECHO_MEDIA_SANDBOX_SYMLINK_DIRS: &[&str] = &["/etc/alternatives"];
/// Prefix of the empty directory in the temp dir that the child's private
/// root tmpfs is mounted on.
pub const ECHO_MEDIA_SANDBOX_ROOT_PREFIX: &str = ".echo-media-root-";
pub const ECHO_MEDIA_SANDBOX_TMPFS_OPTIONS: &std::ffi::CStr = c"mode=0755";
pub const ECHO_MEDIA_SANDBOX_MOUNTPOINT_MODE: u32 = 0o755;
/// Same limit as the kernel's `MAXSYMLINKS`.
pub const ECHO_MEDIA_SANDBOX_MAX_SYMLINKS: usize = 40;
/// Extra read-only paths for jobs that resolve names and speak TLS.
pub const ECHO_MEDIA_SANDBOX_NETWORK_READ_FILES: &[&str] = &[
    "/etc/resolv.conf",
    "/etc/hosts",
    "/etc/nsswitch.conf",
    "/etc/gai.conf",
    "/etc/host.conf",
];
pub const ECHO_MEDIA_SANDBOX_NETWORK_READ_DIRS: &[&str] = &["/etc/ssl"];

pub const ECHO_MEDIA_PROTOCOLS_LOCAL: &str = "file";
/// ffmpeg protocols for a remote input, chosen by its URL scheme.
pub const ECHO_MEDIA_PROTOCOLS_HTTPS: &str = "https,tls,tcp";
pub const ECHO_MEDIA_PROTOCOLS_HTTP: &str = "http,tcp";

pub const ECHO_MEDIA_HTTPS_DEFAULT_PORT: u16 = 443;
pub const ECHO_MEDIA_HTTP_DEFAULT_PORT: u16 = 80;

/// Same list as wdintel-rs `THUMBNAIL_LOCAL_FORMAT_WHITELIST`. `image2`
/// handles images ffmpeg recognises by extension (e.g. `.jpg`); its `%d` and
/// glob expansion can only reach files the sandbox lets the job read.
pub const ECHO_MEDIA_FORMATS_THUMBNAIL: &str = "image2,jpeg_pipe,png_pipe,webp_pipe,bmp_pipe,tiff_pipe,gif,apng,ico,mov,matroska,webm,avi,asf,flv,mpeg,mpegvideo,mpegts,ogg,hevc,h264";
pub const ECHO_MEDIA_FORMATS_IMAGE: &str =
    "image2,jpeg_pipe,png_pipe,webp_pipe,bmp_pipe,tiff_pipe,gif,apng,ico";
pub const ECHO_MEDIA_FORMATS_VIDEO: &str =
    "mov,matroska,webm,avi,asf,flv,mpeg,mpegvideo,mpegts,ogg,hevc,h264";
/// Includes `mpegts` for audio-only transport streams (legacy recordings).
pub const ECHO_MEDIA_FORMATS_AUDIO: &str =
    "mp3,wav,ogg,flac,aac,mov,matroska,webm,amr,mpegts";
pub const ECHO_MEDIA_FORMATS_MOV: &str = "mov";
pub const ECHO_MEDIA_FORMATS_WAV_MP3: &str = "wav,mp3";
/// Demuxers that read other files or URLs named inside the input.
pub const ECHO_MEDIA_FORMATS_FORBIDDEN: &[&str] = &[
    "hls",
    "applehttp",
    "dash",
    "concat",
    "lavfi",
    "sdp",
    "rtsp",
    "rtp",
    "ffmetadata",
];

pub const ECHO_MEDIA_PROBE_SHOW_ENTRIES: &str = "format=format_name,duration:stream=index,codec_type,codec_name,pix_fmt,sample_rate,channels";

pub const ECHO_MEDIA_THUMBNAIL_FILE_NAME: &str = "thumbnail.jpg";

pub const ECHO_MEDIA_JPEG_MAGIC: &[u8] = &[0xff, 0xd8, 0xff];

pub const ECHO_MEDIA_REMUX_VIDEO_BSF: &str = "h264_metadata=level=auto";
pub const ECHO_MEDIA_REMUX_FILE_NAME: &str = "playback.mp4";

pub const ECHO_MEDIA_HLS_SEGMENT_SECS: f64 = 1.0;
pub const ECHO_MEDIA_HLS_VIDEO_FILTER: &str =
    "fps=30,scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2";
pub const ECHO_MEDIA_HLS_VIDEO_MAXRATE: &str = "3M";
pub const ECHO_MEDIA_HLS_SEGMENT_PATTERN: &str = "%d.ts";
pub const ECHO_MEDIA_HLS_PLAYLIST_NAME: &str = "preview.m3u8";

pub const ECHO_MEDIA_AUDIO_MICROSECONDS_PER_SECOND: u128 = 1_000_000;
pub const ECHO_MEDIA_AUDIO_RENDITION_RATE: u32 = 48_000;
pub const ECHO_MEDIA_AUDIO_RENDITION_QUALITY: u32 = 2;
pub const ECHO_MEDIA_AUDIO_RENDITION_FILE_NAME: &str = "rendition";
pub const ECHO_MEDIA_AUDIO_IMAGE_FILE_NAME: &str = "audio.png";

pub const ECHO_MEDIA_PNG_MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";

/// Same filters as `milgeo-audio-wave` `constants.rs` and wdintel-rs
/// `DEVICE_AUDIO_*_FILTER`.
pub const ECHO_MEDIA_AUDIO_WAVE_FILTER: &str = "[0:a]aformat=channel_layouts=mono,compand,showwavespic=s=600x100:colors=#9cf42f";
pub const ECHO_MEDIA_AUDIO_SPECTROGRAM_FILTER: &str = "[0:a]showspectrumpic=s=500x200:mode=combined:legend=off,format=rgba,colorkey=black:0.01:0";
