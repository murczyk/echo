import InfoIcon from '@mui/icons-material/Info';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import { Button, Skeleton, Stack, Tooltip, Typography } from '@mui/material';
import { useState } from 'react';

import { PowerChip } from '../../../components/PowerChip';
import type { AnalysisSummaryTableRowView } from './analysis-summary-table-rows';

export function CompactListCell({ items, maxVisible = 3 }: { items: string[]; maxVisible?: number }) {
  if (items.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        —
      </Typography>
    );
  }

  const visibleItems = items.slice(0, maxVisible);
  const hiddenCount = items.length - visibleItems.length;

  return (
    <Tooltip title={items.join(', ')}>
      <Stack direction="row" spacing={0.5} alignItems="center" sx={{ minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap' }}>
      {visibleItems.map((item, index) => (
        <Typography
          key={`${item}-${index}`}
          component="span"
          variant="body2"
          noWrap
          title={item}
          sx={{ minWidth: 0, lineHeight: 1.35, cursor: 'default' }}
        >
          {item}
        </Typography>
      ))}
      {hiddenCount > 0 ? (
        <Typography component="span" variant="caption" color="text.secondary" sx={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
          +{hiddenCount} ще
        </Typography>
      ) : null}
      </Stack>
    </Tooltip>
  );
}

export function CallsignChipsCell({ callsigns }: { callsigns: AnalysisSummaryTableRowView['callsignChips'] }) {
  const [expanded, setExpanded] = useState(false);

  if (callsigns.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        —
      </Typography>
    );
  }

  const visibleCallsigns = expanded ? callsigns : callsigns.slice(0, 3);
  const hasExpandableOverflow = callsigns.length > 3;
  const hiddenCount = callsigns.length - visibleCallsigns.length;

  return (
    <Stack
      direction="row"
      spacing={0.5}
      alignItems="center"
      useFlexGap
      sx={{
        minWidth: 0,
        overflow: expanded ? 'visible' : 'hidden',
        whiteSpace: expanded ? 'normal' : 'nowrap',
        flexWrap: expanded ? 'wrap' : 'nowrap',
      }}
    >
        {visibleCallsigns.map((entry, index) => {
          const hintIcon =
            entry.iconClass === 'info-circle-fill' ? <InfoIcon fontSize="inherit" /> : entry.iconClass === 'info-circle' ? <InfoOutlinedIcon fontSize="inherit" /> : null;
          const chip = (
            <PowerChip
              label={
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  {entry.tooltip && hintIcon ? hintIcon : null}
                  <span>{entry.callsign.toUpperCase()}</span>
                </span>
              }
              size="small"
              color={entry.tooltip ? 'primary' : 'default'}
              selected={entry.isHighlighted}
              title={entry.tooltip ?? entry.callsign.toUpperCase()}
              sx={{ maxWidth: '100%', minWidth: 0, cursor: 'default' }}
            />
          );

          return (
            <Tooltip key={`${entry.callsign}-${index}`} title={entry.tooltip ?? entry.callsign.toUpperCase()} placement="top">
              <span>{chip}</span>
            </Tooltip>
          );
        })}
      {hasExpandableOverflow ? (
        <Button size="small" variant="text" onClick={() => setExpanded((current) => !current)} sx={{ minWidth: 0, px: 0.5, py: 0, flexShrink: 0, whiteSpace: 'nowrap' }}>
          {expanded ? 'Згорнути' : `+${hiddenCount} ще`}
        </Button>
      ) : null}
    </Stack>
  );
}

export function SummaryTableLoadingState() {
  return (
    <Stack spacing={1.25} sx={{ px: 1.5, py: 1.5, minHeight: 0, flex: 1, overflow: 'hidden' }}>
      <Stack direction="row" spacing={1} flexWrap="wrap" alignItems="center" justifyContent="space-between">
        <Skeleton variant="rounded" width={220} height={36} />
        <Stack direction="row" spacing={1} flexWrap="wrap" justifyContent="flex-end">
          <Skeleton variant="rounded" width={80} height={30} />
          <Skeleton variant="rounded" width={80} height={30} />
          <Skeleton variant="rounded" width={80} height={30} />
        </Stack>
      </Stack>
      <Stack spacing={1} sx={{ flex: 1, minHeight: 0 }}>
        {Array.from({ length: 8 }).map((_, index) => (
          <Skeleton key={index} variant="rounded" height={60} />
        ))}
      </Stack>
    </Stack>
  );
}
