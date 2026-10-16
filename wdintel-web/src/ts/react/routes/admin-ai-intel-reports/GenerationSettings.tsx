import {
  Radio,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import type { AiEngineItem, AiIntelReportSettingsItem } from '../../../../Bindings';

const TIMEOUT_FIELDS = [
  { key: 'primaryTimeoutSecs', label: 'Ліміт спроби 1, с' },
  { key: 'fallbackTimeoutSecs', label: 'Ліміт спроби 2, с' },
  { key: 'totalTimeoutSecs', label: 'Загальний ліміт часу, с' },
] as const;

export function GenerationSettings({
  settings,
  engines,
  saving,
  onChange,
}: {
  settings: AiIntelReportSettingsItem;
  engines: AiEngineItem[];
  saving: boolean;
  onChange: (settings: AiIntelReportSettingsItem) => void;
}) {
  function changeBudget(aiEngineId: string, maxTokens: number) {
    const exists = settings.engineBudgets.some((budget) => budget.aiEngineId === aiEngineId);
    onChange({
      ...settings,
      engineBudgets: exists
        ? settings.engineBudgets.map((budget) =>
            budget.aiEngineId === aiEngineId ? { ...budget, maxTokens } : budget,
          )
        : [...settings.engineBudgets, { aiEngineId, maxTokens }],
    });
  }

  return (
    <Stack spacing={2}>
      <TableContainer>
        <Table size="small" aria-label="Моделі розвіддонесень">
          <TableHead>
            <TableRow>
              <TableCell>Модель</TableCell>
              <TableCell>Бюджет токенів</TableCell>
              <TableCell align="center">Основна</TableCell>
              <TableCell align="center">Резервна</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            <TableRow>
              <TableCell>Не вибрано</TableCell>
              <TableCell />
              <TableCell align="center">
                <Radio
                  name="intel-report-primary"
                  checked={settings.quickAiEngineId === null}
                  disabled={saving}
                  inputProps={{ 'aria-label': 'Основна модель не вибрана' }}
                  onChange={() => onChange({ ...settings, quickAiEngineId: null })}
                />
              </TableCell>
              <TableCell align="center">
                <Radio
                  name="intel-report-fallback"
                  checked={settings.fallbackAiEngineId === null}
                  disabled={saving}
                  inputProps={{ 'aria-label': 'Без резервної моделі' }}
                  onChange={() => onChange({ ...settings, fallbackAiEngineId: null })}
                />
              </TableCell>
            </TableRow>
            {engines.map((engine) => {
              const available = engine.enabled && engine.callsignEnabled;
              const budget = settings.engineBudgets.find(
                (budget) => budget.aiEngineId === engine.id,
              );
              return (
                <TableRow key={engine.id}>
                  <TableCell>
                    <Typography variant="body2">{engine.name}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {engine.modelName}
                      {!engine.enabled
                        ? ' · Вимкнена'
                        : !engine.callsignEnabled
                          ? ' · Не підтримує розвіддонесення'
                          : ''}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <TextField
                      size="small"
                      type="number"
                      value={budget?.maxTokens ?? 512}
                      disabled={saving}
                      inputProps={{
                        min: 1,
                        step: 1,
                        'aria-label': `Бюджет токенів: ${engine.name}`,
                      }}
                      onChange={(event) => changeBudget(engine.id, Number(event.target.value))}
                      sx={{ width: 160 }}
                    />
                  </TableCell>
                  <TableCell align="center">
                    <Radio
                      name="intel-report-primary"
                      checked={settings.quickAiEngineId === engine.id}
                      disabled={saving || !available}
                      inputProps={{ 'aria-label': `Основна: ${engine.name}` }}
                      onChange={() =>
                        onChange({
                          ...settings,
                          quickAiEngineId: engine.id,
                          fallbackAiEngineId:
                            settings.fallbackAiEngineId === engine.id
                              ? null
                              : settings.fallbackAiEngineId,
                        })
                      }
                    />
                  </TableCell>
                  <TableCell align="center">
                    <Radio
                      name="intel-report-fallback"
                      checked={settings.fallbackAiEngineId === engine.id}
                      disabled={saving || !available || settings.quickAiEngineId === engine.id}
                      inputProps={{ 'aria-label': `Резервна: ${engine.name}` }}
                      onChange={() => onChange({ ...settings, fallbackAiEngineId: engine.id })}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
      <Typography variant="body2" color="text.secondary">
        Бюджет включає токени міркування та текст відповіді. Резервна модель запускається лише після
        вичерпання бюджету основної моделі.
      </Typography>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        {TIMEOUT_FIELDS.map(({ key, label }) => (
          <TextField
            key={key}
            fullWidth
            type="number"
            label={label}
            value={settings[key]}
            disabled={saving}
            inputProps={{ min: 1, step: 1 }}
            onChange={(event) => onChange({ ...settings, [key]: Number(event.target.value) })}
          />
        ))}
      </Stack>
      <Typography variant="body2" color="text.secondary">
        Загальний ліміт включає підготовку та обидві спроби; час резервної моделі обмежений залишком
        загального часу.
      </Typography>
    </Stack>
  );
}
