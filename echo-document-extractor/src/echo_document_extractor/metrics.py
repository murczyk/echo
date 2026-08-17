from __future__ import annotations

from prometheus_client import (
    CollectorRegistry,
    Counter,
    Gauge,
    GCCollector,
    Histogram,
    PlatformCollector,
    ProcessCollector,
    start_http_server,
)

from .adapters import ModelResponse


class ServiceMetrics:
    def __init__(self, role: str) -> None:
        self.registry = CollectorRegistry()
        ProcessCollector(registry=self.registry)
        PlatformCollector(registry=self.registry)
        GCCollector(registry=self.registry)
        labels = {"process_role": role}
        self.api_requests = Counter(
            "echo_document_extractor_api_requests_total",
            "HTTP requests handled by the API",
            ("method", "route", "status"),
            registry=self.registry,
        )
        self.api_duration = Histogram(
            "echo_document_extractor_api_request_duration_seconds",
            "HTTP request duration",
            ("method", "route"),
            registry=self.registry,
        )
        self.queue_jobs = Gauge(
            "echo_document_extractor_queue_jobs",
            "Jobs by durable queue state",
            ("state",),
            registry=self.registry,
        )
        self.worker_active = Gauge(
            "echo_document_extractor_worker_active",
            "Whether the worker owns an active job",
            registry=self.registry,
        )
        self.jobs = Counter(
            "echo_document_extractor_jobs_total",
            "Terminal jobs by queue state and extraction quality",
            ("state", "quality"),
            registry=self.registry,
        )
        self.job_duration = Histogram(
            "echo_document_extractor_job_duration_seconds",
            "Job processing duration",
            ("state", "quality"),
            buckets=(1, 5, 15, 60, 300, 900, 3600, 7200, 14400),
            registry=self.registry,
        )
        self.pages = Counter(
            "echo_document_extractor_pages_processed_total",
            "Pages reaching an extraction boundary",
            registry=self.registry,
        )
        self.page_progress = Gauge(
            "echo_document_extractor_page_progress_ratio",
            "Progress ratio for the single active job",
            registry=self.registry,
        )
        self.paddle_duration = Histogram(
            "echo_document_extractor_paddle_duration_seconds",
            "Paddle OCR and structure inference duration",
            ("status",),
            registry=self.registry,
        )
        self.model_requests = Counter(
            "echo_document_extractor_model_requests_total",
            "Requests to extraction models",
            ("adapter", "status"),
            registry=self.registry,
        )
        self.model_duration = Histogram(
            "echo_document_extractor_model_request_duration_seconds",
            "Extraction model request duration",
            ("adapter",),
            registry=self.registry,
        )
        self.tokens = Counter(
            "echo_document_extractor_model_tokens_total",
            "Model token usage",
            ("adapter", "kind"),
            registry=self.registry,
        )
        self.retries = Counter(
            "echo_document_extractor_retries_total",
            "Infrastructure retries",
            ("reason",),
            registry=self.registry,
        )
        self.spool_bytes = Gauge(
            "echo_document_extractor_spool_bytes",
            "Tracked spool bytes",
            registry=self.registry,
        )
        self.spool_free_bytes = Gauge(
            "echo_document_extractor_spool_free_bytes",
            "Free bytes on the spool filesystem",
            registry=self.registry,
        )
        self.cleanup = Counter(
            "echo_document_extractor_cleanup_jobs_total",
            "Expired terminal jobs removed",
            ("status",),
            registry=self.registry,
        )
        self.dependency_up = Gauge(
            "echo_document_extractor_dependency_up",
            "Required dependency availability",
            ("dependency",),
            registry=self.registry,
        )
        self.process_info = Gauge(
            "echo_document_extractor_process_info",
            "Extractor process identity",
            ("process_role",),
            registry=self.registry,
        )
        self.process_info.labels(**labels).set(1)

    def start(self, host: str, port: int) -> None:
        start_http_server(port, addr=host, registry=self.registry)

    def observe_paddle(self, duration: float, status: str) -> None:
        self.paddle_duration.labels(status=status).observe(duration)

    def observe_model(self, response: ModelResponse) -> None:
        status = "error" if response.error else "success"
        self.model_requests.labels(adapter=response.adapter, status=status).inc()
        self.model_duration.labels(adapter=response.adapter).observe(response.latency_ms / 1000)
        self.tokens.labels(adapter=response.adapter, kind="prompt").inc(response.usage.prompt_tokens)
        self.tokens.labels(adapter=response.adapter, kind="completion").inc(response.usage.completion_tokens)

    def observe_model_error(self, adapter: str) -> None:
        self.model_requests.labels(adapter=adapter, status="error").inc()

    def update_queue(self, counts: dict[str, int]) -> None:
        for state, count in counts.items():
            self.queue_jobs.labels(state=state).set(count)
