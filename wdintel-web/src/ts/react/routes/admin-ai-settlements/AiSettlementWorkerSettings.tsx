import SaveIcon from '@mui/icons-material/Save';
import {
  Card,
  CardContent,
  Checkbox,
  CircularProgress,
  FormControlLabel,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { useEffect, useState } from 'react';

import type {
  AiSettlementEngineItem,
  AiSettlementGroupItem,
  AiSettlementWorkerSettingsItem,
} from '../../../../Bindings';
import { AiWorkerEngineSelect } from '../../components/AiWorkerEngineSelect';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerAutocomplete } from '../../components/PowerAutocomplete';
import { PowerButton } from '../../components/PowerButton';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { saveAiSettlementWorkerSettings } from '../../services/api/ai-settlements';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function AiSettlementWorkerSettings({
  engines,
  groups,
  settings,
  onSaved,
}: {
  engines: AiSettlementEngineItem[];
  groups: AiSettlementGroupItem[];
  settings: AiSettlementWorkerSettingsItem;
  onSaved: (settings: AiSettlementWorkerSettingsItem) => void;
}) {
  const [enabled, setEnabled] = useState(settings.enabled);
  const [aiEngineId, setAiEngineId] = useState(settings.aiEngineId ?? '');
  const [fallbackAiEngineId, setFallbackAiEngineId] = useState(settings.fallbackAiEngineId ?? '');
  const [groupsExcept, setGroupsExcept] = useState(settings.groupsExcept);
  const [groupMasterKeys, setGroupMasterKeys] = useState(settings.groupMasterKeys);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { notify } = usePowerSnackbar();

  useEffect(() => {
    setEnabled(settings.enabled);
    setAiEngineId(settings.aiEngineId ?? '');
    setFallbackAiEngineId(settings.fallbackAiEngineId ?? '');
    setGroupsExcept(settings.groupsExcept);
    setGroupMasterKeys(settings.groupMasterKeys);
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
        fallbackAiEngineId: fallbackAiEngineId || null,
        groupsExcept,
        groupMasterKeys,
      });
      onSaved(saved);
      notify({ severity: 'success', message: 'Налаштування воркера збережено.' });
    } catch (saveError) {
      const message = `Помилка збереження воркера: ${errorMessage(saveError)}`;
      setError(message);
      notify({ severity: 'error', message });
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
              пунктів і замінює ними розпізнані локації повідомлення. Якщо ШІ не знайшов населених
              пунктів, попередні локації видаляються. Локації, збережені вручну, не змінюються
              воркером.
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

          <section className="flex flex-col gap-echo-md" aria-labelledby="settlement-worker-groups">
            <Typography component="h3" variant="h6" id="settlement-worker-groups">
              Групи для обробки
            </Typography>
            <ToggleButtonGroup
              exclusive
              value={groupsExcept ? 'except' : 'only'}
              disabled={saving}
              aria-label="Режим обробки груп"
              onChange={(_, value: string | null) => {
                if (value !== null) setGroupsExcept(value === 'except');
              }}
            >
              <ToggleButton value="only">Лише</ToggleButton>
              <ToggleButton value="except">Окрім</ToggleButton>
            </ToggleButtonGroup>
            <PowerAutocomplete
              options={groups}
              value={groupMasterKeys.map(
                (masterKey) =>
                  groups.find((group) => group.masterKey === masterKey) ?? {
                    masterKey,
                    name: `Недоступна група (${masterKey})`,
                  },
              )}
              disabled={saving}
              disableCloseOnSelect
              getOptionLabel={(group) => group.name || group.masterKey}
              getOptionKey={(group) => group.masterKey}
              isOptionEqualToValue={(group, selected) => group.masterKey === selected.masterKey}
              onChange={(_, selected) =>
                setGroupMasterKeys(selected.map((group) => group.masterKey))
              }
              noOptionsText="Немає активних груп"
              clearText="Очистити"
              openText="Відкрити"
              closeText="Закрити"
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="Групи"
                  helperText="Без вибраних груп — без обмежень. Лише — обробляти вибрані; Окрім — пропускати вибрані."
                />
              )}
            />
            <Typography color="text.secondary" variant="body2">
              Збереження налаштувань перезапускає воркер із новими обмеженнями.
            </Typography>
          </section>

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
