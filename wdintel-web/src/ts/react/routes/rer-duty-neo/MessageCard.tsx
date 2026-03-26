import { Box } from '@mui/material';

import type { InboxMessage, Network, Tag } from '../../../../Bindings';
import { MessageCardMessageBody, MessageCardWatermark } from './MessageCardContent';
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
  rightHeaderInsetPx?: number;
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
  rightHeaderInsetPx = 0,
}: MessageCardProps) {
  const [messageRootRef, relativeTimeMs] = useRelativeTimeDisplayMs(referenceTimeMs, msg.timestamp);
  const networkIds = Array.from(new Set(msg.networkIds ?? []));
  const compactLayout = layoutVariant === 'dividers' && feedCount >= 3;
  const etalonNoNetworkLabel = etalonFallbackWhenNoNetworks(msg, { featureStrictNetworks });
  const pointEtalons = getPointEtalonsFromMessage(msg, tagsMap);
  const mapHref = pointEtalons.length > 0 ? buildAnalysisMapHrefWithSearch(pointEtalons) : buildAnalysisHref(msg, true);
  const watermarkUserName = authUserName?.trim() ?? '';

  const headerProps: MessageCardHeaderProps = {
    layout: layoutVariant === 'fluid' ? 'fluid' : 'dividers',
    compact: compactLayout,
    feedCount,
    id,
    msg,
    mapHref,
    copiedFeedbackId,
    groupName,
    senderName,
    networkIds,
    networkDisplayMap,
    networkMap,
    etalonNoNetworkLabel,
    relativeTimeMs,
    rightInsetPx: rightHeaderInsetPx,
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
      sx={{
        listStyle: 'none',
        display: 'flex',
        flexDirection: 'column',
        pl: 0,
        pr: 0,
        pb: 1.5,
        mb: 0,
        fontSize: 13,
      }}
    >
      <Box
        sx={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          gap: compactLayout ? 1.25 : 1.5,
          width: '100%',
          px: 1.5,
          py: 1.25,
          borderRadius: 1,
          bgcolor: 'var(--color-card)',
          color: 'text.primary',
          overflow: 'hidden',
        }}
      >
        {watermarkUserName !== '' && (
          <Box sx={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }} aria-hidden>
            <MessageCardWatermark authUserName={watermarkUserName} />
          </Box>
        )}
        <MessageCardHeader {...headerProps} />
        <MessageCardMessageBody compact={compactLayout} msg={msg} tagsMap={tagsMap} onToggleTag={onToggleTag} />
      </Box>
    </Box>
  );
}
