use std::time::Duration;

use anyhow::Context;
use log::{info, warn};
use opentelemetry::metrics::{Counter, Gauge, Histogram, MeterProvider};
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

const FILE_ANALYSIS_RUNS_COUNT: &str = "echo.device_files.analysis.runs.count";
const FILE_ANALYSIS_RUNS_STATUS_COUNT: &str =
    "echo.device_files.analysis.runs.status.count";
const FILE_ANALYSIS_PREPARED_ITEMS_COUNT: &str =
    "echo.device_files.analysis.prepared_items.count";
const FILE_ANALYSIS_COMPLETED_ITEMS_COUNT: &str =
    "echo.device_files.analysis.completed_items.count";
const FILE_ANALYSIS_CURRENT_PUBLISH_COUNT: &str =
    "echo.device_files.analysis.current_publish.count";
const FILE_ANALYSIS_LEASES_COUNT: &str =
    "echo.device_files.analysis.leases.count";
const FILE_ANALYSIS_OLDEST_RUN_AGE: &str =
    "echo.device_files.analysis.oldest_run.age";
const FILE_ANALYSIS_RUN_COMPLETION_DURATION: &str =
    "echo.device_files.analysis.run_completion.duration";
const FILE_ANALYSIS_DB_DURATION: &str =
    "echo.device_files.analysis.db.duration";
const FILE_ANALYSIS_WORKER_ERRORS_COUNT: &str =
    "echo.device_files.analysis.worker_errors.count";
const FILE_ANALYSIS_DB_DURATION_BUCKETS_SECS: &[f64] = &[
    0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0,
];
const FILE_ANALYSIS_RUN_DURATION_BUCKETS_SECS: &[f64] = &[
    0.1, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 300.0, 900.0, 3_600.0, 10_800.0,
];

#[derive(Clone, Copy, Debug)]
pub(crate) enum FileAnalysisDbOperation {
    SourceRangeAllocation,
    Preparation,
    Claim,
    ResultWrite,
    CurrentPublish,
}

impl FileAnalysisDbOperation {
    fn as_str(self) -> &'static str {
        match self {
            Self::SourceRangeAllocation => "source_range_allocation",
            Self::Preparation => "preparation",
            Self::Claim => "claim",
            Self::ResultWrite => "result_write",
            Self::CurrentPublish => "current_publish",
        }
    }
}

#[derive(Clone)]
pub struct Metrics {
    provider: SdkMeterProvider,
    synchronized_files: Counter<u64>,
    sync_batches: Counter<u64>,
    sync_duration: Histogram<f64>,
    file_analysis_runs: Gauge<u64>,
    file_analysis_run_statuses: Gauge<u64>,
    file_analysis_prepared_items: Counter<u64>,
    file_analysis_completed_items: Counter<u64>,
    file_analysis_current_publish: Counter<u64>,
    file_analysis_leases: Gauge<u64>,
    file_analysis_oldest_run_age: Gauge<f64>,
    file_analysis_run_completion_duration: Histogram<f64>,
    file_analysis_db_duration: Histogram<f64>,
    file_analysis_worker_errors: Counter<u64>,
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
        let file_analysis_runs = meter
            .u64_gauge(FILE_ANALYSIS_RUNS_COUNT)
            .with_description("Number of file analysis runs by immutable cause")
            .with_unit("1")
            .build();
        let file_analysis_run_statuses = meter
            .u64_gauge(FILE_ANALYSIS_RUNS_STATUS_COUNT)
            .with_description("Number of file analysis runs by derived status")
            .with_unit("1")
            .build();
        let file_analysis_prepared_items = meter
            .u64_counter(FILE_ANALYSIS_PREPARED_ITEMS_COUNT)
            .with_description("Number of materialized file analysis run items")
            .with_unit("1")
            .build();
        let file_analysis_completed_items = meter
            .u64_counter(FILE_ANALYSIS_COMPLETED_ITEMS_COUNT)
            .with_description("Number of completed file analysis run items")
            .with_unit("1")
            .build();
        let file_analysis_current_publish = meter
            .u64_counter(FILE_ANALYSIS_CURRENT_PUBLISH_COUNT)
            .with_description(
                "Number of completed file analysis items by current-publish outcome",
            )
            .with_unit("1")
            .build();
        let file_analysis_leases = meter
            .u64_gauge(FILE_ANALYSIS_LEASES_COUNT)
            .with_description(
                "Number of active or expired file analysis leases",
            )
            .with_unit("1")
            .build();
        let file_analysis_oldest_run_age = meter
            .f64_gauge(FILE_ANALYSIS_OLDEST_RUN_AGE)
            .with_description(
                "Age of the oldest non-terminal file analysis run",
            )
            .with_unit("s")
            .build();
        let file_analysis_run_completion_duration = meter
            .f64_histogram(FILE_ANALYSIS_RUN_COMPLETION_DURATION)
            .with_description(
                "End-to-end file analysis run completion duration",
            )
            .with_unit("s")
            .build();
        let file_analysis_db_duration = meter
            .f64_histogram(FILE_ANALYSIS_DB_DURATION)
            .with_description("File analysis database operation duration")
            .with_unit("s")
            .build();
        let file_analysis_worker_errors = meter
            .u64_counter(FILE_ANALYSIS_WORKER_ERRORS_COUNT)
            .with_description("Number of file analysis infrastructure errors")
            .with_unit("1")
            .build();

