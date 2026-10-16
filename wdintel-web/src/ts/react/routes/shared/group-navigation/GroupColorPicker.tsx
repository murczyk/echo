import { Box, ButtonBase, FormControl, FormLabel, Tooltip } from '@mui/material';
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

  return (
    <FormControl component="fieldset" disabled={disabled}>
      <FormLabel component="legend">Колір групи</FormLabel>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 1 }}>
        {signalGroupColors.map((colorKey) => {
          const selected = colorKey === value;
          return (
            <Tooltip key={colorKey} title={colorNames[colorKey]}>
              <ButtonBase
                data-group-color={colorKey}
                aria-label={colorNames[colorKey]}
                aria-pressed={selected}
                disabled={disabled}
                onClick={() => onChange(colorKey)}
                sx={{
                  width: 36,
                  height: 36,
                  border: 2,
                  borderColor: selected ? 'primary.main' : 'transparent',
                  borderRadius: '50%',
                  opacity: disabled ? 0.5 : 1,
                }}
              >
                <Box
                  sx={{
                    width: 26,
                    height: 26,
                    borderRadius: '50%',
                    backgroundColor: resolveGroupColor(theme, colorKey).backgroundColor,
                  }}
                />
              </ButtonBase>
            </Tooltip>
          );
        })}
      </Box>
    </FormControl>
  );
}
