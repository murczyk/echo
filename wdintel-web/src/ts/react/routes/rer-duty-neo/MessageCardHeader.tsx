import AccountCircleOutlinedIcon from '@mui/icons-material/AccountCircleOutlined';
import BarChartOutlinedIcon from '@mui/icons-material/BarChartOutlined';
import BookmarkBorderOutlinedIcon from '@mui/icons-material/BookmarkBorderOutlined';
import BookmarkOutlinedIcon from '@mui/icons-material/BookmarkOutlined';
import CalendarTodayOutlinedIcon from '@mui/icons-material/CalendarTodayOutlined';
import ChatBubbleOutlineOutlinedIcon from '@mui/icons-material/ChatBubbleOutlineOutlined';
import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';
import GraphicEqOutlinedIcon from '@mui/icons-material/GraphicEqOutlined';
import LocationOnOutlinedIcon from '@mui/icons-material/LocationOnOutlined';
import MapOutlinedIcon from '@mui/icons-material/MapOutlined';
import PeopleOutlineOutlinedIcon from '@mui/icons-material/PeopleOutlineOutlined';
import PriorityHighOutlinedIcon from '@mui/icons-material/PriorityHighOutlined';
import ScheduleOutlinedIcon from '@mui/icons-material/ScheduleOutlined';
import SettingsInputAntennaOutlinedIcon from '@mui/icons-material/SettingsInputAntennaOutlined';
import TuneOutlinedIcon from '@mui/icons-material/TuneOutlined';
import {
  Box,
  IconButton,
  Link,
  Stack,
  Tooltip,
  Typography,
  type SxProps,
  type Theme,
} from '@mui/material';

import type { InboxMessage, Network } from '../../../../Bindings';
import { buildAnalysisHref, formatDateNoYear, formatTime, messageRenderDistance } from './utils';

type ActionIconsRowProps = {
  id: number;
  msg: InboxMessage;
  copiedFeedbackId: string | null;
  onBookmark: () => void;
  onImportant: () => void;
  onComment: () => void;
  onCopyText: () => void;
  onDelete?: () => void;
  onEditDetails?: () => void;
  sx?: SxProps<Theme>;
};

function ActionIconButton({
  title,
  icon,
  onClick,
}: {
  title: string;
  icon: JSX.Element;
  onClick: () => void;
}) {
  return (
    <Tooltip title={title}>
      <IconButton
        size="small"
        aria-label={title}
        onClick={onClick}
        sx={{
          width: 26,
          height: 26,
          color: 'var(--color-action)',
          borderRadius: 0.75,
          '& .MuiSvgIcon-root': { fontSize: 18 },
        }}
      >
        {icon}
      </IconButton>
    </Tooltip>
  );
}

function ActionIconsRow({
  id,
  msg,
  copiedFeedbackId,
  onBookmark,
  onImportant,
  onComment,
  onCopyText,
  onDelete,
  onEditDetails,
  sx,
}: ActionIconsRowProps) {
  return (
    <Stack direction="row" spacing={0.25} useFlexGap flexWrap="wrap" alignItems="center" sx={sx}>
      <ActionIconButton
        title={msg.bookmarked ? 'Прибрати закладку' : 'Додати в закладки'}
        icon={msg.bookmarked ? <BookmarkOutlinedIcon fontSize="inherit" /> : <BookmarkBorderOutlinedIcon fontSize="inherit" />}
        onClick={onBookmark}
      />
      <ActionIconButton
        title={msg.important ? 'Прибрати важливе' : 'Помітити як важливе'}
        icon={<PriorityHighOutlinedIcon fontSize="inherit" />}
        onClick={onImportant}
      />
      <ActionIconButton title="Редагувати коментар" icon={<ChatBubbleOutlineOutlinedIcon fontSize="inherit" />} onClick={onComment} />
      <ActionIconButton
        title="Копіювати повідомлення"
        icon={<ContentCopyOutlinedIcon fontSize="inherit" />}
        onClick={onCopyText}
      />
      {onDelete != null ? (
        <ActionIconButton title="Видалити" icon={<DeleteOutlineOutlinedIcon fontSize="inherit" />} onClick={onDelete} />
      ) : null}
      {onEditDetails != null ? (
        <ActionIconButton title="Редагувати додаткові поля" icon={<TuneOutlinedIcon fontSize="inherit" />} onClick={onEditDetails} />
      ) : null}
    </Stack>
  );
}

