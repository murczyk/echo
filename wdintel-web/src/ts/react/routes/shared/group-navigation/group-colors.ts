import {
  amber,
  blue,
  blueGrey,
  cyan,
  deepOrange,
  deepPurple,
  green,
  indigo,
  lightBlue,
  lightGreen,
  lime,
  orange,
  pink,
  purple,
  red,
  teal,
} from '@mui/material/colors';
import { getContrastRatio, type Theme } from '@mui/material/styles';

import type { SignalGroupColor } from '../../../../../Bindings';

type MaterialColor = { 400: string; 700: string };

const colors: Record<SignalGroupColor, MaterialColor> = {
  red,
  pink,
  purple,
  deep_purple: deepPurple,
  indigo,
  blue,
  light_blue: lightBlue,
  cyan,
  teal,
  green,
  light_green: lightGreen,
  lime,
  amber,
  orange,
  deep_orange: deepOrange,
  blue_grey: blueGrey,
};

export const signalGroupColors = Object.keys(colors) as SignalGroupColor[];

export function resolveGroupColor(theme: Theme, colorKey?: string | null) {
  const materialColor = colors[colorKey as SignalGroupColor];
  if (!materialColor) {
    return {
      backgroundColor: theme.palette.action.selected,
      color: theme.palette.text.primary,
    };
  }

  const backgroundColor = materialColor[theme.palette.mode === 'dark' ? 400 : 700];
  const foregrounds = [theme.palette.common.white, theme.palette.common.black];
  const color = foregrounds.reduce((best, candidate) =>
    getContrastRatio(backgroundColor, candidate) > getContrastRatio(backgroundColor, best)
      ? candidate
      : best,
  );

  return { backgroundColor, color };
}
