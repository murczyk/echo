import { Box, CircularProgress, Stack, TextField, Typography } from '@mui/material';

import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { useReportsSettings } from './use-reports-settings';

type Props = {
  active: boolean;
  userRoles: string[];
  rolesLoading: boolean;
};

export function SettingsReportsSection({ active, userRoles, rolesLoading }: Props) {
  const reportsSettings = useReportsSettings({ active, userRoles });
  const isInvalidOrderInput = (value: string) => value.trim() === '' || !Number.isFinite(Number(value));

  return (
    <Box id="settings-neo-panel-reports" role="tabpanel" aria-labelledby="settings-neo-tab-reports" sx={{ p: 3 }}>
      <Stack spacing={3}>
        <Typography component="h2" variant="h6" sx={{ fontWeight: 700, lineHeight: 1.25 }}>
          Звіти
        </Typography>
        <Box>
          <Typography variant="body2" color="text.secondary">
            Порядок визначає послідовність аркушів у GOI-звіті. Менші значення йдуть раніше; AOR без даних пропускаються.
            Менше значення порядку відображається вище в звіті.
          </Typography>
        </Box>

        {!rolesLoading && !reportsSettings.canRead ? (
          <PowerAlert severity="info">У вас немає доступу до налаштування порядку звітів.</PowerAlert>
        ) : null}
        {reportsSettings.loadError ? <PowerAlert severity="error">{reportsSettings.loadError}</PowerAlert> : null}
        {reportsSettings.saveError ? <PowerAlert severity="error">{reportsSettings.saveError}</PowerAlert> : null}
        {reportsSettings.saveSuccess ? (
          <PowerAlert severity="success" role="status">
            {reportsSettings.saveSuccess}
          </PowerAlert>
        ) : null}
        {!rolesLoading && reportsSettings.canRead && !reportsSettings.canEdit ? (
          <PowerAlert severity="info">Редагування доступне ролям `Admin` або `Rer`.</PowerAlert>
        ) : null}

        {reportsSettings.canRead && (rolesLoading || reportsSettings.loadStatus === 'loading') ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress size={28} />
          </Box>
        ) : null}

        {reportsSettings.canRead && !rolesLoading && reportsSettings.loadStatus === 'ready' ? (
          <Stack spacing={2.5}>
            <Box
              sx={{
                width: '100%',
                maxWidth: '100%',
                mx: 'auto',
              }}
            >
              <Box
                sx={{
                  display: { xs: 'none', md: 'grid' },
                  gridTemplateColumns: 'minmax(0, 1fr) 40px minmax(0, 1fr)',
                  alignItems: 'end',
                  pb: 1.5,
                }}
              >
                <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2 }}>
                  <Typography variant="body2" color="text.secondary">
                    Смуга
                  </Typography>
                </Box>
                <Box />
                <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2 }}>
                  <Typography variant="body2" color="text.secondary">
                    Смуга
                  </Typography>
                </Box>
              </Box>

              {reportsSettings.rowPairs.map(([leftRow, rightRow], rowIndex) => {
                const leftInvalid = isInvalidOrderInput(leftRow.orderInput);
                const rightInvalid = rightRow == null ? false : isInvalidOrderInput(rightRow.orderInput);
                const topBorderSx = rowIndex > 0 ? { borderTop: 1, borderColor: 'divider' } : undefined;
                return (
                  <Box
                    key={leftRow.id}
                    sx={{
                      display: { xs: 'none', md: 'grid' },
                      gridTemplateColumns: 'minmax(0, 1fr) 40px minmax(0, 1fr)',
                      alignItems: 'center',
                    }}
                  >
                    <Box
                      sx={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 2,
                        minWidth: 0,
                        py: 2,
                        ...topBorderSx,
                      }}
                    >
                      <Typography variant="subtitle2" sx={{ minWidth: 0 }}>
                        {leftRow.name}
                      </Typography>
                      <TextField
                        label="Порядок"
                        value={leftRow.orderInput}
                        onChange={(event) => reportsSettings.setRowOrderInput(leftRow.id, event.target.value)}
                        type="number"
                        size="small"
                        error={leftInvalid}
                        helperText={leftInvalid ? 'Вкажіть число' : undefined}
                        disabled={!reportsSettings.canEdit || reportsSettings.saveInProgress}
                        slotProps={{ htmlInput: { step: 0.1 } }}
                        sx={{ width: 220, flexShrink: 0 }}
                      />
                    </Box>
                    <Box />
                    {rightRow ? (
                      <Box
                        sx={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          gap: 2,
                          minWidth: 0,
                          py: 2,
                          ...topBorderSx,
                        }}
                      >
                        <Typography variant="subtitle2" sx={{ minWidth: 0 }}>
                          {rightRow.name}
                        </Typography>
                        <TextField
                          label="Порядок"
                          value={rightRow.orderInput}
                          onChange={(event) => reportsSettings.setRowOrderInput(rightRow.id, event.target.value)}
                          type="number"
                          size="small"
                          error={rightInvalid}
                          helperText={rightInvalid ? 'Вкажіть число' : undefined}
                          disabled={!reportsSettings.canEdit || reportsSettings.saveInProgress}
                          slotProps={{ htmlInput: { step: 0.1 } }}
                          sx={{ width: 220, flexShrink: 0 }}
                        />
                      </Box>
                    ) : (
                      <Box />
                    )}
                  </Box>
                );
              })}

              <Box
                sx={{
                  display: { xs: 'grid', md: 'none' },
                  gridTemplateColumns: '1fr',
                  rowGap: 1.5,
                }}
              >
                <Typography variant="body2" color="text.secondary">
                  Смуга
                </Typography>
                {reportsSettings.rows.map((row) => {
                  const invalid = isInvalidOrderInput(row.orderInput);
                  return (
                    <Box
                      key={row.id}
                      sx={{
                        display: 'grid',
                        gridTemplateColumns: '1fr',
                        rowGap: 1,
                        borderTop: 1,
                        borderColor: 'divider',
                        pt: 1.5,
                      }}
                    >
                      <Typography variant="subtitle2">{row.name}</Typography>
                      <TextField
                        label="Порядок"
                        value={row.orderInput}
                        onChange={(event) => reportsSettings.setRowOrderInput(row.id, event.target.value)}
                        type="number"
                        size="small"
                        error={invalid}
                        helperText={invalid ? 'Вкажіть число' : 'Менше значення вище в звіті'}
                        disabled={!reportsSettings.canEdit || reportsSettings.saveInProgress}
                        slotProps={{ htmlInput: { step: 0.1 } }}
                      />
                    </Box>
                  );
                })}
              </Box>

            </Box>

            <Box sx={{ display: 'flex', justifyContent: 'flex-end', pt: 1 }}>
              <PowerButton
                variant="contained"
                onClick={reportsSettings.save}
                disabled={!reportsSettings.canEdit || reportsSettings.hasInvalidRows || !reportsSettings.isDirty || reportsSettings.saveInProgress}
                startIcon={reportsSettings.saveInProgress ? <CircularProgress size={18} /> : undefined}
              >
                зберегти
              </PowerButton>
            </Box>
          </Stack>
        ) : null}
      </Stack>
    </Box>
  );
}
