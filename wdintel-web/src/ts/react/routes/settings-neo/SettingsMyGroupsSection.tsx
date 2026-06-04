import { Box, CircularProgress, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from '@mui/material';

import type { MyAdminSignalGroup } from '../../../../Bindings';
import { ELLIPSIS } from '../../utils/misc';
import { PowerAlert } from '../../components/PowerAlert';

function formatOptionalText(value: string | null | undefined): string {
  if (!value || !value.trim()) return '—';
  return value;
}

function formatAors(group: MyAdminSignalGroup): string {
  const aors = group.areasOfResponsibility ?? [];
  if (aors.length === 0) return '—';
  return aors.map((aor) => aor.name).join(', ');
}

function formatAllowedUsers(group: MyAdminSignalGroup): string {
  if (!group.isGroupSecret) return 'без обмежень';
  if (group.allowedUsers.length === 0) return '—';
  return group.allowedUsers.join(', ');
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
            Для того щоби додати вашу приватну групу, додайте в неї телефон бота, написаний в описі групи підтримки, і напишіть адміністраторам повідомлення у форматі:
            <br />
            1. Додано групу МОЯ_ГРУПА (WhatsApp), зробіть мене (DeltaUser) адміном та групу приватною, видиму користувачам Delta1, Delta2, Delta3
            <br />
            2. Додано групу МОЯ_ГРУПА (Signal), зробіть мене (DeltaUser) адміном та групу публічною, на смугу 99АК
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
            <TableContainer sx={{ border: 1, borderColor: 'divider', borderRadius: 2 }}>
              <Table
                size="small"
                sx={{
                  '& .MuiTableBody-root .MuiTableRow-root:last-of-type .MuiTableCell-root': {
                    borderBottom: 0,
                  },
                }}
              >
                <TableHead>
                  <TableRow>
                    <TableCell>Група</TableCell>
                    <TableCell>Джерело</TableCell>
                    <TableCell>Смуги</TableCell>
                    <TableCell>Приватність</TableCell>
                    <TableCell>Логіни приватної групи</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {groups.map((group) => (
                    <TableRow key={group.masterKey}>
                      <TableCell>{group.name || group.masterKey.slice(-5)}</TableCell>
                      <TableCell>{formatOptionalText(group.datasourceName ?? group.datasourceKind)}</TableCell>
                      <TableCell>{formatAors(group)}</TableCell>
                      <TableCell>{group.isGroupSecret ? 'приватна' : 'публічна'}</TableCell>
                      <TableCell>{formatAllowedUsers(group)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
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
