mod common;
mod device;
mod files;

#[allow(unused_imports)]
pub use common::{
    AorSummary, FieldError, FileEntryKind, PathSyntax, UnitSummary,
};
pub use device::{
    CreateDeviceReq, DeviceArchivedFilter, DeviceDetailReq, DeviceDetails,
    DeviceListItem, DeviceListSortBy, DeviceStatusCounts, DeviceUnitStat,
    DeviceUnitStatsRsp, ListDevicesReq, ListDevicesRsp, UpdateDeviceReq,
};
#[allow(unused_imports)]
pub use files::{
    BrowseDeviceFilesReq, BrowseDeviceFilesRsp, CountDeviceFileSubtreesReq,
    CountDeviceFileSubtreesRsp, DeviceFile, DeviceFileJournalEntry,
    DeviceFileRoot, DeviceFileSubtreeCount, DeviceFileTreeEntry,
    FileBreadcrumb, FileSyncError, FileSyncErrorKind, FileSyncOperation,
    FileSyncResult, JournalDeviceFilesReq, JournalDeviceFilesRsp,
    ListDeviceFileRootsReq, ListDeviceFileRootsRsp, SearchDeviceFilesReq,
    SearchDeviceFilesRsp, SyncDeviceFileItem, SyncDeviceFilesReq,
    SyncDeviceFilesRsp,
};

pub(in crate::devices) use common::{
    format_datetime, parse_datetime, parse_uuid, NullablePatch, RequiredPatch,
};
