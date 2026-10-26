import SaveIcon from '@mui/icons-material/Save';
import {
  Card,
  CardContent,
  Checkbox,
  CircularProgress,
  FormControlLabel,
  MenuItem,
  TextField,
  Typography,
} from '@mui/material';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { type useTranscriptAnalysis } from './use-transcript-analysis';

export function WorkerSettings({ state }: { state: ReturnType<typeof useTranscriptAnalysis> }) {
  const { page, disabled } = state;
  if (!page) return null;

  return (
    <Card variant="outlined" sx={{ borderRadius: 0, boxShadow: 'none' }}>
      <CardContent sx={{ p: 3, '&:last-child': { pb: 3 } }}>
        <section className="flex flex-col gap-[20px] [&>*]:!m-0">
          <div className="flex flex-col gap-echo-xs">
            <Typography component="h2" variant="h6">
              Воркер
            </Typography>
            <Typography color="text.secondary" variant="body2">
              Воркер аналізує автоматичні транскрипції нових повідомлень у групах з увімкненим
              аналізом і позначає важливі. Кожне повідомлення аналізується один раз.
            </Typography>
          </div>
          {page.engines.length === 0 && (
            <PowerAlert severity="warning">
              Немає увімкнених ШІ движків. Увімкніть хоча б один у налаштуваннях системи.
            </PowerAlert>
          )}
          <FormControlLabel
            label="Увімкнути воркер аналізу транскрипцій"
            control={
              <Checkbox
                checked={page.worker.enabled}
                disabled={disabled}
                onChange={(_, enabled) =>
                  state.setPage({ ...page, worker: { ...page.worker, enabled } })
                }
              />
            }
          />
          <TextField
            select
            fullWidth
            required={page.worker.enabled}
            label="ШІ движок"
            value={page.worker.aiEngineId ?? ''}
            disabled={disabled || page.engines.length === 0}
            onChange={(event) =>
              state.setPage({
                ...page,
                worker: { ...page.worker, aiEngineId: event.target.value || null },
              })
            }
          >
            <MenuItem value="">
              <em>Не вибрано</em>
            </MenuItem>
            {page.worker.aiEngineId &&
              !page.engines.some((engine) => engine.id === page.worker.aiEngineId) && (
                <MenuItem value={page.worker.aiEngineId}>Недоступна модель</MenuItem>
              )}
            {page.engines.map((engine) => (
              <MenuItem key={engine.id} value={engine.id}>
                {engine.name} · {engine.modelName}
              </MenuItem>
            ))}
          </TextField>
          <PowerButton
            type="button"
            variant="contained"
            className="self-start"
            disabled={disabled || (page.worker.enabled && !page.worker.aiEngineId)}
            onClick={() => void state.saveWorker()}
            startIcon={disabled ? <CircularProgress size={18} /> : <SaveIcon />}
          >
            Зберегти
          </PowerButton>
        </section>
      </CardContent>
    </Card>
  );
}
