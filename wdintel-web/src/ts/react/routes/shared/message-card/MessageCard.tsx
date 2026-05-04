import BarChartOutlinedIcon from '@mui/icons-material/BarChartOutlined';
import MapOutlinedIcon from '@mui/icons-material/MapOutlined';
import { Box, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import { useMemo } from 'react';
import type { CallsignInfoRes, InboxMessage, MessageComment, Network, Tag, Unit, User } from '../../../../../Bindings';
import { MessageCardContent, MessageCardWatermark, type AnalysisCallsignActions } from './MessageCardContent';
import { MessageCardHeader, type MessageCardDisplayMode, type MessageCardHeaderProps } from './MessageCardHeader';
import { useRelativeTimeDisplayMs } from './useRelativeTimeDisplayMs';
import { isPresent } from '../../../utils/misc';
import {
  buildAnalysisHref,
  buildAnalysisMapHrefWithSearch,
  etalonFallbackWhenNoNetworks,
  getPointEtalonsFromMessage,
  messageRenderDistance,
  type TagsLayoutVariant,
} from '../../rer-duty-neo/utils';

/** Share of the header row (network vs relative time) reserved for etalon / network block. */
export const MESSAGE_CARD_HEADER_NETWORK_ROW_WIDTH_PCT = 90;

export type MessageCardProps = {
  id: number;
  msg: InboxMessage;
  /** Number of feeds (columns). When >= 3, header columns use differential shrink (left 3, center 2, right 0). When 1 or 2, all columns shrink equally. */
  feedCount?: number;
  /** Duty vs analysis: controls stacked action icon grid width (4 vs 3 columns). */
  displayMode?: MessageCardDisplayMode;
  /** Tag chips section visual density mode. */
  tagsLayout?: TagsLayoutVariant;
  tagsLoading?: boolean;
  /** Baseline "now" when the card is off-screen; while visible, relative time updates every minute. */
  referenceTimeMs: number | null;
  /** Auth user display name for background watermark */
  authUserName: string | null;
  groupName: string | null;
  senderName: string | null;
  copiedFeedbackId: string | null;
  currentUser: User | null;
  networkDisplayMap: Record<number, string>;
  messageComments?: MessageComment[];
  searchText?: string | null;
  /** Loaded network models (for «в дорозвідці» badge); keys match `msg.networkIds`. */
  networkMap?: Record<number, Network>;
  /** When false, show `msg.unit` if network ids are empty (and freq present). */
  featureStrictNetworks?: boolean;
  tagsMap: Record<number, Tag>;
  callsignInfoMap?: Record<string, CallsignInfoRes>;
  networks?: Network[];
  unitsMap?: Record<number, Unit>;
  users: Record<string, User | null>;
  onBookmark: () => void;
  onImportant: () => void;
  onCopyText: () => void;
  onCopyFreq: () => void;
  onComment: () => void;
  onDelete?: () => void;
  onEditDetails?: () => void;
  onToggleTag: (tagId: number) => void;
  rightHeaderInsetPx?: number;
  analysisCallsignActions?: AnalysisCallsignActions;
};

export function MessageCard({
  id,
  msg,
  feedCount = 1,
  displayMode = 'duty',
  tagsLayout = 'full',
  tagsLoading = false,
  referenceTimeMs,
  authUserName,
  groupName,
  senderName,
  copiedFeedbackId,
  currentUser,
  networkDisplayMap,
  messageComments = [],
  searchText,
  networkMap = {},
  featureStrictNetworks = false,
  tagsMap,
  callsignInfoMap,
  networks,
  unitsMap,
  users,
  onBookmark,
  onImportant,
  onCopyText,
  onCopyFreq,
  onComment,
  onDelete,
  onEditDetails,
  onToggleTag,
  rightHeaderInsetPx = 0,
  analysisCallsignActions,
}: MessageCardProps) {
  const [messageRootRef, relativeTimeMs] = useRelativeTimeDisplayMs(referenceTimeMs, msg.timestamp);
  const networkIds = Array.from(new Set(msg.networkIds ?? []));
  const compactLayout = feedCount >= 3;
  const derivedNetworkMap = useMemo(() => {
    if (Object.keys(networkMap).length > 0) return networkMap;
    if (!networks) return {};
    return Object.fromEntries(networks.map((network) => [network.id, network]));
  }, [networkMap, networks]);
  const etalonNoNetworkLabel = etalonFallbackWhenNoNetworks(msg, { featureStrictNetworks });
  const pointEtalons = getPointEtalonsFromMessage(msg, tagsMap);
  const mapHref =
    pointEtalons.length > 0 ? buildAnalysisMapHrefWithSearch(pointEtalons, msg) : buildAnalysisHref(msg, true);
  const watermarkUserName = authUserName?.trim() ?? '';
  const timeDistance =
    isPresent(msg.timestamp) && isPresent(relativeTimeMs) ? messageRenderDistance(msg.timestamp, relativeTimeMs) : null;

  const topRight =
    displayMode === 'duty' ? (
      isPresent(timeDistance) ? (
        <Box sx={{ flex: '1 1 0', minWidth: 0, display: 'flex', justifyContent: 'flex-end' }}>
          <Typography variant="caption" sx={{ color: 'text.secondary', whiteSpace: 'nowrap' }}>
            {timeDistance}
          </Typography>
        </Box>
      ) : (
        <Box sx={{ minHeight: 28 }} />
      )
    ) : (
      <Box sx={{ minHeight: 28 }} />
    );

  const actionsRight =
    displayMode === 'duty' ? (
      <Stack direction="row" spacing={0.75} alignItems="center" justifyContent="flex-end" flexWrap="wrap">
        <CardActionLink
          href={mapHref}
          icon={<MapOutlinedIcon aria-hidden />}
          label="Відкрити мапу"
          target="_blank"
        />
        <CardActionLink
          href={buildAnalysisHref(msg, false)}
          icon={<BarChartOutlinedIcon aria-hidden />}
          label="Відкрити аналіз"
          target="_blank"
        />
      </Stack>
    ) : null;

  const headerProps: MessageCardHeaderProps = {
    compact: compactLayout,
    displayMode,
    networkRowContentWidthPct: MESSAGE_CARD_HEADER_NETWORK_ROW_WIDTH_PCT,
    id,
    msg,
    copiedFeedbackId,
    groupName,
    senderName,
    networkIds,
    networkDisplayMap,
    networkMap: derivedNetworkMap,
    etalonNoNetworkLabel,
    rightInsetPx: rightHeaderInsetPx,
    topRight,
    actionsRight,
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
        fontSize: 14,
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
          fontSize: 14,
          '& .MuiTypography-root': {
            fontSize: 14,
          },
          '& a': {
            fontSize: 14,
          },
        }}
      >
        {watermarkUserName !== '' && (
          <Box sx={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }} aria-hidden>
            <MessageCardWatermark authUserName={watermarkUserName} />
          </Box>
        )}
        <MessageCardHeader {...headerProps} />
        <MessageCardContent
          msg={msg}
          tagsMap={tagsMap}
          tagsLoading={tagsLoading}
          onToggleTag={onToggleTag}
          tagsLayout={tagsLayout}
          analysisCallsignActions={analysisCallsignActions}
          callsignInfoMap={callsignInfoMap}
          networks={networks}
          unitsMap={unitsMap}
          authUserName={authUserName}
          currentUser={currentUser}
          messageComments={messageComments}
          users={users}
          searchText={searchText}
        />
      </Box>
    </Box>
  );
}

