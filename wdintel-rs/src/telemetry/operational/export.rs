use std::collections::BTreeMap;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use opentelemetry::metrics::{Counter, Meter};
use opentelemetry::KeyValue;

use crate::config::*;

#[derive(Clone, Copy)]
enum Value {
    Integer(u64),
    Float(f64),
}

struct Point {
    name: &'static str,
    value: Value,
    labels: Vec<KeyValue>,
}

#[derive(Default)]
pub(crate) struct Snapshot {
    points: Vec<Point>,
}

impl Snapshot {
    pub(crate) fn integer(
        &mut self,
        name: &'static str,
        value: u64,
        labels: &[KeyValue],
    ) {
        self.points.push(Point {
            name,
            value: Value::Integer(value),
            labels: labels.to_vec(),
        });
    }

    pub(crate) fn float(
        &mut self,
        name: &'static str,
        value: f64,
        labels: &[KeyValue],
    ) {
        self.points.push(Point {
            name,
            value: Value::Float(value),
            labels: labels.to_vec(),
        });
    }
}

struct Source {
    updated: Instant,
    last_success: Option<f64>,
    snapshot: Option<Snapshot>,
}

type Sources = Arc<RwLock<BTreeMap<&'static str, Source>>>;

#[derive(Clone)]
pub(crate) struct Exporter {
    sources: Sources,
    pub(super) filesystem: Arc<super::collect::FilesystemProbe>,
    pub(crate) errors: Counter<u64>,
    pub(crate) report_timeouts: Counter<u64>,
}

impl Exporter {
    pub(crate) fn new(meter: &Meter) -> Self {
        let sources = Sources::default();
        for &(name, unit, description, integer) in OPERATIONAL_METRICS_GAUGES {
            if integer {
                let sources = sources.clone();
                meter
                    .u64_observable_gauge(name)
                    .with_unit(unit)
                    .with_description(description)
                    .with_callback(move |observer| {
                        observe(&sources, name, |value, labels| {
                            if let Value::Integer(value) = value {
                                observer.observe(value, labels);
                            }
                        });
                    })
                    .build();
            } else {
                let sources = sources.clone();
                meter
                    .f64_observable_gauge(name)
                    .with_unit(unit)
                    .with_description(description)
                    .with_callback(move |observer| {
                        observe(&sources, name, |value, labels| {
                            if let Value::Float(value) = value {
                                observer.observe(value, labels);
                            }
                        });
                    })
                    .build();
            }
        }
        let exporter = Self {
            sources,
            filesystem: Arc::default(),
            errors: meter
                .u64_counter(OPERATIONAL_METRICS_ERRORS)
                .with_unit("1")
                .with_description("Observed Signal REST API failures")
                .build(),
            report_timeouts: meter
                .u64_counter(OPERATIONAL_METRICS_REPORT_TIMEOUTS)
                .with_unit("1")
                .with_description("Report transitions to failed due to timeout")
                .build(),
        };
        for kind in OPERATIONAL_METRICS_REPORT_KINDS
            .iter()
            .copied()
            .chain(std::iter::once(OPERATIONAL_METRICS_UNKNOWN_REPORT_KIND))
        {
            exporter.report_timeouts.add(0, &report_labels(kind));
        }
        exporter
    }

    pub(crate) fn record_report_timeout(&self, kind: &str) {
        let kind = OPERATIONAL_METRICS_REPORT_KINDS
            .iter()
            .copied()
            .find(|known| *known == kind)
            .unwrap_or(OPERATIONAL_METRICS_UNKNOWN_REPORT_KIND);
        self.report_timeouts.add(1, &report_labels(kind));
    }

    pub(crate) fn publish(
        &self,
        source: &'static str,
        timestamp: i64,
        result: anyhow::Result<Snapshot>,
    ) {
        self.publish_all(timestamp, [(source, result)]);
    }

    pub(super) fn publish_all(
        &self,
        timestamp: i64,
        results: impl IntoIterator<Item = (&'static str, anyhow::Result<Snapshot>)>,
    ) {
        let mut sources = self
            .sources
            .write()
            .expect("operational snapshot lock available");
        for (source, result) in results {
            let previous = sources
                .get(source)
                .and_then(|previous| previous.last_success);
            let (snapshot, last_success) = match result {
                Ok(snapshot) => {
                    (Some(snapshot), Some(timestamp as f64 / 1_000.0))
                }
                Err(error) => {
                    log::warn!("Operational metrics source={source} unavailable: {error:#}");
                    (None, previous)
                }
            };
            sources.insert(
                source,
                Source {
                    updated: Instant::now(),
                    last_success,
                    snapshot,
                },
            );
        }
    }
}

fn report_labels(kind: &'static str) -> [KeyValue; 2] {
    [
        KeyValue::new("report_kind", kind),
        KeyValue::new("process", super::process()),
    ]
}

fn observe(
    sources: &Sources,
    name: &str,
    mut emit: impl FnMut(Value, &[KeyValue]),
) {
    let sources = sources.read().expect("operational snapshot lock available");
    for (&source, state) in sources.iter() {
        let labels = [KeyValue::new("source", source)];
        let snapshot = state.snapshot.as_ref().filter(|_| {
            state.updated.elapsed()
                < Duration::from_secs(OPERATIONAL_METRICS_MAX_AGE_SECS)
                && state.last_success.is_some_and(|timestamp| {
                    chrono::Utc::now().timestamp_millis() as f64 / 1_000.0
                        - timestamp
                        < OPERATIONAL_METRICS_MAX_AGE_SECS as f64
                })
        });
        if name == OPERATIONAL_METRICS_AVAILABLE {
            emit(Value::Integer(u64::from(snapshot.is_some())), &labels);
        } else if name == OPERATIONAL_METRICS_UPDATED_AT {
            if let Some(timestamp) = state.last_success {
                emit(Value::Float(timestamp), &labels);
            }
        } else if let Some(snapshot) = snapshot {
            for point in
                snapshot.points.iter().filter(|point| point.name == name)
            {
                let mut attributes = labels.to_vec();
                attributes.extend_from_slice(&point.labels);
                emit(point.value, &attributes);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // https://github.com/echoua/echo/issues/4034
    #[test]
    fn operational_stalled_collector_expires_even_if_wall_clock_moves_back() {
        let config =
            crate::config::read_config(crate::types::Mode::Test).unwrap();
        let (metrics, recorder) = crate::telemetry::Metrics::recording(&config);
        let mut snapshot = Snapshot::default();
        snapshot.integer(OPERATIONAL_METRICS_ROOT_BYTES, 42, &[]);
        metrics.operational.publish(
            "filesystem",
            chrono::Utc::now().timestamp_millis() + 3_600_000,
            Ok(snapshot),
        );
        metrics
            .operational
            .sources
            .write()
            .unwrap()
            .get_mut("filesystem")
            .unwrap()
            .updated = Instant::now()
            - Duration::from_secs(OPERATIONAL_METRICS_MAX_AGE_SECS);
        metrics.force_flush_for_test();
        assert!(recorder.find(OPERATIONAL_METRICS_ROOT_BYTES).is_none());
        assert_eq!(
            recorder.gauge_value(OPERATIONAL_METRICS_AVAILABLE, &[]),
            Some(0)
        );
    }
}
