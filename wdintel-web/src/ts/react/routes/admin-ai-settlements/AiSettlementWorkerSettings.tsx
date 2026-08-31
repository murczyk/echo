import SaveIcon from '@mui/icons-material/Save';
import {
  Card,
  CardContent,
  Checkbox,
  CircularProgress,
  FormControlLabel,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useEffect, useState } from 'react';

import type { AiSettlementEngineItem, AiSettlementWorkerSettingsItem } from '../../../../Bindings';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { saveAiSettlementWorkerSettings } from '../../services/api/ai-settlements';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function AiSettlementWorkerSettings({
  engines,
  settings,
  onSaved,
}: {
  engines: AiSettlementEngineItem[];
  settings: AiSettlementWorkerSettingsItem;
  onSaved: (settings: AiSettlementWorkerSettingsItem) => void;
}) {
  const [enabled, setEnabled] = useState(settings.enabled);
  const [aiEngineId, setAiEngineId] = useState(settings.aiEngineId ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { notify } = usePowerSnackbar();

  useEffect(() => {
    setEnabled(settings.enabled);
    setAiEngineId(settings.aiEngineId ?? '');
  }, [settings]);

  async function save() {
    if (enabled && !aiEngineId) {
      setError('Оберіть ШІ движок для воркера.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = await saveAiSettlementWorkerSettings({
        enabled,
        aiEngineId: aiEngineId || null,
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
              Після звичайного парсингу inbox-повідомлення воркер запускає ШІ-пошук населених
              пунктів, додає лише відсутні значення в location_v2 і не видаляє наявні.
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
            label="Воркер, що парсить населені пункти через ШІ"
          />

          <TextField
            select
            fullWidth
            required={enabled}
            disabled={saving || engines.length === 0}
            label="ШІ движок"
            value={aiEngineId}
            onChange={(event) => setAiEngineId(event.target.value)}
          >
            <MenuItem value="">
              <em>Не вибрано</em>
            </MenuItem>
            {engines.map((engine) => (
              <MenuItem key={engine.id} value={engine.id}>
                {engine.name} · {engine.modelName}
              </MenuItem>
            ))}
          </TextField>

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
