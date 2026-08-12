use crate::config::GOI_XLSX_SYNC_FILE_PREFIX;
use anyhow::Context;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

static GOI_XLSX_SYNC_LOCK: tokio::sync::Mutex<()> =
    tokio::sync::Mutex::const_new(());

pub async fn replace_xlsx_file(
    path: &Path,
    file_data: &[u8],
) -> anyhow::Result<bool> {
    let _sync_guard = GOI_XLSX_SYNC_LOCK.lock().await;
    let parent = path.parent().context("XLSX path has no parent directory")?;
    tokio::fs::create_dir_all(parent).await?;

    let sync_path = sync_xlsx_path(path)?;
    if xlsx_file_matches(path, file_data).await? {
        let _ = tokio::fs::remove_file(&sync_path).await;
        return Ok(false);
    }
    let result = async {
        tokio::fs::write(&sync_path, file_data).await?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            tokio::fs::set_permissions(
                &sync_path,
                std::fs::Permissions::from_mode(0o644),
            )
            .await?;
        }
        tokio::fs::rename(&sync_path, path).await?;
        anyhow::Ok(true)
    }
    .await;

    if result.is_err() {
        let _ = tokio::fs::remove_file(&sync_path).await;
    }
    result
}

async fn xlsx_file_matches(
    path: &Path,
    file_data: &[u8],
) -> anyhow::Result<bool> {
    match tokio::fs::read(path).await {
        Ok(current_file_data) => Ok(current_file_data == file_data),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(err) => Err(err.into()),
    }
}

fn sync_xlsx_path(path: &Path) -> anyhow::Result<PathBuf> {
    let file_name = path.file_name().context("XLSX path has no file name")?;
    let mut sync_file_name = OsString::from(GOI_XLSX_SYNC_FILE_PREFIX);
    sync_file_name.push(file_name);
    Ok(path.with_file_name(sync_file_name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn sync_xlsx_path_prefixes_original_file_name() {
        let path = Path::new("/etc/goi/data/xlsx/knowledge.xlsx");

        assert_eq!(
            sync_xlsx_path(path).expect("sync path"),
            Path::new("/etc/goi/data/xlsx/_sync_knowledge.xlsx")
        );
    }

    #[tokio::test]
    async fn replace_xlsx_file_hot_swaps_sync_copy() {
        let dir = temp_dir("goi-xlsx-hot-swap");
        tokio::fs::create_dir_all(&dir)
            .await
            .expect("create temp dir");
        let path = dir.join("knowledge.xlsx");
        let sync_path = dir.join("_sync_knowledge.xlsx");
        tokio::fs::write(&path, b"original")
            .await
            .expect("write original");

        replace_xlsx_file(&path, b"replacement")
            .await
            .expect("replace XLSX");

        assert_eq!(
            tokio::fs::read(&path).await.expect("read replacement"),
            b"replacement"
        );
        assert!(!sync_path.exists());

        tokio::fs::remove_dir_all(dir).await.ok();
    }

    #[tokio::test]
    async fn replace_xlsx_file_skips_identical_copy() {
        let dir = temp_dir("goi-xlsx-unchanged");
        tokio::fs::create_dir_all(&dir)
            .await
            .expect("create temp dir");
        let path = dir.join("frequencies.xlsx");
        let sync_path = dir.join("_sync_frequencies.xlsx");
        tokio::fs::write(&path, b"unchanged")
            .await
            .expect("write original");
        tokio::fs::write(&sync_path, b"stale")
            .await
            .expect("write stale sync copy");

        let replaced = replace_xlsx_file(&path, b"unchanged")
            .await
            .expect("compare XLSX");

        assert!(!replaced);
        assert_eq!(
            tokio::fs::read(&path).await.expect("read original"),
            b"unchanged"
        );
        assert!(!sync_path.exists());

        tokio::fs::remove_dir_all(dir).await.ok();
    }

    fn temp_dir(prefix: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir()
            .join(format!("{prefix}-{}-{suffix}", std::process::id()))
    }
}
