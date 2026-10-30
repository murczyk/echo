use std::ffi::OsString;
use std::time::Duration;
use uuid::Uuid;

pub(crate) struct VerifiedPause {
    directory: tempfile::TempDir,
    previous_root: Option<OsString>,
}

impl VerifiedPause {
    pub(crate) fn new(job_id: Uuid) -> Self {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(
            directory.path().join("storage_verified.arm"),
            job_id.to_string(),
        )
        .unwrap();
        let previous_root =
            std::env::var_os("ECHO_UPLOAD_FINALIZATION_FAULT_ROOT");
        std::env::set_var(
            "ECHO_UPLOAD_FINALIZATION_FAULT_ROOT",
            directory.path(),
        );
        Self {
            directory,
            previous_root,
        }
    }

    pub(crate) async fn reached(&self) {
        tokio::time::timeout(Duration::from_secs(30), async {
            while !self
                .directory
                .path()
                .join("storage_verified.reached")
                .is_file()
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("worker did not verify storage before publication");
    }

    pub(crate) fn release(&self) {
        std::fs::write(
            self.directory.path().join("storage_verified.release"),
            b"",
        )
        .unwrap();
    }
}

impl Drop for VerifiedPause {
    fn drop(&mut self) {
        self.release();
        match &self.previous_root {
            Some(previous) => std::env::set_var(
                "ECHO_UPLOAD_FINALIZATION_FAULT_ROOT",
                previous,
            ),
            None => std::env::remove_var("ECHO_UPLOAD_FINALIZATION_FAULT_ROOT"),
        }
    }
}
