use super::*;
use std::sync::Arc;

fn headers(value: &str) -> header::HeaderMap {
    let mut headers = header::HeaderMap::new();
    headers.insert(header::RETRY_AFTER, value.parse().unwrap());
    headers
}

#[test]
fn parses_provider_retry_after_headers() {
    let now = "2026-10-23T09:00:00Z".parse::<DateTime<Utc>>().unwrap();
    for (value, seconds) in [
        ("120", 120),
        ("Fri, 23 Oct 2026 09:01:30 GMT", 90),
        ("Fri, 23 Oct 2026 08:59:00 GMT", 0),
        ("invalid", 60),
    ] {
        assert_eq!(
            retry_after(&headers(value), now),
            Duration::from_secs(seconds),
            "{value}"
        );
    }
    assert_eq!(
        retry_after(&header::HeaderMap::new(), now),
        Duration::from_secs(60)
    );
}

#[tokio::test(start_paused = true)]
async fn concurrent_callers_wait_for_the_longest_provider_cooldown() {
    let cooldown = Arc::new(GlmCooldown::default());
    let engine_id = Uuid::new_v4();
    let started = Instant::now();
    cooldown
        .observe(
            engine_id,
            StatusCode::TOO_MANY_REQUESTS,
            &header::HeaderMap::new(),
        )
        .await
        .unwrap();
    let waiters: Vec<_> = (0..2)
        .map(|_| {
            let cooldown = cooldown.clone();
            tokio::spawn(async move { cooldown.wait(engine_id).await })
        })
        .collect();
    tokio::time::advance(Duration::from_secs(30)).await;
    for seconds in [90, 10] {
        cooldown
            .observe(
                engine_id,
                StatusCode::TOO_MANY_REQUESTS,
                &headers(&seconds.to_string()),
            )
            .await
            .unwrap();
    }
    tokio::time::advance(Duration::from_secs(89)).await;
    tokio::task::yield_now().await;
    assert!(waiters.iter().all(|waiter| !waiter.is_finished()));
    tokio::time::advance(Duration::from_secs(1)).await;
    for waiter in waiters {
        waiter.await.unwrap();
    }
    assert_eq!(started.elapsed(), Duration::from_secs(120));
}

#[tokio::test(start_paused = true)]
async fn cooldown_isolates_engines_and_survives_cancelled_waiters() {
    let cooldown = GlmCooldown::default();
    let engine_id = Uuid::new_v4();
    cooldown
        .observe(engine_id, StatusCode::TOO_MANY_REQUESTS, &headers("60"))
        .await
        .unwrap();
    let started = Instant::now();
    cooldown.wait(Uuid::new_v4()).await;
    assert_eq!(started.elapsed(), Duration::ZERO);
    cooldown
        .observe(engine_id, StatusCode::OK, &header::HeaderMap::new())
        .await
        .unwrap();
    assert!(tokio::time::timeout(
        Duration::from_secs(10),
        cooldown.wait(engine_id)
    )
    .await
    .is_err());
    cooldown.wait(engine_id).await;
    assert_eq!(started.elapsed(), Duration::from_secs(60));
    assert!(cooldown.retry_at.lock().await.is_empty());
}
