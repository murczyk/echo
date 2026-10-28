import SaveIcon from '@mui/icons-material/Save';
import {
  Card,
  CardContent,
  Checkbox,
  CircularProgress,
  FormControlLabel,
  Stack,
  Typography,
} from '@mui/material';
import { useEffect, useState } from 'react';

import type { AiCallsignEngineItem, AiCallsignWorkerSettingsItem } from '../../../../Bindings';
import { AiWorkerEngineSelect } from '../../components/AiWorkerEngineSelect';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { saveAiCallsignWorkerSettings } from '../../services/api/ai-callsigns';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function AiCallsignWorkerSettings({
  engines,
  settings,
  onSaved,
}: {
  engines: AiCallsignEngineItem[];
  settings: AiCallsignWorkerSettingsItem;
  onSaved: (settings: AiCallsignWorkerSettingsItem) => void;
}) {
  const [enabled, setEnabled] = useState(settings.enabled);
  const [aiEngineId, setAiEngineId] = useState(settings.aiEngineId ?? '');
  const [fallbackAiEngineId, setFallbackAiEngineId] = useState(settings.fallbackAiEngineId ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { notify } = usePowerSnackbar();

  useEffect(() => {
    setEnabled(settings.enabled);
    setAiEngineId(settings.aiEngineId ?? '');
    setFallbackAiEngineId(settings.fallbackAiEngineId ?? '');
  }, [settings]);

  async function save() {
    if (enabled && !aiEngineId) {
      setError('Оберіть ШІ движок для воркера.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = await saveAiCallsignWorkerSettings({
        enabled,
        aiEngineId: aiEngineId || null,
        fallbackAiEngineId: fallbackAiEngineId || null,
      });
      onSaved(saved);
      notify({ severity: 'success', message: 'Налаштування воркера збережено.' });
    } catch (saveError) {
      setError(`Помилка збереження воркера: ${errorMessage(saveError)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card variant="outlined" sx={{ borderRadius: 0, boxShadow: 'none' }}>
      <CardContent sx={{ p: 3, '&:last-child': { pb: 3 } }}>
        <Stack spacing={2.5}>
          <Stack spacing={0.5}>
            <Typography component="h2" variant="h6">
              Воркер
            </Typography>
            <Typography color="text.secondary" variant="body2">
              Після звичайного парсингу inbox-повідомлення воркер послідовно запускає ШІ-пошук
              позивних.
            </Typography>
          </Stack>

          {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}
          {engines.length === 0 ? (
            <PowerAlert severity="warning">
              Немає увімкнених ШІ движків. Увімкніть хоча б один у налаштуваннях системи.
            </PowerAlert>
          ) : null}

          <FormControlLabel
            control={
              <Checkbox
                checked={enabled}
                onChange={(_, checked) => setEnabled(checked)}
                disabled={saving}
              />
            }
            label="Воркер що парсить позивні через ШІ"
          />

          <AiWorkerEngineSelect
            engines={engines}
            primaryId={aiEngineId}
            fallbackId={fallbackAiEngineId}
            required={enabled}
            disabled={saving}
            onChange={(primaryId, fallbackId) => {
              setAiEngineId(primaryId);
              setFallbackAiEngineId(fallbackId);
            }}
          />

          <PowerButton
            type="button"
            variant="contained"
            disabled={saving || (enabled && !aiEngineId)}
            onClick={() => void save()}
            startIcon={saving ? <CircularProgress size={18} /> : <SaveIcon />}
            sx={{ alignSelf: 'flex-start' }}
          >
            Зберегти
          </PowerButton>
        </Stack>
      </CardContent>
    </Card>
  );
}
