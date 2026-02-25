import { Chip, Divider, List, ListItemButton, ListItemText, Paper, Stack, Typography } from '@mui/material';
import React from 'react';

import type { UnitStatView } from '../types';

type Props = {
  stats: UnitStatView[];
  open: boolean;
  loading: boolean;
  onPickUnitFilter: (unitName: string) => void;
};

function buildGroupLabel(row: UnitStatView): string {
  const parts = [row.army, row.division, row.regiment, row.battalion].filter((part) => part.trim() !== '');
  return parts.join(' / ');
}

export function UnitStatsSidebar({ stats, open, loading, onPickUnitFilter }: Props) {
  if (!open) return null;

  const total = stats.reduce((sum, row) => sum + row.count, 0);

  return (
    <Paper
      variant="outlined"
      sx={{
        width: { xs: '100%', lg: 320 },
        minWidth: { lg: 280 },
        height: { xs: 'auto', lg: '100%' },
        maxHeight: { xs: 'none', lg: '100%' },
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Stack spacing={1.5} sx={{ p: 2 }}>
        <Typography variant="h6">Підрозділи</Typography>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <Chip size="small" label={`Підрозділів: ${stats.length}`} />
          <Chip size="small" label={`Позивних: ${total}`} variant="outlined" />
        </Stack>
        <Typography variant="body2" color="text.secondary">
          Натисніть на підрозділ, щоб підставити його в текстовий фільтр.
        </Typography>
      </Stack>
      <Divider />
      {loading ? (
        <Typography variant="body2" sx={{ p: 2 }} color="text.secondary" role="status" aria-live="polite">
          Завантаження статистики…
        </Typography>
      ) : (
        <List
          dense
          disablePadding
          sx={{ flex: 1, minHeight: 0, overflowY: 'auto' }}
          aria-label="Статистика підрозділів"
        >
          {stats.map((row) => {
            const secondary = buildGroupLabel(row);
            return (
              <ListItemButton
                key={row.unitId}
                onClick={() => onPickUnitFilter(row.unitName)}
                alignItems="flex-start"
                aria-label={`Фільтрувати за підрозділом ${row.unitName}, позивних ${row.count}`}
              >
                <ListItemText
                  primary={row.unitName}
                  secondary={secondary || undefined}
                  primaryTypographyProps={{ noWrap: true, title: row.unitName }}
                  secondaryTypographyProps={{ sx: { whiteSpace: 'normal' } }}
                />
                <Chip size="small" label={row.count} sx={{ ml: 1 }} />
              </ListItemButton>
            );
          })}
          {stats.length === 0 ? (
            <Typography variant="body2" sx={{ p: 2 }} color="text.secondary" role="status" aria-live="polite">
              Статистика відсутня
            </Typography>
          ) : null}
        </List>
      )}
    </Paper>
  );
}
