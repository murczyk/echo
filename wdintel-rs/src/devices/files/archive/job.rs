use super::{
    policy::Policy,
    protocol::{self, Command, Event, Request},
    repository::{self, Attempt},
};
use crate::{
    devices::config::*, file_registry::entities::file_archive, h,
    storage::S3Config, types::ShortContext,
};
use anyhow::{Context, Result};
use sea_orm::DatabaseConnection;
use std::{path::Path, time::Duration};
use tokio::process::Command as Process;
use tokio_util::sync::CancellationToken;

pub(super) struct Processor {
    pub storage: S3Config,
    pub key: [u8; 32],
}

impl Processor {
    pub(super) async fn run(
        &self,
        db: &DatabaseConnection,
        connection: &mut sqlx::PgConnection,
        attempt: &Attempt,
        archive: &file_archive::Model,
        scratch: &Path,
        cancel: &CancellationToken,
    ) -> Result<()> {
        tokio::fs::create_dir(scratch).await.c(h!())?;
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(
            scratch,
            std::fs::Permissions::from_mode(0o700),
        )
        .await
        .c(h!())?;
        let policy: Policy =
            serde_json::from_value(archive.policy.clone()).c(h!())?;
        let request = Request {
            source_key: archive.source_object_key.clone(),
            source_size: archive.source_size_bytes as u64,
            source_sha256: archive
                .source_sha256
                .clone()
                .try_into()
                .map_err(|_| anyhow::anyhow!("source hash length"))?,
            source_encrypted: archive.source_is_encrypted,
            output_prefix: format!(
                "device-file-archive/{}/{}/",
                archive.id, archive.attempts
            ),
            key: self.key,
            storage: self.storage.clone(),
            scratch: scratch.to_owned(),
            limits: policy.manifest,
        };
        let mut child = Process::new(std::env::current_exe().c(h!())?)
            .arg("--device-archive-helper")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .c(h!())?;
        let mut input = child.stdin.take().c(h!())?;
        let mut output = child.stdout.take().c(h!())?;
        let work = async {
            protocol::send(&mut input, &request).await?;
            let manifest = match protocol::receive(&mut output).await? {
                Event::Manifest { manifest } => manifest,
                Event::Failed { reason, limit } => {
                    return Err(
                        super::error::RemoteFailure { reason, limit }.into()
                    )
                }
                _ => anyhow::bail!("expected archive manifest"),
            };
            repository::admit(db, attempt, &manifest)
                .await
                .context(h!())?;
            protocol::send(&mut input, &Command::Admit).await?;
            match protocol::receive(&mut output).await? {
                Event::Result { outputs } => {
                    super::publication::publish(db, attempt, &outputs)
                        .await
                        .context(h!())
                }
                Event::Failed { reason, limit } => {
                    Err(super::error::RemoteFailure { reason, limit }.into())
                }
                _ => anyhow::bail!("expected archive result"),
            }
        };
        tokio::pin!(work);
        let heartbeat = async {
            let mut tick = tokio::time::interval(Duration::from_secs(
                DEVICE_FILE_ARCHIVE_HEARTBEAT_SECONDS,
            ));
            loop {
                tick.tick().await;
                sqlx::query("select 1")
                    .execute(&mut *connection)
                    .await
                    .c(h!())?;
                repository::renew(db, attempt).await?;
            }
            #[allow(unreachable_code)]
            Ok::<(), anyhow::Error>(())
        };
        use sea_orm::{ConnectionTrait, DbBackend, Statement};
        let root = db
            .query_one_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "select deadline from file_archive where id=$1",
                [archive.root_id.into()],
            ))
            .await
            .c(h!())?
            .c(h!())?;
        let deadline: chrono::DateTime<chrono::FixedOffset> =
            root.try_get("", "deadline").c(h!())?;
        let root_deadline = deadline
            .signed_duration_since(chrono::Utc::now())
            .to_std()
            .unwrap_or_default();
        let result = tokio::select! {
            result=&mut work=>result,
            result=heartbeat=>result,
            _=cancel.cancelled()=>Err(std::io::Error::from(std::io::ErrorKind::Interrupted).into()),
            _=tokio::time::sleep(Duration::from_secs(policy.attempt_seconds).min(root_deadline))=>Err(super::error::Failure::Limit("timeout").into()),
        };
        // Killing and reaping also covers a blocking inflater and an unread stdin listener.
        let _ = child.kill().await;
        let _ = child.wait().await;
        result
    }
}
