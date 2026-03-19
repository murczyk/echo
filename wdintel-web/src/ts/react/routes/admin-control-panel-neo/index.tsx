import SaveIcon from '@mui/icons-material/Save';
import {
  Alert,
  Box,
  Card,
  CardContent,
  Checkbox,
  CircularProgress,
  FormControlLabel,
  FormGroup,
  Stack,
  Switch,
  Typography,
} from '@mui/material';
import React from 'react';

import { Info } from '../../components/info';
import { PageHeader } from '../../components/PageHeader';
import { Button } from '../../components/mui-customized/button';
import { useBoolean } from '../../hooks/use-boolean';
import { restartEcho, RestartEchoPayload } from '../../services/api/admin';
import { isUnauthorizedError } from '../../services/api/client';
import {
  createSystemSettings,
  listSystemSettings,
} from '../../services/api/system-settings';

type RestartEchoForm = {
  restartPostgres: boolean;
  restartOutdatedSources: boolean;
};

type StatusState = {
  kind: 'success' | 'error';
  message: string;
} | null;

const initialForm: RestartEchoForm = {
  restartPostgres: false,
  restartOutdatedSources: false,
};

function buildRestartEchoPayload(form: RestartEchoForm): RestartEchoPayload {
  return {
    restartPostgres: form.restartPostgres,
    restartOutdatedSources: form.restartOutdatedSources,
  };
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return 'Невідома помилка. Спробуйте ще раз.';
}

export function AdminControlPanelNeoPage() {
  const [form, setForm] = React.useState<RestartEchoForm>(initialForm);
  const restarting = useBoolean(false);
  const [status, setStatus] = React.useState<StatusState>(null);
  const [draftExactMatchOnlyDefault, setDraftExactMatchOnlyDefault] =
    React.useState(true);
  const [loadInProgress, setLoadInProgress] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = React.useState<string | null>(null);
  const [saveInProgress, setSaveInProgress] = React.useState(false);

  function handleToggleRestartPostgres(event: React.ChangeEvent<HTMLInputElement>) {
    setForm((prev) => ({
      ...prev,
      restartPostgres: event.target.checked,
    }));
  }

  function handleToggleRestartOutdatedSources(event: React.ChangeEvent<HTMLInputElement>) {
    setForm((prev) => ({
      ...prev,
      restartOutdatedSources: event.target.checked,
    }));
  }

  function clearStatus() {
    setStatus(null);
  }

  React.useEffect(() => {
    async function loadSystemSettings() {
      setLoadInProgress(true);
      setLoadError(null);

      try {
        const settings = await listSystemSettings();
        const activeSettings = settings.find((item) => !item.deleted);
        setDraftExactMatchOnlyDefault(
          activeSettings?.rerAnalysisUnitsExactMatchOnlyDefault ?? true,
        );
      } catch (error) {
        if (isUnauthorizedError(error)) {
          window.location.assign('/login');
          return;
        }
        setLoadError(
          `Помилка завантаження системних налаштувань: ${formatErrorMessage(error)}`,
        );
      } finally {
        setLoadInProgress(false);
      }
    }

    loadSystemSettings();
  }, []);

  async function handleRestart() {
    if (restarting.value) return;

    clearStatus();
    restarting.setTrue();

    try {
      await restartEcho(buildRestartEchoPayload(form));
      setStatus({
        kind: 'success',
        message: 'Запит на перезапуск надіслано.',
      });
    } catch (error) {
      setStatus({
        kind: 'error',
        message: `Помилка перезапуску: ${formatErrorMessage(error)}`,
      });
    } finally {
      restarting.setFalse();
    }
  }

  async function handleSaveSystemSettings(event?: React.FormEvent) {
    event?.preventDefault();
    if (saveInProgress) return;

    setSaveInProgress(true);
    setSaveError(null);
    setSaveSuccess(null);

    try {
      await createSystemSettings(draftExactMatchOnlyDefault);
      setSaveSuccess('Нове системне налаштування збережено.');
    } catch (error) {
      if (isUnauthorizedError(error)) {
        window.location.assign('/login');
        return;
      }
      setSaveError(`Помилка збереження: ${formatErrorMessage(error)}`);
    } finally {
      setSaveInProgress(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Панель керування" />
      <Card variant="outlined">
        <CardContent sx={{ p: 3, '&:last-child': { pb: 3 } }}>
          <div className="space-y-5">
            <Typography variant="h6" component="h3" className="!text-lg !font-semibold mb-3">
              Натисність щоби перезапустити Ехо Сервер
            </Typography>
            <FormGroup>
              <FormControlLabel
                disableTypography
                control={<Checkbox checked={form.restartPostgres} onChange={handleToggleRestartPostgres} />}
                label={
                  <span style={{ color: 'var(--bs-secondary-color)' }}>Перезапустити PostgreSQL (база даних)</span>
                }
              />
              <FormControlLabel
                disableTypography
                control={<Checkbox checked={form.restartOutdatedSources} onChange={handleToggleRestartOutdatedSources} />}
                label={<span style={{ color: 'var(--bs-secondary-color)' }}>Перезапустити месенджери що відстали</span>}
              />
            </FormGroup>
            <div className="flex items-center gap-2">
              <Button variant="contained" color="error" disabled={restarting.value} onClick={handleRestart}>
                Перезапустити
              </Button>
              {restarting.value ? <CircularProgress size={18} /> : null}
            </div>
            {status?.kind === 'error' ? <Info text={status.message} color="error" /> : null}
            {status?.kind === 'success' ? (
              <p className="text-sm" style={{ color: 'var(--bs-success)' }} role="status">
                {status.message}
              </p>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card variant="outlined">
        <CardContent sx={{ p: 3, '&:last-child': { pb: 3 } }}>
          <Box component="form" onSubmit={handleSaveSystemSettings} noValidate>
            <Stack spacing={3}>
              <Typography component="h3" variant="h6" sx={{ m: 0, fontWeight: 600 }}>
                Налаштування системи
              </Typography>

              {loadError ? <Alert severity="error">{loadError}</Alert> : null}
              {saveError ? <Alert severity="error">{saveError}</Alert> : null}
              {saveSuccess ? (
                <Alert severity="success" role="status">
                  {saveSuccess}
                </Alert>
              ) : null}

              <FormControlLabel
                control={
                  <Switch
                    checked={draftExactMatchOnlyDefault}
                    onChange={(_, checked) => {
                      setSaveSuccess(null);
                      setDraftExactMatchOnlyDefault(checked);
                    }}
                  />
                }
                label="За замовчуванням на /rer-analysis чекбокс `точний збіг за еталонкою` увімкнений"
              />

              <Box className="flex items-center justify-end">
                <Button
                  variant="contained"
                  type="submit"
                  disabled={saveInProgress || loadInProgress}
                  startIcon={
                    saveInProgress ? (
                      <CircularProgress size={18} />
                    ) : (
                      <SaveIcon fontSize="small" />
                    )
                  }
                >
                  зберегти
                </Button>
              </Box>
            </Stack>
          </Box>
        </CardContent>
      </Card>
    </div>
  );
}