function MetaLine({
  icon,
  title,
  text,
}: {
  icon: JSX.Element;
  title: string;
  text: string;
}) {
  return (
    <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }} title={text}>
      <Box sx={{ color: 'var(--color-icons)', lineHeight: 0, flexShrink: 0 }} title={title}>
        {icon}
      </Box>
      <Typography variant="caption" sx={{ minWidth: 0, color: 'text.secondary' }} noWrap>
        {text}
      </Typography>
    </Stack>
  );
}

function AnalysisLinks({
  msg,
  mapHref,
  direction = 'row',
  align = 'flex-start',
}: {
  msg: InboxMessage;
  mapHref: string;
  direction?: 'row' | 'column';
  align?: 'flex-start' | 'flex-end';
}) {
  return (
    <Stack
      direction={direction}
      spacing={direction === 'row' ? 1.5 : 0.75}
      useFlexGap
      flexWrap={direction === 'row' ? 'wrap' : 'nowrap'}
      alignItems={align}
    >
      <Stack direction="row" alignItems="center" sx={{ minWidth: 0, gap: '4px' }}>
        <Link
          href={buildAnalysisHref(msg, false)}
          target="_blank"
          rel="noopener noreferrer"
          underline="none"
          color="inherit"
          sx={{
            display: 'inline-flex',
            alignItems: 'center',
            fontSize: 12,
            whiteSpace: 'nowrap',
            color: 'var(--message-callsign-color)',
            borderBottom: '2px solid var(--message-callsign-color)',
            lineHeight: 1.1,
          }}
        >
          Аналіз
        </Link>
        <BarChartOutlinedIcon sx={{ color: 'var(--color-icons)', fontSize: 18, flexShrink: 0 }} aria-hidden />
      </Stack>
      <Stack direction="row" alignItems="center" sx={{ minWidth: 0, gap: '4px' }}>
        <Link
          href={mapHref}
          target="_blank"
          rel="noopener noreferrer"
          underline="none"
          color="inherit"
          sx={{
            display: 'inline-flex',
            alignItems: 'center',
            fontSize: 12,
            whiteSpace: 'nowrap',
            color: 'var(--message-callsign-color)',
            borderBottom: '2px solid var(--message-callsign-color)',
            lineHeight: 1.1,
          }}
        >
          Карта
        </Link>
        <MapOutlinedIcon sx={{ color: 'var(--color-icons)', fontSize: 18, flexShrink: 0 }} aria-hidden />
      </Stack>
    </Stack>
  );
}

export type MessageCardHeaderProps = {
  layout: 'fluid' | 'dividers';
  compact?: boolean;
  feedCount: number;
  id: number;
  msg: InboxMessage;
  mapHref: string;
  copiedFeedbackId: string | null;
  groupName: string | null;
  senderName: string | null;
  networkIds: number[];
  networkDisplayMap: Record<number, string>;
  networkMap: Record<number, Network>;
  etalonNoNetworkLabel: string | null;
  relativeTimeMs: number | null;
  rightInsetPx?: number;
  onBookmark: () => void;
  onImportant: () => void;
  onComment: () => void;
  onCopyText: () => void;
  onCopyFreq: () => void;
  onDelete?: () => void;
  onEditDetails?: () => void;
};

