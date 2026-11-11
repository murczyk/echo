//! Every job against G1 payloads (playlists and concat lists that point at
//! local secrets or the network), image2 sequence names and a pixel flood.

mod support;

use echo_media::ffmpeg::{
    AudioImage, AudioImageOptions, DecodeOptions, HlsOptions, HlsSegments,
    ProbeOptions, RemuxOptions, Rendition, RenditionOptions, ThumbnailOptions,
};
use echo_media::{Formats, Input, MediaError};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use support::*;
use tokio::sync::Semaphore;

const THUMBNAIL_FILTER: &str =
    "scale=300:300:force_original_aspect_ratio=increase";
const NAMES: &[&str] = &[
    "payload.mp4",
    "payload.jpg",
    "payload.ts",
    "payload.m3u8",
    "payload.source",
    "payload",
];

fn payloads(secrets: &Secrets, canary: &Canary) -> Vec<(&'static str, String)> {
    let secret = secrets.video.display();
    let port = canary.port;
    let hls = |uri: String| {
        format!("#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n{uri}\n#EXT-X-ENDLIST\n")
    };
    vec![
        ("hls-file", hls(format!("file://{secret}"))),
        ("hls-path", hls(secret.to_string())),
        (
            "hls-http",
            hls(format!("http://127.0.0.1:{port}/private.ts")),
        ),
        ("hls-concat", hls(format!("concat:{secret}|{secret}"))),
        (
            "hls-subfile",
            hls(format!("subfile,,start,0,end,0,,:{secret}")),
        ),
        (
            "ffconcat",
            format!("ffconcat version 1.0\nfile '{secret}'\n"),
        ),
    ]
}

/// Runs one job; `Ok(paths)` lists the files it claims to have produced.
async fn run_job(
    job: &str,
    input: &Input,
    out: &Path,
) -> Result<Vec<PathBuf>, MediaError> {
    let media = ffmpeg();
    let file = out.join(job);
    match job {
        "probe-video" | "probe-audio" | "probe-thumbnail" => {
            let formats = match job {
                "probe-video" => Formats::VIDEO,
                "probe-audio" => Formats::AUDIO,
                _ => Formats::THUMBNAIL,
            };
            media
                .probe(input, &ProbeOptions::new(formats))
                .await
                .map(|_| vec![])
        }
        "thumbnail" => media
            .thumbnail(input, &file, &ThumbnailOptions::new(THUMBNAIL_FILTER))
            .await
            .map(|_| vec![file]),
        "remux" => media
            .remux_mp4_faststart(input, &file, &RemuxOptions::new(64 << 20))
            .await
            .map(|_| vec![file]),
        "hls" => {
            let segments = HlsSegments {
                index: 0,
                start: 0.0,
                length: 3.0,
            };
            let mut running = media.hls_segments(
                input,
                out,
                segments,
                &HlsOptions::default(),
            )?;
            running.wait().await.map(|_| vec![out.join("0.ts")])
        }
        "decode" => media
            .decode_verify(input, &DecodeOptions::new(44100))
            .await
            .map(|_| vec![]),
        "rendition" => {
            let kind = Rendition::Mp3 {
                channels: 1,
                quality: 2,
            };
            media
                .audio_rendition(input, &file, &RenditionOptions::new(kind))
                .await
                .map(|_| vec![file])
        }
        "audio-image" => media
            .audio_image(
                input,
                &file,
                &AudioImageOptions::new(AudioImage::Wave),
            )
            .await
            .map(|_| vec![file]),
        _ => unreachable!("{job}"),
    }
}

const JOBS: &[&str] = &[
    "probe-video",
    "probe-audio",
    "probe-thumbnail",
    "thumbnail",
    "remux",
    "hls",
    "decode",
    "rendition",
    "audio-image",
];

#[tokio::test(flavor = "multi_thread")]
async fn reference_following_payloads_are_refused_by_every_job() {
    let secrets = secrets();
    let canary = Canary::start();
    let inputs = tempfile::tempdir().unwrap();
    let mut cases = tokio::task::JoinSet::new();
    let slots = Arc::new(Semaphore::new(parallelism()));
    for (kind, payload) in payloads(&secrets, &canary) {
        for name in NAMES {
            let path = write(
                inputs.path(),
                &format!("{kind}-{name}"),
                payload.as_bytes(),
            );
            let input = Input::file(&path).unwrap();
            for job in JOBS {
                let (input, slots) = (input.clone(), slots.clone());
                let case = format!("{kind} {name} {job}");
                cases.spawn(async move {
                    let _slot = slots.acquire_owned().await.unwrap();
                    refused(&case, job, &input).await
                });
            }
        }
    }
    let mut failures = Vec::new();
    while let Some(result) = cases.join_next().await {
        if let Err(failure) = result.unwrap() {
            failures.push(failure);
        }
    }
    std::thread::sleep(Duration::from_millis(100));
    assert!(
        failures.is_empty(),
        "jobs accepted hostile input:\n{}",
        failures.join("\n")
    );
    assert_eq!(canary.hits(), 0, "a job connected to the canary");
}

/// One payload × name × job: the job must fail terminally and leave no
/// output behind.
async fn refused(case: &str, job: &str, input: &Input) -> Result<(), String> {
    let out = tempfile::tempdir().unwrap();
    let result = run_job(job, input, out.path()).await;
    assert_no_secret(out.path());
    match result {
        Err(error) if error.is_terminal() => Ok(()),
        Err(error) => Err(format!("{case}: transient error {error:?}")),
        Ok(paths) => Err(format!("{case} -> {paths:?}")),
    }
}

