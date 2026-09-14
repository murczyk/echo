use super::*;
use futures_util::TryStreamExt;
use serde_json::json;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Instant;

struct Fixture {
    directory: tempfile::TempDir,
    source: PathBuf,
    size: u64,
    digest: [u8; 32],
    storage: Operator,
    config: S3Config,
    strongbox_key: String,
    prefix: String,
    backend: String,
}

impl Fixture {
    fn new(size: u64) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.bin");
        let digest = write_source(&source, size);
        let backend = std::env::var("ECHO_UPLOAD_BENCH_BACKEND")
            .unwrap_or_else(|_| "fs".to_string());
        let config = storage_config(&backend);
        let storage = if backend == "s3" {
            build_s3_operator(&config).unwrap()
        } else {
            let root = directory.path().join("objects");
            let atomic = directory.path().join("atomic");
            Operator::new(
                opendal::services::Fs::default()
                    .root(root.to_str().unwrap())
                    .atomic_write_dir(atomic.to_str().unwrap()),
            )
            .unwrap()
            .finish()
        };
        Self {
            directory,
            source,
            size,
            digest,
            storage,
            config,
            strongbox_key: generate_strongbox_key_b64(),
            prefix: format!("upload-audit/{}", Uuid::new_v4()),
            backend,
        }
    }

    async fn upload(&self, mode: &str, key: &str) {
        let file = tokio::fs::File::open(&self.source).await.unwrap();
        match mode {
            "device-plaintext" => upload_device_content_plaintext(
                &self.storage,
                &self.config,
                key,
                file,
                self.size,
                &self.digest,
            )
            .await
            .unwrap(),
            "messenger-file" => upload_plaintext_file_to_s3_with_operator(
                &Some(self.storage.clone()),
                &self.config,
                key,
                file,
                self.size,
            )
            .await
            .unwrap(),
            "messenger-buffer" => upload_plaintext_to_s3_with_operator(
                &Some(self.storage.clone()),
                &self.config,
                key,
                tokio::fs::read(&self.source).await.unwrap(),
            )
            .await
            .unwrap(),
            "device-encrypted" | "messenger-encrypted" => {
                let data = tokio::fs::read(&self.source).await.unwrap();
                if mode == "device-encrypted" {
                    let expected_digest = self.digest;
                    let data = tokio::task::spawn_blocking(move || {
                        assert_eq!(
                            <[u8; 32]>::from(Sha256::digest(&data)),
                            expected_digest
                        );
                        data
                    })
                    .await
                    .unwrap();
                    upload_device_content_encrypted(
                        &self.storage,
                        &self.config,
                        &self.strongbox_key,
                        key,
                        data.into(),
                        None,
                    )
                    .await
                    .unwrap();
                } else {
                    upload_encrypted_to_s3_with_operator(
                        &Some(self.storage.clone()),
                        &self.config,
                        &self.strongbox_key,
                        key,
                        data.into(),
                    )
                    .await
                    .unwrap();
                }
            }
            _ => panic!("unknown benchmark mode"),
        }
    }

    async fn verify(
        &self,
        mode: &str,
        key: &str,
        verify_negatives: bool,
    ) -> u64 {
        let stored_size =
            self.storage.stat(key).await.unwrap().content_length();
        let mut digest = Sha256::new();
        if mode.ends_with("encrypted") {
            let ciphertext = self.storage.read(key).await.unwrap().to_vec();
            let strongbox_key = key_from_b64(&self.strongbox_key).unwrap();
            let strongbox = StaticStrongBox::new(
                strongbox_key.clone(),
                vec![strongbox_key],
            );
            let data = strongbox
                .decrypt(&ciphertext, aad(&self.config.bucket, key).as_bytes())
                .unwrap();
            assert_eq!(data.len() as u64, self.size);
            digest.update(data);
            if verify_negatives {
                assert!(strongbox
                    .decrypt(&ciphertext, aad("wrong-bucket", key).as_bytes())
                    .is_err());
                assert!(strongbox
                    .decrypt(
                        &ciphertext,
                        aad(&self.config.bucket, &format!("{key}-wrong"))
                            .as_bytes()
                    )
                    .is_err());
                for position in [0, ciphertext.len() / 2, ciphertext.len() - 1]
                {
                    let mut corrupted = ciphertext.clone();
                    corrupted[position] ^= 1;
                    assert!(strongbox
                        .decrypt(
                            &corrupted,
                            aad(&self.config.bucket, key).as_bytes()
                        )
                        .is_err());
                }
            }
        } else {
            assert_eq!(stored_size, self.size);
            let reader = self.storage.reader(key).await.unwrap();
            let mut stream = reader.into_bytes_stream(..).await.unwrap();
            while let Some(bytes) = stream.try_next().await.unwrap() {
                digest.update(bytes);
            }
        }
        assert_eq!(<[u8; 32]>::from(digest.finalize()), self.digest);
        self.storage.delete(key).await.unwrap();
        stored_size
    }
}

