import { Button, ButtonGroup, LinearProgress, Skeleton } from '@mui/material';
import { useEffect, useState, type CSSProperties } from 'react';
import type { DailyMessageStatsPanel } from '../../../../Bindings';
import dayjs from 'dayjs';
import { APP_TIME_ZONE } from '../../utils/misc';
import { PowerAlert } from '../../components/PowerAlert';
import { StatsChart } from './StatsChart';
import type { useStatsCatalog } from './use-stats-catalog';
import type { useDailyMessageStats } from './use-daily-message-stats';
import {
  today,
  STATS_SERIES_PAGE_SIZE,
  STATS_REFRESH_INDICATOR_DELAY_MS,
  type StatsState,
} from './state';

type Props = {
  panel: DailyMessageStatsPanel;
  state: StatsState;
  update: (patch: Partial<StatsState>, resetPage?: boolean) => void;
  catalog: ReturnType<typeof useStatsCatalog>;
  resource: ReturnType<typeof useDailyMessageStats>;
};

function useDelayedRefreshProgress(loading: boolean) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!loading) {
      setVisible(false);
      return;
    }
    const timer = window.setTimeout(() => setVisible(true), STATS_REFRESH_INDICATOR_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [loading]);
  return loading && visible;
}

export function StatisticsPanel({ panel, state, update, catalog, resource }: Props) {
  const byGroups = state.grouping === 'Groups';
  const data = resource.data;
  const showRefreshProgress = useDelayedRefreshProgress(resource.loading && !!data);
  const chartByGroups = resource.dataGrouping === 'Groups';
  const emptyMessage =
    !resource.loading && !catalog.loading && catalog.groups.length <= 1 && !catalog.error
      ? 'Немає доступних груп.'
      : data && !data.series.some((series) => series.points.some((point) => point.messages > 0))
        ? 'За вибраними фільтрами повідомлень немає.'
        : null;
  const pageNumber = state.cursors.length;
  return (
    <section
      aria-label={`Графік статистики: ${panel.name}`}
      style={{ '--message-statistics-bar': panel.color } as CSSProperties}
    >
      <div className="message-statistics-card">
        <h2 className="message-statistics-panel-heading">{panel.name}</h2>
        <div className="message-statistics-chart-controls">
          <span>Показати по</span>
          <ButtonGroup variant="outlined" size="small" aria-label="Розріз статистики">
            <Button aria-pressed={byGroups} onClick={() => update({ grouping: 'Groups' })}>
              Групах
            </Button>
            <Button aria-pressed={!byGroups} onClick={() => update({ grouping: 'Senders' })}>
              Відправниках
            </Button>
          </ButtonGroup>
          <p>Висота колонки і верхнє число — повідомлень за день</p>
        </div>
        <p className="message-statistics-legend">
          <span className="message-statistics-legend-swatch" aria-hidden="true" />
          <span className="message-statistics-legend-text">
            <span data-active={chartByGroups} aria-hidden={!chartByGroups}>
              Число на кольоровому тлі — скільки відправників працювало над групою
            </span>
            <span data-active={!chartByGroups} aria-hidden={chartByGroups}>
              Число на кольоровому тлі — скільки груп обробив відправник
            </span>
          </span>
        </p>
        <p className="sr-only" role="status">
          За часом надходження в Echo · Київ
          {state.to === today() ? ' · сьогодні неповний день' : ''}
          {data
            ? ` · оновлено ${dayjs(data.generatedAtMs).tz(APP_TIME_ZONE).format('HH:mm:ss')}`
            : ''}
        </p>
        <div className="message-statistics-chart-content" aria-busy={resource.loading}>
          {resource.loading && !data ? (
            <Skeleton variant="rounded" height="100%" aria-label="Завантаження статистики" />
          ) : null}
          {showRefreshProgress ? (
            <LinearProgress
              className="message-statistics-chart-progress"
              aria-label="Оновлення статистики"
            />
          ) : null}
          {data ? <StatsChart data={data} byGroups={chartByGroups} /> : null}
          {emptyMessage && !resource.error ? (
            <div className="message-statistics-chart-empty" role="status">
              <p>{emptyMessage}</p>
            </div>
          ) : null}
          <div className="message-statistics-chart-notices">
            {resource.error ? (
              <PowerAlert severity="error" dismissible={false}>
                {resource.error}
                {data ? ' Показано попередні дані.' : ''}
                <Button onClick={resource.refresh}>Повторити</Button>
              </PowerAlert>
            ) : null}
          </div>
        </div>
      </div>
      {data && (pageNumber > 1 || data.totalSeries > STATS_SERIES_PAGE_SIZE) ? (
        <nav className="message-statistics-pagination" aria-label="Сторінки серій">
          <Button
            disabled={pageNumber === 1 || resource.loading}
            onClick={() => update({ cursors: state.cursors.slice(0, -1) }, false)}
          >
            Попередні
          </Button>
          <span>
            {data.totalSeries
              ? `${(pageNumber - 1) * STATS_SERIES_PAGE_SIZE + 1}–${Math.min(pageNumber * STATS_SERIES_PAGE_SIZE, data.totalSeries)} з ${data.totalSeries}`
              : '0 серій'}
          </span>
          <Button
            disabled={!data.nextCursor || resource.loading}
            onClick={() => update({ cursors: [...state.cursors, data.nextCursor] }, false)}
          >
            Наступні
          </Button>
        </nav>
      ) : null}
    </section>
  );
}
