import { Button, Paper, Stack, Typography } from '@mui/material';
import { useEffect, useId, useState } from 'react';

import { PowerChip } from '../../../components/PowerChip';
import type { AnalysisCountItem } from '../types';

type Props = {
  items: AnalysisCountItem[];
};

export function AnalysisCallsignsCloudCard({ items }: Props) {
  const headingId = useId().replace(/:/g, '-');
  const [expanded, setExpanded] = useState(false);
  const hasHiddenItems = items.length > 12;
  const visibleItems = expanded || !hasHiddenItems ? items : items.slice(0, 12);
  const hiddenItemsCount = items.length - visibleItems.length;
  const maxCount = items.reduce((best, item) => Math.max(best, item.count), 0);

  useEffect(() => {
    if (!hasHiddenItems && expanded) {
      setExpanded(false);
    }
  }, [expanded, hasHiddenItems]);

  return (
    <Paper variant="outlined" component="section" aria-labelledby={headingId} sx={{ p: 2 }}>
      <Typography id={headingId} variant="subtitle2" component="h2" sx={{ mb: 1.5 }}>
        Хмара позивних
      </Typography>
      <Stack direction="row" gap={1} flexWrap="wrap" role="list" aria-label="Хмара позивних">
        {visibleItems.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            Немає даних
          </Typography>
        ) : (
          visibleItems.map((item) => {
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
      {hasHiddenItems ? (
        <Button sx={{ mt: 1.5 }} size="small" onClick={() => setExpanded((current) => !current)}>
          {expanded ? 'Згорнути' : `Показати ще (${hiddenItemsCount})`}
        </Button>
      ) : null}
    </Paper>
  );
}
