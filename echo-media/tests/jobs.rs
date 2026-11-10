//! Every job produces the expected output from clean fixtures while running
//! inside the sandbox.

mod support;

use echo_media::ffmpeg::{
    AudioImage, AudioImageOptions, DecodeOptions, HlsOptions, HlsSegments,
    ProbeOptions, RemuxOptions, Rendition, RenditionOptions, ThumbnailOptions,
};
use echo_media::{Formats, Input, MediaError};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::time::Duration;
use support::*;

const VIDEO_THUMBNAIL_FILTER: &str =
    "scale=640:-2:force_original_aspect_ratio=decrease,thumbnail=60";
const IMAGE_THUMBNAIL_FILTER: &str =
    "scale=300:300:force_original_aspect_ratio=increase";

#[tokio::test]
async fn probe_reports_streams_and_duration() {
    let dir = tempfile::tempdir().unwrap();
    let input = Input::file(video(dir.path(), "media.source")).unwrap();
    let probe = ffmpeg()
        .probe(&input, &ProbeOptions::new(Formats::VIDEO))
        .await
        .unwrap();
    let video = probe.first("video").unwrap();
    assert_eq!(video.codec_name.as_deref(), Some("h264"));
    assert_eq!(video.pix_fmt.as_deref(), Some("yuv420p"));
    assert_eq!(
        probe.first("audio").unwrap().codec_name.as_deref(),
        Some("aac")
    );
    let duration = probe.duration_secs().unwrap();
    assert!((2.9..3.2).contains(&duration), "{duration}");
}

#[tokio::test]
async fn probe_reports_audio_parameters() {
    let dir = tempfile::tempdir().unwrap();
    let input = Input::file(wav(dir.path(), "audio.source")).unwrap();
    let probe = ffmpeg()
        .probe(&input, &ProbeOptions::new(Formats::WAV_MP3))
        .await
        .unwrap();
    assert_eq!(probe.format_name(), Some("wav"));
    let audio = probe.first("audio").unwrap();
    assert_eq!(audio.sample_rate(), Some(44100));
    assert_eq!(audio.channels, Some(1));
}

#[tokio::test]
async fn video_thumbnail_is_a_private_jpeg() {
    let dir = tempfile::tempdir().unwrap();
    let input = Input::file(video(dir.path(), "media.source")).unwrap();
    let output = dir.path().join("cache/thumbnails/id.jpg");
    let size = ffmpeg()
        .thumbnail(
            &input,
            &output,
            &ThumbnailOptions::new(VIDEO_THUMBNAIL_FILTER),
        )
        .await
        .unwrap();
    assert_eq!(size, std::fs::metadata(&output).unwrap().len());
    assert_jpeg(&output);
    let mode = std::fs::metadata(&output).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o600);
    assert_no_job_dirs(output.parent().unwrap());
}

#[tokio::test]
async fn image_thumbnails_probe_by_content_with_any_name() {
    let dir = tempfile::tempdir().unwrap();
    let images = [
        image(dir.path(), "png.source", "png", "image2"),
        image(dir.path(), "jpeg.source", "mjpeg", "image2"),
        image(dir.path(), "webp.source", "libwebp", "webp"),
        image(dir.path(), "gif.source", "gif", "gif"),
        image(dir.path(), "plain.png", "png", "image2"),
        image(dir.path(), "plain.jpg", "mjpeg", "image2"),
        image(
            dir.path(),
            "subfile,,start,0,end,0,,:x.png",
            "png",
            "image2",
        ),
        image(dir.path(), "concat:a.png|b.png", "png", "image2"),
    ];
    for (index, path) in images.iter().enumerate() {
        let input = Input::file(path).unwrap();
        let output = dir.path().join(format!("thumb-{index}.jpg"));
        ffmpeg()
            .thumbnail(
                &input,
                &output,
                &ThumbnailOptions::new(IMAGE_THUMBNAIL_FILTER),
            )
            .await
            .unwrap_or_else(|error| panic!("{}: {error:?}", path.display()));
        assert_jpeg(&output);
    }
}

#[tokio::test]
async fn thumbnail_over_its_size_limit_fails() {
    let dir = tempfile::tempdir().unwrap();
    let input = Input::file(video(dir.path(), "media.source")).unwrap();
    let output = dir.path().join("thumb.jpg");
    let options = ThumbnailOptions {
        max_bytes: Some(512),
        ..ThumbnailOptions::new(VIDEO_THUMBNAIL_FILTER)
    };
    let error = ffmpeg()
        .thumbnail(&input, &output, &options)
        .await
        .unwrap_err();
    assert!(error.is_terminal(), "{error:?}");
    assert!(!output.exists());
    assert_no_job_dirs(dir.path());
}

#[tokio::test]
async fn remux_moves_moov_before_mdat() {
    let dir = tempfile::tempdir().unwrap();
    let source = video(dir.path(), "media.source");
    assert!(
        top_level_boxes(&source).iter().position(|b| b == "mdat")
            < top_level_boxes(&source).iter().position(|b| b == "moov")
    );
    let output = dir.path().join("playback.mp4");
    let input = Input::file(&source).unwrap();
    ffmpeg()
        .remux_mp4_faststart(&input, &output, &RemuxOptions::new(64 << 20))
        .await
        .unwrap();
    let boxes = top_level_boxes(&output);
    let moov = boxes.iter().position(|b| b == "moov").unwrap();
    let mdat = boxes.iter().position(|b| b == "mdat").unwrap();
    assert!(moov < mdat, "{boxes:?}");
}

