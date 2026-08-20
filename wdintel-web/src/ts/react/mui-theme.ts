import { createTheme, ThemeProvider } from '@mui/material/styles';
import { createElement, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import designTokens from '../../design-system/tokens.json';

type CssVariableTokens<T> = { [Key in keyof T]: string };

export interface EchoThemeTokens {
  spacing: CssVariableTokens<typeof designTokens.spacing>;
  size: CssVariableTokens<typeof designTokens.size>;
  radius: CssVariableTokens<typeof designTokens.radius>;
  fontSize: CssVariableTokens<typeof designTokens.fontSize>;
  breakpoint: typeof designTokens.breakpoint;
  shadow: CssVariableTokens<typeof designTokens.shadow>;
}

declare module '@mui/material/styles' {
  interface Theme {
    echo: EchoThemeTokens;
  }

  interface ThemeOptions {
    echo?: EchoThemeTokens;
  }
}

function buildCssVariableTokens<T extends Record<string, string>>(
  namespace: string,
  tokens: T,
): CssVariableTokens<T> {
  return Object.fromEntries(
    Object.keys(tokens).map((name) => [name, `var(--echo-${namespace}-${toKebabCase(name)})`]),
  ) as CssVariableTokens<T>;
}

function toKebabCase(value: string) {
  return value.replaceAll(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

export const echoThemeTokens: EchoThemeTokens = {
  spacing: buildCssVariableTokens('spacing', designTokens.spacing),
  size: buildCssVariableTokens('size', designTokens.size),
  radius: buildCssVariableTokens('radius', designTokens.radius),
  fontSize: buildCssVariableTokens('font-size', designTokens.fontSize),
  breakpoint: designTokens.breakpoint,
  shadow: buildCssVariableTokens('shadow', designTokens.shadow),
};

export function getMuiPaletteMode(): 'light' | 'dark' {
  return document.documentElement.getAttribute('data-bs-theme') === 'dark' ? 'dark' : 'light';
}

export function useMuiPaletteMode() {
  const [mode, setMode] = useState(getMuiPaletteMode);

  useEffect(() => {
    const syncMode = () => setMode(getMuiPaletteMode());
    const observer = new MutationObserver(syncMode);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-bs-theme'],
    });

    window.addEventListener('echo-theme-applied', syncMode);

    return () => {
      observer.disconnect();
      window.removeEventListener('echo-theme-applied', syncMode);
    };
  }, []);

  return mode;
}

const neoMuiFontFamily =
  'var(--bs-body-font-family, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", "Liberation Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji")';

function resolveCssCustomProperty(reference: string, fallback: string) {
  if (typeof document === 'undefined') return fallback;

  const styles = getComputedStyle(document.documentElement);
  const seen = new Set<string>();

  const resolveReference = (propertyName: string): string => {
    if (seen.has(propertyName)) return '';
    seen.add(propertyName);

    const value = styles.getPropertyValue(propertyName).trim();
    return value.replaceAll(
      /var\((--[\w-]+)(?:,\s*([^)]+))?\)/g,
      (_, nestedReference: string, nestedFallback: string | undefined) =>
        resolveReference(nestedReference) || nestedFallback?.trim() || '',
    );
  };

  return resolveReference(reference) || fallback;
}

function buildSharedPalette(mode: 'light' | 'dark') {
  const defaultPalette = createTheme({ palette: { mode } }).palette;
  const color = (name: keyof typeof designTokens.colorReference, fallback: string) =>
    resolveCssCustomProperty(designTokens.colorReference[name], fallback);

  return {
    mode,
    primary: {
      light: color('primaryLight', defaultPalette.primary.light),
      main: color('primary', defaultPalette.primary.main),
      dark: color('primaryDark', defaultPalette.primary.dark),
      contrastText: color('onPrimary', defaultPalette.primary.contrastText),
    },
    secondary: {
      light: color('secondaryLight', defaultPalette.secondary.light),
      main: color('secondary', defaultPalette.secondary.main),
      dark: color('secondaryDark', defaultPalette.secondary.dark),
      contrastText: color('onSecondary', defaultPalette.secondary.contrastText),
    },
    success: {
      light: color('successLight', defaultPalette.success.light),
      main: color('success', defaultPalette.success.main),
      dark: color('successDark', defaultPalette.success.dark),
    },
    warning: {
      light: color('warningLight', defaultPalette.warning.light),
      main: color('warning', defaultPalette.warning.main),
      dark: color('warningDark', defaultPalette.warning.dark),
    },
    error: {
      light: color('errorLight', defaultPalette.error.light),
      main: color('error', defaultPalette.error.main),
      dark: color('errorDark', defaultPalette.error.dark),
    },
    background: {
      default: color('background', defaultPalette.background.default),
      paper: color('surface', defaultPalette.background.paper),
    },
    text: {
      primary: color('text', defaultPalette.text.primary),
      secondary: color('textMuted', defaultPalette.text.secondary),
      disabled: color('textDisabled', defaultPalette.text.disabled),
    },
    divider: color('divider', defaultPalette.divider),
  };
}

