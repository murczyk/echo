import {
  Autocomplete,
  FormControlLabel,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';

import { PowerAlert } from '../../../components/PowerAlert';

type Props = {
  unitName: string;
  skipNetworkCreation: boolean;
  allowSkip: boolean;
  locations: string[];
  unitMask: string[];
  disabled: boolean;
  onSkipNetworkCreationChange: (value: boolean) => void;
  onLocationsChange: (value: string[]) => void;
  onUnitMaskChange: (value: string[]) => void;
};

export function AutoNetworkFields({
  unitName,
  skipNetworkCreation,
  allowSkip,
  locations,
  unitMask,
  disabled,
  onSkipNetworkCreationChange,
  onLocationsChange,
  onUnitMaskChange,
}: Props) {
  const fieldsDisabled = disabled || skipNetworkCreation;

  return (
    <Stack spacing={3}>
      <TextField label="Підрозділ" value={unitName || 'Без назви'} disabled fullWidth />
      <PowerAlert severity="info" autoHideDuration={null}>
        {allowSkip
          ? 'Разом з підрозділом буде створена SIGINT мережа, яку можна редагувати у База Даних — Мережі.'
          : 'Для підрозділу буде створена SIGINT мережа, яку можна редагувати у База Даних — Мережі.'}
      </PowerAlert>
      {allowSkip ? (
        <>
          <FormControlLabel
            control={
              <Switch
                checked={skipNetworkCreation}
                onChange={(event) => onSkipNetworkCreationChange(event.target.checked)}
                disabled={disabled}
              />
            }
            label="Пропустити створення мережі"
          />
          <Typography variant="body2" color="text.secondary">
            Без мережі вхідні повідомлення не будуть автоматично зіставлятися з цим підрозділом.
          </Typography>
        </>
      ) : null}
      <TextField
        label="Назва майбутньої мережі"
        value={`р/м 💻 ${unitName || 'Без назви'}`}
        disabled
        fullWidth
      />
      <Autocomplete
        multiple
        freeSolo
        options={[]}
        value={locations}
        onChange={(_, value) => onLocationsChange(value)}
        disabled={fieldsDisabled}
        renderInput={(params) => (
          <TextField
            {...params}
            label="Локації"
            placeholder="Введіть локацію та натисніть Enter"
            required={!skipNetworkCreation}
          />
        )}
      />
      <Typography variant="body2" color="text.secondary">
        Якщо текст сигналу містить одну з цих назв, повідомлення буде позначено як повідомлення від
        цього підрозділу.
      </Typography>
      <Autocomplete
        multiple
        freeSolo
        options={[]}
        value={unitMask}
        onChange={(_, value) => onUnitMaskChange(value)}
        disabled={fieldsDisabled}
        renderInput={(params) => (
          <TextField
            {...params}
            label="Маски підрозділу"
            placeholder="Введіть маску та натисніть Enter"
          />
        )}
      />
    </Stack>
  );
}
