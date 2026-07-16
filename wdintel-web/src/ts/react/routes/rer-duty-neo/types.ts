import type {
  CallsignInfoRes,
  InboxMessage,
  Network,
  OrganismKeywordSetDto,
  RerDutyQueryStateWf as RerDutyFeedFilterState,
  SignalGroupEntry,
  SignalProfileEntry,
  Tag,
  Unit,
} from '../../../../Bindings';
import type { MessageEntityFilterKind, TagsLayoutVariant, MessageFeedState } from './utils';
import type { FeedFilterPanelModel } from './FeedFilterPanel';
import type { MessageCardBotTagAction } from '../shared/message-card/message-card.types';

export type FeedColumnModel = {
  feed: MessageFeedState;
  view: {
    /** Viewport below MUI `sm`: full-width columns, horizontal snap, flexible feed min-height. */
    narrowScreen?: boolean;
    /** Number of feeds (columns). Passed to MessageCard for header column shrink behavior. */
    feedCount?: number;
    canRemove: boolean;
    maxWidth?: string | number;
    isWatchMode?: boolean;
    scrollTrackingEnabled?: boolean;
    loadingNewer?: boolean;
    arrowResultMessage?: string | null;
    unreadCount?: number;
  };
  filterPanel: FeedFilterPanelModel;
  keywordsPanel: {
    keywordSets: OrganismKeywordSetDto[];
    onFilterChange: (feedId: string, nextFilter: RerDutyFeedFilterState) => void;
    onKeywordSetsReload: () => Promise<void>;
  };
  messageCard: {
    /** Current auth user display name for message watermarks */
    authUserName: string | null;
    copiedFeedbackId: string | null;
    networkDisplayMap: Record<number, string>;
    networkMap: Record<number, Network>;
    unitsMap: Record<number, Unit>;
    callsignInfoMap: Record<string, CallsignInfoRes>;
    groupInfos: Record<string, SignalGroupEntry>;
    profiles: Record<string, SignalProfileEntry | null>;
    /** When true, empty network ids do not fall back to `msg.unit`. Server `featureStrictNetworks`. */
    featureStrictNetworks: boolean;
    tagsLayout: TagsLayoutVariant;
    tagsMap: Record<number, Tag>;
    tagsOrder: number[];
    botTagAction: MessageCardBotTagAction | null;
    onCancelBotTagAction: () => void;
    onMarkBotTagWrong: (messageId: number, tagId: number) => void | Promise<void>;
    onOpenPointsOnMap?: (etalons: string[], message: InboxMessage) => void;
  };
  actions: {
    onLoadOlder: () => void;
    onLoadNewer?: () => void;
    onRemoveColumn: () => void;
    onMessageBookmark: (msgId: number, currentlyBookmarked: boolean) => void;
    onMessageImportant: (msgId: number, currentlyImportant: boolean) => void;
    onMessageAddFrequencyToFilter: (feedId: string, freq: string) => void;
    onMessageCopy: (text: string, feedbackId: string) => void;
    onMessageComment: (msgId: number, currentComment: string | null) => void;
    onMessageExcludeEntity: (entity: MessageEntityFilterKind, value: string) => void;
    onMessageToggleTag: (msgId: number, tagId: number) => void;
    onCreateMessageFeed?: () => void;
    onScrollToTop?: () => void;
    /** Called when user scrolls to bottom; use to enable watch mode (same as after arrow click). */
    onReachedBottom?: () => void;
    /** Called when user scrolls away from bottom; use to disable watch mode so we don't load new messages. */
    onLeftBottom?: () => void;
    /** Called when the scroller enters or leaves the near-bottom pixel zone. Used so polling can load newer messages while the user follows the tail. */
    onNearBottomChange?: (near: boolean) => void;
    /** Pixel-level at-bottom state; used so auto-scroll follow only runs when the scroller is actually at the bottom. */
    onAtBottomChange?: (atBottom: boolean) => void;
    onArrowClick?: () => void;
    /** Called when the visible range changes; pass message IDs in view so parent can add them to readIds. When user reaches bottom, called with all IDs and atBottom: true so badge clears. */
    onVisibleMessageIds?: (lastVisibleId: number, opts?: { atBottom?: boolean }) => void;
  };
};
