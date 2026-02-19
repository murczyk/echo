import { createTheme } from '@mui/material/styles';
import React from 'react';

function getMuiPaletteMode(): 'light' | 'dark' {
  return document.documentElement.getAttribute('data-bs-theme') === 'dark' ? 'dark' : 'light';
}

function useMuiPaletteMode() {
  const [mode, setMode] = React.useState(getMuiPaletteMode);

  React.useEffect(() => {
    const observer = new MutationObserver(() => setMode(getMuiPaletteMode()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-bs-theme'],
    });

    return () => observer.disconnect();
  }, []);

  return mode;
}

const neoMuiFontFamily =
  'var(--bs-body-font-family, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", "Liberation Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji")';

export function useNeoMuiTheme() {
  const mode = useMuiPaletteMode();

  return React.useMemo(
    () =>
      createTheme({
        palette: { mode },
        typography: {
          fontFamily: neoMuiFontFamily,
        },
      }),
    [mode],
  );
}
