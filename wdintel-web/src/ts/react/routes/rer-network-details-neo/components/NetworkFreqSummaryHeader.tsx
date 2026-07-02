import { Box, Chip, Stack, Typography } from '@mui/material';

import type { NetworkFreqsRes } from '../../../../../Bindings';
import { ELLIPSIS } from '../../../utils/misc';
import { formatNetworkFreqValue } from '../frequency-utils';

type Props = {
  freq: NetworkFreqsRes | null;
};

function formatCallsigns(callsigns: Array<string> | null | undefined): string {
  const values = (callsigns ?? [])
    .map((callsign) => callsign.trim())
    .filter((callsign) => callsign !== '');
  if (values.length === 0) return '—';
  return values.slice(0, 3).join(', ') + (values.length > 3 ? ELLIPSIS : '');
}

export function NetworkFreqSummaryHeader({ freq }: Props) {
  if (!freq) return null;

  return (
    <Box
      sx={{
        px: 2.5,
        py: 2,
        borderBottom: '1px solid',
        borderColor: 'divider',
      }}
    >
      <Stack spacing={0.75}>
        <Stack direction="row" spacing={1} alignItems="center" useFlexGap sx={{ flexWrap: 'wrap' }}>
          <Typography variant="h4" fontWeight={800} sx={{ lineHeight: 1 }}>
            {formatNetworkFreqValue(freq.freq)}
          </Typography>
          <Chip size="small" label={freq.modulation || 'Не визначено'} />
          <Chip size="small" label={freq.encryption ?? '—'} />
        </Stack>
        <Typography
          variant="body2"
          color="text.secondary"
          noWrap
          title={formatCallsigns(freq.callsigns)}
        >
          {formatCallsigns(freq.callsigns)}
        </Typography>
      </Stack>
    </Box>
  );
}
