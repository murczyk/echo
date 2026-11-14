use crate::{h, types::ShortContext};
use serde::Serialize;
use std::{
    collections::HashMap,
    fmt,
    future::Future,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::Notify;

#[derive(Debug, Clone)]
struct SharedFailure(Arc<anyhow::Error>);
impl fmt::Display for SharedFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.0, f)
    }
}

impl std::error::Error for SharedFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.0.as_ref().as_ref())
    }
}

enum Outcome<T> {
    Finished(Result<Arc<T>, SharedFailure>),
    Cancelled,
}
struct Flight<T> {
    outcome: Mutex<Option<Outcome<T>>>,
    changed: Notify,
}
struct Entry<T> {
    value: Arc<T>,
    completed: Instant,
}
struct State<T> {
    entries: HashMap<String, Entry<T>>,
    flights: HashMap<String, Arc<Flight<T>>>,
}

pub(super) struct Cache<T> {
    state: Mutex<State<T>>,
    ttl: Duration,
    capacity: usize,
    max_bytes: usize,
}

struct Leader<'a, T> {
    cache: &'a Cache<T>,
    key: String,
    flight: Arc<Flight<T>>,
    completed: bool,
}

impl<T> Drop for Leader<'_, T> {
    fn drop(&mut self) {
        if self.completed {
            return;
        }
        let mut state = self
            .cache
            .state
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        state.flights.remove(&self.key);
        *self
            .flight
            .outcome
            .lock()
            .unwrap_or_else(|err| err.into_inner()) = Some(Outcome::Cancelled);
        self.flight.changed.notify_waiters();
    }
}

impl<T: Serialize> Cache<T> {
    pub fn new(ttl: Duration, capacity: usize, max_bytes: usize) -> Self {
        Self {
            state: Mutex::new(State {
                entries: HashMap::new(),
                flights: HashMap::new(),
            }),
            ttl,
            capacity,
            max_bytes,
        }
    }

