import { FormControlLabel, Switch, Typography } from '@mui/material';

import type { DutyMessageCardVisibility } from '../shared/message-card/DutyMessageCardVisibility';

export type SettingsDutyCardVisibilityProps = {
  value: DutyMessageCardVisibility;
  /** Frequency is shown only to users with radio features. */
  showFrequency: boolean;
  onChange: (patch: Partial<DutyMessageCardVisibility>) => void;
};

export function SettingsDutyCardVisibility({
  value,
  showFrequency,
  onChange,
  loadInProgress,
}: SettingsDutyCardVisibilityProps & { loadInProgress: boolean }) {
  const options: Array<{
    key: keyof DutyMessageCardVisibility;
    label: string;
    description?: string;
  }> = [
    {
      key: 'hideHeader',
      label: 'Заголовок',
      description:
        'Мережа, група, відправник, локація та час перехоплення. Кнопки дій залишаються.',
    },
    ...(showFrequency ? [{ key: 'hideFrequency' as const, label: 'Частота' }] : []),
    { key: 'hideUnit', label: 'Підрозділ' },
  ];
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-echo-sm border-0 p-0">
      <Typography
        component="legend"
        variant="body2"
        className="p-0"
        sx={{ color: 'text.secondary' }}
      >
        Показувати в Оперативному:
      </Typography>
      {options.map((option) => (
        <FormControlLabel
          key={option.key}
          className="m-0! items-start! gap-echo-md"
          control={
            <Switch
              checked={!value[option.key]}
              onChange={(_, checked) => onChange({ [option.key]: !checked })}
              disabled={loadInProgress}
            />
          }
          label={
            <div className="flex flex-col gap-echo-xs pt-0.5">
              <Typography variant="body1" sx={{ fontWeight: 600, lineHeight: 1.35 }}>
                {option.label}
              </Typography>
              {option.description ? (
                <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.6 }}>
                  {option.description}
                </Typography>
              ) : null}
            </div>
          }
        />
      ))}
    </fieldset>
  );
}
