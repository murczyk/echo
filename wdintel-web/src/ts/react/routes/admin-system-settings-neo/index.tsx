import { Box, ButtonBase, Card, CardContent, CircularProgress, FormControlLabel, Stack, Switch, TextField, Typography } from '@mui/material';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';

import { PageHeader } from '../../components/PageHeader';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import {
  createSystemSettings,
  listSystemSettings,
  type SystemSettingsItem,
} from '../../services/api/system-settings';

type SystemSettingsForm = {
  exactMatchOnlyDefault: boolean;
  dutyTestEnabled: boolean;
  dutyInsertHistoricalInterceptions: boolean;
  dutyTestSinceMs: number;
  dutyTestLimit: number;
  dutyPollIntervalSec: number;
  shortUrlEnabled: boolean;
};

const EMPTY_FORM: SystemSettingsForm = {
  exactMatchOnlyDefault: true,
  dutyTestEnabled: false,
  dutyInsertHistoricalInterceptions: false,
  dutyTestSinceMs: 0,
  dutyTestLimit: 1,
  dutyPollIntervalSec: 1,
  shortUrlEnabled: false,
};

function formFromSettings(item: SystemSettingsItem | undefined): SystemSettingsForm {
  return {
    exactMatchOnlyDefault: item?.rerAnalysisUnitsExactMatchOnlyDefault ?? true,
    dutyTestEnabled: item?.rerDutyTestEnabled ?? false,
    dutyInsertHistoricalInterceptions: item?.rerDutyInsertHistoricalInterceptions ?? false,
    dutyTestSinceMs: item?.rerDutyTestSinceMs ?? 0,
    dutyTestLimit: item?.rerDutyTestLimit ?? 1,
    dutyPollIntervalSec: item?.rerDutyPollIntervalSec ?? 1,
    shortUrlEnabled: item?.rerShortUrlEnabled ?? false,
  };
}

