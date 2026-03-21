import { List, ListItem, ListItemText, Paper, Typography } from '@mui/material';
import React from 'react';

import type { AnalysisCountItem } from '../types';

type Props = {
  title: string;
  items: AnalysisCountItem[];
};

export function AnalysisCountBlock({ title, items }: Props) {
  const headingId = React.useId().replace(/:/g, '-');

  return (
    <Paper variant="outlined" component="section" aria-labelledby={headingId} sx={{ p: 2 }}>
      <Typography id={headingId} variant="subtitle2" component="h2" sx={{ mb: 1.5 }}>
        {title}
      </Typography>
      <List dense disablePadding>
        {items.length === 0 ? (
          <ListItem disablePadding>
            <ListItemText primary="Немає даних" />
          </ListItem>
        ) : (
          items.slice(0, 12).map((item) => (
            <ListItem key={item.key} disablePadding sx={{ py: 0.5 }}>
              <ListItemText primary={item.key} secondary={`Повідомлень: ${item.count}`} />
            </ListItem>
          ))
        )}
      </List>
    </Paper>
  );
}
