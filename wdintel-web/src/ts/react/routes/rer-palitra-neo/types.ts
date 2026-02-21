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

export type UiError = {
  text: string;
};

export type SortColumn = 'name' | 'colorHex' | 'sourceFileName' | 'author' | 'lastUploadedAtTs';
export type SortDirection = 'asc' | 'desc';
