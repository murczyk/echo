import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import { Box, IconButton, Skeleton, Stack, Tooltip } from '@mui/material';
import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react';

import { copyTextToClipboard } from '../../../../copy-to-clipboard';
import { PowerChip } from '../../../components/PowerChip';
import { handleNavigateWithinSpaClick } from '../../../utils/browser';
import {
  buildNetworkCopyText,
  buildNetworkFrequencyDisplayGroups,
  getActivityBarHeight,
  type NetworkRowView,
} from '../helpers';

export function getLocationParts(location: string): string[] {
  return location
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

function RowLabel({ text }: { text: string }) {
  return (
    <Box
      sx={{
        fontWeight: 700,
        lineHeight: 1.25,
        whiteSpace: 'normal',
        overflowWrap: 'anywhere',
        width: '100%',
      }}
      title={text}
    >
      {text}
    </Box>
  );
}

export function ActivityBars({ bars }: { bars: Array<{ value: number; title: string }> }) {
  const maxValue = bars.reduce((max, bar) => Math.max(max, bar.value), 0);
  return (
    <Stack
      direction="row"
      spacing={0.35}
      alignItems="flex-end"
      sx={{ height: 36, overflow: 'hidden' }}
    >
      {bars.map((bar) => (
        <Tooltip key={bar.title} title={`${bar.title} - ${bar.value}`}>
          <Box
            sx={{
              width: 4,
              height: getActivityBarHeight(bar.value, maxValue),
              maxHeight: 34,
              borderRadius: 999,
              bgcolor: 'text.secondary',
              opacity: bar.value > 0 ? 1 : 0.3,
            }}
          />
        </Tooltip>
      ))}
    </Stack>
  );
}

export function NetworkActivityCell({
  activityLoadState,
  activityBars,
}: Pick<NetworkRowView, 'activityLoadState' | 'activityBars'>) {
  if (activityLoadState === 'loading') {
    return <Skeleton variant="text" width={120} aria-label="Завантаження активності" />;
  }

  if (activityLoadState === 'error') {
    return <Box sx={{ color: 'error.main' }}>Не вдалося завантажити активність</Box>;
  }

  if (activityBars.some((bar) => bar.value > 0)) {
    return <ActivityBars bars={activityBars} />;
  }

  return <Box sx={{ color: 'text.secondary' }}>Немає перехоплень за останні 10 днів</Box>;
}

const COPY_BUTTON_CLASS = 'network-row-copy-button';
type CopyState = 'idle' | 'copied' | 'error';

function NetworkCopyButton({ getText }: { getText: () => string }) {
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const resetTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    };
  }, []);

  const showCopyState = (next: CopyState) => {
    // Copy is async; the virtualized row may unmount before it settles.
    if (!mountedRef.current) return;
    setCopyState(next);
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = window.setTimeout(() => setCopyState('idle'), 1500);
  };

  const handleClick = async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await copyTextToClipboard(getText());
      showCopyState('copied');
    } catch (_) {
      showCopyState('error');
    }
  };

  const title =
    copyState === 'copied'
      ? 'Скопійовано'
      : copyState === 'error'
        ? 'Не вдалося скопіювати'
        : 'Копіювати інформацію про мережу';

  return (
    <Tooltip title={title}>
      <IconButton
        className={COPY_BUTTON_CLASS}
        size="small"
        aria-label="Копіювати інформацію про мережу"
        onClick={handleClick}
        sx={{
          p: 0.25,
          flexShrink: 0,
          opacity: copyState === 'idle' ? 0 : 1,
          transition: 'opacity 120ms',
          color: copyState === 'error' ? 'error.main' : 'text.secondary',
          '&:focus-visible': { opacity: 1 },
        }}
      >
        <ContentCopyOutlinedIcon sx={{ fontSize: 16 }} />
      </IconButton>
    </Tooltip>
  );
}

export function NetworkCell({
  network,
  includeFrequenciesInCopy,
}: {
  network: NetworkRowView;
  includeFrequenciesInCopy: boolean;
}) {
  return (
    <Stack
      direction="row"
      spacing={1}
      alignItems="center"
      sx={{
        minWidth: 0,
        flexWrap: 'nowrap',
        [`&:hover .${COPY_BUTTON_CLASS}`]: { opacity: 1 },
      }}
    >
      <Tooltip title={network.statusLabel}>
        <Box
          sx={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            bgcolor: network.statusColor,
            flexShrink: 0,
          }}
        />
      </Tooltip>
      <Box
        component="a"
        href={`/rer-networks-neo/${network.id}`}
        onClick={(event) => handleNavigateWithinSpaClick(event, `/rer-networks-neo/${network.id}`)}
        title={network.networkLabel}
        aria-label={network.networkLabel}
        sx={{
          minWidth: 0,
          flex: 1,
          display: 'flex',
          alignItems: 'flex-start',
          color: 'primary.main',
          textDecoration: 'none',
          '&:hover': {
            textDecoration: 'none',
          },
        }}
      >
        <RowLabel text={network.networkLabel} />
      </Box>
      <NetworkCopyButton getText={() => buildNetworkCopyText(network, includeFrequenciesInCopy)} />
      {network.developing ? (
        <PowerChip
          label="В дорозвідці"
          interactive={false}
          size="small"
          fontWeight={700}
          unselectedOpacity={1}
          unselectedBackgroundColor="warning.main"
          unselectedTextColor="warning.contrastText"
          unselectedBorderColor="warning.main"
        />
      ) : null}
    </Stack>
  );
}

