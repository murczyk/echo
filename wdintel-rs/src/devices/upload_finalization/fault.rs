use uuid::Uuid;

#[cfg(not(any(test, debug_assertions)))]
pub(crate) async fn point(_stage: &str, _identity: Uuid) {}

#[cfg(any(test, debug_assertions))]
pub(crate) async fn point(stage: &str, identity: Uuid) {
    if let Err(error) = pause(stage, identity).await {
        log::warn!("finalization debug fault point failed: {error:#}");
    }
}

#[cfg(any(test, debug_assertions))]
async fn pause(stage: &str, identity: Uuid) -> anyhow::Result<()> {
    use crate::h;
    use anyhow::Context;
    use std::io::Write;

    let Some(root) = std::env::var_os("ECHO_UPLOAD_FINALIZATION_FAULT_ROOT")
    else {
        return Ok(());
    };
    let root = std::path::PathBuf::from(root);
    anyhow::ensure!(root.is_absolute(), "fault root must be absolute");
    let armed = match std::fs::read_to_string(root.join(format!("{stage}.arm")))
    {
        Ok(armed) => armed,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(())
        }
        Err(error) => return Err(error).context(h!()),
    };
    if armed.trim() != "*" && armed.trim() != identity.to_string() {
        return Ok(());
    }
    let mut active = match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(root.join(format!("{stage}.active")))
    {
        Ok(active) => active,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            return Ok(())
        }
        Err(error) => return Err(error).context(h!()),
    };
    let receipt = serde_json::to_vec(&serde_json::json!({
        "pid": std::process::id(), "identity": identity,
    }))
    .context(h!())?;
    active.write_all(&receipt).context(h!())?;
    active.sync_all().context(h!())?;
    std::fs::write(root.join(format!("{stage}.reached.tmp")), receipt)
        .context(h!())?;
    std::fs::rename(
        root.join(format!("{stage}.reached.tmp")),
        root.join(format!("{stage}.reached")),
    )
    .context(h!())?;
    while !root
        .join(format!("{stage}.release"))
        .try_exists()
        .context(h!())?
    {
        tokio::time::sleep(std::time::Duration::from_millis(
            crate::config::DEVICE_UPLOAD_FINALIZATION_FAULT_POLL_MILLIS,
        ))
        .await;
    }
    Ok(())
}

#[cfg(test)]
static STORAGE_DISPATCHES: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<Uuid, usize>>,
> = std::sync::LazyLock::new(|| {
    std::sync::Mutex::new(std::collections::HashMap::new())
});

#[cfg(test)]
pub(crate) fn storage_dispatch(attempt: Uuid) {
    *STORAGE_DISPATCHES
        .lock()
        .unwrap()
        .entry(attempt)
        .or_default() += 1;
}

#[cfg(test)]
pub(crate) fn storage_dispatches(attempt: Uuid) -> usize {
    STORAGE_DISPATCHES
        .lock()
        .unwrap()
        .get(&attempt)
        .copied()
        .unwrap_or(0)
}
