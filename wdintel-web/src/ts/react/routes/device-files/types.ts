import type {
  DeviceFile,
  DeviceFileTreeEntry,
  FileEntryKind,
  FileSyncErrorCode,
  FileSyncFieldError,
  FileSyncOperation,
  SourceFileState,
  TagMatch,
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
export type DeviceAnalyticsTagFilter = {
  tagIds: string[];
  tagMatch: TagMatch;
  untagged: boolean;
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
      fileId: string;
      revision: number;
      file: DeviceFile;
    }
  | {
      kind: 'rejected';
      code: FileSyncErrorCode;
      message: string;
      fieldErrors: FileSyncFieldError[];
    };

export type DeviceFileSyncRow = {
  localId: string;
  existing: boolean;
  absolutePath: string;
  mimeType: string;
  extension: string;
  fileMetadataCreatedAt: string | null;
  fileMetadataModifiedAt: string | null;
  sourceFileState: SourceFileState | null;
  fieldErrors: Partial<Record<DeviceFileSyncField, string>>;
  result: DeviceFileSyncResult | null;
};

export type DeviceFileSyncSeed = {
  entry: DeviceFileTreeEntry | null;
};
