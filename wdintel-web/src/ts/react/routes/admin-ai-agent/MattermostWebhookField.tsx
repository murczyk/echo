import { FormControlLabel, Stack, Switch, TextField } from '@mui/material';

type Props = {
  label: string;
  configured: boolean;
  value: string;
  clear: boolean;
  onChange: (value: string) => void;
  onClear: (clear: boolean) => void;
};

export function MattermostWebhookField(props: Props) {
  return (
    <Stack spacing={2}>
      {props.configured ? (
        <FormControlLabel
          control={
            <Switch
              checked={props.clear}
              onChange={(event) => props.onClear(event.target.checked)}
            />
          }
          label={`Очистити ${props.label}`}
        />
      ) : null}
      <TextField
        type="url"
        label={props.label}
        value={props.value}
        disabled={props.clear}
        placeholder={props.configured ? 'Налаштовано (введіть для заміни)' : ''}
        helperText="Порожнє поле зберігає наявний секрет без змін"
        onChange={(event) => props.onChange(event.target.value)}
      />
    </Stack>
  );
}
