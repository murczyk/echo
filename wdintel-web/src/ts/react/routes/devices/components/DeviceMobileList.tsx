import EditIcon from '@mui/icons-material/Edit';
import { CircularProgress, Link, MenuItem, Skeleton, TextField } from '@mui/material';
import type { MRT_TableInstance } from 'material-react-table';

import { AuthorLabel } from '../../../components/AuthorLabel';
import { PowerButton } from '../../../components/PowerButton';
import { PowerChip } from '../../../components/PowerChip';
import { PowerIconButton } from '../../../components/PowerIconButton';
import { TableEmptyState } from '../../../components/TableEmptyState';
import { handleNavigateWithinSpaClick } from '../../../utils/browser';
import type { DeviceRowView } from '../helpers';
import { DeviceActivityChart } from './DeviceActivityChart';
import { DeviceSizeLabel } from './DeviceSizeLabel';

export function DeviceMobileList({
  table,
  rows,
  loading,
  refreshing,
  loadingMore,
  hasMore,
  total,
  canEdit,
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
  total: number;
  canEdit: boolean;
  mutatingDeviceId: string | null;
  hasFilters: boolean;
  onEdit: (id: string) => void;
  onLoadMore: () => Promise<void>;
  onClearFilters: () => void;
}) {
  const sorting = table.getState().sorting[0];
  const visible = (id: string) => table.getColumn(id)?.getIsVisible() !== false;
  return (
    <section
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
        <MenuItem value="">Без сортування</MenuItem>
        {['name', 'createdAt'].flatMap((id) => [
          <MenuItem key={`${id}:asc`} value={`${id}:asc`}>
            {table.getColumn(id)?.columnDef.header} ↑
          </MenuItem>,
          <MenuItem key={`${id}:desc`} value={`${id}:desc`}>
            {table.getColumn(id)?.columnDef.header} ↓
          </MenuItem>,
        ])}
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
              <Link
                href={`/devices/${row.id}`}
                onClick={(event) => handleNavigateWithinSpaClick(event, `/devices/${row.id}`)}
                className="min-w-0 flex-1 py-echo-sm font-semibold [overflow-wrap:anywhere]"
              >
                {row.name ?? 'Без назви'}
              </Link>
              {canEdit && !row.archived ? (
                <PowerIconButton
                  className="!size-echo-control-lg shrink-0"
                  aria-label={`Редагувати ${row.name ?? 'пристрій'}`}
                  disabled={mutatingDeviceId !== null}
                  onClick={() => onEdit(row.id)}
                >
                  <EditIcon fontSize="small" />
                </PowerIconButton>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-echo-sm py-echo-sm">
              {visible('unit') ? (
                <span className="min-w-0 text-[length:var(--echo-typography-font-size-sm)] [overflow-wrap:anywhere]">
                  {row.unitLabel}
                </span>
              ) : null}
              {visible('lifecycle') ? (
                <PowerChip
                  label={row.archived ? 'Архівний' : 'Активний'}
                  color={row.archived ? 'warning' : 'success'}
                  selected
                  interactive={false}
                />
              ) : null}
            </div>
            {visible('size') ? (
              <p className="m-0 text-[length:var(--echo-typography-font-size-xs)] text-echo-text/70">
                Розмір: <DeviceSizeLabel row={row} />
              </p>
            ) : null}
            {visible('activity') && row.activity.length > 0 ? (
              <div className="py-echo-sm">
                <DeviceActivityChart days={row.activity} />
              </div>
            ) : null}
            <details className="mt-echo-sm text-[length:var(--echo-typography-font-size-sm)]">
              <summary className="min-h-echo-control-lg cursor-pointer py-echo-md text-echo-primary">
                Деталі
              </summary>
              <dl className="m-0 grid min-w-0 gap-echo-sm [overflow-wrap:anywhere]">
                <div>
                  <dt>№</dt>
                  <dd className="m-0">{index + 1}</dd>
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
                      <AuthorLabel login={row.createdBy} />
                    </dd>
                  </div>
                ) : null}
                {visible('createdAt') ? (
                  <div>
                    <dt>Створено</dt>
                    <dd className="m-0">{row.createdAtLabel}</dd>
                  </div>
                ) : null}
              </dl>
            </details>
          </li>
        ))}
      </ul>
      {rows.length > 0 ? (
        <p
          role="status"
          className="m-0 text-center text-[length:var(--echo-typography-font-size-sm)]"
        >
          Показано {rows.length} з {total}
        </p>
      ) : null}
      {hasMore ? (
        <PowerButton
          variant="outlined"
          className="!min-h-echo-control-lg shrink-0"
          disabled={loadingMore || loading || refreshing}
          onClick={() => void onLoadMore()}
          startIcon={loadingMore ? <CircularProgress size={16} /> : null}
        >
          Завантажити ще
        </PowerButton>
      ) : null}
    </section>
  );
}