export function AorCell({ labels }: { labels: string[] }) {
  return (
    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
      {labels.length > 0
        ? labels.map((label) => <PowerChip key={label} label={label} interactive={false} />)
        : '—'}
    </Stack>
  );
}

export function FrequencyCell({
  row,
  onPointerEnterAnchor,
  onPointerLeaveAnchor,
}: {
  row: NetworkRowView;
  onPointerEnterAnchor: (anchorEl: HTMLElement, row: NetworkRowView) => void;
  onPointerLeaveAnchor: () => void;
}) {
  const groups = buildNetworkFrequencyDisplayGroups(row);
  const totalFrequencies = row.activeFrequencies.length + row.inactiveFrequencies.length;

  return (
    <Stack
      direction="column"
      spacing={0.5}
      sx={{ minWidth: 0, cursor: 'default' }}
      data-network-hover-anchor={totalFrequencies > 0 ? 'true' : undefined}
      onPointerEnter={(event) => {
        if (totalFrequencies === 0) return;
        onPointerEnterAnchor(event.currentTarget, row);
      }}
      onPointerLeave={onPointerLeaveAnchor}
    >
      {groups.map((group) => {
        return group.frequencies.length > 0 ? (
          <Stack
            key={group.title}
            direction="row"
            spacing={0.5}
            alignItems="center"
            useFlexGap
            sx={{ flexWrap: 'wrap', minWidth: 0 }}
          >
            {group.frequencies.map((freq) => (
              <Box
                key={freq.id}
                sx={{
                  fontWeight: 700,
                  color: group.isInactive ? 'text.secondary' : 'text.primary',
                }}
              >
                {freq.freq}
              </Box>
            ))}
            {group.hiddenCount > 0 ? (
              <Box sx={{ color: 'text.secondary', flexShrink: 0 }}>{`+${group.hiddenCount}`}</Box>
            ) : null}
          </Stack>
        ) : null;
      })}
    </Stack>
  );
}

export function LocationCell({
  row,
  onPointerEnterAnchor,
  onPointerLeaveAnchor,
}: {
  row: NetworkRowView;
  onPointerEnterAnchor: (anchorEl: HTMLElement, row: NetworkRowView) => void;
  onPointerLeaveAnchor: () => void;
}) {
  const parts = getLocationParts(row.network.location);
  const hoverable = parts.length > 2;

  return (
    <Stack
      spacing={0.25}
      sx={{ cursor: 'default', minWidth: 0, maxWidth: '100%', overflow: 'hidden' }}
      data-network-hover-anchor={hoverable ? 'true' : undefined}
      {...(hoverable
        ? {
            onPointerEnter: (event: PointerEvent<HTMLElement>) =>
              onPointerEnterAnchor(event.currentTarget, row),
            onPointerLeave: onPointerLeaveAnchor,
          }
        : {})}
    >
      {parts.slice(0, 2).map((item, index) => (
        <Stack
          key={item}
          direction="row"
          spacing={0.75}
          alignItems="center"
          useFlexGap
          sx={{ minWidth: 0, maxWidth: '100%' }}
        >
          <Box
            title={item}
            sx={{
              display: 'block',
              minWidth: 0,
              maxWidth: '100%',
              fontWeight: 400,
              lineHeight: 1.2,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {item}
          </Box>
          {hoverable && index === 0 ? (
            <Box
              sx={{ color: 'text.secondary', flexShrink: 0, lineHeight: 1.2 }}
            >{`+${parts.length - 2}`}</Box>
          ) : null}
        </Stack>
      ))}
    </Stack>
  );
}

export function LastActivityCell({
  label,
  detail,
  tooltip,
}: {
  label: string;
  detail: string;
  tooltip: string;
}) {
  return (
    <Tooltip describeChild title={<span style={{ whiteSpace: 'pre-line' }}>{tooltip}</span>}>
      <Stack
        spacing={0.25}
        tabIndex={0}
        sx={{
          cursor: 'default',
          minWidth: 0,
          maxWidth: '100%',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          '&:focus-visible': {
            outline: '2px solid',
            outlineColor: 'primary.main',
            outlineOffset: 2,
          },
        }}
      >
        <Box
          sx={{
            minWidth: 0,
            maxWidth: '100%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: 'text.primary',
          }}
        >
          {label}
        </Box>
        <Box
          sx={{
            minWidth: 0,
            maxWidth: '100%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: 'text.secondary',
          }}
        >
          {detail}
        </Box>
      </Stack>
    </Tooltip>
  );
}
