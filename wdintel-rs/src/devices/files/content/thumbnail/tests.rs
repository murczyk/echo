use super::*;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tokio::sync::Notify;

fn key(revision: i64) -> Key {
    Key::new(
        (Uuid::nil(), Uuid::nil(), revision),
        &PublishedContent {
            name: "fixture.png".to_owned(),
            extension: Some("png".to_owned()),
            mime_type: Some("image/png".to_owned()),
            object_key: "source".to_owned(),
            source_sha256: vec![0; 32],
            source_size_bytes: 8,
            is_encrypted: false,
        },
        true,
    )
}

fn cache(root: &Path, jobs: usize) -> Arc<cache::Cache> {
    cache::Cache::new(
        root.to_owned(),
        cache::Limits {
            max_bytes: DEVICE_FILE_THUMBNAIL_MAX_BYTES,
            max_entries: 2,
            free_bytes: 0,
            idle: Duration::from_secs(60),
            jobs,
        },
    )
    .unwrap()
}

#[tokio::test]
async fn thumbnail_cache_initialization_cannot_race_namespace_cleanup() {
    let root = tempfile::tempdir().unwrap();
    let janitor =
        std::fs::File::create(root.path().join("janitor.lock")).unwrap();
    fs2::FileExt::lock_exclusive(&janitor).unwrap();
    let path = root.path().to_owned();
    let started = Arc::new(Notify::new());
    let initializing = started.clone();
    let mut task = tokio::task::spawn_blocking(move || {
        initializing.notify_one();
        cache(&path, 1)
    });
    started.notified().await;
    assert!(tokio::time::timeout(Duration::from_millis(50), &mut task)
        .await
        .is_err());
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1, "no namespace may be visible before initialization owns the janitor lock");
    drop(janitor);
    let initialized = task.await.unwrap();
    let sibling = cache(root.path(), 1);
    initialized.request(key(1), None, |path| async move {
        tokio::fs::write(path, b"complete").await.unwrap();
        Ok(8)
    });
    let entry = ready(&initialized, key(1)).await;
    assert_eq!(std::fs::read(entry.path()).unwrap(), b"complete");
    drop(sibling);
}