fn write_source(path: &Path, size: u64) -> [u8; 32] {
    let mut file = std::fs::File::create(path).unwrap();
    let mut digest = Sha256::new();
    let chunk: Vec<u8> = (0..1024 * 1024)
        .map(|index| ((index * 31 + index / 257) % 251) as u8)
        .collect();
    let mut remaining = size;
    while remaining > 0 {
        let length = remaining.min(chunk.len() as u64) as usize;
        file.write_all(&chunk[..length]).unwrap();
        digest.update(&chunk[..length]);
        remaining -= length as u64;
    }
    file.sync_all().unwrap();
    digest.finalize().into()
}

fn storage_config(backend: &str) -> S3Config {
    if backend == "s3" {
        let path = std::env::var("ECHO_UPLOAD_BENCH_S3_CONFIG").unwrap();
        let config: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let field = |name: &str| config[name].as_str().unwrap().to_string();
        S3Config {
            bucket: field("bucket"),
            endpoint: field("endpoint"),
            region: field("region"),
            access_key_id: field("access_key_id"),
            secret_access_key: field("secret_access_key"),
            prefix: String::new(),
        }
    } else {
        assert_eq!(backend, "fs");
        S3Config {
            bucket: "upload-audit-fs".to_string(),
            endpoint: String::new(),
            region: String::new(),
            access_key_id: String::new(),
            secret_access_key: String::new(),
            prefix: String::new(),
        }
    }
}

fn rss_bytes() -> u64 {
    if cfg!(target_os = "linux") {
        let mut status = String::new();
        std::fs::File::open("/proc/self/status")
            .unwrap()
            .read_to_string(&mut status)
            .unwrap();
        status
            .lines()
            .find(|line| line.starts_with("VmRSS:"))
            .unwrap()
            .split_whitespace()
            .nth(1)
            .unwrap()
            .parse::<u64>()
            .unwrap()
            * 1024
    } else {
        let output = std::process::Command::new("ps")
            .args(["-o", "rss=", "-p", &std::process::id().to_string()])
            .output()
            .unwrap();
        String::from_utf8(output.stdout)
            .unwrap()
            .trim()
            .parse::<u64>()
            .unwrap()
            * 1024
    }
}

fn env_number(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .map(|value| value.parse().unwrap())
        .unwrap_or(default)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "explicit upload audit with isolated filesystem or disposable S3"]
