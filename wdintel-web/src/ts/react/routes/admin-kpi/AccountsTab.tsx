import { FormControlLabel, MenuItem, Switch, TextField } from '@mui/material';
import { useMemo, useState } from 'react';

import { CountChart } from './CountChart';
import { KpiPanel, MetricCard, SnapshotState } from './KpiSummary';
import type { Login } from '../../../../Bindings';
import type { Snapshot } from './use-kpi-data';
import { StaleAccounts } from './StaleAccounts';
import {
  AccountStatus,
  KPI_MISSING_GROUP,
  Recency,
  accountRecency,
  accountStatus,
  countCategories,
  directionGroups,
  groupAccounts,
  organismGroup,
  recencyLabels,
  roleGroups,
  statusLabels,
} from './helpers';

export function AccountsTab({
  accounts,
}: {
  accounts: Snapshot<Login[]> & { reload: () => Promise<void> };
}) {
  const [role, setRole] = useState('');
  const [organism, setOrganism] = useState('');
  const [includeActive, setIncludeActive] = useState(false);
  const allAccounts = useMemo(() => accounts.data ?? [], [accounts.data]);
  const roleOptions = useMemo(() => groupAccounts(allAccounts, roleGroups), [allAccounts]);
  const organismOptions = useMemo(
    () => groupAccounts(allAccounts, (login) => [organismGroup(login)]),
    [allAccounts],
  );
  const selected = useMemo(
    () =>
      allAccounts.filter(
        (login) =>
          (!role || roleGroups(login).some((group) => group.id === role)) &&
          (!organism || organismGroup(login).id === organism),
      ),
    [allAccounts, role, organism],
  );
  const asOf = accounts.updatedAt ?? 0;
  const active = selected.filter((login) => accountStatus(login) === AccountStatus.Active);
  const stale = selected.filter((login) => accountRecency(login, asOf) === Recency.Stale);
  const statusRows = useMemo(
    () => countCategories(selected, statusLabels, accountStatus),
    [selected],
  );
  const recencyRows = useMemo(
    () =>
      countCategories(
        includeActive
          ? selected
          : selected.filter((login) => accountStatus(login) !== AccountStatus.Active),
        recencyLabels,
        (login) => accountRecency(login, asOf),
      ),
    [selected, includeActive, asOf],
  );
  const roleRows = useMemo(() => groupAccounts(selected, roleGroups), [selected]);
  const organismRows = useMemo(
    () => groupAccounts(selected, (login) => [organismGroup(login)]),
    [selected],
  );
  const directionRows = useMemo(() => groupAccounts(selected, directionGroups), [selected]);

  return (
    <KpiPanel title="База облікових записів">
      <p>
        Поточні облікові записи, доступні в адмініструванні користувачів, включно з технічними.
        Остаточно видалені облікові записи, облікові записи остаточно видалених організмів і
        керовані облікові записи ШІ не входять до підрахунку.
      </p>
      <p>
        Статус «активний» означає доступність облікового запису. Запис активності може оновлюватися
        під час створення, відновлення або роботи відкритої сторінки; він не підтверджує вхід чи дію
        людини.
      </p>
      <SnapshotState
        snapshot={accounts}
        label="облікові записи"
        retry={() => void accounts.reload()}
      />
      {accounts.data !== null && (
        <>
          <div className="grid gap-echo-md echo-md:grid-cols-2">
            <TextField
              select
              label="Роль"
              value={role}
              onChange={(event) => setRole(event.target.value)}
              fullWidth
            >
              <MenuItem value="">Усі ролі</MenuItem>
              {roleOptions.map((row) => (
                <MenuItem key={row.id} value={row.id}>
                  {row.label}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              select
              label="Організм"
              value={organism}
              onChange={(event) => setOrganism(event.target.value)}
              fullWidth
            >
              <MenuItem value="">Усі організми</MenuItem>
              {organismOptions.map((row) => (
                <MenuItem key={row.id} value={row.id}>
                  {row.label} ({row.id === KPI_MISSING_GROUP ? 'без прив’язки' : `ID ${row.id}`})
                </MenuItem>
              ))}
            </TextField>
          </div>
          <p className="text-echo-sm">
            Вибрано облікових записів: {selected.length} із {allAccounts.length}. Фільтри
            застосовано до всіх показників бази.
          </p>
          <div className="grid gap-echo-md echo-md:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              title="Облікові записи"
              value={selected.length}
              description="Наявна база у вибраному розрізі; не всі реєстрації за весь час."
            />
            <MetricCard
              title="Активні облікові записи"
              value={active.length}
              description="Не деактивовані та не заблоковані через організм."
            />
            <MetricCard
              title="Деактивовані / заблоковані"
              value={selected.length - active.length}
              description="Кожен обліковий запис враховується лише в одному статусі."
            />
            <MetricCard
              title="Потребують перевірки: понад 90 днів"
              value={stale.length}
              description="Запис активності старший за 90 днів; облікові записи без дати не включено."
            />
          </div>
          {selected.length === 0 && <p>Облікових записів у вибраному розрізі немає.</p>}
          <div className="grid items-start gap-echo-lg xl:grid-cols-2">
            <CountChart title="Статуси облікових записів" rows={statusRows} />
            <div className="min-w-0">
              <FormControlLabel
                control={
                  <Switch
                    checked={includeActive}
                    onChange={(_, checked) => setIncludeActive(checked)}
                  />
                }
                label="Включити активні облікові записи до давності"
              />
              <CountChart
                title="Давність останнього запису активності"
                rows={recencyRows}
                description={
                  includeActive
                    ? 'Усі вибрані облікові записи.'
                    : 'Лише деактивовані або заблоковані облікові записи. Відсутність дати не означає, що входів не було.'
                }
              />
            </div>
          </div>
          <div className="grid items-start gap-echo-lg xl:grid-cols-3">
            <CountChart
              title="Розподіл за ролями"
              rows={roleRows}
              description="Обліковий запис може мати кілька ролей. Це системні ролі, а не посади."
            />
            <CountChart title="Розподіл за організмами" rows={organismRows} />
            <CountChart
              title="Розподіл за напрямками"
              rows={directionRows}
              description="Напрямки з налаштувань користувачів; не військові підрозділи."
            />
          </div>
          <StaleAccounts key={`${role}:${organism}`} accounts={stale} />
        </>
      )}
    </KpiPanel>
  );
}
