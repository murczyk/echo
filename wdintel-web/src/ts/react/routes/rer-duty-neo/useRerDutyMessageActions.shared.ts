import type {
  InboxMessagesReq,
  RerDutyQueryStateWf as RerDutyFeedFilterState,
  SavedFilterDuty,
  SignalGroupEntry,
  SignalProfileEntry,
  Tag,
} from '../../../../Bindings';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { FeedColumnHandle } from './FeedColumn';
import { buildInboxReq } from './utils';
import type { MessageFeedState } from './utils';

export type MessageActionsDeps = {
  messageFeeds: MessageFeedState[];
  setMessageFeeds: Dispatch<SetStateAction<MessageFeedState[]>>;
  setError: (value: SetStateAction<string | null>) => void;
  applyFilter: (feedId: string, f: RerDutyFeedFilterState) => void;
  loadFeedInitialMessages: (
    feedId: string,
    overrides?: { highlightSignalsEnabled?: boolean; onlyMyUnitTagsEnabled?: boolean },
  ) => Promise<void>;
  loadFeedNewerMessages: (
    feedId: string,
    opts?: { nolimit?: boolean; scrollToEndAfterLoad?: boolean; markAllReadAfterAppend?: boolean },
  ) => Promise<void>;
  buildReqForFeed: (
    feed: MessageFeedState,
    opts: Omit<
      Parameters<typeof buildInboxReq>[0],
      | 'filter'
      | 'expandedFreqsSelected'
      | 'expandedFreqsDenied'
      | 'highlightSignals'
      | 'reportTagsOnlyThisUnit'
    >,
  ) => InboxMessagesReq;
  columnRefsRef: MutableRefObject<Record<string, FeedColumnHandle | null>>;
  showArrowResult: (feedId: string, message: string) => void;
  setWatchModeByFeedId: Dispatch<SetStateAction<Record<string, boolean>>>;
  setLoadingNewerFeedId: Dispatch<SetStateAction<string | null>>;
  authUserName: string | null;
  profiles: Record<string, SignalProfileEntry | null>;
  tagsMap: Record<number, Tag>;
  tagsOrder: number[];
  groupInfos: Record<string, SignalGroupEntry>;
  savedFilters: SavedFilterDuty[];
  setSavedFilters: Dispatch<SetStateAction<SavedFilterDuty[]>>;
  selectedSavedIdByFeedId: Record<string, number | null>;
  setSelectedSavedIdByFeedId: Dispatch<SetStateAction<Record<string, number | null>>>;
  saveFilterNameByFeedId: Record<string, string>;
  setSaveFilterNameByFeedId: Dispatch<SetStateAction<Record<string, string>>>;
  dutyDisableAutoScroll: boolean;
};
