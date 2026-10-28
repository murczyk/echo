import RefreshIcon from '@mui/icons-material/Refresh';
import RestoreIcon from '@mui/icons-material/Restore';
import SaveIcon from '@mui/icons-material/Save';
import ScienceOutlinedIcon from '@mui/icons-material/ScienceOutlined';
import {
  Checkbox,
  CircularProgress,
  FormControl,
  InputLabel,
  ListItemText,
  MenuItem,
  Select,
  TextField,
  Typography,
} from '@mui/material';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { Action, type useTranscriptAnalysis } from './use-transcript-analysis';

export function PromptPanel({ state }: { state: ReturnType<typeof useTranscriptAnalysis> }) {
  const { page, action, disabled } = state;
  if (!page) return null;
  const engineNames = new Map(page.engines.map((engine) => [engine.id, engine.name]));

  return (
    <aside
      aria-label="Панель промпту"
      className="flex w-[400px] shrink-0 flex-col gap-echo-lg self-stretch border border-echo-border bg-echo-surface-raised p-echo-lg"
    >
      <Typography component="h2" variant="h6">
        Промпт аналізу
      </Typography>
      <div className="flex flex-col items-start gap-echo-sm">
        <Typography variant="body2" color="text.secondary">
          {page.promptOverridden
            ? 'Активне тимчасове перевизначення.'
            : 'Використовується вбудований стандартний промпт.'}
        </Typography>
        <PowerButton
          type="button"
          variant="outlined"
          disabled={disabled || !page.promptOverridden}
          onClick={() => void state.reset()}
          startIcon={action === Action.Reset ? <CircularProgress size={18} /> : <RestoreIcon />}
        >
          Скинути до стандартного
        </PowerButton>
      </div>
      {page.engines.length === 0 && (
        <PowerAlert severity="warning">
          Немає увімкнених ШІ движків. Увімкніть хоча б один у налаштуваннях системи.
        </PowerAlert>
      )}
      <TextField
        fullWidth
        required
        disabled={disabled}
        multiline
        minRows={5}
        label="Промпт аналізу"
        value={state.prompt}
        onChange={(event) => state.setPrompt(event.target.value)}
        helperText='Очікувана відповідь: JSON-об’єкт {"important":true,"description":"Короткий опис","quotes":["Цитата з транскрипції"]}.'
      />
      <FormControl fullWidth disabled={disabled}>
        <InputLabel id="transcript-analysis-engines-label">ШІ движки</InputLabel>
        <Select
          labelId="transcript-analysis-engines-label"
          multiple
          label="ШІ движки"
          value={state.selected}
          onChange={(event) => {
            const value = event.target.value;
            state.setSelected(typeof value === 'string' ? value.split(',') : value);
          }}
          renderValue={(ids) =>
            ids.map((id) => engineNames.get(id) ?? id).join(', ') || 'Не вибрано'
          }
        >
          {page.engines.map((engine) => (
            <MenuItem key={engine.id} value={engine.id}>
              <Checkbox checked={state.selected.includes(engine.id)} />
              <ListItemText primary={engine.name} secondary={engine.modelName} />
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      <div className="flex flex-wrap gap-echo-md">
        <PowerButton
          type="button"
          variant="outlined"
          disabled={disabled || !state.canRun}
          onClick={() => void state.run(false)}
          startIcon={
            action === Action.Test ? <CircularProgress size={18} /> : <ScienceOutlinedIcon />
          }
        >
          Тест
        </PowerButton>
        <PowerButton
          type="button"
          variant="contained"
          disabled={disabled || !state.prompt.trim()}
          onClick={() => void state.save()}
          startIcon={action === Action.Save ? <CircularProgress size={18} /> : <SaveIcon />}
        >
          Зберегти
        </PowerButton>
        <PowerButton
          type="button"
          variant="outlined"
          disabled={disabled || !state.canRun}
          onClick={() => void state.run(true)}
          startIcon={
            action === Action.Recalculate ? <CircularProgress size={18} /> : <RefreshIcon />
          }
        >
          Перерахувати всі
        </PowerButton>
      </div>
    </aside>
  );
}
