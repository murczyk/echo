import { alpha, type Theme } from '@mui/material/styles';

export const NETWORK_RELATIONS_FULLSCREEN_Z_INDEX = 10000;

export type NetworkRelationsGraphTheme = {
  frameBg: string;
  frameBorder: string;
  gridLine: string;
  overlayBg: string;
  overlayBorder: string;
  overlayShadow: string;
  overlayText: string;
  overlayTextSecondary: string;
  surfaceBg: string;
  surfaceBorder: string;
  zoomControlBg: string;
  zoomControlBorder: string;
  zoomControlHoverBg: string;
  zoomControlText: string;
};

export function getNetworkRelationsGraphTheme(theme: Theme): NetworkRelationsGraphTheme {
  const isDarkMode = theme.palette.mode === 'dark';

  return {
    frameBg: isDarkMode ? '#0f0f0f' : theme.palette.background.paper,
    frameBorder: alpha(theme.palette.divider, isDarkMode ? 0.6 : 0.85),
    gridLine: isDarkMode ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.05)',
    overlayBg: isDarkMode ? 'rgba(12,12,12,0.94)' : alpha(theme.palette.background.paper, 0.98),
    overlayBorder: alpha(theme.palette.divider, isDarkMode ? 0.5 : 0.85),
    overlayShadow: isDarkMode ? '0 12px 28px rgba(0,0,0,0.35)' : '0 12px 24px rgba(0,0,0,0.10)',
    overlayText: theme.palette.text.primary,
    overlayTextSecondary: alpha(theme.palette.text.primary, isDarkMode ? 0.72 : 0.62),
    surfaceBg: isDarkMode ? 'rgba(255,255,255,0.06)' : alpha(theme.palette.text.primary, 0.04),
    surfaceBorder: isDarkMode ? 'rgba(255,255,255,0.14)' : alpha(theme.palette.divider, 0.9),
    zoomControlBg: isDarkMode ? '#24272d' : alpha(theme.palette.background.paper, 0.96),
    zoomControlBorder: isDarkMode
      ? 'rgba(255,255,255,0.28)'
      : alpha(theme.palette.text.primary, 0.35),
    zoomControlHoverBg: isDarkMode
      ? 'rgba(255,255,255,0.08)'
      : alpha(theme.palette.text.primary, 0.06),
    zoomControlText: isDarkMode ? '#f3f5f7' : theme.palette.text.primary,
  };
}
