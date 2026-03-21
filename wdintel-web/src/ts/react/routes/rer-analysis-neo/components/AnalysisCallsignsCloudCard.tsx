import { Paper, Stack, Typography } from '@mui/material';
import React from 'react';

import { PowerChip } from '../../../components/PowerChip';
import type { AnalysisCountItem } from '../types';

type Props = {
  items: AnalysisCountItem[];
};

export function AnalysisCallsignsCloudCard({ items }: Props) {
  const headingId = React.useId().replace(/:/g, '-');
  const maxCount = items.reduce((best, item) => Math.max(best, item.count), 0);

  return (
    <Paper variant="outlined" component="section" aria-labelledby={headingId} sx={{ p: 2 }}>
      <Typography id={headingId} variant="subtitle2" component="h2" sx={{ mb: 1.5 }}>
        Хмара позивних
      </Typography>
      <Stack direction="row" gap={1} flexWrap="wrap" role="list" aria-label="Хмара позивних">
        {items.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            Немає даних
          </Typography>
        ) : (
          items.map((item) => {
            const weight = maxCount === 0 ? 0 : item.count / maxCount;
            return (
              <PowerChip
                key={item.key}
                color={weight > 0.66 ? 'primary' : 'default'}
                label={`${item.key} (${item.count})`}
                selected={weight > 0.66}
                size={weight > 0.4 ? 'medium' : 'small'}
                sx={{
                  fontWeight: weight > 0.66 ? 700 : 500,
                  '& .MuiChip-label': { px: weight > 0.66 ? 1.5 : 1.25 },
                }}
              />
            );
          })
        )}
      </Stack>
    </Paper>
  );
}
