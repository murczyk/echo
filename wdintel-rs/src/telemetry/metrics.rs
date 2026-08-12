use std::time::Duration;

use anyhow::Context;
use log::{info, warn};
use opentelemetry::metrics::{Counter, Histogram, MeterProvider};
use opentelemetry::{Key, KeyValue};
use opentelemetry_otlp::WithExportConfig;
use opentelemetry_sdk::metrics::{
    exporter::PushMetricExporter, Aggregation, Instrument, PeriodicReader,
    SdkMeterProvider, Stream,
};
use opentelemetry_sdk::Resource;

use crate::config::{
    Config, SIGNOZ_METRICS_EXPORT_INTERVAL_SECS, SIGNOZ_METRICS_SERVICE_NAME,
    SIGNOZ_METRICS_SERVICE_NAMESPACE,
};

const DEVICE_FILES_SYNCHRONIZED_COUNT: &str =
    "echo.device_files.synchronized.count";
const DEVICE_FILES_SYNCHRONIZED_DESCRIPTION: &str =
    "Number of device files successfully synchronized";
const DEVICE_FILES_SYNC_BATCHES_COUNT: &str =
    "echo.device_files.sync_batches.count";
const DEVICE_FILES_SYNC_BATCHES_DESCRIPTION: &str =
    "Number of device file synchronization batches";
const DEVICE_FILES_SYNC_DURATION: &str = "echo.device_files.sync.duration";
const DEVICE_FILES_SYNC_DURATION_DESCRIPTION: &str =
    "Device file synchronization batch duration";
const DEVICE_FILES_SYNC_DURATION_BUCKETS_SECS: &[f64] = &[
    0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0,
];

#[derive(Clone)]
pub struct Metrics {
    provider: SdkMeterProvider,
    synchronized_files: Counter<u64>,
    sync_batches: Counter<u64>,
    sync_duration: Histogram<f64>,
}

impl Metrics {
    pub fn from_config(config: &Config) -> Option<Self> {
        if !config.signoz_metrics_enabled.unwrap_or(false) {
            return None;
        }

        let Some(endpoint) = config
            .signoz_metrics_endpoint
            .as_deref()
            .map(str::trim)
            .filter(|endpoint| !endpoint.is_empty())
        else {
            warn!(
                "Signoz metrics are enabled, but signoz_metrics_endpoint is missing"
            );
            return None;
        };

        let exporter = match opentelemetry_otlp::MetricExporter::builder()
            .with_tonic()
            .with_endpoint(endpoint.to_string())
            .build()
            .context("building Signoz OTLP metrics exporter")
        {
            Ok(exporter) => exporter,
            Err(error) => {
                warn!("Failed to initialize Signoz metrics: {error:#}");
                return None;
            }
        };

        info!("Signoz metrics export enabled endpoint={endpoint}");
        Some(Self::with_exporter(
            config,
            exporter,
            Duration::from_secs(SIGNOZ_METRICS_EXPORT_INTERVAL_SECS),
        ))
    }

    fn with_exporter<T>(
        config: &Config,
        exporter: T,
        interval: Duration,
    ) -> Self
    where
        T: PushMetricExporter,
    {
        let reader = PeriodicReader::builder(exporter)
            .with_interval(interval)
            .build();
        let provider = SdkMeterProvider::builder()
            .with_resource(metrics_resource(config))
            .with_reader(reader)
            .with_view(metrics_view)
            .build();
        let meter = provider.meter(SIGNOZ_METRICS_SERVICE_NAME);
        let synchronized_files = meter
            .u64_counter(DEVICE_FILES_SYNCHRONIZED_COUNT)
            .with_description(DEVICE_FILES_SYNCHRONIZED_DESCRIPTION)
            .with_unit("1")
            .build();
        let sync_batches = meter
            .u64_counter(DEVICE_FILES_SYNC_BATCHES_COUNT)
            .with_description(DEVICE_FILES_SYNC_BATCHES_DESCRIPTION)
            .with_unit("1")
            .build();
        let sync_duration = meter
            .f64_histogram(DEVICE_FILES_SYNC_DURATION)
            .with_description(DEVICE_FILES_SYNC_DURATION_DESCRIPTION)
            .with_unit("s")
            .build();

        Self {
            provider,
            synchronized_files,
            sync_batches,
            sync_duration,
        }
    }

    pub(crate) fn record_device_files_sync(
        &self,
        created: u64,
        updated: u64,
        duration: Duration,
    ) {
        self.record_synchronized_files("created", created);
        self.record_synchronized_files("updated", updated);
        self.sync_batches.add(1, &[]);
        self.sync_duration.record(duration.as_secs_f64(), &[]);
    }

