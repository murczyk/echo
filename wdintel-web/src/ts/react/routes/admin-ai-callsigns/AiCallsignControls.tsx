import RefreshIcon from '@mui/icons-material/Refresh';
import SaveIcon from '@mui/icons-material/Save';
import ScienceOutlinedIcon from '@mui/icons-material/ScienceOutlined';
import {
  Box,
  Checkbox,
  CircularProgress,
  FormControl,
  InputLabel,
  ListItemText,
  MenuItem,
  Select,
  Stack,
  TextField,
} from '@mui/material';

import type { AiCallsignEngineItem } from '../../../../Bindings';
import { PowerButton } from '../../components/PowerButton';

export type AiCallsignAction = 'test' | 'save' | 'recalculate';

export function AiCallsignControls({
  action,
  canRun,
  engines,
  prompt,
  selectedEngineIds,
  onPromptChange,
  onRecalculate,
  onSave,
  onSelectionChange,
  onTest,
}: {
  action: AiCallsignAction | null;
  canRun: boolean;
  engines: AiCallsignEngineItem[];
  prompt: string;
  selectedEngineIds: string[];
  onPromptChange: (prompt: string) => void;
  onRecalculate: () => void;
  onSave: () => void;
  onSelectionChange: (ids: string[]) => void;
  onTest: () => void;
}) {
  const engineNames = new Map(engines.map((engine) => [engine.id, engine.name]));
  const busy = action !== null;

  return (
    <Stack spacing={2}>
      <TextField
        fullWidth
        required
        multiline
        minRows={5}
        label="Промпт для пошуку позивних"
        value={prompt}
        onChange={(event) => onPromptChange(event.target.value)}
        helperText='Очікувана відповідь: JSON-об’єкт {"callsigns":["ПОЗИВНИЙ"]} або JSON-масив.'
      />

      <FormControl fullWidth>
        <InputLabel id="ai-callsign-engines-label">ШІ движки</InputLabel>
        <Select
          labelId="ai-callsign-engines-label"
          multiple
          label="ШІ движки"
          value={selectedEngineIds}
          onChange={(event) => {
            const value = event.target.value;
            onSelectionChange(typeof value === 'string' ? value.split(',') : value);
          }}
          renderValue={(ids) =>
            ids.map((id) => engineNames.get(id) ?? id).join(', ') || 'Не вибрано'
          }
        >
          {engines.map((engine) => (
            <MenuItem key={engine.id} value={engine.id}>
              <Checkbox checked={selectedEngineIds.includes(engine.id)} />
              <ListItemText primary={engine.name} secondary={engine.modelName} />
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
        <PowerButton
          type="button"
          variant="outlined"
          disabled={busy || !canRun}
          onClick={onTest}
          startIcon={action === 'test' ? <CircularProgress size={18} /> : <ScienceOutlinedIcon />}
        >
          Тест
        </PowerButton>
        <PowerButton
          type="button"
          variant="contained"
          disabled={busy || !prompt.trim()}
          onClick={onSave}
          startIcon={action === 'save' ? <CircularProgress size={18} /> : <SaveIcon />}
        >
          Зберегти
        </PowerButton>
        <PowerButton
          type="button"
          variant="outlined"
          disabled={busy || !canRun}
          onClick={onRecalculate}
          startIcon={action === 'recalculate' ? <CircularProgress size={18} /> : <RefreshIcon />}
        >
          Перерахувати всі
        </PowerButton>
      </Box>
    </Stack>
  );
}
