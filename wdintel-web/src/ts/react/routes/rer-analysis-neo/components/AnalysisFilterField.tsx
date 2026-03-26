import { Autocomplete, TextField } from '@mui/material';

type Props = {
  label: string;
  options: string[];
  value: string[];
  disabled?: boolean;
  onChange: (next: string[]) => void;
};

export function AnalysisFilterField({ label, options, value, disabled, onChange }: Props) {
  return (
    <Autocomplete
      multiple
      size="small"
      options={options}
      value={value}
      disabled={disabled}
      openText="Відкрити"
      closeText="Закрити"
      clearText="Очистити"
      onChange={(_event, next) => onChange(next)}
      renderInput={(params) => <TextField {...params} label={label} />}
    />
  );
}