    fn record_synchronized_files(&self, operation: &'static str, count: u64) {
        if count == 0 {
            return;
        }
        self.synchronized_files
            .add(count, &[KeyValue::new("operation", operation)]);
    }

    pub fn shutdown(&self) {
        if let Err(error) = self.provider.shutdown() {
            warn!("Failed to shut down Signoz metrics provider: {error}");
        }
    }
}

fn metrics_view(instrument: &Instrument) -> Option<Stream> {
    let (allowed_attributes, boundaries): (&[&'static str], Option<&[f64]>) =
        match instrument.name() {
            DEVICE_FILES_SYNCHRONIZED_COUNT => (&["operation"], None),
            DEVICE_FILES_SYNC_BATCHES_COUNT => (&[], None),
            DEVICE_FILES_SYNC_DURATION => {
                (&[], Some(DEVICE_FILES_SYNC_DURATION_BUCKETS_SECS))
            }
            _ => return None,
        };
    let mut stream = Stream::builder().with_allowed_attribute_keys(
        allowed_attributes.iter().copied().map(Key::from_static_str),
    );
    if let Some(boundaries) = boundaries {
        stream =
            stream.with_aggregation(Aggregation::ExplicitBucketHistogram {
                boundaries: boundaries.to_vec(),
                record_min_max: true,
            });
    }
    Some(stream.build().expect("static Signoz metrics view is valid"))
}

fn metrics_resource(config: &Config) -> Resource {
    let mut attributes = vec![
        KeyValue::new("service.name", SIGNOZ_METRICS_SERVICE_NAME),
        KeyValue::new("service.namespace", SIGNOZ_METRICS_SERVICE_NAMESPACE),
    ];
    if !config.public_host.trim().is_empty() {
        attributes.push(KeyValue::new("host.name", config.public_host.clone()));
    }
    if let Some(server_id) = config.server_id {
        attributes
            .push(KeyValue::new("service.instance.id", server_id.to_string()));
    }

    Resource::builder().with_attributes(attributes).build()
}

#[cfg(test)]
impl Metrics {
    pub(crate) fn recording(config: &Config) -> (Self, MetricsRecorder) {
        let recorder = MetricsRecorder::default();
        let metrics = Self::with_exporter(
            config,
            RecordingExporter {
                recorder: recorder.clone(),
            },
            Duration::from_secs(3_600),
        );
        (metrics, recorder)
    }

    pub(crate) fn force_flush_for_test(&self) {
        self.provider
            .force_flush()
            .expect("recording metrics flush succeeds");
    }
}

#[cfg(test)]
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum RecordedMetricValue {
    Counter(u64),
    Histogram {
        count: u64,
        sum: f64,
        boundaries: Vec<f64>,
    },
}

#[cfg(test)]
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct RecordedMetric {
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) unit: String,
    pub(crate) value: RecordedMetricValue,
    pub(crate) attributes: std::collections::BTreeMap<String, String>,
    pub(crate) resources: std::collections::BTreeMap<String, String>,
}

#[cfg(test)]
#[derive(Clone, Debug, Default)]
pub(crate) struct MetricsRecorder {
    records: std::sync::Arc<std::sync::Mutex<Vec<RecordedMetric>>>,
}

#[cfg(test)]
impl MetricsRecorder {
    pub(crate) fn find(&self, name: &str) -> Option<RecordedMetric> {
        self.records
            .lock()
            .expect("metrics recorder lock is available")
            .iter()
            .find(|record| record.name == name)
            .cloned()
    }

    pub(crate) fn counter_value(
        &self,
        name: &str,
        attributes: &[(&str, &str)],
    ) -> Option<u64> {
        self.records
            .lock()
            .expect("metrics recorder lock is available")
            .iter()
            .find(|record| {
                record.name == name
                    && attributes.iter().all(|(key, value)| {
                        record.attributes.get(*key).map(String::as_str)
                            == Some(*value)
                    })
            })
            .and_then(|record| match record.value {
                RecordedMetricValue::Counter(value) => Some(value),
                RecordedMetricValue::Histogram { .. } => None,
            })
    }
}

#[cfg(test)]
#[derive(Debug)]
struct RecordingExporter {
    recorder: MetricsRecorder,
}

#[cfg(test)]
impl PushMetricExporter for RecordingExporter {
    async fn export(
        &self,
        metrics: &opentelemetry_sdk::metrics::data::ResourceMetrics,
    ) -> opentelemetry_sdk::error::OTelSdkResult {
        use opentelemetry_sdk::metrics::data::{AggregatedMetrics, MetricData};

        let resources: std::collections::BTreeMap<_, _> = metrics
            .resource()
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect();
        let mut records = Vec::new();
        for scope in metrics.scope_metrics() {
            for metric in scope.metrics() {
                match metric.data() {
                    AggregatedMetrics::U64(MetricData::Sum(sum)) => {
                        for point in sum.data_points() {
                            records.push(RecordedMetric {
                                name: metric.name().to_string(),
                                description: metric.description().to_string(),
                                unit: metric.unit().to_string(),
                                value: RecordedMetricValue::Counter(
                                    point.value(),
                                ),
                                attributes: point
                                    .attributes()
                                    .map(|attribute| {
                                        (
                                            attribute.key.to_string(),
                                            attribute.value.to_string(),
                                        )
                                    })
                                    .collect(),
                                resources: resources.clone(),
                            });
                        }
                    }
                    AggregatedMetrics::F64(MetricData::Histogram(
                        histogram,
                    )) => {
                        for point in histogram.data_points() {
                            records.push(RecordedMetric {
                                name: metric.name().to_string(),
                                description: metric.description().to_string(),
                                unit: metric.unit().to_string(),
                                value: RecordedMetricValue::Histogram {
                                    count: point.count(),
                                    sum: point.sum(),
                                    boundaries: point.bounds().collect(),
                                },
                                attributes: point
                                    .attributes()
                                    .map(|attribute| {
                                        (
                                            attribute.key.to_string(),
                                            attribute.value.to_string(),
                                        )
                                    })
                                    .collect(),
                                resources: resources.clone(),
                            });
                        }
                    }
                    _ => {}
                }
            }
        }
        *self
            .recorder
            .records
            .lock()
            .expect("metrics recorder lock is available") = records;
        Ok(())
    }

    fn force_flush(&self) -> opentelemetry_sdk::error::OTelSdkResult {
        Ok(())
    }

    fn shutdown_with_timeout(
        &self,
        _timeout: Duration,
    ) -> opentelemetry_sdk::error::OTelSdkResult {
        Ok(())
    }

    fn temporality(&self) -> opentelemetry_sdk::metrics::Temporality {
        opentelemetry_sdk::metrics::Temporality::Cumulative
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Mode;

    #[test]
    fn metrics_are_disabled_when_config_is_absent() {
        let mut config = crate::config::read_config(Mode::Test).unwrap();
        config.signoz_metrics_enabled = None;
        config.signoz_metrics_endpoint = None;

        assert!(Metrics::from_config(&config).is_none());

        config.signoz_metrics_enabled = Some(true);
        assert!(Metrics::from_config(&config).is_none());
    }

    #[test]
    fn device_file_sync_metrics_match_signoz_contract() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let (metrics, recorder) = Metrics::recording(&config);

        metrics.record_device_files_sync(2, 3, Duration::from_millis(250));
        metrics.force_flush_for_test();

        assert_eq!(
            recorder.counter_value(
                DEVICE_FILES_SYNCHRONIZED_COUNT,
                &[("operation", "created")],
            ),
            Some(2)
        );
        assert_eq!(
            recorder.counter_value(
                DEVICE_FILES_SYNCHRONIZED_COUNT,
                &[("operation", "updated")],
            ),
            Some(3)
        );
        assert_eq!(
            recorder.counter_value(DEVICE_FILES_SYNC_BATCHES_COUNT, &[]),
            Some(1)
        );

        let duration = recorder.find(DEVICE_FILES_SYNC_DURATION).unwrap();
        assert_eq!(
            duration.value,
            RecordedMetricValue::Histogram {
                count: 1,
                sum: 0.25,
                boundaries: DEVICE_FILES_SYNC_DURATION_BUCKETS_SECS.to_vec(),
            }
        );
        assert!(duration.attributes.is_empty());
        assert_eq!(
            duration.description,
            DEVICE_FILES_SYNC_DURATION_DESCRIPTION
        );
        assert_eq!(duration.unit, "s");

        let synchronized =
            recorder.find(DEVICE_FILES_SYNCHRONIZED_COUNT).unwrap();
        assert_eq!(
            synchronized.description,
            DEVICE_FILES_SYNCHRONIZED_DESCRIPTION
        );
        assert_eq!(synchronized.unit, "1");
        assert_eq!(
            synchronized.resources.get("host.name"),
            Some(&config.public_host)
        );
        assert_eq!(
            synchronized.resources.get("service.instance.id"),
            Some(&config.server_id.unwrap().to_string())
        );
        assert_eq!(
            synchronized.resources.get("service.name"),
            Some(&SIGNOZ_METRICS_SERVICE_NAME.to_string())
        );
        assert_eq!(
            synchronized.resources.get("service.namespace"),
            Some(&SIGNOZ_METRICS_SERVICE_NAMESPACE.to_string())
        );
    }
}