fn parallelism() -> usize {
    std::thread::available_parallelism().map_or(4, |count| count.get())
}

/// Proves the corpus is live: without whitelists and the sandbox, ffmpeg
/// follows the playlist and renders the secret video into a thumbnail.
#[test]
fn unprotected_ffmpeg_follows_the_playlist() {
    let secrets = secrets();
    let canary = Canary::start();
    let dir = tempfile::tempdir().unwrap();
    let (_, payload) = payloads(&secrets, &canary).remove(0);
    let input = write(dir.path(), "payload.mp4", payload.as_bytes());
    assert!(payload.contains("file://"));
    let output = dir.path().join("leak.jpg");
    let status = ffmpeg_command()
        .args(["-loglevel", "quiet", "-i"])
        .arg(&input)
        .args(["-frames:v", "1", "-f", "image2"])
        .arg(&output)
        .status()
        .unwrap();
    assert!(
        status.success() && output.exists(),
        "control payload did not reproduce G1"
    );
}

/// Defence in depth: with the whitelists removed, the sandbox alone still
/// keeps the secret out of reach.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn sandbox_alone_blocks_the_playlist() {
    use echo_media::process::{self, Spec};
    use echo_media::Policy;
    let secrets = secrets();
    let canary = Canary::start();
    let dir = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let (_, payload) = payloads(&secrets, &canary).remove(0);
    let input = write(dir.path(), "payload.mp4", payload.as_bytes());
    let output = out.path().join("leak.jpg");
    let spec = Spec {
        program: ffmpeg_bin(),
        args: ["-hide_banner", "-loglevel", "error", "-y", "-i"]
            .iter()
            .map(Into::into)
            .chain([input.clone().into_os_string()])
            .chain(["-frames:v", "1", "-f", "image2"].iter().map(Into::into))
            .chain([output.clone().into_os_string()])
            .collect(),
        policy: Policy::for_programs(&[ffmpeg_bin()])
            .read_file(&input)
            .write_dir(out.path())
            .fs_isolation(fs_isolation()),
        mode: sandbox_mode(),
        timeout: Duration::from_secs(30),
        capture_stdout: false,
        redact: Vec::new(),
    };
    let result = process::run(spec).await;
    let Err(MediaError::InvalidMedia { stderr, .. }) = result else {
        panic!("sandboxed ffmpeg read the secret: {result:?}");
    };
    assert!(
        stderr.contains("Error when loading first segment"),
        "{stderr}"
    );
    assert!(!output.exists());
}

/// `image2` expands `%d` in the input name to neighbouring files. The
/// sandbox grants only the input itself, so the neighbour read fails.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn image2_sequence_names_cannot_read_neighbours() {
    let dir = tempfile::tempdir().unwrap();
    image_named(dir.path(), "neighbour-1.png", "png");
    let path = image_named(dir.path(), "neighbour-%d.png", "png");
    let output = dir.path().join("neighbour.thumb");
    let result = ffmpeg()
        .thumbnail(
            &Input::file(&path).unwrap(),
            &output,
            &ThumbnailOptions::new(THUMBNAIL_FILTER),
        )
        .await;
    assert!(
        matches!(result, Err(MediaError::InvalidMedia { .. })),
        "{result:?}"
    );
    assert!(!output.exists());
}

#[tokio::test]
async fn pixel_flood_png_fails_fast() {
    let dir = tempfile::tempdir().unwrap();
    let path = write(dir.path(), "flood.source", &png(65535, 65535));
    let output = dir.path().join("flood.jpg");
    let started = Instant::now();
    let result = ffmpeg()
        .thumbnail(
            &Input::file(&path).unwrap(),
            &output,
            &ThumbnailOptions::new(THUMBNAIL_FILTER),
        )
        .await;
    assert!(result.is_err(), "{result:?}");
    assert!(started.elapsed() < Duration::from_secs(30));
    assert!(!output.exists());
}

fn assert_no_secret(dir: &Path) {
    for entry in walk(dir) {
        assert!(
            !contains(&entry, SECRET_MARKER),
            "secret leaked into {}",
            entry.display()
        );
        let size = std::fs::metadata(&entry).map(|m| m.len()).unwrap_or(0);
        assert_eq!(size, 0, "unexpected output {}", entry.display());
    }
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            files.extend(walk(&path));
        } else {
            files.push(path);
        }
    }
    files
}

/// A PNG whose header declares `width`×`height` RGBA with a tiny IDAT.
fn png(width: u32, height: u32) -> Vec<u8> {
    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    // zlib stream with one empty stored block.
    let idat = [
        0x78, 0x01, 0x01, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00, 0x00, 0x01,
    ];
    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
    for (kind, data) in
        [(&b"IHDR"[..], &ihdr[..]), (b"IDAT", &idat), (b"IEND", &[])]
    {
        bytes.extend_from_slice(&(data.len() as u32).to_be_bytes());
        let start = bytes.len();
        bytes.extend_from_slice(kind);
        bytes.extend_from_slice(data);
        let crc = crc32(&bytes[start..]);
        bytes.extend_from_slice(&crc.to_be_bytes());
    }
    bytes
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xedb8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}
