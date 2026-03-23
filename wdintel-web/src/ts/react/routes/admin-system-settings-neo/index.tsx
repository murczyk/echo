import SaveIcon from '@mui/icons-material/Save';
import {
  Alert,
  Box,
  Card,
  CardContent,
  CircularProgress,
  FormControlLabel,
  Stack,
  Switch,
  Typography,
} from '@mui/material';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';

import { PageHeader } from '../../components/PageHeader';
import { Button } from '../../components/mui-customized/button';
import { isUnauthorizedError } from '../../services/api/client';
import {
  createSystemSettings,
  listSystemSettings,
} from '../../services/api/system-settings';

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim().length > 0) {
    return error;
  }
  return 'Невідома помилка. Спробуйте ще раз.';
}

export function AdminSystemSettingsNeoPage() {
  const [draftExactMatchOnlyDefault, setDraftExactMatchOnlyDefault] =
    useState(true);
  const [loadInProgress, setLoadInProgress] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [saveInProgress, setSaveInProgress] = useState(false);

  useEffect(() => {
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

  async function handleSaveSystemSettings(event?: FormEvent) {
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
    <Box className="w-full" sx={{ height: '100%', minHeight: 0, overflow: 'auto' }}>
      <Stack spacing={3} useFlexGap sx={{ minHeight: '100%' }}>
        <PageHeader title="Налаштування системи" className="px-4" />

        <Card variant="outlined">
          <CardContent sx={{ p: 3, '&:last-child': { pb: 3 } }}>
            <Box component="form" onSubmit={handleSaveSystemSettings} noValidate>
              <Stack spacing={3}>
                <Typography component="h2" variant="h6" sx={{ m: 0, fontWeight: 600 }}>
                  Активне значення за замовчуванням
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
      </Stack>
    </Box>
  );
}
