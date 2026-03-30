import AccountCircleOutlinedIcon from '@mui/icons-material/AccountCircleOutlined';
import BarChartOutlinedIcon from '@mui/icons-material/BarChartOutlined';
import BookmarkBorderOutlinedIcon from '@mui/icons-material/BookmarkBorderOutlined';
import BookmarkOutlinedIcon from '@mui/icons-material/BookmarkOutlined';
import CalendarTodayOutlinedIcon from '@mui/icons-material/CalendarTodayOutlined';
import ChatBubbleOutlineOutlinedIcon from '@mui/icons-material/ChatBubbleOutlineOutlined';
import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';
import EditIcon from '@mui/icons-material/Edit';
import GraphicEqOutlinedIcon from '@mui/icons-material/GraphicEqOutlined';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import MapOutlinedIcon from '@mui/icons-material/MapOutlined';
import PeopleOutlineOutlinedIcon from '@mui/icons-material/PeopleOutlineOutlined';
import PriorityHighOutlinedIcon from '@mui/icons-material/PriorityHighOutlined';
import ScheduleOutlinedIcon from '@mui/icons-material/ScheduleOutlined';
import SettingsInputAntennaOutlinedIcon from '@mui/icons-material/SettingsInputAntennaOutlined';
import {
  Box,
  Button,
  ButtonGroup,
  Link,
  Stack,
  Tooltip,
  Typography,
  type SxProps,
  type Theme,
} from '@mui/material';
import { useEffect, useRef, useState } from 'react';

import type { InboxMessage, Network } from '../../../../Bindings';
import { buildAnalysisHref, formatDateNoYear, formatTime, messageRenderDistance } from './utils';

type ActionIconsRowProps = {
  id: number;
  msg: InboxMessage;
  compact?: boolean;
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
      <Button
        aria-label={title}
        onClick={onClick}
        sx={{
          width: 30,
          minWidth: 30,
          height: 30,
          p: 0,
          color: 'var(--color-action)',
          '& .MuiSvgIcon-root': { fontSize: 18 },
        }}
      >
        {icon}
      </Button>
    </Tooltip>
  );
}

