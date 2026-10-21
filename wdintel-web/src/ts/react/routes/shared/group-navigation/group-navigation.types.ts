import type { SignalGroupEntry } from '../../../../../Bindings';

export type GroupScope = { kind: 'all' } | { kind: 'group'; masterKey: string };

export type GroupNavigationItem =
  | { kind: 'all'; masterKey: null; name: string }
  | ({ kind: 'group' } & Pick<SignalGroupEntry, 'masterKey' | 'name' | 'colorKey'>);

export type GroupFilterNavigationModel = {
  groups: GroupNavigationItem[];
  scope: GroupScope;
  loading: boolean;
  error: unknown;
  select: (scope: GroupScope) => void;
  retry?: () => void;
};
