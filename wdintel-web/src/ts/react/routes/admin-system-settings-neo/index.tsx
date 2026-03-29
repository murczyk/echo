import {
  Alert,
  Box,
  ButtonBase,
  Card,
  CardContent,
  CircularProgress,
  FormControlLabel,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import React from 'react';

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
    React.useState(true);
  const [initialExactMatchOnlyDefault, setInitialExactMatchOnlyDefault] =
    React.useState(true);
  const [draftDutyTestEnabled, setDraftDutyTestEnabled] = React.useState(false);
  const [draftDutyTestSinceMs, setDraftDutyTestSinceMs] = React.useState(0);
  const [draftDutyTestLimit, setDraftDutyTestLimit] = React.useState(1);
  const [draftDutyPollIntervalSec, setDraftDutyPollIntervalSec] = React.useState(1);
  const [initialDutyTestEnabled, setInitialDutyTestEnabled] = React.useState(false);
  const [initialDutyTestSinceMs, setInitialDutyTestSinceMs] = React.useState(0);
  const [initialDutyTestLimit, setInitialDutyTestLimit] = React.useState(1);
  const [initialDutyPollIntervalSec, setInitialDutyPollIntervalSec] = React.useState(1);
  const [loadInProgress, setLoadInProgress] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = React.useState<string | null>(null);
  const [saveInProgress, setSaveInProgress] = React.useState(false);

  React.useEffect(() => {
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
        setDraftDutyTestEnabled(activeSettings?.rerDutyTestEnabled ?? false);
        setDraftDutyTestSinceMs(activeSettings?.rerDutyTestSinceMs ?? 0);
        setDraftDutyTestLimit(activeSettings?.rerDutyTestLimit ?? 1);
        setDraftDutyPollIntervalSec(activeSettings?.rerDutyPollIntervalSec ?? 1);
        setInitialDutyTestEnabled(activeSettings?.rerDutyTestEnabled ?? false);
        setInitialDutyTestSinceMs(activeSettings?.rerDutyTestSinceMs ?? 0);
        setInitialDutyTestLimit(activeSettings?.rerDutyTestLimit ?? 1);
        setInitialDutyPollIntervalSec(activeSettings?.rerDutyPollIntervalSec ?? 1);
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
    draftExactMatchOnlyDefault !== initialExactMatchOnlyDefault ||
    draftDutyTestEnabled !== initialDutyTestEnabled ||
    draftDutyTestSinceMs !== initialDutyTestSinceMs ||
    draftDutyTestLimit !== initialDutyTestLimit ||
    draftDutyPollIntervalSec !== initialDutyPollIntervalSec;

  function handleExactMatchOnlyChange(checked: boolean) {
    setSaveSuccess(null);
    setDraftExactMatchOnlyDefault(checked);
  }

  async function handleSaveSystemSettings(event?: React.FormEvent) {
    event?.preventDefault();
    if (saveInProgress) return;
    if (!isDirty) return;

    setSaveInProgress(true);
    setSaveError(null);
    setSaveSuccess(null);

    try {
      const testSinceMs = Math.max(0, Math.floor(draftDutyTestSinceMs) || 0);
      const testLimit = Math.max(1, Math.floor(draftDutyTestLimit) || 1);
      const pollIntervalSec = Math.max(1, Math.floor(draftDutyPollIntervalSec) || 1);
      await createSystemSettings(
        draftExactMatchOnlyDefault,
        draftDutyTestEnabled,
        testSinceMs,
        testLimit,
        pollIntervalSec,
      );
      setDraftDutyTestSinceMs(testSinceMs);
      setDraftDutyTestLimit(testLimit);
      setDraftDutyPollIntervalSec(pollIntervalSec);
      setInitialExactMatchOnlyDefault(draftExactMatchOnlyDefault);
      setInitialDutyTestEnabled(draftDutyTestEnabled);
      setInitialDutyTestSinceMs(testSinceMs);
      setInitialDutyTestLimit(testLimit);
      setInitialDutyPollIntervalSec(pollIntervalSec);
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

                <Typography component="h2" variant="h6" sx={{ m: 0, fontWeight: 600 }}>
                  Оперативний: тестові повідомлення
                </Typography>
                <FormControlLabel
                  control={
                    <Switch
                      checked={draftDutyTestEnabled}
                      onChange={(_, checked) => {
                        setSaveSuccess(null);
                        setDraftDutyTestEnabled(checked);
                      }}
                    />
                  }
                  label="Увімкнути тестову вибірку повідомлень"
                />
                <TextField
                  label="Дата старту (timestamp ms)"
                  type="number"
                  value={draftDutyTestSinceMs}
                  onChange={(event) => {
                    setSaveSuccess(null);
                    const next = Number(event.target.value);
                    setDraftDutyTestSinceMs(Number.isFinite(next) ? next : 0);
                  }}
                  inputProps={{ min: 0, step: 1000 }}
                  helperText="Використовується як sinceDateInclusiveMs"
                />
                <TextField
                  label="Ліміт повідомлень"
                  type="number"
                  value={draftDutyTestLimit}
                  onChange={(event) => {
                    setSaveSuccess(null);
                    const next = Number(event.target.value);
                    setDraftDutyTestLimit(Number.isFinite(next) ? next : 1);
                  }}
                  inputProps={{ min: 1, step: 1 }}
                  helperText="Мінімум 1"
                />
                <TextField
                  label="Інтервал запиту нових повідомлень (сек)"
                  type="number"
                  value={draftDutyPollIntervalSec}
                  onChange={(event) => {
                    setSaveSuccess(null);
                    const next = Number(event.target.value);
                    setDraftDutyPollIntervalSec(Number.isFinite(next) ? next : 1);
                  }}
                  inputProps={{ min: 1, step: 1 }}
                  helperText="Як часто перевіряти нові повідомлення"
                />

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
