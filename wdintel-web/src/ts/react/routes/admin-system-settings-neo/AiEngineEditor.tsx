import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import SaveIcon from '@mui/icons-material/Save';
import {
  Box,
  CircularProgress,
  FormControlLabel,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { useState } from 'react';

import type { AiEngineItem } from '../../../../Bindings';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { createAiEngine, updateAiEngine } from '../../services/api/ai-engines';

type AiEngineForm = {
  name: string;
  url: string;
  modelName: string;
  token: string;
  clearToken: boolean;
  enabled: boolean;
};

const EMPTY_FORM: AiEngineForm = {
  name: '',
  url: 'https://api.openai.com/v1',
  modelName: '',
  token: '',
  clearToken: false,
  enabled: true,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function initialForm(aiEngine?: AiEngineItem): AiEngineForm {
  if (!aiEngine) return EMPTY_FORM;
  return {
    name: aiEngine.name,
    url: aiEngine.url,
    modelName: aiEngine.modelName,
    token: '',
    clearToken: false,
    enabled: aiEngine.enabled,
  };
}

function validate(form: AiEngineForm): string | null {
  if (!form.name.trim()) return 'Вкажіть назву ШІ движка.';
  if (!form.url.trim()) return 'Вкажіть URL OpenAI-сумісного API.';
  if (!form.modelName.trim()) return 'Вкажіть назву моделі.';
  try {
    const url = new URL(form.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return 'URL повинен використовувати http або https.';
    }
  } catch {
    return 'Вкажіть коректний URL.';
  }
  return null;
}

export function AiEngineEditor({
  aiEngine,
  onBack,
  onSaved,
}: {
  aiEngine?: AiEngineItem;
  onBack: () => void;
  onSaved: (aiEngine: AiEngineItem) => void;
}) {
  const [form, setForm] = useState(() => initialForm(aiEngine));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isEdit = aiEngine !== undefined;

  function patchForm(patch: Partial<AiEngineForm>) {
    setForm((current) => ({ ...current, ...patch }));
  }

  async function handleSave() {
    const validationError = validate(form);
    if (validationError) {
      setError(validationError);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const token = form.token.trim() || null;
      const saved = isEdit
        ? await updateAiEngine({
            id: aiEngine.id,
            name: form.name.trim(),
            url: form.url.trim(),
            modelName: form.modelName.trim(),
            token,
            clearToken: form.clearToken,
            enabled: form.enabled,
          })
        : await createAiEngine({
            name: form.name.trim(),
            url: form.url.trim(),
            modelName: form.modelName.trim(),
            token,
            enabled: form.enabled,
          });
      onSaved(saved);
    } catch (saveError) {
      setError(`Помилка збереження: ${errorMessage(saveError)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Stack spacing={3}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
        <PowerButton
          type="button"
          variant="outlined"
          onClick={onBack}
          startIcon={<ArrowBackIcon />}
        >
          Назад
        </PowerButton>
        <Typography variant="h6" component="h2">
          {isEdit ? 'Редагувати ШІ движок' : 'Новий ШІ движок'}
        </Typography>
      </Box>

      {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}

      <Box
        sx={{
          display: 'grid',
          gap: 2,
          gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
        }}
      >
        <TextField
          fullWidth
          disabled
          label="ID"
          value={aiEngine?.id ?? ''}
          helperText={isEdit ? 'UUIDv7' : 'UUIDv7 буде створено автоматично'}
        />
        <TextField
          fullWidth
          required
          label="Назва"
          value={form.name}
          onChange={(event) => patchForm({ name: event.target.value })}
        />
        <TextField
          fullWidth
          required
          label="Base URL"
          value={form.url}
          onChange={(event) => patchForm({ url: event.target.value })}
          helperText="Наприклад, https://api.openai.com/v1 або http://spark:8000/v1"
        />
        <TextField
          fullWidth
          required
          label="Модель"
          value={form.modelName}
          onChange={(event) => patchForm({ modelName: event.target.value })}
          helperText="Ідентифікатор моделі OpenAI або ім’я моделі vLLM"
        />
        <FormControlLabel
          control={
            <Switch
              checked={form.enabled}
              onChange={(_, checked) => patchForm({ enabled: checked })}
            />
          }
          label="Увімкнений"
        />
        <TextField
          fullWidth
          label="Токен"
          type="password"
          value={form.token}
          disabled={form.clearToken}
          onChange={(event) => patchForm({ token: event.target.value })}
          helperText={
            isEdit && aiEngine.hasToken
              ? 'Залиште порожнім, щоб зберегти чинний токен'
              : 'Можна залишити порожнім для vLLM без автентифікації'
          }
        />
        {isEdit && aiEngine.hasToken ? (
          <FormControlLabel
            control={
              <Switch
                checked={form.clearToken}
                onChange={(_, checked) => patchForm({ clearToken: checked, token: '' })}
              />
            }
            label="Очистити збережений токен"
          />
        ) : null}
      </Box>

      <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
        <PowerButton
          type="button"
          variant="contained"
          disabled={saving}
          onClick={() => void handleSave()}
          startIcon={saving ? <CircularProgress size={18} /> : <SaveIcon />}
        >
          Зберегти
        </PowerButton>
      </Box>
    </Stack>
  );
}
