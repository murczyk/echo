import type { FileEntryKind, TagMatch } from '../../../../Bindings';

export const DEVICE_FILE_PAGE_SIZE = 100;
export const DEVICE_FILE_PAGE_PREFETCH_MARGIN_PX = 240;
export const DEVICE_FILE_DIRECTORY_HISTORY_LIMIT = 20;
export const DEVICE_FILE_LOADING_PLACEHOLDER_COUNT = 6;
export const DEVICE_FILE_SUBTREE_COUNT_BATCH_SIZE = 100;

export type DeviceFileScrollPositions = Map<'grid' | 'list', { top: number; left: number }>;

export type DeviceFileLoadError = {
  message: string;
  status: number | null;
};

export type DeviceFileSearchScope = {
  archiveRevision?: number | null;
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
  globalSearch?: boolean;
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

export type DeviceFileVideoPlayback = {
  sourceKey: string;
  currentTime: number;
  paused: boolean;
  volume: number;
  muted: boolean;
  playbackRate: number;
};
