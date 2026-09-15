use std::time::Instant;

pub(super) struct InboxReadDiagnostics {
    started: Instant,
    page: Option<String>,
    pub(super) route: &'static str,
    pub(super) reason: &'static str,
    pub(super) stage: &'static str,
    failed_stage: &'static str,
    outcome: &'static str,
    pub(super) candidate_count: Option<usize>,
    pub(super) hydrated_count: Option<usize>,
    pub(super) ordered_count: Option<usize>,
    result_count: Option<usize>,
    postgres_started: Option<Instant>,
}

impl InboxReadDiagnostics {
    pub(super) fn new(page: Option<&str>) -> Self {
        Self {
            started: Instant::now(),
            page: page.map(str::to_owned),
            route: "postgres",
            reason: "query_policy",
            stage: "candidate_retrieval",
            failed_stage: "none",
            outcome: "cancelled",
            candidate_count: None,
            hydrated_count: None,
            ordered_count: None,
            result_count: None,
            postgres_started: None,
        }
    }

    pub(super) fn fallback(&mut self, reason: &'static str) {
        self.route = "postgres_fallback";
        self.reason = reason;
        self.failed_stage = self.stage;
    }

    pub(super) fn start_postgres(&mut self) {
        self.stage = "postgres";
        self.postgres_started = Some(Instant::now());
    }

    pub(super) fn finish<T, E>(&mut self, result: &Result<Vec<T>, E>) {
        self.outcome = if result.is_ok() { "success" } else { "error" };
        self.result_count = result.as_ref().ok().map(Vec::len);
    }
}

impl Drop for InboxReadDiagnostics {
    fn drop(&mut self) {
        log::info!(
            target: "inbox_operation",
            "inbox operation completed page={:?} route={} reason={} stage={} failed_stage={} outcome={} candidate_count={:?} hydrated_count={:?} ordered_count={:?} result_count={:?} postgres_ms={:?} elapsed_ms={}",
            self.page.as_deref().unwrap_or("unknown"),
            self.route,
            self.reason,
            self.stage,
            self.failed_stage,
            self.outcome,
            self.candidate_count,
            self.hydrated_count,
            self.ordered_count,
            self.result_count,
            self.postgres_started.map(|started| started.elapsed().as_millis()),
            self.started.elapsed().as_millis(),
        );
    }
}
