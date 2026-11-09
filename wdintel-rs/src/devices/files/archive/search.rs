use super::tree::Snapshot;
use crate::devices::files::{
    sessions, types::SearchDeviceFilesReq, types::SearchDeviceFilesRsp,
};
use crate::file_registry::FileRegistryDb;
use crate::{error::AppError, h, types::ShortContext};

pub(in crate::devices::files) async fn search(
    files: &FileRegistryDb,
    snapshot: &Snapshot,
    body: SearchDeviceFilesReq,
) -> Result<SearchDeviceFilesRsp, AppError> {
    let scope = format!(
        "archive:{}:{}",
        snapshot.job.id,
        sessions::read::scope_key("search", &body).c(h!())?
    );
    let mut response = sessions::read::search_snapshot(
        files,
        body,
        sessions::query::SessionQuery::archive(
            snapshot.device,
            snapshot.job.root_id,
        ),
        &snapshot.entry.hierarchy_path.to_string(),
        &scope,
    )
    .await
    .c(h!())?;
    super::hydrate::tree(
        files.connection(),
        snapshot.device,
        &mut response.entries,
    )
    .await
    .c(h!())?;
    Ok(response)
}
