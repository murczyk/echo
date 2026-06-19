import { Box, Stack, Tooltip } from '@mui/material';
import type { PointerEvent } from 'react';

import type { NetworkFreq } from '../../../../../Bindings';
import { CompactPowerChip } from '../../../components/CompactPowerChip';
import { PowerChip } from '../../../components/PowerChip';
import { buildNetworkFrequencyDisplayGroups, getActivityBarHeight, type NetworkRowView } from '../helpers';

const MAX_FREQUENCY_METADATA_LABEL_LENGTH = 16;

function isShortFrequencyMetadataLabel(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= MAX_FREQUENCY_METADATA_LABEL_LENGTH &&
    !/[\r\n]/.test(trimmed) &&
    !/(?:^|[\s/._-])(key|hash|keyid|rx|tx)(?:$|[\s/._-])/i.test(trimmed)
  );
}

export function buildFrequencyMetadataLabels(freq: NetworkFreq): string[] {
  const labels: string[] = [];
  const pushLabel = (value: string | null | undefined) => {
    const trimmed = value?.trim();
    if (!trimmed || !isShortFrequencyMetadataLabel(trimmed) || labels.includes(trimmed)) {
      return;
    }
    labels.push(trimmed);
  };

  pushLabel(freq.kind);
  for (const encryptionKey of freq.encryptionKeys) {
    pushLabel(encryptionKey.description);
  }

  return labels;
}

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
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        fontWeight: 700,
        whiteSpace: 'nowrap',
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
    <Stack direction="row" spacing={0.35} alignItems="flex-end" sx={{ height: 36, overflow: 'hidden' }}>
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

function FrequencyMetadataChips({ labels }: { labels: string[] }) {
  if (labels.length === 0) {
    return null;
  }

  return (
    <Stack
      direction="row"
      spacing={0.5}
      useFlexGap
      sx={{
        flexWrap: 'nowrap',
        minWidth: 0,
        maxWidth: '100%',
        overflow: 'hidden',
        justifyContent: 'flex-end',
      }}
    >
      {labels.map((label) => (
        <CompactPowerChip
          key={label}
          label={label}
          interactive={false}
          title={label}
          sx={{
            maxWidth: '100%',
            minWidth: 0,
            '& .MuiChip-label': {
              maxWidth: '100%',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
          }}
        />
      ))}
    </Stack>
  );
}

export function NetworkCell({ network }: { network: NetworkRowView }) {
  return (
    <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0, flexWrap: 'nowrap' }}>
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
        title={network.networkLabel}
        aria-label={network.networkLabel}
        sx={{
          minWidth: 0,
          flex: 1,
          display: 'inline-flex',
          alignItems: 'center',
          color: 'primary.main',
          textDecoration: 'none',
          '&:hover': {
            textDecoration: 'none',
          },
        }}
      >
        <RowLabel text={network.networkLabel} />
      </Box>
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
      {labels.length > 0 ? labels.slice(0, 3).map((label) => <PowerChip key={label} label={label} interactive={false} />) : '—'}
      {labels.length > 3 ? <Box sx={{ color: 'text.secondary' }}>{`+${labels.length - 3}`}</Box> : null}
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
        const visibleFrequencies = group.frequencies.slice(0, 2);

        return visibleFrequencies.length > 0 ? (
          <Stack key={group.title} direction="row" spacing={0.5} alignItems="center" useFlexGap sx={{ flexWrap: 'wrap', minWidth: 0 }}>
            {visibleFrequencies.map((freq) => (
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
            {group.hiddenCount > 0 ? <Box sx={{ color: 'text.secondary' }}>{`+${group.hiddenCount}`}</Box> : null}
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
            onPointerEnter: (event: PointerEvent<HTMLElement>) => onPointerEnterAnchor(event.currentTarget, row),
            onPointerLeave: onPointerLeaveAnchor,
          }
        : {})}
    >
      {parts.slice(0, 2).map((item, index) => (
        <Stack key={item} direction="row" spacing={0.75} alignItems="center" useFlexGap sx={{ minWidth: 0, maxWidth: '100%' }}>
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
            <Box sx={{ color: 'text.secondary', flexShrink: 0, lineHeight: 1.2 }}>{`+${parts.length - 2}`}</Box>
          ) : null}
        </Stack>
      ))}
    </Stack>
  );
}

export function LastActivityCell({ label, detail, tooltip }: { label: string; detail: string; tooltip: string }) {
  return (
    <Tooltip title={<span style={{ whiteSpace: 'pre-line' }}>{tooltip}</span>}>
      <Stack spacing={0.25} sx={{ cursor: 'default' }}>
        <Box sx={{ color: 'text.primary' }}>{label}</Box>
        <Box sx={{ color: 'text.secondary' }}>{detail}</Box>
      </Stack>
    </Tooltip>
  );
}
