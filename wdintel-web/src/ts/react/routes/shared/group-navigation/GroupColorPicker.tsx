import { useId } from 'react';
import { Box, FormControl, InputLabel, MenuItem, Select } from '@mui/material';
import { useTheme } from '@mui/material/styles';

import type { SignalGroupColor } from '../../../../../Bindings';
import { resolveGroupColor, signalGroupColors } from './group-colors';

const colorNames: Record<SignalGroupColor, string> = {
  red: 'Червоний',
  pink: 'Рожевий',
  purple: 'Фіолетовий',
  deep_purple: 'Темно-фіолетовий',
  indigo: 'Індиго',
  blue: 'Синій',
  light_blue: 'Блакитний',
  cyan: 'Бірюзовий',
  teal: 'Синьо-зелений',
  green: 'Зелений',
  light_green: 'Світло-зелений',
  lime: 'Лаймовий',
  amber: 'Бурштиновий',
  orange: 'Помаранчевий',
  deep_orange: 'Темно-помаранчевий',
  blue_grey: 'Синьо-сірий',
};

type Props = {
  value: SignalGroupColor;
  onChange: (value: SignalGroupColor) => void;
  disabled?: boolean;
};

export function GroupColorPicker({ value, onChange, disabled = false }: Props) {
  const theme = useTheme();
  const labelId = useId();

  return (
    <FormControl
      size="small"
      disabled={disabled}
      sx={{ display: 'flex', width: 220, maxWidth: '100%' }}
    >
      <InputLabel id={labelId}>Колір групи</InputLabel>
      <Select
        labelId={labelId}
        label="Колір групи"
        value={value}
        onChange={(event) => onChange(event.target.value as SignalGroupColor)}
        MenuProps={{ PaperProps: { sx: { maxHeight: 320 } } }}
      >
        {signalGroupColors.map((colorKey) => (
          <MenuItem key={colorKey} value={colorKey} data-group-color={colorKey}>
            <Box component="span" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Box
                component="span"
                aria-hidden="true"
                sx={{
                  width: 18,
                  height: 18,
                  flexShrink: 0,
                  borderRadius: '50%',
                  backgroundColor: resolveGroupColor(theme, colorKey).backgroundColor,
                }}
              />
              {colorNames[colorKey]}
            </Box>
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );
}