        Self {
            provider,
            synchronized_files,
            sync_batches,
            sync_duration,
            file_analysis_runs,
            file_analysis_run_statuses,
            file_analysis_prepared_items,
            file_analysis_completed_items,
            file_analysis_current_publish,
            file_analysis_leases,
            file_analysis_oldest_run_age,
            file_analysis_run_completion_duration,
            file_analysis_db_duration,
            file_analysis_worker_errors,
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

    pub(crate) fn record_file_analysis_db_duration(
        &self,
        operation: FileAnalysisDbOperation,
        duration: Duration,
    ) {
        self.file_analysis_db_duration.record(
            duration.as_secs_f64(),
            &[KeyValue::new("operation", operation.as_str())],
        );
    }

    pub(crate) fn record_file_analysis_preparation(
        &self,
        item_count: u64,
        duration: Duration,
    ) {
        if item_count > 0 {
            self.file_analysis_prepared_items.add(item_count, &[]);
        }
        self.record_file_analysis_db_duration(
            FileAnalysisDbOperation::Preparation,
            duration,
        );
    }

    pub(crate) fn record_file_analysis_claim(&self, duration: Duration) {
        self.record_file_analysis_db_duration(
            FileAnalysisDbOperation::Claim,
            duration,
        );
    }

    pub(crate) fn record_file_analysis_completion(
        &self,
        completed_count: u64,
        published_count: u64,
        result_write_duration_secs: f64,
        current_publish_duration_secs: f64,
        run_completion_duration_secs: Option<f64>,
    ) {
        if completed_count > 0 {
            self.file_analysis_completed_items.add(completed_count, &[]);
        }
        if published_count > 0 {
            self.file_analysis_current_publish
                .add(published_count, &[KeyValue::new("outcome", "published")]);
        }
        let skipped_count = completed_count.saturating_sub(published_count);
        if skipped_count > 0 {
            self.file_analysis_current_publish
                .add(skipped_count, &[KeyValue::new("outcome", "skipped")]);
        }
        self.file_analysis_db_duration.record(
            result_write_duration_secs,
            &[KeyValue::new(
                "operation",
                FileAnalysisDbOperation::ResultWrite.as_str(),
            )],
        );
        self.file_analysis_db_duration.record(
            current_publish_duration_secs,
            &[KeyValue::new(
                "operation",
                FileAnalysisDbOperation::CurrentPublish.as_str(),
            )],
        );
        if let Some(duration_secs) = run_completion_duration_secs {
            self.file_analysis_run_completion_duration
                .record(duration_secs, &[]);
        }
    }

    pub(crate) fn record_file_analysis_run_completion_duration(
        &self,
        duration_secs: f64,
    ) {
        self.file_analysis_run_completion_duration
            .record(duration_secs, &[]);
    }

    pub(crate) fn record_file_analysis_worker_error(&self) {
        self.file_analysis_worker_errors.add(1, &[]);
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn record_file_analysis_operational_state(
        &self,
        sync_runs: u64,
        manual_runs: u64,
        preparing_runs: u64,
        running_runs: u64,
        completed_runs: u64,
        active_leases: u64,
        expired_leases: u64,
        oldest_preparing_age_secs: f64,
        oldest_running_age_secs: f64,
    ) {
        for (cause, count) in [("sync", sync_runs), ("manual", manual_runs)] {
            self.file_analysis_runs
                .record(count, &[KeyValue::new("cause", cause)]);
        }
        for (status, count) in [
            ("preparing", preparing_runs),
            ("running", running_runs),
            ("completed", completed_runs),
        ] {
            self.file_analysis_run_statuses
                .record(count, &[KeyValue::new("status", status)]);
        }
        for (state, count) in
            [("active", active_leases), ("expired", expired_leases)]
        {
            self.file_analysis_leases
                .record(count, &[KeyValue::new("state", state)]);
        }
        for (status, age_secs) in [
            ("preparing", oldest_preparing_age_secs),
            ("running", oldest_running_age_secs),
        ] {
            self.file_analysis_oldest_run_age
                .record(age_secs, &[KeyValue::new("status", status)]);
        }
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
            FILE_ANALYSIS_RUNS_COUNT => (&["cause"], None),
            FILE_ANALYSIS_RUNS_STATUS_COUNT => (&["status"], None),
            FILE_ANALYSIS_PREPARED_ITEMS_COUNT
            | FILE_ANALYSIS_COMPLETED_ITEMS_COUNT
            | FILE_ANALYSIS_WORKER_ERRORS_COUNT => (&[], None),
            FILE_ANALYSIS_CURRENT_PUBLISH_COUNT => (&["outcome"], None),
            FILE_ANALYSIS_LEASES_COUNT => (&["state"], None),
            FILE_ANALYSIS_OLDEST_RUN_AGE => (&["status"], None),
            FILE_ANALYSIS_RUN_COMPLETION_DURATION => {
                (&[], Some(FILE_ANALYSIS_RUN_DURATION_BUCKETS_SECS))
            }
            FILE_ANALYSIS_DB_DURATION => {
                (&["operation"], Some(FILE_ANALYSIS_DB_DURATION_BUCKETS_SECS))
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
    Gauge(u64),
    GaugeF64(f64),
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

    pub(crate) fn find_with_attributes(
        &self,
        name: &str,
        attributes: &[(&str, &str)],
    ) -> Option<RecordedMetric> {
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
                RecordedMetricValue::Gauge(_)
                | RecordedMetricValue::GaugeF64(_)
                | RecordedMetricValue::Histogram { .. } => None,
            })
    }

    pub(crate) fn gauge_value(
        &self,
        name: &str,
        attributes: &[(&str, &str)],
    ) -> Option<u64> {
        self.find_with_attributes(name, attributes)
            .and_then(|record| match record.value {
                RecordedMetricValue::Gauge(value) => Some(value),
                RecordedMetricValue::Counter(_)
                | RecordedMetricValue::GaugeF64(_)
                | RecordedMetricValue::Histogram { .. } => None,
            })
    }

    pub(crate) fn gauge_f64_value(
        &self,
        name: &str,
        attributes: &[(&str, &str)],
    ) -> Option<f64> {
        self.find_with_attributes(name, attributes)
            .and_then(|record| match record.value {
                RecordedMetricValue::GaugeF64(value) => Some(value),
                RecordedMetricValue::Counter(_)
                | RecordedMetricValue::Gauge(_)
                | RecordedMetricValue::Histogram { .. } => None,
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
                    AggregatedMetrics::U64(MetricData::Gauge(gauge)) => {
                        for point in gauge.data_points() {
                            records.push(RecordedMetric {
                                name: metric.name().to_string(),
                                description: metric.description().to_string(),
                                unit: metric.unit().to_string(),
                                value: RecordedMetricValue::Gauge(
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
                    AggregatedMetrics::F64(MetricData::Gauge(gauge)) => {
                        for point in gauge.data_points() {
                            records.push(RecordedMetric {
                                name: metric.name().to_string(),
                                description: metric.description().to_string(),
                                unit: metric.unit().to_string(),
                                value: RecordedMetricValue::GaugeF64(
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

    #[test]
    fn file_analysis_metrics_match_operational_contract() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let (metrics, recorder) = Metrics::recording(&config);

        metrics.record_file_analysis_operational_state(
            2, 7, 5, 6, 7, 8, 9, 10.0, 11.0,
        );
        metrics
            .record_file_analysis_preparation(1_000, Duration::from_millis(12));
        metrics.record_file_analysis_run_completion_duration(14.0);
        metrics.record_file_analysis_claim(Duration::from_millis(200));
        metrics.record_file_analysis_completion(900, 800, 0.3, 0.4, Some(15.0));
        metrics.record_file_analysis_db_duration(
            FileAnalysisDbOperation::SourceRangeAllocation,
            Duration::from_millis(100),
        );
        metrics.record_file_analysis_worker_error();
        metrics.force_flush_for_test();

        for (cause, expected) in [("sync", 2), ("manual", 7)] {
            assert_eq!(
                recorder.gauge_value(
                    FILE_ANALYSIS_RUNS_COUNT,
                    &[("cause", cause)],
                ),
                Some(expected),
            );
        }
        for (status, expected) in
            [("preparing", 5), ("running", 6), ("completed", 7)]
        {
            assert_eq!(
                recorder.gauge_value(
                    FILE_ANALYSIS_RUNS_STATUS_COUNT,
                    &[("status", status)],
                ),
                Some(expected),
            );
        }
        assert_eq!(
            recorder.counter_value(FILE_ANALYSIS_PREPARED_ITEMS_COUNT, &[],),
            Some(1_000),
        );
        assert_eq!(
            recorder.counter_value(FILE_ANALYSIS_COMPLETED_ITEMS_COUNT, &[],),
            Some(900),
        );
        assert_eq!(
            recorder.counter_value(
                FILE_ANALYSIS_CURRENT_PUBLISH_COUNT,
                &[("outcome", "published")],
            ),
            Some(800),
        );
        assert_eq!(
            recorder.counter_value(
                FILE_ANALYSIS_CURRENT_PUBLISH_COUNT,
                &[("outcome", "skipped")],
            ),
            Some(100),
        );
        assert_eq!(
            recorder.counter_value(FILE_ANALYSIS_WORKER_ERRORS_COUNT, &[]),
            Some(1),
        );
        assert_eq!(
            recorder.gauge_value(
                FILE_ANALYSIS_LEASES_COUNT,
                &[("state", "active")],
            ),
            Some(8),
        );
        assert_eq!(
            recorder.gauge_value(
                FILE_ANALYSIS_LEASES_COUNT,
                &[("state", "expired")],
            ),
            Some(9),
        );
        assert_eq!(
            recorder.gauge_f64_value(
                FILE_ANALYSIS_OLDEST_RUN_AGE,
                &[("status", "preparing")],
            ),
            Some(10.0),
        );
        assert_eq!(
            recorder.gauge_f64_value(
                FILE_ANALYSIS_OLDEST_RUN_AGE,
                &[("status", "running")],
            ),
            Some(11.0),
        );

        for (operation, expected_sum) in [
            ("source_range_allocation", 0.1),
            ("preparation", 0.012),
            ("claim", 0.2),
            ("result_write", 0.3),
            ("current_publish", 0.4),
        ] {
            let duration = recorder
                .find_with_attributes(
                    FILE_ANALYSIS_DB_DURATION,
                    &[("operation", operation)],
                )
                .unwrap();
            assert_eq!(
                duration.value,
                RecordedMetricValue::Histogram {
                    count: 1,
                    sum: expected_sum,
                    boundaries: FILE_ANALYSIS_DB_DURATION_BUCKETS_SECS.to_vec(),
                },
            );
            assert_eq!(duration.attributes.len(), 1);
        }

        let run_duration = recorder
            .find(FILE_ANALYSIS_RUN_COMPLETION_DURATION)
            .unwrap();
        assert_eq!(
            run_duration.value,
            RecordedMetricValue::Histogram {
                count: 2,
                sum: 29.0,
                boundaries: FILE_ANALYSIS_RUN_DURATION_BUCKETS_SECS.to_vec(),
            },
        );
        assert!(run_duration.attributes.is_empty());

        for (name, unit) in [
            (FILE_ANALYSIS_RUNS_COUNT, "1"),
            (FILE_ANALYSIS_RUNS_STATUS_COUNT, "1"),
            (FILE_ANALYSIS_PREPARED_ITEMS_COUNT, "1"),
            (FILE_ANALYSIS_COMPLETED_ITEMS_COUNT, "1"),
            (FILE_ANALYSIS_LEASES_COUNT, "1"),
            (FILE_ANALYSIS_OLDEST_RUN_AGE, "s"),
            (FILE_ANALYSIS_DB_DURATION, "s"),
            (FILE_ANALYSIS_RUN_COMPLETION_DURATION, "s"),
            (FILE_ANALYSIS_CURRENT_PUBLISH_COUNT, "1"),
            (FILE_ANALYSIS_WORKER_ERRORS_COUNT, "1"),
        ] {
            let metric = recorder.find(name).unwrap();
            assert_eq!(metric.unit, unit);
            assert!(!metric.description.is_empty());
        }
    }
}
