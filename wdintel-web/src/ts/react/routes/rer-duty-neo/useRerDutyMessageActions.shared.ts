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
import type { ExplicitFeedNavigation } from './useRerDutyNavigation';
import type { ExplicitScrollNavigation } from './windowed-feed-scroll-shared';

export type MessageActionsDeps = {
  messageFeeds: MessageFeedState[];
  setMessageFeeds: Dispatch<SetStateAction<MessageFeedState[]>>;
  setError: (value: SetStateAction<string | null>) => void;
  applyFilter: (feedId: string, f: RerDutyFeedFilterState) => void;
  loadFeedInitialMessages: (
    feedId: string,
    overrides?: { highlightSignalsEnabled?: boolean },
  ) => Promise<{ id: number; timestamp: number | null } | null | void>;
  loadFeedNewerMessages: (
    feedId: string,
    opts?: {
      nolimit?: boolean;
      scrollToEndAfterLoad?: boolean;
      markAllReadAfterAppend?: boolean;
      showLoading?: boolean;
      followGeneration?: number;
    },
  ) => Promise<{ ok: boolean; addedCount: number }>;
  flushPendingNewerMessages: (
    feedId: string,
    opts?: { markAllRead?: boolean; urgent?: boolean },
  ) => void;
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
  catchUpFeedUnreadToTail: (feedId: string) => void;
  authUserName: string | null;
  currentUserOrganismId: number | null;
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
  beginExplicitNavigation: (feedId: string) => ExplicitFeedNavigation;
  isExplicitNavigationCurrent: (operation: ExplicitFeedNavigation) => boolean;
  registerExplicitLanding: (
    operation: ExplicitFeedNavigation,
    target: { id: number; timestamp: number | null },
    complete: () => void,
  ) => boolean;
  registerExplicitLoading: (
    operation: ExplicitFeedNavigation,
    releaseLoading: () => void,
  ) => boolean;
  cancelExplicitNavigation: (operation: ExplicitFeedNavigation) => boolean;
  registerExplicitScheduledWork: (operation: ExplicitFeedNavigation, cancel: () => void) => boolean;
  clearExplicitScheduledWork: (operation: ExplicitFeedNavigation) => void;
  getExplicitScrollNavigation: (
    feedId: string,
    generation: number,
  ) => ExplicitScrollNavigation | null;
  openPointsOnMap?: (etalons: string[], message: InboxMessage) => void;
};
