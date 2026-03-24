import {
  Alert,
  Box,
  ButtonBase,
  Card,
  CardContent,
  CircularProgress,
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
  const [initialExactMatchOnlyDefault, setInitialExactMatchOnlyDefault] =
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
        const nextValue =
          activeSettings?.rerAnalysisUnitsExactMatchOnlyDefault ?? true;
        setDraftExactMatchOnlyDefault(nextValue);
        setInitialExactMatchOnlyDefault(nextValue);
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

  const isDirty =
    draftExactMatchOnlyDefault !== initialExactMatchOnlyDefault;

  function handleExactMatchOnlyChange(checked: boolean) {
    setSaveSuccess(null);
    setDraftExactMatchOnlyDefault(checked);
  }

  async function handleSaveSystemSettings(event?: FormEvent) {
    event?.preventDefault();
    if (saveInProgress) return;
    if (!isDirty) return;

    setSaveInProgress(true);
    setSaveError(null);
    setSaveSuccess(null);

    try {
      await createSystemSettings(draftExactMatchOnlyDefault);
      setInitialExactMatchOnlyDefault(draftExactMatchOnlyDefault);
      setSaveSuccess('Нове системне налаштування збережено');
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
    <Box className="w-full" sx={{ maxWidth: 980, mx: "auto" }}>
      <Stack spacing={2} useFlexGap>
        <PageHeader title="Налаштування системи" />

        <Card variant="outlined" sx={{ borderRadius: 0, boxShadow: 'none' }}>
          <CardContent sx={{ p: 3, '&:last-child': { pb: 3 } }}>
            <Box component="form" onSubmit={handleSaveSystemSettings} noValidate>
              <Stack spacing={3} sx={{ width: '100%' }}>
                <Typography component="h2" variant="subtitle1" sx={{ m: 0, fontWeight: 600 }}>
                  Активні значення за замовчуванням
                </Typography>

                {loadError ? <Alert severity="error">{loadError}</Alert> : null}
                {saveError ? <Alert severity="error">{saveError}</Alert> : null}
                {saveSuccess ? (
                  <Alert severity="success" role="status">
                    {saveSuccess}
                  </Alert>
                ) : null}

                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                  <Switch
                    sx={{ m: 0 }}
                    checked={draftExactMatchOnlyDefault}
                    onChange={(_, checked) => {
                      handleExactMatchOnlyChange(checked);
                    }}
                  />
                  <ButtonBase
                    component="button"
                    type="button"
                    onClick={() => {
                      handleExactMatchOnlyChange(!draftExactMatchOnlyDefault);
                    }}
                    sx={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      textAlign: 'left',
                      borderRadius: 0.5,
                      typography: 'body1',
                      fontWeight: 400,
                      color: 'text.primary',
                    }}
                  >
                    Прапорець «точний збіг за еталонкою» на аналізі увімкнений
                  </ButtonBase>
                </Box>

                <Box sx={{ display: 'flex', justifyContent: 'flex-end', pt: 1 }}>
                  <Button
                    variant="contained"
                    type="submit"
                    disabled={saveInProgress || loadInProgress || !isDirty}
                    startIcon={saveInProgress ? <CircularProgress size={18} /> : undefined}
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