export function MessageCardHeader({
  layout,
  compact = false,
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
  rightInsetPx = 0,
  onBookmark,
  onImportant,
  onComment,
  onCopyText,
  onCopyFreq,
  onDelete,
  onEditDetails,
}: MessageCardHeaderProps) {
  const timeDistance =
    msg.timestamp != null && relativeTimeMs != null ? messageRenderDistance(msg.timestamp, relativeTimeMs) : null;

  const dateTimeBlock = (
    <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" alignItems="center">
      <Stack direction="row" spacing={0.5} alignItems="center">
        <ScheduleOutlinedIcon sx={{ color: 'var(--color-icons)', fontSize: 18 }} />
        <Typography variant="caption">{formatTime(msg.time)}</Typography>
      </Stack>
      {msg.date != null ? (
        <Stack direction="row" spacing={0.5} alignItems="center">
          <CalendarTodayOutlinedIcon sx={{ color: 'var(--color-icons)', fontSize: 18 }} />
          <Typography variant="caption">{formatDateNoYear(msg.date)}</Typography>
        </Stack>
      ) : null}
    </Stack>
  );

  const freqBlock = msg.freq != null ? (
    <Stack direction="row" spacing={0.25} alignItems="center" sx={{ flexShrink: 0 }}>
      <Stack direction="row" spacing={0.5} alignItems="center">
        <SettingsInputAntennaOutlinedIcon sx={{ color: 'var(--color-icons)', fontSize: 18 }} titleAccess="Частота" />
        <Typography variant="caption" sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>
          {msg.freq}
        </Typography>
      </Stack>
      <ActionIconButton
        title="Копіювати частоту"
        icon={<ContentCopyOutlinedIcon fontSize="inherit" />}
        onClick={onCopyFreq}
      />
    </Stack>
  ) : null;

  const analysisLink = (
    <Stack direction="row" alignItems="center" sx={{ minWidth: 0, gap: '4px' }}>
      <Link
        href={buildAnalysisHref(msg, false)}
        target="_blank"
        rel="noopener noreferrer"
        underline="none"
        color="inherit"
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          fontSize: 12,
          whiteSpace: 'nowrap',
          color: 'var(--message-callsign-color)',
          borderBottom: '2px solid var(--message-callsign-color)',
          lineHeight: 1.1,
        }}
      >
        Аналіз
      </Link>
      <BarChartOutlinedIcon sx={{ color: 'var(--color-icons)', fontSize: 18, flexShrink: 0 }} aria-hidden />
    </Stack>
  );

  const mapLink = (
    <Stack direction="row" alignItems="center" sx={{ minWidth: 0, gap: '4px' }}>
      <Link
        href={mapHref}
        target="_blank"
        rel="noopener noreferrer"
        underline="none"
        color="inherit"
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          fontSize: 12,
          whiteSpace: 'nowrap',
          color: 'var(--message-callsign-color)',
          borderBottom: '2px solid var(--message-callsign-color)',
          lineHeight: 1.1,
        }}
      >
        Карта
      </Link>
      <MapOutlinedIcon sx={{ color: 'var(--color-icons)', fontSize: 18, flexShrink: 0 }} aria-hidden />
    </Stack>
  );

  const networkLabel =
    networkIds.length > 0
      ? networkIds
          .map((networkId) => {
            const network = networkMap[networkId];
            return networkDisplayMap[networkId] ?? (network != null ? `р/м ${network.name}` : 'Невідома мережа');
          })
          .join(', ')
      : (etalonNoNetworkLabel ?? '—');

  if (layout === 'fluid') {
    return (
      <Stack spacing={1}>
        <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1.5} useFlexGap flexWrap="wrap">
          {dateTimeBlock}
          {groupName != null ? <MetaLine icon={<GraphicEqOutlinedIcon sx={{ fontSize: 18 }} />} title="Група" text={groupName} /> : null}
          {senderName != null ? <MetaLine icon={<AccountCircleOutlinedIcon sx={{ fontSize: 18 }} />} title="Відправник" text={senderName} /> : null}
          {freqBlock}
        </Stack>
        <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1.5} useFlexGap flexWrap="wrap">
          <AnalysisLinks msg={msg} mapHref={mapHref} />
          <ActionIconsRow
            id={id}
            msg={msg}
            copiedFeedbackId={copiedFeedbackId}
            onBookmark={onBookmark}
            onImportant={onImportant}
            onComment={onComment}
            onCopyText={onCopyText}
            onDelete={onDelete}
            onEditDetails={onEditDetails}
          />
        </Stack>
      </Stack>
    );
  }

  if (compact) {
    return (
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
          gridTemplateRows: 'repeat(3, minmax(0, auto))',
          width: '100%',
          alignItems: 'center',
          columnGap: 2,
          rowGap: 1,
          pb: 1,
          borderBottom: '1px solid',
          borderColor: 'divider',
        }}
      >
        <Box sx={{ minWidth: 0, display: 'flex', alignItems: 'center', gridColumn: 1, gridRow: 1 }}>
          {dateTimeBlock}
        </Box>
        <Box sx={{ minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gridColumn: 2, gridRow: 1 }}>
          <ActionIconsRow
            id={id}
            msg={msg}
            copiedFeedbackId={copiedFeedbackId}
            onBookmark={onBookmark}
            onImportant={onImportant}
            onComment={onComment}
            onCopyText={onCopyText}
            onDelete={onDelete}
            onEditDetails={onEditDetails}
          />
        </Box>
        <Box sx={{ minWidth: 0, pr: `${rightInsetPx}px`, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gridColumn: 3, gridRow: 1 }}>
          {analysisLink}
        </Box>
        <Box sx={{ minWidth: 0, display: 'flex', alignItems: 'flex-start', gridColumn: 1, gridRow: 2 }}>
          <Stack direction="row" spacing={1.5} useFlexGap flexWrap="wrap" alignItems="center" sx={{ minWidth: 0 }}>
            {groupName != null ? <MetaLine icon={<GraphicEqOutlinedIcon sx={{ fontSize: 18 }} />} title="Група" text={groupName} /> : <Typography variant="caption" color="text.secondary">—</Typography>}
            {senderName != null ? <MetaLine icon={<AccountCircleOutlinedIcon sx={{ fontSize: 18 }} />} title="Відправник" text={senderName} /> : <Typography variant="caption" color="text.secondary">—</Typography>}
          </Stack>
        </Box>
        <Box sx={{ minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gridColumn: 2, gridRow: 2 }}>
          {freqBlock ?? <Typography variant="caption" color="text.secondary">—</Typography>}
        </Box>
        <Box sx={{ minWidth: 0, pr: `${rightInsetPx}px`, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gridColumn: 3, gridRow: 2 }}>
          {mapLink}
        </Box>
        <Box sx={{ minWidth: 0, display: 'flex', alignItems: 'flex-start', alignSelf: 'start', gridColumn: 1, gridRow: 3 }}>
          <Stack direction="row" spacing={0.75} alignItems="flex-start" sx={{ minWidth: 0 }}>
            <PeopleOutlineOutlinedIcon sx={{ mt: '2px', fontSize: 18, color: 'var(--color-icons)', flexShrink: 0 }} titleAccess="Еталонна прив'язка" />
            <Typography variant="body2" sx={{ minWidth: 0, overflowWrap: 'anywhere', fontWeight: 400 }}>
              {networkLabel}
            </Typography>
          </Stack>
        </Box>
        <Box sx={{ minWidth: 0, display: 'flex', alignItems: 'flex-start', alignSelf: 'start', justifyContent: 'center', gridColumn: 2, gridRow: 3 }}>
          <Stack direction="row" spacing={0.75} alignItems="flex-start" sx={{ minWidth: 0, maxWidth: '100%' }}>
            <LocationOnOutlinedIcon sx={{ mt: '2px', fontSize: 18, color: 'var(--color-icons)', flexShrink: 0 }} titleAccess="Локація" />
            <Typography variant="body2" sx={{ minWidth: 0, overflowWrap: 'anywhere', fontWeight: 400, textAlign: 'center' }}>
              {msg.location ?? 'Не встановлена'}
            </Typography>
          </Stack>
        </Box>
        <Box sx={{ minWidth: 0, pr: `${rightInsetPx}px`, display: 'flex', alignItems: 'flex-start', alignSelf: 'start', justifyContent: 'flex-end', gridColumn: 3, gridRow: 3 }}>
          {timeDistance != null ? (
            <Typography variant="caption" sx={{ color: 'text.secondary', whiteSpace: 'nowrap' }}>
              {timeDistance}
            </Typography>
          ) : null}
        </Box>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
        gridTemplateRows: 'repeat(3, minmax(0, auto))',
        width: '100%',
        alignItems: 'center',
        columnGap: 4,
        rowGap: 1.25,
      }}
    >
      <Box sx={{ minWidth: 0, display: 'flex', alignItems: 'center', gridColumn: 1, gridRow: 1 }}>
        {dateTimeBlock}
      </Box>
      <Box sx={{ minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gridColumn: 2, gridRow: 1 }}>
        <ActionIconsRow
          id={id}
          msg={msg}
          copiedFeedbackId={copiedFeedbackId}
          onBookmark={onBookmark}
          onImportant={onImportant}
          onComment={onComment}
          onCopyText={onCopyText}
          onDelete={onDelete}
          onEditDetails={onEditDetails}
        />
      </Box>
      <Box sx={{ minWidth: 0, pr: `${rightInsetPx}px`, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gridColumn: 3, gridRow: 1 }}>
        {analysisLink}
      </Box>
      <Box sx={{ minWidth: 0, display: 'flex', alignItems: 'flex-start', gridColumn: 1, gridRow: 2 }}>
        <Stack direction="row" spacing={1.5} useFlexGap flexWrap="wrap" alignItems="center" sx={{ minWidth: 0 }}>
          {groupName != null ? <MetaLine icon={<GraphicEqOutlinedIcon sx={{ fontSize: 18 }} />} title="Група" text={groupName} /> : <Typography variant="caption" color="text.secondary">—</Typography>}
          {senderName != null ? <MetaLine icon={<AccountCircleOutlinedIcon sx={{ fontSize: 18 }} />} title="Відправник" text={senderName} /> : <Typography variant="caption" color="text.secondary">—</Typography>}
        </Stack>
      </Box>
      <Box sx={{ minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gridColumn: 2, gridRow: 2 }}>
        {freqBlock ?? <Typography variant="caption" color="text.secondary">—</Typography>}
      </Box>
      <Box sx={{ minWidth: 0, pr: `${rightInsetPx}px`, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gridColumn: 3, gridRow: 2 }}>
        {mapLink}
      </Box>
      <Box sx={{ minWidth: 0, display: 'flex', alignItems: 'flex-start', alignSelf: 'start', gridColumn: 1, gridRow: 3 }}>
        <Stack direction="row" spacing={0.75} alignItems="flex-start" sx={{ minWidth: 0 }}>
          <PeopleOutlineOutlinedIcon sx={{ mt: '2px', fontSize: 18, color: 'var(--color-icons)', flexShrink: 0 }} titleAccess="Еталонна прив'язка" />
          <Typography variant="body2" sx={{ minWidth: 0, overflowWrap: 'anywhere', fontWeight: 400 }}>
            {networkLabel}
          </Typography>
        </Stack>
      </Box>
      <Box sx={{ minWidth: 0, display: 'flex', alignItems: 'flex-start', alignSelf: 'start', justifyContent: 'center', gridColumn: 2, gridRow: 3 }}>
        <Stack direction="row" spacing={0.75} alignItems="flex-start" sx={{ minWidth: 0, maxWidth: '100%' }}>
          <LocationOnOutlinedIcon sx={{ mt: '2px', fontSize: 18, color: 'var(--color-icons)', flexShrink: 0 }} titleAccess="Локація" />
          <Typography variant="body2" sx={{ minWidth: 0, overflowWrap: 'anywhere', fontWeight: 400, textAlign: 'center' }}>
            {msg.location ?? 'Не встановлена'}
          </Typography>
        </Stack>
      </Box>
      <Box sx={{ minWidth: 0, pr: `${rightInsetPx}px`, display: 'flex', alignItems: 'flex-start', alignSelf: 'start', justifyContent: 'flex-end', gridColumn: 3, gridRow: 3 }}>
        {timeDistance != null ? (
          <Typography variant="caption" sx={{ color: 'text.secondary', whiteSpace: 'nowrap' }}>
            {timeDistance}
          </Typography>
        ) : null}
      </Box>
    </Box>
  );
}
