use super::*;
use crate::devices::audio::types::ReceiveDeviceAudioReq;
use crate::functest::tests::cleanup_locked;
use serde_json::json;

async fn fixture(
    directory: &Path,
    format: &str,
    seconds: &str,
) -> std::path::PathBuf {
    let path = directory.join(format!("fixture-{seconds}.{format}"));
    let codec = match format {
        "wav" => "pcm_s16le",
        "mp3" => "libmp3lame",
        _ => "flac",
    };
    let output = tokio::process::Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000",
            "-t",
            seconds,
            "-c:a",
            codec,
        ])
        .arg(&path)
        .output()
        .await
        .unwrap();
    assert!(
        output.status.success(),
        "fixture creation: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    path
}

#[tokio::test]
#[serial_test::serial]
async fn audio_probe_preserves_absolute_midnight_interval() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let directory = tempfile::tempdir().unwrap();
    let wav = fixture(directory.path(), "wav", "90").await;
    let start: DateTime<Utc> = "2026-10-03T23:59:30Z".parse().unwrap();
    let audio = probe(&env.device_audio, &wav, start).await.unwrap();
    assert_eq!(audio.mime_type, "audio/wav");
    assert_eq!(audio.duration_us, 90_000_000);
    assert_eq!(
        audio.recording_ended_at,
        "2026-10-04T00:01:00Z".parse::<DateTime<Utc>>().unwrap()
    );
    let equivalent = "2026-10-04T02:59:30+03:00"
        .parse::<DateTime<Utc>>()
        .unwrap();
    assert_eq!(
        probe(&env.device_audio, &wav, equivalent)
            .await
            .unwrap()
            .recording_ended_at,
        audio.recording_ended_at
    );
    let mp3 = fixture(directory.path(), "mp3", "1").await;
    let audio = probe(&env.device_audio, &mp3, start).await.unwrap();
    assert_eq!(audio.mime_type, "audio/mpeg");
    assert_eq!(
        audio.duration_us, 1_000_000,
        "MP3 encoder delay/padding must not become recorded duration"
    );
    let renamed = directory.path().join("pretend.wav");
    tokio::fs::rename(mp3, &renamed).await.unwrap();
    assert_eq!(
        probe(&env.device_audio, &renamed, start)
            .await
            .unwrap()
            .mime_type,
        "audio/mpeg"
    );
}

#[tokio::test]
#[serial_test::serial]
async fn audio_probe_rejects_late_corruption_and_naive_time() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let directory = tempfile::tempdir().unwrap();
    let start: DateTime<Utc> = "2026-10-03T23:59:30Z".parse().unwrap();
    let wav = fixture(directory.path(), "wav", "1").await;
    probe(&env.device_audio, &wav, start).await.unwrap();
    let mut bytes = tokio::fs::read(&wav).await.unwrap();
    bytes.truncate(bytes.len() - 1);
    tokio::fs::write(&wav, bytes).await.unwrap();
    assert!(
        probe(&env.device_audio, &wav, start).await.is_err(),
        "late corrupted packet cannot pass by probing the header"
    );
    let unsupported = fixture(directory.path(), "flac", "1").await;
    let error = probe(&env.device_audio, &unsupported, start)
        .await
        .unwrap_err();
    assert!(error.chain().any(|e| e
        .downcast_ref::<DeviceAudioMediaError>()
        .is_some_and(|e| matches!(
            e,
            DeviceAudioMediaError::UnsupportedMedia
        ))));
    for bytes in [b"".as_slice(), b"not audio", b"RIFF\x00\x00\x00\x00WAVE"] {
        let path = directory.path().join("invalid.wav");
        tokio::fs::write(&path, bytes).await.unwrap();
        assert!(probe(&env.device_audio, &path, start).await.is_err());
    }
    let valid = fixture(directory.path(), "wav", "0.1").await;
    let empty = fixture(directory.path(), "wav", "0").await;
    assert!(probe(&env.device_audio, &empty, start).await.is_err());
    assert!(probe(&env.device_audio, &valid, DateTime::<Utc>::MAX_UTC)
        .await
        .is_err());
    assert!(probe(&env.device_audio, &valid, DateTime::<Utc>::MIN_UTC)
        .await
        .is_err());
    let request = json!({"device_id": uuid::Uuid::new_v4(),"upload_url":"/local","name":"audio","recording_started_at":"2026-10-03T23:59:30"});
    assert!(serde_json::from_value::<ReceiveDeviceAudioReq>(request).is_err());
}

#[tokio::test]
#[serial_test::serial]
async fn audio_probe_counts_decoded_samples_when_mp3_rate_changes() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let directory = tempfile::tempdir().unwrap();
    let mut source = Vec::new();
    for rate in ["44100", "48000"] {
        let path = directory.path().join(format!("{rate}.mp3"));
        let result = tokio::process::Command::new("ffmpeg")
            .args(["-v", "error", "-f", "lavfi", "-i"])
            .arg(format!("sine=frequency=440:sample_rate={rate}"))
            .args([
                "-t",
                "1",
                "-c:a",
                "libmp3lame",
                "-write_xing",
                "0",
                "-id3v2_version",
                "0",
            ])
            .arg(&path)
            .output()
            .await
            .unwrap();
        assert!(result.status.success());
        source.extend(tokio::fs::read(path).await.unwrap());
    }
    let source_path = directory.path().join("mixed-rates.mp3");
    tokio::fs::write(&source_path, source).await.unwrap();
    let sample_rate = i64::from(
        media_metadata(&source_path)
            .await
            .unwrap()
            .first("audio")
            .unwrap()
            .sample_rate()
            .unwrap(),
    );
    let decoded = tokio::process::Command::new("ffmpeg")
        .args([
            "-v",
            "error",
            "-nostdin",
            "-xerror",
            "-err_detect",
            "explode",
            "-i",
        ])
        .arg(&source_path)
        .args(["-map", "0:a:0", "-c:a", "pcm_s16le", "-ar"])
        .arg(sample_rate.to_string())
        .args(["-ac", "1", "-f", "s16le", "pipe:1"])
        .output()
        .await
        .unwrap();
    assert!(decoded.status.success());
    let samples = i64::try_from(decoded.stdout.len() / 2).unwrap();
    let expected_us = (samples * 1_000_000 + sample_rate / 2) / sample_rate;
    let start = "2026-10-03T23:59:30Z".parse().unwrap();
    let audio = probe(&env.device_audio, &source_path, start).await.unwrap();
    assert_eq!(audio.duration_us, expected_us, "duration must count every decoded packet even after filter reinitialization");
}
