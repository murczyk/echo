import {
  Card,
  CardContent,
  Checkbox,
  CircularProgress,
  FormControlLabel,
  FormGroup,
  Typography,
} from '@mui/material';
import { useState } from 'react';
import type { ChangeEvent } from 'react';

import { Info } from '../../components/info';
import { PageHeader } from '../../components/PageHeader';
import { PowerButton } from '../../components/PowerButton';
import { useBoolean } from '../../hooks/use-boolean';
import { restartEcho, RestartEchoPayload } from '../../services/api/admin';

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
  const [form, setForm] = useState<RestartEchoForm>(initialForm);
  const restarting = useBoolean(false);
  const [status, setStatus] = useState<StatusState>(null);

  function handleToggleRestartPostgres(event: ChangeEvent<HTMLInputElement>) {
    setForm((prev) => ({
      ...prev,
      restartPostgres: event.target.checked,
    }));
  }

  function handleToggleRestartOutdatedSources(event: ChangeEvent<HTMLInputElement>) {
    setForm((prev) => ({
      ...prev,
      restartOutdatedSources: event.target.checked,
    }));
  }

  function clearStatus() {
    setStatus(null);
  }

  async function handleRestart() {
    if (restarting.value) return;

    clearStatus();
    restarting.setTrue();

    try {
      await restartEcho(buildRestartEchoPayload(form));
      setStatus({
        kind: 'success',
        message: 'Запит на перезапуск надіслано',
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

  return (
    <div className="space-y-6">
      <PageHeader title="Панель керування" />
      <Card variant="outlined">
        <CardContent sx={{ p: 3, '&:last-child': { pb: 3 } }}>
          <div className="space-y-5">
            <Typography variant="h6" component="h3" className="!text-lg !font-semibold mb-3">
              Натисніть, щоб перезапустити ЕХО Сервер
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
              <PowerButton variant="contained" color="error" disabled={restarting.value} onClick={handleRestart}>
                Перезапустити
              </PowerButton>
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
    </div>
  );
}
