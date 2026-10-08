import SaveIcon from '@mui/icons-material/Save';
import {
  Card,
  CardContent,
  FormControlLabel,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';

import type { AiPositionEngineItem } from '../../../../Bindings';
import { PowerButton } from '../../components/PowerButton';

export type DocumentSettingsValue = {
  enabled: boolean;
  summariesEnabled: boolean;
  positionsEnabled: boolean;
  aiEngineId: string | null;
  positionEngineId: string | null;
};

type Props<T extends DocumentSettingsValue> = {
  title: string;
  enabledLabel: string;
  positionsLabel: string;
  note: string;
  settings: T;
  engines: AiPositionEngineItem[];
  saving: boolean;
  onChange: (settings: T) => void;
  onSave: () => void;
};

export function DocumentSettingsCard<T extends DocumentSettingsValue>({
  title,
  enabledLabel,
  positionsLabel,
  note,
  settings,
  engines,
  saving,
  onChange,
  onSave,
}: Props<T>) {
  const toggle = (key: 'enabled' | 'summariesEnabled' | 'positionsEnabled', label: string) => (
    <FormControlLabel
      label={label}
      control={
        <Switch
          checked={settings[key]}
          onChange={(_, checked) => onChange({ ...settings, [key]: checked })}
        />
      }
    />
  );
  const engineSelect = (key: 'aiEngineId' | 'positionEngineId', label: string) => (
    <TextField
      select
      size="small"
      label={label}
      value={settings[key] ?? ''}
      onChange={(event) => onChange({ ...settings, [key]: event.target.value || null })}
    >
      <MenuItem value="">Не обрано</MenuItem>
      {engines.map((engine) => (
        <MenuItem key={engine.id} value={engine.id}>
          {engine.name}
        </MenuItem>
      ))}
    </TextField>
  );
  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={2}>
          <Typography component="h2" variant="h6">
            {title}
          </Typography>
          <Stack>
            {toggle('enabled', enabledLabel)}
            {toggle('summariesEnabled', 'Автоматичні підсумки')}
            {toggle('positionsEnabled', positionsLabel)}
          </Stack>
          {engineSelect('aiEngineId', 'Рушій підсумків')}
          {engineSelect('positionEngineId', 'Рушій позицій')}
          <Typography variant="body2" color="text.secondary">
            {note}
          </Typography>
          <div>
            <PowerButton
              variant="contained"
              startIcon={<SaveIcon />}
              disabled={saving}
              onClick={onSave}
            >
              Зберегти
            </PowerButton>
          </div>
        </Stack>
      </CardContent>
    </Card>
  );
}
