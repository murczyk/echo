import { Button, Skeleton, Stack, Tooltip, Typography } from '@mui/material';
import { Fragment, useState } from 'react';

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
    <Stack spacing={0.5}>
      {visibleItems.map((item, index) => (
        <Typography key={`${item}-${index}`} variant="body2" title={item} sx={{ lineHeight: 1.35 }}>
          {item}
        </Typography>
      ))}
      {hiddenCount > 0 ? (
        <Typography variant="caption" color="text.secondary">
          +{hiddenCount} ще
        </Typography>
      ) : null}
    </Stack>
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

  const visibleCallsigns = expanded ? callsigns : callsigns.slice(0, 5);
  const hasExpandableOverflow = callsigns.length > 5;
  const hiddenCount = callsigns.length - visibleCallsigns.length;

  return (
    <Stack spacing={0.75} alignItems="flex-start">
      <Stack direction="row" gap={0.5} flexWrap="wrap" sx={{ maxWidth: '100%' }}>
        {visibleCallsigns.map((entry, index) => {
          const chip = (
            <PowerChip
              label={
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  {entry.tooltip && entry.iconClass ? <i className={`bi ${entry.iconClass}`} /> : null}
                  <span>{entry.callsign.toUpperCase()}</span>
                </span>
              }
              size="small"
              color={entry.tooltip ? 'primary' : 'default'}
              selected={entry.isHighlighted}
            />
          );

          return (
            <Fragment key={`${entry.callsign}-${index}`}>
              {entry.tooltip ? (
                <Tooltip title={entry.tooltip} placement="top">
                  <span>{chip}</span>
                </Tooltip>
              ) : (
                chip
              )}
            </Fragment>
          );
        })}
      </Stack>
      {hasExpandableOverflow ? (
        <Button size="small" variant="text" onClick={() => setExpanded((current) => !current)} sx={{ minWidth: 0, px: 0 }}>
          {expanded ? 'Згорнути' : `Показати ще (${hiddenCount})`}
        </Button>
      ) : null}
    </Stack>
  );
}

export function SummaryTableLoadingState() {
  return (
    <Stack spacing={1.5} sx={{ px: 2, py: 2, minHeight: 0, flex: 1, overflow: 'hidden' }}>
      <Stack direction="row" spacing={1.5} flexWrap="wrap" alignItems="center" justifyContent="space-between">
        <Skeleton variant="rounded" width={280} height={40} />
        <Stack direction="row" spacing={1.5} flexWrap="wrap" justifyContent="flex-end">
          <Skeleton variant="rounded" width={92} height={32} />
          <Skeleton variant="rounded" width={92} height={32} />
          <Skeleton variant="rounded" width={92} height={32} />
        </Stack>
      </Stack>
      <Stack spacing={1.25} sx={{ flex: 1, minHeight: 0 }}>
        {Array.from({ length: 8 }).map((_, index) => (
          <Skeleton key={index} variant="rounded" height={72} />
        ))}
      </Stack>
    </Stack>
  );
}
