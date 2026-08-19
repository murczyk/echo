import InfoIcon from '@mui/icons-material/Info';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import { Box, Skeleton, Stack, Tooltip } from '@mui/material';

import { PowerChip } from '../../../components/PowerChip';
import { MrtOverflowItems } from '../../../components/mui-customized/table/mrt-overflow';
import type { AnalysisSummaryTableRowView } from './analysis-summary-table-rows';

export function CompactListCell({ items }: { items: string[] }) {
  return (
    <MrtOverflowItems
      items={items}
      getItemText={(item) => item}
      renderItem={(item) => <Box component="span">{item}</Box>}
    />
  );
}

export function CallsignChip({
  entry,
}: {
  entry: AnalysisSummaryTableRowView['callsignChips'][number];
}) {
  const hintIcon =
    entry.iconClass === 'info-circle-fill' ? (
      <InfoIcon fontSize="inherit" />
    ) : entry.iconClass === 'info-circle' ? (
      <InfoOutlinedIcon fontSize="inherit" />
    ) : null;
  const chip = (
    <PowerChip
      label={
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            minWidth: 0,
            maxWidth: '100%',
          }}
        >
          {entry.tooltip && hintIcon ? hintIcon : null}
          <span
            style={{
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {entry.callsign.toUpperCase()}
          </span>
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
    <Tooltip describeChild title={entry.tooltip ?? entry.callsign.toUpperCase()} placement="top">
      <span
        tabIndex={0}
        style={{ display: 'inline-flex', minWidth: 0, maxWidth: '100%', overflow: 'hidden' }}
      >
        {chip}
      </span>
    </Tooltip>
  );
}

export function CallsignChipsCell({
  callsigns,
}: {
  callsigns: AnalysisSummaryTableRowView['callsignChips'];
}) {
  return <MrtOverflowItems items={callsigns} {...callsignOverflowRenderer} />;
}

export const callsignOverflowRenderer = {
  getItemText: (entry: AnalysisSummaryTableRowView['callsignChips'][number]) =>
    entry.callsign.toUpperCase(),
  getItemKey: (entry: AnalysisSummaryTableRowView['callsignChips'][number]) => entry.callsign,
  getItemMeasurementKey: (entry: AnalysisSummaryTableRowView['callsignChips'][number]) =>
    JSON.stringify([entry.iconClass, Boolean(entry.tooltip), entry.isHighlighted]),
  renderItem: (entry: AnalysisSummaryTableRowView['callsignChips'][number]) => (
    <CallsignChip entry={entry} />
  ),
  renderCompactItem: (entry: AnalysisSummaryTableRowView['callsignChips'][number]) => (
    <CallsignChip entry={entry} />
  ),
};

export function SummaryTableLoadingState() {
  return (
    <Stack spacing={1.25} sx={{ px: 1.5, py: 1.5, minHeight: 0, flex: 1, overflow: 'hidden' }}>
      <Stack spacing={1} sx={{ flex: 1, minHeight: 0 }}>
        {Array.from({ length: 8 }).map((_, index) => (
          <Skeleton key={index} variant="rounded" height={60} />
        ))}
      </Stack>
    </Stack>
  );
}
