import type {
  DeviceFile,
  DeviceFileRoot,
  DeviceFileTreeEntry,
  FileEntryKind,
  FileSyncError,
  FileSyncOperation,
} from '../../../../Bindings';

export const DEVICE_FILE_PAGE_SIZE = 100;
export const DEVICE_FILE_SUBTREE_COUNT_BATCH_SIZE = 100;

export type DeviceFileLoadError = {
  message: string;
  status: number | null;
};

export type DeviceFileSearchScope = {
  entryId: string;
  rootEntryId: string;
  label: string;
};

export type DeviceFileSearchDraft = {
  nameQuery: string;
  kinds: FileEntryKind[];
  mimeTypes: string;
  extensions: string;
  modifiedFrom: string | null;
  modifiedTo: string | null;
};

export type DeviceFileSearchValidationErrors = Partial<
  Record<'nameQuery' | 'modifiedRange', string>
>;

export type DeviceFileSyncField =
  'absolutePath' | 'mimeType' | 'extension' | 'fileMetadataCreatedAt' | 'fileMetadataModifiedAt';

export type DeviceFileSyncResult =
  | {
      kind: 'accepted';
      operation: FileSyncOperation;
      root: DeviceFileRoot;
      file: DeviceFile;
    }
  | { kind: 'rejected'; error: FileSyncError };

export type DeviceFileSyncRow = {
  localId: string;
  fileId: string | null;
  absolutePath: string;
  mimeType: string;
  extension: string;
  fileMetadataCreatedAt: string | null;
  fileMetadataModifiedAt: string | null;
  fieldErrors: Partial<Record<DeviceFileSyncField, string>>;
  result: DeviceFileSyncResult | null;
};

export type DeviceFileSyncSeed = {
  entry: DeviceFileTreeEntry | null;
};
