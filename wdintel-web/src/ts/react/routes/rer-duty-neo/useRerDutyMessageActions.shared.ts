import type {
  InboxMessage,
  RerDutyQueryStateWf as RerDutyFeedFilterState,
  SavedFilterDuty,
  SignalGroupEntry,
  SignalProfileEntry,
  Tag,
} from '../../../../Bindings';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { MessageFeedState } from './utils';

export type MessageActionsDeps = {
  messageFeeds: MessageFeedState[];
  setMessageFeeds: Dispatch<SetStateAction<MessageFeedState[]>>;
  setError: (value: SetStateAction<string | null>) => void;
  applyFilter: (feedId: string, f: RerDutyFeedFilterState) => void;
  loadFeedInitialMessages: (
    feedId: string,
    overrides?: { highlightSignalsEnabled?: boolean },
  ) => Promise<void>;
  loadFeedNewerMessages: (
    feedId: string,
    opts?: {
      nolimit?: boolean;
      scrollToEndAfterLoad?: boolean;
      markAllReadAfterAppend?: boolean;
      showLoading?: boolean;
      followGeneration?: number;
    },
  ) => Promise<void>;
  showArrowResult: (feedId: string, message: string) => void;
  columnRefsRef: MutableRefObject<
    Record<string, { scrollToEnd: (behavior?: ScrollBehavior) => void } | null>
  >;
  setWatchModeByFeedId: Dispatch<SetStateAction<Record<string, boolean>>>;
  setLoadingNewerFeedIds: Dispatch<SetStateAction<Set<string>>>;
  requestValidatedInboxCount: (feedId: string) => Promise<{
    feedId: string;
    quantity: number;
    cursorId: number | null;
    hasItems: boolean;
    requestSignature: string;
  } | null>;
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
  beginFollowTail: (feedId: string) => number;
  openPointsOnMap?: (etalons: string[], message: InboxMessage) => void;
};
