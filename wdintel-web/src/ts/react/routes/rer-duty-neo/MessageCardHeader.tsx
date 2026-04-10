import AccountCircleOutlinedIcon from '@mui/icons-material/AccountCircleOutlined';
import BarChartOutlinedIcon from '@mui/icons-material/BarChartOutlined';
import BookmarkOutlinedIcon from '@mui/icons-material/BookmarkOutlined';
import CalendarTodayOutlinedIcon from '@mui/icons-material/CalendarTodayOutlined';
import ChatBubbleOutlineOutlinedIcon from '@mui/icons-material/ChatBubbleOutlineOutlined';
import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';
import EditIcon from '@mui/icons-material/Edit';
import GraphicEqOutlinedIcon from '@mui/icons-material/GraphicEqOutlined';
import MapOutlinedIcon from '@mui/icons-material/MapOutlined';
import OpenInNewOutlinedIcon from '@mui/icons-material/OpenInNewOutlined';
import PeopleOutlineOutlinedIcon from '@mui/icons-material/PeopleOutlineOutlined';
import PriorityHighOutlinedIcon from '@mui/icons-material/PriorityHighOutlined';
import ScheduleOutlinedIcon from '@mui/icons-material/ScheduleOutlined';
import SettingsInputAntennaOutlinedIcon from '@mui/icons-material/SettingsInputAntennaOutlined';
import { Box, Button, ButtonGroup, Link, Stack, Tooltip, Typography, type SxProps, type Theme } from '@mui/material';
import { useEffect, useRef, useState } from 'react';

import type { InboxMessage, Network } from '../../../../Bindings';
import { buildAnalysisHref, formatDateNoYear, formatTime, messageRenderDistance } from './utils';

/** Where the card is shown: duty columns use a 4-wide action grid when stacked; analysis uses 3. */
export type MessageCardDisplayMode = 'duty' | 'analysis';

