import { Link, MenuItem, Skeleton, TextField } from '@mui/material';
import type { MRT_TableInstance } from 'material-react-table';

import { AuthorLabel } from '../../../components/AuthorLabel';
import { DeviceRowActions } from './DeviceRowActions';
import { DeviceStatusIcon } from './DeviceStatusIcon';
import { DeviceRating } from './DeviceRating';
import { DeviceTagsCell } from './DeviceTagsCell';
import { TableEmptyState } from '../../../components/TableEmptyState';
import { handleNavigateWithinSpaClick } from '../../../utils/browser';
import {
  customFieldColumnId,
  DEVICES_LOADING_PLACEHOLDER_COUNT,
  type DeviceRowView,
} from '../helpers';
import { useDeviceAutoLoad } from '../use-device-auto-load';
import { DeviceRecentActivityCell } from './DeviceRecentActivityCell';
import { DeviceSizeLabel } from './DeviceSizeLabel';

export function DeviceMobileList({
  table,
  rows,
  loading,
  refreshing,
  loadingMore,
  hasMore,
  startOffset,
  scrollResetKey,
  autoLoadBlocked,
  canEdit,
  canRate,
  onRate,
  mutatingDeviceId,
  hasFilters,
  onEdit,
  onLoadMore,
  onClearFilters,
}: {
  table: MRT_TableInstance<DeviceRowView>;
  rows: DeviceRowView[];
  loading: boolean;
  refreshing: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  startOffset: number;
  scrollResetKey: string;
  autoLoadBlocked: boolean;
  canEdit: boolean;
  canRate: boolean;
  onRate: (deviceId: string, rating: number) => void;
  mutatingDeviceId: string | null;
  hasFilters: boolean;
  onEdit: (id: string) => void;
  onLoadMore: () => Promise<void>;
  onClearFilters: () => void;
}) {
  const scroll = useDeviceAutoLoad<HTMLElement>({
    hasMore,
    blocked: autoLoadBlocked || loading || refreshing || loadingMore || mutatingDeviceId !== null,
    resetKey: scrollResetKey,
    onLoadMore,
  });
  const sorting = table.getState().sorting[0];
  const visible = (id: string) => table.getColumn(id)?.getIsVisible() !== false;
  const customFieldVisible = (key: string) =>
    table.getColumn(customFieldColumnId(key))?.getIsVisible() === true;
  return (
    <section
      ref={scroll.containerRef}
      onScroll={scroll.onScroll}
      data-testid="devices-mobile-scroll"
      aria-label="Пристрої"
      aria-busy={loading || refreshing || loadingMore}
      className="flex min-h-0 flex-1 flex-col gap-echo-md overflow-y-auto pt-echo-sm"
    >
      <TextField
        select
        size="small"
        label="Сортування"
        value={sorting ? `${sorting.id}:${sorting.desc ? 'desc' : 'asc'}` : ''}
        onChange={(event) => {
          const [id, direction] = event.target.value.split(':');
          table.setSorting(id ? [{ id, desc: direction === 'desc' }] : []);
        }}
      >
        <MenuItem value="">За замовчуванням (активність ↓)</MenuItem>
        {['name', 'rating', 'aors', 'unit', 'createdBy', 'createdAt', 'activity', 'size'].flatMap(
          (id) => [
            <MenuItem key={`${id}:asc`} value={`${id}:asc`}>
              {table.getColumn(id)?.columnDef.header} ↑
            </MenuItem>,
            <MenuItem key={`${id}:desc`} value={`${id}:desc`}>
              {table.getColumn(id)?.columnDef.header} ↓
            </MenuItem>,
          ],
        )}
      </TextField>
      {loading && rows.length === 0 ? (
        <Skeleton variant="rounded" height={160} />
      ) : rows.length === 0 ? (
        <TableEmptyState
          message={hasFilters ? 'Пристрої не знайдено' : 'Пристрої ще не створені'}
          actionLabel={hasFilters ? 'Очистити фільтри' : undefined}
          onAction={hasFilters ? onClearFilters : undefined}
        />
      ) : null}
      <ul className="m-0 flex list-none flex-col gap-echo-md p-0">
        {rows.map((row, index) => (
          <li
            key={row.id}
            className="min-w-0 rounded-echo-md border border-echo-border bg-echo-surface p-echo-md"
          >
            <div className="flex min-w-0 items-center gap-echo-sm">
              <DeviceStatusIcon archived={row.archived} />
              <Link
                variant="body2"
                href={`/devices/${row.id}`}
                onClick={(event) => handleNavigateWithinSpaClick(event, `/devices/${row.id}`)}
                className="min-w-0 flex-1 py-echo-sm font-semibold [overflow-wrap:anywhere]"
              >
                {row.name ?? 'Без назви'}
              </Link>
              {canEdit ? (
                <DeviceRowActions
                  row={row}
                  canEdit={canEdit}
                  disabled={mutatingDeviceId !== null}
                  onEdit={onEdit}
                />
              ) : null}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-echo-sm py-echo-sm">
              {visible('unit') ? (
                <span className="min-w-0 text-[length:var(--echo-typography-font-size-base)] [overflow-wrap:anywhere]">
                  {row.unitLabel}
                </span>
              ) : null}
              {visible('rating') ? (
                <DeviceRating
                  row={row}
                  canRate={canRate}
                  disabled={mutatingDeviceId !== null}
                  onRate={onRate}
                />
              ) : null}
            </div>
            {visible('tags') ? <DeviceTagsCell tags={row.tags} /> : null}
            {visible('size') ? (
              <p className="m-0 text-[length:var(--echo-typography-font-size-xs)] text-echo-text/70">
                Розмір: <DeviceSizeLabel row={row} />
              </p>
            ) : null}
            {visible('activity') && row.activity !== null ? (
              <div className="py-echo-sm">
                <DeviceRecentActivityCell
                  activity={row.activity}
                  splitFilesAudio={row.activitySplitFilesAudio}
                />
              </div>
            ) : null}
            <details className="mt-echo-sm text-[length:var(--echo-typography-font-size-base)]">
              <summary className="min-h-echo-control-lg cursor-pointer py-echo-md text-echo-primary">
                Деталі
              </summary>
              <dl className="m-0 grid min-w-0 gap-echo-sm [overflow-wrap:anywhere]">
                <div>
                  <dt>№</dt>
                  <dd className="m-0">{startOffset + index + 1}</dd>
                </div>
                {visible('aors') ? (
                  <div>
                    <dt>Смуги</dt>
                    <dd className="m-0">{row.aorLabel}</dd>
                  </div>
                ) : null}
                {visible('createdBy') ? (
                  <div>
                    <dt>Створив</dt>
                    <dd className="m-0">
                      <AuthorLabel login={row.createdBy} interactive={false} />
                    </dd>
                  </div>
                ) : null}
                {visible('createdAt') ? (
                  <div>
                    <dt>Створено</dt>
                    <dd className="m-0">{row.createdAtLabel}</dd>
                  </div>
                ) : null}
                {visible('description') && row.description ? (
                  <div>
                    <dt>Опис</dt>
                    <dd className="m-0 whitespace-pre-line">{row.description}</dd>
                  </div>
                ) : null}
                {Object.entries(row.customFields)
                  .filter(([key, value]) => value && customFieldVisible(key))
                  .map(([key, value]) => (
                    <div key={key}>
                      <dt>{key}</dt>
                      <dd className="m-0">{value}</dd>
                    </div>
                  ))}
              </dl>
            </details>
          </li>
        ))}
      </ul>
      {loadingMore ? (
        <div
          role="status"
          aria-label="Завантаження пристроїв"
          className="flex shrink-0 flex-col gap-echo-md"
        >
          {Array.from({ length: DEVICES_LOADING_PLACEHOLDER_COUNT }, (_, index) => (
            <Skeleton key={index} animation="wave" variant="rounded" height={160} aria-hidden />
          ))}
        </div>
      ) : null}
    </section>
  );
}
