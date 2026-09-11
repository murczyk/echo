import type { FileEntryKind, TagMatch } from '../../../../Bindings';

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