type BaseMessageCardProps = Omit<MessageCardProps, 'displayMode'>;

export function DutyMessageCard(props: BaseMessageCardProps) {
  return <MessageCard {...props} displayMode="duty" />;
}

export function AnalysisMessageCard(props: BaseMessageCardProps) {
  return <MessageCard {...props} displayMode="analysis" />;
}

function CardActionLink({
  href,
  icon,
  label,
  target,
}: {
  href: string;
  icon: JSX.Element;
  label: string;
  target?: '_blank';
}) {
  return (
    <Tooltip title={label} enterDelay={300}>
      <IconButton
        component="a"
        href={href}
        target={target}
        rel={target === '_blank' ? 'noopener noreferrer' : undefined}
        aria-label={label}
        size="small"
        color="inherit"
      sx={{
        width: 30,
        height: 30,
        borderRadius: 999,
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: 'color-mix(in srgb, var(--color-card) 88%, white 12%)',
        color: 'text.primary',
        transition: 'background-color 120ms ease, border-color 120ms ease, color 120ms ease, transform 120ms ease',
        '& .MuiSvgIcon-root': {
          fontSize: 16,
          color: 'var(--color-icons)',
          flexShrink: 0,
        },
        '&:hover': {
          bgcolor: 'action.hover',
          borderColor: 'var(--message-callsign-color)',
          color: 'var(--message-callsign-color)',
          textDecoration: 'none',
        },
        '&:focus-visible': {
          outline: '2px solid var(--message-callsign-color)',
          outlineOffset: '2px',
        },
      }}
      >
        {icon}
      </IconButton>
    </Tooltip>
  );
}
