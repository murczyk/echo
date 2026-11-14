import { Checkbox, FormControlLabel, Typography } from '@mui/material';

export function MessageStatisticsExclusion({
  login,
  excluded,
  disabled,
  onChange,
}: {
  login: string;
  excluded: boolean;
  disabled: boolean;
  onChange: (excluded: boolean) => void;
}) {
  return (
    <FormControlLabel
      className="max-w-full"
      disableTypography
      control={
        <Checkbox
          size="small"
          sx={(theme) => ({ p: theme.echo.spacing.xs })}
          checked={excluded}
          disabled={disabled}
          onChange={(_, checked) => onChange(checked)}
          inputProps={{ 'aria-label': `Виключити зі статистики повідомлень: ${login}` }}
        />
      }
      label={
        <Typography component="span" variant="body2">
          Виключити зі статистики повідомлень
        </Typography>
      }
    />
  );
}
