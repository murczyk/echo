import type {
  DeviceArchiveOrigin,
  DeviceArchiveSummary,
  DeviceFileTreeEntry,
  LocateDeviceFileRsp,
} from '../../../../Bindings';
import { normalizeFilePreviewMetadata } from '../shared/message-card/attachment-preview/file-preview-source';
import { getFilePreviewKind } from '../shared/message-card/file-preview-kind';

type SourceFields =
  | 'createdAt'
  | 'updatedAt'
  | 'syncId'
  | 'sourceFileState'
  | 'archive'
  | 'isArchive'
  | 'archiveOrigin'
  | 'virtualPath';
export type DeviceFileSelection = Omit<DeviceFileTreeEntry, SourceFields> &
  Partial<Pick<DeviceFileTreeEntry, Exclude<SourceFields, 'archive'>>> & {
    archive?: DeviceArchiveSummary | null;
    archiveOrigin?: DeviceArchiveOrigin | null;
    archiveParents?: DeviceFileSelection[];
  };

export function isDeviceArchive(file: DeviceFileSelection) {
  if (file.isArchive !== undefined) return file.kind === 'file' && file.isArchive;
  return (
    file.kind === 'file' &&
    getFilePreviewKind({
      ...normalizeFilePreviewMetadata({
        fileName: file.name,
        extension: file.extension,
        contentType: file.mimeType,
      }),
      key: file.entryId,
      originalHref: '',
      sizeBytes: null,
    }) === 'zip'
  );
}

export function isDeviceFolder(file: DeviceFileSelection) {
  return file.kind === 'directory' || (isDeviceArchive(file) && file.archive?.state === 'ready');
}

export function archiveMemberSelection(
  archive: DeviceFileSelection,
  entry: DeviceFileTreeEntry,
): DeviceFileSelection {
  return {
    ...entry,
    pathComponents: entry.virtualPath?.split('/') ?? [...archive.pathComponents, entry.name],
    archiveParents: [...(archive.archiveParents ?? []), archive],
  };
}

export function locatedFileSelection(located: LocateDeviceFileRsp): DeviceFileSelection {
  const archiveParents: DeviceFileSelection[] = [];
  for (const ancestor of located.ancestors) {
    if (isDeviceArchive(ancestor))
      archiveParents.push({ ...ancestor, archiveParents: [...archiveParents] });
  }
  return { ...located.file, archiveParents };
}