type ActionIconsRowProps = {
  id: number;
  msg: InboxMessage;
  compact?: boolean;
  displayMode: MessageCardDisplayMode;
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
  selected = false,
}: {
  title: string;
  icon: JSX.Element;
  onClick: () => void;
  selected?: boolean;
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
          color: selected ? 'primary.main' : 'var(--color-action)',
          backgroundColor: selected ? 'action.selected' : 'transparent',
          '& .MuiSvgIcon-root': { fontSize: 18 },
          '&:hover': {
            backgroundColor: selected ? 'action.selected' : 'action.hover',
          },
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
        <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>{icon}</Box>
        <Box sx={{ minWidth: 0, maxWidth: '100%', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
          {text}
        </Box>
        <Box
          sx={{ width: 30, minWidth: 30, height: 30, display: 'flex', justifyContent: 'center', alignItems: 'center' }}
        >
          {trailing ?? null}
        </Box>
      </Box>
    </Box>
  );
}

function CenteredTextOnlyRow({ text }: { text: JSX.Element }) {
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
  displayMode,
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
      <ActionIconButton
        key="edit-details"
        title="Редагувати додаткові поля та позивні"
        icon={<EditIcon fontSize="inherit" />}
        onClick={onEditDetails}
      />
    ) : null,
    <ActionIconButton
      key="comment"
      title="Редагувати коментар"
      icon={<ChatBubbleOutlineOutlinedIcon fontSize="inherit" />}
      onClick={onComment}
    />,
    <ActionIconButton
      key="copy"
      title="Копіювати повідомлення"
      icon={<ContentCopyOutlinedIcon fontSize="inherit" />}
      onClick={onCopyText}
    />,
    <ActionIconButton
      key="important"
      title={msg.important ? 'Позначити як не важливе' : 'Позначити як важливе'}
      icon={<PriorityHighOutlinedIcon fontSize="inherit" />}
      onClick={onImportant}
      selected={msg.important}
    />,
    <ActionIconButton
      key="bookmark"
      title={msg.bookmarked ? 'Прибрати з закладок' : 'Додати в закладки'}
      icon={<BookmarkOutlinedIcon fontSize="inherit" />}
      onClick={onBookmark}
      selected={msg.bookmarked}
    />,
    onDelete != null ? (
      <ActionIconButton
        key="delete"
        title="Видалити"
        icon={<DeleteOutlineOutlinedIcon fontSize="inherit" />}
        onClick={onDelete}
      />
    ) : null,
  ].filter(Boolean);

  const actionGridColumns = displayMode === 'duty' ? 4 : 3;
  const lastRowButtonCount =
    buttons.length === 0
      ? 0
      : buttons.length % actionGridColumns === 0
        ? actionGridColumns
        : buttons.length % actionGridColumns;

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
    const minHeaderWidthForInline = 680;
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
    const col = actionGridColumns;
    const lastRow = lastRowButtonCount;
    return (
      <div ref={rootRef} style={{ width: '100%', display: 'flex', justifyContent: 'center' }}>
        <Box
          role="group"
          aria-label="Дії повідомлення"
          sx={[
            {
              display: 'grid',
              gridTemplateColumns: `repeat(${col}, 30px)`,
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
              [`& .MuiButton-root:nth-of-type(${col}n)`]: {
                borderRight: 'none',
              },
              ...(lastRow > 0
                ? {
                    [`& .MuiButton-root:nth-last-of-type(-n+${lastRow})`]: {
                      borderBottom: 'none',
                    },
                  }
                : {}),
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

function MetaLine({ icon, title, text }: { icon: JSX.Element; title: string; text: string }) {
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

function networkNeedsInvestigationBadge(network: Network | undefined): boolean {
  if (network == null) return false;
  const ids = network.unitIds;
  if (ids == null) return true;
  return ids.length === 0;
}

function NetworkEtalonSection({
  networkIds,
  networkDisplayMap,
  networkMap,
  fallbackEtalonLabel,
  location,
}: {
  networkIds: number[];
  networkDisplayMap: Record<number, string>;
  networkMap: Record<number, Network>;
  /** When `networkIds` is empty: unit / «Не встановлена» / «—». */
  fallbackEtalonLabel: string;
  location: string | null | undefined;
}) {
  const hasLocationDetails = location != null && location !== '' && location !== 'Не встановлена';

  const geoButton = hasLocationDetails ? (
    <Tooltip title={location} placement="top">
      <Box
        component="button"
        type="button"
        aria-label={`Показати локацію: ${location}`}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxSizing: 'border-box',
          width: 18,
          height: 18,
          p: 0,
          mt: '2px',
          border: '1px solid',
          borderColor: 'var(--color-icons)',
          borderRadius: '50%',
          bgcolor: 'transparent',
          color: 'var(--color-icons)',
          cursor: 'help',
          flexShrink: 0,
          alignSelf: 'flex-start',
          '&:hover': {
            color: 'var(--message-callsign-color)',
            borderColor: 'var(--message-callsign-color)',
          },
          '&:focus-visible': {
            outline: '2px solid var(--message-callsign-color)',
            outlineOffset: '2px',
          },
        }}
      >
        <Box
          component="i"
          className="bi bi-geo-alt-fill"
          aria-hidden
          sx={{ fontSize: 12, lineHeight: 1, fontStyle: 'normal' }}
        />
      </Box>
    </Tooltip>
  ) : null;

  return (
    <Stack direction="row" spacing={0.75} alignItems="flex-start" sx={{ minWidth: 0, width: '100%' }}>
      <PeopleOutlineOutlinedIcon
        sx={{ mt: '2px', fontSize: 18, color: 'var(--color-icons)', flexShrink: 0 }}
        titleAccess="Еталонна прив'язка"
      />
      <Box
        sx={{
          minWidth: 0,
          flex: 1,
          display: 'flex',
          flexDirection: 'row',
          flexWrap: 'wrap',
          alignItems: 'flex-start',
          columnGap: 0.75,
          rowGap: 0.5,
        }}
      >
        <Box sx={{ minWidth: 0, flex: '0 1 auto', maxWidth: '100%' }}>
          {networkIds.length > 0 ? (
            <Stack spacing={0.5} sx={{ minWidth: 0 }}>
              {networkIds.map((networkId) => {
                const network = networkMap[networkId];
                const label =
                  networkDisplayMap[networkId] ?? (network != null ? `р/м ${network.name}` : 'Невідома мережа');
                const badge = networkNeedsInvestigationBadge(network);
                const hasNetworkLink = network != null;
                return (
                  <Box key={networkId} sx={{ minWidth: 0, width: '100%' }}>
                    {hasNetworkLink ? (
                      <Link
                        href={`/rer-networks/${networkId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Відкрити мережу в новій вкладці"
                        underline="none"
                        color="inherit"
                        sx={{
                          /* Inline flow: chip + icon sit after the last word of the name, not the row edge. */
                          display: 'inline-block',
                          maxWidth: '100%',
                          verticalAlign: 'top',
                          overflowWrap: 'anywhere',
                          wordBreak: 'break-word',
                          '&:hover': { color: 'var(--message-callsign-color)' },
                          '&:hover .MuiSvgIcon-root': { color: 'var(--message-callsign-color)', opacity: 1 },
                        }}
                      >
                        <Box component="span" sx={{ fontWeight: 700 }}>
                          {label}
                        </Box>
                        {badge ? (
                          <Box
                            component="span"
                            className="badge badge-no-unit-sm"
                            sx={{
                              ml: '0.35em',
                              verticalAlign: 'middle',
                              position: 'relative',
                              top: '-0.06em',
                            }}
                          >
                            в дорозвідці
                          </Box>
                        ) : null}
                        <OpenInNewOutlinedIcon
                          sx={{
                            fontSize: '1.2em',
                            width: '1.2em',
                            height: '1.2em',
                            verticalAlign: 'middle',
                            ml: '0.2em',
                            color: 'var(--color-icons)',
                            opacity: 0.75,
                            display: 'inline-block',
                            position: 'relative',
                            top: '-0.05em',
                          }}
                          aria-hidden
                        />
                      </Link>
                    ) : (
                      <Typography variant="body2" sx={{ minWidth: 0, overflowWrap: 'anywhere', fontWeight: 400 }}>
                        {label}
                      </Typography>
                    )}
                  </Box>
                );
              })}
            </Stack>
          ) : (
            <Typography variant="body2" sx={{ minWidth: 0, overflowWrap: 'anywhere', fontWeight: 400 }}>
              {fallbackEtalonLabel}
            </Typography>
          )}
        </Box>
        {geoButton}
      </Box>
    </Stack>
  );
}

function AnalysisActionLink({ href, icon, label }: { href: string; icon: JSX.Element; label: string }) {
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
  compact?: boolean;
  displayMode: MessageCardDisplayMode;
  /** Width % of the bottom header row for the network / etalon block (remainder for relative time). */
  networkRowContentWidthPct?: number;
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
  compact = false,
  displayMode,
  networkRowContentWidthPct = 80,
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

  const freqBlock =
    msg.freq != null ? (
      <CenteredInfoRow
        icon={
          <SettingsInputAntennaOutlinedIcon sx={{ color: 'var(--color-icons)', fontSize: 18 }} titleAccess="Частота" />
        }
        text={
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="caption" sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>
              {msg.freq}
            </Typography>
          </Box>
        }
        trailing={
          <ActionIconButton
            title="Копіювати частоту"
            icon={<ContentCopyOutlinedIcon fontSize="inherit" />}
            onClick={onCopyFreq}
          />
        }
      />
    ) : null;

  const analysisLink = (
    <AnalysisActionLink
      href={buildAnalysisHref(msg, false)}
      icon={<BarChartOutlinedIcon aria-hidden />}
      label="Аналіз"
    />
  );

  const mapLink = <AnalysisActionLink href={mapHref} icon={<MapOutlinedIcon aria-hidden />} label="Карта" />;

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
        <Box
          sx={{
            minWidth: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gridColumn: 2,
            gridRow: 1,
          }}
        >
          <ActionIconsRow
            id={id}
            msg={msg}
            compact
            displayMode={displayMode}
            copiedFeedbackId={copiedFeedbackId}
            onBookmark={onBookmark}
            onImportant={onImportant}
            onComment={onComment}
            onCopyText={onCopyText}
            onDelete={onDelete}
            onEditDetails={onEditDetails}
          />
        </Box>
        <Box
          sx={{
            minWidth: 0,
            pr: `${rightInsetPx}px`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gridColumn: 3,
            gridRow: 1,
          }}
        >
          {analysisLink}
        </Box>
        <Box sx={{ minWidth: 0, display: 'flex', alignItems: 'flex-start', gridColumn: 1, gridRow: 2 }}>
          <Stack direction="row" spacing={1.5} useFlexGap flexWrap="wrap" alignItems="center" sx={{ minWidth: 0 }}>
            {groupName != null ? (
              <MetaLine icon={<GraphicEqOutlinedIcon sx={{ fontSize: 18 }} />} title="Група" text={groupName} />
            ) : (
              <Typography variant="caption" color="text.secondary">
                —
              </Typography>
            )}
            {senderName != null ? (
              <MetaLine
                icon={<AccountCircleOutlinedIcon sx={{ fontSize: 18 }} />}
                title="Відправник"
                text={senderName}
              />
            ) : (
              <Typography variant="caption" color="text.secondary">
                —
              </Typography>
            )}
          </Stack>
        </Box>
        <Box
          sx={{
            minWidth: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gridColumn: 2,
            gridRow: 2,
          }}
        >
          {freqBlock ?? (
            <Typography variant="caption" color="text.secondary">
              —
            </Typography>
          )}
        </Box>
        <Box
          sx={{
            minWidth: 0,
            pr: `${rightInsetPx}px`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gridColumn: 3,
            gridRow: 2,
          }}
        >
          {mapLink}
        </Box>
        <Box
          sx={{
            minWidth: 0,
            display: 'flex',
            alignItems: 'flex-start',
            alignSelf: 'start',
            gridColumn: '1 / -1',
            gridRow: 3,
            columnGap: 1,
            pr: `${rightInsetPx}px`,
          }}
        >
          <Box
            sx={{ flex: `0 1 ${networkRowContentWidthPct}%`, minWidth: 0, maxWidth: `${networkRowContentWidthPct}%` }}
          >
            <NetworkEtalonSection
              networkIds={networkIds}
              networkDisplayMap={networkDisplayMap}
              networkMap={networkMap}
              fallbackEtalonLabel={etalonNoNetworkLabel ?? '—'}
              location={msg.location}
            />
          </Box>
          <Box sx={{ flex: '1 1 0', minWidth: 0, display: 'flex', justifyContent: 'flex-end' }}>
            {timeDistance != null ? (
              <Typography variant="caption" sx={{ color: 'text.secondary', whiteSpace: 'nowrap' }}>
                {timeDistance}
              </Typography>
            ) : null}
          </Box>
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
      <Box sx={{ minWidth: 0, display: 'flex', alignItems: 'center', gridColumn: 1, gridRow: 1 }}>{dateTimeBlock}</Box>
      <Box
        sx={{ minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gridColumn: 2, gridRow: 1 }}
      >
        <ActionIconsRow
          id={id}
          msg={msg}
          compact={compact}
          displayMode={displayMode}
          copiedFeedbackId={copiedFeedbackId}
          onBookmark={onBookmark}
          onImportant={onImportant}
          onComment={onComment}
          onCopyText={onCopyText}
          onDelete={onDelete}
          onEditDetails={onEditDetails}
        />
      </Box>
      <Box
        sx={{
          minWidth: 0,
          pr: `${rightInsetPx}px`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gridColumn: 3,
          gridRow: 1,
        }}
      >
        {analysisLink}
      </Box>
      <Box sx={{ minWidth: 0, display: 'flex', alignItems: 'flex-start', gridColumn: 1, gridRow: 2 }}>
        <Stack direction="row" spacing={1.5} useFlexGap flexWrap="wrap" alignItems="center" sx={{ minWidth: 0 }}>
          {groupName != null ? (
            <MetaLine icon={<GraphicEqOutlinedIcon sx={{ fontSize: 18 }} />} title="Група" text={groupName} />
          ) : (
            <Typography variant="caption" color="text.secondary">
              —
            </Typography>
          )}
          {senderName != null ? (
            <MetaLine icon={<AccountCircleOutlinedIcon sx={{ fontSize: 18 }} />} title="Відправник" text={senderName} />
          ) : (
            <Typography variant="caption" color="text.secondary">
              —
            </Typography>
          )}
        </Stack>
      </Box>
      <Box
        sx={{ minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gridColumn: 2, gridRow: 2 }}
      >
        {freqBlock ?? (
          <CenteredTextOnlyRow
            text={
              <Typography variant="caption" color="text.secondary">
                —
              </Typography>
            }
          />
        )}
      </Box>
      <Box
        sx={{
          minWidth: 0,
          pr: `${rightInsetPx}px`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gridColumn: 3,
          gridRow: 2,
        }}
      >
        {mapLink}
      </Box>
      <Box
        sx={{
          minWidth: 0,
          display: 'flex',
          alignItems: 'flex-start',
          alignSelf: 'start',
          gridColumn: '1 / -1',
          gridRow: 3,
          columnGap: 1,
          pr: `${rightInsetPx}px`,
        }}
      >
        <Box sx={{ flex: `0 1 ${networkRowContentWidthPct}%`, minWidth: 0, maxWidth: `${networkRowContentWidthPct}%` }}>
          <NetworkEtalonSection
            networkIds={networkIds}
            networkDisplayMap={networkDisplayMap}
            networkMap={networkMap}
            fallbackEtalonLabel={etalonNoNetworkLabel ?? '—'}
            location={msg.location}
          />
        </Box>
        <Box sx={{ flex: '1 1 0', minWidth: 0, display: 'flex', justifyContent: 'flex-end' }}>
          {timeDistance != null ? (
            <Typography variant="caption" sx={{ color: 'text.secondary', whiteSpace: 'nowrap' }}>
              {timeDistance}
            </Typography>
          ) : null}
        </Box>
      </Box>
    </Box>
  );
}
