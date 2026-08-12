import {
  Button,
  CircularProgress,
  Paper,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
} from '@mui/material';
import { createElement, useEffect, useId, useMemo, useRef } from 'react';

import type { FreqDailyActivityCount } from '../../../../../Bindings';
import type { AnalysisGroupsActivityPeriod } from '../types';
import { PowerAlert } from '../../../components/PowerAlert';
import { CompactText, CompactTitle } from '../../../components/CompactTypography';
import { ELLIPSIS } from '../../../utils/misc';

type Props = {
  groupsActivity: FreqDailyActivityCount | null;
  groupsActivityLoadedFreq: string | null;
  groupsActivityLoadedPeriod: AnalysisGroupsActivityPeriod | null;
  loading: boolean;
  period: AnalysisGroupsActivityPeriod;
  selectedFreq: string | null;
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

function hasRenderableData(groupsActivity: FreqDailyActivityCount | null): boolean {
  return Object.values(groupsActivity?.dataPerDate ?? {}).some((entry) =>
    Object.values(entry?.countByGroupName ?? {}).some((count) => count > 0),
  );
}

export function AnalysisGroupsActivityCard({
  groupsActivity,
  groupsActivityLoadedFreq,
  groupsActivityLoadedPeriod,
  loading,
  period,
  selectedFreq,
  onLoad,
}: Props) {
  const hostRef = useRef<HTMLElement | null>(null);
  const headingId = useId().replace(/:/g, '-');
  const hasTimeline = Object.keys(groupsActivity?.dataPerDate ?? {}).length > 0;
  const canRenderChart = hasRenderableData(groupsActivity);
  const matchesCurrentSelection =
    groupsActivityLoadedFreq === selectedFreq && groupsActivityLoadedPeriod === period;
  const canRenderCurrentChart = canRenderChart && matchesCurrentSelection;
  const chartStatus = useMemo(() => {
    if (canRenderCurrentChart) return 'ready' as const;
    if (loading) return 'loading' as const;
    if (!matchesCurrentSelection)
      return selectedFreq ? ('empty' as const) : ('needs-load' as const);
    if (hasTimeline) return 'empty-period' as const;
    return 'empty' as const;
  }, [canRenderCurrentChart, hasTimeline, loading, matchesCurrentSelection, selectedFreq]);

  useEffect(() => {
    if (!selectedFreq) return;
    onLoad();
  }, [onLoad, selectedFreq]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !canRenderCurrentChart) return;
    host.setAttribute('style', 'display:block;width:100%;height:250px;');
    // use properties to match the web-component contract
    Object.assign(host, {
      data: groupsActivity ?? { dataPerDate: {} },
      period,
      isAnalysis: true,
    });
    const chartHost = host as HTMLElement & {
      requestUpdate?: () => void;
      renderChart?: () => void;
    };
    const frameId = window.requestAnimationFrame(() => {
      chartHost.requestUpdate?.();
      chartHost.renderChart?.();
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [canRenderCurrentChart, groupsActivity, period]);

  return (
    <Paper variant="outlined" component="section" aria-labelledby={headingId} sx={{ p: 2 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1.5 }}>
        <CompactTitle id={headingId} component="h2">
          Активність по датах
        </CompactTitle>
        {loading ? <CircularProgress size={18} /> : null}
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
      <CompactText component="div" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
        {selectedFreq
          ? `Частота для графіка: ${selectedFreq}`
          : 'Усі частоти за поточними фільтрами.'}
      </CompactText>
      {chartStatus === 'ready' ? (
        createElement('dashboard-chart', {
          ref: hostRef,
          role: 'img',
          'aria-label': 'Графік активності по датах',
        })
      ) : chartStatus === 'needs-load' ? (
        <Stack spacing={1} alignItems="flex-start">
          <CompactText color="text.secondary">
            Завантажте активність по датах для всіх частот за поточними фільтрами.
          </CompactText>
          <Button variant="outlined" size="small" onClick={() => onLoad()}>
            Завантажити
          </Button>
        </Stack>
      ) : chartStatus === 'loading' ? (
        <Stack direction="row" spacing={1} alignItems="center" sx={{ minHeight: 80 }}>
          <CircularProgress size={18} />
          <CompactText color="text.secondary">
            {`Завантажую активність по датах${ELLIPSIS}`}
          </CompactText>
        </Stack>
      ) : chartStatus === 'empty-period' ? (
        <PowerAlert severity="info">
          {selectedFreq
            ? `Для частоти ${selectedFreq} за цей інтервал активності не знайдено.`
            : 'За цей інтервал активності не знайдено.'}
        </PowerAlert>
      ) : (
        <PowerAlert severity="info">
          {selectedFreq
            ? `Для частоти ${selectedFreq} немає даних для побудови графіка.`
            : 'Немає даних для побудови графіка.'}
        </PowerAlert>
      )}
    </Paper>
  );
}
