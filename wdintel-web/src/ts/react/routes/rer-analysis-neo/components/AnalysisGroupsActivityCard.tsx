import { Button, CircularProgress, Paper, Stack, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { createElement, useEffect, useId, useRef } from 'react';

import type { FreqDailyActivityCount } from '../../../../../Bindings';
import type { AnalysisGroupsActivityPeriod } from '../types';

type Props = {
  groupsActivity: FreqDailyActivityCount | null;
  loading: boolean;
  period: AnalysisGroupsActivityPeriod;
  onLoad: (period?: AnalysisGroupsActivityPeriod) => void;
};

function periodLabel(period: AnalysisGroupsActivityPeriod): string {
  switch (period) {
    case 'selected':
      return 'Вибраний період';
    case 'month':
      return 'Місяць';
    case 'quarter':
      return '3 місяці';
    case 'year':
      return 'Рік';
  }
}

export function AnalysisGroupsActivityCard({ groupsActivity, loading, period, onLoad }: Props) {
  const hostRef = useRef<HTMLElement | null>(null);
  const headingId = useId().replace(/:/g, '-');
  const hasData = Object.keys(groupsActivity?.dataPerDate ?? {}).length > 0;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !hasData) return;
    host.setAttribute('style', 'display:block;width:100%;height:250px;');
    // use properties to match the web-component contract
    Object.assign(host, {
      data: groupsActivity ?? { dataPerDate: {} },
      period,
      isAnalysis: true,
    });
  }, [groupsActivity, hasData, period]);

  return (
    <Paper variant="outlined" component="section" aria-labelledby={headingId} sx={{ p: 2 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1.5 }}>
        <Typography id={headingId} variant="subtitle1" component="h2" sx={{ fontWeight: 600 }}>
          Активність по датах
        </Typography>
        <Button size="small" onClick={() => onLoad(period)} disabled={loading}>
          {loading ? <CircularProgress size={14} /> : 'Оновити'}
        </Button>
      </Stack>
      <ToggleButtonGroup
        exclusive
        size="small"
        value={period}
        sx={{ mb: 1.5, flexWrap: 'wrap' }}
        onChange={(_event, value: AnalysisGroupsActivityPeriod | null) => {
          if (value) onLoad(value);
        }}
      >
        <ToggleButton value="selected">{periodLabel('selected')}</ToggleButton>
        <ToggleButton value="month">{periodLabel('month')}</ToggleButton>
        <ToggleButton value="quarter">{periodLabel('quarter')}</ToggleButton>
        <ToggleButton value="year">{periodLabel('year')}</ToggleButton>
      </ToggleButtonGroup>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
        Для графіка використовується перша обрана частота.
      </Typography>
      {hasData ? (
        createElement('bar-chart-2', { ref: hostRef, role: 'img', 'aria-label': 'Графік активності по датах' })
      ) : (
        <Typography variant="body2" color="text.secondary">
          Немає даних для побудови графіка.
        </Typography>
      )}
    </Paper>
  );
}
