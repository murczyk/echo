use super::*;
use serde_json::Value;

#[tokio::test]
async fn segments_preserve_seek_timestamps_and_decode_with_audio() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source.mp4");
    let status = Command::new(MESSENGER_MEDIA_LOCAL_CACHE_FFMPEG_BIN)
        .args([
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=1920x1080:rate=30",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=44100",
            "-t",
            "6.2",
            "-c:v",
            "libx264",
            "-threads",
            "2",
            "-preset",
            "ultrafast",
            "-g",
            "120",
            "-c:a",
            "aac",
        ])
        .arg(&source)
        .status()
        .await
        .unwrap();
    assert!(status.success());

    let entry = cache::Entry::for_test(directory.path());
    render_window(source.clone().into_os_string(), &entry, 3, 4, 6.2)
        .await
        .unwrap();
    render_window(source.clone().into_os_string(), &entry, 0, 3, 6.2)
        .await
        .unwrap();
    let mut segments = Vec::new();
    for index in 0..7 {
        let (start, length) = segment_bounds(index, 6.2).unwrap();
        let path = entry.path(&format!("{index}.ts"));
        let output = Command::new(MESSENGER_MEDIA_LOCAL_CACHE_FFPROBE_BIN)
            .args([
                "-v",
                "error",
                "-show_streams",
                "-show_packets",
                "-of",
                "json",
            ])
            .arg(&path)
            .output()
            .await
            .unwrap();
        assert!(output.status.success());
        let probe: Value = serde_json::from_slice(&output.stdout).unwrap();
        let streams = probe["streams"].as_array().unwrap();
        assert_eq!(streams[0]["width"], 1280);
        assert_eq!(streams[0]["height"], 720);
        assert_eq!(streams[1]["codec_name"], "aac");
        let video_packets: Vec<_> = probe["packets"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|packet| packet["codec_type"] == "video")
            .collect();
        let pts: f64 = video_packets[0]["pts_time"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap();
        assert!((pts - start).abs() < 0.05, "{index}: {pts} != {start}");
        assert!(video_packets[0]["flags"].as_str().unwrap().contains('K'));
        assert!((video_packets.len() as f64 - length * 30.0).abs() <= 1.0);
        segments.push((index, path));
    }
    segments.sort_by_key(|(index, _)| *index);
    let joined = directory.path().join("joined.ts");
    let mut bytes = Vec::new();
    for (_, path) in segments {
        bytes.extend(fs::read(path).await.unwrap());
    }
    fs::write(&joined, bytes).await.unwrap();
    let output = Command::new(MESSENGER_MEDIA_LOCAL_CACHE_FFMPEG_BIN)
        .args(["-v", "error", "-i"])
        .arg(joined)
        .args(["-f", "null", "-"])
        .output()
        .await
        .unwrap();
    assert!(output.status.success());
    assert!(
        output.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(segment_bounds(7, 6.2).is_none());
}

#[tokio::test]
async fn preview_worker_slots_are_bounded_across_requests() {
    let directory = tempfile::tempdir().unwrap();
    let entry = cache::Entry::for_test(directory.path());
    let first = entry.slot().await.unwrap().unwrap();
    let second = entry.slot().await.unwrap().unwrap();
    assert!(entry.slot().await.unwrap().is_none());
    drop(first);
    assert!(entry.slot().await.unwrap().is_some());
    drop(second);
}

#[tokio::test]
async fn cleanup_tolerates_finished_preview_jobs() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().to_owned();
    let entry = cache::Entry::for_test(&root);
    let jobs = tokio::spawn(async move {
        for _ in 0..20 {
            for index in 0..32 {
                fs::create_dir(root.join(format!("{index}.work")))
                    .await
                    .unwrap();
            }
            for index in 0..32 {
                fs::remove_dir(root.join(format!("{index}.work")))
                    .await
                    .unwrap();
            }
        }
    });
    while !jobs.is_finished() {
        entry.prepare_space(0).await.unwrap();
    }
    jobs.await.unwrap();
}

#[tokio::test]
async fn disk_pressure_reclaims_previews_before_rejecting_generation() {
    let directory = tempfile::tempdir().unwrap();
    let entry = cache::Entry::for_test(directory.path());
    let segment = entry.path("0.ts");
    fs::write(&segment, b"cached preview").await.unwrap();

    let min_free = fs2::total_space(directory.path()).unwrap();
    let error = entry.prepare_space(min_free).await.unwrap_err();
    assert!(error.to_string().contains("free-space floor"));
    assert!(!segment.exists());
}
