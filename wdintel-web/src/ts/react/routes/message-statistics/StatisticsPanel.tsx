import { Button, ButtonGroup, LinearProgress, Skeleton } from '@mui/material';
import type { CSSProperties } from 'react';
import type { DailyMessageStatsPanel } from '../../../../Bindings';
import dayjs from 'dayjs';
import { APP_TIME_ZONE } from '../../utils/misc';
import { PowerAlert } from '../../components/PowerAlert';
import { StatsChart } from './StatsChart';
import type { useStatsCatalog } from './use-stats-catalog';
import type { useDailyMessageStats } from './use-daily-message-stats';
import { today, STATS_SERIES_PAGE_SIZE, type StatsState } from './state';

type Props = {
  panel: DailyMessageStatsPanel;
  state: StatsState;
  update: (patch: Partial<StatsState>, resetPage?: boolean) => void;
  catalog: ReturnType<typeof useStatsCatalog>;
  resource: ReturnType<typeof useDailyMessageStats>;
};
export function StatisticsPanel({ panel, state, update, catalog, resource }: Props) {
  const byGroups = state.grouping === 'Groups';
  const data = resource.data;
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
          <p>Висота колонки і число над нею — повідомлень за день</p>
        </div>
        <p className="message-statistics-legend">
          <span className="message-statistics-legend-swatch" aria-hidden="true" />
          <span className="message-statistics-legend-text">
            <span data-active={byGroups} aria-hidden={!byGroups}>
              Число в колонці — скільки відправників працювало над групою
            </span>
            <span data-active={!byGroups} aria-hidden={byGroups}>
              Число в колонці — скільки груп обробив відправник
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
          {resource.loading && data ? (
            <LinearProgress
              className="message-statistics-chart-progress"
              aria-label="Оновлення статистики"
            />
          ) : null}
          {data && data.series.length > 0 ? <StatsChart data={data} byGroups={byGroups} /> : null}
          <div className="message-statistics-chart-notices">
            {resource.error ? (
              <PowerAlert severity="error" dismissible={false}>
                {resource.error}
                {data ? ' Показано попередні дані.' : ''}
                <Button onClick={resource.refresh}>Повторити</Button>
              </PowerAlert>
            ) : null}
            {!resource.loading &&
            !catalog.loading &&
            catalog.groups.length <= 1 &&
            !catalog.error ? (
              <PowerAlert severity="info">Немає доступних груп.</PowerAlert>
            ) : null}
            {data && data.series.length > 0 ? (
              data.series.every((series) =>
                series.points.every((point) => point.messages === 0),
              ) ? (
                <PowerAlert severity="info">
                  За вибраними фільтрами в цих групах повідомлень немає.
                </PowerAlert>
              ) : null
            ) : data && catalog.groups.length > 1 ? (
              <PowerAlert severity="info">За вибраними фільтрами повідомлень немає.</PowerAlert>
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