function buildAutofillStyles(theme: {
  palette: { background: { default: string }; text: { primary: string } };
}) {
  return {
    '& input:-webkit-autofill, & input:-webkit-autofill:hover, & input:-webkit-autofill:focus, & input:-webkit-autofill:active':
      {
        WebkitBoxShadow: '0 0 0 1000px transparent inset',
        WebkitTextFillColor: theme.palette.text.primary,
        caretColor: theme.palette.text.primary,
        transition: 'background-color 9999s ease-out 0s',
        backgroundColor: 'transparent',
      },
  };
}

export function createNeoMuiTheme(mode: 'light' | 'dark') {
  return createTheme({
    palette: buildSharedPalette(mode),
    echo: echoThemeTokens,
    typography: {
      fontFamily: neoMuiFontFamily,
      htmlFontSize: 14,
    },
    components: {
      // Native controls can safely restore pointer events while disabled.
      // Non-native controls and anchors must remain non-interactive; wrap
      // them in a ref-forwarding cursor wrapper when a forbidden cursor is needed.
      MuiButtonBase: {
        styleOverrides: {
          root: {
            '&.Mui-disabled:is(button, input, select, textarea), &.Mui-disabled:is(button, input, select, textarea):hover':
              {
                cursor: 'not-allowed',
                pointerEvents: 'auto',
              },
            '&.Mui-disabled:is(button, input, select, textarea) *': {
              cursor: 'not-allowed',
            },
          },
        },
      },
      MuiInputBase: {
        styleOverrides: {
          root: ({ theme }) => ({
            '&.Mui-disabled, &.Mui-disabled:hover': {
              cursor: 'not-allowed',
            },
            '&.Mui-disabled *': {
              cursor: 'not-allowed',
            },
            ...buildAutofillStyles(theme),
          }),
          input: ({ theme }) => ({
            '&.Mui-disabled, &.Mui-disabled:hover': {
              cursor: 'not-allowed',
              pointerEvents: 'auto',
            },
            '&.Mui-disabled *': {
              cursor: 'not-allowed',
            },
            ...buildAutofillStyles(theme),
          }),
        },
      },
      MuiFormControl: {
        styleOverrides: {
          root: {
            '&.Mui-disabled, &.Mui-disabled:hover': {
              cursor: 'not-allowed',
            },
            '&.Mui-disabled *': {
              cursor: 'not-allowed',
            },
          },
        },
      },
      MuiFormControlLabel: {
        styleOverrides: {
          root: {
            alignSelf: 'flex-start',
            width: 'fit-content',
            maxWidth: '100%',
            '&.Mui-disabled, &.Mui-disabled:hover': {
              cursor: 'not-allowed',
            },
            '&.Mui-disabled *': {
              cursor: 'not-allowed',
            },
          },
        },
      },
      MuiDialogActions: {
        styleOverrides: {
          root: ({ theme }) => ({
            padding: theme.spacing(3),
            gap: theme.spacing(1.5),
            '& > :not(style) ~ :not(style)': {
              marginLeft: 0,
            },
          }),
        },
      },
      MuiMenuItem: {
        styleOverrides: {
          root: {
            fontSize: '14px',
            '& .MuiListItemText-primary': {
              fontSize: '14px',
            },
            '& .MuiTypography-body1, & .MuiTypography-body2': {
              fontSize: '14px',
            },
          },
        },
      },
      MuiTableCell: {
        styleOverrides: {
          root: {
            fontSize: '1rem',
            '& .MuiTypography-body2, & .MuiTypography-caption': {
              fontSize: '1rem',
            },
          },
          head: {
            fontWeight: 600,
          },
          sizeSmall: {
            paddingTop: 12,
            paddingBottom: 12,
            paddingLeft: 16,
            paddingRight: 16,
          },
        },
      },
      MuiTableSortLabel: {
        styleOverrides: {
          root: {
            fontSize: '1rem',
          },
        },
      },
    },
  });
}

export function useNeoMuiTheme() {
  const mode = useMuiPaletteMode();

  return useMemo(() => createNeoMuiTheme(mode), [mode]);
}

export function NeoMuiThemeProvider({ children }: { children: ReactNode }) {
  const theme = useNeoMuiTheme();

  return createElement(ThemeProvider, { theme }, children);
}
