import { Autocomplete, TextField } from '@mui/material';

type Props = {
  label: string;
  options: string[];
  value: string[];
  disabled?: boolean;
  loading?: boolean;
  onChange: (next: string[]) => void;
};

export function AnalysisFilterField({ label, options, value, disabled, loading, onChange }: Props) {
  return (
    <Autocomplete
      multiple
      size="small"
      options={options}
      value={value}
      disabled={disabled}
      loading={loading}
      openText="Відкрити"
      closeText="Закрити"
      clearText="Очистити"
      noOptionsText="Немає варіантів"
      onChange={(_event, next) => onChange(next)}
      renderInput={(params) => <TextField {...params} label={label} />}
    />
  );
}
