import { MenuItem, TextField, Typography } from '@mui/material';

import type { AiCallsignEngineItem } from '../../../Bindings';

export function AiWorkerEngineSelect({
  engines,
  primaryId,
  fallbackId,
  required,
  disabled,
  onChange,
}: {
  engines: AiCallsignEngineItem[];
  primaryId: string;
  fallbackId: string;
  required: boolean;
  disabled: boolean;
  onChange: (primaryId: string, fallbackId: string) => void;
}) {
  return (
    <section className="flex flex-col gap-echo-md" aria-label="Моделі обробки">
      <TextField
        select
        fullWidth
        required={required}
        disabled={disabled || engines.length === 0}
        label="Основний ШІ движок"
        SelectProps={{ displayEmpty: true }}
        InputLabelProps={{ shrink: true }}
        value={primaryId}
        onChange={(event) =>
          onChange(
            event.target.value,
            !event.target.value || event.target.value === fallbackId ? '' : fallbackId,
          )
        }
      >
        <MenuItem value="">Не вибрано</MenuItem>
        {engines.map((engine) => (
          <MenuItem key={engine.id} value={engine.id}>
            {engine.name} · {engine.modelName}
          </MenuItem>
        ))}
      </TextField>
      <TextField
        select
        fullWidth
        disabled={disabled || !primaryId}
        label="Резервний ШІ движок"
        SelectProps={{ displayEmpty: true }}
        InputLabelProps={{ shrink: true }}
        value={fallbackId}
        onChange={(event) => onChange(primaryId, event.target.value)}
      >
        <MenuItem value="">Без резервного движка</MenuItem>
        {engines
          .filter((engine) => engine.id !== primaryId)
          .map((engine) => (
            <MenuItem key={engine.id} value={engine.id}>
              {engine.name} · {engine.modelName}
            </MenuItem>
          ))}
      </TextField>
      <Typography variant="body2" color="text.secondary">
        Резервний движок обробляє повідомлення, якщо основний повернув помилку, некоректну відповідь
        або перевищив ліміт часу.
      </Typography>
    </section>
  );
}