    fn lookup(&self, key: &str) -> Lookup<T> {
        let mut state =
            self.state.lock().unwrap_or_else(|err| err.into_inner());
        state
            .entries
            .retain(|_, entry| entry.completed.elapsed() < self.ttl);
        if let Some(entry) = state.entries.get(key) {
            return Lookup::Hit(entry.value.clone());
        }
        if let Some(flight) = state.flights.get(key) {
            return Lookup::Follower(flight.clone());
        }
        if state.entries.len() + state.flights.len() >= self.capacity {
            let oldest = state
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.completed)
                .map(|(key, _)| key.clone());
            if let Some(oldest) = oldest {
                state.entries.remove(&oldest);
            }
        }
        if state.entries.len() + state.flights.len() >= self.capacity {
            return Lookup::Bypass;
        }
        let flight = Arc::new(Flight {
            outcome: Mutex::new(None),
            changed: Notify::new(),
        });
        state.flights.insert(key.to_string(), flight.clone());
        Lookup::Leader(flight)
    }

    async fn compute<Fut>(
        &self,
        key: String,
        flight: Arc<Flight<T>>,
        compute: Fut,
    ) -> anyhow::Result<(Arc<T>, &'static str)>
    where
        Fut: Future<Output = anyhow::Result<T>>,
    {
        let mut guard = Leader {
            cache: self,
            key: key.clone(),
            flight: flight.clone(),
            completed: false,
        };
        let result = compute
            .await
            .map(Arc::new)
            .map_err(|error| SharedFailure(Arc::new(error)));
        let cacheable = match &result {
            Ok(value) => {
                serde_json::to_vec(value.as_ref()).c(h!())?.len()
                    <= self.max_bytes
            }
            Err(_) => false,
        };
        let mut state =
            self.state.lock().unwrap_or_else(|err| err.into_inner());
        if cacheable {
            if let Ok(value) = &result {
                state.entries.insert(
                    key.clone(),
                    Entry {
                        value: value.clone(),
                        completed: Instant::now(),
                    },
                );
            }
        }
        state.flights.remove(&key);
        *flight.outcome.lock().unwrap_or_else(|err| err.into_inner()) =
            Some(Outcome::Finished(result.clone()));
        guard.completed = true;
        flight.changed.notify_waiters();
        result
            .map(|value| (value, "miss"))
            .map_err(anyhow::Error::new)
    }

    pub async fn get<F, Fut>(
        &self,
        key: String,
        compute: F,
    ) -> anyhow::Result<(Arc<T>, &'static str)>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = anyhow::Result<T>>,
    {
        let mut compute = Some(compute);
        loop {
            match self.lookup(&key) {
                Lookup::Hit(value) => return Ok((value, "hit")),
                Lookup::Bypass => {
                    return Ok((
                        Arc::new(compute.take().c(h!())?().await.c(h!())?),
                        "bypass",
                    ))
                }
                Lookup::Leader(flight) => {
                    return self
                        .compute(key, flight, compute.take().c(h!())?())
                        .await
                }
                Lookup::Follower(flight) => {
                    if let Some(result) = flight.wait().await {
                        return result
                            .map(|value| (value, "wait"))
                            .map_err(anyhow::Error::new);
                    }
                }
            }
        }
    }
}

enum Lookup<T> {
    Hit(Arc<T>),
    Leader(Arc<Flight<T>>),
    Follower(Arc<Flight<T>>),
    Bypass,
}

impl<T> Flight<T> {
    async fn wait(&self) -> Option<Result<Arc<T>, SharedFailure>> {
        loop {
            let changed = self.changed.notified();
            {
                let outcome =
                    self.outcome.lock().unwrap_or_else(|err| err.into_inner());
                match outcome.as_ref() {
                    Some(Outcome::Finished(result)) => {
                        return Some(result.clone())
                    }
                    Some(Outcome::Cancelled) => return None,
                    None => {}
                }
            }
            changed.await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::sync::oneshot;

    fn cache(capacity: usize, max_bytes: usize) -> Arc<Cache<String>> {
        Arc::new(Cache::new(Duration::from_secs(5), capacity, max_bytes))
    }

    #[tokio::test]
    async fn issue_3873_coalesces_concurrent_success_and_does_not_cache_errors()
    {
        let cache = cache(8, 1024);
        let calls = AtomicUsize::new(0);
        let requests = (0..20).map(|_| {
            cache.get("same".into(), || async {
                calls.fetch_add(1, Ordering::SeqCst);
                tokio::task::yield_now().await;
                Ok("result".into())
            })
        });
        let results = futures::future::join_all(requests).await;
        assert!(results
            .into_iter()
            .all(|result| result.unwrap().0.as_str() == "result"));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        for _ in 0..2 {
            assert!(cache
                .get("error".into(), || async {
                    calls.fetch_add(1, Ordering::SeqCst);
                    anyhow::bail!("failed")
                })
                .await
                .is_err());
        }
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn issue_3873_cancelled_leader_releases_waiters_and_capacity() {
        let cache = cache(1, 1024);
        let (started, ready) = oneshot::channel();
        let leader_cache = cache.clone();
        let leader = tokio::spawn(async move {
            leader_cache
                .get("same".into(), || async {
                    started.send(()).unwrap();
                    std::future::pending::<anyhow::Result<String>>().await
                })
                .await
        });
        ready.await.unwrap();
        let follower =
            cache.get("same".into(), || async { Ok("replacement".into()) });
        tokio::pin!(follower);
        assert!(futures::poll!(&mut follower).is_pending());
        let bypass = cache
            .get("other".into(), || async { Ok("uncached".into()) })
            .await
            .unwrap();
        assert_eq!(bypass.1, "bypass");
        leader.abort();
        assert!(leader.await.unwrap_err().is_cancelled());
        let response = tokio::time::timeout(Duration::from_secs(1), follower)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(response.0.as_str(), "replacement");
        assert_eq!(response.1, "miss");
        assert!(cache.state.lock().unwrap().flights.is_empty());
    }

    #[tokio::test]
    async fn issue_3873_cancelled_follower_does_not_cancel_the_leader() {
        let cache = cache(1, 1024);
        let (release, released) = oneshot::channel();
        let leader = cache.get("same".into(), || async {
            released.await.unwrap();
            Ok("leader".into())
        });
        tokio::pin!(leader);
        assert!(futures::poll!(&mut leader).is_pending());
        {
            let follower = cache.get("same".into(), || async {
                panic!("follower became leader")
            });
            tokio::pin!(follower);
            assert!(futures::poll!(&mut follower).is_pending());
        }
        release.send(()).unwrap();
        assert_eq!(leader.await.unwrap().0.as_str(), "leader");
        assert_eq!(
            cache
                .get("same".into(), || async {
                    panic!("completed result was not retained")
                })
                .await
                .unwrap()
                .1,
            "hit"
        );
    }

    #[tokio::test]
    async fn issue_3873_expiry_is_not_renewed_and_oversized_values_are_not_kept(
    ) {
        let cache = Cache::new(Duration::from_millis(30), 1, 8);
        cache
            .get("key".into(), || async { Ok("small".to_string()) })
            .await
            .unwrap();
        let completed = cache.state.lock().unwrap().entries["key"].completed;
        assert_eq!(
            cache
                .get("key".into(), || async { panic!("cache hit") })
                .await
                .unwrap()
                .1,
            "hit"
        );
        assert_eq!(
            cache.state.lock().unwrap().entries["key"].completed,
            completed
        );
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert_eq!(
            cache
                .get("key".into(), || async { Ok("new".into()) })
                .await
                .unwrap()
                .1,
            "miss"
        );
        for _ in 0..2 {
            assert_eq!(
                cache
                    .get("large".into(), || async {
                        Ok("larger than eight bytes".into())
                    })
                    .await
                    .unwrap()
                    .1,
                "miss"
            );
        }
        assert!(cache.state.lock().unwrap().entries.is_empty());
    }
}
