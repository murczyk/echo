import type { Palitra } from '../../../../Bindings';

export type AccessType = 'logins' | 'organisms' | 'aor';

export type PalitraFormState = {
  name: string;
  colorHex: string;
  accessType: AccessType;
  logins: string[];
  organismIds: number[];
  aorIds: number[];
};

export type KmzColorOption = {
  rank: number;
  colorHex: string;
  count: number;
  selected: boolean;
  suffix: string;
};

export type PalitraCreateMode = 'basic' | 'advanced';

export type UiStatus =
  | { kind: 'error'; text: string }
  | { kind: 'success'; text: string }
  | { kind: 'warning'; text: string }
  | null;

export type FolderTreeNode = {
  path: string;
  name: string;
  depth: number;
  childPaths: string[];
  directPalitraIds: number[];
  allPalitraIds: number[];
  modifiablePalitraIds: number[];
};

export type FolderActionKind = 'assign' | 'rename' | 'archive' | 'delete';

export type FolderActionPreview = {
  requestedIds: number[];
  requestedCount: number;
  modifiableIds: number[];
  modifiableCount: number;
  skippedIds: number[];
  skippedCount: number;
  unchangedIds: number[];
  unchangedCount: number;
  descendantFolderCount: number;
};

export type FolderActionDialogState = {
  kind: FolderActionKind;
  folderPath: string;
  nextFolderPath: string;
  targetPalitraIds: number[];
  targetPalitraNames: string[];
  assignRequestedRows?: PalitraRowView[];
  preview: FolderActionPreview;
};

export type FolderActionResultSummary = {
  requestedIds: number[];
  requestedCount: number;
  changedIds: number[];
  changedCount: number;
  skippedIds: number[];
  skippedCount: number;
};

export type FolderTableRowView = {
  id: string;
  kind: 'folder';
  folderPath: string;
  hiddenByCollapsedFolder: boolean;
  name: string;
  depth: number;
  totalCount: number;
  modifiableCount: number;
  childCount: number;
  isExpanded: boolean;
  canSelect: false;
  canModify: boolean;
  archiveInFlight: boolean;
  deleteInFlight: boolean;
  downloadInFlight: false;
  uploadInFlight: false;
  retryInFlight: false;
  colorHex: null;
  sourceFileName: null;
  lastUploadedAtTs: null;
  author: null;
  accessSummary: string;
};

export type PalitraRowView = {
  id: number;
  kind: 'palitra';
  palitra: Palitra;
  hiddenByCollapsedFolder: boolean;
  name: string;
  depth: number;
  colorHex: string;
  sourceFileName: string | null;
  lastUploadedAtTs: number | null;
  author: string | null;
  accessSummary: string;
  canModify: boolean;
  canSelect: boolean;
  archiveInFlight: boolean;
  deleteInFlight: boolean;
  downloadInFlight: boolean;
  uploadInFlight: boolean;
  retryInFlight: boolean;
};

export type TableRowView = FolderTableRowView | PalitraRowView;
