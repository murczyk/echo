import InfoIcon from '@mui/icons-material/Info';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import { Box, Button, Skeleton, Stack, Tooltip, Typography } from '@mui/material';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { PowerChip } from '../../../components/PowerChip';
import type { AnalysisSummaryTableRowView } from './analysis-summary-table-rows';

type ExpandableInlineListCellProps<T> = {
  items: T[];
  maxVisible: number;
  renderItem: (item: T, index: number) => ReactNode;
  tooltipTitle?: ReactNode;
  collapsedLabel?: (hiddenCount: number) => string;
  expandedLabel?: string;
};

function ExpandableInlineListCell<T>({
  items,
  maxVisible,
  renderItem,
  tooltipTitle,
  collapsedLabel = (hiddenCount) => `+${hiddenCount} ще`,
  expandedLabel = 'Згорнути',
}: ExpandableInlineListCellProps<T>) {
  const [expanded, setExpanded] = useState(false);

  if (items.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        —
      </Typography>
    );
  }

  const visibleItems = expanded ? items : items.slice(0, maxVisible);
  const hiddenCount = Math.max(items.length - maxVisible, 0);
  const content = (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) auto',
        alignItems: 'center',
        columnGap: 0.75,
        minWidth: 0,
        width: '100%',
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          minWidth: 0,
          overflow: expanded ? 'visible' : 'hidden',
          whiteSpace: expanded ? 'normal' : 'nowrap',
          flexWrap: expanded ? 'wrap' : 'nowrap',
        }}
      >
        {visibleItems.map((item, index) => renderItem(item, index))}
      </Box>
      {items.length > maxVisible ? (
        <Button
          size="small"
          variant="text"
          onClick={() => setExpanded((current) => !current)}
          aria-label={expanded ? expandedLabel : `Показати ще ${hiddenCount}`}
          sx={{
            minWidth: 0,
            px: 0.5,
            py: 0,
            flexShrink: 0,
            whiteSpace: 'nowrap',
            fontWeight: 600,
            lineHeight: 1.2,
          }}
        >
          {expanded ? expandedLabel : collapsedLabel(hiddenCount)}
        </Button>
      ) : null}
    </Box>
  );

  return tooltipTitle ? <Tooltip title={tooltipTitle}>{content}</Tooltip> : content;
}

function ExpandableTextListCell({
  items,
  maxVisible,
  tooltipTitle,
}: {
  items: string[];
  maxVisible: number;
  tooltipTitle?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);

  if (items.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        —
      </Typography>
    );
  }

  const visibleItems = expanded ? items : items.slice(0, maxVisible);
  const hiddenCount = Math.max(items.length - maxVisible, 0);
  const collapsedText = visibleItems.join(', ');
  const expandedText = items.join(', ');

  const content = (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) auto',
        alignItems: 'center',
        columnGap: 0.75,
        minWidth: 0,
        width: '100%',
      }}
    >
      <Typography
        component="span"
        variant="body2"
        title={expanded ? expandedText : collapsedText}
        sx={{
          minWidth: 0,
          width: '100%',
          overflow: expanded ? 'visible' : 'hidden',
          whiteSpace: expanded ? 'normal' : 'nowrap',
          textOverflow: expanded ? 'clip' : 'ellipsis',
          lineHeight: 1.35,
        }}
      >
        {expanded ? expandedText : collapsedText}
      </Typography>
      {items.length > maxVisible ? (
        <Button
          size="small"
          variant="text"
          onClick={() => setExpanded((current) => !current)}
          aria-label={expanded ? 'Згорнути' : `Показати ще ${hiddenCount}`}
          sx={{
            minWidth: 0,
            px: 0.5,
            py: 0,
            flexShrink: 0,
            whiteSpace: 'nowrap',
            fontWeight: 600,
            lineHeight: 1.2,
          }}
        >
          {expanded ? 'Згорнути' : `+${hiddenCount} ще`}
        </Button>
      ) : null}
    </Box>
  );

  return tooltipTitle ? <Tooltip title={tooltipTitle}>{content}</Tooltip> : content;
}

export function CompactListCell({ items, maxVisible = 2 }: { items: string[]; maxVisible?: number }) {
  return (
    <ExpandableTextListCell
      items={items}
      maxVisible={maxVisible}
      tooltipTitle={items.join(', ')}
    />
  );
}

export function CallsignChipsCell({ callsigns }: { callsigns: AnalysisSummaryTableRowView['callsignChips'] }) {
  return (
    <ExpandableInlineListCell
      items={callsigns}
      maxVisible={3}
      renderItem={(entry, index) => {
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
      }}
    />
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
