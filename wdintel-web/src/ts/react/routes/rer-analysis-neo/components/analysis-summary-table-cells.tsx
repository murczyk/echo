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

export function CallsignChipsCell({
  callsigns,
}: {
  callsigns: AnalysisSummaryTableRowView['callsignChips'];
}) {
  return (
    <MrtOverflowItems
      items={callsigns}
      getItemText={(entry) => entry.callsign.toUpperCase()}
      renderItem={(entry, index) => {
        const hintIcon =
          entry.iconClass === 'info-circle-fill' ? (
            <InfoIcon fontSize="inherit" />
          ) : entry.iconClass === 'info-circle' ? (
            <InfoOutlinedIcon fontSize="inherit" />
          ) : null;
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
          <Tooltip
            key={`${entry.callsign}-${index}`}
            title={entry.tooltip ?? entry.callsign.toUpperCase()}
            placement="top"
          >
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
      <Stack spacing={1} sx={{ flex: 1, minHeight: 0 }}>
        {Array.from({ length: 8 }).map((_, index) => (
          <Skeleton key={index} variant="rounded" height={60} />
        ))}
      </Stack>
    </Stack>
  );
}
