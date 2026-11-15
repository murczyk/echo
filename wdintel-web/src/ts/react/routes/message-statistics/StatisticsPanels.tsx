import { Button } from '@mui/material';
import { useEffect, useState } from 'react';
import type {
  DailyMessageStatsPanel,
  DailyMessageStatsReq,
  DailyMessageStatsPanelsRsp,
} from '../../../../Bindings';
import { fetchDailyMessageStatsPanels } from '../../services/api/daily-message-stats';
import { isAbortError } from '../../services/api/client';
import { PowerAlert } from '../../components/PowerAlert';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { StatisticsPanel } from './StatisticsPanel';
import { useDailyMessageStats } from './use-daily-message-stats';
import type { useStatsCatalog } from './use-stats-catalog';
import { buildStatsRequest, STATS_REFRESH_MS, type StatsState } from './state';

type Catalog = ReturnType<typeof useStatsCatalog>;
type PanelView = Pick<StatsState, 'grouping' | 'cursors'>;

function usePanelViews(state: StatsState, scopeVersion: number) {
  const filterKey = JSON.stringify([
    state.from,
    state.to,
    state.groups,
    state.senders,
    state.units,
    state.children,
    scopeVersion,
  ]);
  const [saved, setSaved] = useState({
    filterKey,
    scopeVersion,
    views: {} as Record<number, PanelView>,
  });
  if (saved.filterKey !== filterKey) {
    setSaved({
      filterKey,
      scopeVersion,
      views:
        saved.scopeVersion === scopeVersion
          ? Object.fromEntries(
              Object.entries(saved.views).map(([id, view]) => [id, { ...view, cursors: [null] }]),
            )
          : {},
    });
  }
  const update = (labelId: number, patch: Partial<StatsState>, resetPage = true) => {
    setSaved((current) => {
      const view = current.views[labelId] ?? { grouping: state.grouping, cursors: [null] };
      return {
        ...current,
        views: {
          ...current.views,
          [labelId]: {
            grouping: patch.grouping ?? view.grouping,
            cursors: resetPage ? [null] : (patch.cursors ?? view.cursors),
          },
        },
      };
    });
  };
  return { views: saved.views, update };
}

function LabelPanel({
  panel,
  state,
  catalog,
  view,
  update,
}: {
  panel: DailyMessageStatsPanel;
  state: StatsState;
  catalog: Catalog;
  view: PanelView;
  update: (patch: Partial<StatsState>, resetPage?: boolean) => void;
}) {
  const local = { ...state, ...view };
  const base = buildStatsRequest(local, catalog.hierarchy);
  const request = base && !catalog.denied ? { ...base, userLabelId: panel.labelId } : null;
  const resource = useDailyMessageStats(request, catalog.scopeVersion, catalog.reject);
  return (
    <StatisticsPanel
      panel={panel}
      state={local}
      update={update}
      catalog={catalog}
      resource={resource}
    />
  );
}

export function StatisticsPanels({
  state,
  request,
  catalog,
}: {
  state: StatsState;
  request: DailyMessageStatsReq | null;
  catalog: Catalog;
}) {
  const { views, update } = usePanelViews(state, catalog.scopeVersion);
  const [response, setResponse] = useState<{
    scopeVersion: number;
    data: DailyMessageStatsPanelsRsp;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const { notify } = usePowerSnackbar();
  const key = JSON.stringify([
    request && { ...request, grouping: 'Groups', cursor: null },
    catalog.scopeVersion,
  ]);
  const enabled = !!request && !!catalog.accessRevision && !catalog.denied;
  useEffect(() => {
    if (!enabled || !request) return;
    const controller = new AbortController();
    setError(null);
    fetchDailyMessageStatsPanels({ ...request, cursor: null }, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted && catalog.checkResponse(data))
          setResponse({ scopeVersion: catalog.scopeVersion, data });
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted || isAbortError(reason)) return;
        catalog.reject(reason);
        const message =
          reason instanceof Error ? reason.message : 'Не вдалося завантажити панелі статистики.';
        setError(message);
        notify({ severity: 'error', message });
      });
    return () => controller.abort();
  }, [key, enabled, revision, notify, catalog.checkResponse, catalog.reject]);
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') setRevision((value) => value + 1);
    }, STATS_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [enabled]);
  const panels =
    enabled && response?.scopeVersion === catalog.scopeVersion ? response.data.panels : [];
  const loaded = enabled && response?.scopeVersion === catalog.scopeVersion;
  if (catalog.denied || !request) return null;
  return (
    <div className="message-statistics-panels">
      {error ? (
        <PowerAlert severity="error" dismissible={false}>
          {error}
          <Button onClick={() => setRevision((value) => value + 1)}>Повторити</Button>
        </PowerAlert>
      ) : null}
      {loaded && !panels.length && !error ? (
        <PowerAlert severity="info" dismissible={false}>
          Немає доступних панелей статистики. Користувач має належати до організму.
        </PowerAlert>
      ) : null}
      {!loaded && !error ? (
        <StatisticsPanel
          panel={{
            labelId: -1,
            name: 'Завантаження панелей',
            color: '#87d7f1',
            organismName: null,
          }}
          state={state}
          update={() => undefined}
          catalog={catalog}
          resource={{ data: null, error: null, loading: true, refresh: () => undefined }}
        />
      ) : null}
      {panels.map((panel) => (
        <LabelPanel
          key={panel.labelId}
          panel={panel}
          state={state}
          catalog={catalog}
          view={views[panel.labelId] ?? { grouping: state.grouping, cursors: [null] }}
          update={(patch, resetPage) => update(panel.labelId, patch, resetPage)}
        />
      ))}
    </div>
  );
}
