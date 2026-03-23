import { Paper, Stack, Typography } from '@mui/material';
import { useCallback, useId } from 'react';

import type { NewCallsignsRes } from '../../../../../Bindings';

type Props = {
  newCallsigns: NewCallsignsRes;
};

export function AnalysisNewCallsignsCard({ newCallsigns }: Props) {
  const headingId = useId().replace(/:/g, '-');
  const renderList = useCallback((items: string[] | null | undefined) => ((items ?? []).join(', ') || 'немає'), []);

  return (
    <Paper variant="outlined" component="section" aria-labelledby={headingId} sx={{ p: 2 }}>
      <Typography id={headingId} variant="subtitle2" component="h2" sx={{ mb: 1.5 }}>
        Нові позивні
      </Typography>
      <Stack component="ul" spacing={1.5} sx={{ pl: 2, m: 0 }}>
        <Typography component="li" variant="caption" color="text.secondary">
          24 години: {renderList(newCallsigns.notSeen24h)}
        </Typography>
        <Typography component="li" variant="caption" color="text.secondary">
          7 днів: {renderList(newCallsigns.notSeen7days)}
        </Typography>
        <Typography component="li" variant="caption" color="text.secondary">
          30 днів: {renderList(newCallsigns.notSeen30days)}
        </Typography>
      </Stack>
    </Paper>
  );
}
