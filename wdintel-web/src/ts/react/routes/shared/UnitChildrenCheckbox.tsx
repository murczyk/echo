import { Checkbox, FormControlLabel, LinearProgress, Stack } from '@mui/material';

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
    <Stack direction="row" alignItems="center" spacing={1}>
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
          sx={{ flex: 1, minWidth: 40 }}
        />
      ) : null}
    </Stack>
  );
}
