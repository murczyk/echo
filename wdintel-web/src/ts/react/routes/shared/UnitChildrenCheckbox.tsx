import { Checkbox, FormControlLabel, LinearProgress } from '@mui/material';

export function UnitChildrenCheckbox({
  checked,
  loading,
  onChange,
}: {
  checked: boolean;
  loading: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <FormControlLabel
        control={
          <Checkbox
            size="small"
            checked={checked}
            disabled={loading}
            onChange={(_, value) => onChange(value)}
          />
        }
        label="включаючи дочірні підрозділи"
        slotProps={{ typography: { variant: 'body2' } }}
      />
      {loading ? (
        <LinearProgress
          aria-label="Завантаження ієрархії підрозділів"
          className="min-w-10 flex-1"
        />
      ) : null}
    </div>
  );
}
