import { MenuItem, TextField, Typography } from '@mui/material';
import { useMemo } from 'react';
import type { Login, OrganismUserLabelsRsp } from '../../../../Bindings';
import {
  type AppMrtColumnDef,
  mrtCustomCell,
} from '../../components/mui-customized/table/get-default-table-options';
import { UsersTable } from '../admin-users-neo/UsersTable';
import { MessageStatisticsExclusion } from './MessageStatisticsExclusion';

export function OrganismUsersList({
  users,
  labels,
  busy,
  edit,
  onUserUpdated,
  assignLabel,
  setExcluded,
}: {
  users: Login[];
  labels: OrganismUserLabelsRsp;
  busy: boolean;
  edit: (user: Login) => void;
  onUserUpdated: (user: Login) => void;
  assignLabel: (id: string, label: number | null) => void;
  setExcluded: (id: string, excluded: boolean) => void;
}) {
  const columns = useMemo<AppMrtColumnDef<Login>[]>(() => {
    const assigned = new Map(labels.assignments.map((entry) => [entry.loginId, entry.labelId]));
    const excluded = new Set(labels.excludedLoginIds);
    return [
      {
        id: 'userLabel',
        header: 'Лейбл',
        size: 220,
        accessorFn: (user) =>
          labels.labels.find((label) => label.id === assigned.get(user.id))?.name ?? 'Без лейбла',
        meta: { overflowMode: 'custom', overflowOwner: 'structured-layout', interactive: true },
        Cell: mrtCustomCell(({ row }) => (
          <TextField
            select
            size="small"
            fullWidth
            value={assigned.get(row.original.id) ?? ''}
            slotProps={{
              select: {
                sx: (theme) => ({
                  fontSize: theme.echo.fontSize.sm,
                  '& .MuiSelect-select': { py: theme.echo.spacing.xs },
                }),
                displayEmpty: true,
                inputProps: { 'aria-label': `Лейбл: ${row.original.login}` },
              },
            }}
            disabled={busy}
            onChange={(event) =>
              assignLabel(
                row.original.id,
                event.target.value === '' ? null : Number(event.target.value),
              )
            }
          >
            <MenuItem value="">Без лейбла</MenuItem>
            {labels.labels.map((label) => (
              <MenuItem key={label.id} value={label.id}>
                {label.name}
              </MenuItem>
            ))}
          </TextField>
        )),
      },
      {
        id: 'messageStatsExcluded',
        header: 'Статистика повідомлень',
        size: 320,
        accessorFn: (user) => (excluded.has(user.id) ? 'Виключено' : 'Враховується'),
        meta: { overflowMode: 'custom', overflowOwner: 'structured-layout', interactive: true },
        Cell: mrtCustomCell(({ row }) => (
          <MessageStatisticsExclusion
            login={row.original.login}
            excluded={excluded.has(row.original.id)}
            disabled={busy}
            onChange={(checked) => setExcluded(row.original.id, checked)}
          />
        )),
      },
    ];
  }, [labels, busy, assignLabel, setExcluded]);
  return (
    <div className="flex min-w-0 flex-col gap-echo-sm">
      <Typography variant="body2" color="text.secondary">
        Виключення діє для всіх періодів статистики.
      </Typography>
      <UsersTable
        data={users}
        loading={false}
        onEdit={edit}
        onUserUpdated={onUserUpdated}
        extraColumns={columns}
      />
    </div>
  );
}
