import { createTheme, ThemeProvider } from '@mui/material/styles';
import { createElement, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

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

export function useNeoMuiTheme() {
  const mode = useMuiPaletteMode();

  return useMemo(
    () =>
      createTheme({
        palette: { mode },
        typography: {
          fontFamily: neoMuiFontFamily,
          htmlFontSize: 14,
        },
        components: {
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
      }),
    [mode],
  );
}

export function NeoMuiThemeProvider({ children }: { children: ReactNode }) {
  const theme = useNeoMuiTheme();

  return createElement(ThemeProvider, { theme }, children);
}
