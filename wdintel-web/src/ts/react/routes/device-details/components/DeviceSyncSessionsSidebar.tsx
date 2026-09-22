import RefreshIcon from '@mui/icons-material/Refresh';
import { ButtonBase, CircularProgress, TextField, Typography } from '@mui/material';
import { useEffect, useRef } from 'react';

import type { SyncSummary } from '../../../../../Bindings';
import { PowerButton } from '../../../components/PowerButton';
import { PowerIconButton } from '../../../components/PowerIconButton';
import type { DeviceSyncSessionsState } from '../use-device-sync-sessions';

const number = new Intl.NumberFormat('uk-UA');
const day = new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'long', year: 'numeric' });
const time = new Intl.DateTimeFormat('uk-UA', { hour: '2-digit', minute: '2-digit' });
const statuses: Record<SyncSummary['status'], string> = {
  open: 'Триває',
  completed: 'Завершено',
  completed_with_errors: 'З помилками',
  expired: 'Час вичерпано',
};

export function DeviceSyncSessionsSidebar({
  deviceId,
  syncId,
  state,
  onSelect,
}: {
  deviceId: string;
  syncId: string | null;
  state: DeviceSyncSessionsState;
  onSelect: (id: string | null) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowIds = state.rows.map((row) => row.syncId).join(',');
  const setVisibleIds = state.setVisibleIds;
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisibleIds(rowIds.split(',').filter(Boolean).slice(0, 10));
      return;
    }
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.syncId;
          if (!id) continue;
          if (entry.isIntersecting) visible.add(id);
          else visible.delete(id);
        }
        setVisibleIds([...visible].sort());
      },
      { root, rootMargin: '100px' },
    );
    for (const row of root.querySelectorAll('[data-sync-id]')) observer.observe(row);
    return () => {
      observer.disconnect();
      setVisibleIds([]);
    };
  }, [rowIds, setVisibleIds]);

  let previousDay = '';
  return (
    <aside
      aria-labelledby="device-sync-sessions-title"
      data-testid="device-sync-sessions-sidebar"
      className="bg-echo-surface border border-echo-border rounded-echo-md min-w-0 min-h-0 flex flex-col overflow-hidden h-[50vh] echo-lg:h-full"
    >
      <header className="p-echo-lg flex flex-col gap-echo-md border-b border-echo-border">
        <div className="flex items-center justify-between gap-echo-sm">
          <Typography
            component="h2"
            id="device-sync-sessions-title"
            variant="subtitle2"
            fontWeight={600}
          >
            Сесії синхронізації
          </Typography>
          <PowerIconButton
            aria-label="Оновити сесії"
            onClick={state.refresh}
            disabled={state.loading}
            size="small"
          >
            <RefreshIcon fontSize="small" />
          </PowerIconButton>
        </div>
        <TextField
          type="date"
          size="small"
          label="Знайти за датою"
          value={state.date}
          onChange={(event) => state.setDate(event.target.value)}
          InputLabelProps={{ shrink: true }}
          fullWidth
        />
      </header>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-echo-md">
        <ButtonBase
          onClick={() => onSelect(null)}
          aria-pressed={syncId === null}
          className="w-full !justify-start !rounded-echo-md !p-echo-md text-left"
          sx={{ bgcolor: syncId === null ? 'action.selected' : undefined }}
        >
          <span className="flex flex-col gap-echo-xs text-left">
            <strong>Усі сесії</strong>
            <span className="text-echo-sm text-echo-text-muted">
              {state.total === null
                ? 'Усі файли пристрою'
                : `${number.format(state.total)} файлів за весь час`}
            </span>
          </span>
        </ButtonBase>
        {state.error ? (
          <div role="alert" className="p-echo-md text-echo-sm">
            {state.error}
            <PowerButton size="small" onClick={state.refresh}>
              Спробувати ще раз
            </PowerButton>
          </div>
        ) : null}
        {state.loading && state.rows.length === 0 ? (
          <div className="p-echo-lg flex justify-center">
            <CircularProgress size={24} aria-label="Завантаження сесій" />
          </div>
        ) : null}
        {!state.loading && state.rows.length === 0 && !state.error ? (
          <p className="p-echo-md text-echo-sm text-echo-text-muted">Сесій не знайдено.</p>
        ) : null}
        <ul className="m-0 p-0 list-none">
          {state.rows.map((session) => {
            const date = day.format(new Date(session.createdAt));
            const showDay = date !== previousDay;
            previousDay = date;
            const summary = state.stats[`${deviceId}:${session.syncId}`];
            return (
              <li key={session.syncId}>
                {showDay ? (
                  <Typography
                    component="h3"
                    variant="caption"
                    color="text.secondary"
                    className="px-echo-md !mt-echo-lg !mb-echo-sm"
                  >
                    {date}
                  </Typography>
                ) : null}
                <ButtonBase
                  data-sync-id={session.syncId}
                  aria-pressed={syncId === session.syncId}
                  onClick={() => onSelect(session.syncId)}
                  className="w-full !justify-start !rounded-echo-md !p-echo-md text-left"
                  sx={{ bgcolor: syncId === session.syncId ? 'action.selected' : undefined }}
                >
                  <span className="flex w-full flex-col gap-echo-sm text-left">
                    <span className="flex justify-between gap-echo-sm">
                      <strong>
                        {time.format(new Date(session.createdAt))}
                        {session.completedAt
                          ? ` — ${time.format(new Date(session.completedAt))}`
                          : ''}
                      </strong>
                      <span className="text-echo-xs text-echo-text-muted">
                        {statuses[session.status]}
                      </span>
                    </span>
                    <span className="text-echo-sm">
                      {summary
                        ? `${number.format(summary.totalFileCount)} файлів`
                        : `${number.format(session.counts.accepted)} прийнято`}
                    </span>
                    {summary?.items.length ? (
                      <span className="text-echo-xs text-echo-text-muted">
                        {summary.items
                          .slice(0, 3)
                          .map((item) => `${number.format(item.fileCount)} ${item.tag.name}`)
                          .join(' · ')}
                      </span>
                    ) : null}
                    {summary && summary.analyzedFileCount < summary.totalFileCount ? (
                      <span className="text-echo-xs text-echo-text-muted">
                        Проаналізовано {number.format(summary.analyzedFileCount)} з{' '}
                        {number.format(summary.totalFileCount)}
                      </span>
                    ) : null}
                    {session.counts.rejected > 0 ? (
                      <span className="text-echo-xs text-echo-text-muted">
                        Відхилено: {number.format(session.counts.rejected)}
                      </span>
                    ) : null}
                  </span>
                </ButtonBase>
              </li>
            );
          })}
        </ul>
        {state.nextCursor ? (
          <div className="pt-echo-md">
            <PowerButton
              fullWidth
              size="small"
              onClick={() => void state.loadMore()}
              disabled={state.loadingMore || state.loading}
            >
              {state.loadingMore ? 'Завантаження…' : 'Показати старіші сесії'}
            </PowerButton>
          </div>
        ) : null}
      </div>
    </aside>
  );
}