#[tokio::test]
async fn hls_segments_are_written_to_the_output_dir() {
    let dir = tempfile::tempdir().unwrap();
    let input = Input::file(video(dir.path(), "media.source")).unwrap();
    let out = tempfile::tempdir().unwrap();
    let segments = HlsSegments {
        index: 0,
        start: 0.0,
        length: 3.0,
    };
    let mut running = ffmpeg()
        .hls_segments(&input, out.path(), segments, &HlsOptions::default())
        .unwrap();
    running.wait().await.unwrap();
    let names: Vec<_> = std::fs::read_dir(out.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    assert!(names.contains(&"0.ts".to_string()), "{names:?}");
    assert!(names.contains(&"preview.m3u8".to_string()), "{names:?}");
    assert!(
        names.iter().all(|name| !name.ends_with(".tmp")),
        "{names:?}"
    );
}

#[tokio::test]
async fn hls_past_its_deadline_times_out() {
    let dir = tempfile::tempdir().unwrap();
    let input = Input::file(video(dir.path(), "media.source")).unwrap();
    let out = tempfile::tempdir().unwrap();
    let segments = HlsSegments {
        index: 0,
        start: 0.0,
        length: 3.0,
    };
    let options = HlsOptions {
        timeout: Duration::from_millis(30),
        ..HlsOptions::default()
    };
    let mut running = ffmpeg()
        .hls_segments(&input, out.path(), segments, &options)
        .unwrap();
    let result = running.wait().await;
    assert!(matches!(result, Err(MediaError::Timeout(_))), "{result:?}");
}

#[tokio::test]
async fn decode_verify_reports_the_decoded_duration() {
    let dir = tempfile::tempdir().unwrap();
    for (path, rate) in [
        (wav(dir.path(), "a.source"), 44100),
        (mp3(dir.path(), "b.source"), 44100),
    ] {
        let input = Input::file(&path).unwrap();
        let report = ffmpeg()
            .decode_verify(&input, &DecodeOptions::new(rate))
            .await
            .unwrap();
        let duration = report.duration_us;
        assert!((1_950_000..2_100_000).contains(&duration), "{duration}");
    }
}

#[tokio::test]
async fn audio_renditions_are_verified_and_published() {
    let dir = tempfile::tempdir().unwrap();
    let input = Input::file(wav(dir.path(), "audio.source")).unwrap();
    let kinds = [
        (
            "mp3",
            Rendition::Mp3 {
                channels: 1,
                quality: 2,
            },
        ),
        (
            "wave",
            Rendition::Wave {
                filter: echo_media::constants::ECHO_MEDIA_AUDIO_WAVE_FILTER,
            },
        ),
        (
            "spectrogram",
            Rendition::Spectrogram {
                filter:
                    echo_media::constants::ECHO_MEDIA_AUDIO_SPECTROGRAM_FILTER,
            },
        ),
    ];
    for (name, kind) in kinds {
        let output = dir.path().join(name);
        let report = ffmpeg()
            .audio_rendition(&input, &output, &RenditionOptions::new(kind))
            .await
            .unwrap_or_else(|error| panic!("{name}: {error:?}"));
        assert!(
            (1_950_000..2_100_000).contains(&report.duration_us),
            "{name}"
        );
        let bytes = std::fs::read(&output).unwrap();
        match kind {
            Rendition::Mp3 { .. } => {
                assert!(bytes.starts_with(b"ID3") || bytes[0] == 0xff, "{name}")
            }
            _ => assert!(bytes.starts_with(b"\x89PNG"), "{name}"),
        }
    }
}

#[tokio::test]
async fn audio_images_render_messenger_formats() {
    let dir = tempfile::tempdir().unwrap();
    let sources = [
        opus(dir.path(), "voice.source"),
        mp3(dir.path(), "song.source"),
    ];
    for source in &sources {
        let input = Input::file(source).unwrap();
        for kind in [AudioImage::Wave, AudioImage::Spectrogram] {
            let output = dir.path().join(format!("{kind:?}.png"));
            ffmpeg()
                .audio_image(&input, &output, &AudioImageOptions::new(kind))
                .await
                .unwrap_or_else(|error| {
                    panic!("{kind:?} {}: {error:?}", source.display())
                });
            assert!(std::fs::read(&output).unwrap().starts_with(b"\x89PNG"));
        }
    }
}

fn assert_jpeg(path: &Path) {
    let bytes = std::fs::read(path).unwrap();
    assert!(bytes.starts_with(&[0xff, 0xd8, 0xff]), "{}", path.display());
}

fn assert_no_job_dirs(dir: &Path) {
    let leftovers: Vec<_> = std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .filter(|name| name.starts_with(".echo-media-"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

fn top_level_boxes(path: &Path) -> Vec<String> {
    let bytes = std::fs::read(path).unwrap();
    let mut boxes = Vec::new();
    let mut offset = 0usize;
    while offset + 8 <= bytes.len() {
        let size =
            u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap())
                as usize;
        boxes.push(
            String::from_utf8_lossy(&bytes[offset + 4..offset + 8])
                .into_owned(),
        );
        if size < 8 {
            break;
        }
        offset += size;
    }
    boxes
}