function formsEqual(a: SystemSettingsForm, b: SystemSettingsForm): boolean {
  return (
    a.exactMatchOnlyDefault === b.exactMatchOnlyDefault &&
    a.dutyTestEnabled === b.dutyTestEnabled &&
    a.dutyInsertHistoricalInterceptions === b.dutyInsertHistoricalInterceptions &&
    a.dutyTestSinceMs === b.dutyTestSinceMs &&
    a.dutyTestLimit === b.dutyTestLimit &&
    a.dutyPollIntervalSec === b.dutyPollIntervalSec &&
    a.shortUrlEnabled === b.shortUrlEnabled
  );
}

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
  const [saved, setSaved] = useState<SystemSettingsForm>(EMPTY_FORM);
  const [form, setForm] = useState<SystemSettingsForm>(EMPTY_FORM);
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
        const nextForm = formFromSettings(activeSettings);
        setSaved(nextForm);
        setForm(nextForm);
      } catch (error) {
        setLoadError(
          `Помилка завантаження системних налаштувань: ${formatErrorMessage(error)}`,
        );
      } finally {
        setLoadInProgress(false);
      }
    }

    loadSystemSettings();
  }, []);

  const isDirty = !formsEqual(form, saved);

  function patchForm(patch: Partial<SystemSettingsForm>) {
    setSaveSuccess(null);
    setForm((prev) => ({ ...prev, ...patch }));
  }

  async function handleSaveSystemSettings(event?: FormEvent) {
    event?.preventDefault();
    if (saveInProgress) return;
    if (!isDirty) return;

    setSaveInProgress(true);
    setSaveError(null);
    setSaveSuccess(null);

    try {
      const nextForm: SystemSettingsForm = {
        ...form,
        dutyTestSinceMs: Math.max(0, Math.floor(form.dutyTestSinceMs) || 0),
        dutyTestLimit: Math.max(1, Math.floor(form.dutyTestLimit) || 1),
        dutyPollIntervalSec: Math.max(1, Math.floor(form.dutyPollIntervalSec) || 1),
      };
      await createSystemSettings(
        nextForm.exactMatchOnlyDefault,
        nextForm.dutyTestEnabled,
        nextForm.dutyInsertHistoricalInterceptions,
        nextForm.dutyTestSinceMs,
        nextForm.dutyTestLimit,
        nextForm.dutyPollIntervalSec,
        nextForm.shortUrlEnabled,
      );
      setForm(nextForm);
      setSaved(nextForm);
      setSaveSuccess('Нове системне налаштування збережено.');
    } catch (error) {
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

                {loadError ? <PowerAlert severity="error">{loadError}</PowerAlert> : null}
                {saveError ? <PowerAlert severity="error">{saveError}</PowerAlert> : null}
                {saveSuccess ? (
                  <PowerAlert severity="success" role="status">
                    {saveSuccess}
                  </PowerAlert>
                ) : null}

                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                  <Switch
                    sx={{ m: 0 }}
                    checked={form.exactMatchOnlyDefault}
                    onChange={(_, checked) => {
                      patchForm({ exactMatchOnlyDefault: checked });
                    }}
                  />
                  <ButtonBase
                    component="button"
                    type="button"
                    onClick={() => {
                      patchForm({ exactMatchOnlyDefault: !form.exactMatchOnlyDefault });
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

                <Typography component="h2" variant="subtitle1" sx={{ m: 0, fontWeight: 600 }}>
                  Оперативний: тестові повідомлення
                </Typography>
                <FormControlLabel
                  control={
                    <Switch
                      checked={form.dutyTestEnabled}
                      onChange={(_, checked) => {
                        patchForm({ dutyTestEnabled: checked });
                      }}
                    />
                  }
                  label="Увімкнути тестову вибірку повідомлень"
                />
                <FormControlLabel
                  control={
                    <Switch
                      checked={form.dutyInsertHistoricalInterceptions}
                      onChange={(_, checked) => {
                        patchForm({ dutyInsertHistoricalInterceptions: checked });
                      }}
                    />
                  }
                  label="Вставляти історичні перехоплення"
                />
                <TextField
                  label="Дата старту (timestamp ms)"
                  type="number"
                  value={form.dutyTestSinceMs}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    patchForm({ dutyTestSinceMs: Number.isFinite(next) ? next : 0 });
                  }}
                  inputProps={{ min: 0, step: 1000 }}
                  helperText="Використовується як sinceDateInclusiveMs"
                />
                <TextField
                  label="Ліміт повідомлень"
                  type="number"
                  value={form.dutyTestLimit}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    patchForm({ dutyTestLimit: Number.isFinite(next) ? next : 1 });
                  }}
                  inputProps={{ min: 1, step: 1 }}
                  helperText="Мінімум 1"
                />
                <TextField
                  label="Інтервал запиту нових повідомлень (сек)"
                  type="number"
                  value={form.dutyPollIntervalSec}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    patchForm({ dutyPollIntervalSec: Number.isFinite(next) ? next : 1 });
                  }}
                  inputProps={{ min: 1, step: 1 }}
                  helperText="Як часто перевіряти нові повідомлення"
                />

                <Typography component="h2" variant="subtitle1" sx={{ m: 0, fontWeight: 600 }}>
                  Оперативний: Короткий URL
                </Typography>

                <FormControlLabel
                  control={
                    <Switch
                      checked={form.shortUrlEnabled}
                      onChange={(_, checked) => {
                        patchForm({ shortUrlEnabled: checked });
                      }}
                    />
                  }
                  label="Увімкнути которкий URL для оперативного"
                />

                <Box sx={{ display: 'flex', justifyContent: 'flex-end', pt: 1 }}>
                  <PowerButton
                    variant="contained"
                    type="submit"
                    disabled={saveInProgress || loadInProgress || !isDirty}
                    startIcon={saveInProgress ? <CircularProgress size={18} /> : undefined}
                  >
                    зберегти
                  </PowerButton>
                </Box>
              </Stack>
            </Box>
          </CardContent>
        </Card>
      </Stack>
    </Box>
  );
}
