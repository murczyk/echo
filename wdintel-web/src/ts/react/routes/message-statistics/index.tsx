import { Button } from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import { useEffect, useState, type CSSProperties } from 'react';
import { PowerAlert } from '../../components/PowerAlert';
import { useStatsCatalog } from './use-stats-catalog';
import { buildStatsRequest, periodError, readState, stateHref, type StatsState } from './state';
import { StatisticsFilters } from './StatisticsFilters';
import { StatisticsPanels } from './StatisticsPanels';
import './message-statistics.css';

export function MessageStatisticsPage() {
  const theme = useTheme();
  const [state, setState] = useState(readState);
  const catalog = useStatsCatalog(state);
  const request = catalog.denied ? null : buildStatsRequest(state, catalog.hierarchy);
  const validation = periodError(state);
  const update = (patch: Partial<StatsState>, resetPage = true) => {
    setState((current) => {
      const next = { ...current, ...patch, ...(resetPage ? { cursors: [null] } : {}) };
      if (!periodError(next)) window.history.pushState({}, '', stateHref(next));
      return next;
    });
  };
  useEffect(() => {
    const restore = () => setState(readState());
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);
  return (
    <main
      className="message-statistics-page"
      style={
        {
          '--message-statistics-secondary': theme.palette.text.secondary,
          '--message-statistics-divider': theme.palette.divider,
          '--message-statistics-input-border': alpha(theme.palette.text.primary, 0.23),
        } as CSSProperties
      }
    >
      <header className="message-statistics-heading">
        <h1>Статистика повідомлень</h1>
        <p>Скільки повідомлень надіслав кожен відправник за день і скільки груп обробив</p>
      </header>
      <div className="message-statistics-content">
        <StatisticsFilters
          key={catalog.scopeVersion}
          state={state}
          update={update}
          catalog={catalog}
          request={request}
        />
        {validation ? (
          <PowerAlert severity="warning" dismissible={false}>
            {validation}
          </PowerAlert>
        ) : null}
        {catalog.error ? (
          <PowerAlert severity="error" dismissible={false}>
            {catalog.error}
            <Button onClick={catalog.retry}>Повторити</Button>
          </PowerAlert>
        ) : null}
        <StatisticsPanels state={state} request={request} catalog={catalog} />
      </div>
    </main>
  );
}