async fn audit_upload_size_scaling() {
    let mode = std::env::var("ECHO_UPLOAD_BENCH_MODE")
        .unwrap_or_else(|_| "device-plaintext".to_string());
    let modes: Vec<String> = mode.split(',').map(str::to_owned).collect();
    let size = env_number("ECHO_UPLOAD_BENCH_SIZE_BYTES", 8 * 1024 * 1024);
    let concurrency = env_number("ECHO_UPLOAD_BENCH_CONCURRENCY", 1) as usize;
    let repetitions = env_number("ECHO_UPLOAD_BENCH_REPETITIONS", 3);
    assert!((1..=16).contains(&concurrency));
    assert!(size <= crate::config::DEVICE_FILE_CONTENT_UPLOAD_MAX_BYTES);
    let fixture = Arc::new(Fixture::new(size));
    let mut verified_negative_modes = std::collections::HashSet::new();
    for repetition in 0..repetitions {
        let stopped = Arc::new(AtomicBool::new(false));
        let initial_rss = rss_bytes();
        let peak_rss = Arc::new(AtomicU64::new(initial_rss));
        let sample_count = Arc::new(AtomicU64::new(0));
        let sampler = {
            let stopped = stopped.clone();
            let peak_rss = peak_rss.clone();
            let sample_count = sample_count.clone();
            std::thread::spawn(move || {
                while !stopped.load(Ordering::Relaxed) {
                    peak_rss.fetch_max(rss_bytes(), Ordering::Relaxed);
                    sample_count.fetch_add(1, Ordering::Relaxed);
                    std::thread::sleep(Duration::from_millis(10));
                }
            })
        };
        let heartbeat_lag = Arc::new(AtomicU64::new(0));
        let heartbeat_count = Arc::new(AtomicU64::new(0));
        let heartbeat = {
            let lag = heartbeat_lag.clone();
            let count = heartbeat_count.clone();
            tokio::spawn(async move {
                loop {
                    let start = Instant::now();
                    tokio::time::sleep(Duration::from_millis(5)).await;
                    lag.fetch_max(
                        start
                            .elapsed()
                            .saturating_sub(Duration::from_millis(5))
                            .as_nanos() as u64,
                        Ordering::Relaxed,
                    );
                    count.fetch_add(1, Ordering::Relaxed);
                }
            })
        };
        let barrier = Arc::new(tokio::sync::Barrier::new(concurrency + 1));
        let completion_rank = Arc::new(AtomicU64::new(0));
        let mut uploads = Vec::new();
        for index in 0..concurrency {
            let fixture = fixture.clone();
            let mode = modes[index % modes.len()].clone();
            let completion_rank = completion_rank.clone();
            let barrier = barrier.clone();
            uploads.push(tokio::spawn(async move {
                let key = format!("{}/{repetition}/{index}", fixture.prefix);
                barrier.wait().await;
                let started = Instant::now();
                fixture.upload(&mode, &key).await;
                let latency_ms = started.elapsed().as_secs_f64() * 1000.0;
                let rank = completion_rank.fetch_add(1, Ordering::Relaxed);
                (key, latency_ms, mode, rank)
            }));
        }
        let started = Instant::now();
        barrier.wait().await;
        let mut completed = Vec::new();
        for upload in uploads {
            completed.push(upload.await.unwrap());
        }
        let elapsed = started.elapsed().as_secs_f64();
        stopped.store(true, Ordering::Relaxed);
        sampler.join().unwrap();
        heartbeat.abort();
        let latencies: Vec<f64> = completed
            .iter()
            .map(|(_, latency, _, _)| *latency)
            .collect();
        let outcomes: Vec<_> = completed.iter().map(|(_, latency, mode, rank)| {
            json!({"mode": mode, "latency_ms": latency, "completion_rank": rank})
        }).collect();
        let mut negative_checks = 0;
        let mut object_bytes = 0;
        for (key, _, upload_mode, _) in completed {
            let verify_negatives = upload_mode.ends_with("encrypted")
                && verified_negative_modes.insert(upload_mode.clone());
            negative_checks += usize::from(verify_negatives);
            object_bytes +=
                fixture.verify(&upload_mode, &key, verify_negatives).await;
        }
        println!(
            "UPLOAD_AUDIT_JSON {}",
            json!({
                "backend": fixture.backend,
                "mode": mode,
                "size_bytes": size,
                "concurrency": concurrency,
                "repetition": repetition,
                "runtime_workers": 2,
                "wall_ms": elapsed * 1000.0,
                "upload_latency_ms": latencies,
                "upload_outcomes": outcomes,
                "throughput_mib_s": size as f64 * concurrency as f64 / 1048576.0 / elapsed,
                "rss_baseline_bytes": initial_rss,
                "rss_peak_bytes": peak_rss.load(Ordering::Relaxed),
                "rss_delta_bytes": peak_rss.load(Ordering::Relaxed).saturating_sub(initial_rss),
                "rss_samples": sample_count.load(Ordering::Relaxed),
                "heartbeat_max_lag_ms": heartbeat_lag.load(Ordering::Relaxed) as f64 / 1000000.0,
                "heartbeat_samples": heartbeat_count.load(Ordering::Relaxed),
                "stored_bytes": object_bytes,
            "source_sha256": fixture.digest.iter().map(|byte| format!("{byte:02x}")).collect::<String>(),
                "integrity_verified": concurrency,
                "ciphertext_aad_negative_verified": negative_checks,
                "ciphertext_wrong_object_aad_negative_verified": negative_checks,
                "ciphertext_bit_flip_negative_verified": negative_checks * 3,
                "fixture_exists": fixture.directory.path().is_dir(),
            })
        );
    }
}

#[tokio::test]
#[ignore = "explicit fault audit with isolated filesystem or disposable S3"]
async fn audit_plaintext_stream_rejects_corrupt_sources() {
    let size =
        env_number("ECHO_UPLOAD_BENCH_FAULT_SIZE_BYTES", 8 * 1024 * 1024 + 1);
    assert!((1..=crate::config::DEVICE_FILE_CONTENT_UPLOAD_MAX_BYTES)
        .contains(&size));
    let fixture = Fixture::new(size);
    let cases = [
        ("digest", fixture.size, [0; 32]),
        ("short", fixture.size + 1, fixture.digest),
        ("long", fixture.size - 1, fixture.digest),
    ];
    for (name, size, digest) in cases {
        let key = format!("{}/{name}", fixture.prefix);
        let error = upload_device_content_plaintext(
            &fixture.storage,
            &fixture.config,
            &key,
            tokio::fs::File::open(&fixture.source).await.unwrap(),
            size,
            &digest,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, DeviceContentUploadError::Sha256Mismatch));
        assert_eq!(
            fixture.storage.stat(&key).await.unwrap_err().kind(),
            opendal::ErrorKind::NotFound
        );
        println!(
            "UPLOAD_FAULT_JSON {}",
            json!({
                "backend": fixture.backend, "case": name, "source_bytes": fixture.size,
                "sha256_mismatch": true, "uncommitted_object_absent": true,
            })
        );
    }
}
