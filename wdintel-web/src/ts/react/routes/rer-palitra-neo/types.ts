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

export type UiError = {
  text: string;
};

export type PalitraRowView = {
  id: number;
  palitra: Palitra;
  name: string;
  colorHex: string;
  sourceFileName: string | null;
  lastUploadedAtTs: number | null;
  author: string | null;
  accessSummary: string;
  canModify: boolean;
  canSelect: boolean;
  deleteInFlight: boolean;
  uploadInFlight: boolean;
};
