import { FormControlLabel, Stack, Switch, TextField, Typography } from '@mui/material';
import { useEffect, useState } from 'react';

import type { AiEngineItem } from '../../../../Bindings';
import { PowerButton } from '../../components/PowerButton';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { updateAiEngineHealth } from '../../services/api/ai-engines';
import { errorMessage, formatDateTime } from './format';

const HEALTH_MESSAGE_MAX_CHARS = 500;

/**
 * Marks an engine unhealthy for chat users with a message (#4112). Saved on its own,
 * apart from the settings form, so it can be flipped quickly during an outage.
 */
export function ProviderHealthEditor({
  engine,
  onSaved,
}: {
  engine: AiEngineItem;
  onSaved: (engine: AiEngineItem) => void;
}) {
  const savedUnhealthy = engine.unhealthy ?? false;
  const savedMessage = engine.healthMessage ?? '';
  const [unhealthy, setUnhealthy] = useState(savedUnhealthy);
  const [message, setMessage] = useState(savedMessage);
  const [saving, setSaving] = useState(false);
  const { notify } = usePowerSnackbar();

  useEffect(() => {
    setUnhealthy(savedUnhealthy);
    setMessage(savedMessage);
  }, [savedUnhealthy, savedMessage]);

  const changed =
    unhealthy !== savedUnhealthy || (unhealthy && message.trim() !== savedMessage.trim());

  async function save() {
    setSaving(true);
    try {
      const updated = await updateAiEngineHealth({
        id: engine.id,
        unhealthy,
        message: unhealthy ? message : null,
      });
      onSaved(updated);
      notify({
        severity: 'success',
        message: updated.unhealthy
          ? `${updated.name} позначено як несправний`
          : `${updated.name} знову справний`,
      });
    } catch (error) {
      notify({
        severity: 'error',
        message: `Не вдалося зберегти стан провайдера: ${errorMessage(error)}`,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Stack spacing={1}>
      <FormControlLabel
        control={
          <Switch
            color="warning"
            checked={unhealthy}
            onChange={(event) => setUnhealthy(event.target.checked)}
          />
        }
        label="Несправний: попередити користувачів ШІ-чату"
      />
      {unhealthy ? (
        <TextField
          fullWidth
          multiline
          minRows={1}
          label="Повідомлення для користувачів"
          placeholder="Наприклад: державний шлюз не відповідає, використовуйте іншу модель"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          slotProps={{ htmlInput: { maxLength: HEALTH_MESSAGE_MAX_CHARS } }}
          helperText={`${message.length}/${HEALTH_MESSAGE_MAX_CHARS}`}
        />
      ) : null}
      <Stack direction="row" spacing={1} alignItems="center">
        <PowerButton
          type="button"
          size="small"
          variant="outlined"
          color={unhealthy ? 'warning' : 'primary'}
          disabled={!changed || saving}
          onClick={() => void save()}
        >
          Зберегти стан
        </PowerButton>
        {engine.healthUpdatedAt ? (
          <Typography variant="caption" color="text.secondary">
            Змінено {formatDateTime(engine.healthUpdatedAt)}
          </Typography>
        ) : null}
      </Stack>
    </Stack>
  );
}