function CenteredInfoRow({
  icon,
  text,
  trailing,
}: {
  icon: JSX.Element;
  text: JSX.Element;
  trailing?: JSX.Element | null;
}) {
  return (
    <Box
      sx={{
        width: '100%',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: '30px minmax(0, auto) 30px',
          alignItems: 'center',
          columnGap: 0.5,
          minHeight: 30,
          maxWidth: '100%',
        }}
      >
        <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
          {icon}
        </Box>
        <Box sx={{ minWidth: 0, maxWidth: '100%', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
          {text}
        </Box>
        <Box sx={{ width: 30, minWidth: 30, height: 30, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
          {trailing ?? null}
        </Box>
      </Box>
    </Box>
  );
}

function CenteredTextOnlyRow({
  text,
}: {
  text: JSX.Element;
}) {
  return (
    <Box
      sx={{
        width: '100%',
        justifyContent: 'center',
        display: 'flex',
        alignItems: 'center',
      }}
    >
      {text}
    </Box>
  );
}

function ActionIconsRow({
  id,
  msg,
  compact = false,
  copiedFeedbackId,
  onBookmark,
  onImportant,
  onComment,
  onCopyText,
  onDelete,
  onEditDetails,
  sx,
}: ActionIconsRowProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [stackedLayout, setStackedLayout] = useState(compact);

  const buttons = [
    onEditDetails != null ? (
      <ActionIconButton key="edit-details" title="Редагувати додаткові поля та позивні" icon={<EditIcon fontSize="inherit" />} onClick={onEditDetails} />
    ) : null,
    <ActionIconButton key="comment" title="Редагувати коментар" icon={<ChatBubbleOutlineOutlinedIcon fontSize="inherit" />} onClick={onComment} />,
    <ActionIconButton
      key="copy"
      title="Копіювати повідомлення"
      icon={<ContentCopyOutlinedIcon fontSize="inherit" />}
      onClick={onCopyText}
    />,
    <ActionIconButton
      key="important"
      title={msg.important ? 'Прибрати важливе' : 'Помітити як важливе'}
      icon={<PriorityHighOutlinedIcon fontSize="inherit" />}
      onClick={onImportant}
    />,
    <ActionIconButton
      key="bookmark"
      title={msg.bookmarked ? 'Прибрати закладку' : 'Додати в закладки'}
      icon={msg.bookmarked ? <BookmarkOutlinedIcon fontSize="inherit" /> : <BookmarkBorderOutlinedIcon fontSize="inherit" />}
      onClick={onBookmark}
    />,
    onDelete != null ? (
      <ActionIconButton key="delete" title="Видалити" icon={<DeleteOutlineOutlinedIcon fontSize="inherit" />} onClick={onDelete} />
    ) : null,
  ].filter(Boolean);

  useEffect(() => {
    if (compact) {
      setStackedLayout(true);
      return;
    }

    const root = rootRef.current;
    const header = root?.closest('[data-message-header-grid="true"]') as HTMLDivElement | null;
    if (!root || typeof ResizeObserver === 'undefined') {
      setStackedLayout(false);
      return;
    }

    const minInlineWidth = 6 * 30 + 2;
    const minHeaderWidthForInline = 760;
    const updateLayout = () => {
      const availableWidth = header?.clientWidth ?? root.clientWidth;
      setStackedLayout(availableWidth < Math.max(minInlineWidth, minHeaderWidthForInline));
    };

    updateLayout();
    const observer = new ResizeObserver(updateLayout);
    observer.observe(root);
    if (header != null && header !== root) {
      observer.observe(header);
    }
    return () => observer.disconnect();
  }, [compact]);

  if (stackedLayout) {
    return (
      <div ref={rootRef} style={{ width: '100%', display: 'flex', justifyContent: 'center' }}>
        <Box
          role="group"
          aria-label="Дії повідомлення"
          sx={[
            {
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 30px)',
              gridAutoRows: '30px',
              width: 'fit-content',
              marginInline: 'auto',
              border: '1px solid',
              borderColor: 'divider',
              borderRadius: 1,
              color: 'var(--color-action)',
              overflow: 'hidden',
              '& .MuiButton-root': {
                color: 'var(--color-action)',
                borderColor: 'divider',
                borderRadius: 0,
                borderRight: '1px solid',
                borderBottom: '1px solid',
                borderRightColor: 'divider',
                borderBottomColor: 'divider',
              },
              '& .MuiButton-root:nth-of-type(3n)': {
                borderRight: 'none',
              },
              '& .MuiButton-root:nth-last-of-type(-n+3)': {
                borderBottom: 'none',
              },
              '& .MuiButton-root:hover': {
                borderColor: 'divider',
                backgroundColor: 'action.hover',
              },
            },
            ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
          ]}
        >
          {buttons}
        </Box>
      </div>
    );
  }

  return (
    <div ref={rootRef} style={{ width: '100%', display: 'flex', justifyContent: 'center' }}>
      <ButtonGroup
        size="small"
        variant="outlined"
        aria-label="Дії повідомлення"
        sx={[
          {
            flexWrap: 'nowrap',
            alignItems: 'center',
            borderRadius: 1,
            '& .MuiButton-root': {
              borderColor: 'divider',
              borderRadius: 0,
            },
            '& .MuiButton-root:first-of-type': {
              borderTopLeftRadius: (theme) => `${theme.shape.borderRadius}px`,
              borderBottomLeftRadius: (theme) => `${theme.shape.borderRadius}px`,
            },
            '& .MuiButton-root:last-of-type': {
              borderTopRightRadius: (theme) => `${theme.shape.borderRadius}px`,
              borderBottomRightRadius: (theme) => `${theme.shape.borderRadius}px`,
            },
            '& .MuiButton-root:hover': {
              borderColor: 'divider',
              backgroundColor: 'action.hover',
            },
          },
          ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
        ]}
      >
        {buttons}
      </ButtonGroup>
    </div>
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

function NetworkLocationLine({
  networkLabel,
  location,
}: {
  networkLabel: string;
  location: string | null | undefined;
}) {
  const hasLocationDetails = location != null && location !== '' && location !== 'Не встановлена';

  return (
    <Stack direction="row" spacing={0.75} alignItems="flex-start" sx={{ minWidth: 0, width: '100%' }}>
      <PeopleOutlineOutlinedIcon sx={{ mt: '2px', fontSize: 18, color: 'var(--color-icons)', flexShrink: 0 }} titleAccess="Еталонна прив'язка" />
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Box
          sx={{
            display: 'inline-flex',
            alignItems: 'flex-start',
            gap: 0.5,
            minWidth: 0,
            maxWidth: '100%',
            verticalAlign: 'top',
          }}
        >
        <Typography variant="body2" sx={{ minWidth: 0, overflowWrap: 'anywhere', fontWeight: 400 }}>
          {networkLabel}
        </Typography>
        {hasLocationDetails ? (
          <Tooltip title={location} placement="top">
            <Box
              component="button"
              type="button"
              aria-label={`Показати локацію: ${location}`}
              sx={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 18,
                height: 18,
                p: 0,
                border: 'none',
                borderRadius: '50%',
                bgcolor: 'transparent',
                color: 'var(--color-icons)',
                cursor: 'help',
                flexShrink: 0,
                '&:hover': {
                  color: 'var(--message-callsign-color)',
                },
                '&:focus-visible': {
                  outline: '2px solid var(--message-callsign-color)',
                  outlineOffset: '2px',
                },
              }}
            >
              <InfoOutlinedIcon sx={{ fontSize: 16 }} />
            </Box>
          </Tooltip>
        ) : null}
        </Box>
      </Box>
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
      <AnalysisActionLink href={buildAnalysisHref(msg, false)} icon={<BarChartOutlinedIcon aria-hidden />} label="Аналіз" />
      <AnalysisActionLink href={mapHref} icon={<MapOutlinedIcon aria-hidden />} label="Карта" />
    </Stack>
  );
}

function AnalysisActionLink({
  href,
  icon,
  label,
}: {
  href: string;
  icon: JSX.Element;
  label: string;
}) {
  return (
    <Link
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      underline="none"
      color="inherit"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.75,
        minHeight: 28,
        px: 1,
        py: 0.5,
        borderRadius: 999,
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: 'color-mix(in srgb, var(--color-card) 88%, white 12%)',
        color: 'text.primary',
        fontSize: 12,
        fontWeight: 600,
        lineHeight: 1,
        whiteSpace: 'nowrap',
        textDecoration: 'none',
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
      <Box component="span">{label}</Box>
    </Link>
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
    <CenteredInfoRow
      icon={<SettingsInputAntennaOutlinedIcon sx={{ color: 'var(--color-icons)', fontSize: 18 }} titleAccess="Частота" />}
      text={
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="caption" sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>
            {msg.freq}
          </Typography>
        </Box>
      }
      trailing={
        <ActionIconButton title="Копіювати частоту" icon={<ContentCopyOutlinedIcon fontSize="inherit" />} onClick={onCopyFreq} />
      }
    />
  ) : null;

  const analysisLink = <AnalysisActionLink href={buildAnalysisHref(msg, false)} icon={<BarChartOutlinedIcon aria-hidden />} label="Аналіз" />;

  const mapLink = <AnalysisActionLink href={mapHref} icon={<MapOutlinedIcon aria-hidden />} label="Карта" />;

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
            compact={compact}
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
        data-message-header-grid="true"
        sx={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)',
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
        <Box sx={{ minWidth: 0, display: 'flex', alignItems: 'flex-start', alignSelf: 'start', gridColumn: '1 / span 2', gridRow: 3 }}>
          <NetworkLocationLine networkLabel={networkLabel} location={msg.location} />
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
      data-message-header-grid="true"
      sx={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)',
        gridTemplateRows: 'repeat(3, minmax(0, auto))',
        width: '100%',
        alignItems: 'center',
        columnGap: 4,
        rowGap: 0.75,
      }}
    >
      <Box sx={{ minWidth: 0, display: 'flex', alignItems: 'center', gridColumn: 1, gridRow: 1 }}>
        {dateTimeBlock}
      </Box>
      <Box sx={{ minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gridColumn: 2, gridRow: 1 }}>
        <ActionIconsRow
          id={id}
          msg={msg}
          compact={compact}
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
        {freqBlock ?? <CenteredTextOnlyRow text={<Typography variant="caption" color="text.secondary">—</Typography>} />}
      </Box>
      <Box sx={{ minWidth: 0, pr: `${rightInsetPx}px`, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gridColumn: 3, gridRow: 2 }}>
        {mapLink}
      </Box>
      <Box sx={{ minWidth: 0, display: 'flex', alignItems: 'flex-start', alignSelf: 'start', gridColumn: '1 / span 2', gridRow: 3 }}>
        <NetworkLocationLine networkLabel={networkLabel} location={msg.location} />
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
