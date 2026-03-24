import { Box } from '@mui/material';

import type { InboxMessage, Network, Tag } from '../../../../Bindings';
import { MessageCardEtalonLocationTime, MessageCardMessageBody, MessageCardWatermark } from './MessageCardContent';
import { MessageCardHeader, type MessageCardHeaderProps } from './MessageCardHeader';
import { useRelativeTimeDisplayMs } from './useRelativeTimeDisplayMs';
import {
  buildAnalysisHref,
  buildAnalysisMapHrefWithSearch,
  etalonFallbackWhenNoNetworks,
  getPointEtalonsFromMessage,
} from './utils';

export type MessageCardProps = {
  id: number;
  msg: InboxMessage;
  feedId: string;
  /** Number of feeds (columns). When >= 3, header columns use differential shrink (left 3, center 2, right 0). When 1 or 2, all columns shrink equally. */
  feedCount?: number;
  /** 'dividers' = sections with borders; 'fluid' = no dividers, spacing only (for A/B testing). */
  layoutVariant?: 'dividers' | 'fluid';
  /** Baseline "now" when the card is off-screen; while visible, relative time updates every minute. */
  referenceTimeMs: number | null;
  /** Auth user display name for background watermark */
  authUserName: string | null;
  groupName: string | null;
  senderName: string | null;
  copiedFeedbackId: string | null;
  networkDisplayMap: Record<number, string>;
  /** Loaded network models (for «в дорозвідці» badge); keys match `msg.networkIds`. */
  networkMap?: Record<number, Network>;
  /** When false, show `msg.unit` if network ids are empty (and freq present). */
  featureStrictNetworks?: boolean;
  tagsMap: Record<number, Tag>;
  onBookmark: () => void;
  onImportant: () => void;
  onCopyText: () => void;
  onCopyFreq: () => void;
  onComment: () => void;
  onDelete?: () => void;
  onEditDetails?: () => void;
  onToggleTag: (tagId: number) => void;
};

export function MessageCard({
  id,
  msg,
  feedId: _feedId,
  feedCount = 1,
  layoutVariant = 'dividers',
  referenceTimeMs,
  authUserName,
  groupName,
  senderName,
  copiedFeedbackId,
  networkDisplayMap,
  networkMap = {},
  featureStrictNetworks = false,
  tagsMap,
  onBookmark,
  onImportant,
  onCopyText,
  onCopyFreq,
  onComment,
  onDelete,
  onEditDetails,
  onToggleTag,
}: MessageCardProps) {
  const [messageRootRef, relativeTimeMs] = useRelativeTimeDisplayMs(referenceTimeMs, msg.timestamp);
  const networkIds = Array.from(new Set(msg.networkIds ?? []));
  const etalonNoNetworkLabel = etalonFallbackWhenNoNetworks(msg, { featureStrictNetworks });
  const pointEtalons = getPointEtalonsFromMessage(msg, tagsMap);
  const mapHref = pointEtalons.length > 0 ? buildAnalysisMapHrefWithSearch(pointEtalons) : buildAnalysisHref(msg, true);
  const watermarkUserName = authUserName?.trim() ?? '';

  const headerProps: MessageCardHeaderProps = {
    layout: layoutVariant === 'fluid' ? 'fluid' : 'dividers',
    feedCount,
    id,
    msg,
    mapHref,
    copiedFeedbackId,
    groupName,
    senderName,
    onBookmark,
    onImportant,
    onComment,
    onCopyText,
    onCopyFreq,
    onDelete,
    onEditDetails,
  };

  return (
    <Box
      ref={messageRootRef}
      component="li"
      className="list-none flex flex-col pr-0 pl-2 rer-duty-message mb-2 font-size-[13px] pb-2"
    >
      <div className="flex flex-col w-full bg-card rounded-sm p-2 gap-2 relative">
        {watermarkUserName !== '' && (
          <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden>
            <MessageCardWatermark authUserName={watermarkUserName} />
          </div>
        )}
        <MessageCardHeader {...headerProps} />
        <MessageCardEtalonLocationTime
          networkIds={networkIds}
          networkDisplayMap={networkDisplayMap}
          networkMap={networkMap}
          etalonNoNetworkLabel={etalonNoNetworkLabel}
          msg={msg}
          relativeTimeMs={relativeTimeMs}
        />
        <MessageCardMessageBody msg={msg} tagsMap={tagsMap} onToggleTag={onToggleTag} />
      </div>
    </Box>
  );
}