async fn ready(cache: &Arc<cache::Cache>, key: Key) -> Arc<cache::Entry> {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let cache::Lookup::Ready(entry) =
                cache.request(key, None, |_| async {
                    panic!("must reuse existing job")
                })
            {
                return entry;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn thumbnail_cache_single_flight_and_capacity_preserve_readers() {
    let root = tempfile::tempdir().unwrap();
    let cache = cache(root.path(), 1);
    let started = Arc::new(Notify::new());
    let released = Arc::new(Notify::new());
    let invocations = Arc::new(AtomicUsize::new(0));
    let job_started = started.clone();
    let job_released = released.clone();
    let job_invocations = invocations.clone();
    assert!(matches!(
        cache.request(key(1), None, move |path| async move {
            job_invocations.fetch_add(1, Ordering::Relaxed);
            job_started.notify_one();
            job_released.notified().await;
            tokio::fs::write(path, b"jpeg").await.unwrap();
            Ok(4)
        }),
        cache::Lookup::Pending
    ));
    started.notified().await;
    assert!(matches!(
        cache.request(key(1), None, |_| async {
            panic!("duplicate generation")
        }),
        cache::Lookup::Pending
    ));
    assert!(matches!(
        cache.request(key(2), None, |_| async {
            panic!("capacity must be checked before source read")
        }),
        cache::Lookup::Failed(Failure::Transient)
    ));
    released.notify_one();
    let first = ready(&cache, key(1)).await;
    assert_eq!(invocations.load(Ordering::Relaxed), 1);
    assert!(matches!(
        cache.request(key(2), None, |_| async {
            panic!("live lease must not be evicted")
        }),
        cache::Lookup::Failed(Failure::Transient)
    ));
    let first_path = first.path().to_owned();
    drop(first);
    assert!(matches!(
        cache.request(key(2), None, |path| async move {
            tokio::fs::write(path, b"different").await.unwrap();
            Ok(9)
        }),
        cache::Lookup::Pending
    ));
    let second = ready(&cache, key(2)).await;
    assert_eq!(std::fs::read(second.path()).unwrap(), b"different");
    assert!(!first_path.exists());
}

#[tokio::test]
async fn thumbnail_cache_does_not_share_actor_access_failure() {
    let root = tempfile::tempdir().unwrap();
    let cache = cache(root.path(), 2);
    assert!(matches!(
        cache.request(key(1), None, |_| async { Err(Failure::Access) }),
        cache::Lookup::Pending
    ));
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(matches!(
        cache.request(key(1), None, |path| async move {
            tokio::fs::write(path, b"allowed").await.unwrap();
            Ok(7)
        }),
        cache::Lookup::Pending
    ));
    assert_eq!(
        std::fs::read(ready(&cache, key(1)).await.path()).unwrap(),
        b"allowed"
    );
}

#[tokio::test]
async fn thumbnail_cache_cools_down_decoder_failure_and_removes_partial_output()
{
    let root = tempfile::tempdir().unwrap();
    let cache = cache(root.path(), 2);
    let output = Arc::new(Mutex::new(None));
    let job_output = output.clone();
    cache.request(key(1), None, move |path| async move {
        *job_output.lock().unwrap() = Some(path.clone());
        tokio::fs::write(path, b"incomplete").await.unwrap();
        Err(Failure::Terminal)
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if matches!(
                cache.request(key(1), None, |_| async {
                    panic!("terminal failure must be cached")
                }),
                cache::Lookup::Failed(Failure::Terminal)
            ) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert!(!output.lock().unwrap().as_ref().unwrap().exists());
}

#[tokio::test]
async fn thumbnail_generator_decodes_bounded_image_and_rejects_playlist() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let output = root.path().join("thumbnail.jpg");
    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(1280, 80)
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    tokio::fs::write(&source, png.into_inner()).await.unwrap();
    let options = crate::thumbnail::Options {
        binary: DEVICE_FILE_THUMBNAIL_FFMPEG_BIN,
        filter: DEVICE_FILE_THUMBNAIL_IMAGE_FILTER,
        timeout: Duration::from_secs(10),
        max_bytes: Some(DEVICE_FILE_THUMBNAIL_MAX_BYTES),
        local_media_only: true,
    };
    crate::thumbnail::generate(&source, &output, &options)
        .await
        .unwrap();
    let jpeg = read_jpeg(&output).await.unwrap();
    let decoded = image::load_from_memory(&jpeg).unwrap();
    assert_eq!((decoded.width(), decoded.height()), (640, 40));
    tokio::fs::remove_file(&output).await.unwrap();
    tokio::fs::write(&source, b"#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://127.0.0.1:9/private.ts\n#EXT-X-ENDLIST\n").await.unwrap();
    assert!(crate::thumbnail::generate(&source, &output, &options)
        .await
        .is_err());
    assert!(!output.exists());
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
}

#[tokio::test]
async fn thumbnail_generator_cleans_missing_binary_and_kills_timed_out_process()
{
    use std::os::unix::fs::PermissionsExt;

    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let output = root.path().join("thumbnail.jpg");
    tokio::fs::write(&source, b"source").await.unwrap();
    let executable = root.path().join("decoder");
    let options = crate::thumbnail::Options {
        binary: executable.to_str().unwrap(),
        filter: DEVICE_FILE_THUMBNAIL_IMAGE_FILTER,
        timeout: Duration::from_secs(5),
        max_bytes: Some(DEVICE_FILE_THUMBNAIL_MAX_BYTES),
        local_media_only: true,
    };
    let missing = crate::thumbnail::generate(&source, &output, &options)
        .await
        .unwrap_err();
    assert_eq!(
        missing.downcast_ref::<std::io::Error>().unwrap().kind(),
        std::io::ErrorKind::NotFound
    );
    assert!(!output.exists());
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);

    tokio::fs::write(
        &executable,
        b"#!/bin/sh\nprintf '%s' \"$$\" > \"$0.pid\"\nfor output in \"$@\"; do :; done\nprintf partial > \"$output\"\nexec /bin/sleep 60\n",
    )
    .await
    .unwrap();
    tokio::fs::set_permissions(
        &executable,
        std::fs::Permissions::from_mode(0o700),
    )
    .await
    .unwrap();
    let timed_out = crate::thumbnail::generate(&source, &output, &options)
        .await
        .unwrap_err();
    assert!(timed_out
        .downcast_ref::<tokio::time::error::Elapsed>()
        .is_some());
    let pid: libc::pid_t =
        tokio::fs::read_to_string(executable.with_extension("pid"))
            .await
            .unwrap()
            .parse()
            .unwrap();
    let terminated = tokio::time::timeout(Duration::from_secs(2), async {
        while unsafe { libc::kill(pid, 0) } == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await;
    if terminated.is_err() {
        unsafe { libc::kill(pid, libc::SIGKILL) };
    }
    assert!(terminated.is_ok(), "decoder must be terminated on timeout");
    assert!(!output.exists());
    assert!(std::fs::read_dir(root.path()).unwrap().all(|entry| {
        !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".tmp-")
    }));
}
