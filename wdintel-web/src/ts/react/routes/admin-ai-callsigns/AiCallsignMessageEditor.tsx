import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import SaveIcon from '@mui/icons-material/Save';
import { Box, CircularProgress, Stack, TextField, Typography } from '@mui/material';
import { useState } from 'react';

import type { AiCallsignTestMessageItem } from '../../../../Bindings';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import {
  createAiCallsignTestMessage,
  updateAiCallsignTestMessage,
} from '../../services/api/ai-callsigns';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function AiCallsignMessageEditor({
  message,
  onBack,
  onSaved,
}: {
  message?: AiCallsignTestMessageItem;
  onBack: () => void;
  onSaved: (message: AiCallsignTestMessageItem) => void;
}) {
  const [value, setValue] = useState(message?.message ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isEdit = message !== undefined;

  async function handleSave() {
    const nextValue = value.trim();
    if (!nextValue) {
      setError('Вкажіть текст тестового повідомлення.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = isEdit
        ? await updateAiCallsignTestMessage({ id: message.id, message: nextValue })
        : await createAiCallsignTestMessage({ message: nextValue });
      onSaved(saved);
    } catch (saveError) {
      setError(`Помилка збереження повідомлення: ${errorMessage(saveError)}`);
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
          {isEdit ? 'Редагувати тестове повідомлення' : 'Нове тестове повідомлення'}
        </Typography>
      </Box>

      {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}

      <TextField
        fullWidth
        disabled
        label="ID"
        value={message?.id ?? ''}
        helperText={isEdit ? 'UUIDv7' : 'UUIDv7 буде створено автоматично'}
      />
      <TextField
        fullWidth
        required
        multiline
        minRows={8}
        label="Текст повідомлення"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />

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
