import { createTheme, ThemeProvider } from '@mui/material/styles';
import { createElement, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { designTokens } from '../../design-system/design-tokens';

type CssVariableTokens<T> = { [Key in keyof T]: string };

export interface EchoThemeTokens {
  color: typeof designTokens.color;
  spacing: CssVariableTokens<typeof designTokens.spacing>;
  size: CssVariableTokens<typeof designTokens.size>;
  radius: CssVariableTokens<typeof designTokens.radius>;
  fontSize: CssVariableTokens<typeof designTokens.typography.fontSize>;
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
  color: designTokens.color,
  spacing: buildCssVariableTokens('spacing', designTokens.spacing),
  size: buildCssVariableTokens('size', designTokens.size),
  radius: buildCssVariableTokens('radius', designTokens.radius),
  fontSize: buildCssVariableTokens('typography-font-size', designTokens.typography.fontSize),
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
    // Compatibility-first: generated colors are exposed through `theme.echo`,
    // while the established global MUI palette remains unchanged.
    palette: { mode },
    echo: echoThemeTokens,
    typography: {
      fontFamily: designTokens.typography.fontFamily,
      htmlFontSize: Number.parseInt(designTokens.typography.fontSize.base, 10),
    },
    components: {
      MuiDialog: {
        styleOverrides: {
          paper: {
            backgroundColor: designTokens.color[mode].dialogSurface,
            backgroundImage: 'none',
          },
        },
      },
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
