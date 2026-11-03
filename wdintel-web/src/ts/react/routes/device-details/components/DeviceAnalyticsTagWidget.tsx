import { Typography } from '@mui/material';
import type { DeviceAnalyticsSummaryItem } from '../../../../../Bindings';
import { PowerChip } from '../../../components/PowerChip';

const fileCountFormatter = new Intl.NumberFormat('uk-UA');

export function DeviceAnalyticsTagWidget({ summary }: { summary: DeviceAnalyticsSummaryItem }) {
  return (
    <li className="flex min-h-echo-control-lg min-w-0 flex-wrap items-center gap-echo-sm rounded-echo-sm border border-echo-divider-subtle px-echo-lg py-echo-md">
      <Typography component="span" variant="body1" className="min-w-0 [overflow-wrap:anywhere]">
        {summary.tag.name}
      </Typography>
      <PowerChip
        label={`${fileCountFormatter.format(summary.fileCount)} файлів`}
        color="default"
        interactive={false}
      />
    </li>
  );
}
