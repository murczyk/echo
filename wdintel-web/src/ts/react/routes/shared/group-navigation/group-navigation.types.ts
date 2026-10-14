import type {
  AcknowledgeGroupFeedReq,
  GroupFeedCursorDto,
  GroupFeedState,
} from '../../../../../Bindings';

export type GroupScope = { kind: 'all' } | { kind: 'group'; masterKey: string };

export type GroupNavigationItem =
  | {
      kind: 'all';
      masterKey: null;
      name: string;
      unreadCount: number;
      oldestUnreadMessageRef: null;
      latestCursor: null;
    }
  | ({ kind: 'group' } & GroupFeedState);

export type GroupFeedNavigationModel = {
  groups: GroupNavigationItem[];
  scope: GroupScope;
  ready: boolean;
  loading: boolean;
  error: unknown;
  select: (scope: GroupScope) => void;
  refresh: () => Promise<void>;
  acknowledge: (request: AcknowledgeGroupFeedReq, signal?: AbortSignal) => Promise<GroupFeedState>;
  selectedGroup: GroupNavigationItem;
  selectedCursor: GroupFeedCursorDto | null;
};
