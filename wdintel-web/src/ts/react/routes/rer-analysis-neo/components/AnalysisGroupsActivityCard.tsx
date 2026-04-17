import { Button, CircularProgress, Paper, Stack, ToggleButton, ToggleButtonGroup } from '@mui/material';
import { createElement, useEffect, useId, useMemo, useRef } from 'react';

import type { FreqDailyActivityCount } from '../../../../../Bindings';
import type { AnalysisGroupsActivityPeriod } from '../types';
import { PowerAlert } from '../../../components/PowerAlert';
import { CompactText, CompactTitle } from '../../../components/CompactTypography';

type Props = {
  groupsActivity: FreqDailyActivityCount | null;
  groupsActivityLoadedFreq: string | null;
  groupsActivityLoadedPeriod: AnalysisGroupsActivityPeriod | null;
  loading: boolean;
  period: AnalysisGroupsActivityPeriod;
  selectedFreq: string | null;
  suggestedFreqs: string[];
  onLoad: (period?: AnalysisGroupsActivityPeriod) => void;
  onSelectFreq: (freq: string) => void;
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
  suggestedFreqs,
  onLoad,
  onSelectFreq,
}: Props) {
  const sectionRef = useRef<HTMLElement | null>(null);
  const hostRef = useRef<HTMLElement | null>(null);
  const previousChartStatusRef = useRef<'needs-freq' | 'loading' | 'ready' | 'empty-period' | 'empty' | null>(null);
  const headingId = useId().replace(/:/g, '-');
  const hasTimeline = Object.keys(groupsActivity?.dataPerDate ?? {}).length > 0;
  const canRenderChart = hasRenderableData(groupsActivity);
  const matchesCurrentSelection =
    groupsActivityLoadedFreq === selectedFreq && groupsActivityLoadedPeriod === period;
  const canRenderCurrentChart = canRenderChart && matchesCurrentSelection;
  const chartStatus = useMemo(() => {
    if (!selectedFreq) return 'needs-freq' as const;
    if (canRenderCurrentChart) return 'ready' as const;
    if (loading) return 'loading' as const;
    if (hasTimeline) return 'empty-period' as const;
    return 'empty' as const;
  }, [canRenderCurrentChart, hasTimeline, loading, selectedFreq]);

  useEffect(() => {
    const previousChartStatus = previousChartStatusRef.current;
    previousChartStatusRef.current = chartStatus;
    if (previousChartStatus == null || chartStatus !== 'ready' || previousChartStatus === 'ready') return;
    const section = sectionRef.current;
    if (!section) return;
    const frameId = window.requestAnimationFrame(() => {
      section.scrollIntoView({ behavior: 'smooth', block: 'end' });
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [chartStatus]);

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
    <Paper ref={sectionRef} variant="outlined" component="section" aria-labelledby={headingId} sx={{ p: 2 }}>
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
        {selectedFreq ? `Частота для графіка: ${selectedFreq}` : 'Для графіка потрібно обрати одну частоту.'}
      </CompactText>
      {chartStatus === 'ready' ? (
        createElement('bar-chart-2', { ref: hostRef, role: 'img', 'aria-label': 'Графік активності по датах' })
      ) : chartStatus === 'needs-freq' ? (
        <Stack spacing={1.5} sx={{ alignItems: 'flex-start' }}>
          <PowerAlert
            severity="info"
            sx={{ width: '100%', pl: 0, '& .MuiAlert-message': { pl: 0 }, '& .MuiAlert-icon': { mr: 1 } }}
          >
            Оберіть частоту у фільтрі або скористайтесь швидким вибором нижче.
          </PowerAlert>
          {suggestedFreqs.length > 0 ? (
            <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
              {suggestedFreqs.map((freq) => (
                <Button key={freq} variant="outlined" size="small" onClick={() => onSelectFreq(freq)}>
                  {freq}
                </Button>
              ))}
            </Stack>
          ) : null}
        </Stack>
      ) : chartStatus === 'loading' ? (
        <Stack direction="row" spacing={1} alignItems="center" sx={{ minHeight: 80 }}>
          <CircularProgress size={18} />
          <CompactText color="text.secondary">
            Завантажую активність по датах…
          </CompactText>
        </Stack>
      ) : chartStatus === 'empty-period' ? (
        <PowerAlert severity="info">
          {`Для частоти ${selectedFreq} за цей інтервал активності не знайдено.`}
        </PowerAlert>
      ) : (
        <PowerAlert severity="info">
          {`Для частоти ${selectedFreq} немає даних для побудови графіка.`}
        </PowerAlert>
      )}
    </Paper>
  );
}
