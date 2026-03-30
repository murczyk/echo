import { List, ListItem, ListItemText, Paper, Typography } from '@mui/material';
import { useId } from 'react';

import type { AnalysisCountItem } from '../types';

type Props = {
  title: string;
  items: AnalysisCountItem[];
};

export function AnalysisCountBlock({ title, items }: Props) {
  const headingId = useId().replace(/:/g, '-');
  const visibleItems = items.slice(0, 12);

  return (
    <Paper variant="outlined" component="section" aria-labelledby={headingId} sx={{ p: 2 }}>
      <Typography id={headingId} variant="subtitle2" component="h2" sx={{ mb: 1.5 }}>
        {title}
      </Typography>
      <List
        dense
        disablePadding
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' },
          columnGap: 2,
        }}
      >
        {visibleItems.length === 0 ? (
          <ListItem disablePadding>
            <ListItemText primary="Немає даних" />
          </ListItem>
        ) : (
          visibleItems.map((item) => (
            <ListItem key={item.key} disablePadding sx={{ py: 0.5, minWidth: 0, alignItems: 'flex-start' }}>
              <ListItemText primary={item.key} secondary={`Повідомлень: ${item.count}`} />
            </ListItem>
          ))
        )}
      </List>
    </Paper>
  );
}
