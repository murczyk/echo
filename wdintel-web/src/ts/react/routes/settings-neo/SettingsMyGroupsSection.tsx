import { Box, CircularProgress, Stack, Typography } from '@mui/material';
import { MRT_ColumnDef } from 'material-react-table';
import { useMemo } from 'react';

import type { MyAdminSignalGroup, SignalGroupLogin } from '../../../../Bindings';
import { ELLIPSIS } from '../../utils/misc';
import { PowerAlert } from '../../components/PowerAlert';
import { TableStateProvider } from '../../components/mui-customized/table/table-state-provider';
import { SettingsNeoTable } from './SettingsNeoTable';

const DEFAULT_MY_GROUPS_COLUMNS_VISIBILITY = {
  name: true,
  aors: true,
  admins: true,
  privacy: true,
  allowedUsers: true,
};

const DEFAULT_MY_GROUPS_COLUMN_ORDER = [
  'mrt-row-numbers',
  'name',
  'aors',
  'admins',
  'privacy',
  'allowedUsers',
];

const MY_GROUPS_SETUP_FLOW_IMAGE_ALT =
  'Схема додавання групи: 1. Додайте номер бота до групи Signal або WhatsApp. 2. Напишіть в підтримку "Додано групу ...". 3. Вкажіть тип групи: приватна група — користувачі Delta1, Delta2; смугова група — смуга АК33, АК34.';

function formatAors(group: MyAdminSignalGroup): string {
  const aors = group.areasOfResponsibility ?? [];
  if (aors.length === 0) return '—';
  return aors.map((aor) => aor.name).join(', ');
}

function formatGroupLogin(login: SignalGroupLogin): string {
  if (!login.deltaLogin || login.login.toLocaleLowerCase() === login.deltaLogin.toLocaleLowerCase()) {
    return login.login;
  }
  return `${login.login} (${login.deltaLogin})`;
}

function formatGroupLogins(logins: SignalGroupLogin[]): string {
  if (logins.length === 0) return '—';
  return logins.map(formatGroupLogin).join(', ');
}

function formatAllowedUsers(group: MyAdminSignalGroup): string {
  if (!group.isGroupSecret) return 'без обмежень';
  return formatGroupLogins(group.allowedUsers);
}

function useMyGroupsColumns() {
  return useMemo<MRT_ColumnDef<MyAdminSignalGroup>[]>(
    () => [
      {
        header: 'Група',
        id: 'name',
        accessorFn: (row) => row.name || row.masterKey.slice(-5),
        size: 160,
      },
      {
        header: 'Смуги',
        id: 'aors',
        accessorFn: formatAors,
        enableSorting: false,
        size: 130,
      },
      {
        header: 'Адміни',
        id: 'admins',
        accessorFn: (row) => formatGroupLogins(row.adminLogins),
        enableSorting: false,
        size: 180,
      },
      {
        header: 'Є приватною',
        id: 'privacy',
        accessorFn: (row) => (row.isGroupSecret ? 'так' : 'ні'),
        size: 110,
      },
      {
        header: 'Логіни приватної групи',
        id: 'allowedUsers',
        accessorFn: formatAllowedUsers,
        enableSorting: false,
        size: 250,
      },
    ],
    [],
  );
}

function SettingsMyGroupsTable(props: { groups: MyAdminSignalGroup[]; loading: boolean }) {
  const columns = useMyGroupsColumns();
  return <SettingsNeoTable columns={columns} data={props.groups} loading={props.loading} />;
}

function MyGroupsSetupFlowImage() {
  return (
    <Box
      component="img"
      src="/img/settings-my-groups-flow.svg"
      alt={MY_GROUPS_SETUP_FLOW_IMAGE_ALT}
      sx={{
        display: 'block',
        width: '100%',
        maxWidth: 920,
        height: 'auto',
        mt: 0.5,
        borderRadius: 1,
      }}
    />
  );
}

export type SettingsMyGroupsSectionProps = {
  status: 'idle' | 'loading' | 'success' | 'error';
  groups: MyAdminSignalGroup[];
  error: string | null;
};

export function SettingsMyGroupsSection({ status, groups, error }: SettingsMyGroupsSectionProps) {
  const hasGroups = groups.length > 0;

  return (
    <Box role="tabpanel" id="settings-neo-panel-my-groups" aria-labelledby="settings-neo-tab-my-groups">
      <Box sx={{ p: 3 }}>
        <Stack spacing={3}>
          <Typography component="h2" variant="h6" sx={{ fontWeight: 700, lineHeight: 1.25 }}>
            Мої групи
          </Typography>

          <PowerAlert severity="info">
            <Stack spacing={1.5}>
              <Box>
                Для того щоби додати вашу приватну групу, додайте в неї телефон бота, написаний в описі групи підтримки, і напишіть адміністраторам повідомлення у форматі:
                <br />
                1. Додано групу МОЯ_ГРУПА (WhatsApp), зробіть мене (DeltaUser) адміном та групу приватною, видиму користувачам Delta1, Delta2, Delta3
                <br />
                2. Додано групу МОЯ_ГРУПА (Signal), зробіть мене (DeltaUser) адміном та групу публічною, на смугу 99АК
              </Box>
              <MyGroupsSetupFlowImage />
            </Stack>
          </PowerAlert>

          {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}

          {status === 'loading' ? (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <CircularProgress size={18} />
              <Typography variant="body2" color="text.secondary">
                Завантаження груп{ELLIPSIS}
              </Typography>
            </Box>
          ) : null}

          {status === 'success' && hasGroups ? (
            <TableStateProvider
              tableId="settings-neo-my-groups-v2"
              defaultColumnOrder={DEFAULT_MY_GROUPS_COLUMN_ORDER}
              defaultColumnVisibility={DEFAULT_MY_GROUPS_COLUMNS_VISIBILITY}
              defaultEnableColumnOrdering={false}
            >
              <Box sx={{ width: '100%', minWidth: 0, overflow: 'hidden' }}>
                <SettingsMyGroupsTable groups={groups} loading={false} />
              </Box>
            </TableStateProvider>
          ) : null}

          {status === 'success' && !hasGroups ? (
            <Box
              sx={{
                border: 1,
                borderColor: 'divider',
                borderRadius: 2,
                p: { xs: 2, sm: 2.5 },
                bgcolor: 'background.paper',
              }}
            >
              <Stack spacing={1}>
                <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                  Груп не знайдено
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Тут з&apos;являться групи, коли для вашого облікового запису знайдуться приватні або керовані групи.
                </Typography>
              </Stack>
            </Box>
          ) : null}
        </Stack>
      </Box>
    </Box>
  );
}
