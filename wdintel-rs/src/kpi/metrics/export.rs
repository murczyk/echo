use std::collections::BTreeMap;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use opentelemetry::{
    metrics::{AsyncInstrument, Meter},
    KeyValue,
};

use crate::config::*;
use crate::h;
use crate::types::ShortContext;

struct Point {
    name: &'static str,
    value: f64,
    attributes: Vec<KeyValue>,
}

#[derive(Default)]
pub(super) struct Snapshot {
    points: Vec<Point>,
}

impl Snapshot {
    pub(super) fn record(
        &mut self,
        name: &'static str,
        value: impl Into<f64>,
        attributes: &[KeyValue],
    ) {
        self.points.push(Point {
            name,
            value: value.into(),
            attributes: attributes.to_vec(),
        });
    }

    fn validate(&self) -> anyhow::Result<()> {
        let mut groups = BTreeMap::new();
        for point in &self.points {
            *groups.entry(point.name).or_insert(0) += 1;
            anyhow::ensure!(point.value.is_finite(), "Nonfinite KPI metric");
        }
        anyhow::ensure!(
            groups
                .values()
                .all(|count| *count <= KPI_METRICS_MAX_GROUPS),
            "KPI metric exceeds group limit"
        );
        Ok(())
    }
}

struct Source {
    updated: Instant,
    timestamp: f64,
    snapshot: Option<Snapshot>,
}

type Sources = BTreeMap<(&'static str, &'static str), Source>;

#[derive(Clone, Default)]
pub(crate) struct Exporter {
    sources: Arc<RwLock<Sources>>,
}

impl Exporter {
    pub(crate) fn new(meter: &Meter) -> Self {
        let exporter = Self::default();
        for &(name, unit, description) in KPI_METRICS_INSTRUMENTS {
            let sources = exporter.sources.clone();
            meter
                .f64_observable_gauge(name)
                .with_unit(unit)
                .with_description(description)
                .with_callback(move |observer| {
                    let sources =
                        sources.read().expect("KPI snapshot lock is available");
                    observe(&sources, name, observer);
                })
                .build();
        }
        exporter
    }

    pub(super) fn publish(
        &self,
        source: &'static str,
        window: &'static str,
        timestamp: i64,
        result: anyhow::Result<Option<Snapshot>>,
    ) {
        let result = result.and_then(|snapshot| {
            if let Some(snapshot) = &snapshot {
                snapshot.validate().c(h!())?;
            }
            Ok(snapshot)
        });
        let snapshot = match result {
            Ok(snapshot) => snapshot,
            Err(error) => {
                log::warn!(
                    "KPI metrics source={source} window={window}: {error:#}"
                );
                None
            }
        };
        self.sources
            .write()
            .expect("KPI snapshot lock is available")
            .insert(
                (source, window),
                Source {
                    updated: Instant::now(),
                    timestamp: timestamp as f64 / 1_000.0,
                    snapshot,
                },
            );
    }
}

fn observe(sources: &Sources, name: &str, observer: &dyn AsyncInstrument<f64>) {
    for (&(source, window), value) in sources {
        let labels = [
            KeyValue::new("source", source),
            KeyValue::new("window", window),
        ];
        let snapshot = value.snapshot.as_ref().filter(|_| {
            value.updated.elapsed()
                < Duration::from_secs(KPI_METRICS_MAX_AGE_SECS)
        });
        if name == KPI_METRICS_AVAILABLE {
            observer.observe(f64::from(snapshot.is_some()), &labels);
        } else if let Some(snapshot) = snapshot {
            if name == KPI_METRICS_UPDATED_AT {
                observer.observe(value.timestamp, &labels);
            }
            for point in
                snapshot.points.iter().filter(|point| point.name == name)
            {
                let mut attributes = labels.to_vec();
                attributes.extend_from_slice(&point.attributes);
                observer.observe(point.value, &attributes);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // https://github.com/echoua/echo/issues/3826
    #[test]
    fn failed_expired_and_replaced_snapshots_stop_exporting_previous_values() {
        let config =
            crate::config::read_config(crate::types::Mode::Test).unwrap();
        let (metrics, recorder) = crate::telemetry::Metrics::recording(&config);
        let mut snapshot = Snapshot::default();
        snapshot.record(
            KPI_METRICS_REPORT_DURATION,
            12.0,
            &[KeyValue::new("statistic", "p90")],
        );
        metrics
            .kpi
            .publish("reports", "7d", 1_000, Ok(Some(snapshot)));
        metrics.force_flush_for_test();
        assert_eq!(
            recorder.gauge_f64_value(KPI_METRICS_REPORT_DURATION, &[]),
            Some(12.0)
        );

        metrics.kpi.publish(
            "reports",
            "7d",
            2_000,
            Ok(Some(Snapshot::default())),
        );
        metrics.force_flush_for_test();
        assert!(recorder.find(KPI_METRICS_REPORT_DURATION).is_none());
        assert_eq!(
            recorder.gauge_f64_value(KPI_METRICS_AVAILABLE, &[]),
            Some(1.0)
        );

        metrics.kpi.publish(
            "reports",
            "7d",
            3_000,
            Err(anyhow::anyhow!("source failed")),
        );
        metrics.force_flush_for_test();
        assert_eq!(
            recorder.gauge_f64_value(KPI_METRICS_AVAILABLE, &[]),
            Some(0.0)
        );
        assert!(recorder.find(KPI_METRICS_UPDATED_AT).is_none());

        let mut snapshot = Snapshot::default();
        snapshot.record(KPI_METRICS_REPORT_DURATION, 13.0, &[]);
        metrics
            .kpi
            .publish("reports", "7d", 4_000, Ok(Some(snapshot)));
        metrics
            .kpi
            .sources
            .write()
            .unwrap()
            .get_mut(&("reports", "7d"))
            .unwrap()
            .updated =
            Instant::now() - Duration::from_secs(KPI_METRICS_MAX_AGE_SECS);
        metrics.force_flush_for_test();
        assert_eq!(
            recorder.gauge_f64_value(KPI_METRICS_AVAILABLE, &[]),
            Some(0.0)
        );
        assert!(recorder.find(KPI_METRICS_REPORT_DURATION).is_none());
    }
}
